// node --test packages/wallet/test/pool-evm-releases.test.ts: W's releases at a sell (card evm-sell-no-release-in-flight,
// audit E-01; src/pool/evm-releases.ts). The pool's round is planted as evmTreeSync's events() gives it (a finalized
// anchor and the leaf events up to the newest agreed block); the store's notes as its list() gives them. Test seed only:
// the all-zero entropy of vectors/a8.json; never money.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as d from "../src/derive/index.ts";
import { noteSecrets, type NoteRef } from "../src/notes/secrets.ts";
import { refKey, type NoteRecord, type NoteState } from "../src/notes/store.ts";
import { evmPoolScopeOf, type EvmPoolEvent } from "../src/pool/evm.ts";
import { evmReadSellReleases, evmSellReleasesOf, type EvmReleaseRound } from "../src/pool/evm-releases.ts";
import { jOf } from "../src/pool/queue.ts";

const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const SCOPE = evmPoolScopeOf("0x00000000000000000000000000000000b1f1f001", 84532n);
const L = 77n;
const NOTE: NoteRef = { kind: "change", l: L, j: 2 };
const OTHER_NOTE: NoteRef = { kind: "change", l: L, j: 5 };
const wOf = (ref: NoteRef): string => {
  const k = d.freshWallet(SEED, "evm", L, jOf(ref));
  k.secretKey.fill(0);
  return k.address;
};
const W = wOf(NOTE);
const NUL = noteSecrets(SEED, NOTE).nullifierHash;
// the round's finalized anchor: block 100 at 1,000 s
const FIN = { number: 100n, timestamp: 1_000n };

const note = (ref: NoteRef, state: NoteState, deadlineMs = 2_000_000n, scope = SCOPE): NoteRecord =>
  ({ id: refKey(ref), ref, scope, precommitment: 1n, state, leaf: { value: 10n ** 15n, label: L, commitment: 3n, leafIndex: 0n }, deadlineMs }) as NoteRecord;
const release = (block: bigint, recipient: string, nullifier: bigint, kind: "withdraw" | "buy" = "withdraw"): EvmPoolEvent => ({
  block, blockHash: `0x${"ab".repeat(32)}`, logIndex: 0n, bytes: "", kind, state: 5n, label: null, value: 10n ** 15n, precommitment: null, nullifier, recipient: recipient.toLowerCase(), token: kind === "buy" ? "0x" + "77".repeat(20) : null,
});
const deposit: EvmPoolEvent = { block: 150n, blockHash: `0x${"ab".repeat(32)}`, logIndex: 1n, bytes: "", kind: "deposit", state: 6n, label: 9n, value: 10n ** 15n, precommitment: 8n, nullifier: null, recipient: null, token: null };
const round = (events: EvmPoolEvent[]): EvmReleaseRound => ({ fin: FIN, events });
const of = (notes: NoteRecord[], events: EvmPoolEvent[]) => evmSellReleasesOf(SEED, "base-sepolia", SCOPE, W, notes, round(events)).pending;

test("a release W's note sent that has not landed is pending until a final block's time passes its deadline", () => {
  assert.deepEqual(of([note(NOTE, "RESERVED", 1_000_000n)], [deposit]), [{ note: refKey(NOTE), deadlineMs: 1_000_000n }]);
  assert.deepEqual(of([note(NOTE, "RESERVED", 5_000_000n)], []), [{ note: refKey(NOTE), deadlineMs: 5_000_000n }]);
  // the finalized block's time (1,000,000 ms) is past it: it can never land
  assert.deepEqual(of([note(NOTE, "RESERVED", 999_999n)], []), []);
});

test("a release that landed on W is pending while its block is above the finalized one, a withdraw and a buy's alike, and final at or below it", () => {
  assert.deepEqual(of([note(NOTE, "RESERVED")], [release(101n, W, NUL)]), [{ note: refKey(NOTE), landed: 101n }]);
  assert.deepEqual(of([], [release(140n, W, 4n, "buy")]), [{ note: null, landed: 140n }]);
  assert.deepEqual(of([note(NOTE, "RESERVED")], [release(100n, W, NUL)]), []);
  assert.deepEqual(of([], [release(60n, W, 4n)]), []);
});

test("only this pool's notes whose proof left the device and that pay this W count", () => {
  // HELD: its proof never left; SPENT and UNSPENT: no proof of it on its way; another W's note; another pool's
  for (const n of [note(NOTE, "HELD"), note(NOTE, "SPENT"), note(NOTE, "UNSPENT"), note(OTHER_NOTE, "RESERVED"), note(NOTE, "RESERVED", 2_000_000n, SCOPE + 1n)]) assert.deepEqual(of([n], []), [], `${n.state} ${refKey(n.ref)}`);
  // a release in the tail paid to another address moves no ETH onto W
  assert.deepEqual(of([], [release(150n, wOf(OTHER_NOTE), 4n)]), []);
  // W named in any case
  assert.deepEqual(evmSellReleasesOf(SEED, "base-sepolia", SCOPE, W.toUpperCase().replace("0X", "0x"), [note(NOTE, "RESERVED")], round([])).pending, [{ note: refKey(NOTE), deadlineMs: 2_000_000n }]);
});

test("a RESERVED note without its leaf or deadline is refused, never passed over", () => {
  const n = note(NOTE, "RESERVED");
  delete (n as { deadlineMs?: bigint }).deadlineMs;
  assert.throws(() => of([n], []), /a RESERVED note holds its leaf and its deadline/);
});

test("evmReadSellReleases lists the notes before the round is read, on the pool's own events()", async () => {
  const calls: string[] = [];
  const v = await evmReadSellReleases({
    seed64: SEED,
    chain: "base-sepolia",
    scope: SCOPE,
    w: W,
    notes: { list: async () => (calls.push("list"), [note(NOTE, "RESERVED")]) },
    sync: { events: async () => (calls.push("events"), { ...round([release(120n, W, NUL)]), anchor: { number: 130n, hash: "0x", timestamp: 1_100n, baseFeePerGas: null } }) as never },
  });
  assert.deepEqual(calls, ["list", "events"]);
  assert.equal(v.chain, "base-sepolia");
  assert.equal(v.w, W.toLowerCase());
  assert.equal(v.finalBlock, 100n);
  assert.deepEqual(v.pending, [{ note: refKey(NOTE), landed: 120n }]);
});
