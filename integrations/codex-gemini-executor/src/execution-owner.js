import * as fs from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

export function createExecutionOwner({ directory, io = fs }) {
  if (!isAbsolute(directory)) throw new TypeError("Absolute runtime directory required");
  const lockPath = join(directory, "execution-owner.json");
  return Object.freeze({
    async acquire() {
      const owner = { instanceId: randomUUID(), pid: process.pid,
        startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        acquiredAt: new Date().toISOString(), executable: process.execPath };
      await io.mkdir(directory, { recursive: true });
      try {
        await io.writeFile(lockPath, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
      } catch (error) {
        throw Object.assign(new Error("Runtime owned by another job or awaiting recovery"), {
          code: error.code === "EEXIST" ? "workspace_locked" : "protocol_error",
        });
      }
      let retained = false;
      let released = false;
      return Object.freeze({
        async quarantine() { retained = true; },
        async release() {
          if (released || retained) return;
          const record = JSON.parse(await io.readFile(lockPath, "utf8"));
          if (record.instanceId !== owner.instanceId) throw new Error("Runtime ownership changed");
          await io.unlink(lockPath);
          released = true;
        },
      });
    },
  });
}
