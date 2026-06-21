import { NextRequest, NextResponse } from "next/server";
import {
  closePullRequest,
  createPullRequest,
  getPullRequests,
  mergePullRequest,
} from "@/lib/store";

export const runtime = "nodejs";

export async function GET() {
  const pullRequests = await getPullRequests();
  return NextResponse.json({ pullRequests });
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      title?: string;
      body?: string;
      sourceBranch?: string;
      targetBranch?: string;
      action?: "merge" | "close";
      id?: number;
    };

    if (body.action === "merge" && body.id != null) {
      const pr = await mergePullRequest(body.id);
      if (!pr) {
        return NextResponse.json({ error: "PR not found or not open" }, { status: 404 });
      }
      return NextResponse.json({ pullRequest: pr });
    }

    if (body.action === "close" && body.id != null) {
      const pr = await closePullRequest(body.id);
      if (!pr) {
        return NextResponse.json({ error: "PR not found or not open" }, { status: 404 });
      }
      return NextResponse.json({ pullRequest: pr });
    }

    if (!body.title?.trim() || !body.sourceBranch || !body.targetBranch) {
      return NextResponse.json(
        { error: "Title, sourceBranch, and targetBranch required" },
        { status: 400 },
      );
    }

    const pullRequest = await createPullRequest(
      body.title.trim(),
      body.body?.trim() ?? "",
      body.sourceBranch,
      body.targetBranch,
    );
    return NextResponse.json({ pullRequest });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "PR failed" },
      { status: 400 },
    );
  }
}
