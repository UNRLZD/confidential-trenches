#!/usr/bin/env node
// Live check of card signers-own-bytes on SIGN_HOST (https://confidential.unrealized.trade). The signing page
// bundles the kit's Solana trade flow, so the device that signs a trade runs the signer SIGN_HOST serves. What it
// proves, and only that: the served /app.js is the one index.html pins (its sha384), and its text carries these lines,
// each found by a mark of the bundle's shape (the minifier renames, never restructures them;
// packages/kit/src/trade/solana/own-wires.ts and flow.ts):
//   - the registry: a module WeakMap that keeps its own copy of the bytes a check passed and the height the wire was
//     built with, and a lookup that answers a fresh copy only when every byte and the height still match;
//   - the signer: its first line takes that copy and refuses a wire with none, before the message check and the signer;
//   - then it hands the signer a copy of the copy's message with the copy's height, verifies the signature against that
//     message and puts it in the copy, which it returns with that height (review 1 M1: never the caller's arrays);
//   - a trade leg is put in the registry only once its verdict is ok, with the copy its checks read;
//   - a teardown's frames are copied before their simulations, and put in it only after their checks pass on those
//     copies, each with its own, before they are signed.
// It does not prove those lines run or refuse: that is the kit's tests at the released commit
// (packages/kit/test/solana-flow.test.ts, the hostile test of card signers-own-bytes; test/solana-flow-replay.test.ts),
// and that the served files are that commit's build is signpage-release's.
//   node scripts/live-checks/signers-own-bytes.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "signers-own-bytes";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const I = "[\\w$]+"; // a minified name
const esc = (s) => s.replace(/\$/g, "\\$");
const REGISTRY = new RegExp(
  `var (${I})=new WeakMap;function (${I})\\((${I}),(${I})\\)\\{\\1\\.set\\(\\3,Object\\.freeze\\(\\{wire:Uint8Array\\.from\\(\\4\\),lastValidBlockHeight:\\3\\.lastValidBlockHeight\\}\\)\\)\\}` +
    `function (${I})\\((${I})\\)\\{let (${I})=\\1\\.get\\(\\6\\);return \\7===void 0\\|\\|!\\(\\6\\.wire instanceof Uint8Array\\)\\|\\|\\7\\.wire\\.length!==\\6\\.wire\\.length\\|\\|!\\6\\.wire\\.every\\(\\((${I}),(${I})\\)=>\\8===\\7\\.wire\\[\\9\\]\\)` +
    `\\|\\|!Object\\.is\\(\\7\\.lastValidBlockHeight,\\6\\.lastValidBlockHeight\\)\\?null:\\{wire:Uint8Array\\.from\\(\\7\\.wire\\),lastValidBlockHeight:\\7\\.lastValidBlockHeight\\}\\}`,
);
// the signer: the registry's copy taken first, refused when there is none; then only that copy's message is handed to
// the signer (as a copy), verified, and given the signature; its height is the one handed and sent
const GATE = (own) => new RegExp(`async function ${I}\\(${I},${I},(${I}),${I}\\)\\{let (${I})=${esc(own)}\\(\\1\\);if\\(\\2===null\\)throw Error\\(\`the wire is not one this flow built and checked\`\\);`);
const COPY = (own) =>
  new RegExp(
    `let (${I})=${esc(own)}\\(${I}\\);if\\(\\1===null\\)throw Error\\(\`the wire is not one this flow built and checked\`\\);let\\{wire:(${I}),lastValidBlockHeight:(${I})\\}=\\1,(${I})=\\2\\.subarray\\(65\\);` +
      `[^]{0,700}?=await (${I})\\.sign\\((${I}),\\4\\.slice\\(\\),\\{lastValidBlockHeight:\\3\\}\\)\\}` +
      `[^]{0,200}?!${I}\\.verify\\((${I}),\\4,${I}\\.decode\\(\\6\\)\\)\\)\\)throw Error\\(\`the signature for \\$\\{\\6\\} does not verify\`\\);return \\2\\.set\\(\\7,1\\),\\{wire:\\2,lastValidBlockHeight:\\3\\}\\}`,
  );
const LEG = (reg) => new RegExp(`,(${I})\\.ok\\?\\(${esc(reg)}\\((${I}),(${I})\\),\\{leg:${I},rec:${I},assembled:\\2,checked:\\3,`);
// the teardown: the copies taken before the simulations, simulated and checked, and registered after the checks pass
const TEARDOWN = (reg) =>
  new RegExp(
    `(${I})=(${I})\\.map\\((${I})=>Uint8Array\\.from\\(\\3\\.wire\\)\\),(${I})=await Promise\\.all\\(\\1\\.map\\(` +
      `[^;]{0,200}?,(${I})=${I}\\(\\1,${I},\\{accounts:${I},wallet:[^;]{0,120}?,simulations:\\4\\}\\);` +
      `if\\(!\\5\\.ok\\|\\|\\2\\.length===0\\)return\\{verdict:\\5[^;]{0,80}\\};\\2\\.forEach\\(\\((${I}),(${I})\\)=>${esc(reg)}\\(\\6,\\1\\[\\7\\]\\)\\);let ${I}=await ${I}\\(${I},\\2\\.map\\(`,
  );

export const MARKS = Object.freeze([
  "the registry keeps a copy of the checked bytes and height, compares every byte and the height, and hands out a copy",
  "the signer refuses a wire not in the registry before anything else",
  "the signer signs, verifies and returns only the registry's copy, with its height",
  "a trade leg is registered only once its verdict is ok, with its checked copy",
  "a teardown's frames are copied before their simulations and registered only after their checks pass, before they are signed",
]);

/** What the check keeps of the reads: the index, the served bundle's sha384, and which lines the bundle carries. */
export function facts(index, js) {
  const r = REGISTRY.exec(js);
  const has = r ? [true, GATE(r[5]).test(js), COPY(r[5]).test(js), LEG(r[2]).test(js), TEARDOWN(r[2]).test(js)] : MARKS.map(() => false);
  return { index, sha384: sha384(js), carries: Object.fromEntries(MARKS.map((k, i) => [k, has[i]])) };
}

/** The verdict on an answer { index, sha384, carries }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  for (const k of MARKS) if (a?.carries?.[k] !== true) bad(`the served bundle does not carry: ${k}`);
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
