// Card sign-out-stops-the-pages-reads: a sign out tapped while a money run holds the seed lock lets that run finish.
// The tap is modelled as src/main.ts signOut runs it: the pool flow's stops (testnet.signingOut()), then the store's
// sign out, whose `locked` closes the page's one gate (closeHostLanes) once it holds the seed lock exclusive. Each run
// is the testnet page's own (src/pool-testnet.ts testnetPool) on its own transport: every RPC call a laned one
// (src/page-rpc.ts lanedRpc), every helper call through laneFetch, and the page's fetch the gate's (gatedFetch), over a
// stub that answers as a fake chain and helper. Each case records the order of the run's sends, the tap, the run's
// release of the seed lock and the gate's close. On a tree where the tap itself closed the gate (stopHostLaneWaits
// before the store's sign out, no closeHostLanes), the same cases run that tap, and the run is cut at its next read.
// No network: fetch is stubbed, every RPC host is .example, the helper's origin is answered by the stub alone.
//   node --test test/sign-out-mid-run.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { entropyToWords, freshWallet, wordsToSeed64 } from "../../wallet/src/derive/keys.ts";
import { WALLET_SEED_LOCK, openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import { openNoteStore } from "../../wallet/src/notes/store.ts";
import { noteCommitment, noteSecrets } from "../../wallet/src/notes/secrets.ts";
import { jOf } from "../../wallet/src/pool/queue.ts";
import { VaultTree } from "../../kit/src/vault/inputs.ts";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { evmPoolChainFee } from "../../kit/src/trade/evm/pool-fee.ts";
import { evmPoolVenues } from "../../kit/src/trade/evm/buy-unpinned.ts";
import { signalsProver } from "../../wallet/test/withdraw-fixture.ts";
import * as lanes from "../../wallet/src/throttle.ts";

(globalThis as { __SIGN_NETWORK__?: string }).__SIGN_NETWORK__ = "testnet";
// loaded after the network is set (a static import would load the wallet's network module first, as mainnet)
const { testnetPool } = await import("../src/pool-testnet.ts");
const { lanedRpc } = await import("../src/page-rpc.ts");
const { TRADE_HELPER } = await import("../src/trade.ts");
const { evmPoolContextOf, evmPoolScopeOf } = await import("../../wallet/src/pool/evm.ts");
const { EVM_ONWARD_GAS } = await import("../src/rules/pool.ts");
const { EVM_ONWARD_L1_BYTES, EVM_ONWARD_TIP } = await import("../src/pool-withdraw-evm.ts");
type EvmPoolRequest = import("../../wallet/src/pool/evm.ts").EvmPoolRequest;
type EvmRelayData = import("../../wallet/src/pool/evm.ts").EvmRelayData;
type EvmPendingOnward = import("../src/pool-withdraw-evm.ts").EvmPendingOnward;
type Pool = import("../../wallet/src/pool/pool.ts").Pool<EvmPoolRequest>;

const OWN = "https://sign.example";
const SEED = wordsToSeed64(entropyToWords(new Uint8Array(16))); // the published all-zero entropy vector (a8.json)
const closers: (() => void)[] = [];
after(() => closers.forEach((f) => f()));

// ---------- the page's transport over a stub ----------

type Handler = (method: string, params: unknown[]) => unknown;
type Helper = (path: string, body: unknown) => Promise<{ status: number; json: unknown }>;
/** The fetch under the page's gate: each RPC host's JSON-RPC answered by its fake, the helper's origin by `helper`;
 *  any other request is refused here (none leaves the process). */
function stubFetch(rpcs: Record<string, Handler>, helper: Helper): typeof fetch {
  const helperOrigin = new URL(TRADE_HELPER).origin;
  return (async (u: string | URL | Request, init?: RequestInit) => {
    const url = new URL(u instanceof Request ? u.url : String(u));
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.origin === helperOrigin) {
      const got = await helper(url.pathname, init?.body === undefined ? null : JSON.parse(String(init.body)));
      return json(got.status, got.json);
    }
    const rpc = rpcs[url.host];
    if (rpc === undefined) throw new Error(`no stub for ${url.host}`);
    const { id, method, params } = JSON.parse(String(init?.body)) as { id: unknown; method: string; params?: unknown[] };
    try {
      return json(200, { jsonrpc: "2.0", id, result: await rpc(method, params ?? []) });
    } catch (e) {
      return json(200, { jsonrpc: "2.0", id, error: { code: -32000, message: String((e as Error)?.message ?? e) } });
    }
  }) as typeof fetch;
}
/** globalThis.fetch as src/main.ts installs it (the gate over the stub) for one case, every lane forgotten before and after. */
async function onPageFetch(raw: typeof fetch, run: () => Promise<void>): Promise<void> {
  const was = globalThis.fetch;
  lanes.resetHostLanes();
  globalThis.fetch = lanes.gatedFetch(raw, OWN);
  try {
    await run();
  } finally {
    globalThis.fetch = was;
    lanes.resetHostLanes();
  }
}

/** Web Locks as the page's (navigator.locks), every shared hold of the seed lock counted: `held` while a run holds it, and
 *  each release logged. */
function seedLocks(log: string[]) {
  let freed!: () => void;
  const st = { held: 0, released: new Promise<void>((r) => (freed = r)) };
  const L = navigator.locks;
  const request = (name: string, a: LockOptions | LockGrantedCallback<unknown>, b?: LockGrantedCallback<unknown>): Promise<unknown> => {
    const [opts, cb] = typeof a === "function" ? [{} as LockOptions, a] : [a, b!];
    if (name !== WALLET_SEED_LOCK || opts.mode !== "shared") return L.request(name, opts, cb);
    return L.request(name, opts, async (lock) => {
      if (lock !== null) st.held++;
      try {
        return await cb(lock);
      } finally {
        if (lock !== null) st.held--, log.push("run lock released"), freed();
      }
    });
  };
  return { st, locks: { request, query: () => L.query() } as unknown as Pick<LockManager, "request" | "query"> };
}

// The tap, as src/main.ts signOut runs it on this tree: the pool flow's stops, then the store's sign out, the gate
// closed once it holds the seed lock. On a tree with no closeHostLanes (the design before), main.ts's tap closed the
// gate itself first (stopHostLaneWaits), then the same stops and the store's sign out.
const closeLanes = (lanes as Record<string, unknown>).closeHostLanes as (() => void) | undefined;
function tapSignOut(pool: { signingOut(): void }, store: WalletStore, log: string[], st: { held: number }): Promise<void> {
  log.push("tap");
  const close = (): void => void log.push(`gate closed, ${st.held} held`);
  if (closeLanes === undefined) {
    lanes.stopHostLaneWaits();
    close();
    pool.signingOut();
    return store.signOut();
  }
  pool.signingOut();
  return store.signOut({ locked: () => (close(), closeLanes()) });
}
const before = (log: readonly string[], a: string, b: string): boolean => log.indexOf(a) >= 0 && log.indexOf(b) > log.indexOf(a);

// ---------- 1. an EVM pool withdraw: the release, then W's send ----------

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const q = (v: bigint) => "0x" + v.toString(16);
const word = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");
const lower = (s: string) => s.toLowerCase();
const rawHash = (r: string) => "0x" + hex(keccak_256(Uint8Array.from(Buffer.from(r.slice(2), "hex"))));
// Base Sepolia's pool as the kit's venues name it, so the rule's venue check is the page's own
const EVM_POOL = evmPoolVenues()["base-sepolia"].pool!;
const FEE_TO = "0x5555555555555555555555555555555555555555";
const EVM_PIN = { network: "base-sepolia", pool: EVM_POOL, feeRecipient: FEE_TO, fromBlock: 1n } as const;
const EVM_SCOPE = evmPoolScopeOf(EVM_POOL, 84532n);
const TO = "0x1111111111111111111111111111111111111111";
const REL = "0x" + "ab".repeat(32);
const PART = 10n ** 14n;
const EVM_FEE = 20_000_000_000_000n;
const BASE_FEE = 10_000_000n;
const NOW = 1_800_000_000_000n;
const EVM_WFEE = EVM_ONWARD_GAS * (2n * BASE_FEE + EVM_ONWARD_TIP) + evmPoolChainFee("base-sepolia", EVM_ONWARD_L1_BYTES, [900n, 0n]);

/** One landed EVM note (a deposit's, 0.001 ETH), the pool's trees and bind, and a chain over two RPC hosts and the
 *  helper's send, as test/pool-withdraw-evm.test.ts runWorld has them. */
async function evmWorld(log: string[]) {
  const ws = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => ws.close());
  await ws.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
  const notes = await openNoteStore(ws);
  const value = 10n ** 15n;
  const planned = await notes.planDeposit(EVM_SCOPE, (r) => noteSecrets(SEED, r).precommitment);
  const inc = await notes.move(planned.id, "PLANNED", "INCOMING", { send: { signature: "5".repeat(87), value, last_valid_block_height: 1_000n } });
  const label = vaultLabelOf(keccak_256, EVM_SCOPE, 1n);
  await notes.move(inc.id, "INCOMING", "UNSPENT", { leaf: { value, label, commitment: noteCommitment(value, label, inc.precommitment), leafIndex: 0n } });
  notes.close();
  const w = freshWallet(SEED, "evm", label, jOf(inc.ref)).address;
  const nullifier = noteSecrets(SEED, inc.ref).nullifierHash;
  const leaf = noteCommitment(value, label, noteSecrets(SEED, inc.ref).precommitment);
  const clock = { ms: NOW };
  const chain = { logs: [] as unknown[], balance: 0n, sent: [] as string[], binds: [] as bigint[], releases: 0 };
  const pool = {
    id: `evm:${EVM_POOL}`, chain: "evm", scope: EVM_SCOPE, ladder: [], epochMs: 60_000n, lifeMs: 210_000n, sendMarginMs: 30_000n,
    now: async () => clock.ms,
    trees: async () => {
      const st = new VaultTree([leaf]), lt = new VaultTree([label]);
      return { stateTree: st, labelTree: lt, stateRoot: st.root!, labelRoot: lt.root! };
    },
    bind: async (b: { chunk: bigint; wallet: { address: string }; refundPrecommitment: bigint; deadlineMs: bigint }) => {
      const relay: EvmRelayData = { recipient: b.wallet.address, feeRecipient: FEE_TO, feeCap: EVM_FEE, deadlineMs: b.deadlineMs, refundPrecommitment: b.refundPrecommitment, salt: "0x" + (chain.binds.length + 1).toString(16).padStart(32, "0") };
      chain.binds.push(b.chunk);
      const request: EvmPoolRequest = { processooor: EVM_POOL, relay };
      return { context: evmPoolContextOf(request, EVM_SCOPE), feeCap: EVM_FEE, request };
    },
  } as unknown as Pool;
  const topic = "0x" + hex(keccak_256(new TextEncoder().encode("Withdrawn(address,address,uint256,uint256,uint256,uint256)")));
  // what happens at each call: the test's tap goes in here
  const on = { logsRead: (): void => {}, wSend: async (_raw: string): Promise<void> => {}, release: async (): Promise<void> => {} };
  const rpc = (method: string, params: unknown[]): unknown => {
    if (method === "eth_blockNumber") return q(0x100n);
    if (method === "eth_getBlockByNumber") {
      const at = typeof params[0] === "string" && params[0].startsWith("0x") ? BigInt(params[0]) : 0x100n;
      return { number: q(at), hash: "0x" + "be".repeat(32), timestamp: q((NOW + 600_000n) / 1000n), baseFeePerGas: q(BASE_FEE) };
    }
    if (method === "eth_getLogs") return (on.logsRead(), chain.logs);
    if (method === "eth_getBalance") return q(lower(String(params[0])) === lower(w) ? chain.balance : 0n);
    if (method === "eth_getCode") return "0x";
    if (method === "eth_estimateGas") return q(EVM_ONWARD_GAS);
    if (method === "eth_call") {
      const c = params[0] as { to: string; data?: string };
      if (lower(c.to) === "0x420000000000000000000000000000000000000f") return word(c.data!.startsWith("0xf1c7a58b") ? 900n : 0n);
      return "0x";
    }
    if (method === "eth_getTransactionCount") return q(chain.sent.length > 0 ? 1n : 0n);
    if (method === "eth_getTransactionReceipt") return chain.sent.some((r) => rawHash(r) === params[0]) ? { status: "0x1", from: w, to: TO, blockHash: "0x" + "ee".repeat(32), blockNumber: q(0x100n) } : null;
    if (method === "eth_getTransactionByHash") return { value: q(PART) };
    throw new Error(`no ${method}`);
  };
  const seen = new Set<string>();
  const rpcs: Record<string, Handler> = {
    "base-a.example": rpc,
    "base-b.example": async (method, params) => {
      // W's send goes to both RPCs: the chain takes it once
      if (method === "eth_sendRawTransaction") {
        const raw = String(params[0]);
        if (!seen.has(raw)) {
          seen.add(raw);
          await on.wSend(raw);
          chain.sent.push(raw), log.push("W sent");
        }
        return rawHash(raw);
      }
      return rpc(method, params);
    },
  };
  const a = rpcs["base-a.example"]!;
  rpcs["base-a.example"] = (method, params) => (method === "eth_sendRawTransaction" ? rpcs["base-b.example"]!(method, params) : a(method, params));
  const helper: Helper = async (path) => {
    if (path !== "/v1/pool/evm/send") return { status: 404, json: { error: { code: "not_found" } } };
    await on.release();
    chain.releases++;
    const chunk = chain.binds.at(-1)!;
    const data = "0x" + [BigInt(FEE_TO), chunk, EVM_FEE, nullifier, 1n].map((v) => v.toString(16).padStart(64, "0")).join("");
    chain.logs = [{ address: EVM_POOL, topics: [topic, word(BigInt(w))], data, blockNumber: q(0x100n), logIndex: "0x0", transactionHash: REL, blockHash: "0x" + "bb".repeat(32) }];
    chain.balance = chunk - EVM_FEE;
    log.push("release sent");
    return { status: 200, json: { hash: REL } };
  };
  const pair = () => [lanedRpc("https://base-a.example"), lanedRpc("https://base-b.example")] as const;
  return { ws, w, chain, clock, on, pool, raw: stubFetch(rpcs, helper), pair };
}

test("an EVM pool withdraw with a sign out tapped after its release, before W's send: both are sent, W's send kept before it leaves, and the gate closes only once the run let the seed lock go", { timeout: 30_000 }, async () => {
  const log: string[] = [];
  const world = await evmWorld(log);
  await onPageFetch(world.raw, async () => {
    const { st, locks } = seedLocks(log);
    const opId = "wd-evm-1";
    const tp = testnetPool(
      { store: async () => world.ws, seed64: async () => SEED.slice() },
      {
        pin: null,
        prover: { vault: signalsProver(), stop: () => {} },
        locks,
        evmPin: (c) => (c === "base" ? EVM_PIN : undefined),
        evmRpcs: (c) => (c === "base" ? world.pair() : null),
        evmSync: () => ({ events: async () => Promise.reject(new Error("no sync read here")) }),
        evmQueuePool: () => world.pool as never,
        now: () => world.clock.ms,
        wait: async (ms) => void (world.clock.ms += BigInt(ms)),
      },
    );
    // the owed send at the release, and W's send's hash kept before W's send leaves (meta/owed/<op id>,
    // src/pool-testnet.ts owedKey)
    const owedAt: { release?: unknown; wSend?: EvmPendingOnward } = {};
    world.on.release = async () => void (owedAt.release = await world.ws.get("meta", `owed/${opId}`));
    world.on.wSend = async (raw) => {
      const rec = (await world.ws.get("meta", `owed/${opId}`)) as Record<string, EvmPendingOnward> | undefined;
      owedAt.wSend = Object.values(rec ?? {}).find((p) => p.onward === rawHash(raw) || (p.onwards ?? []).includes(rawHash(raw)));
    };
    // the tap: at the release's first read-back, once the helper took it
    let signedOut: Promise<void> | null = null;
    world.on.logsRead = () => {
      if (signedOut === null && world.chain.releases === 1) signedOut = tapSignOut(tp, world.ws, log, st);
    };
    const run = tp.withdraw({ chain: "base", to: TO, amount: PART, maxFee: EVM_FEE + EVM_WFEE }, opId);
    await run;
    assert.ok(signedOut !== null, "the sign out was tapped mid run");
    await signedOut;
    assert.equal(world.chain.releases, 1, "the release sent");
    assert.equal(world.chain.sent.length, 1, `W's send sent after the tap: ${log.join(", ")}`);
    assert.ok(owedAt.release !== undefined && Object.keys(owedAt.release as object).length === 1, "the part owed before the release left");
    assert.ok(owedAt.wSend !== undefined, "W's send kept before it left");
    assert.ok(before(log, "release sent", "tap") && before(log, "tap", "W sent"), `the tap between the two sends: ${log.join(", ")}`);
    assert.ok(log.includes("gate closed, 0 held"), `the gate closed with no run holding the seed lock: ${log.join(", ")}`);
    assert.ok(before(log, "W sent", "run lock released") && before(log, "run lock released", "gate closed, 0 held"), `the order: ${log.join(", ")}`);
    assert.equal(lanes.hostLanesClosed(), true, "the gate stays closed after the sign out");
  });
});

// ---------- 2 and 3. a Solana pool sell: the sale, then a full sale's rent back (its teardown and its sweep) ----------

const sw = await import("./pool-sell-world.ts");
const { BUY_MINTS_KEY, poolSellKind } = await import("../src/pool-sell.ts");
const { solanaDecodeMessage } = await import("../../kit/src/checks/solana/message.ts");
const { PROGRAM } = await import("../../kit/test/solana-pool-buy-fx.ts");

/** What a Solana transaction is: the sale (the venue's sell and the deposit back), the sweep (the deposit alone) or a
 *  teardown frame (the rest). */
const kindOf = (tx: Uint8Array): "sale" | "sweep" | "teardown" => {
  const m = solanaDecodeMessage(tx.subarray(1 + 64 * tx[0]!));
  const pool = m.instructions.some((x) => m.staticKeys[x.programIndex] === PROGRAM);
  return pool && m.instructions.some((x) => x.data.length === 24) ? "sale" : pool ? "sweep" : "teardown";
};
/** The sell world's chain (test/pool-sell-world.ts) over two RPC hosts, a wallet store holding W's note (RESERVED: its
 *  buy's release left the device) and W's buy record, and every transaction's first send logged by its kind. */
async function sellWorld(log: string[], plant: Parameters<typeof sw.chain>[0] = {}) {
  const c = sw.chain(plant);
  const ws = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => ws.close());
  await ws.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
  const ns = await openNoteStore(ws);
  const ref = { kind: "deposit", s: sw.SCOPE, i: 0 } as const;
  assert.equal(jOf(ref), sw.J, "W's j: the world's");
  const pre = noteSecrets(sw.SEED64, ref).precommitment;
  let n = await ns.add({ ref, scope: sw.SCOPE, precommitment: pre, state: "UNSPENT", leaf: { value: 10_000_000n, label: sw.L, commitment: noteCommitment(10_000_000n, sw.L, pre), leafIndex: 0n } });
  n = await ns.move(n.id, "UNSPENT", "HELD", { deadlineMs: 1_000n, context: "1" });
  await ns.move(n.id, "HELD", "RESERVED", { attempt: n.attempt! });
  ns.close();
  await ws.put("meta", BUY_MINTS_KEY, { [sw.W.address]: { mint: sw.MINT, program: sw.TOKEN_PROGRAM } });
  const on = { sent: async (_kind: string): Promise<void> => {} };
  const seen = new Set<string>();
  const sends: string[] = [];
  const side = (k: 0 | 1): Handler => async (method, params) => {
    if (method === "sendTransaction") {
      const tx = Uint8Array.from(Buffer.from(String(params[0]), "base64"));
      const sig = Buffer.from(tx.subarray(1, 65)).toString("hex");
      if (!seen.has(sig)) {
        seen.add(sig);
        const kind = kindOf(tx);
        sends.push(kind), log.push(`${kind} sent`);
        await on.sent(kind);
      }
    }
    return c.rpcs[k](method, params);
  };
  const raw = stubFetch({ "sol-a.example": side(0), "sol-b.example": side(1) }, async () => ({ status: 404, json: { error: { code: "not_found" } } }));
  const holdings = { chain: "sol", read: async () => ({ native: 0n, tokens: new Map([[sw.MINT, { amount: sw.AMOUNT, frozen: false }]]), unreadable: [] }) };
  return { c, ws, on, sends, raw, holdings };
}
/** The testnet page on the sell world: its pin, the pair as laned RPCs, the sell kind on the recording locks. */
function sellPage(world: Awaited<ReturnType<typeof sellWorld>>, locks: Pick<LockManager, "request" | "query">) {
  return testnetPool(
    { store: async () => world.ws, seed64: async () => sw.SEED64.slice() },
    {
      pin: sw.PIN,
      rpcs: [lanedRpc("https://sol-a.example"), lanedRpc("https://sol-b.example")],
      prover: { vault: signalsProver(), stop: () => {} },
      locks,
      holdings: () => world.holdings,
      positions: { setTimer: () => {}, clearTimer: () => {} },
      tradeKinds: { sell: (mk: Parameters<typeof poolSellKind>[0]) => poolSellKind(mk, locks as never) },
    } as never,
  );
}
type Running = { running: true; after: Promise<void>; answer: () => { result?: { stage: string } } };
const tapSell = (tp: ReturnType<typeof sellPage>, amount: bigint, id: string, stages: string[]) =>
  tp.flow({ kind: "pool.sell", chain: "solana", token: sw.MINT, amount, slippageBps: sw.SLIPPAGE, decimals: 6 }, { id, sha: "00", progress: (s: string) => void stages.push(s), route: () => {} } as never) as unknown as Running;
const settled = async (ok: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 1_500 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ok(), what);
};

test("a full Solana pool sell with a sign out tapped once the sale left: its rent back's teardown and sweep are sent too, W's owed rent back kept until then, and the gate closes only once the run let the seed lock go", { timeout: 30_000 }, async () => {
  const log: string[] = [];
  // W's token account at its rent, as a buy made it: its close gives W enough for the sweep's note (over its floor)
  const world = await sellWorld(log, { ataLamports: Number(sw.rentMin(165)) });
  await onPageFetch(world.raw, async () => {
    const { st, locks } = seedLocks(log);
    const tp = sellPage(world, locks);
    // W's rent back owed (meta owed/rentback-sol, src/pool-sell.ts owedRentBacks) at every send of the run
    const owedAt: Record<string, boolean> = {};
    let signedOut: Promise<void> | null = null;
    world.on.sent = async (kind) => {
      const owed = (await world.ws.get("meta", "owed/rentback-sol")) as Record<string, unknown> | undefined;
      owedAt[kind] = owed !== undefined && Object.hasOwn(owed, sw.W.address);
      // the tap: as the sale leaves
      if (kind === "sale") signedOut = tapSignOut(tp, world.ws, log, st);
    };
    const stages: string[] = [];
    const r = tapSell(tp, sw.AMOUNT, "sell-full-1", stages);
    assert.equal(r.running, true);
    await settled(() => signedOut !== null, "the sign out tapped as the sale left");
    await signedOut;
    assert.deepEqual(world.sends, ["sale", "teardown", "sweep"], `every transaction of the run sent: ${log.join(", ")}`);
    assert.deepEqual([...world.c.txs.values()].map((t) => t.err), [null, null, null], "each landed");
    assert.equal(world.c.accounts.get(sw.W.address), undefined, "W swept to 0: nothing left on W");
    assert.deepEqual(owedAt, { sale: true, teardown: true, sweep: true }, "W's rent back owed at every send, so none leaves unkept");
    assert.deepEqual(stages, ["filled"], "the sale filled");
    assert.ok(before(log, "sale sent", "tap") && before(log, "tap", "teardown sent") && before(log, "teardown sent", "sweep sent"), `the order: ${log.join(", ")}`);
    assert.ok(log.includes("gate closed, 0 held") && before(log, "sweep sent", "run lock released") && before(log, "run lock released", "gate closed, 0 held"), `the gate closed once no run held the seed lock: ${log.join(", ")}`);
  });
});

test("a sign out tapped mid trade (a Solana pool sell, sent) lands right after the trade's end: the trade fills, and the store's sign out resolves once the run let the seed lock go, before any 3 s wait", { timeout: 30_000 }, async () => {
  const log: string[] = [];
  const world = await sellWorld(log);
  await onPageFetch(world.raw, async () => {
    const { st, locks } = seedLocks(log);
    const tp = sellPage(world, locks);
    let signedOut: Promise<void> | null = null;
    // the trade's end bound from the tap: a run cut at the tap reads until its 120 s bound, far past it
    let late!: Promise<"late">;
    world.on.sent = async (kind) => {
      if (kind !== "sale") return;
      signedOut = tapSignOut(tp, world.ws, log, st).then(() => void log.push("signed out"));
      late = new Promise((r) => setTimeout(() => r("late"), 15_000).unref());
    };
    const stages: string[] = [];
    // part of W's holding: one transaction, no rent back
    const r = tapSell(tp, sw.AMOUNT / 2n, "sell-part-1", stages);
    assert.equal(r.running, true);
    await settled(() => signedOut !== null, "the sign out tapped as the sale left");
    // a 3 s timer from the run's release of the seed lock: the sign out lands before it, waiting on no timer of its own
    const soon = st.released.then(() => new Promise<"3 s past the run's end">((r) => setTimeout(() => r("3 s past the run's end"), 3_000).unref()));
    const ended = await Promise.race([signedOut!.then(() => "signed out" as const), late, soon]);
    assert.equal(ended, "signed out", `the sign out landed within 15 s of the tap and 3 s of the run's end: ${log.join(", ")}`);
    assert.deepEqual(stages, ["filled"], "the trade ran to its end: filled");
    assert.deepEqual(world.sends, ["sale"], "one transaction");
    assert.ok(before(log, "run lock released", "gate closed, 0 held") && before(log, "gate closed, 0 held", "signed out"), `the order: ${log.join(", ")}`);
    assert.equal(log.filter((x) => x === "run lock released").length, 1, "one run held the seed lock");
  });
});
