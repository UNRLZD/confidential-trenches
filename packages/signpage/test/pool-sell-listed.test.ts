// Card pool-sell-legs-side-by-side: a sale lists its Ws with no read at the tap. The sell host (src/pool-testnet.ts
// sellHost's wallets) derives every W the pool's spent notes paid from the seed, each with the tokens the last whole
// positions pass listed it holding; the plan (src/pool-sell.ts planReads) reads each W a buy record or that listing
// names for the token, in a getMultipleAccounts of W's four accounts of its own on each provider. No whole pass kept
// yet: the finder's read, as before. On a fake chain, the published all-zero seed (a8.json's kind): no key of anyone's.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { base58, base64 } from "@scure/base";
import { IDBFactory } from "fake-indexeddb";
import { entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import { SOLANA_TOKEN_2022_PROGRAM, SOLANA_TOKEN_PROGRAM } from "../../kit/src/checks/solana/checks.ts";
import { solanaAta } from "../../kit/src/checks/solana/message.ts";
import { noteCommitment, noteSecrets } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore } from "../../wallet/src/notes/store.ts";
import type { HoldingsReader } from "../../wallet/src/pool/buy-wallets.ts";
import { solanaPoolOf } from "../../wallet/src/pool/solana.ts";
import { freshWallet } from "../../wallet/src/derive/keys.ts";
import { jOf } from "../../wallet/src/pool/queue.ts";
import { POSITIONS_KEPT_KEY } from "../src/positions.ts";
import { testnetPool } from "../src/pool-testnet.ts";
import { BUY_MINTS_KEY, planPoolSell } from "../src/pool-sell.ts";

const SEED64 = wordsToSeed64(entropyToWords(new Uint8Array(16)));
const PIN = { program: "9Z6Yi2VcXkFWgAV6Nb6kMei78vAAVUEMTqzvFiUZcvG8", feePayer: "9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb" };
const SCOPE = solanaPoolOf(PIN.program).scope;
const MINT = "So11111111111111111111111111111111111111112";
const MINT2 = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const closers: (() => void)[] = [];
after(() => closers.forEach((f) => f()));

async function spentWallet(n: number): Promise<WalletStore> {
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
const wOf = (i: number): string => {
  const fw = freshWallet(SEED64, "sol", BigInt(77 + i), jOf({ kind: "deposit", s: SCOPE, i }));
  fw.secretKey.fill(0);
  return fw.address;
};
/** An SPL token account of `mint` owned by `owner` holding `amount`, initialized. */
const tokenAccount = (mint: string, owner: string, amount: bigint): string => {
  const d = new Uint8Array(165);
  d.set(base58.decode(mint), 0);
  d.set(base58.decode(owner), 32);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  d[108] = 1;
  return base64.encode(d);
};

/** Both providers: the mint under `program`; each W's four accounts (its ATA under `program` holding `held`'s amount,
 *  W, its two volume accounts: none). Every getMultipleAccounts is checked to name one W, and each W named is kept. */
function chain(ws: readonly string[], held: ReadonlyMap<string, bigint>, program = SOLANA_TOKEN_PROGRAM) {
  const ataOf = new Map(ws.map((w) => [solanaAta(w, MINT, program), w] as const));
  const named: [Set<string>, Set<string>] = [new Set(), new Set()];
  const calls: [string[], string[]] = [[], []];
  const open = { now: 0, most: 0 };
  const rpc = (k: number) => async (method: string, params: readonly unknown[]): Promise<unknown> => {
    calls[k]!.push(method);
    if (method === "getAccountInfo") {
      assert.equal(params[0], MINT, "the only lone account read is the mint");
      return { context: { slot: 10 }, value: { owner: program, lamports: 1, data: [base64.encode(new Uint8Array(82)), "base64"] } };
    }
    assert.equal(method, "getMultipleAccounts");
    const keys = params[0] as string[];
    const theirs = new Set(keys.map((a) => ataOf.get(a) ?? (ws.includes(a) ? a : null)).filter((x): x is string => x !== null));
    assert.equal(theirs.size, 1, "a request names one W of the user's at most");
    const w = [...theirs][0]!;
    assert.equal(keys[1], w);
    named[k]!.add(w);
    open.now++;
    open.most = Math.max(open.most, open.now);
    await new Promise((r) => setTimeout(r, 1));
    open.now--;
    const amount = held.get(w) ?? 0n;
    return { context: { slot: 10 }, value: keys.map((a, i) => (i === 0 && amount > 0n ? { owner: program, lamports: 2_039_280, data: [tokenAccount(MINT, w, amount), "base64"] } : i === 1 ? { owner: "11111111111111111111111111111111", lamports: 50_000_000, data: ["", "base64"] } : null)) };
  };
  return { rpcs: [rpc(0), rpc(1)] as const, named, calls, open };
}

/** The page's sell host on `w` (the sell kind's own, taken when a sell is asked), with a finder that counts its reads. */
async function sellHostOf(w: WalletStore, c: ReturnType<typeof chain>, finderHeld: ReadonlyMap<string, bigint> = new Map()) {
  const finder = { reads: 0 };
  const reader: HoldingsReader = { chain: "sol", read: async (address) => (finder.reads++, { native: 0n, tokens: new Map((finderHeld.get(address) ?? 0n) > 0n ? [[MINT, { amount: finderHeld.get(address)!, frozen: false }]] : []), unreadable: [] }) };
  let host: unknown = null;
  const sell = (make: () => unknown) => () => {
    host = make();
    return { running: true as const, after: new Promise<void>(() => {}), answer: () => ({ result: { stage: "sent", txs: [] } }) };
  };
  const tp = testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { pin: PIN, rpcs: c.rpcs, holdings: () => reader, tradeKinds: { sell }, positions: { setTimer: () => 0, clearTimer: () => {} } } as never);
  tp.flow({ kind: "pool.sell", chain: "solana", token: MINT, amount: 1n, slippageBps: 100, decimals: 6 }, { id: "s", sha: "00", progress: () => {} } as never);
  for (let i = 0; i < 200 && host === null; i++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(host !== null);
  return { host: host as Parameters<typeof planPoolSell>[0] & { end(): void }, finder };
}
const ALL = { kind: "pool.sell", chain: "solana", token: MINT, amount: 0n, shareBps: 10_000, slippageBps: 100, decimals: 6 } as const;
const kept = (listed: Record<string, bigint>) => ({ positions: [], held: Object.fromEntries(Object.entries(listed).map(([k, a]) => [`${k} ${MINT}`, a.toString()])), listed: Object.keys(listed).map((k) => `${k} ${MINT}`) });

test("with a whole pass kept: no finder read; the Ws a buy record or the pass names for the token, each in a request of its own on each provider; no other W named to either", async () => {
  const w = await spentWallet(4);
  const [w0, w1, w2, w3] = [0, 1, 2, 3].map(wOf) as [string, string, string, string];
  await w.update("meta", BUY_MINTS_KEY, () => ({ [w0]: { mint: MINT, program: SOLANA_TOKEN_PROGRAM }, [w1]: { mint: MINT2, program: SOLANA_TOKEN_PROGRAM } }));
  await w.put("meta", POSITIONS_KEPT_KEY, kept({ [w2]: 7n }));
  const c = chain([w0, w1, w2, w3], new Map([[w0, 5n], [w2, 7n]]));
  const { host, finder } = await sellHostOf(w, c);
  const plan = await planPoolSell(host, ALL);
  host.end();
  assert.equal(finder.reads, 0, "no finder read at the tap");
  assert.equal(plan.total, 12n);
  assert.deepEqual(plan.legs.map((l) => l.w.address).sort(), [w0, w2].sort());
  for (const k of [0, 1] as const) assert.deepEqual([...c.named[k]].sort(), [w0, w2].sort(), "W1 (another mint's buy) and W3 (nothing) are never named");
  assert.equal(c.calls[0].filter((m) => m === "getMultipleAccounts").length, 2, "one request per W on provider A");
  assert.ok(!c.calls[0].includes("getTokenAccountsByOwner") && !c.calls[0].includes("getBalance"));
});

test("a W the pass listed that holds none now costs no leg and no error", async () => {
  const w = await spentWallet(2);
  const [w0, w1] = [wOf(0), wOf(1)];
  await w.update("meta", BUY_MINTS_KEY, () => ({ [w0]: { mint: MINT, program: SOLANA_TOKEN_PROGRAM } }));
  await w.put("meta", POSITIONS_KEPT_KEY, kept({ [w1]: 9n }));
  const c = chain([w0, w1], new Map([[w0, 5n]]));
  const { host } = await sellHostOf(w, c);
  const plan = await planPoolSell(host, ALL);
  host.end();
  assert.deepEqual(plan.legs.map((l) => l.w.address), [w0]);
  assert.equal(plan.total, 5n);
});

test("a Token-2022 mint: W's account under that program is found (no buy record names the program)", async () => {
  const w = await spentWallet(1);
  const w0 = wOf(0);
  await w.put("meta", POSITIONS_KEPT_KEY, kept({ [w0]: 3n }));
  const c = chain([w0], new Map([[w0, 3n]]), SOLANA_TOKEN_2022_PROGRAM);
  const { host } = await sellHostOf(w, c);
  const plan = await planPoolSell(host, ALL);
  host.end();
  assert.equal(plan.total, 3n);
  assert.equal(plan.legs[0]!.w.address, w0);
});

test("a restored device (no buy record): with a whole pass kept the pass lists the Ws; with none yet, the finder does, and the sale is the same", async () => {
  for (const pass of [true, false]) {
    const w = await spentWallet(2);
    const [w0, w1] = [wOf(0), wOf(1)];
    if (pass) await w.put("meta", POSITIONS_KEPT_KEY, kept({ [w1]: 4n }));
    const c = chain([w0, w1], new Map([[w1, 4n]]));
    const { host, finder } = await sellHostOf(w, c, new Map([[w1, 4n]]));
    const plan = await planPoolSell(host, ALL);
    host.end();
    assert.deepEqual(plan.legs.map((l) => l.w.address), [w1], `pass kept: ${pass}`);
    assert.equal(finder.reads, pass ? 0 : 2, "the finder only when no pass is kept");
    assert.deepEqual([...c.named[0]], [w1]);
  }
});

test("thirty Ws listed: thirty requests on each provider, each naming one W, all asked at once", async () => {
  const N = 30;
  const w = await spentWallet(N);
  const ws = Array.from({ length: N }, (_, i) => wOf(i));
  await w.update("meta", BUY_MINTS_KEY, () => Object.fromEntries(ws.map((a) => [a, { mint: MINT, program: SOLANA_TOKEN_PROGRAM }])));
  await w.put("meta", POSITIONS_KEPT_KEY, kept({}));
  const c = chain(ws, new Map(ws.map((a, i) => [a, BigInt(i + 1)])));
  const { host } = await sellHostOf(w, c);
  const plan = await planPoolSell(host, ALL);
  host.end();
  assert.equal(plan.total, BigInt((N * (N + 1)) / 2));
  for (const k of [0, 1] as const) {
    assert.equal(c.calls[k].filter((m) => m === "getMultipleAccounts").length, N);
    assert.equal(c.named[k].size, N);
  }
  assert.equal(c.open.most, 2 * N, "every W's request in flight at once, on both providers");
});
