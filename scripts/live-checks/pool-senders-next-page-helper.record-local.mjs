// The good answer of pool-senders-next-page-helper.answers.json: the live check's own read() of each pool it reads
// (poolsToRead: both pools of the devnet move, DEVNET_MOVE) against this tree's helper senders in process
// (apps/helper/src/pool/solana.ts solanaPoolSender, one per program, as solanaPoolSendersFromEnv makes them), devnet, a
// throwaway fee payer made here, the
// Rent sysvar at mainnet's 5,080 a byte (the fee 1,300,000, as the devnet helper publishes it), and RPCs that answer a
// simulation the way a cluster does for a blockhash it never made (err "BlockhashNotFound") and a blockhash read. Each answer carries the
// tree's commit in X-Helper-Commit, as server.ts sets it.
//   node scripts/live-checks/pool-senders-next-page-helper.record-local.mjs <commit> [--only <program>] > <file>
// --only serves that one program, as a helper whose POOL_SOLANA_PROGRAM_DEVNET lists only it (the recorded bad answer
// bad_one_program: the other pool answers 404).
// Runs: once, it records the check's good answer from this tree's helper in process; the check itself runs after every helper deploy
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { solanaPoolSender } from "../../apps/helper/src/pool/solana.ts";
import { solanaPoolAccount } from "../../packages/kit/src/index.ts";
import { b58encode } from "./helper-pool-senders.mjs";
import { poolsToRead, read } from "./pool-senders-next-page-helper.mjs";

const commit = process.argv[2];
if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error("usage: record-local.mjs <40-hex commit>");
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined;
// each devnet program the move serves (pool-senders-next-page-helper.mjs DEVNET_MOVE), or only the one --only names
const want = poolsToRead().filter((w) => w.cluster === "devnet" && w.program);
const programs = want.map((w) => w.program).filter((p) => only === undefined || p === only);
if (programs.length === 0) throw new Error("no devnet program to serve");
for (const w of want) if (solanaPoolAccount(w.program) !== w.pool) throw new Error(`${w.pool} is not ${w.program}'s pool`);
const k = generateKeyPairSync("ed25519");
const seed = k.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
const pub = createPublicKey(k.privateKey).export({ format: "der", type: "spki" }).subarray(-32);
const rpc = (i) => Object.assign(async (method) => {
  if (method === "simulateTransaction") return { context: { slot: 1 }, value: { err: "BlockhashNotFound", logs: [] } };
  if (method === "getLatestBlockhash") return { context: { slot: 1 }, value: { blockhash: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM", lastValidBlockHeight: 1000 } };
  throw new Error(`unexpected ${method}`);
}, { url: `https://stub-${i}.invalid` });
const senders = new Map();
for (const program of programs) {
  const s = solanaPoolSender(
    { cluster: "devnet", program, feePayerSecret: b58encode(Buffer.concat([seed, pub])), fee: "1300000" },
    { providers: [rpc(0), rpc(1)], readRent: async () => ({ lamportsPerByte: 5_080n, factor: 1n }), log: () => {}, send: () => { throw new Error("no send"); } },
  );
  await s.ready;
  senders.set(s.pool, s);
}
const none = { status: 404, body: { error: { code: "not_found" } } };
const headers = { "content-type": "application/json", "x-helper-commit": commit };
const fetchFn = async (url, init = {}) => {
  const u = new URL(url);
  const pool = u.pathname === "/v1/pool/fee" ? u.searchParams.get("pool") : JSON.parse(init.body).pool;
  const s = senders.get(pool);
  const a = !s ? none : u.pathname === "/v1/pool/fee" ? { status: 200, body: await s.fee(Date.now()) } : await s.carry(JSON.parse(init.body));
  return new Response(JSON.stringify(a.body), { status: a.status, headers });
};
const runs = [];
for (const w of want) runs.push({ cluster: w.cluster, program: w.program, ...(await read("https://helper.local", w.pool, fetchFn)) });
console.log(JSON.stringify(runs, null, 1));
