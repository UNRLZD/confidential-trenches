// Card tests-make-no-late-reads: no package test reaches the network (scripts/test-no-network.cjs, loaded by
// scripts/test-bound-watch.cjs). Planted files, run with each package's own node --test flags from its package.json, in
// that package's folder: a test that reads a host off this machine through fetch, node:https, node:net and node:tls,
// and a name its own lookup pins there, each catching its failure and passing, fails its file, every host named, with
// no connection made (the plant's host is 192.0.2.1, TEST-NET-1, which no packet reaches); a test that reads a server
// of its own on loopback (127.0.0.1, localhost, ::1, a name its own lookup pins to 127.0.0.1) and on a unix socket
// passes. Red control: the same reading file under node --test with no guard
// passes, its reads failing unseen.
//   node --test scripts/ci/test-no-network.test.mjs
import assert from "node:assert/strict";
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "../group-run.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// a run started from inside a node --test file is a run of its own: NODE_TEST_CONTEXT would make it report to this one
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT"));
const OFF = "192.0.2.1";

const PLANTS = {
  "reads-off.test.mjs": `import { test } from "node:test";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
// each read ends at its failure or at 3 s, its socket closed, so the file ends either way
const ended = (s) => new Promise((ok) => s.on("error", ok).on("close", ok).setTimeout(3000, () => s.destroy()));
test("reads a host off this machine four ways, each failure caught", async () => {
  await fetch("https://${OFF}:8443/", { signal: AbortSignal.timeout(3000) }).catch(() => {});
  await new Promise((ok) => https.get({ host: "${OFF}", port: 8444, timeout: 3000 }).on("error", ok).on("timeout", function () { this.destroy(); }).on("close", ok));
  await ended(net.connect(8445, "${OFF}"));
  await ended(tls.connect({ host: "${OFF}", port: 8446 }));
  // a name the caller's own lookup pins to an address off this machine
  const pin = (h, o, cb) => (o?.all ? cb(null, [{ address: "${OFF}", family: 4 }]) : cb(null, "${OFF}", 4));
  await new Promise((ok) => https.get({ host: "pinned.invalid", port: 8447, lookup: pin, timeout: 3000 }).on("error", ok).on("timeout", function () { this.destroy(); }).on("close", ok));
});
`,
  "reads-loopback.test.mjs": `import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
test("reads a server of its own on loopback and on a unix socket", async () => {
  const s = http.createServer((q, r) => r.end("ok"));
  await new Promise((ok) => s.listen(0, "::", ok));
  const { port } = s.address();
  for (const h of ["127.0.0.1", "localhost", "[::1]"]) assert.equal(await (await fetch(\`http://\${h}:\${port}/\`)).text(), "ok", h);
  // a name the caller's own lookup pins to loopback (the helper's logo fetch pins the address it checked)
  const pin = (h, o, cb) => (o?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4));
  const pinned = await new Promise((ok, no) => http.get({ host: "pinned.invalid", port, lookup: pin }, (r) => { let t = ""; r.on("data", (d) => (t += d)).on("end", () => ok(t)); }).on("error", no));
  assert.equal(pinned, "ok", "pinned.invalid");
  s.close();
  const dir = mkdtempSync(path.join(tmpdir(), "no-net-"));
  const sock = path.join(dir, "s");
  const u = net.createServer((c) => c.end("ok"));
  await new Promise((ok) => u.listen(sock, ok));
  const got = await new Promise((ok, no) => { let t = ""; net.connect(sock).on("data", (d) => (t += d)).on("end", () => ok(t)).on("error", no); });
  u.close();
  rmSync(dir, { recursive: true, force: true });
  assert.equal(got, "ok");
});
`,
};

function plant() {
  const dir = mkdtempSync(path.join(tmpdir(), "test-no-network-"));
  for (const [f, text] of Object.entries(PLANTS)) writeFileSync(path.join(dir, f), text);
  return dir;
}

/** Each workspace package with a test script: its folder and the flags of its node --test, as package.json has them. */
function packages() {
  const globs = [...readFileSync(path.join(ROOT, "pnpm-workspace.yaml"), "utf8").matchAll(/^\s+-\s+["']?([^"'\s]+)["']?\s*$/gm)].map((m) => m[1]);
  const out = [];
  for (const pkg of globs.flatMap((g) => globSync(`${g}/package.json`, { cwd: ROOT })).sort()) {
    const script = JSON.parse(readFileSync(path.join(ROOT, pkg), "utf8")).scripts?.test;
    if (typeof script !== "string") continue;
    const w = script.split("&&").map((s) => s.trim().split(/\s+/)).find((x) => x[0] === "node" && x.includes("--test"));
    assert.ok(w, `${pkg}: no node --test in its test script`);
    out.push({ dir: path.dirname(pkg), flags: w.slice(w.indexOf("--test") + 1).filter((x) => x.startsWith("-")) });
  }
  return out;
}

test("every package's test run fails a file that reads a host off this machine, each host named, and passes a loopback reader", async () => {
  const dir = plant();
  try {
    const pkgs = packages();
    assert.ok(pkgs.length >= 7, `the workspace's test scripts, read: ${pkgs.map((p) => p.dir)}`);
    const off = path.join(dir, "reads-off.test.mjs");
    const loop = path.join(dir, "reads-loopback.test.mjs");
    const runs = await Promise.all(
      pkgs.map(async (p) => ({
        ...p,
        off: await run(process.execPath, ["--test", ...p.flags, off], { cwd: path.join(ROOT, p.dir), env: ENV, timeoutMs: 60_000 }),
        loop: await run(process.execPath, ["--test", ...p.flags, loop], { cwd: path.join(ROOT, p.dir), env: ENV, timeoutMs: 60_000 }),
      })),
    );
    for (const { dir: d, off: r, loop: l } of runs) {
      const out = r.stdout + r.stderr;
      assert.notEqual(r.status, 0, `${d}: a file that read off this machine passed\n${out}`);
      for (const port of [8443, 8444, 8445, 8446]) assert.ok(out.includes(`test-no-network: ${off} asked ${OFF}:${port}, refused`), `${d}: ${OFF}:${port} not named\n${out}`);
      assert.ok(out.includes(`test-no-network: ${off} asked pinned.invalid (${OFF}):8447, refused`), `${d}: the pinned name not named\n${out}`);
      assert.match(out, /✔ reads a host off this machine four ways/, `${d}: the test itself did not pass, its reads refused at once\n${out}`);
      assert.equal(l.status, 0, `${d}: a loopback reader failed\n${l.stdout}${l.stderr}`);
      assert.doesNotMatch(l.stdout + l.stderr, /test-no-network/, d);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("red control: the same reading file under node --test with no guard passes, its reads failing unseen", async () => {
  const dir = plant();
  try {
    const r = await run(process.execPath, ["--test", path.join(dir, "reads-off.test.mjs")], { cwd: ROOT, env: ENV, timeoutMs: 60_000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout + r.stderr, /test-no-network/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
