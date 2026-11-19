// node --test apps/helper/deploy/burst-capacity.test.mjs (card helper-answers-through-a-burst): a burst of page opens is
// a burst of connects from Caddy to the helper. The helper asks the kernel for a listen queue of LISTEN_BACKLOG
// (src/server.ts listenAt), compose.yaml lets the kernel give it (net.core.somaxconn in the helper's network, at least
// that), and the Caddyfile keeps up to IDLE_MIN idle connections to the helper so a burst's next requests reuse them
// rather than connect again (Caddy's default keeps 32).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LISTEN_BACKLOG, listenAt } from "../src/server.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The fewest idle connections Caddy may keep to the helper [design: over the 921 that 300 page opens held at once]. */
export const IDLE_MIN = 1_024;

/** The helper service's net.core.somaxconn in a compose file, or null when it sets none. */
export function somaxconnOf(compose) {
  const helper = compose.split(/\n(?= {2}[a-z][a-z0-9_-]*:\s*$)/m).find((b) => /^ {2}helper:\s*$/m.test(b)) ?? "";
  const m = /^ {4}sysctls:\s*\n(?: {6}.*\n)*? {6}net\.core\.somaxconn:\s*"?(\d+)"?\s*$/m.exec(helper);
  return m === null ? null : Number(m[1]);
}
/** The reverse_proxy transport's keepalive_idle_conns_per_host in a Caddyfile, or null when it sets none. */
export function idleOf(caddyfile) {
  const lines = caddyfile.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "").trim());
  const m = lines.map((l) => /^keepalive_idle_conns_per_host\s+(\d+)$/.exec(l)).filter(Boolean);
  return m.length === 1 ? Number(m[0][1]) : null;
}

test("the helper's listen queue: asked for LISTEN_BACKLOG on every port, and compose.yaml lets the kernel give it", () => {
  assert.ok(LISTEN_BACKLOG >= 4_096, String(LISTEN_BACKLOG));
  for (const p of [0, 8080]) assert.equal(listenAt(p).backlog, LISTEN_BACKLOG);
  const s = somaxconnOf(readFileSync(path.join(HERE, "compose.yaml"), "utf8"));
  assert.ok(s !== null && s >= LISTEN_BACKLOG, `compose.yaml helper net.core.somaxconn ${s}, at least ${LISTEN_BACKLOG}`);
});

test("Caddy keeps at least IDLE_MIN idle connections to the helper", () => {
  const n = idleOf(readFileSync(path.join(HERE, "Caddyfile"), "utf8"));
  assert.ok(n !== null && n >= IDLE_MIN, `keepalive_idle_conns_per_host ${n}, at least ${IDLE_MIN}`);
});

test("planted files fail: no sysctls, a low somaxconn, somaxconn on caddy only; no idle line, Caddy's 32, a commented line", () => {
  const compose = (helper, caddy = "") => `services:\n  helper:\n    image: x\n${helper}  caddy:\n    image: y\n${caddy}volumes: {}\n`;
  assert.equal(somaxconnOf(compose("    sysctls:\n      net.core.somaxconn: 4096\n")), 4096, "the good shape reads");
  assert.equal(somaxconnOf(compose("")), null);
  assert.equal(somaxconnOf(compose("    sysctls:\n      net.core.somaxconn: 511\n")), 511);
  assert.equal(somaxconnOf(compose("", "    sysctls:\n      net.core.somaxconn: 4096\n")), null);
  const caddy = (t) => `{\n}\n\nx {\n\treverse_proxy helper:8080 {\n\t\ttransport http {\n${t}\t\t}\n\t}\n}\n`;
  assert.equal(idleOf(caddy("\t\t\tkeepalive_idle_conns_per_host 1024\n")), 1024, "the good shape reads");
  assert.equal(idleOf(caddy("")), null);
  assert.ok(idleOf(caddy("\t\t\tkeepalive_idle_conns_per_host 32\n")) < IDLE_MIN);
  assert.equal(idleOf(caddy("\t\t\t# keepalive_idle_conns_per_host 1024\n")), null);
});
