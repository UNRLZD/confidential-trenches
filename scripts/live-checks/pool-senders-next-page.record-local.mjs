// The good answer of pool-senders-next-page.answers.json: the live check's own read() against this tree's helper
// sender in process (apps/helper/src/pool/solana.ts solanaPoolSender), devnet, a throwaway fee payer made here, the
// Rent sysvar at mainnet's 5,080 a byte (the fee 1,300,000, as the devnet helper publishes it), and RPCs that answer a
// simulation the way a cluster does for a blockhash it never made (err "BlockhashNotFound") and a blockhash read. Each answer carries the
// tree's commit in X-Helper-Commit, as server.ts sets it.
//   node scripts/live-checks/pool-senders-next-page.record-local.mjs <commit> > <file>
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { solanaPoolSender } from "../../apps/helper/src/pool/solana.ts";
import { solanaPoolAccount } from "../../packages/kit/src/index.ts";
import { b58encode } from "./helper-pool-senders.mjs";
import { read } from "./pool-senders-next-page.mjs";

const commit = process.argv[2];
if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error("usage: record-local.mjs <40-hex commit>");
const PROGRAM = "5V9iJECfs9q9zZTXvNco7oREqkZFvrtuKqKm74GgJWMZ"; // the devnet pool's program (pool-sol-deploy.devnet.json)
const k = generateKeyPairSync("ed25519");
const seed = k.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
const pub = createPublicKey(k.privateKey).export({ format: "der", type: "spki" }).subarray(-32);
const rpc = (i) => Object.assign(async (method) => {
  if (method === "simulateTransaction") return { context: { slot: 1 }, value: { err: "BlockhashNotFound", logs: [] } };
  if (method === "getLatestBlockhash") return { context: { slot: 1 }, value: { blockhash: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM", lastValidBlockHeight: 1000 } };
  throw new Error(`unexpected ${method}`);
}, { url: `https://stub-${i}.invalid` });
const s = solanaPoolSender(
  { cluster: "devnet", program: PROGRAM, feePayerSecret: b58encode(Buffer.concat([seed, pub])), fee: "1300000" },
  { providers: [rpc(0), rpc(1)], readRent: async () => ({ lamportsPerByte: 5_080n, factor: 1n }), log: () => {}, send: () => { throw new Error("no send"); } },
);
await s.ready;
const headers = { "content-type": "application/json", "x-helper-commit": commit };
const fetchFn = async (url, init = {}) => {
  const u = new URL(url);
  const a = u.pathname === "/v1/pool/fee" ? { status: 200, body: await s.fee(Date.now()) } : await s.carry(JSON.parse(init.body));
  return new Response(JSON.stringify(a.body), { status: a.status, headers });
};
const run = await read("https://helper.local", solanaPoolAccount(PROGRAM), fetchFn);
console.log(JSON.stringify([{ cluster: "devnet", ...run }], null, 1));
