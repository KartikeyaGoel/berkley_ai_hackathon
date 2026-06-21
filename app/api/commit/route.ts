import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { reconcileCommit } from "@/lib/topoVision";
import {
  appendCommit,
  getCurrentBranch,
  getHistory,
  getPrevPhoto,
  nextCommitHash,
  putPhoto,
} from "@/lib/store";
import type { CommitState, CompressionBreakdown } from "@/types/topo";
import { diffAndCrop, estimateImageTokens } from "@/utils/imageDiff";
import {
  buildTokenMetrics,
  formatCommitDiff,
} from "@/utils/metrics";
import { compressSpatialHistory } from "@/utils/spatialCompressor";
import { approxTokens } from "@/utils/statePrompt";

export const runtime = "nodejs";

function parseBase64Image(raw: string): Buffer {
  const base64 = raw.includes(",") ? raw.split(",")[1]! : raw;
  return Buffer.from(base64, "base64");
}

export async function POST(request: NextRequest) {
  return Sentry.withScope(async (scope) => {
    scope.setTag("route", "commit");

    try {
      const forceFull = request.nextUrl.searchParams.get("forceFull") === "1";
      const branchParam = request.nextUrl.searchParams.get("branch");
      const branch = branchParam ?? (await getCurrentBranch());
      const body = (await request.json()) as { image?: string };

      if (!body.image) {
        return NextResponse.json({ error: "Missing image" }, { status: 400 });
      }

      const imageBuffer = await Sentry.startSpan(
        { name: "decode-image", op: "image.decode" },
        async () => parseBase64Image(body.image!),
      );

      const [prevPhoto, history] = await Promise.all([
        getPrevPhoto(branch),
        getHistory(branch),
      ]);
      const prevCommit = history.length > 0 ? history[history.length - 1]! : null;
      const priorObjects = prevCommit?.objects ?? [];

      const diffResult = await Sentry.startSpan(
        { name: "diff-and-crop", op: "image.diff" },
        async () => diffAndCrop(imageBuffer, prevPhoto),
      );

      const commitHash = nextCommitHash(history);
      let commit: CommitState;

      // Naive baselines shared by every branch: a no-compression client would
      // resend the whole frame + the entire prior-state JSON on every commit.
      const fullImageTokens = estimateImageTokens(
        diffResult.imageWidth,
        diffResult.imageHeight,
      );
      const naiveStateChars = JSON.stringify(priorObjects).length;
      const naiveStateTokens = approxTokens(naiveStateChars);

      if (!diffResult.changed) {
        // Layer 3: zero-token skip — provably-unchanged scene, no Claude call.
        const compression: CompressionBreakdown = {
          visual: {
            bytesSent: 0,
            bytesNaive: diffResult.imageBytesUncropped,
            approxTokensSent: 0,
            approxTokensNaive: fullImageTokens,
          },
          state: {
            charsSent: 0,
            charsNaive: naiveStateChars,
            approxTokensSent: 0,
            approxTokensNaive: naiveStateTokens,
            inViewObjects: 0,
            omittedObjects: priorObjects.length,
          },
          skipped: true,
          approxTokensSaved: fullImageTokens + naiveStateTokens,
        };

        commit = {
          commitHash,
          timestamp: Date.now(),
          objects: priorObjects,
          reconciliationNotes: "Scene unchanged — state carried forward, no Claude call",
          tokenUsage: {
            inputTokens: 0,
            outputTokens: 0,
            imageBytesSent: 0,
            regionCropped: false,
          },
          compression,
        };
      } else {
        const imageToSend = forceFull ? diffResult.fullImage : diffResult.crop;

        const croppedBase64 = imageToSend.toString("base64");

        const reconcileResult = await Sentry.startSpan(
          { name: "reconcile-commit", op: "gen_ai.chat" },
          async (span) => {
            span.setAttribute("gen_ai.system", "anthropic");
            span.setAttribute("gen_ai.operation.name", "chat");
            const r = await reconcileCommit(
              croppedBase64,
              priorObjects,
              forceFull ? null : diffResult.bbox,
              diffResult.imageWidth,
              diffResult.imageHeight,
            );
            span.setAttribute("gen_ai.usage.input_tokens", r.usage.input_tokens);
            span.setAttribute("gen_ai.usage.output_tokens", r.usage.output_tokens);
            span.setAttribute("topo.state.in_view", r.statePrompt.inViewObjects);
            span.setAttribute("topo.state.omitted", r.statePrompt.omittedObjects);
            return r;
          },
        );

        // Layer 1 (visual): crop pixel-area ratio approximates vision-token savings.
        const cropAreaRatio =
          !forceFull && diffResult.bbox && diffResult.imageWidth > 0
            ? ((diffResult.bbox.x1 - diffResult.bbox.x0) *
                (diffResult.bbox.y1 - diffResult.bbox.y0)) /
              (diffResult.imageWidth * diffResult.imageHeight)
            : 1;
        const visualTokensSent = Math.max(
          0,
          Math.round(fullImageTokens * cropAreaRatio),
        );

        const { statePrompt } = reconcileResult;
        const stateTokensSent = approxTokens(statePrompt.charsSent);

        // Deterministic carry-forward: objects outside the changed crop are
        // restored verbatim from prior state — Claude never re-places what it
        // cannot see, so their coordinates are exact, not hallucinated.
        const outViewIds = new Set(
          statePrompt.outViewObjects.map((o) => o.id),
        );
        const reconciledObjects = [
          ...reconcileResult.objects.filter((o) => !outViewIds.has(o.id)),
          ...statePrompt.outViewObjects,
        ];

        const compression: CompressionBreakdown = {
          visual: {
            bytesSent: forceFull
              ? diffResult.imageBytesUncropped
              : diffResult.imageBytesSent,
            bytesNaive: diffResult.imageBytesUncropped,
            approxTokensSent: forceFull ? fullImageTokens : visualTokensSent,
            approxTokensNaive: fullImageTokens,
          },
          state: {
            charsSent: statePrompt.charsSent,
            charsNaive: statePrompt.charsNaive,
            approxTokensSent: stateTokensSent,
            approxTokensNaive: approxTokens(statePrompt.charsNaive),
            inViewObjects: statePrompt.inViewObjects,
            omittedObjects: statePrompt.omittedObjects,
          },
          skipped: false,
          approxTokensSaved: forceFull
            ? 0
            : Math.max(
                0,
                fullImageTokens -
                  visualTokensSent +
                  (approxTokens(statePrompt.charsNaive) - stateTokensSent),
              ),
        };

        commit = {
          commitHash,
          timestamp: Date.now(),
          objects: reconciledObjects,
          reconciliationNotes: reconcileResult.reasoning,
          tokenUsage: {
            inputTokens: reconcileResult.usage.input_tokens,
            outputTokens: reconcileResult.usage.output_tokens,
            imageBytesSent: forceFull
              ? diffResult.imageBytesUncropped
              : diffResult.imageBytesSent,
            regionCropped: !forceFull && diffResult.bbox !== null,
          },
          compression,
        };
      }

      await putPhoto(imageBuffer, branch);
      const updatedHistory = await appendCommit(commit, branch);
      const compressed = compressSpatialHistory(updatedHistory);

      const croppedTokens = updatedHistory
        .filter((c) => c.tokenUsage.regionCropped)
        .map((c) => c.tokenUsage.inputTokens);
      const fullTokens = updatedHistory
        .filter((c) => !c.tokenUsage.regionCropped && c.tokenUsage.inputTokens > 0)
        .map((c) => c.tokenUsage.inputTokens);

      const metrics = buildTokenMetrics(updatedHistory, croppedTokens, fullTokens);
      const diffSummary = formatCommitDiff(commit, prevCommit);

      // ── Sentry: AI-pipeline observability ──────────────────────────────
      // Surface compression + token measurements on the commit transaction so
      // every commit's savings are queryable/alertable in Sentry, not just logs.
      const breakdown = commit.compression;
      if (breakdown) {
        Sentry.setMeasurement("input_tokens", commit.tokenUsage.inputTokens, "none");
        Sentry.setMeasurement("output_tokens", commit.tokenUsage.outputTokens, "none");
        Sentry.setMeasurement("tokens_saved", breakdown.approxTokensSaved, "none");
        Sentry.setMeasurement("image_bytes_sent", breakdown.visual.bytesSent, "byte");
        Sentry.setMeasurement("state_chars_sent", breakdown.state.charsSent, "none");
        Sentry.setMeasurement("objects_in_scene", commit.objects.length, "none");
      }
      scope.setContext("topo.compression", {
        commitHash,
        branch,
        skipped: breakdown?.skipped ?? false,
        regionCropped: commit.tokenUsage.regionCropped,
        forceFull,
        visualBytesSent: breakdown?.visual.bytesSent,
        visualBytesNaive: breakdown?.visual.bytesNaive,
        stateInView: breakdown?.state.inViewObjects,
        stateOmitted: breakdown?.state.omittedObjects,
        approxTokensSaved: breakdown?.approxTokensSaved,
      });
      scope.setTag("topo.skipped", String(breakdown?.skipped ?? false));

      // Quality monitoring: a sudden swing in object count is a reconciliation
      // smell (mis-identification / hallucinated or dropped objects). Surface it
      // as a Sentry warning so we can track compression *quality*, not just errors.
      if (prevCommit && !breakdown?.skipped) {
        const before = prevCommit.objects.length;
        const after = commit.objects.length;
        const delta = Math.abs(after - before);
        if (before > 0 && delta / before > 0.5 && delta >= 2) {
          Sentry.captureMessage("Reconciliation object-count anomaly", {
            level: "warning",
            extra: {
              commitHash,
              branch,
              before,
              after,
              reasoning: commit.reconciliationNotes,
            },
          });
        }
      }

      return NextResponse.json({
        branch,
        commit,
        history: updatedHistory,
        compressed,
        metrics,
        diffSummary,
        debug: {
          changed: diffResult.changed,
          bbox: diffResult.bbox,
          forceFull,
          imageBytesSent: diffResult.imageBytesSent,
          imageBytesUncropped: diffResult.imageBytesUncropped,
        },
      });
    } catch (error) {
      Sentry.captureException(error);
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Commit failed" },
        { status: 500 },
      );
    }
  });
}
