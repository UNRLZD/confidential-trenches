// Card helper-page-jup-429: a cold token page is named on chain and never waits on Jupiter's window. Under Jupiter
// Free's 10 sends in any 10 s, every page and build shares one window (helper live run 42164306192: the page 5603 ms,
// jup-wait 1565 and jup-turn 3983 with no 429). The page answers within 1 s with the symbol its mint names on chain
// (a Token-2022 mint's tokenMetadata extension, a classic mint's Metaplex metadata account, read in the same
// getMultipleAccounts as the mint), and its search goes at the page lane's next free send; the next read has its row.
// Read as a namespace so this file runs against the code before the card too (the red run).

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
type Page = { status: number; ms: number; row?: Record<string, unknown> };
function ask(tok: ReturnType<typeof T.createSolanaToken>, m: string): { done: Page | null } {
  const t0 = Date.now();
  const h: { done: Page | null } = { done: null };
  void tok.page(m).then((a) => (h.done = { status: a.status, ms: Date.now() - t0, ...(a.status === 200 ? { row: JSON.parse(a.body).row } : {}) }));
  return h;
}
async function until(t: TestContext, h: { done: Page | null }, ms: number) {
  for (let left = ms; h.done === null && left > 0; left -= 10) await run(t, 10);
}
/** Jupiter behind the real proxy: a search answers its mints' rows, anything else `{}`; `sends` holds each send's path
 *  and time; `answer` may answer a send itself (a 429). */
function jupiter(answer?: (n: number) => Response | undefined) {
  const sends: { path: string; at: number }[] = [];
  const proxy = createProxy({}, {
    now: () => Date.now(),
    fetch: (async (url: string) => {
      const u = new URL(url);
      sends.push({ path: u.pathname, at: Date.now() });
      const own = answer?.(sends.length);
      if (own !== undefined) return own;
      if (u.pathname.endsWith("/search")) return new Response(JSON.stringify(u.searchParams.get("query")!.split(",").map(rowOf)), { headers: { "content-type": "application/json" } });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }) as never,
  });
  return { proxy, sends };
}

test("card helper-page-jup-429: Jupiter's 10 s window full, a cold page answers 200 within 1 s named on chain; its search goes at the window's next free send and the next read, within 10 s, has its row", async (t) => {
  clock(t);
  const { proxy, sends } = jupiter();
  const tok = T.createSolanaToken(proxy, rpc, { now: () => Date.now() });
  // the window filled: one page's search, two devices' builds (7, and the 1 left them), then a second page's search
  const first = ask(tok, mint(1));
  await until(t, first, 2_000);
  for (let i = 0; i < 7; i++) void proxy.handle("jupiter", "/swap/v2/build", `q=a${i}`, "", "198.51.100.7");
  for (let i = 0; i < 2; i++) void proxy.handle("jupiter", "/swap/v2/build", `q=b${i}`, "", "198.51.100.8");
  await run(t, 50);
  // the builds leave the pages one send (proxy.ts OWN_ROOM): a second page takes it
  const second = ask(tok, mint(4));
  await until(t, second, 2_000);
  assert.equal(sends.length, 10, "the window is full");
  const cold = ask(tok, mint(2));
  await until(t, cold, 1_000);
  assert.ok(cold.done !== null && cold.done.ms < 1_000, `answered within 1 s: ${cold.done?.ms} ms`);
  assert.equal(cold.done!.status, 200);
  assert.deepEqual([cold.done!.row!.symbol, cold.done!.row!.src, cold.done!.row!.price_usd], [symbolOf(mint(2)), "chain", null], "named on chain, Jupiter's fields null");
  // its search goes when the window has room again, and the next read within one window has Jupiter's row
  const searches = () => sends.filter((s) => s.path.endsWith("/search"));
  for (let ms = 0; ms < 10_000 && searches().length < 3; ms += 50) await run(t, 50);
  assert.ok(searches()[2]!.at - searches()[0]!.at >= 10_000 - 20, "the search waited for the window's room");
  await run(t, 100);
  const again = ask(tok, mint(2));
  await until(t, again, 1_000);
  assert.ok(Date.now() - NOW < 2_000 + 10_000, "within one window of the page");
  assert.deepEqual([again.done?.status, again.done?.row?.src, again.done?.row?.symbol], [200, "jupiter", FX.tokens[PUMP].search[0].symbol], "the next read has the row");
});

test("card helper-page-jup-429: Jupiter answering 429 (reset 1 s), a cold page answers 200 within 1 s named on chain; the next read after the search's turn has its row", async (t) => {
  clock(t);
  const { proxy, sends } = jupiter((n) => (n === 1 ? new Response("{}", { status: 429, headers: { "content-type": "application/json", "retry-after": "1" } }) : undefined));
  const tok = T.createSolanaToken(proxy, rpc, { now: () => Date.now() });
  const cold = ask(tok, mint(3));
  await until(t, cold, 1_000);
  assert.ok(cold.done !== null && cold.done.ms < 1_000, `answered within 1 s: ${cold.done?.ms} ms`);
  assert.deepEqual([cold.done!.status, cold.done!.row!.symbol, cold.done!.row!.src], [200, symbolOf(mint(3)), "chain"]);
  for (let ms = 0; ms < 10_000 && sends.length < 2; ms += 50) await run(t, 50);
  await run(t, 100);
  assert.equal(sends.length, 2, "the 429, then the search's turn");
  const again = ask(tok, mint(3));
  await until(t, again, 1_000);
  assert.deepEqual([again.done?.status, again.done?.row?.src], [200, "jupiter"], "the next read has the row");
});

test("card helper-page-jup-429: a classic SPL mint is named by its Metaplex metadata account, read in the one getMultipleAccounts that reads the mint (BONK, recorded on mainnet)", async (t) => {
  clock(t);
  const [BONK, META] = MD.keys;
  assert.equal(metadataOf(BONK), META, "the metadata account is the program address of (metadata, program, mint)");
  const reads: string[][] = [];
  const classic = {
    async handle(_c: string, _ct: string | undefined, body: string) {
      const r = JSON.parse(body) as { method: string; params: [string[], { encoding: string }] };
      if (r.params[1].encoding === "base64") return { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: MD.answer.result.context, value: r.params[0].map(() => null) } }) };
      reads.push(r.params[0]);
      const value = r.params[0].map((k) => (k === BONK ? MD.answer.result.value[0] : k === META ? MD.answer.result.value[1] : null));
      return { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: MD.answer.result.context, value } }) };
    },
  };
  // Jupiter's window held past the page's wait: only the chain names it
  const { proxy } = jupiter(() => new Response("{}", { status: 429, headers: { "content-type": "application/json", "retry-after": "30" } }));
  const tok = T.createSolanaToken(proxy, classic, { now: () => Date.now() });
  const p = ask(tok, BONK);
  await until(t, p, 1_000);
  assert.deepEqual([p.done?.status, p.done?.row?.symbol, p.done?.row?.name, p.done?.row?.src], [200, "Bonk", "Bonk", "chain"]);
  assert.deepEqual(reads, [[BONK, META]], "one jsonParsed read: the mint and its metadata account");
});

test("card helper-page-jup-429: the name on chain is hostile input: a metadata account of another program or another mint, a cut or oversized length, and control characters name nothing", () => {
  const identityOf = (T as Record<string, unknown>).identityOf as ((a: unknown, b: unknown, m: string) => { name: string | null; symbol: string | null; uri: string | null }) | undefined;
  assert.ok(identityOf !== undefined, "identityOf is served");
  const [BONK] = MD.keys;
  const [mintAcct, meta] = MD.answer.result.value as [unknown, { owner: string; data: [string, string] }];
  assert.deepEqual(identityOf(mintAcct, meta, BONK), { name: "Bonk", symbol: "Bonk", uri: "https://arweave.net/QPC6FYdUn-3V8ytFNuoCS85S2tHAuiDblh6u3CIZLsw" });
  const raw = Buffer.from(meta.data[0], "base64");
  const as = (b: Buffer, owner = meta.owner) => ({ ...meta, owner, data: [b.toString("base64"), "base64"] });
  const none = { name: null, symbol: null, uri: null };
  assert.deepEqual(identityOf(mintAcct, as(raw, "11111111111111111111111111111111"), BONK), none, "another program's account");
  assert.deepEqual(identityOf(mintAcct, meta, PUMP), none, "another mint's metadata");
  assert.deepEqual(identityOf(mintAcct, as(raw.subarray(0, 70)), BONK), none, "cut inside the name's length");
  const big = Buffer.from(raw);
  big.writeUInt32LE(1_000_000, 65);
  assert.deepEqual(identityOf(mintAcct, as(big), BONK), none, "a name length past the account");
  assert.deepEqual(identityOf(mintAcct, { ...meta, data: [meta.data[0], "base58"] }, BONK), none, "not base64");
  assert.deepEqual(identityOf(mintAcct, null, BONK), none, "no metadata account");
  // control characters are stripped and the parts bounded, as Jupiter's row is (lists.ts text)
  const named = Buffer.from(raw);
  const nameLen = named.readUInt32LE(65);
  named.write("\u0007Bo\u0000", 69, "utf8");
  const id = identityOf(mintAcct, as(named), BONK);
  assert.ok(nameLen >= 4 && id.symbol === "Bonk" && !/[\u0000-\u001f]/.test(id.name ?? ""), JSON.stringify(id));
});
