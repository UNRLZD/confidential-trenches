#!/usr/bin/env node
// Live check of card evm-buy-end-carries-its-tx: a Base or Robinhood buy's end reaches the app with its transaction and
// its own stage (review of 39c2ab9c, P3-6: the early "sent" answer names no transaction and is the one kept, so a filled
// buy showed no link). It reads what SIGN_HOST and APP_HOST serve: each page, then every script the page names (each the
// one its page pins), and checks the bundles hold:
//   - SIGN_HOST: a stage event names its transactions by their own two fields (src/api.ts progress, kit 1.19); the EVM
//     buy's and the EVM sale's end each go out with their transactions (src/pool-buy-evm.ts and src/pool-sell-evm.ts
//     kinds: `late` and the run's own end); a pool Withdrawn for the buy (the swap failed, the ETH on W, carried back)
//     ends owed_back with its release, and so does the rest leg whose own buy reverted, and the legs' end is owed_back
//     over a refusal (legsEnd); a kit at 1.18 or below is sent owed_back as refused (src/kit-version.ts stageFor; from kit 1.20, card
//     taps-wait-inside-the-page, kit-v1.19 read as the current level there); the
//     two wrappers between a kind and the api hand each stage on with its transactions (src/pool-testnet.ts evmEnds,
//     which reads the chain's positions again at an end, owed_back among them, and src/cash-to-pool.ts cashFirst's
//     trace: the review of 167d9deea found both passing the stage alone, so the end still reached the app with no tx);
//   - APP_HOST: the trade box takes an end stage's transaction into the fill toast's link (route.ts fromProgress), and
//     ends a buy at owed_back with its own line and no Retry (model.ts endView, showsRetry), a refused buy of the same id
//     too when its late end is owed_back (model.ts progress), and Filled or part filled when its late end is that
//     (card evm-buy-late-fill-reaches-app); any other late stage leaves it refused.
// The behaviour is the packages' own tests: packages/kit/test/signpage-client.test.mjs, packages/signpage/test/
// pool-buy-evm-kind.test.ts, pool-buy-evm.test.ts, pool-sell-evm.test.ts, api.test.ts, kit-version.test.ts, and
// apps/terminal/test/buy-route.test.ts and trade-states.test.ts. Mainnet only: no testnet run of any kind.
// Each host's deploy runs its own half, so a host that lags does not fail the other's deploy.
// After: sign --host sign
// After: app --host app
// Bundle: read sign
// Bundle: read app
//   node scripts/live-checks/evm-buy-end-carries-its-tx.mjs [--host app|sign] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2 (no --host: both)
// --record writes what the run read (the marks each file holds, its pin and its sha384, not the files), so the check's
// test can replay it.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "evm-buy-end-carries-its-tx";
export const APP_URL = "https://ct-app.unrealized.trade/";
export const SIGN_URL = "https://confidential.unrealized.trade/";
// a minifier may quote a string with any of the three quotes and rename any identifier
const Q = "[`\"']";
const ID = "[\\w$]+";
/** Each host's marks: its name, what the bundle holds when the change is in place, and how many times at least. */
export const MARKS = {
  sign: [
    ["a stage event names its txs by their own two fields", new RegExp(`txs:${ID}\\.map\\(${ID}=>\\(\\{chain:${ID}\\?\\.chain,hash:${ID}\\?\\.hash\\}\\)\\)`, "g"), 1],
    // the EVM buy's kind and the EVM sale's kind
    ["the EVM buy's and sale's late end go out with their txs", new RegExp(`late:${ID}=>${ID}\\?\\.progress\\(${ID}\\.stage,${ID}\\.txs\\)`, "g"), 2],
    ["a Withdrawn end is owed_back with its release", new RegExp(`carry\\?\\.\\(\\)\\}catch\\{\\}return\\{stage:${Q}owed_back${Q},txs:${ID}\\}`, "g"), 1],
    ["the rest leg's reverted buy is owed_back", new RegExp(`\\{end:${Q}reverted${Q}\\}\\)\\.catch\\(\\(\\)=>\\{\\}\\),${ID}\\(\\),\\{stage:${Q}owed_back${Q},txs:${ID}\\}`, "g"), 1],
    ["the legs' end is owed_back over a refusal", new RegExp(`\\.some\\(${ID}=>${ID}===${Q}owed_back${Q}\\)\\?\\{stage:${Q}owed_back${Q},txs:${ID}\\}:${ID}\\.some\\(${ID}=>${ID}===${Q}refused${Q}\\)`, "g"), 1],
    ["kit-v1.18 and below are sent owed_back as refused", new RegExp(`${ID}!==${Q}current${Q}(?:&&${ID}!==${Q}1\\.19${Q})?&&${ID}===${Q}owed_back${Q}\\?${Q}refused${Q}:${ID}`, "g"), 1],
    ["the EVM trade's ends wrapper hands on the txs", new RegExp(`\\{\\.\\.\\.${ID},progress:\\((${ID}),(${ID})\\)=>\\{${ID}\\.progress\\(\\1,\\2\\),${ID}\\.has\\(\\1\\)&&${ID}\\(${ID}\\)\\?\\.refresh\\(\\)\\}\\}`, "g"), 1],
    ["the EVM trade's ends include owed_back", new RegExp(`=new Set\\(\\[${Q}filled${Q},${Q}part_filled${Q},${Q}not_landed${Q},${Q}owed_back${Q}\\]\\)`, "g"), 1],
    ["the cash-first trace hands on the txs", new RegExp(`progress:\\((${ID}),(${ID})\\)=>\\(${ID}\\(${Q}swap${Q},\\{stage:\\1\\}\\),${ID}\\.progress\\(\\1,\\2\\)\\)`, "g"), 1],
  ],
  app: [
    ["an end stage's tx fills the toast's link", new RegExp(`\\?\\.\\[0\\]\\?\\.hash,${ID}=${ID}\\(${ID},${ID},${ID},${ID},${ID}\\);return ${ID}\\?${ID}\\(${ID},\\{t:${Q}tx${Q},id:${ID},tx:${ID}\\}\\):${ID}`, "g"), 1],
    // endView's chained answer, as an if or a ternary
    ["owed_back ends a buy as owed back", new RegExp(`\\.stage===${Q}owed_back${Q}(?:\\)return|\\?)\\{k:${Q}owedBack${Q},reason:null\\}`, "g"), 1],
    // a refused buy's late end of the same id (card evm-buy-late-fill-reaches-app: filled and part_filled beside owed_back,
    // the review of 167d9deea's): filled is Filled from the tap, part filled and owed back their own end, anything else
    // leaves the buy as it is
    ["a refused buy's late owed_back, part filled or filled moves it; nothing else does", new RegExp(`(${ID})\\.k===${Q}ended${Q}&&\\1\\.stage===${Q}refused${Q}&&\\1\\.id===(${ID})(?:\\)\\{if\\(|\\?)(${ID})===${Q}filled${Q}(?:\\)return|\\?)\\{k:${Q}filled${Q},id:\\2,at:\\1\\.at,ms:Math\\.max\\(0,${ID}-\\1\\.at\\)\\}(?:;if\\(|:)\\3===${Q}part_filled${Q}\\|\\|\\3===${Q}owed_back${Q}(?:\\)return|\\?)\\{k:${Q}ended${Q},id:\\2,at:\\1\\.at,stage:\\3\\}(?:;return |:)\\1(?![\\w$.])`, "g"), 1],
    ["owed back shows no Retry", new RegExp(`\\.stage!==${Q}part_filled${Q}&&${ID}\\.stage!==${Q}owed_back${Q}&&`, "g"), 1],
  ],
};
export const NAMES = { sign: MARKS.sign.map(([n]) => n), app: MARKS.app.map(([n]) => n) };

/** The page's scripts: the `src` of each script tag, with its `integrity` when it has one. */
export const scriptsOf = (html) =>
  [...html.matchAll(/<script\b[^>]*>/gi)].flatMap((m) => {
    const src = /\bsrc="([^"]+)"/i.exec(m[0])?.[1];
    return src ? [{ src, integrity: /\bintegrity="([^"]+)"/i.exec(m[0])?.[1] ?? null }] : [];
  });
/** A script's sha384, as an integrity attribute names it. */
export const sha384 = (text) => `sha384-${createHash("sha384").update(text).digest("base64")}`;
/** The names of `host`'s marks a script holds, each as often as it must. */
export const marksIn = (host, text) => MARKS[host].filter(([, re, min]) => (text.match(re) ?? []).length >= min).map(([n]) => n);

// ------------------------------------------------------------------------------------------------ the verdict
/** The check on one answer: { sign?: { source, pageStatus, js: [{ url, status, found }] }, app?: { ... } }, each host it
 *  holds; one that holds neither fails. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const hosts = ["sign", "app"].filter((h) => rec?.[h] !== undefined);
  say(hosts.length > 0, `hosts read: ${hosts.join(", ") || "none"}`);
  for (const host of hosts) {
    const h = rec[host];
    say(h.pageStatus === 200, `${host}: the page answers ${h.pageStatus ?? "nothing"}`);
    const js = h.js ?? [];
    say(js.length > 0 && js.every((f) => f.status === 200), `${host}: ${js.length} script(s) named by the page, each answering 200`);
    // each script's bytes are the ones its page pins: the browser runs no other, so marks in another file prove nothing
    const off = js.filter((f) => typeof f.integrity !== "string" || f.integrity !== f.sha384);
    say(off.length === 0, off.length ? `${host}: not the script its page pins: ${off.map((f) => f.url).join(", ")}` : `${host}: each script is the one its page pins`);
    const held = new Set(js.flatMap((f) => f.found ?? []));
    const miss = NAMES[host].filter((n) => !held.has(n));
    say(miss.length === 0, miss.length ? `${host}: the scripts lack: ${miss.join("; ")}` : `${host}: ${NAMES[host].join("; ")}`);
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
async function host(name, url, fetchFn) {
  const http = async (u) => {
    const r = await fetchFn(u, { redirect: "manual" });
    return { status: r.status, text: await r.text() };
  };
  const page = await http(url);
  const rec = { source: url, pageStatus: page.status, js: [] };
  for (const { src, integrity } of scriptsOf(page.text)) {
    const f = await http(new URL(src, url).href);
    rec.js.push({ url: src, status: f.status, integrity, sha384: sha384(f.text), found: marksIn(name, f.text) });
  }
  return rec;
}

/** What each of `hosts` serves, read with `fetchFn` (scripts/ci/bundle-checks.mjs passes one that answers from the
 *  build). */
export async function collect({ hosts = ["sign", "app"], fetchFn = fetch } = {}) {
  const rec = { at: new Date().toISOString() };
  if (hosts.includes("sign")) rec.sign = await host("sign", SIGN_URL, fetchFn);
  if (hosts.includes("app")) rec.app = await host("app", APP_URL, fetchFn);
  return rec;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  const h = opt("--host", null);
  try {
    if (h !== null && h !== "app" && h !== "sign") throw new Error(`--host app|sign, not ${h}`);
    const rec = await collect({ hosts: h === null ? ["sign", "app"] : [h] });
    const file = opt("--record", null);
    if (file) writeFileSync(file, `${JSON.stringify(rec, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"} (${[rec.sign?.source, rec.app?.source].filter(Boolean).join(", ")})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}

/** How scripts/ci/bundle-checks.mjs runs this check on a build (its `// Bundle: read` line): `f` answers from the build
 *  folders as the host would. */
export async function bundle(f, { host }) {
  return judge(await collect({ hosts: [host], fetchFn: f }));
}
