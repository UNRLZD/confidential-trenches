/// <reference types="node" />
// Row M1.3's proof, the --dry set of 3 (markets paper M:3056): three v0 txs in the standard set's frame (compute
// budget, the 5,000-lamport Sender tip and the 10,000-lamport Jito tip of T2.1 items 8-9, from three different
// wallets, one fresh blockhash and its lastValidBlockHeight), passed through the kit's own set checks and simulated on
// two public providers with dryRunSolanaSet: simulateTransaction only, nothing is sent. The swap itself is not in the
// frame (its build is row M1.1's, through the helper's Jupiter key), so these simulate the send and tips, not a trade.
//
// The wallets are stand-ins: large system accounts (the first two are P4's, research proofs/p4-speed/solana/run.mjs
// SIM_FUNDED; each is read live below and refused unless system-owned and funded). The bytes are signed by keys made
// here and thrown away, so the simulation runs with sigVerify off; no key of anyone's signs anything.
//
//   node packages/kit/test/solana-send-dry.ts --dry
import { base58 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  SOLANA_JITO_TIP,
  SOLANA_JITO_TIP_ACCOUNTS,
  SOLANA_PUBLIC_RPC_URL,
  SOLANA_SENDER_TIP,
  SOLANA_SENDER_TIP_ACCOUNTS,
  SOLANA_SYSTEM_PROGRAM,
  SOLANA_COMPUTE_BUDGET_PROGRAM,
  dryRunSolanaSet,
  solanaJsonRpc,
  solanaSendPaths,
  type SolanaSignedTx,
} from "../src/index.ts";

if (!process.argv.includes("--dry")) {
  console.error("this script runs only with --dry: it simulates and never sends");
  process.exit(2);
}
// Provider B: the second public RPC the kit's quote fixtures were read on (test/fixtures/solana-capture.mjs:7).
const PROVIDER_B = "https://public.rpc.solanavibestation.com";
const STAND_INS = ["H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9"];

const a = solanaJsonRpc(SOLANA_PUBLIC_RPC_URL, { timeoutMs: 10_000 });
const b = solanaJsonRpc(PROVIDER_B, { timeoutMs: 10_000 });

const u32 = (n: number) => { const x = new Uint8Array(4); new DataView(x.buffer).setUint32(0, n, true); return [...x]; };
const u64 = (n: bigint) => { const x = new Uint8Array(8); new DataView(x.buffer).setBigUint64(0, n, true); return [...x]; };
const key = (s: string) => [...base58.decode(s)];

// One v0 message: payer W, then the two tip accounts (writable), then the system and compute-budget programs.
function frame(w: string, blockhash: string, i: number): number[] {
  const senderTip = SOLANA_SENDER_TIP_ACCOUNTS[i % SOLANA_SENDER_TIP_ACCOUNTS.length]!;
  const jitoTip = SOLANA_JITO_TIP_ACCOUNTS[i % SOLANA_JITO_TIP_ACCOUNTS.length]!;
  const keys = [w, senderTip, jitoTip, SOLANA_SYSTEM_PROGRAM, SOLANA_COMPUTE_BUDGET_PROGRAM];
  const ix = (program: number, accounts: number[], data: number[]) => [program, accounts.length, ...accounts, data.length, ...data];
  return [
    0x80, 1, 0, 2, keys.length, ...keys.flatMap(key), ...key(blockhash),
    4,
    ...ix(4, [], [2, ...u32(200_000)]), // SetComputeUnitLimit
    ...ix(4, [], [3, ...u64(100_000n)]), // SetComputeUnitPrice, microlamports
    ...ix(3, [0, 1], [2, 0, 0, 0, ...u64(SOLANA_SENDER_TIP)]), // system transfer: the Sender tip
    ...ix(3, [0, 2], [2, 0, 0, 0, ...u64(SOLANA_JITO_TIP)]), // system transfer: the Jito tip
    0, // no lookups
  ];
}

const t0 = performance.now();
for (const w of STAND_INS) {
  const info = (await a("getAccountInfo", [w, { encoding: "base64", commitment: "confirmed" }])) as { value: { owner: string; lamports: number } | null };
  if (!info.value || info.value.owner !== SOLANA_SYSTEM_PROGRAM || info.value.lamports < 1e9) throw new Error(`stand-in ${w} is not a funded system account`);
}
const latest = (await a("getLatestBlockhash", [{ commitment: "confirmed" }])) as { context: { slot: number }; value: { blockhash: string; lastValidBlockHeight: number } };
const set: SolanaSignedTx[] = STAND_INS.map((w, i) => {
  const msg = Uint8Array.from(frame(w, latest.value.blockhash, i));
  const sig = ed25519.sign(msg, ed25519.utils.randomSecretKey());
  return { wire: Uint8Array.from([1, ...sig, ...msg]), lastValidBlockHeight: latest.value.lastValidBlockHeight };
});
const paths = solanaSendPaths(); // never called by the dry run; named in its answer
const tSim = performance.now();
const r = await dryRunSolanaSet(set, { paths, providers: [a, b], callTimeoutMs: 10_000 });
const simMs = performance.now() - tSim;
console.log(JSON.stringify({
  dry: true,
  slot: latest.context.slot,
  blockhash: latest.value.blockhash,
  lastValidBlockHeight: latest.value.lastValidBlockHeight,
  providers: [SOLANA_PUBLIC_RPC_URL, PROVIDER_B],
  paths: r.paths,
  sizes: set.map((s) => s.wire.length),
  txs: r.txs,
  simulateMs: Math.round(simMs),
  totalMs: Math.round(performance.now() - t0),
}, null, 1));
if (r.txs.some((t) => t.state !== "simulated")) process.exit(1);
