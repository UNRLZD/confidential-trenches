#!/usr/bin/env node
// Live check of card pool-buy-filled-2s on SIGN_HOST (https://confidential.unrealized.trade). What it holds, and only
// that: the served /app.js is the one index.html pins (its sha384); and the bundle sends no pool transaction (it never
// names the helper's /v1/pool/solana/send), or, in src/pool-buy.ts sendAndSettle as minified:
//   - one back-off: a wait doubled up to a cap, or the provider's Retry-After when longer, and only a finite one, at most
//     its own cap: `g=(e,t)=>{let n=t instanceof Ly?Number(t.afterMs):NaN,r=Number.isFinite(n)&&n>0?Math.min(n,vV):0;
//     return Math.max(Math.min(e*2,_V),r)}`;
//   - the read-back's pace starts at a slot (400 ms) and a throttle doubles it by that back-off: `_=400,v=e=>void(_=g(_,
//     e))`; the settle's own wait starts at a slot and a settle that throws doubles it: `x=400,S={settle:(t,n)=>e.settle(
//     t,n).catch(e=>(x=g(x,e),Promise.reject(e)))}`;
//   - after `named`, the read-back waits that pace (`n>0&&await h(_)`), never a fixed second, and the finality loop its
//     own next wait (`t>0&&await h(R)`): the pace again once a finalized-slot read goes through (`_=400,R=_`), the gap
//     at a slot's time each while an RPC is short and the gate's bound is not past (`if(r>0&&i>0){R=Math.max(_,Math.min(
//     r*400,_V,i));continue}`), and the settle's wait after a settle that found no spend (`a===!1&&(x=g(x,null)),!a){R=x;
//     continue}`);
//   - once the transaction read back on both RPCs, the settle (the function that calls the host's `.settle(`) is asked
//     only past that gate, held to both RPCs' finalized slots read (`await C([n[0],n[1]])`), and nowhere else past the
//     read-back.
// A pace of a fixed second, a settle asked before the finality gate, or a gate missing each FAIL.
// It reads two stretches of the minified bundle, so it does not prove the whole rule (the three rounds of the checks'
// reads, the back-off's numbers): packages/signpage/test/pool-buy.test.ts holds those, red on main 2736dbef.
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
/** The back-off: its name (group 1). */
const BACKOFF = /([\w$]+)=\(([\w$]+),([\w$]+)\)=>\{let ([\w$]+)=\3 instanceof [\w$]+\?Number\(\3\.afterMs\):NaN,([\w$]+)=Number\.isFinite\(\4\)&&\4>0\?Math\.min\(\4,[\w$]+\):0;return Math\.max\(Math\.min\(\2\*2,[\w$]+\),\5\)\}/;
/** The settle's function: its name (group 1), the one that asks the host's settle (through the settle's back-off). */
const SETTLE = /([\w$]+)=async [\w$]+=>\{if\([\w$]+\)return!0;let [\w$]+=await [\w$]+\.settle\(/;
const N = String.raw`[\w$]+`;

/** sendAndSettle from its `function` keyword to `named` (head), and from `named` to its end (stretch). */
export function facts(index, js) {
  const m = HOOK.exec(js);
  const start = m ? js.lastIndexOf("function", m.index) : -1;
  const end = m ? js.indexOf("function", m.index) : -1;
  return {
    index,
    sha384: sha384(js),
    poolSend: js.includes("/v1/pool/solana/send"),
    head: m && start >= 0 ? js.slice(start, m.index) : null,
    stretch: m ? js.slice(m.index, end < 0 ? js.length : end) : null,
  };
}

function problems(head, stretch) {
  if (typeof head !== "string" || typeof stretch !== "string") return ["the bundle's sendAndSettle is not read"];
  const out = [];
  const g = BACKOFF.exec(head)?.[1];
  const pace = g && new RegExp(String.raw`,(${N})=400,${N}=${N}=>void\(\1=${esc(g)}\(\1,${N}\)\)`).exec(head)?.[1];
  const hold = g && new RegExp(String.raw`,(${N})=400,${N}=\{settle:\((${N}),(${N})\)=>${N}\.settle\(\2,\3\)\.catch\((${N})=>\(\1=${esc(g)}\(\1,\4\),Promise\.reject\(\4\)\)\)\}`).exec(head)?.[1];
  if (!pace || !hold) return ["the bundle's read-back has no pace of a slot (400 ms) that only a throttle or a thrown settle doubles, by a back-off capped at its own most and the Retry-After's, and finite"];
  const waits = [...stretch.matchAll(/[\w$]+>0&&await [\w$]+\(([^()]*)\)/g)].map((x) => x[1]);
  if (waits.length !== 2 || waits[0] !== pace) out.push(`the bundle's read-back wait is not its pace (${waits.join(", ") || "none"}): a fixed wait asks a throttled provider again at once`);
  const settle = SETTLE.exec(head)?.[1];
  if (settle === undefined) return [...out, "the bundle's settle function is not read"];
  // the finality loop: its wait (group 1); both RPCs' finalized slots (group 2); the pace back once they read; the gap
  // (group 3) waited while short and the gate's bound (group 4) not past; then the settle, held to those slots, and
  // after one that found no spend the settle's own wait
  const P = esc(pace), H = esc(hold);
  const gate = new RegExp(String.raw`${N}>0&&await ${N}\((${N})\);let (${N});try\{\2=\(await Promise\.all\(${N}\.rpcs\.map\((${N})=>\3\(\x60getSlot\x60,\[\{commitment:\x60finalized\x60\}\]\)\)\)\)\.map\(${N}\)\}catch\(${N}\)\{[^{}]*\1=${P};continue\}${P}=400,\1=${P};let (${N})=Math\.max\(\.\.\.\2\.map\(\((${N}),(${N})\)=>\(${N}\[\6\]\?\?0\)-\5\)\),(${N})=${N}-\(${N}\(\)-${N}\);if\(\4>0&&\7>0\)\{\1=Math\.max\(${P},Math\.min\(\4\*400,${N},\7\)\);continue\}let (${N})=await ${esc(settle)}\(\[\2\[0\],\2\[1\]\]\);if\(\8===!1&&\(${H}=${esc(g)}\(${H},null\)\),!\8\)\{\1=${H};continue\}`);
  const m = gate.exec(stretch);
  if (!m || waits[1] !== m[1]) return [...out, "the bundle's finality wait is not the rule (the settle only once both RPCs' finalized slot reaches the transaction's or the gate's bound is past, held to those slots; the gap waited out; the pace back after a read; a settle that found no spend asked again at its doubling wait): it lists every mark of the pool before the chain can answer it, or every slot"];
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
  else if (a.poolSend) for (const p of problems(a.head, a.stretch)) bad(p);
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
