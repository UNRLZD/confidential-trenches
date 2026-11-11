// One real Base Sepolia or Robinhood testnet pool buy, its position, its sell and the position gone, through the signing
// page's own code path (card signpage-positions-evm): the page's pool kinds (src/pool-kinds.ts over src/pool-testnet.ts
// testnetPool, as main.ts wires them) on the testnet build's own pins, providers and helper. pool.buy runs to filled;
// then the page's state positions (src/positions-evm.ts, the pass its end starts) name the token on the chain with the
// amount both pool RPCs read W holding; then pool.sell of the whole holding (share_bps 10000, as the terminal's Sell
// asks it) runs to filled; then the positions name it no more.
//   FLOW_RESUME=<seed file> node packages/signpage/scripts/pool-positions-evm-testnet.mjs <base|robinhood> <token> <out.json>
// - The seed: a run's own 16 random bytes, kept 0600 in ~/.ct-devnet-runs by the deposit run that put its note in the
//   pool (pool-deposit-evm-testnet.mjs --keep-seed); read here, never printed. The note comes back from the seed alone
//   (the wallet's evmRestoreNotes, notes only).
// - What differs from the page in a browser, and only that: the prover is snarkjs's fullProve in this process on the
//   release's pinned withdraw files, and the wallet store is fake-indexeddb in memory.
// - It writes each answer and end, W, the buy's and the sell's transactions with each pool RPC's receipt, and the
//   positions after each, to <out.json>. Nothing here logs a key or the words.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { IDBFactory } from "fake-indexeddb";

globalThis.__SIGN_NETWORK__ = "testnet";
// each request's host, JSON-RPC method and answer status, logged as it ends (never a body)
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url instanceof Request ? url.url : url));
  let method = "";
  try {
    method = [JSON.parse(String(init?.body ?? "null"))].flat().map((x) => x?.method).filter(Boolean).join(",");
  } catch {}
  const r = await realFetch(url, init);
  if (r.status !== 200) console.log(`${new Date().toISOString()} request ${init?.method ?? "GET"} ${u.host}${u.pathname} ${method}: HTTP ${r.status}`);
  return r;
};
const { entropyToWords, wordsToSeed64 } = await import("../../wallet/src/derive/index.ts");
const { openWalletStore, WALLET_SEED_LOCK } = await import("../../wallet/src/store/index.ts");
const { openNoteStore } = await import("../../wallet/src/notes/store.ts");
const { EVM_POOLS, EVM_CHAIN_IDS } = await import("../../wallet/src/pool/evm.ts");
const { evmRestoreNotes } = await import("../../wallet/src/pool/evm-restore.ts");
const { ZK_SETUP_FILES } = await import("../../kit/src/zk/setup-files.ts");
const { poolKinds } = await import("../src/pool-kinds.ts");
const { TESTNET_RPCS, testnetPool, testnetPoolDeps, testnetRpc } = await import("../src/pool-testnet.ts");
const { EVM_POSITION_COSTS_KEY } = await import("../src/pool-buy-evm.ts");
const { EVM_OPEN_SELLS_KEY } = await import("../src/pool-sell-evm.ts");

const [CHAIN, TOKEN, OUT] = process.argv.slice(2);
if ((CHAIN !== "base" && CHAIN !== "robinhood") || !/^0x[0-9a-fA-F]{40}$/.test(TOKEN ?? "") || !OUT || !process.env.FLOW_RESUME)
  throw new Error("usage: FLOW_RESUME=<seed file> pool-positions-evm-testnet.mjs <base|robinhood> <token> <out.json>");
const NETWORK = CHAIN === "base" ? "base-sepolia" : "robinhood-testnet";
const PIN = EVM_POOLS[NETWORK];
if (!PIN) throw new Error(`the testnet build pins no ${NETWORK} pool`);
const log = (s) => console.log(`${new Date().toISOString()} ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const big = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
const lower = (s) => String(s).toLowerCase();

// the prover: snarkjs's fullProve in this process, on the release's pinned withdraw files
const KIT_ZK = new URL("../../kit/zk/", import.meta.url);
const file = (name) => {
  const b = readFileSync(new URL(name, KIT_ZK));
  if (createHash("sha256").update(b).digest("hex") !== ZK_SETUP_FILES[name].sha256) throw new Error(`${name}: not the pinned setup file`);
  return new Uint8Array(b);
};
const WASM = file("withdraw.wasm");
const ZKEY = file("withdraw.zkey");
const snarkjs = createRequire(new URL("../../kit/package.json", import.meta.url))("snarkjs");
const vault = {
  load: async () => {},
  prove: async (circuit, input) => {
    if (circuit !== "withdraw") throw new Error(`no ${circuit} prover here`);
    const t0 = performance.now();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY, undefined, undefined, { singleThread: true });
    log(`proved in ${Math.round(performance.now() - t0)} ms`);
    return { proof, publicSignals, proveMs: Math.round(performance.now() - t0) };
  },
};

const entropy = Buffer.from(readFileSync(process.env.FLOW_RESUME, "utf8").trim(), "hex");
if (entropy.length !== 16) throw new Error("the seed file holds no 16-byte seed");
const seed64 = wordsToSeed64(entropyToWords(Uint8Array.from(entropy)));
const w = await openWalletStore({ indexedDB: new IDBFactory() });
await w.insertSeed({ v: 1, entropy: Uint8Array.from(entropy), source: "code", code_saved: true, created_ms: Date.now() });
entropy.fill(0);
const ns = await openNoteStore(w);
const RPCS = TESTNET_RPCS[CHAIN];
const rpcs = RPCS.map((u) => testnetRpc(u));
if (EVM_CHAIN_IDS[NETWORK] === undefined) throw new Error("no chain id");

// the note from the seed alone, as the page's restore reads it (notes only: no W is named to any provider)
const restored = await evmRestoreNotes({ seed64: seed64.slice(), pin: PIN, rpcs, wallets: false });
for (const n of restored.notes) await ns.add({ ref: n.ref, scope: n.scope, precommitment: n.precommitment, state: n.state, leaf: n.leaf });
log(`restored ${restored.notes.length} note(s) at block ${restored.block}: ${restored.notes.map((n) => `${n.ref.kind} ${n.state} ${n.leaf.value}`).join(", ")}`);
if (!restored.notes.some((n) => n.state === "UNSPENT")) throw new Error("no UNSPENT note to buy with");

const helperFetch = async (url, init) => {
  const r = await fetch(url, init);
  const body = r.status === 200 ? null : (await r.clone().text()).slice(0, 300);
  log(`helper ${init?.method ?? "GET"} ${new URL(url).pathname}: HTTP ${r.status}${body === null ? "" : ` ${body} (Retry-After ${r.headers.get("retry-after")})`}`);
  return r;
};
const page = { store: async () => w, held: async () => w, seed64: async () => seed64.slice() };
const t = testnetPool(page, { prover: { vault, stop: () => {} }, fetch: helperFetch });
const kinds = poolKinds(testnetPoolDeps(t.flow));
const ENDS = ["filled", "part_filled", "refused", "not_landed"];

/** One tap of `kind` with `params`, to its end stage (the tap's or a late one); its first answer and its end. */
async function tap(kind, params) {
  const stages = [];
  const at = Date.now();
  const r = kinds[kind](params, { id: kind, sha: "00", progress: (s) => (stages.push(s), log(`${kind} progress ${JSON.stringify(s)}`)) });
  if ("error" in r) throw new Error(`${kind} refused: ${JSON.stringify(r)}`);
  await r.after;
  const first = r.answer();
  log(`${kind} answered ${JSON.stringify(first)} in ${Date.now() - at} ms; waiting for the end`);
  // a refusal ran to no send: it has no end to wait for
  if (first !== null && "error" in first) return { first, end: null, ms: Date.now() - at };
  await navigator.locks.request(WALLET_SEED_LOCK, { mode: "exclusive" }, () => {});
  for (let i = 0; i < 360 && !ENDS.includes(stages.at(-1)); i++) await sleep(2_000);
  return { first, end: stages.at(-1) ?? null, ms: Date.now() - at };
}
/** This chain's positions of TOKEN in the page's state, read until `want` holds of them (2 s apart, 3 min at most). */
async function positionsUntil(want) {
  let got = null;
  for (let i = 0; i < 90; i++) {
    got = ((await t.positions()) ?? []).filter((p) => p.chain === CHAIN && lower(p.token) === lower(TOKEN));
    if (want(got)) return got;
    await sleep(2_000);
  }
  return got;
}
const receipts = async (hash) =>
  hash === null
    ? []
    : Promise.all(rpcs.map(async (rpc, k) => {
        const rc = await rpc("eth_getTransactionReceipt", [hash]).catch((e) => ({ error: String(e?.message).slice(0, 120) }));
        return { rpc: RPCS[k], block: rc?.blockNumber ? BigInt(rc.blockNumber).toString() : null, status: rc?.status ?? null };
      }));

// the queue's proof: the state read starts the chain's pass; wait for its ready proof
await t.stateRead();
let ready = [];
for (let i = 0; i < 120 && ready.length === 0; i++) {
  await sleep(5_000);
  ready = ((await t.readyWith(async () => null)).ready ?? []).filter((p) => p.wallet.chain === "evm");
  if (ready.length === 0 && i % 6 === 5) await t.stateRead();
}
if (ready.length === 0) throw new Error("no ready proof");
const proof = ready[0];
const W = proof.wallet.address;
log(`ready: note ${proof.noteId}, chunk ${proof.chunk}, fee ${proof.binding.feeCap}, W ${W}`);

// 1. the buy, to filled
const buy = await tap("pool.buy", { chain: CHAIN, token: TOKEN, amount: (Number(proof.chunk) / 1e18).toString(), slippage_bps: 300 });
const holding = (await w.get("meta", EVM_POSITION_COSTS_KEY))?.[W] ?? null;
const buyTx = holding?.route?.tx ?? null;
const buyReads = await receipts(buyTx);
log(`buy end ${buy.end}; tx ${buyTx}; reads ${JSON.stringify(buyReads)}; holding ${JSON.stringify(holding, big)}`);
if (buy.end !== "filled") throw new Error(`the buy ended ${buy.end ?? JSON.stringify(buy.first)}: no position to read`);
// 2. the position, from the page's own pass: W's amount as both pool RPCs read it
const held = await positionsUntil((ps) => ps.length === 1 && ps[0].wallets.map(lower).includes(lower(W)));
log(`positions after the buy: ${JSON.stringify(held)}`);
// 3. the sell of the whole holding, as the terminal's Sell asks it, to filled
const opened = [];
const sell = await tap("pool.sell", { chain: CHAIN, token: TOKEN, share_bps: 10_000, slippage_bps: 300 });
for (const o of Object.values((await w.get("meta", EVM_OPEN_SELLS_KEY)) ?? {})) opened.push(o);
// the sale's transaction: the pool's Deposited from W since the buy's block, the same on both pool RPCs
const DEPOSITED = "0xe3b53cd1a44fbf11535e145d80b8ef1ed6d57a73bf5daa7e939b6b01657d6549";
const sold = await Promise.all(rpcs.map(async (rpc) => ((await rpc("eth_getLogs", [{ address: PIN.pool, fromBlock: `0x${BigInt(buyReads[0]?.block ?? 0).toString(16)}`, toBlock: "latest", topics: [DEPOSITED, `0x${W.slice(2).toLowerCase().padStart(64, "0")}`] }])) ?? []).map((l) => l.transactionHash)));
const sellTx = sold[0]?.length === 1 && sold[1]?.length === 1 && sold[0][0] === sold[1][0] ? sold[0][0] : null;
const sellReads = await receipts(sellTx);
log(`sell end ${sell.end}; tx ${sellTx}; reads ${JSON.stringify(sellReads)}`);
// 4. the position gone, from the page's own pass
const after = await positionsUntil((ps) => ps.length === 0);
log(`positions after the sell: ${JSON.stringify(after)}`);

writeFileSync(OUT, JSON.stringify({ by: "packages/signpage/scripts/pool-positions-evm-testnet.mjs", network: NETWORK, pool: PIN.pool, token: TOKEN, rpcs: RPCS, w: W, buy: { ...buy, tx: buyTx, reads: buyReads }, holding, held, sell: { ...sell, tx: sellTx, reads: sellReads }, opened, after }, big, 2) + "\n");
log(`wrote ${OUT}`);
await t.signedOut();
seed64.fill(0);
ns.close();
w.close();
const ok = (x) => x.end === "filled" && x.reads.length === 2 && x.reads.every((r) => r.status === "0x1");
process.exit(ok({ ...buy, reads: buyReads }) && held?.length === 1 && ok({ ...sell, reads: sellReads }) && after?.length === 0 ? 0 : 1);
