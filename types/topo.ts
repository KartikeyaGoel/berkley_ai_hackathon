export interface PhysicalObject {
  id: string;          // stable across commits once reconciled
  label: string;
  x: number;            // 0-10 grid
  y: number;            // 0-10 grid
  z: number;             // rough depth ordering, 0-10
  status: "idle" | "active" | "misplaced" | "hazard";
  confidence: number;    // model's own confidence in this object's identity match
}

/**
 * Per-commit accounting for each deterministic compression layer.
 * Every field is "what we actually sent" vs "what a naive client would send",
 * so the UI / Sentry can attribute savings to a specific layer.
 */
export interface CompressionBreakdown {
  /** Layer 1 — visual delta cropping (image payload). */
  visual: {
    bytesSent: number;
    bytesNaive: number; // full frame
    approxTokensSent: number;
    approxTokensNaive: number;
  };
  /** Layer 2 — structured state-delta prompt (text payload). */
  state: {
    charsSent: number;
    charsNaive: number; // full JSON.stringify(priorObjects)
    approxTokensSent: number;
    approxTokensNaive: number;
    inViewObjects: number;
    omittedObjects: number; // provably-unchanged, coords deleted from prompt
  };
  /** Layer 3 — zero-token skip (no Claude call at all). */
  skipped: boolean;
  /** Total approx input tokens saved this commit vs the naive baseline. */
  approxTokensSaved: number;
}

export interface CommitState {
  commitHash: string;     // short hash, e.g. c1, c2...
  timestamp: number;
  objects: PhysicalObject[];
  reconciliationNotes: string; // Claude's stated reasoning for id matches, logged not shown
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    imageBytesSent: number;
    regionCropped: boolean;
  };
  /** Optional — present once the layered compressor runs (added post-c0 commits too). */
  compression?: CompressionBreakdown;
}

export interface CompressedLedger {
  dictMap: Record<string, string>;
  spaceLedger: Record<string, {
    intervals: { startCommit: string; endCommit: string; x: number; y: number; z: number; status: string }[];
  }>;
}

export interface BranchData {
  history: CommitState[];
  forkedFrom?: string;
  createdAt: number;
}

export interface Issue {
  id: number;
  title: string;
  body: string;
  status: "open" | "closed";
  branch: string;
  createdAt: number;
}

export interface PullRequest {
  id: number;
  title: string;
  body: string;
  sourceBranch: string;
  targetBranch: string;
  status: "open" | "merged" | "closed";
  createdAt: number;
}

export interface RepoStore {
  currentBranch: string;
  branches: Record<string, BranchData>;
  issues: Issue[];
  pullRequests: PullRequest[];
  nextIssueId: number;
  nextPullId: number;
}
