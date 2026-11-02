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
import { CACHE_MS, createTokenWatch, readUrls, statusesOf, statusFrom, TESTNET_RPCS, TESTNET_TOKEN, tokenHeld, tokenWatchesFromEnv, USDC, USDC_CODE_HASH, WATCH_RPCS, type TokenStatus } from "./status.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const A = "https://a.example";
const B = "https://b.example";
const CHANGED = "GT71B8i42Z2xegTKpA6TUJQYghRqZfyJUNJG6rKf21DT"; // another real code hash (the vault's testnet build)
const view = (code_hash: string, block_height = 222_531_448) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { amount: "0", code_hash, block_height, block_hash: "x", storage_usage: 1 } }), { status: 200, headers: { "content-type": "application/json" } });

/** Two fake providers: `answers[url]` answers each call; every call is recorded. */
function providers(answers: Record<string, () => Response | Promise<Response>>) {
  const seen: { url: string; body: unknown }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    seen.push({ url, body: JSON.parse(String(init.body)) });
    return answers[url]!();
  };
  return { seen, fetch };
}
const ENV = { NEAR_RPC_URL: A, NEAR_RPC_URL_B: B };

test("the pin is the vault's USDC and its code hash as the repo pins them; the answer has the kit's fields", () => {
  assert.match(readFileSync(path.join(ROOT, "contracts/vault/src/constants.rs"), "utf8"), new RegExp(`pub const TOKEN: &str = "${USDC}";`));
  assert.equal(JSON.parse(readFileSync(path.join(ROOT, "contracts/vault/deployments/testnet-usdc.json"), "utf8")).code_hash, USDC_CODE_HASH);
  const s: HelperTokenStatusAnswer = statusFrom(undefined, undefined, USDC); // the kit's type: tsc checks the shape
  assert.deepEqual(Object.keys(s), ["token", "caught_up", "halted", "vault_blocked", "code_hash_ok", "code_hash", "block_height", "last_event"]);
});

test("both providers agree on the pin: the code hash at the lower height, and still held (no event watch: not caught up)", async () => {
  const p = providers({ [A]: () => view(USDC_CODE_HASH, 100), [B]: () => view(USDC_CODE_HASH, 98) });
  const w = createTokenWatch("mainnet", ENV, { fetch: p.fetch });
  const s = await w.status();
  assert.deepEqual(s, { token: USDC, caught_up: false, halted: null, vault_blocked: null, code_hash_ok: null, code_hash: USDC_CODE_HASH, block_height: 98, last_event: null });
  assert.equal(await w.held(), true);
  assert.deepEqual(p.seen.map((c) => c.url).sort(), [A, B]);
  for (const c of p.seen) assert.deepEqual(c.body, { jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: USDC } });
});

test("the safe answer when the providers disagree or either fails: no code hash, held", async () => {
  const bad: [string, () => Response | Promise<Response>][] = [
    ["a changed hash on one", () => view(CHANGED)],
    ["a 500", () => new Response("{}", { status: 500 })],
    ["an RPC error", () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000 } }), { status: 200 })],
    ["not JSON", () => new Response("<html>", { status: 200 })],
    ["a hash of the wrong shape", () => view("0x" + "a".repeat(64))],
    ["a height of the wrong shape", () => view(USDC_CODE_HASH, -1)],
    ["no answer", () => Promise.reject(new Error("down"))],
    ["an answer too large", () => new Response(JSON.stringify({ result: { code_hash: USDC_CODE_HASH, block_height: 1, pad: "x".repeat(5000) } }), { status: 200 })],
  ];
  for (const [name, answer] of bad) {
    for (const order of [[answer, () => view(USDC_CODE_HASH)], [() => view(USDC_CODE_HASH), answer]] as const) {
      const w = createTokenWatch("mainnet", ENV, { fetch: providers({ [A]: order[0], [B]: order[1] }).fetch });
      const s = await w.status();
      assert.equal(s.code_hash, "", name);
      assert.equal(s.block_height, 0, name);
      assert.equal(await w.held(), true, name);
    }
  }
  // both changed the same way: shown as read, and held (not the pin)
  const both = createTokenWatch("mainnet", ENV, { fetch: providers({ [A]: () => view(CHANGED), [B]: () => view(CHANGED) }).fetch });
  assert.equal((await both.status()).code_hash, CHANGED);
  assert.equal(await both.held(), true);
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

test("one pair of reads per CACHE_MS however many callers ask", async () => {
  let t = 1_800_000_000_000;
  const p = providers({ [A]: () => view(USDC_CODE_HASH), [B]: () => view(USDC_CODE_HASH) });
  const w = createTokenWatch("mainnet", ENV, { fetch: p.fetch, now: () => t });
  await Promise.all([w.status(), w.status(), w.held()]);
  await w.status();
  assert.equal(p.seen.length, 2);
  t += CACHE_MS;
  await w.status();
  assert.equal(p.seen.length, 4);
});

test("providers: two different http(s) URLs from the environment, else two public ones; errors name the variable only", () => {
  assert.deepEqual(readUrls({}, "mainnet"), WATCH_RPCS.map((r) => r.fallback));
  assert.notEqual(new URL(WATCH_RPCS[0].fallback).host, new URL(WATCH_RPCS[1].fallback).host);
  assert.throws(() => readUrls({ NEAR_RPC_URL: B, NEAR_RPC_URL_B: B }, "mainnet"), /two different providers/);
  for (const bad of ["nope", "ftp://x.example", "https://x.example/#f"]) assert.throws(() => readUrls({ NEAR_RPC_URL_B: bad }, "mainnet"), (e: Error) => e.message.startsWith("NEAR_RPC_URL_B must be") && !e.message.includes(bad));
});

test("GET /v1/token-status on the server: the release's USDC answered in the kit's shape; any other token 404 token_not_watched", async () => {
  const w = createTokenWatch("mainnet", ENV, { fetch: providers({ [A]: () => view(USDC_CODE_HASH, 7), [B]: () => view(USDC_CODE_HASH, 7) }).fetch });
  const t = createTokenWatch("testnet", { NEAR_TESTNET_RPC_URL: A, NEAR_TESTNET_RPC_URL_B: B }, { fetch: providers({ [A]: () => view(USDC_CODE_HASH, 9), [B]: () => view(USDC_CODE_HASH, 9) }).fetch });
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
  const p = providers({ [A]: () => view(USDC_CODE_HASH, 5), [B]: () => view(USDC_CODE_HASH, 5), [TA]: () => view(CHANGED, 6), [TB]: () => view(CHANGED, 6) });
  const w = tokenWatchesFromEnv(env, { fetch: p.fetch });
  const m = await w.mainnet.status();
  assert.deepEqual(p.seen.map((c) => [c.url, (c.body as { params: { account_id: string } }).params.account_id]).sort(), [[A, USDC], [B, USDC]]);
  const t = await w.testnet.status();
  assert.deepEqual(p.seen.slice(2).map((c) => [c.url, (c.body as { params: { account_id: string } }).params.account_id]).sort(), [[TA, TESTNET_TOKEN], [TB, TESTNET_TOKEN]]);
  assert.deepEqual([m.token, m.code_hash, t.token, t.code_hash], [USDC, USDC_CODE_HASH, TESTNET_TOKEN, CHANGED]);
  const s = statusesOf(w);
  assert.equal(s.mainnet, w.mainnet.status);
  assert.equal(s.testnet, w.testnet.status);
  // testnet's pair: the environment, else the release's public pair of two operators; one URL twice is refused
  assert.deepEqual(readUrls({}, "testnet"), TESTNET_RPCS.map((r) => r.fallback));
  assert.notEqual(new URL(TESTNET_RPCS[0].fallback).host, new URL(TESTNET_RPCS[1].fallback).host);
  assert.throws(() => readUrls({ NEAR_TESTNET_RPC_URL: TA, NEAR_TESTNET_RPC_URL_B: TA }, "testnet"), /NEAR_TESTNET_RPC_URL and NEAR_TESTNET_RPC_URL_B must be two different providers/);
  // the testnet token is the deployed one, and it runs USDC's own code
  const dep = JSON.parse(readFileSync(path.join(ROOT, "contracts/vault/deployments/testnet-usdc.json"), "utf8")) as { account_id: string; code_hash: string };
  assert.deepEqual([dep.account_id, dep.code_hash], [TESTNET_TOKEN, USDC_CODE_HASH]);
});
