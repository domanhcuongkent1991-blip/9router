// RAM cooldown for no-auth free lanes (connectionId === "noauth").
// The free lane has no connection record to carry modelLock_* keys, so a 429
// from upstream used to leave no trace: every next request went straight back
// upstream and burned the daily quota faster (see auth.js markAccountUnavailable's
// early return). This store is the lane's lock — keyed by provider:model, TTL
// from upstream retry-after/resetsAt when the caller has one.
const NOAUTH_MAX_COOLDOWN_MS = 6 * 60 * 60 * 1000;

const cooldowns = new Map(); // `${providerId}:${model}` -> expiry epoch ms

/** Arm (or extend) the free-lane cooldown for provider:model. */
export function markNoauthCooldown(providerId, model, cooldownMs) {
  if (!providerId) return;
  const ms = Math.min(Number(cooldownMs) || 0, NOAUTH_MAX_COOLDOWN_MS);
  if (ms <= 0) return;
  const key = `${providerId}:${model || "*"}`;
  const expiry = Date.now() + ms;
  if ((cooldowns.get(key) || 0) >= expiry) return;
  cooldowns.set(key, expiry);
}

/** Expiry timestamp still in the future for provider:model, else null (lazy-cleaned). */
export function getNoauthCooldownUntil(providerId, model) {
  if (!providerId) return null;
  const now = Date.now();
  const keys = [`${providerId}:${model || "*"}`, `${providerId}:*`];
  let earliest = null;
  for (const key of keys) {
    const expiry = cooldowns.get(key);
    if (!expiry) continue;
    if (expiry <= now) {
      cooldowns.delete(key);
      continue;
    }
    if (earliest === null || expiry < earliest) earliest = expiry;
  }
  return earliest;
}

/** Test hook: drop all armed cooldowns. */
export function resetNoauthCooldowns() {
  cooldowns.clear();
}
