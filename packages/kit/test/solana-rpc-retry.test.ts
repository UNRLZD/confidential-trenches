// The kit's JSON-RPC client with `retry` (card signpage-rpc-throttle-retry): each transport fault form is tried again
// within the call's bounds and the call lands; a fault that outlasts them rejects as a SolanaRpcTransportError naming
// it; anything else rejects at once; without `retry` the client is one attempt, as before.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { SOLANA_POOL_QUOTE_MAX_AGE_SLOTS } from "../src/trade/solana/pool-buy.ts";
import { SOLANA_RPC_RETRY, SolanaRpcTransportError, solanaJsonRpc, type SolanaRpcRetry } from "../src/trade/solana/send.ts";

type Answer = { status?: number; body?: string; headers?: Record<string, string>; stall?: boolean; reject?: boolean };
const ok = (id: string): Answer => ({ body: JSON.stringify({ jsonrpc: "2.0", id, result: 7 }) });

/** A provider that answers `faults` in turn, then the call's result; it counts the attempts. */
function provider(faults: Answer[]) {
  let n = 0;
  const fetch = (_u: string, init: RequestInit): Promise<Response> => {
    const id = (JSON.parse(String(init.body)) as { id: string }).id;
    const a = n < faults.length ? faults[n]! : ok(id);
    n++;
    if (a.reject) return Promise.reject(new TypeError("fetch failed"));
    if (a.stall)
      return new Promise((_, rej) => {
        const s = init.signal!;
        s.addEventListener("abort", () => rej(s.reason), { once: true });
      });
    const body = (a.body ?? "").replaceAll("$ID", id);
    return Promise.resolve(new Response(body, { status: a.status ?? 200, headers: a.headers ?? {} }));
  };
  return { fetch, tries: () => n };
}

const FAST: SolanaRpcRetry = { deadlineMs: 1_500, backoffMs: 10 };
/** Runs the call on mocked time (setTimeout and Date): the event loop is flushed, then the clock moved `step` ms at a
 * time until the call settles or `maxMs` passes. Returns what it settled to and the mocked ms that took, so a wait is
 * judged by the time the code asked for, never by how fast this machine ran. */
async function onMockedTime(t: TestContext, call: () => Promise<unknown>, step: number, maxMs: number) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_700_000_000_000 });
  const out: { settled: boolean; value?: unknown; ms: number } = { settled: false, ms: 0 };
  void call().then(
    (v) => Object.assign(out, { settled: true, value: v }),
    (e: unknown) => Object.assign(out, { settled: true, value: e }),
  );
  const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  await flush();
  while (!out.settled && out.ms < maxMs) {
    t.mock.timers.tick(step);
    out.ms += step;
    await flush();
  }
  return out;
}
const rpcError = (code: number) => ({ body: JSON.stringify({ jsonrpc: "2.0", id: "$ID", error: { code, message: "too many requests" } }) });

const FORMS: [string, Answer][] = [
  ["HTTP 429", { status: 429, body: "Too Many Requests" }],
  ["HTTP 429 with Retry-After 0", { status: 429, body: "", headers: { "retry-after": "0" } }],
  ["HTTP 502", { status: 502, body: "<html>bad gateway</html>" }],
  ["HTTP 503", { status: 503, body: "" }],
  ["-32029 in a 200", rpcError(-32029)],
  ["-32429 in a 200", rpcError(-32429)],
  // -429 and dRPC's code 15, as recorded in scripts/live-checks/vault-testnet-t02.mjs (dRPC's real answer: "You reached
  // Public endpoint rate limit, please upgrade to paid plan", code 15) and scripts/ci/money-gate.mjs (code -429)
  ["-429 in a 200", rpcError(-429)],
  ["dRPC's code 15 in a 200", { body: JSON.stringify({ id: "$ID", jsonrpc: "2.0", error: { message: "You reached Public endpoint rate limit, please upgrade to paid plan", code: 15 } }) }],
  ["dRPC's code 15 in its HTTP 429", { status: 429, body: JSON.stringify({ id: "$ID", jsonrpc: "2.0", error: { message: "You reached Public endpoint rate limit, please upgrade to paid plan", code: 15 } }) }],
  ["a 200 that is not JSON", { body: "<html>rate limited</html>" }],
  ["no connection", { reject: true }],
];

for (const [name, fault] of FORMS) {
  test(`with retry, ${name} once and then the result: the call lands`, async () => {
    const p = provider([fault]);
    const got = await solanaJsonRpc("https://rpc.example", { fetch: p.fetch, retry: FAST })("getSlot", []);
    assert.equal(got, 7);
    assert.equal(p.tries(), 2);
  });
}

test("with retry, a fault that outlasts the deadline rejects as a SolanaRpcTransportError naming the fault, never a bare failure", async (t) => {
  const p = provider(Array.from({ length: 1000 }, () => rpcError(-32429)));
  const { value: e, ms } = await onMockedTime(t, () => solanaJsonRpc("https://rpc.example", { fetch: p.fetch, retry: FAST })("getSlot", []), 10, 60_000);
  assert.ok(e instanceof SolanaRpcTransportError, String(e));
  assert.equal(e.fault, "rpc_throttled");
  assert.equal(e.host, "rpc.example");
  assert.ok(e.tries >= 3, `tries ${e.tries}`);
  assert.match(e.message, /RPC error -32429.*rpc_throttled.*rpc\.example/);
  assert.ok(ms <= FAST.deadlineMs, `answered after ${ms} ms of waits, past the ${FAST.deadlineMs} ms deadline`);
});

test("with retry, Retry-After is honoured: a 429 naming 1 s is tried again only after it", async (t) => {
  const p = provider([{ status: 429, body: "", headers: { "retry-after": "1" } }]);
  const got = await onMockedTime(t, () => solanaJsonRpc("https://rpc.example", { fetch: p.fetch, retry: SOLANA_RPC_RETRY })("getSlot", []), 1, 5_000);
  assert.equal(got.value, 7);
  assert.equal(got.ms, 1_000, `tried again after ${got.ms} ms`);
});

test("with retry, a Retry-After that ends past the deadline is not waited: the call answers at once, the 429 named", async (t) => {
  const p = provider([{ status: 429, body: "", headers: { "retry-after": "30" } }]);
  const { value: e, ms } = await onMockedTime(t, () => solanaJsonRpc("https://rpc.example", { fetch: p.fetch, retry: SOLANA_RPC_RETRY })("getSlot", []), 100, 60_000);
  assert.ok(e instanceof SolanaRpcTransportError, String(e));
  assert.equal(e.fault, "http_429");
  assert.equal(e.afterMs, 30_000, "the provider's Retry-After goes with the fault, for the caller's next ask");
  assert.equal(p.tries(), 1);
  assert.equal(ms, 0, `answered after ${ms} ms of waits`);
});

test("with retry, a stall forever stops at the deadline, named a timeout", async () => {
  const p = provider(Array.from({ length: 1000 }, () => ({ stall: true })));
  const e = await solanaJsonRpc("https://rpc.example", { fetch: p.fetch, retry: FAST })("getSlot", []).catch((x: unknown) => x);
  assert.ok(e instanceof SolanaRpcTransportError);
  assert.equal(e.fault, "timeout");
  // the try's own limit is what the deadline left, never the call's SOLANA_CALL_TIMEOUT_MS: the fault names it
  const limit = Number(/no answer in (\d+) ms/.exec(e.message)?.[1]);
  assert.ok(limit > 0 && limit <= FAST.deadlineMs, e.message);
});

test("the quote's age: the page's retry stops two calls (the venue, then the blockhash and its slot) inside 25 slots", () => {
  // a pool buy's reads after the reference: the venue (both RPCs at once) and the blockhash, whose slot is the device's
  // own; each call ends within its deadline, waits included, so the two together end inside the rule's window at a
  // 360 ms slot (the cluster's target is 400 ms)
  assert.ok(2 * SOLANA_RPC_RETRY.deadlineMs < SOLANA_POOL_QUOTE_MAX_AGE_SLOTS * 360);
});

test("with retry, a forever-throttled read ends inside the quote's window, measured", async () => {
  const p = provider(Array.from({ length: 1000 }, () => ({ status: 429, body: "", headers: { "retry-after": "1" } })));
  const t0 = Date.now();
  const e = await solanaJsonRpc("https://rpc.example", { fetch: p.fetch, retry: SOLANA_RPC_RETRY })("getLatestBlockhash", []).catch((x: unknown) => x);
  const took = Date.now() - t0;
  assert.ok(e instanceof SolanaRpcTransportError);
  assert.ok(took <= SOLANA_RPC_RETRY.deadlineMs, `took ${took} ms`);
  assert.ok(2 * took < SOLANA_POOL_QUOTE_MAX_AGE_SLOTS * 360);
});

test("with retry, anything that is not a transport fault rejects at once: an RPC error, a 4xx, a foreign id", async () => {
  for (const a of [
    rpcError(-32602),
    { status: 403, body: "forbidden" },
    { body: JSON.stringify({ jsonrpc: "2.0", id: "x", result: 1 }) },
  ] as Answer[]) {
    const p = provider([a]);
    const e = await solanaJsonRpc("https://rpc.example", { fetch: p.fetch, retry: FAST })("getSlot", []).catch((x: unknown) => x);
    assert.ok(e instanceof Error && !(e instanceof SolanaRpcTransportError), String(e));
    assert.equal(p.tries(), 1);
  }
});

test("without retry, one attempt: a 429 rejects as HTTP 429, as before", async () => {
  const p = provider([{ status: 429, body: "" }]);
  await assert.rejects(solanaJsonRpc("https://rpc.example", { fetch: p.fetch })("getSlot", []), (e: Error) => e.message === "HTTP 429" && !(e instanceof SolanaRpcTransportError));
  assert.equal(p.tries(), 1);
});

test("without retry, every fault rejects as the client did before the option: one attempt, the same error", async () => {
  const boom = new TypeError("fetch failed");
  const cases: [Answer | "reject", (e: unknown) => boolean][] = [
    [{ status: 502, body: "" }, (e) => e instanceof Error && e.message === "HTTP 502"],
    [rpcError(-32429), (e) => e instanceof Error && e.message === "RPC error -32429: too many requests"],
    [{ body: "<html>" }, (e) => e instanceof SyntaxError],
    ["reject", (e) => e === boom],
  ];
  for (const [a, is] of cases) {
    let n = 0;
    const fetch = (_u: string, init: RequestInit): Promise<Response> => {
      n++;
      if (a === "reject") return Promise.reject(boom);
      const id = (JSON.parse(String(init.body)) as { id: string }).id;
      return Promise.resolve(new Response((a.body ?? "").replaceAll("$ID", id), { status: a.status ?? 200 }));
    };
    const e = await solanaJsonRpc("https://rpc.example", { fetch })("getSlot", []).catch((x: unknown) => x);
    assert.ok(is(e), String(e));
    assert.equal(n, 1);
  }
});

test("a refusal whose body is a JSON-RPC error keeps its words after the status: dRPC's range cap is told from any other 400", async () => {
  const drpc = { status: 400, body: JSON.stringify({ id: 1, jsonrpc: "2.0", error: { message: "ranges over 10000 blocks are not supported on free plan", code: 35 } }) };
  for (const retry of [undefined, FAST]) {
    const p = provider([drpc]);
    const e = await solanaJsonRpc("https://rpc.example", { fetch: p.fetch, ...(retry ? { retry } : {}) })("eth_getLogs", []).catch((x: unknown) => x);
    assert.ok(e instanceof Error && !(e instanceof SolanaRpcTransportError));
    assert.equal(e.message, "HTTP 400: RPC error 35: ranges over 10000 blocks are not supported on free plan");
    assert.equal(p.tries(), 1, "a 400 is never tried again");
  }
  const bare = provider([{ status: 400, body: "<html>bad request</html>" }]);
  await assert.rejects(solanaJsonRpc("https://rpc.example", { fetch: bare.fetch })("eth_getLogs", []), (e: Error) => e.message === "HTTP 400");
});

test("with retry, a slow answer inside the deadline lands: an answer at 2.5 s, which the client without retry takes, resolves", async () => {
  const slow = (_u: string, i: RequestInit): Promise<Response> =>
    new Promise((res, rej) => {
      const id = (JSON.parse(String(i.body)) as { id: string }).id;
      const t = setTimeout(() => res(new Response(JSON.stringify({ jsonrpc: "2.0", id, result: 7 }), { status: 200 })), 2_500);
      i.signal?.addEventListener("abort", () => (clearTimeout(t), rej(i.signal!.reason)), { once: true });
    });
  assert.equal(await solanaJsonRpc("https://rpc.example", { fetch: slow })("getSlot", []), 7);
  assert.equal(await solanaJsonRpc("https://rpc.example", { fetch: slow, retry: SOLANA_RPC_RETRY })("getSlot", []), 7);
});

test("with retry, Retry-After 0 is never a burst: the backoff is its floor (at most 5 requests in one call)", async () => {
  const p = provider(Array.from({ length: 1000 }, () => ({ status: 429, body: "", headers: { "retry-after": "0" } })));
  const e = await solanaJsonRpc("https://rpc.example", { fetch: p.fetch, retry: SOLANA_RPC_RETRY })("getSlot", []).catch((x: unknown) => x);
  assert.ok(e instanceof SolanaRpcTransportError);
  assert.ok(p.tries() <= 5, `${p.tries()} requests`);
});

test("review of 39a4c67a, P3-4: an RPC error keeps its data's words after its message, so a range cap named there is read (Tenderly's, recorded)", async () => {
  // base.gateway.tenderly.co, eth_getLogs over 2,001 blocks, 2026-11-09 19:43Z
  const DATA = "Block range too large: maximum 1000 blocks without an access key. Try [0x33cf5a7, 0x33cf98f], or use an access key for larger ranges.";
  const tenderly = { body: JSON.stringify({ id: "$ID", jsonrpc: "2.0", error: { code: -32602, message: "invalid params", data: DATA } }) };
  for (const retry of [undefined, FAST]) {
    const e = await solanaJsonRpc("https://rpc.example", { fetch: provider([tenderly]).fetch, ...(retry ? { retry } : {}) })("eth_getLogs", []).catch((x: unknown) => x);
    assert.ok(e instanceof Error);
    assert.equal(e.message, `RPC error -32602: invalid params: ${DATA}`);
  }
  // the same in a refusal's body after its status; data that is not text adds nothing
  const as400 = { status: 400, body: tenderly.body.replace('"$ID"', "1") };
  assert.equal(((await solanaJsonRpc("https://rpc.example", { fetch: provider([as400]).fetch })("eth_getLogs", []).catch((x: unknown) => x)) as Error).message, `HTTP 400: RPC error -32602: invalid params: ${DATA}`);
  const objData = { body: JSON.stringify({ id: "$ID", jsonrpc: "2.0", error: { code: -32602, message: "invalid params", data: { x: 1 } } }) };
  assert.equal(((await solanaJsonRpc("https://rpc.example", { fetch: provider([objData]).fetch })("eth_getLogs", []).catch((x: unknown) => x)) as Error).message, "RPC error -32602: invalid params");
});
