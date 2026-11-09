// The restore's IdReader on NEAR (card wallet-restore-id-reader; docs/plan1/wallet.md §2.3 "Restore" step 5,
// l.297-324): each rule replayed on mainnet answers (test/vectors/id-reader-mainnet.json, test/record-id-reader.mjs),
// the two-provider rule and the indexer on a fake world, and whole step 5 restores on providers that fail.
//   node --test test/restore-id-reader.test.ts      (from packages/wallet)
// Test secrets: the all-zero BIP-39 entropy (test/vectors/a8.json), never money.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { resetPaces } from "../src/pace.ts";
import * as P from "../src/pace.ts";
// each test's clock starts at its own zero: one pace per provider URL is shared by every reader (card wallet-id-reader-paced)
beforeEach(() => resetPaces());
import { keccak_256 } from "@noble/hashes/sha3.js";
import { VAULT_CONSTANTS, vaultScopeOf } from "@blindfill/kit";
import * as d from "../src/derive/index.ts";
import { depositAccount, NEAR_NETWORKS, type NearRpc } from "../src/deposit/account.ts";
import { RESTORE_GAP, RESTORE_LANES, type NoteRestore, type RestoredNote } from "../src/notes/restore.ts";
import { ID_READ_TRIES, nearBalanceReader as balanceAt, nearIdReader as idReaderAt, openRestorePass, passTimeMs, PASS_TRIES, PASS_WAIT_MS, type RestorePass } from "../src/restore/id-reader.ts";
// the names card wallet-id-reader-paced adds, read off the module, so this file still loads where they are missing and
// each test that needs one fails on its own
import * as IDR from "../src/restore/id-reader.ts";
import { rereadOnOpen, secondScan, type AfterRpc } from "../src/restore/after.ts";
import { afterRestore, DEPOSIT_ID_MARGIN, REREAD_MS, restoreDepositIds as depositIds, type IdReader } from "../src/restore/wallets.ts";

const FAST = "https://rpc.mainnet.fastnear.com";
const DRPC = "https://near.drpc.org";
const USDC = NEAR_NETWORKS.mainnet.usdc;
const REC = JSON.parse(readFileSync(new URL("./vectors/id-reader-mainnet.json", import.meta.url), "utf8")) as {
  ids: Record<string, string>;
  states: Record<string, string[]>;
  answers: Record<string, unknown[]>;
  pass: { h: number; hash: string };
  intents: Record<string, { tokens: unknown; held: unknown }>;
};
const noSleep = async (): Promise<void> => {};
// the pair's disagreement (card wallet-id-reader-paced), naming the provider with the stronger answer
const isPair = (e: unknown, stronger: string): boolean => e instanceof Error && e.name === "PairDisagrees" && (e as { stronger?: unknown }).stronger === stronger;
// the readers read at a restore pass's one block (openRestorePass). These open one for each reader on its own
// providers (the replay's: the one pass recorded, opened once below), so a refused pass fails every read, and a bad
// network or pair still throws at once
const REPLAYED = new WeakSet<NearRpc>();
let LIVE: RestorePass | undefined;
const passFor = (rpcs: readonly [NearRpc, NearRpc], opts: { tries?: number; sleep?: (ms: number) => Promise<void> }): Promise<RestorePass> =>
  REPLAYED.has(rpcs[0]) && REPLAYED.has(rpcs[1]) && LIVE ? Promise.resolve(LIVE) : openRestorePass("mainnet", rpcs, { sleep: noSleep, ...(opts.tries === undefined ? {} : { tries: opts.tries }), ...(opts.sleep ? { sleep: opts.sleep } : {}) });
const nearIdReader = (network: "mainnet", rpcs: readonly [NearRpc, NearRpc], opts: Parameters<typeof idReaderAt>[3] = {}): IdReader => {
  // the pace's waits are stubbed unless a test gives its own sleep (its virtual clock moves by them)
  const p = passFor(rpcs, opts).then((pass) => idReaderAt(network, rpcs, pass, { sleep: noSleep, ...opts }));
  p.catch(() => {});
  return (u) => p.then((f) => f(u));
};
const nearBalanceReader = (network: "mainnet", rpcs: readonly [NearRpc, NearRpc], opts: Parameters<typeof balanceAt>[3] = {}) => {
  const p = passFor(rpcs, opts).then((pass) => balanceAt(network, rpcs, pass, { sleep: noSleep, ...opts }));
  p.catch(() => {});
  return (what: "usdc" | "near" | "intents", u: string) => p.then((f) => f(what, u));
};
const restoreDepositIds = async (...a: Parameters<typeof depositIds>) => (await depositIds(...a)).lanes;
// the block each recorded hash names
const HEIGHT = new Map<string, number>();
for (const xs of Object.values(REC.answers)) for (const a of xs as { result?: { block_hash?: string; block_height?: number } }[]) if (a.result?.block_hash) HEIGHT.set(a.result.block_hash, a.result.block_height!);
const argsOf = (p: Record<string, unknown>): Record<string, unknown> => (typeof p.args_base64 === "string" ? JSON.parse(Buffer.from(p.args_base64, "base64").toString()) : {});

// a provider that answers from the recorded mainnet answers, by its URL and the exact params: a request asked more than
// once gets the recorded answers in their order, then the last again (the pass's final reads repeat while one catches
// up). One object per URL, as a pass holds its two providers by identity; each test sets its log and swap.
const served = new Map<string, number>();
const replays = new Map<string, { rpc: NearRpc; log: string[]; swap: (p: Record<string, unknown>) => unknown }>();
function replay(url: string, log: string[] = [], swap: (p: Record<string, unknown>) => unknown = () => undefined): NearRpc {
  const had = replays.get(url);
  if (had) return Object.assign(had, { log, swap }).rpc;
  const me = { rpc: undefined as unknown as NearRpc, log, swap };
  const rpc: NearRpc = {
    name: url,
    query: async (params) => {
      me.log.push(`${url.replace("https://", "")} ${String(params.method_name ?? params.request_type)}`);
      const s = me.swap(params);
      if (s !== undefined) return s;
      const k = `${url} ${JSON.stringify(params)}`;
      const xs = REC.answers[k];
      if (xs === undefined) throw new Error(`no recorded answer for ${JSON.stringify(params)}`);
      const n = served.get(k) ?? 0;
      served.set(k, n + 1);
      return xs[Math.min(n, xs.length - 1)];
    },
  };
  me.rpc = rpc;
  replays.set(url, me);
  REPLAYED.add(rpc);
  return rpc;
}
// the recorded pass, opened once on the recorded answers: both finals, the one behind re-read, the block on both
LIVE = await openRestorePass("mainnet", [replay(FAST), replay(DRPC)], { sleep: noSleep });
assert.deepEqual([LIVE.h, LIVE.hash], [REC.pass.h, REC.pass.hash]);

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
  // never used: both providers read in full (storage, tokens, account on each), both at once; money: both, each to its
  // money (card wallet-id-reader-paced: the pair is read in parallel, and both must agree)
  const log: string[] = [];
  const by = (host: string) => log.filter((l) => l.startsWith(host));
  await nearIdReader("mainnet", [replay(FAST, log), replay(DRPC, log)], { first: () => 0, tries: 1 })(REC.ids.never_used!);
  assert.deepEqual(by("rpc.mainnet.fastnear.com"), ["rpc.mainnet.fastnear.com view_account", "rpc.mainnet.fastnear.com storage_balance_of", "rpc.mainnet.fastnear.com mt_tokens_for_owner", "rpc.mainnet.fastnear.com view_account"]);
  assert.deepEqual(by("near.drpc.org"), ["near.drpc.org view_account", "near.drpc.org storage_balance_of", "near.drpc.org mt_tokens_for_owner", "near.drpc.org view_account"]);
  log.length = 0;
  await nearIdReader("mainnet", [replay(FAST, log), replay(DRPC, log)], { first: () => 1, tries: 1 })(REC.ids.money_usdc!);
  assert.deepEqual(by("near.drpc.org"), ["near.drpc.org view_account", "near.drpc.org storage_balance_of", "near.drpc.org ft_balance_of"]);
  assert.deepEqual(by("rpc.mainnet.fastnear.com"), ["rpc.mainnet.fastnear.com view_account", "rpc.mainnet.fastnear.com storage_balance_of", "rpc.mainnet.fastnear.com ft_balance_of"]);
});

test("the intents.near branch on mainnet's answers: tokens listed above zero are money", async () => {
  // never_used's token views and account, with money_intents's real intents.near answers in place of its own
  const u = REC.ids.never_used!;
  const intents = (url: string) => (p: Record<string, unknown>) => {
    if (p.account_id !== "intents.near" || p.request_type === "view_account") return undefined; // the reader's finals are their own
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
const heightOf = (p: Record<string, unknown>, final = 1): number =>
  typeof p.block_id === "string" ? Number([...(p.block_id as string).slice(1).replace(/z+$/, "")].map((c) => "abcdefghij".indexOf(c)).join("")) : typeof p.block_id === "number" ? p.block_id : final;
const view = (x: unknown, h = 1) => ({ jsonrpc: "2.0", result: { result: [...Buffer.from(JSON.stringify(x))], logs: [], block_height: h, block_hash: hashOf(h) } });
const unknown = (id: string) => ({ jsonrpc: "2.0", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: id } } } });
function answer(world: Map<string, Id>, p: Record<string, unknown>): unknown {
  const args = argsOf(p);
  const u = (p.request_type === "view_account" ? p.account_id : args.account_id) as string;
  const x = world.get(u) ?? {};
  const acct = { jsonrpc: "2.0", result: { amount: "1", locked: "0", storage_usage: 182, block_height: 1, block_hash: hashOf(1) } };
  if (p.request_type === "view_account" && u === "intents.near") return acct; // the pass's reads
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
      // the pass's reads answer: these tests fail id reads; the pass's own tests use their own providers
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

test("unused only when both providers say so; a pair that disagrees at the pass's block concludes nothing and names the provider with the stronger answer; an indexer may add used, never unused", async () => {
  const empty = W({});
  const used = W({ [U1]: { account: true } });
  const read = (a: Map<string, Id>, b: Map<string, Id>, opts = {}) => nearIdReader("mainnet", [provider(FAST, a), provider(DRPC, b)], { first: () => 0, sleep: noSleep, ...opts });
  assert.equal(await read(empty, empty)(U1), "unused");
  assert.equal(await read(used, used)(U1), "used");
  assert.equal(await read(W({ [U1]: { usdc: 5n } }), W({ [U1]: { usdc: 5n } }))(U1), "money");
  // card wallet-id-reader-paced (review P2-3): two providers at one block hash read one state, so a disagreement means
  // one of them is wrong: nothing is concluded on either's word, and the read stops naming the one that would read on
  const stops = (a: Map<string, Id>, b: Map<string, Id>, stronger: string, said: RegExp) =>
    assert.rejects(read(a, b)(U1), (e: unknown) => isPair(e, stronger) && said.test((e as Error).message));
  await stops(empty, used, DRPC, /near\.drpc\.org answered used where https:\/\/rpc\.mainnet\.fastnear\.com answered unused at block/);
  await stops(empty, W({ [U1]: { usdc: 5n } }), DRPC, /answered money where .* answered unused/);
  await stops(W({ [U1]: { storage: true } }), empty, FAST, /fastnear\.com answered used where .* answered unused/);
  // review F6 (a): a token listed at 0 is no trace (intents.near at 16d04f6 deletes a balance that falls to 0)
  assert.equal(await read(W({ [U1]: { tokens: { "nep141:a": 0n } } }), empty)(U1), "unused", "a token listed at zero");
  await stops(W({ [U1]: { tokens: { "nep141:a": 0n, "nep141:b": 3n } } }), empty, FAST, /answered money where/);
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
  // the backoff's waits, in order; any other is a pace slot (card wallet-id-reader-paced), no longer than FastNEAR's gap
  assert.deepEqual(waits.slice(0, 3), [250, 500, 1000]);
  assert.ok(waits.slice(3).every((w) => w <= 1000 / IDR.PACE.fastnear.perSec), `pace slots ${waits.slice(3).join(", ")}`);
  // FastNEAR down: dRPC reads the id, and an unused answer needs FastNEAR's, so the id's read fails
  const down = () => new Error("HTTP 503");
  await assert.rejects(nearIdReader("mainnet", [provider(FAST, empty, down), provider(DRPC, empty)], { first: () => 0, sleep: noSleep })(U1), /rpc\.mainnet\.fastnear\.com: .*HTTP 503|HTTP 503/);
  // money on the provider that answers is that provider's word alone, so the read fails too (card
  // wallet-id-reader-paced; step 5 counts a failed id as money all the same, and never reads a lane on at one word)
  await assert.rejects(nearIdReader("mainnet", [provider(FAST, W({ [U1]: { usdc: 1n } }), down), provider(DRPC, W({ [U1]: { usdc: 1n } }))], { first: () => 0, sleep: noSleep })(U1), /HTTP 503/);
  // a trace alone is not enough with the other provider down: it may hide money there (review F1)
  await assert.rejects(nearIdReader("mainnet", [provider(FAST, W({ [U2]: { account: true } })), provider(DRPC, W({}), down)], { first: () => 1, sleep: noSleep })(U2), /HTTP 503/);
});

// review F1: a provider that hides money behind a trace (answers used) never decides the id: the read stops, naming the
// provider that shows the money, whichever is drawn first (card wallet-id-reader-paced: the pair's disagreement)
test("a provider hiding money behind a trace stops the read, on either side and whichever is drawn first: token and intents money", async () => {
  const honestT = W({ [U1]: { storage: true, usdc: 9n, account: true } });
  const lieT = W({ [U1]: { storage: true, usdc: 0n, account: true } });
  const honestI = W({ [U1]: { tokens: { "nep141:x": 5n } } });
  const lieI = W({ [U1]: { account: true } });
  for (const [label, liar, honest] of [["token", lieT, honestT], ["intents", lieI, honestI]] as const) {
    for (const liarAt of [0, 1]) {
      for (const f of [0, 1]) {
        const worlds = liarAt === 0 ? [liar, honest] : [honest, liar];
        const honestName = liarAt === 0 ? DRPC : FAST;
        await assert.rejects(nearIdReader("mainnet", [provider(FAST, worlds[0]!), provider(DRPC, worlds[1]!)], { first: () => f, sleep: noSleep, tries: 1 })(U1),
          (e: unknown) => isPair(e, honestName) && /answered money where .* answered used/.test((e as Error).message),
          `${label} money, the liar ${liarAt === 0 ? "FastNEAR" : "dRPC"}, ${f === liarAt ? "the liar" : "the honest one"} drawn first`);
      }
    }
  }
});

// review F6 (b): every view is read at the pass's one block, so money moving between two views never reads as used
test("one block for the pass: money moved out between two views still reads as money; a view at another block fails the read", async () => {
  // at block 10 U holds 9 USDC; at block 11 it was moved out (U's storage on the token stays)
  const heights = [W({ [U1]: { usdc: 9n } }), W({ [U1]: { storage: true } })];
  let tip = 10;
  const asked: unknown[] = [];
  const chain = (url: string, skew = 0): NearRpc => ({
    name: url,
    query: async (params) => {
      const h = heightOf(params, tip);
      if (params.account_id === "intents.near" && params.request_type === "view_account") return { jsonrpc: "2.0", result: { amount: "1", block_height: h, block_hash: hashOf(h) } };
      asked.push(params.block_id ?? params.finality);
      const a = answer(heights[h - 10]!, params) as { result?: { block_height?: number; block_hash?: string } };
      if (a.result) Object.assign(a.result, { block_height: h + skew, block_hash: hashOf(h + skew) });
      tip = 11; // the money moves right after the first view is answered
      return a;
    },
  });
  assert.equal(await nearIdReader("mainnet", [chain(FAST), chain(DRPC)], { first: () => 0, sleep: noSleep, tries: 1 })(U1), "money");
  assert.deepEqual(asked, [hashOf(10), hashOf(10), hashOf(10), hashOf(10)], "every view at the pass's block, by its hash (both providers, each to its money)");
  tip = 10;
  await assert.rejects(nearIdReader("mainnet", [chain(FAST, 1), chain(DRPC, 1)], { first: () => 0, sleep: noSleep, tries: 1 })(U1), new RegExp(`answered at block 11 ${hashOf(11)}, not 10 ${hashOf(10)}`));
});

// review N1 and its fold: no single provider picks the block. The pass's floor is the higher final, the provider behind
// is re-read until it reaches it (bounded), and the block's hash must agree on both; every view is at that hash.
test("the pass: a liar's low final, a high one, a fake hash, heads over 120 apart; a lagging honest provider catching up", async () => {
  // a chain whose U holds 9 USDC from block 980; `finals` gives each final read's height in turn (the last repeats)
  const chain = (url: string, finals: number[], o: { fake?: number; reads?: { n: number } } = {}): NearRpc => {
    let k = 0;
    return {
      name: url,
      query: async (p) => {
        const isFinal = p.finality === "final";
        if (isFinal && o.reads && ++o.reads.n > 50) throw new Error("read on past any bound");
        const h = isFinal ? finals[Math.min(k++, finals.length - 1)]! : heightOf(p);
        const hash = h === o.fake ? "F".padEnd(44, "a") : hashOf(h);
        if (typeof p.block_id === "string" && p.block_id !== hash) return { jsonrpc: "2.0", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_BLOCK" } } };
        if (p.account_id === "intents.near" && p.request_type === "view_account") return { jsonrpc: "2.0", result: { amount: "1", block_height: h, block_hash: hash } };
        const a = answer(h >= 980 ? W({ [U1]: { usdc: 9n, storage: true } }) : W({}), p) as { result?: Record<string, unknown> };
        if (a.result) Object.assign(a.result, { block_height: h, block_hash: hash });
        return a;
      },
    };
  };
  const waits: number[] = [];
  const sleep = async (ms: number): Promise<void> => void waits.push(ms);
  // a liar's low final (950, a real block, before the money at 980): the floor is the honest 1000, the liar re-read
  // until it gives 1000, and U reads money at block 1000 whichever is read first
  for (const f of [0, 1]) {
    const liar = chain(FAST, [950, 1000]), honest = chain(DRPC, [1000]);
    const pass = await openRestorePass("mainnet", [liar, honest], { sleep: noSleep, tries: 1 });
    assert.equal(pass.h, 1000);
    assert.equal(await (await idReaderAt("mainnet", [liar, honest], pass, { first: () => f, sleep: noSleep, tries: 1 }))(U1), "money");
    assert.equal(await (await balanceAt("mainnet", [liar, honest], pass, { first: () => f, sleep: noSleep, tries: 1 }))("usdc", U1), 9n);
  }
  // a liar's high final (1050) the honest one never reaches: refused after PASS_TRIES re-reads, PASS_WAIT_MS apart
  assert.equal(PASS_TRIES, 10);
  assert.equal(PASS_WAIT_MS, 1_000);
  // (each part of this test on its own clock: the pace is one per provider URL)
  resetPaces();
  waits.length = 0;
  await assert.rejects(openRestorePass("mainnet", [chain(FAST, [1050]), chain(DRPC, [1000], { reads: { n: 0 } })], { sleep, tries: 1 }), /^Error: the RPCs' finals did not meet; the restore does not start \(https:\/\/near\.drpc\.org at 1000, the other at 1050\)$/);
  assert.deepEqual(waits, Array(10).fill(1_000), "about 10 s in all");
  // a liar that stays low is behind and never meets either: a stop, never a pass at its block
  await assert.rejects(openRestorePass("mainnet", [chain(FAST, [950], { reads: { n: 0 } }), chain(DRPC, [1000])], { sleep: noSleep, tries: 1 }), /finals did not meet/);
  // the two hashes of the floor block disagreeing: refused
  await assert.rejects(openRestorePass("mainnet", [chain(FAST, [1000], { fake: 1000 }), chain(DRPC, [1000])], { sleep: noSleep, tries: 1 }), new RegExp(`the RPCs' blocks at 1000 differ \\(${"F".padEnd(44, "a")}, ${hashOf(1000)}\\); the restore does not start`));
  // heads over 120 apart: refused at once, with no wait
  resetPaces();
  waits.length = 0;
  await assert.rejects(openRestorePass("mainnet", [chain(FAST, [1000]), chain(DRPC, [1121])], { sleep, tries: 1 }), /the RPCs' final heights 1000 and 1121 are over 120 blocks apart; the restore does not start/);
  assert.deepEqual(waits, []);
  // a lagging honest provider that catches up within the bound: opens at the higher final
  resetPaces();
  waits.length = 0;
  const lag = await openRestorePass("mainnet", [chain(FAST, [1000]), chain(DRPC, [995, 996, 998, 1000])], { sleep, tries: 1 });
  assert.deepEqual([lag.h, lag.hash, waits.length], [1000, hashOf(1000), 3]);
  // a pass is taken only from openRestorePass, and only on the providers it was opened on
  const a = chain(FAST, [1000]), b = chain(DRPC, [1000]);
  assert.throws(() => idReaderAt("mainnet", [a, b], { network: "mainnet", rpcs: [FAST, DRPC], h: 800, hash: hashOf(800) }), /not one openRestorePass opened/);
  assert.throws(() => balanceAt("mainnet", [b, a], lag), /opened on other RPCs/);
});

// review P1 and P2 (the reviewer's probe3): a pass at 1000, money landing at 1100, the chain at 1700. A reader built on
// the old pass would read the chain before the money with nothing erroring until the providers drop block 1000; a pass
// holds its two providers by identity. The steps that look for money after a height own their passes (below).
test("a stale pass is refused; a fresh one reads money; providers by identity", async () => {
  let tip = 1000;
  const chain = (url: string): NearRpc => ({
    name: url,
    query: async (p) => {
      const h = p.finality === "final" ? tip : heightOf(p);
      if (p.account_id === "intents.near" && p.request_type === "view_account") return { jsonrpc: "2.0", result: { amount: "1", block_height: h, block_hash: hashOf(h) } };
      const a = answer(h >= 1100 ? W({ [U1]: { usdc: 9n, storage: true } }) : W({}), p) as { result?: Record<string, unknown> };
      if (a.result) Object.assign(a.result, { block_height: h, block_hash: hashOf(h) });
      return a;
    },
  });
  const rpcs = [chain(FAST), chain(DRPC)] as const;
  const o = { sleep: noSleep, tries: 1 };
  const old = await openRestorePass("mainnet", rpcs, o);
  assert.equal(old.h, 1000);
  tip = 1700;
  const stale = new RegExp(`^StalePass: the pass at block 1000 is stale: the RPCs' finals are at 1700 and 1700, over 120 blocks past it; open a fresh pass$`);
  await assert.rejects(idReaderAt("mainnet", rpcs, old, { ...o, first: () => 0 }), stale);
  await assert.rejects(balanceAt("mainnet", rpcs, old, { ...o, first: () => 0 }), stale);
  const now = await openRestorePass("mainnet", rpcs, o);
  assert.equal(await (await idReaderAt("mainnet", rpcs, now, { ...o, first: () => 0 }))(U1), "money");
  assert.equal(await (await balanceAt("mainnet", rpcs, now, { ...o, first: () => 0 }))("usdc", U1), 9n);
  // 120 blocks past the pass is still fresh; 121 is not
  tip = 1820;
  await idReaderAt("mainnet", rpcs, now, o);
  tip = 1821;
  await assert.rejects(idReaderAt("mainnet", rpcs, now, o), /the pass at block 1700 is stale/);
  // freshness is judged against the higher final: an honest 1700 and a liar's 1000 refuse a pass at 1000 (the lower
  // final would take it)
  const liarLow: NearRpc = { name: FAST, query: async (p) => (p.finality === "final" ? { jsonrpc: "2.0", result: { amount: "1", block_height: 1000, block_hash: hashOf(1000) } } : rpcs[0].query(p)) };
  tip = 1000;
  const atLiar = await openRestorePass("mainnet", [liarLow, rpcs[1]], o);
  assert.equal(atLiar.h, 1000);
  tip = 1700;
  await assert.rejects(idReaderAt("mainnet", [liarLow, rpcs[1]], atLiar, o), /^StalePass: the pass at block 1000 is stale: the RPCs' finals are at 1000 and 1700, over 120 blocks past it; open a fresh pass$/);
  // P2: an object named as the release URL but not the one the pass was opened on is refused
  const lookalike: NearRpc = { name: FAST, query: rpcs[0].query };
  assert.throws(() => idReaderAt("mainnet", [lookalike, rpcs[1]], now, o), /the pass was opened on other RPCs/);
  // review R2: swapping a provider in the caller's own array after the open changes nothing the pass holds
  const arr: [NearRpc, NearRpc] = [rpcs[0], rpcs[1]];
  const mine = await openRestorePass("mainnet", arr, o);
  arr[0] = lookalike;
  assert.throws(() => idReaderAt("mainnet", arr, mine, o), /the pass was opened on other RPCs/);
  assert.equal(typeof (await idReaderAt("mainnet", rpcs, mine, o)), "function");
});

// ---------- step 7's owned steps (restore/after.ts; review R1, delta review 5) ----------
// A chain for the steps that look for money after a height: block h's time is T0 + (h - 1000) s; `tip` is every final
// (`vault` and `intents` lag the vault's and intents.near's view finals when set); money lands at block 1100 on the ids
// in `money`; the mainnet vault answers its views, empty; `block` answers headers, UNKNOWN_BLOCK for a skipped height.
const T0 = 1_762_600_000_000;
const timeOf = (h: number): number => T0 + (h - 1000) * 1000;
const MVAULT = NEAR_NETWORKS.mainnet.vault;
const MSCOPE = vaultScopeOf(keccak_256, MVAULT, USDC);
const mid = (i: number) => depositAccount(SEED, MSCOPE, i).account;
type StepWorld = { tip: number; vault?: number; intents?: number; skip?: Set<number>; finalMs?: number; restoreHash?: string; restoreMs?: number; retain?: number; blockMs?: number; failBlock?: number; blockTip?: number; money: string[] };
const tree = { size: 0, depth: 0, root: "0" };
const vaultConfig = { version: "blindfill-vault 0.1.0", asset: USDC, scope: String(MSCOPE), max_tree_depth: 32, min_deposit: "1000000", max_relay_fee_bps: 5000, page_max: VAULT_CONSTANTS.PAGE_MAX };
function stepChain(url: string, s: StepWorld): AfterRpc {
  const noBlock = { jsonrpc: "2.0", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_BLOCK" } } };
  return {
    name: url,
    query: async (p) => {
      const final = p.finality === "final";
      if (p.account_id === MVAULT) {
        const h = final ? (s.vault ?? s.tip) : heightOf(p);
        const m = p.method_name as string;
        return view(m === "config" ? vaultConfig : m === "state_tree" || m === "label_tree" ? tree : [], h);
      }
      const pass = p.account_id === "intents.near" && p.request_type === "view_account";
      const h = final ? (pass ? (s.intents ?? s.tip) : s.tip) : heightOf(p);
      if (pass) return { jsonrpc: "2.0", result: { amount: "1", block_height: h, block_hash: hashOf(h) } };
      const a = answer(h >= 1100 ? W(Object.fromEntries(s.money.map((u) => [u, { usdc: 9n, storage: true }]))) : W({}), p) as { result?: Record<string, unknown> };
      if (a.result) Object.assign(a.result, { block_height: h, block_hash: hashOf(h) });
      return a;
    },
    block: async (p) => {
      // `failBlock`: that many `block` reads fail first, a bare HTTP 429 (FastNEAR, delta review 7), then one UNKNOWN_BLOCK
      // from a node a block behind
      if (s.failBlock !== undefined && s.failBlock > 0) {
        s.failBlock--;
        if (s.failBlock > 0) throw new Error("HTTP 429");
        if ("block_id" in p) return noBlock;
      }
      const h = "block_id" in p ? p.block_id : (s.blockTip ?? s.tip);
      // `retain`: the depth a provider still serves a block by height (FastNEAR about 20.7 h, dRPC about 28 h, read 8 Nov)
      if ("block_id" in p && (h > s.tip || s.skip?.has(h) || (s.retain !== undefined && h < s.tip - s.retain))) return noBlock;
      const hash = h === 1000 && s.restoreHash ? s.restoreHash : hashOf(h);
      const ms = "finality" in p && s.finalMs !== undefined ? s.finalMs : h === 1000 && s.restoreMs !== undefined ? s.restoreMs : T0 + (h - 1000) * (s.blockMs ?? 1000);
      return { jsonrpc: "2.0", result: { header: { height: h, hash, timestamp_nanosec: String(BigInt(ms) * 1_000_000n) } } };
    },
  };
}
// one pair of provider objects over two worlds (a pass holds its providers by identity); set() changes both, or each
function stepPair(base: StepWorld) {
  const a: StepWorld = { ...base }, b: StepWorld = { ...base };
  const rpcs = [stepChain(FAST, a), stepChain(DRPC, b)] as const;
  const clear = { vault: undefined, intents: undefined, skip: undefined, finalMs: undefined, restoreHash: undefined, restoreMs: undefined, retain: undefined, blockMs: undefined, failBlock: undefined, blockTip: undefined };
  return { rpcs, set: (x: Partial<StepWorld>, y: Partial<StepWorld> = x) => void (Object.assign(a, clear, x), Object.assign(b, clear, y)) };
}
const so = { sleep: noSleep, tries: 1, first: () => 0 };
// the reviewer's probe5 chain: a note at 3 (lane 3), money landing at index 11 (lane 3, k=1) at block 1100
const r5 = (): Pick<NoteRestore, "notes" | "laneHighest" | "laneWalked"> => ({ notes: [dep(3)], laneHighest: [null, null, null, 3, null, null, null, null], laneWalked: Array.from({ length: 8 }, (_, l) => (l === 3 ? 3 : l - 8) + 8 * 10_000) });
const store = { lane: 0, raiseDepositIndex: async (_s: bigint, m: number) => m };

test("step 7's owned steps take no reader, pass height or clock: the probe5 ways in are gone or refused", async () => {
  const idMod = await import("../src/restore/id-reader.ts"), armsMod = await import("../src/restore/arms.ts"), walletsMod = await import("../src/restore/wallets.ts");
  for (const [m, names] of [[idMod, ["readerPast", "openRereadPass"]], [armsMod, ["secondScanDepositIds", "secondScanArmAccounts", "openSecondScanPass"]], [walletsMod, ["rereadsDue"]]] as const)
    for (const n of names) assert.equal(n in m, false, `${n} is off the surface`);
  const { rpcs, set } = stepPair({ tip: 1000, money: [id(11), mid(at(0, 1))] });
  const restored = await openRestorePass("mainnet", rpcs, so);
  const old = await idReaderAt("mainnet", rpcs, restored, so);
  const lanes = await restoreDepositIds(SEED, SCOPE, r5(), old);
  const plan = await afterRestore(SEED, store, SCOPE, lanes, restored);
  set({ tip: 1700 });
  // (a) a forged pass, or a copy of the real one: refused by both steps (a reader can no longer be handed in at all)
  for (const forged of [{ ...restored, h: 1e9 }, { ...restored }, { h: 1e9 }]) {
    await assert.rejects(rereadOnOpen({ network: "mainnet", rpcs, restored: forged as RestorePass, plan, opts: so }), /^Error: restored: the pass is not one openRestorePass opened on these RPCs$/);
    await assert.rejects(secondScan({ seed64: SEED, network: "mainnet", rpcs, restored: forged as RestorePass, wallets: { wallets: [], unread: [] }, gap: 3, opts: so }), /^Error: restored: the pass is not one openRestorePass opened on these RPCs$/);
  }
  // a real pass opened on other provider objects: refused
  await assert.rejects(rereadOnOpen({ network: "mainnet", rpcs: stepPair({ tip: 1700, money: [] }).rpcs, restored, plan, opts: so }), /not one openRestorePass opened on these RPCs/);
  // (b) afterRestore takes only a real pass (restore-wallets.test.ts holds the rest); a plan of another height is refused
  await assert.rejects(afterRestore(SEED, store, SCOPE, lanes, { h: 1 } as RestorePass), /^Error: restored: the pass is not one openRestorePass opened$/);
  await assert.rejects(rereadOnOpen({ network: "mainnet", rpcs, restored, plan: { ...plan, after: 1 }, opts: so }), /^Error: plan: not the restore's \(its block is not the pass's\)$/);
  // (c) the re-reads read on their own pass above the restore's: the money at 11 shows; the restore's reader still says unused
  assert.equal(await old(id(11)), "unused", "the restore's reader reads block 1000, before the money");
  const got = await rereadOnOpen({ network: "mainnet", rpcs, restored, plan, opts: so });
  assert.ok(got.due);
  assert.deepEqual(got.ids.find((x) => x.i === 11), { lane: 3, i: 11, id: id(11), state: "money" });
  assert.equal(got.ids.length, plan.rereads.length);
});

test("step 7's re-reads: due for 72 h of block time past the restore's block on both finals, on a pass above it", async () => {
  const { rpcs, set } = stepPair({ tip: 1000, money: [id(11)] });
  const restored = await openRestorePass("mainnet", rpcs, so);
  const plan = await afterRestore(SEED, store, SCOPE, await restoreDepositIds(SEED, SCOPE, r5(), await idReaderAt("mainnet", rpcs, restored, so)), restored);
  const run = () => rereadOnOpen({ network: "mainnet", rpcs, restored, plan, opts: so });
  // the pass is above the restore's block: at the restore's own tip it is refused, to be read again
  await assert.rejects(run(), /^Error: the pass at block 1000 is not past block 1000; read again once the chain is past it$/);
  // due until both finals are REREAD_MS past the restore block's time (block 1000 + 259,200 s)
  assert.equal(REREAD_MS, 72 * 3_600_000, "72 h of NEAR block time (a deposit address's life, D44)");
  const end = 1000 + 72 * 3_600;
  set({ tip: end - 1 });
  assert.equal((await run()).due, true);
  set({ tip: end });
  assert.deepEqual(await run(), { due: false });
  // one provider's final time lying late never ends the re-reads early: both must be past
  set({ tip: 2000, finalMs: timeOf(end) }, { tip: 2000 });
  assert.equal((await run()).due, true);
  set({ tip: 2000 }, { tip: 2000, finalMs: timeOf(end) });
  assert.equal((await run()).due, true);
});

test("step 7's second scan: due on its own reads of both finals and the bound block, the vault read past the bound, ids on a pass above it", async () => {
  const { rpcs, set } = stepPair({ tip: 1000, money: [mid(at(0, 1))] });
  const restored = await openRestorePass("mainnet", rpcs, so);
  const scan = () => secondScan({ seed64: SEED, network: "mainnet", rpcs, restored, wallets: { wallets: [], unread: [] }, gap: 3, opts: { ...so, margin: 2 } });
  // the bound: block 1601 (1000 + 600 + 1), its time T0 + 601 s; due once both finals are 2 min past it: past T0 + 721 s
  set({ tip: 1600 });
  assert.deepEqual(await scan(), { due: false }, "the height bound is not past");
  set({ tip: 1721 });
  assert.deepEqual(await scan(), { due: false }, "the bound block's 2 min are not past");
  set({ tip: 1722 });
  const got = await scan();
  assert.ok(got.due);
  assert.deepEqual(got.ids.lanes[0]!.money, [at(0, 1)], "the money after the restore's block shows");
  assert.ok(got.notes.height >= 1601, "the vault read at or past the bound block");
  // the vault's finals lagging below the bound: the scan's vault read refuses them (restoreNotes atLeast)
  set({ tip: 1722, vault: 1600 });
  await assert.rejects(scan(), /below the cursor's 1601/);
  // intents.near's finals at the bound: the scan's own pass is refused until it is above it
  set({ tip: 1722, intents: 1601 });
  await assert.rejects(scan(), /^Error: the pass at block 1601 is not past block 1601; read again once the chain is past it$/);
  // one provider's final time lying late is outvoted: due needs both
  set({ tip: 1721 }, { tip: 1721, finalMs: T0 + 3_600_000 });
  assert.deepEqual(await scan(), { due: false });
  // a skipped bound block: the next block's time is the bound (later, never earlier)
  set({ tip: 1722, skip: new Set([1601]) });
  assert.deepEqual(await scan(), { due: false }, "1602's time T0 + 602 s: due past T0 + 722 s");
  set({ tip: 1723, skip: new Set([1601]) });
  assert.equal((await scan()).due, true);
});

// delta review 6: the release pair stops serving a block by height after about 20.7 h (FastNEAR) and 28 h (dRPC), read
// on mainnet 8 Nov 19:58Z. The pass keeps its block's time from its open, read on both while served; the steps never
// read the restore block again, and the second scan's bound stands in a later block once the bound is old.
test("step 7's clock: the pass keeps its block's time from its open, agreed on both; the steps run on past the providers' block depth", async () => {
  const HOUR = 3_600; // blocks per hour at the world's 1 s
  const gc = { retain: Math.round(20.7 * HOUR) }, gcB = { retain: 28 * HOUR };
  // the pass's block header on both: the agreed hash and one time, or the open is refused (P2: one provider's early time
  // would end the re-reads at once)
  {
    const { rpcs, set } = stepPair({ tip: 1000, money: [] });
    set({}, { restoreHash: "F".padEnd(44, "a") });
    await assert.rejects(openRestorePass("mainnet", rpcs, so), /^Error: https:\/\/near\.drpc\.org: the pass's block 1000 is not \S+; the restore does not start$/);
    set({ restoreMs: timeOf(1000) - REREAD_MS }, {});
    await assert.rejects(openRestorePass("mainnet", rpcs, so), /^Error: the RPCs' times of the restore's block 1000 differ; the restore does not start$/);
    set({}, { restoreMs: timeOf(1000) - REREAD_MS });
    await assert.rejects(openRestorePass("mainnet", rpcs, so), /times of the restore's block 1000 differ/);
  }
  const { rpcs, set } = stepPair({ tip: 1000, money: [id(11), mid(at(0, 1))] });
  const restored = await openRestorePass("mainnet", rpcs, so);
  const plan = await afterRestore(SEED, store, SCOPE, await restoreDepositIds(SEED, SCOPE, r5(), await idReaderAt("mainnet", rpcs, restored, so)), restored);
  // a header naming another time for block 1000 after the open changes nothing: the block is not read again
  set({ tip: 2000, restoreMs: timeOf(1000) - REREAD_MS }, { tip: 2000, restoreMs: timeOf(1000) - REREAD_MS });
  assert.equal((await rereadOnOpen({ network: "mainnet", rpcs, restored, plan, opts: so })).due, true);
  // 21 h on: FastNEAR no longer serves block 1000; the re-reads still read the money at 11
  const at21 = 1000 + 21 * HOUR;
  set({ tip: at21, ...gc }, { tip: at21, ...gcB });
  const got = await rereadOnOpen({ network: "mainnet", rpcs, restored, plan, opts: so });
  assert.ok(got.due);
  assert.deepEqual(got.ids.find((x) => x.i === 11), { lane: 3, i: 11, id: id(11), state: "money" });
  // the second scan first run then: due, on a later block's time for the long-gone bound block, and it reads
  const scanned = await secondScan({ seed64: SEED, network: "mainnet", rpcs, restored, wallets: { wallets: [], unread: [] }, gap: 3, opts: { ...so, margin: 2 } });
  assert.ok(scanned.due);
  assert.deepEqual(scanned.ids.lanes[0]!.money, [at(0, 1)]);
  // past 72 h on both: the re-reads end, never throwing
  const at73 = 1000 + 73 * HOUR;
  set({ tip: at73, ...gc }, { tip: at73, ...gcB });
  assert.deepEqual(await rereadOnOpen({ network: "mainnet", rpcs, restored, plan, opts: so }), { due: false });
});

// delta review 7: the header reads are retried as the views are, in every path (the open, both finals, the bound); a
// time-less pass is refused by the steps; the bound block's stand-in is older than the LOWER final by the delivery time.
test("step 7's clock: header reads retried as the views (a 429, a node a block behind); a time-less pass refused; the bound against the lower final", async () => {
  // the open: two 429s then an UNKNOWN_BLOCK on dRPC's read of the pass's block, then its header: the pass opens with
  // the time; with tries 1 it is refused, naming the cause
  {
    const { rpcs, set } = stepPair({ tip: 1000, money: [] });
    set({}, { failBlock: 3 });
    const pass = await openRestorePass("mainnet", rpcs, { sleep: noSleep });
    assert.equal(passTimeMs(pass), T0);
    set({}, { failBlock: 1 });
    await assert.rejects(openRestorePass("mainnet", rpcs, so), /^Error: https:\/\/near\.drpc\.org: the pass's block 1000 is not served \(UNKNOWN_BLOCK\)$/);
    set({}, { failBlock: 2 });
    await assert.rejects(openRestorePass("mainnet", rpcs, so), /^Error: HTTP 429$/);
  }
  // the steps' finals and bound: a 429 on each is retried
  {
    const { rpcs, set } = stepPair({ tip: 1000, money: [mid(at(0, 1))] });
    const restored = await openRestorePass("mainnet", rpcs, so);
    const o = { sleep: noSleep, first: () => 0 };
    set({ tip: 1722, failBlock: 2 }, { tip: 1722, failBlock: 2 });
    assert.equal((await secondScan({ seed64: SEED, network: "mainnet", rpcs, restored, wallets: { wallets: [], unread: [] }, gap: 3, opts: { ...o, margin: 2 } })).due, true);
    const plan = { scope: SCOPE, lane: 0, next: 0, after: restored.h, rereads: [] };
    set({ tip: 2000, failBlock: 2 }, { tip: 2000 });
    assert.equal((await rereadOnOpen({ network: "mainnet", rpcs, restored, plan, opts: o })).due, true);
  }
  // a pass opened on query-only objects holds no time: the steps refuse it, even once the objects read blocks
  {
    const { rpcs } = stepPair({ tip: 1000, money: [] });
    const q = rpcs.map((r) => ({ name: r.name, query: r.query })) as unknown as [AfterRpc, AfterRpc];
    const pass = await openRestorePass("mainnet", q, so);
    assert.equal(passTimeMs(pass), null);
    q.forEach((r, k) => Object.assign(r, { block: rpcs[k]!.block }));
    const plan = { scope: SCOPE, lane: 0, next: 0, after: pass.h, rereads: [] };
    await assert.rejects(rereadOnOpen({ network: "mainnet", rpcs: q, restored: pass, plan, opts: so }), /^Error: restored: the pass was opened on RPCs that read no blocks, so it holds no block time$/);
    await assert.rejects(secondScan({ seed64: SEED, network: "mainnet", rpcs: q, restored: pass, wallets: { wallets: [], unread: [] }, gap: 3, opts: so }), /holds no block time/);
  }
  // 205 ms blocks (600 of them just over 2 min) and dRPC 36 blocks behind, both honest: against its own final, FastNEAR's
  // stand-in for the bound stays within 2 min of dRPC's final for good; against the lower final, the scan is due
  {
    const { rpcs, set } = stepPair({ tip: 1000, money: [mid(at(0, 1))] });
    const restored = await openRestorePass("mainnet", rpcs, so);
    set({ tip: 10_000, blockMs: 205 }, { tip: 10_000, blockTip: 9_964, blockMs: 205 });
    const got = await secondScan({ seed64: SEED, network: "mainnet", rpcs, restored, wallets: { wallets: [], unread: [] }, gap: 3, opts: { ...so, margin: 2 } });
    assert.ok(got.due);
    assert.deepEqual(got.ids.lanes[0]!.money, [at(0, 1)]);
  }
});

// ---------- step 5's R/V/A balances (restore/arms.ts BalanceReader) ----------
test("the R/V/A balance reader on mainnet's answers, and only a balance both providers answer at the block (card wallet-id-reader-paced)", async () => {
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
  // one provider hiding money, or faking it, decides nothing: the pair disagrees, naming the higher (before, the higher
  // was taken on its one word)
  await assert.rejects(b(empty, rich)("usdc", U1), (e: unknown) => isPair(e, DRPC) && /near\.drpc\.org answered 7 where https:\/\/rpc\.mainnet\.fastnear\.com answered 0 at block 1/.test((e as Error).message));
  await assert.rejects(b(rich, empty)("intents", U1), (e: unknown) => isPair(e, FAST) && /answered 5 where .* answered 0/.test((e as Error).message));
  assert.equal(await b(rich, rich)("intents", U1), 5n);
  assert.equal(await b(empty, empty)("usdc", U1), 0n);
  await assert.rejects(b(empty, empty, () => new Error("HTTP 503"))("usdc", U1), /HTTP 503/, "a 0 needs both providers");
  await assert.rejects(b(rich, rich, () => new Error("HTTP 503"))("usdc", U1), /HTTP 503/, "and so does any balance");
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

// review N2 (the reviewer's Q3): one provider fakes money on a used, empty id; the other answers used, so the pair
// disagrees at one block: never money on one word, and step 5 stops at that id naming the faker (card
// wallet-id-reader-paced: before, the id was unread and the lane read on)
test("a faked money on a used, empty id stops step 5 at that id, naming the provider that faked it", async () => {
  const u = at(3, 1);
  const world = W({ [id(u)]: { storage: true } });
  const fake = (p: Record<string, unknown>) => (argsOf(p).account_id === id(u) && p.method_name === "ft_balance_of" ? view("5") : undefined);
  await assert.rejects(
    restoreDepositIds(SEED, SCOPE, R, nearIdReader("mainnet", [provider(FAST, world, fake), provider(DRPC, world)], { first: () => 0, sleep: noSleep, tries: 1 })),
    new RegExp(`^PairDisagrees: lane 3: at index ${u}, https://rpc\\.mainnet\\.fastnear\\.com answered money where https://near\\.drpc\\.org answered used at block 1: one of the pair is wrong at one block, so the restore stops, to be retried$`),
  );
});

// ---- card wallet-id-reader-paced: busy providers, the pace, both at once, the signal, a liar, a Retry's progress ----
// FastNEAR's free plan answers HTTP 429 (body {"error":{"code":-429,"message":"Rate limits exceeded. ..."}}) in runs of
// 1.6-1.9 s with no Retry-After (read 8 Nov 23:42Z and 9 Nov, the card's own reads); near.org sends Retry-After: 600
const http = (status: number, retryAfterMs?: number): Error => Object.assign(new Error(`HTTP ${status}`), { status }, retryAfterMs === undefined ? {} : { retryAfterMs });
const FAST_429 = { jsonrpc: "2.0", id: "1", error: { code: -429, message: "Rate limits exceeded. For higher rate limits get a subscription at https://fastnear.com" } };
const DRPC_30 = { jsonrpc: "2.0", id: "x", error: { message: "Request timeout on the free plan, please upgrade to paid plan", code: 30 } };
// a virtual clock that only the reader's waits move
const vclock = () => {
  const c = { t: 0, waits: [] as number[] };
  return { c, now: () => c.t, sleep: async (ms: number): Promise<void> => void (c.waits.push(ms), (c.t += ms)) };
};
const isIdView = (p: Record<string, unknown>) => !(p.request_type === "view_account" && p.account_id === "intents.near");

test("a busy provider is waited out and asked again past FastNEAR's 1.9 s runs: HTTP 429, 5xx, the JSON -429 and dRPC's code 30", async () => {
  for (const [name, busy] of [["HTTP 429", http(429)], ["HTTP 503", http(503)], ["HTTP 502", http(502)], ["JSON -429", FAST_429], ["dRPC code 30", DRPC_30]] as const) {
    const v = vclock();
    // every view FastNEAR is asked in the clock's first 1.9 s answers busy (one free-plan run), then it answers
    const fail = () => (v.now() < 1_900 ? busy : undefined);
    const got = await nearIdReader("mainnet", [provider(FAST, W({}), fail), provider(DRPC, W({}))], { first: () => 0, sleep: v.sleep, now: v.now })(U1);
    assert.equal(got, "unused", name);
    assert.ok(v.now() >= 1_900, `${name}: read at ${v.now()} ms`);
  }
});

test("FastNEAR busy in 1.9 s runs every 4 s for a whole restore: every id read, nothing unread, the same lanes as a calm chain", { timeout: 60_000 }, async () => {
  const calm = shape(await restoreDepositIds(SEED, SCOPE, R, nearIdReader("mainnet", [provider(FAST, WORLD), provider(DRPC, WORLD)], { sleep: noSleep })));
  const v = vclock();
  const fail = () => (v.now() % 4_000 < 1_900 ? http(429) : undefined);
  const lanes = await restoreDepositIds(SEED, SCOPE, R, nearIdReader("mainnet", [provider(FAST, WORLD, fail), provider(DRPC, WORLD)], { sleep: v.sleep, now: v.now }));
  assert.deepEqual(shape(lanes), calm);
  assert.deepEqual(lanes.flatMap((x) => x.unread), []);
});

test("Retry-After is honoured: nothing is asked of that provider before it", async () => {
  const v = vclock();
  const at: number[] = [];
  let n = 0;
  const fail = (p: Record<string, unknown>) => (p.method_name === "storage_balance_of" ? (at.push(v.now()), n++ === 0 ? http(429, 7_000) : undefined) : undefined);
  assert.equal(await nearIdReader("mainnet", [provider(FAST, W({}), fail), provider(DRPC, W({}))], { first: () => 0, sleep: v.sleep, now: v.now })(U1), "unused");
  assert.equal(at.length, 2);
  assert.ok(at[1]! - at[0]! >= 7_000, `asked again ${at[1]! - at[0]!} ms after a Retry-After of 7 s`);
});

test("the busy waits are bounded: a provider busy for good fails its read after BUSY_WAIT_MAX_MS of waits, a Retry-After past it at once", async () => {
  const v = vclock();
  let t0: number | undefined;
  await assert.rejects(nearIdReader("mainnet", [provider(FAST, W({}), () => ((t0 ??= v.now()), http(429))), provider(DRPC, W({}))], { first: () => 0, sleep: v.sleep, now: v.now })(U1), /^Error: https:\/\/rpc\.mainnet\.fastnear\.com: busy past 60000 ms of waits \(HTTP 429\)$/);
  // from its first busy answer it waited out twenty and more of FastNEAR's longest runs, and no more than the bound
  assert.ok(v.now() - t0! >= 50_000 && v.now() - t0! <= 61_000, `gave up ${v.now() - t0!} ms after the first 429`);
  resetPaces();
  const w = vclock();
  await assert.rejects(nearIdReader("mainnet", [provider(FAST, W({}), () => http(429, 600_000)), provider(DRPC, W({}))], { first: () => 0, sleep: w.sleep, now: w.now })(U1), /busy past 60000 ms of waits/);
  // (the pace's own slots for the pass's reads aside: no wait near the Retry-After's)
  // (card wallet-id-reader-paced: the pace's slots at 0.39 a second add up to more, each a few seconds at most)
  assert.ok(w.now() < 60_000 && w.c.waits.every((x) => x < 10_000), `waited ${w.now()} ms on a Retry-After of 600 s: ${w.c.waits.join(", ")}`);
  resetPaces();
  const x = vclock();
  await assert.rejects(nearIdReader("mainnet", [provider(FAST, W({}), () => FAST_429), provider(DRPC, W({}))], { first: () => 0, sleep: x.sleep, now: x.now, busyMaxMs: 5_000 })(U1), /busy past 5000 ms of waits/);
  assert.equal(IDR.BUSY_WAIT_MAX_MS, 60_000);
});

// card wallet-id-reader-paced, review P2-1: a busy answer with Retry-After: 0 counts at least the pace's gap toward the
// bound, and busy tries are capped, so a provider answering it on every view ends the read named (before: asked forever)
test("Retry-After: 0 on every view ends the read named, within the bound", async () => {
  const v = vclock();
  let asks = 0;
  const c = new AbortController();
  const busy = () => (++asks >= 5_000 && c.abort(new Error("still asking after 5000 asks")), http(429, 0));
  await assert.rejects(nearIdReader("mainnet", [provider(FAST, W({}), busy), provider(DRPC, W({}))], { first: () => 0, sleep: v.sleep, now: v.now, signal: c.signal })(U1), /^Error: https:\/\/rpc\.mainnet\.fastnear\.com: busy past 60000 ms of waits \(HTTP 429\)$/);
  assert.ok(asks <= IDR.BUSY_TRIES_MAX + 2, `${asks} asks`);
  assert.ok(v.now() <= 61_000 + 8 * 2_565, `read ended at ${v.now()} ms`);
});

// card wallet-id-reader-paced, review P3-4: the bound is one wall-clock bound per view, request time included, so a
// provider that never answers (each request timing out at nearRpc's 10 s) ends the read near BUSY_WAIT_MAX_MS (before:
// about 165 s, the request time not counted)
test("a provider that never answers ends the read within BUSY_WAIT_MAX_MS of request time and waits", async () => {
  const v = vclock();
  let t0: number | undefined;
  const hangs = (p: Record<string, unknown>) => (isIdView(p) ? ((t0 ??= v.now()), (v.c.t += 10_000), new DOMException("The operation timed out.", "TimeoutError")) : undefined);
  await assert.rejects(nearIdReader("mainnet", [provider(FAST, W({}), hangs), provider(DRPC, W({}))], { first: () => 0, sleep: v.sleep, now: v.now })(U1), /busy past 60000 ms of waits/);
  assert.ok(v.now() - t0! <= 70_000, `one view took ${v.now() - t0!} ms`);
});

// card wallet-id-reader-paced, review P3-5: one pace per provider URL for the whole page, whichever reader object asks
// (before: each NearRpc object had its own bucket, so a second object got a fresh burst)
test("two readers of one provider URL share its one pace; pacedFetch paces at the transport", async () => {
  const v = vclock();
  const hdr = { jsonrpc: "2.0", result: { header: { height: 5, hash: "H".padEnd(44, "z"), timestamp_nanosec: "1" } } };
  const mk = () => ({ name: FAST, query: async () => ({}), block: async () => hdr });
  for (const r of [mk(), mk()]) for (let k = 0; k < 8; k++) await IDR.headerRetried(r, { finality: "final" }, "test", v);
  // FastNEAR's burst is 8: the second object's 8 reads each wait one gap
  assert.equal(v.c.waits.length, 8);
  assert.ok(v.c.waits.every((w) => Math.abs(w - 1000 / IDR.PACE.fastnear.perSec) < 1), v.c.waits.join(", "));
  // at the transport: two pacedFetch of one URL share it, on the real clock; the ninth request waits and its signal ends it
  resetPaces();
  let sent = 0;
  const f = async () => (sent++, new Response("{}"));
  const [a, b] = [P.pacedFetch(FAST, f), P.pacedFetch(FAST, f)];
  for (let k = 0; k < 8; k++) await (k % 2 ? a : b)(FAST);
  const c = new AbortController();
  setTimeout(() => c.abort(new Error("signed out")), 30);
  const t = performance.now();
  await assert.rejects(a(FAST, { signal: c.signal }), /^Error: signed out$/);
  assert.equal(sent, 8);
  assert.ok(performance.now() - t < 1_000);
  assert.ok(P.isPacedFetch(a) && !P.isPacedFetch(f));
});

test("the two providers of an id are read at once", async () => {
  let inFlight = 0, most = 0;
  const timed = (rpc: NearRpc): NearRpc => ({
    name: rpc.name,
    query: async (p, signal) => {
      if (!isIdView(p)) return rpc.query(p, signal);
      most = Math.max(most, ++inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      return rpc.query(p, signal);
    },
  });
  assert.equal(await nearIdReader("mainnet", [timed(provider(FAST, W({}))), timed(provider(DRPC, W({})))], { first: () => 0 })(U1), "unused");
  assert.equal(most, 2);
});

test("the signal aborts the view in flight and the busy wait: the read throws its reason at once", async () => {
  const hangs = (url: string): NearRpc => {
    const honest = provider(url, W({}));
    return { name: url, query: (p, signal) => (isIdView(p) ? new Promise((_r, rej) => signal?.addEventListener("abort", () => rej(signal.reason))) : honest.query(p)) };
  };
  const guard = (p: Promise<unknown>) => Promise.race([p, new Promise((_r, rej) => setTimeout(() => rej(new Error("still reading 1 s after the abort")), 1_000))]);
  const c = new AbortController();
  const p = nearIdReader("mainnet", [hangs(FAST), hangs(DRPC)], { first: () => 0, signal: c.signal })(U1);
  setTimeout(() => c.abort(new Error("signed out")), 30);
  await assert.rejects(guard(p), /^Error: signed out$/);
  // a provider busy for good, on the real clock: the abort cuts the wait short
  const d = new AbortController();
  const q = nearIdReader("mainnet", [provider(FAST, W({}), () => http(429)), provider(DRPC, W({}))], { first: () => 0, signal: d.signal, sleep: undefined })(U1);
  setTimeout(() => d.abort(new Error("signed out")), 30);
  await assert.rejects(guard(q), /^Error: signed out$/);
});

test("a liar over a whole scope: one provider answering used, or money, on every id stops step 5 at the first id it lies on, naming it", async () => {
  const everywhere = (x: Id) => ({ get: () => x }) as unknown as Map<string, Id>;
  for (const [lie, said] of [[{ account: true }, "used"], [{ usdc: 7n }, "money"]] as const) {
    for (const liarAt of [0, 1] as const) {
      const count = { n: 0 };
      const liar = provider(liarAt === 0 ? FAST : DRPC, everywhere(lie), undefined, count);
      const honest = provider(liarAt === 0 ? DRPC : FAST, WORLD, undefined, count);
      const rpcs = (liarAt === 0 ? [liar, honest] : [honest, liar]) as [NearRpc, NearRpc];
      await assert.rejects(
        restoreDepositIds(SEED, SCOPE, R, nearIdReader("mainnet", rpcs, { sleep: noSleep })),
        (e: unknown) => isPair(e, liar.name) && new RegExp(`^lane 0: at index 0, ${liar.name.replaceAll(".", "\\.")} answered ${said} where ${honest.name.replaceAll(".", "\\.")} answered unused at block 1: `).test((e as Error).message),
      );
      // the pass's reads and one id's views on each side: the liar never moves a lane on
      assert.ok(count.n <= 20, `${said} on ${liar.name}: ${count.n} queries`);
    }
  }
});

// a pair whose finals stand at tip.h, every view answered at the block it names (as the stale-pass test's)
const tipped = (url: string, world: Map<string, Id>, tip: { h: number }, fail: (p: Record<string, unknown>) => unknown = () => undefined, ids?: string[]): NearRpc => ({
  name: url,
  query: async (p) => {
    const h = p.finality === "final" ? tip.h : heightOf(p);
    if (p.account_id === "intents.near" && p.request_type === "view_account") return { jsonrpc: "2.0", result: { amount: "1", block_height: h, block_hash: hashOf(h) } };
    ids?.push(String(p.request_type === "view_account" ? p.account_id : argsOf(p).account_id));
    const f = fail(p);
    if (f instanceof Error) throw f;
    const a = (f ?? answer(world, p)) as { result?: Record<string, unknown> };
    if (a.result) Object.assign(a.result, { block_height: h, block_hash: hashOf(h) });
    return a;
  },
});

// card wallet-id-reader-paced, review P2-2: a stale pass keeps only the ids both providers answered used (an id once
// used stays used); every kept unused and money answer is asked again at the new pass
test("a Retry goes on where the last run stopped: every id answered at the kept pass is not asked again; a stale pass keeps only the agreed used", async () => {
  const tip = { h: 1000 };
  const WORLD = W({ [id(at(0, 3))]: { storage: true }, [id(at(1, 7))]: { account: true }, [id(at(0, 9))]: { usdc: 2n }, [id(at(2, 14))]: { usdc: 9n }, [id(at(5, 20))]: { storage: true }, [id(at(5, 39))]: { tokens: { "nep141:wrap.near": 4n } } });
  const calm = shape(await restoreDepositIds(SEED, SCOPE, R, nearIdReader("mainnet", [provider(FAST, WORLD), provider(DRPC, WORLD)], { sleep: noSleep })));
  let broken = true;
  const seen = new Set<string>();
  // dRPC breaks (a wrong answer, not busy) once the run has asked of 40 ids, so the first run stops in its lane 2
  const breaks = (p: Record<string, unknown>) => (seen.add(String(argsOf(p).account_id ?? p.account_id)), broken && seen.size > 40 ? new Error("boom") : undefined);
  const asked: string[] = [];
  const rpcs = [tipped(FAST, WORLD, tip, undefined, asked), tipped(DRPC, WORLD, tip, breaks)] as const;
  const keep = IDR.idReadKeep();
  const o = { sleep: noSleep, tries: 1, first: () => 0 };
  const first = await IDR.keptIdReader("mainnet", () => rpcs, keep, o);
  await assert.rejects(restoreDepositIds(SEED, SCOPE, R, first.reader), /id reads failed with none showing history between them/);
  const kept = new Set(keep.answers.keys());
  assert.ok(kept.size >= 30, `${kept.size} answers kept`);
  // the Retry: same pass, the kept answers reused, only the rest asked
  broken = false;
  asked.length = 0;
  const again = await IDR.keptIdReader("mainnet", () => assert.fail("a fresh kept pass opens no new one"), keep, o);
  assert.equal(again.pass, first.pass);
  assert.deepEqual(shape(await restoreDepositIds(SEED, SCOPE, R, again.reader)), calm);
  assert.deepEqual(asked.filter((u) => kept.has(u)), [], "a kept id asked again");
  // past VAULT_SYNC_LAG_MAX the pass is stale: a new one, keeping only the agreed used; every other id asked at it
  const used = [...keep.answers].filter(([, x]) => x === "used").map(([u]) => u);
  const other = [...keep.answers].filter(([, x]) => x !== "used").map(([u]) => u);
  assert.ok(used.length >= 2 && other.some((u) => keep.answers.get(u) === "money") && other.length >= 30, `${used.length} used, ${other.length} other`);
  tip.h = 1121;
  asked.length = 0;
  const later = await IDR.keptIdReader("mainnet", () => rpcs, keep, o);
  assert.equal(later.pass.h, 1121);
  assert.deepEqual([...keep.answers.keys()].sort(), [...used].sort());
  assert.deepEqual(shape(await restoreDepositIds(SEED, SCOPE, R, later.reader)), calm);
  assert.deepEqual(asked.filter((u) => used.includes(u)), [], "an agreed used id asked again");
  assert.deepEqual(other.filter((u) => !asked.includes(u)), [], "a kept unused or money id not asked again");
});

// a used answer on the indexer's word alone is not both providers' answer: a stale pass asks it again
test("a stale pass asks again an id kept used on the indexer's word", async () => {
  const tip = { h: 1000 };
  const u = id(at(0, 0));
  const asked: string[] = [];
  const rpcs = [tipped(FAST, WORLD, tip, undefined, asked), tipped(DRPC, WORLD, tip)] as const;
  const keep = IDR.idReadKeep();
  const o = { sleep: noSleep, first: () => 0, indexer: async (x: string) => x === u };
  assert.equal(await (await IDR.keptIdReader("mainnet", () => rpcs, keep, o)).reader(u), "used");
  tip.h = 1121;
  asked.length = 0;
  const later = await IDR.keptIdReader("mainnet", () => rpcs, keep, o);
  assert.equal(keep.answers.size, 0);
  assert.equal(await later.reader(u), "used");
  assert.ok(asked.includes(u));
});

// virtual time for many waiters at once: each sleep resolves when the clock reaches its end, and the clock jumps to the
// earliest pending end only once every promise has settled (a macrotask turn with nothing else to run)
const vtime = () => {
  let t = 0;
  const due: { at: number; go: () => void }[] = [];
  let turning = false;
  const turn = (): void => {
    if (turning) return;
    turning = true;
    setImmediate(() => {
      turning = false;
      if (due.length === 0) return;
      due.sort((a, b) => a.at - b.at);
      const at = due[0]!.at;
      t = Math.max(t, at);
      for (const d of due.splice(0, due.findIndex((x) => x.at > at) === -1 ? due.length : due.findIndex((x) => x.at > at))) d.go();
      turn();
    });
  };
  return { now: () => t, sleep: (ms: number): Promise<void> => new Promise<void>((go) => (due.push({ at: t + ms, go }), turn())) };
};

// FastNEAR's sustained rate, read 9 Nov 02:59-03:20Z (id-reader.ts PACE)
const FASTNEAR_SUSTAINED = 0.39;
// card wallet-id-reader-paced: FastNEAR's pace is its sustained rate (PACE's comment cites the 10-minute read), so a
// restore's views on it, once its burst is spent, come exactly that far apart, never faster
test("FastNEAR's views come at its measured sustained rate once its burst is spent", async () => {
  const v = vtime();
  const at: Record<string, number[]> = { [FAST]: [], [DRPC]: [] };
  const timed = (rpc: NearRpc): NearRpc => ({ name: rpc.name, query: async (p, signal) => (at[rpc.name]!.push(v.now()), rpc.query(p, signal)) });
  const rpcs = [timed(provider(FAST, W({}))), timed(provider(DRPC, W({})))] as const;
  const o = { sleep: v.sleep, now: v.now, first: () => 0 };
  const pass = await openRestorePass("mainnet", rpcs, o);
  const read = await idReaderAt("mainnet", rpcs, pass, o);
  for (let k = 0; k < 12; k++) assert.equal(await read(k.toString(16).padStart(2, "0").repeat(32)), "unused");
  assert.equal(IDR.PACE.fastnear.perSec, FASTNEAR_SUSTAINED);
  const gaps = (xs: number[]) => xs.slice(1).map((x, k) => x - xs[k]!);
  // past the burst every FastNEAR view waits its full slot (FastNEAR is the slower of the two, so it is always asked)
  const fast = gaps(at[FAST]!).slice(IDR.PACE.fastnear.burst);
  assert.ok(fast.length >= 20, `${fast.length} paced FastNEAR views`);
  for (const g of fast) assert.ok(Math.abs(g - 1000 / FASTNEAR_SUSTAINED) < 1e-6, `FastNEAR asked ${g} ms apart, not ${1000 / FASTNEAR_SUSTAINED}`);
});
