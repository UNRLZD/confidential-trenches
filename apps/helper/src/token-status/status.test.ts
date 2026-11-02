// node --test apps/helper/src/token-status/status.test.ts: USDC's status (markets paper H7 /v1/token-status, M:3336;
// H3.4 check 10, M:1388) with two fake NEAR providers. The code hash is shown only when both providers answer and
// agree; the hold is on unless every value is known and clear, so a failing, disagreeing or changed provider, and the
// watch not caught up, all hold the relayers. Served on a real server on a free port.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { HelperTokenStatusAnswer } from "../../../../packages/kit/src/index.ts";
import { start } from "../server.ts";
import { HEIGHT_SPREAD_MAX as FEE_SPREAD } from "../withdraw/fee.ts";
import { MAX_FINAL_AGE_MS } from "../withdraw/index.ts";
import { A, B, hashOf, nearChain, nearPair, PAUSED, type Views } from "../../test/token-status/near.ts";
import {
  backoffOf,
  BACKOFF_429_MS,
  CACHE_MS,
  createTokenWatch,
  FINAL_AGE_MAX_MS,
  H_WAIT_MS,
  haltOf,
  HEIGHT_SPREAD_MAX,
  readUrls,
  statusesOf,
  statusFrom,
  TESTNET_RPCS,
  TESTNET_TOKEN,
  tokenHeld,
  tokenWatchesFromEnv,
  USDC,
  USDC_CODE_HASH,
  viewOutcome,
  WATCH_RPCS,
  type Read,
  type TokenStatus,
} from "./status.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const CHANGED = "GT71B8i42Z2xegTKpA6TUJQYghRqZfyJUNJG6rKf21DT"; // another real code hash (the vault's testnet build)
const ENV = { NEAR_RPC_URL: A, NEAR_RPC_URL_B: B };
const VAULT = "vault.test.near";
const WITH_VAULT = { ...ENV, WITHDRAW_VAULT_MAINNET: VAULT };
/** One provider's every answer replaced by `answer` (the other answers as nearcore does). */
function oneBroken(url: string, answer: () => Response | Promise<Response>, views: Views = {}) {
  const good = nearPair(views);
  return { seen: good.seen, fetch: async (u: string, init: RequestInit) => (u === url ? answer() : good.fetch(u, init)) };
}
const short = (c: { url: string; method: string; params: Record<string, unknown> }) =>
  `${c.url === A ? "A" : "B"} ${c.method === "block" ? "block" : String(c.params.method_name ?? c.params.request_type)} ${String(c.params.block_id ?? c.params.finality)}`;

test("the pin is the vault's USDC and its code hash as the repo pins them; the answer has the kit's fields", () => {
  assert.match(readFileSync(path.join(ROOT, "contracts/vault/src/constants.rs"), "utf8"), new RegExp(`pub const TOKEN: &str = "${USDC}";`));
  assert.equal(JSON.parse(readFileSync(path.join(ROOT, "contracts/vault/deployments/testnet-usdc.json"), "utf8")).code_hash, USDC_CODE_HASH);
  const s: HelperTokenStatusAnswer = statusFrom(undefined, undefined, USDC); // the kit's type: tsc checks the shape
  assert.deepEqual(Object.keys(s), ["token", "caught_up", "halted", "vault_blocked", "code_hash_ok", "code_hash", "block_height", "last_event"]);
});

test("one value each: the finals' spread and H's age are the withdraw path's own (fee.ts, withdraw/index.ts)", () => {
  assert.equal(BigInt(HEIGHT_SPREAD_MAX), FEE_SPREAD);
  assert.equal(BigInt(FINAL_AGE_MAX_MS), MAX_FINAL_AGE_MS);
});

test("no vault carried on the network: the code hash at H (the lower final) on both, shown, never caught up, held", async () => {
  const p = nearPair({ final: 100 }, { final: 98 });
  const w = createTokenWatch("mainnet", ENV, { fetch: p.fetch });
  const s = await w.status();
  assert.deepEqual(s, { token: USDC, caught_up: false, halted: null, vault_blocked: null, code_hash_ok: null, code_hash: USDC_CODE_HASH, block_height: 98, last_event: null });
  assert.deepEqual(p.seen.map(short).sort(), ["A block final", "A view_account 98", "B block final", "B view_account 98"]);
  assert.equal(await w.held("lower"), true);
});

test("the safe answer when either provider fails or answers off shape: no code hash, held", async () => {
  const bad: [string, () => Response | Promise<Response>][] = [
    ["a 500", () => new Response("{}", { status: 500 })],
    ["an RPC error", () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000 } }), { status: 200 })],
    ["not JSON", () => new Response("<html>", { status: 200 })],
    ["no answer", () => Promise.reject(new Error("down"))],
    ["an answer too large", () => new Response(JSON.stringify({ result: { code_hash: USDC_CODE_HASH, block_height: 1, header: {}, pad: "x".repeat(1_048_577) } }), { status: 200 })],
  ];
  for (const [name, answer] of bad) {
    for (const url of [A, B]) {
      const w = createTokenWatch("mainnet", WITH_VAULT, { fetch: oneBroken(url, answer).fetch });
      const s = await w.status();
      assert.deepEqual([s.caught_up, s.code_hash, s.block_height], [false, "", 0], `${name} on ${url}`);
      assert.equal(await w.held("lower"), true, name);
    }
  }
  const shapes: [string, Views][] = [
    ["a changed hash on one", { code: () => ({ code_hash: CHANGED }) }],
    ["a hash of the wrong shape", { code: () => ({ code_hash: "0x" + "a".repeat(64) }) }],
    ["an answer of another block", { code: (h) => ({ block_hash: hashOf(h + 1) }) }],
    ["a view_account answer over 4 KB (a block's answer may hold 1 MiB, a view's 4 KB)", { code: () => ({ pad: "x".repeat(4_096) }) }],
  ];
  for (const [name, v] of shapes) {
    const s = await createTokenWatch("mainnet", WITH_VAULT, { fetch: nearPair(v, {}).fetch }).status();
    assert.deepEqual([s.caught_up, s.code_hash, s.block_height], [false, "", 0], name);
  }
  // both changed the same way: shown as read, and held (not the pin)
  const both = createTokenWatch("mainnet", WITH_VAULT, { fetch: nearPair({ code: () => ({ code_hash: CHANGED }) }).fetch });
  assert.equal((await both.status()).code_hash, CHANGED);
  assert.equal(await both.held("lower"), true);
});

test("tokenHeld: free only when caught up, not halted, the vault not blocked and the code the pin; anything else holds", () => {
  const clear: TokenStatus = { token: USDC, caught_up: true, halted: false, vault_blocked: false, code_hash_ok: true, code_hash: USDC_CODE_HASH, block_height: 1, last_event: null };
  assert.equal(tokenHeld(clear), false);
  const holds: Partial<TokenStatus>[] = [
    { caught_up: false },
    { halted: true },
    { halted: null },
    { vault_blocked: true },
    { vault_blocked: null },
    { code_hash_ok: false },
    { code_hash_ok: null },
    { code_hash: CHANGED },
    { code_hash: "" },
  ];
  for (const h of holds) assert.equal(tokenHeld({ ...clear, ...h }), true, JSON.stringify(h));
});

test("the display: one read per CACHE_MS of the monotonic clock however many callers ask", async () => {
  let t = 1_000;
  const p = nearPair({});
  const w = createTokenWatch("mainnet", WITH_VAULT, { fetch: p.fetch, clock: () => t });
  await Promise.all([w.status(), w.status(), w.status()]);
  await w.status();
  const once = p.seen.length;
  assert.equal(once, 8, "two finals, then three views at H on each");
  t += CACHE_MS;
  await w.status();
  assert.equal(p.seen.length, once + 2, "the finals again; H unchanged, its status kept by block");
});

test("providers: two different http(s) URLs from the environment, else two public ones; errors name the variable only", () => {
  assert.deepEqual(readUrls({}, "mainnet"), WATCH_RPCS.map((r) => r.fallback));
  assert.notEqual(new URL(WATCH_RPCS[0].fallback).host, new URL(WATCH_RPCS[1].fallback).host);
  assert.throws(() => readUrls({ NEAR_RPC_URL: B, NEAR_RPC_URL_B: B }, "mainnet"), /two different providers/);
  for (const bad of ["nope", "ftp://x.example", "https://x.example/#f"]) assert.throws(() => readUrls({ NEAR_RPC_URL_B: bad }, "mainnet"), (e: Error) => e.message.startsWith("NEAR_RPC_URL_B must be") && !e.message.includes(bad));
});

test("GET /v1/token-status on the server: the release's USDC answered in the kit's shape; any other token 404 token_not_watched", async () => {
  const w = createTokenWatch("mainnet", ENV, { fetch: nearPair({ final: 7 }).fetch });
  const t = createTokenWatch("testnet", { NEAR_TESTNET_RPC_URL: A, NEAR_TESTNET_RPC_URL_B: B }, { fetch: nearPair({ final: 9 }).fetch });
  const server = start("0123456789abcdef0123456789abcdef01234567", 0, undefined, undefined, { mainnet: w, testnet: t });
  await new Promise<void>((ok) => server.on("listening", () => ok()));
  const port = (server.address() as AddressInfo).port;
  const call = (method: string, p: string) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((ok, fail) => {
      const r = request({ host: "127.0.0.1", port, method, path: p, headers: { origin: "https://confidential.unrealized.trade" } }, (res) => {
        let body = "";
        res.setEncoding("utf8").on("data", (d) => (body += d)).on("end", () => ok({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      r.on("error", fail).end();
    });
  try {
    const good = await call("GET", `/v1/token-status?token=${USDC}`);
    assert.equal(good.status, 200);
    assert.deepEqual(JSON.parse(good.body), { token: USDC, caught_up: false, halted: null, vault_blocked: null, code_hash_ok: null, code_hash: USDC_CODE_HASH, block_height: 7, last_event: null });
    assert.ok(Buffer.byteLength(good.body) <= 1024, "1 KB limit (H7)");
    assert.equal(good.headers["access-control-allow-origin"], "https://confidential.unrealized.trade");
    assert.equal(good.headers["cache-control"], "no-store");
    for (const p of ["/v1/token-status", "/v1/token-status?token=usdc.near", `/v1/token-status?token=${USDC}&token=${USDC}`, `/v1/token-status?token=${USDC.toUpperCase()}`]) {
      const r = await call("GET", p);
      assert.equal(r.status, 404, p);
      assert.deepEqual(JSON.parse(r.body), { error: { code: "token_not_watched" } }, p);
    }
    // the testnet token from testnet's own watch
    const tn = await call("GET", `/v1/token-status?token=${TESTNET_TOKEN}`);
    assert.equal(tn.status, 200);
    assert.deepEqual(JSON.parse(tn.body), { token: TESTNET_TOKEN, caught_up: false, halted: null, vault_blocked: null, code_hash_ok: null, code_hash: USDC_CODE_HASH, block_height: 9, last_event: null });
    const post = await call("POST", `/v1/token-status?token=${USDC}`);
    assert.equal(post.status, 405);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
  }
});

test("one watch per network: mainnet's reads USDC on mainnet's pair only, testnet's the testnet token on testnet's pair only; the relayers get each network's own", async () => {
  const [TA, TB] = ["https://t-a.example", "https://t-b.example"];
  const env = { ...ENV, NEAR_TESTNET_RPC_URL: TA, NEAR_TESTNET_RPC_URL_B: TB };
  const main = nearPair({ final: 5 });
  const tnet = nearPair({ final: 6, code: () => ({ code_hash: CHANGED }) }, undefined, [TA, TB]);
  const seen: string[] = [];
  const fetch = (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { method: string; params: { account_id?: string } };
    if (body.method === "query") seen.push(`${url} ${body.params.account_id}`);
    return url === A || url === B ? main.fetch(url, init) : tnet.fetch(url, init);
  };
  const w = tokenWatchesFromEnv(env, { fetch });
  const m = await w.mainnet.status();
  assert.deepEqual(seen.sort(), [`${A} ${USDC}`, `${B} ${USDC}`]);
  seen.length = 0;
  const t = await w.testnet.status();
  assert.deepEqual(seen.sort(), [`${TA} ${TESTNET_TOKEN}`, `${TB} ${TESTNET_TOKEN}`]);
  assert.deepEqual([m.token, m.code_hash, t.token, t.code_hash], [USDC, USDC_CODE_HASH, TESTNET_TOKEN, CHANGED]);
  const s = statusesOf(w);
  assert.equal(s.mainnet, w.mainnet.statusAt);
  assert.equal(s.testnet, w.testnet.statusAt);
  // testnet's pair: the environment, else the release's public pair of two operators; one URL twice is refused
  assert.deepEqual(readUrls({}, "testnet"), TESTNET_RPCS.map((r) => r.fallback));
  assert.notEqual(new URL(TESTNET_RPCS[0].fallback).host, new URL(TESTNET_RPCS[1].fallback).host);
  assert.throws(() => readUrls({ NEAR_TESTNET_RPC_URL: TA, NEAR_TESTNET_RPC_URL_B: TA }, "testnet"), /NEAR_TESTNET_RPC_URL and NEAR_TESTNET_RPC_URL_B must be two different providers/);
  // the testnet token is the deployed one, and it runs USDC's own code
  const dep = JSON.parse(readFileSync(path.join(ROOT, "contracts/vault/deployments/testnet-usdc.json"), "utf8")) as { account_id: string; code_hash: string };
  assert.deepEqual([dep.account_id, dep.code_hash], [TESTNET_TOKEN, USDC_CODE_HASH]);
});

// ---- design (b): USDC's own views at the move's H on both providers ----

test("(b) open: both providers read a balance, the vault not blocklisted and the pin at H, the lower final, each answer of H's hash: caught up, not halted, not blocked, free", async () => {
  const p = nearPair({ final: 500 }, { final: 497 });
  const w = createTokenWatch("mainnet", WITH_VAULT, { fetch: p.fetch });
  assert.deepEqual(await w.status(), { token: USDC, caught_up: true, halted: false, vault_blocked: false, code_hash_ok: true, code_hash: USDC_CODE_HASH, block_height: 497, last_event: null });
  assert.equal(await w.held("lower"), false);
  const args = Buffer.from(JSON.stringify({ account_id: VAULT })).toString("base64");
  for (const url of [A, B]) {
    const mine = p.seen.filter((c) => c.url === url && c.method === "query").map((c) => c.params);
    assert.deepEqual(mine.slice(0, 3), [
      { request_type: "call_function", block_id: 497, account_id: USDC, method_name: "ft_balance_of", args_base64: args },
      { request_type: "call_function", block_id: 497, account_id: USDC, method_name: "is_blocklisted", args_base64: args },
      { request_type: "view_account", block_id: 497, account_id: USDC },
    ]);
  }
});

test("(b) USDC's exact paused panic on either provider is halted; is_blocklisted true on either is blocked; both hold", async () => {
  for (const [what, a, b, want] of [
    ["halted on A", { balance: () => ({ error: PAUSED }) }, {}, { halted: true, vault_blocked: false }],
    ["halted on both", { balance: () => ({ error: PAUSED }) }, { balance: () => ({ error: PAUSED }) }, { halted: true, vault_blocked: false }],
    ["blocked on B", {}, { blocked: () => "true" }, { halted: false, vault_blocked: true }],
  ] as const) {
    const w = createTokenWatch("mainnet", WITH_VAULT, { fetch: nearPair(a as Views, b as Views).fetch });
    const s = await w.status();
    assert.deepEqual([s.caught_up, s.halted, s.vault_blocked, s.code_hash_ok], [true, want.halted, want.vault_blocked, true], what);
    assert.equal(await w.held("lower"), true, what);
    assert.equal(await w.held("higher"), true, what);
  }
});

test("(b) unknown holds: any answer that is not exactly the open one or USDC's paused panic, another code, or no vault: not caught up, all null, held", async () => {
  const cases: [string, Views, Views?][] = [
    ["another panic", { balance: () => ({ error: 'wasm execution failed with error: HostError(GuestPanic { panic_msg: "FiatToken: not paused" })' }) }],
    ["the paused panic with more after it", { balance: () => ({ error: 'wasm execution failed with error: HostError(GuestPanic { panic_msg: "FiatToken: paused, and more" })' }) }],
    ["the paused panic with a space after it", { balance: () => ({ error: 'wasm execution failed with error: HostError(GuestPanic { panic_msg: "FiatToken: paused " })' }) }],
    ["a balance of the wrong shape", { balance: () => "null" }],
    ["a balance with a space around it", { balance: () => ' "5" ' }],
    ["a method error, not a panic", { balance: () => ({ error: "wasm execution failed with error: MethodResolveError(MethodNotFound)" }) }],
    ["is_blocklisted not a boolean", { blocked: () => '"false"' }],
    ["is_blocklisted panics", { blocked: () => ({ error: PAUSED }) }],
    ["view_account at another block", { code: (h) => ({ block_height: h + 1 }) }],
    ["both agree on another code: the views' meaning is the pin's only", { code: () => ({ code_hash: CHANGED }) }],
    ["the providers' code differs", {}, { code: () => ({ code_hash: CHANGED }) }],
  ];
  for (const [what, a, b] of cases) {
    const w = createTokenWatch("mainnet", WITH_VAULT, { fetch: nearPair(a, b ?? {}).fetch });
    const s = await w.status();
    assert.deepEqual([s.caught_up, s.halted, s.vault_blocked, s.code_hash_ok], [false, null, null, null], what);
    assert.equal(await w.held("lower"), true, what);
  }
  const another = await createTokenWatch("mainnet", WITH_VAULT, { fetch: nearPair({ code: () => ({ code_hash: CHANGED }) }).fetch }).status();
  assert.equal(another.code_hash, CHANGED, "the code read is shown, so the reason is visible");
  const noVault = await createTokenWatch("mainnet", ENV, { fetch: nearPair({}).fetch }).status();
  assert.deepEqual([noVault.caught_up, noVault.code_hash], [false, USDC_CODE_HASH], "no vault carried on the network: never caught up");
});

test("(b) the vault from WITHDRAW_VAULT_<NET> or BIND_VAULT_<NET>; two that differ or one that is not an account id stop the helper; each network its own", () => {
  assert.equal(createTokenWatch("mainnet", { ...ENV, BIND_VAULT_MAINNET: VAULT }).vault, VAULT);
  assert.equal(createTokenWatch("mainnet", { ...ENV, WITHDRAW_VAULT_MAINNET: VAULT, BIND_VAULT_MAINNET: VAULT }).vault, VAULT);
  assert.equal(createTokenWatch("testnet", { ...ENV, WITHDRAW_VAULT_MAINNET: VAULT }).vault, undefined);
  assert.throws(() => createTokenWatch("mainnet", { ...ENV, WITHDRAW_VAULT_MAINNET: VAULT, BIND_VAULT_MAINNET: "other.near" }), /WITHDRAW_VAULT_MAINNET and BIND_VAULT_MAINNET must name the same vault/);
  assert.throws(() => createTokenWatch("mainnet", { ...ENV, BIND_VAULT_MAINNET: "Not An Id" }), /BIND_VAULT_MAINNET must be a NEAR account id/);
});

test("(b) pausedAt(h): block h's header on both, ft_balance_of at its parent and at h (by hash), the pin at both, on both providers; paused at either; null unless all known and agreed; a known answer is kept", async () => {
  const at = async (views: Views, viewsB?: Views, h = 100n) => {
    const p = nearPair(views, viewsB ?? views);
    const w = createTokenWatch("mainnet", WITH_VAULT, { fetch: p.fetch });
    return { got: await w.pausedAt(h), p, w };
  };
  const pausedFrom = (x: number) => (h: number) => (h >= x ? { error: PAUSED } : '"5"');
  assert.equal((await at({ balance: pausedFrom(100) })).got, true, "paused in the block");
  assert.equal((await at({ balance: (h) => (h === 99 ? { error: PAUSED } : '"5"') })).got, true, "paused before, unpaused in the block");
  assert.equal((await at({})).got, false, "open at both");
  assert.equal((await at({ balance: pausedFrom(100) }, {})).got, null, "the providers disagree");
  assert.equal((await at({ balance: pausedFrom(100), code: () => ({ code_hash: CHANGED }) })).got, null, "another code at the block");
  assert.equal((await at({ balance: pausedFrom(100), code: (h) => (h === 99 ? { code_hash: CHANGED } : {}) })).got, null, "another code at the parent");
  assert.equal((await at({ balance: pausedFrom(100), final: 99 })).got, null, "a block the provider does not hold");
  const { p, w } = await at({ balance: pausedFrom(100) });
  const [h99, h100] = [hashOf(99), hashOf(100)];
  assert.deepEqual(
    p.seen.map(short).sort(),
    ["A block 100", "A ft_balance_of " + h100, "A ft_balance_of " + h99, "A view_account " + h100, "A view_account " + h99, "B block 100", "B ft_balance_of " + h100, "B ft_balance_of " + h99, "B view_account " + h100, "B view_account " + h99].sort(),
  );
  const n = p.seen.length;
  assert.equal(await w.pausedAt(100n), true);
  assert.equal(p.seen.length, n, "a known answer for a past block is kept, not read again");
  assert.equal(await createTokenWatch("mainnet", ENV, { fetch: nearPair({ balance: pausedFrom(100) }).fetch }).pausedAt(100n), null, "no vault: not known");
});

// ---- review round 1 (46a261d): each test fails with its plant ----

test("(r1) H by the move: lower reads every view at the lower final; higher at the higher, after the lagging provider reaches it within H_WAIT_MS; finals over HEIGHT_SPREAD_MAX apart hold", async () => {
  let bFinal = 497;
  let t = 0;
  const sleeps: number[] = [];
  const deps = (fetch: (u: string, i: RequestInit) => Promise<Response>) => ({ fetch, clock: () => t, sleep: async (ms: number) => void (sleeps.push(ms), (t += ms), bFinal++) });
  const lower = nearPair({ final: 500 }, { final: () => bFinal });
  const wl = createTokenWatch("mainnet", WITH_VAULT, deps(lower.fetch));
  assert.equal((await wl.statusAt("lower")).block_height, 497);
  assert.deepEqual([...new Set(lower.seen.filter((c) => c.method === "query").map((c) => c.params.block_id))], [497]);
  assert.equal(sleeps.length, 0, "the lower final is held by both: no wait");
  const higher = nearPair({ final: 500 }, { final: () => bFinal });
  const wh = createTokenWatch("mainnet", WITH_VAULT, deps(higher.fetch));
  const s = await wh.statusAt("higher");
  assert.deepEqual([s.caught_up, s.block_height], [true, 500]);
  assert.deepEqual([...new Set(higher.seen.filter((c) => c.method === "query").map((c) => c.params.block_id))], [500]);
  assert.equal(sleeps.length, 3, "B waited for, one final read per poll, until it reached 500");
  // a provider that does not reach H within H_WAIT_MS: held
  const stuck = nearPair({ final: 500 }, { final: 497 });
  t = 0;
  sleeps.length = 0;
  const ws = createTokenWatch("mainnet", WITH_VAULT, { fetch: stuck.fetch, clock: () => t, sleep: async (ms: number) => void (sleeps.push(ms), (t += ms)) });
  assert.equal((await ws.statusAt("higher")).caught_up, false);
  assert.ok(sleeps.reduce((x, y) => x + y, 0) >= H_WAIT_MS && sleeps.reduce((x, y) => x + y, 0) < H_WAIT_MS + 1_000);
  assert.equal(stuck.seen.filter((c) => c.method === "query").length, 0, "no view read short of H");
  assert.equal(await ws.held("higher"), true);
  // two providers naming different blocks at H (one on a fork): held, at one height and at two
  for (const fb of [500, 497]) {
    const forked = createTokenWatch("mainnet", WITH_VAULT, { fetch: nearPair({ final: 500 }, { final: fb, fork: "x" }).fetch });
    assert.equal((await forked.statusAt("lower")).caught_up, false, `fork, B at ${fb}`);
  }
  // finals too far apart: held either way
  const far = createTokenWatch("mainnet", WITH_VAULT, { fetch: nearPair({ final: 500 }, { final: 500 - HEIGHT_SPREAD_MAX - 1 }).fetch });
  assert.equal((await far.statusAt("lower")).caught_up, false);
  assert.equal((await far.statusAt("higher")).caught_up, false);
  assert.equal((await createTokenWatch("mainnet", WITH_VAULT, { fetch: nearPair({ final: 500 }, { final: 500 - HEIGHT_SPREAD_MAX }).fetch }).statusAt("lower")).caught_up, true);
});

test("(r1) PROBE: both providers stuck at 1000 for 60 s: not caught up, held (H's block over FINAL_AGE_MAX_MS behind the wall clock)", async () => {
  const stale = { final: 1000, ms: () => Date.now() - 60_000 };
  const w = createTokenWatch("mainnet", WITH_VAULT, { fetch: nearPair(stale).fetch });
  assert.equal((await w.status()).caught_up, false);
  assert.equal(await w.held("lower"), true);
  assert.equal(await w.held("higher"), true);
  const fresh = createTokenWatch("mainnet", WITH_VAULT, { fetch: nearPair({ final: 1000, ms: () => Date.now() - FINAL_AGE_MAX_MS + 2_000 }).fetch });
  assert.equal((await fresh.status()).caught_up, true);
});

test("(r1) PROBE: the wall clock stepped back 60 s never keeps an old answer: a pause in a newer final block is read at once", async () => {
  let wall = Date.now();
  let tick = 0;
  let final = 500;
  const p = nearPair({ final: () => final, ms: () => wall, balance: (h) => (h >= 501 ? { error: PAUSED } : '"5"') });
  const w = createTokenWatch("mainnet", WITH_VAULT, { fetch: p.fetch, now: () => wall, clock: () => tick });
  assert.equal((await w.status()).halted, false);
  assert.equal(await w.held("lower"), false);
  wall -= 60_000; // the host's clock stepped back
  final = 502; // the chain moved on, paused at 501
  tick += CACHE_MS;
  assert.equal((await w.status()).halted, true, "the display");
  assert.equal(await w.held("lower"), true, "the hold");
});

test("(r1) the status at one H is read once (kept by block); a status not caught up is never kept", async () => {
  let fail = true;
  const p = nearPair({});
  const fetch = async (u: string, init: RequestInit) => (fail && u === B && String(init.body).includes("is_blocklisted") ? new Response("{}", { status: 500 }) : p.fetch(u, init));
  const w = createTokenWatch("mainnet", WITH_VAULT, { fetch });
  assert.equal((await w.statusAt("lower")).caught_up, false);
  fail = false;
  assert.equal((await w.statusAt("lower")).caught_up, true, "read again");
  const n = p.seen.filter((c) => c.method === "query").length;
  assert.equal((await w.statusAt("higher")).caught_up, true);
  assert.equal(p.seen.filter((c) => c.method === "query").length, n, "the same block: kept");
});

test("(r1) statusFrom: both reads of one block (height and hash), and each read's is_blocklisted of the halt's own block, else not caught up", () => {
  const read = (h: number, over: Partial<Read> = {}): Read => ({ block_height: h, block_hash: hashOf(h), halt: { at: h, answer: '"5"' }, blocked: { at: h, answer: "false" }, code_hash: USDC_CODE_HASH, ...over });
  assert.equal(statusFrom(read(10), read(10), USDC).caught_up, true);
  const off: [string, Read, Read][] = [
    ["is_blocklisted of another block", read(10, { blocked: { at: 9, answer: "false" } }), read(10)],
    ["is_blocklisted of another block on B", read(10), read(10, { blocked: { at: 11, answer: "false" } })],
    ["the halt of another block", read(10, { halt: { at: 9, answer: '"5"' } }), read(10)],
    ["two heights", read(10), read(11)],
    ["two hashes at one height", read(10), read(10, { block_hash: hashOf(11) })],
    ["no hash", read(10, { block_hash: undefined }), read(10, { block_hash: undefined })],
  ];
  for (const [what, a, b] of off) assert.equal(statusFrom(a, b, USDC).caught_up, false, what);
});

test("(r1) the exact text: haltOf takes the paused panic with nothing after it; viewOutcome keeps a value's text as sent", () => {
  assert.equal(haltOf({ at: 1, panic: "FiatToken: paused" }), true);
  assert.equal(haltOf({ at: 1, panic: "FiatToken: paused " }), null);
  assert.equal(haltOf({ at: 1, panic: " FiatToken: paused" }), null);
  const o = viewOutcome({ result: { block_height: 7, result: [...Buffer.from(' "5"\n')] } });
  assert.deepEqual(o, { at: 7, answer: ' "5"\n' });
  assert.equal(haltOf(o), null);
});

test("(r1) pausedAt: decided by both providers, the pin on both, and a null never kept", async () => {
  const pausedFrom = (x: number) => (h: number) => (h >= x ? { error: PAUSED } : '"5"');
  const v = { balance: pausedFrom(100) };
  // B fails: not known, though A alone says paused
  for (const what of ["ft_balance_of", "block", "view_account"]) {
    const p = nearPair(v);
    const fetch = async (u: string, init: RequestInit) => (u === B && String(init.body).includes(`"${what}"`) ? new Response("{}", { status: 500 }) : p.fetch(u, init));
    assert.equal(await createTokenWatch("mainnet", WITH_VAULT, { fetch }).pausedAt(100n), null, `B's ${what} fails`);
  }
  // the pin on A only
  assert.equal(await createTokenWatch("mainnet", WITH_VAULT, { fetch: nearPair(v, { ...v, code: () => ({ code_hash: CHANGED }) }).fetch }).pausedAt(100n), null, "another code on B");
  assert.equal(await createTokenWatch("mainnet", WITH_VAULT, { fetch: nearPair({ ...v, code: () => ({ code_hash: CHANGED }) }, v).fetch }).pausedAt(100n), null, "another code on A");
  // null is not kept: B's ft_balance_of down, then back
  let down = true;
  const p = nearPair(v);
  const w = createTokenWatch("mainnet", WITH_VAULT, { fetch: async (u, init) => (down && u === B && String(init.body).includes('"ft_balance_of"') ? new Response("{}", { status: 500 }) : p.fetch(u, init)) });
  assert.equal(await w.pausedAt(100n), null);
  down = false;
  assert.equal(await w.pausedAt(100n), true, "read again once B answers");
});

test("(r1) PROBE: a height NEAR skipped before h: the view before is at h's parent (by hash), not at h-1", async () => {
  // no block at 99; 100's parent is 98, where USDC was paused; unpaused in 100
  const v: Views = { skip: [99], balance: (h) => (h === 98 ? { error: PAUSED } : '"5"') };
  const p = nearPair(v);
  const w = createTokenWatch("mainnet", WITH_VAULT, { fetch: p.fetch });
  assert.equal(await w.pausedAt(100n), true);
  assert.ok(p.seen.some((c) => c.params.block_id === hashOf(98)));
  assert.ok(!p.seen.some((c) => c.params.block_id === 99 || c.params.block_id === hashOf(99)));
});

test("(r1) one 429 is waited out (Retry-After, at most BACKOFF_429_MS) and the read made again; a second 429 holds; the code hash never flips to empty on one", async () => {
  assert.equal(backoffOf(null), BACKOFF_429_MS);
  assert.equal(backoffOf("3"), 3_000);
  assert.equal(backoffOf("120"), BACKOFF_429_MS);
  assert.equal(backoffOf("soon"), BACKOFF_429_MS);
  for (const [limit, retry, want] of [[1, "2", true], [1, null, true], [2, null, false]] as const) {
    const p = nearPair({});
    const waits: number[] = [];
    let n = 0;
    const fetch = async (u: string, init: RequestInit) => (u === A && n++ < limit ? new Response("", { status: 429, headers: retry === null ? {} : { "retry-after": retry } }) : p.fetch(u, init));
    const w = createTokenWatch("mainnet", WITH_VAULT, { fetch, sleep: async (ms) => void waits.push(ms) });
    const s = await w.status();
    assert.equal(s.caught_up, want, `${limit} 429s`);
    assert.equal(s.code_hash, want ? USDC_CODE_HASH : "");
    assert.deepEqual(waits, [retry === null ? BACKOFF_429_MS : 2_000]);
  }
});
