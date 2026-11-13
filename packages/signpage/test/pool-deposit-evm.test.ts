// pool.deposit on an EVM pool (card pool-deposits, slice 3): src/pool-deposit-evm.ts on two mocked RPCs and a
// fake-indexeddb note store. INCOMING with its send before the tx leaves; nothing signed when a simulation fails; a
// taken precommitment restored; a reload settles the open note and plans no new index; a dead send (U's nonce
// past it at a block final on BOTH RPCs, no Deposited) rebuilt on the same note at the new nonce; one index across asks.
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
import { EVM_CHAIN_IDS, evmPoolScopeOf, EVM_LADDER, type EvmNetwork, type EvmPoolEvent, type EvmPoolPin } from "../../wallet/src/pool/evm.ts";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { EVM_POOL_MIN_DEPOSIT } from "../../kit/src/trade/evm/pool-fee.ts";
import { ladderSplit } from "../../wallet/src/pool/ladder.ts";
import { EVM_DEPOSIT_GAS_MAX, evmDepositHeadroom } from "../src/rules/pool.ts";
import { EVM_READ_TRY_MS } from "../../wallet/src/pool/evm.ts";
import { EVM_DEPOSIT_PRIORITY_CAP, EVM_DEPOSIT_RESEND_MS } from "../src/pool-deposit-evm.ts";
import { mock } from "node:test";
import { followPoolDepositEvm, POOL_DEPOSIT_EVM_LANDING_MS, POOL_DEPOSIT_EVM_WAIT_MS, poolDepositEvmKind, runPoolDepositEvm, type PoolDepositEvmHost } from "../src/pool-deposit-evm.ts";
import { EvmNotFinalError } from "../../wallet/src/pool/evm-restore.ts";
import { SolanaRpcTransportError } from "../../kit/src/trade/solana/send.ts";
import type { PoolAsk } from "../src/rules/pool.ts";

const ENTROPY = () => new Uint8Array(16);
const SEED = wordsToSeed64(entropyToWords(ENTROPY()));
const POOL = "0x00000000000000000000000000000000000f0011";
// the network this file runs on: Base Sepolia, or the one test/pool-deposit-evm-mainnet.test.ts names before it imports
// this file (Base and Robinhood mainnet, card evm-deposit-on-mainnet: every edge below on SIGN_HOST's own networks)
const NET: EvmNetwork = (globalThis as { __ctEvmDepositNet?: EvmNetwork }).__ctEvmDepositNet ?? "base-sepolia";
const TESTNET = NET === "base-sepolia" || NET === "robinhood-testnet";
const CHAIN: "base" | "robinhood" = NET === "base" || NET === "base-sepolia" ? "base" : "robinhood";
const PIN: EvmPoolPin = Object.freeze({ network: NET, pool: POOL, feeRecipient: "0x0000000000000000000000000000000000000fee", fromBlock: 1n });
const SCOPE = evmPoolScopeOf(POOL, EVM_CHAIN_IDS[NET]);
const RUNG = EVM_LADDER.min; // 0.001 ETH
const ASK: PoolAsk = { kind: "pool.deposit", chain: CHAIN, token: null, amount: RUNG, slippageBps: 0, decimals: 18 };
/** The L1 fee bound the mock's oracle answers (Base's and Base Sepolia's GasPriceOracle); a Robinhood deposit reads none. */
const L1 = CHAIN === "base" ? 7_000n : 0n;
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

/** Two RPCs over one chain: per-RPC balance, nonce and simulation; the pool's events and its finalized block. */
function chain() {
  const c = {
    block: 100n,
    baseFee: 1_000_000n,
    nonce: 0n,
    /** U's nonce each RPC answers at a block hash (EIP-1898), when not `nonce` */
    nonceAt: [null, null] as (bigint | null)[],
    /** each RPC's "finalized" header number, when not `fin` */
    finHead: [null, null] as (bigint | null)[],
    /** each RPC's block hash at a number, when not the default */
    hashes: [new Map<bigint, string>(), new Map<bigint, string>()],
    /** RPCs that keep no old state: U's nonce at "finalized" refused as Robinhood's public nodes refuse it */
    pruned: false,
    balance: [0n, 0n] as bigint[],
    simFail: [false, false],
    events: [] as EvmPoolEvent[],
    fin: 100n,
    sent: [] as string[],
    onSend: (_raw: string) => {},
    // one RPC's word off the other's: added to RPC 1's answer
    off: { nonce: 0n, estimate: 0n, l1: 0n, baseFee: 0n },
    /** each RPC's estimate of a call by its value, when not the mock's 250,000 (re-read P3-4: the rung-down estimate) */
    estimateOf: null as ((k: number, value: bigint) => bigint) | null,
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
    c.balance = c.balance.map((b) => b - s.value - 10n ** 12n);
  };
  const rpc =
    (k: number) =>
    async (method: string, params: readonly unknown[]): Promise<unknown> => {
      const p = params as unknown[];
      const off = (v: bigint, d: bigint) => (k === 1 ? v + d : v);
      if (k === 1 && c.down === method) throw new SolanaRpcTransportError("http_5xx", "HTTP 503", 4, "rpc1.example");
      switch (method) {
        case "eth_getBlockByNumber": {
          const n = p[0] === "latest" ? (c.head[k] ?? c.block) : p[0] === "finalized" ? (c.finHead[k] ?? c.fin) : BigInt(p[0] as string);
          return { number: q(n), hash: c.hashes[k]!.get(n) ?? `0x${"11".repeat(32)}`, timestamp: "0x1", baseFeePerGas: q(off(c.baseFee, c.off.baseFee)) };
        }
        case "eth_getTransactionCount":
          if (p[1] === "finalized" && c.pruned) throw new Error("RPC error -32000: historical state a5a7fa45d53925ebc8c068cfff3eb8a4b45ff56fc39078b86d614df23a905b8a is not available");
          if (typeof p[1] === "object" && p[1] !== null) return q(c.nonceAt[k] ?? c.nonce);
          return q(p[1] === "pending" ? (c.pending[k] ?? c.nonce) : off(c.nonce, c.off.nonce));
        case "eth_getTransactionByHash":
          return c.known[k]!.has(p[0] as string) ? { hash: p[0] } : null;
        case "eth_getBalance":
          return q((c.at.get(String(p[0]).toLowerCase()) ?? c.balance)[k]!);
        case "eth_estimateGas":
          if (c.estimateOf !== null) return q(c.estimateOf(k, BigInt((p[0] as { value: string }).value)));
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
    testnet: TESTNET,
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
  assert.deepEqual(a, { stage: "filled", txs: [{ chain: CHAIN, hash: s.hash }] });
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

test("a dead send (U's nonce past it at a block final on BOTH RPCs, no Deposited) is rebuilt on the same note at the new nonce; on one RPC only it stays pending", async () => {
  const { ch, ns, planned } = await funded(RUNG + FEE);
  await runPoolDepositEvm(hostOf(ch, ns), ASK);
  const first = sentOf(ch.c.sent[0]!);
  // U's nonce 0 used by another tx (dropped deposit): read past it on one RPC only
  ch.c.nonce = 1n;
  ch.c.nonceAt = [null, 0n]; // RPC 1 reads U's nonce unmoved at the newest block
  const p = await runPoolDepositEvm(hostOf(ch, ns), null); // the load's pass
  assert.deepEqual(p, { stage: "not_landed", txs: [] });
  assert.equal(ch.c.sent.length, 1, "pending on one RPC's word: not rebuilt");
  // on both: rebuilt from fresh reads at nonce 1, same note and precommitment, new bytes
  ch.c.nonceAt = [null, null];
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

// Card evm-deposit-note-stays-incoming: Robinhood's public nodes keep ~10 to 24 s of state and refuse U's nonce at
// "finalized" (-32000 "historical state ... is not available"); the verdict reads only the newest block's state and
// block headers, so a landed deposit settles on the next load whatever such a node refuses.
test("evm-deposit-note-stays-incoming: on RPCs that refuse state at \"finalized\" (the exact -32000) and serve the newest block, a landed deposit's note turns UNSPENT on the next load", async () => {
  const { ch, ns, planned } = await funded(RUNG + FEE);
  ch.c.pruned = true;
  const a = await runPoolDepositEvm(hostOf(ch, ns, { reads: 1 }), ASK);
  assert.equal("stage" in a && a.stage, "sent");
  assert.equal((await ns.get(planned.id))!.state, "INCOMING");
  ch.land(ch.c.sent[0]!); // mined, its Deposited final
  const p = await runPoolDepositEvm(hostOf(ch, ns), null); // the next load's pass
  assert.deepEqual(p, { stage: "filled", txs: [] });
  const n = await ns.get(planned.id);
  assert.deepEqual([n!.state, n!.leaf?.value], ["UNSPENT", RUNG], "usable on the next load");
  assert.equal(ch.c.sent.length, 1, "never sent again");
});

test("evm-deposit-note-stays-incoming: a send that lands just after the device read U's nonce unmoved is read landed by the round read after it, never dead, never sent again", async () => {
  const { ch, ns, planned } = await funded(RUNG + FEE);
  ch.c.pruned = true;
  await runPoolDepositEvm(hostOf(ch, ns, { reads: 1 }), ASK);
  let plant = true;
  const at = (rpc: (m: string, p: readonly unknown[]) => Promise<unknown>) => async (m: string, p: readonly unknown[]) => {
    const got = await rpc(m, p);
    if (plant && m === "eth_getTransactionCount" && typeof p[1] === "object") (plant = false), ch.land(ch.c.sent[0]!); // lands after the read answered 0
    return got;
  };
  const rpcs = [at(ch.rpcs[0]), at(ch.rpcs[1])] as const;
  // the nonce read answered unmoved on both, then the send landed: no block kept, and the round read after it holds
  // the Deposited
  const p = await runPoolDepositEvm(hostOf(ch, ns, { rpcs }), null);
  assert.equal(plant, false, "the planted landing happened");
  assert.deepEqual(p, { stage: "filled", txs: [] });
  assert.equal(ch.c.sent.length, 1, "never built again");
  assert.equal((await ns.get(planned.id))!.state, "UNSPENT");
});

test("evm-deposit-note-stays-incoming: a reorg between U's nonce read and its block's finality drops the kept block: U's nonce unmoved on the final chain, nothing built again", async () => {
  const { ch, ns, planned } = await funded(RUNG + FEE);
  ch.c.pruned = true;
  await runPoolDepositEvm(hostOf(ch, ns, { reads: 1 }), ASK);
  // a tx at U's nonce 0 with no Deposited (another device's, or a revert) in block 100, not final yet
  ch.c.nonce = 1n;
  ch.c.fin = 90n;
  assert.deepEqual(await runPoolDepositEvm(hostOf(ch, ns), null), { stage: "not_landed", txs: [] });
  assert.equal(ch.c.sent.length, 1, "kept, not final: pending");
  // a reorg: block 100 is another block, in which U's nonce 0 is unused; it goes final
  ch.c.hashes = [new Map([[100n, `0x${"22".repeat(32)}`]]), new Map([[100n, `0x${"22".repeat(32)}`]])];
  ch.c.nonce = 0n;
  ch.c.fin = 100n;
  for (let k = 0; k < 2; k++) assert.deepEqual(await runPoolDepositEvm(hostOf(ch, ns), null), { stage: "not_landed", txs: [] });
  assert.equal(ch.c.sent.length, 1, "never built again on a block the final chain does not hold");
  assert.equal((await ns.get(planned.id))!.state, "INCOMING");
  // the send lands on the final chain: settled as the note
  ch.land(ch.c.sent[0]!);
  assert.deepEqual(await runPoolDepositEvm(hostOf(ch, ns), null), { stage: "filled", txs: [] });
  assert.equal((await ns.get(planned.id))!.state, "UNSPENT");
});

test("evm-deposit-note-stays-incoming: one RPC behind or lying (U's nonce, the finalized header, the kept block's hash) or a round behind the kept block builds nothing; both honest and final builds the note again once, at U's new nonce", async () => {
  const { ch, ns, planned } = await funded(RUNG + FEE);
  ch.c.pruned = true;
  await runPoolDepositEvm(hostOf(ch, ns, { reads: 1 }), ASK);
  ch.c.nonce = 1n; // U's nonce 0 used by a tx with no Deposited
  const pass = async (o: Partial<PoolDepositEvmHost> = {}) => {
    assert.deepEqual(await runPoolDepositEvm(hostOf(ch, ns, o), null), { stage: "not_landed", txs: [] });
    assert.equal(ch.c.sent.length, 1, JSON.stringify({ nonceAt: ch.c.nonceAt.map(String), finHead: ch.c.finHead.map(String) }));
  };
  ch.c.nonceAt = [null, 0n]; // RPC 1 reads U's nonce unmoved at the block
  await pass();
  ch.c.nonceAt = [null, null];
  ch.c.finHead = [null, 99n]; // RPC 1's finalized block below the kept one (behind)
  await pass();
  ch.c.finHead = [90n, 10_000n]; // RPC 1 says final far ahead, RPC 0 has not reached it
  await pass();
  ch.c.finHead = [null, null];
  ch.c.hashes = [new Map(), new Map([[100n, `0x${"33".repeat(32)}`]])]; // RPC 1 names another block at the kept number
  await pass();
  ch.c.hashes = [new Map(), new Map()];
  await pass({ round: async () => ({ events: [...ch.c.events], finalBlock: 99n }) }); // the round's final events stop below the kept block
  ch.c.onSend = (raw) => ch.land(raw);
  assert.deepEqual(await runPoolDepositEvm(hostOf(ch, ns), null), { stage: "not_landed", txs: [] }, "built again: pending");
  assert.equal(ch.c.sent.length, 2);
  assert.deepEqual([sentOf(ch.c.sent[1]!).nonce, sentOf(ch.c.sent[1]!).pre], [1n, planned.precommitment], "the same note at U's new nonce");
  assert.deepEqual(await runPoolDepositEvm(hostOf(ch, ns), null), { stage: "filled", txs: [] });
  assert.equal((await ns.get(planned.id))!.state, "UNSPENT");
  assert.equal(ch.c.sent.length, 2, "one deposit");
});

test("evm-deposit-note-stays-incoming: no step of the deposit asks a block's state by a tag other than the newest block both RPCs hold", async () => {
  const { ch, ns } = await funded(RUNG + FEE);
  ch.c.pruned = true;
  const asked: unknown[] = [];
  const STATE = new Set(["eth_getTransactionCount", "eth_getBalance", "eth_call", "eth_estimateGas", "eth_getCode", "eth_getStorageAt"]);
  const at = (rpc: (m: string, p: readonly unknown[]) => Promise<unknown>) => async (m: string, p: readonly unknown[]) => (STATE.has(m) && asked.push(p.at(-1)), rpc(m, p));
  const rpcs = [at(ch.rpcs[0]), at(ch.rpcs[1])] as const;
  await runPoolDepositEvm(hostOf(ch, ns, { rpcs, reads: 1 }), ASK);
  ch.c.nonce = 1n;
  await runPoolDepositEvm(hostOf(ch, ns, { rpcs }), null);
  const s = new Set(asked.map((x) => JSON.stringify(x)));
  assert.ok(asked.length > 0);
  const newest = [JSON.stringify(q(ch.c.block)), '"latest"', '"pending"', JSON.stringify({ blockHash: `0x${"11".repeat(32)}` })];
  for (const x of s) assert.ok(newest.includes(x), `a state read at ${x}`);
});

// The independent review of 04446874: a refused read of U's nonce at the newest block's hash never keeps a landed note
// INCOMING (review 1); the kept block lives with the note's record, so a reload waits on the same block (review 2); each
// RPC's word is checked on both seats (review 3); nothing of U stays in the page past a sign out and the lag waits end
// with it (review 4).
type Rpc = (m: string, p: readonly unknown[]) => Promise<unknown>;
const refusing = (ch: ReturnType<typeof chain>, seat: number, msg: string) =>
  ch.rpcs.map((rpc, k) => async (m: string, p: readonly unknown[]) => {
    if (k === seat && m === "eth_getTransactionCount" && typeof p[1] === "object") throw new Error(msg);
    return rpc(m, p);
  }) as unknown as readonly [Rpc, Rpc];
const NO_HEADER = "RPC error -32000: header for hash not found";
const PRUNED = "RPC error -32000: historical state ca8bb15301a3aa9f843453adbb448dbbf18baace8ea267360fd05e1c3dfe50a5 is not available";

test("evm-deposit-note-stays-incoming review 1: a landed deposit whose nonce read at the newest block's hash one RPC refuses (either -32000) settles at that pass", async () => {
  for (const [seat, msg] of [[1, NO_HEADER], [0, PRUNED]] as const) {
    const { ch, ns, planned } = await funded(RUNG + FEE);
    await runPoolDepositEvm(hostOf(ch, ns, { reads: 1 }), ASK);
    ch.land(ch.c.sent[0]!);
    assert.deepEqual(await runPoolDepositEvm(hostOf(ch, ns, { rpcs: refusing(ch, seat, msg) }), null), { stage: "filled", txs: [] }, msg);
    assert.equal((await ns.get(planned.id))!.state, "UNSPENT", msg);
  }
});

test("evm-deposit-note-stays-incoming review 1: the end's reads tell filled while every nonce read at a hash is refused; with no Deposited the refusal is a failed read (backed off)", async () => {
  const { ch, ns, planned } = await funded(RUNG + FEE);
  await runPoolDepositEvm(hostOf(ch, ns, { reads: 1 }), ASK);
  const rec = (await ns.get(planned.id))!;
  const left = { notes: [{ precommitment: rec.precommitment, value: RUNG, nonce: 0n, u: uOf(rec) }], landed: false, whole: true };
  const rpcs = refusing(ch, 1, NO_HEADER);
  const waits: number[] = [];
  const open = await followPoolDepositEvm({ ...hostOf(ch, ns, { rpcs }), records: async () => [rec], wait: async (ms: number) => { if (waits.push(ms) > 2) throw new Error("cut"); } }, left).catch((e: Error) => e.message);
  assert.equal(open, "cut", "no Deposited: no end told");
  assert.deepEqual(waits.slice(0, 2), [10_000, 20_000], "a failed read: backed off, never read as a send that may land");
  ch.land(ch.c.sent[0]!);
  assert.equal(await followPoolDepositEvm({ ...hostOf(ch, ns, { rpcs }), records: async () => [rec], wait: () => Promise.reject(new Error("cut")) }, left), "filled");
});

test("evm-deposit-note-stays-incoming review 1: a new ask is never refused for an earlier open note's refused nonce read; with no ask the refusal is the pass's answer", async () => {
  const { ch, ns } = await funded(2n * (RUNG + FEE));
  await runPoolDepositEvm(hostOf(ch, ns, { reads: 1 }), ASK); // note 1: sent, open, no Deposited
  const rpcs = refusing(ch, 1, "RPC error -32000: header not found");
  assert.deepEqual(await runPoolDepositEvm(hostOf(ch, ns, { rpcs }), null), { error: "failed" }, "the pass alone: the read failed");
  assert.equal(ch.c.sent.length, 1);
  const a = await runPoolDepositEvm(hostOf(ch, ns, { rpcs, reads: 1 }), ASK);
  assert.equal("stage" in a && a.stage, "sent", JSON.stringify(a));
  assert.equal(ch.c.sent.length, 2, "the new ask's note sent from its own U");
  assert.notEqual(sentOf(ch.c.sent[1]!).pre, sentOf(ch.c.sent[0]!).pre);
});

test("evm-deposit-note-stays-incoming review 1 (P2-1): with no ask, a note whose nonce read is refused never keeps the pass from settling a later note that landed; the pass still answers failed", async () => {
  const { ch, ns } = await funded(2n * (RUNG + FEE));
  await runPoolDepositEvm(hostOf(ch, ns, { reads: 1 }), ASK);
  await runPoolDepositEvm(hostOf(ch, ns, { reads: 1 }), ASK); // a second open note, on its own U
  const open = (await ours(ns)).filter((n) => n.state === "INCOMING");
  assert.equal(open.length, 2);
  // the pass reads them in the store's order: the first one's read refused, the second one landed and final
  const [first, second] = open as [NoteRecord, NoteRecord];
  assert.notEqual(uOf(first), uOf(second));
  ch.land(ch.c.sent.find((raw) => sentOf(raw).pre === second.precommitment)!);
  const u = uOf(first).toLowerCase();
  const rpcs = ch.rpcs.map((rpc, k) => async (m: string, p: readonly unknown[]) => {
    if (k === 1 && m === "eth_getTransactionCount" && typeof p[1] === "object" && String(p[0]).toLowerCase() === u) throw new Error("RPC error -32000: header not found");
    return rpc(m, p);
  }) as unknown as readonly [Rpc, Rpc];
  assert.deepEqual(await runPoolDepositEvm(hostOf(ch, ns, { rpcs }), null), { error: "failed" }, "the refused read is the pass's answer");
  assert.equal((await ns.get(second.id))!.state, "UNSPENT", "the landed note settled all the same");
  assert.equal((await ns.get(first.id))!.state, "INCOMING");
  assert.equal(ch.c.sent.length, 2, "nothing built again");
});

test("evm-deposit-note-stays-incoming review 2: a reloaded page (a new RPC pair, the same store) rebuilds a dead send at the same pass as the page that stayed open; the kept block lives in the note's record until the next send", async () => {
  const kept = async (reload: boolean) => {
    const { ch, ns, planned } = await funded(RUNG + FEE);
    await runPoolDepositEvm(hostOf(ch, ns, { reads: 1 }), ASK);
    ch.c.nonce = 1n; // nonce 0 used by a tx with no Deposited
    ch.c.fin = 90n;
    assert.deepEqual(await runPoolDepositEvm(hostOf(ch, ns), null), { stage: "not_landed", txs: [] });
    const at = (await ns.get(planned.id))!.evmSpent;
    assert.deepEqual(at && [at.nonce, at.number], [0n, 100n], "the block kept with the note");
    ch.c.block = 9_100n; // ~20 min on: block 100 final, the head far past the state window
    ch.c.fin = 100n;
    const rpcs = reload ? ([async (m: string, p: readonly unknown[]) => ch.rpcs[0](m, p), async (m: string, p: readonly unknown[]) => ch.rpcs[1](m, p)] as const) : ch.rpcs;
    await runPoolDepositEvm(hostOf(ch, ns, { rpcs }), null);
    const n = (await ns.get(planned.id))!;
    return [ch.c.sent.length, n.evmSends!.length, n.evmSpent === undefined];
  };
  const open = await kept(false);
  assert.deepEqual(await kept(true), open);
  assert.deepEqual(open, [2, 2, true], "built again at once; the new send's block read afresh");
});

test("evm-deposit-note-stays-incoming review 2: within one run the kept block is read back between reads, so a dead send is built again once its block is final, not chased up the head", async () => {
  const { ch, ns } = await funded(2n * (RUNG + FEE));
  let k = 0;
  ch.c.onSend = () => void (k++ === 0 && ((ch.c.nonce = 1n), (ch.c.fin = 90n))); // the first send's nonce used, no Deposited
  let reads = 0;
  const wait = async () => {
    if (++reads === 1) (ch.c.block = 9_100n), (ch.c.fin = 100n);
  };
  await runPoolDepositEvm(hostOf(ch, ns, { reads: 3, wait }), ASK);
  assert.equal(ch.c.sent.length, 2, "built again on the run's second read");
});

test("evm-deposit-note-stays-incoming review 3: a node that keeps only the newest block's state is never asked an older block's; the dead send is built again once its block is final", async () => {
  const { ch, ns, planned } = await funded(RUNG + FEE);
  await runPoolDepositEvm(hostOf(ch, ns, { reads: 1 }), ASK);
  const hashOf = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
  const asked = new Set<string>();
  const rpcs = ch.rpcs.map((rpc) => async (m: string, p: readonly unknown[]) => {
    if (m === "eth_getBlockByNumber") {
      const b = (await rpc(m, p)) as { number: string };
      return { ...b, hash: hashOf(BigInt(b.number)) };
    }
    if (m === "eth_getTransactionCount" && typeof p[1] === "object") {
      const h = (p[1] as { blockHash: string }).blockHash;
      asked.add(h);
      if (h !== hashOf(ch.c.block)) throw new Error("RPC error -32000: historical state 00 is not available");
    }
    return rpc(m, p);
  }) as unknown as readonly [Rpc, Rpc];
  ch.c.nonce = 1n;
  ch.c.fin = 90n;
  const pass = () => runPoolDepositEvm(hostOf(ch, ns, { rpcs }), null);
  assert.deepEqual(await pass(), { stage: "not_landed", txs: [] });
  ch.c.block = 5_000n;
  ch.c.fin = 99n;
  assert.deepEqual(await pass(), { stage: "not_landed", txs: [] });
  ch.c.block = 9_100n;
  ch.c.fin = 100n;
  ch.c.onSend = (raw) => ch.land(raw);
  await pass();
  assert.deepEqual([...asked], [hashOf(100n)], "only the newest block's state, once");
  assert.equal(ch.c.sent.length, 2, "built again once block 100 is final");
  assert.equal((await ns.get(planned.id))!.evmSends!.length, 2);
});

test("evm-deposit-note-stays-incoming review 3: RPC 0's word is checked as RPC 1's is (U's nonce, the kept hash), and a block a reorg dropped is forgotten, so the send is read again on the final chain", async () => {
  const { ch, ns } = await funded(RUNG + FEE);
  await runPoolDepositEvm(hostOf(ch, ns, { reads: 1 }), ASK);
  ch.c.nonce = 1n;
  const pass = async () => assert.deepEqual(await runPoolDepositEvm(hostOf(ch, ns), null), { stage: "not_landed", txs: [] });
  ch.c.nonceAt = [0n, null]; // RPC 0 reads U's nonce unmoved
  await pass();
  assert.equal(ch.c.sent.length, 1, "RPC 1's word alone for the nonce");
  ch.c.nonceAt = [null, null];
  ch.c.fin = 90n;
  await pass(); // kept: block 100, not final
  ch.c.fin = 100n;
  ch.c.hashes = [new Map([[100n, `0x${"33".repeat(32)}`]]), new Map()]; // RPC 0 names another block at 100
  await pass();
  assert.equal(ch.c.sent.length, 1, "RPC 1's word alone for the kept block's hash");
  // both name another block at 100: the kept one was dropped. Read again at the newest block, whose own block is final
  ch.c.hashes = [new Map([[100n, `0x${"33".repeat(32)}`]]), new Map([[100n, `0x${"33".repeat(32)}`]])];
  await pass(); // the dropped block forgotten
  ch.c.onSend = (raw) => ch.land(raw);
  await pass(); // block 100 (now 0x33..) read and final: built again
  assert.equal(ch.c.sent.length, 2, "read again on the chain that is final, and built again");
});

test("evm-deposit-note-stays-incoming review 3: a note built again is dead only past its last send's nonce, never its first's", async () => {
  const { ch, ns } = await funded(2n * (RUNG + FEE));
  await runPoolDepositEvm(hostOf(ch, ns, { reads: 1 }), ASK);
  ch.c.nonce = 1n; // nonce 0 used, no Deposited
  ch.c.fin = 90n;
  await runPoolDepositEvm(hostOf(ch, ns), null);
  ch.c.fin = 100n;
  await runPoolDepositEvm(hostOf(ch, ns), null);
  assert.equal(ch.c.sent.length, 2, "built again at nonce 1");
  assert.equal(sentOf(ch.c.sent[1]!).nonce, 1n);
  ch.c.block = 200n; // nonce 1 not used yet; the newest block final
  ch.c.fin = 200n;
  for (let k = 0; k < 2; k++) assert.deepEqual(await runPoolDepositEvm(hostOf(ch, ns), null), { stage: "not_landed", txs: [] });
  assert.equal(ch.c.sent.length, 2, "the rebuild at nonce 1 may still land: nothing built");
});

test("evm-deposit-note-stays-incoming review 4: the end's reads keep nothing of U past their own life, and the record's kept block is read on a new page's first read", async () => {
  const { ch, ns, planned } = await funded(RUNG + FEE);
  await runPoolDepositEvm(hostOf(ch, ns, { reads: 1 }), ASK);
  const rec = (await ns.get(planned.id))!;
  const left = { notes: [{ precommitment: rec.precommitment, value: RUNG, nonce: 0n, u: uOf(rec) }], landed: false, whole: true };
  ch.c.nonce = 1n;
  ch.c.fin = 90n;
  let byHash = 0;
  const rpcs = ch.rpcs.map((rpc) => async (m: string, p: readonly unknown[]) => (m === "eth_getTransactionCount" && typeof p[1] === "object" && byHash++, rpc(m, p))) as unknown as readonly [Rpc, Rpc];
  const stop = new AbortController();
  // a follow that kept block 100, then the sign out
  assert.equal(await followPoolDepositEvm({ ...hostOf(ch, ns, { rpcs }), signal: stop.signal, records: async () => [rec], wait: async () => stop.abort() }, left), null);
  assert.equal(byHash, 2, "U's nonce read on both RPCs");
  // the next follow over the same pair holds nothing of it: U's nonce read again
  await followPoolDepositEvm({ ...hostOf(ch, ns, { rpcs }), records: async () => [rec], wait: () => Promise.reject(new Error("cut")) }, left).catch(() => null);
  assert.equal(byHash, 4, "read again: nothing of U kept in the page");
  // the pass keeps block 100 with the note; final now: a new follow reads it from the record and starts the pass at once
  await runPoolDepositEvm(hostOf(ch, ns, { rpcs }), null);
  ch.c.block = 9_100n;
  ch.c.fin = 100n;
  const kept = (await ns.get(planned.id))!;
  let settled = 0;
  byHash = 0;
  await followPoolDepositEvm({ ...hostOf(ch, ns, { rpcs }), records: async () => [kept], settle: () => void settled++, wait: () => Promise.reject(new Error("cut")) }, left).catch(() => null);
  assert.deepEqual([settled, byHash], [1, 0], "the record's block, final: the pass started, no nonce read");
});

test("evm-deposit-note-stays-incoming review 2: the end's reads read past a record's block a reorg dropped: U's nonce read again at the newest block, and the pass started once that one is final", async () => {
  const { ch, ns, planned } = await funded(RUNG + FEE);
  await runPoolDepositEvm(hostOf(ch, ns, { reads: 1 }), ASK);
  ch.c.nonce = 1n; // nonce 0 used, no Deposited
  ch.c.fin = 90n;
  await runPoolDepositEvm(hostOf(ch, ns), null); // the pass keeps block 100 with the note
  const rec = (await ns.get(planned.id))!;
  assert.equal(rec.evmSpent?.number, 100n);
  // a reorg: both name another block at 100; the newest block (also 100) and final
  ch.c.hashes = [new Map([[100n, `0x${"44".repeat(32)}`]]), new Map([[100n, `0x${"44".repeat(32)}`]])];
  ch.c.fin = 100n;
  let settled = 0;
  let waits = 0;
  await followPoolDepositEvm({ ...hostOf(ch, ns), records: async () => [rec], settle: () => void settled++, wait: async () => { if (++waits > 2) throw new Error("cut"); } }, { notes: [{ precommitment: rec.precommitment, value: RUNG, nonce: 0n, u: uOf(rec) }], landed: false, whole: true }).catch(() => null);
  assert.equal(settled > 0, true, "the dropped block read past: the pass started");
});

test("evm-deposit-note-stays-incoming review 4: a sign out during a lag wait of U's nonce read sends no header read after it (the end's reads and the run's)", async () => {
  for (const end of [true, false]) {
    const { ch, ns, planned } = await funded(RUNG + FEE);
    await runPoolDepositEvm(hostOf(ch, ns, { reads: 1 }), ASK);
    const rec = (await ns.get(planned.id))!;
    ch.c.nonce = 1n;
    const stop = new AbortController();
    let after = 0;
    // RPC 1 has no newest block yet: a lag, waited on (one tag answer of each RPC is the agreed block's read, card
    // evm-first-proof-inside-ten-seconds, so the lag is RPC 1's latest, never a read by number)
    const rpcs = ch.rpcs.map((rpc, k) => async (m: string, p: readonly unknown[]) => {
      if (stop.signal.aborted) after++;
      if (k === 1 && m === "eth_getBlockByNumber" && p[0] === "latest") return null;
      return rpc(m, p);
    }) as unknown as readonly [Rpc, Rpc];
    const h = { ...hostOf(ch, ns, { rpcs }), signal: stop.signal, wait: async () => stop.abort() };
    if (end) await followPoolDepositEvm({ ...h, records: async () => [rec] }, { notes: [{ precommitment: rec.precommitment, value: RUNG, nonce: 0n, u: uOf(rec) }], landed: false, whole: true });
    else await runPoolDepositEvm(h, null);
    assert.equal(stop.signal.aborted, true, "the lag was waited on");
    assert.equal(after, 0, `no read after the sign out (${end ? "end" : "run"})`);
  }
});

test("a Deposited at another value in the verdict is a take: the note restored at that value, the rung sent again on the next note", async () => {
  const { ch, ns, planned } = await funded(2n * RUNG + FEE);
  let k = 0;
  ch.c.onSend = (raw) => {
    if (k++ === 0) {
      // a front-runner's deposit lands first on the precommitment; U's tx reverts, its nonce used
      ch.deposit(sentOf(raw).pre, EVM_POOL_MIN_DEPOSIT);
      ch.c.nonce = 1n;
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

test("a take of U's deposit note in a block not final yet: the note is the user's at once (UNSPENT at the take's value, its block kept), nothing more signed past it, the run's wait rejects with EvmNotFinalError (pool-kinds answers busy)", async () => {
  const { ch, ns, planned } = await funded(RUNG + FEE);
  ch.deposit(planned.precommitment, EVM_POOL_MIN_DEPOSIT);
  ch.c.events[0]!.block = ch.c.fin + 1n; // above the round's finalized block
  await assert.rejects(runPoolDepositEvm(hostOf(ch, ns), ASK), (e: unknown) => e instanceof EvmNotFinalError);
  const kind = poolDepositEvmKind(() => hostOf(ch, ns));
  const run = kind(ASK, null) as { after: Promise<void>; answer(): unknown };
  await assert.rejects(run.after, (e: unknown) => e instanceof EvmNotFinalError);
  assert.equal(ch.c.sent.length, 0, "nothing sent");
  // card evm-money-shows-and-spends-at-once: the newest agreed block holds the take, so the note shows now
  const got = (await ns.get(planned.id))!;
  assert.equal(got.state, "UNSPENT");
  assert.equal(got.leaf?.value, EVM_POOL_MIN_DEPOSIT);
  assert.equal((await ns.landings()).get(got.id), ch.c.fin + 1n, "its block kept beside it");
});

test("a rule refusal answers not_allowed, by its class (a PoolRuleRefused), whatever its name", async () => {
  const { ch, ns } = await funded(RUNG + FEE);
  // the other chain's ask on this chain's pin: the rule refuses the pin (evm_not_pinned)
  const a = await runPoolDepositEvm(hostOf(ch, ns), { ...ASK, chain: CHAIN === "base" ? "robinhood" : "base" });
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
    assert.deepEqual(await runPoolDepositEvm(hostOf(ch, ns, { testnet: false, pin: { ...PIN, network: CHAIN === "base" ? "base-sepolia" : "robinhood-testnet" } }), ASK), { error: "not_allowed" }, "the testnet pin under SIGN_HOST");
    assert.equal(ch.c.sent.length, 0);
  }
  {
    const { ch, ns } = await funded(RUNG + FEE);
    assert.deepEqual(await runPoolDepositEvm(hostOf(ch, ns, { testnet: true, pin: { ...PIN, network: CHAIN } }), ASK), { error: "not_allowed" }, "the mainnet pin under the testnet page");
    assert.equal(ch.c.sent.length, 0);
  }
});

test("before a send, two RPCs that read apart (U's nonce, the estimate, the chain fee, the base fee) answer failed; a provider down past the page's retry answers down", async () => {
  // the L1 fee is Base's alone: a Robinhood deposit reads none, so none can read apart there
  for (const [k, d] of ([["nonce", 1n], ["estimate", 1n], ["l1", 1n], ["baseFee", 1n]] as const).filter(([k]) => k !== "l1" || L1 > 0n)) {
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
  const bound = (EVM_DEPOSIT_GAS_MAX + evmDepositHeadroom(0n, 0n)) * (2n * ch.c.baseFee + EVM_DEPOSIT_PRIORITY_CAP) + L1; // the cap's gas and the tree's headroom at the max fee, and the L1 fee bound
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
const capBound = (c: { baseFee: bigint; depth: bigint[] }) => (EVM_DEPOSIT_GAS_MAX + evmDepositHeadroom(c.depth[0]!, c.depth[1]!)) * (2n * c.baseFee + EVM_DEPOSIT_PRIORITY_CAP) + L1;
/** One deposit's fee at the run's own need (card evm-deposit-route-mainnet review P2b): the mock's estimate (250,000)
 *  and the tree's headroom, at 2 x base fee + tip, and the mock's L1 fee. */
const estBound = (c: { baseFee: bigint; depth: bigint[] }) => (250_000n + evmDepositHeadroom(c.depth[0]!, c.depth[1]!)) * (2n * c.baseFee + EVM_DEPOSIT_PRIORITY_CAP) + L1;

test("R1: an earlier ask's note that lands later is settled by the next run, never credited to it: the later ask sends its own deposit and answers with its own tx", async () => {
  const { ch, ns, planned } = await funded(0n);
  ch.c.balance = [RUNG + capBound(ch.c), RUNG + capBound(ch.c)];
  // ask X: sent, its Deposited not in any round within the run (mined after the run's last read)
  let landX = () => {};
  ch.c.onSend = (raw) => {
    const s = sentOf(raw);
    landX = () => ch.deposit(s.pre, s.value);
    ch.c.nonce = s.nonce + 1n;
    ch.c.balance = ch.c.balance.map((b) => b - s.value - 250_000n * (ch.c.baseFee + EVM_DEPOSIT_PRIORITY_CAP));
  };
  const a = await runPoolDepositEvm(hostOf(ch, ns), ASK);
  assert.equal("stage" in a && a.stage, "sent");
  const x = sentOf(ch.c.sent[0]!).hash;
  assert.equal((await ns.get(planned.id))!.state, "INCOMING");
  // later: X's Deposited is in the round and final (Y's deposit index is found past X's note, so Y is signed once X's block is final); the user funds U for a second deposit Y of one rung and asks it
  landX();
  ch.c.balance = ch.c.balance.map((b) => b + RUNG + capBound(ch.c));
  ch.c.onSend = (raw) => ch.land(raw);
  const sent: string[] = [];
  const b = await runPoolDepositEvm(hostOf(ch, ns, { sent: (h) => void sent.push(h) }), ASK);
  assert.equal(ch.c.sent.length, 2, "Y sent its own deposit");
  const y = sentOf(ch.c.sent[1]!).hash;
  assert.notEqual(y, x);
  assert.deepEqual(b, { stage: "filled", txs: [{ chain: CHAIN, hash: y }] }, "Y answered with Y's tx, never X's");
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
  // the deposit is mined and reverts: U's nonce used, its gas burnt, and U left 1 wei short of paying it again
  ch.c.onSend = (raw) => {
    const s = sentOf(raw);
    ch.c.nonce = s.nonce + 1n;
    ch.c.at.set(u.toLowerCase(), [RUNG + estBound(ch.c) - 1n, RUNG + estBound(ch.c) - 1n]);
  };
  const a = await runPoolDepositEvm(h(), ASK);
  assert.equal("stage" in a && a.stage, "sent", "the ask's send: sent, never failed");
  assert.equal(ch.c.sent.length, 1, "the send again not signed: U cannot pay it");
  assert.equal((await ns.get(planned.id))!.state, "INCOMING");
  const low = ch.c.at.get(u.toLowerCase())![0]!;
  const want: [string, bigint] = [u, RUNG + estBound(ch.c) - low];
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

test("the gas limit is the two-RPC estimate plus the tree's headroom from the pool's two depths, and U's balance covers that padded limit (review P2b: the run's need is that limit's fee, never the cap's)", async () => {
  const { ch, ns } = await funded(0n);
  ch.c.depth = [7n, 5n];
  const need = RUNG + estBound(ch.c);
  assert.ok(need < RUNG + capBound(ch.c), "under what the cap would need");
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

// card evm-deposit-route-mainnet re-read P3-4: U holds two rungs, under two rungs and the fee: the run steps down to
// the one rung that fits with its fee and estimates that call again on both RPCs. That second estimate is held as the
// first: the two RPCs alike, at most the cap, and the one the tx's gas limit is built from
test("re-read P3-4: the rung-down call's own estimate, alike on both RPCs and capped, is the gas limit; apart, over the cap, or not read, nothing signed at it", async () => {
  const two = 2n * RUNG;
  const setup = async (est: (k: number, value: bigint) => bigint) => {
    const f = await funded(two + estBound(f0.ch.c) - 1n);
    f.ch.c.estimateOf = est;
    f.ch.c.onSend = (raw) => f.ch.land(raw);
    return f;
  };
  const f0 = await funded(0n);
  // the lower rung's call estimated at 300,000 on both: the gas limit is that and the headroom, never the first 250,000
  const a = await setup((_k, v) => (v === two ? 250_000n : 300_000n));
  const ra = await runPoolDepositEvm(hostOf(a.ch, a.ns), { ...ASK, amount: two });
  assert.equal(a.ch.c.sent.length, 1, JSON.stringify(ra));
  assert.equal(sentOf(a.ch.c.sent[0]!).value, RUNG, "one rung, the one that fits with its fee");
  assert.equal(sentOf(a.ch.c.sent[0]!).gas, 300_000n + evmDepositHeadroom(0n, 0n), "the rung-down call's own estimate");
  // the lower rung's call read apart (the first RPC as the first estimate, the second not): nothing signed
  const b = await setup((k, v) => (v === two ? 250_000n : k === 0 ? 250_000n : 260_000n));
  assert.deepEqual(await runPoolDepositEvm(hostOf(b.ch, b.ns), { ...ASK, amount: two }), { error: "failed" });
  assert.equal(b.ch.c.sent.length, 0);
  // the lower rung's call over the cap on both: refused, nothing signed
  const c = await setup((_k, v) => (v === two ? 250_000n : EVM_DEPOSIT_GAS_MAX + 1n));
  assert.deepEqual(await runPoolDepositEvm(hostOf(c.ch, c.ns), { ...ASK, amount: two }), { error: "not_allowed" });
  assert.equal(c.ch.c.sent.length, 0);
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
// Deposited naming the note at its value is final; not_landed only once U's nonce is past every send of it (at a final block) on
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

test("pool-deposit-sent-end (EVM): a send that lands after the run gives filled as soon as its Deposited is in the round, its block not final yet; before it lands, nothing", async () => {
  const { ch, ns } = await funded(RUNG + FEE);
  const f = followedEvm(ch, ns);
  await f.r.after;
  const s = sentOf(ch.c.sent[0]!);
  assert.deepEqual(f.r.answer(), { result: { stage: "sent", txs: [{ chain: CHAIN, hash: s.hash }] } });
  await f.runEnd;
  assert.deepEqual(f.stages, []);
  assert.equal(await f.parked(), true, "the end's reads go on after the run: the app is never left at sent");
  // not landed yet: nothing told
  f.go();
  assert.equal(await f.parked(), true);
  assert.deepEqual(f.stages, [], "no Deposited in the round tells nothing");
  // it lands in a block not final yet: filled at once (card evm-money-shows-and-spends-at-once)
  ch.land(ch.c.sent[0]!);
  ch.c.events.at(-1)!.block = 100n; // the newest agreed block
  ch.c.fin = 90n; // finalized only up to 90
  f.go();
  assert.equal(await f.staged(1), true);
  assert.deepEqual(f.stages, ["filled"], "a Deposited above the finalized block, in the round, is filled");
  assert.equal(ch.c.sent.length, 1, "never sent again");
});

test("pool-deposit-sent-end review 1 (EVM): U's nonce past the send at a block final on one RPC alone tells nothing; on both with no Deposited is no end either (the pass builds the note again at U's new nonce from U's money): the end's reads start the pass and follow the rebuilt send to filled, never not_landed", async () => {
  const { ch, ns, planned } = await funded(RUNG + FEE);
  let kicks = 0;
  const f = followedEvm(ch, ns, { settle: () => void kicks++ });
  await f.r.after;
  await f.runEnd;
  assert.equal(await f.parked(), true);
  ch.c.finHead = [null, 99n]; // the nonce taken by a tx with no Deposited (a revert), its block final on RPC 0 only
  ch.c.nonce = 1n;
  f.go();
  assert.equal(await f.parked(), true);
  assert.deepEqual(f.stages, [], "one RPC's word alone tells nothing");
  assert.equal(kicks, 0);
  ch.c.finHead = [null, null];
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
  assert.deepEqual(f.r.answer(), { result: { stage: "sent", txs: [{ chain: CHAIN, hash: sentOf(ch.c.sent[0]!).hash }] } });
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
  const dead = () => ((ch.c.nonce = 1n), (ended = true));
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
  // a sign out stops a follow at once: no RPC call after it (fold review 4 X7: no landing planted, so only the stop ends it)
  const { ch: ch2, ns: ns2 } = await funded(RUNG + FEE);
  let calls = 0;
  const counted = (rpc: (m: string, p: readonly unknown[]) => Promise<unknown>) => async (m: string, p: readonly unknown[]) => (calls++, rpc(m, p));
  const f = followedEvm(ch2, ns2, { signal: stop.signal, rpcs: [counted(ch2.rpcs[0]), counted(ch2.rpcs[1])] as const });
  await f.r.after;
  await f.runEnd;
  assert.equal(await f.parked(), true);
  const before = calls;
  stop.abort();
  f.go();
  assert.equal(await f.parked(), false, "no read after the sign out");
  assert.equal(calls, before, "no RPC call after the sign out");
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

test("pool-deposit-sent-end fold: the verdict reads U's nonce (at the newest block, kept until final) before the round, so a send that lands and finalizes between the two reads is landed, never read dead and sent again", async () => {
  const { ch, ns, planned } = await funded(RUNG + FEE);
  // the send lands and is final just as the verdict reads U's nonce (planted: between the two reads)
  let landed = false;
  const at = (rpc: (m: string, p: readonly unknown[]) => Promise<unknown>) => async (m: string, p: readonly unknown[]) => {
    if (m === "eth_getTransactionCount" && typeof p[1] === "object" && !landed && ch.c.sent.length > 0) (landed = true), ch.land(ch.c.sent[0]!);
    return rpc(m, p);
  };
  const a = await runPoolDepositEvm(hostOf(ch, ns, { rpcs: [at(ch.rpcs[0]), at(ch.rpcs[1])] as const }), ASK);
  assert.equal(landed, true, "the planted landing happened");
  assert.equal(ch.c.sent.length, 1, "never built again on a nonce read before its Deposited");
  assert.deepEqual(a, { stage: "filled", txs: [{ chain: CHAIN, hash: sentOf(ch.c.sent[0]!).hash }] });
  assert.equal((await ns.get(planned.id))!.state, "UNSPENT");
});

// Card pool-deposit-sent-end review 8: the rules the reviewer's mutants showed unplanted (test/pool-deposit-mutants.mjs).
test("review 8 E1: the follower reads U's nonce (at the newest block, kept until final) before the round: a send that lands and finalizes between the two reads is filled at that read, never read dead (no pass started)", async () => {
  const { ch, ns } = await funded(RUNG + FEE);
  let plant = false;
  const at = (rpc: (m: string, p: readonly unknown[]) => Promise<unknown>) => async (m: string, p: readonly unknown[]) => {
    if (plant && m === "eth_getTransactionCount" && typeof p[1] === "object") (plant = false), ch.land(ch.c.sent[0]!);
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

test("pool-deposit-sent-end fold review 4 X1 (EVM): a note the pass restored at another value (a take read from the store) is not_landed, never filled", async () => {
  const { ch, ns, planned } = await funded(RUNG + FEE);
  const f = followedEvm(ch, ns);
  await f.r.after;
  await f.runEnd;
  assert.equal(await f.parked(), true);
  ch.deposit(planned.precommitment, EVM_POOL_MIN_DEPOSIT); // a front-runner's, final
  await runPoolDepositEvm(hostOf(ch, ns, { reads: 1 }), null); // the page's pass restores it before the end's read
  const n = await ns.get(planned.id);
  assert.deepEqual([n!.state, n!.leaf!.value], ["UNSPENT", EVM_POOL_MIN_DEPOSIT], "restored at the take's value");
  f.go();
  assert.equal(await f.staged(1), true);
  assert.deepEqual(f.stages, ["not_landed"], "restored at another value: never filled");
});

test("pool-deposit-sent-end fold review 4 X14 (EVM): a read that fails (a provider down) backs the end's reads off, 10 s doubling to 60 s, never read as a send that may land", async () => {
  const { ch, ns } = await funded(RUNG + FEE);
  const waits: number[] = [];
  let ended = false;
  let cut = false;
  const kind = poolDepositEvmKind(() => ({ ...hostOf(ch, ns), wait: async (ms: number) => {
      if (cut) throw new Error("cut");
      if (ended) waits.push(ms);
    }, end: () => void ((ch.c.down = "eth_getTransactionCount"), (ended = true)) }));
  await (kind(ASK, { id: "e4", sha: "00", progress: () => {} }) as { after: Promise<void> }).after;
  for (const t0 = Date.now(); waits.length < 5 && Date.now() - t0 < 10_000; ) await new Promise((ok) => setTimeout(ok, 20));
  cut = true;
  assert.deepEqual(waits.slice(0, 5), [10_000, 20_000, 40_000, 60_000, 60_000]);
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
  ch.c.nonce = 1n;
  assert.deepEqual(await runPoolDepositEvm(hostOf(ch, ns, { reads: 1 }), null), { stage: "not_landed", txs: [] });
  assert.deepEqual((await ns.get(planned.id))!.evmSends!.map((x) => x.nonce), [0n, 1n], "built again at nonce 1");
  f.go();
  assert.equal(await f.parked(), true);
  assert.deepEqual(f.stages, []);
  assert.equal(kicks, 0, "the live send at nonce 1 keeps the note from a dead read");
});

// ---- the delta review of 09542dc6 (five Lows): the reviewer's REV tests adopted, and the folds' own ----
const settleMs = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const sumOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
test("pool-deposit-sent-end low 2 (REV E1): two notes both land in the run: exactly one end, and nothing after it", async () => {
  const { ch, ns } = await funded(3n * RUNG + 2n * FEE);
  ch.c.onSend = (raw) => void ch.land(raw);
  const f = followedEvm(ch, ns, {}, { ...ASK, amount: 3n * RUNG });
  await f.r.after;
  await f.runEnd;
  await settleMs(500);
  assert.deepEqual(f.stages, ["sent", "filled"]);
});

test("pool-deposit-sent-end low 2 R5 (EVM): an ask whose first note landed and whose next U cannot carry ends part_filled with no note open: told part_filled once, never filled, and nothing after it", async () => {
  const { ch, ns } = await funded(3n * RUNG + 2n * FEE);
  let n = 0;
  ch.c.onSend = (raw) => {
    ch.land(raw);
    if (n++ === 0) ch.c.balance = [0n, 0n]; // the next rung's U holds nothing
  };
  const f = followedEvm(ch, ns, {}, { ...ASK, amount: 3n * RUNG });
  await f.r.after;
  await f.runEnd;
  await settleMs(500);
  assert.equal(ch.c.sent.length, 1, "one note sent, and it landed");
  assert.deepEqual(f.stages, ["part_filled"]);
  assert.equal(await f.parked(), false, "an ask that ended is not followed");
});

test("pool-deposit-sent-end low 2 R11 (EVM): a sign out during the last read tells nothing, even when that read finds the note landed", async () => {
  const { ch, ns } = await funded(RUNG + FEE);
  const stop = new AbortController();
  const left = { notes: [{ precommitment: 4_242n, value: RUNG, nonce: 0n, u: "0x" + "11".repeat(20) }], landed: false, whole: true };
  const rec = { scope: SCOPE, precommitment: 4_242n, state: "UNSPENT", leaf: { value: RUNG } } as unknown as NoteRecord;
  assert.equal(await followPoolDepositEvm({ ...hostOf(ch, ns), signal: stop.signal, records: async () => (stop.abort(), [rec]) }, left), null, "no end after the sign out");
  assert.equal(await followPoolDepositEvm({ ...hostOf(ch, ns), records: async () => [rec] }, left), "filled", "the same read with no sign out");
});

test("pool-deposit-sent-end low 1 (EVM, REV E2): a send that never lands and never goes dead (U's nonce never passes it, no Deposited) is read every 10 s through its landing window, then backs off as a quiet one, 20 s doubling to 60 s, and is never stopped", async () => {
  const { ch, ns } = await funded(RUNG + FEE);
  const waits: number[] = [];
  let ended = false;
  let calls = 0;
  let cut = false;
  const counted = (rpc: (m: string, p: readonly unknown[]) => Promise<unknown>) => async (m: string, p: readonly unknown[]) => (ended && calls++, rpc(m, p));
  const kind = poolDepositEvmKind(() => ({
    ...hostOf(ch, ns, { rpcs: [counted(ch.rpcs[0]), counted(ch.rpcs[1])] as const }),
    wait: async (ms: number) => {
      if (cut) throw new Error("cut");
      if (ended) {
        if (sumOf(waits) >= 6 * 3_600_000) throw new Error("cut"); // the follower stops here, not at the 20 ms poll below
        waits.push(ms);
      }
    },
    end: () => void (ended = true),
  }));
  await (kind(ASK, { id: "rv3", sha: "00", progress: () => {} }) as { after: Promise<void> }).after;
  for (const t0 = Date.now(); sumOf(waits) < 6 * 3_600_000 && Date.now() - t0 < 30_000; ) await settleMs(20);
  cut = true;
  const inside = POOL_DEPOSIT_EVM_LANDING_MS / 10_000;
  assert.ok(POOL_DEPOSIT_EVM_LANDING_MS >= 1_439_000 + 60_000, "the slowest measured finality and a minute to be mined");
  // each read inside the window waits 10 s, and so does the first read past it (a quiet wait doubles after it is waited)
  assert.ok(waits.slice(0, inside + 1).every((w) => w === 10_000), "every 10 s inside the window");
  assert.deepEqual(waits.slice(inside + 1, inside + 6), [20_000, 40_000, 60_000, 60_000, 60_000], "past it, backed off and capped");
  assert.ok(sumOf(waits) >= 6 * 3_600_000, `still reading after 6 h: ${waits.length} reads, ${calls} RPC calls`);
  assert.ok(waits.length < inside + 400, `the reads past the window come a minute apart: ${waits.length}`);
});

test("pool-deposit-sent-end low 1 (EVM): a note the pass sends anew gets a new landing window: past the window, a dead read starts the pass, and the new send is read every 10 s again", async () => {
  const { ch, ns } = await funded(RUNG + FEE);
  const waits: number[] = [];
  let ended = false;
  let cut = false;
  let killed = -1;
  let pass: Promise<unknown> | null = null;
  const kind = poolDepositEvmKind(() => ({
    ...hostOf(ch, ns),
    settle: () => void (pass ??= runPoolDepositEvm(hostOf(ch, ns, { reads: 1 }), null)),
    wait: async (ms: number) => {
      if (cut) throw new Error("cut");
      if (!ended) return;
      waits.push(ms);
      if (killed < 0 && sumOf(waits) > POOL_DEPOSIT_EVM_LANDING_MS + 300_000) {
        killed = waits.length; // the nonce taken by a tx with no Deposited, final on both: dead
        ch.c.nonce = 1n;
      }
      if (pass) await pass;
    },
    end: () => void (ended = true),
  }));
  await (kind(ASK, { id: "l1e", sha: "00", progress: () => {} }) as { after: Promise<void> }).after;
  for (const t0 = Date.now(); (killed < 0 || waits.length < killed + 4) && Date.now() - t0 < 30_000; ) await settleMs(20);
  cut = true;
  assert.ok(killed > 0, "the reads went past the window");
  assert.equal(waits[killed - 1], 60_000, "backed off past the window");
  assert.equal(ch.c.sent.length, 2, "the pass sent the note anew");
  assert.equal(sentOf(ch.c.sent[1]!).nonce, 1n);
  assert.deepEqual(waits.slice(killed, killed + 3), [60_000, 10_000, 10_000], "the dead read waits quiet, then the new send is read every 10 s");
});

test("pool-deposit-sent-end low 4 (EVM, REV E3): a sign out during a pass's reads stops at once: no RPC read after it, for any open note", async () => {
  const { ch, ns } = await funded(RUNG + FEE);
  const stop = new AbortController();
  let calls = 0;
  let after = 0;
  const counted = (rpc: (m: string, p: readonly unknown[]) => Promise<unknown>) => async (m: string, p: readonly unknown[]) => (calls++, stop.signal.aborted && after++, rpc(m, p));
  let rounds = 0;
  const h = { ...hostOf(ch, ns, { rpcs: [counted(ch.rpcs[0]), counted(ch.rpcs[1])] as const, signal: stop.signal }), round: async () => (rounds++, { events: [...ch.c.events], finalBlock: ch.c.fin }), records: async () => (stop.abort(), ns.list()), wait: async () => {} };
  const left = { notes: [0n, 1n, 2n].map((k) => ({ precommitment: 1000n + k, value: RUNG, nonce: 0n, u: "0x" + "11".repeat(20) })), landed: false, whole: true };
  const got = await followPoolDepositEvm(h, left);
  assert.equal(got, null);
  assert.equal(after, 0, "no read naming U after the sign out");
  assert.equal(rounds, 0, "no round after the sign out");
  // the same pass with no sign out reads each note on both RPCs (the count above means something)
  calls = 0;
  await followPoolDepositEvm({ ...h, signal: undefined, records: async () => ns.list(), wait: () => Promise.reject(new Error("cut")) }, left).catch(() => null);
  assert.equal(calls, 12, "3 open notes, each: the newest block both hold (2 reads: one block, card evm-first-proof-inside-ten-seconds) and U's nonce at its hash, on both RPCs");
});

test("pool-deposit-sent-end low 4 (EVM): the end's own wait ends at the sign out, its timer cleared: the follow returns at once, not a wait later", async () => {
  const { ch, ns } = await funded(RUNG + FEE);
  const stop = new AbortController();
  const { wait: _no, ...bare } = hostOf(ch, ns); // the page's host: no wait of its own, so the follower's is used
  const left = { notes: [{ precommitment: 1000n, value: RUNG, nonce: 0n, u: "0x" + "11".repeat(20) }], landed: false, whole: true };
  const got = followPoolDepositEvm({ ...bare, signal: stop.signal }, left);
  await settleMs(300); // the first read done, the 10 s wait running
  const t0 = Date.now();
  stop.abort();
  const end = await Promise.race([got, settleMs(1_200).then(() => "still waiting" as const)]);
  assert.equal(end, null, "the follow ended with the sign out");
  assert.ok(Date.now() - t0 < 1_000, `ended ${Date.now() - t0} ms after the sign out`);
});

/** A note store whose reads fail once the run has zeroed its seed: the hand-off's store read, and nothing before it. */
function brokenAtHandOff(ns: NoteStore): Partial<PoolDepositEvmHost> {
  let seed: Uint8Array | null = null;
  const broken = new Proxy(ns, { get: (t, k) => (k === "get" && seed !== null && seed.every((b) => b === 0) ? () => Promise.reject(new Error("IndexedDB read failed")) : (t as unknown as Record<string | symbol, unknown>)[k as string]) }) as NoteStore;
  return { notes: async () => broken, seed64: async () => (seed = SEED.slice()) };
}

test("pool-deposit-sent-end low 5 (EVM): the hand-off's store read failing after \"sent\" hands the ask's note over as open: it is read on and told filled once it lands, never left at sent", async () => {
  const { ch, ns } = await funded(RUNG + FEE);
  const f = followedEvm(ch, ns, brokenAtHandOff(ns));
  await f.r.after;
  await f.runEnd;
  assert.deepEqual(f.stages, []);
  assert.equal(await f.parked(), true, "the note is read on: the app is never left at sent");
  ch.land(ch.c.sent[0]!);
  f.go();
  assert.equal(await f.staged(1), true);
  assert.deepEqual(f.stages, ["filled"]);
});

test("pool-deposit-sent-end low 5 (EVM): the hand-off's store read failing after one note landed, with the next still landing, is no end at part_filled: the open note is read on to filled", async () => {
  const { ch, ns } = await funded(3n * RUNG + 2n * FEE);
  let n = 0;
  ch.c.onSend = (raw) => void (n++ === 0 && ch.land(raw)); // the first note lands at once, the second not yet
  const f = followedEvm(ch, ns, brokenAtHandOff(ns), { ...ASK, amount: 3n * RUNG });
  await f.r.after;
  await f.runEnd;
  assert.equal(ch.c.sent.length, 2, "both notes sent");
  assert.deepEqual(f.stages, ["sent"], "never part_filled while the second may land");
  assert.equal(await f.parked(), true, "the open note is read on");
  ch.land(ch.c.sent[1]!);
  f.go();
  assert.equal(await f.staged(2), true);
  assert.deepEqual(f.stages, ["sent", "filled"]);
});

test("pool-deposit-sent-end review 2 (info, EVM): a note a pass the follower did not start sends anew (a state read's) gets a new landing window too: read every 10 s again, not a minute on", async () => {
  const { ch, ns } = await funded(RUNG + FEE);
  const waits: number[] = [];
  let ended = false;
  let cut = false;
  let killed = -1;
  const kind = poolDepositEvmKind(() => ({
    ...hostOf(ch, ns),
    settle: () => {}, // the follower starts no pass here
    wait: async (ms: number) => {
      if (cut) throw new Error("cut");
      if (!ended) return;
      waits.push(ms);
      if (killed < 0 && sumOf(waits) > POOL_DEPOSIT_EVM_LANDING_MS + 300_000) {
        killed = waits.length; // the nonce taken by a tx with no Deposited, final on both: dead
        ch.c.nonce = 1n;
        await runPoolDepositEvm(hostOf(ch, ns, { reads: 1 }), null); // the page's state read: its pass sends the note anew
      }
    },
    end: () => void (ended = true),
  }));
  await (kind(ASK, { id: "l1s", sha: "00", progress: () => {} }) as { after: Promise<void> }).after;
  for (const t0 = Date.now(); (killed < 0 || waits.length < killed + 4) && Date.now() - t0 < 30_000; ) await settleMs(20);
  cut = true;
  assert.ok(killed > 0, "the reads went past the window");
  assert.equal(waits[killed - 1], 60_000, "backed off past the window");
  assert.equal(ch.c.sent.length, 2, "the state read's pass sent the note anew");
  assert.equal(sentOf(ch.c.sent[1]!).nonce, 1n);
  assert.deepEqual(waits.slice(killed, killed + 3), [10_000, 10_000, 10_000], "the new send is read every 10 s");
});

// ---- card start-reads-wait-out-a-throttle: an EVM deposit's reads before U signs wait out a provider fault on the
// page's one rule (src/read-waits.ts readWaits), each attempt from its first read, then "down", nothing sent ----
test("card start-reads-wait-out-a-throttle: a provider down past the page's retry at U's balance, the estimate or the nonce waits 1 s and deposits; one that stays waits 1, 2, 4, 8, 10 s, then down; a sign out ends the wait", async () => {
  for (const m of ["eth_getBalance", "eth_estimateGas", "eth_getTransactionCount"]) {
    const { ch, ns } = await funded(RUNG + FEE);
    ch.c.down = m;
    ch.c.onSend = (raw) => ch.land(raw);
    const waits: number[] = [];
    const a = await runPoolDepositEvm(hostOf(ch, ns, { wait: async (ms) => void (ch.c.sent.length === 0 && (waits.push(ms), (ch.c.down = null))) }), ASK);
    assert.ok("stage" in a && a.stage === "filled", `${m}: ${JSON.stringify(a)}`);
    assert.deepEqual(waits.slice(0, 1), [1_000], m);
    assert.equal(ch.c.sent.length, 1, m);
  }
  {
    const { ch, ns } = await funded(RUNG + FEE);
    ch.c.down = "eth_estimateGas";
    const waits: number[] = [];
    assert.deepEqual(await runPoolDepositEvm(hostOf(ch, ns, { wait: async (ms) => void waits.push(ms) }), ASK), { error: "down" });
    assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000, 10_000]);
    assert.equal(ch.c.sent.length, 0);
  }
  {
    const { ch, ns } = await funded(RUNG + FEE);
    ch.c.down = "eth_estimateGas";
    const stop = new AbortController();
    const run = runPoolDepositEvm(hostOf(ch, ns, { signal: stop.signal, wait: () => (stop.abort(), new Promise<void>(() => {})) }), ASK);
    const a = await Promise.race([run, new Promise<"held">((r) => setTimeout(() => r("held"), 5_000))]);
    assert.deepEqual(a, { error: "failed" });
    assert.equal(ch.c.sent.length, 0);
  }
});

// ---- card evm-deposit-route-mainnet (pool-deposit-follow review H1, on EVM): the follow of a pool quote pays from U_X
// alone, the one U^evm_{s,i} the quote named, never the newest landed U or the planned index ----
/** The run's U: each eth_estimateGas names its `from`. */
function fromsOf(ch: ReturnType<typeof chain>) {
  const froms: string[] = [];
  const w = (r: (typeof ch.rpcs)[0]) => async (m: string, p: readonly unknown[]) => {
    if (m === "eth_estimateGas") froms.push(String((p[0] as { from: string }).from));
    return r(m, p);
  };
  return { froms, rpcs: [w(ch.rpcs[0]), w(ch.rpcs[1])] as const };
}
/** U_0 landed a note (the newest used U, funded again) and U_1 is the planned index, funded too. */
async function twoUs() {
  const { ch, ns, planned } = await funded(RUNG + FEE);
  ch.c.onSend = (raw) => ch.land(raw);
  assert.equal("stage" in (await runPoolDepositEvm(hostOf(ch, ns), ASK)) && (await ns.get(planned.id))!.state, "UNSPENT");
  const next = await ns.planDeposit(SCOPE, (ref) => noteSecrets(SEED, ref).precommitment);
  const i1 = (next.ref as { i: number }).i;
  assert.notEqual(i1, (planned.ref as { i: number }).i, "a new planned index");
  const u0 = depositIdEvm(SEED, SCOPE, (planned.ref as { i: number }).i).address, u1 = depositIdEvm(SEED, SCOPE, i1).address;
  ch.c.at.set(u0.toLowerCase(), [RUNG + FEE, RUNG + FEE]);
  ch.c.at.set(u1.toLowerCase(), [RUNG + FEE, RUNG + FEE]);
  return { ch, ns, next, i1, u0, u1 };
}

test("evm-deposit-route-mainnet: a fixed U_{s,i} pays the ask from U_X alone, its planned deposit note; with none given the run pays from the newest landed U", async () => {
  {
    const { ch, ns, u0 } = await twoUs();
    const f = fromsOf(ch);
    const a = await runPoolDepositEvm(hostOf(ch, ns, { rpcs: f.rpcs }), ASK);
    assert.ok("stage" in a && a.stage === "filled", JSON.stringify(a));
    assert.deepEqual([...new Set(f.froms)], [u0], "no source given: the newest landed U");
  }
  const { ch, ns, next, i1, u1 } = await twoUs();
  const f = fromsOf(ch);
  const a = await runPoolDepositEvm(hostOf(ch, ns, { rpcs: f.rpcs }), ASK, undefined, { s: SCOPE, i: i1, u: u1 });
  assert.ok("stage" in a && a.stage === "filled", JSON.stringify(a));
  assert.deepEqual([...new Set(f.froms)], [u1], "the fixed U_X alone");
  assert.equal(sentOf(ch.c.sent.at(-1)!).pre, next.precommitment, "its planned deposit note");
  assert.equal((await ns.get(next.id))!.state, "UNSPENT");
});

test("evm-deposit-route-mainnet: a fixed U_X of another scope, an address that is not U^evm_{s,i}'s, or an index the store never planned signs nothing (not_allowed)", async () => {
  const { ch, ns, i1, u0, u1 } = await twoUs();
  const sent = ch.c.sent.length;
  assert.deepEqual(await runPoolDepositEvm(hostOf(ch, ns), ASK, undefined, { s: SCOPE + 1n, i: i1, u: u1 }), { error: "not_allowed" }, "another scope");
  assert.deepEqual(await runPoolDepositEvm(hostOf(ch, ns), ASK, undefined, { s: SCOPE, i: i1, u: u0 }), { error: "not_allowed" }, "another U's address");
  assert.deepEqual(await runPoolDepositEvm(hostOf(ch, ns), ASK, undefined, { s: SCOPE, i: i1 + 5, u: depositIdEvm(SEED, SCOPE, i1 + 5).address }), { error: "not_allowed" }, "never planned");
  assert.equal(ch.c.sent.length, sent, "nothing sent");
});

test("evm-deposit-route-mainnet: a fixed U_X that cannot pay the rung and its fee is not_funded with its own top-up named, never paid from the newest landed U", async () => {
  const { ch, ns, i1, u0, u1 } = await twoUs();
  ch.c.at.set(u1.toLowerCase(), [RUNG / 2n, RUNG / 2n]);
  const f = fromsOf(ch);
  const shorts: string[] = [];
  const sent = ch.c.sent.length;
  const a = await runPoolDepositEvm(hostOf(ch, ns, { rpcs: f.rpcs, short: (u) => void shorts.push(u) }), ASK, undefined, { s: SCOPE, i: i1, u: u1 });
  assert.deepEqual(a, { error: "not_funded" });
  assert.equal(ch.c.sent.length, sent, "nothing sent");
  assert.ok(!f.froms.includes(u0), "U_0 never priced");
  assert.deepEqual(shorts, [u1], "the top-up names U_X");
});

test("evm-deposit-route-mainnet: the kind takes the fixed source as the Solana kind does (poolDepositEvmKind(host)(ask, ctx, from))", async () => {
  const { ch, ns, i1, u1 } = await twoUs();
  const f = fromsOf(ch);
  const run = poolDepositEvmKind(() => hostOf(ch, ns, { rpcs: f.rpcs }))(ASK, null, { s: SCOPE, i: i1, u: u1 }) as { after: Promise<void>; answer(): unknown };
  await run.after;
  assert.deepEqual([...new Set(f.froms)], [u1]);
});

// card evm-deposit-route-mainnet review: each fixed-source rule held by a test of its own (each fails with its rule taken
// out of runPoolDepositEvm)
test("evm-deposit-route-mainnet review: a fixed U of another scope, its own address and an index this scope planned, signs nothing (the scope rule alone refuses it)", async () => {
  const { ch, ns, i1 } = await twoUs();
  const other = depositIdEvm(SEED, SCOPE + 1n, i1).address;
  ch.c.at.set(other.toLowerCase(), [RUNG + FEE, RUNG + FEE]);
  const f = fromsOf(ch);
  const sent = ch.c.sent.length;
  assert.deepEqual(await runPoolDepositEvm(hostOf(ch, ns, { rpcs: f.rpcs }), ASK, undefined, { s: SCOPE + 1n, i: i1, u: other }), { error: "not_allowed" });
  assert.equal(ch.c.sent.length, sent, "nothing sent");
  assert.deepEqual(f.froms, [], "no U priced");
});

test("evm-deposit-route-mainnet review: a fixed U with a note still landing is read again (not_landed), never sent a second deposit beside it", async () => {
  const { ch, ns, i1, u1 } = await twoUs();
  // U_1's deposit sent, never landing
  ch.c.onSend = () => {};
  const first = await runPoolDepositEvm(hostOf(ch, ns), ASK, undefined, { s: SCOPE, i: i1, u: u1 });
  assert.ok("stage" in first, JSON.stringify(first));
  const sent = ch.c.sent.length;
  assert.ok((await ns.list()).some((n) => n.state === "INCOMING" && n.ref.kind === "deposit" && n.ref.i === i1), "U_1's note landing");
  ch.c.at.set(u1.toLowerCase(), [3n * (RUNG + FEE), 3n * (RUNG + FEE)]);
  const methods: string[] = [];
  const log = (r: (typeof ch.rpcs)[0]) => async (m: string, p: readonly unknown[]) => (methods.push(m), r(m, p));
  assert.deepEqual(await runPoolDepositEvm(hostOf(ch, ns, { rpcs: [log(ch.rpcs[0]), log(ch.rpcs[1])] }), ASK, undefined, { s: SCOPE, i: i1, u: u1 }), { stage: "not_landed", txs: [] });
  assert.equal(ch.c.sent.length, sent, "no second deposit from U_1");
  assert.ok(!methods.includes("eth_getBalance"), "answered from its landing note: U_1's balance never read");
});

test("evm-deposit-route-mainnet review: a short fixed U is not_funded with its own top-up named while another U's deposit is landing (no wait on another U)", async () => {
  const { ch, ns, i1, u0, u1 } = await twoUs();
  // U_0's next deposit sent, never landing: the default path would wait on it
  ch.c.onSend = () => {};
  await runPoolDepositEvm(hostOf(ch, ns), ASK);
  assert.ok((await ns.list()).some((n) => n.state === "INCOMING" && !(n.ref.kind === "deposit" && n.ref.i === i1)), "U_0's note landing");
  // U_0 holds enough that its landing would cover the ask: the default path waits for it (not_landed)
  ch.c.at.set(u0.toLowerCase(), [3n * (RUNG + FEE), 3n * (RUNG + FEE)]);
  ch.c.at.set(u1.toLowerCase(), [RUNG / 2n, RUNG / 2n]);
  const shorts: string[] = [];
  const sent = ch.c.sent.length;
  // every read of the fixed run, to hold it to U_1 alone (one U per request, and no other U at all)
  const named: string[] = [];
  const log = (r: (typeof ch.rpcs)[0]) => async (m: string, p: readonly unknown[]) => (named.push(JSON.stringify(p).toLowerCase()), r(m, p));
  assert.deepEqual(await runPoolDepositEvm(hostOf(ch, ns, { rpcs: [log(ch.rpcs[0]), log(ch.rpcs[1])], short: (u) => void shorts.push(u) }), ASK, undefined, { s: SCOPE, i: i1, u: u1 }), { error: "not_funded" });
  assert.deepEqual(shorts, [u1]);
  assert.equal(ch.c.sent.length, sent);
  assert.ok(!named.some((x) => x.includes(u0.slice(2).toLowerCase())), "no read names U_0");
});

// card evm-money-shows-and-spends-at-once: the run's two reads, and a sign out or a stop around them (on every network
// this file runs on: no chain, pin or L1 fee of its own)
test("evm-money-shows-and-spends-at-once: a send mined only after the run's first read is read again POOL_DEPOSIT_EVM_WAIT_MS later and lands in the run (UNSPENT, filled), not on the next load pass", async () => {
  const { ch, ns, planned } = await funded(RUNG + FEE);
  const waits: number[] = [];
  // the page's own read count (no `reads`): the first read finds no block holding the send, the next one does
  const h = hostOf(ch, ns, { reads: undefined, wait: async (ms) => void (waits.push(ms), ch.c.sent.length === 1 && !ch.c.events.some((e) => e.kind === "deposit") && ch.land(ch.c.sent[0]!)) });
  const a = await runPoolDepositEvm(h, ASK);
  assert.deepEqual(a, { stage: "filled", txs: [{ chain: ASK.chain, hash: sentOf(ch.c.sent[0]!).hash }] });
  assert.equal((await ns.get(planned.id))!.state, "UNSPENT");
  assert.deepEqual(waits, [POOL_DEPOSIT_EVM_WAIT_MS], "one wait between the run's two reads");
  assert.equal(ch.c.sent.length, 1, "never sent again");
});

test("evm-money-shows-and-spends-at-once: a sign out or a stop during the run's own wait between its two reads ends the wait at once: no read and no write after it", async () => {
  for (const k of ["signal", "stop"] as const) {
    const { ch, ns, planned } = await funded(RUNG + FEE);
    const ac = new AbortController();
    let rounds = 0;
    let after = 0;
    // the run's own wait (no `wait`): the first read after the send finds no block holding it; the send lands and the
    // sign out comes 100 ms into the POOL_DEPOSIT_EVM_WAIT_MS wait
    const h = hostOf(ch, ns, { reads: undefined, wait: undefined, [k]: ac.signal, round: async () => {
      if (ac.signal.aborted) after++;
      if (ch.c.sent.length === 1 && rounds++ === 0) {
        const events = [...ch.c.events];
        ch.land(ch.c.sent[0]!);
        setTimeout(() => ac.abort(), 100);
        return { events, finalBlock: ch.c.fin };
      }
      return { events: [...ch.c.events], finalBlock: ch.c.fin };
    } });
    // a run that sits out its wait ends after POOL_DEPOSIT_EVM_WAIT_MS; one that ends at the sign out (100 ms in) wins
    // this race by over a second
    const a = await Promise.race([runPoolDepositEvm(h, ASK), settleMs((POOL_DEPOSIT_EVM_WAIT_MS * 3) / 4).then(() => "sat out the wait" as const)]);
    assert.notEqual(a, "sat out the wait", `${k}: the wait ended at the sign out`);
    assert.equal((a as { stage?: string }).stage, "sent", k);
    assert.equal(after, 0, `${k}: no read after the sign out`);
    assert.equal((await ns.get(planned.id))!.state, "INCOMING", `${k}: nothing written after the sign out`);
  }
});

test("evm-money-shows-and-spends-at-once: a sign out while the second read's round is in hand writes nothing: the note stays INCOMING for the next sign in", async () => {
  const { ch, ns, planned } = await funded(RUNG + FEE);
  const ac = new AbortController();
  let rounds = 0;
  const h = hostOf(ch, ns, { reads: undefined, signal: ac.signal, wait: async () => void ch.land(ch.c.sent[0]!), round: async () => {
    if (ch.c.sent.length === 1 && rounds++ === 1) ac.abort(); // the second read's round: the sign out lands meanwhile
    return { events: [...ch.c.events], finalBlock: ch.c.fin };
  } });
  const a = await runPoolDepositEvm(h, ASK);
  assert.equal((a as { stage?: string }).stage, "sent");
  assert.equal(rounds, 2);
  assert.equal((await ns.get(planned.id))!.state, "INCOMING", "no landing written after the sign out");
});

test("evm-money-shows-and-spends-at-once: a round that fails right after the send (logs behind the pool's state at the newest block) is read again POOL_DEPOSIT_EVM_WAIT_MS later, and the note lands in the run", async () => {
  const { ch, ns, planned } = await funded(RUNG + FEE);
  ch.c.onSend = (raw) => ch.land(raw);
  let failed = 0;
  // the first round after the send fails as the sync refuses a lagging read (its logs 0 leaves, the pool's state 1)
  const h = hostOf(ch, ns, { reads: undefined, round: async () => {
    if (ch.c.sent.length === 1 && failed++ === 0) throw new Error("the state tree from the logs (0 leaves) is not the pool's");
    return { events: [...ch.c.events], finalBlock: ch.c.fin };
  } });
  const a = await runPoolDepositEvm(h, ASK);
  assert.deepEqual(a, { stage: "filled", txs: [{ chain: ASK.chain, hash: sentOf(ch.c.sent[0]!).hash }] });
  assert.equal((await ns.get(planned.id))!.state, "UNSPENT");
  assert.equal(ch.c.sent.length, 1, "never sent again");
  // after a sign out or a stop, that failed read ends the run at once: "sent", never read again, no wait
  for (const k of ["signal", "stop"] as const) {
    const t = await funded(RUNG + FEE);
    t.ch.c.onSend = (raw) => t.ch.land(raw);
    const ac = new AbortController();
    let waits = 0;
    const g = hostOf(t.ch, t.ns, { reads: undefined, [k]: ac.signal, wait: async () => void waits++, round: async () => {
      if (t.ch.c.sent.length === 1) (ac.abort(), (() => { throw new Error("the state tree from the logs (0 leaves) is not the pool's"); })());
      return { events: [...t.ch.c.events], finalBlock: t.ch.c.fin };
    } });
    const b = await runPoolDepositEvm(g, ASK);
    assert.equal((b as { stage?: string }).stage, "sent", k);
    assert.equal(waits, 0, `${k}: no wait for a read again`);
  }
});
