#!/usr/bin/env node
// Live check of card signpage-sent-read-back on SIGN_HOST (https://confidential.unrealized.trade). What it holds,
// and only that: the served /app.js is the one index.html pins (its sha384); and the bundle sends no pool transaction
// (it never names the helper's /v1/pool/solana/send), or, in src/pool-buy.ts sendAndSettle as minified:
//   - the hook it calls right after it takes the helper's signature is `named` (a name to read back, never told);
//   - from that hook to the function's end, `sent` (the app's answer) is called exactly once, and only behind a
//     once-only flag and both slots of the array the read-back sets from `mine` (both RPCs read this very transaction
//     under the signature): `!T&&w[0]&&w[1]&&(T=!0,await e.sent?.(S))`, `w[t]||=e.mine===!0`;
//   - a bundle whose sendAndSettle tells the buy's transaction as a route fact (card pool-buy-send-fast: its tellTx,
//     `u=e=>{s&&!l&&(l=!0,s.tell({tx:e}))}`) tells it inside that same guard, with sent's own signature, and nowhere else
//     from `named` on: `!D&&E[0]&&E[1]&&(D=!0,u(w),await e.sent?.(w))`, exactly once; before `named`, only with a spend
//     read as this attempt's own (spentBy's `u(n.mine)`). A bundle with no route tell has nothing but `sent` in the guard.
// A `sent` right after `named`, before the read loop, after one RPC's read or without the once flag each FAILs, as does
// a route tell outside the guard, twice, with another argument, or another call in the guard.
// SIGN_HOST's mainnet build sends no pool transaction until pinned pools land there, so today the check holds the pin
// and that rule for that day.
// It reads one stretch of the minified bundle, so it does not prove the whole rule (no answer's txs name the helper's
// signature before the read-back, for buy and withdraw): that is held by packages/signpage/test/pool-buy.test.ts and
// test/pool-withdraw.test.ts (the helper answering a signature that is not this transaction's, red on main a95cce2).
// The recorded testnet answers are facts() over packages/signpage/scripts/build-app.mjs bundle(pkg, { network:
// "testnet" }) of each tree (this file reaches no package code: the import check holds it).
//   node scripts/live-checks/signpage-sent-read-back.mjs [--base <url>] [--record <file>] [--answer <file>]
//   (--base: a build's own address, a Pages preview say; SIGN_HOST when absent)
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "signpage-sent-read-back";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** The hooks the bundle calls right after it checks the helper's signature is one (64 bytes of base58), in order. */
const HOOK = /\.length!==64\)return [\w$]+\(\[\]\);await [\w$]+\.([\w$]+)\?\.\(/g;

/** The `sent` call that may stand in that stretch: behind the once flag (set in the same breath) and both slots of an
 *  array (group 2), which must be the one the read-back sets from `mine` (SEEN). */
const GUARD = /!([\w$]+)&&([\w$]+)\[0\]&&\2\[1\]&&\(\1=!0,(?:([\w$]+)\(([\w$]+)\),)?await [\w$]+\.sent\?\.\(([\w$]+)\)/g;
/** sendAndSettle's route tell of the buy's transaction (pool-buy.ts tellTx), told once: group 1 its name. */
const TELL = /([\w$]+)=([\w$]+)=>\{[\w$]+&&![\w$]+&&\([\w$]+=!0,[\w$]+\.tell\(\{tx:\2\}\)\)\}/;
const callsOf = (name, text) => [...text.matchAll(new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}\\(([^()]*)\\)`, "g"))].map((m) => m[1]);
/** The read-back's per-RPC slot: set when that RPC read this very transaction's bytes under the signature. */
const SEEN = /([\w$]+)\[[\w$]+\]\|\|=[\w$]+\.mine===!0/;

/** The bundle from the first `named` hook after the signature check to the end of its function (the next `function`
 *  keyword: sendAndSettle holds only arrows; none found, the rest of the bundle, which fails closed). */
function stretchOf(js) {
  const m = [...js.matchAll(HOOK)].find((x) => x[1] === "named");
  if (!m) return null;
  const end = js.indexOf("function", m.index);
  return js.slice(m.index, end < 0 ? js.length : end);
}

/** The bundle from the start of the function holding the first `named` hook (its `function` keyword) to that hook. */
function headOf(js) {
  const m = [...js.matchAll(HOOK)].find((x) => x[1] === "named");
  if (!m) return null;
  const start = js.lastIndexOf("function", m.index);
  return start < 0 ? null : js.slice(start, m.index);
}

/** What the check keeps of the reads: the index, the served bundle's sha384 and the facts read from it. */
export function facts(index, js) {
  return { index, sha384: sha384(js), poolSend: js.includes("/v1/pool/solana/send"), hooks: [...js.matchAll(HOOK)].map((m) => m[1]), stretch: stretchOf(js), head: headOf(js) };
}

/** Problems with the stretch from `named` to the end of sendAndSettle (empty: its one `sent` is behind the read-back).
 *  `head`: the function from its start to `named` (absent in an answer recorded before the route tell). */
function sentProblems(stretch, head) {
  if (typeof stretch !== "string") return ["the bundle's stretch from named to the end of its function is not read"];
  const calls = stretch.split(".sent?.(").length - 1;
  if (calls !== 1) return [`the bundle calls sent ${calls} times after named: once, behind both RPCs' read-back, is the rule`];
  const g = [...stretch.matchAll(GUARD)];
  const seen = SEEN.exec(stretch)?.[1];
  if (g.length !== 1 || seen === undefined || g[0][2] !== seen) {
    return ["the bundle's sent is not behind its once-only flag and both RPCs' read of this very transaction: the app may be told a transaction the chain has not read as its own"];
  }
  const [, , , inGuard, toldArg, sentArg] = g[0];
  const tell = typeof head === "string" ? TELL.exec(head)?.[1] : undefined;
  if (tell === undefined) {
    if (stretch.includes(".tell({tx:") || (typeof head === "string" && head.includes(".tell({tx:"))) return ["the bundle tells the buy's transaction by a function the check cannot read"];
    return inGuard === undefined ? [] : [`the bundle calls ${inGuard} inside sent's guard, which is no route tell of the transaction`];
  }
  if (inGuard !== tell || toldArg !== sentArg) return ["the bundle's route tx is not told inside sent's guard with sent's own signature: the app may be linked a transaction the chain has not read as its own"];
  const after = callsOf(tell, stretch);
  if (after.length !== 1) return [`the bundle tells the route tx ${after.length} times after named: once, inside sent's guard, is the rule`];
  const before = callsOf(tell, head.slice(head.indexOf(TELL.exec(head)[0]) + TELL.exec(head)[0].length));
  if (before.some((a) => !/^[\w$]+\.mine$/.test(a))) return ["the bundle tells the route tx before named with something but a spend read as this attempt's own"];
  return [];
}

/** The verdict on an answer { index, sha384, poolSend, hooks, stretch }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (typeof a?.poolSend !== "boolean" || !Array.isArray(a?.hooks)) bad("the bundle's facts are not read");
  else if (a.poolSend && a.hooks.length !== 1) bad(`the bundle sends pool transactions and its hook after the helper's signature is not read (${a.hooks.length} found)`);
  else if (a.poolSend && a.hooks[0] !== "named") bad(`the bundle calls ${a.hooks[0]} with the helper's signature before any read-back: the app is told a transaction the chain has not read as its own`);
  else if (a.poolSend) for (const p of sentProblems(a.stretch, a.head)) bad(p);
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
