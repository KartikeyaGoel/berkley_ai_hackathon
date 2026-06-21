"use client";

import {
  CircleDot,
  GitBranch,
  GitFork,
  GitPullRequest,
  Layers,
  Plus,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { IssuesPanel } from "@/components/topo/issues-panel";
import { PullsPanel } from "@/components/topo/pulls-panel";
import { WorkspacePanel } from "@/components/topo/workspace-panel";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export interface BranchInfo {
  name: string;
  commits: number;
  forkedFrom?: string;
}

export function TopoApp() {
  const [currentBranch, setCurrentBranch] = useState("main");
  const [branches, setBranches] = useState<BranchInfo[]>([
    { name: "main", commits: 0 },
  ]);
  const [branchDialogOpen, setBranchDialogOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [branchAction, setBranchAction] = useState<"create" | "fork">("create");
  const [branchLoading, setBranchLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const loadBranches = useCallback(async () => {
    const res = await fetch("/api/branches");
    if (!res.ok) return;
    const data = (await res.json()) as {
      currentBranch: string;
      branches: BranchInfo[];
    };
    setCurrentBranch(data.currentBranch);
    setBranches(data.branches);
  }, []);

  useEffect(() => {
    void loadBranches();
  }, [loadBranches]);

  const refresh = useCallback(async () => {
    await loadBranches();
    setRefreshKey((k) => k + 1);
  }, [loadBranches]);

  const switchBranch = useCallback(
    async (name: string) => {
      const res = await fetch("/api/branches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "switch", name }),
      });
      if (!res.ok) return;
      await refresh();
    },
    [refresh],
  );

  const handleBranchAction = useCallback(async () => {
    if (!newBranchName.trim()) return;
    setBranchLoading(true);
    try {
      const res = await fetch("/api/branches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: branchAction,
          name: newBranchName.trim(),
          from: currentBranch,
        }),
      });
      if (!res.ok) return;
      setBranchDialogOpen(false);
      setNewBranchName("");
      await refresh();
    } finally {
      setBranchLoading(false);
    }
  }, [branchAction, currentBranch, newBranchName, refresh]);

  const currentBranchInfo = branches.find((b) => b.name === currentBranch);

  return (
    <main className="topo-shell-bg min-h-screen">
      <header className="border-b border-border/80 bg-card/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-5 sm:px-6 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Layers className="size-5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Topo</h1>
              <p className="text-sm text-muted-foreground">
                Version-controlled physical space
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <ThemeToggle />
            <Select
              value={currentBranch}
              onValueChange={(v) => {
                if (v) void switchBranch(v);
              }}
            >
              <SelectTrigger className="w-full min-w-0 gap-2 font-mono text-xs sm:w-fit sm:min-w-[140px]">
                <GitBranch className="size-3.5 text-primary" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {branches.map((b) => (
                  <SelectItem key={b.name} value={b.name}>
                    {b.name} ({b.commits})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Dialog open={branchDialogOpen} onOpenChange={setBranchDialogOpen}>
              <DialogTrigger
                render={
                  <Button variant="outline" size="sm" className="gap-1.5" />
                }
              >
                <Plus className="size-3.5" />
                Branch
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>New branch or fork</DialogTitle>
                  <DialogDescription>
                    Create an empty branch or fork the current branch with its
                    full commit history.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-2">
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant={branchAction === "create" ? "default" : "outline"}
                      size="sm"
                      className="flex-1 gap-1.5"
                      onClick={() => setBranchAction("create")}
                    >
                      <GitBranch className="size-3.5" />
                      New branch
                    </Button>
                    <Button
                      type="button"
                      variant={branchAction === "fork" ? "default" : "outline"}
                      size="sm"
                      className="flex-1 gap-1.5"
                      onClick={() => setBranchAction("fork")}
                    >
                      <GitFork className="size-3.5" />
                      Fork
                    </Button>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="branch-name">Branch name</Label>
                    <Input
                      id="branch-name"
                      placeholder="experiment-bench"
                      value={newBranchName}
                      onChange={(e) => setNewBranchName(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      From{" "}
                      <span className="font-mono text-foreground">
                        {currentBranch}
                      </span>
                      {branchAction === "fork"
                        ? " — copies all commits"
                        : " — starts empty"}
                    </p>
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    onClick={() => void handleBranchAction()}
                    disabled={branchLoading || !newBranchName.trim()}
                  >
                    {branchAction === "fork" ? "Fork branch" : "Create branch"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Badge variant="secondary" className="font-mono text-xs">
              {currentBranchInfo?.commits ?? 0} commits
            </Badge>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <Tabs defaultValue="workspace">
          <TabsList
            variant="line"
            className="no-scrollbar h-11 w-full justify-start overflow-x-auto rounded-none border-b bg-transparent px-0"
          >
            <TabsTrigger value="workspace" className="shrink-0 px-3 sm:px-4">
              Workspace
            </TabsTrigger>
            <TabsTrigger value="issues" className="shrink-0 gap-1.5 px-3 sm:px-4">
              <CircleDot className="size-3.5" />
              Issues
            </TabsTrigger>
            <TabsTrigger value="pulls" className="shrink-0 gap-1.5 px-3 sm:px-4">
              <GitPullRequest className="size-3.5" />
              <span className="hidden sm:inline">Pull requests</span>
              <span className="sm:hidden">PRs</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="workspace" className="py-6">
            <WorkspacePanel
              key={`${currentBranch}-${refreshKey}`}
              branch={currentBranch}
              onBranchesLoaded={loadBranches}
              onRefresh={refresh}
            />
          </TabsContent>
          <TabsContent value="issues" className="py-6">
            <IssuesPanel branch={currentBranch} branches={branches} />
          </TabsContent>
          <TabsContent value="pulls" className="py-6">
            <PullsPanel
              branch={currentBranch}
              branches={branches}
              onMerged={refresh}
            />
          </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}
