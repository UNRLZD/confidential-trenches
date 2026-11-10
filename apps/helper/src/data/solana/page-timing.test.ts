// node --test apps/helper/src/data/solana/page-timing.test.ts (card helper-ready-page-warm): a token page answer names
// what it waited on, in the standard Server-Timing header: the lists, the Solana RPC read (its wait for a hold or the
// provider's pace, its send, and a keyed provider's time before it fell back to the public endpoint), Jupiter's search
// (its wait for its turn, the search itself), the launch read, and the helper's whole time. Helper live run 42078439435
// (787f2a4): the first run of helper-token-page-cold after the deploy read p95 1672 ms, max 2784 ms, and nothing said
// which wait it was.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { b58encode } from "./lists.ts";
import * as T from "./token.ts";
import * as R from "../../rpc/rpc.ts";
import * as server from "../../server.ts";

const FX = JSON.parse(readFileSync(new URL("./fixtures/token-page.json", import.meta.url), "utf8"));
const PUMP = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const mint = (n: number) => b58encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 1 + (n >> 8) : i === 1 ? n & 0xff : 7)));
const rowOf = (m: string) => ({ ...FX.tokens[PUMP].search[0], id: m });
/** At least `ms` as performance.now() reads it: Node dates a timer from the event loop's clock, read when its turn began
 *  (lib/internal/timers.js getLibuvNow), so a timer set late in a long turn fires that much before `ms` has passed on
 *  performance.now(), the clock the timings are read on. */
const sleep = async (ms: number): Promise<void> => {
  const end = performance.now() + ms;
  for (let t = performance.now(); t < end; t = performance.now()) await new Promise((ok) => setTimeout(ok, Math.ceil(end - t)));
};
/** Each entry's name and its dur (or its desc), in order. */
const entries = (h: string) => h.split(", ").map((e) => e.split(";")[0]);
const dur = (h: string, name: string) => Number(/dur=(\d+)/.exec(h.split(", ").find((e) => e.split(";")[0] === name) ?? "")?.[1] ?? NaN);

/** The RPC path as rpc.ts answers it: PUMP's mint account, with that read's timing entries. */
const rpc = {
  async handle(_c: string, _ct: string | undefined, body: string) {
    const r = JSON.parse(body) as { params: [string[], { encoding: string }] };
    const keys = r.params[0];
    await sleep(20);
    if (r.params[1].encoding === "base64") return { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 464517653 }, value: keys.map(() => null) } }) };
    const rec = FX.tokens[PUMP].accounts;
    return { status: 200, body: JSON.stringify({ ...rec, result: { ...rec.result, value: keys.map(() => rec.result.value[0]) } }), timing: ["rpc-wait;dur=300", 'rpc;dur=20;desc="solana"'] };
  },
};
/** Jupiter's search, answering after `lat` ms; with `gate`, the first search also waits for it to open. */
const proxyOf = (lat: number, gate?: Promise<void>) => ({
  async handle(_v: string, _p: string, q: string) {
    if (gate !== undefined) await gate, (gate = undefined);
    await sleep(lat);
    const mints = new URLSearchParams(q).get("query")!.split(",");
    return { status: 200, headers: { "X-Fetched-At": new Date().toISOString() }, body: JSON.stringify(mints.map(rowOf)) };
  },
});

test("card helper-ready-page-warm: a cold page's answer names each wait: the lists, the RPC read's wait and send, Jupiter's search turn and search, the launch read; served again from what is held it says cache (red at 787f2a4: no timing)", async () => {
  let open!: () => void;
  const gate = new Promise<void>((ok) => (open = ok));
  const tok = T.createSolanaToken(proxyOf(60, gate) as never, rpc as never);
  // the second mint is asked while the first's search is out (held out until the second has waited 15 ms, so no slow
  // timer lets it return first), so it goes in the next search
  const pa = tok.page(mint(1));
  await sleep(15);
  const pb = tok.page(mint(2));
  await sleep(15);
  open();
  const [a, b] = await Promise.all([pa, pb]);
  assert.equal(a.status, 200);
  const h = (a as { timing?: string }).timing ?? "";
  assert.deepEqual(entries(h), ["lists", "rpc-wait", "rpc", "jup-wait", "jup", "launch", "read"], h);
  assert.equal(dur(h, "rpc-wait"), 300, "the RPC read's own wait carried as rpc.ts names it");
  assert.ok(dur(h, "jup") >= 55, h);
  // the second mint's search went once the first returned: its turn is the first search's time
  const hb = (b as { timing?: string }).timing ?? "";
  assert.ok(dur(hb, "jup-wait") >= 35, `the second search waited its turn: ${hb}`);
  assert.equal((await tok.page(mint(1)) as { timing?: string }).timing, "cache");
  // a page whose launch came in after it was built is served as filled from what is held: still cache
  await sleep(T.LAUNCH_WAIT_MS);
  assert.equal((await tok.page(mint(2)) as { timing?: string }).timing, "cache");
  assert.equal((await tok.holders(mint(1)) as { timing?: string }).timing, undefined, "a holders read made now names nothing yet");
  assert.equal((await tok.holders(mint(1)) as { timing?: string }).timing, "cache");
});

test("card helper-ready-page-warm: a keyed Solana provider's 429 names its time before the read fell back and the public endpoint's send (red at 787f2a4: no timing)", async () => {
  const KEYED = "https://solana.keyed.example/ct-proof-0123456789abcdef";
  const fetch = async (url: string, init: RequestInit) => {
    const id = (JSON.parse(String(init.body)) as { id: number }).id;
    if (url === KEYED) return new Response("{}", { status: 429, headers: { "retry-after": "1" } });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: 1 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const rpcK = R.createRpc({ SOLANA_RPC_URL: KEYED }, { fetch, log: () => undefined });
  const a = (await rpcK.handle("solana", "application/json", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [[PUMP]] }))) as { status: number; timing?: string[] };
  assert.equal(a.status, 200);
  // card solana-quote-under-1s: rpc-wait on every answer, 0 included
  assert.deepEqual((a.timing ?? []).map((e) => e.split(";")[0]), ["rpc-keyed", "rpc-wait", "rpc"], String(a.timing));
  assert.match(a.timing![0]!, /desc="fell back"/);
  assert.match(a.timing![2]!, /desc="public"/);
});

test("card helper-rpc-wait-timing: rpc-wait is the time the read waited out a hold or the provider's pace, never the fallback's own work (red at 9ceba84: 2 ms of work between the keyed 429 and the public send read rpc-wait;dur=20)", async () => {
  const KEYED = "https://solana.keyed.example/ct-proof-0123456789abcdef";
  let slow = false;
  // a slow runner: after the keyed provider's 429 every clock read costs 2 ms of the read's own work, with no hold and
  // no pace on the public endpoint (PR #337 fresh-run job 127756337132 read rpc-wait at 0.5 ms of it)
  const now = () => {
    if (slow) for (const end = performance.now() + 2; performance.now() < end; );
    return performance.timeOrigin + performance.now();
  };
  const fetch = async (url: string, init: RequestInit) => {
    const id = (JSON.parse(String(init.body)) as { id: number }).id;
    if (url === KEYED) return (slow = true), new Response("{}", { status: 429, headers: { "retry-after": "1" } });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: 1 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const rpcK = R.createRpc({ SOLANA_RPC_URL: KEYED }, { fetch, now, log: () => undefined });
  const a = (await rpcK.handle("solana", "application/json", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [[PUMP]] }))) as { status: number; timing?: string[] };
  assert.equal(a.status, 200);
  assert.deepEqual((a.timing ?? []).map((e) => e.split(";")[0]), ["rpc-keyed", "rpc-wait", "rpc"], String(a.timing));
  assert.ok(Number(/dur=(\d+)/.exec(a.timing![0]!)![1]) >= 2, `the fall's own time is rpc-keyed's: ${a.timing}`);
  assert.equal(a.timing![1], "rpc-wait;dur=0", `no wait: ${a.timing}`);
});

/**
 * Solana's provider (the public endpoint, no key set) answers 429 with a reset 1 s ahead, then 200, on a clock that moves only by the helper's waits.
 * `early`: a long wait's timer fires that many ms before the clock reads its end, as Node's does when it is set late in
 * a long turn (lib/internal/timers.js dates it from the loop's clock).
 */
async function heldRead(early: number) {
  let t = 1_800_000_000_000;
  let calls = 0;
  const fetch = async (_url: string, init: RequestInit) => {
    const id = (JSON.parse(String(init.body)) as { id: number }).id;
    if (++calls === 1) return new Response("{}", { status: 429, headers: { "retry-after": "1" } });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: 1 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const rpcP = R.createRpc({}, { fetch, now: () => t, sleep: async (ms: number) => void (t += ms > 100 ? ms - early : ms), log: () => undefined });
  const a = (await rpcP.handle("solana", "application/json", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [[PUMP]] }))) as { status: number; timing?: string[] };
  assert.equal(a.status, 200, JSON.stringify(a));
  assert.equal(calls, 2);
  // the hold's 1 s from the 429 and the 5 ms margin past its end (rpc.ts HOLD_MARGIN_MS), all of it waited
  // card solana-quote-under-1s: the provider by its environment name; the public endpoint, set under none, is "public"
  assert.deepEqual(a.timing, ["rpc-wait;dur=1005", 'rpc;dur=0;desc="public"']);
}

test("card helper-rpc-wait-timing: a read that waited out the provider's hold names that wait as rpc-wait, and its send as rpc", () => heldRead(0));

test("card helper-rpc-wait-timing: a read whose wait wakes inside the provider's hold waits out its rest and is sent, never the caller's 429 (red with 9ceba84's one-wait holdOver: 429)", () => heldRead(6));

test("card helper-ready-page-warm: GET /v1/market/token sends the read's entries and the helper's total in Server-Timing (red at 787f2a4: no header)", async (t) => {
  const token = { page: async () => (await sleep(30), { status: 200, body: "{}", src: "jupiter", asOfMs: 1, timing: 'rpc;dur=12;desc="solana"' }) };
  const h = server.start(COMMIT, 0, undefined, undefined, undefined, undefined, undefined, undefined, token as never);
  t.after(() => new Promise<void>((done) => (h.closeAllConnections(), h.close(() => done()))));
  await new Promise<void>((done) => h.on("listening", () => done()));
  const port = (h.address() as AddressInfo).port;
  const st = await new Promise<string>((done, fail) =>
    request({ host: "127.0.0.1", port, path: `/v1/market/token?chain=solana&token=${PUMP}` }, (res) => (res.resume(), done(String(res.headers["server-timing"] ?? "")))).on("error", fail).end(),
  );
  assert.deepEqual(entries(st), ["rpc", "total"], st);
  assert.ok(dur(st, "total") >= 25, st);
});

/**
 * The Jupiter turn case: its first search answered 429 (a reset 1 s ahead) and sent once more at the reset, within its
 * SEARCH_HOLD_WAIT_MS. `early`: the proxy's timers fire that many ms before its clock reads their end, as Node's do when
 * a timer is set late in a long turn (lib/internal/timers.js dates it from the loop's clock), so the woken retry finds
 * the clock inside Jupiter's hold (PR #342 test-packages job 127786967728: one turn line of two, the search 503).
 */
async function jupTurnCase(early: number) {
  let calls = 0;
  const fetch = async (url: string) => {
    calls++;
    if (calls === 1) return new Response("{}", { status: 429, headers: { "retry-after": "1" } });
    const mints = new URL(url).searchParams.get("query")!.split(",");
    return new Response(JSON.stringify(mints.map(rowOf)), { status: 200, headers: { "content-type": "application/json" } });
  };
  const lines: string[] = [];
  const timer = (ms: number) => new Promise<void>((ok) => setTimeout(ok, Math.max(0, ms - early)));
  const proxy = (await import("../../proxy/proxy.ts")).createProxy({ PROXY_BUDGET_JUPITER: "120,30", PROXY_BUDGET_RELAY: "120,30", PROXY_BUDGET_LIFI: "120,30", PROXY_BUDGET_ONECLICK: "120,30" }, { fetch: fetch as never, log: (l: string) => lines.push(l), ...(early > 0 ? { sleep: timer } : {}) });
  // each search the page sends, so the test waits for its answer, never for a guessed time
  const searches: Promise<unknown>[] = [];
  const seen = { handle: (...a: Parameters<typeof proxy.handle>) => (searches.push(proxy.handle(...a)), searches.at(-1)!) };
  const tok = T.createSolanaToken(seen as never, rpc as never);
  const a = await tok.page(mint(3));
  assert.equal(a.status, 200, (a as { body: string }).body);
  // the page answered on its own JUP_PAGE_WAIT_MS (500 ms) timer, before the search's retry at Jupiter's reset (1 s on):
  // it never waited on the search (timers fire in the order they are due, however busy the machine is)
  assert.equal(calls, 1, "the page answered before the search's retry was sent");
  const h = (a as { timing?: string }).timing ?? "";
  assert.deepEqual(entries(h), ["lists", "rpc-wait", "rpc", "jup", "launch", "read"], h);
  assert.match(h, new RegExp(`jup;desc="late";dur=${T.JUP_PAGE_WAIT_MS}`));
  assert.equal(searches.length, 1);
  // the search's own answer, its retry's: the token holds its row before this await returns (token.ts search)
  const s = (await searches[0]) as { status: number };
  assert.equal(s.status, 200, JSON.stringify(s));
  assert.equal(calls, 2);
  const turns = lines.filter((l) => l.startsWith("jupiter turn:"));
  assert.equal(turns.length, 2, turns.join("\n"));
  assert.match(turns[0]!, /answered 429/);
  assert.match(turns[1]!, /answered 200/);
  assert.equal(JSON.parse((await tok.page(mint(3))).body).row.src, "jupiter", "the next read has the row");
}

test("card helper-ready-page-warm slice 2, card helper-page-jup-429: a page whose search outlasts its wait names it late; the search's own parts are named in the proxy's turn lines (a 429, then the send), and the next read has its row", () => jupTurnCase(0));

test("card helper-rpc-wait-timing: a search whose retry wakes a few ms inside Jupiter's hold waits out the rest and is sent, never a 503 (red at 9ceba84: the retry's draw refused as held, one turn line of two)", () => jupTurnCase(3));
