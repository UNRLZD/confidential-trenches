#!/usr/bin/env node
// Live check of card restore-shows-a-note-on-a-planned-index on SIGN_HOST (https://confidential.unrealized.trade).
// What it holds, signed out, and only that: the served /app.js is the one index.html pins (its sha384), and in it, as
// minified:
//   - store: the note store refuses to mark a deposit index TAKEN once it is in meta owed/quoted-deposits (the wallet's
//     notes/store.ts move); its skipUsed leaves a note not PLANNED, or a quoted, found or already skipped index, as it
//     is, and otherwise only puts the index in meta owed/skipped-deposits and writes the note again as it is (never
//     TAKEN); and planDeposit leaves a skipped index out of the scope's one unfunded index, so the page names a fresh one;
//   - marks: deposit.quote and pool.address mark U's index quoted (`quoted`, before anything of U leaves: no address, no
//     plain send, no 1Click ask before it), and the page hands every one of its four quote hosts the one mark, the note
//     store's markQuoted under the seed lock shared (src/main.ts quotedIndex);
//   - skip: restore step 5 reads every id through one `skipping` reader, whose "used" answer goes to own.skip, the note
//     store's skipUsed under the run's seed use, on the pools' two reads and the vault's one (src/pool-restore.ts).
// What each does is held by the card's tests (packages/wallet/test/note-store.test.ts Q1,
// packages/signpage/test/pool-deposit-address.test.ts Q2, deposit-wire.test.ts Q3, pool-restore.test.ts Q4, P2 and the
// vault's). The
// recorded answers are facts() over each tree's packages/signpage/index.html and public/app.js.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/restore-shows-a-note-on-a-planned-index.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "restore-shows-a-note-on-a-planned-index";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const ID = "[\\w$]+";
// the move: a deposit index in the quoted set is never TAKEN
const REFUSES = new RegExp(`if\\(${ID}===\`TAKEN\`&&(${ID})\\.ref\\.kind===\`deposit\`&&(${ID})\\(await ${ID}\\.get\\(\`meta\`,\`owed/quoted-deposits\`\\)\\)\\.has\\(${ID}\\(\\1\\.ref\\)\\)\\)throw`);
// the skip set's meta key, bound to a name skipUsed writes and planDeposit reads
const SKIPPED = new RegExp(`(?:var |,)(${ID})=\`owed/skipped-deposits\``);
// skipUsed: a note not PLANNED, or a quoted, found or skipped index, is returned as it is; else the index goes in the skip
// set and the note is written again as it is, and nothing else (no move, no TAKEN)
const skipsOf = (k) => new RegExp(`skipUsed\\(${ID},${ID}\\)\\{return ${ID}\\(${ID},\`scope\`\\),${ID}\\(${ID},\`deposit index\`\\),${ID}\\(async\\(\\)=>\\{let (${ID})=${ID}\\(\\{kind:\`deposit\`,s:${ID},i:${ID}\\}\\),(${ID})=\\(await ${ID}\\(\\)\\)\\.find\\(${ID}=>${ID}\\(${ID}\\.ref\\)===\\1\\);if\\(\\2===void 0\\|\\|\\2\\.state!==\`PLANNED\`\\|\\|${ID}\\(await ${ID}\\.get\\(\`meta\`,\`owed/quoted-deposits\`\\)\\)\\.has\\(\\1\\)\\|\\|${ID}\\(await ${ID}\\.get\\(\`meta\`,\`owed/found-deposits\`\\)\\)\\.has\\(\\1\\)\\|\\|${ID}\\(await ${ID}\\.get\\(\`meta\`,\`owed/skipped-deposits\`\\)\\)\\.has\\(\\1\\)\\)return \\2;if\\(${ID}\\)throw Error\\(\`the note store is closed\`\\);return await ${ID}\\.update\\(\`meta\`,${k},${ID}=>Object\\.fromEntries\\(\\[\\.\\.\\.${ID}\\(${ID}\\),\\1\\]\\.map\\(${ID}=>\\[${ID},!0\\]\\)\\)\\),await ${ID}\\(\\2\\),\\2\\}\\)\\}`);
// planDeposit: the scope's one unfunded index leaves out a found index and a skipped one
const plansOf = (k) => new RegExp(`planDeposit\\(${ID},${ID}\\)\\{return ${ID}\\(${ID},\`scope\`\\),${ID}\\(async\\(\\)=>\\{let (${ID})=await ${ID}\\(\\),(${ID})=${ID}\\(await ${ID}\\.get\\(\`meta\`,${ID}\\)\\),(${ID})=${ID}\\(await ${ID}\\.get\\(\`meta\`,${k}\\)\\),${ID}=\\1\\.filter\\(${ID}=>${ID}\\.ref\\.kind===\`deposit\`&&${ID}\\.scope===${ID}&&${ID}\\.state===\`PLANNED\`&&!\\2\\.has\\(${ID}\\(${ID}\\.ref\\)\\)&&!\\3\\.has\\(${ID}\\(${ID}\\.ref\\)\\)\\)`);
// the hosts: deposit.quote's mark on the record's index, pool.address's on U_X's, each before anything else of U
const VAULT_MARK = new RegExp(`if\\(!(${ID})\\)return;if\\(await ${ID}\\.quoted\\(${ID},\\1\\.deposit\\.index\\),${ID}\\(\\)\\)return void\\(${ID}=\\{error:\`not_allowed\`\\}\\);let ${ID}=${ID}\\.refund===void 0`);
const POOL_MARK = new RegExp(`if\\(!(${ID})\\)return;if\\(await ${ID}\\.quoted\\(${ID}\\.scope,\\1\\.record\\.index\\),${ID}\\(\\)\\)return void\\(${ID}=\\{error:\`not_allowed\`\\}\\);if\\(!${ID}\\)return void\\(${ID}=\\{result:\\{chain:${ID},address:\\1\\.wallet`);
// the page's one mark: the note store's markQuoted under the seed lock shared, handed to every quote host
const MARKER = new RegExp(`(${ID})=\\((${ID}),(${ID})\\)=>navigator\\.locks\\.request\\(${ID},\\{mode:\`shared\`\\},async\\(\\)=>\\{let (${ID})=await ${ID}\\(await ${ID}\\(\\)\\);try\\{await \\4\\.markQuoted\\(\\2,\\3\\)\\}finally\\{\\4\\.close\\(\\)\\}\\}\\)`);
// restore step 5: one reader whose "used" answer goes to own.skip, which is the note store's skipUsed under the run's seed use
const SKIPPING = new RegExp(`(${ID})=\\((${ID}),(${ID}),(${ID})\\)=>async\\((${ID}),(${ID})\\)=>\\{let (${ID})=await \\4\\(\\5,\\6\\);return \\7===\`used\`&&\\6!==void 0&&await \\2\\.skip\\(\\3,\\6\\),\\7\\}`);
const SKIP = new RegExp(`skip:\\((${ID}),(${ID})\\)=>${ID}\\(async\\(\\)=>\\{let (${ID})=await ${ID}\\(await ${ID}\\.store\\(\\)\\);try\\{await \\3\\.skipUsed\\(\\1,\\2\\)\\}finally\\{\\3\\.close\\(\\)\\}\\}\\)`);
const esc = (name) => name.replace(/[$]/g, "\\$");

/** The skip set's rules in the note store: skipUsed writes only the set, planDeposit leaves it out. */
function skips(js) {
  const k = SKIPPED.exec(js)?.[1];
  return k !== undefined && skipsOf(esc(k)).test(js) && plansOf(esc(k)).test(js);
}

/** How many of step 5's reads go through the skipping reader: the pools' two and the vault's one. */
function skipped(js) {
  const m = SKIPPING.exec(js);
  if (!m) return 0;
  return (js.match(new RegExp(`[^\\w$]${esc(m[1])}\\(${ID},${ID}\\.scope,${ID}\\)`, "g")) ?? []).length;
}

/** The name the page's mark is bound to, and how many hosts it is handed to (`quoted:<name>`). */
function handed(js) {
  const m = MARKER.exec(js);
  if (!m) return 0;
  return (js.match(new RegExp(`[{,]quoted:${esc(m[1])}[,}]`, "g")) ?? []).length;
}

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  return {
    index,
    sha384: sha384(js),
    store: REFUSES.test(js) && skips(js),
    marks: VAULT_MARK.test(js) && POOL_MARK.test(js) && handed(js) >= 4,
    skip: skipped(js) >= 3 && SKIP.test(js),
  };
}

/** The verdict on an answer { index, sha384, store, marks, skip }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.store !== true) bad("the note store can mark a deposit index TAKEN on a restore's read, or names an index read used again: an address can go dead or be reused");
  if (a?.marks !== true) bad("an address or a quote leaves before its index is marked quoted: a restore can mark it dead");
  if (a?.skip !== true) bad("restore step 5 does not skip an index whose id reads used on every path (the pools' and the vault's): the page names a used id again");
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
