#!/usr/bin/env node
// Live check of card vault-late-send-carried on SIGN_HOST (https://confidential.unrealized.trade). What it can show is
// only that the rule shipped in SIGN_HOST's bundle: no account of ours holds money under a vault deposit id a lost store
// named, and nobody on the team moves real money, so a carry itself is never run here. What it holds, signed out, and
// only that: the served /app.js is the one index.html pins (its sha384), and in it, as minified:
//   - reread: step 7's re-reads (the wallet's rereadOnOpen) read each id by asset on both providers, each provider's
//     amount kept (held), never one state from the stronger of two;
//   - rule: a late send is taken (lateFound) only as the vault's token with both providers' amounts equal and above 0;
//     a failed read, two apart, or an asset inside intents.near is a reason, never an amount;
//   - wired: the restore's step 5 reads the vault's deposit ids after the pools' (readVaultLate), and each re-read's
//     late send of at least MIN_DEPOSIT gets its deposit note from that rule's two amounts (own.found: planFound) before
//     its carry;
//   - carry: the carry binds from U (bindDeposit) with every wait ending its seed phase, and a carry that ends anything
//     but deposited is a reason named.
// What each does is held by the card's tests (packages/wallet/test/restore-id-reader.test.ts "step 7's late send",
// packages/signpage/test/pool-restore.test.ts "vault-late-send-carried") and its mutants
// (packages/wallet/scripts/restore-wallets-mutants.mjs).
// The recorded answers are facts() over SIGN_HOST's index.html and /app.js: good, this card's build (--site
// packages/signpage); bad, SIGN_HOST as served before the card.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/vault-late-send-carried.mjs [--site <dir>] [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "vault-late-send-carried";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const N = "[\\w$]+";
const Q = "`";
const esc = (n) => n.replace(/[$]/g, "\\$");
// rereadOnOpen: from its plan check to the held read of each re-read id
const REREAD = new RegExp(
  `throw Error\\(${Q}plan: not the restore's \\(its block is not the pass's\\)${Q}\\);[^]{0,400}?for\\(let (${N}) of ${N}\\.rereads\\)try\\{${N}\\.push\\(\\{lane:\\1\\.lane,i:\\1\\.i,id:\\1\\.id,held:await ${N}\\(\\1\\.id\\)\\}\\)\\}catch`,
);
// lateFound: a failed read is a reason; each asset's two amounts equal, the token's above 0 the only amount taken
const RULE = new RegExp(
  `function (${N})\\((${N}),(${N})\\)\\{if\\(${Q}error${Q}in \\2\\)return\\{found:null,why:\\[\\{text:${Q}its read failed \\(\\$\\{\\2\\.error\\}\\): read again${Q},retry:!0\\}\\]\\};` +
    `let (${N})=null,(${N})=\\[\\];for\\(let\\{asset:(${N}),amounts:\\[(${N}),(${N})\\]\\}of \\2\\.held\\)\\7===\\8\\?\\6===\\3\\?\\7>0n&&\\(\\4=\\[\\7,\\8\\]\\):\\5\\.push\\(\\{text:${Q}[^${Q}]*inside intents\\.near[^${Q}]*${Q},retry:!1\\}\\):\\5\\.push\\(\\{text:${Q}[^${Q}]*on NEAR's two providers, read apart: read again${Q},retry:!0\\}\\);return\\{found:\\4,why:\\5\\}\\}`,
);
// readVaultLate: the rule's two amounts, MIN_DEPOSIT, then planFound before the carry
const TAKEN = (rule) => new RegExp(`\\{found:(${N}),why:(${N})\\}=${esc(rule)}\\((${N}),(${N})\\);[^]{0,200}?if\\(\\1===null\\|\\|\\1\\[0\\]<${N}\\.MIN_DEPOSIT\\)continue;`);
const WRITES = (found) => new RegExp(`try\\{await (${N})\\.found\\((${N})\\.scope,(${N})\\.i,${esc(found)}\\)\\}catch`);
const CARRIED = new RegExp(`let (${N})=await ${N}\\(\\{scope:${N}\\.scope,i:${N}\\.i,noteId:${N}\\.id,amount:${N}\\[0\\]\\},${N}\\);\\1!==null&&\\(\\1\\.retry\\?`);
// step 5's try: the vault's ids read after the pools' (readDepositIds' end), a throw a reason by the vault's label
const STEP5 = new RegExp(`(${N})!==null&&await (${N})\\([^)]*\\1\\.v,[^)]*\\1\\.notesAt,\\1\\.carry\\)\\.catch\\((${N})=>\\{if\\(${N}\\.aborted\\|\\|\\3 instanceof ${N}\\)throw \\3;${N}\\.retry\\.push\\(${Q}\\$\\{\\1\\.v\\.label\\}: its deposit ids' read did not finish`);
// the carry: bindDeposit with every wait thrown (the seed phase ends), deposited alone null
const CARRY = new RegExp(`onWait:\\((${N}),(${N})\\)=>\\{throw new (${N})\\(\\1,\\2\\?\\?1e3\\)\\}\\}\\)\\);return (${N})\\.kind===${Q}deposited${Q}\\?null:`);
const once = (re, js) => [...js.matchAll(new RegExp(re.source, "g"))].length === 1;

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  const rule = once(RULE, js) ? RULE.exec(js) : null;
  const taken = rule && once(TAKEN(rule[1]), js) ? TAKEN(rule[1]).exec(js) : null;
  return {
    index,
    sha384: sha384(js),
    reread: once(REREAD, js),
    rule: !!rule,
    wired: !!taken && once(WRITES(taken[1]), js) && once(CARRIED, js) && once(STEP5, js),
    carry: once(CARRY, js),
  };
}

export const WHY = Object.freeze({
  reread: "step 7's re-reads take one state from the stronger of two providers, not each provider's amount by asset",
  rule: "a late send is taken on one provider's read, two apart, or as an asset that is not the vault's token",
  wired: "the restore never reads the vault's deposit ids, or carries a late send with no note written from two agreeing amounts",
  carry: "a late send's carry holds the seed across a wait, or a carry that did not land is not named",
});

/** The verdict on an answer { index, sha384, reread, rule, wired, carry }. */
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
    const site = arg("--site");
    const answer = arg("--answer")
      ? JSON.parse(readFileSync(arg("--answer"), "utf8"))
      : site
        ? facts(readFileSync(`${site}/index.html`, "utf8"), readFileSync(`${site}/public/app.js`, "utf8"))
        : await read();
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
