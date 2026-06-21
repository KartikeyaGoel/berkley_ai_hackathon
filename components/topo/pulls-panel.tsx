"use client";

import { GitMerge, GitPullRequest, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { BranchInfo } from "@/components/topo/topo-app";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { PullRequest } from "@/types/topo";

export function PullsPanel({
  branch,
  branches,
  onMerged,
}: {
  branch: string;
  branches: BranchInfo[];
  onMerged: () => Promise<void>;
}) {
  const [pulls, setPulls] = useState<PullRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [source, setSource] = useState(branch);
  const [target, setTarget] = useState("main");

  const load = useCallback(async () => {
    const res = await fetch("/api/pulls");
    if (res.ok) {
      const data = (await res.json()) as { pullRequests: PullRequest[] };
      setPulls(data.pullRequests);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setSource(branch);
  }, [branch]);

  const createPR = async () => {
    if (!title.trim() || source === target) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/pulls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          body: body.trim(),
          sourceBranch: source,
          targetBranch: target,
        }),
      });
      if (res.ok) {
        setTitle("");
        setBody("");
        await load();
      }
    } finally {
      setSubmitting(false);
    }
  };

  const mergePR = async (id: number) => {
    await fetch("/api/pulls", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "merge", id }),
    });
    await load();
    await onMerged();
  };

  const closePR = async (id: number) => {
    await fetch("/api/pulls", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "close", id }),
    });
    await load();
  };

  const branchNames = branches.map((b) => b.name);

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <Card className="shadow-sm lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Open pull request</CardTitle>
          <CardDescription>
            Propose merging one branch&apos;s world state into another — like
            merging spatial timelines.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="pr-title">Title</Label>
            <Input
              id="pr-title"
              placeholder="Merge experiment-bench into main"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pr-body">Description</Label>
            <Textarea
              id="pr-body"
              placeholder="What changed on the source branch…"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="pr-source">From</Label>
              <select
                id="pr-source"
                className="flex h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm"
                value={source}
                onChange={(e) => setSource(e.target.value)}
              >
                {branchNames.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="pr-target">Into</Label>
              <select
                id="pr-target"
                className="flex h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                {branchNames.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <Button
            onClick={() => void createPR()}
            disabled={submitting || !title.trim() || source === target}
            className="w-full gap-2"
          >
            {submitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <>
                <GitPullRequest className="size-4" />
                Create pull request
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      <Card className="shadow-sm lg:col-span-3">
        <CardHeader>
          <CardTitle className="text-base">Pull requests</CardTitle>
          <CardDescription>
            {pulls.filter((p) => p.status === "open").length} open
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : pulls.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No pull requests yet.
            </p>
          ) : (
            pulls.map((pr) => (
              <div
                key={pr.id}
                className="rounded-lg border bg-card p-4 transition-colors hover:bg-muted/30"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="font-medium">
                      <span className="mr-2 font-mono text-xs text-muted-foreground">
                        #{pr.id}
                      </span>
                      {pr.title}
                    </p>
                    {pr.body && (
                      <p className="mt-1 text-sm text-muted-foreground">
                        {pr.body}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {pr.sourceBranch} → {pr.targetBranch}
                      </Badge>
                      <Badge
                        variant={
                          pr.status === "open"
                            ? "default"
                            : pr.status === "merged"
                              ? "secondary"
                              : "outline"
                        }
                        className="text-[10px]"
                      >
                        {pr.status}
                      </Badge>
                    </div>
                  </div>
                  {pr.status === "open" && (
                    <div className="flex shrink-0 gap-2">
                      <Button
                        size="sm"
                        className="gap-1.5"
                        onClick={() => void mergePR(pr.id)}
                      >
                        <GitMerge className="size-3.5" />
                        Merge
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void closePR(pr.id)}
                      >
                        Close
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
