#!/usr/bin/env node
// Live check of card notes-plan-at-restored-index on SIGN_HOST (https://confidential.unrealized.trade). What it can show
// is only that the rule shipped in SIGN_HOST's bundle: no account of ours holds money at a one-time account a lost store
// named, and nobody on the team moves real money, so a carry itself is never run here. What it holds, signed out, and
// only that: the served /app.js is the one index.html pins (its sha384), and in it, as minified:
//   - rule: the note store's planFound checks the restore's read first (an object of the index's scope and index, two
//     bigint balances, the two equal, above 0): one provider's word, two apart, or a read of no money is refused;
//   - held: planFound refuses an index the store holds a note at;
//   - counter: planFound refuses an index of the store's lane its scope's counter has not passed (none, or next <= i);
//   - funded: planDeposit leaves every note planFound marked (meta owed/found-deposits) out of the scope's one unfunded
//     index, so the sign-in's planned index is still the one a quote names;
//   - wired: restore step 5's `found` opens the note store under the seed's use and calls planFound with the seed's
//     precommitment and the carry's two balances, and the U_X carry hands it, for an index with no note here, in place
//     of naming it (the carry's own shape is wallet-restore-reads-ux's ux_carry).
// What each does is held by the card's tests (packages/wallet/test/note-store-found.test.ts, packages/signpage/test/
// pool-restore.test.ts, pool-deposit.test.ts and pool-deposit-evm.test.ts "notes-plan-at-restored-index") and by its
// mutants (packages/wallet/scripts/restore-wallets-mutants.mjs).
// The recorded answers are facts() over SIGN_HOST's index.html and /app.js: good, this card's build; bad, SIGN_HOST as
// served before the card.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/notes-plan-at-restored-index.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "notes-plan-at-restored-index";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const N = "[\\w$]+";
const Q = "`";
const esc = (n) => n.replace(/[$]/g, "\\$");
// the read rule, by its own words and shape
const RULE = new RegExp(
  `function (${N})\\((${N}),(${N}),(${N})\\)\\{if\\(typeof \\2!=${Q}object${Q}\\|\\|!\\2\\)throw Error\\(${Q}a found read is an object${Q}\\);let (${N})=\\2;` +
    `if\\(\\5\\.s!==\\3\\|\\|\\5\\.i!==\\4\\)throw Error\\(${Q}the found read is not of deposit index [^${Q}]*${Q}\\);let (${N})=\\5\\.amounts;` +
    `if\\(!Array\\.isArray\\(\\6\\)\\|\\|\\6\\.length!==2\\|\\|!\\6\\.every\\((${N})=>typeof \\7==${Q}bigint${Q}\\)\\)throw Error\\(${Q}a found read holds two providers' balances${Q}\\);` +
    `if\\(\\6\\[0\\]!==\\6\\[1\\]\\)throw Error\\(${Q}[^${Q}]*: no agreed balance${Q}\\);if\\(\\6\\[0\\]<=0n\\)throw Error\\(${Q}the two providers read no money${Q}\\)\\}`,
);
// planFound: its head checks the read by that rule, then (in its body, up to its end) under the notes lock refuses a
// held index and, in the store's lane, one its counter has not passed, and writes the mark before the note
const HEAD = (rule) =>
  new RegExp(`async planFound\\((${N}),(${N}),(${N}),(${N})\\)\\{return ${N}\\(\\1,${Q}scope${Q}\\),${N}\\(\\2,${Q}deposit index${Q}\\),${esc(rule)}\\(\\4,\\1,\\2\\),${N}\\(async\\(\\)=>\\{let (${N})=await ${N}\\(\\),(${N})=\\{kind:${Q}deposit${Q},s:\\1,i:\\2\\},(${N})=(${N})\\(\\6\\);`);
const HELD = (h) => new RegExp(`^if\\(${esc(h[5])}\\.some\\((${N})=>${esc(h[8])}\\(\\1\\.ref\\)===${esc(h[7])}\\)\\)throw Error\\(${Q}deposit index \\$\\{${esc(h[2])}\\} of scope \\$\\{${esc(h[1])}\\} is already a note${Q}\\);`);
const COUNTER = (h) =>
  new RegExp(`if\\(${esc(h[2])}%8===(${N})\\.lane\\)\\{let (${N})=await \\1\\.get\\(${Q}counters${Q},${Q}i/\\$\\{${esc(h[1])}\\.toString\\(\\)\\}${Q}\\);if\\(\\2===void 0\\|\\|!\\(\\2\\.next>${esc(h[2])}\\)\\)throw Error\\(${Q}[^${Q}]*is not under the scope's counter`);
const MARKED = (h) => new RegExp(`await (${N})\\.update\\(${Q}meta${Q},(${N}),[^]*?\\),await ${N}\\(${N}\\),${N}\\}\\)\\}`);
// the mark's key, and planDeposit's one unfunded index leaving each marked note out
const MARK = (k) => new RegExp(`[,; ]${esc(k)}=${Q}owed/found-deposits${Q}`);
const UNFUNDED = (k) =>
  // (card restore-shows-a-note-on-a-planned-index: the skip set read beside it and left out after it, optional)
  new RegExp(`(${N})=(${N})\\(await ${N}\\.get\\(${Q}meta${Q},${esc(k)}\\)\\),(?:${N}=${N}\\(await ${N}\\.get\\(${Q}meta${Q},${N}\\)\\),)?(${N})=${N}\\.filter\\((${N})=>\\4\\.ref\\.kind===${Q}deposit${Q}&&\\4\\.scope===${N}&&\\4\\.state===${Q}PLANNED${Q}&&!\\1\\.has\\(${N}\\(\\4\\.ref\\)\\)(?:&&!${N}\\.has\\(${N}\\(\\4\\.ref\\)\\))?\\);if\\(\\3\\.length>1\\)throw Error`);
// step 5's `found`: the note store opened under the seed's use, planFound with the seed's precommitment and the balances
const WIRED = new RegExp(
  `found:\\((${N}),(${N}),(${N})\\)=>${N}\\(async (${N})=>\\{let (${N})=await ${N}\\(await ${N}\\.store\\(\\)\\);try\\{await \\5\\.planFound\\(\\1,\\2,(${N})=>${N}\\(\\4,\\6\\)\\.precommitment,\\{s:\\1,i:\\2,amounts:\\3\\}\\)\\}finally\\{\\5\\.close\\(\\)\\}\\}\\)`,
);
// the carry handed it for an index with no note here, with the carry's two balances
const HANDED = new RegExp(`${N}\\.has\\((${N})\\.i\\)\\|\\|\\((${N})=>${N}\\.found\\((${N})\\.scope,\\1\\.i,\\2\\)\\)`);
const CARRY_WRITES = new RegExp(`typeof (${N})==${Q}function${Q}\\)\\{try\\{await \\1\\(\\[(${N}),(${N})\\]\\)\\}catch`);
const once = (re, js) => [...js.matchAll(new RegExp(re.source, "g"))].length === 1;

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  const rule = once(RULE, js) ? RULE.exec(js) : null;
  const head = rule && once(HEAD(rule[1]), js) ? HEAD(rule[1]).exec(js) : null;
  // planFound's body: from its head to the end of the method (the next method or function after it)
  const body = head ? js.slice(head.index + head[0].length, head.index + head[0].length + 1_500) : "";
  const marked = head ? MARKED(head).exec(body) : null;
  const key = marked?.[2] ?? null;
  return {
    index,
    sha384: sha384(js),
    rule: !!rule && !!head,
    held: !!head && HELD(head).test(body),
    counter: !!head && COUNTER(head).test(body),
    funded: key !== null && once(MARK(key), js) && once(UNFUNDED(key), js),
    wired: once(WIRED, js) && once(HANDED, js) && once(CARRY_WRITES, js),
  };
}

export const WHY = Object.freeze({
  rule: "planFound takes a read that is not two providers agreeing on money (one provider's word, two apart, none)",
  held: "planFound writes a deposit note at an index the store holds",
  counter: "planFound writes a deposit note at an index of the store's lane its counter has not passed",
  funded: "a found deposit note is counted as the scope's unfunded index (planDeposit names it, or throws on two)",
  wired: "restore step 5 never writes a found deposit note: a U_X with no note here is named, not carried",
});

/** The verdict on an answer { index, sha384, rule, held, counter, funded, wired }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  for (const [k, why] of Object.entries(WHY)) if (a?.[k] !== true) bad(why);
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
