// node --test packages/kit/test/prove-e2e.test.ts: the kit's one call (src/prover/prove.ts, card vault-prover-e2e)
// takes the device's leaves and returns a withdraw proof that snarkjs 0.7.5's groth16.verify accepts with the
// release's withdraw.vkey (zk/, pinned in ZK_SETUP_FILES), and refuses a changed leaf or a changed public signal.
// - In node, the prover is snarkjs's own fullProve in this process, the call worker.js makes (singleThread).
// - In headless Chromium (KIT_PROVER_E2E=1, a heavy job: Playwright), the prover is the real worker, prover-worker.js
//   built by build.mjs, started by client.ts under SIGN_HOST's own headers (packages/signpage/public/_headers, every
//   header of its one /* rule on every response; the worker file also gets its own policy, wallet.md W:880, and the
//   setup files the /assets/zk/* rule's Cache-Control with an ETag, as Pages caches them, so a retry meets the browser's
//   HTTP cache as it will on SIGN_HOST: a setup file that once came back wrong is fetched again, not read from it). It prints
//   each call's times with the CPU, the vault paper's V2.5 desktop row (docs/plan1/vault.md l.1199). With
//   KIT_PROVER_E2E_OUT=<dir> it also writes the first proof as proof.json and public.json there, for the snarkjs CLI:
//   snarkjs groth16 verify packages/kit/zk/withdraw.vkey <dir>/public.json <dir>/proof.json
// The leaves are fixture 1 of vault-inputs.test.ts (fixtures/prove-fixture.ts): test values only, never money.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { vaultProveWithdraw, type VaultProver, type VaultWithdrawProof } from "../src/prover/prove.ts";
import type { VaultSnarkjsProof } from "../src/vault/shapes.ts";
import { ZK_SETUP_FILES } from "../src/zk/setup-files.ts";
import { fixtureArgs, fixtureSignals, type ContextVector } from "./fixtures/prove-fixture.ts";

const KIT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string): Buffer => readFileSync(join(KIT, p));
type Proved = { proof: VaultSnarkjsProof; publicSignals: string[] };
const snarkjs = createRequire(import.meta.url)("snarkjs") as {
  groth16: {
    fullProve(input: unknown, wasm: Uint8Array, zkey: Uint8Array, logger: undefined, wtns: undefined, o: { singleThread: boolean }): Promise<Proved>;
    verify(vkey: unknown, publicSignals: string[], proof: VaultSnarkjsProof): Promise<boolean>;
  };
};
after(() => (globalThis as { curve_bn128?: { terminate?: () => void } }).curve_bn128?.terminate?.());

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
for (const f of ["withdraw.vkey", "withdraw.wasm", "withdraw.zkey"] as const) {
  assert.equal(sha256(read(`zk/${f}`)), ZK_SETUP_FILES[f].sha256, `zk/${f} is not the release's pinned file`);
}
const VKEY: unknown = JSON.parse(read("zk/withdraw.vkey").toString("utf8"));
const WASM = new Uint8Array(read("zk/withdraw.wasm"));
const ZKEY = new Uint8Array(read("zk/withdraw.zkey"));
const CV = (JSON.parse(read("test/vectors/vault-v1.json").toString("utf8")) as { context: ContextVector[] }).context[0]!;
const SIGNALS = fixtureSignals(CV);
const verify = (publicSignals: string[], proof: VaultSnarkjsProof): Promise<boolean> => snarkjs.groth16.verify(VKEY, publicSignals, proof);
/** Each of the 8 signals in turn, plus 1. */
const tampered = (s: readonly string[]): string[][] => s.map((_, k) => s.map((v, j) => (j === k ? String(BigInt(v) + 1n) : v)));

/** A prover running snarkjs in this process, with a log of what it was asked. */
function nodeProver(log: string[]): VaultProver {
  return {
    async load(circuit) {
      log.push(`load ${circuit}`);
    },
    async prove(circuit, input) {
      log.push(`prove ${circuit}`);
      assert.equal(circuit, "withdraw");
      const t0 = performance.now();
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY, undefined, undefined, { singleThread: true });
      return { proof, publicSignals, proveMs: Math.round(performance.now() - t0) };
    },
  };
}

let good: VaultWithdrawProof | undefined;

test("node: one call from the fixture's leaves gives a proof snarkjs accepts with the release's withdraw.vkey", async () => {
  const log: string[] = [];
  good = await vaultProveWithdraw(nodeProver(log), fixtureArgs(CV));
  assert.deepEqual(good.publicSignals, SIGNALS);
  assert.equal(await verify(good.publicSignals, good.proof), true);
  assert.deepEqual(log, ["load withdraw", "prove withdraw"]);
});

test("node: snarkjs refuses the proof with any one public signal changed", async () => {
  assert.ok(good, "the first test's proof");
  for (const s of tampered(good.publicSignals)) assert.equal(await verify(s, good.proof), false);
});

test("node: a changed leaf, a missing leaf or an extra leaf is refused before anything is posted to the prover", async () => {
  const log: string[] = [];
  await assert.rejects(vaultProveWithdraw(nodeProver(log), fixtureArgs(CV, "state-leaf")), /stateTree: its root is not the vault's newest/);
  const short = fixtureArgs(CV);
  await assert.rejects(vaultProveWithdraw(nodeProver(log), { ...short, newestStateRoot: short.newestStateRoot + 1n }), /stateTree: its root is not the vault's newest/);
  short.labelTree.append([123n]);
  await assert.rejects(vaultProveWithdraw(nodeProver(log), short), /labelTree: its root is not the vault's newest/);
  assert.deepEqual(log, []);
});

test("node: a prover answer whose signals are not the input's, or whose proof is not snarkjs JSON, is refused", async () => {
  assert.ok(good, "the first test's proof");
  const g = good;
  const answering = (publicSignals: unknown, proof: unknown = g.proof): VaultProver => ({
    load: async () => {},
    prove: async () => ({ proof: proof as VaultSnarkjsProof, publicSignals: publicSignals as string[], proveMs: 1 }),
  });
  const names = ["newCommitmentHash", "existingNullifierHash", "withdrawnValue", "stateRoot", "stateTreeDepth", "ASPRoot", "ASPTreeDepth", "context"];
  for (const [k, s] of tampered(SIGNALS).entries()) {
    await assert.rejects(vaultProveWithdraw(answering(s), fixtureArgs(CV)), new RegExp(`worker answer: ${names[k]} is not the input's`));
  }
  await assert.rejects(vaultProveWithdraw(answering(SIGNALS.slice(0, 7)), fixtureArgs(CV)), /worker answer: not 8 public signals/);
  await assert.rejects(vaultProveWithdraw(answering([...SIGNALS, "1"]), fixtureArgs(CV)), /worker answer: not 8 public signals/);
  await assert.rejects(vaultProveWithdraw(answering(SIGNALS.map(BigInt)), fixtureArgs(CV)), /worker answer: newCommitmentHash is not the input's/);
  await assert.rejects(vaultProveWithdraw(answering(undefined), fixtureArgs(CV)), /worker answer: not 8 public signals/);
  const projective = { ...g.proof, pi_a: [g.proof.pi_a[0], g.proof.pi_a[1], "2"] };
  await assert.rejects(vaultProveWithdraw(answering(SIGNALS, projective), fixtureArgs(CV)), /worker answer: proof: not affine snarkjs JSON/);
  await assert.rejects(vaultProveWithdraw(answering(SIGNALS, null), fixtureArgs(CV)), /worker answer: /);
  // and the same answer, right, passes
  const ok = await vaultProveWithdraw(answering([...SIGNALS]), fixtureArgs(CV));
  assert.deepEqual(ok.publicSignals, SIGNALS);
});

test("node: the setup files load once per prover, and again after a failed load", async () => {
  assert.ok(good, "the first test's proof");
  const g = good;
  const log: string[] = [];
  let fail = true;
  const flaky: VaultProver = {
    load: async (c) => {
      log.push(`load ${c}`);
      if (fail) throw new Error("withdraw.zkey: HTTP 503");
    },
    prove: async (c) => {
      log.push(`prove ${c}`);
      return { proof: g.proof, publicSignals: [...g.publicSignals], proveMs: 1 };
    },
  };
  await assert.rejects(vaultProveWithdraw(flaky, fixtureArgs(CV)), /HTTP 503/);
  fail = false;
  await vaultProveWithdraw(flaky, fixtureArgs(CV));
  await vaultProveWithdraw(flaky, fixtureArgs(CV));
  assert.deepEqual(log, ["load withdraw", "load withdraw", "prove withdraw", "prove withdraw"]);
});

// ---- headless Chromium, the real worker under SIGN_HOST's headers ----

const WORKER_CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'"; // W:880

/** The Cache-Control of _headers' /assets/zk/* rule. */
function zkCacheControl(): string {
  const text = readFileSync(join(KIT, "..", "signpage", "public", "_headers"), "utf8");
  const m = /^\/assets\/zk\/\*\n\s+Cache-Control:\s*(.+)$/m.exec(text);
  assert.ok(m, "_headers has no /assets/zk/* rule with a Cache-Control");
  return m[1]!.trim();
}

/** The header lines of _headers' one /* rule. */
function siteHeaders(): [string, string][] {
  const out: [string, string][] = [];
  let inRule = false;
  for (const line of readFileSync(join(KIT, "..", "signpage", "public", "_headers"), "utf8").split("\n")) {
    if (line.startsWith("#") || !line.trim()) continue;
    if (!/^\s/.test(line)) {
      inRule = line.trim() === "/*";
      continue;
    }
    if (!inRule) continue;
    const i = line.indexOf(":");
    out.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  const csp = out.find(([k]) => k === "Content-Security-Policy")?.[1] ?? "";
  for (const d of ["script-src 'self' 'wasm-unsafe-eval'", "worker-src 'self'", "require-trusted-types-for 'script'", "trusted-types prover-worker"])
    assert.ok(csp.includes(d), `_headers' CSP lacks ${d}`);
  assert.ok(out.some(([k, v]) => k === "Integrity-Policy" && v === "blocked-destinations=(script)"), "_headers lacks Integrity-Policy");
  return out;
}

type PageCall = { result?: VaultWithdrawProof; wallMs?: number; error?: string };
type PageRun = { calls: PageCall[]; posts: unknown[]; violations: { where: string; directive: string; sample: string }[] };

test(
  "chromium: the real worker proves from the fixture's leaves, snarkjs accepts each proof, a changed leaf or answer is refused",
  { skip: process.env.KIT_PROVER_E2E === "1" ? false : "KIT_PROVER_E2E=1 runs it (a heavy job: Playwright Chromium)", timeout: 600_000 },
  async (t) => {
    const { chromium } = (await import("playwright")) as typeof import("playwright");
    const { build } = (await import("rolldown")) as typeof import("rolldown");
    const { buildProverWorker, PROVER_WORKER_FILE } = (await import(String(new URL("../src/prover/build.mjs", import.meta.url)))) as {
      buildProverWorker(out: string): { file: string; bytes: number; sha256: string };
      PROVER_WORKER_FILE: string;
    };
    const headers = siteHeaders();
    const dir = mkdtempSync(join(tmpdir(), "kit-prove-e2e-"));
    const worker = buildProverWorker(dir);
    await build({ input: fileURLToPath(new URL("./fixtures/prove-page.ts", import.meta.url)), platform: "browser", logLevel: "silent", output: { file: join(dir, "page.js"), format: "iife" } });
    const pageJs = readFileSync(join(dir, "page.js"));
    const sri = "sha384-" + createHash("sha384").update(pageJs).digest("base64");
    const html = `<!doctype html><html><head><meta charset="utf-8"><script src="/page.js" integrity="${sri}" crossorigin="anonymous"></script></head><body></body></html>`;
    const files = new Map<string, { type: string; body: Buffer }>([
      ["/", { type: "text/html", body: Buffer.from(html) }],
      ["/page.js", { type: "text/javascript", body: pageJs }],
      [`/${PROVER_WORKER_FILE}`, { type: "text/javascript", body: readFileSync(worker.file) }],
    ]);
    for (const [name, pin] of Object.entries(ZK_SETUP_FILES)) {
      const ext = name.slice(name.lastIndexOf(".") + 1);
      files.set(`/assets/zk/${pin.sha256}.${ext}`, { type: ext === "wasm" ? "application/wasm" : "application/octet-stream", body: read(`zk/${name}`) });
    }
    const siteCsp = headers.find(([k]) => k === "Content-Security-Policy")![1];
    const zkCache = zkCacheControl();
    const zkeyPath = `/assets/zk/${ZK_SETUP_FILES["withdraw.zkey"].sha256}.zkey`;
    // the plant of the "once" case: the next withdraw.zkey answer has one byte changed, the ones after it are right
    let badZkeyOnce = false;
    let badEtag = ""; // the ETag the wrong answer went out with
    const zkeyRequests: { ifNoneMatch: string | null; status: number }[] = [];
    const server: Server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      const f = files.get(path);
      for (const [k, v] of headers) res.setHeader(k, v);
      if (!f) return void res.writeHead(404).end();
      if (path === `/${PROVER_WORKER_FILE}`) res.setHeader("Content-Security-Policy", [siteCsp, WORKER_CSP]);
      if (!path.startsWith("/assets/zk/")) return void res.writeHead(200, { "Content-Type": f.type, "Content-Length": f.body.length, "Cache-Control": "no-store" }).end(f.body);
      let body = f.body;
      if (path === zkeyPath && badZkeyOnce) {
        badZkeyOnce = false;
        body = Buffer.from(body);
        const k = body.length >> 1;
        body[k] = body[k]! ^ 0x01;
      }
      const etag = `"${sha256(body)}"`;
      if (body !== f.body) badEtag = etag;
      const status = req.headers["if-none-match"] === etag ? 304 : 200;
      if (path === zkeyPath) zkeyRequests.push({ ifNoneMatch: (req.headers["if-none-match"] as string | undefined) ?? null, status });
      res.setHeader("Cache-Control", zkCache);
      res.setHeader("ETag", etag);
      if (status === 304) return void res.writeHead(304).end();
      res.writeHead(200, { "Content-Type": f.type, "Content-Length": body.length }).end(body);
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browser = await chromium.launch();
    // `disk`: a profile on disk, so the browser keeps a 17 MB answer in its HTTP cache as a phone does (a fresh
    // context's cache is in memory and keeps no entry that large)
    const runPage = async (plant: string, times: number, disk = false): Promise<PageRun> => {
      const profile = disk ? mkdtempSync(join(tmpdir(), "kit-prove-e2e-profile-")) : null;
      const ctx = profile ? await chromium.launchPersistentContext(profile) : await browser.newContext();
      const page = await ctx.newPage();
      const logs: string[] = [];
      page.on("pageerror", (e) => logs.push(`pageerror ${e.message}`));
      try {
        await page.goto(`${origin}/`);
        if (!(await page.evaluate(() => !!(window as unknown as { __kitProve?: unknown }).__kitProve))) throw new Error(`page.js did not run: ${logs.join(" | ")}`);
        return await page.evaluate(
          ([cv, p, n]) => (window as unknown as { __kitProve: { run(cv: unknown, p: unknown, n: unknown): Promise<PageRun> } }).__kitProve.run(cv, p, n),
          [CV, plant, times] as const,
        );
      } finally {
        await ctx.close();
        if (profile) rmSync(profile, { recursive: true, force: true });
      }
    };
    try {
      const machine = { chromium: browser.version(), cpu: cpus()[0]?.model, cores: cpus().length, host: execFileSync("uname", ["-sm"]).toString().trim(), worker: worker.sha256 };
      t.diagnostic(JSON.stringify(machine));

      const ok = await runPage("none", 3);
      t.diagnostic(JSON.stringify({ case: "good", calls: ok.calls.map((c) => ({ proveMs: c.result?.proveMs, wallMs: c.wallMs, error: c.error })), posts: ok.posts }));
      assert.deepEqual(ok.violations, []);
      assert.deepEqual(ok.posts, ["load", "prove", "prove", "prove"]);
      for (const [k, c] of ok.calls.entries()) {
        assert.ok(c.result, `call ${k}: ${c.error}`);
        assert.deepEqual(c.result.publicSignals, SIGNALS);
        const accepted = await verify(c.result.publicSignals, c.result.proof);
        t.diagnostic(`call ${k}: snarkjs groth16.verify with zk/withdraw.vkey -> ${accepted}`);
        assert.equal(accepted, true);
        for (const s of tampered(c.result.publicSignals)) assert.equal(await verify(s, c.result.proof), false);
      }
      const out = process.env.KIT_PROVER_E2E_OUT;
      if (out) {
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, "proof.json"), JSON.stringify(ok.calls[0]!.result!.proof));
        writeFileSync(join(out, "public.json"), JSON.stringify(ok.calls[0]!.result!.publicSignals));
      }

      const leaf = await runPage("state-leaf", 1);
      t.diagnostic(JSON.stringify({ case: "state-leaf", error: leaf.calls[0]?.error, posts: leaf.posts }));
      assert.match(leaf.calls[0]?.error ?? "", /stateTree: its root is not the vault's newest/);
      assert.deepEqual(leaf.posts, []);

      const answer = await runPage("answer-signal", 1);
      t.diagnostic(JSON.stringify({ case: "answer-signal", error: answer.calls[0]?.error, posts: answer.posts }));
      assert.match(answer.calls[0]?.error ?? "", /worker answer: context is not the input's/);
      assert.deepEqual(answer.posts, ["load", "prove"]);

      // withdraw.zkey comes back wrong once under its pinned name, cached for good: the first call is refused at load,
      // and the second fetches the file from the server again (never the browser's cached copy) and proves
      zkeyRequests.length = 0;
      badZkeyOnce = true;
      const once = await runPage("none", 2, true);
      t.diagnostic(JSON.stringify({ case: "zkey-wrong-once", calls: once.calls.map((c) => c.error ?? "proof"), posts: once.posts, zkeyRequests }));
      assert.match(once.calls[0]?.error ?? "", new RegExp(`withdraw\\.zkey: sha256 [0-9a-f]{64}, pinned ${ZK_SETUP_FILES["withdraw.zkey"].sha256}`));
      assert.ok(once.calls[1]?.result, `the second call: ${once.calls[1]?.error}`);
      assert.deepEqual(once.calls[1].result.publicSignals, SIGNALS);
      assert.equal(await verify(once.calls[1].result.publicSignals, once.calls[1].result.proof), true);
      assert.equal(zkeyRequests.length, 2, `withdraw.zkey reached the server ${zkeyRequests.length} time(s): ${JSON.stringify(zkeyRequests)}`);
      assert.deepEqual(zkeyRequests.map((r) => r.status), [200, 200]);
      // the browser had kept the wrong answer and asked the server about it: the cache was there, and was not trusted
      assert.ok(badEtag, "the wrong answer was served");
      assert.equal(zkeyRequests[1]!.ifNoneMatch, badEtag, "the second request did not revalidate the cached wrong answer");
      assert.deepEqual(once.posts, ["load", "load", "prove"]);
      assert.deepEqual(once.violations, []);
    } finally {
      await browser.close();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
