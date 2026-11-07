#!/usr/bin/env node
// Live check of card pool-deposits: the signing page's same-chain Solana deposit, built, priced and its mark read by the
// kit (packages/kit/src/trade/solana/pool-deposit.ts) since slice 2, landed a note on the devnet pool its testnet build
// pins, and SIGN_HOST (https://confidential.unrealized.trade) still serves the mainnet build, which carries no testnet pin. The run is pool-deposits.run.json,
// written from packages/signpage/scripts/pool-deposit-devnet.mjs (runPoolDeposit, src/pool-deposit.ts, at this card's
// code, a seed made in that run). The reads are signpage-pool-notes's, on each of two devnet RPCs of two operators at
// finalized: the deposit tx with no error, paid and signed by the run's U, calling the pinned program; the mark at the
// run's value and nonce, the program's; the label leaf keccak256(scope, nonce) mod p and the state leaf the note's
// commitment, both worked out here; U at 0 lamports (the kit's cost was exactly what the program took).
//   node scripts/live-checks/pool-deposits.mjs [--precommitment <hex>] [--record <file>]
// --precommitment reads another precommitment in the run's place (the recorded bad answer). PASS exit 0, FAIL exit 1,
// error exit 2.
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEVNET_PROVIDERS, recorder } from "./pool-sol-deploy.mjs";
import { check as checkRun, readSignFlow } from "./signpage-pool-notes.mjs";

const KEY = "pool-deposits";
export const RUN = new URL("./pool-deposits.run.json", import.meta.url);

/** The verdict for this card's run (with `precommitment` in its place when given), read through `fetchFn`, and SIGN_HOST's read `sign`. */
export const check = ({ run = JSON.parse(readFileSync(RUN, "utf8")), ...rest } = {}) => checkRun({ run, ...rest });

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opt = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const run = JSON.parse(readFileSync(RUN, "utf8"));
    const rec = recorder();
    const sign = await readSignFlow();
    const precommitment = opt("--precommitment") ?? run.precommitment;
    const r = await check({ run, precommitment, fetchFn: opt("--record") ? rec.fetchFn : fetch, sign });
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify({ precommitment, rpcs: DEVNET_PROVIDERS, at: new Date().toISOString(), sign, answers: rec.answers })}\n`);
    for (const l of r.lines) console.log(l);
    console.log(`${r.ok ? "PASS" : "FAIL"} ${KEY}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
