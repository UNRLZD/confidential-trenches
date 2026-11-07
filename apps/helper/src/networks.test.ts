// node --test apps/helper/src/networks.test.ts: the deployed composition carries each network under its own token
// watch. The helper is started as server.ts builds it (the senders from process.env, no sender handed in), on a fake
// pair of NEAR providers answering as nearcore does, with the token watches stubbed per network:
// - a testnet withdrawal (the real proof of withdraw/fixtures/withdraw-request.json, its token the testnet token) is
//   carried when testnet's watch is open, whatever mainnet's says, and held (503 token_halted) when testnet's holds;
// - a deposit delegate (POST /v1/bind) on testnet is held by testnet's watch only, the same way;
// - a mainnet withdrawal (the same proof, its token USDC) is carried or held by mainnet's watch only;
// - every read of a carry goes to its own network's pair, never the other's;
// - with both networks' deposits carried, a send on each that failed on USDC's paused error asks only its own
//   network's watch whether USDC was paused there (R3's exception, bind/env.ts watchDeps).
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { enableTimers, resetTimers } from "../test/mock-timers.ts";
import { base58, NEP366_PREFIX } from "./bind/checks.ts";
import { createFileStore, type DepositRecord } from "./bind/send.ts";
import { bindSenderFromEnv } from "./bind/env.ts";
import { start } from "./server.ts";
import { statusesOf, TESTNET_TOKEN, USDC, USDC_CODE_HASH, type HoldAt, type TokenStatus, type TokenWatches } from "./token-status/status.ts";
import type { FeeQuoter } from "./withdraw/fee.ts";
import { A_STORE_YOCTO, idKeyOf, withdrawSenderFromEnv } from "./withdraw/send.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "withdraw/fixtures/withdraw-request.json"), "utf8")) as {
  vault: string;
  scope: string;
  fee_recipient: string;
  request: Record<string, unknown> & { withdrawal: { recipient: string; register_deposit: string; relay_fee: string; deadline_ms: number } };
};
const W = fixture.request.withdrawal;
/** The helper's clock and the chain's final time: two minutes before the fixture's deadline. */
const NOW = W.deadline_ms - 120_000;
const H = 1_000;
const MAINNET = { NEAR_RPC_URL: "https://m-a.example", NEAR_RPC_URL_B: "https://m-b.example" };
const TESTNET = { NEAR_TESTNET_RPC_URL: "https://t-a.example", NEAR_TESTNET_RPC_URL_B: "https://t-b.example" };
const RELAYER = "relay.test.testnet";
const BIND_RELAYER = "bind.test.testnet";
const BIND_RELAYER_MAINNET = "bind.test.near";

/** An ed25519 key from a fixed seed, as the host's env holds it ("ed25519:" base58 of seed and public key). */
function keyText(fill: number): string {
  const seed = Buffer.alloc(32, fill);
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const pub = Buffer.from(createPublicKey(priv).export({ format: "jwk" }).x as string, "base64url");
  return `ed25519:${base58(Buffer.concat([seed, pub]))}`;
}

const hashOf = (h: number) => base58(createHash("sha256").update(`block ${h}`).digest());
const header = (h: number) => ({ header: { height: h, hash: hashOf(h), prev_height: h - 1, gas_price: "100000000", timestamp_nanosec: (BigInt(NOW) * 1_000_000n).toString() } });
const at = (h: number) => ({ block_height: h, block_hash: hashOf(h) });

/** Two providers per network answering as nearcore does; every call recorded with the URL it went to. */
function fakeNear() {
  const seen: { url: string; method: string; params: Record<string, unknown> }[] = [];
  const views: Record<string, unknown> = {
    spends: [],
    leaves: [],
    storage_balance_of: null,
    storage_balance_bounds: { min: W.register_deposit, max: W.register_deposit },
    is_known_state_root: true,
    is_known_label_root: true,
    totals: { deposited: "1000000000000", spent: "0", returned: "0" },
    deposits: [],
    is_blocklisted: false, // check 7b: the fee account, not blocklisted
  };
  const fetchFn = (async (url: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body) as { method: string; params: Record<string, unknown> };
    seen.push({ url: String(url), method, params });
    const h = typeof params.block_id === "number" ? params.block_id : H;
    let result: unknown;
    if (method === "block") result = header(h);
    else if (method === "query" && params.method_name === "config") {
      // each network's vault holds its own token
      const asset = new URL(String(url)).host.startsWith("m-") ? USDC : TESTNET_TOKEN;
      result = { result: [...Buffer.from(JSON.stringify({ scope: fixture.scope, asset }))], logs: [], ...at(h) };
    }
    else if (method === "EXPERIMENTAL_protocol_config") result = { transaction_validity_period: 86_400 };
    else if (method === "EXPERIMENTAL_changes" && params.changes_type === "single_access_key_changes") {
      // the relayer key's change at D, caused by its stored send (PAUSED_SENDS)
      const key = (params.keys as { account_id: string; public_key: string }[])[0]!;
      result = { block_hash: hashOf(h), changes: [{ type: "access_key_update", cause: { type: "transaction_processing", tx_hash: PAUSED_SENDS[key.account_id] }, change: { ...key, access_key: { nonce: 5, permission: "FullAccess" } } }] };
    } else if (method === "tx") {
      // the stored send's outcome, FINAL: applied at D, the token's receipt failed on USDC's paused panic at H
      const token = new URL(String(url)).host.startsWith("m-") ? USDC : TESTNET_TOKEN;
      const status = { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: FiatToken: paused" } } } } };
      result = { final_execution_status: "FINAL", transaction_outcome: { block_hash: hashOf(PAUSED_B0 + 1) }, receipts_outcome: [{ block_hash: hashOf(H), outcome: { executor_id: token, status } }] };
    }
    else if (method === "send_tx") result = { final_execution_status: "NONE" };
    else if (method === "query" && params.request_type === "call_function" && String(params.method_name) in views) {
      const args = JSON.parse(Buffer.from(String(params.args_base64), "base64").toString("utf8")) as { account_id?: string };
      // check 7b: the fee account is registered on the token; the recipient is not (register_deposit the minimum)
      const v = params.method_name === "storage_balance_of" && args.account_id !== W.recipient ? { total: W.register_deposit, available: "0" } : views[String(params.method_name)];
      result = { result: [...Buffer.from(JSON.stringify(v))], logs: [], ...at(h) };
    } else if (method === "query" && params.request_type === "view_account") {
      const relayer = [RELAYER, BIND_RELAYER, "relay.test.near", BIND_RELAYER_MAINNET].includes(String(params.account_id));
      result = { amount: relayer ? (10n ** 25n).toString() : A_STORE_YOCTO.toString(), locked: "0", code_hash: "11111111111111111111111111111111", storage_usage: 182, ...at(h) };
    } else if (method === "query" && params.request_type === "view_access_key_list") {
      result = { keys: [{ public_key: idKeyOf(W.recipient), access_key: { nonce: 0, permission: "FullAccess" } }], ...at(h) };
    } else if (method === "query" && params.request_type === "view_access_key") {
      result = { nonce: 5, permission: "FullAccess", ...at(h) };
    } else return new Response(JSON.stringify({ jsonrpc: "2.0", id: "r", error: { name: "HANDLER_ERROR", cause: { name: "NOT_SERVED" } } }));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "r", result }));
  }) as unknown as typeof fetch;
  return { seen, fetchFn };
}

const OPEN = { caught_up: true, halted: false, vault_blocked: false, code_hash_ok: true, code_hash: USDC_CODE_HASH, block_height: H, last_event: null } as const;
const HELD = { ...OPEN, halted: true } as const;
/** Each network's watch, stubbed: `open` or `held` per network, each answering for its own token. */
function watches(m: "open" | "held", t: "open" | "held"): TokenWatches {
  const w = (network: "mainnet" | "testnet", token: string, s: "open" | "held") => {
    const status = async (): Promise<TokenStatus> => ({ token, ...(s === "open" ? OPEN : HELD) });
    return { network, token, status, statusAt: status, held: async () => s === "held", pausedAt: async () => null };
  };
  return { mainnet: w("mainnet", USDC, m), testnet: w("testnet", TESTNET_TOKEN, t) } as unknown as TokenWatches;
}

const quoter: FeeQuoter = { networkOf: () => null, quote: async () => { throw new Error("no quote"); }, reads: () => ({ feeMin: async () => BigInt(W.relay_fee) }) } as unknown as FeeQuoter;

function call(port: number, method: string, path: string, body?: string) {
  return new Promise<{ status: number; body: string }>((ok, fail) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers: { "content-type": "application/json" } }, (res) => {
      let b = "";
      res.setEncoding("utf8").on("data", (d) => (b += d)).on("end", () => ok({ status: res.statusCode ?? 0, body: b }));
    });
    r.on("error", fail).end(body);
  });
}

/** The helper as server.ts composes it from `env`, with the watches stubbed; the calls run, then it closes. */
async function withHelper(env: Record<string, string>, w: TokenWatches, run: (port: number, near: ReturnType<typeof fakeNear>) => Promise<void>) {
  const near = fakeNear();
  const saved = { env: { ...process.env }, fetch: globalThis.fetch };
  enableTimers(mock.timers, { apis: ["Date", "setTimeout"], now: NOW });
  Object.assign(process.env, MAINNET, TESTNET, env);
  globalThis.fetch = near.fetchFn;
  // the senders are left to the server's own defaults (handler's parameters), exactly as the deployed main builds them,
  // but for the withdraw sender's mainnet pin: the recorded proof was made for fixture.vault, not the release's vault
  // (send.ts MAINNET_VAULT), so the withdraw and bind senders are built from the same environment with fixture.vault as their pin
  // start() warms the senders it is given, and handler's own defaults are never warmed: these are not either
  const withdraw = { ...withdrawSenderFromEnv(process.env, quoter, statusesOf(w), near.fetchFn, fixture.vault), warm: () => undefined };
  const bind = { ...bindSenderFromEnv(process.env, w, near.fetchFn, fixture.vault), warm: () => undefined };
  const server = start(COMMIT, 0, undefined, undefined, w, undefined, quoter, withdraw, undefined, bind);
  try {
    await new Promise<void>((ok) => server.on("listening", () => ok()));
    await run((server.address() as AddressInfo).port, near);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
    globalThis.fetch = saved.fetch;
    for (const k of Object.keys(process.env)) if (!(k in saved.env)) delete process.env[k];
    Object.assign(process.env, saved.env);
    resetTimers(mock.timers);
  }
}

const WITHDRAW_ENV = () => ({
  WITHDRAW_RELAYER_TESTNET: RELAYER,
  WITHDRAW_FEE_RECIPIENT_TESTNET: fixture.fee_recipient,
  WITHDRAW_VAULT_TESTNET: fixture.vault,
  WITHDRAW_RELAYER_KEYS_TESTNET: keyText(7),
  HELPER_RELEASE: "1",
  HELPER_STORE_DIR: mkdtempSync(join(tmpdir(), "networks-w-")),
});
const testnetWithdrawal = () => JSON.stringify({ ...structuredClone(fixture.request), token: TESTNET_TOKEN });
const codeOf = (body: string) => (JSON.parse(body) as { error?: { code?: string } }).error?.code ?? "ok";

test("a testnet withdrawal is held by testnet's own watch: carried when it is open (mainnet held or not), 503 token_halted when it holds; its reads only on testnet's pair", async () => {
  for (const [m, t, want] of [
    ["held", "open", "submitted"],
    ["open", "open", "submitted"],
    ["open", "held", "token_halted"],
  ] as const) {
    await withHelper(WITHDRAW_ENV(), watches(m, t), async (port, near) => {
      const a = await call(port, "POST", "/v1/withdraw", testnetWithdrawal());
      const got = a.status === 200 ? (JSON.parse(a.body) as { state: string }).state : codeOf(a.body);
      assert.equal(got, want, `mainnet ${m}, testnet ${t}: ${a.status} ${a.body}`);
      assert.equal(a.status, want === "submitted" ? 200 : 503);
      assert.ok(near.seen.length > 0);
      assert.deepEqual([...new Set(near.seen.map((c) => new URL(c.url).host))].sort(), ["t-a.example", "t-b.example"], "a testnet carry reads testnet's pair only");
      assert.equal(near.seen.filter((c) => c.method === "send_tx").length, want === "submitted" ? 2 : 0, "the signed bytes go to both providers only when carried");
    });
  }
});

test("a mainnet withdrawal is held by mainnet's own watch: carried when it is open (testnet held or not), 503 token_halted when it holds; its reads only on mainnet's pair", async () => {
  const env = () => ({
    WITHDRAW_RELAYER_MAINNET: "relay.test.near",
    WITHDRAW_FEE_RECIPIENT_MAINNET: fixture.fee_recipient,
    WITHDRAW_VAULT_MAINNET: fixture.vault,
    WITHDRAW_RELAYER_KEYS_MAINNET: keyText(9),
    HELPER_RELEASE: "1",
    HELPER_STORE_DIR: mkdtempSync(join(tmpdir(), "networks-m-")),
  });
  for (const [m, t, want] of [
    ["open", "held", "submitted"],
    ["held", "open", "token_halted"],
  ] as const) {
    await withHelper(env(), watches(m, t), async (port, near) => {
      const a = await call(port, "POST", "/v1/withdraw", JSON.stringify({ ...structuredClone(fixture.request), token: USDC }));
      const got = a.status === 200 ? (JSON.parse(a.body) as { state: string }).state : codeOf(a.body);
      assert.equal(got, want, `mainnet ${m}, testnet ${t}: ${a.status} ${a.body}`);
      assert.deepEqual([...new Set(near.seen.map((c) => new URL(c.url).host))].sort(), ["m-a.example", "m-b.example"], "a mainnet carry reads mainnet's pair only");
    });
  }
});

// ---- A deposit delegate on testnet (POST /v1/bind) ----

const le = (n: bigint, len: number): Buffer => {
  const b = Buffer.alloc(len);
  for (let i = 0; i < len; i++) b[i] = Number((n >> BigInt(8 * i)) & 0xffn);
  return b;
};
const str = (s: string): Buffer => Buffer.concat([le(BigInt(Buffer.byteLength(s)), 4), Buffer.from(s, "utf8")]);
/** U's ft_transfer_call on `token` as a SignedDelegateAction, its signature then broken (check 2 refuses it, after the hold). */
function badlySigned(token: string): string {
  const seed = Buffer.alloc(32, 3);
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const pub = Buffer.from(createPublicKey(priv).export({ format: "jwk" }).x as string, "base64url");
  const args = JSON.stringify({ receiver_id: fixture.vault, amount: "25000000", msg: "{}" });
  const action = Buffer.concat([Buffer.from([2]), str("ft_transfer_call"), str(args), le(180_000_000_000_000n, 8), le(1n, 16)]);
  const delegate = Buffer.concat([str(pub.toString("hex")), str(token), le(1n, 4), action, le(101n, 8), le(BigInt(H + 120), 8), Buffer.from([0]), pub]);
  const sig = sign(null, createHash("sha256").update(le(BigInt(NEP366_PREFIX), 4)).update(delegate).digest(), priv);
  sig[0] = sig[0]! ^ 1;
  return Buffer.concat([delegate, Buffer.from([0]), sig]).toString("base64");
}

const BIND_ENV_TESTNET = () => ({
  BIND_VAULT_TESTNET: fixture.vault,
  BIND_RELAYER_TESTNET: BIND_RELAYER,
  BIND_RELAYER_KEY_TESTNET: keyText(8),
  BIND_MARGIN_K: "20",
  HELPER_RELEASE: "1",
  HELPER_STORE_DIR: mkdtempSync(join(tmpdir(), "networks-b-")),
});

test("POST /v1/bind on testnet is held by testnet's own watch: past the hold to the checks when it is open (mainnet held or not), 503 token_halted when it holds; reads only on testnet's pair", async () => {
  for (const [m, t, want, status] of [
    ["held", "open", "bad_signature", 400],
    ["open", "held", "token_halted", 503],
  ] as const) {
    await withHelper(BIND_ENV_TESTNET(), watches(m, t), async (port, near) => {
      const a = await call(port, "POST", "/v1/bind", JSON.stringify({ signed_delegate: badlySigned(TESTNET_TOKEN) }));
      assert.deepEqual([a.status, codeOf(a.body)], [status, want], `mainnet ${m}, testnet ${t}: ${a.body}`);
      assert.deepEqual([...new Set(near.seen.map((c) => new URL(c.url).host))].sort(), ["t-a.example", "t-b.example"]);
      // a delegate on mainnet's token: no mainnet network is set, so it is refused with nothing read
      const before = near.seen.length;
      const b = await call(port, "POST", "/v1/bind", JSON.stringify({ signed_delegate: badlySigned(USDC) }));
      assert.deepEqual([b.status, codeOf(b.body)], [400, "token_not_accepted"]);
      assert.equal(near.seen.length, before);
    });
  }
});

const BIND_ENV_MAINNET = () => ({
  BIND_VAULT_MAINNET: fixture.vault,
  BIND_RELAYER_MAINNET: BIND_RELAYER_MAINNET,
  BIND_RELAYER_KEY_MAINNET: keyText(10),
  BIND_MARGIN_K: "20",
  HELPER_RELEASE: "1",
  HELPER_STORE_DIR: mkdtempSync(join(tmpdir(), "networks-bm-")),
});
const hostsOf = (near: ReturnType<typeof fakeNear>, from: number) => [...new Set(near.seen.slice(from).map((c) => new URL(c.url).host))].sort();

test("POST /v1/bind on mainnet is held by mainnet's own watch: past the hold when it is open (testnet held or not), 503 token_halted when it holds; reads only on mainnet's pair", async () => {
  for (const [m, t, want, status] of [
    ["open", "held", "bad_signature", 400],
    ["held", "open", "token_halted", 503],
  ] as const) {
    await withHelper(BIND_ENV_MAINNET(), watches(m, t), async (port, near) => {
      const a = await call(port, "POST", "/v1/bind", JSON.stringify({ signed_delegate: badlySigned(USDC) }));
      assert.deepEqual([a.status, codeOf(a.body)], [status, want], `mainnet ${m}, testnet ${t}: ${a.body}`);
      assert.deepEqual(hostsOf(near, 0), ["m-a.example", "m-b.example"]);
      // a delegate on the testnet token: no testnet network is set, so it is refused with nothing read
      const before = near.seen.length;
      const b = await call(port, "POST", "/v1/bind", JSON.stringify({ signed_delegate: badlySigned(TESTNET_TOKEN) }));
      assert.deepEqual([b.status, codeOf(b.body)], [400, "token_not_accepted"]);
      assert.equal(near.seen.length, before);
    });
  }
});

test("POST /v1/bind with both networks set at once: each delegate is held by its own network's watch only and reads its own pair only", async () => {
  for (const [m, t] of [
    ["held", "open"],
    ["open", "held"],
  ] as const) {
    await withHelper({ ...BIND_ENV_TESTNET(), ...BIND_ENV_MAINNET() }, watches(m, t), async (port, near) => {
      for (const [token, state, hosts] of [
        [USDC, m, ["m-a.example", "m-b.example"]],
        [TESTNET_TOKEN, t, ["t-a.example", "t-b.example"]],
      ] as const) {
        const from = near.seen.length;
        const a = await call(port, "POST", "/v1/bind", JSON.stringify({ signed_delegate: badlySigned(token) }));
        assert.deepEqual([a.status, codeOf(a.body)], state === "open" ? [400, "bad_signature"] : [503, "token_halted"], `${token} (mainnet ${m}, testnet ${t}): ${a.body}`);
        assert.deepEqual(hostsOf(near, from), hosts, `${token}'s carry reads its own pair`);
      }
    });
  }
});

// ---- R3's exception per network (review round 1: a carry given the other network's pausedAt failed no test) ----
const PAUSED_B0 = H - 5;
/** Each network's bind relayer and the hash of its stored send that failed on USDC's paused panic. */
const PAUSED_SENDS: Record<string, string> = { [BIND_RELAYER]: hashOf(900_001), [BIND_RELAYER_MAINNET]: hashOf(900_002) };

test("POST /v1/bind with both networks set at once: a send on each that failed on USDC's paused error asks only its own network's watch (pausedAt), and each hold asks at the deposit's H", async () => {
  const env = { ...BIND_ENV_TESTNET(), ...BIND_ENV_MAINNET() };
  // one open record per network, its send stored pending: the lock round at start reads its outcome
  for (const [net, relayer, u] of [["testnet", BIND_RELAYER, "ab"], ["mainnet", BIND_RELAYER_MAINNET, "cd"]] as const) {
    const store = createFileStore(join(env.HELPER_STORE_DIR, `bind-${net}`));
    const send = { tx_hash: PAUSED_SENDS[relayer]!, nonce: "5", height: String(PAUSED_B0), block_hash: hashOf(PAUSED_B0), signed_tx: Buffer.from("stored").toString("base64"), sha256: "0".repeat(64), amount: "25000000", max_block_height: String(H), state: "pending" as const, counted: true };
    const rec: DepositRecord = { u: u.repeat(32), p: "12345", prepaid_bytes: 756, failed: 0, struck: false, landed: false, p_closed: false, prepays: [], sends: [send], carried: [] };
    store.create(rec);
    store.close();
  }
  const asked: Record<string, { at: bigint[]; holds: HoldAt[] }> = { mainnet: { at: [], holds: [] }, testnet: { at: [], holds: [] } };
  const w = watches("open", "open");
  for (const net of ["mainnet", "testnet"] as const) {
    const status = w[net].status;
    Object.assign(w[net], {
      statusAt: (at: HoldAt) => (asked[net]!.holds.push(at), status()),
      pausedAt: async (h: bigint) => (asked[net]!.at.push(h), true),
    });
  }
  await withHelper(env, w, async (port) => {
    for (const token of [USDC, TESTNET_TOKEN]) {
      const a = await call(port, "POST", "/v1/bind", JSON.stringify({ signed_delegate: badlySigned(token) }));
      assert.deepEqual([a.status, codeOf(a.body)], [400, "bad_signature"], `${token}: ${a.body}`);
    }
    // the lock rounds run at each network's start; wait for both to read their send
    for (let i = 0; i < 5_000 && (asked.mainnet!.at.length === 0 || asked.testnet!.at.length === 0); i++) await new Promise((ok) => setImmediate(ok));
  });
  assert.deepEqual(asked.mainnet!.at, [BigInt(H)], "mainnet's send asked mainnet's watch, once");
  assert.deepEqual(asked.testnet!.at, [BigInt(H)], "testnet's send asked testnet's watch, once");
  // each network's hold asked at the deposit's H rule
  assert.ok(asked.mainnet!.holds.length > 0 && asked.mainnet!.holds.every((x) => x === "higher"), JSON.stringify(asked.mainnet!.holds));
  assert.ok(asked.testnet!.holds.length > 0 && asked.testnet!.holds.every((x) => x === "higher"), JSON.stringify(asked.testnet!.holds));
});
