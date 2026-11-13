// The recorded good answer of owners-solana-buy-lands.answers.json: the live check's own read() against this tree, in
// process: SIGN_HOST's / and /app.js from a local build of the signing page (packages/signpage/scripts/build-app.mjs
// --out <dir>), and HELPER_HOST from this tree's helper sender (apps/helper/src/pool/solana.ts solanaPoolSender) on
// mainnet with a throwaway fee payer made here, the fee 1,300,000, a block engine stand-in that is never called, and RPCs
// that answer a simulation of a blockhash they never made "BlockhashNotFound", as a public mainnet RPC does (read 11 Nov
// 18:10Z); mainnet's rent 5,080 a byte. Each helper answer carries the given commit in X-Helper-Commit.
//   node scripts/live-checks/owners-solana-buy-lands.record-local.mjs <commit> <sign build dir> > <file>
// Runs: once, it records the good answer (the bad one is the live hosts' own answer before the card, read by the check)
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { solanaPoolSender } from "../../apps/helper/src/pool/solana.ts";
import { b58encode } from "./helper-pool-senders.mjs";
import { HELPER, mainnetPool, read, SIGN } from "./owners-solana-buy-lands.mjs";

const [commit, dir] = process.argv.slice(2);
if (!/^[0-9a-f]{40}$/.test(commit ?? "") || !dir) throw new Error("usage: record-local.mjs <40-hex commit> <sign build dir>");
const PROGRAM = "EN1Wb2iWTw7ihNHTNW3SU2DkUCbw7yEEGR7ywWgWn8MF";
const rpc = (i) =>
  Object.assign(
    async (method) => {
      if (method === "simulateTransaction") return { context: { slot: 1 }, value: { err: "BlockhashNotFound", logs: [] } };
      if (method === "getLatestBlockhash") return { context: { slot: 1 }, value: { blockhash: b58encode(Buffer.alloc(32, 2)), lastValidBlockHeight: 1000 } };
      throw new Error(`unexpected ${method}`);
    },
    { url: `https://stub-${i}.invalid` },
  );
const never = () => {
  throw new Error("the block engine stand-in is never called");
};
const k = generateKeyPairSync("ed25519");
const seed = k.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
const pub = createPublicKey(k.privateKey).export({ format: "der", type: "spki" }).subarray(-32);
const rent = { lamportsPerByte: 5_080n, factor: 1n };
const s = solanaPoolSender(
  { cluster: "mainnet", program: PROGRAM, feePayerSecret: b58encode(Buffer.concat([seed, pub])), fee: "1300000" },
  { providers: [rpc(0), rpc(1)], readRent: async () => rent, log: () => {}, jito: { intervalMs: 1_000, send: never, rebroadcast: never, status: never, sendBundle: never, rebroadcastBundle: never }, send: never },
);
await s.ready;
if (s.pool !== mainnetPool()) throw new Error(`the sender's pool ${s.pool} is not the mainnet record's`);
const headers = { "content-type": "application/json", "x-helper-commit": commit };
const fetchFn = async (url, init = {}) => {
  const u = new URL(url);
  if (u.origin === SIGN) return new Response(readFileSync(join(dir, u.pathname === "/" ? "index.html" : u.pathname.slice(1)), "utf8"), { status: 200 });
  if (u.origin !== HELPER) throw new Error(`not read here: ${u.origin}`);
  const a = u.pathname === "/v1/pool/fee" ? { status: 200, body: await s.fee(Date.now()) } : await s.carryPieces(JSON.parse(init.body));
  return new Response(JSON.stringify(a.body), { status: a.status, headers });
};
console.log(JSON.stringify(await read(fetchFn, async () => rent)));
