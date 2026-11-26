// node --test apps/helper/src/token-status/keyed-pair.test.ts (card near-pair-on-keyed-providers): every mainnet NEAR
// read the helper makes on two providers that must agree goes to the host's two keyed providers when it has them, the
// keyed FastNear name first and dRPC's key (NEAR_RPC_URL_B) second, and to the free pair only when no key is set. Live 13 Nov: the host
// held NEAR_RPC_URL_FASTNEAR, but the fee quote, the token watch and the carries read readUrls' free pair, and a free
// endpoint's 429 refused a withdraw fee and a NEAR trade. Each path is asked here at its start or first read, its sends
// recorded by URL: none may reach a free endpoint while a key is set.
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bindSenderFromEnv } from "../bind/env.ts";
import { feeQuoterFromEnv } from "../withdraw/fee.ts";
import { MAINNET_VAULT, withdrawSenderFromEnv } from "../withdraw/send.ts";
import { keyReads, type KeyReads } from "../limits/key-reads.ts";
import * as status from "./status.ts";
import { readUrls, tokenWatchesFromEnv, USDC, WATCH_RPCS } from "./status.ts";

// read by name, so the file loads on a base without it and only its own test fails
const pairNames = (env: Record<string, string | undefined>): string[] => (status as unknown as { pairNames: (e: typeof env) => string[] }).pairNames(env);

// keyed URLs in each company's documented form, with made-up keys (no real key is ever in a test)
const FASTNEAR = `https://rpc.mainnet.fastnear.com?apiKey=${"f".repeat(32)}`;
const DRPC = "https://lb.drpc.live/near/dddddddddddddddddddddddddddddddd";
const KEYED = { NEAR_RPC_URL_FASTNEAR: FASTNEAR, NEAR_RPC_URL_B: DRPC };
const FREE = WATCH_RPCS.map((r) => r.fallback);

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(b: Buffer): string {
  let n = BigInt(`0x${b.toString("hex")}`);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    s = `1${s}`;
  }
  return s;
}
const key = (() => {
  const seed = Buffer.alloc(32, 7);
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const pub = Buffer.from(createPublicKey(priv).export({ format: "jwk" }).x as string, "base64url");
  return `ed25519:${base58(Buffer.concat([seed, pub]))}`;
})();

/** A fetch that records every URL it is sent to and answers 400, so each path stops at its first read (card
 *  near-off-the-fastnear-key: a key's 429 or 5xx now sends that read on to the slot's free endpoint, so a stop is an
 *  answer no slot falls over on). */
function recording() {
  const sent: string[] = [];
  const fetch = (async (url: string | URL | Request) => {
    sent.push(String(url));
    return new Response("{}", { status: 400 });
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}
const settle = () => new Promise((ok) => setTimeout(ok, 50));
const hosts = (sent: string[]) => [...new Set(sent)].sort();

test("readUrls: the keyed FastNear name first and dRPC's key second; NEAR_RPC_URL, then each free endpoint, only when no key is set", () => {
  assert.deepEqual(readUrls(KEYED, "mainnet"), [FASTNEAR, DRPC]);
  assert.deepEqual(readUrls({ NEAR_RPC_URL_FASTNEAR: FASTNEAR }, "mainnet"), [FASTNEAR, FREE[1]], "one key: the other slot keeps its free endpoint");
  assert.deepEqual(readUrls({ ...KEYED, NEAR_RPC_URL: "https://a.example" }, "mainnet"), [FASTNEAR, DRPC], "FastNear's key wins over NEAR_RPC_URL");
  assert.deepEqual(readUrls({ NEAR_RPC_URL: "https://a.example", NEAR_RPC_URL_B: "https://b.example" }, "mainnet"), ["https://a.example", "https://b.example"]);
  assert.deepEqual(readUrls({}, "mainnet"), FREE, "no key: the free pair");
  assert.deepEqual(readUrls(KEYED, "testnet"), ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"], "testnet's pair reads no mainnet key");
});

test("readUrls: two slots of one company are refused at start, naming the variables, never a value", () => {
  for (const env of [
    { NEAR_RPC_URL_FASTNEAR: FASTNEAR, NEAR_RPC_URL_B: "https://free.rpc.fastnear.com" },
    { NEAR_RPC_URL_FASTNEAR: "https://lb.drpc.live/near/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", NEAR_RPC_URL_B: DRPC },
    { NEAR_RPC_URL: "https://near.drpc.org", NEAR_RPC_URL_B: DRPC },
  ]) {
    assert.throws(
      () => readUrls(env, "mainnet"),
      (e: Error) => /two different companies/.test(e.message) && Object.values(env).every((v) => !e.message.includes(v)),
      JSON.stringify(Object.keys(env)),
    );
  }
  assert.throws(() => readUrls({ NEAR_RPC_URL_FASTNEAR: "ftp://x.example" }, "mainnet"), (e: Error) => e.message.startsWith("NEAR_RPC_URL_FASTNEAR must be") && !e.message.includes("x.example"));
});

test("pairNames: each slot as /v1/health names it, a company and its key, a free endpoint keyless, never a URL or a key", () => {
  assert.deepEqual(pairNames(KEYED), ["fastnear.com", "drpc.live"]);
  assert.deepEqual(pairNames({}), ["fastnear.com keyless", "drpc.org keyless"]);
  assert.deepEqual(pairNames({ NEAR_RPC_URL_FASTNEAR: FASTNEAR }), ["fastnear.com", "drpc.org keyless"]);
  assert.ok(!JSON.stringify(pairNames(KEYED)).includes("f".repeat(16)));
});

test("the fee quoter's block reads go to the two keyed providers, never a free endpoint (red at e831870c0: the free rpc.mainnet.fastnear.com, FastNear's key unread)", async () => {
  const r = recording();
  const q = feeQuoterFromEnv({ ...KEYED, WITHDRAW_RELAYER_MAINNET: "relay.test.near", WITHDRAW_FEE_RECIPIENT_MAINNET: "relay.test.near" }, r.fetch);
  await q.quote(USDC).catch(() => undefined);
  assert.ok(r.sent.length >= 2, "the quote sent its block reads");
  assert.deepEqual(hosts(r.sent), [DRPC, FASTNEAR].sort());
});

test("the token watch reads the two keyed providers", async () => {
  const r = recording();
  const w = tokenWatchesFromEnv(KEYED, { fetch: r.fetch, store: null });
  await w.mainnet.status().catch(() => undefined);
  assert.ok(r.sent.length >= 2);
  assert.deepEqual(hosts(r.sent), [DRPC, FASTNEAR].sort());
});

test("the withdrawal carry's start reads the two keyed providers", async () => {
  const r = recording();
  const quoter = { networkOf: () => null, quote: async () => { throw new Error("no"); }, reads: () => ({ feeMin: async () => 0n }) };
  const env = { ...KEYED, WITHDRAW_VAULT_MAINNET: MAINNET_VAULT, WITHDRAW_RELAYER_KEYS_MAINNET: key, WITHDRAW_RELAYER_MAINNET: "relay.test.near", WITHDRAW_FEE_RECIPIENT_MAINNET: "relay.test.near", HELPER_RELEASE: "1", HELPER_STORE_DIR: mkdtempSync(join(tmpdir(), "kpair-w-")) };
  const s = withdrawSenderFromEnv(env, quoter as never, {}, r.fetch);
  s.warm();
  await settle();
  s.stop();
  assert.ok(r.sent.length >= 2);
  assert.deepEqual(hosts(r.sent), [DRPC, FASTNEAR].sort());
});

test("the deposit carry's start (its send, trade and delivery reads, and the intents reads) reads the two keyed providers", async () => {
  const r = recording();
  const env = { ...KEYED, BIND_VAULT_MAINNET: MAINNET_VAULT, BIND_RELAYER_MAINNET: "bind.test.near", BIND_RELAYER_KEY_MAINNET: key, BIND_MARGIN_K: "20", HELPER_RELEASE: "1", HELPER_STORE_DIR: mkdtempSync(join(tmpdir(), "kpair-b-")) };
  const s = bindSenderFromEnv(env, {}, r.fetch);
  s.warm();
  await settle();
  s.stop();
  assert.ok(r.sent.length >= 2);
  assert.deepEqual(hosts(r.sent), [DRPC, FASTNEAR].sort());
});

// ---- card near-pair-falls-over-a-refused-key: a dead key never refuses a read or a send ----
// The FastNEAR plan switch of 30 Nov removes the host's key (the owner, 26 Nov 11:19Z). Each company answers a dead key
// so (read 26 Nov 11:3xZ with made-up keys): FastNEAR HTTP 403 "Invalid API key", dRPC HTTP 403 {"error":{"message":
// "Your token is invalid or expired","code":4}}; a 401 is the same refusal.

type PairFetch = (env: Record<string, string | undefined>, fetchFn?: typeof fetch, now?: () => number, log?: (line: string) => void, tryMs?: number, reads?: KeyReads) => typeof fetch;
// read by name, as pairNames above
const pairFetch: PairFetch = (...a) => (status as unknown as { pairFetch: PairFetch }).pairFetch(...a);
const keyRestMs = () => (status as unknown as { KEY_REST_MS: number }).KEY_REST_MS;

/** Both keys dead with `code`; every other URL recorded and answering 503, so each path stops at its first read. */
function deadKeys(code: 401 | 403) {
  const sent: string[] = [];
  const fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    sent.push(u);
    if (u === FASTNEAR) return new Response("Invalid API key", { status: code });
    if (u === DRPC) return new Response(JSON.stringify({ id: 1, jsonrpc: "2.0", error: { message: "Your token is invalid or expired", code: 4 } }), { status: code });
    return new Response("{}", { status: 503 });
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

for (const code of [403, 401] as const) {
  test(`HTTP ${code} on both keys: the fee quoter, the token watch, the withdrawal carry and the deposit carry each go on to the two free endpoints (red before the card: each stopped at the dead keys)`, async () => {
    const paths: [string, (f: typeof fetch) => Promise<void>][] = [
      ["fee quoter", async (f) => void (await feeQuoterFromEnv({ ...KEYED, WITHDRAW_RELAYER_MAINNET: "relay.test.near", WITHDRAW_FEE_RECIPIENT_MAINNET: "relay.test.near" }, f).quote(USDC).catch(() => undefined))],
      ["token watch", async (f) => void (await tokenWatchesFromEnv(KEYED, { fetch: f, store: null }).mainnet.status().catch(() => undefined))],
      [
        "withdrawal carry",
        async (f) => {
          const quoter = { networkOf: () => null, quote: async () => { throw new Error("no"); }, reads: () => ({ feeMin: async () => 0n }) };
          const env = { ...KEYED, WITHDRAW_VAULT_MAINNET: MAINNET_VAULT, WITHDRAW_RELAYER_KEYS_MAINNET: key, WITHDRAW_RELAYER_MAINNET: "relay.test.near", WITHDRAW_FEE_RECIPIENT_MAINNET: "relay.test.near", HELPER_RELEASE: "1", HELPER_STORE_DIR: mkdtempSync(join(tmpdir(), "kdead-w-")) };
          const s = withdrawSenderFromEnv(env, quoter as never, {}, f);
          s.warm();
          await settle();
          s.stop();
        },
      ],
      [
        "deposit carry",
        async (f) => {
          const env = { ...KEYED, BIND_VAULT_MAINNET: MAINNET_VAULT, BIND_RELAYER_MAINNET: "bind.test.near", BIND_RELAYER_KEY_MAINNET: key, BIND_MARGIN_K: "20", HELPER_RELEASE: "1", HELPER_STORE_DIR: mkdtempSync(join(tmpdir(), "kdead-b-")) };
          const s = bindSenderFromEnv(env, {}, f);
          s.warm();
          await settle();
          s.stop();
        },
      ],
    ];
    for (const [name, run] of paths) {
      const r = deadKeys(code);
      await run(r.fetch);
      assert.deepEqual(hosts(r.sent), [DRPC, FASTNEAR, ...FREE].sort(), `${name}: ${hosts(r.sent).join(", ")}`);
    }
  });
}

test("pairFetch: a refused key rests KEY_REST_MS (its reads go to the slot's free endpoint, the same request first), then is asked again; one line per rest names the variable, never a URL or a key", async () => {
  let t = 1_000;
  const lines: string[] = [];
  const asked: string[] = [];
  let dead = true;
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    asked.push(`${String(url)} ${String(init?.body)}`);
    if (String(url) === FASTNEAR && dead) return new Response("Invalid API key", { status: 403 });
    return new Response('{"result":1}', { status: 200 });
  }) as typeof globalThis.fetch;
  const f = pairFetch(KEYED, fetchFn, () => t, (l) => lines.push(l));
  const r1 = await f(FASTNEAR, { method: "POST", body: "one" });
  assert.equal(r1.status, 200);
  assert.deepEqual(asked.splice(0), [`${FASTNEAR} one`, `${FREE[0]} one`], "the refused request is sent once more, to the slot's own free endpoint");
  t += keyRestMs() - 1;
  await f(FASTNEAR, { method: "POST", body: "two" });
  assert.deepEqual(asked.splice(0), [`${FREE[0]} two`], "inside the rest: the free endpoint only");
  t += 1;
  dead = false;
  await f(FASTNEAR, { method: "POST", body: "three" });
  assert.deepEqual(asked.splice(0), [`${FASTNEAR} three`], "past the rest: the key again, kept while it answers");
  await f(DRPC, { method: "POST", body: "four" });
  assert.deepEqual(asked.splice(0), [`${DRPC} four`], "a key that answers is never passed over");
  await f("https://other.example", { method: "POST", body: "five" });
  assert.deepEqual(asked.splice(0), ["https://other.example five"], "a URL of no slot goes as it is");
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0]!, /NEAR_RPC_URL_FASTNEAR/);
  assert.ok(!lines[0]!.includes("apiKey") && !lines[0]!.includes("f".repeat(8)) && !lines[0]!.includes("https://"), lines[0]);
});

test("pairFetch: a slot whose free endpoint is the other slot's company keeps its own URL, so the pair never reads one company twice", async () => {
  // the two keys set in each other's slot: slot one's free endpoint (FastNear's) is slot two's company and slot two's
  // (dRPC's near.drpc.org, one company with lb.drpc.live) is slot one's, so neither slot falls over and each refusal
  // comes back as it is
  const env = { NEAR_RPC_URL: DRPC, NEAR_RPC_URL_B: FASTNEAR };
  const asked: string[] = [];
  const fetchFn = (async (url: string | URL | Request) => {
    asked.push(String(url));
    return new Response("Invalid API key", { status: 403 });
  }) as typeof globalThis.fetch;
  const lines: string[] = [];
  const f = pairFetch(env, fetchFn, () => 0, (l) => lines.push(l));
  assert.equal((await f(DRPC, { method: "POST", body: "x" })).status, 403);
  assert.equal((await f(FASTNEAR, { method: "POST", body: "x" })).status, 403);
  assert.deepEqual(asked, [DRPC, FASTNEAR], "no free endpoint asked: each is the other slot's company");
  assert.deepEqual(lines, []);
});

// card near-off-the-fastnear-key: the key is never the only path, and every request to it is counted and bounded
/** FastNEAR's key answering `answer` (a status, a thrown error, or never until aborted); every other URL 200. */
function keyAnswers(answer: number | "throw" | "hang") {
  const asked: string[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    asked.push(`${String(url)} ${String(init?.body)}`);
    if (String(url) !== FASTNEAR) return new Response('{"result":1}', { status: 200 });
    if (answer === "throw") throw new TypeError("fetch failed");
    if (answer === "hang") {
      const signal = init?.signal;
      return new Promise<Response>((_, no) => {
        if (signal?.aborted) return no(signal.reason);
        signal?.addEventListener("abort", () => no(signal.reason), { once: true });
      });
    }
    return new Response("busy", { status: answer });
  }) as typeof globalThis.fetch;
  return { asked, fetchFn };
}
const READ = JSON.stringify({ jsonrpc: "2.0", id: "1", method: "query", params: {} });

for (const answer of [429, 500, 502, 503, "throw"] as const) {
  test(`card near-off-the-fastnear-key: the key answering ${answer === "throw" ? "no connection" : `HTTP ${answer}`}: that request goes to the slot's free endpoint, the next asks the key again (no rest); one line a minute names the variable, never a URL or a key`, async () => {
    let t = 0;
    const lines: string[] = [];
    const { asked, fetchFn } = keyAnswers(answer);
    const f = pairFetch(KEYED, fetchFn, () => t, (l) => lines.push(l), 1_000, keyReads(() => 0));
    assert.equal((await f(FASTNEAR, { method: "POST", body: READ })).status, 200);
    assert.deepEqual(asked.splice(0), [`${FASTNEAR} ${READ}`, `${FREE[0]} ${READ}`]);
    t += 1_000;
    await f(FASTNEAR, { method: "POST", body: READ });
    assert.deepEqual(asked.splice(0), [`${FASTNEAR} ${READ}`, `${FREE[0]} ${READ}`], "the key asked again: a busy answer is no rest");
    assert.equal(lines.length, 1, lines.join("\n"));
    assert.match(lines[0]!, /NEAR_RPC_URL_FASTNEAR/);
    assert.ok(!lines[0]!.includes("f".repeat(8)) && !lines[0]!.includes("https://"), lines[0]);
  });
}

// the hang bound is the test's own timeout (scripts/ci/no-wall-clock-asserts.mjs): a key that is never cut hangs past it
test("card near-off-the-fastnear-key: a read the key has not started answering within the try bound goes to the free endpoint; a send is held to the caller's own deadline, never cut", { timeout: 10_000 }, async () => {
  const { asked, fetchFn } = keyAnswers("hang");
  const f = pairFetch(KEYED, fetchFn, () => 0, () => undefined, 30, keyReads(() => 0));
  assert.equal((await f(FASTNEAR, { method: "POST", body: READ })).status, 200, "answered from the free endpoint past the bound");
  assert.deepEqual(asked.splice(0), [`${FASTNEAR} ${READ}`, `${FREE[0]} ${READ}`]);
  const SEND = JSON.stringify({ jsonrpc: "2.0", id: "1", method: "send_tx", params: { signed_tx_base64: "AAAA", wait_until: "EXECUTED" } });
  const caller = new AbortController();
  const sent = f(FASTNEAR, { method: "POST", body: SEND, signal: caller.signal });
  await new Promise((go) => setTimeout(go, 120));
  assert.deepEqual(asked.splice(0), [`${FASTNEAR} ${SEND}`], "past 4 bounds the send still waits on the key alone");
  caller.abort(new Error("the caller's deadline"));
  await assert.rejects(sent, /the caller's deadline/);
  assert.deepEqual(asked, [], "the caller's own deadline ends it: nothing is asked of the free endpoint");
});

test("card near-off-the-fastnear-key: every request sent to the key counts in the helper bucket, a request to the free endpoint does not; past the day's ceiling the key is not asked until the next UTC day", async () => {
  let wall = Date.UTC(2026, 10, 26, 23, 59);
  const reads = keyReads(() => wall, 3);
  const { asked, fetchFn } = keyAnswers(200);
  const lines: string[] = [];
  const f = pairFetch(KEYED, fetchFn, () => 0, (l) => lines.push(l), 1_000, reads);
  for (let i = 0; i < 3; i++) await f(FASTNEAR, { method: "POST", body: READ });
  await f(DRPC, { method: "POST", body: READ });
  assert.equal(asked.splice(0).filter((a) => a.startsWith(FASTNEAR)).length, 3);
  assert.match(reads.header(), /^2026-11-26 helper=3 seat=0 of 3 hit/);
  await f(FASTNEAR, { method: "POST", body: READ });
  assert.deepEqual(asked.splice(0), [`${FREE[0]} ${READ}`], "past the ceiling: the free endpoint first, the key never asked");
  assert.match(lines.join("\n"), /NEAR_RPC_URL_FASTNEAR is past its day's ceiling \(NEAR_KEY_DAY\)/);
  wall += 60_000;
  await f(FASTNEAR, { method: "POST", body: READ });
  assert.deepEqual(asked.splice(0), [`${FASTNEAR} ${READ}`], "the next UTC day: the key again");
});
