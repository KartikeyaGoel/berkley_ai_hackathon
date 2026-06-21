import { NextRequest, NextResponse } from "next/server";
import { getCurrentBranch } from "@/lib/store";
import {
  getMemoryStats,
  listObjectMemories,
} from "@/lib/spatialMemory";
import { isRedisConfigured } from "@/lib/redis";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const branch =
    request.nextUrl.searchParams.get("branch") ?? (await getCurrentBranch());

  if (!isRedisConfigured()) {
    return NextResponse.json({
      branch,
      enabled: false,
      objects: [],
      stats: { objectCount: 0, streamLength: 0, hintsUsedLastCommit: 0 },
    });
  }

  const [objects, stats] = await Promise.all([
    listObjectMemories(branch),
    getMemoryStats(branch),
  ]);

  return NextResponse.json({
    branch,
    enabled: true,
    objects,
    stats: { ...stats, hintsUsedLastCommit: 0 },
  });
}
