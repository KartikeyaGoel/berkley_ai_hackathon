import { NextRequest, NextResponse } from "next/server";
import { clearBranch, clearStore, getCurrentBranch } from "@/lib/store";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const all = request.nextUrl.searchParams.get("all") === "1";
  if (all) {
    await clearStore();
    return NextResponse.json({ ok: true, cleared: "all" });
  }
  const branch =
    request.nextUrl.searchParams.get("branch") ?? (await getCurrentBranch());
  await clearBranch(branch);
  return NextResponse.json({ ok: true, cleared: branch });
}
