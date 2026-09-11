import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import * as fs from "node:fs/promises";

export function createSessionStore({ directory, io = fs }) {
  const pathFor = (sessionId) => join(directory, `${createHash("sha256").update(sessionId).digest("hex")}.json`);
  return {
    async load(sessionId, request, fingerprint) {
      try {
        const raw = await io.readFile(pathFor(sessionId), "utf8");
        if (Buffer.byteLength(raw) > 16384) throw new Error();
        const record = JSON.parse(raw);
        if (record.schemaVersion !== 1 || record.sessionId !== sessionId || record.fingerprint !== fingerprint
          || record.workspace !== request.workspace || record.access !== request.access || record.model !== request.model
          || !record.context) throw new Error();
        return record.context;
      } catch {
        throw Object.assign(new Error("Session is unknown or belongs to another workspace/runtime"), { code: "invalid_request" });
      }
    },
    async save(sessionId, request, fingerprint, context) {
      const text = JSON.stringify({ schemaVersion: 1, sessionId, fingerprint,
        workspace: request.workspace, access: request.access, model: request.model, context });
      if (Buffer.byteLength(text) > 16384) throw new Error("Session metadata too large");
      await io.mkdir(directory, { recursive: true });
      const target = pathFor(sessionId);
      const temporary = `${target}.${randomUUID()}.tmp`;
      await io.writeFile(temporary, text, { flag: "wx", mode: 0o600 });
      await io.rename(temporary, target);
    },
  };
}
