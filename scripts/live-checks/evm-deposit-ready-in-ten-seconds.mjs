#!/usr/bin/env node
// Live check of card evm-deposit-ready-in-ten-seconds: a Base or Robinhood deposit on SIGN_HOST
// (https://confidential.unrealized.trade) is spendable within 10 s of its block. Before this card the Base mainnet copy
// read ready 12.67 s = seen 5.6 s + pass 2.7 s + prove 4.4 s (ep2-final, 15:45Z): the deposit's verdict read U's nonce
// at the newest block and that block's finality (4 host answers in a row, 3.6 s) before the round that held the
// Deposited. What the verdict does is held by packages/signpage/test/pool-deposit-evm.test.ts (card
// evm-deposit-ready-in-ten-seconds tests); this check holds that SIGN_HOST serves that code. It passes only when
// SIGN_HOST's served /app.js is the one its index.html pins (its sha384), and in it, as minified, each exactly once:
//   - first (src/pool-deposit-evm.ts verdictOf): the verdict reads the round first and a note its Deposited names is
//     landed there, before any read of U's nonce (`n.evmSpent`), so a landed send waits on the round alone;
//   - guard (verdictOf): a send is dead only at a block the round's final events reach (`spent!==null&&
//     round.finalBlock>=spent`), the rule that makes the nonce read after the round safe.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/evm-deposit-ready-in-ten-seconds.mjs [--local] [--record <file>]
//   PASS exit 0, FAIL 1, error 2. --local judges this tree's SIGN_HOST build (signBuilt) in SIGN_HOST's place; --record
//   writes what the run read, which evm-deposit-ready-in-ten-seconds.test.mjs replays. Reads only.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signBuilt } from "../signpage-built.mjs";

export const KEY = "evm-deposit-ready-in-ten-seconds";
export const SIGN = "https://confidential.unrealized.trade";

const N = "[\\w$]+";
const count = (re, js) => [...js.matchAll(new RegExp(re.source, "g"))].length;
const once = (re, js) => count(re, js) === 1;
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** verdictOf's start: `e.keys.push(a.secretKey);let o=await e.h.round(),s=aF(e.seed,e.scope,o.events,r,o.finalBlock);
 *  if(s.taken.some(e=>MI(e.ref,t.ref))){...return{kind:\`landed\`,...}}if(i===void 0)return{kind:\`dead\`};let c=t.evmSpent!==void 0`. */
const FIRST = new RegExp(`\\.keys\\.push\\((${N})\\.secretKey\\);let (${N})=await (${N})\\.h\\.round\\(\\),(${N})=${N}\\(\\3\\.seed,\\3\\.scope,\\2\\.events,${N},\\2\\.finalBlock\\);if\\(\\4\\.taken\\.some\\([^]{0,200}?return\\{kind:\`landed\`,[^]{0,120}?\\}\\}if\\((${N})===void 0\\)return\\{kind:\`dead\`\\};let ${N}=(${N})\\.evmSpent!==void 0`);
/** The dead guard: `u!==null&&o.finalBlock>=u)return{kind:\`dead\`}`. */
const GUARD = new RegExp(`(${N})!==null&&(${N})\\.finalBlock>=\\1\\)return\\{kind:\`dead\`\\}`);

/** What the check keeps of SIGN_HOST's build: its pin and sha384, and each part found exactly once. */
export function pageFacts(index, js) {
  return {
    pin: /src="\/app\.js" integrity="([^"]+)"/.exec(index)?.[1] ?? null,
    sha384: sha384(js),
    first: once(FIRST, js),
    guard: once(GUARD, js),
  };
}

/** SIGN_HOST's index and /app.js through `fetchFn`: { from, page }. */
export async function readBundle(fetchFn = fetch) {
  const get = async (p) => {
    const r = await fetchFn(`${SIGN}${p}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`SIGN_HOST ${p}: HTTP ${r.status}`);
    return r.text();
  };
  return { from: SIGN, page: pageFacts(await get("/"), await get("/app.js")) };
}

/** The verdict on { page }: { ok, verdict, lines }. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const p = run?.page;
  say(typeof p?.pin === "string" && p.pin === p.sha384, `[SIGN_HOST] the served /app.js is the one index.html pins: ${p?.pin ?? "no pin"}`);
  say(p?.first === true, "[SIGN_HOST] a deposit's verdict reads the round first and lands its note there, before any read of U's nonce (first)");
  say(p?.guard === true, "[SIGN_HOST] a send is dead only at a block the round's final events reach (guard)");
  const verdict = lines.some((l) => l.startsWith("BAD")) ? "FAIL" : "PASS";
  return { ok: verdict === "PASS", verdict, lines };
}

/** SIGN_HOST's index and /app.js, or this tree's build with `local`. */
export async function read(fetchFn = fetch, { local = false } = {}) {
  const page = local ? pageFacts(readFileSync(path.join(signBuilt(), "index.html"), "utf8"), readFileSync(path.join(signBuilt(), "public/app.js"), "utf8")) : (await readBundle(fetchFn)).page;
  return { readAt: new Date().toISOString(), from: local ? "local build" : SIGN, page };
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const a = process.argv.slice(2);
  try {
    const run = await read(fetch, { local: a.includes("--local") });
    if (a.includes("--record")) writeFileSync(a[a.indexOf("--record") + 1], `${JSON.stringify(run, null, 1)}\n`);
    const { verdict, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${verdict}`);
    process.exit(verdict === "PASS" ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
