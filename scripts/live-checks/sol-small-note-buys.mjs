#!/usr/bin/env node
// Live check of card sol-small-note-buys: the ladder's least Solana rung, 0.01 SOL (SOL_LADDER.min), can buy on
// mainnet. What a tap may spend from its chunk is the signing page's tap_max (packages/wallet/src/pool/balances.ts
// solanaTapSpendOf: the chunk less the relay fee, the tip cap, W's new accounts' rent and its sell's reserve, at the worst
// venue, on the Rent sysvar the page reads; the itemized table is in that file). This reads what it depends on now:
//   1. the Rent sysvar on the signing page's Solana pair (SIGN_HOST's provider A and the helper's keyed route,
//      signpage-pool-pins.mjs rentRead), both answers agreeing;
//   2. with --pin, the mainnet pool's pin (packages/wallet/src/pool/solana.ts SOL_POOLS.mainnet, which card
//      pool-sol-deploy-mainnet writes and then passes here): the helper's GET /v1/pool/fee for that pool must answer the
//      device's own fee for that rent (the kit's solanaPoolFee) and the pinned fee payer, since that fee is what the
//      proof binds; without it the device's fee stands for it and the line says the read waits for the pin;
// and passes when the 0.01 SOL rung's tap_max at that fee, the tip cap and the read rent is above 0, by the kit's rule
// that packages/wallet/src/pool/balances.ts solanaTapSpendOf gives (solanaPoolBuyMaxSpend at the worst venue).
// Scripts reach Blindfill only through the kit's entry (check:imports), so the rung and the tip cap are written here;
// packages/wallet/test/pool-balances.test.ts holds them equal to SOL_LADDER.min and SOL_TIP_CAP.
//   node scripts/live-checks/sol-small-note-buys.mjs [--pin <program>:<feePayer>] [--rent <lamportsPerByte>x<factor>] [--record <file>]
//     --rent: a harness run, that rent standing for the pair's read (the helper is still read live)
//     PASS exit 0, FAIL exit 1, error exit 2
import "../net-window.mjs";
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SOLANA_POOL_WORST_BUY_VENUE, solanaPoolAccount, solanaPoolBuyMaxSpend, solanaPoolFee } from "../../packages/kit/src/index.ts";
import { PAGE_PAIR, rentRead } from "./signpage-pool-pins.mjs";

const KEY = "sol-small-note-buys";
const HELPER_HOST = "https://api.confidential.unrealized.trade";
const DIGITS = /^[1-9]\d*$/;
/** The ladder's least Solana rung, 0.01 SOL, and the tip cap every buy proof binds, in lamports (the wallet's
 *  SOL_LADDER.min and SOL_TIP_CAP). */
export const SOL_RUNG = 10_000_000n;
export const SOL_TIP = 1_000_000n;
const KEY58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ------------------------------------------------------------------------------------------------ the verdict
export function judge(rec) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  const r = rec.rent ?? {};
  const pair = Array.isArray(r.rpcs) && r.rpcs.length === 2 && r.rpcs.every((u, i) => u === PAGE_PAIR[i]);
  say(pair, `the Rent read is on the page's Solana pair: ${(r.rpcs ?? []).join(" and ") || "none"}`);
  const read = typeof r.lamportsPerByte === "string" && DIGITS.test(r.lamportsPerByte) && (r.factor === "1" || r.factor === "2") && r.error === undefined;
  say(read, `the pair agrees on the Rent sysvar: ${read ? `${r.lamportsPerByte} lamports per byte, factor ${r.factor}` : (r.error ?? "no read")}`);
  if (!read) return { ok: false, lines };
  const rent = { lamportsPerByte: BigInt(r.lamportsPerByte), factor: BigInt(r.factor) };
  const fee = solanaPoolFee(rent);
  const pin = rec.pin ?? null;
  if (pin === null) {
    say(true, `no mainnet pool pin given (card pool-sol-deploy-mainnet passes --pin once it pins one): the helper's fee waits for it; the device's fee at this rent is ${fee}`);
  } else {
    const h = rec.helperFee ?? {};
    const a = h.answer ?? {};
    const same = h.status === 200 && a.chain === "solana" && a.program === pin.program && a.pool === solanaPoolAccount(pin.program) && a.fee_payer === pin.feePayer && a.fee === fee.toString();
    say(same, `the helper's fee for the pinned pool ${pin.program} is the device's ${fee} with the pinned fee payer: ${h.status !== 200 ? `HTTP ${h.status ?? "none"}` : `fee ${a.fee}, fee payer ${a.fee_payer}, pool ${a.pool}`}`);
  }
  const spend = solanaPoolBuyMaxSpend({ withdrawnValue: SOL_RUNG, relayFee: fee }, SOLANA_POOL_WORST_BUY_VENUE, SOL_TIP, rent);
  say(spend > 0n, `the ${SOL_RUNG}-lamport rung's tap_max at the worst venue, fee ${fee} and tip cap ${SOL_TIP}: ${spend} lamports`);
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
export async function collect({ rent: stand, pin: pinArg } = {}) {
  const at = new Date().toISOString();
  let rent;
  if (stand) {
    const m = /^([1-9]\d*)x([12])$/.exec(stand);
    if (!m) throw new Error("--rent is <lamportsPerByte>x<factor>, factor 1 or 2");
    rent = { rpcs: PAGE_PAIR, lamportsPerByte: m[1], factor: m[2] };
  } else {
    rent = await rentRead();
  }
  let pin = null;
  if (pinArg !== undefined) {
    const [program, feePayer, ...rest] = String(pinArg).split(":");
    if (rest.length || !KEY58.test(program ?? "") || !KEY58.test(feePayer ?? "")) throw new Error("--pin is <program>:<feePayer>, two base58 addresses");
    pin = { program, feePayer };
  }
  let helperFee = null;
  if (pin !== null) {
    const res = await fetch(`${HELPER_HOST}/v1/pool/fee?pool=${solanaPoolAccount(pin.program)}`, { signal: AbortSignal.timeout(15_000) });
    helperFee = { status: res.status, answer: res.status === 200 ? await res.json() : null };
  }
  return { check: KEY, at, source: stand ? `harness: rent ${stand} standing for the pair's read` : `live: the page's Solana pair and ${HELPER_HOST}`, rent, pin, helperFee };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  try {
    const arg = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
    const rec = await collect({ rent: arg("--rent"), pin: arg("--pin") });
    const file = a.includes("--record") ? a[a.indexOf("--record") + 1] : null;
    if (file) writeFileSync(file, `${JSON.stringify(rec, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"} (${rec.source})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
