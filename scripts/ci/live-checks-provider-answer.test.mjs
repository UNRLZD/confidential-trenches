// The provider-answer gate (live-checks-provider-answer.mjs) on planted files: a live check that builds a JSON-RPC
// request outside the shared module is refused in every quoting, a comment or a test is not, NOT_MOVED only shrinks,
// and the repo's own tree passes.
//   node --test scripts/ci/live-checks-provider-answer.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildsRpc, MOCKS, NOT_MOVED, refusalsOf } from "./live-checks-provider-answer.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GATE = join(ROOT, "scripts/ci/live-checks-provider-answer.mjs");
const F = "scripts/live-checks/planted.mjs";

// each one builds a JSON-RPC request or answer in code
const BUILDS = [
  `body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })`,
  `const b = { "jsonrpc": "2.0", id: 1 };`,
  `const b = { 'jsonrpc': '2.0' };`,
  "const b = `{\"jsonrpc\":\"2.0\",\"id\":1}`;",
  `body: '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'`,
  `body: "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":1}"`,
  `const b = {jsonrpc:"2.0"};`,
  `fetch("https://rpc.example", { body: JSON.stringify({ jsonrpc: "2.0" }) })`,
  // review of 6cfd2778, P3-1: any value, the shorthand, a key built by +, a "//" or "/*" in a string, an element
  `const V = "2.0";\nconst b = { jsonrpc: V, id: 1 };`,
  `const jsonrpc = "2.0";\nconst b = { jsonrpc, id: 1 };`,
  `const b = { ["json" + "rpc"]: "2.0" };`,
  `const b = { path: "//", jsonrpc: "2.0" };`,
  `const a = "/*";\nconst b = { jsonrpc: "2.0" };\nconst c = "*/";`,
  `const b = {};\nb["jsonrpc"] = "2.0";`,
];
// none of these builds one
const NOT = [
  `// body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })`,
  `/* {"jsonrpc":"2.0","error":{"message":"rate limit"}} */`,
  ` * dRPC answer, HTTP 429: {"id":187,"jsonrpc":"2.0"}`.replace(/^/, "/**\n").concat("\n */"),
  `const a = await rpcAnswer(url, "eth_call", params);`,
  `const v = "jsonrpc 2.0 answers";`,
];

test("a JSON-RPC request or answer in code is found in every quoting; in a comment or in words it is not", () => {
  for (const s of BUILDS) assert.equal(buildsRpc(s), true, s);
  for (const s of NOT) assert.equal(buildsRpc(s), false, s);
});

test("planted: a check that builds its own request is refused; one on the shared module passes; tests and the module are not read", () => {
  const read = (m) => (f) => m[f];
  for (const s of BUILDS) {
    const r = refusalsOf([F], read({ [F]: s }), []);
    assert.equal(r.length, 1, s);
    assert.match(r[0], /builds a JSON-RPC request outside provider-answer\.mjs/);
  }
  assert.deepEqual(refusalsOf([F], read({ [F]: `import { rpcAnswer } from "./provider-answer.mjs";\nawait rpcAnswer(u, "eth_chainId", []);` }), []), []);
  // both: imports the module and still builds its own
  const both = refusalsOf([F], read({ [F]: `import { rpcAnswer } from "./provider-answer.mjs";\nconst b = { jsonrpc: "2.0" };` }), [F]);
  assert.equal(both.length, 1);
  assert.match(both[0], /imports provider-answer\.mjs and builds a JSON-RPC request itself too/);
  // tests, the shared module and its plants, and files outside scripts/live-checks/*.mjs are not this gate's
  const files = ["scripts/live-checks/x.test.mjs", "scripts/live-checks/provider-answer.mjs", "scripts/live-checks/provider-answer.plants.mjs", "scripts/ci/x.mjs"];
  assert.deepEqual(refusalsOf(files, () => BUILDS[0], []), []);
  // every code file under scripts/live-checks is read, in a subfolder or as .js too (review of 6cfd2778, P3-1)
  for (const f of ["scripts/live-checks/sub/x.mjs", "scripts/live-checks/x.js", "scripts/live-checks/x.cjs"]) assert.equal(refusalsOf([f], () => BUILDS[0], []).length, 1, f);
});

test("planted: NOT_MOVED only shrinks: a listed check that builds none, or is gone, is refused", () => {
  assert.deepEqual(refusalsOf([F], () => BUILDS[0], [F]), [], "listed and builds one: allowed until moved");
  const moved = refusalsOf([F], () => `await rpcAnswer(u, "m", []);`, [F]);
  assert.equal(moved.length, 1);
  assert.match(moved[0], /NOT_MOVED names it but it builds no JSON-RPC request/);
  const gone = refusalsOf([], () => "", [F]);
  assert.equal(gone.length, 1);
  assert.match(gone[0], /NOT_MOVED names a file that is not there/);
});

test("the moved checks are off NOT_MOVED and on the shared module", () => {
  for (const f of ["evm-buy-gas-depth.mjs", "evm-buy-hookdata-fee.mjs", "evm-quote-read-gas-starve.mjs", "robinhood-mainnet-rpcs.mjs"]) assert.equal(NOT_MOVED.includes(`scripts/live-checks/${f}`), false, f);
});

test("the gate's own run: a planted tree exits 1 naming the file; the repo's tree exits 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "lcpa-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    mkdirSync(join(dir, "scripts/live-checks"), { recursive: true });
    // every NOT_MOVED file there and building one, so only the planted file is refused
    for (const f of NOT_MOVED) writeFileSync(join(dir, f), `const b = { jsonrpc: "2.0" };\n`);
    writeFileSync(join(dir, F), `export const b = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });\n`);
    const bad = spawnSync(process.execPath, [GATE, dir], { encoding: "utf8" });
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stderr, /REFUSED: scripts\/live-checks\/planted\.mjs: builds a JSON-RPC request outside provider-answer\.mjs/);
    writeFileSync(join(dir, F), `import { rpcAnswer } from "./provider-answer.mjs";\nexport const a = () => rpcAnswer("https://x", "eth_chainId", []);\n`);
    const good = spawnSync(process.execPath, [GATE, dir], { encoding: "utf8" });
    assert.equal(good.status, 0, good.stdout + good.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const repo = spawnSync(process.execPath, [GATE, ROOT], { encoding: "utf8" });
  assert.equal(repo.status, 0, repo.stdout + repo.stderr);
  assert.match(repo.stdout, /^live-checks-provider-answer: OK/);
});

// review of 6cfd2778, P2-2: a check that reads a provider through an imported rpc builds JSON-RPC too
test("planted: a JSON-RPC request through a relative import is refused; a name that holds none, or a mock's, is not", () => {
  const RPC_WAIT = "scripts/ci/rpc-wait.mjs";
  const DEPLOY = "scripts/live-checks/pool-evm-deploy.mjs";
  const tree = {
    [RPC_WAIT]: `export async function rpc(f, u, method, params) {\n  return f(u, { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });\n}\nexport const pause = (ms) => ms;\n`,
    [DEPLOY]: `export const rpc = (f, u, method, params) => f(u, { body: JSON.stringify({ jsonrpc: "2.0", method, params }) });\nexport const poolRecordName = (n) => n;\n`,
    "scripts/live-checks/lib/rpc.mjs": `export const go = (u) => fetch(u, { body: JSON.stringify({ jsonrpc: "2.0" }) });\n`,
    "scripts/live-checks/rpc-helper.js": `export const go = (u) => fetch(u, { body: JSON.stringify({ jsonrpc: "2.0" }) });\n`,
    "scripts/live-checks/app-in-shell.mjs": `export const harnessRoute = () => ({ jsonrpc: "2.0", result: "0x1" });\n`,
  };
  const read = (extra) => (f) => ({ ...tree, ...extra })[f] ?? null;
  const refused = (src) => refusalsOf([F, ...Object.keys(tree).filter((f) => f.startsWith("scripts/live-checks/"))], read({ [F]: src }), [DEPLOY, "scripts/live-checks/lib/rpc.mjs", "scripts/live-checks/rpc-helper.js"]).filter((x) => x.startsWith(F));
  for (const src of [
    `import { rpc } from "../ci/rpc-wait.mjs";\nexport const go = (u) => rpc(fetch, u, "eth_blockNumber", []);`,
    `import { rpc as r } from "./pool-evm-deploy.mjs";\nexport const go = (u) => r(fetch, u, "eth_chainId", []);`,
    `import * as w from "../ci/rpc-wait.mjs";\nexport const go = (u) => w.rpc(fetch, u, "eth_chainId", []);`,
    `export const go = async (u) => (await import("../ci/rpc-wait.mjs")).rpc(fetch, u, "eth_chainId", []);`,
    `export { rpc } from "./pool-evm-deploy.mjs";`,
    `import { go } from "./lib/rpc.mjs";\nexport const x = (u) => go(u);`,
    `import { go } from "./rpc-helper.js";\nexport const x = (u) => go(u);`,
    `import { rpc } from "./gone.mjs";\nexport const x = (u) => rpc(u);`,
  ]) {
    const r = refused(src);
    assert.equal(r.length, 1, src);
    assert.match(r[0], /builds a JSON-RPC request outside provider-answer\.mjs \(through /, src);
  }
  // a name that holds no JSON-RPC, a bare import, the kit, and a mock's harness are not a provider read
  for (const src of [
    `import { poolRecordName } from "./pool-evm-deploy.mjs";\nexport const x = poolRecordName("a");`,
    `import { pause } from "../ci/rpc-wait.mjs";\nexport const x = pause(1);`,
    `import "../net-window.mjs";\nimport { evmPoolVenues } from "../../packages/kit/src/index.ts";\nexport const x = evmPoolVenues;`,
    `import { harnessRoute } from "./app-in-shell.mjs";\nexport const x = harnessRoute;`,
  ])
    assert.deepEqual(refused(src), [], src);
  assert.deepEqual(Object.keys(MOCKS), ["scripts/live-checks/app-in-shell.mjs"]);
});

// review of 6cfd2778, P2-3, and its delta review P3-c: NOT_MOVED only shrinks. Its names are frozen here as they stand at
// this card (46 that build their own, less app-in-shell, a mock; 16 that import an rpc; 13 that import a name calling
// one): every name it holds is one of them, so a swap is refused too, and each was a live check at a70ea92b, the
// commit this card started from
const FROZEN = Object.freeze(`app-footer-bar base-200ms-blocks delete-refund-readback.sweep evm-buy-gas-floor evm-pool-index
evm-quote-lag-held evm-quote-warm-round evm-rpc-spare-list evm-scan-second-provider evm-sell-hook-intrablock held-move-forgotten-tx
helper-create-u helper-evm-abi-tie helper-launchpad-origin helper-mainnet-vault-env helper-pool-senders helper-rpc-proxy
helper-rpc-sell-methods helper-tape-4337-trader helper-usdc-event-watch helper-usdc-pending-pause helper-v4-hook-liquidity
index-evm-swaps index-sol-trades intents-u-registered-first-run near-rpc-operators notes-per-pool-evm pool-buy-send-fast
pool-evm-deploy pool-sol-deploy relayer-cost-guards relayer-withdraw-fee rh-cold-quote robinhood-mainnet-rpcs
signpage-solana-trade solana-quote-under-1s vault-mainnet-money vault-review-fixes-1 vault-review-fixes-kit vault-testnet-t02
vault-testnet-usdc wallet-mainnet-relayer-pins wallet-refund-move wallet-restore-id-reader wallet-rpc-hex-case
evm-fee-collector evm-mainnet-senders evm-sell-v4 evm-testnet-delegate-review3 evm-venues-pin pool-evm-buy-pays-revert
pool-evm-deploy-resume-safe pool-sol-deploy-after-run pool-sol-deploy-sweep precommit-taken-recover signpage-pool-flow
signpage-pool-notes signpage-pool-withdraw-form vault-kit-settle vault-mainnet vault-skeleton
delete-refund-readback evm-selldelegate-exact-debit helper-evm-sender helper-sender-fee-proof money-gate-testnet pool-deposits
pool-evm-deploy-mainnet pool-evm-testnet-run pool-sol-deploy-mainnet vault-final-sha vault-review-fixes-3 vault-testnet-t01
vault-testnet-t04`.split(/\s+/).map((k) => `scripts/live-checks/${k}.mjs`));

test("NOT_MOVED names only the frozen names, each a file at a70ea92b, never more than 74", () => {
  assert.equal(FROZEN.length, 74);
  assert.ok(NOT_MOVED.length <= 74, `NOT_MOVED holds ${NOT_MOVED.length}: move a check onto provider-answer.mjs, never add one`);
  assert.equal(new Set(NOT_MOVED).size, NOT_MOVED.length, "no name twice");
  for (const f of NOT_MOVED) assert.ok(FROZEN.includes(f), `${f} is not one of the names frozen here: a new check reads providers through provider-answer.mjs`);
  for (const f of FROZEN) assert.equal(spawnSync("git", ["cat-file", "-e", `a70ea92b:${f}`], { cwd: ROOT }).status, 0, `${f} was not a live check at a70ea92b`);
});

// delta review of 323af592, P1-a: a name counts when what it calls holds JSON-RPC, followed through every file
test("planted: an imported name that calls an rpc, in another file or its own, is refused; a cycle ends", () => {
  const tree = {
    "scripts/ci/rpc-wait.mjs": `export async function rpc(f, u, method, params) {\n  return f(u, { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });\n}\n`,
    "scripts/ci/x.mjs": `import { rpc } from "./rpc-wait.mjs";\nexport const wrap = (u) => rpc(fetch, u, "eth_chainId", []);\n`,
    "scripts/ci/money-gate.mjs": `import { rpc as r } from "./rpc-wait.mjs";\nconst inner = (u) => r(fetch, u, "tx", []);\nexport async function readTx(u) {\n  return inner(u);\n}\nexport const quiet = 1;\n`,
    "scripts/live-checks/evm-fee-collector.mjs": `import { rpc } from "./pool-evm-deploy.mjs";\nexport async function check(u) {\n  return rpc(fetch, u, "eth_call", []);\n}\n`,
    "scripts/live-checks/pool-evm-deploy.mjs": `export const rpc = (f, u, m, p) => f(u, { body: JSON.stringify({ jsonrpc: "2.0", method: m, params: p }) });\n`,
    "scripts/live-checks/a.mjs": `import { b } from "./b.mjs";\nexport const a = () => b();\n`,
    "scripts/live-checks/b.mjs": `import { a } from "./a.mjs";\nexport const b = () => a();\n`,
  };
  const listed = ["scripts/live-checks/evm-fee-collector.mjs", "scripts/live-checks/pool-evm-deploy.mjs"];
  const run = (src) => refusalsOf([F, ...Object.keys(tree).filter((f) => f.startsWith("scripts/live-checks/"))], (f) => ({ ...tree, [F]: src })[f] ?? null, listed).filter((x) => x.startsWith(F));
  for (const src of [
    `import { check } from "./evm-fee-collector.mjs";\nexport const go = (u) => check(u);`,
    `import { readTx } from "../ci/money-gate.mjs";\nexport const go = (u) => readTx(u);`,
    `import { wrap } from "../ci/x.mjs";\nexport const go = (u) => wrap(u);`,
    `import { wrap } from "../ci/x.mjs";\nconst local = (u) => wrap(u);\nexport const go = (u) => local(u);`,
  ]) {
    const r = run(src);
    assert.equal(r.length, 1, src);
    assert.match(r[0], /builds a JSON-RPC request outside provider-answer\.mjs \(through /, src);
  }
  // a name that calls none, and two files that only call each other, hold nothing
  for (const src of [`import { quiet } from "../ci/money-gate.mjs";\nexport const x = quiet;`, `import { a } from "./a.mjs";\nexport const x = () => a();`]) assert.deepEqual(run(src), [], src);
});
