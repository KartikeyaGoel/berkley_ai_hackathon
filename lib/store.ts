import fs from "fs/promises";
import path from "path";
import { put } from "@vercel/blob";
import { redisGetJson, redisSetJson } from "@/lib/redis";
import type { BranchData, CommitState, Issue, PullRequest, RepoStore } from "@/types/topo";

const DATA_DIR = path.join(process.cwd(), ".topo-data");
const PHOTOS_DIR = path.join(DATA_DIR, "photos");
const REPO_PATH = path.join(DATA_DIR, "repo.json");
const LEGACY_LEDGER_PATH = path.join(DATA_DIR, "ledger.json");
const KV_REPO_KEY = "topo:repo";

function isVercelRuntime(): boolean {
  return process.env.VERCEL === "1";
}

function hasRemoteStorageCreds(): boolean {
  return !!(process.env.BLOB_READ_WRITE_TOKEN && process.env.REDIS_URL);
}

/**
 * Local dev: filesystem under .topo-data/ (default).
 * Vercel: Blob + Redis whenever credentials exist (linked Storage auto-injects env vars).
 * Local + TOPO_USE_VERCEL_STORAGE=1: opt-in to real Blob/Redis for integration testing.
 */
function useRemoteBackend(): boolean {
  if (process.env.TOPO_USE_VERCEL_STORAGE === "1") {
    return hasRemoteStorageCreds();
  }
  if (isVercelRuntime()) {
    return hasRemoteStorageCreds();
  }
  return false;
}

function storageConfigError(): string {
  const missing: string[] = [];
  if (!process.env.BLOB_READ_WRITE_TOKEN) missing.push("BLOB_READ_WRITE_TOKEN");
  if (!process.env.REDIS_URL) missing.push("REDIS_URL");
  return (
    "Topo cannot write to the server filesystem on Vercel. " +
    "Link a Redis database and a Blob store to this project in the Vercel dashboard " +
    "(Storage / Marketplace → Redis + Blob), then redeploy so " +
    (missing.length > 0
      ? `these env vars are set: ${missing.join(", ")}.`
      : "BLOB_READ_WRITE_TOKEN and REDIS_URL are available.")
  );
}

/** Throws on Vercel when Blob/KV are not configured — never mkdir .topo-data there. */
function assertLocalFilesystemAllowed(): void {
  if (isVercelRuntime()) {
    throw new Error(storageConfigError());
  }
}

function emptyStore(): RepoStore {
  return {
    currentBranch: "main",
    branches: { main: { history: [], createdAt: Date.now() } },
    issues: [],
    pullRequests: [],
    nextIssueId: 1,
    nextPullId: 1,
  };
}

function sanitizeBranch(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
}

function photoPath(branch: string): string {
  return path.join(PHOTOS_DIR, `${sanitizeBranch(branch)}.jpg`);
}

async function ensureLocalDirs(): Promise<void> {
  await fs.mkdir(PHOTOS_DIR, { recursive: true });
}

async function readLocalRepo(): Promise<RepoStore> {
  try {
    const raw = await fs.readFile(REPO_PATH, "utf-8");
    return JSON.parse(raw) as RepoStore;
  } catch {
    /* migrate legacy single-branch ledger */
    try {
      const legacy = await fs.readFile(LEGACY_LEDGER_PATH, "utf-8");
      const history = JSON.parse(legacy) as CommitState[];
      const store = emptyStore();
      store.branches.main = { history, createdAt: Date.now() };
      await writeLocalRepo(store);
      return store;
    } catch {
      return emptyStore();
    }
  }
}

async function writeLocalRepo(store: RepoStore): Promise<void> {
  await ensureLocalDirs();
  await fs.writeFile(REPO_PATH, JSON.stringify(store, null, 2));
}

export async function getRepoStore(): Promise<RepoStore> {
  if (useRemoteBackend()) {
    const store = await redisGetJson<RepoStore>(KV_REPO_KEY);
    return store ?? emptyStore();
  }
  assertLocalFilesystemAllowed();
  return readLocalRepo();
}

async function saveRepoStore(store: RepoStore): Promise<void> {
  if (useRemoteBackend()) {
    await redisSetJson(KV_REPO_KEY, store);
    return;
  }
  assertLocalFilesystemAllowed();
  await writeLocalRepo(store);
}

export async function getCurrentBranch(): Promise<string> {
  const store = await getRepoStore();
  return store.currentBranch;
}

export async function listBranches(): Promise<
  { name: string; commits: number; forkedFrom?: string }[]
> {
  const store = await getRepoStore();
  return Object.entries(store.branches).map(([name, data]) => ({
    name,
    commits: data.history.length,
    forkedFrom: data.forkedFrom,
  }));
}

export async function switchBranch(name: string): Promise<RepoStore> {
  const store = await getRepoStore();
  if (!store.branches[name]) {
    throw new Error(`Branch "${name}" does not exist`);
  }
  store.currentBranch = name;
  await saveRepoStore(store);
  return store;
}

export async function createBranch(
  name: string,
  options: { from?: string; fork?: boolean } = {},
): Promise<RepoStore> {
  const trimmed = name.trim();
  if (!trimmed || !/^[a-zA-Z0-9/_-]+$/.test(trimmed)) {
    throw new Error("Invalid branch name");
  }
  const store = await getRepoStore();
  if (store.branches[trimmed]) {
    throw new Error(`Branch "${trimmed}" already exists`);
  }

  const sourceName = options.from ?? store.currentBranch;
  const source = store.branches[sourceName];

  if (options.fork && source) {
    store.branches[trimmed] = {
      history: structuredClone(source.history),
      forkedFrom: sourceName,
      createdAt: Date.now(),
    };
    if (!useRemoteBackend()) {
      try {
        await ensureLocalDirs();
        await fs.copyFile(photoPath(sourceName), photoPath(trimmed));
      } catch {
        /* no photo yet */
      }
    }
  } else {
    store.branches[trimmed] = {
      history: [],
      forkedFrom: sourceName,
      createdAt: Date.now(),
    };
  }

  store.currentBranch = trimmed;
  await saveRepoStore(store);
  return store;
}

export async function getHistory(branch?: string): Promise<CommitState[]> {
  const store = await getRepoStore();
  const b = branch ?? store.currentBranch;
  return store.branches[b]?.history ?? [];
}

export async function getPrevPhoto(branch?: string): Promise<Buffer | null> {
  const store = await getRepoStore();
  const b = branch ?? store.currentBranch;

  if (useRemoteBackend()) {
    const url = await redisGetJson<string>(`topo:photo:${sanitizeBranch(b)}`);
    if (!url) return null;
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  }

  assertLocalFilesystemAllowed();
  try {
    return await fs.readFile(photoPath(b));
  } catch {
    return null;
  }
}

export async function putPhoto(buffer: Buffer, branch?: string): Promise<void> {
  const store = await getRepoStore();
  const b = branch ?? store.currentBranch;

  if (useRemoteBackend()) {
    const blob = await put(`topo/photo-${sanitizeBranch(b)}-${Date.now()}.jpg`, buffer, {
      access: "public",
      contentType: "image/jpeg",
    });
    await redisSetJson(`topo:photo:${sanitizeBranch(b)}`, blob.url);
    return;
  }

  assertLocalFilesystemAllowed();
  await ensureLocalDirs();
  await fs.writeFile(photoPath(b), buffer);
}

export async function appendCommit(
  commit: CommitState,
  branch?: string,
): Promise<CommitState[]> {
  const store = await getRepoStore();
  const b = branch ?? store.currentBranch;
  if (!store.branches[b]) {
    store.branches[b] = { history: [], createdAt: Date.now() };
  }
  store.branches[b]!.history.push(commit);
  await saveRepoStore(store);
  return store.branches[b]!.history;
}

export function nextCommitHash(history: CommitState[]): string {
  return `c${history.length + 1}`;
}

export async function clearBranch(branch?: string): Promise<void> {
  const store = await getRepoStore();
  const b = branch ?? store.currentBranch;
  if (store.branches[b]) {
    store.branches[b]!.history = [];
  }
  await saveRepoStore(store);

  if (!useRemoteBackend()) {
    try {
      await fs.unlink(photoPath(b));
    } catch {
      /* no photo */
    }
  }
}

export async function clearStore(): Promise<void> {
  const store = emptyStore();
  await saveRepoStore(store);
  if (!useRemoteBackend()) {
    try {
      await fs.rm(PHOTOS_DIR, { recursive: true, force: true });
    } catch {
      /* ok */
    }
    try {
      await fs.unlink(LEGACY_LEDGER_PATH);
    } catch {
      /* ok */
    }
  }
}

export async function getIssues(): Promise<Issue[]> {
  const store = await getRepoStore();
  return store.issues;
}

export async function createIssue(
  title: string,
  body: string,
  branch?: string,
): Promise<Issue> {
  const store = await getRepoStore();
  const issue: Issue = {
    id: store.nextIssueId++,
    title,
    body,
    status: "open",
    branch: branch ?? store.currentBranch,
    createdAt: Date.now(),
  };
  store.issues.unshift(issue);
  await saveRepoStore(store);
  return issue;
}

export async function updateIssueStatus(
  id: number,
  status: "open" | "closed",
): Promise<Issue | null> {
  const store = await getRepoStore();
  const issue = store.issues.find((i) => i.id === id);
  if (!issue) return null;
  issue.status = status;
  await saveRepoStore(store);
  return issue;
}

export async function getPullRequests(): Promise<PullRequest[]> {
  const store = await getRepoStore();
  return store.pullRequests;
}

export async function createPullRequest(
  title: string,
  body: string,
  sourceBranch: string,
  targetBranch: string,
): Promise<PullRequest> {
  const store = await getRepoStore();
  if (!store.branches[sourceBranch] || !store.branches[targetBranch]) {
    throw new Error("Invalid branch");
  }
  if (sourceBranch === targetBranch) {
    throw new Error("Source and target must differ");
  }
  const pr: PullRequest = {
    id: store.nextPullId++,
    title,
    body,
    sourceBranch,
    targetBranch,
    status: "open",
    createdAt: Date.now(),
  };
  store.pullRequests.unshift(pr);
  await saveRepoStore(store);
  return pr;
}

export async function mergePullRequest(id: number): Promise<PullRequest | null> {
  const store = await getRepoStore();
  const pr = store.pullRequests.find((p) => p.id === id);
  if (!pr || pr.status !== "open") return null;

  const source = store.branches[pr.sourceBranch]?.history ?? [];
  const target = store.branches[pr.targetBranch]?.history ?? [];
  const sourceHead = source.length > 0 ? source[source.length - 1]! : null;

  if (sourceHead) {
    const mergeCommit: CommitState = {
      commitHash: nextCommitHash(target),
      timestamp: Date.now(),
      objects: structuredClone(sourceHead.objects),
      reconciliationNotes: `Merged branch ${pr.sourceBranch} into ${pr.targetBranch} (PR #${pr.id})`,
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        imageBytesSent: 0,
        regionCropped: false,
      },
    };
    if (!store.branches[pr.targetBranch]) {
      store.branches[pr.targetBranch] = { history: [], createdAt: Date.now() };
    }
    store.branches[pr.targetBranch]!.history.push(mergeCommit);
  }

  pr.status = "merged";
  await saveRepoStore(store);
  return pr;
}

export async function closePullRequest(id: number): Promise<PullRequest | null> {
  const store = await getRepoStore();
  const pr = store.pullRequests.find((p) => p.id === id);
  if (!pr || pr.status !== "open") return null;
  pr.status = "closed";
  await saveRepoStore(store);
  return pr;
}
