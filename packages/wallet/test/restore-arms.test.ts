// Restore step 5's reads of R, V and A, step 7's second-scan wait and its arms with nothing visible (card
// wallet-restore-id-reader; docs/plan1/wallet.md §2.3 "Restore" step 5 l.293-306, step 7 l.335-348). Fixtures on fake
// readers that log every request.
//   node --test test/restore-arms.test.ts      (from packages/wallet)
// Test secrets: the all-zero BIP-39 entropy (test/vectors/a8.json), never money.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { VaultSpendRow } from "@blindfill/kit";
import * as d from "../src/derive/index.ts";
import type { NoteRestore, RestoredSpend } from "../src/notes/restore.ts";
import type { RestoredWallet, UnreadWallet, WalletRestore } from "../src/restore/wallets.ts";
import {
  quietArms,
  restoreArmAccounts,
  secondScanBoundHeight,
  secondScanDue,
  SECOND_SCAN_BLOCKS,
  SECOND_SCAN_DELIVERY_MS,
  SECOND_SCAN_WAIT_MS,
  type ArmRead,
  type ArmRestore,
} from "../src/restore/arms.ts";

const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const L1 = 1111n, L2 = 2222n;
const zeroed = <T extends { secretKey: Uint8Array }>(k: T): T => (k.secretKey.fill(0), k);
const R = (c: d.Chain, l: bigint, j: number): string => zeroed(d.returnId(SEED, c, l, j)).id;
const V = (l: bigint, j: number): string => zeroed(d.refundId(SEED, l, j)).id;
const A = (l: bigint, j: number): string => zeroed(d.armAccount(SEED, l, j)).id;
const W = (c: d.Chain, l: bigint, j: number): string => zeroed(d.freshWallet(SEED, c, l, j)).address;

const row = (o: Partial<VaultSpendRow> = {}): VaultSpendRow => ({
  index: 0, nullifierHash: 1n, withdrawn: 10n, newLeafIndex: 1n, refundPrecommitment: 2n, refundValue: 0n, refundLabel: 0n,
  refundLeafIndex: 0n, status: "paid", payer: "relayer.testnet", reserve: 0n, recipient: "x.testnet", fee: 0n, context: 1n, ...o,
});
const spend = (l: bigint, j: number, o: Partial<VaultSpendRow> = {}): RestoredSpend => ({ l, j, note: `note-${l}-${j}`, spend: row({ recipient: A(l, j), ...o }) });
const wallet = (c: d.Chain, l: bigint, j: number): RestoredWallet => ({ c, l, j, note: `note-${l}-${j}`, path: "", address: W(c, l, j), history: ["near"], returnNote: null });

// a reader answering from "what account" -> value (absent: 0n), logging every request
function reader(vals: Record<string, unknown> = {}) {
  const log: string[] = [];
  const read = async (what: ArmRead, account: string): Promise<bigint> => {
    log.push(`${what} ${account}`);
    const v = vals[`${what} ${account}`];
    if (v instanceof Error) throw v;
    return (v === undefined ? 0n : v) as bigint;
  };
  return { read, log };
}
const json = (x: unknown): string => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? String(v) : v));

const TWO: Pick<NoteRestore, "spends"> = { spends: [spend(L1, 0), spend(L2, 1)] };
const FOUND: Pick<WalletRestore, "wallets"> = { wallets: [wallet("sol", L1, 0), wallet("hop-evm", L1, 0)] };

test("step 5: R for every wallet found (hop targets included), V and A for every withdrawal, each read one account per request", async () => {
  const { read, log } = reader({ [`usdc ${A(L1, 0)}`]: 7n, [`intents ${R("hop-evm", L1, 0)}`]: 1n, [`near ${A(L2, 1)}`]: 3n });
  const got = await restoreArmAccounts(SEED, TWO, FOUND, read);
  assert.deepEqual(got.unread, []);
  assert.deepEqual(
    got.accounts.map((a) => [a.kind, a.c ?? null, a.l, a.j, a.account, a.holds]),
    [
      ["R", "sol", L1, 0, R("sol", L1, 0), []],
      ["R", "hop-evm", L1, 0, R("hop-evm", L1, 0), ["intents"]],
      ["V", null, L1, 0, V(L1, 0), []],
      ["A", null, L1, 0, A(L1, 0), ["usdc"]],
      ["V", null, L2, 1, V(L2, 1), []],
      ["A", null, L2, 1, A(L2, 1), ["near"]],
    ],
  );
  const want = [
    ...["intents", "usdc"].flatMap((w) => [`${w} ${R("sol", L1, 0)}`, `${w} ${R("hop-evm", L1, 0)}`, `${w} ${V(L1, 0)}`, `${w} ${V(L2, 1)}`]),
    ...["usdc", "near", "intents"].flatMap((w) => [`${w} ${A(L1, 0)}`, `${w} ${A(L2, 1)}`]),
  ];
  assert.deepEqual([...log].sort(), want.sort(), "R and V: intents and usdc; A: usdc, near and intents; nothing else");
  assert.ok(!json(got).includes("secret"), "no key leaves");
});

test("step 5: one R per wallet tag and one V and one A per withdrawal, however often they are listed", async () => {
  const { read, log } = reader();
  const got = await restoreArmAccounts(SEED, { spends: [spend(L1, 0), spend(L1, 0)] }, { wallets: [wallet("near", L1, 0), wallet("near", L1, 0)] }, read);
  assert.deepEqual(got.accounts.map((a) => a.kind), ["R", "V", "A"]);
  assert.equal(log.length, 2 + 2 + 3);
});

test("step 5: a read that fails or answers no balance is listed in unread, never taken as zero", async () => {
  const { read } = reader({
    [`usdc ${A(L1, 0)}`]: new Error("rpc down"),
    [`intents ${V(L1, 0)}`]: "5",
    [`usdc ${R("sol", L1, 0)}`]: -1n,
    [`intents ${R("sol", L1, 0)}`]: 4,
    [`near ${A(L1, 0)}`]: 9n,
  });
  const got = await restoreArmAccounts(SEED, { spends: [spend(L1, 0)] }, { wallets: [wallet("sol", L1, 0)] }, read);
  const un = got.unread.map((u) => [u.kind, u.account, u.what, u.halt ?? false]).sort();
  assert.deepEqual(un, [
    ["A", A(L1, 0), "usdc", false],
    ["R", R("sol", L1, 0), "intents", false],
    ["R", R("sol", L1, 0), "usdc", false],
    ["V", V(L1, 0), "intents", false],
  ].sort());
  assert.equal(got.unread.find((u) => u.what === "usdc" && u.kind === "A")!.error, "rpc down");
  const a = got.accounts.find((x) => x.kind === "A")!;
  assert.deepEqual(a.holds, ["near"], "the failed usdc read is not a zero and not a hold; the near read still counts");
  assert.deepEqual(got.accounts.find((x) => x.kind === "R")!.holds, []);
});

test("step 5: a FiatToken: paused answer is a halt, listed in unread with halt", async () => {
  const { read } = reader({ [`usdc ${V(L1, 0)}`]: new Error("Smart contract panicked: FiatToken: paused"), [`usdc ${A(L1, 0)}`]: new Error("timeout") });
  const got = await restoreArmAccounts(SEED, { spends: [spend(L1, 0)] }, { wallets: [] }, read);
  const v = got.unread.find((u) => u.kind === "V")!;
  assert.equal(v.halt, true);
  assert.match(v.error, /FiatToken: paused/);
  assert.equal(got.unread.find((u) => u.kind === "A")!.halt, undefined);
});

test("step 5: the reads go in the order pick draws, never the list's", async () => {
  const last = reader(), first = reader(), rnd = reader();
  await restoreArmAccounts(SEED, TWO, FOUND, last.read, { pick: (n) => n - 1 });
  await restoreArmAccounts(SEED, TWO, FOUND, first.read, { pick: () => 0 });
  await restoreArmAccounts(SEED, TWO, FOUND, rnd.read);
  assert.deepEqual([...first.log].sort(), [...last.log].sort());
  assert.deepEqual([...rnd.log].sort(), [...last.log].sort());
  assert.notDeepEqual(first.log, last.log, "a pick fixture changes the order");
  // pick n - 1 swaps nothing: the list's own order, R then V and A
  assert.deepEqual(last.log.slice(0, 2), [`intents ${R("sol", L1, 0)}`, `usdc ${R("sol", L1, 0)}`]);
  await assert.rejects(restoreArmAccounts(SEED, TWO, FOUND, reader().read, { pick: (n) => n }), /pick is out of range/);
});

// ---------- step 7: the second scan ----------
const MIN = 60_000;
const AT = { heights: [1_000, 1_005] as [number, number], timesMs: [1_700_000_000_000, 1_700_000_003_000] as [number, number] };
const maxT = AT.timesMs[1], maxH = AT.heights[1];
const now = (t: [number, number], h: [number, number]) => ({ timesMs: t, heights: h });
// both RPCs' times of block maxH + 601, the first past the height bound: here before the time bound
const EARLY: [number, number] = [maxT + MIN, maxT + MIN];

test("step 7: the second scan waits 10 min + 2 min of block time and 600 blocks past the higher of both RPCs", () => {
  assert.equal(SECOND_SCAN_WAIT_MS, 10 * MIN);
  assert.equal(SECOND_SCAN_DELIVERY_MS, 2 * MIN);
  assert.equal(SECOND_SCAN_BLOCKS, 600);
  const T = maxT + 12 * MIN, H = maxH + 600;
  assert.equal(secondScanDue(AT, now([T + 1, T + 1], [H + 1, H + 1]), EARLY), true, "one past each, on both");
  assert.equal(secondScanDue(AT, now([T, T + 1], [H + 1, H + 1]), EARLY), false, "time exactly at the edge on one RPC");
  assert.equal(secondScanDue(AT, now([T + 1, T], [H + 1, H + 1]), EARLY), false);
  assert.equal(secondScanDue(AT, now([T + 1, T + 1], [H, H + 1]), EARLY), false, "height exactly at the edge on one RPC");
  assert.equal(secondScanDue(AT, now([T + 1, T + 1], [H + 1, H]), EARLY), false);
  assert.equal(secondScanDue(AT, now([T, T], [H, H]), EARLY), false, "both exactly at the edges");
  assert.equal(secondScanDue(AT, now([T + 1, AT.timesMs[0] + 12 * MIN + 1], [H + 1, H + 1]), EARLY), false, "past the lower restore time only is not enough");
  assert.equal(secondScanDue(AT, now([T + 1, T + 1], [H + 1, AT.heights[0] + 601]), EARLY), false, "past the lower restore height only is not enough");
  assert.equal(secondScanDue(AT, now([T + 9 * MIN, T + 9 * MIN], [H + 1, H + 1]), EARLY), true);
});

// wallet.md l.338-342: the 2 minutes of 1Click's delivery run after BOTH bounds. With slow blocks the height bound comes
// last, so a delegate landing at block maxH + 600 still gets its 2 minutes: they count from the block past it.
test("step 7: with slow blocks the 2 minutes count from the first block past the height bound", () => {
  assert.equal(secondScanBoundHeight(AT), maxH + 601);
  const B = maxT + 20 * MIN; // block maxH + 601 came 20 min after the restore
  const H = maxH + 601;
  assert.equal(secondScanDue(AT, now([maxT + 13 * MIN, maxT + 13 * MIN], [H, H]), [B, B]), false, "past 10 + 2 min but not 2 min past the height bound");
  assert.equal(secondScanDue(AT, now([B + 2 * MIN, B + 2 * MIN], [H, H]), [B, B]), false, "exactly 2 min past it");
  assert.equal(secondScanDue(AT, now([B + 2 * MIN + 1, B + 2 * MIN + 1], [H, H]), [B - 5, B]), true, "the later of the two RPCs' times counts");
  assert.equal(secondScanDue(AT, now([B + 2 * MIN, B + 2 * MIN + 1], [H, H]), [B - 5, B]), false);
  // before the height bound is passed there is no bound block to read: not due
  assert.equal(secondScanDue(AT, now([B + 9 * MIN, B + 9 * MIN], [maxH + 600, H]), null), false);
  assert.throws(() => secondScanDue(AT, now([B + 9 * MIN, B + 9 * MIN], [H, H]), null), /the bound block's times are needed once both heights are past it/);
});

test("step 7: secondScanDue takes only safe positive integers, two of each", () => {
  const ok = now([maxT + 13 * MIN, maxT + 13 * MIN], [maxH + 700, maxH + 700]);
  for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "5" as unknown as number]) {
    assert.throws(() => secondScanDue({ ...AT, heights: [bad, 1] }, ok, EARLY), /safe positive integer/);
    assert.throws(() => secondScanDue(AT, { ...ok, timesMs: [ok.timesMs[0], bad] }, EARLY), /safe positive integer/);
  }
  assert.throws(() => secondScanDue({ ...AT, heights: [1] as unknown as [number, number] }, ok, EARLY), /two/);
});

// ---------- step 7: an arm with nothing visible ----------
const ALONE: Pick<NoteRestore, "spends"> = { spends: [spend(L1, 0)] };
const NONE: Pick<WalletRestore, "wallets" | "unread"> = { wallets: [], unread: [] };
const armsOf = async (r: Pick<NoteRestore, "spends">, w: Pick<WalletRestore, "wallets">, vals: Record<string, unknown> = {}): Promise<ArmRestore> =>
  restoreArmAccounts(SEED, r, w, reader(vals).read);

test("step 7: a landed arm whose A, W and V hold nothing is re-read: its three W and its V", async () => {
  const got = quietArms(SEED, ALONE, await armsOf(ALONE, NONE), NONE);
  assert.deepEqual(json(got), json([{
    l: L1, j: 0, note: `note-${L1}-0`,
    w: [
      { c: "sol", address: W("sol", L1, 0), chains: ["solana"] },
      { c: "evm", address: W("evm", L1, 0), chains: ["base", "robinhood"] },
      { c: "near", address: W("near", L1, 0), chains: ["near"] },
    ],
    v: V(L1, 0),
  }]));
  // settled with nothing refunded is landed too (anyone may settle a paid spend)
  const settled = { spends: [spend(L1, 0, { status: "settled", refundValue: 0n })] };
  assert.equal(quietArms(SEED, settled, await armsOf(settled, NONE), NONE).length, 1);
});

test("step 7: an arm that did not land at A is left out (in flight, refunded, or paid to another account)", async () => {
  for (const o of [{ status: "in_flight" }, { status: "refund_pending", refundValue: 10n }, { status: "settled", refundValue: 10n }, { recipient: "typed.testnet" }] as Partial<VaultSpendRow>[]) {
    const r = { spends: [spend(L1, 0, o)] };
    assert.deepEqual(quietArms(SEED, r, await armsOf(r, NONE), NONE), [], json(o));
  }
});

test("step 7: an arm with any money, any wallet found, or any read unread is left out", async () => {
  const cases: [string, Record<string, unknown>, Pick<WalletRestore, "wallets" | "unread">][] = [
    ["A usdc", { [`usdc ${A(L1, 0)}`]: 1n }, NONE],
    ["A near", { [`near ${A(L1, 0)}`]: 1n }, NONE],
    ["A intents", { [`intents ${A(L1, 0)}`]: 1n }, NONE],
    ["V intents", { [`intents ${V(L1, 0)}`]: 1n }, NONE],
    ["V usdc", { [`usdc ${V(L1, 0)}`]: 1n }, NONE],
    ["A unread", { [`near ${A(L1, 0)}`]: new Error("down") }, NONE],
    ["V halt", { [`usdc ${V(L1, 0)}`]: new Error("FiatToken: paused") }, NONE],
    ["a W found", {}, { wallets: [wallet("evm", L1, 0)], unread: [] }],
    ["a hop target found", {}, { wallets: [wallet("hop-near", L1, 0)], unread: [] }],
    ["a W unread", {}, { wallets: [], unread: [{ c: "sol", l: L1, j: 0, address: W("sol", L1, 0), chain: "solana", error: "down" } satisfies UnreadWallet] }],
  ];
  for (const [name, vals, w] of cases) {
    const arms = await armsOf(ALONE, w, vals);
    assert.deepEqual(quietArms(SEED, ALONE, arms, w), [], name);
  }
  // an R of the arm that holds money or is unread leaves it out too
  const withR = { wallets: [wallet("near", L1, 0)] };
  const armsR = await armsOf(ALONE, withR, { [`usdc ${R("near", L1, 0)}`]: new Error("down") });
  assert.deepEqual(quietArms(SEED, ALONE, armsR, { wallets: [], unread: [] }), []);
  // another arm's money or failure does not leave this one out
  const both = { spends: [spend(L1, 0), spend(L2, 1)] };
  const arms2 = await armsOf(both, NONE, { [`usdc ${A(L2, 1)}`]: 5n, [`near ${V(L2, 1)}`]: new Error("x") });
  const w2 = { wallets: [wallet("sol", L2, 1)], unread: [{ c: "near", l: L2, j: 1, address: W("near", L2, 1), chain: "near", error: "d" } satisfies UnreadWallet] };
  assert.deepEqual(quietArms(SEED, both, arms2, w2).map((q) => [q.l, q.j]), [[L1, 0]]);
});

test("step 7: arm reads that do not cover a landed arm stop quietArms", async () => {
  const empty: ArmRestore = { accounts: [], unread: [] };
  assert.throws(() => quietArms(SEED, ALONE, empty, NONE), /no step 5 read/);
  const other = await armsOf({ spends: [spend(L2, 1)] }, NONE);
  assert.throws(() => quietArms(SEED, ALONE, other, NONE), /no step 5 read/);
});
