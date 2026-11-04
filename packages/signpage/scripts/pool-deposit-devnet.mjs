// One real devnet deposit through the signing page's own flow (card signpage-pool-notes): src/pool-deposit.ts
// runPoolDeposit, on the devnet pool the testnet build pins, read on its two devnet RPCs.
//   node packages/signpage/scripts/pool-deposit-devnet.mjs <out.json>
// - A seed made in this run only (16 random bytes), never printed or kept: its note's secrets end with the run, so the
//   0.01 SOL stays in the pool as a test deposit, as the deploy run's does (scripts/live-checks/pool-sol-deploy.md).
// - It plans the deposit note on the wallet's own note store (fake-indexeddb, in memory), prints U's address and the
//   lamports U needs (the rung, the mark's rent, two page entries and the fee, from the Rent sysvar both RPCs give),
//   then waits for U to hold exactly that, or that plus at least an empty account's rent. Someone else funds U.
// - Then one pool.deposit of 0.01 SOL; it prints the answer, the note (state, leaf) and the landed tx, and writes them to
//   <out.json>. U's remainder, if any, goes back to the deploy run's return address in a plain transfer.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { IDBFactory } from "fake-indexeddb";
import { base58, base64 } from "@scure/base";
import { entropyToWords, wordsToSeed64, depositId } from "../../wallet/src/derive/index.ts";
import { openWalletStore } from "../../wallet/src/store/index.ts";
import { openNoteStore } from "../../wallet/src/notes/store.ts";
import { noteSecrets } from "../../wallet/src/notes/secrets.ts";
import { solanaPoolOf } from "../../wallet/src/pool/solana.ts";
import { solanaJsonRpc } from "../../kit/src/trade/solana/send.ts";
import { readSolanaRent, solanaRentMin } from "../../kit/src/trade/solana/pool-buy.ts";
import { solanaCompileV0 } from "../../kit/src/trade/solana/build.ts";
import { ed25519 } from "@noble/curves/ed25519.js";
import { runPoolDeposit } from "../src/pool-deposit.ts";

const OUT = process.argv[2];
if (!OUT) throw new Error("usage: pool-deposit-devnet.mjs <out.json>");
// the devnet pin of the testnet build (src/pool-testnet.ts, ../../wallet/src/pool/solana.ts SOL_POOLS.devnet)
const PIN = { program: "5V9iJECfs9q9zZTXvNco7oREqkZFvrtuKqKm74GgJWMZ", feePayer: "9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb" };
const RPCS = ["https://api.devnet.solana.com", "https://solana-devnet.api.onfinality.io/public"];
const RETURN_TO = "3NSPoKXm5PNTLurbAcJiYRB6oEuK4dfrxJy26JvzMqKx"; // the deploy run's (pool-sol-deploy.devnet.json return_to)
const RUNG = 10_000_000n;
const FEE = 5_000n;
const log = (s) => console.log(`${new Date().toISOString()} ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// public devnet RPCs answer HTTP 429 under load: this run waits and asks again, up to 8 times per call
const patient = (rpc) => async (method, params) => {
  for (let i = 0; ; i++) {
    try {
      return await rpc(method, params);
    } catch (e) {
      if (i >= 7 || !/HTTP 429|fetch failed/.test(String(e?.message))) throw e;
      await sleep(1_000 * 2 ** Math.min(i, 4));
    }
  }
};
const rpcs = [patient(solanaJsonRpc(RPCS[0])), patient(solanaJsonRpc(RPCS[1]))];

const w = await openWalletStore({ indexedDB: new IDBFactory() });
const entropy = randomBytes(16);
await w.insertSeed({ v: 1, entropy: Uint8Array.from(entropy), source: "code", code_saved: true, created_ms: Date.now() });
const seed64 = wordsToSeed64(entropyToWords(Uint8Array.from(entropy)));
entropy.fill(0);
const ns = await openNoteStore(w);
const { scope, pool } = solanaPoolOf(PIN.program);
const note = await ns.planDeposit(scope, (ref) => noteSecrets(seed64, ref).precommitment);
const id = depositId(seed64, scope, note.ref.i);
const U = base58.encode(id.publicKey);

const rent = await readSolanaRent(rpcs);
const NEED = RUNG + solanaRentMin(rent, 17) + 2n * 72n * rent.lamportsPerByte * rent.factor + FEE;
const EMPTY = solanaRentMin(rent, 0);
const balance = async () => {
  const got = await Promise.all(rpcs.map(async (r) => BigInt(((await r("getBalance", [U, { commitment: "confirmed" }])).value))));
  return got[0] < got[1] ? got[0] : got[1];
};
log(`pool ${pool}; fund U ${U} with exactly ${NEED} lamports (or at least ${NEED + EMPTY}) on devnet`);
for (let b = await balance(); !(b === NEED || b >= NEED + EMPTY); b = await balance()) {
  if (b > 0n) log(`U holds ${b}: waiting for exactly ${NEED} or at least ${NEED + EMPTY}`);
  await sleep(10_000);
}
log("U funded; depositing 0.01 SOL");

const answer = await runPoolDeposit(
  { pin: PIN, rpcs, notes: async () => ns, seed64: async () => seed64.slice(), progress: (s) => log(`stage ${s}`), wait: sleep },
  { kind: "pool.deposit", chain: "solana", token: null, amount: RUNG, slippageBps: 0, decimals: 9 },
);
const notes = (await ns.list()).map((n) => ({ ref: n.ref.kind, state: n.state, precommitment: n.precommitment.toString(16).padStart(64, "0"), leaf: n.leaf && { value: String(n.leaf.value), label: n.leaf.label.toString(16).padStart(64, "0"), commitment: n.leaf.commitment.toString(16).padStart(64, "0"), leafIndex: String(n.leaf.leafIndex) }, sends: (n.sends ?? []).map((s) => s.signature) }));
log(`answer ${JSON.stringify(answer)}`);
log(`notes ${JSON.stringify(notes)}`);

// U's remainder back, if any: a system transfer of all but the fee
let sweep = null;
const left = await balance();
if (left > FEE) {
  const bh = (await rpcs[0]("getLatestBlockhash", [{ commitment: "confirmed" }])).value.blockhash;
  const data = new Uint8Array(12);
  new DataView(data.buffer).setUint32(0, 2, true);
  new DataView(data.buffer).setBigUint64(4, left - FEE, true);
  const { message } = solanaCompileV0(U, [{ program: "11111111111111111111111111111111", accounts: [{ key: U, signer: true, writable: true }, { key: RETURN_TO, signer: false, writable: true }], data }], bh, []);
  const sig = ed25519.sign(message, id.secretKey);
  const tx = new Uint8Array(65 + message.length);
  tx[0] = 1;
  tx.set(sig, 1);
  tx.set(message, 65);
  sweep = await rpcs[0]("sendTransaction", [base64.encode(tx), { encoding: "base64" }]);
  log(`sweep ${sweep}: ${left - FEE} lamports to ${RETURN_TO}`);
}
id.secretKey.fill(0);
seed64.fill(0);
writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), cluster: "devnet", program: PIN.program, pool, U, need: String(NEED), answer, notes, sweep }, null, 2) + "\n");
ns.close();
w.close();
process.exit("stage" in answer && answer.stage === "filled" ? 0 : 1);
