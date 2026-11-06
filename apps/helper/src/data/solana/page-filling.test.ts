// Card token-page-fills-after (M384): the TokenPage says whether its Jupiter row is still coming. `filling` is true
// only while a page off the lists is named on chain because its search was late (rowLater); the read after the row
// is held answers false. A mint Jupiter answers it does not list is named on chain with filling false at once, so the
// app draws the dash there, not a skeleton. The app reads a chain-named page again every 5 s; those re-reads of a held
// page send their search as a background read (the proxy's `caller` false), never ahead of a caller's turn: trade
// builds share Jupiter Free's one window. Read as a namespace so this file runs against the code before the card too
// (the red run). Machinery as page-chain.test.ts's.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { enableTimers, resetTimers } from "../../../test/mock-timers.ts";
import { createProxy } from "../../proxy/proxy.ts";
import { b58encode } from "./lists.ts";
import { pda } from "./origin.ts";
import * as T from "./token.ts";

const FX = JSON.parse(readFileSync(new URL("./fixtures/token-page.json", import.meta.url), "utf8"));
/** BONK, a classic SPL mint, and its Metaplex metadata account, one recorded mainnet getMultipleAccounts. */
const MD = JSON.parse(readFileSync(new URL("./fixtures/token-metadata.json", import.meta.url), "utf8")) as { keys: [string, string]; answer: { result: { context: { slot: number }; value: [unknown, unknown] } } };
const PUMP = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const NOW = Date.parse("2026-11-06T05:00:00.000Z");
const METADATA_PROGRAM = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const enc = new TextEncoder();
const { b58decode } = await import("./lists.ts");
const metadataOf = (m: string) => pda([enc.encode("metadata"), b58decode(METADATA_PROGRAM)!, b58decode(m)!], METADATA_PROGRAM);

/** The n-th test mint: 32 bytes, a valid address, never a real token. */
const mint = (n: number) => b58encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 9 + (n >> 8) : i === 1 ? n & 0xff : 3)));
/** Jupiter's row for any mint: PUMP's recorded row under the mint's id. */
const rowOf = (m: string) => ({ ...FX.tokens[PUMP].search[0], id: m });
/** The Token-2022 symbol each test mint names on chain. */
const symbolOf = (m: string) => `T${m.slice(0, 5)}`;

/** The RPC path: each mint read answers PUMP's recorded Token-2022 account, its tokenMetadata naming the asked mint;
 *  the launch read finds no curve. */
const rpc = {
  async handle(_c: string, _ct: string | undefined, body: string) {
    const r = JSON.parse(body) as { params: [string[], { encoding: string }] };
    const keys = r.params[0];
    if (r.params[1].encoding === "base64") return { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 464517653 }, value: keys.map(() => null) } }) };
    const rec = FX.tokens[PUMP].accounts;
    const v0 = rec.result.value[0];
    const m = keys[0]!;
    const exts = v0.data.parsed.info.extensions.map((e: { extension: string; state: Record<string, unknown> }) =>
      e.extension === "tokenMetadata" ? { ...e, state: { ...e.state, mint: m, name: `Token ${m.slice(0, 5)}`, symbol: symbolOf(m) } } : e,
    );
    const acct = { ...v0, data: { ...v0.data, parsed: { ...v0.data.parsed, info: { ...v0.data.parsed.info, extensions: exts } } } };
    return { status: 200, body: JSON.stringify({ ...rec, result: { ...rec.result, value: keys.map((k, i) => (i === 0 ? acct : k === metadataOf(m) ? null : acct)) } }) };
  },
};

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((ok) => setImmediate(ok));
};
async function run(t: TestContext, ms: number) {
  for (let left = ms; left > 0; left -= 10) {
    await flush();
    t.mock.timers.tick(Math.min(10, left));
  }
  await flush();
}
const clock = (t: TestContext) => {
  enableTimers(t.mock.timers, { apis: ["setTimeout", "Date"], now: NOW });
  t.after(() => resetTimers(t.mock.timers));
};
type Page = { status: number; ms: number; row?: Record<string, unknown>; filling?: unknown };
function ask(tok: ReturnType<typeof T.createSolanaToken>, m: string): { done: Page | null } {
  const t0 = Date.now();
  const h: { done: Page | null } = { done: null };
  void tok.page(m).then((a) => (h.done = { status: a.status, ms: Date.now() - t0, ...(a.status === 200 ? { row: JSON.parse(a.body).row, filling: JSON.parse(a.body).filling } : {}) }));
  return h;
}
async function until(t: TestContext, h: { done: Page | null }, ms: number) {
  for (let left = ms; h.done === null && left > 0; left -= 10) await run(t, 10);
}
/** Jupiter behind the real proxy: a search answers its mints' rows, anything else `{}`; `sends` holds each send's path
 *  and time; `answer` may answer a send itself (a 429). */
function jupiter(answer?: (n: number) => Response | undefined, rows: (m: string) => unknown[] = (m) => [rowOf(m)]) {
  const sends: { path: string; at: number }[] = [];
  const proxy = createProxy({}, {
    now: () => Date.now(),
    fetch: (async (url: string) => {
      const u = new URL(url);
      sends.push({ path: u.pathname, at: Date.now() });
      const own = answer?.(sends.length);
      if (own !== undefined) return own;
      if (u.pathname.endsWith("/search")) return new Response(JSON.stringify(u.searchParams.get("query")!.split(",").flatMap(rows)), { headers: { "content-type": "application/json" } });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }) as never,
  });
  return { proxy, sends };
}


test("card token-page-fills-after: a late search answers filling true (named on chain); the read after its row is held answers filling false", async (t) => {
  clock(t);
  // Jupiter's first send answers 429 (reset 1 s): the page's search is late, the page is named on chain
  const { proxy, sends } = jupiter((n) => (n === 1 ? new Response("{}", { status: 429, headers: { "content-type": "application/json", "retry-after": "1" } }) : undefined));
  const tok = T.createSolanaToken(proxy, rpc, { now: () => Date.now() });
  const cold = ask(tok, mint(5));
  await until(t, cold, 1_000);
  assert.deepEqual([cold.done?.status, cold.done?.row?.src, cold.done?.filling], [200, "chain", true], "late: named on chain and filling");
  for (let ms = 0; ms < 10_000 && sends.length < 2; ms += 50) await run(t, 50);
  await run(t, 100);
  const again = ask(tok, mint(5));
  await until(t, again, 1_000);
  assert.deepEqual([again.done?.status, again.done?.row?.src, again.done?.filling], [200, "jupiter", false], "the row held: Jupiter's, not filling");
});

test("card token-page-fills-after: a mint Jupiter's search does not list is named on chain with filling false at once", async (t) => {
  clock(t);
  const { proxy } = jupiter(undefined, () => []);
  const tok = T.createSolanaToken(proxy, rpc, { now: () => Date.now() });
  const p = ask(tok, mint(6));
  await until(t, p, 1_000);
  assert.deepEqual([p.done?.status, p.done?.row?.src, p.done?.row?.symbol, p.done?.filling], [200, "chain", symbolOf(mint(6)), false]);
});

test("card token-page-fills-after: a Jupiter row answers filling false, and every page answer carries it as a boolean", async (t) => {
  clock(t);
  const { proxy } = jupiter();
  const tok = T.createSolanaToken(proxy, rpc, { now: () => Date.now() });
  const p = ask(tok, mint(7));
  await until(t, p, 1_000);
  assert.deepEqual([p.done?.status, p.done?.row?.src, p.done?.filling], [200, "jupiter", false]);
  assert.deepEqual(T.PAGE_FIELDS.at(-1), "filling");
});

test("card token-page-fills-after: the app's 5 s re-reads of a held chain-named page send their search as a background read, never as a caller's", async (t) => {
  clock(t);
  const { proxy } = jupiter(undefined, () => []);
  const searches: { caller: unknown; at: number }[] = [];
  const spy = { ...proxy, handle: (...a: Parameters<typeof proxy.handle>) => (a[1] === "/tokens/v2/search" && searches.push({ caller: a[7], at: Date.now() }), proxy.handle(...a)) };
  const tok = T.createSolanaToken(spy as typeof proxy, rpc, { now: () => Date.now() });
  const first = ask(tok, mint(8));
  await until(t, first, 1_000);
  assert.deepEqual([first.done?.row?.src, first.done?.filling], ["chain", false]);
  // the app's follow: one read every 5 s for two minutes, each answered at once from what is held
  for (let i = 0; i < 24; i++) {
    await run(t, 5_000);
    const r = ask(tok, mint(8));
    await until(t, r, 1_000);
    assert.equal(r.done?.status, 200);
  }
  await run(t, 1_000);
  assert.equal(searches[0]?.caller, true, "the first read waits for its search: a caller's");
  const later = searches.slice(1);
  assert.ok(later.length >= 2, `the held page's search read again in the background: ${later.length}`);
  assert.deepEqual(later.filter((s) => s.caller !== false), [], "every re-read's search is a background read");
});

test("card jupiter-build-budget-503: N fill polls of one mint (four devices a second for 14 s) while its search is in flight or held make one Jupiter search", async (t) => {
  clock(t);
  // Jupiter answers the search 2 s after it is sent: the first pages are late (named on chain, filling), the search in
  // flight under them, then its row held JUP_FRESH_MS
  const searches: string[] = [];
  const proxy = createProxy({}, {
    now: () => Date.now(),
    fetch: (async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/search")) searches.push(u.searchParams.get("query")!);
      await new Promise((ok) => setTimeout(ok, 2_000));
      return new Response(JSON.stringify(u.pathname.endsWith("/search") ? u.searchParams.get("query")!.split(",").map(rowOf) : {}), { headers: { "content-type": "application/json" } });
    }) as never,
  });
  const tok = T.createSolanaToken(proxy, rpc, { now: () => Date.now() });
  const m = mint(9);
  const polls: { done: Page | null }[] = [];
  for (let s = 0; s <= 14; s++) {
    for (let d = 0; d < 4; d++) polls.push(ask(tok, m));
    await run(t, 1_000);
  }
  await run(t, 1_000);
  assert.ok(polls.every((p) => p.done?.status === 200), polls.map((p) => p.done?.status ?? "pending").join(" "));
  assert.deepEqual([polls[0]!.done?.filling, polls.at(-1)!.done?.filling, polls.at(-1)!.done?.row?.src], [true, false, "jupiter"], "the first late, the last from the held row");
  assert.deepEqual(searches, [m], `${polls.length} polls, ${searches.length} Jupiter searches`);
});
