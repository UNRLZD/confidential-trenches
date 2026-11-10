#!/usr/bin/env node
// Live check of card pool-buy-filled-2s on SIGN_HOST (https://confidential.unrealized.trade). What it holds, and only
// that: the served /app.js is the one index.html pins (its sha384); and the bundle sends no pool transaction (it never
// names the helper's /v1/pool/solana/send), or, in src/pool-buy.ts sendAndSettle as minified:
//   - the read-back's pace starts at a slot (400 ms) and only a throttle or a settle that threw doubles it, up to a cap,
//     or the provider's Retry-After when longer: `g=400,_=e=>{let t=e instanceof Ry&&e.afterMs!==null?Math.min(...):0;
//     g=Math.max(Math.min(g*2,_V),t)}`;
//   - after `named`, the read-back's wait is that pace (`t>0&&await h(g)`), never a fixed second, and the finality
//     wait's is the gap at a slot's time each, at least that pace (`t>0&&await h(Math.max(g,Math.min(F*400,_V)))`);
//   - once the transaction read back on both RPCs, the settle (the function that calls the host's `.settle(`) is asked
//     only behind both RPCs' finalized getSlot reaching each one's slot of this transaction, and held to those slots:
//     `if(F=Math.max(...n.map((e,t)=>(P[t]??0)-e)),F>0||!await x([n[0],n[1]]))continue`, and nowhere else past the
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
/** The pace: its name (group 1) set to 400, doubled up to a cap or the Retry-After by the throttle's function. */
const PACE = /,([\w$]+)=400,[\w$]+=[\w$]+=>\{let ([\w$]+)=[\w$]+ instanceof [\w$]+&&[\w$]+\.afterMs!==null\?Math\.min\([\w$]+\.afterMs,[\w$]+\):0;\1=Math\.max\(Math\.min\(\1\*2,[\w$]+\),\2\)\}/;
/** The settle's function: its name (group 1), the one that asks the host's settle. */
const SETTLE = /([\w$]+)=async [\w$]+=>\{if\([\w$]+\)return!0;let [\w$]+=await [\w$]+\.settle\(/;

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
  const pace = PACE.exec(head)?.[1];
  if (pace === undefined) return ["the bundle's read-back has no pace of a slot (400 ms) that only a throttle or a thrown settle doubles"];
  const waits = [...stretch.matchAll(/[\w$]+>0&&await [\w$]+\(([^()]*)\)/g)].map((x) => x[1]);
  if (waits.length !== 1 || waits[0] !== pace) out.push(`the bundle's read-back wait is not its pace (${waits.join(", ") || "none"}): a fixed wait asks a throttled provider again at once`);
  const settle = SETTLE.exec(head)?.[1];
  if (settle === undefined) return [...out, "the bundle's settle function is not read"];
  // the finality wait: the gap (group 1) waited at a slot's time each, at least the pace, then both RPCs' finalized slot
  // (group 2) read; the settle only once neither is short, held to those slots
  const gate = new RegExp(String.raw`[\w$]+>0&&await [\w$]+\(Math\.max\(${esc(pace)},Math\.min\(([\w$]+)\*400,[\w$]+\)\)\),\1=0;let ([\w$]+);try\{\2=\(await Promise\.all\([\w$]+\.rpcs\.map\(([\w$]+)=>\3\(\x60getSlot\x60,\[\{commitment:\x60finalized\x60\}\]\)\)\)\)\.map\([\w$]+\)\}catch\([\w$]+\)\{[^{}]*continue\}if\(\1=Math\.max\(\.\.\.\2\.map\(\(([\w$]+),([\w$]+)\)=>\([\w$]+\[\5\]\?\?0\)-\4\)\),\1>0\|\|!await ${esc(settle)}\(\[\2\[0\],\2\[1\]\]\)\)continue`);
  const g = gate.exec(stretch);
  if (!g) return [...out, "the bundle asks the settle with no gate on both RPCs' finalized slot reaching the transaction's: it lists every mark of the pool before the chain can answer it"];
  // past the read-back (its `return E(...)` for a transaction not landed), the gate's is the only settle call
  const landedAt = stretch.lastIndexOf("return", g.index);
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
