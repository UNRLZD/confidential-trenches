// The recorded answers of buy-spends-several-pieces.answers.json: the live check's own read() of each pool it reads
// (poolsToRead: each cluster's record pool and both pools of the devnet move) against a tree's helper senders in process
// (apps/helper/src/pool/solana.ts solanaPoolSender, one per program; its carryPieces for /v1/pool/solana/pieces), a
// throwaway fee payer made here, the fee 1,300,000, and RPCs that answer a simulation as a public RPC does for a
// blockhash it never made ("BlockhashNotFound"). Nothing is sent: the sender's send throws. Each answer carries the
// given commit in X-Helper-Commit, as server.ts sets it. A tree whose sender has no carryPieces answers 404, as a
// helper with no such route does.
//   node scripts/live-checks/buy-spends-several-pieces.record-local.mjs <commit> > <file>
// Runs: once, it records the check's good answer from the card's tree; the check itself runs after every helper deploy
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { solanaPoolSender } from "../../apps/helper/src/pool/solana.ts";
import { b58encode } from "./helper-pool-senders.mjs";
import { poolsToRead } from "./pool-senders-next-page-helper.mjs";
import { read } from "./buy-spends-several-pieces.mjs";

const commit = process.argv[2];
if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error("usage: record-local.mjs <40-hex commit>");
const KNOWN = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";
const rpc = (i) =>
  Object.assign(
    async (method, params) => {
      if (method === "simulateTransaction") return { context: { slot: 1 }, value: { err: params[1].replaceRecentBlockhash ? { InstructionError: [1, { Custom: 1 }] } : "BlockhashNotFound", logs: [] } };
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
    {
      providers: [rpc(0), rpc(1)],
      readRent: async () => ({ lamportsPerByte: 5_080n, factor: 1n }),
      log: () => {},
      jito: null,
      send: () => {
        throw new Error("no send");
      },
    },
  );
  await s.ready;
  senders.set(s.pool, s);
}
const headers = { "content-type": "application/json", "x-helper-commit": commit };
const fetchFn = async (url, init = {}) => {
  const u = new URL(url);
  const pool = u.pathname === "/v1/pool/fee" ? u.searchParams.get("pool") : JSON.parse(init.body).pool;
  const s = senders.get(pool);
  const a =
    !s || (u.pathname === "/v1/pool/solana/pieces" && typeof s.carryPieces !== "function")
      ? { status: 404, body: { error: { code: "not_found" } } }
      : u.pathname === "/v1/pool/fee"
        ? { status: 200, body: await s.fee(Date.now()) }
        : await s.carryPieces(JSON.parse(init.body));
  return new Response(JSON.stringify(a.body), { status: a.status, headers });
};
const runs = [];
for (const w of want) runs.push({ cluster: w.cluster, program: w.program, ...(await read("https://helper.local", w.pool, fetchFn)) });
console.log(JSON.stringify(runs, null, 1));
