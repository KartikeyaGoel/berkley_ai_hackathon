"use client";

import { CircleDot, Loader2 } from "lucide-react";
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
import type { Issue } from "@/types/topo";

export function IssuesPanel({
  branch,
  branches,
}: {
  branch: string;
  branches: BranchInfo[];
}) {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [issueBranch, setIssueBranch] = useState(branch);

  const load = useCallback(async () => {
    const res = await fetch("/api/issues");
    if (res.ok) {
      const data = (await res.json()) as { issues: Issue[] };
      setIssues(data.issues);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setIssueBranch(branch);
  }, [branch]);

  const createIssue = async () => {
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          body: body.trim(),
          branch: issueBranch,
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

  const toggleIssue = async (id: number, action: "close" | "reopen") => {
    await fetch("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, id }),
    });
    await load();
  };

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <Card className="shadow-sm lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Open an issue</CardTitle>
          <CardDescription>
            Track physical-world problems — misplaced objects, hazards, layout
            drift.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="issue-title">Title</Label>
            <Input
              id="issue-title"
              placeholder="Wrench not where commit c3 says it is"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="issue-body">Description</Label>
            <Textarea
              id="issue-body"
              placeholder="Expected vs observed state…"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="issue-branch">Branch</Label>
            <select
              id="issue-branch"
              className="flex h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm"
              value={issueBranch}
              onChange={(e) => setIssueBranch(e.target.value)}
            >
              {branches.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          <Button
            onClick={() => void createIssue()}
            disabled={submitting || !title.trim()}
            className="w-full"
          >
            {submitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              "Create issue"
            )}
          </Button>
        </CardContent>
      </Card>

      <Card className="shadow-sm lg:col-span-3">
        <CardHeader>
          <CardTitle className="text-base">Issues</CardTitle>
          <CardDescription>
            {issues.filter((i) => i.status === "open").length} open ·{" "}
            {issues.length} total
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : issues.length === 0 ? (
            <p className="text-sm text-muted-foreground">No issues yet.</p>
          ) : (
            issues.map((issue) => (
              <div
                key={issue.id}
                className="rounded-lg border bg-card p-4 transition-colors hover:bg-muted/30"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <CircleDot
                      className={`mt-0.5 size-4 shrink-0 ${
                        issue.status === "open"
                          ? "text-chart-4"
                          : "text-muted-foreground"
                      }`}
                    />
                    <div>
                      <p className="font-medium">
                        <span className="mr-2 font-mono text-xs text-muted-foreground">
                          #{issue.id}
                        </span>
                        {issue.title}
                      </p>
                      {issue.body && (
                        <p className="mt-1 text-sm text-muted-foreground">
                          {issue.body}
                        </p>
                      )}
                      <div className="mt-2 flex gap-2">
                        <Badge variant="outline" className="font-mono text-[10px]">
                          {issue.branch}
                        </Badge>
                        <Badge
                          variant={
                            issue.status === "open" ? "default" : "secondary"
                          }
                          className="text-[10px]"
                        >
                          {issue.status}
                        </Badge>
                      </div>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void toggleIssue(
                        issue.id,
                        issue.status === "open" ? "close" : "reopen",
                      )
                    }
                  >
                    {issue.status === "open" ? "Close" : "Reopen"}
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
