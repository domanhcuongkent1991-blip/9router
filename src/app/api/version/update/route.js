import { NextResponse } from "next/server";

export async function POST() {
  // The legacy updater cannot checkpoint data or qualify MCP compatibility.
  return NextResponse.json(
    {
      success: false,
      code: "manual_upgrade_required",
      message: "One-click updates are disabled. Before a manual upgrade, create a verified backup, select an exact 9Router version, and validate MCP compatibility in isolation. No update or restart was started.",
    },
    { status: 409 }
  );
}
