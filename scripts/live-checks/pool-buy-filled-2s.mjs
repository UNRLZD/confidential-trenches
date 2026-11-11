#!/usr/bin/env node
// Live check of card pool-buy-filled-2s on SIGN_HOST (https://confidential.unrealized.trade). What it holds, and only
// that: the served /app.js is the one index.html pins (its sha384); and the bundle sends no pool transaction (it never
// names the helper's /v1/pool/solana/send), or, in src/pool-buy.ts sendAndSettle as minified:
//   - one back-off, on the wallet's one rule (packages/wallet/src/throttle.ts throttleWaitMs) with the buy's bounds: a
//     pause doubled from a slot (400 ms) up to 8 s, or the provider's Retry-After when longer, only a finite one above 0,
//     at most 10 s: `g=(e,t)=>nV(e,t instanceof Ly?t.afterMs:null,DV)`, the rule's body and `DV=Object.freeze({firstMs:
//     400,maxMs:EV,afterMaxMs:1e4})` read in the whole bundle;
//   - the read-back's pace starts at a slot and any failed read (a 5xx as a 429) doubles it by that back-off and counts
//     once: `_=400,v=0,y=e=>void(v++,_=g(_,e))`; the settle's own wait starts at a slot and a settle that throws doubles
//     it: `x=400,S={settle:(t,n)=>e.settle(t,n).catch(e=>(x=g(x,e),Promise.reject(e)))}`;
//   - after `named`, the read-back waits that pace held within the blockhash's life (90 s from the signature, `L=e=>{let
//     t=CV-(f()-p);return t>0?Math.min(e,t):e}`, `n>0&&await h(L(_))`), never a fixed second; a read-back that fails
//     slows it and only one that went through puts it back (`.catch(e=>(r=!0,y(e),...));r||(_=400)`);
//   - the finality loop waits its own next wait (`t>0&&await h(ee)`): a finalized-slot read that fails slows the pace
//     (`catch(e){y(e),ee=_;continue}`); the gap at a slot's time each while an RPC is short and the gate's bound is not
//     past (`if(r>0&&i>0){_=400,ee=Math.max(_,Math.min(r*400,EV,i));continue}`); the settle's wait after a settle that
//     found no spend (`a===!1&&(x=g(x,null)),!a){_=400,ee=x;continue}`); after whose spend, the pace back only when that
//     round had no failed read (`let o=v,...;v===o&&(_=400),ee=_`);
//   - once the transaction read back on both RPCs, the settle (the function that calls the host's `.settle(`) is asked
//     only past that gate, held to both RPCs' finalized slots read (`await C([n[0],n[1]])`), and nowhere else past the
//     read-back.
// These marks hold from release-115 (card signpage-throttled-read-is-not-asked-again-at-once re-anchored them: the
// back-off moved onto the wallet's rule, a pace that slowed only on a throttle now slows on any failed read, the pace
// back after every finalized read is now back after a whole round with no failure, and the read-back gained the
// blockhash's life); a build before it carries the old back-off and FAILs.
// A pace of a fixed second, a settle asked before the finality gate, or a gate missing each FAIL.
// It reads two stretches of the minified bundle and the rule, so it does not prove the whole rule (the three rounds of
// the checks' reads, the counts under a throttle): packages/signpage/test/pool-buy.test.ts holds those.
// The recorded testnet answers are facts() over packages/signpage/scripts/build-app.mjs bundle(pkg, { network:
// "testnet" }) of each tree (this file reaches no package code: the import check holds it).
// After: sign
//   node scripts/live-checks/pool-buy-filled-2s.mjs [--base <url>] [--record <file>] [--answer <file>]
//   (--base: a build's own address, a Pages preview say; SIGN_HOST when absent)
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "pool-buy-filled-2s";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const esc = (s) => s.replace(/\$/g, "\\$");

/** The hook the bundle calls right after it checks the helper's signature is one (signpage-sent-read-back's HOOK). */
const HOOK = /\.length!==64\)return [\w$]+\(\[\]\);await [\w$]+\.named\?\.\(/;
/** The back-off: its name (group 1), on the wallet's one rule (group 2, throttleWaitMs) with the buy's bounds (group 3):
 *  `g=(e,t)=>R(e,t instanceof X?t.afterMs:null,B)` (card signpage-throttled-read-is-not-asked-again-at-once). */
const BACKOFF = /([\w$]+)=\(([\w$]+),([\w$]+)\)=>([\w$]+)\(\2,\3 instanceof [\w$]+\?\3\.afterMs:null,([\w$]+)\)/;
/** The rule: a pause doubling from its bounds' first to their most, a Retry-After the wait when longer, finite and above
 *  0, held to its bounds' afterMaxMs (packages/wallet/src/throttle.ts throttleWaitMs). */
const RULE = (f) => new RegExp(String.raw`function ${f}\(([\w$]+),([\w$]+),([\w$]+)=[\w$]+\)\{let ([\w$]+)=Number\.isFinite\(\1\)&&\1>0\?Math\.min\(\1\*2,\3\.maxMs\):\3\.firstMs,([\w$]+)=typeof \2==\x60number\x60&&Number\.isFinite\(\2\)&&\2>0\?Math\.min\(\2,\3\.afterMaxMs\):0;return Math\.max\(\4,\5\)\}`);
/** The buy's bounds: from a slot (400 ms) to 8 s (written, or named by a constant of 8e3), a Retry-After up to 10 s. */
const BOUNDS = (b) => new RegExp(String.raw`[,;\s]${b}=Object\.freeze\(\{firstMs:400,maxMs:(?:8e3|([\w$]+)),afterMaxMs:1e4\}\)`);
const boundsIn = (b, js) => {
  const m = BOUNDS(b).exec(js);
  return Boolean(m) && (m[1] === undefined || new RegExp(String.raw`[,;\s]${m[1].replace(/\$/g, "\\$")}=8e3[,;]`).test(js));
};
/** The settle's function: its name (group 1), the one that asks the host's settle (through the settle's back-off). */
const SETTLE = /([\w$]+)=async [\w$]+=>\{if\([\w$]+\)return!0;let [\w$]+=await [\w$]+\.settle\(/;
const N = String.raw`[\w$]+`;

/** sendAndSettle from its `function` keyword to `named` (head), and from `named` to its end (stretch). */
export function facts(index, js) {
  const m = HOOK.exec(js);
  const start = m ? js.lastIndexOf("function", m.index) : -1;
  const end = m ? js.indexOf("function", m.index) : -1;
  const head = m && start >= 0 ? js.slice(start, m.index) : null;
  const stretch = m ? js.slice(m.index, end < 0 ? js.length : end) : null;
  const b = head ? BACKOFF.exec(head) : null;
  const l = stretch ? LIFE.exec(stretch) : null;
  return {
    index,
    sha384: sha384(js),
    poolSend: js.includes("/v1/pool/solana/send"),
    head,
    stretch,
    // read past the two stretches: the back-off's rule and bounds, and the read-back's bound of the blockhash's life
    rule: Boolean(b) && RULE(esc(b[4])).test(js) && boundsIn(esc(b[5]), js),
    life: Boolean(l) && new RegExp(String.raw`[,;\s]${esc(l[4])}=9e4[,;]`).test(js),
  };
}

/** The read-back's wait within the blockhash's life: `L=e=>{let t=LIFE-(clock()-signedAt);return t>0?Math.min(e,t):e}`. */
const LIFE = new RegExp(String.raw`(${N})=(${N})=>\{let (${N})=(${N})-\((${N})\(\)-(${N})\);return \3>0\?Math\.min\(\2,\3\):\2\}`);
/** The head as read: the back-off on the rule and its bounds, and the read-back's pace with its failure count. */
function paceOf(head, rule) {
  const m = BACKOFF.exec(head);
  if (!m || rule !== true) return null;
  const g = m[1];
  // `_=400,v=0,y=e=>void(v++,_=g(_,e))`: the pace, the count of failed reads, the slow-down any failed read calls
  const p = new RegExp(String.raw`,(${N})=400,(${N})=0,(${N})=(${N})=>void\(\2\+\+,\1=${esc(g)}\(\1,\4\)\)`).exec(head);
  const hold = new RegExp(String.raw`,(${N})=400,${N}=\{settle:\((${N}),(${N})\)=>${N}\.settle\(\2,\3\)\.catch\((${N})=>\(\1=${esc(g)}\(\1,\4\),Promise\.reject\(\4\)\)\)\}`).exec(head)?.[1];
  return p && hold ? { g, pace: p[1], faults: p[2], slow: p[3], hold } : null;
}

function problems(head, stretch, rule, lifeHeld) {
  if (typeof head !== "string" || typeof stretch !== "string") return ["the bundle's sendAndSettle is not read"];
  const out = [];
  const q = paceOf(head, rule);
  if (!q) return ["the bundle's read-back has no pace of a slot (400 ms) that any failed read or a thrown settle doubles, on the one rule (a pause doubling to 8 s, a Retry-After when longer, at most 10 s, and finite)"];
  const { g, pace, faults, slow, hold } = q;
  const P = esc(pace), H = esc(hold), Y = esc(slow), V = esc(faults);
  // the read-back's wait: its pace, held within the blockhash's life (9e4 ms from the signature) to the time left
  const life = LIFE.exec(stretch);
  const waits = [...stretch.matchAll(/[\w$]+>0&&await [\w$]+\(((?:[^()]|\([^()]*\))*)\)/g)].map((x) => x[1]);
  if (waits.length !== 2 || !life || waits[0] !== `${life[1]}(${pace})`) out.push(`the bundle's read-back wait is not its pace (${waits.join(", ") || "none"}): a fixed wait asks a throttled provider again at once`);
  else if (lifeHeld !== true) out.push("the bundle's read-back wait is not held within the blockhash's life (90 s): a grown pause may run past it");
  // a read-back that fails, any failure, slows the pace; only one that went through puts it back
  if (!new RegExp(String.raw`\.catch\((${N})=>\((${N})=!0,${Y}\(\1\),\[\{got:\x60none\x60\},\{got:\x60none\x60\}\]\)\);\2\|\|\(${P}=400\)`).test(stretch)) out.push("the bundle's read-back does not slow on every failed read (a 5xx as a 429), or puts the pace back after one that failed: a provider that is down is asked again at a slot's pace");
  const settle = SETTLE.exec(head)?.[1];
  if (settle === undefined) return [...out, "the bundle's settle function is not read"];
  // the finality loop: its wait (group 1); both RPCs' finalized slots (group 2); a failed read slowing the pace; the gap
  // (group 5) waited while short and the gate's bound (group 8) not past, the pace back (a round that went through);
  // then the settle, held to those slots, after one that found no spend the settle's own wait; then whose spend, whose
  // failed reads keep the grown pace (the failure count, group 10, unchanged puts it back)
  const gate = new RegExp(String.raw`${N}>0&&await ${N}\((${N})\);let (${N});try\{\2=\(await Promise\.all\(${N}\.rpcs\.map\((${N})=>\3\(\x60getSlot\x60,\[\{commitment:\x60finalized\x60\}\]\)\)\)\)\.map\(${N}\)\}catch\((${N})\)\{${Y}\(\4\),\1=${P};continue\}let (${N})=Math\.max\(\.\.\.\2\.map\(\((${N}),(${N})\)=>\(${N}\[\7\]\?\?0\)-\6\)\),(${N})=${N}-\(${N}\(\)-${N}\);if\(\5>0&&\8>0\)\{${P}=400,\1=Math\.max\(${P},Math\.min\(\5\*400,${N},\8\)\);continue\}let (${N})=await ${esc(settle)}\(\[\2\[0\],\2\[1\]\]\);if\(\9===!1&&\(${H}=${esc(g)}\(${H},null\)\),!\9\)\{${P}=400,\1=${H};continue\}let (${N})=${V},(${N})=await ${N}\(${N},${N}\);if\(\11\)return \11;${V}===\10&&\(${P}=400\),\1=${P}\}`);
  const m = gate.exec(stretch);
  if (!m || waits[1] !== m[1]) return [...out, "the bundle's finality wait is not the rule (the settle only once both RPCs' finalized slot reaches the transaction's or the gate's bound is past, held to those slots; the gap waited out; a failed read slowing the pace and only a round that went through putting it back; a settle that found no spend asked again at its doubling wait): it lists every mark of the pool before the chain can answer it, or every slot"];
  // past the read-back (its `return k(...)` for a transaction not landed), the gate's is the only settle call
  const landedAt = stretch.lastIndexOf("return", m.index);
  const calls = [...stretch.slice(landedAt).matchAll(new RegExp(`(?<![\\w$.])${esc(settle)}\\(`, "g"))].length;
  if (calls !== 1) out.push(`the bundle asks the settle ${calls} times past the read-back: once, behind the finality gate, is the rule`);
  return out;
}

/** The verdict on an answer { index, sha384, poolSend, head, stretch }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (typeof a?.poolSend !== "boolean") bad("the bundle's facts are not read");
  else if (a.poolSend) for (const p of problems(a.head, a.stretch, a.rule, a.life)) bad(p);
  else lines.push("NOTE the bundle sends no pool transaction (no pinned pool on this build)");
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

export async function read(fetchFn = fetch, base = SIGN) {
  const get = async (path) => {
    const r = await fetchFn(`${base}${path}`, { redirect: "error" });
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
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read(fetch, (arg("--base") ?? SIGN).replace(/\/$/, ""));
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
