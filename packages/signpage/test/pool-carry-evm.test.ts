// The carry on a Base or Robinhood pool (src/pool-carry-evm.ts): a refused buy's ETH on W goes back into the pool as a
// note of the user's, found from the chain alone. Two mocked RPCs and a fake-indexeddb note store: the release a
// Withdrawn of a buy() call to the pool; W's deposit signed under the rule (to the pool, from W, the largest 1-2-5 rung
// at or under W's balance less the fee bound, the rest W's tail) before it leaves; UNSPENT only from a final Deposited; a lost send built again at its own nonce; a dead
// one at W's new nonce; a reload and a fresh device the same pass; a withdraw's W, a release the RPCs read apart, dust
// and a sign out never carried.
//   node --test test/pool-carry-evm.test.ts      (from packages/signpage)
// The seed is the published all-zero vector (packages/wallet/test/vectors/a8.json).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import { freshWallet } from "../../wallet/src/derive/keys.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, type NoteRecord, type NoteStore } from "../../wallet/src/notes/store.ts";
import { evmPoolScopeOf, type EvmPoolEvent, type EvmPoolPin } from "../../wallet/src/pool/evm.ts";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { EVM_POOL_MIN_DEPOSIT } from "../../kit/src/trade/evm/pool-fee.ts";
import { checkEvmCarry, evmDepositHeadroom, PoolRuleRefused, signEvmDeposit, type EvmDepositReads, type EvmOnwardSend } from "../src/rules/pool.ts";
import { EVM_DEPOSIT_PRIORITY_CAP, EVM_DEPOSIT_RESEND_MS } from "../src/pool-deposit-evm.ts";
import { EVM_BUY_SIGNATURE, EVM_WITHDRAW_SIGNATURE, evmSellVerdict, type EvmDeposited, type EvmDepositedRead } from "../src/evm-send.ts";
import { carryEvmOwed, EVM_CARRY_DONE_KEY, EVM_CARRY_OPEN_KEY, EVM_CARRY_WAIT_KEY, EVM_OWED_BACK_KEY, type EvmCarryHost, type EvmCarryOpen } from "../src/pool-carry-evm.ts";
import { evmType2Hash } from "../src/evm-tx-hash.ts";

const SEED = wordsToSeed64(entropyToWords(new Uint8Array(16)));
const POOL = "0x00000000000000000000000000000000000f0011";
const PINS: Record<"base" | "robinhood", EvmPoolPin> = {
  base: Object.freeze({ network: "base", pool: POOL, feeRecipient: "0x0000000000000000000000000000000000000fee", fromBlock: 1n }),
  robinhood: Object.freeze({ network: "robinhood", pool: POOL, feeRecipient: "0x0000000000000000000000000000000000000fee", fromBlock: 1n }),
};
const CHAIN_ID = { base: 8453n, robinhood: 4663n } as const;
const LABEL = 777n;
const CHUNK = 1_000_000_000_000_000n; // 0.001 ETH, the ladder's least chunk
const FEE = 20_000_000_000_000n;
// a refused 0.005 ETH buy: W holds the chunk less the fee, which carries as the 0.002 rung, then 0.002, then a tail
const OWED = 5n * CHUNK - FEE;
const tailOf = async (ws: { get(s: "meta", k: string): Promise<unknown> }, name: "base" | "robinhood" = "base") => ws.get("meta", `w-tail/${name}/${W}`);
const q = (v: bigint) => "0x" + v.toString(16);
const word = (v: bigint) => v.toString(16).padStart(64, "0");
const sel = (sig: string) => "0x" + Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString("hex").slice(0, 8);
const SEL_STATE_DEPTH = sel("currentTreeDepth()");
const SEL_LABEL_DEPTH = sel("currentLabelTreeDepth()");
const DEPOSIT = sel("deposit(uint256,uint256)");
const W = freshWallet(SEED, "evm", LABEL, 0).address.toLowerCase();
/** A release's transaction as the helper's route answers it: its fields hash to the hash the round's row carries. */
const releaseTxOf = (to: string, input: string) => {
  const t: Record<string, unknown> = { type: "0x2", chainId: "0x2105", nonce: "0x0", maxPriorityFeePerGas: "0x1", maxFeePerGas: "0x2", gas: "0x5208", to, value: "0x0", input, accessList: [], yParity: "0x0", r: "0x" + "5a".repeat(32), s: "0x" + "3c".repeat(32) };
  return { ...t, hash: evmType2Hash(t) } as Record<string, unknown> & { hash: string };
};
const RELEASE_BLOCK = 90n;
const RELEASE_HASH = "0x" + "90".repeat(32);
/** A Buy's input as evmBuyCalldata lays it out (evm-send.ts evmBuyCalldataRead reads it): the Buy at word 18. */
const BUY_INPUT = (() => {
  const words = Array.from({ length: 20 }, (_, k) => (k === 18 ? word(640n) : word(0n)));
  return sel(EVM_BUY_SIGNATURE) + words.join("") + word(0xa0n) + word(0x80n) + word(1n) + word(0xbbn) + word(0n);
})();
const WITHDRAW_INPUT = sel(EVM_WITHDRAW_SIGNATURE) + word(0n).repeat(20);

const closers: (() => void)[] = [];
after(() => closers.forEach((f) => f()));

function fieldsOf(rawHex: string): Uint8Array[] {
  const b = Uint8Array.from(Buffer.from(rawHex.slice(4), "hex"));
  const len = (o: number, n: number) => b.slice(o, o + n).reduce((a, x) => a * 256 + x, 0);
  let at = b[0]! <= 0xf7 ? 1 : 1 + (b[0]! - 0xf7);
  const out: Uint8Array[] = [];
  while (at < b.length) {
    const x = b[at]!;
    if (x < 0x80) (out.push(b.slice(at, at + 1)), (at += 1));
    else if (x <= 0xb7) (out.push(b.slice(at + 1, at + 1 + x - 0x80)), (at += 1 + x - 0x80));
    else if (x <= 0xbf) {
      const l = len(at + 1, x - 0xb7);
      out.push(b.slice(at + 1 + x - 0xb7, at + 1 + x - 0xb7 + l));
      at += 1 + x - 0xb7 + l;
    } else (out.push(new Uint8Array(0)), (at += 1 + x - 0xc0));
  }
  return out;
}
const big = (b: Uint8Array) => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);
const sentOf = (raw: string) => {
  const f = fieldsOf(raw);
  const data = "0x" + Buffer.from(f[7]!).toString("hex");
  return { chainId: big(f[0]!), nonce: big(f[1]!), tip: big(f[2]!), maxFee: big(f[3]!), gas: big(f[4]!), to: "0x" + Buffer.from(f[5]!).toString("hex"), value: big(f[6]!), data, pre: BigInt("0x" + data.slice(74, 138)), hash: "0x" + Buffer.from(keccak_256(Buffer.from(raw.slice(2), "hex"))).toString("hex") };
};

/** The pool's two RPCs over one chain: W's balance and nonce, the release's log and transaction, the pool's events. */
function chain(name: "base" | "robinhood" = "base") {
  const scope = evmPoolScopeOf(POOL, CHAIN_ID[name]);
  const c = {
    block: 100n,
    fin: 100n,
    baseFee: 1_000_000n,
    nonce: 0n,
    nonceAt: [null, null] as (bigint | null)[],
    pending: [null, null] as (bigint | null)[],
    balance: [OWED, OWED] as bigint[],
    events: [] as EvmPoolEvent[],
    sent: [] as string[],
    known: [new Set<string>(), new Set<string>()],
    simFail: [false, false],
    /** the release's transaction (its hash in the round's row) and how the helper's route answers for it */
    release: releaseTxOf(POOL, BUY_INPUT),
    helper: "ok" as "ok" | "withhold" | "fail" | "forge",
    helperAsked: [] as string[],
    /** every request each public RPC was sent */
    asked: [[], []] as string[][],
    estimate: 250_000n,
    /** the pool's tree depths, the L1 fee each chain-fee read answers, and W's balance at the final block (null: as latest) */
    depth: 0n,
    l1: 7_000n,
    finBalance: null as bigint[] | null,
  };
  const helper = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    c.helperAsked.push(`${method} ${JSON.stringify(params)}`);
    if (method !== "eth_getTransactionByHash") throw new Error(`no ${method} on the helper`);
    if (c.helper === "fail") throw new Error("HTTP 503");
    if (c.helper === "withhold" || params[0] !== c.release.hash) return null;
    // another transaction under the agreed hash: its fields hash to another
    if (c.helper === "forge") return { ...c.release, input: c.release.input === BUY_INPUT ? WITHDRAW_INPUT : BUY_INPUT };
    return c.release;
  };
  const rpc =
    (k: number) =>
    async (method: string, params: readonly unknown[]): Promise<unknown> => {
      const p = params as unknown[];
      c.asked[k]!.push(`${method} ${JSON.stringify(params)}`);
      switch (method) {
        case "eth_getBlockByNumber": {
          const n = p[0] === "latest" ? c.block : p[0] === "finalized" ? c.fin : BigInt(p[0] as string);
          // a release's block, its transactions or its logs are never asked of a public RPC
          if (p[1] === true || n === RELEASE_BLOCK) throw new Error("a release's block asked of a public RPC");
          return { number: q(n), hash: `0x${"11".repeat(32)}`, timestamp: "0x1", baseFeePerGas: q(c.baseFee) };
        }
        case "eth_getTransactionCount":
          if (typeof p[1] === "object" && p[1] !== null) return q(c.nonceAt[k] ?? c.nonce);
          return q(p[1] === "pending" ? (c.pending[k] ?? c.nonce) : c.nonce);
        case "eth_getTransactionByHash":
          return c.known[k]!.has(p[0] as string) ? { hash: p[0] } : null;
        case "eth_getBalance":
          if (String(p[0]).toLowerCase() !== W) return q(0n);
          return q(c.finBalance !== null && p[1] === q(c.fin) ? c.finBalance[k]! : c.balance[k]!);
        case "eth_estimateGas":
          return q(c.estimate);
        case "eth_call": {
          const call = p[0] as { from?: string; data: string };
          if (call.from !== undefined) {
            if (c.simFail[k]) throw new Error("RPC error 3: execution reverted");
            return "0x";
          }
          if (call.data === SEL_STATE_DEPTH) return "0x" + word(c.depth);
          if (call.data === SEL_LABEL_DEPTH) return "0x" + word(c.depth);
          return "0x" + word(call.data.startsWith("0xf1c7a58b") ? c.l1 : 0n);
        }
        case "eth_sendRawTransaction": {
          const raw = p[0] as string;
          if (k === 0) c.sent.push(raw);
          return sentOf(raw).hash;
        }
      }
      throw new Error(`unmocked ${method}`);
    };
  /** a deposit of `pre` at `value` lands at a final block */
  const land = (pre: bigint, value: bigint) => {
    const label = vaultLabelOf(keccak_256, scope, BigInt(c.events.filter((e) => e.kind === "deposit").length + 1));
    c.events.push({ block: c.fin, blockHash: `0x${"ab".repeat(32)}`, logIndex: BigInt(c.events.length), bytes: "", kind: "deposit", state: noteCommitment(value, label, pre), label, value, precommitment: pre, nullifier: null, recipient: null, token: null } as EvmPoolEvent);
  };
  return { c, scope, land, rpcs: [rpc(0), rpc(1)] as const, helper };
}

async function stores(idb = new IDBFactory()): Promise<{ ns: NoteStore; ws: WalletStore; idb: IDBFactory }> {
  const ws = await openWalletStore({ indexedDB: idb });
  closers.push(() => ws.close());
  const ns = await openNoteStore(ws);
  closers.push(() => ns.close());
  return { ns, ws, idb };
}

/** A spent deposit note of the pool's scope whose release paid W (as a restore from the words writes it: the note
 *  SPENT with its change UNSPENT), and the release's Withdrawn in the pool's events. */
async function refused(ch: ReturnType<typeof chain>, ns: NoteStore): Promise<NoteRecord> {
  const planned = await ns.planDeposit(ch.scope, (ref) => noteSecrets(SEED, ref).precommitment);
  const value = 3n * CHUNK;
  await ns.move(planned.id, "PLANNED", "INCOMING", { evmSend: { hash: "0x" + "01".repeat(32), nonce: 0n, value, sentMs: 1n } });
  await ns.move(planned.id, "INCOMING", "UNSPENT", { leaf: { value, label: LABEL, commitment: noteCommitment(value, LABEL, planned.precommitment), leafIndex: 0n } });
  const change: NoteRef = { kind: "change", l: LABEL, j: 0 };
  const cpre = noteSecrets(SEED, change).precommitment;
  await ns.add({ ref: change, scope: ch.scope, precommitment: cpre, state: "UNSPENT", leaf: { value: value - CHUNK, label: LABEL, commitment: noteCommitment(value - CHUNK, LABEL, cpre), leafIndex: 1n } });
  ch.c.events.push({ block: RELEASE_BLOCK, blockHash: RELEASE_HASH, logIndex: 3n, bytes: [q(RELEASE_BLOCK), RELEASE_HASH, "0x3", ch.c.release.hash, "0x0", POOL, "t0", "t1", "0x"].join(" "), kind: "withdraw", state: 1n, label: null, value: CHUNK, precommitment: null, nullifier: noteSecrets(SEED, planned.ref).nullifierHash, recipient: W, token: null } as EvmPoolEvent);
  return planned;
}

function hostOf(ch: ReturnType<typeof chain>, ns: NoteStore, ws: WalletStore, name: "base" | "robinhood" = "base", o: Partial<EvmCarryHost> = {}): EvmCarryHost & { seeds: Uint8Array[]; clock: { t: number } } {
  const seeds: Uint8Array[] = [];
  const clock = { t: 1_000_000 };
  return {
    seeds,
    clock,
    chain: name,
    testnet: false,
    pin: PINS[name],
    scope: ch.scope,
    rpcs: ch.rpcs,
    helper: ch.helper,
    round: async () => ({ events: [...ch.c.events], fin: { number: ch.c.fin } }),
    notes: async () => ns,
    seed64: async () => (seeds.push(SEED.slice()), seeds.at(-1)!),
    held: async () => ws,
    now: () => clock.t,
    wait: async () => {},
    ...o,
  };
}
const carries = async (ns: NoteStore, scope: bigint) => (await ns.list()).filter((n) => n.scope === scope && (n.ref.kind === "return" || n.ref.kind === "second"));
const RETURN: NoteRef = { kind: "return", c: "evm", l: LABEL, j: 0 };
const RETURN_PRE = noteSecrets(SEED, RETURN).precommitment;

for (const name of ["base", "robinhood"] as const) {
  test(`${name}: a refused buy's ETH on W is carried into the pool by W's own deposit, INCOMING before it leaves, UNSPENT from its final Deposited, W ended carried; the seed zeroed`, async () => {
    const ch = chain(name);
    const { ns, ws } = await stores();
    await refused(ch, ns);
    await ws.update("meta", EVM_OWED_BACK_KEY, () => ({ [W]: { address: W, chain: name, wei: OWED.toString(), tx: ch.c.release.hash, block: "90" } }));
    const h = hostOf(ch, ns, ws, name);
    assert.deepEqual(await carryEvmOwed(h), [{ w: W, end: "sent" }]);
    assert.equal(ch.c.sent.length, 1);
    const s = sentOf(ch.c.sent[0]!);
    // to the pinned pool, deposit(value, the return note's precommitment), from W at its nonce, on the chain's id
    assert.equal(s.to, POOL);
    assert.equal(s.data, DEPOSIT + word(s.value) + word(RETURN_PRE));
    assert.equal(s.chainId, CHAIN_ID[name]);
    assert.equal(s.nonce, 0n);
    const gas = 250_000n + evmDepositHeadroom(0n, 0n);
    assert.equal(s.gas, gas);
    assert.equal(s.maxFee, 2n * ch.c.baseFee + EVM_DEPOSIT_PRIORITY_CAP);
    const l1 = name === "base" ? 7_000n : 0n;
    assert.ok(OWED - gas * s.maxFee - l1 < 5n * CHUNK);
    assert.equal(s.value, 2n * CHUNK, "the largest rung at or under W's balance less the send's bound");
    const open = await carries(ns, ch.scope);
    assert.equal(open.length, 1);
    assert.equal(open[0]!.state, "INCOMING");
    assert.deepEqual(open[0]!.ref, RETURN);
    const rec = ((await ws.get("meta", EVM_CARRY_OPEN_KEY)) as Record<string, EvmCarryOpen>)[W]!;
    assert.deepEqual([rec.note, rec.l, rec.j, rec.sends.map((x) => x.hash)], [open[0]!.id, LABEL.toString(), 0, [s.hash]], "the send kept before it left");
    // not landed yet: pending, nothing sent again
    assert.deepEqual(await carryEvmOwed(h), [{ w: W, end: "pending" }]);
    assert.equal(ch.c.sent.length, 1);
    ch.land(s.pre, s.value);
    ch.c.nonce = 1n;
    ch.c.balance = [gas * s.maxFee - 100_000n, gas * s.maxFee - 100_000n];
    assert.deepEqual(await carryEvmOwed(h), [{ w: W, end: "landed" }]);
    const landed = (await carries(ns, ch.scope))[0]!;
    assert.equal(landed.state, "UNSPENT");
    assert.equal(landed.leaf!.value, s.value);
    assert.deepEqual(await ws.get("meta", EVM_CARRY_DONE_KEY), { [W]: { chain: name, end: "carried" } });
    assert.deepEqual(await tailOf(ws, name), { chain: name, address: W, l: LABEL.toString(), j: 0, amount: (gas * s.maxFee - 100_000n).toString() }, "what is left under the least rung is W's tail");
    assert.deepEqual(await ws.get("meta", EVM_OWED_BACK_KEY), {}, "the owed list ends empty");
    assert.deepEqual(await ws.get("meta", EVM_CARRY_OPEN_KEY), {}, "no open carry");
    // ended: never read again
    assert.deepEqual(await carryEvmOwed(h), []);
    assert.equal(ch.c.sent.length, 1);
    assert.ok(h.seeds.every((x) => x.every((b) => b === 0)), "every seed copy zeroed");
  });
}

test("a fresh device restored from the words (no buy record, no owed hint, only the notes the restore writes) carries the same ETH", async () => {
  const ch = chain();
  const { ns, ws } = await stores();
  await refused(ch, ns);
  assert.equal(await ws.get("meta", EVM_OWED_BACK_KEY), undefined);
  assert.deepEqual(await carryEvmOwed(hostOf(ch, ns, ws)), [{ w: W, end: "sent" }]);
  assert.equal(sentOf(ch.c.sent[0]!).pre, RETURN_PRE);
});

test("a reload mid-carry (the page closed after the send) follows the open note on the next load: nothing signed twice, landed", async () => {
  const ch = chain();
  const first = await stores();
  await refused(ch, first.ns);
  await carryEvmOwed(hostOf(ch, first.ns, first.ws));
  first.ns.close();
  const again = await stores(first.idb);
  const h = hostOf(ch, again.ns, again.ws);
  assert.deepEqual(await carryEvmOwed(h), [{ w: W, end: "pending" }]);
  assert.equal(ch.c.sent.length, 1);
  const s = sentOf(ch.c.sent[0]!);
  ch.land(s.pre, s.value);
  ch.c.balance = [10n ** 12n, 10n ** 12n];
  assert.deepEqual(await carryEvmOwed(h), [{ w: W, end: "landed" }]);
  assert.equal(ch.c.sent.length, 1);
});

test("a send that reached neither RPC is built again at its own nonce once EVM_DEPOSIT_RESEND_MS has passed, never before; one note", async () => {
  const ch = chain();
  const { ns, ws } = await stores();
  await refused(ch, ns);
  const h = hostOf(ch, ns, ws);
  await carryEvmOwed(h);
  assert.deepEqual(await carryEvmOwed(h), [{ w: W, end: "pending" }], "too early");
  h.clock.t += Number(EVM_DEPOSIT_RESEND_MS.base);
  ch.c.known[0]!.add(sentOf(ch.c.sent[0]!).hash);
  assert.deepEqual(await carryEvmOwed(h), [{ w: W, end: "pending" }], "an RPC knows it: it may land");
  ch.c.known[0]!.clear();
  ch.c.baseFee = 2_000_000n; // fees moved: a new value at the same nonce
  assert.deepEqual(await carryEvmOwed(h), [{ w: W, end: "sent" }]);
  assert.equal(ch.c.sent.length, 2);
  const [a, b] = ch.c.sent.map(sentOf);
  assert.equal(b!.nonce, a!.nonce, "the same nonce: at most one lands");
  assert.equal(b!.pre, a!.pre, "the same note");
  const open = await carries(ns, ch.scope);
  assert.equal(open.length, 1);
  assert.deepEqual(((await ws.get("meta", EVM_CARRY_OPEN_KEY)) as Record<string, EvmCarryOpen>)[W]!.sends.map((x) => x.hash), [a!.hash, b!.hash]);
});

test("a dead send (W's nonce past it at a block final on both RPCs, no Deposited) is built again on the same note at W's new nonce", async () => {
  const ch = chain();
  const { ns, ws } = await stores();
  await refused(ch, ns);
  const h = hostOf(ch, ns, ws);
  await carryEvmOwed(h);
  // the deposit reverted on chain: W's nonce on, its gas spent, no Deposited
  ch.c.nonce = 1n;
  ch.c.balance = [OWED - 10n ** 12n, OWED - 10n ** 12n];
  ch.c.block = 101n;
  assert.deepEqual(await carryEvmOwed(h), [{ w: W, end: "pending" }], "the block W's nonce moved at is not final yet");
  ch.c.fin = 101n;
  assert.deepEqual(await carryEvmOwed(h), [{ w: W, end: "sent" }]);
  const b = sentOf(ch.c.sent[1]!);
  assert.equal(b.nonce, 1n);
  assert.equal(b.pre, RETURN_PRE);
  assert.equal(b.value, 2n * CHUNK, "the rung of W's balance now, its gas spent");
});

test("a withdraw's W (its release not a Buy) is never carried, and ended so; nothing signed", async () => {
  const ch = chain();
  ch.c.release = releaseTxOf(POOL, WITHDRAW_INPUT);
  const { ns, ws } = await stores();
  await refused(ch, ns);
  const h = hostOf(ch, ns, ws);
  assert.deepEqual(await carryEvmOwed(h), [{ w: W, end: "withdraw" }]);
  assert.equal(ch.c.sent.length, 0);
  assert.deepEqual(await ws.get("meta", EVM_CARRY_DONE_KEY), { [W]: { chain: "base", end: "withdraw" } });
  assert.deepEqual(await carryEvmOwed(h), []);
});

test("a release through another contract is never carried (other); one the helper withholds, fails or answers with another transaction under the hash is left unread for a later pass", async () => {
  const other = chain();
  other.c.release = releaseTxOf("0x00000000000000000000000000000000000000cc", BUY_INPUT);
  const a = await stores();
  await refused(other, a.ns);
  assert.deepEqual(await carryEvmOwed(hostOf(other, a.ns, a.ws)), [{ w: W, end: "other" }]);
  for (const mode of ["withhold", "fail", "forge"] as const) {
    const apart = chain();
    apart.c.helper = mode;
    const b = await stores();
    await refused(apart, b.ns);
    assert.deepEqual(await carryEvmOwed(hostOf(apart, b.ns, b.ws)), [{ w: W, end: "unread" }], mode);
    assert.equal(apart.c.sent.length, 0);
    assert.equal(await b.ws.get("meta", EVM_CARRY_DONE_KEY), undefined, "read again on the next pass");
    // and read again: the helper answers now
    apart.c.helper = "ok";
    assert.deepEqual(await carryEvmOwed(hostOf(apart, b.ns, b.ws)), [{ w: W, end: "sent" }], `${mode}, then answered`);
  }
  assert.equal(other.c.sent.length, 0);
});

test("dust: W under the least rung is its tail (or empty at 0), its rest recorded; a rung that fits only under the bound is a tail too; over the fee at this base fee it is read again (high_fee); a failed simulation signs nothing", async () => {
  const ch = chain();
  ch.c.balance = [EVM_POOL_MIN_DEPOSIT, EVM_POOL_MIN_DEPOSIT + 1n];
  const { ns, ws } = await stores();
  await refused(ch, ns);
  assert.deepEqual(await carryEvmOwed(hostOf(ch, ns, ws)), [{ w: W, end: "tail" }]);
  assert.deepEqual(await ws.get("meta", EVM_CARRY_DONE_KEY), { [W]: { chain: "base", end: "tail" } });
  assert.deepEqual(await tailOf(ws), { chain: "base", address: W, l: LABEL.toString(), j: 0, amount: EVM_POOL_MIN_DEPOSIT.toString() });
  const zero = chain();
  zero.c.balance = [0n, 0n];
  const z = await stores();
  await refused(zero, z.ns);
  assert.deepEqual(await carryEvmOwed(hostOf(zero, z.ns, z.ws)), [{ w: W, end: "empty" }]);
  assert.equal(await tailOf(z.ws), undefined, "no tail of nothing");
  // W holds the least rung, but not with the send's bound on top: no rung fits, so its tail
  const edge = chain();
  edge.c.balance = [CHUNK + 1n, CHUNK + 1n];
  const g = await stores();
  await refused(edge, g.ns);
  assert.deepEqual(await carryEvmOwed(hostOf(edge, g.ns, g.ws)), [{ w: W, end: "tail" }]);
  assert.equal(edge.c.sent.length + zero.c.sent.length, 0);
  const hi = chain();
  hi.c.baseFee = 10n ** 12n;
  const b = await stores();
  await refused(hi, b.ns);
  assert.deepEqual(await carryEvmOwed(hostOf(hi, b.ns, b.ws)), [{ w: W, end: "high_fee" }]);
  assert.equal(await b.ws.get("meta", EVM_CARRY_DONE_KEY), undefined);
  const sim = chain();
  sim.c.simFail = [false, true];
  const c = await stores();
  await refused(sim, c.ns);
  assert.deepEqual(await carryEvmOwed(hostOf(sim, c.ns, c.ws)), [{ w: W, end: "sim_failed" }]);
  assert.equal(ch.c.sent.length + hi.c.sent.length + sim.c.sent.length, 0);
  assert.equal((await carries(c.ns, sim.scope)).length, 0, "no note written");
});

test("a sign out before W signs: nothing signed, written or sent", async () => {
  const ch = chain();
  const { ns, ws } = await stores();
  await refused(ch, ns);
  const stop = new AbortController();
  // aborted once the simulation has been asked: the reads ran, the signature never does
  const rpcs = [async (m: string, p: readonly unknown[]) => (m === "eth_call" && (p[0] as { from?: string }).from ? (stop.abort(), "0x") : ch.rpcs[0](m, p)), ch.rpcs[1]] as const;
  assert.deepEqual(await carryEvmOwed(hostOf(ch, ns, ws, "base", { rpcs, signal: stop.signal })), [{ w: W, end: "pending" }]);
  assert.equal(ch.c.sent.length, 0);
  assert.equal((await carries(ns, ch.scope)).length, 0);
});

test("a release to another W (the note's secrets used elsewhere) is not the user's W's: never carried", async () => {
  const ch = chain();
  const { ns, ws } = await stores();
  await refused(ch, ns);
  ch.c.events = ch.c.events.map((e) => (e.kind === "withdraw" ? { ...e, recipient: "0x00000000000000000000000000000000000000dd" } : e));
  assert.deepEqual(await carryEvmOwed(hostOf(ch, ns, ws)), []);
});

// the rule: every field held as U's deposit is, and the largest rung at or under W's lower balance less the bound exactly
const READS: EvmDepositReads = { nonce: [0n, 0n], balance: [OWED, OWED + 5n], estimate: [250_000n, 250_000n], baseFee: [1_000_000n, 1_000_000n], l1Fee: [7_000n, 7_000n], stateDepth: [0n, 0n], labelDepth: [0n, 0n], priorityCap: EVM_DEPOSIT_PRIORITY_CAP };
const GAS = 250_000n + evmDepositHeadroom(0n, 0n);
const MAXFEE = 2n * 1_000_000n + EVM_DEPOSIT_PRIORITY_CAP;
const WHOLE = OWED - GAS * MAXFEE - 7_000n;
const VALUE = 2n * CHUNK; // the largest rung at or under WHOLE
const callOf = (value: bigint, pre = RETURN_PRE, to = POOL) => Object.freeze({ to, value, data: DEPOSIT + word(value) + word(pre) });
const txOf = (o: Partial<EvmOnwardSend> = {}, call = callOf(VALUE)): EvmOnwardSend => ({ type: 2, chainId: 8453n, nonce: 0n, maxPriorityFeePerGas: EVM_DEPOSIT_PRIORITY_CAP, maxFeePerGas: MAXFEE, gasLimit: GAS, to: call.to, value: call.value, data: call.data, accessList: [], ...o });
const ctxOf = (call = callOf(VALUE)) => ({ wallet: W, precommitment: RETURN_PRE, call, pin: PINS.base, chain: "base" as const });
const rule = (f: () => unknown): string => {
  try {
    f();
    return "passed";
  } catch (e) {
    assert.ok(e instanceof PoolRuleRefused, String(e));
    return e.rule;
  }
};

test("checkEvmCarry: the rung of W's lower balance less the bound, to the pinned pool's deposit, on the pin's chain; signed with W's key only", () => {
  const tx = txOf();
  assert.equal(rule(() => checkEvmCarry(tx, ctxOf(), READS)), "passed");
  const raw = signEvmDeposit(freshWallet(SEED, "evm", LABEL, 0).secretKey, tx);
  assert.equal(sentOf("0x" + Buffer.from(raw).toString("hex")).to, POOL);
  assert.equal(rule(() => signEvmDeposit(freshWallet(SEED, "evm", LABEL, 1).secretKey, tx)), "wallet", "another key never signs W's carry");
  // a value off the ladder, or a lower rung: refused, and nothing of it can be signed
  const less = callOf(VALUE - 1n);
  const kept = txOf({}, less);
  assert.equal(rule(() => checkEvmCarry(kept, ctxOf(less), READS)), "amount");
  const lower = callOf(CHUNK);
  assert.equal(rule(() => checkEvmCarry(txOf({}, lower), ctxOf(lower), READS)), "amount");
  const whole = callOf(WHOLE);
  assert.equal(rule(() => checkEvmCarry(txOf({}, whole), ctxOf(whole), READS)), "amount", "W's whole balance less the bound is off the ladder");
  assert.equal(rule(() => signEvmDeposit(freshWallet(SEED, "evm", LABEL, 0).secretKey, kept)), "unchecked");
  const more = callOf(WHOLE + 1n);
  assert.equal(rule(() => checkEvmCarry(txOf({}, more), ctxOf(more), READS)), "balance");
  const elsewhere = callOf(VALUE, RETURN_PRE, "0x00000000000000000000000000000000000000cc");
  assert.equal(rule(() => checkEvmCarry(txOf({}, elsewhere), ctxOf(elsewhere), READS)), "to");
  assert.equal(rule(() => checkEvmCarry(txOf({ to: "0x00000000000000000000000000000000000000cc" }), ctxOf(), READS)), "to");
  assert.equal(rule(() => checkEvmCarry(txOf(), { ...ctxOf(), precommitment: RETURN_PRE + 1n }, READS)), "data");
  assert.equal(rule(() => checkEvmCarry(txOf({ data: sel("withdraw(uint256)") + word(VALUE) + word(RETURN_PRE) }), ctxOf(), READS)), "data");
  assert.equal(rule(() => checkEvmCarry(txOf({ chainId: 84532n }), ctxOf(), READS)), "chain_id");
  assert.equal(rule(() => checkEvmCarry(txOf({ nonce: 1n }), ctxOf(), READS)), "nonce");
  assert.equal(rule(() => checkEvmCarry(txOf(), { ...ctxOf(), chain: "solana" as never }, READS)), "chain");
  assert.equal(rule(() => checkEvmCarry(txOf(), { ...ctxOf(), pin: PINS.robinhood }, READS)), "evm_not_pinned");
  assert.equal(rule(() => checkEvmCarry(txOf({ gasLimit: GAS + 1n }), ctxOf(), READS)), "gas_estimate");
});

/** A device restored from the words with several releases, each paying its own W: `kind` of each release, W's balance.
 *  Every request each public RPC gets is kept, per pass. */
async function several(releases: { label: bigint; block: bigint; input: string; balance: bigint }[]) {
  const ch = chain();
  const { ns, ws } = await stores();
  const wOf = (label: bigint) => freshWallet(SEED, "evm", label, 0).address.toLowerCase();
  const txs = releases.map((r) => releaseTxOf(POOL, r.input));
  for (const [i, r] of releases.entries()) {
    const planned = await ns.planDeposit(ch.scope, (ref) => noteSecrets(SEED, ref).precommitment);
    const value = 3n * CHUNK;
    await ns.move(planned.id, "PLANNED", "INCOMING", { evmSend: { hash: "0x" + (i + 1).toString(16).padStart(64, "0"), nonce: 0n, value, sentMs: 1n } });
    await ns.move(planned.id, "INCOMING", "UNSPENT", { leaf: { value, label: r.label, commitment: noteCommitment(value, r.label, planned.precommitment), leafIndex: BigInt(2 * i) } });
    await ns.move(planned.id, "UNSPENT", "SPENT").catch(async () => {});
    const hash = "0x" + r.block.toString(16).padStart(64, "9");
    ch.c.events.push({ block: r.block, blockHash: hash, logIndex: 3n, bytes: [q(r.block), hash, "0x3", txs[i]!.hash, "0x0", POOL, "t0", "t1", "0x"].join(" "), kind: "withdraw", state: BigInt(1_000 + i), label: null, value: CHUNK, precommitment: null, nullifier: noteSecrets(SEED, planned.ref).nullifierHash, recipient: wOf(r.label), token: null } as EvmPoolEvent);
  }
  const asked: string[][] = [[], []];
  const balanceOf = (w: string) => releases.find((r) => wOf(r.label) === w)?.balance ?? 0n;
  const rpc = (k: 0 | 1) => async (method: string, params: readonly unknown[]) => {
    asked[k]!.push(`${method} ${JSON.stringify(params)}`);
    if (method === "eth_getBalance") return q(balanceOf(String(params[0]).toLowerCase()));
    return ch.rpcs[k](method, params);
  };
  const helperAsked: string[] = [];
  const helper = async (method: string, params: readonly unknown[]) => {
    helperAsked.push(`${method} ${JSON.stringify(params)}`);
    return txs.find((t) => t.hash === params[0]) ?? null;
  };
  const h = hostOf(ch, ns, ws, "base", { rpcs: [rpc(0), rpc(1)], helper });
  return { ch, ns, ws, h, asked, helperAsked, ws_: releases.map((r) => wOf(r.label)), txs };
}

test("a restored device owed three releases: each pass names one W at most to the pool's RPCs and no release block to any; the releases' transactions go to the helper's route alone; three passes take the three", async () => {
  const x = await several([
    { label: 701n, block: 90n, input: WITHDRAW_INPUT, balance: 0n },
    { label: 702n, block: 92n, input: BUY_INPUT, balance: OWED },
    { label: 703n, block: 94n, input: BUY_INPUT, balance: OWED },
  ]);
  // the restore writes these SPENT: the store's own path is RESERVED or SPENT, either is read
  const seen = new Map<string, string[]>();
  let passes = 0;
  for (; passes < 30 && seen.size < 3; passes++) {
    const before = [x.asked[0]!.length, x.asked[1]!.length];
    const out = await carryEvmOwed(x.h);
    assert.ok(out.length <= 1, "one W a pass");
    for (const k of [0, 1] as const) {
      const now = x.asked[k]!.slice(before[k]).join("\n").toLowerCase();
      const named = x.ws_.filter((w) => now.includes(w.slice(2)));
      assert.ok(named.length <= 1, `pass ${passes}: rpc ${k} was named ${named.length} Ws`);
      if (out[0] !== undefined) assert.ok(named.every((w) => w === out[0]!.w), "only the pass's own W");
      assert.ok(!/"0x5a",|"0x5c",|"0x5e",|"fromblock"/.test(now), "no release block asked");
    }
    for (const o of out) seen.set(o.w, [...(seen.get(o.w) ?? []), o.end]);
  }
  assert.ok(passes >= 3, "three passes at least");
  assert.deepEqual(seen.get(x.ws_[0]!)?.[0], "withdraw");
  assert.ok(seen.get(x.ws_[1]!)!.includes("sent") && seen.get(x.ws_[2]!)!.includes("sent"));
  // the helper was asked each release's transaction by its hash, and nothing else
  assert.ok(x.helperAsked.every((l) => l.startsWith("eth_getTransactionByHash ")));
  assert.deepEqual(new Set(x.helperAsked.map((l) => JSON.parse(l.slice(l.indexOf(" ") + 1))[0])), new Set(x.txs.map((t) => t.hash)));
  // and the withdraw's W was never named to a public RPC at all
  assert.ok(!x.asked.flat().join("\n").toLowerCase().includes(x.ws_[0]!.slice(2)));
});

test("a fee spike (0.3 gwei on Base, the deposit's real estimate): the bound is over 5% of the value, so nothing is signed; it waits 30 s, then 60 s, doubling to 10 min, read again only past each wait", async () => {
  const ch = chain();
  ch.c.baseFee = 300_000_000n;
  ch.c.estimate = 330_785n;
  const { ns, ws } = await stores();
  await refused(ch, ns);
  const h = hostOf(ch, ns, ws);
  const waits: number[] = [];
  for (let i = 0; i < 7; i++) {
    assert.deepEqual(await carryEvmOwed(h), [{ w: W, end: "high_fee" }]);
    const rec = ((await ws.get("meta", EVM_CARRY_WAIT_KEY)) as Record<string, { at: string; waitMs: number }>)[W]!;
    waits.push(rec.waitMs);
    assert.equal(BigInt(rec.at), BigInt(h.clock.t + rec.waitMs));
    // before the wait is over the W is not drawn
    h.clock.t += rec.waitMs - 1;
    assert.deepEqual(await carryEvmOwed(h), []);
    h.clock.t += 1;
  }
  assert.deepEqual(waits, [30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
  assert.equal(ch.c.sent.length, 0);
  assert.equal(await ws.get("meta", EVM_CARRY_DONE_KEY), undefined, "never ended");
  // the fee falls: carried, the wait dropped
  ch.c.baseFee = 1_000_000n;
  assert.deepEqual(await carryEvmOwed(h), [{ w: W, end: "sent" }]);
  assert.deepEqual(await ws.get("meta", EVM_CARRY_WAIT_KEY), {});
  const s = sentOf(ch.c.sent[0]!);
  assert.ok((s.gas * s.maxFee + 7_000n) * 20n <= s.value, "the bound at most 5% of what it carries");
});

test("the 5% bound counts the tree's depth and Base's L1 fee: a carry at depth 0 signs where depth 20 waits; a large L1 fee waits on Base, not on Robinhood (none)", async () => {
  const at = async (name: "base" | "robinhood", baseFee: bigint, depth: bigint, l1: bigint) => {
    const ch = chain(name);
    Object.assign(ch.c, { baseFee, depth, l1 });
    const { ns, ws } = await stores();
    await refused(ch, ns);
    return (await carryEvmOwed(hostOf(ch, ns, ws, name)))[0]!.end;
  };
  // the 0.002 rung carried: its 5% is 0.0001 ETH
  assert.equal(await at("base", 35_000_000n, 0n, 7_000n), "sent");
  assert.equal(await at("base", 35_000_000n, 20n, 7_000n), "high_fee");
  assert.equal(await at("base", 10_000_000n, 0n, 7_000n), "sent");
  assert.equal(await at("base", 10_000_000n, 0n, 100_000_000_000_000n), "high_fee");
  assert.equal(await at("robinhood", 10_000_000n, 0n, 100_000_000_000_000n), "sent");
});

test("a W still holding the least rung or more after its carry landed is carried again on its chain's next note, never ended; ended carried once what is left is under it, the rest its tail", async () => {
  const ch = chain();
  const { ns, ws } = await stores();
  await refused(ch, ns);
  const h = hostOf(ch, ns, ws);
  assert.deepEqual(await carryEvmOwed(h), [{ w: W, end: "sent" }]);
  const a = sentOf(ch.c.sent[0]!);
  ch.land(a.pre, a.value);
  ch.c.nonce = 1n;
  // W still holds a rung (the 0.005 buy's rest, 0.00298 ETH)
  ch.c.balance = [OWED - a.value, OWED - a.value];
  assert.deepEqual(await carryEvmOwed(h), [{ w: W, end: "pending" }], "landed, W not ended");
  assert.equal(await ws.get("meta", EVM_CARRY_DONE_KEY), undefined);
  assert.deepEqual(await ws.get("meta", EVM_CARRY_OPEN_KEY), {}, "the landed carry's record closed");
  assert.deepEqual(await carryEvmOwed(h), [{ w: W, end: "sent" }]);
  const b = sentOf(ch.c.sent[1]!);
  assert.notEqual(b.pre, a.pre, "the chain's next note");
  ch.land(b.pre, b.value);
  ch.c.nonce = 2n;
  assert.equal(b.value, 2n * CHUNK, "the next rung");
  ch.c.balance = [10n ** 12n, 10n ** 12n];
  assert.deepEqual(await carryEvmOwed(h), [{ w: W, end: "landed" }]);
  assert.deepEqual(await ws.get("meta", EVM_CARRY_DONE_KEY), { [W]: { chain: "base", end: "carried" } });
  assert.equal(((await tailOf(ws)) as { amount: string }).amount, (10n ** 12n).toString());
});

test("the ends that stop a W for good come from final reads: a withdraw above the final block waits; a tail at latest but more at the final block waits", async () => {
  const ch = chain();
  ch.c.release = releaseTxOf(POOL, WITHDRAW_INPUT);
  ch.c.fin = RELEASE_BLOCK - 1n;
  const { ns, ws } = await stores();
  await refused(ch, ns);
  const h = hostOf(ch, ns, ws);
  assert.deepEqual(await carryEvmOwed(h), [{ w: W, end: "pending" }]);
  assert.equal(await ws.get("meta", EVM_CARRY_DONE_KEY), undefined);
  ch.c.fin = RELEASE_BLOCK;
  assert.deepEqual(await carryEvmOwed(h), [{ w: W, end: "withdraw" }]);
  const e = chain();
  e.c.balance = [EVM_POOL_MIN_DEPOSIT, EVM_POOL_MIN_DEPOSIT];
  e.c.finBalance = [OWED, OWED];
  e.c.fin = 99n; // the latest block 100, the final 99
  const b = await stores();
  await refused(e, b.ns);
  const he = hostOf(e, b.ns, b.ws);
  assert.deepEqual(await carryEvmOwed(he), [{ w: W, end: "pending" }]);
  assert.equal(await b.ws.get("meta", EVM_CARRY_DONE_KEY), undefined);
  e.c.finBalance = null;
  assert.deepEqual(await carryEvmOwed(he), [{ w: W, end: "tail" }]);
});

test("every W key the pass derives (the owed list's and the signature's) is zeroed", async () => {
  const ch = chain();
  const { ns, ws } = await stores();
  await refused(ch, ns);
  const keys: Uint8Array[] = [];
  const derive: typeof freshWallet = (...a) => {
    const k = freshWallet(...a);
    keys.push(k.secretKey);
    return k;
  };
  assert.deepEqual(await carryEvmOwed(hostOf(ch, ns, ws, "base", { derive })), [{ w: W, end: "sent" }]);
  assert.ok(keys.length >= 2, "the owed list's key and the signature's");
  assert.ok(keys.every((k) => k.every((b) => b === 0)), "every key zeroed");
});

// card pool-amounts-are-standard-sizes-evm: the carry is a deposit into the pool, public in value, so it is a rung of
// the pool's ladder (the largest at or under W's lower balance less the bound), and what is under the next rung stays on
// W as the user's (the Solana rule, f344853ca): never a deposit off the ladder, never paid away
test("checkEvmCarry: the value carried is the largest rung at or under W's lower balance less the bound; the rest stays on W", () => {
  const held = 2n * CHUNK - FEE + 12_345n; // a refused 0.002 ETH buy: W holds the chunk less the fee
  const reads: EvmDepositReads = { ...READS, balance: [held, held + 5n] };
  const whole = held - GAS * MAXFEE - 7_000n; // 0.00198 ETH less the bound: no rung
  const rung = CHUNK; // the largest rung under it
  const wholeCall = callOf(whole);
  assert.equal(rule(() => checkEvmCarry(txOf({}, wholeCall), ctxOf(wholeCall), reads)), "amount", "a carry off the ladder is refused");
  const rungCall = callOf(rung);
  assert.equal(rule(() => checkEvmCarry(txOf({}, rungCall), ctxOf(rungCall), reads)), "passed", "the rung passes, the rest kept on W");
  const under = callOf(rung - 1n);
  assert.equal(rule(() => checkEvmCarry(txOf({}, under), ctxOf(under), reads)), "amount", "a smaller rung or a value under it is refused");
});

// card pool-amounts-are-standard-sizes-evm: SellDelegate deposits the largest rung at or under the sale's ETH less the
// fee, so the sale's own deposit holds the rung of the least W signed for (min out less the fee cap), not that least; a
// deposit of the rung is the sale's (filled), one under the rung, or another depositor's, is not
test("evmSellVerdict: a sale's deposit of the rung of its least is filled; under that rung, or not from W, it is taken", () => {
  const W = "0x1111111111111111111111111111111111111111";
  const P = 77n;
  const least = 12_345_000_000_000_000n; // min out less the fee cap: the rung under it is 0.01 ETH
  const dep = (value: bigint, depositor = W): EvmDeposited => ({ block: 9n, blockHash: "0xab", tx: "0xcd", index: 0n, depositor, commitment: 1n, label: 2n, value, precommitment: P });
  const read = (d: EvmDeposited): EvmDepositedRead => ({ head: 10n, final: 10n, stop: null, to: 10n, ended: false, deposits: [d] }) as unknown as EvmDepositedRead;
  const end = (d: EvmDeposited) => evmSellVerdict([read(d), read(d)], { precommitment: P, w: W, least })?.end;
  assert.equal(end(dep(10_000_000_000_000_000n)), "filled", "the rung of the least");
  assert.equal(end(dep(least)), "filled", "the first sets' delegate: all of it");
  assert.equal(end(dep(10_000_000_000_000_000n - 1n)), "taken", "under the rung");
  assert.equal(end(dep(10_000_000_000_000_000n, "0x2222222222222222222222222222222222222222")), "taken", "another depositor");
});
