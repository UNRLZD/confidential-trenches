// node --test apps/helper/deploy/burst-capacity.test.mjs (card helper-answers-through-a-burst): a burst of page opens is
// a burst of connects from Caddy to the helper. The helper asks the kernel for a listen queue of LISTEN_BACKLOG
// (src/server.ts listenAt), compose.yaml lets the kernel give it (net.core.somaxconn in the helper's network, at least
// that), and the Caddyfile holds at most CONNS connections to the helper, under that queue, and keeps every one idle for
// the next request (Caddy's default: no limit, 32 kept), so a burst's requests wait in Caddy for a connection rather
// than connect again past the queue.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LISTEN_BACKLOG, listenAt } from "../src/server.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The connections Caddy holds to the helper at most, all kept idle between requests [design: 1024, a quarter of the
 *  helper's listen queue, so Caddy alone fills at most a quarter of it; over the 921 that 300 page opens held at once
 *  with no limit on the copy pinned to 2 CPUs (deploy/burst-proof.sh)]. */
export const CONNS = 1_024;

/** The helper service's net.core.somaxconn in a compose file, or null when it sets none. */
export function somaxconnOf(compose) {
  const helper = compose.split(/\n(?= {2}[a-z][a-z0-9_-]*:\s*$)/m).find((b) => /^ {2}helper:\s*$/m.test(b)) ?? "";
  const m = /^ {4}sysctls:\s*\n(?: {6}.*\n)*? {6}net\.core\.somaxconn:\s*"?(\d+)"?\s*$/m.exec(helper);
  return m === null ? null : Number(m[1]);
}
/** A reverse_proxy transport setting's one value in a Caddyfile, or null when it is not set exactly once. */
export function settingOf(caddyfile, name) {
  const lines = caddyfile.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "").trim());
  const m = lines.map((l) => new RegExp(`^${name}\\s+(\\d+)$`).exec(l)).filter(Boolean);
  return m.length === 1 ? Number(m[0][1]) : null;
}

test("the helper's listen queue: asked for LISTEN_BACKLOG on every port, and compose.yaml lets the kernel give it", () => {
  assert.ok(LISTEN_BACKLOG >= 4_096, String(LISTEN_BACKLOG));
  for (const p of [0, 8080]) assert.equal(listenAt(p).backlog, LISTEN_BACKLOG);
  const s = somaxconnOf(readFileSync(path.join(HERE, "compose.yaml"), "utf8"));
  assert.ok(s !== null && s >= LISTEN_BACKLOG, `compose.yaml helper net.core.somaxconn ${s}, at least ${LISTEN_BACKLOG}`);
});

test("Caddy holds at most CONNS connections to the helper, under its listen queue, and keeps them all idle", () => {
  const text = readFileSync(path.join(HERE, "Caddyfile"), "utf8");
  const max = settingOf(text, "max_conns_per_host");
  assert.equal(max, CONNS, `max_conns_per_host ${max}`);
  assert.ok(max < LISTEN_BACKLOG, "Caddy alone can never fill the helper's listen queue");
  assert.equal(settingOf(text, "keepalive_idle_conns_per_host"), max, "every connection held is kept idle for the next request");
});

test("planted files fail: no sysctls, a low somaxconn, somaxconn on caddy only; no connection limit, a commented one, one set twice, Caddy's 32 kept idle", () => {
  const compose = (helper, caddy = "") => `services:\n  helper:\n    image: x\n${helper}  caddy:\n    image: y\n${caddy}volumes: {}\n`;
  assert.equal(somaxconnOf(compose("    sysctls:\n      net.core.somaxconn: 4096\n")), 4096, "the good shape reads");
  assert.equal(somaxconnOf(compose("")), null);
  assert.equal(somaxconnOf(compose("    sysctls:\n      net.core.somaxconn: 511\n")), 511);
  assert.equal(somaxconnOf(compose("", "    sysctls:\n      net.core.somaxconn: 4096\n")), null);
  const caddy = (t) => `{\n}\n\nx {\n\treverse_proxy helper:8080 {\n\t\ttransport http {\n${t}\t\t}\n\t}\n}\n`;
  assert.equal(settingOf(caddy("\t\t\tmax_conns_per_host 1024\n"), "max_conns_per_host"), 1024, "the good shape reads");
  assert.equal(settingOf(caddy(""), "max_conns_per_host"), null, "no limit");
  assert.equal(settingOf(caddy("\t\t\t# max_conns_per_host 1024\n"), "max_conns_per_host"), null, "a commented limit");
  assert.equal(settingOf(caddy("\t\t\tkeepalive_idle_conns_per_host 32\n"), "keepalive_idle_conns_per_host"), 32, "Caddy's default kept idle, under the limit");
  assert.equal(settingOf(caddy("\t\t\tmax_conns_per_host 1024\n\t\t\tmax_conns_per_host 8192\n"), "max_conns_per_host"), null, "set twice");
});
