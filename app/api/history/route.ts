import { NextRequest, NextResponse } from "next/server";
import { getCurrentBranch, getHistory } from "@/lib/store";
import {
  buildTokenMetrics,
  formatCommitDiff,
} from "@/utils/metrics";
import { compressSpatialHistory } from "@/utils/spatialCompressor";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const branch =
    request.nextUrl.searchParams.get("branch") ?? (await getCurrentBranch());
  const history = await getHistory(branch);
  const compressed = compressSpatialHistory(history);

  const croppedTokens = history
    .filter((c) => c.tokenUsage.regionCropped)
    .map((c) => c.tokenUsage.inputTokens);
  const fullTokens = history
    .filter((c) => !c.tokenUsage.regionCropped && c.tokenUsage.inputTokens > 0)
    .map((c) => c.tokenUsage.inputTokens);

  const metrics = buildTokenMetrics(history, croppedTokens, fullTokens);
  const log = history.map((commit, i) => {
    const prev = i > 0 ? history[i - 1]! : null;
    return `$ ${formatCommitDiff(commit, prev)}`;
  });

  return NextResponse.json({ branch, history, compressed, metrics, log });
}
