// One real devnet front-run of a deposit through the signing page's own flow (card precommit-taken-recover):
// src/pool-deposit.ts runPoolDeposit on the devnet pool the testnet build pins, read on its two devnet RPCs, while a
// stranger's key deposits MIN_DEPOSIT on the precommitment of U's pending send and lands first.
//   node packages/signpage/scripts/pool-deposit-taken-devnet.mjs <out.json>
// - A seed made in this run only (16 random bytes), never printed or kept: its notes' secrets end with the run, so what
//   it deposits stays in the pool as a test deposit, as signpage-pool-notes' run does.
// - S, the stranger, is a key made in this run, not from the seed. The run prints S's address and the lamports S needs:
//   its own deposit of MIN_DEPOSIT with its costs, U's exact funding and one transfer's fee. Someone else funds S; this
//   run never funds anything. Then S sends U exactly what U's deposit needs.
// - The front-run: when the flow first sends U's signed deposit, the run first sends S's deposit of MIN_DEPOSIT with the
//   precommitment U's transaction names, waits until both RPCs hold its mark at finalized, then lets U's send go (both
//   RPCs refuse it at preflight: the precommitment is used). The flow must then restore S's deposit as the user's note at
//   MIN_DEPOSIT and land the rung on U's next note in the same run: answer filled, with U's second deposit.
// - It writes the answer, the notes (state, precommitment, leaf), S's and U's landed txs and both marks to <out.json>,
//   which the card's live check reads; S's remainder goes back to the deploy run's return address.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { IDBFactory } from "fake-indexeddb";
import { base58, base64 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import { entropyToWords, wordsToSeed64, depositId } from "../../wallet/src/derive/index.ts";
import { openWalletStore } from "../../wallet/src/store/index.ts";
import { openNoteStore } from "../../wallet/src/notes/store.ts";
import { noteSecrets } from "../../wallet/src/notes/secrets.ts";
import { solanaPoolOf } from "../../wallet/src/pool/solana.ts";
import { solanaJsonRpc } from "../../kit/src/trade/solana/send.ts";
import { readSolanaRent, solanaPoolPage, solanaRentMin } from "../../kit/src/trade/solana/pool-buy.ts";
import { solanaCompileV0 } from "../../kit/src/trade/solana/build.ts";
import { solanaDecodeMessage, solanaProgramAddress } from "../../kit/src/checks/solana/message.ts";
import { runPoolDeposit } from "../src/pool-deposit.ts";

const OUT = process.argv[2];
if (!OUT) throw new Error("usage: pool-deposit-taken-devnet.mjs <out.json>");
// the devnet pin of the testnet build (src/pool-testnet.ts, ../../wallet/src/pool/solana.ts SOL_POOLS.devnet)
const PIN = { program: "5V9iJECfs9q9zZTXvNco7oREqkZFvrtuKqKm74GgJWMZ", feePayer: "9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb" };
const RPCS = ["https://api.devnet.solana.com", "https://solana-devnet.api.onfinality.io/public"];
const RETURN_TO = "3NSPoKXm5PNTLurbAcJiYRB6oEuK4dfrxJy26JvzMqKx"; // the deploy run's (pool-sol-deploy.devnet.json return_to)
const SYSTEM = "11111111111111111111111111111111";
const RUNG = 10_000_000n;
const MIN_DEPOSIT = 1_000_000n; // contracts/pool-solana/src/lib.rs:78
const FEE = 5_000n;
const enc = new TextEncoder();
const log = (s) => console.log(`${new Date().toISOString()} ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const be32 = (x) => {
  const b = new Uint8Array(32);
  for (let i = 31, v = x; i >= 0; i--, v >>= 8n) b[i] = Number(v & 255n);
  return b;
};
const hex32 = (x) => x.toString(16).padStart(64, "0");
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
const plain = [patient(solanaJsonRpc(RPCS[0])), patient(solanaJsonRpc(RPCS[1]))];
const lower = async (address) => {
  const got = await Promise.all(plain.map(async (r) => BigInt((await r("getBalance", [address, { commitment: "confirmed" }])).value)));
  return got[0] < got[1] ? got[0] : got[1];
};
const blockhash = async () => (await plain[0]("getLatestBlockhash", [{ commitment: "confirmed" }])).value.blockhash;
const signed = (payer, ixs, bh, sk) => {
  const { message } = solanaCompileV0(payer, ixs, bh, []);
  const tx = new Uint8Array(65 + message.length);
  tx[0] = 1;
  tx.set(ed25519.sign(message, sk), 1);
  tx.set(message, 65);
  return tx;
};
const transfer = (from, to, lamports) => {
  const data = new Uint8Array(12);
  new DataView(data.buffer).setUint32(0, 2, true);
  new DataView(data.buffer).setBigUint64(4, lamports, true);
  return { program: SYSTEM, accounts: [{ key: from, signer: true, writable: true }, { key: to, signer: false, writable: true }], data };
};
const finalized = async (sig) => {
  for (;;) {
    const st = await Promise.all(plain.map(async (r) => (await r("getSignatureStatuses", [[sig], { searchTransactionHistory: true }])).value[0]));
    if (st.some((x) => x?.err)) throw new Error(`${sig} failed: ${JSON.stringify(st.map((x) => x?.err))}`);
    if (st.every((x) => x?.confirmationStatus === "finalized")) return;
    await sleep(2_000);
  }
};
const markOf = (pre) => solanaProgramAddress([enc.encode("pre"), be32(pre)], PIN.program);
const markRead = async (pre) => {
  const got = await Promise.all(plain.map(async (r) => (await r("getAccountInfo", [markOf(pre), { encoding: "base64", commitment: "finalized" }])).value));
  if (got.some((v) => v === null)) return null;
  const d = base64.decode(got[0].data[0]);
  const v = new DataView(d.buffer, d.byteOffset);
  return { value: String(v.getBigUint64(0, true)), nonce: String(v.getBigUint64(8, true)) };
};

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
const sSk = Uint8Array.from(randomBytes(32));
const S = base58.encode(ed25519.getPublicKey(sSk));

const rent = await readSolanaRent(plain);
const EMPTY = solanaRentMin(rent, 0);
// a page entry each tree, or a new page's rent when one starts: the higher, so the funding never falls short
const GROW = solanaRentMin(rent, 16 + 72) > 72n * rent.lamportsPerByte * rent.factor ? solanaRentMin(rent, 16 + 72) : 72n * rent.lamportsPerByte * rent.factor;
const COST = solanaRentMin(rent, 17) + 2n * GROW + FEE;
// U keeps at least an empty account's rent after its deposit (the flow refuses a remainder below it)
const U_NEED = RUNG + COST + EMPTY;
const S_NEED = MIN_DEPOSIT + COST + U_NEED + FEE + EMPTY;
log(`pool ${pool}; fund S ${S} with at least ${S_NEED} lamports on devnet (S then funds U ${U} with ${U_NEED})`);
for (let b = await lower(S); b < S_NEED; b = await lower(S)) {
  if (b > 0n) log(`S holds ${b}: waiting for at least ${S_NEED}`);
  await sleep(10_000);
}
const fundTx = signed(S, [transfer(S, U, U_NEED)], await blockhash(), sSk);
const fundU = base58.encode(fundTx.subarray(1, 65));
await Promise.allSettled(plain.map((r) => r("sendTransaction", [base64.encode(fundTx), { encoding: "base64" }])));
await finalized(fundU);
log(`U funded with ${U_NEED}; depositing 0.01 SOL, front-run by S`);

// S's deposit of MIN_DEPOSIT on precommitment `pre`, the pool's pages read on the first RPC
const strangerDeposit = async (pre) => {
  const acc = (await plain[0]("getAccountInfo", [pool, { encoding: "base64", commitment: "confirmed" }])).value;
  const d = base64.decode(acc.data[0]);
  const dv = new DataView(d.buffer, d.byteOffset);
  const ss = Number(dv.getBigUint64(49, true));
  const ls = Number(dv.getBigUint64(49 + 8 + 1 + 33 * 32, true));
  const u64 = new Uint8Array(8);
  new DataView(u64.buffer).setBigUint64(0, MIN_DEPOSIT, true);
  const ix = {
    program: PIN.program,
    accounts: [
      { key: pool, signer: false, writable: true },
      { key: S, signer: true, writable: true },
      { key: solanaPoolPage(PIN.program, 0, ss), signer: false, writable: true },
      { key: solanaPoolPage(PIN.program, 1, ls), signer: false, writable: true },
      { key: markOf(pre), signer: false, writable: true },
      { key: SYSTEM, signer: false, writable: false },
    ],
    data: Uint8Array.of(1, ...u64, ...be32(pre)),
  };
  const tx = signed(S, [ix], await blockhash(), sSk);
  const sig = base58.encode(tx.subarray(1, 65));
  await Promise.allSettled(plain.map((r) => r("sendTransaction", [base64.encode(tx), { encoding: "base64", preflightCommitment: "confirmed" }])));
  await finalized(sig);
  while ((await markRead(pre)) === null) await sleep(2_000);
  return sig;
};
let front = null; // the first send's front-run, once, shared by both RPCs' sends
const racing = (rpc) => async (method, params) => {
  if (method === "sendTransaction") {
    front ??= (async () => {
      const tx = base64.decode(params[0]);
      const pre = BigInt(`0x${Buffer.from(solanaDecodeMessage(tx.subarray(65)).instructions[0].data.subarray(9, 41)).toString("hex")}`);
      return { pre, sig: await strangerDeposit(pre) };
    })();
    await front;
  }
  return rpc(method, params);
};

const answer = await runPoolDeposit(
  { pin: PIN, rpcs: [racing(plain[0]), racing(plain[1])], notes: async () => ns, seed64: async () => seed64.slice(), progress: (s) => log(`stage ${s}`), wait: sleep },
  { kind: "pool.deposit", chain: "solana", token: null, amount: RUNG, slippageBps: 0, decimals: 9 },
);
const taken = front === null ? null : await front;
const notes = (await ns.list()).map((n) => ({ ref: n.ref, state: n.state, precommitment: hex32(n.precommitment), leaf: n.leaf && { value: String(n.leaf.value), label: hex32(n.leaf.label), commitment: hex32(n.leaf.commitment), leafIndex: String(n.leaf.leafIndex) }, sends: (n.sends ?? []).map((s) => s.signature) }));
log(`answer ${JSON.stringify(answer)}`);
log(`notes ${JSON.stringify(notes)}`);
const marks = await Promise.all(notes.map(async (n) => ({ precommitment: n.precommitment, mark: await markRead(BigInt(`0x${n.precommitment}`)) })));

// S's remainder back, all but the fee
let sweep = null;
const left = await lower(S);
if (left > FEE) {
  const tx = signed(S, [transfer(S, RETURN_TO, left - FEE)], await blockhash(), sSk);
  sweep = await plain[0]("sendTransaction", [base64.encode(tx), { encoding: "base64" }]);
  log(`sweep ${sweep}: ${left - FEE} lamports to ${RETURN_TO}`);
}
id.secretKey.fill(0);
sSk.fill(0);
seed64.fill(0);
writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), cluster: "devnet", program: PIN.program, pool, U, S, uNeed: String(U_NEED), answer, taken: taken && { precommitment: hex32(taken.pre), signature: taken.sig }, notes, marks, sweep }, null, 2) + "\n");
ns.close();
w.close();
const ok = "stage" in answer && answer.stage === "filled" && notes.some((n) => n.ref.kind === "deposit" && n.state === "UNSPENT" && n.leaf?.value === String(MIN_DEPOSIT));
process.exit(ok ? 0 : 1);
