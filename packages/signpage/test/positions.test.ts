// state.positions on SIGN_HOST's top-level page (card signpage-state-holdings): the tokens this device's pool buys
// hold, each buy's W read by the finder, one pass at a time, run at the first signed-in state read and again when a
// pool buy or sell ends; red before this card, where every signed-in state sent positions: [] (src/state.ts stateOf).
// The page's requests on the mainnet build are test/positions-requests.test.ts.
//   node --test test/positions.test.ts
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { base58, base64 } from "@scure/base";
import { IDBFactory } from "fake-indexeddb";
import { entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import type { SignpageState } from "../../kit/src/signpage/messages.ts";
import { SIGNPAGE_MAX_ANSWER_BYTES, SIGNPAGE_RESULT_SCHEMAS } from "../../kit/src/signpage/schema.ts";
import { SOLANA_TOKEN_PROGRAM } from "../../kit/src/checks/solana/checks.ts";
import { solanaAta } from "../../kit/src/checks/solana/message.ts";
import { SIGNPAGE_RESULT_SCHEMAS as V1_8_SCHEMAS } from "./fixtures/kit-v1.8/signpage/schema.ts";
import { noteCommitment, noteSecrets } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore } from "../../wallet/src/notes/store.ts";
import type { Holdings, HoldingsReader } from "../../wallet/src/pool/buy-wallets.ts";
import { solanaPoolOf } from "../../wallet/src/pool/solana.ts";
import { freshWallet } from "../../wallet/src/derive/keys.ts";
import { jOf } from "../../wallet/src/pool/queue.ts";
import { passMemo, POSITION_COSTS_KEY, positionCost, POSITIONS_KEPT_KEY, POSITIONS_SOLD_KEY, positionsCache, positionsPass, recordPoolBuy, usdOf, withPositions, type KeptPass, type PassMemo, type PassResult, type PassRun, type Position, type PositionCosts, type PositionsReads } from "../src/positions.ts";
import { stateFor } from "../src/kit-version.ts";
import { testnetPool } from "../src/pool-testnet.ts";

const MINT = base58.encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 7 : 0))); // a 32-byte key, as a mint is (low entropy: gitleaks reads a recorded "token" as a key otherwise)
const MINT2 = "Mint2222222222222222222222222222222222222222";
const STRANGER = "Mint3333333333333333333333333333333333333333"; // a token anyone sent to W: no buy record on this device
const W1 = "W1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const W2 = "W2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SIGNED_IN: SignpageState = { release: "sp-1", api: 1, signed_in: true, code_saved: true, vault_balance: "0", wallets: [], positions: [], orders: [], held: [], ops: [] };
const tick = () => new Promise((r) => setTimeout(r, 0));

/** W's buy record of `mint`: `received` units at 6 decimals (MINT) or 9 (MINT2), as recordPoolBuy writes it. */
const rec = (mint: string, received: string, more: { decimals?: number | null; cost_usd?: string } = {}) => ({ mint, received, ...(more.decimals === null ? {} : { decimals: more.decimals ?? (mint === MINT2 ? 9 : 6) }), ...(more.cost_usd === undefined ? {} : { cost_usd: more.cost_usd }) });

/** The finder's reads: `found` each W's tokens (base units), null for a W whose read fails; `costs` the buy records.
 *  `asked` each wallets() call's set of addresses, `decimalsAsked` each mint whose decimals were read. */
const reads = (found: Record<string, Record<string, bigint> | null>, o: { costs?: PositionCosts; sold?: string[]; decimals?: Record<string, number>; kept?: unknown } = {}) => {
  const saved: KeptPass[] = [];
  const asked: string[][] = [];
  const decimalsAsked: string[] = [];
  const decimals = o.decimals ?? { [MINT]: 6, [MINT2]: 9 };
  const r: PositionsReads & { saved: KeptPass[]; asked: string[][]; decimalsAsked: string[] } = {
    wallets: async (only) => (asked.push([...only].sort()), Object.entries(found).map(([address, t]) => ({ address, tokens: t === null ? null : new Map(Object.entries(t)) }))),
    decimals: async (m) => (decimalsAsked.push(m), decimals[m] ?? Promise.reject(new Error("the two RPCs read the mint apart"))),
    costs: async () => o.costs ?? {},
    sold: async () => new Set(o.sold ?? []),
    ...(o.kept === undefined ? {} : { kept: async () => o.kept }),
    keep: async (k) => void saved.push(k),
    saved,
    asked,
    decimalsAsked,
  };
  return r;
};

test("a pass: one position per token this device bought, from the finder's read of its W, its amount the sum over its Ws at the decimals its buy record names; a token at 0 is not held", async () => {
  const costs = { [W1]: rec(MINT, "1.5"), [W2]: rec(MINT, "2.25") };
  const r = reads({ [W1]: { [MINT]: 1_500_000n }, [W2]: { [MINT]: 2_250_001n } }, { costs });
  const got = await positionsPass(r);
  assert.deepEqual(got, { positions: [{ chain: "solana", token: MINT, amount: "3.750001", cost: "0", wallets: [W1, W2], decimals: 6 }], whole: true });
  assert.deepEqual(r.decimalsAsked, [], "the buy records name the decimals: no RPC is asked");
  assert.deepEqual((await positionsPass(reads({ [W1]: { [MINT]: 0n } }, { costs: { [W1]: rec(MINT, "1") } }))).positions, [], "listed at 0: not held");
  const none = reads({ [W1]: { [MINT]: 1n } });
  assert.deepEqual(await positionsPass(none), { positions: [], whole: true }, "no buy record: no positions");
  assert.deepEqual(none.asked, [], "and no W read");
});

test("a token this device did not buy (sent to W by anyone) is no position: not listed, no Sell, and nothing is read for it; a W with no buy record is not read", async () => {
  const costs = { [W1]: rec(MINT, "5") };
  const r = reads({ [W1]: { [MINT]: 4_000_000n, [STRANGER]: 9_000_000n } }, { costs });
  const got = await positionsPass(r);
  assert.deepEqual(got.positions.map((p) => [p.token, p.amount]), [[MINT, "4"]]);
  assert.equal(got.whole, true);
  assert.deepEqual(r.decimalsAsked, [], "no decimals read for the stranger's mint (nor the bought one: its record names them)");
  assert.deepEqual(r.asked, [[W1]], "the finder is asked for the Ws with a buy record only");
  assert.ok(!JSON.stringify(r.saved).includes(STRANGER), "nor is it kept");
  // a record from before decimals were kept: its mint read once on the page's RPCs, never the stranger's
  const old = reads({ [W1]: { [MINT]: 4_000_000n, [STRANGER]: 1n } }, { costs: { [W1]: rec(MINT, "5", { decimals: null }) } });
  assert.deepEqual((await positionsPass(old)).positions.map((p) => p.amount), ["4"]);
  assert.deepEqual(old.decimalsAsked, [MINT]);
});

test("one W's failed read is its own: it keeps its last amount while every other W updates, and the pass runs again; a finder that cannot list keeps them all", async () => {
  const costs = { [W1]: rec(MINT, "1"), [W2]: rec(MINT2, "2") };
  const memo = passMemo();
  await positionsPass(reads({ [W1]: { [MINT]: 1_000_000n }, [W2]: { [MINT2]: 2_000_000_000n } }, { costs }), memo);
  let got = await positionsPass(reads({ [W1]: { [MINT]: 500_000n }, [W2]: null }, { costs }), memo);
  assert.deepEqual(got.positions.map((p) => [p.token, p.amount]), [[MINT, "0.5"], [MINT2, "2"]], "W1 updates, W2 keeps its last");
  assert.equal(got.whole, false);
  got = await positionsPass({ ...reads({}, { costs }), wallets: async () => Promise.reject(new Error("the helper is down")) }, memo);
  assert.deepEqual(got.positions.map((p) => [p.token, p.amount]), [[MINT, "0.5"], [MINT2, "2"]]);
  assert.equal(got.whole, false);
  // a fresh device whose W cannot be read shows its record's amount for it (never listed, not sold), and the other W
  got = await positionsPass(reads({ [W1]: { [MINT]: 1_000_000n }, [W2]: null }, { costs }));
  assert.deepEqual([got.positions.map((p) => [p.token, p.amount]), got.whole], [[[MINT, "1"], [MINT2, "2"]], false]);
});

test("what this device bought: shown from its buy record while the finder lags, then the finder's amount; gone once the finder listed it and lists it no more, and an unread W or a finder that is down never brings it back", async () => {
  const costs = { [W1]: rec(MINT, "7") };
  const memo = passMemo();
  // the finder read W whole, not listing the token yet: the record's amount
  let got = await positionsPass(reads({ [W1]: {} }, { costs }), memo);
  assert.deepEqual([got.positions.map((p) => [p.token, p.amount, p.wallets]), got.whole], [[[MINT, "7", [W1]]], true]);
  // the finder does not know W yet (its note not read as spent): the record's amount, and the pass runs again
  got = await positionsPass(reads({}, { costs }), passMemo());
  assert.deepEqual([got.positions.map((p) => p.amount), got.whole], [["7"], false]);
  for (let i = 0; i < 3; i++) got = await positionsPass(reads({ [W1]: {} }, { costs }), memo);
  assert.deepEqual(got.positions.map((p) => p.amount), ["7"], "never hidden for a lag");
  got = await positionsPass(reads({ [W1]: { [MINT]: 3_000_000n } }, { costs }), memo);
  assert.deepEqual(got.positions.map((p) => p.amount), ["3"], "listed: the finder's amount stands (a part sold)");
  got = await positionsPass(reads({ [W1]: {} }, { costs }), memo);
  assert.deepEqual(got.positions, [], "listed before, read whole, listed no more: gone, though the record stays");
  got = await positionsPass(reads({ [W1]: null }, { costs }), memo);
  assert.deepEqual([got.positions, got.whole], [[], false], "gone, then W unread: still gone");
  got = await positionsPass({ ...reads({}, { costs }), wallets: async () => Promise.reject(new Error("down")) }, memo);
  assert.deepEqual(got.positions, [], "gone, then the finder down: still gone");
  // listed at 0 counts as listed: gone, and stays gone when W is unread after
  const z = passMemo();
  await positionsPass(reads({ [W1]: { [MINT]: 0n } }, { costs }), z);
  assert.deepEqual((await positionsPass(reads({ [W1]: null }, { costs }), z)).positions, []);
  // but W unread with a last amount: its last stays
  const m2 = passMemo();
  await positionsPass(reads({ [W1]: { [MINT]: 3_000_000n } }, { costs }), m2);
  got = await positionsPass(reads({ [W1]: null }, { costs }), m2);
  assert.deepEqual(got.positions.map((p) => p.amount), ["3"]);
});

test("a full sell this device signed, with the finder never listing the token: gone though the record stays; without the sell it stays", async () => {
  const costs = { [W1]: rec(MINT, "7") };
  assert.deepEqual((await positionsPass(reads({ [W1]: {} }, { costs, sold: [`${W1} ${MINT}`] }))).positions, [], "sold all, read whole, not listed: gone");
  assert.deepEqual((await positionsPass(reads({ [W1]: {} }, { costs }))).positions.length, 1, "not sold: stays");
  // a full sell that did not land: the finder still lists the token, so it stays
  assert.deepEqual((await positionsPass(reads({ [W1]: { [MINT]: 7_000_000n } }, { costs, sold: [`${W1} ${MINT}`] }))).positions.map((p) => p.amount), ["7"]);
  // sold, W unread, nothing shown before: its record is not shown again
  assert.deepEqual((await positionsPass(reads({ [W1]: null }, { costs, sold: [`${W1} ${MINT}`] }))).positions, []);
});

test("a pass keeps itself only when whole, and a load reads what was kept: each W's amounts, what the finder listed and each token's decimals, so a load asks no RPC", async () => {
  const costs = { [W1]: rec(MINT, "3", { decimals: null }) };
  const r = reads({ [W1]: { [MINT]: 3_000_000n } }, { costs });
  const memo = passMemo();
  await positionsPass(r, memo);
  await positionsPass(r, memo);
  assert.deepEqual(r.decimalsAsked, [MINT], "a record from before decimals were kept: read once, then held");
  const kept = r.saved.at(-1)!;
  assert.deepEqual(kept, { positions: [{ chain: "solana", token: MINT, amount: "3", cost: "0", wallets: [W1], decimals: 6 }], held: { [`${W1} ${MINT}`]: "3000000" }, listed: [`${W1} ${MINT}`] });
  // a reload: the kept pass's decimals, no RPC asked; W unread: its kept amount stands
  const reload = reads({ [W1]: null }, { costs, kept });
  assert.deepEqual((await positionsPass(reload, passMemo())).positions.map((p) => p.amount), ["3"]);
  assert.deepEqual(reload.decimalsAsked, [], "the kept position's decimals");
  assert.deepEqual(reload.saved, [], "a pass with a W unread never replaces the kept pass");
  // a reload whose decimals do not read (a public RPC's 429) and no record or kept pass names them: the entry is never
  // dropped from what the next pass carries, and the kept pass stays as it was
  const k2: KeptPass = { positions: [], held: { [`${W1} ${MINT}`]: "7000000" }, listed: [`${W1} ${MINT}`] };
  const m3 = passMemo();
  const r3 = reads({ [W1]: { [MINT]: 7_000_000n } }, { costs, kept: k2, decimals: {} });
  assert.deepEqual(await positionsPass(r3, m3), { positions: [], whole: false });
  assert.deepEqual(r3.saved, [], "not whole: the kept pass is not replaced by nothing");
  const r4 = { ...reads({}, { costs }), wallets: async () => Promise.reject(new Error("the helper is down")) } as PositionsReads;
  assert.deepEqual((await positionsPass(r4, m3)).positions.map((p) => p.amount), ["7"], "W's last stays, shown once its decimals read");
  // the token listed before and no longer: gone, from the kept pass
  const sold = reads({ [W1]: {} }, { costs, kept });
  assert.deepEqual((await positionsPass(sold, passMemo())).positions, []);
  // a pass a sign out overtook keeps nothing
  const stale = passMemo();
  stale.stale = true;
  const r2 = reads({ [W1]: { [MINT]: 1n } }, { costs });
  await positionsPass(r2, stale);
  assert.deepEqual(r2.saved, []);
});

test("a pass stopped (a sign out, or a sell's own read) throws, and changes and keeps nothing", async () => {
  const stop = new AbortController();
  const costs = { [W1]: rec(MINT, "3") };
  const memo = passMemo();
  const r = { ...reads({ [W1]: { [MINT]: 3_000_000n } }, { costs }), signal: stop.signal };
  r.wallets = async () => (stop.abort(), [{ address: W1, tokens: new Map([[MINT, 3_000_000n]]) }]);
  await assert.rejects(positionsPass(r, memo), { name: "AbortError" });
  assert.deepEqual([memo.held.size, memo.listed.size, r.saved.length], [0, 0, 0]);
});

const P = (amount: string): Position => ({ chain: "solana", token: MINT, amount, cost: "0", wallets: [W1], decimals: 6 });

test("the cache: one pass at a time, a refresh while one runs runs once more after it; a failed pass keeps the last and is tried again", async () => {
  const timers: (() => void)[] = [];
  let answer: Position[] | Error | PassResult = [];
  let calls = 0;
  let gate: (() => void) | null = null;
  const c = positionsCache(
    async () => {
      calls++;
      if (gate === null) await new Promise<void>((r) => (gate = r));
      if (answer instanceof Error) throw answer;
      return Array.isArray(answer) ? { positions: answer, whole: true } : answer;
    },
    { retries: 2, setTimer: (f) => timers.push(f), clearTimer: () => {} },
  );
  let told = 0;
  c.watch(() => told++);
  assert.equal(c.get(), null, "before the first pass: none (the state keeps its [])");
  c.refresh();
  await tick();
  assert.equal(calls, 0, "no pass before the sign-in's first");
  c.first();
  c.first();
  c.refresh();
  await tick();
  assert.equal(calls, 1, "one pass at a time");
  answer = [P("1")];
  (gate as unknown as () => void)();
  await c.idle();
  assert.equal(calls, 2, "the refresh asked meanwhile ran once more after it");
  assert.deepEqual(c.get(), [P("1")]);
  assert.equal(told, 1, "told once: the second pass changed nothing");
  answer = new Error("one RPC behind");
  c.refresh();
  await c.idle();
  assert.deepEqual(c.get(), [P("1")], "a failed pass keeps the last whole one");
  assert.equal(timers.length, 1, "and is tried again later");
  answer = [];
  timers.shift()!();
  await c.idle();
  assert.deepEqual(c.get(), [], "a full sell: the position is gone");
  assert.equal(told, 2);
  answer = { positions: [P("1")], whole: false };
  c.refresh();
  await c.idle();
  assert.deepEqual(c.get(), [P("1")], "the part that read is shown");
  assert.equal(timers.length, 1, "and the pass is tried again");
  answer = [P("1")];
  timers.shift()!();
  await c.idle();
  assert.equal(timers.length, 0, "a whole pass: no more tries");
  c.clear();
  assert.equal(c.get(), null, "sign out drops them");
});

test("the cache: retries stop after their count; a pass running at sign out is stopped and dropped", async () => {
  const timers: (() => void)[] = [];
  let calls = 0;
  const c = positionsCache(async () => (calls++, Promise.reject(new Error("down"))), { retries: 2, setTimer: (f) => timers.push(f), clearTimer: () => {} });
  c.first();
  for (let i = 0; i < 5; i++) {
    await c.idle();
    timers.shift()?.();
  }
  await c.idle();
  assert.equal(calls, 3, "the first pass and two tries");
  let release!: () => void;
  let signal!: AbortSignal;
  const d = positionsCache((_m, run) => ((signal = run.signal), new Promise<PassResult>((r) => (release = () => r({ positions: [P("1")], whole: true })))));
  d.first();
  d.clear();
  assert.equal(signal.aborted, true, "sign out stops the running pass");
  release();
  await d.idle();
  assert.equal(d.get(), null, "the answer of a pass from before the sign out is never kept");
});

test("the cache across a sign out: the next sign-in reads its own kept pass and runs its own first pass, with a memo of its own; nothing of the last account's carries", async () => {
  const gates: (() => void)[] = [];
  const memos: PassMemo[] = [];
  const timers: { f: () => void; cleared: boolean }[] = [];
  let kept: readonly Position[] | null = [P("9")];
  let keptAsked = 0;
  let calls = 0;
  let fail = false;
  const c = positionsCache(
    async (memo) => {
      calls++;
      memos.push(memo);
      await new Promise<void>((r) => gates.push(r));
      if (fail) throw new Error("down");
      return { positions: [P(String(calls))], whole: true };
    },
    { kept: async () => (keptAsked++, kept), setTimer: (f) => (timers.push({ f, cleared: false }), timers.at(-1)), clearTimer: (t) => void ((t as { cleared: boolean }).cleared = true) },
  );
  // account A: its kept pass, its first pass, a retry pending
  await c.ready();
  assert.deepEqual(c.get(), [P("9")]);
  c.first();
  fail = true;
  gates.shift()!();
  await c.idle();
  assert.equal(timers.length, 1);
  memos[0]!.held.set(`${W1} ${MINT}`, 5n);
  // a pass of A's running at its sign out
  fail = false;
  timers[0]!.f();
  await tick();
  c.clear();
  assert.equal(memos[1]!.stale, true, "the running pass's memo is marked stale: it keeps nothing");
  assert.equal(timers[0]!.cleared || timers.length === 1, true);
  // account B signs in before A's pass ends
  kept = [P("7")];
  await c.ready();
  assert.equal(keptAsked, 2, "B's kept pass is read");
  assert.deepEqual(c.get(), [P("7")], "B's own kept pass");
  c.first();
  gates.shift()!(); // A's pass ends: its answer is dropped, and B's first pass runs after it
  await tick();
  await tick();
  assert.equal(calls, 3, "B's own first pass runs once A's ends");
  assert.notEqual(memos[2], memos[0], "with a memo of its own");
  assert.equal(memos[2]!.held.size, 0, "nothing of A's amounts carries");
  gates.shift()!();
  await c.idle();
  assert.deepEqual(c.get(), [P("3")]);
  // a retry left from A never runs for B: sign out clears it
  const d = positionsCache(async () => Promise.reject(new Error("down")), { setTimer: (f) => (timers.push({ f, cleared: false }), timers.at(-1)), clearTimer: (t) => void ((t as { cleared: boolean }).cleared = true) });
  d.first();
  await d.idle();
  const left = timers.at(-1)!;
  d.clear();
  assert.equal(left.cleared, true, "sign out clears the retry");
});

test("the cache: a refresh after a sign out is no sign-in's first pass; a kept pass never replaces a pass already run, nor one read across a sign out", async () => {
  let calls = 0;
  const c = positionsCache(async () => (calls++, { positions: [P(String(calls))], whole: true }), { kept: async () => [P("9")], setTimer: () => 0, clearTimer: () => {} });
  c.first();
  await c.idle();
  c.clear();
  c.refresh(); // a trade's end the sign out waited for
  await c.idle();
  assert.equal(calls, 1, "no pass on a signed-out page");
  await c.ready();
  c.first(); // the next account's first state read
  await c.idle();
  assert.equal(calls, 2, "the next sign-in's first pass runs");
  // the kept pass read after a pass ran: the pass stands
  let give!: (k: Position[]) => void;
  const e = positionsCache(async () => ({ positions: [P("1")], whole: true }), { kept: () => new Promise((r) => (give = r)) });
  const ready = e.ready();
  e.first();
  await e.idle();
  give([P("9")]);
  await ready;
  assert.deepEqual(e.get(), [P("1")], "the kept pass never replaces a pass already run");
  // a kept pass read that lands after a sign out: not the next account's
  const f = positionsCache(async () => ({ positions: [], whole: true }), { kept: () => new Promise((r) => (give = r)) });
  const r1 = f.ready();
  f.clear();
  give([P("9")]);
  await r1;
  assert.equal(f.get(), null, "A's kept pass, read across the sign out, is not taken");
});

test("the cache: a sell's own read stops the running pass and is the next pass's read", async () => {
  const runs: PassRun[] = [];
  const gates: (() => void)[] = [];
  const c = positionsCache(async (_m, run) => {
    runs.push(run);
    await new Promise<void>((r) => gates.push(r));
    run.signal.throwIfAborted();
    return { positions: [P(run.found ? "fed" : "read")], whole: true };
  });
  c.feed([]);
  await tick();
  assert.equal(runs.length, 0, "no pass before the sign-in's first");
  c.first();
  await tick();
  c.preempt();
  assert.equal(runs[0]!.signal.aborted, true, "the sell stops the running pass");
  const found = [{ address: W1, tokens: new Map([[MINT, 1n]]) }];
  c.feed(found);
  gates.shift()!();
  await tick();
  await tick();
  assert.equal(runs.length, 2);
  assert.equal(runs[1]!.found, found, "the next pass reads what the sell read");
  gates.shift()!();
  await c.idle();
  assert.deepEqual(c.get(), [P("fed")]);
});

test("withPositions: signed in with a pass, the state carries them, valid at kit 1.9 and at kit 1.8 (decimals kept), kit 1.7 without decimals; a state past the answer's bound goes as it was", () => {
  const Ps: Position[] = [{ chain: "solana", token: MINT, amount: "3.750001", cost: "0", wallets: [W1, W2], decimals: 6 }];
  const s = withPositions(SIGNED_IN, Ps);
  assert.deepEqual(s.positions, Ps);
  assert.equal(SIGNPAGE_RESULT_SCHEMAS.state(s), true, "kit 1.9");
  const v18 = stateFor("1.8", s);
  assert.deepEqual(v18.positions, Ps, "kit 1.8 reads a position's decimals (card signpage-state-holdings shipped them at 1.8)");
  assert.equal(V1_8_SCHEMAS.state(v18), true, "kit-v1.8's own schema");
  assert.deepEqual(stateFor("1.7", s).positions, [{ chain: "solana", token: MINT, amount: "3.750001", cost: "0", wallets: [W1, W2] }]);
  assert.equal(withPositions(SIGNED_IN, null), SIGNED_IN, "no pass yet: the state as it is");
  const out = { ...SIGNED_IN, signed_in: false } as unknown as SignpageState;
  assert.equal(withPositions(out, Ps), out, "signed out: never");
  assert.equal(withPositions(SIGNED_IN, [{ ...Ps[0]!, amount: "1.1234567" }]), SIGNED_IN, "a position the kit's schema refuses never goes");
  // a state 128 bytes under the kit's bound: the schema takes it, but it leaves no room for the answer around it
  const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
  // 9,000 positions (the kit reads at most 10,000 items an array, 512 characters a string), their tokens grown to fit
  const target = SIGNPAGE_MAX_ANSWER_BYTES - 128;
  const sized = (len: number) => Array.from({ length: 9_000 }, (_, i): Position => ({ ...Ps[0]!, token: String(i).padStart(len, "x") }));
  let many = sized(8);
  many = sized(8 + Math.floor((target - bytes({ ...SIGNED_IN, positions: many })) / many.length));
  for (let k = 0, left = target - bytes({ ...SIGNED_IN, positions: many }); left > 0; k++, left--) many[k] = { ...many[k]!, token: `${many[k]!.token}x` };
  assert.equal(bytes({ ...SIGNED_IN, positions: many }), SIGNPAGE_MAX_ANSWER_BYTES - 128);
  assert.ok(SIGNPAGE_RESULT_SCHEMAS.state({ ...SIGNED_IN, positions: many }), "the schema alone would take them");
  assert.equal(withPositions(SIGNED_IN, many), SIGNED_IN, "past the answer's room: the state as it was");
});

// ---------------------------------------------------- the page's wiring (src/pool-testnet.ts), on a fake chain
const SEED64 = wordsToSeed64(entropyToWords(new Uint8Array(16))); // the published all-zero entropy vector (a8.json)
const PIN = { program: "9Z6Yi2VcXkFWgAV6Nb6kMei78vAAVUEMTqzvFiUZcvG8", feePayer: "9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb" }; // the devnet pool (wallet/src/pool/solana.ts SOL_POOLS)
const SCOPE = solanaPoolOf(PIN.program).scope;
const LIVE_STATE = new URL("../../../apps/terminal/test/sell-positions/live-state.json", import.meta.url);
const closers: (() => void)[] = [];
after(() => closers.forEach((f) => f()));

/** A wallet store with `n` SPENT notes of the pool: buy wallets W0..W(n-1). */
async function spentWallet(n = 1): Promise<WalletStore> {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => w.close());
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
  const ns = await openNoteStore(w);
  for (let i = 0; i < n; i++) {
    const ref = { kind: "deposit" as const, s: SCOPE, i };
    const precommitment = noteSecrets(SEED64, ref).precommitment;
    const label = BigInt(77 + i);
    const r = await ns.add({ ref, scope: SCOPE, precommitment, state: "UNSPENT", leaf: { value: 10_000_000n, label, commitment: noteCommitment(10_000_000n, label, precommitment), leafIndex: BigInt(i) } });
    await ns.move(r.id, "UNSPENT", "SPENT");
  }
  ns.close();
  return w;
}

/** The i-th spent note's buy wallet W (its label 77 + i): its address only. */
function solanaWallet(i = 0): string {
  const fw = freshWallet(SEED64, "sol", BigInt(77 + i), jOf({ kind: "deposit", s: SCOPE, i }));
  fw.secretKey.fill(0);
  return fw.address;
}

/** A fake chain: the mint (6 decimals) on both RPCs, which the pass may read for a record from before decimals were
 *  kept, and nothing else (no read names a W to them); the finder's one read of each W, `amounts[0]` of the mint, and
 *  a stranger's token on every W; failing while `fail`. */
function chain() {
  const mintData = new Uint8Array(82);
  mintData[44] = 6;
  mintData[45] = 1;
  const amounts: [bigint, bigint] = [0n, 0n];
  const owners = new Map<string, string>(); // ATA -> W
  const calls = { rpc: [0, 0], finder: 0 };
  const state = { fail: false };
  const rpc = (k: number) => async (method: string, params: readonly unknown[]) => {
    calls.rpc[k]!++;
    assert.equal(method, "getAccountInfo");
    assert.equal(params[0], MINT, "the page's RPCs read a bought mint only, never a wallet's account or a stranger's mint");
    return { context: { slot: 10 }, value: { owner: SOLANA_TOKEN_PROGRAM, lamports: 1, data: [base64.encode(mintData), "base64"] } };
  };
  const finder: HoldingsReader = {
    chain: "sol",
    read: async (address) => {
      calls.finder++;
      owners.set(solanaAta(address, MINT, SOLANA_TOKEN_PROGRAM), address);
      if (state.fail) throw new Error("the helper did not answer");
      return { native: 0n, tokens: new Map([[STRANGER, { amount: 1n, frozen: false }], ...(amounts[0] > 0n ? [[MINT, { amount: amounts[0], frozen: false }] as const] : [])]), unreadable: [] };
    },
  };
  return { amounts, rpcs: [rpc(0), rpc(1)] as const, finder, owners, calls, state };
}
const until = async (f: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 400 && !(await f()); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(await f());
};
/** W's buy record on the store, as the buy writes it. */
const recorded = (w: WalletStore, records: Record<string, ReturnType<typeof rec>>) => w.update("meta", POSITION_COSTS_KEY, (v) => ({ ...((v as object) ?? {}), ...records }));

test("the page: the first signed-in read starts a pass from the finder's read, a sell's end reads again, a full sell's position is gone, a W the finder cannot read keeps its last, sign out drops them", async () => {
  const w = await spentWallet();
  await recorded(w, { [solanaWallet()]: rec(MINT, "1081590.213565") });
  const c = chain();
  c.amounts[0] = c.amounts[1] = 1_081_590_213_565n;
  const timers: (() => void)[] = [];
  let ended!: () => void;
  const ran: string[] = [];
  const sell = () => (ask: unknown, ctx: { id: string }) => {
    ran.push(ctx.id);
    return { running: true as const, after: new Promise<void>((r) => (ended = r)), answer: () => ({ result: { stage: "filled", txs: [] } }) };
  };
  const tp = testnetPool(
    { store: async () => w, seed64: async () => SEED64.slice() },
    // @ts-expect-error a stand-in sell kind: only its run's end matters here
    { pin: PIN, rpcs: c.rpcs, holdings: () => c.finder, tradeKinds: { sell }, positions: { setTimer: (f: () => void) => timers.push(f), clearTimer: () => {} } },
  );
  let told = 0;
  tp.watch(() => told++);
  assert.equal(await tp.positions(), null, "no pass yet, none kept: the state keeps its []");
  await until(async () => (await tp.positions()) !== null);
  const [p] = (await tp.positions())!;
  assert.deepEqual({ ...p, wallets: p!.wallets.length }, { chain: "solana", token: MINT, amount: "1081590.213565", cost: "0", wallets: 1, decimals: 6 });
  assert.equal(p!.wallets[0], [...c.owners.values()][0], "W, the spent note's buy wallet");
  assert.equal((await tp.positions())!.length, 1, "the stranger's token on W is no position");
  assert.deepEqual(c.calls.rpc, [0, 0], "the decimals are the buy record's: no RPC read");
  assert.ok(told >= 1, "the page's state is read again when the positions change");
  // what SIGN_HOST then sends the app: the terminal's sell test reads this very state (apps/terminal/test/sell-live.test.ts)
  const sent = withPositions(SIGNED_IN, await tp.positions());
  if (process.env.RECORD_LIVE_STATE === "1") writeFileSync(LIVE_STATE, `${JSON.stringify(sent, null, 2)}\n`);
  assert.deepEqual(sent, JSON.parse(readFileSync(LIVE_STATE, "utf8")), "the terminal's recorded state is the page's own");
  assert.equal(SIGNPAGE_RESULT_SCHEMAS.state(sent), true);
  assert.equal(V1_8_SCHEMAS.state(stateFor("1.8", sent)), true);
  // a full sell: its run ends, the finder lists none, the position is gone with no reload
  c.amounts[0] = c.amounts[1] = 0n;
  const r = tp.flow({ kind: "pool.sell", chain: "solana", token: MINT, amount: 1n, slippageBps: 100, decimals: 6 }, { id: "s1", sha: "00", progress: () => {} } as never);
  assert.ok("running" in r);
  assert.deepEqual(ran, ["s1"]);
  assert.equal((await tp.positions())!.length, 1, "nothing read again before the run ends");
  ended();
  await until(async () => (await tp.positions())!.length === 0);
  // tokens again (a buy into the same W is not possible; the finder lists it, a reader's late view): then the finder
  // cannot read W: its last stays, the pass tried again
  c.amounts[0] = 5n;
  tp.flow({ kind: "pool.sell", chain: "solana", token: MINT, amount: 1n, slippageBps: 100, decimals: 6 }, { id: "s2", sha: "00", progress: () => {} } as never);
  ended();
  await until(async () => (await tp.positions())!.length === 1);
  c.state.fail = true;
  c.amounts[0] = 0n;
  tp.flow({ kind: "pool.sell", chain: "solana", token: MINT, amount: 1n, slippageBps: 100, decimals: 6 }, { id: "s3", sha: "00", progress: () => {} } as never);
  ended();
  await until(() => timers.length > 0);
  assert.equal((await tp.positions())![0]!.amount, "0.000005", "W unread: its last amount stays");
  c.state.fail = false;
  timers.shift()!();
  await until(async () => (await tp.positions())!.length === 0);
  // sign out: the store's database goes (its kept pass with it), the page's positions with it
  await w.signOut();
  await tp.signedOut();
  assert.equal(await tp.positions(), null, "sign out drops them");
});

test("the page: two buy wallets, one W's failed read is its own: the other updates and the pass is tried again", async () => {
  const w = await spentWallet(2);
  await recorded(w, { [solanaWallet(0)]: rec(MINT, "1"), [solanaWallet(1)]: rec(MINT2, "2") });
  const amounts = new Map<string, Map<string, { amount: bigint; frozen: boolean }>>([
    [solanaWallet(0), new Map([[MINT, { amount: 1_000_000n, frozen: false }]])],
    [solanaWallet(1), new Map([[MINT2, { amount: 2_000_000_000n, frozen: false }]])],
  ]);
  let failW = "";
  const finder: HoldingsReader = { chain: "sol", read: async (a) => (a === failW ? Promise.reject(new Error("no")) : { native: 0n, tokens: amounts.get(a)!, unreadable: [] }) };
  const timers: (() => void)[] = [];
  const tp = testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { pin: PIN, rpcs: chain().rpcs, holdings: () => finder, positions: { setTimer: (f: () => void) => timers.push(f), clearTimer: () => {} } } as never);
  await tp.positions();
  await until(async () => ((await tp.positions()) ?? []).length === 2);
  failW = solanaWallet(1);
  amounts.set(solanaWallet(0), new Map([[MINT, { amount: 500_000n, frozen: false }]]));
  amounts.set(solanaWallet(1), new Map());
  timers.length = 0;
  tp.flow({ kind: "pool.sell", chain: "solana", token: MINT, amount: 1n, slippageBps: 100, decimals: 6 }, { id: "x", sha: "00", progress: () => {} } as never);
  await until(async () => (await tp.positions())!.find((p) => p.token === MINT)?.amount === "0.5");
  assert.deepEqual((await tp.positions())!.map((p) => [p.token, p.amount]), [[MINT, "0.5"], [MINT2, "2"]], "W0 updates, W1 keeps its last");
  await until(() => timers.length > 0);
});

test("the page: a reload with a kept pass answers the first state read with no chain read, and the first pass replaces it", async () => {
  const w = await spentWallet();
  await recorded(w, { [solanaWallet()]: rec(MINT, "9") });
  const c = chain();
  c.amounts[0] = 2_000_000n;
  const kept: KeptPass = { positions: [{ chain: "solana", token: MINT, amount: "9", cost: "0", wallets: [solanaWallet()], decimals: 6 }], held: { [`${solanaWallet()} ${MINT}`]: "9000000" }, listed: [`${solanaWallet()} ${MINT}`] };
  await w.put("meta", POSITIONS_KEPT_KEY, kept);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow: HoldingsReader = { chain: "sol", read: async (a, s) => (await gate, c.finder.read(a, s)) };
  const tp = testnetPool(
    { store: async () => w, seed64: async () => SEED64.slice() },
    { pin: PIN, rpcs: c.rpcs as never, holdings: () => slow, positions: { setTimer: () => {}, clearTimer: () => {} } } as never,
  );
  assert.deepEqual(await tp.positions(), kept.positions, "the kept pass, at the first state read");
  assert.deepEqual([c.calls.rpc, c.calls.finder], [[0, 0], 0], "no chain read for it");
  release();
  await until(async () => (await tp.positions())![0]?.amount === "2");
  assert.deepEqual(((await w.get("meta", POSITIONS_KEPT_KEY)) as KeptPass).positions.map((p) => p.amount), ["2"], "the pass is kept in its place");
  await w.signOut();
  await tp.signedOut();
  assert.equal(await tp.positions(), null, "sign out: the kept pass went with the store");
});

test("the page: a record from before decimals were kept reads its mint on both of the page's RPCs, once; the next load asks none", async () => {
  const w = await spentWallet();
  await recorded(w, { [solanaWallet()]: rec(MINT, "3", { decimals: null }) });
  const c = chain();
  c.amounts[0] = 3_000_000n;
  const make = () => testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { pin: PIN, rpcs: c.rpcs as never, holdings: () => c.finder, positions: { setTimer: () => {}, clearTimer: () => {} } } as never);
  const tp = make();
  await tp.positions();
  await until(async () => ((await tp.positions()) ?? []).length === 1);
  assert.deepEqual(c.calls.rpc, [1, 1], "one read on each RPC, the two compared");
  const again = make();
  await again.positions();
  await until(async () => c.calls.finder === 2);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(c.calls.rpc, [1, 1], "the kept pass names them: no read at the next load");
});

test("the page at sign out mid-pass: the seed copy is zeroed as soon as the Ws are derived, the pass stops (no further read of the old account's Ws), and the next sign-in runs its own first pass", async () => {
  const w = await spentWallet(2);
  await recorded(w, { [solanaWallet(0)]: rec(MINT, "1"), [solanaWallet(1)]: rec(MINT, "2") });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const asked: string[] = [];
  const slow: HoldingsReader = { chain: "sol", read: async (a) => (asked.push(a), await gate, { native: 0n, tokens: new Map([[MINT, { amount: 1_000_000n, frozen: false }]]), unreadable: [] }) };
  const seeds: Uint8Array[] = [];
  const tp = testnetPool({ store: async () => w, seed64: async () => (seeds.push(SEED64.slice()), seeds.at(-1)!) }, { pin: PIN, rpcs: chain().rpcs, holdings: () => slow, positions: { setTimer: () => 0, clearTimer: () => {} } } as never);
  await tp.positions();
  await until(() => asked.length === 1);
  assert.equal(seeds.length, 1);
  assert.ok(seeds.every((s) => s.every((b) => b === 0)), "zeroed before the first read");
  await tp.signedOut();
  assert.ok(seeds.every((s) => s.every((b) => b === 0)), "and after sign out");
  release();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(asked.length, 1, "the stopped pass reads no other W");
  assert.equal(await w.get("meta", POSITIONS_KEPT_KEY), undefined, "and keeps nothing");
  // the same tab signs in again: its own first pass
  assert.equal(await tp.positions(), null);
  await until(async () => ((await tp.positions()) ?? []).length === 1);
  assert.equal(asked.length, 3, "the new sign-in's pass reads its Ws");
});

test("the page: a sell's own read is not held behind a running positions pass (the finder's one paced queue, on an injected clock): the pass stops, and the sell's read is the positions' next", async () => {
  const N = 3;
  const w = await spentWallet(N);
  await recorded(w, Object.fromEntries(Array.from({ length: N }, (_, i) => [solanaWallet(i), rec(MINT, "1")])));
  // the finder's paced queue: one W's read a turn of 3 s, in order; `turn` ends the head's turn
  const clock = { ms: 0 };
  const queue: { address: string; done: () => void }[] = [];
  const held = (): Holdings => ({ native: 0n, tokens: new Map([[MINT, { amount: 2_000_000n, frozen: false }]]), unreadable: [] });
  const paced: HoldingsReader = { chain: "sol", read: (address) => new Promise((done) => queue.push({ address, done: () => done(held()) })) };
  const turn = () => {
    clock.ms += 3_000;
    queue.shift()!.done();
  };
  let sellReadAt = -1;
  let sellRead: Promise<unknown> | null = null;
  const sell = (host: () => { wallets(): Promise<unknown> }) => () => {
    const start = clock.ms;
    sellRead = host().wallets().then(() => void (sellReadAt = clock.ms - start));
    return { running: true as const, after: new Promise<void>(() => {}), answer: () => ({ result: { stage: "sent", txs: [] } }) };
  };
  const tp = testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { pin: PIN, rpcs: chain().rpcs, holdings: () => paced, tradeKinds: { sell }, positions: { setTimer: () => 0, clearTimer: () => {} } } as never);
  await tp.positions();
  await until(() => queue.length === 1); // the pass's first W is in its turn
  tp.flow({ kind: "pool.sell", chain: "solana", token: MINT, amount: 1n, slippageBps: 100, decimals: 6 }, { id: "s", sha: "00", progress: () => {} } as never);
  for (let i = 0; i < 4 * N && sellReadAt < 0; i++) {
    await until(() => queue.length > 0 || sellReadAt >= 0);
    if (sellReadAt < 0) turn();
    await tick();
  }
  await sellRead;
  assert.equal(sellReadAt, 3_000 * (N + 1), "the sell waits only for the one W read already in its turn, then reads its own N (a pass in full: 2N turns)");
  await until(async () => (await tp.positions())?.[0]?.amount === String(N * 2));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(queue.length, 0, "the positions took the sell's read: no read of their own after it");
});

// ---------------------------------------------------- cost, and the pool buy's records
const PRICE = { price: "15000000000", expo: -8, published_s: 1, read_ms: 1 }; // 150 USD a SOL, the page's own read

test("a pool buy's USD: its spend at the page's own price, exact; no price that reads, none", () => {
  assert.equal(usdOf(10_000_000n, 9, PRICE), "1.5");
  assert.equal(usdOf(12_345_678n, 9, { ...PRICE, price: "14999999999" }), "1.85185169987654322");
  assert.equal(usdOf(1n, 9, { ...PRICE, price: "0" }), null);
  assert.equal(usdOf(1n, 9, { ...PRICE, expo: 2 }), null);
});

test("a position's cost: each W's spend times what it holds over what it received (a sell takes it off pro rata); any W with no record of the mint: unknown", () => {
  const costs = { [W1]: { mint: MINT, cost_usd: "1.5", received: "1000" }, [W2]: { mint: MINT, cost_usd: "3", received: "10" } };
  assert.equal(positionCost(MINT, 6, [{ address: W1, amount: 1_000_000_000n }], costs), "1.5", "all of it held");
  assert.equal(positionCost(MINT, 6, [{ address: W1, amount: 250_000_000n }], costs), "0.375", "a quarter held after a sell");
  assert.equal(positionCost(MINT, 6, [{ address: W1, amount: 500_000_000n }, { address: W2, amount: 10_000_000n }], costs), "3.75");
  assert.equal(positionCost(MINT, 6, [{ address: W1, amount: 2_000_000_000n }], costs), "1.5", "never more than it spent");
  assert.equal(positionCost(MINT, 6, [{ address: W1, amount: 1n }, { address: "Wnone", amount: 1n }], costs), "0", "a W with no record");
  assert.equal(positionCost(MINT2, 6, [{ address: W1, amount: 1n }], costs), "0", "a record of another mint");
  assert.equal(positionCost(MINT, 6, [{ address: W1, amount: 1n }], { [W1]: { mint: MINT, cost_usd: "x", received: "1" } }), "0");
  assert.equal(positionCost(MINT, 6, [{ address: W1, amount: 1n }], { [W1]: { mint: MINT, cost_usd: "1", received: "0" } }), "0");
  const third = positionCost(MINT, 6, [{ address: W1, amount: 1n }], { [W1]: { mint: MINT, cost_usd: "1", received: "0.000003" } });
  assert.equal(third, "0.333333333333", "cut at 12 decimals");
  const p: Position = { chain: "solana", token: MINT, amount: "0.000001", cost: third, wallets: [W1], decimals: 6 };
  assert.deepEqual(withPositions(SIGNED_IN, [p]).positions, [p], "a cost at 12 decimals fits the kit's schema");
});

/** A wallet store's ops and meta, in memory. */
const memStore = () => {
  const ops = new Map<string, unknown>();
  const meta = new Map<string, unknown>();
  return {
    ops,
    meta,
    get: async (_s: "ops", k: string) => ops.get(k),
    put: async (_s: "ops", k: string, v: unknown) => void ops.set(k, v),
    update: async (_s: "meta", k: string, f: (v: unknown) => unknown) => void meta.set(k, f(meta.get(k))),
  };
};
const FACTS = { token: MINT, spend: 10_000_000n, spendDecimals: 9, price: PRICE, createdMs: 1_800_000_000_000, wallet: W1, out: "1081590.213565", decimals: 6 };

test("a pool buy's records: filled, its ops record (time, chain, token, USD) and W's buy record with its decimals, every other W's kept; refused or not landed, its ops record and no buy record; sent, id_reused or seen before, nothing", async () => {
  const { opOf } = await import("../src/state.ts");
  const s = memStore();
  s.meta.set(POSITION_COSTS_KEY, { [W2]: rec(MINT2, "4") });
  await recordPoolBuy(s, "b1", FACTS, { result: { stage: "filled", txs: [{ chain: "solana", hash: "Sig1" }] } });
  assert.deepEqual(opOf("b1", s.ops.get("b1")), { id: "b1", kind: "buy", stage: "filled", txs: [{ chain: "solana", hash: "Sig1" }], created_ms: 1_800_000_000_000, chain: "solana", token: MINT, amount_usd: "1.5" });
  assert.deepEqual(s.meta.get(POSITION_COSTS_KEY), { [W2]: rec(MINT2, "4"), [W1]: { mint: MINT, decimals: 6, cost_usd: "1.5", received: "1081590.213565" } }, "W1's record beside W2's");
  await recordPoolBuy(s, "b2", { ...FACTS, wallet: "W3" }, { error: "quote_check_failed" });
  assert.deepEqual(opOf("b2", s.ops.get("b2")), { id: "b2", kind: "buy", stage: "refused", txs: [], code: "quote_check_failed", created_ms: 1_800_000_000_000, chain: "solana", token: MINT, amount_usd: "1.5" });
  await recordPoolBuy(s, "b3", { ...FACTS, wallet: "W3" }, { result: { stage: "not_landed", txs: [] } });
  assert.equal((s.ops.get("b3") as { stage: string }).stage, "not_landed");
  assert.deepEqual(Object.keys(s.meta.get(POSITION_COSTS_KEY) as object), [W2, W1], "no buy record for a buy that did not fill");
  await recordPoolBuy(s, "b4", FACTS, { result: { stage: "sent", txs: [{ chain: "solana", hash: "Sig4" }] } });
  await recordPoolBuy(s, "b5", FACTS, { error: "id_reused" });
  await recordPoolBuy(s, "b6", FACTS, null);
  assert.deepEqual([...s.ops.keys()], ["b1", "b2", "b3"], "no record for an answer with no end, another tab's run or none");
  await recordPoolBuy(s, "b1", FACTS, { error: "failed" });
  assert.equal((s.ops.get("b1") as { stage: string }).stage, "filled", "a record already there is never written over");
  const n = memStore();
  await recordPoolBuy(n, "b7", { ...FACTS, price: null, decimals: undefined }, { result: { stage: "filled", txs: [] } });
  assert.equal((n.ops.get("b7") as { amount_usd?: string }).amount_usd, undefined, "no price read: no USD");
  assert.deepEqual(n.meta.get(POSITION_COSTS_KEY), { [W1]: { mint: MINT, received: "1081590.213565" } }, "no price, no decimals told: W's record without them");
  const bad = memStore();
  await recordPoolBuy(bad, "b9", { ...FACTS, decimals: 256 }, { result: { stage: "filled", txs: [] } });
  assert.equal((bad.meta.get(POSITION_COSTS_KEY) as Record<string, { decimals?: number }>)[W1]!.decimals, undefined, "decimals past a u8 are not written");
  const m = memStore();
  await recordPoolBuy(m, "b8", { ...FACTS, out: undefined }, { result: { stage: "filled", txs: [] } });
  assert.equal(m.meta.get(POSITION_COSTS_KEY), undefined, "no amount told: no buy record");
});

test("the page: a pool buy's end writes its records, the decimals its run told among them, and reads the positions again with its cost and no RPC read", async () => {
  const w = await spentWallet();
  const c = chain();
  let ended!: () => void;
  const buy = (host: () => { outDecimals?(w: string, d: number): void }) => (ask: { amount: bigint }, ctx: { route?: (r: unknown) => void }) => {
    assert.equal(ask.amount, 10_000_000n);
    // the run tells W once it is bound, the decimals and the amount W received once both RPCs read them (pool-buy.ts)
    ctx.route?.({ wallet: solanaWallet() });
    host().outDecimals?.(solanaWallet(), 6);
    ctx.route?.({ out: "1081590.213565" });
    return { running: true as const, after: new Promise<void>((r) => (ended = r)), answer: () => ({ result: { stage: "filled", txs: [{ chain: "solana", hash: "SigB" }] } }) };
  };
  const routed: unknown[] = [];
  const tp = testnetPool(
    { store: async () => w, seed64: async () => SEED64.slice(), price: () => PRICE },
    // @ts-expect-error a stand-in buy kind: only its route facts, answer and end matter here
    { pin: PIN, rpcs: c.rpcs, table: "Table111111111111111111111111111111111111111", holdings: () => c.finder, tradeKinds: { buy }, positions: { setTimer: () => {}, clearTimer: () => {} } },
  );
  assert.equal(await tp.positions(), null);
  await until(async () => (await tp.positions()) !== null);
  assert.deepEqual(await tp.positions(), [], "nothing bought yet (the stranger's token on W is none)");
  const r = tp.flow({ kind: "pool.buy", chain: "solana", token: MINT, amount: 10_000_000n, slippageBps: 100, decimals: 9 }, { id: "pb1", sha: "00", progress: () => {}, route: (x: unknown) => routed.push(x) } as never);
  assert.ok("running" in r);
  c.amounts[0] = c.amounts[1] = 1_081_590_213_565n;
  ended();
  await until(async () => ((await tp.positions()) ?? []).length === 1);
  assert.equal((await tp.positions())![0]!.cost, "1.5", "the buy's spend at the page's price, all of it held");
  assert.deepEqual(await w.get("meta", POSITION_COSTS_KEY), { [solanaWallet()]: { mint: MINT, received: "1081590.213565", decimals: 6, cost_usd: "1.5" } });
  assert.deepEqual(c.calls.rpc, [0, 0], "the decimals came with the buy: no read");
  assert.deepEqual(routed, [{ wallet: solanaWallet() }, { out: "1081590.213565" }], "the run's route facts still reach the app");
  const op = (await w.get("ops", "pb1")) as { stage: string; amount_usd: string; token: string };
  assert.deepEqual([op.stage, op.amount_usd, op.token], ["filled", "1.5", MINT], "the pool buy shows in state.ops (review P3-1)");
});

test("the page: a pool buy answered early as sent (its fill read later) is recorded at the end stage its run posts, once", async () => {
  const w = await spentWallet();
  const c = chain();
  let answered!: () => void;
  let progress!: (s: string) => void;
  const buy = () => (_ask: unknown, ctx: { route?: (r: unknown) => void; progress: (s: string) => void }) => {
    progress = ctx.progress;
    ctx.route?.({ wallet: solanaWallet() });
    ctx.route?.({ out: "5" });
    return { running: true as const, after: new Promise<void>((r) => (answered = r)), answer: () => ({ result: { stage: "sent", txs: [{ chain: "solana", hash: "SigS" }] } }) };
  };
  const posted: string[] = [];
  const tp = testnetPool(
    { store: async () => w, seed64: async () => SEED64.slice(), price: () => PRICE },
    // @ts-expect-error a stand-in buy kind
    { pin: PIN, rpcs: c.rpcs, table: "Table111111111111111111111111111111111111111", holdings: () => c.finder, tradeKinds: { buy }, positions: { setTimer: () => {}, clearTimer: () => {} } },
  );
  await until(async () => (await tp.positions()) !== null);
  tp.flow({ kind: "pool.buy", chain: "solana", token: MINT, amount: 10_000_000n, slippageBps: 100, decimals: 9 }, { id: "pb2", sha: "00", progress: (s: string) => posted.push(s) } as never);
  answered();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await w.get("ops", "pb2"), undefined, "sent is no end: nothing written yet");
  progress("filled");
  progress("filled");
  for (let i = 0; i < 200 && (await w.get("ops", "pb2")) === undefined; i++) await new Promise((r) => setTimeout(r, 5));
  const op = (await w.get("ops", "pb2")) as { stage: string; txs: unknown[] };
  assert.deepEqual([op.stage, op.txs], ["filled", [{ chain: "solana", hash: "SigS" }]]);
  assert.deepEqual(posted, ["filled", "filled"], "the app still gets every progress the run posts");
  assert.deepEqual(await w.get("meta", POSITION_COSTS_KEY), { [solanaWallet()]: { mint: MINT, received: "5", cost_usd: "1.5" } });
});

test("the page: a sell answered at its send (sent) and ended later: its position is gone at the end, with no reload", async () => {
  const w = await spentWallet();
  await recorded(w, { [solanaWallet()]: rec(MINT, "5") });
  const c = chain();
  c.amounts[0] = c.amounts[1] = 5_000_000n;
  let answered!: () => void;
  let progress!: (s: string) => void;
  const sell = () => (_ask: unknown, ctx: { progress: (s: string) => void }) => {
    progress = ctx.progress;
    return { running: true as const, after: new Promise<void>((r) => (answered = r)), answer: () => ({ result: { stage: "sent", txs: [{ chain: "solana", hash: "SigX" }] } }) };
  };
  const posted: string[] = [];
  const tp = testnetPool(
    { store: async () => w, seed64: async () => SEED64.slice() },
    // @ts-expect-error a stand-in sell kind
    { pin: PIN, rpcs: c.rpcs, holdings: () => c.finder, tradeKinds: { sell }, positions: { setTimer: () => {}, clearTimer: () => {} } },
  );
  await until(async () => ((await tp.positions()) ?? []).length === 1);
  tp.flow({ kind: "pool.sell", chain: "solana", token: MINT, amount: 5_000_000n, slippageBps: 100, decimals: 6 }, { id: "sx", sha: "00", progress: (s: string) => posted.push(s) } as never);
  answered();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await tp.positions())!.length, 1, "sent: the tokens are still W's, nothing to read yet");
  c.amounts[0] = c.amounts[1] = 0n;
  progress("filled");
  await until(async () => (await tp.positions())!.length === 0);
  assert.deepEqual(posted, ["filled"], "the app still gets the run's progress");
});

test("the page: the finder lists W with none of the token yet, the device's own buy record names it: shown at the first pass; a full sell this device signs writes W's rent-back record first, then notes the sell (never failing the sell, never another W's note), so a finder that never lists it shows it gone", async () => {
  const w = await spentWallet();
  const c = chain();
  const W = solanaWallet();
  await recorded(w, { [W]: rec(MINT, "3") });
  await w.update("meta", POSITIONS_SOLD_KEY, () => ({ [W2]: [MINT2] }));
  const lagging: HoldingsReader = { chain: "sol", read: async (address) => (c.finder.read(address), { native: 0n, tokens: new Map(), unreadable: [] }) };
  // the page's store, its meta writes in order; the sold note's write fails while `failNote`
  const writes: string[] = [];
  let failNote = true;
  const store = new Proxy(w, {
    get: (t, k) => {
      if (k === "update") return async (s: string, key: string, f: (v: unknown) => unknown) => {
        writes.push(key);
        if (key === POSITIONS_SOLD_KEY && failNote) throw new Error("the store refused the write");
        return t.update(s as "meta", key, f);
      };
      const v = Reflect.get(t, k, t) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  let ended!: () => void;
  const puts: Promise<void>[] = [];
  const back = { address: W, l: "77", j: 0, mints: [{ mint: MINT, program: SOLANA_TOKEN_PROGRAM }], passes: 0, sell: { [MINT]: { tx: "AA==", last: 1 } } };
  // the sell's own host: a full sell writes W's rent-back record with that sell before it leaves the device
  const sell = (host: () => { owed?: { put(r: unknown): Promise<void> } }) => (_ask: unknown, _ctx: unknown) => {
    puts.push(host().owed!.put(back));
    return { running: true as const, after: new Promise<void>((r) => (ended = r)), answer: () => ({ result: { stage: "filled", txs: [] } }) };
  };
  const tp = testnetPool(
    { store: async () => store, seed64: async () => SEED64.slice() },
    { pin: PIN, rpcs: c.rpcs as never, holdings: () => lagging, tradeKinds: { sell }, positions: { setTimer: () => {}, clearTimer: () => {} } } as never,
  );
  await until(async () => (await tp.positions()) !== null);
  assert.deepEqual((await tp.positions())!.map((p) => [p.token, p.amount, p.wallets]), [[MINT, "3", [W]]], "never hidden for the finder's lag");
  // a note that fails: the rent-back record written, the sell's put not failed
  writes.length = 0;
  tp.flow({ kind: "pool.sell", chain: "solana", token: MINT, amount: 3_000_000n, slippageBps: 100, decimals: 6 }, { id: "s8", sha: "00", progress: () => {} } as never);
  await puts.at(-1);
  assert.deepEqual(writes, ["owed/rentback-sol", POSITIONS_SOLD_KEY], "W's rent-back record first, then the note");
  assert.deepEqual(Object.keys(((await w.get("meta", "owed/rentback-sol")) as object) ?? {}), [W], "the rent-back record is written");
  assert.deepEqual(await w.get("meta", POSITIONS_SOLD_KEY), { [W2]: [MINT2] }, "the failed note changed nothing");
  ended();
  failNote = false;
  tp.flow({ kind: "pool.sell", chain: "solana", token: MINT, amount: 3_000_000n, slippageBps: 100, decimals: 6 }, { id: "s9", sha: "00", progress: () => {} } as never);
  await puts.at(-1);
  assert.deepEqual(await w.get("meta", POSITIONS_SOLD_KEY), { [W2]: [MINT2], [W]: [MINT] }, "noted beside every other W's");
  ended();
  await until(async () => (await tp.positions())!.length === 0);
  assert.deepEqual(await w.get("meta", POSITION_COSTS_KEY), { [W]: rec(MINT, "3") }, "the record stays; the sold one is never kept on screen for it");
});
