// node --test packages/wallet/test/hop-out.test.ts (card wallet-hop-out): a hop's first leg, the vault paying whole
// dollars to the device's own fresh NEAR accounts A_{l,j}, one USDC rung each. The vault is withdraw-fixture.ts's: the
// public test seed's deposit notes of 2, 5 and 10 USDC, the relayer's fixture config, fee_max's recorded reads. The
// prover answers the input's own signals without proving (signalsProver). Test values only, never money.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { VaultProver } from "@blindfill/kit";
import { armAccount } from "../src/derive/index.ts";
import { HOP_KEY, hopOut, hopRungs, type HopOutArgs, type HopRecord } from "../src/hop/out.ts";
import { restoreArmAccounts } from "../src/restore/arms.ts";
import type { RestoredSpend } from "../src/notes/restore.ts";
import { argsFor, closeVaults, FEE_MAX, RELAY_FEE, SEED, signalsProver, vaultWith, type Vault } from "./withdraw-fixture.ts";

after(closeVaults);

const USDC = 1_000_000n;
const aOf = (l: bigint, j: number): string => {
  const a = armAccount(SEED, l, j);
  a.secretKey.fill(0);
  return a.id;
};
function hopArgs(v: Vault, prover: VaultProver, over: Partial<HopOutArgs> = {}): HopOutArgs {
  const { amount: _a, to: _t, note: _n, claim: _c, ...base } = argsFor(v, prover);
  return { ...base, id: "hop-1", chain: "solana", amount: 7n * USDC, store: v.w, createdMs: 1_793_750_000_000, ...over };
}
const states = async (v: Vault): Promise<string[]> => (await v.ns.list()).map((n) => n.state);
const nothingWritten = async (v: Vault, id = "hop-1"): Promise<void> => {
  assert.equal(await v.w.get("quotes", HOP_KEY + id), undefined, "no hop record");
  assert.equal(await v.w.get("ops", id), undefined, "no op");
  assert.deepEqual(await states(v), ["UNSPENT", "UNSPENT", "UNSPENT"]);
};

test("hopRungs: whole dollars as the USDC ladder's rungs from $2, largest first; what no rung covers is named", () => {
  assert.deepEqual(hopRungs(7n * USDC), { rungs: [5n * USDC, 2n * USDC], left: 0n });
  assert.deepEqual(hopRungs(4n * USDC), { rungs: [2n * USDC, 2n * USDC], left: 0n });
  assert.deepEqual(hopRungs(27n * USDC), { rungs: [20n * USDC, 5n * USDC, 2n * USDC], left: 0n });
  assert.deepEqual(hopRungs(3n * USDC), { rungs: [2n * USDC], left: USDC });
  assert.deepEqual(hopRungs(2_500_000n), { rungs: [2n * USDC], left: 500_000n });
});

test("a 7 USDC hop proves rungs 5 and 2, each from its own note to that note's own A, fund_recipient true", async () => {
  const v = await vaultWith();
  const prover = signalsProver();
  const r = await hopOut(hopArgs(v, prover));
  assert.equal(r.failed, undefined);
  assert.equal(r.requests.length, 2);
  // rung 5 is paid by the 10 USDC note (the 5 note cannot carry 5 and the fee), rung 2 by the 5 USDC note
  const [ten, five] = [v.notes[2]!, v.notes[1]!];
  const want = [
    { note: ten, rung: 5n * USDC },
    { note: five, rung: 2n * USDC },
  ];
  for (const [k, w] of want.entries()) {
    const q = r.requests[k]!;
    assert.equal(q.noteId, w.note.id);
    assert.equal(q.recipient, aOf(w.note.leaf!.label, 0));
    assert.equal(q.body.withdrawal.recipient, q.recipient);
    assert.equal(q.body.fund_recipient, true);
    assert.equal(BigInt(q.body.withdrawal.relay_fee), RELAY_FEE);
    assert.equal(BigInt(q.body.public_signals[2]!), w.rung + RELAY_FEE, "the note withdraws the rung and its fee: A gets the rung");
  }
  assert.notEqual(r.requests[0]!.recipient, r.requests[1]!.recipient);
  // the record and the op: X, the amount, each rung's note and A, RESERVED once proved
  const rec = (await v.w.get("quotes", HOP_KEY + "hop-1")) as HopRecord;
  assert.equal(rec.chain, "solana");
  assert.equal(rec.amount, 7n * USDC);
  assert.deepEqual(
    rec.rungs.map((x) => [x.rung, x.note, x.a, x.state]),
    want.map((w) => [w.rung, w.note.id, aOf(w.note.leaf!.label, 0), "reserved"]),
  );
  assert.deepEqual(await v.w.get("ops", "hop-1"), { kind: "hop", stage: "in_flight", txs: [], created_ms: 1_793_750_000_000 });
  const byId = new Map((await v.ns.list()).map((n) => [n.id, n.state]));
  assert.deepEqual(v.notes.map((n) => byId.get(n.id)), ["UNSPENT", "RESERVED", "RESERVED"]);
});

test("the record and the op are written before the first proof, so a page that dies mid-hop leaves its A named", async () => {
  const v = await vaultWith();
  const inner = signalsProver();
  const seen: unknown[] = [];
  const prover: VaultProver = {
    load: inner.load,
    async prove(circuit, input) {
      seen.push([await v.w.get("quotes", HOP_KEY + "hop-1"), await v.w.get("ops", "hop-1")]);
      return inner.prove(circuit, input);
    },
  };
  await hopOut(hopArgs(v, prover));
  assert.equal(seen.length, 2);
  const [rec, op] = seen[0] as [HopRecord, unknown];
  assert.deepEqual(rec.rungs.map((x) => x.state), ["planned", "planned"]);
  assert.deepEqual(op, { kind: "hop", stage: "in_flight", txs: [], created_ms: 1_793_750_000_000 });
});

test("a relay fee over the device's fee_max is refused before anything is written or proved", async () => {
  const v = await vaultWith();
  const prover = signalsProver();
  await assert.rejects(hopOut(hopArgs(v, prover, { relayFee: FEE_MAX + 1n })), /fee_max/);
  assert.deepEqual(prover.log, []);
  await nothingWritten(v);
});

test("a register_deposit read one RPC refuses stops the hop before anything is written or proved", async () => {
  const v = await vaultWith();
  const prover = signalsProver();
  let n = 0;
  const registerDepositOf = async (): Promise<bigint> => {
    if (++n === 2) throw new Error("rpc: one RPC refused the storage_balance_bounds read");
    return 1_250_000_000_000_000_000_000n;
  };
  await assert.rejects(hopOut(hopArgs(v, prover, { registerDepositOf })), /refused the storage_balance_bounds read/);
  assert.deepEqual(prover.log, []);
  await nothingWritten(v);
});

test("refused before anything is written: an amount that is not whole rungs, rungs the notes cannot pay one each, a hop id already recorded", async () => {
  const v = await vaultWith();
  const prover = signalsProver();
  await assert.rejects(hopOut(hopArgs(v, prover, { amount: 3n * USDC })), /rungs/);
  await assert.rejects(hopOut(hopArgs(v, prover, { amount: 0n })), /amount/);
  // 20 USDC is one rung no note covers; 17 = 10 + 5 + 2 needs three notes over 10, 5 and 2 plus their fees
  await assert.rejects(hopOut(hopArgs(v, prover, { amount: 20n * USDC })), /no unspent note covers/);
  await assert.rejects(hopOut(hopArgs(v, prover, { amount: 17n * USDC })), /no unspent note covers/);
  await assert.rejects(hopOut(hopArgs(v, prover, { chain: "near" as never })), /chain/);
  await assert.rejects(hopOut(hopArgs(v, prover, { id: "a/b" })), /id/);
  assert.deepEqual(prover.log, []);
  await nothingWritten(v);
  await hopOut(hopArgs(v, prover, { amount: 2n * USDC }));
  await assert.rejects(hopOut(hopArgs(v, prover, { amount: 2n * USDC })), /already recorded/);
});

test("4 USDC is two rungs of 2 from two notes, never one note twice", async () => {
  const v = await vaultWith();
  const r = await hopOut(hopArgs(v, signalsProver(), { amount: 4n * USDC }));
  assert.deepEqual(r.requests.map((q) => q.noteId), [v.notes[1]!.id, v.notes[2]!.id]);
});

test("a proof that fails on the second rung: the first stays RESERVED and is handed back to be sent, the second's note is freed and named", async () => {
  const v = await vaultWith();
  const inner = signalsProver();
  let calls = 0;
  const prover: VaultProver = {
    load: inner.load,
    async prove(circuit, input) {
      if (++calls === 2) throw new Error("the prover worker stopped");
      return inner.prove(circuit, input);
    },
  };
  const r = await hopOut(hopArgs(v, prover));
  assert.equal(r.requests.length, 1);
  assert.deepEqual(r.failed, { rung: 2n * USDC, error: "the prover worker stopped" });
  const rec = (await v.w.get("quotes", HOP_KEY + "hop-1")) as HopRecord;
  assert.deepEqual(rec.rungs.map((x) => x.state), ["reserved", "refused"]);
  const byId = new Map((await v.ns.list()).map((n) => [n.id, n.state]));
  assert.deepEqual(v.notes.map((n) => byId.get(n.id)), ["UNSPENT", "UNSPENT", "RESERVED"], "the 10 note (rung 5) RESERVED, the 5 note (rung 2) freed");
});

test("a hop whose first proof fails sends nothing and leaves no record or op", async () => {
  const v = await vaultWith();
  const inner = signalsProver();
  const prover: VaultProver = {
    load: inner.load,
    async prove() {
      throw new Error("the prover worker stopped");
    },
  };
  await assert.rejects(hopOut(hopArgs(v, prover)), /prover worker stopped/);
  await nothingWritten(v);
});

test("a restore from the 12 words lists each rung's A once its withdrawal is a spend, with the USDC it holds", async () => {
  const v = await vaultWith();
  const r = await hopOut(hopArgs(v, signalsProver()));
  const spends = r.requests.map((q) => ({ l: q.change.l, j: q.change.j, note: q.noteId, spend: {} }) as unknown as RestoredSpend);
  const held = new Map(r.requests.map((q, k) => [q.recipient, [5n, 2n][k]! * USDC]));
  const found = await restoreArmAccounts(SEED, { spends }, { wallets: [], unread: [] }, async (what, account) => (what === "usdc" ? (held.get(account) ?? 0n) : 0n), { pick: () => 0 });
  const as = found.accounts.filter((a) => a.kind === "A");
  assert.deepEqual(new Set(as.map((a) => a.account)), new Set(r.requests.map((q) => q.recipient)));
  for (const a of as) assert.deepEqual(a.holds, ["usdc"]);
});
