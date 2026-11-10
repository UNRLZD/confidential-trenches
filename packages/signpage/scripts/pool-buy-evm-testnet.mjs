// One real Base Sepolia or Robinhood testnet pool buy through the signing page's own code path (card
// signpage-evm-pool-buy): the page's pool kinds (src/pool-kinds.ts over src/pool-testnet.ts testnetPool, as main.ts
// wires them) on the testnet build's own pins, providers and helper; the chain's proof queue makes the proof, and
// pool.buy quotes, builds, checks, signs (W), writes W's holding pending, takes, sends through the helper's POST
// /v1/pool/evm/send and reads its end on the pool's own release events on the chain's two pool RPCs
// (src/pool-buy-evm.ts): the tap answers "sent" once the bytes leave, and the end comes as the kind's progress.
//   FLOW_RESUME=<seed file> node packages/signpage/scripts/pool-buy-evm-testnet.mjs <base|robinhood> <token> <out.json>
// - The seed: a run's own 16 random bytes, kept 0600 in ~/.ct-devnet-runs by the deposit run that put its note in the
//   pool (pool-deposit-evm-testnet.mjs with the seed kept, as pool-buy-own-spend-devnet.mjs keeps its); read here,
//   never printed. The note comes back from the seed alone (the wallet's evmRestoreNotes, notes only, as the page's
//   restore reads them).
// - What differs from the page in a browser, and only that: the prover is snarkjs's fullProve in this process on the
//   release's pinned withdraw files, and the wallet store is fake-indexeddb in memory.
// - It writes the answer, the end, the notes, W's holding record, each RPC's read of the transaction and the buy's
//   request log (every request from the tap to the end: its host, its method, and whether it names W, the proof's
//   nullifier or the transaction) to <out.json>. Nothing here logs a key or the words.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { IDBFactory } from "fake-indexeddb";

globalThis.__SIGN_NETWORK__ = "testnet";
// installed before any module loads, so every provider made at load or later fetches through it
// every request this process makes, from the tap on: host, path, the JSON-RPC method, and what it names
const requests = [];
let tapped = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (tapped) {
    const u = new URL(String(url instanceof Request ? url.url : url));
    let method = null;
    try {
      method = [JSON.parse(String(init?.body ?? "null"))].flat().map((x) => x?.method).filter(Boolean).join(",") || null;
    } catch {}
    requests.push({ at: Date.now(), host: u.host, path: u.pathname, verb: init?.method ?? "GET", method, body: String(init?.body ?? "").toLowerCase() });
  }
  return realFetch(url, init);
};
const { entropyToWords, wordsToSeed64 } = await import("../../wallet/src/derive/index.ts");
const { openWalletStore, WALLET_SEED_LOCK } = await import("../../wallet/src/store/index.ts");
const { openNoteStore } = await import("../../wallet/src/notes/store.ts");
const { EVM_POOLS, evmPoolScopeOf, EVM_CHAIN_IDS } = await import("../../wallet/src/pool/evm.ts");
const { evmRestoreNotes } = await import("../../wallet/src/pool/evm-restore.ts");
const { ZK_SETUP_FILES } = await import("../../kit/src/zk/setup-files.ts");
const { poolKinds } = await import("../src/pool-kinds.ts");
const { TESTNET_RPCS, testnetPool, testnetPoolDeps, testnetRpc } = await import("../src/pool-testnet.ts");
const { EVM_OWED_BACK_KEY, EVM_POSITION_COSTS_KEY } = await import("../src/pool-buy-evm.ts");

const [CHAIN, TOKEN, OUT] = process.argv.slice(2);
if ((CHAIN !== "base" && CHAIN !== "robinhood") || !/^0x[0-9a-fA-F]{40}$/.test(TOKEN ?? "") || !OUT || !process.env.FLOW_RESUME)
  throw new Error("usage: FLOW_RESUME=<seed file> pool-buy-evm-testnet.mjs <base|robinhood> <token> <out.json>");
const NETWORK = CHAIN === "base" ? "base-sepolia" : "robinhood-testnet";
const PIN = EVM_POOLS[NETWORK];
if (!PIN) throw new Error(`the testnet build pins no ${NETWORK} pool`);
const log = (s) => console.log(`${new Date().toISOString()} ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const big = (_k, v) => (typeof v === "bigint" ? v.toString() : v);

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
const scope = evmPoolScopeOf(PIN.pool, EVM_CHAIN_IDS[NETWORK]);
const RPCS = TESTNET_RPCS[CHAIN];
const rpcs = RPCS.map((u) => testnetRpc(u));

// the note from the seed alone, as the page's restore reads it (notes only: no W is named to any provider)
const restored = await evmRestoreNotes({ seed64: seed64.slice(), pin: PIN, rpcs, wallets: false });
for (const n of restored.notes) await ns.add({ ref: n.ref, scope: n.scope, precommitment: n.precommitment, state: n.state, leaf: n.leaf });
log(`restored ${restored.notes.length} note(s) at block ${restored.block}: ${restored.notes.map((n) => `${n.ref.kind} ${n.state} ${n.leaf.value}`).join(", ")}`);
if (!restored.notes.some((n) => n.state === "UNSPENT")) throw new Error("no UNSPENT note to buy with");

const helperLog = [];
const helperFetch = async (url, init) => {
  const r = await fetch(url, init);
  // a refusal's body is the helper's public error (its code and detail), kept for the record
  const body = r.status === 200 ? null : (await r.clone().text()).slice(0, 300);
  helperLog.push({ method: init?.method ?? "GET", path: new URL(url).pathname, status: r.status, ...(body === null ? {} : { body, retryAfter: r.headers.get("retry-after") }) });
  log(`helper ${init?.method ?? "GET"} ${new URL(url).pathname}: HTTP ${r.status}${body === null ? "" : ` ${body} (Retry-After ${r.headers.get("retry-after")})`}`);
  return r;
};
// the page's open store as main.ts gives it (held: opened()), which the buy writes W's holding to
const page = { store: async () => w, held: async () => w, seed64: async () => seed64.slice() };
const t = testnetPool(page, { prover: { vault, stop: () => {} }, fetch: helperFetch });
const kinds = poolKinds(testnetPoolDeps(t.flow));

// the queue's proof: the state read starts the chain's pass; wait for its ready proof (one prove, a few minutes at most)
await t.stateRead();
let ready = [];
for (let i = 0; i < 120 && ready.length === 0; i++) {
  await sleep(5_000);
  ready = ((await t.readyWith(async () => null)).ready ?? []).filter((p) => p.wallet.chain === "evm");
  if (ready.length === 0 && i % 6 === 5) await t.stateRead();
}
if (ready.length === 0) throw new Error("no ready proof");
const proof = ready[0];
log(`ready: note ${proof.noteId}, chunk ${proof.chunk}, fee ${proof.binding.feeCap}, W ${proof.wallet.address}, epoch ${proof.epochStartMs}`);

const amount = (Number(proof.chunk) / 1e18).toString();
const stages = [];
tapped = true;
const tapAt = Date.now();
const r = kinds["pool.buy"]({ chain: CHAIN, token: TOKEN, amount, slippage_bps: 300 }, { id: "buy", sha: "00", progress: (s) => (stages.push(s), log(`progress ${JSON.stringify(s)}`)) });
if ("error" in r) throw new Error(`refused: ${JSON.stringify(r)}`);
await r.after;
const first = r.answer();
log(`answered ${JSON.stringify(first)} in ${Date.now() - tapAt} ms; waiting for the end`);
// the send part holds the seed's lock; the read-back runs past it and ends as progress (the tap's or a late one)
await navigator.locks.request(WALLET_SEED_LOCK, { mode: "exclusive" }, () => {});
const ENDS = ["filled", "part_filled", "refused", "not_landed"];
for (let i = 0; i < 360 && !ENDS.includes(stages.at(-1)); i++) await sleep(2_000);
const end = stages.at(-1) ?? null;
const endMs = Date.now() - tapAt;
tapped = false;
const holdings = await w.get("meta", EVM_POSITION_COSTS_KEY);
const owed = await w.get("meta", EVM_OWED_BACK_KEY);
const hash = holdings?.[proof.wallet.address]?.route?.tx ?? null;
// what each request named: W, the proof's nullifier (its word), the transaction
const said = { w: proof.wallet.address.slice(2).toLowerCase(), nullifier: BigInt(proof.publicSignals[1]).toString(16).padStart(64, "0"), tx: hash?.slice(2) ?? "-" };
const requestLog = requests.map(({ body, ...q }) => ({ ...q, at: q.at - tapAt, names: Object.entries(said).filter(([, v]) => body.includes(v)).map(([k]) => k) }));
// each pool RPC's own read of the transaction, for the run record
const reads = [];
if (hash)
  for (const [k, rpc] of rpcs.entries()) {
    const rc = await rpc("eth_getTransactionReceipt", [hash]).catch((e) => ({ error: String(e?.message).slice(0, 120) }));
    reads.push({ rpc: RPCS[k], block: rc?.blockNumber ? BigInt(rc.blockNumber).toString() : null, status: rc?.status ?? null });
  }
log(`end ${end} in ${endMs} ms; tx ${hash}; reads ${JSON.stringify(reads)}; holding ${JSON.stringify(holdings, big)}; owed ${JSON.stringify(owed ?? null)}`);
for (const q of requestLog) log(`request +${q.at} ms ${q.verb} ${q.host}${q.path} ${q.method ?? ""} names: ${q.names.join(",") || "none"}`);
const notes = (await ns.list()).map((n) => ({ id: n.id, ref: n.ref.kind, state: n.state, value: n.leaf ? String(n.leaf.value) : null }));
writeFileSync(OUT, JSON.stringify({ by: "packages/signpage/scripts/pool-buy-evm-testnet.mjs", network: NETWORK, pool: PIN.pool, token: TOKEN, rpcs: RPCS, w: proof.wallet.address, chunk: proof.chunk, fee: proof.binding.feeCap, first, end, endMs, hash, reads, holdings, owed: owed ?? null, notes, helper: helperLog, requests: requestLog }, big, 2) + "\n");
log(`wrote ${OUT}`);
await t.signedOut();
seed64.fill(0);
ns.close();
w.close();
process.exit(end === "filled" && reads.length === 2 && reads.every((x) => x.status === "0x1") ? 0 : 1);
