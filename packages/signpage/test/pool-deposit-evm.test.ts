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
  return { nonce: big(f[1]!), value: big(f[6]!), pre: BigInt("0x" + data.slice(72, 136)), hash: "0x" + Buffer.from(keccak_256(Buffer.from(raw.slice(2), "hex"))).toString("hex") };
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
    pending: [null, null] as (bigint | null)[],
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
          return { number: q(c.block), hash: `0x${"11".repeat(32)}`, timestamp: "0x1", baseFeePerGas: q(off(c.baseFee, c.off.baseFee)) };
        case "eth_getTransactionCount":
          return q(p[1] === "finalized" ? c.finNonce[k]! : p[1] === "pending" ? (c.pending[k] ?? c.nonce) : off(c.nonce, c.off.nonce));
        case "eth_getTransactionByHash":
          return c.known[k]!.has(p[0] as string) ? { hash: p[0] } : null;
        case "eth_getBalance":
          return q(c.balance[k]!);
        case "eth_estimateGas":
          return q(off(250_000n, c.off.estimate));
        case "eth_call": {
          const call = p[0] as { from?: string; data: string };
          if (call.from !== undefined) {
            if (c.simFail[k]) throw new Error("RPC error 3: execution reverted");
            return "0x";
          }
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
    rpcs: ch.rpcs,
    round: async () => ({ events: [...ch.c.events], finalBlock: ch.c.fin }),
    notes: async () => ns,
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
  const h = hostOf(ch, ns);
  const a = await runPoolDepositEvm(h, ASK);
  assert.equal(ch.c.sent.length, 1);
  const s = sentOf(ch.c.sent[0]!);
  assert.deepEqual(a, { stage: "filled", txs: [{ chain: "base", hash: s.hash }] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(atSend[0]!.state, "INCOMING", "INCOMING before the tx left");
  assert.deepEqual(atSend[0]!.evmSends, [{ hash: s.hash, nonce: 0n, value: RUNG }]);
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

test("a reload mid-way: a run cut after the INCOMING write, then a fresh run, sends nothing new and plans no index i+1", async () => {
  const { ch, ns, planned } = await funded(RUNG + FEE);
  const a = await runPoolDepositEvm(hostOf(ch, ns), ASK); // never lands within its reads
  assert.equal("stage" in a && a.stage, "sent", "pending: sent, never failed");
  assert.equal((await ns.get(planned.id))!.state, "INCOMING");
  ch.c.balance = [10n * RUNG, 10n * RUNG]; // more money: still no second deposit while the note is open
  const b = await runPoolDepositEvm(hostOf(ch, ns), ASK);
  assert.deepEqual(b, { stage: "not_landed", txs: [] });
  assert.equal(ch.c.sent.length, 1, "no second send");
  const deps = (await ours(ns)).filter((n) => n.ref.kind === "deposit");
  assert.deepEqual(deps.map((n) => n.id), [planned.id], "no index i+1");
});

test("a dead send (U's finalized nonce past it on BOTH RPCs, no Deposited) is rebuilt on the same note at the new nonce; on one RPC only it stays pending", async () => {
  const { ch, ns, planned } = await funded(RUNG + FEE);
  await runPoolDepositEvm(hostOf(ch, ns), ASK);
  const first = sentOf(ch.c.sent[0]!);
  // U's nonce 0 used by another tx (dropped deposit): finalized nonce 1 on one RPC only
  ch.c.nonce = 1n;
  ch.c.finNonce = [1n, 0n];
  const p = await runPoolDepositEvm(hostOf(ch, ns), ASK);
  assert.deepEqual(p, { stage: "not_landed", txs: [] });
  assert.equal(ch.c.sent.length, 1, "pending on one RPC's word: not rebuilt");
  // on both: rebuilt from fresh reads at nonce 1, same note and precommitment, new bytes
  ch.c.finNonce = [1n, 1n];
  ch.c.onSend = (raw) => ch.land(raw);
  const r = await runPoolDepositEvm(hostOf(ch, ns), ASK);
  assert.equal(ch.c.sent.length, 2);
  const second = sentOf(ch.c.sent[1]!);
  assert.deepEqual([second.nonce, second.pre, second.value], [1n, first.pre, first.value]);
  assert.notEqual(second.hash, first.hash, "never the old bytes");
  const n = await ns.get(planned.id);
  assert.deepEqual(n!.evmSends!.map((x) => x.nonce), [0n, 1n]);
  assert.equal(n!.state, "UNSPENT");
  assert.equal("stage" in r && r.stage, "filled");
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
