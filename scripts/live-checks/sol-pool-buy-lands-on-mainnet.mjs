#!/usr/bin/env node
// Live check of card sol-pool-buy-lands-on-mainnet on SIGN_HOST (https://confidential.unrealized.trade). What it holds,
// and only that: the served /app.js is the one index.html pins (its sha384); the mainnet pool buy's Jito tip, read from
// the bundle where the buy picks it (`<cluster> === "mainnet" ? TIP : 0n`, src/pool-buy.ts), is over Jito's 1,000
// lamport minimum (two buys at it were taken by a block engine and never landed, 11 Nov) and at most the proof's tip
// cap, 1,000,000 (packages/wallet SOL_TIP_CAP); and the pool sell pays a priority fee on mainnet: the bundle builds its
// compute budget there (src/pool-sell.ts solanaSellBudget) and the sell box's preview counts a priority of more than 0
// (src/pool-sell-dry.ts). It does not prove a buy or a sell lands: only a mainnet tap does, read back on two RPCs.
// After: sign
//   node scripts/live-checks/sol-pool-buy-lands-on-mainnet.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "sol-pool-buy-lands-on-mainnet";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const ID = "[A-Za-z_$][\\w$]*";
/** A minified constant's value: `<name>=<digits>n` where it is declared (after var, let, const or a comma). */
const valueOf = (js, name) => {
  const m = new RegExp(`(?:^|[,;{\\s])(?:var |let |const )?${name.replace(/\$/g, "\\$")}=(\\d+)n[,;]`).exec(js);
  return m ? m[1] : null;
};

/** What the check keeps of the reads: the index, the bundle's sha384, the buy's mainnet tip and the sell's priority. */
export function facts(index, js) {
  const buy = new RegExp(`let ${ID}=${ID}\\.cluster===\`mainnet\`\\?(${ID}):0n,${ID}=new Map`).exec(js);
  const sellBuilds = new RegExp(`${ID}\\.cluster===\`mainnet\`\\?${ID}\\(null\\):null`).test(js);
  const preview = new RegExp(`${ID}\\+\\(${ID}\\.cluster===\`mainnet\`\\?(${ID}):0n\\)`).exec(js);
  return { index, sha384: sha384(js), buyTip: buy ? valueOf(js, buy[1]) : null, sellBudget: sellBuilds, sellPriority: preview ? valueOf(js, preview[1]) : null };
}

/** The verdict on an answer { index, sha384, buyTip, sellBudget, sellPriority }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  const tip = typeof a?.buyTip === "string" && /^\d{1,19}$/.test(a.buyTip) ? BigInt(a.buyTip) : null;
  if (tip === null) bad("the bundle's mainnet buy tip is not read");
  else if (tip <= 1_000n) bad(`the mainnet buy tips ${tip} lamports, not over Jito's 1,000 minimum`);
  else if (tip > 1_000_000n) bad(`the mainnet buy tips ${tip} lamports, over the proof's tip cap 1,000,000`);
  if (a?.sellBudget !== true) bad("the bundle builds no compute budget for a mainnet sell");
  const pri = typeof a?.sellPriority === "string" && /^\d{1,19}$/.test(a.sellPriority) ? BigInt(a.sellPriority) : null;
  if (pri === null || pri === 0n) bad("the sell box's preview counts no mainnet priority fee");
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

export async function read(fetchFn = fetch) {
  const get = async (path) => {
    const r = await fetchFn(`${SIGN}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status}`);
    return r.text();
  };
  return facts(await get("/"), await get("/app.js"));
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read();
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(answer)}\n`);
    const v = judge(answer);
    for (const l of v.lines) console.log(l);
    console.log(v.ok ? `PASS ${KEY}` : `FAIL ${KEY}`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
