"use client";

import dynamic from "next/dynamic";
import {
  Camera,
  GitCommitHorizontal,
  Layers,
  Loader2,
  RotateCcw,
  Terminal,
  Upload,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { MetricStat } from "@/components/topo/metric-stat";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import type { CommitState, CompressedLedger } from "@/types/topo";
import type { TokenMetrics } from "@/utils/metrics";

const DiffViewer = dynamic(() => import("@/components/DiffViewer"), {
  ssr: false,
});

function pct(sent: number, naive: number): number | null {
  if (naive <= 0) return null;
  return Math.round(((naive - sent) / naive) * 100);
}

function LayerRow({
  label,
  detail,
  savings,
  active,
}: {
  label: string;
  detail: string;
  savings: number | null;
  active: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{label}</p>
        <p className="topo-terminal truncate text-[11px] text-muted-foreground">
          {detail}
        </p>
      </div>
      <Badge
        variant={active && savings != null ? "default" : "outline"}
        className="shrink-0 font-mono text-xs"
      >
        {savings != null ? `−${savings}%` : "—"}
      </Badge>
    </div>
  );
}

const SpatialPlaceholder = dynamic(
  () => import("@/components/DiffViewer").then((m) => m.SpatialPlaceholder),
  { ssr: false },
);

interface CommitResponse {
  commit: CommitState;
  history: CommitState[];
  compressed: CompressedLedger;
  metrics: TokenMetrics;
  diffSummary: string;
  branch: string;
}

interface HistoryResponse {
  branch: string;
  history: CommitState[];
  compressed: CompressedLedger;
  metrics: TokenMetrics;
  log: string[];
}

export function WorkspacePanel({
  branch,
  onBranchesLoaded,
  onRefresh,
}: {
  branch: string;
  onBranchesLoaded: () => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const [history, setHistory] = useState<CommitState[]>([]);
  const [metrics, setMetrics] = useState<TokenMetrics | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [hydrating, setHydrating] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  // When OFF, send the full frame + full prior-state JSON (the naive baseline)
  // so judges can A/B the deterministic compression stack live.
  const [compressionOn, setCompressionOn] = useState(true);
  const forceFull = !compressionOn;
  const uploadRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  const loadHistory = useCallback(async () => {
    setHydrating(true);
    try {
      const res = await fetch(`/api/history?branch=${encodeURIComponent(branch)}`);
      if (!res.ok) throw new Error("Failed to load");
      const data = (await res.json()) as HistoryResponse;
      setHistory(data.history);
      setMetrics(data.metrics);
      setLog(data.log);
      await onBranchesLoaded();
    } catch {
      setHistory([]);
      setMetrics(null);
      setLog([]);
    } finally {
      setHydrating(false);
    }
  }, [branch, onBranchesLoaded]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const submitCommit = useCallback(
    async (file: File) => {
      setLoading(true);
      setError(null);
      try {
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(new Error("Failed to read image"));
          reader.readAsDataURL(file);
        });

        const params = new URLSearchParams({ branch });
        if (forceFull) params.set("forceFull", "1");

        const res = await fetch(`/api/commit?${params}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            image: base64,
            message: commitMessage.trim() || undefined,
          }),
        });

        if (!res.ok) {
          const err = (await res.json()) as { error?: string };
          throw new Error(err.error ?? "Commit failed");
        }

        const data = (await res.json()) as CommitResponse;
        setHistory(data.history);
        setMetrics(data.metrics);
        const msg = commitMessage.trim();
        setLog((prev) => [
          ...prev,
          msg
            ? `$ ${data.diffSummary}  // "${msg}"`
            : `$ ${data.diffSummary}`,
        ]);
        setCommitMessage("");
        await onRefresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    },
    [branch, commitMessage, forceFull, onRefresh],
  );

  const onFileSelected = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void submitCommit(file);
      e.target.value = "";
    },
    [submitCommit],
  );

  const resetBranch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/reset?branch=${encodeURIComponent(branch)}`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error("Reset failed");
      setHistory([]);
      setMetrics(null);
      setLog([]);
      setCommitMessage("");
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset failed");
    } finally {
      setLoading(false);
    }
  }, [branch, onRefresh]);

  const current = history.length > 0 ? history[history.length - 1]! : null;
  const previous = history.length > 1 ? history[history.length - 2]! : null;
  const head = current?.commitHash ?? "—";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="font-mono text-xs">
          HEAD {head}
        </Badge>
        <Badge variant="secondary" className="font-mono text-xs">
          {branch}
        </Badge>
      </div>

      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <GitCommitHorizontal className="size-4 text-primary" />
            <CardTitle className="text-base">New commit</CardTitle>
          </div>
          <CardDescription>
            Change the scene, then capture a snapshot when you are ready.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <span className="topo-terminal shrink-0 text-sm text-muted-foreground">
              -m
            </span>
            <Input
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder="moved wrench to the bench"
              disabled={loading}
              className="topo-terminal h-10"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              size="lg"
              onClick={() => uploadRef.current?.click()}
              disabled={loading || hydrating}
              className="gap-2"
            >
              {loading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Upload className="size-4" />
              )}
              {loading ? "Committing…" : "Upload snapshot"}
            </Button>
            <Button
              size="lg"
              variant="outline"
              onClick={() => cameraRef.current?.click()}
              disabled={loading || hydrating}
              className="gap-2 sm:hidden"
            >
              <Camera className="size-4" />
              Camera
            </Button>

            <AlertDialog>
              <AlertDialogTrigger
                render={
                  <Button
                    size="lg"
                    variant="ghost"
                    disabled={loading || history.length === 0}
                    className="gap-2 text-muted-foreground"
                  />
                }
              >
                <RotateCcw className="size-4" />
                Reset branch
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Reset {branch}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Clears commits on this branch only. Other branches are
                    untouched.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    onClick={() => void resetBranch()}
                  >
                    Reset
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>

          <input
            ref={uploadRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={onFileSelected}
            disabled={loading}
          />
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={onFileSelected}
            disabled={loading}
          />

          <div className="flex items-center gap-3 rounded-lg border bg-muted/40 px-3 py-2.5">
            <Switch
              id={`compression-${branch}`}
              checked={compressionOn}
              onCheckedChange={setCompressionOn}
            />
            <label
              htmlFor={`compression-${branch}`}
              className="cursor-pointer text-sm"
            >
              <span className="font-medium">Compression stack</span>{" "}
              <span className="text-muted-foreground">
                {compressionOn
                  ? "on — visual + state deltas"
                  : "off — sending full frame + full state (baseline)"}
              </span>
            </label>
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="overflow-hidden shadow-sm lg:col-span-3">
          <CardHeader className="border-b pb-3">
            <CardTitle className="text-base">Spatial diff</CardTitle>
            <CardDescription>Changes vs. previous commit</CardDescription>
          </CardHeader>
          <CardContent className="p-4">
            {hydrating ? (
              <Skeleton className="w-full rounded-xl" style={{ height: 360 }} />
            ) : current ? (
              <DiffViewer current={current} previous={previous} />
            ) : (
              <SpatialPlaceholder />
            )}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-6 lg:col-span-2">
          <Card className="shadow-sm">
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <Terminal className="size-4 text-primary" />
                <CardTitle className="text-base">Commit log</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[220px] rounded-lg border bg-muted/30">
                <div className="topo-terminal space-y-1.5 p-3 text-xs leading-relaxed">
                  {log.length === 0 ? (
                    <>
                      <p className="text-primary">$ topo init</p>
                      <p className="text-muted-foreground">
                        awaiting first snapshot…
                      </p>
                    </>
                  ) : (
                    log.map((line, i) => (
                      <p
                        key={i}
                        className={
                          line.includes("no Claude call")
                            ? "text-muted-foreground"
                            : "text-foreground/90"
                        }
                      >
                        {line}
                      </p>
                    ))
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          <Card className="shadow-sm">
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <Zap className="size-4 text-chart-2" />
                <CardTitle className="text-base">Compression</CardTitle>
              </div>
              <CardDescription>Measured from real API usage</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-2">
                <MetricStat
                  label="Input tokens"
                  value={metrics?.cumulativeInputTokens ?? 0}
                />
                <MetricStat
                  label="Output tokens"
                  value={metrics?.cumulativeOutputTokens ?? 0}
                />
                <MetricStat
                  label="Image savings"
                  value={
                    metrics?.imageTokenSavingsPercent != null
                      ? `${metrics.imageTokenSavingsPercent}%`
                      : "—"
                  }
                  hint={
                    metrics?.imageTokenSavingsPercent == null
                      ? "Needs 2+ commits"
                      : "vs full frame every commit"
                  }
                  accent={metrics?.imageTokenSavingsPercent != null}
                />
                <MetricStat
                  label="S-RLE ratio"
                  value={
                    metrics?.compressionRatio != null
                      ? `${metrics.compressionRatio}×`
                      : "—"
                  }
                  hint={
                    metrics?.compressionRatio == null
                      ? "Needs longer history"
                      : "naive ÷ compressed"
                  }
                  accent={metrics?.compressionRatio != null}
                />
              </div>
            </CardContent>
            {current && (
              <>
                <Separator />
                <CardFooter className="text-[11px] text-muted-foreground">
                  {current.objects.length} objects · {current.commitHash}
                  {current.tokenUsage.inputTokens === 0 &&
                    current.tokenUsage.outputTokens === 0 &&
                    " · zero tokens"}
                </CardFooter>
              </>
            )}
          </Card>

          <Card className="shadow-sm">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Layers className="size-4 text-primary" />
                  <CardTitle className="text-base">Compression stack</CardTitle>
                </div>
                {metrics?.overallSavingsPercent != null && (
                  <Badge className="font-mono text-xs">
                    −{metrics.overallSavingsPercent}% input
                  </Badge>
                )}
              </div>
              <CardDescription>
                Deterministic layers · latest commit
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {metrics?.latestBreakdown ? (
                <>
                  <LayerRow
                    label="1 · Visual delta"
                    detail={
                      metrics.latestBreakdown.skipped
                        ? "no image sent"
                        : `${(
                            metrics.latestBreakdown.visual.bytesSent / 1024
                          ).toFixed(0)}KB vs ${(
                            metrics.latestBreakdown.visual.bytesNaive / 1024
                          ).toFixed(0)}KB full frame`
                    }
                    savings={pct(
                      metrics.latestBreakdown.visual.approxTokensSent,
                      metrics.latestBreakdown.visual.approxTokensNaive,
                    )}
                    active={!forceFull}
                  />
                  <LayerRow
                    label="2 · State delta"
                    detail={
                      metrics.latestBreakdown.skipped
                        ? "no prompt sent"
                        : `${metrics.latestBreakdown.state.inViewObjects} in-view · ${metrics.latestBreakdown.state.omittedObjects} coords deleted`
                    }
                    savings={pct(
                      metrics.latestBreakdown.state.approxTokensSent,
                      metrics.latestBreakdown.state.approxTokensNaive,
                    )}
                    active={!forceFull}
                  />
                  <LayerRow
                    label="3 · Zero-token skip"
                    detail={
                      metrics.latestBreakdown.skipped
                        ? "scene unchanged — Claude call avoided"
                        : "scene changed — reconciled"
                    }
                    savings={metrics.latestBreakdown.skipped ? 100 : null}
                    active={metrics.latestBreakdown.skipped}
                  />
                  <div className="flex items-center justify-between pt-1 text-xs text-muted-foreground">
                    <span>≈ tokens deleted this commit</span>
                    <span className="topo-terminal text-foreground">
                      {metrics.latestBreakdown.approxTokensSaved.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>≈ tokens deleted total</span>
                    <span className="topo-terminal text-foreground">
                      {metrics.cumulativeTokensSaved.toLocaleString()}
                    </span>
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Commit a snapshot to see per-layer savings.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
