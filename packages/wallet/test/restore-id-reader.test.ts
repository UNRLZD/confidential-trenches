// The restore's IdReader on NEAR (card wallet-restore-id-reader; docs/plan1/wallet.md §2.3 "Restore" step 5,
// l.297-324): each rule replayed on mainnet answers (test/vectors/id-reader-mainnet.json, test/record-id-reader.mjs),
// the two-provider rule and the indexer on a fake world, and whole step 5 restores on providers that fail.
//   node --test test/restore-id-reader.test.ts      (from packages/wallet)
// Test secrets: the all-zero BIP-39 entropy (test/vectors/a8.json), never money.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { vaultScopeOf } from "@blindfill/kit";
import * as d from "../src/derive/index.ts";
import { depositAccount, NEAR_NETWORKS, type NearRpc } from "../src/deposit/account.ts";
import { RESTORE_GAP, RESTORE_LANES, type NoteRestore, type RestoredNote } from "../src/notes/restore.ts";
import { ID_READ_TRIES, nearBalanceReader as openBalanceReader, nearIdReader as openIdReader } from "../src/restore/id-reader.ts";
import { afterRestore, DEPOSIT_ID_MARGIN, restoreDepositIds as depositIds, type IdReader } from "../src/restore/wallets.ts";

const FAST = "https://rpc.mainnet.fastnear.com";
const DRPC = "https://near.drpc.org";
const USDC = NEAR_NETWORKS.mainnet.usdc;
const REC = JSON.parse(readFileSync(new URL("./vectors/id-reader-mainnet.json", import.meta.url), "utf8")) as {
  ids: Record<string, string>;
  states: Record<string, string[]>;
  answers: Record<string, unknown>;
  intents: Record<string, { tokens: unknown; held: unknown }>;
};
const noSleep = async (): Promise<void> => {};
// the readers open with a floor read (review N1); these take each read through the opened reader, so an open that
// fails fails every read, and a bad network or pair still throws at once
const nearIdReader = (...a: Parameters<typeof openIdReader>): IdReader => {
  const p = openIdReader(...a);
  p.catch(() => {});
  return (u) => p.then((f) => f(u));
};
const nearBalanceReader = (...a: Parameters<typeof openBalanceReader>) => {
  const p = openBalanceReader(...a);
  p.catch(() => {});
  return (what: "usdc" | "near" | "intents", u: string) => p.then((f) => f(what, u));
};
const restoreDepositIds = async (...a: Parameters<typeof depositIds>) => (await depositIds(...a)).lanes;
// the block each recorded hash names
const HEIGHT = new Map<string, number>();
for (const a of Object.values(REC.answers) as { result?: { block_hash?: string; block_height?: number } }[]) if (a.result?.block_hash) HEIGHT.set(a.result.block_hash, a.result.block_height!);
const argsOf = (p: Record<string, unknown>): Record<string, unknown> => (typeof p.args_base64 === "string" ? JSON.parse(Buffer.from(p.args_base64, "base64").toString()) : {});

// a provider that answers from the recorded mainnet answers, by its URL and the exact params
function replay(url: string, log: string[] = [], swap: (p: Record<string, unknown>) => unknown = () => undefined): NearRpc {
  return {
    name: url,
    query: async (params) => {
      log.push(`${url.replace("https://", "")} ${String(params.method_name ?? params.request_type)}`);
      const s = swap(params);
      if (s !== undefined) return s;
      const a = REC.answers[`${url} ${JSON.stringify(params)}`];
      if (a === undefined) throw new Error(`no recorded answer for ${JSON.stringify(params)}`);
      return a;
    },
  };
}

test("each rule on mainnet's answers: never used, used by storage on the token, used by its NEAR account, money on the token", async () => {
  for (const name of ["never_used", "used_storage", "used_account", "money_usdc", "money_intents"]) {
    for (const f of [0, 1]) {
      const got = await nearIdReader("mainnet", [replay(FAST), replay(DRPC)], { first: () => f, tries: 1 })(REC.ids[name]!);
      assert.equal(got, REC.states[name]![f], `${name}, ${f === 0 ? "FastNEAR" : "dRPC"} first`);
    }
  }
  assert.deepEqual(REC.states, {
    never_used: ["unused", "unused"],
    used_storage: ["used", "used"],
    used_account: ["used", "used"],
    money_usdc: ["money", "money"],
    money_intents: ["money", "money"],
  });
  // never used: both providers read in full (storage, tokens, account on each); money: one provider, and no more
  const log: string[] = [];
  await nearIdReader("mainnet", [replay(FAST, log), replay(DRPC, log)], { first: () => 0, tries: 1 })(REC.ids.never_used!);
  assert.deepEqual(log, ["rpc.mainnet.fastnear.com view_account", "near.drpc.org view_account", "rpc.mainnet.fastnear.com storage_balance_of", "rpc.mainnet.fastnear.com mt_tokens_for_owner", "rpc.mainnet.fastnear.com view_account", "near.drpc.org storage_balance_of", "near.drpc.org mt_tokens_for_owner", "near.drpc.org view_account"]);
  log.length = 0;
  await nearIdReader("mainnet", [replay(FAST, log), replay(DRPC, log)], { first: () => 1, tries: 1 })(REC.ids.money_usdc!);
  assert.deepEqual(log, ["rpc.mainnet.fastnear.com view_account", "near.drpc.org view_account", "near.drpc.org storage_balance_of", "near.drpc.org ft_balance_of"], "the floor's two reads, then the id's");
});

test("the intents.near branch on mainnet's answers: tokens listed above zero are money", async () => {
  // never_used's token views and account, with money_intents's real intents.near answers in place of its own
  const u = REC.ids.never_used!;
  const intents = (url: string) => (p: Record<string, unknown>) => {
    if (p.account_id !== "intents.near" || p.request_type === "view_account") return undefined; // the floor's read is its own
    assert.deepEqual(argsOf(p).account_id, u);
    const rec = REC.intents[url]!;
    // recorded at their own block: served as of the block asked, as the reader pins every view of an id to one
    const a = structuredClone(p.method_name === "mt_tokens_for_owner" ? rec.tokens : rec.held) as { result: { block_height: number; block_hash: string } };
    if (typeof p.block_id === "string") Object.assign(a.result, { block_hash: p.block_id, block_height: HEIGHT.get(p.block_id) });
    return a;
  };
  assert.equal(await nearIdReader("mainnet", [replay(FAST, [], intents(FAST)), replay(DRPC, [], intents(DRPC))], { first: () => 0, tries: 1 })(u), "money");
});

// ---------- a fake world ----------
type Id = { storage?: boolean; usdc?: bigint; tokens?: Record<string, bigint>; account?: boolean };
// a block hash per height, base58 (digits as letters, padded): hashOf(h) names block h of the fake chain
const hashOf = (h: number): string => `H${[...String(h)].map((c) => "abcdefghij"[Number(c)]).join("")}`.padEnd(44, "z");
const heightOf = (p: Record<string, unknown>, final = 1): number => (typeof p.block_id === "string" ? Number([...(p.block_id as string).slice(1).replace(/z+$/, "")].map((c) => "abcdefghij".indexOf(c)).join("")) : final);
const view = (x: unknown, h = 1) => ({ jsonrpc: "2.0", result: { result: [...Buffer.from(JSON.stringify(x))], logs: [], block_height: h, block_hash: hashOf(h) } });
const unknown = (id: string) => ({ jsonrpc: "2.0", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: id } } } });
function answer(world: Map<string, Id>, p: Record<string, unknown>): unknown {
  const args = argsOf(p);
  const u = (p.request_type === "view_account" ? p.account_id : args.account_id) as string;
  const x = world.get(u) ?? {};
  const acct = { jsonrpc: "2.0", result: { amount: "1", locked: "0", storage_usage: 182, block_height: 1, block_hash: hashOf(1) } };
  if (p.request_type === "view_account" && u === "intents.near") return acct; // the floor's read
  if (p.request_type === "view_account") return x.account ? acct : unknown(u);
  if (p.account_id === USDC && p.method_name === "storage_balance_of") return view(x.storage || (x.usdc ?? 0n) > 0n ? { total: "1250000000000000000000", available: "0" } : null);
  if (p.account_id === USDC && p.method_name === "ft_balance_of") return view(String(x.usdc ?? 0n));
  if (p.account_id === "intents.near" && p.method_name === "mt_tokens_for_owner") return view(Object.keys(x.tokens ?? {}).map((token_id) => ({ token_id })));
  if (p.account_id === "intents.near" && p.method_name === "mt_batch_balance_of") return view((args.token_ids as string[]).map((t) => String(x.tokens?.[t] ?? 0n)));
  throw new Error(`unexpected view ${JSON.stringify(p)}`);
}
// a provider over `world`; `fail` decides per query whether it fails (an Error) or answers something else
function provider(url: string, world: Map<string, Id>, fail: (p: Record<string, unknown>) => unknown = () => undefined, count = { n: 0 }): NearRpc {
  return {
    name: url,
    query: async (params) => {
      count.n++;
      // the floor's read answers: these tests fail id reads; the floor's own tests use their own providers
      if (params.request_type === "view_account" && params.account_id === "intents.near") return answer(world, params);
      const f = fail(params);
      if (f instanceof Error) throw f;
      if (f !== undefined) return f;
      return answer(world, params);
    },
  };
}
const W = (o: Record<string, Id>) => new Map(Object.entries(o));
const U1 = "11".repeat(32), U2 = "22".repeat(32);

test("unused only when both providers say so: a trace or money on either one is enough; an indexer may add used, never unused", async () => {
  const empty = W({});
  const used = W({ [U1]: { account: true } });
  const read = (a: Map<string, Id>, b: Map<string, Id>, opts = {}) => nearIdReader("mainnet", [provider(FAST, a), provider(DRPC, b)], { first: () => 0, sleep: noSleep, ...opts });
  assert.equal(await read(empty, empty)(U1), "unused");
  assert.equal(await read(empty, used)(U1), "used", "the second provider shows the account the first hid");
  assert.equal(await read(empty, W({ [U1]: { usdc: 5n } }))(U1), "money");
  assert.equal(await read(W({ [U1]: { storage: true } }), empty)(U1), "used", "storage on the token, read on the first provider alone");
  // review F6 (a): a token listed at 0 is no trace (intents.near at 16d04f6 deletes a balance that falls to 0)
  assert.equal(await read(W({ [U1]: { tokens: { "nep141:a": 0n } } }), empty)(U1), "unused", "a token listed at zero");
  assert.equal(await read(W({ [U1]: { tokens: { "nep141:a": 0n, "nep141:b": 3n } } }), empty)(U1), "money");
  // the indexer: true turns unused into used; false, a throw or a non-boolean leave it unused; it is never asked of an
  // id the chain already shows
  let asked = 0;
  const idx = (x: unknown) => async (): Promise<boolean> => (asked++, x instanceof Error ? Promise.reject(x) : (x as boolean));
  assert.equal(await read(empty, empty, { indexer: idx(true) })(U1), "used");
  for (const x of [false, new Error("HTTP 500"), "yes", 1]) assert.equal(await read(empty, empty, { indexer: idx(x) })(U1), "unused", String(x));
  asked = 0;
  assert.equal(await read(used, used, { indexer: idx(false) })(U1), "used");
  assert.equal(asked, 0);
  await assert.rejects(read(empty, empty)("not-an-id"), /64-hex implicit account id/);
  assert.throws(() => nearIdReader("mainnet", [provider(FAST, empty), provider("https://rpc.mainnet.near.org", empty)]), /the RPCs must be one of/);
});

test("hostile answers fail the read, never read as unused: a halt, an error, a malformed view, UNKNOWN_ACCOUNT on a call", async () => {
  const empty = W({});
  const bad = (f: (p: Record<string, unknown>) => unknown) => nearIdReader("mainnet", [provider(FAST, empty, f), provider(DRPC, empty, f)], { first: () => 0, sleep: noSleep, tries: 2 })(U1);
  const on = (m: string, x: unknown) => (p: Record<string, unknown>) => (p.method_name === m || p.request_type === m ? x : undefined);
  await assert.rejects(bad(on("storage_balance_of", { jsonrpc: "2.0", result: { error: "wasm execution failed with error: Smart contract panicked: FiatToken: paused", logs: [], block_height: 1, block_hash: hashOf(1) } })), /the token is halted \(FiatToken: paused\)/);
  await assert.rejects(bad(on("storage_balance_of", { jsonrpc: "2.0", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } })), /storage_balance_of: HANDLER_ERROR/);
  await assert.rejects(bad(on("storage_balance_of", view({ total: 5 }))), /neither null nor a balance/);
  await assert.rejects(bad(on("mt_tokens_for_owner", view({}))), /not a token list/);
  await assert.rejects(bad(on("mt_tokens_for_owner", { jsonrpc: "2.0", result: { result: [0xff], block_height: 1, block_hash: hashOf(1) } })), /not JSON/);
  await assert.rejects(bad(on("view_account", { jsonrpc: "2.0", result: { block_height: 1, block_hash: hashOf(1) } })), /not an account/);
  await assert.rejects(bad(on("view_account", { jsonrpc: "2.0", error: { name: "TIMEOUT_ERROR" } })), /view_account: TIMEOUT_ERROR/);
  await assert.rejects(bad(on("view_account", "nope")), /not a JSON-RPC answer/);
  const money = W({ [U1]: { storage: true, tokens: { "nep141:a": 1n } } });
  const r = (f: (p: Record<string, unknown>) => unknown) => nearIdReader("mainnet", [provider(FAST, money, f), provider(DRPC, money, f)], { first: () => 0, sleep: noSleep, tries: 1 })(U1);
  await assert.rejects(r(on("ft_balance_of", view(-1))), /ft_balance_of: not a decimal string/);
  await assert.rejects(r(on("mt_batch_balance_of", view(["1", "2"]))), /not one balance per token/);
});

test("retries: a view is retried with doubling backoff on its provider, then the id's read falls over to the other one", async () => {
  const empty = W({});
  const waits: number[] = [];
  const sleep = async (ms: number): Promise<void> => void waits.push(ms);
  let n = 0;
  // FastNEAR fails its first three storage reads and then answers: four tries, waits 250, 500, 1000
  const flaky = (p: Record<string, unknown>) => (p.method_name === "storage_balance_of" && n++ < 3 ? new Error("HTTP 429") : undefined);
  assert.equal(ID_READ_TRIES, 4);
  assert.equal(await nearIdReader("mainnet", [provider(FAST, empty, flaky), provider(DRPC, empty)], { first: () => 0, sleep })(U1), "unused");
  assert.deepEqual(waits, [250, 500, 1000]);
  // FastNEAR down: dRPC reads the id, and an unused answer needs FastNEAR's, so the id's read fails
  const down = () => new Error("HTTP 503");
  await assert.rejects(nearIdReader("mainnet", [provider(FAST, empty, down), provider(DRPC, empty)], { first: () => 0, sleep: noSleep })(U1), /rpc\.mainnet\.fastnear\.com: .*HTTP 503|HTTP 503/);
  // but money or a trace on the provider that answers is enough
  assert.equal(await nearIdReader("mainnet", [provider(FAST, W({ [U1]: { usdc: 1n } }), down), provider(DRPC, W({ [U1]: { usdc: 1n } }))], { first: () => 0, sleep: noSleep })(U1), "money");
  // a trace alone is not enough with the other provider down: it may hide money there (review F1)
  await assert.rejects(nearIdReader("mainnet", [provider(FAST, W({ [U2]: { account: true } })), provider(DRPC, W({}), down)], { first: () => 1, sleep: noSleep })(U2), /HTTP 503/);
});

// review F1: a provider that hides money behind a trace (answers used) is outvoted, whichever is read first
test("a provider hiding money behind a trace is outvoted, on either side and whichever is read first: token and intents money", async () => {
  const honestT = W({ [U1]: { storage: true, usdc: 9n, account: true } });
  const lieT = W({ [U1]: { storage: true, usdc: 0n, account: true } });
  const honestI = W({ [U1]: { tokens: { "nep141:x": 5n } } });
  const lieI = W({ [U1]: { account: true } });
  for (const [label, liar, honest] of [["token", lieT, honestT], ["intents", lieI, honestI]] as const) {
    for (const liarAt of [0, 1]) {
      for (const f of [0, 1]) {
        const worlds = liarAt === 0 ? [liar, honest] : [honest, liar];
        const got = await nearIdReader("mainnet", [provider(FAST, worlds[0]!), provider(DRPC, worlds[1]!)], { first: () => f, sleep: noSleep, tries: 1 })(U1);
        assert.equal(got, "money", `${label} money, the liar ${liarAt === 0 ? "FastNEAR" : "dRPC"}, ${f === liarAt ? "the liar" : "the honest one"} read first`);
      }
    }
  }
});

// review F6 (b): every view of an id is read at one block, so money moving between two views never reads as used
test("one block per id: money moved out between two views still reads as money; a view at another block fails the read", async () => {
  // at block 10 U holds 9 USDC; at block 11 it was moved out (U's storage on the token stays)
  const heights = [W({ [U1]: { usdc: 9n } }), W({ [U1]: { storage: true } })];
  let tip = 10;
  const asked: unknown[] = [];
  const chain = (url: string, skew = 0): NearRpc => ({
    name: url,
    query: async (params) => {
      if (params.account_id === "intents.near" && params.request_type === "view_account") return { jsonrpc: "2.0", result: { amount: "1", block_height: 10, block_hash: hashOf(10) } };
      asked.push(params.block_id ?? params.finality);
      const h = heightOf(params, tip);
      const a = answer(heights[h - 10]!, params) as { result?: { block_height?: number; block_hash?: string } };
      if (a.result) Object.assign(a.result, { block_height: h + skew, block_hash: hashOf(h + skew) });
      tip = 11; // the money moves right after the first view is answered
      return a;
    },
  });
  assert.equal(await nearIdReader("mainnet", [chain(FAST), chain(DRPC)], { first: () => 0, sleep: noSleep, tries: 1 })(U1), "money");
  assert.deepEqual(asked, ["final", hashOf(10)], "the first view at final, the next at its block's hash");
  tip = 10;
  await assert.rejects(nearIdReader("mainnet", [chain(FAST, 1), chain(DRPC, 1)], { first: () => 0, sleep: noSleep, tries: 1 })(U1), new RegExp(`answered at block 12 ${hashOf(12)}, not 11 ${hashOf(11)}`));
});

// review N1: one lying provider drawn first must not pick an old block, at which the honest one then truthfully reads
// U before its money landed. The floor (both finals within 120 blocks, the lower of the two) bounds the first view,
// and every later view names the first one's hash, so the other provider confirms the very block.
test("the floor and the pinned hash: a liar naming an old block, first or second, or a fake hash never makes money unused", async () => {
  const FINAL = 1000;
  // an honest chain: U's money landed at block 900
  const honest = (url: string, final = FINAL, shows = W({ [U1]: { usdc: 9n, storage: true } })): NearRpc => ({
    name: url,
    query: async (params) => {
      const h = heightOf(params, final);
      if (typeof params.block_id === "string" && h > final) return { jsonrpc: "2.0", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_BLOCK" } } };
      if (params.account_id === "intents.near" && params.request_type === "view_account") return { jsonrpc: "2.0", result: { amount: "1", block_height: h, block_hash: hashOf(h) } };
      const a = answer(h >= 900 ? shows : W({}), params) as { result?: Record<string, unknown> };
      if (a.result) Object.assign(a.result, { block_height: h, block_hash: hashOf(h) });
      return a;
    },
  });
  // the liar: honest answers, but every view it is asked at final it answers at block 800 (served back, a real block)
  const liar = (url: string): NearRpc => {
    const h = honest(url);
    return { name: url, query: async (p) => h.query(p.finality === "final" && !(p.account_id === "intents.near" && p.request_type === "view_account") ? { ...p, finality: undefined, block_id: hashOf(800) } : p) };
  };
  for (const f of [0, 1]) {
    const got = await nearIdReader("mainnet", [liar(FAST), honest(DRPC)], { first: () => f, sleep: noSleep, tries: 1 })(U1).then((x) => x, (e: Error) => e.message);
    // the liar first: its block 800 is under the floor 1000, so its read fails; the honest one shows money, enough
    // the honest first: its block 1000 is pinned, and the liar asked at that hash answers it, money
    assert.equal(got, "money", `${f === 0 ? "the liar" : "the honest one"} first`);
  }
  // with nothing on the honest side but a trace, the liar first fails the id: a failed read, never unused
  const trace = (url: string): NearRpc => ({ name: url, query: async (p) => {
    if (p.account_id === "intents.near" && p.request_type === "view_account") return { jsonrpc: "2.0", result: { amount: "1", block_height: FINAL, block_hash: hashOf(FINAL) } };
    const h = p.finality === "final" ? 800 : heightOf(p);
    const a = answer(W({}), p) as { result?: Record<string, unknown> };
    if (a.result) Object.assign(a.result, { block_height: h, block_hash: hashOf(h) });
    return a;
  } });
  await assert.rejects(nearIdReader("mainnet", [trace(FAST), honest(DRPC, FINAL, W({ [U1]: { storage: true } }))], { first: () => 0, sleep: noSleep, tries: 1 })(U1), /rpc\.mainnet\.fastnear\.com: storage_balance_of: answered at block 800, below the restore's floor 1000/);
  // a fake hash: the liar first answers "block 1000" with another block's views (U empty) under a hash that is not the
  // chain's; the honest one, asked at that hash, does not hold it (UNKNOWN_BLOCK), so the id's read fails
  const FAKE = "F".padEnd(44, "a");
  const fakeBlock = (url: string): NearRpc => ({ name: url, query: async (p) => {
    if (p.account_id === "intents.near" && p.request_type === "view_account") return honest(url).query(p);
    const a = answer(W({}), p) as { result?: Record<string, unknown> };
    if (a.result) Object.assign(a.result, { block_height: FINAL, block_hash: FAKE });
    return a;
  } });
  const holdsChain = (url: string): NearRpc => ({ name: url, query: async (p) => (p.block_id === FAKE ? { jsonrpc: "2.0", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_BLOCK" } } } : honest(url).query(p)) });
  await assert.rejects(nearIdReader("mainnet", [fakeBlock(FAST), holdsChain(DRPC)], { first: () => 0, sleep: noSleep, tries: 1 })(U1), /near\.drpc\.org: storage_balance_of: HANDLER_ERROR/);
  // heads more than 120 blocks apart: the reader does not open, by name
  await assert.rejects(openIdReader("mainnet", [honest(FAST, 1000), honest(DRPC, 1121)], { sleep: noSleep, tries: 1 }), /the RPCs' final heights 1000 and 1121 are over 120 blocks apart; the restore does not start/);
  await assert.rejects(openBalanceReader("mainnet", [honest(FAST, 1121), honest(DRPC, 1000)], { sleep: noSleep, tries: 1 }), /over 120 blocks apart/);
  assert.equal(typeof (await openIdReader("mainnet", [honest(FAST, 1000), honest(DRPC, 1120)], { sleep: noSleep, tries: 1 })), "function", "120 apart opens");
  // the balance reader holds the same floor: a liar's old block fails its read, and the honest one's money is enough
  assert.equal(await nearBalanceReader("mainnet", [liar(FAST), honest(DRPC)], { first: () => 0, sleep: noSleep, tries: 1 })("usdc", U1), 9n);
});

// ---------- step 5's R/V/A balances (restore/arms.ts BalanceReader) ----------
test("the R/V/A balance reader on mainnet's answers, and above 0 on either provider is enough, 0 only on both", async () => {
  const live = (f: number) => nearBalanceReader("mainnet", [replay(FAST), replay(DRPC)], { first: () => f, tries: 1 });
  for (const f of [0, 1]) {
    assert.equal(await live(f)("usdc", REC.ids.money_usdc!), 3_000_668n);
    assert.equal(await live(f)("near", REC.ids.used_account!), 20_000_000_000_000_000_000_000n);
    assert.equal(await live(f)("near", REC.ids.never_used!), 0n, "no account is 0 NEAR, on both");
    assert.ok((await live(f)("intents", REC.ids.money_intents!)) > 0n);
  }
  const empty = W({});
  const rich = W({ [U1]: { usdc: 7n, tokens: { "nep141:a": 2n, "nep141:b": 3n }, account: true } });
  const b = (x: Map<string, Id>, y: Map<string, Id>, fx?: () => unknown) => nearBalanceReader("mainnet", [provider(FAST, x, fx), provider(DRPC, y)], { first: () => 0, sleep: noSleep });
  assert.equal(await b(empty, rich)("usdc", U1), 7n, "the second provider shows what the first hid");
  assert.equal(await b(rich, empty)("intents", U1), 5n);
  assert.equal(await b(empty, empty)("usdc", U1), 0n);
  await assert.rejects(b(empty, empty, () => new Error("HTTP 503"))("usdc", U1), /HTTP 503/, "a 0 needs both providers");
  assert.equal(await b(rich, rich, () => new Error("HTTP 503"))("usdc", U1), 7n, "the provider up shows money: enough");
  const halted = () => ({ jsonrpc: "2.0", result: { error: "Smart contract panicked: FiatToken: paused", logs: [], block_height: 1, block_hash: hashOf(1) } });
  await assert.rejects(nearBalanceReader("mainnet", [provider(FAST, rich, halted), provider(DRPC, rich, halted)], { first: () => 0, sleep: noSleep, tries: 1 })("usdc", U1), /FiatToken: paused/);
  await assert.rejects(b(rich, rich)("gas" as "usdc", U1), /unknown read/);
});

// ---------- whole step 5 restores on failing providers (review 2, gap 2) ----------
const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const SCOPE = vaultScopeOf(keccak_256, "vault.bf-restore.testnet", "usdc.fakes.testnet");
const at = (lane: number, k: number) => lane + 8 * k;
const id = (i: number) => depositAccount(SEED, SCOPE, i).account;
const dep = (i: number): RestoredNote => ({ ref: { kind: "deposit", s: SCOPE, i }, scope: SCOPE, precommitment: 0n, leaf: { value: 1n, label: 1n, commitment: 1n, leafIndex: 0n }, state: "UNSPENT" });
// lane 0: a note at 0; lane 2: money at its 15th index; lane 5: a used id at its 21st and money at its 40th
const R: Pick<NoteRestore, "notes" | "laneHighest" | "laneWalked"> = {
  notes: [dep(0)],
  laneHighest: [0, null, null, null, null, null, null, null],
  laneWalked: Array.from({ length: RESTORE_LANES }, (_, l) => (l === 0 ? 0 : l - RESTORE_LANES) + RESTORE_LANES * RESTORE_GAP),
};
const WORLD = W({ [id(at(2, 14))]: { usdc: 9n }, [id(at(5, 20))]: { storage: true }, [id(at(5, 39))]: { tokens: { "nep141:wrap.near": 4n } } });
// a seeded generator, so every run of the test fails the same reads
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s + 0x6d2b79f5) >>> 0), (((s ^ (s >>> 15)) * (s | 1)) >>> 0) / 0x1_0000_0000);
}
const shape = (lanes: Awaited<ReturnType<typeof restoreDepositIds>>) => lanes.map((x) => [x.lane, x.money, x.used, x.highest]);

test("restores at 10% and at 20% per-read failures finish, 40 of 40 each, and find every money and trace", { timeout: 120_000 }, async () => {
  const want = shape(await restoreDepositIds(SEED, SCOPE, R, nearIdReader("mainnet", [provider(FAST, WORLD), provider(DRPC, WORLD)], { sleep: noSleep })));
  assert.deepEqual(want[2], [2, [at(2, 14)], [], at(2, 14)]);
  assert.deepEqual(want[5], [5, [at(5, 39)], [at(5, 20)], at(5, 39)]);
  const seen: Record<string, number> = {};
  for (const rate of [0.1, 0.2]) {
    let finished = 0;
    let unread = 0;
    for (let k = 0; k < 40; k++) {
      const r = rng(1_000 * rate + k);
      const fail = () => (r() < rate ? new Error("HTTP 429") : undefined);
      const got = await restoreDepositIds(SEED, SCOPE, R, nearIdReader("mainnet", [provider(FAST, WORLD, fail), provider(DRPC, WORLD, fail)], { sleep: noSleep, first: () => (r() < 0.5 ? 0 : 1) }));
      finished++;
      for (const [lane, , , ] of want) {
        const x = got[lane as number]!;
        const w = want[lane as number]!;
        const unreadAt = new Set(x.unread.map((u) => u.i));
        // every id the world shows money or a trace at is found as such, or listed unread (which steps 5 and 7 treat as
        // money): never read as unused
        for (const i of w[1] as number[]) assert.ok(x.money.includes(i) || unreadAt.has(i), `rate ${rate}, run ${k}: money at ${i} lost`);
        for (const i of w[2] as number[]) assert.ok(x.used.includes(i) || unreadAt.has(i), `rate ${rate}, run ${k}: the trace at ${i} lost`);
        assert.ok(x.highest !== null || w[3] === null);
        if (w[3] !== null) assert.ok(x.highest! >= (w[3] as number), `rate ${rate}, run ${k}: lane ${lane} ends below its money`);
        unread += x.unread.length;
      }
    }
    assert.equal(finished, 40, `rate ${rate}`);
    seen[String(rate)] = unread;
  }
  // a few id reads still fail after every retry on both providers at these rates; each is listed, never a stop
  assert.ok(seen["0.1"]! < seen["0.2"]!, JSON.stringify(seen));
});

test("a provider always down ends the restore with the lane's named error; so do both down", async () => {
  const down = () => new Error("HTTP 503");
  for (const rpcs of [[provider(FAST, WORLD, down), provider(DRPC, WORLD)], [provider(FAST, WORLD), provider(DRPC, WORLD, down)], [provider(FAST, WORLD, down), provider(DRPC, WORLD, down)]] as const) {
    await assert.rejects(
      restoreDepositIds(SEED, SCOPE, R, nearIdReader("mainnet", rpcs, { sleep: noSleep })),
      new RegExp(`^Error: lane 0: ${DEPOSIT_ID_MARGIN} id reads failed with none showing history between them \\(the last at index ${at(0, DEPOSIT_ID_MARGIN - 1)}: .*HTTP 503\\); the restore stops, to be retried$`),
    );
  }
});

// review N2 (the reviewer's Q3): one provider read first fakes money on a used, empty id; money ends the id's read, so
// no second read outvotes it, and step 7 still re-reads the id on each open
test("a faked money on a used, empty id keeps it in step 7's re-reads", async () => {
  const u = at(3, 1);
  const world = W({ [id(u)]: { storage: true } });
  const fake = (p: Record<string, unknown>) => (argsOf(p).account_id === id(u) && p.method_name === "ft_balance_of" ? view("5") : undefined);
  const lanes = await restoreDepositIds(SEED, SCOPE, R, nearIdReader("mainnet", [provider(FAST, world, fake), provider(DRPC, world)], { first: () => 0, sleep: noSleep, tries: 1 }));
  assert.deepEqual(lanes[3]!.money, [u], "the faked money is taken (nothing outvotes money)");
  const plan = await afterRestore(SEED, { lane: 0, raiseDepositIndex: async (_s, m) => m }, SCOPE, lanes, 1_762_600_000_000);
  assert.ok(plan.rereads.some((x) => x.i === u), "the id is re-read until its move lands");
});
