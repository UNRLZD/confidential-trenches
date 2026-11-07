// node --test apps/helper/src/rpc/slot.test.ts (card helper-solana-failover): a keyed Solana provider that stops serving
// us (401, 403, a spent plan, a 429 past its reset, no answer for 30 s) is the public endpoint's to answer, at once, on
// its own budget; the key is tried again every 5 min and taken back when it answers; each switch is one log line with
// no URL and no key. The holders slot has no public fallback (the public endpoint refuses getTokenLargestAccounts).
import assert from "node:assert/strict";
import { test } from "node:test";
import * as rpcMod from "./rpc.ts";
import { createRpc } from "./rpc.ts";

const KEYED = "https://keyed.test/?api-key=11111111-2222-3333-4444-555555555555";
const PUBLIC = "https://api.mainnet-beta.solana.com";
const JSON_T = "application/json";
const read = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: ["x"] });
const ok = (u: string) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { from: u === PUBLIC ? "public" : "keyed" } }), { status: 200, headers: { "content-type": JSON_T } });
const from = (a: { status: number; body: string }) => (a.status === 200 ? (JSON.parse(a.body).result.from as string) : `${a.status} ${a.body}`);

/** A keyed provider that answers `keyed(n)` (its n-th call) and a public one that answers; every call and log kept. */
function world(keyed: (n: number) => Response | "silent") {
  let t = 1_800_000_000_000;
  const calls: string[] = [];
  const logs: string[] = [];
  let n = 0;
  const fetch = async (u: string) => {
    calls.push(u === PUBLIC ? "public" : u === KEYED ? "keyed" : u);
    if (u === PUBLIC) return ok(u);
    const r = keyed(n++);
    if (r === "silent") {
      t += 10_000; // the read's RPC_TIMEOUT_MS
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }
    return r;
  };
  const r = createRpc({ SOLANA_RPC_URL: KEYED }, { fetch: fetch as never, now: () => t, log: (l) => logs.push(l) });
  const ask = () => r.handle("solana", JSON_T, read, "caller");
  return { r, ask, calls, logs, advance: (ms: number) => (t += ms), state: () => (r as unknown as { slot?: { state(): string } }).slot?.state() };
}
const status = (s: number, body = "Unauthorized", headers: Record<string, string> = {}) => () => new Response(body, { status: s, headers });

for (const [what, answer] of [
  ["401 (a revoked key)", status(401)],
  ["403 (a suspended key)", status(403, "Forbidden")],
  ["429 whose body says the plan is spent", status(429, JSON.stringify({ jsonrpc: "2.0", error: { code: -32429, message: "max usage reached" } }), { "content-type": JSON_T })],
  ["200 with a JSON-RPC error that says the credits are spent", () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Your plan's credits are exhausted" } }), { status: 200, headers: { "content-type": JSON_T } })],
] as const) {
  test(`the RPC slot: a key that answers ${what} is the public endpoint's to answer, from that read on, and says so once in the log`, async () => {
    const w = world(answer);
    assert.equal(from(await w.ask()), "public", "the read the key failed is answered");
    assert.equal(from(await w.ask()), "public");
    assert.deepEqual(w.calls, ["keyed", "public", "public"], "the key is not asked again inside the retry");
    assert.equal(w.state(), "fallback");
    assert.equal(w.logs.filter((l) => l.startsWith("solana rpc fallback")).length, 1, w.logs.join("\n"));
    assert.ok(w.logs.every((l) => !l.includes("keyed.test") && !l.includes("api-key") && !l.includes("1111")), "no URL and no key in the log");
  });
}

test("the RPC slot: no answer for 30 s (timeouts) falls back; each timed-out read is answered by the public endpoint meanwhile", async () => {
  const w = world(() => "silent");
  for (let i = 0; i < 3; i++) assert.equal(from(await w.ask()), "public", `read ${i}`);
  assert.equal(w.state(), "fallback", "three 10 s timeouts: 30 s with no answer");
  assert.deepEqual(w.calls, ["keyed", "public", "keyed", "public", "keyed", "public"]);
  assert.equal(from(await w.ask()), "public");
  assert.equal(w.calls.at(-2), "public", "fallen back: the key is not asked");
});

test("the RPC slot: a 429 is waited out once (its reset held, as before); a 429 again past that reset falls back", async () => {
  const w = world((n) => (n === 0 ? new Response("slow", { status: 429, headers: { "retry-after": "5" } }) : n === 1 ? new Response("slow", { status: 429, headers: { "retry-after": "5" } }) : ok(KEYED)));
  const first = await w.ask();
  assert.equal(first.status, 429, "the first 429 is a wait, as before");
  w.advance(5_000);
  assert.equal(from(await w.ask()), "public", "a 429 again past its reset: the public endpoint answers");
  assert.equal(w.state(), "fallback");
});

test("the RPC slot: the key is tried again every 5 min; an answer takes it back (logged), a failure keeps the fallback 5 min more", async () => {
  let dead = true;
  const w = world(() => (dead ? new Response("Unauthorized", { status: 401 }) : ok(KEYED)));
  assert.equal(from(await w.ask()), "public");
  w.advance(299_000);
  assert.equal(from(await w.ask()), "public");
  assert.equal(w.calls.filter((c) => c === "keyed").length, 1, "not before 5 min");
  w.advance(1_000);
  assert.equal(from(await w.ask()), "public", "the retry failed: answered by the public endpoint");
  assert.equal(w.calls.filter((c) => c === "keyed").length, 2);
  assert.equal(w.state(), "fallback");
  dead = false;
  w.advance(300_000);
  assert.equal(from(await w.ask()), "keyed", "the key answers again");
  assert.equal(w.state(), "keyed");
  assert.equal(w.logs.filter((l) => l.startsWith("solana rpc keyed")).length, 1, w.logs.join("\n"));
});

test("the public endpoint has its own budget while it stands in: 100 per 10 s and 40 per method, never the keyed plan's", async () => {
  let t = 1_800_000_000_000;
  const calls: string[] = [];
  const r = createRpc({ SOLANA_RPC_URL: KEYED, RPC_BUDGET_SOLANA: "500,100,500" }, { fetch: (async (u: string) => (calls.push(u), u === PUBLIC ? ok(u) : new Response("x", { status: 401 }))) as never, now: () => t, log: () => undefined });
  const answers = [];
  for (let i = 0; i < 45; i++) answers.push((await r.handle("solana", JSON_T, read, `c${i % 10}`)).status);
  const room = rpcMod.RPC_METHOD_MAX - rpcMod.RPC_RESERVE.solana; // the public 40 a method, less Discover's reserve
  assert.equal(calls.filter((u) => u === PUBLIC).length, room, "the public endpoint's 40 getBalance a 10 s, never the keyed 500");
  assert.ok(answers.slice(room).every((s) => s === 429));
  t += 11_000; // a request in second s counts in the provider's window to the end of s + 10 (limits.ts totalWait)
  assert.equal((await r.handle("solana", JSON_T, read, "c0")).status, 200, "the next window");
});

test("the holders slot: the public endpoint refuses its call, so while fallen back it answers 503 at once and the token page serves Jupiter's holders", async () => {
  const calls: string[] = [];
  const logs: string[] = [];
  const r = createRpc({ SOLANA_RPC_URL: KEYED }, { fetch: (async (u: string) => (calls.push(u), new Response("x", { status: 403 }))) as never, log: (l: string) => logs.push(l), slot: "holders", publicFallback: false } as never);
  const read2 = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenLargestAccounts", params: ["x"] });
  assert.equal((await r.handle("solana", JSON_T, read2)).status, 503);
  assert.equal((await r.handle("solana", JSON_T, read2)).status, 503);
  assert.deepEqual(calls, [KEYED], "never the public endpoint, and the key not again inside the retry");
  assert.match(logs.join("\n"), /^solana holders fallback \(403\)/m);
});

test("a public SOLANA_RPC_URL (unset) is the public endpoint from the start: its 401 is 503 as before, no fallback", async () => {
  const calls: string[] = [];
  const r = createRpc({}, { fetch: (async (u: string) => (calls.push(u), new Response("x", { status: 401 }))) as never, log: () => undefined });
  assert.equal((await r.handle("solana", JSON_T, read)).status, 503);
  assert.equal((r as unknown as { slot?: { state(): string } }).slot?.state(), "public");
  assert.equal(typeof (rpcMod as Record<string, unknown>).SOLANA_PUBLIC, "string");
});

test("GET /v1/health names each Solana slot keyed, fallback or public, never a URL or a key", async () => {
  const { createServer, request } = await import("node:http");
  const { handler } = await import("../server.ts");
  const r = createRpc({ SOLANA_RPC_URL: KEYED }, { fetch: (async (u: string) => (u === PUBLIC ? ok(u) : new Response("x", { status: 401 }))) as never, log: () => undefined });
  const h = createServer(handler("0123456789abcdef0123456789abcdef01234567", undefined, r as never));
  await new Promise<void>((done) => h.listen(0, "127.0.0.1", () => done()));
  const port = (h.address() as { port: number }).port;
  const get = () =>
    new Promise<string>((done, fail) => request({ host: "127.0.0.1", port, path: "/v1/health" }, (res) => {
      let b = "";
      res.setEncoding("utf8").on("data", (d) => (b += d)).on("end", () => done(b));
    }).on("error", fail).end());
  try {
    assert.deepEqual(JSON.parse(await get()).solana, { rpc: "keyed" });
    await r.handle("solana", JSON_T, read);
    const body = await get();
    assert.deepEqual(JSON.parse(body).solana, { rpc: "fallback" });
    // card rpc-keyed-lists: the keyed list's host is named (its rpc entry), never the URL's path, query or key
    assert.ok(!body.includes("api-key") && !body.includes("1111"));
    assert.deepEqual(JSON.parse(body).rpc.solana, ["keyed.test unread"]);
  } finally {
    h.closeAllConnections();
    await new Promise<void>((done) => h.close(() => done()));
  }
});
