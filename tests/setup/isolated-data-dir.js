import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Unit tests must never touch the real 9router data dir. src/lib/dataDir.js
// snapshots DATA_DIR at import time, so this has to run before any test
// module loads — that is exactly what setupFiles guarantees. Without it,
// running a test that persists through @/models (e.g. the zed-native-auth
// callback test) with no explicit DATA_DIR silently wrote mock provider
// connections into the production DB — the source of the 11 bogus "Zed
// accounts" found on 2026-10-09.
const realDir = path.resolve(
  process.platform === "win32"
    ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "9router")
    : path.join(os.homedir(), ".9router"),
);

// Respect an isolated dir the runner chose explicitly (e.g.
// DATA_DIR=$(mktemp -d) npx vitest). Only force isolation when DATA_DIR is
// unset — or dangerously pointing straight at the real data dir.
const configured = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : null;
if (!configured || configured === realDir) {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9router-vitest-"));
}
