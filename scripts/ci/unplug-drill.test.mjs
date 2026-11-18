// Card vault-drill-script: the unplug drill (scripts/drill/unplug.mjs) and its network guard (scripts/drill/net-guard.mjs).
// The dry run on recorded answers writes a PASS record the money gate's own parser reads clean; a request to a host of
// ours (the helper, APP_HOST, SIGN_HOST and the setup mirror on it), a stopped chain, a tx line the exit's own end line
// does not list, or an unreadable record fails the drill; the guard refuses a request to a host of ours before it
// leaves and lets a public one through, writing both down.
//   node --test scripts/ci/unplug-drill.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseLive } from "./money-gate.mjs";
import { hostOf, ourHost } from "../drill/net-guard.mjs";
import { finish, GUARD, parseExit, replayFetch } from "../drill/unplug.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const DRILL = `${ROOT}/scripts/drill/unplug.mjs`;
const ANSWERS = `${ROOT}/scripts/drill/unplug.answers.json`;
const answers = () => JSON.parse(readFileSync(ANSWERS, "utf8"));
const noWait = async () => {};
const run = (a, over = {}) => finish({ key: "unplug-drill", chains: a.chains, code: a.exit.code, lines: a.exit.lines, requests: a.requests, fetchFn: replayFetch(a.reads), sleep: noWait, ...over });
const HELPER = "https://ct-api.unrealized.trade/";
const A = "a".repeat(64);
const H1 = "eP88kSmCM2bkRL3jPY3ehpKgAuHKd1yoP59oAmGMquA";
const H2 = "69oUWMcN329Su1LsMffc5yTqJgT4vAZJneUyu2GFJGiu";

test("the dry run on recorded answers: a PASS record the money gate's parser reads clean, every step ok", () => {
  const dir = mkdtempSync(`${tmpdir()}/unplug-test-`);
  try {
    const out = `${dir}/r.md`;
    execFileSync(process.execPath, [DRILL, "--dry", ANSWERS, "--out", out], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const text = readFileSync(out, "utf8");
    const live = parseLive(text, "unplug-drill");
    assert.deepEqual(live.problems, []);
    assert.equal(live.verdict, "PASS");
    assert.equal(live.moneyPath, true);
    assert.deepEqual(live.real.map((t) => [t.chain, t.hash]), [["near", H1]]);
    for (const n of ["1 servers off", "2 the exit", "3 what was sent", "4 read back"]) assert.match(text, new RegExp(`^Step ${n}: ok `, "m"));
    assert.doesNotMatch(text, /^Request: .* ours$/m);
    // the recorded answers hold nothing shaped as a NEAR secret key (gitleaks' near-ed25519-secret-key, .gitleaks.toml)
    assert.doesNotMatch(readFileSync(ANSWERS, "utf8"), /ed25519:[1-9A-HJ-NP-Za-km-z]{86,88}/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a planted request to our helper, APP_HOST or SIGN_HOST (the setup mirror on it too) fails the drill on step 1", async () => {
  for (const url of [HELPER, "https://ct-app.unrealized.trade/", "https://confidential.unrealized.trade/assets/zk/x.zkey", "https://CT-API.Unrealized.Trade./"]) {
    const a = answers();
    a.requests.splice(2, 0, { url, ours: ourHost(hostOf(url)) });
    const { text, pass } = await run(a);
    assert.equal(pass, false, url);
    assert.match(text, /^CARD unplug-drill \/ live: FAIL$/m);
    assert.match(text, /^Step 1 servers off: FAIL 1 request\(s\) to a host of ours, refused: /m, url);
    // the record still parses: its FAIL is the money gate's to refuse as a last live verdict, never a parse fault
    assert.deepEqual(parseLive(text, "unplug-drill").problems, []);
  }
});

test("a stopped chain, a non-zero exit, no request read, a tx the exit's end line does not list, or none sent: FAIL", async () => {
  const a = answers();
  const stop = { ...a, exit: { code: 1, lines: [...a.exit.lines.slice(0, -1), `near: stopped: withdraw failed: x (txs so far: ${H1}); run the exit again to go on`] } };
  assert.match((await run(stop)).text, /^Step 2 the exit: FAIL exit code 1; near stopped: /m);
  assert.equal((await run({ ...a, exit: { ...a.exit, code: 1 } })).pass, false);
  assert.match((await run({ ...a, requests: [] })).text, /^Step 1 servers off: FAIL 0 request/m);
  const extra = { ...a, exit: { ...a.exit, lines: [...a.exit.lines.slice(0, -1), `near: done: sent 5000000, left 0, txs ${H1} ${H2}`] } };
  assert.match((await run(extra)).text, /^Step 3 what was sent: FAIL near: its tx lines name /m);
  const none = { ...a, exit: { ...a.exit, lines: a.exit.lines.filter((l) => !l.includes(" tx ")).map((l) => l.replace(/, txs .*$/, "")) } };
  assert.equal((await run(none)).pass, false);
});

test("a read back the public RPCs do not answer as succeeded fails step 4", async () => {
  const a = answers();
  const { text, pass } = await run(a, { fetchFn: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 0, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION" } } }), { status: 200 }) });
  assert.equal(pass, false);
  assert.match(text, /^Step 4 read back: FAIL /m);
});

test("the exit's NEAR lines: withdraw and settle are Tx lines with their signer, A's close a Deleted line naming it", () => {
  const lines = [`near: withdraw tx ${H1} from ${A}`, `near: settle tx ${H2} from ${A}`, `near: close tx 5Kp8z6Ttx8wzv6DqYPHHkvAD2ZK6rbmy3XbJ1z5rCrrE from ${A}`, `near: done: sent 5, left 0, txs ${H1} ${H2} 5Kp8z6Ttx8wzv6DqYPHHkvAD2ZK6rbmy3XbJ1z5rCrrE`];
  const e = parseExit(lines);
  assert.deepEqual(e.problems, []);
  assert.deepEqual(e.txs.map((t) => [t.step, t.hash, t.signer]), [["withdraw", H1, A], ["settle", H2, A]]);
  assert.deepEqual(e.deleted.map((d) => d.account), [A]);
  // a tx line in another shape (the signer missing: the exit before this card) is never silently left unread
  assert.equal(parseExit([`near: withdraw tx ${H1}`, `near: done: sent 5, left 0, txs ${H1}`]).problems.length, 2);
  // the line the exit prints is the one read: near-out.ts names each tx's signer
  assert.match(readFileSync(`${ROOT}/packages/exit/src/near-out.ts`, "utf8"), /record: async \(r\) => ctx\.say\(`\$\{r\.step\} tx \$\{r\.hash\} from \$\{signer\}`\)/);
});

test("the guard: a request to a host of ours is refused before it leaves and written down; a public one goes through", async () => {
  let hits = 0;
  const server = http.createServer((_q, s) => (hits++, s.end("ok")));
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const dir = mkdtempSync(`${tmpdir()}/unplug-guard-`);
  try {
    const log = `${dir}/requests.jsonl`;
    writeFileSync(log, "");
    const script = `${dir}/probe.mjs`;
    writeFileSync(
      script,
      [
        'import http from "node:http"; import https from "node:https";',
        "const out = [];",
        `for (const u of [${JSON.stringify(HELPER)}, "https://confidential.unrealized.trade/assets/zk/a.zkey"]) out.push(await fetch(u).then(() => "sent", (e) => e.message));`,
        'try { https.get("https://ct-app.unrealized.trade/"); out.push("sent"); } catch (e) { out.push(e.message); }',
        `out.push(await fetch("http://127.0.0.1:${server.address().port}/p?k=secret").then((r) => r.text()));`,
        "console.log(JSON.stringify(out));",
      ].join("\n"),
    );
    // spawned, not spawnSync: this process's server answers the probe's public request
    const r = await new Promise((done) => {
      const c = spawn(process.execPath, ["--import", GUARD, script], { env: { ...process.env, DRILL_HOSTS: log } });
      let stdout = "";
      let stderr = "";
      c.stdout.on("data", (d) => (stdout += d));
      c.stderr.on("data", (d) => (stderr += d));
      c.on("close", (status) => done({ status, stdout, stderr }));
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    for (const m of out.slice(0, 3)) assert.match(m, /^unplug drill: a request to [a-z.-]+unrealized\.trade is refused: every server of ours is off$/);
    assert.equal(out[3], "ok");
    assert.equal(hits, 1);
    const logged = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(logged.map((x) => x.ours), [true, true, true, false]);
    // a query is never written: it may carry a key
    assert.equal(logged[3].url, `http://127.0.0.1:${server.address().port}/p`);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the drill takes no words and echoes no unknown argument; a dry run reads nothing it did not record", () => {
  const r = spawnSync(process.execPath, [DRILL, "abandon", "--out", "x.md"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.doesNotMatch(r.stderr, /abandon/);
  assert.match(r.stderr, /never given here/);
  assert.rejects(replayFetch([])("https://near.drpc.org", { body: "{}" }), /not recorded/);
});

test("the real drill, its input closed before the words: the exit refuses (code 2, no words read) and the drill records FAIL at step 2", () => {
  // card exit-refuses-when-the-words-never-come: the exit once exited 0 here with nothing said; no network is reached
  // (the exit refuses before any read, and a record with no Tx is never read back)
  const dir = mkdtempSync(`${tmpdir()}/unplug-closed-`);
  try {
    const out = `${dir}/r.md`;
    const r = spawnSync(process.execPath, [DRILL, "--out", out], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    assert.equal(r.status, 1, r.stderr);
    const text = readFileSync(out, "utf8");
    assert.match(text, /^CARD unplug-drill \/ live: FAIL$/m);
    assert.match(text, /^Step 2 the exit: FAIL exit code 2; the exit said: no words were read: the input closed before the 12 words were typed, so nothing was read or sent; near never ended$/m);
    assert.match(text, /^Step 1 servers off: FAIL 0 request\(s\)/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
