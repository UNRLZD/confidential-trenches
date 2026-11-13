#!/usr/bin/env node
// Live check of card owners-solana-buy-lands: a Solana pool buy of several pieces is carried the way one piece's is.
// What it holds, and only that:
//   - SIGN_HOST: the served /app.js is the one index.html pins (its sha384), and the kit's tip rule in it
//     (solanaPoolBuyTip, minified `function F(c,k){...pieces: 1 to N...;return c===devnet?0n:TIP}`) tips one tip for
//     every count of pieces on mainnet, over Jito's 1,000 lamport minimum and at most the proof's tip cap 1,000,000;
//     the rule before the card (`k===1?TIP:MIN`) FAILs;
//   - HELPER_HOST, the mainnet pool: POST /v1/pool/solana/pieces of a "tight" plant, a tag 2 and a tag 3 of one
//     throwaway W, each setting a priority fee 1,000 lamports under its relay fee's priority budget (the kit's
//     solanaPoolPriorityBudget at the published fee and mainnet's rent, read on two public RPCs), its blockhash one no
//     cluster made. Each transaction passes the one-piece checks, so the helper reaches its reads and refuses the
//     blockhash: 422 blockhash_not_found (simulation_failed when a provider replaces it). The helper before the card
//     paid a tip of its own out of the pieces' relay fees and refused this plant before any read, 422 fee_below_cost
//     ("the relay fees pay no tip Jito takes"): FAIL. Nothing is sent and the fee payer signs nothing.
// It does not prove a buy lands: only a mainnet buy of several pieces does, read back on two RPCs.
// After: sign helper
//   node scripts/live-checks/owners-solana-buy-lands.mjs [--record <file>] [--answer <file>]
//   PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readSolanaRent, solanaJsonRpc, solanaPoolPriorityBudget } from "../../packages/kit/src/index.ts";
import { plant } from "./pool-senders-next-page-helper.mjs";

const KEY = "owners-solana-buy-lands";
export const SIGN = "https://confidential.unrealized.trade";
export const HELPER = "https://ct-api.unrealized.trade";
const RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
/** The mainnet pool, from its deploy record (contracts/pool-solana/deployments/mainnet.json). */
export const mainnetPool = () => {
  const r = JSON.parse(readFileSync(new URL("../../contracts/pool-solana/deployments/mainnet.json", import.meta.url), "utf8"));
  if (r?.cluster !== "mainnet" || !B58.test(r?.pool ?? "")) throw new Error("contracts/pool-solana/deployments/mainnet.json names no mainnet pool");
  return r.pool;
};
const ID = "[A-Za-z_$][\\w$]*";
const DEC = /^(0|[1-9]\d*)$/;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** The plant's CU limit (pool-senders-next-page-helper.mjs plant: 400,000). */
const CU = 400_000n;
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const json = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

/** The kit's tip rule as the bundle holds it: one tip for every count (`tip`), or the rule before the card (`byCount`). */
export function tipRule(js) {
  const f = new RegExp(`function ${ID}\\((${ID}),(${ID})\\)\\{if\\(!Number\\.isSafeInteger\\(\\2\\)\\|\\|\\2<1\\|\\|\\2>\\d+\\)throw Error\\(\`pieces: 1 to \\d+\`\\);return \\1===\`devnet\`\\?0n:(?:(${ID})|\\2===1\\?${ID}:${ID})\\}`).exec(js);
  if (!f) return { found: false };
  if (f[3] === undefined) return { found: true, byCount: true };
  const v = new RegExp(`(?:^|[,;{\\s])(?:var |let |const )?${f[3].replace(/\$/g, "\\$")}=(\\d+)n[,;]`).exec(js);
  return { found: true, byCount: false, tip: v ? v[1] : null };
}

/** The microlamports a CU that make the plant's priority fee 1,000 lamports under `budget` (none when the budget is). */
export const tightPrice = (budget) => (budget > 1_000n ? ((budget - 1_000n) * 1_000_000n) / CU : null);

export async function read(fetchFn = fetch, rentOf = () => readSolanaRent([solanaJsonRpc(RPCS[0]), solanaJsonRpc(RPCS[1])])) {
  const get = async (url, init = {}) => {
    const r = await fetchFn(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000) });
    return { status: r.status, headers: Object.fromEntries(r.headers), body: await r.text() };
  };
  const index = await get(`${SIGN}/`);
  const app = await get(`${SIGN}/app.js`);
  const sign = { index: index.body, sha384: sha384(app.body), rule: tipRule(app.body) };
  const pool = mainnetPool();
  const fee = await get(`${HELPER}/v1/pool/fee?pool=${encodeURIComponent(pool)}`);
  const f = json(fee.body);
  const helper = { pool, fee: { status: fee.status, body: fee.body.slice(0, 2_000) } };
  if (f && DEC.test(f.fee ?? "") && B58.test(f.program ?? "") && B58.test(f.fee_payer ?? "")) {
    const rent = await rentOf();
    const budget = solanaPoolPriorityBudget(rent, BigInt(f.fee));
    const cuPrice = tightPrice(budget);
    helper.budget = String(budget);
    if (cuPrice !== null) {
      const w = generateKeyPairSync("ed25519").privateKey;
      const tx = (kind) => plant({ program: f.program, pool, feePayer: f.fee_payer, relayFee: BigInt(f.fee), kind, w, nullifier: Uint8Array.from([0, ...randomBytes(31)]), cuPrice }).toString("base64");
      const r = await get(`${HELPER}/v1/pool/solana/pieces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pool, txs: [tx("next_tag2"), tx("next_tag3")] }) });
      helper.tight = { status: r.status, commit: r.headers["x-helper-commit"] ?? null, body: r.body.slice(0, 2_000) };
    }
  }
  return { sign, helper };
}

/** The verdict on an answer { sign: { index, sha384, rule }, helper: { pool, fee, budget, tight } }. */
export function judge(a) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.sign?.index ?? "")?.[1];
  say(pin !== undefined && pin === a?.sign?.sha384, `SIGN_HOST's served /app.js is the one index.html pins: ${pin ? pin === a?.sign?.sha384 : "no pin"}`);
  const rule = a?.sign?.rule ?? {};
  const tip = typeof rule.tip === "string" && /^\d{1,19}$/.test(rule.tip) ? BigInt(rule.tip) : null;
  say(rule.found === true && rule.byCount === false && tip !== null && tip > 1_000n && tip <= 1_000_000n, rule.found !== true ? "the kit's tip rule is not read in /app.js" : rule.byCount ? "the tip rule tips by the count of pieces (the rule before card owners-solana-buy-lands)" : `every mainnet set tips ${tip ?? "an unread tip"} lamports`);
  const t = a?.helper?.tight;
  const code = json(t?.body ?? "")?.error?.code;
  say(t !== undefined && t.status === 422 && (code === "blockhash_not_found" || code === "simulation_failed"), t === undefined ? "the tight plant was not sent (no fee answer, or no budget)" : `the tight plant of 2 pieces answers ${t.status} ${String(t.body).slice(0, 120)} (want 422 blockhash_not_found or simulation_failed; fee_below_cost is the helper before the card)`);
  say(/^[0-9a-f]{40}$/.test(t?.commit ?? ""), `X-Helper-Commit: ${t?.commit ?? "none"}`);
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
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
