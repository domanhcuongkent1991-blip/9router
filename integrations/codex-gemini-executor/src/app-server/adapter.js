import { AppServerCompatibilityError, assessAppServerCompatibility } from "./compatibility.js";

function normalizeFailure(error, stage, observedVersion = "unknown") {
  if (error instanceof AppServerCompatibilityError) return error;
  return new AppServerCompatibilityError({ observedVersion, stage, causeType: error instanceof Error ? error.name : "UnknownError" });
}

export function createAppServerCompatibilityAdapter({ baseline, clientInfo, observeExecutable, initialize, probeRequiredContract, onWarning = () => {} }) {
  return Object.freeze({
    async check() {
      let stage = "observe"; let observation;
      try {
        observation = await observeExecutable();
        stage = "initialize";
        const handshake = await initialize({ clientInfo, capabilities: { experimentalApi: false } });
        if (handshake?.ok !== true) {
          throw new AppServerCompatibilityError({ observedVersion: observation?.version ?? "unknown", handshakeCompatible: false, schemaSubsetCompatible: false, missingCapabilities: [] });
        }
        stage = "probe";
        const probe = await probeRequiredContract();
        const result = assessAppServerCompatibility({ observation, baseline, handshake, schemaSubsetCompatible: probe.schemaSubsetCompatible, methods: probe.methods });
        for (const warning of result.warnings) {
          try { Promise.resolve(onWarning(warning)).catch(() => {}); } catch { /* warnings are non-gating */ }
        }
        return result;
      } catch (error) { throw normalizeFailure(error, stage, observation?.version); }
    },
  });
}
