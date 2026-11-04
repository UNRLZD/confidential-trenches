#!/usr/bin/env node
// Live check of card signpage-pool-flow: the devnet pool the signing page's testnet build pins (SOL_POOLS.devnet,
// packages/wallet/src/pool/solana.ts) is the deployed one. The pins are written out here, not read from the wallet:
//   - the program and pool are those of contracts/pool-solana's devnet deployment record
//     (scripts/live-checks/pool-sol-deploy.devnet.json);
//   - on two devnet RPCs of two operators, pool-sol-deploy's own check passes for that program:
//     - an executable upgradeable-loader program with its upgrade authority none, and the build's code;
//     - the pool account the program's, with the record's deposit in its trees;
//     - the run's funder emptied.
//   - SIGN_HOST (https://sign.confidential.unrealized.trade) serves the mainnet build: its /app.js carries none of the
//     testnet build's pins or providers (TESTNET_ONLY).
// The fee payer pin (the helper's devnet key) is checked against the helper's own answer once it serves this pool
// (card signpage-pool-flow-run).
//   node scripts/live-checks/signpage-pool-flow.mjs [--program <id>] [--record <file>]
// --program reads another program in the pin's place (the recorded bad answer). PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEPLOYMENT, RPCS, check as deployCheck, poolAddress, programDataAddress, recorder } from "./pool-sol-deploy.mjs";

const KEY = "signpage-pool-flow";
/** SOL_POOLS.devnet in the testnet build, and the pool its program derives. */
export const PIN = Object.freeze({
  program: "5V9iJECfs9q9zZTXvNco7oREqkZFvrtuKqKm74GgJWMZ",
  feePayer: "9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb",
  pool: "2S5wpE7U7GoJRVqox1dXmTQm38SmseG8A4F9eReWwYwr",
});

export const SIGN = "https://sign.confidential.unrealized.trade";
/** What only the testnet build carries: the devnet pins and the testnet RPC hosts (src/pool-testnet.ts). */
export const TESTNET_ONLY = Object.freeze([PIN.program, PIN.feePayer, "api.devnet.solana.com", "solana-devnet.api.onfinality.io", "sepolia.base.org", "base-sepolia-rpc.publicnode.com", "rpc.testnet.chain.robinhood.com", "robinhood-sepolia-rpc.publicnode.com"]);

/** SIGN_HOST's /app.js: its status and which of TESTNET_ONLY it carries. */
export async function readSign(fetchFn = fetch) {
  const r = await fetchFn(`${SIGN}/app.js`);
  const text = await r.text();
  return { status: r.status, bytes: text.length, found: TESTNET_ONLY.filter((s) => text.includes(s)) };
}

/** The verdict for `program` read through `fetchFn` (live, or a recorded answer replayed), and SIGN_HOST's read `sign`. */
export async function check({ program = PIN.program, fetchFn = fetch, rpcs = RPCS, sleep, sign } = {}) {
  const record = JSON.parse(readFileSync(DEPLOYMENT, "utf8"));
  const lines = [];
  const say = (pass, text) => lines.push(`${pass ? "ok  " : "BAD "} ${text}`);
  say(sign?.status === 200 && sign.bytes > 0 && Array.isArray(sign.found) && sign.found.length === 0, `SIGN_HOST's /app.js is the mainnet build, with no testnet pin or provider: ${sign ? `${sign.status}, ${sign.bytes} chars, carries [${sign.found.join(", ")}]` : "not read"}`);
  say(program === PIN.program, `the program read is the pin's: ${program}`);
  say(record.cluster === "devnet" && record.program_id === PIN.program && record.pool === PIN.pool, `the deployment record names the pin's program and pool: ${record.program_id}, ${record.pool}`);
  say(poolAddress(PIN.program).address === PIN.pool, `the pin's pool derives from its program: ${poolAddress(PIN.program).address}`);
  const deployment = program === PIN.program ? record : { ...record, program_id: program, programdata: programDataAddress(program), pool: poolAddress(program).address };
  const r = await deployCheck({ deployment, fetchFn, rpcs, ...(sleep ? { sleep } : {}) });
  for (const l of r.lines) lines.push(l.startsWith("FAIL") ? `BAD ${l.slice(4)}` : l);
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opt = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const rec = recorder();
    const sign = await readSign();
    const r = await check({ program: opt("--program") ?? PIN.program, fetchFn: opt("--record") ? rec.fetchFn : fetch, sign });
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify({ program: opt("--program") ?? PIN.program, rpcs: RPCS, at: new Date().toISOString(), sign, answers: rec.answers })}\n`);
    for (const l of r.lines) console.log(l);
    console.log(`${r.ok ? "PASS" : "FAIL"} ${KEY}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
