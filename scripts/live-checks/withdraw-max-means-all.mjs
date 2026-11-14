#!/usr/bin/env node
// Live check of card withdraw-max-means-all on SIGN_HOST (https://confidential.unrealized.trade): on the withdraw forms
// Max is an intent, not a number, and a typed amount the notes cannot pay exactly sends the nearest payable amount at or
// below it, shown before the press; no Try. Reads only: nothing is signed or sent. What it holds, and only that: SIGN_HOST
// serves the script its index.html pins (its sha384), and, each found by a mark of the minified bundle's shape
// (packages/signpage/src/withdraw/pool-form.ts, form.ts, checks.ts):
//   - poolMax: the pool form, Max tapped, puts the live Max in the box after every funds read until an amount is typed
//     (the owner's Base withdraw at 03:15Z: a fee re-read moved Max and the old number was refused);
//   - poolPress: the pool form's press under Max hands over the live Max at a Max fee no higher than the one drawn, any
//     other amount only exactly as drawn;
//   - poolPayable: the pool form checks a typed amount as the nearest payable at or below it (Max above all), refusing
//     only one under the least payable, in the Min words;
//   - cashMax, cashPress, cashPayable: the same on the Cash form, whose box is rewritten to the amount it sends.
// The numbers and every refusal are packages/signpage/test/pool-withdraw-form.test.ts, pool-withdraw-sendable.test.ts and
// withdraw-form.test.ts at the released commit. The recorded answers are facts() over
// packages/signpage/scripts/build-app.mjs's build (mainnet, as SIGN_HOST serves) and SIGN_HOST as served before.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/withdraw-max-means-all.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "withdraw-max-means-all";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const N = "[\\w$]+";
const esc = (s) => s.replace(/[$]/g, "\\$");

// the pool form's check: after the read, the live Max in the box while the intent holds
const POOL_MAX = new RegExp(`await ${N},(${N})&&(${N})!==null&&(${N})\\(\\2\\)>0n&&\\((${N})\\.input\\.value=(${N})\\(\\3\\(\\2\\),${N}\\)\\);`);
const POOL_PRESS = new RegExp(`(${N})\\?\\.ready&&\\1\\.ready\\.dest===(${N})\\.dest&&\\1\\.ready\\.to===\\2\\.to&&\\(${N}\\?\\1\\.ready\\.maxFee<=\\2\\.maxFee:\\1\\.ready\\.amount===\\2\\.amount&&\\1\\.ready\\.maxFee===\\2\\.maxFee\\)&&await ${N}\\.handoff\\(\\1\\.ready\\)`);
const POOL_PAYABLE = new RegExp(`function (${N})\\((${N}),(${N}),(${N})\\)\\{let (${N})=(${N})\\(\\2,\\3,\\4\\);if\\(\\5\\.ok\\|\\|\\5\\.code!==\`insufficient\`&&\\5\\.code!==\`unplannable\`\\)return \\5;if\\(\\5\\.below!==void 0\\)\\{let (${N})=\\6\\(\\2,${N}\\(\\5\\.below,${N}\\[\\2\\]\\.decimals\\),\\4\\);if\\(\\7\\.ok\\)return \\7\\}return \\5\\.code===\`unplannable\`&&\\5\\.above!==void 0\\?\\{ok:!1,code:\`min\`,min:\\5\\.above\\}:\\5\\.code===\`insufficient\`\\?\\{ok:!1,code:\`insufficient\`\\}:\\5\\}`);
// the Cash form's check: the live Max in the box while the intent holds, then the amount sent written in the box
const CASH_MAX = new RegExp(`let (${N})=(${N})\\.notes===null\\|\\|\\2\\.fee===null\\?0n:(${N})\\(\\2\\.notes,\\2\\.fee\\);(${N})&&\\1>0n&&\\((${N})\\.input\\.value=(${N})\\(\\1\\)\\);`);
const CASH_BOX = new RegExp(`(${N})\\.ready&&${N}\\((${N})\\.input\\.value\\)!==\\1\\.ready\\.amount&&\\(\\2\\.input\\.value=${N}\\(\\1\\.ready\\.amount\\)\\)`);
const CASH_PRESS = new RegExp(`if\\(!(${N})\\?\\.ready\\|\\|\\1\\.ready\\.recipient!==(${N})\\.recipient\\|\\|\\1\\.ready\\.chain!==\\2\\.chain\\|\\|(${N})\\.fee===null\\|\\|\\(${N}\\?(${N})===null\\|\\|\\3\\.fee>\\4:\\1\\.ready\\.amount!==\\2\\.amount\\|\\|(${N})\\(\\1\\.ready\\)!==\\5\\(\\2\\)\\)\\)return;`);
const CASH_PAYABLE = new RegExp(`function (${N})\\((${N}),(${N})\\)\\{let (${N})=(${N})\\(\\2,\\3\\);if\\(\\4\\.ok\\|\\|\\4\\.code!==\`insufficient\`&&\\4\\.code!==\`unplannable\`\\)return \\4;if\\(\\4\\.below!==void 0\\)\\{let (${N})=\\5\\(${N}\\(\\4\\.below\\),\\3\\);if\\(\\6\\.ok\\)return \\6\\}return \\4\\.code===\`unplannable\`&&\\4\\.above!==void 0\\?\\{ok:!1,code:\`min\`,min:\\4\\.above\\}:\\4\\.code===\`insufficient\`\\?\\{ok:!1,code:\`insufficient\`\\}:\\4\\}`);

/** Max is an intent on a form: the check's rewrite, a typed amount ends it, the tap starts it with the same Max. */
function maxIntent(js, flag, box, tap) {
  if (flag === undefined || box === undefined) return false;
  return js.includes(`${box}.input.addEventListener(\`input\`,()=>{${flag}=!1,`) && new RegExp(`\\(${esc(flag)}=!0,${esc(box)}\\.input\\.value=${tap}`).test(js);
}

/** What the check keeps of the reads: the index, the served bundle's sha384, and the marks read from it. */
export function facts(index, js) {
  const pm = POOL_MAX.exec(js);
  const cm = CASH_MAX.exec(js);
  const pp = POOL_PAYABLE.exec(js);
  const cp = CASH_PAYABLE.exec(js);
  return {
    index,
    sha384: sha384(js),
    poolMax: maxIntent(js, pm?.[1], pm?.[4], pm ? `${esc(pm[5])}\\(${esc(pm[3])}\\(${esc(pm[2])}\\),` : ""),
    poolPress: POOL_PRESS.test(js),
    // the screen's evaluate checks the amount with it
    poolPayable: pp !== null && new RegExp(`(${N})=${N}\\?null:${esc(pp[1])}\\(${N},${N},${N}\\),${N}=${N}\\?\\.ok&&\\1\\?\\.ok\\?Object\\.freeze\\(\\{chain:`).test(js),
    cashMax: maxIntent(js, cm?.[4], cm?.[5], cm ? `${esc(cm[6])}\\(${esc(cm[3])}\\(${esc(cm[2])}\\.notes,${esc(cm[2])}\\.fee\\)\\)` : ""),
    cashPress: CASH_PRESS.test(js),
    cashPayable: cp !== null && CASH_BOX.test(js) && new RegExp(`\\?null:${esc(cp[1])}\\(${N},\\{notes:(${N})\\.notes,fee:\\1\\.fee\\}\\)`).test(js),
  };
}

export const SAYS = Object.freeze({
  poolMax: "the pool form does not keep Max as everything: after a fee or balance re-read the box keeps the old number (the owner's Base withdraw at 03:15Z: refused with Try)",
  poolPress: "the pool form's press under Max does not hand over the live Max at a Max fee no higher than drawn, or hands over any other amount not exactly as drawn",
  poolPayable: "the pool form does not send a typed amount as the nearest payable at or below it: it refuses with Try",
  cashMax: "the Cash form does not keep Max as everything: after the press's re-read the box keeps the old number",
  cashPress: "the Cash form's press under Max does not hand over the live Max at a fee bound no higher than drawn, or hands over any other amount not exactly as drawn",
  cashPayable: "the Cash form does not send a typed amount as the nearest payable at or below it, written in the box: it refuses with Try",
});

/** The verdict on an answer { index, sha384, poolMax, poolPress, poolPayable, cashMax, cashPress, cashPayable }. */
export function judge(a) {
  const lines = [];
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) lines.push("BAD SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) lines.push("BAD SIGN_HOST's served /app.js is not the one index.html pins");
  for (const [k, say] of Object.entries(SAYS)) if (a?.[k] !== true) lines.push(`BAD ${say}`);
  return { ok: lines.length === 0, lines };
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
