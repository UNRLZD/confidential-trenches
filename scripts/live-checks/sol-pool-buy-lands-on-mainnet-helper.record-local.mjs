// The recorded answers of sol-pool-buy-lands-on-mainnet-helper.answers.json: the live check's own read() of each pool it
// reads (poolsToRead: both pools of the devnet move) against this tree's helper senders in process (apps/helper/src/pool/
// solana.ts solanaPoolSender, one per program), devnet, a throwaway fee payer made here, the fee 1,300,000, and RPCs that
// answer a simulation as a public mainnet RPC did (read 11 Nov 18:13Z, sigVerify true, replaceRecentBlockhash false):
// "SignatureFailure" when a signature does not hold, "BlockhashNotFound" for a blockhash they never made, and a
// blockhash read. Each answer carries the given commit in X-Helper-Commit, as server.ts sets it.
//   node scripts/live-checks/sol-pool-buy-lands-on-mainnet-helper.record-local.mjs <commit> > <file>
// Runs: once, it records the check's answers from a tree's helper in process (good: the card's; bad: c338a184's solana.ts); the check itself runs after every helper deploy
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { solanaPoolSender } from "../../apps/helper/src/pool/solana.ts";
import { b58encode } from "./helper-pool-senders.mjs";
import { poolsToRead, read } from "./pool-senders-next-page-helper.mjs";

const commit = process.argv[2];
if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error("usage: record-local.mjs <40-hex commit>");
const KNOWN = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";
const spki = (raw) => createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
/** Every signature of a v0 wire over its message, by its first n static keys (one-byte key count, as the plants have). */
const holds = (w) => {
  const n = w[0];
  const m = w.subarray(1 + 64 * n);
  return Array.from({ length: n }, (_, i) => verify(null, m, spki(m.subarray(5 + 32 * i, 37 + 32 * i)), w.subarray(1 + 64 * i, 65 + 64 * i))).every(Boolean);
};
const rpc = (i) =>
  Object.assign(
    async (method, params) => {
      if (method === "simulateTransaction") {
        const w = Buffer.from(params[0], "base64");
        const m = w.subarray(1 + 64 * w[0]);
        const bh = b58encode(m.subarray(5 + 32 * m[4], 37 + 32 * m[4]));
        const err = params[1].sigVerify && !holds(w) ? "SignatureFailure" : params[1].replaceRecentBlockhash || bh === KNOWN ? { InstructionError: [1, { Custom: 1 }] } : "BlockhashNotFound";
        return { context: { slot: 1 }, value: { err, logs: [] } };
      }
      if (method === "getLatestBlockhash") return { context: { slot: 1 }, value: { blockhash: KNOWN, lastValidBlockHeight: 1000 } };
      throw new Error(`unexpected ${method}`);
    },
    { url: `https://stub-${i}.invalid` },
  );
const k = generateKeyPairSync("ed25519");
const seed = k.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
const pub = createPublicKey(k.privateKey).export({ format: "der", type: "spki" }).subarray(-32);
const want = poolsToRead();
const senders = new Map();
for (const w of want) {
  const s = solanaPoolSender(
    { cluster: w.cluster, program: w.program, feePayerSecret: b58encode(Buffer.concat([seed, pub])), fee: "1300000" },
    { providers: [rpc(0), rpc(1)], readRent: async () => ({ lamportsPerByte: 5_080n, factor: 1n }), log: () => {}, send: () => { throw new Error("no send"); } },
  );
  await s.ready;
  senders.set(s.pool, s);
}
const headers = { "content-type": "application/json", "x-helper-commit": commit };
const fetchFn = async (url, init = {}) => {
  const u = new URL(url);
  const pool = u.pathname === "/v1/pool/fee" ? u.searchParams.get("pool") : JSON.parse(init.body).pool;
  const s = senders.get(pool);
  const a = !s ? { status: 404, body: { error: { code: "not_found" } } } : u.pathname === "/v1/pool/fee" ? { status: 200, body: await s.fee(Date.now()) } : await s.carry(JSON.parse(init.body));
  return new Response(JSON.stringify(a.body), { status: a.status, headers });
};
const runs = [];
for (const w of want) runs.push({ cluster: w.cluster, program: w.program, ...(await read("https://helper.local", w.pool, fetchFn)) });
console.log(JSON.stringify(runs, null, 1));
