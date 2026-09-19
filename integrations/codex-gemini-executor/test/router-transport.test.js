import test from "node:test";
import assert from "node:assert/strict";

import { assertPublicRouterEndpoint, validatePublicRouterUrl, validateConfiguredRouterUrl, assertConfiguredRouterEndpoint } from "../src/router-transport.js";

test("configured endpoint allows only the exact local 9Router origin", () => {
  assert.equal(validateConfiguredRouterUrl("http://127.0.0.1:20128/"), "http://127.0.0.1:20128");
  assert.doesNotThrow(() => assertConfiguredRouterEndpoint("http://127.0.0.1:20128/v1/responses"));
  for (const url of ["http://localhost:20128", "http://127.0.0.1:20129", "http://127.1:20128",
    "http://2130706433:20128", "http://[::1]:20128", "http://user:pass@127.0.0.1:20128",
    "http://127.0.0.1:20128?x=1", "http://10.0.0.1:20128"]) {
    assert.throws(() => validateConfiguredRouterUrl(url), { code: "router_transport_rejected" });
  }
  assert.throws(() => assertConfiguredRouterEndpoint("http://127.0.0.1:20128/other"));
});

function rejectsTransport(value) {
  return assert.throws(() => validatePublicRouterUrl(value), { code: "router_transport_rejected" });
}

test("accepts public http/https router URLs and returns the normalized base", () => {
  assert.equal(validatePublicRouterUrl("https://router.example.test"), "https://router.example.test");
  assert.equal(validatePublicRouterUrl("https://router.example.test/"), "https://router.example.test");
  assert.equal(validatePublicRouterUrl("http://router.9router.com:8443"), "http://router.9router.com:8443");
  assert.equal(validatePublicRouterUrl("http://93.184.216.34:20128"), "http://93.184.216.34:20128");
  assert.equal(validatePublicRouterUrl("https://[2606:4700::1]:20128"), "https://[2606:4700::1]:20128");
});

test("rejects non-http(s) schemes", () => {
  rejectsTransport("file://C:/router/v1");
  rejectsTransport("ftp://router.example.test");
  rejectsTransport("unix:///run/router.sock");
});

test("rejects credentials, query, hash, extra path, and invalid ports", () => {
  rejectsTransport("http://user:pass@router.example.test");
  rejectsTransport("https://router.example.test/?x=1");
  rejectsTransport("https://router.example.test/#frag");
  rejectsTransport("https://router.example.test/api");
  rejectsTransport("https://router.example.test:70000");
  rejectsTransport("https://router.example.test:0");
});

test("rejects loopback and this-network IPv4 literals", () => {
  for (const host of ["127.0.0.1", "127.8.8.8", "0.0.0.0", "0.1.2.3"]) {
    rejectsTransport(`http://${host}:20128`);
  }
});

test("rejects private and link-local IPv4 literals", () => {
  for (const host of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.1.1", "100.64.0.1"]) {
    rejectsTransport(`http://${host}:20128`);
  }
});

test("rejects reserved, benchmark, documentation, multicast, and broadcast IPv4 literals", () => {
  for (const host of ["192.0.0.1", "192.0.2.1", "198.18.0.1", "198.19.255.255", "198.51.100.7",
    "203.0.113.9", "224.0.0.1", "239.1.1.1", "240.0.0.1", "255.255.255.255"]) {
    rejectsTransport(`http://${host}:20128`);
  }
});

test("accepts IPv4 literals just outside the blocked ranges", () => {
  for (const host of ["11.0.0.1", "172.32.0.1", "100.128.0.1", "198.20.0.1", "193.0.0.1"]) {
    assert.doesNotThrow(() => validatePublicRouterUrl(`http://${host}:20128`));
  }
});

test("rejects loopback, unspecified, mapped, link-local, ULA, multicast, and documentation IPv6 literals", () => {
  for (const host of ["[::1]", "[::]", "[::ffff:127.0.0.1]", "[::ffff:10.0.0.1]", "[::ffff:192.168.0.1]",
    "[fe80::1]", "[fc00::1]", "[fd12::1]", "[ff02::1]", "[2001:db8::1]"]) {
    rejectsTransport(`http://${host}:20128`);
  }
  rejectsTransport("http://[fe80::1%25eth0]:20128");
});

test("rejects localhost and mDNS hostnames in any case", () => {
  for (const host of ["localhost", "LOCALHOST", "sub.localhost", "host.local", "host.LOCAL"]) {
    rejectsTransport(`http://${host}:20128`);
  }
});

test("assertPublicRouterEndpoint allows the responses path on a public host and rejects non-public hosts", () => {
  assert.doesNotThrow(() => assertPublicRouterEndpoint("https://router.example.test/v1/responses"));
  assert.doesNotThrow(() => assertPublicRouterEndpoint("http://router.9router.com:8443/v1/responses"));
  assert.throws(() => assertPublicRouterEndpoint("http://127.0.0.1:20128/v1/responses"), { code: "router_transport_rejected" });
  assert.throws(() => assertPublicRouterEndpoint("https://10.0.0.5/v1/responses"), { code: "router_transport_rejected" });
  assert.throws(() => assertPublicRouterEndpoint("file:///v1/responses"), { code: "router_transport_rejected" });
  assert.throws(() => assertPublicRouterEndpoint("not a url"), { code: "router_transport_rejected" });
});

test("rejects empty, oversized, and non-string input", () => {
  rejectsTransport("");
  rejectsTransport("   ");
  rejectsTransport(null);
  rejectsTransport(42);
  rejectsTransport(`https://${"a".repeat(5000)}.test`);
});
