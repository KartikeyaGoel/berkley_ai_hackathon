import { NextRequest, NextResponse } from "next/server";
import {
  createIssue,
  getIssues,
  updateIssueStatus,
} from "@/lib/store";

export const runtime = "nodejs";

export async function GET() {
  const issues = await getIssues();
  return NextResponse.json({ issues });
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      title?: string;
      body?: string;
      branch?: string;
      action?: "close" | "reopen";
      id?: number;
    };

    if (body.action && body.id != null) {
      const status = body.action === "close" ? "closed" : "open";
      const issue = await updateIssueStatus(body.id, status);
      if (!issue) {
        return NextResponse.json({ error: "Issue not found" }, { status: 404 });
      }
      return NextResponse.json({ issue });
    }

    if (!body.title?.trim()) {
      return NextResponse.json({ error: "Title required" }, { status: 400 });
    }

    const issue = await createIssue(
      body.title.trim(),
      body.body?.trim() ?? "",
      body.branch,
    );
    return NextResponse.json({ issue });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Issue failed" },
      { status: 400 },
    );
  }
}
