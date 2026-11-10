// node --test apps/helper/src/status-hook.test.ts: the proxy route hands a 1Click status answer it carried to the
// deposit's creation (card helper-create-u; bind/env.ts delivered, bind/create.ts onStatusAnswer), after the answer and
// off its path. The proxy is the real one on a fake 1Click that answers the recorded status (bind/fixtures/
// oneclick-status.json); the bind sender is a fake that records what it is handed.
// - the device's answer is byte-equal with the hook on and off, and the hook gets that same body once;
// - a hook that throws or never ends changes no answer;
// - only a 200 of oneclick /v0/status reaches it: another path, another vendor or a refused call does not.
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { base58 } from "./bind/checks.ts";
import { bindSenderFromEnv, type BindSender } from "./bind/env.ts";
import { createFileStore } from "./bind/send.ts";
import { createProxy } from "./proxy/proxy.ts";
import { start } from "./server.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const ENV = { ONECLICK_JWT: "test-oneclick-0001", RELAY_API_KEY: "test-relay-0001" };
const RECORDED = JSON.parse(readFileSync(join(import.meta.dirname, "bind/fixtures/oneclick-status.json"), "utf8")) as { answers: { success_usdc: unknown } };
/** The upstream's bytes, as 1Click sends them (no spaces). */
const UPSTREAM = JSON.stringify(RECORDED.answers.success_usdc);
const ADDRESS = "a998c6585100ca4bccbc0e0bcceb9abd66e59666e87bd03b1d83bb9544f7ce2f";

type Got = { status: number; body: string; type: string | undefined };
function call(port: number, path: string, body = ""): Promise<Got> {
  return new Promise((ok, fail) => {
    const r = request({ host: "127.0.0.1", port, method: "POST", path, headers: { "content-type": "application/json" } }, (res) => {
      let b = "";
      res.setEncoding("utf8").on("data", (d) => (b += d)).on("end", () => ok({ status: res.statusCode ?? 0, body: b, type: res.headers["content-type"] }));
    });
    r.on("error", fail).end(body);
  });
}
const turns = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((ok) => setImmediate(ok));
};

/** A helper whose 1Click answers `upstream` (status, body) to every call, with `bind` handed in. */
async function helper(bind: BindSender, upstream: (url: string) => { status: number; body: string } = () => ({ status: 200, body: UPSTREAM }), senders: Promise<unknown> = Promise.resolve()): Promise<{ port: number; close(): Promise<void> }> {
  const fetchFn = async (url: string) => {
    const u = upstream(url);
    return new Response(u.body, { status: u.status, headers: { "content-type": "application/json" } });
  };
  const s: Server = start(COMMIT, 0, createProxy(ENV, { fetch: fetchFn }), undefined, undefined, undefined, undefined, undefined, undefined, bind, undefined, undefined, undefined, undefined, senders);
  await new Promise<void>((ok) => s.on("listening", () => ok()));
  return {
    port: (s.address() as AddressInfo).port,
    close: () => new Promise<void>((ok) => (s.closeAllConnections(), s.close(() => ok()))),
  };
}
const sender = (delivered?: (body: string) => void): BindSender => ({
  carry: async () => ({ status: 503, body: { error: { code: "upstream" } } }),
  warm: () => undefined,
  stop: () => undefined,
  ...(delivered ? { delivered } : {}),
});
const STATUS_PATH = `/v1/proxy/oneclick/v0/status?depositAddress=${ADDRESS}`;

test("the device's status answer is byte-equal with the hook on and off, and the hook gets that body once, after it", async (t) => {
  const off = await helper(sender());
  t.after(() => off.close());
  const seen: string[] = [];
  const on = await helper(sender((b) => void seen.push(b)));
  t.after(() => on.close());
  const a = await call(off.port, STATUS_PATH);
  const b = await call(on.port, STATUS_PATH);
  assert.equal(a.status, 200);
  assert.equal(a.body, UPSTREAM, "the proxy passes 1Click's bytes");
  assert.deepEqual(b, a);
  await turns();
  assert.deepEqual(seen, [UPSTREAM]);
});

test("a hook that throws, or never ends, changes no answer; the next call is served as before", async (t) => {
  let calls = 0;
  const throws = await helper(
    sender(() => {
      calls++;
      throw new Error("hook broke");
    }),
  );
  t.after(() => throws.close());
  const hangs = await helper(sender(() => void new Promise(() => undefined)));
  t.after(() => hangs.close());
  for (const h of [throws, hangs, throws]) {
    const r = await call(h.port, STATUS_PATH);
    assert.deepEqual([r.status, r.body], [200, UPSTREAM]);
  }
  await turns();
  assert.equal(calls, 2);
});

test("only a 200 of oneclick /v0/status reaches the hook: a quote, another vendor's status or a refused status does not", async (t) => {
  const seen: string[] = [];
  let status = 200;
  const h = await helper(sender((b) => void seen.push(b)), () => ({ status, body: UPSTREAM }));
  t.after(() => h.close());
  assert.equal((await call(h.port, "/v1/proxy/oneclick/v0/quote", "{}")).status, 200);
  assert.equal((await call(h.port, "/v1/proxy/relay/intents/status/v3?requestId=0x1")).status, 200);
  assert.equal((await call(h.port, "/v1/proxy/oneclick/v0/status/?depositAddress=x")).status, 400, "not the path byte for byte: refused");
  for (const s of [404, 400]) {
    status = s;
    const r = await call(h.port, STATUS_PATH);
    assert.notEqual(r.status, 200, String(s));
  }
  await turns();
  assert.deepEqual(seen, []);
});

test("fold 5: during the senders' handover the hook waits (nothing opens the deposit store the old helper holds), no lock is taken while the old helper holds it, and it runs once they are this helper's", async (t) => {
  const seed = Buffer.alloc(32, 5);
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const pub = Buffer.from(createPublicKey(priv).export({ format: "jwk" }).x as string, "base64url");
  const dir = mkdtempSync(join(tmpdir(), "handover-"));
  const old = createFileStore(join(dir, "bind-mainnet")); // the helper being replaced holds the mainnet deposit store
  let oldOpen = true;
  t.after(() => oldOpen && old.close());
  const reads: string[] = [];
  // the providers answer the start's block and config reads, so a start that ran during the handover would reach the
  // store's lock (a 321 ms stall, measured with the lock held), then fail its next read, so this one is logged and ends
  const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
  const near = (async (_u: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body) as { method: string; params: Record<string, unknown> };
    reads.push(method);
    const at = { block_height: 1000, block_hash: "3".repeat(43) };
    let result: unknown;
    if (method === "block") result = { header: { height: 1000, hash: at.block_hash, prev_height: 999, gas_price: "100000000", timestamp_nanosec: (BigInt(Date.now()) * 1_000_000n).toString() } };
    else if (method === "query" && params.method_name === "config") result = { result: [...Buffer.from(JSON.stringify({ asset: USDC }))], logs: [], ...at };
    else throw new Error("provider down");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "r", result }), { status: 200 });
  }) as unknown as typeof fetch;
  const env = { BIND_VAULT_MAINNET: "vault.test.near", BIND_RELAYER_MAINNET: "bind.test.near", BIND_RELAYER_KEY_MAINNET: `ed25519:${base58(Buffer.concat([seed, pub]))}`, BIND_MARGIN_K: "20", HELPER_RELEASE: "1", HELPER_STORE_DIR: dir };
  const errors: string[] = [];
  t.mock.method(console, "error", (l: string) => void errors.push(l));
  // the store's lock is SQLite's BEGIN EXCLUSIVE, the only SQLite call there is (store/durable.ts), and its take blocks
  // the thread for its busy timeout (LOCK_WAIT_MS, 250 ms) while the old helper holds it: each take is counted with
  // whether the old helper still held the store then, never timed, so a runner's scheduling cannot reach it
  const exec = DatabaseSync.prototype.exec;
  let takenWhileHeld = 0;
  const takes = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (oldOpen) takenWhileHeld++;
    return exec.call(this, sql);
  });
  const bind = bindSenderFromEnv(env, {}, near, env.BIND_VAULT_MAINNET); // a stand-in vault: its own pin
  t.after(() => bind.stop());
  let handOver: () => void = () => undefined;
  const senders = new Promise<void>((ok) => (handOver = ok));
  const h = await helper(bind, undefined, senders);
  t.after(() => h.close());
  for (let i = 0; i < 3; i++) {
    const r = await call(h.port, STATUS_PATH);
    assert.deepEqual([r.status, r.body], [200, UPSTREAM]);
  }
  await new Promise((ok) => setTimeout(ok, 300));
  const readsBefore = [...reads];
  // the handover: the old helper stops, its locks go with it
  old.close();
  oldOpen = false;
  handOver();
  for (let i = 0; i < 100 && errors.length === 0; i++) await new Promise((ok) => setTimeout(ok, 10));
  assert.ok(takes.mock.callCount() > 0, "the new helper took the store's lock, so its take was measured");
  assert.equal(takenWhileHeld, 0, "no lock take while the old helper held the store");
  assert.deepEqual(readsBefore, [], "nothing started while the senders are the old helper's");
  assert.ok(reads.length > 0, "the hook ran once the senders were this helper's");
});

test("card helper-id-intents: a 1Click quote answer the proxy carried (200 or 201) reaches bind.quoted once, after the device's answer; another path does not", async (t) => {
  const QUOTE = JSON.stringify((RECORDED.answers.success_usdc as { quoteResponse: unknown }).quoteResponse);
  const quoted: string[] = [];
  for (const status of [200, 201]) {
    const h = await helper({ ...sender(), quoted: (b) => void quoted.push(b) }, () => ({ status, body: QUOTE }));
    t.after(() => h.close());
    const a = await call(h.port, "/v1/proxy/oneclick/v0/quote", JSON.stringify({ dry: false }));
    assert.equal(a.status, status);
    assert.equal(a.body, QUOTE);
    await turns();
  }
  assert.deepEqual(quoted, [QUOTE, QUOTE]);
  const other = await helper({ ...sender(), quoted: (b) => void quoted.push(b) }, () => ({ status: 200, body: QUOTE }));
  t.after(() => other.close());
  await call(other.port, STATUS_PATH);
  const refused = await helper({ ...sender(), quoted: (b) => void quoted.push(b) }, () => ({ status: 400, body: "{}" }));
  t.after(() => refused.close());
  await call(refused.port, "/v1/proxy/oneclick/v0/quote", "{}");
  await turns();
  assert.equal(quoted.length, 2, "a status, or a refused quote, is not recorded");
});
