import type {
  CommitState,
  CompressedLedger,
  CompressionBreakdown,
  PhysicalObject,
} from "@/types/topo";
import { compressSpatialHistory } from "@/utils/spatialCompressor";

export interface TokenMetrics {
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  /** % fewer vision input tokens vs resending a full frame on every commit. */
  imageTokenSavingsPercent: number | null;
  /** Naive history size ÷ S-RLE ledger size; null until compression wins. */
  compressionRatio: number | null;
  reconciliationAccuracy: number | null;
  /** Approx input tokens deleted across all commits vs the naive baseline. */
  cumulativeTokensSaved: number;
  /** Approx input tokens a no-compression client would have spent. */
  cumulativeNaiveInputTokens: number;
  /** Overall % of input tokens deleted by the full stack. */
  overallSavingsPercent: number | null;
  /** Per-layer breakdown for the most recent commit (for the stack panel). */
  latestBreakdown: CompressionBreakdown | null;
  /** @deprecated debug only — use imageTokenSavingsPercent from history model */
  croppedInputTokens: number[];
  /** @deprecated debug only */
  fullInputTokens: number[];
}

/** §7-D: cumulative deterministic-stack savings across the whole branch. */
export function computeStackSavings(history: CommitState[]): {
  saved: number;
  naive: number;
  percent: number | null;
} {
  let saved = 0;
  let naive = 0;
  let actual = 0;

  for (const c of history) {
    const b = c.compression;
    if (!b) continue;
    saved += b.approxTokensSaved;
    naive += b.visual.approxTokensNaive + b.state.approxTokensNaive;
    actual += b.visual.approxTokensSent + b.state.approxTokensSent;
  }

  if (naive <= 0) return { saved, naive, percent: null };
  const percent = Math.round(((naive - actual) / naive) * 100);
  return { saved, naive, percent };
}

export function computeCumulativeTokens(history: CommitState[]): {
  input: number;
  output: number;
} {
  return history.reduce(
    (acc, commit) => ({
      input: acc.input + commit.tokenUsage.inputTokens,
      output: acc.output + commit.tokenUsage.outputTokens,
    }),
    { input: 0, output: 0 },
  );
}

/** §7-A: actual vision tokens vs naive “full image on every commit after c1”. */
export function computeImageTokenSavingsFromHistory(
  history: CommitState[],
): number | null {
  if (history.length < 2) return null;

  const baselineCommit =
    history.find(
      (c) => c.tokenUsage.inputTokens > 0 && !c.tokenUsage.regionCropped,
    ) ?? history.find((c) => c.tokenUsage.inputTokens > 0);

  if (!baselineCommit) return null;
  const baseline = baselineCommit.tokenUsage.inputTokens;

  const actual = history.reduce(
    (sum, c) => sum + c.tokenUsage.inputTokens,
    0,
  );

  // Naive: c1 costs what it costs; every later snapshot resends the full frame.
  let naive = 0;
  for (let i = 0; i < history.length; i++) {
    naive +=
      i === 0 ? history[i]!.tokenUsage.inputTokens : baseline;
  }

  if (naive <= 0) return null;
  const pct = ((naive - actual) / naive) * 100;
  return Math.round(Math.max(-100, Math.min(100, pct)));
}

/** Paired cropped vs forceFull runs (same scene) — for debug calibrations only. */
export function computePairedImageTokenSavings(
  croppedInputTokens: number[],
  fullInputTokens: number[],
): number | null {
  if (
    croppedInputTokens.length === 0 ||
    croppedInputTokens.length !== fullInputTokens.length
  ) {
    return null;
  }
  const croppedTotal = croppedInputTokens.reduce((a, b) => a + b, 0);
  const fullTotal = fullInputTokens.reduce((a, b) => a + b, 0);
  if (fullTotal === 0) return null;
  return Math.round(((fullTotal - croppedTotal) / fullTotal) * 100);
}

/** §7-C: naive restated-history size vs S-RLE ledger size (characters). */
export function computeCompressionRatio(
  history: CommitState[],
): number | null {
  if (history.length < 2) return null;

  const naiveText = history
    .map(
      (c) =>
        `${c.commitHash}:${c.objects
          .map((o) => `${o.id}|${o.label}|${o.x},${o.y},${o.z}|${o.status}`)
          .join(";")}`,
    )
    .join("\n");

  const compressed: CompressedLedger = compressSpatialHistory(history);
  const compressedText = JSON.stringify(compressed);

  const naiveSize = naiveText.length;
  const compressedSize = compressedText.length;
  if (compressedSize === 0 || naiveSize === 0) return null;

  const ratio = naiveSize / compressedSize;
  // Short histories have JSON overhead; don't show a misleading sub-1× ratio.
  if (ratio < 1) return null;
  return Math.round(ratio * 100) / 100;
}

export interface GroundTruthFixture {
  commits: {
    commitHash: string;
    objects: { id: string; label: string }[];
  }[];
}

/** §7-B: reconciliation accuracy harness scaffold. */
export function computeReconciliationAccuracy(
  history: CommitState[],
  groundTruth: GroundTruthFixture,
): number | null {
  if (groundTruth.commits.length === 0) return null;

  let matched = 0;
  let total = 0;

  for (const gtCommit of groundTruth.commits) {
    const actual = history.find((c) => c.commitHash === gtCommit.commitHash);
    if (!actual) continue;

    for (const gtObj of gtCommit.objects) {
      total++;
      const found = actual.objects.find(
        (o) => o.id === gtObj.id && o.label === gtObj.label,
      );
      if (found) matched++;
    }
  }

  if (total === 0) return null;
  return Math.round((matched / total) * 100);
}

export function buildTokenMetrics(
  history: CommitState[],
  croppedInputTokens: number[] = [],
  fullInputTokens: number[] = [],
  groundTruth?: GroundTruthFixture,
): TokenMetrics {
  const cumulative = computeCumulativeTokens(history);
  const stack = computeStackSavings(history);
  const latest = history.length > 0 ? history[history.length - 1]! : null;
  return {
    cumulativeInputTokens: cumulative.input,
    cumulativeOutputTokens: cumulative.output,
    imageTokenSavingsPercent: computeImageTokenSavingsFromHistory(history),
    compressionRatio: computeCompressionRatio(history),
    reconciliationAccuracy: groundTruth
      ? computeReconciliationAccuracy(history, groundTruth)
      : null,
    cumulativeTokensSaved: stack.saved,
    cumulativeNaiveInputTokens: stack.naive,
    overallSavingsPercent: stack.percent,
    latestBreakdown: latest?.compression ?? null,
    croppedInputTokens,
    fullInputTokens,
  };
}

export function formatCommitDiff(
  current: CommitState,
  previous: CommitState | null,
): string {
  if (!previous) {
    const labels = current.objects.map((o) => o.label).join(", ");
    return `${current.commitHash}: initial snapshot — ${labels || "no objects"}`;
  }

  const parts: string[] = [];
  const prevById = new Map(previous.objects.map((o) => [o.id, o]));
  const currById = new Map(current.objects.map((o) => [o.id, o]));

  for (const obj of current.objects) {
    const prev = prevById.get(obj.id);
    if (!prev) {
      parts.push(`${obj.label} newly visible`);
    } else if (prev.x !== obj.x || prev.y !== obj.y || prev.z !== obj.z) {
      parts.push(
        `${obj.label} moved [${prev.x},${prev.y}]->[${obj.x},${obj.y}]`,
      );
    } else {
      parts.push(`${obj.label} unchanged`);
    }
  }

  for (const obj of previous.objects) {
    if (!currById.has(obj.id)) {
      parts.push(`${obj.label} missing`);
    }
  }

  if (current.tokenUsage.inputTokens === 0 && current.tokenUsage.outputTokens === 0) {
    parts.push("(no Claude call — scene unchanged)");
  }

  return `${current.commitHash}: ${parts.join(", ")}`;
}

export function classifyObjectDiff(
  obj: PhysicalObject,
  previous: CommitState | null,
): "new" | "missing" | "moved" | "unchanged" {
  if (!previous) return "new";
  const prev = previous.objects.find((o) => o.id === obj.id);
  if (!prev) return "new";
  if (prev.x !== obj.x || prev.y !== obj.y || prev.z !== obj.z) return "moved";
  return "unchanged";
}

export function findMissingObjects(
  current: CommitState,
  previous: CommitState | null,
): PhysicalObject[] {
  if (!previous) return [];
  const currIds = new Set(current.objects.map((o) => o.id));
  return previous.objects.filter((o) => !currIds.has(o.id));
}
