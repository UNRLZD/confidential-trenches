// pool.deposit on an EVM pool (card pool-deposits, slice 3): src/pool-deposit-evm.ts on two mocked RPCs and a
// fake-indexeddb note store. INCOMING with its send before the tx leaves; nothing signed when a simulation fails; a
// taken precommitment restored; a reload settles the open note and plans no new index; a dead send (U's finalized nonce
// past it on BOTH RPCs, no Deposited) rebuilt on the same note at the new nonce; one index across asks.
//   node --test test/pool-deposit-evm.test.ts      (from packages/signpage)
// The seed is the published all-zero vector (packages/wallet/test/vectors/a8.json).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore } from "@blindfill/wallet/store";
import { depositIdEvm } from "../../wallet/src/derive/keys.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, type NoteRecord, type NoteStore } from "../../wallet/src/notes/store.ts";
import { evmPoolScopeOf, EVM_LADDER, type EvmPoolEvent, type EvmPoolPin } from "../../wallet/src/pool/evm.ts";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { EVM_POOL_MIN_DEPOSIT } from "../../kit/src/trade/evm/pool-fee.ts";
import { ladderSplit } from "../../wallet/src/pool/ladder.ts";
import { EVM_DEPOSIT_GAS_MAX, evmDepositHeadroom } from "../src/rules/pool.ts";
import { EVM_READ_TRY_MS } from "../../wallet/src/pool/evm.ts";
import { EVM_DEPOSIT_PRIORITY_CAP, EVM_DEPOSIT_RESEND_MS } from "../src/pool-deposit-evm.ts";
import { mock } from "node:test";
import { poolDepositEvmKind, runPoolDepositEvm, type PoolDepositEvmHost } from "../src/pool-deposit-evm.ts";
import { EvmNotFinalError } from "../../wallet/src/pool/evm-restore.ts";
import { SolanaRpcTransportError } from "../../kit/src/trade/solana/send.ts";
import type { PoolAsk } from "../src/rules/pool.ts";

const ENTROPY = () => new Uint8Array(16);
const SEED = wordsToSeed64(entropyToWords(ENTROPY()));
const POOL = "0x00000000000000000000000000000000000f0011";
const PIN: EvmPoolPin = Object.freeze({ network: "base-sepolia", pool: POOL, feeRecipient: "0x0000000000000000000000000000000000000fee", fromBlock: 1n });
const SCOPE = evmPoolScopeOf(POOL, 84532n);
const RUNG = EVM_LADDER.min; // 0.001 ETH
const ASK: PoolAsk = { kind: "pool.deposit", chain: "base", token: null, amount: RUNG, slippageBps: 0, decimals: 18 };
const FEE = 1_000_000n * 3_000_000n + 10n ** 13n; // well above the cap's fee bound at the mocked base fee
const q = (v: bigint) => "0x" + v.toString(16);
const sel = (sig: string) => "0x" + Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString("hex").slice(0, 8);
const SEL_STATE_DEPTH = sel("currentTreeDepth()");
const SEL_LABEL_DEPTH = sel("currentLabelTreeDepth()");
const word = (v: bigint) => v.toString(16).padStart(64, "0");

const closers: (() => void)[] = [];
after(() => closers.forEach((f) => f()));
async function notes(idb = new IDBFactory()): Promise<{ ns: NoteStore; idb: IDBFactory }> {
  const w = await openWalletStore({ indexedDB: idb });
  closers.push(() => w.close());
  const ns = await openNoteStore(w);
  closers.push(() => ns.close());
  return { ns, idb };
}

// RLP decode of a type 2 raw tx: its fields as byte strings (the access list as an empty one)
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
  const data = Buffer.from(f[7]!).toString("hex");
  return { nonce: big(f[1]!), gas: big(f[4]!), value: big(f[6]!), pre: BigInt("0x" + data.slice(72, 136)), hash: "0x" + Buffer.from(keccak_256(Buffer.from(raw.slice(2), "hex"))).toString("hex") };
};

/** Two RPCs over one chain: per-RPC balance, finalized nonce and simulation; the pool's events and its finalized block. */
function chain() {
  const c = {
    block: 100n,
    baseFee: 1_000_000n,
    nonce: 0n,
    finNonce: [0n, 0n] as bigint[],
    balance: [0n, 0n] as bigint[],
    simFail: [false, false],
    events: [] as EvmPoolEvent[],
    fin: 100n,
    sent: [] as string[],
    onSend: (_raw: string) => {},
    // one RPC's word off the other's: added to RPC 1's answer
    off: { nonce: 0n, estimate: 0n, l1: 0n, baseFee: 0n },
    /** a method that fails on RPC 1 past the page's retry (the kit client's transport error) */
    down: null as string | null,
    /** tx hashes each RPC knows; U's pending nonce on each, when it is past "latest" */
    known: [new Set<string>(), new Set<string>()],
    /** each RPC's latest head when it is past `block` (the agreed block is the lower of the two) */
    head: [null, null] as (bigint | null)[],
    pending: [null, null] as (bigint | null)[],
    /** the pool's state and label tree depths (currentTreeDepth, currentLabelTreeDepth) */
    depth: [0n, 0n] as bigint[],
    /** a balance of one address's own, by lowercase address (else `balance`) */
    at: new Map<string, bigint[]>(),
  };
  const deposit = (pre: bigint, value: bigint) => {
    const label = vaultLabelOf(keccak_256, SCOPE, BigInt(c.events.length + 1));
    c.events.push({ block: c.fin, blockHash: `0x${"ab".repeat(32)}`, logIndex: BigInt(c.events.length), bytes: "", kind: "deposit", state: noteCommitment(value, label, pre), label, value, precommitment: pre, nullifier: null, recipient: null, token: null } as EvmPoolEvent);
  };
  /** U's tx lands: its Deposited at a final block, U's nonce on, its value and fee spent. */
  const land = (raw: string) => {
    const s = sentOf(raw);
    deposit(s.pre, s.value);
    c.nonce = s.nonce + 1n;
    c.finNonce = [c.nonce, c.nonce];
    c.balance = c.balance.map((b) => b - s.value - 10n ** 12n);
  };
  const rpc =
    (k: number) =>
    async (method: string, params: readonly unknown[]): Promise<unknown> => {
      const p = params as unknown[];
      const off = (v: bigint, d: bigint) => (k === 1 ? v + d : v);
      if (k === 1 && c.down === method) throw new SolanaRpcTransportError("http_5xx", "HTTP 503", 4, "rpc1.example");
      switch (method) {
        case "eth_getBlockByNumber":
          return { number: q(p[0] === "latest" ? (c.head[k] ?? c.block) : BigInt(p[0] as string)), hash: `0x${"11".repeat(32)}`, timestamp: "0x1", baseFeePerGas: q(off(c.baseFee, c.off.baseFee)) };
        case "eth_getTransactionCount":
          return q(p[1] === "finalized" ? c.finNonce[k]! : p[1] === "pending" ? (c.pending[k] ?? c.nonce) : off(c.nonce, c.off.nonce));
        case "eth_getTransactionByHash":
          return c.known[k]!.has(p[0] as string) ? { hash: p[0] } : null;
        case "eth_getBalance":
          return q((c.at.get(String(p[0]).toLowerCase()) ?? c.balance)[k]!);
        case "eth_estimateGas":
          return q(off(250_000n, c.off.estimate));
        case "eth_call": {
          const call = p[0] as { from?: string; data: string };
          if (call.from !== undefined) {
            if (c.simFail[k]) throw new Error("RPC error 3: execution reverted");
            return "0x";
          }
          if (call.data === SEL_STATE_DEPTH) return "0x" + word(c.depth[0]!);
          if (call.data === SEL_LABEL_DEPTH) return "0x" + word(c.depth[1]!);
          return "0x" + word(call.data.startsWith("0xf1c7a58b") ? off(7_000n, c.off.l1) : 0n); // L1 fee bound, operator fee 0
        }
        case "eth_sendRawTransaction": {
          const raw = p[0] as string;
          if (k === 0) (c.sent.push(raw), c.onSend(raw));
          return sentOf(raw).hash;
        }
      }
      throw new Error(`unmocked ${method}`);
    };
  return { c, deposit, land, rpcs: [rpc(0), rpc(1)] as const };
}

function hostOf(ch: ReturnType<typeof chain>, ns: NoteStore, o: Partial<PoolDepositEvmHost> = {}): PoolDepositEvmHost & { seeds: Uint8Array[] } {
  const seeds: Uint8Array[] = [];
  return {
    seeds,
    pin: PIN,
    testnet: true,
    rpcs: ch.rpcs,
    round: async () => ({ events: [...ch.c.events], finalBlock: ch.c.fin }),
    notes: async () => ns,
    records: async () => ns.list(),
    seed64: async () => (seeds.push(SEED.slice()), seeds.at(-1)!),
    reads: 2,
    wait: async () => {},
    ...o,
  };
}
const ours = async (ns: NoteStore): Promise<NoteRecord[]> => (await ns.list()).filter((n) => n.scope === SCOPE);
const uOf = (n: NoteRecord) => depositIdEvm(SEED, SCOPE, (n.ref as { i: number }).i).address;

/** A store with its planned index's U funded with `wei` on both RPCs. */
async function funded(wei: bigint) {
  const ch = chain();
  const { ns, idb } = await notes();
  const planned = await ns.planDeposit(SCOPE, (ref) => noteSecrets(SEED, ref).precommitment);
  ch.c.balance = [wei, wei];
  return { ch, ns, idb, planned, u: uOf(planned) };
}

test("a funded U deposits its rung: INCOMING with { hash, nonce, value } before the tx leaves, UNSPENT once its Deposited is final; seed zeroed", async () => {
  const { ch, ns, planned } = await funded(RUNG + FEE);
  const atSend: (NoteRecord | undefined)[] = [];
  ch.c.onSend = (raw) => {
    void ns.get(planned.id).then((n) => atSend.push(n));
    ch.land(raw);
  };
  const h = hostOf(ch, ns, { now: () => 5_000 });
  const a = await runPoolDepositEvm(h, ASK);
  assert.equal(ch.c.sent.length, 1);
  const s = sentOf(ch.c.sent[0]!);
  assert.deepEqual(a, { stage: "filled", txs: [{ chain: "base", hash: s.hash }] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(atSend[0]!.state, "INCOMING", "INCOMING before the tx left");
  assert.deepEqual(atSend[0]!.evmSends, [{ hash: s.hash, nonce: 0n, value: RUNG, sentMs: 5_000n }], "sentMs: the device's clock as it left");
  assert.equal(s.pre, planned.precommitment, "the planned note's precommitment");
  const n = await ns.get(planned.id);
  assert.equal(n!.state, "UNSPENT");
  assert.equal(n!.leaf!.value, RUNG);
  assert.ok(h.seeds.every((x) => x.every((b) => b === 0)), "the seed zeroed at run end");
});

test("a simulation that fails on one RPC signs nothing; read and simulated once more, then not_funded with nothing written", async () => {
  const { ch, ns, planned } = await funded(RUNG + FEE);
  ch.c.simFail = [false, true];
  const a = await runPoolDepositEvm(hostOf(ch, ns), ASK);
  assert.deepEqual(a, { error: "not_funded" });
  assert.equal(ch.c.sent.length, 0, "nothing sent");
  assert.equal((await ns.get(planned.id))!.state, "PLANNED", "nothing written");
});

test("a precommitment a Deposited already names is restored as the user's note at its value, and the rung goes on U's next note", async () => {
  const { ch, ns, planned } = await funded(RUNG + FEE);
  ch.deposit(planned.precommitment, EVM_POOL_MIN_DEPOSIT); // a front-runner's MIN_DEPOSIT on U's deposit note
  ch.c.onSend = (raw) => ch.land(raw);
  const a = await runPoolDepositEvm(hostOf(ch, ns), ASK);
  assert.equal("stage" in a && a.stage, "filled");
  const taken = await ns.get(planned.id);
  assert.deepEqual([taken!.state, taken!.leaf!.value], ["UNSPENT", EVM_POOL_MIN_DEPOSIT], "restored at the take's value");
  const n0: NoteRef = { kind: "second", id: { id: "U", s: SCOPE, i: (planned.ref as { i: number }).i }, n: 0 };
  assert.equal(sentOf(ch.c.sent[0]!).pre, noteSecrets(SEED, n0).precommitment, "the rung went on U's second arrival 0");
});

test("a reload mid-way: a run cut after the INCOMING write, then a fresh ask: the open note read once, never waited on, its U no source; the ask waits (not_landed) since that U holds the rung once its note lands", async () => {
  const { ch, ns, planned } = await funded(RUNG + FEE);
  const a = await runPoolDepositEvm(hostOf(ch, ns), ASK); // never lands within its reads
  assert.equal("stage" in a && a.stage, "sent", "pending: sent, never failed");
  assert.equal((await ns.get(planned.id))!.state, "INCOMING");
  // more money on U: still no second send from U while its note is open; any other U holds nothing
  ch.c.at.set(uOf(planned).toLowerCase(), [10n * RUNG, 10n * RUNG]);
  ch.c.balance = [0n, 0n];
  let waits = 0;
  const b = await runPoolDepositEvm(hostOf(ch, ns, { reads: 50, wait: async () => void waits++ }), ASK);
  assert.deepEqual(b, { stage: "not_landed", txs: [] }, "never the old note's tx as the ask's");
  assert.equal(waits, 0, "the old note is never waited on");
  assert.equal(ch.c.sent.length, 1, "no second send");
  assert.equal((await ns.get(planned.id))!.state, "INCOMING");
});

test("a dead send (U's finalized nonce past it on BOTH RPCs, no Deposited) is rebuilt on the same note at the new nonce; on one RPC only it stays pending", async () => {
  const { ch, ns, planned } = await funded(RUNG + FEE);
  await runPoolDepositEvm(hostOf(ch, ns), ASK);
  const first = sentOf(ch.c.sent[0]!);
  // U's nonce 0 used by another tx (dropped deposit): finalized nonce 1 on one RPC only
  ch.c.nonce = 1n;
  ch.c.finNonce = [1n, 0n];
  const p = await runPoolDepositEvm(hostOf(ch, ns), null); // the load's pass
  assert.deepEqual(p, { stage: "not_landed", txs: [] });
  assert.equal(ch.c.sent.length, 1, "pending on one RPC's word: not rebuilt");
  // on both: rebuilt from fresh reads at nonce 1, same note and precommitment, new bytes
  ch.c.finNonce = [1n, 1n];
  ch.c.onSend = (raw) => ch.land(raw);
  assert.deepEqual(await runPoolDepositEvm(hostOf(ch, ns), null), { stage: "not_landed", txs: [] }, "sent again by the pass: read at the next one");
  const r = await runPoolDepositEvm(hostOf(ch, ns), null);
  assert.equal(ch.c.sent.length, 2);
  const second = sentOf(ch.c.sent[1]!);
  assert.deepEqual([second.nonce, second.pre, second.value], [1n, first.pre, first.value]);
  assert.notEqual(second.hash, first.hash, "never the old bytes");
  const n = await ns.get(planned.id);
  assert.deepEqual(n!.evmSends!.map((x) => x.nonce), [0n, 1n]);
  assert.equal(n!.state, "UNSPENT");
  assert.deepEqual(r, { stage: "filled", txs: [] }, "settled by the pass, no ask's tx");
});

test("a Deposited at another value in the verdict is a take: the note restored at that value, the rung sent again on the next note", async () => {
  const { ch, ns, planned } = await funded(2n * RUNG + FEE);
  let k = 0;
  ch.c.onSend = (raw) => {
    if (k++ === 0) {
      // a front-runner's deposit lands first on the precommitment; U's tx reverts, its nonce used
      ch.deposit(sentOf(raw).pre, EVM_POOL_MIN_DEPOSIT);
      ch.c.nonce = 1n;
      ch.c.finNonce = [1n, 1n];
    } else ch.land(raw);
  };
  const a = await runPoolDepositEvm(hostOf(ch, ns), ASK);
  assert.equal("stage" in a && a.stage, "filled");
  const n = await ns.get(planned.id);
  assert.deepEqual([n!.state, n!.leaf!.value], ["UNSPENT", EVM_POOL_MIN_DEPOSIT]);
  assert.equal(ch.c.sent.length, 2);
  assert.notEqual(sentOf(ch.c.sent[1]!).pre, planned.precommitment, "the next note");
});

test("one index across asks until money reaches it: planDeposit hands the same PLANNED index back", async () => {
  const ch = chain();
  const { ns } = await notes();
  const shorts: [string, bigint][] = [];
  const a = await runPoolDepositEvm(hostOf(ch, ns, { short: (u, w) => void shorts.push([u, w]) }), ASK);
  const b = await runPoolDepositEvm(hostOf(ch, ns, { short: (u, w) => void shorts.push([u, w]) }), ASK);
  assert.deepEqual([a, b], [{ error: "not_funded" }, { error: "not_funded" }]);
  const deps = (await ours(ns)).filter((n) => n.ref.kind === "deposit");
  assert.equal(deps.length, 1, "one index");
  assert.equal(deps[0]!.state, "PLANNED");
  assert.equal(shorts[0]![0], shorts[1]![0], "the same U named for the top-up");
  assert.equal(shorts[0]![0], uOf(deps[0]!));
  assert.equal(ch.c.sent.length, 0);
});

test("a take of U's deposit note in a block not final yet: nothing signed, the run's wait rejects with EvmNotFinalError (pool-kinds answers busy)", async () => {
  const { ch, ns, planned } = await funded(RUNG + FEE);
  ch.deposit(planned.precommitment, EVM_POOL_MIN_DEPOSIT);
  ch.c.events[0]!.block = ch.c.fin + 1n; // above the round's finalized block
  await assert.rejects(runPoolDepositEvm(hostOf(ch, ns), ASK), (e: unknown) => e instanceof EvmNotFinalError);
  const kind = poolDepositEvmKind(() => hostOf(ch, ns));
  const run = kind(ASK, null) as { after: Promise<void>; answer(): unknown };
  await assert.rejects(run.after, (e: unknown) => e instanceof EvmNotFinalError);
  assert.equal(ch.c.sent.length, 0, "nothing sent");
  assert.equal((await ns.get(planned.id))!.state, "PLANNED");
});

test("a rule refusal answers not_allowed, by its class (a PoolRuleRefused), whatever its name", async () => {
  const { ch, ns } = await funded(RUNG + FEE);
  // a Robinhood ask on Base Sepolia's pin: the rule refuses the pin (evm_not_pinned)
  const a = await runPoolDepositEvm(hostOf(ch, ns), { ...ASK, chain: "robinhood" });
  assert.deepEqual(a, { error: "not_allowed" });
  assert.equal(ch.c.sent.length, 0);
  // an error that only names itself PoolRuleRefused is not a rule refusal
  const fake = Object.assign(new Error("x"), { name: "PoolRuleRefused" });
  const b = await runPoolDepositEvm(hostOf(ch, ns, { round: async () => Promise.reject(fake) }), ASK);
  assert.notDeepEqual(b, { error: "not_allowed" });
});

test("the rule holds the pin to the page's network, never to the pin's own: a testnet pin on a mainnet page, or a mainnet pin on a testnet page, signs nothing (not_allowed)", async () => {
  {
    const { ch, ns } = await funded(RUNG + FEE);
    assert.deepEqual(await runPoolDepositEvm(hostOf(ch, ns, { testnet: false }), ASK), { error: "not_allowed" }, "Base Sepolia's pin under SIGN_HOST");
    assert.equal(ch.c.sent.length, 0);
  }
  {
    const { ch, ns } = await funded(RUNG + FEE);
    assert.deepEqual(await runPoolDepositEvm(hostOf(ch, ns, { testnet: true, pin: { ...PIN, network: "base" } }), ASK), { error: "not_allowed" }, "Base mainnet's pin under the testnet page");
    assert.equal(ch.c.sent.length, 0);
  }
});

test("before a send, two RPCs that read apart (U's nonce, the estimate, the chain fee, the base fee) answer failed; a provider down past the page's retry answers down", async () => {
  for (const [k, d] of [["nonce", 1n], ["estimate", 1n], ["l1", 1n], ["baseFee", 1n]] as const) {
    const { ch, ns, planned } = await funded(RUNG + FEE);
    ch.c.off[k] = d;
    assert.deepEqual(await runPoolDepositEvm(hostOf(ch, ns), ASK), { error: "failed" }, k);
    assert.equal(ch.c.sent.length, 0, k);
    assert.equal((await ns.get(planned.id))!.state, "PLANNED", k);
  }
  for (const m of ["eth_getBalance", "eth_estimateGas", "eth_getTransactionCount"]) {
    const { ch, ns } = await funded(RUNG + FEE);
    ch.c.down = m;
    assert.deepEqual(await runPoolDepositEvm(hostOf(ch, ns), ASK), { error: "down" }, m);
    assert.equal(ch.c.sent.length, 0, m);
  }
});

test("not_funded names the ask's first rung and the fee bound less U's lower balance as U's shortfall", async () => {
  const want = 35n * 10n ** 14n; // 0.0035 ETH
  const first = ladderSplit(EVM_LADDER, want).notes[0]!;
  const { ch, ns, u } = await funded(0n);
  ch.c.balance = [6n * 10n ** 14n, 5n * 10n ** 14n]; // the lower is RPC 1's
  const shorts: [string, bigint][] = [];
  const a = await runPoolDepositEvm(hostOf(ch, ns, { short: (x, w) => void shorts.push([x, w]) }), { ...ASK, amount: want });
  assert.deepEqual(a, { error: "not_funded" });
  const bound = (EVM_DEPOSIT_GAS_MAX + evmDepositHeadroom(0n, 0n)) * (2n * ch.c.baseFee + EVM_DEPOSIT_PRIORITY_CAP) + 7_000n; // the cap's gas and the tree's headroom at the max fee, and the L1 fee bound
  assert.deepEqual(shorts, [[u, first + bound - 5n * 10n ** 14n]]);
  assert.ok(first > EVM_POOL_MIN_DEPOSIT, "the ask's rung, not the pool's least deposit");
});

/** A run whose send reached neither RPC (neither knows its hash, U's nonce not moved), sent at the device's 1,000 ms. */
const T0 = 1_000;
async function unsent() {
  const f = await funded(RUNG + FEE);
  const a = await runPoolDepositEvm(hostOf(f.ch, f.ns, { now: () => T0 }), ASK);
  assert.equal("stage" in a && a.stage, "sent");
  assert.equal((await f.ns.get(f.planned.id))!.evmSends![0]!.sentMs, BigInt(T0), "sentMs: the device's clock as it left");
  return { ...f, N: Number(EVM_DEPOSIT_RESEND_MS[PIN.network]), first: sentOf(f.ch.c.sent[0]!) };
}

test("the resend wait in ms: the client's deadline for one call with its retry and one measured block interval", () => {
  assert.equal(EVM_READ_TRY_MS, 3_500n);
  assert.deepEqual({ ...EVM_DEPOSIT_RESEND_MS }, { base: 3_700n, "base-sepolia": 3_700n, robinhood: 3_610n, "robinhood-testnet": 3_704n });
});

test("a send that reached neither RPC is built again at the SAME nonce (same note, value, fresh fees) once the wait has passed since it left; the two sends land as one deposit and one UNSPENT note", async () => {
  const { ch, ns, planned, N, first } = await unsent();
  ch.c.onSend = (raw) => ch.land(raw);
  ch.c.baseFee += 1n; // fresh fee reads: the base fee moved
  assert.deepEqual(await runPoolDepositEvm(hostOf(ch, ns, { now: () => T0 + N }), null), { stage: "not_landed", txs: [] });
  assert.equal(ch.c.sent.length, 2, "built again");
  const second = sentOf(ch.c.sent[1]!);
  assert.deepEqual([second.nonce, second.pre, second.value], [first.nonce, first.pre, first.value], "the same nonce, note and value");
  assert.notEqual(second.hash, first.hash);
  assert.deepEqual(await runPoolDepositEvm(hostOf(ch, ns, { now: () => T0 + N }), null), { stage: "filled", txs: [] });
  const n = (await ns.get(planned.id))!;
  assert.deepEqual(n.evmSends!.map((x) => [x.hash, x.nonce, x.sentMs]), [[first.hash, 0n, BigInt(T0)], [second.hash, 0n, BigInt(T0 + N)]], "every hash kept");
  assert.equal(n.state, "UNSPENT");
  assert.equal(ch.c.events.filter((e) => e.precommitment === planned.precommitment).length, 1, "one deposit");
  assert.equal((await ours(ns)).filter((x) => x.state === "UNSPENT").length, 1, "one note");
});

test("the same-nonce rebuild is refused when either RPC knows a hash, when either RPC's pending nonce is past the send's, and until the wait has passed since the send left", async () => {
  type C = ReturnType<typeof chain>["c"];
  const cases: [string, (c: C, h: string) => void, number][] = [
    ["RPC 1 knows the hash", (c, h) => void c.known[1]!.add(h), 0],
    ["RPC 0 knows the hash", (c, h) => void c.known[0]!.add(h), 0],
    ["RPC 0's pending nonce past it", (c) => void (c.pending[0] = 1n), 0],
    ["RPC 1's pending nonce past it", (c) => void (c.pending[1] = 1n), 0],
    ["1 ms short of the wait", () => {}, -1],
  ];
  for (const [what, set, early] of cases) {
    const { ch, ns, planned, N, first } = await unsent();
    set(ch.c, first.hash);
    const r = await runPoolDepositEvm(hostOf(ch, ns, { now: () => T0 + N + early }), null);
    assert.deepEqual(r, { stage: "not_landed", txs: [] }, what);
    assert.equal(ch.c.sent.length, 1, `${what}: not built again`);
    assert.equal((await ns.get(planned.id))!.state, "INCOMING", what);
  }
});

test("a send again of the very bytes restarts the wait: within one run it is not sent a third time before the wait passes again", async () => {
  const { ch, ns, planned } = await funded(RUNG + FEE);
  const N = Number(EVM_DEPOSIT_RESEND_MS[PIN.network]);
  let clock = T0;
  let jumped = false;
  // the ask's own reads: the first at the send, then the wait passes once (the very bytes sent again: fees unchanged),
  // then no more time passes
  const a = await runPoolDepositEvm(hostOf(ch, ns, { now: () => clock, reads: 4, wait: async () => void (jumped || ((clock += N), (jumped = true))) }), ASK);
  assert.equal("stage" in a && a.stage, "sent");
  assert.equal(ch.c.sent.length, 2, "sent again once, the same bytes");
  assert.equal(ch.c.sent[0], ch.c.sent[1]);
  assert.equal((await ns.get(planned.id))!.evmSends!.length, 1, "the very send: no second record");
});

// The slice 3 review's scenarios (R1, R2), on the mock above.
const capBound = (c: { baseFee: bigint; depth: bigint[] }) => (EVM_DEPOSIT_GAS_MAX + evmDepositHeadroom(c.depth[0]!, c.depth[1]!)) * (2n * c.baseFee + EVM_DEPOSIT_PRIORITY_CAP) + 7_000n;

test("R1: an earlier ask's note that lands later is settled by the next run, never credited to it: the later ask sends its own deposit and answers with its own tx", async () => {
  const { ch, ns, planned } = await funded(0n);
  ch.c.balance = [RUNG + capBound(ch.c), RUNG + capBound(ch.c)];
  // ask X: sent, its Deposited in a block not final within the run (finality ~18 to 24 min on all four networks)
  ch.c.onSend = (raw) => {
    const s = sentOf(raw);
    ch.deposit(s.pre, s.value);
    ch.c.events.at(-1)!.block = ch.c.fin + 10n;
    ch.c.nonce = s.nonce + 1n;
    ch.c.balance = ch.c.balance.map((b) => b - s.value - 250_000n * (ch.c.baseFee + EVM_DEPOSIT_PRIORITY_CAP));
  };
  const a = await runPoolDepositEvm(hostOf(ch, ns), ASK);
  assert.equal("stage" in a && a.stage, "sent");
  const x = sentOf(ch.c.sent[0]!).hash;
  assert.equal((await ns.get(planned.id))!.state, "INCOMING");
  // later: X's block is final; the user funds U for a second deposit Y of one rung and asks it
  ch.c.fin += 20n;
  ch.c.finNonce = [1n, 1n];
  ch.c.balance = ch.c.balance.map((b) => b + RUNG + capBound(ch.c));
  ch.c.onSend = (raw) => ch.land(raw);
  const sent: string[] = [];
  const b = await runPoolDepositEvm(hostOf(ch, ns, { sent: (h) => void sent.push(h) }), ASK);
  assert.equal(ch.c.sent.length, 2, "Y sent its own deposit");
  const y = sentOf(ch.c.sent[1]!).hash;
  assert.notEqual(y, x);
  assert.deepEqual(b, { stage: "filled", txs: [{ chain: "base", hash: y }] }, "Y answered with Y's tx, never X's");
  assert.deepEqual(sent, [y], "the app hears only Y's send");
  assert.equal((await ns.get(planned.id))!.state, "UNSPENT", "X settled as its own note");
  assert.equal((await ours(ns)).filter((n) => n.state === "UNSPENT").length, 2, "two notes: X's and Y's");
});

test("R2: a deposit that reverts and cannot be paid again names its top-up (`short`, the amount) on every pass, and never blocks the pool: the next ask goes on a new index", async () => {
  const ch = chain();
  const { ns } = await notes();
  const planned = await ns.planDeposit(SCOPE, (ref) => noteSecrets(SEED, ref).precommitment);
  const u = uOf(planned);
  const shorts: [string, bigint][] = [];
  const h = (o: Partial<PoolDepositEvmHost> = {}) => hostOf(ch, ns, { short: (x, w) => void shorts.push([x, w]), ...o });
  assert.deepEqual(await runPoolDepositEvm(h(), ASK), { error: "not_funded" });
  const [named, top] = shorts[0]!;
  assert.equal(named, u);
  ch.c.at.set(u.toLowerCase(), [top, top]); // the user tops up exactly what was asked; any other U holds nothing
  // the deposit is mined and reverts: U's nonce used, its gas burnt
  ch.c.onSend = (raw) => {
    const s = sentOf(raw);
    ch.c.nonce = s.nonce + 1n;
    ch.c.finNonce = [ch.c.nonce, ch.c.nonce];
    const left = ch.c.at.get(u.toLowerCase())!.map((b) => b - s.gas * (ch.c.baseFee + EVM_DEPOSIT_PRIORITY_CAP));
    ch.c.at.set(u.toLowerCase(), left);
  };
  const a = await runPoolDepositEvm(h(), ASK);
  assert.equal("stage" in a && a.stage, "sent", "the ask's send: sent, never failed");
  assert.equal(ch.c.sent.length, 1, "the send again not signed: U cannot pay it");
  assert.equal((await ns.get(planned.id))!.state, "INCOMING");
  const low = ch.c.at.get(u.toLowerCase())![0]!;
  const want: [string, bigint] = [u, RUNG + capBound(ch.c) - low];
  assert.deepEqual(shorts.at(-1), want, "the top-up the send again needs, named");
  // the load's pass: the same top-up named again, and the answer is not_funded
  assert.deepEqual(await runPoolDepositEvm(h(), null), { error: "not_funded" });
  assert.deepEqual(shorts.at(-1), want);
  // the next ask: the stuck note's U is no source, the ask plans a new index and names that U's top-up
  assert.deepEqual(await runPoolDepositEvm(h(), ASK), { error: "not_funded" });
  const other = shorts.at(-1)!;
  assert.notEqual(other[0], u, "a new index's U, never blocked behind the stuck note");
  assert.equal(ch.c.sent.length, 1);
});

test("the gas limit is the two-RPC estimate plus the tree's headroom from the pool's two depths, and U's balance covers that padded limit", async () => {
  const { ch, ns } = await funded(0n);
  ch.c.depth = [7n, 5n];
  const need = RUNG + capBound(ch.c);
  ch.c.balance = [need - 1n, need - 1n];
  const shorts: bigint[] = [];
  assert.deepEqual(await runPoolDepositEvm(hostOf(ch, ns, { short: (_u, w) => void shorts.push(w) }), ASK), { error: "not_funded" });
  assert.deepEqual(shorts, [1n], "short by the padded limit's fee, to the wei");
  ch.c.balance = [need, need];
  ch.c.onSend = (raw) => ch.land(raw);
  const a = await runPoolDepositEvm(hostOf(ch, ns), ASK);
  assert.equal("stage" in a && a.stage, "filled");
  assert.equal(sentOf(ch.c.sent[0]!).gas, 250_000n + evmDepositHeadroom(7n, 5n), "estimate + (7 + 1 + 5 + 1) levels");
  // two RPCs that read the depth apart: no read, nothing signed
  const f = await funded(10n ** 18n);
  f.ch.c.depth = [7n, 5n];
  const orig = f.ch.rpcs[1];
  const rpcs = [f.ch.rpcs[0], async (m: string, p: readonly unknown[]) => ((p[0] as { data?: string })?.data === SEL_STATE_DEPTH ? "0x" + word(8n) : orig(m, p))] as const;
  assert.deepEqual(await runPoolDepositEvm(hostOf(f.ch, f.ns, { rpcs }), ASK), { error: "failed" });
  assert.equal(f.ch.c.sent.length, 0);
});

test("an ask below the ladder's smallest rung is refused with nothing planned, and a top-up is always named at a rung the ladder deposits (found by the Base Sepolia run: an ask of MIN_DEPOSIT was told to top up 0.0001 ETH, then kept it)", async () => {
  const ch = chain();
  const { ns } = await notes();
  const shorts: [string, bigint][] = [];
  const a = await runPoolDepositEvm(hostOf(ch, ns, { short: (u, w) => void shorts.push([u, w]) }), { ...ASK, amount: EVM_LADDER.one });
  assert.deepEqual(a, { error: "not_allowed" });
  assert.equal((await ours(ns)).length, 0, "nothing planned");
  assert.equal(shorts.length, 0);
  // an ask of the smallest rung: named at that rung, and U funded with exactly that deposits it
  const b = await runPoolDepositEvm(hostOf(ch, ns, { short: (u, w) => void shorts.push([u, w]) }), { ...ASK, amount: EVM_LADDER.min });
  assert.deepEqual(b, { error: "not_funded" });
  assert.deepEqual(shorts.map((x) => x[1]), [EVM_LADDER.min + capBound(ch.c)] as bigint[]);
  ch.c.balance = [shorts[0]![1], shorts[0]![1]];
  ch.c.onSend = (raw) => ch.land(raw);
  const c = await runPoolDepositEvm(hostOf(ch, ns), { ...ASK, amount: EVM_LADDER.min });
  assert.equal("stage" in c && c.stage, "filled");
});

// Card pool-deposit-sent-end: the EVM kind answers at the ask's first send and its run reads the verdict once (a
// Deposited is final only ~1,000 s on), so its end reaches the app only by the kind's reads after the run: filled once a
// Deposited naming the note at its value is final; not_landed only once U's finalized nonce is past every send of it on
// BOTH RPCs with no Deposited naming it, or a final Deposited at another value took it.
function followedEvm(ch: ReturnType<typeof chain>, ns: NoteStore, o: Partial<PoolDepositEvmHost> = {}, ask: PoolAsk = ASK) {
  const stages: string[] = [];
  let ended = false;
  let ran!: () => void;
  const runEnd = new Promise<void>((r) => (ran = r));
  const parked: (() => void)[] = [];
  let onPark: (() => void) | null = null;
  let onStage: (() => void) | null = null;
  const wait = async (): Promise<void> => {
    if (!ended) return;
    await new Promise<void>((r) => {
      parked.push(r);
      onPark?.();
    });
  };
  const kind = poolDepositEvmKind(() => ({ ...hostOf(ch, ns, { wait, ...o }), end: () => ((ended = true), ran()) }));
  const r = kind(ask, { id: "e1", sha: "00", progress: (s) => (stages.push(String(s)), onStage?.()) });
  const within = (p: Promise<void>, ms = 2_000): Promise<boolean> => Promise.race([p.then(() => true), new Promise<boolean>((ok) => setTimeout(() => ok(false), ms))]);
  return {
    r: r as { after: Promise<void>; answer(): unknown },
    stages,
    runEnd,
    parked: () => within(new Promise<void>((ok) => (parked.length ? ok() : (onPark = ok)))),
    staged: (n: number) => within(new Promise<void>((ok) => (stages.length >= n ? ok() : (onStage = () => stages.length >= n && ok())))),
    go: () => parked.splice(0).forEach((f) => f()),
  };
}

test("pool-deposit-sent-end (EVM): a send that lands after the run, its Deposited final only later, gives filled; while that block is not final, nothing", async () => {
  const { ch, ns } = await funded(RUNG + FEE);
  const f = followedEvm(ch, ns);
  await f.r.after;
  const s = sentOf(ch.c.sent[0]!);
  assert.deepEqual(f.r.answer(), { result: { stage: "sent", txs: [{ chain: "base", hash: s.hash }] } });
  await f.runEnd;
  assert.deepEqual(f.stages, []);
  assert.equal(await f.parked(), true, "the end's reads go on after the run: the app is never left at sent");
  // it lands in a block not final yet: nothing told
  ch.land(ch.c.sent[0]!); // its Deposited at block 100
  ch.c.fin = 90n; // finalized only up to 90
  ch.c.finNonce = [0n, 0n];
  f.go();
  assert.equal(await f.parked(), true);
  assert.deepEqual(f.stages, [], "a Deposited above the finalized block tells nothing");
  ch.c.fin = 100n;
  ch.c.finNonce = [1n, 1n];
  f.go();
  assert.equal(await f.staged(1), true);
  assert.deepEqual(f.stages, ["filled"]);
  assert.equal(ch.c.sent.length, 1, "never sent again");
});

test("pool-deposit-sent-end review 1 (EVM): U's finalized nonce past the send on one RPC alone tells nothing; on both with no Deposited is no end either (the pass builds the note again at U's new nonce from U's money): the end's reads start the pass and follow the rebuilt send to filled, never not_landed", async () => {
  const { ch, ns, planned } = await funded(RUNG + FEE);
  let kicks = 0;
  const f = followedEvm(ch, ns, { settle: () => void kicks++ });
  await f.r.after;
  await f.runEnd;
  assert.equal(await f.parked(), true);
  ch.c.finNonce = [1n, 0n]; // the nonce taken by a tx with no Deposited (a revert), final on RPC 0 only
  ch.c.nonce = 1n;
  f.go();
  assert.equal(await f.parked(), true);
  assert.deepEqual(f.stages, [], "one RPC's word alone tells nothing");
  assert.equal(kicks, 0);
  ch.c.finNonce = [1n, 1n];
  f.go();
  assert.equal(await f.parked(), true, "dead on both with no Deposited is no end: the reads go on");
  assert.deepEqual(f.stages, [], "never not_landed for a note the pass builds again");
  assert.equal(kicks, 1, "the end's reads start the pass");
  // the page's pass: the same note built again at U's new nonce, from U's money; it lands and is final
  const a = await runPoolDepositEvm(hostOf(ch, ns, { reads: 1 }), null);
  assert.deepEqual(a, { stage: "not_landed", txs: [] }, "built again and sent: pending");
  assert.equal(ch.c.sent.length, 2);
  assert.equal(sentOf(ch.c.sent[1]!).nonce, 1n);
  ch.land(ch.c.sent[1]!);
  f.go();
  assert.equal(await f.staged(1), true);
  assert.deepEqual(f.stages, ["filled"], "the ask's end is the rebuilt send's landing");
  assert.equal((await ns.get(planned.id))!.state, "INCOMING", "the end's reads write nothing");
});

test("pool-deposit-sent-end review 3 (EVM): an ask whose first note landed and whose next is still landing is no end at part_filled: its open note is read on to a real end (filled once it lands)", async () => {
  const { ch, ns } = await funded(3n * RUNG + 2n * FEE);
  let n = 0;
  ch.c.onSend = (raw) => void (n++ === 0 && ch.land(raw)); // the first note lands at once, the second not yet
  const f = followedEvm(ch, ns, {}, { ...ASK, amount: 3n * RUNG });
  await f.r.after;
  await f.runEnd;
  assert.equal(ch.c.sent.length, 2, "both notes sent");
  assert.deepEqual(f.stages, ["sent"], "the second note's send only: the first note's landing is no end (fold review 1), and never part_filled while the second may land");
  assert.equal(await f.parked(), true, "the open note is read on");
  ch.land(ch.c.sent[1]!);
  f.go();
  assert.equal(await f.staged(2), true);
  assert.deepEqual(f.stages, ["sent", "filled"]);
});

test("pool-deposit-sent-end fold review 1 (EVM): an ask whose two notes both land in the run tells the app filled once, after its answer, at the run's end (never at the first note)", async () => {
  const { ch, ns } = await funded(3n * RUNG + 2n * FEE);
  ch.c.onSend = (raw) => void ch.land(raw); // each note lands at once
  const f = followedEvm(ch, ns, {}, { ...ASK, amount: 3n * RUNG });
  await f.r.after;
  await f.runEnd;
  assert.equal(ch.c.sent.length, 2, "both notes sent");
  assert.deepEqual(f.r.answer(), { result: { stage: "sent", txs: [{ chain: "base", hash: sentOf(ch.c.sent[0]!).hash }] } });
  assert.deepEqual(f.stages, ["sent", "filled"], "the second send, then the ask's one end");
  assert.equal(await f.parked(), false, "an ask that ended is not followed");
});

test("pool-deposit-sent-end review 4 (EVM): the end's reads back off (10 s doubling to 60 s) while every send is dead with no Deposited, go on past an hour (fold review 5: no give-up) so the pass's send that lands then is told filled, and stop at once when the page leaves the deposit", async () => {
  const { ch, ns } = await funded(RUNG + FEE);
  const waits: number[] = [];
  const stop = new AbortController();
  let ended = false;
  let topped = false;
  const stages: string[] = [];
  // at the run's end: dead on both, no Deposited; no pass runs until past an hour of the end's reads
  let cut = false;
  const dead = () => ((ch.c.finNonce = [1n, 1n]), (ch.c.nonce = 1n), (ended = true));
  const kind = poolDepositEvmKind(() => ({ ...hostOf(ch, ns), wait: async (ms: number) => {
      if (cut) throw new Error("cut");
      if (!ended) return;
      waits.push(ms);
      if (!topped && waits.reduce((a, b) => a + b, 0) > 3_600_000) {
        topped = true;
        assert.deepEqual(stages, [], "nothing told for an hour of dead sends");
        // the page's pass, then: the note built again at U's new nonce, and it lands and is final
        await runPoolDepositEvm(hostOf(ch, ns, { reads: 1 }), null);
        ch.land(ch.c.sent.at(-1)!);
      }
    }, end: () => void dead() }));
  const r = kind(ASK, { id: "e3", sha: "00", progress: (s) => void stages.push(String(s)) }) as { after: Promise<void> };
  await r.after;
  // until the app is told (a follow that gives up never tells: cut at 10 s, and fails below)
  for (const t0 = Date.now(); stages.length === 0 && Date.now() - t0 < 10_000; ) await new Promise((ok) => setTimeout(ok, 20));
  cut = true;
  assert.equal(topped, true, `the reads went on past an hour: ${waits.reduce((a, b) => a + b, 0)} ms`);
  assert.deepEqual(waits.slice(0, 5), [10_000, 20_000, 40_000, 60_000, 60_000]);
  assert.deepEqual(stages, ["filled"], "the late landing told");
  assert.equal(ch.c.sent.length, 2);
  // a sign out stops a follow at once
  const { ch: ch2, ns: ns2 } = await funded(RUNG + FEE);
  const f = followedEvm(ch2, ns2, { signal: stop.signal });
  await f.r.after;
  await f.runEnd;
  assert.equal(await f.parked(), true);
  stop.abort();
  ch2.land(ch2.c.sent[0]!);
  f.go();
  assert.equal(await f.parked(), false, "no read after the sign out");
  assert.deepEqual(f.stages, []);
});

test("pool-deposit-sent-end fold review 6 (EVM): the end's reads read each note's record read only (records), never opening the note store", async () => {
  const { ch, ns } = await funded(RUNG + FEE);
  let opens = 0;
  let reads = 0;
  const f = followedEvm(ch, ns, { notes: async () => (opens++, ns), records: async () => (reads++, ns.list()) });
  await f.r.after;
  await f.runEnd;
  const atEnd = opens;
  assert.equal(await f.parked(), true);
  f.go();
  assert.equal(await f.parked(), true);
  assert.ok(reads >= 2, `the record read on each read: ${reads}`);
  assert.equal(opens, atEnd, "the note store is never opened by the end's reads");
});

test("pool-deposit-sent-end review 6 (EVM): the run's end zeroes the seed and U's keys before any store read: a store read that never settles keeps neither", async () => {
  const { ch, ns } = await funded(RUNG + FEE);
  const hang: NoteStore = new Proxy(ns, { get: (t, k) => (k === "get" ? () => new Promise(() => {}) : (t as unknown as Record<string | symbol, unknown>)[k as string]) }) as NoteStore;
  const h = hostOf(ch, ns, { notes: async () => hang });
  void runPoolDepositEvm(h, ASK);
  for (let k = 0; k < 100 && ch.c.sent.length === 0; k++) await new Promise((ok) => setTimeout(ok, 10));
  await new Promise((ok) => setTimeout(ok, 100));
  assert.equal(ch.c.sent.length, 1, "the send left");
  assert.ok(h.seeds.length > 0 && h.seeds.every((s) => s.every((b) => b === 0)), "the seed is zeroed while the store read hangs");
});

test("pool-deposit-sent-end fold: the verdict reads U's finalized nonce before the round, so a send that lands and finalizes between the two reads is landed, never read dead and sent again", async () => {
  const { ch, ns, planned } = await funded(RUNG + FEE);
  // the send lands and is final just as the verdict reads U's finalized nonce (planted: between the two reads)
  let landed = false;
  const at = (rpc: (m: string, p: readonly unknown[]) => Promise<unknown>) => async (m: string, p: readonly unknown[]) => {
    if (m === "eth_getTransactionCount" && p[1] === "finalized" && !landed && ch.c.sent.length > 0) (landed = true), ch.land(ch.c.sent[0]!);
    return rpc(m, p);
  };
  const a = await runPoolDepositEvm(hostOf(ch, ns, { rpcs: [at(ch.rpcs[0]), at(ch.rpcs[1])] as const }), ASK);
  assert.equal(landed, true, "the planted landing happened");
  assert.equal(ch.c.sent.length, 1, "never built again on a nonce read before its Deposited");
  assert.deepEqual(a, { stage: "filled", txs: [{ chain: "base", hash: sentOf(ch.c.sent[0]!).hash }] });
  assert.equal((await ns.get(planned.id))!.state, "UNSPENT");
});

// Card pool-deposit-sent-end review 8: the rules the reviewer's mutants showed unplanted (test/pool-deposit-mutants.mjs).
test("review 8 E1: the follower reads U's finalized nonce before the round: a send that lands and finalizes between the two reads is filled at that read, never read dead (no pass started)", async () => {
  const { ch, ns } = await funded(RUNG + FEE);
  let plant = false;
  const at = (rpc: (m: string, p: readonly unknown[]) => Promise<unknown>) => async (m: string, p: readonly unknown[]) => {
    if (plant && m === "eth_getTransactionCount" && p[1] === "finalized") (plant = false), ch.land(ch.c.sent[0]!);
    return rpc(m, p);
  };
  let kicks = 0;
  const f = followedEvm(ch, ns, { rpcs: [at(ch.rpcs[0]), at(ch.rpcs[1])] as const, settle: () => void kicks++ });
  await f.r.after;
  await f.runEnd;
  assert.equal(await f.parked(), true);
  plant = true;
  f.go();
  assert.equal(await f.staged(1), true);
  assert.deepEqual(f.stages, ["filled"]);
  assert.equal(kicks, 0, "never read dead");
});

test("review 8 E4 and E5: a Deposited at another value is no end while its block is not final, and once final a take (not_landed), never filled", async () => {
  const { ch, ns, planned } = await funded(RUNG + FEE);
  const f = followedEvm(ch, ns);
  await f.r.after;
  await f.runEnd;
  assert.equal(await f.parked(), true);
  ch.deposit(planned.precommitment, EVM_POOL_MIN_DEPOSIT); // a front-runner's, at block 100
  ch.c.fin = 90n;
  f.go();
  assert.equal(await f.parked(), true);
  assert.deepEqual(f.stages, [], "a take not final yet tells nothing");
  ch.c.fin = 100n;
  f.go();
  assert.equal(await f.staged(1), true);
  assert.deepEqual(f.stages, ["not_landed"]);
});

test("review 8 E7: an ask whose run ended before all of it was sent ends part_filled when its sent note lands, never filled", async () => {
  const { ch, ns } = await funded(3n * RUNG + 2n * FEE);
  const f = followedEvm(ch, ns, {}, { ...ASK, amount: 3n * RUNG });
  await f.r.after;
  await f.runEnd;
  assert.equal(ch.c.sent.length, 1, "the run ends on its first note, pending");
  assert.ok(sentOf(ch.c.sent[0]!).value < 3n * RUNG);
  assert.equal(await f.parked(), true);
  ch.land(ch.c.sent[0]!);
  f.go();
  assert.equal(await f.staged(1), true);
  assert.deepEqual(f.stages, ["part_filled"]);
});

test("review 8 E8: a note built again at a new nonce is dead only past its highest send's nonce: the first send's nonce taken is no dead read (no pass started)", async () => {
  const { ch, ns, planned } = await funded(RUNG + FEE);
  let kicks = 0;
  const f = followedEvm(ch, ns, { settle: () => void kicks++ });
  await f.r.after;
  await f.runEnd;
  assert.equal(await f.parked(), true);
  ch.c.finNonce = [1n, 1n]; // nonce 0 taken by a revert, final on both
  ch.c.nonce = 1n;
  assert.deepEqual(await runPoolDepositEvm(hostOf(ch, ns, { reads: 1 }), null), { stage: "not_landed", txs: [] });
  assert.deepEqual((await ns.get(planned.id))!.evmSends!.map((x) => x.nonce), [0n, 1n], "built again at nonce 1");
  f.go();
  assert.equal(await f.parked(), true);
  assert.deepEqual(f.stages, []);
  assert.equal(kicks, 0, "the live send at nonce 1 keeps the note from a dead read");
});
