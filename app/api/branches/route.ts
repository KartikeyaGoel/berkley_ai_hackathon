import { NextRequest, NextResponse } from "next/server";
import {
  createBranch,
  getRepoStore,
  listBranches,
  switchBranch,
} from "@/lib/store";

export const runtime = "nodejs";

export async function GET() {
  const store = await getRepoStore();
  const branches = await listBranches();
  return NextResponse.json({
    currentBranch: store.currentBranch,
    branches,
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      action?: "create" | "fork" | "switch";
      name?: string;
      from?: string;
    };

    if (!body.name?.trim()) {
      return NextResponse.json({ error: "Branch name required" }, { status: 400 });
    }

    if (body.action === "switch") {
      const store = await switchBranch(body.name.trim());
      return NextResponse.json({
        currentBranch: store.currentBranch,
        branches: await listBranches(),
      });
    }

    const store = await createBranch(body.name.trim(), {
      from: body.from,
      fork: body.action === "fork",
    });

    return NextResponse.json({
      currentBranch: store.currentBranch,
      branches: await listBranches(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Branch operation failed" },
      { status: 400 },
    );
  }
}
