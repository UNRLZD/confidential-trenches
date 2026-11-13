#!/usr/bin/env node
// Live check of card trades-and-balance-fast on SIGN_HOST (https://confidential.unrealized.trade). The owner's Solana
// sale of 13 Nov 18:05:39Z (W 3RrvTxXabDkApBYNuKijcNJDMkVVkkHcG1qR3sLVEQfn, pool 7ijWvp3xEk5yUfGYQJfgoabReCTpSyZhiWjmCt3TQDz8,
// read on api.mainnet-beta.solana.com and solana-rpc.publicnode.com) closed W's accounts at 18:05:45Z and swept W into
// the pool at 18:05:49Z, each step read back a second apart, and the sweep's note stayed INCOMING until a later state
// read: the balance showed the sale's SOL only when something else asked the state. What it holds, signed out, and only
// that: the served /app.js is the one index.html pins (its sha384), and in it, as minified:
//   - pace: a sale, its teardown frames and a partial sale's sweep are read back at a slot's pace (400 ms), within the
//     same wall-clock budget (120 x 1 s, read 400 ms apart);
//   - gate: a sent note's settle (its mark at finalized) is asked once both RPCs' finalized slot reaches the send's, the
//     wait between those reads the gap at a slot's time each, at most the buy's longest;
//   - follow: a full sale's sweep, once sent, is followed to its note's end with the sell lock let go first, so the
//     note's move to UNSPENT is the store change the page's state follows;
//   - landed: a sale is told filled once every leg reads back on both RPCs as its very transaction, succeeded (a sale
//     with a deposit back waited for its note's mark to be final), once, and a share left short at its end as before.
// That a pool sale lands and fills on mainnet is pool-sol-mainnet-run's live check.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/trades-and-balance-fast.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "trades-and-balance-fast";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const Q = "[`\"']";
const V = "[\\w$]+";
// POOL_SELL_WAIT_MS 1e3, POOL_SELL_POLL_MS 400, and the read count that keeps the 120 s budget at that pace
const PACE = new RegExp(`(${V})=1e3,(${V})=400,${V}=120\\*\\1\\/\\2[,;]`);
// settleGate: both RPCs' finalized slot against the send's, the gap at a slot's time each, at most the buy's longest wait
const GATE = new RegExp(
  `${Q}getSlot${Q},\\[\\{commitment:${Q}finalized${Q}\\}\\]\\)\\)\\)\\.then\\(${V}=>${V}\\.map\\(${V}=>${V}\\(${V}\\)\\),\\(\\)=>null\\);if\\(${V}===null\\)return 0;let (${V})=Math\\.max\\(${V}\\[0\\]-${V}\\[0\\],${V}\\[1\\]-${V}\\[1\\]\\);return \\1>0\\?Math\\.min\\(\\1\\*${V},${V}\\):0`,
);
// the sweep sent, the sell lock let go, then its note followed through the gate
const FOLLOW = new RegExp(`\\((${V})\\.one\\.signed,\\1\\.one\\.signature\\),${V}\\?\\.release\\(\\);let ${V}=0;return await ${V}\\(${V}\\(${V},\\1\\.one\\.signature,\\1\\.one\\.signed\\)`);

// the kind's landed hook: every leg landed, not short, told filled once
const LANDED = new RegExp(
  `landed:(${V})=>\\{(${V})\\.add\\(\\1\\),(${V})===null&&(${V})\\.short!==!0&&\\4\\.legs!==void 0&&\\4\\.legs\\.length>0&&\\2\\.size===\\4\\.legs\\.length&&\\(\\3=${Q}filled${Q},${V}\\.progress\\(${Q}filled${Q}\\)\\)\\}`,
);

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  return { index, sha384: sha384(js), pace: PACE.test(js), gate: GATE.test(js), follow: FOLLOW.test(js), landed: LANDED.test(js) };
}

export const NO_PACE = "BAD a sale's read-backs are not at a slot's pace (400 ms) within the 120 s budget";
export const NO_GATE = "BAD a sent note's settle is not held to both RPCs' finalized slot reaching the send's";
export const NO_FOLLOW = "BAD a full sale's sweep is not followed to its note's end once sent";
export const NO_LANDED = "BAD a sale is not told filled once every leg reads back landed on both RPCs";

/** The verdict on an answer { index, sha384, pace, gate, follow, landed }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(m.startsWith("BAD ") ? m : `BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.pace !== true) bad(NO_PACE);
  if (a?.gate !== true) bad(NO_GATE);
  if (a?.follow !== true) bad(NO_FOLLOW);
  if (a?.landed !== true) bad(NO_LANDED);
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
