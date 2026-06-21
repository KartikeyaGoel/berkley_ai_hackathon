import { NextRequest, NextResponse } from "next/server";
import {
  clearAllSpatialMemory,
  clearSpatialMemory,
} from "@/lib/spatialMemory";
import { clearBranch, clearStore, getCurrentBranch, wipeRemoteStorage } from "@/lib/store";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const all = request.nextUrl.searchParams.get("all") === "1";
  if (all) {
    const wiped = await wipeRemoteStorage();
    await clearStore();
    await clearAllSpatialMemory();
    return NextResponse.json({ ok: true, cleared: "all", ...wiped });
  }
  const branch =
    request.nextUrl.searchParams.get("branch") ?? (await getCurrentBranch());
  await clearBranch(branch);
  await clearSpatialMemory(branch);
  return NextResponse.json({ ok: true, cleared: branch });
}
