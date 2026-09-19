import { isIP } from "node:net";

export class RouterTransportError extends Error {
  constructor(reason) {
    super("Router transport rejected");
    this.name = "RouterTransportError";
    this.code = "router_transport_rejected";
    this.details = { reason };
  }
}

const MAX_URL_BYTES = 4096;
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local"];
const BLOCKED_HOST_NAMES = new Set(["localhost"]);

function reject(reason) {
  throw new RouterTransportError(reason);
}

function isPublicHostname(hostname) {
  if (typeof hostname !== "string" || hostname.length === 0) return false;
  const host = hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) return isPublicIpv6(host.slice(1, -1));
  const bare = host.endsWith(".") ? host.slice(0, -1) : host;
  if (BLOCKED_HOST_NAMES.has(bare) || BLOCKED_HOST_SUFFIXES.some((suffix) => bare.endsWith(suffix))) return false;
  if (isIP(bare) === 4) return isPublicIpv4(bare.split(".").map(Number));
  if (bare.includes("%")) return false;
  return isIP(bare) === 0;
}

function isPublicIpv4(octets) {
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false;
  return true;
}

function isPublicIpv6(address) {
  if (address.includes("%")) return false;
  const mapped = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) return isPublicIpv4(mapped[1].split(".").map(Number));
  const groups = expandIpv6(address);
  if (!groups) return false;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return isPublicIpv4([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]);
  }
  if (groups.every((group) => group === 0)) return false;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return false;
  if (groups[0] >= 0xfe80 && groups[0] <= 0xfebf) return false;
  if (groups[0] >= 0xfc00 && groups[0] <= 0xfdff) return false;
  if (groups[0] >= 0xff00) return false;
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return false;
  return true;
}

function expandIpv6(address) {
  if (!address.includes(":")) return null;
  const doubleColonParts = address.split("::");
  if (doubleColonParts.length > 2) return null;
  const parseGroups = (part) => part.length === 0 ? [] : part.split(":").map((group) => /^[0-9a-f]{1,4}$/i.test(group) ? Number.parseInt(group, 16) : NaN);
  const head = parseGroups(doubleColonParts[0]);
  const tail = doubleColonParts.length === 2 ? parseGroups(doubleColonParts[1]) : [];
  if (head.some(Number.isNaN) || tail.some(Number.isNaN)) return null;
  if (doubleColonParts.length === 1) {
    return head.length === 8 ? head : null;
  }
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...Array(fill).fill(0), ...tail];
}

function parseRouterUrl(rawUrl, { allowPath = false } = {}) {
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0 || Buffer.byteLength(rawUrl, "utf8") > MAX_URL_BYTES) {
    reject("router_url_invalid");
  }
  let url;
  try { url = new URL(rawUrl); } catch { reject("router_url_invalid"); }
  if (!["http:", "https:"].includes(url.protocol)) reject("router_scheme_not_transport");
  if (url.username || url.password) reject("router_credentials_not_allowed");
  if (!isPublicHostname(url.hostname)) reject("router_host_not_public");
  if (!allowPath) {
    if (url.search || url.hash || (url.pathname !== "" && url.pathname !== "/")) reject("router_base_url_invalid");
    if (url.port !== "" && (!Number.isInteger(Number(url.port)) || Number(url.port) < 1 || Number(url.port) > 65_535)) {
      reject("router_port_invalid");
    }
  }
  return url;
}

export function validatePublicRouterUrl(rawUrl) {
  const url = parseRouterUrl(rawUrl);
  return url.toString().replace(/\/$/u, "");
}

export function assertPublicRouterEndpoint(rawUrl) {
  parseRouterUrl(rawUrl, { allowPath: true });
}

// Installation-owned endpoint only. No arbitrary private/LAN hosts, localhost
// DNS aliases or alternate loopback encodings; callers cannot supply this URL.
export function validateConfiguredRouterUrl(rawUrl) {
  if (rawUrl === "http://127.0.0.1:20128" || rawUrl === "http://127.0.0.1:20128/") {
    return "http://127.0.0.1:20128";
  }
  return validatePublicRouterUrl(rawUrl);
}

export function assertConfiguredRouterEndpoint(rawUrl) {
  if (rawUrl === "http://127.0.0.1:20128/v1/responses") return;
  assertPublicRouterEndpoint(rawUrl);
}
