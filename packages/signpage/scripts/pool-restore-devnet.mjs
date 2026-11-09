// Browser B of card pool-restore-wired's devnet run: a new browser, an empty store, the same 12 words. The words of a
// finished devnet run of the page's own pool flow (browser A: pool-flow-devnet.mjs, which deposits, buys and sells on
// the devnet pool and keeps its seed at ~/.ct-devnet-runs/run-<time>.seed, 0600, outside the repo) are signed in to a
// fresh wallet store (fake-indexeddb, in memory) and the signing page's own restore runs as main.ts runs it after a
// words sign-in: src/pool-restore.ts poolRestore(...).auto() on pagePools() of the testnet build (the devnet pool
// SOL_POOLS pins, on the page's two devnet RPCs; EVM_POOLS pins no EVM pool, so none is read).
//   node packages/signpage/scripts/pool-restore-devnet.mjs <run.seed> <out.json>
// Then, for the record: every note the store holds (its ref kind, state, value and leaf index), and each SPENT note's
// W (derived from the words, the only W a release of the device's pays: ../../wallet/src/pool/evm-restore.ts header)
// with its lamports and token accounts read on both devnet RPCs at finalized. The seed is never printed or written;
// the record holds addresses, values and leaf indices only. Exit 0 only when the restore ended as the testnet build's
// must (card wallet-restore-reads-ux): stalled with exactly one reason per pool walked, POOL_UX_UNREAD_TESTNET, since that
// build reads no deposit id nor any U_X; any other reason, or done, exits 1.
import { readFileSync, writeFileSync } from "node:fs";
import { IDBFactory } from "fake-indexeddb";

globalThis.__SIGN_NETWORK__ = "testnet";
const { entropyToWords, wordsToSeed64 } = await import("../../wallet/src/derive/index.ts");
const { freshWallet } = await import("../../wallet/src/derive/keys.ts");
const { openWalletStore } = await import("../../wallet/src/store/index.ts");
const { openNoteStore } = await import("../../wallet/src/notes/store.ts");
const { jOf } = await import("../../wallet/src/pool/queue.ts");
const { POOL_TESTNET } = await import("../../wallet/src/pool/network.ts");
const { pagePools, poolRestore, POOL_UX_UNREAD_TESTNET } = await import("../src/pool-restore.ts");
const { TESTNET_RPCS, pageSolanaRpcs } = await import("../src/pool-testnet.ts");
if (POOL_TESTNET !== true) throw new Error("not the testnet build's pins");

const [SEED_FILE, OUT] = process.argv.slice(2);
if (!OUT) throw new Error("usage: pool-restore-devnet.mjs <run.seed> <out.json>");
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

const entropy = Buffer.from(readFileSync(SEED_FILE, "utf8").trim(), "hex");
if (entropy.length !== 16) throw new Error("the seed file holds no 16-byte seed");
const w = await openWalletStore({ indexedDB: new IDBFactory() });
await w.insertSeed({ v: 1, entropy: Uint8Array.from(entropy), source: "code", code_saved: true, created_ms: Date.now() });
const seed64Of = () => wordsToSeed64(entropyToWords(Uint8Array.from(entropy)));

const pools = pagePools();
log(`the page's pools: ${JSON.stringify(pools.map((p) => (p.chain === "solana" ? `solana ${p.program}` : `evm ${p.pin.network}`)))}`);
const ns0 = await openNoteStore(w);
const before = (await ns0.list()).length;
ns0.close();
const t0 = performance.now();
let why = null;
const r = poolRestore({ store: async () => w, seed64: async () => seed64Of(), signedIn: async () => true, ended: (_, y) => void (why = [...y]) });
const stage = await r.auto();
const ms = Math.round(performance.now() - t0);
log(`store B held ${before} notes; the restore with no tap ended ${stage} in ${ms} ms`);

const ns = await openNoteStore(w);
const notes = (await ns.list()).map((n) => ({ ref: n.ref.kind, state: n.state, value: n.leaf ? String(n.leaf.value) : null, leafIndex: n.leaf ? String(n.leaf.leafIndex) : null, label: n.leaf ? String(n.leaf.label) : null, j: n.ref.kind === "deposit" ? null : jOf(n.ref) }));
const ops = [];
for (const k of await w.keys("ops")) ops.push({ id: k, ...(await w.get("ops", k)) });
notes.sort((a, b) => Number(a.leafIndex) - Number(b.leafIndex));
for (const n of notes) log(`note ${n.ref} ${n.state} value ${n.value} leaf ${n.leafIndex}`);

// each SPENT note's W, from the words, on both RPCs at finalized
const rpcs = pageSolanaRpcs();
const seed64 = seed64Of();
const spent = (await ns.list()).filter((n) => n.state === "SPENT");
const ws = [];
for (const n of spent) {
  const fw = freshWallet(seed64, "sol", n.leaf.label, jOf(n.ref));
  fw.secretKey.fill(0);
  const reads = [];
  for (const [i, rpc] of rpcs.entries()) {
    const bal = await rpc("getBalance", [fw.address, { commitment: "finalized" }]);
    const toks = await rpc("getTokenAccountsByOwner", [fw.address, { programId: "TokenkegQfeZyiNwAJbNbGQPQwen1t6eZVs7u6m9yMKXdoSKD" }, { commitment: "finalized", encoding: "jsonParsed" }]).catch((e) => ({ error: String(e?.message ?? e).slice(0, 80) }));
    const toks22 = await rpc("getTokenAccountsByOwner", [fw.address, { programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" }, { commitment: "finalized", encoding: "jsonParsed" }]).catch((e) => ({ error: String(e?.message ?? e).slice(0, 80) }));
    reads.push({ rpc: TESTNET_RPCS.solana[i], slot: bal?.context?.slot ?? null, lamports: String(bal?.value ?? null), tokenAccounts: (toks?.value ?? []).length + (toks22?.value ?? []).length });
  }
  ws.push({ note: n.ref.kind, w: fw.address, reads });
  log(`W of the ${n.ref.kind} note: ${fw.address}: ${reads.map((x) => `${x.lamports} lamports, ${x.tokenAccounts} token accounts at slot ${x.slot}`).join(" | ")}`);
}
seed64.fill(0);
entropy.fill(0);
ns.close();
writeFileSync(OUT, `${JSON.stringify({ at: new Date().toISOString(), cluster: "devnet", pools: pools.map((p) => (p.chain === "solana" ? { chain: "solana", program: p.program } : { chain: "evm", network: p.pin.network })), before, stage, ms, ops, notes, wallets: ws }, null, 1)}\n`);
log(`written ${OUT}`);
const want = pools.map((p) => `${p.chain === "solana" ? "solana" : p.pin.network}: ${POOL_UX_UNREAD_TESTNET}`);
const named = stage === "stalled" && why !== null && why.length === want.length && why.every((y, k) => y === want[k]);
log(named ? "the restore stalled by the testnet build's one name, as it must" : `the restore did not end as the testnet build's must: ${stage}, ${JSON.stringify(why)}`);
process.exit(named ? 0 : 1);
