#!/usr/bin/env node
// Live check of card kit-renewal-read-bounded: a many-wallet Solana trade is never signed on a price read that answered
// late. The kit (packages/kit/src/trade/solana/flow.ts) holds one age rule, referenceLate: the reference the legs are
// checked on must be begun no more than SOLANA_BLOCKHASH_REFRESH_MS (20 s) before the signature. It is read at the sign
// point's one re-read (the time taken again just before it; a late answer refuses every leg, unsigned, never read again)
// and for each leg right before its signer is asked and again when it answers (signedWire), so a slow store read or
// seed open inside the signer refuses the leg too. The refusal is `checks: ...`, the signing page's quote_check_failed.
// A signature the kit drops is never named: the kit hands the kept ones to onSigned, and the page's answers, stage
// writes and txs come from that list alone (packages/signpage/src/trade.ts legsRun).
// What runs on a device is the signing page's bundle, so this reads what SIGN_HOST serves: the page and the script it
// names (/app.js) answer 200, and the script holds the four parts of the rule and the page's kept list, each a marker
// robust to the minifier's names. The behaviour is proven by packages/kit/test/solana-flow-replay.test.ts (a 40 s
// sign-point read refuses all three legs; a 15 s signer after a 10 s old reference refuses the leg; onSigned holds the
// kept legs alone) and packages/signpage/test/trade.test.ts (a dropped leg is in no answer); no real trade runs here.
//   node scripts/live-checks/kit-renewal-read-bounded.mjs [--record <file>]
//     SIGN_HOST as deployed: https://sign.confidential.unrealized.trade/
//   node scripts/live-checks/kit-renewal-read-bounded.mjs --local [--record <file>]
//     the same read on this checkout: packages/signpage (index.html, public/app.js as committed)
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read (which markers the script holds, not the script), so the check's test can replay it.
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "kit-renewal-read-bounded";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SIGN = { url: "https://sign.confidential.unrealized.trade/", local: path.join(ROOT, "packages/signpage") };
const ID = "[\\w$]+";
/** The rule's parts in the signing page's bundle, by name. */
export const MARKERS = {
  // function referenceLate(at, now): age <= 20 s ? null : `checks: the reference is ...`
  "the age rule": new RegExp(`${ID}<=(?:2e4|20000|${ID})\\?null:\`checks: the reference is \\$\\{`),
  // renewSet's sign point: the time again, the one re-read, and a late answer refusing every passed leg
  "the sign point's timed re-read": new RegExp(`${ID}=${ID}\\(\\);let ${ID}=await ${ID}\\(\\),${ID}=${ID}\\(${ID},${ID}\\(\\)\\);if\\(${ID}\\)\\{for\\(let ${ID} of ${ID}\\)${ID}\\.p\\.rec\\.refused=${ID};return\\{legs:\\[\\],at:${ID}\\}\\}`),
  // each leg: the rule read right before its signer is asked
  "the rule before each signer": new RegExp(`${ID}\\(\\)\\?\\?await ${ID}\\(${ID},${ID}\\.leg\\.wallet,${ID}\\.assembled,${ID}\\)`),
  // signedWire: the rule read when the signer answers, before its signature is checked or put in the wire
  "the rule when the signer answers": new RegExp(`=await ${ID}\\.sign\\(${ID},${ID}\\.message,\\{lastValidBlockHeight:${ID}\\.lastValidBlockHeight\\}\\)\\}let ${ID}=${ID}\\(\\);if\\(${ID}\\)return ${ID};`),
  // the page (src/trade.ts legsRun): its signer passes straight through, and its txs are the kit's kept signatures alone
  "the page names only kept signatures": new RegExp(`sign:\\(${ID},${ID},${ID}\\)=>${ID}\\.sign\\(${ID},${ID},${ID}\\),onSigned:${ID}=>\\{${ID}\\.splice\\(0,${ID}\\.length,\\.\\.\\.${ID}\\.map\\(${ID}=>\\(\\{chain:\`solana\`,hash:${ID}\\.signature\\}\\)\\)\\)\\}`),
};

/** The page's scripts: the `src` of each script tag. */
export const scriptsOf = (html) => [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]);
export const found = (text) => Object.entries(MARKERS).filter(([, re]) => re.test(text)).map(([name]) => name);

// ------------------------------------------------------------------------------------------------ the verdict
/** The check on one answer: { source, pageStatus, js: [{ url, status, found }] }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(rec?.pageStatus === 200, `sign: the page answers ${rec?.pageStatus ?? "nothing"} (${rec?.source ?? "no source"})`);
  const js = Array.isArray(rec?.js) ? rec.js : [];
  say(js.length > 0 && js.every((f) => f.status === 200), `sign: ${js.length} script(s) named by the page, each answering 200`);
  const held = new Set(js.flatMap((f) => (Array.isArray(f.found) ? f.found : [])));
  const miss = Object.keys(MARKERS).filter((m) => !held.has(m));
  say(miss.length === 0, miss.length ? `sign: the scripts lack ${miss.join(", ")}` : `sign: the scripts hold ${Object.keys(MARKERS).join(", ")}`);
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
async function http(url) {
  const r = await fetch(url, { redirect: "manual" });
  return { status: r.status, text: await r.text() };
}

export async function collect({ local = false } = {}) {
  const file = (rel) => {
    try {
      return { status: 200, text: readFileSync(path.join(SIGN.local, rel), "utf8") };
    } catch {
      return { status: 404, text: "" };
    }
  };
  const page = local ? file("index.html") : await http(SIGN.url);
  const rec = { at: new Date().toISOString(), source: local ? `this checkout, ${path.relative(ROOT, SIGN.local)}` : SIGN.url, pageStatus: page.status, js: [] };
  for (const ref of scriptsOf(page.text)) {
    const f = local ? file(path.join("public", new URL(ref, "http://x/").pathname)) : await http(new URL(ref, SIGN.url).href);
    rec.js.push({ url: ref, status: f.status, found: found(f.text) });
  }
  return rec;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  try {
    const rec = await collect({ local: a.includes("--local") });
    const out = a.includes("--record") ? a[a.indexOf("--record") + 1] : null;
    if (out) writeFileSync(out, `${JSON.stringify(rec, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"} (${rec.source})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
