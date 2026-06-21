import { NextResponse } from "next/server";
import { storageDiagnostics } from "@/lib/storageEnv";

export const runtime = "nodejs";

/** Debug endpoint — shows which storage env vars Vercel injected (names only). */
export async function GET() {
  const d = storageDiagnostics();
  return NextResponse.json({
    ready: d.ready,
    vercel: d.vercel,
    blobVarsDetected: d.blob,
    redisVarsDetected: d.redis,
    missing: d.missing,
    hint: d.ready
      ? "Storage is configured correctly."
      : "Link Blob + Redis in Vercel dashboard, ensure vars apply to Production AND Preview, then redeploy.",
  });
}
