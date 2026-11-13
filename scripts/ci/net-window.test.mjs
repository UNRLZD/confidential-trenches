// scripts/net-window.mjs: every Node tool here that opens a network connection sets Node's
// per-address connect window to 2000 ms before its first connection (Node's own 250 ms cancelled a Mac's slow IPv4
// connect to api.hetzner.cloud: "fetch failed", 1 Nov 04:37Z).
//   node --test scripts/ci/net-window.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SHARED = path.join(ROOT, "scripts/net-window.mjs");


// Scripts in the searched folders that open no connection from Node, and why.
export const KEEP = {
  "scripts/webkit-harness/index.mjs": "a loopback HTTPS server and CONNECT proxy for the Mac's WKWebView, both on 127.0.0.1; Node opens none to a remote host",
  "scripts/webkit-harness/self-test.mjs": "drives index.mjs's loopback harness; Node opens none to a remote host",
  "scripts/ci/verify-gate.mjs": "reads git history only, no network",
  "scripts/ci/kit-reach.mjs": "reads the tree only, no network",
  "scripts/ci/no-network.mjs": "a preload that refuses every connection but this machine's; it opens none",
  "scripts/perf-table.mjs": "reads files only, no network",
};

const FOLDERS = ["scripts", "apps/helper/deploy", "contracts/vault/scripts"];
const NET = /^[^/*#\n]*(\bfetch\(|= *(globalThis\.)?fetch\b|new WebSocket|node:https?|node:net|node:tls|(net|tls)\.connect)/m;

const files = () =>
  execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...FOLDERS], { cwd: ROOT, encoding: "utf8" })
    .split("\0").filter((f) => /\.mjs$/.test(f) && !/\.test\.mjs$/.test(f) && f !== "scripts/net-window.mjs");

// Every script that opens a connection (fetch, a library that fetches, a WebSocket) and is not in KEEP: each one must
// import the shared module. Found by the search, never listed (card ci-stops-costing-reruns: a list every new live check
// appended to made each ready branch conflict with the next merge).
export const opensConnection = (f, root = ROOT) => NET.test(readFileSync(path.join(root, f), "utf8"));
export const CHANGED = files().filter((f) => !Object.hasOwn(KEEP, f) && opensConnection(f));

// the window a fresh process has after importing a file, read in a child so no earlier import can have set it
const windowAfter = (file) => {
  const code = `import net from "node:net"; if (process.env.NW_FILE) await import(process.env.NW_FILE); console.log(net.getDefaultAutoSelectFamilyAttemptTimeout());`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: ROOT, encoding: "utf8", timeout: 30_000, env: { ...process.env, NW_FILE: file ? pathToFileURL(file).href : "" } });
  assert.equal(r.status, 0, `${file}: ${r.stderr}`);
  return Number(r.stdout.trim());
};

test("Node's own window is 250 ms and the shared module makes it 2000 ms", () => {
  assert.equal(windowAfter(null), 250);
  assert.equal(windowAfter(SHARED), 2000);
});

for (const f of CHANGED) {
  test(`${f}: imported, the window is 2000 ms, and the shared module is imported by it`, () => {
    assert.equal(windowAfter(path.join(ROOT, f)), 2000);
    assert.match(readFileSync(path.join(ROOT, f), "utf8"), /net-window\.mjs/);
  });
}

test("the search finds the scripts that open a connection, and KEEP names only scripts that open none from Node", () => {
  assert.ok(CHANGED.length > 100, `${CHANGED.length} scripts found opening a connection: the search reads nothing`);
  for (const f of ["scripts/ci/jup-idle.mjs", "scripts/ci/live-plan.mjs", "contracts/vault/scripts/deploy.mjs", "apps/helper/deploy/create-server.mjs"]) assert.ok(CHANGED.includes(f), f);
  for (const f of Object.keys(KEEP)) assert.ok(files().includes(f), `KEEP names ${f}, which is no script in the searched folders`);
});
