import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pkg from "../../../../package.json" with { type: "json" };

export const dynamic = "force-dynamic";

const startupBuildId = readFile(join(process.cwd(), ".next", "BUILD_ID"), "utf8")
  .then((value) => value.trim(), () => null);

export async function GET() {
  try {
    const buildId = await startupBuildId;
    if (!buildId || buildId.length > 256 || process.env.NODE_ENV !== "production") throw new Error();
    return Response.json({ version: pkg.version, buildId, contractVersion: 1 }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json({ error: "unqualified_build" }, { status: 503 });
  }
}
