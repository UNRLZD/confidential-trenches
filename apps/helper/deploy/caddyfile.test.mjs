// node --test apps/helper/deploy/caddyfile.test.mjs (card solana-quote-under-1s): the Caddyfile compresses every answer
// a caller asks to have compressed (a cold page's first round is ~37 KB raw, ~11 KB gzip: TCP slow start costs round
// trips on the raw bytes), and its admin endpoint, which redeploy.sh reloads through, is a unix socket inside the
// container, never a TCP address. The docker run of it is local-proof.sh's; this reads the file the image's Caddy loads.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "Caddyfile");

/** The Caddyfile's top-level blocks, `{ ... }` with their label ("" for the global options), comments dropped. */
export function blocks(text) {
  const lines = text.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "").trim());
  const out = [];
  let depth = 0;
  let cur = null;
  for (const line of lines) {
    if (!line) continue;
    if (depth === 0) {
      assert.ok(line.endsWith("{"), `a top-level line that opens no block: ${line}`);
      cur = { label: line.slice(0, -1).trim(), body: [] };
      depth = 1;
      continue;
    }
    if (line.endsWith("{")) depth++;
    if (line === "}") depth--;
    if (depth === 0) out.push(cur);
    else cur.body.push({ depth, line });
  }
  assert.equal(depth, 0, "every block closes");
  return out;
}

/** What makes a Caddyfile pass: the reasons it fails, none when it passes. */
export function problems(text) {
  const all = blocks(text);
  const global = all.filter((b) => b.label === "");
  const sites = all.filter((b) => b.label !== "");
  const bad = [];
  if (global.length !== 1) bad.push("one global options block");
  if (sites.length !== 1) bad.push("one site block");
  const admin = (global[0]?.body ?? []).filter((d) => d.depth === 1 && /^admin(\s|$)/.test(d.line));
  if (admin.length !== 1 || !/^admin unix\/\/config\/[A-Za-z0-9._-]+\.sock$/.test(admin[0].line)) {
    bad.push(`admin on a unix socket under /config only (read: ${admin.map((d) => d.line).join(", ") || "none"})`);
  }
  const encode = (sites[0]?.body ?? []).filter((d) => d.depth === 1 && /^encode(\s|$)/.test(d.line));
  const algos = encode.length === 1 ? encode[0].line.split(/\s+/).slice(1) : [];
  if (!algos.includes("zstd") || !algos.includes("gzip")) bad.push(`encode with zstd and gzip in the site block (read: ${encode.map((d) => d.line).join(", ") || "none"})`);
  return bad;
}

test("the Caddyfile compresses with zstd and gzip in its site block, and its admin is a unix socket under /config", () => {
  assert.deepEqual(problems(readFileSync(FILE, "utf8")), []);
});

test("planted Caddyfiles fail: no encode, encode in the global block, gzip only, admin off, admin on TCP, admin on a socket outside /config", () => {
  const site = (inner) => `{\n\tadmin unix//config/caddy-admin.sock\n}\n\nexample.org {\n${inner}\treverse_proxy helper:8080\n}\n`;
  const withAdmin = (admin) => `{\n\t${admin}\n}\n\nexample.org {\n\tencode zstd gzip\n\treverse_proxy helper:8080\n}\n`;
  assert.deepEqual(problems(site("\tencode zstd gzip\n")), [], "the good shape passes");
  const planted = {
    "no encode": site(""),
    "encode inside reverse_proxy, not the site": site("\treverse_proxy x {\n\t\tencode zstd gzip\n\t}\n"),
    "a commented encode": site("\t# encode zstd gzip\n"),
    "gzip only": site("\tencode gzip\n"),
    "encode in the global block": `{\n\tadmin unix//config/caddy-admin.sock\n\tencode zstd gzip\n}\n\nexample.org {\n\treverse_proxy helper:8080\n}\n`,
    "admin off": withAdmin("admin off"),
    "admin on a TCP port": withAdmin("admin localhost:2019"),
    "admin on all interfaces": withAdmin("admin :2019"),
    "admin on a socket outside /config": withAdmin("admin unix//tmp/caddy.sock"),
    "admin on a socket path that climbs out": withAdmin("admin unix//config/../tmp/caddy.sock"),
    "no admin line (Caddy's default is localhost:2019)": `{\n}\n\nexample.org {\n\tencode zstd gzip\n}\n`,
  };
  for (const [name, text] of Object.entries(planted)) assert.notDeepEqual(problems(text), [], name);
});
