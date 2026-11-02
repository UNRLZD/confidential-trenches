// node --test apps/helper/deploy/env-names.test.mjs: every environment name the helper's code reads reaches the
// container. compose.yaml passes the helper only the names under services.helper.environment, and the image sets its
// own ENV (Dockerfile), so a name read in src/ and in neither is never set on the deployed helper (card
// relayer-withdraw-fee: its WITHDRAW_* names were missing, and the deployed fee route would have answered 404 for every
// token). Two reads, each a gate:
// - src/ as text: every quoted ALL_CAPS_WITH_UNDERSCORES string, every process.env.NAME and every name destructured
//   from process.env, less the few quoted constants that are not environment names (NOT_ENV); a new constant of that
//   form fails here until it is listed there or passed, so the miss is always loud. A computed process.env[...] read
//   fails too: only the run below can see its name.
// - the code run: every function server.ts hands process.env to (ENV_READERS, held equal to server.ts's calls) gets a
//   recording env instead, every relayer network set and a store folder given, and every name it reads, built at run
//   time or not, must be passed.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createProxy } from "../src/proxy/proxy.ts";
import { createRpc } from "../src/rpc/rpc.ts";
import { bindSenderFromEnv } from "../src/bind/env.ts";
import { tokenWatchesFromEnv } from "../src/token-status/status.ts";
import { feeQuoterFromEnv } from "../src/withdraw/fee.ts";
import { withdrawSenderFromEnv } from "../src/withdraw/send.ts";
import { solanaTokenFromEnv } from "../src/server.ts";

const HELPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Quoted constants in src/ that are not environment names: NEAR RPC error causes and a Ref pool kind. */
export const NOT_ENV = new Set(["UNKNOWN_ACCESS_KEY", "UNKNOWN_ACCOUNT", "UNKNOWN_BLOCK", "SIMPLE_POOL"]);

function codeFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return codeFiles(p);
    return /\.(ts|mjs|js)$/.test(e.name) && !/\.test\.(ts|mjs|js)$/.test(e.name) ? [p] : [];
  });
}

/** The names a source text reads from the environment, by the scan's rule. */
export function envNamesIn(text) {
  const names = new Set();
  for (const m of text.matchAll(/["']([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)["']/g)) if (!NOT_ENV.has(m[1])) names.add(m[1]);
  for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1]);
  for (const m of text.matchAll(/\{([^{}]*)\}\s*=\s*process\.env\b/g))
    for (const k of m[1].matchAll(/(?:^|,)\s*([A-Z][A-Z0-9_]*)\b/g)) names.add(k[1]);
  return names;
}

/** The computed process.env[...] reads in a source text: names the text scan cannot see. */
export const computedEnvReads = (text) => [...text.matchAll(/process\.env\[(?!\s*["'][A-Z][A-Z0-9_]*["']\s*\])/g)].length;

/** The functions server.ts hands process.env to, each run here with a recording env. */
// withdrawSenderFromEnv takes the server's fee quoter (fee.ts opens its store once); its own names are read with a stub quoter
const noFee = { networkOf: () => null, quote: async () => { throw new Error("no quote"); }, reads: () => ({ feeMin: async () => 0n }) };
// solanaTokenFromEnv takes the server's proxy and lists; its own names are read with stubs
const noProxy = { handle: async () => ({ status: 503, headers: {}, body: "" }) };
const noLists = { get: async () => ({ status: 503, body: "" }), warm: () => () => {} };
export const ENV_READERS = {
  createProxy,
  createRpc,
  tokenWatchesFromEnv,
  feeQuoterFromEnv,
  withdrawSenderFromEnv: (env) => withdrawSenderFromEnv(env, noFee),
  bindSenderFromEnv: (env) => bindSenderFromEnv(env),
  solanaTokenFromEnv: (env) => solanaTokenFromEnv(env, noProxy, noLists),
};

/** An env that records every name read from it (a get, an `in`), holding `values`. */
export function recordingEnv(values) {
  const read = new Set();
  const note = (k) => typeof k === "string" && read.add(k);
  const env = new Proxy({ ...values }, {
    get: (t, k) => (note(k), t[k]),
    has: (t, k) => (note(k), k in t),
    getOwnPropertyDescriptor: (t, k) => (note(k), Reflect.getOwnPropertyDescriptor(t, k)),
  });
  return { env, read };
}

/** The names each reader reads when run on a recording env with every relayer network set and a store folder. */
export function namesReadAtRun(readers = ENV_READERS) {
  const dir = mkdtempSync(path.join(tmpdir(), "env-names-"));
  try {
    const { env, read } = recordingEnv({
      WITHDRAW_RELAYER_MAINNET: "relayer.confidential.unrlzd.near",
      WITHDRAW_FEE_RECIPIENT_MAINNET: "fees.confidential.unrlzd.near",
      WITHDRAW_RELAYER_TESTNET: "relayer.confidential-unrlzd.testnet",
      WITHDRAW_FEE_RECIPIENT_TESTNET: "fees.confidential-unrlzd.testnet",
      HELPER_STORE_DIR: dir,
    });
    for (const f of Object.values(readers)) f(env);
    return read;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** compose.yaml's services.helper.environment keys, and the Dockerfile's ENV names. */
export function passedNames(compose, dockerfile) {
  const block = /^ {2}helper:\n([\s\S]*?)(?=^ {2}[a-z_]+:\n)/m.exec(compose)?.[1] ?? "";
  const env = /^ {4}environment:\n((?: {6}.*\n| *#.*\n)+)/m.exec(block)?.[1] ?? "";
  const names = new Set([...env.matchAll(/^ {6}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]));
  for (const m of dockerfile.matchAll(/^ENV\s+(.+)$/gm)) for (const kv of m[1].matchAll(/([A-Z][A-Z0-9_]*)=/g)) names.add(kv[1]);
  return names;
}

const read = (p) => readFileSync(path.join(HELPER, p), "utf8");

test("every environment name src/ reads is passed by compose.yaml or set by the image", () => {
  const read_ = new Set(codeFiles(path.join(HELPER, "src")).flatMap((f) => [...envNamesIn(readFileSync(f, "utf8"))]));
  const passed = passedNames(read("deploy/compose.yaml"), read("Dockerfile"));
  assert.ok(["WITHDRAW_RELAYER_MAINNET", "NEAR_RPC_URL", "HELPER_COMMIT", "HELPER_STORE_DIR"].every((n) => read_.has(n)), `the scan found ${[...read_].join(", ")}`);
  assert.deepEqual([...read_].filter((n) => !passed.has(n)).sort(), []);
  assert.deepEqual(codeFiles(path.join(HELPER, "src")).filter((f) => computedEnvReads(readFileSync(f, "utf8")) > 0), [], "a computed process.env read");
});

test("every environment name the helper's code reads when it runs is passed by compose.yaml or set by the image", () => {
  // the readers are exactly the functions server.ts hands process.env to
  // process.env as the first argument, alone or with others (withdrawSenderFromEnv(process.env, fee, ...))
  const handed = new Set([...read("src/server.ts").matchAll(/(\w+)\(process\.env[,)]/g)].map((m) => m[1]));
  assert.deepEqual([...handed].sort(), Object.keys(ENV_READERS).sort());
  const atRun = namesReadAtRun();
  const passed = passedNames(read("deploy/compose.yaml"), read("Dockerfile"));
  assert.ok(["HELPER_STORE_DIR", "WITHDRAW_RELAYER_TESTNET", "NEAR_TESTNET_RPC_URL_B", "JUPITER_API_KEY", "SOLANA_RPC_URL"].every((n) => atRun.has(n)), `the run read ${[...atRun].join(", ")}`);
  assert.deepEqual([...atRun].filter((n) => !passed.has(n)).sort(), []);
  // POST /v1/withdraw's names (withdraw/send.ts), read when nothing is set: a compose without one is caught
  assert.ok(["HELPER_RELEASE", "WITHDRAW_VAULT_MAINNET", "WITHDRAW_RELAYER_KEYS_TESTNET"].every((n) => atRun.has(n)), `the run read ${[...atRun].join(", ")}`);
  const without = passedNames(read("deploy/compose.yaml").replace(/^ {6}WITHDRAW_RELAYER_KEYS_TESTNET:.*\n/m, ""), read("Dockerfile"));
  assert.deepEqual([...atRun].filter((n) => !without.has(n)), ["WITHDRAW_RELAYER_KEYS_TESTNET"]);
  // POST /v1/bind's names (bind/env.ts), read when nothing is set: a compose without one is caught
  const bind = ["BIND_VAULT_MAINNET", "BIND_RELAYER_MAINNET", "BIND_RELAYER_KEY_MAINNET", "BIND_VAULT_TESTNET", "BIND_RELAYER_TESTNET", "BIND_RELAYER_KEY_TESTNET", "BIND_MARGIN_K"];
  assert.ok(bind.every((n) => atRun.has(n)), `the run read ${[...atRun].join(", ")}`);
  for (const n of bind) {
    const missing = passedNames(read("deploy/compose.yaml").replace(new RegExp(`^ {6}${n}:.*\\n`, "m"), ""), read("Dockerfile"));
    assert.deepEqual([...atRun].filter((x) => !missing.has(x)), [n]);
  }
});

test("planted: a name read in src/ that compose.yaml does not pass is caught; one it passes is not", () => {
  const compose = read("deploy/compose.yaml");
  const passed = passedNames(compose, read("Dockerfile"));
  assert.ok(passed.has("WITHDRAW_FEE_RECIPIENT_TESTNET") && passed.has("PORT") && passed.has("HELPER_COMMIT"));
  const without = passedNames(compose.replace(/^ {6}WITHDRAW_RELAYER_TESTNET:.*\n/m, ""), read("Dockerfile"));
  assert.equal(without.has("WITHDRAW_RELAYER_TESTNET"), false);
  assert.deepEqual([...envNamesIn('const k = env["NEW_VENDOR_KEY"]; process.env.OTHER_ONE; "SIMPLE_POOL"')], ["NEW_VENDOR_KEY", "OTHER_ONE"]);
  assert.equal(passedNames(compose, "").has("PORT"), false, "PORT comes from the image's ENV only");
  assert.equal([...passedNames(compose, read("Dockerfile"))].some((n) => n === "HELPER_SITE"), false, "caddy's environment is not the helper's");
  // the forms only a run sees, or that the text scan reads besides quotes
  assert.deepEqual([...envNamesIn("const { HELPER_STORE_DIR, PORT: port } = process.env;")].sort(), ["HELPER_STORE_DIR", "PORT"]);
  assert.equal(computedEnvReads("process.env[`${chain}_RPC_URL`]; process.env[name]"), 2);
  assert.equal(computedEnvReads('process.env["PORT"]'), 0);
  const built = namesReadAtRun({ templated: (env) => env[`${"near".toUpperCase()}_ARCHIVE_URL`], dotted: (env) => env.HELPER_STORE_DIRS });
  assert.deepEqual([...built].filter((n) => !passed.has(n)).sort(), ["HELPER_STORE_DIRS", "NEAR_ARCHIVE_URL"]);
});
