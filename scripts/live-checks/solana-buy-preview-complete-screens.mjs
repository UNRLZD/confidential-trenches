#!/usr/bin/env node
// Live check of card solana-buy-preview-complete on APP_HOST (https://ct-app.unrealized.trade): the trade box's You
// receive on a Solana pool buy draws what the signing page's dry answer says the buy gets. Its signing page's half is
// solana-buy-preview-complete.mjs (SIGN_HOST). Reads only: nothing is signed or sent. What it holds, and only that:
// APP_HOST serves the script its index.html pins (its sha384), and, each found by a mark of the minified bundle's shape
// (apps/terminal/src/screens/trade/TradeBox.tsx useTrade and TradeView, model.ts receiveShown, packages/kit's client):
//   - ask: the box's Fee read (pool.buy.dry with the typed amount) keeps the answer's out and the amount it asked for,
//     beside the cost;
//   - shown: You receive's rule: the out of this coin's answer, dimmed while another amount is typed, a dash with none;
//   - wired: on a pool path the box's trade state carries that rule's value as its receive;
//   - drawn: You receive (`trade-receive`) draws `≈ <out> <symbol>` from it, and dims it while pending, before any set
//     preview (which the live source has none of);
//   - hello: the app's kit names itself 1.14, the version the signing page sends out to.
// The rule's cases are apps/terminal/test/trade-pool-buy.test.ts and the box's drawing apps/terminal/test/trade-pool/
// run.mjs at the released commit. The recorded answers are facts() over apps/terminal/dist as the deploy builds it.
// After: app
// Bundle: read app
//   node scripts/live-checks/solana-buy-preview-complete-screens.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "solana-buy-preview-complete-screens";
export const APP = "https://ct-app.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const N = "[\\w$]+";
const esc = (v) => v.replace(/\$/g, "\\$");

const ASK = new RegExp(`\\{key:${N},cost:(${N})\\.result\\.cost,\\.\\.\\.\\1\\.result\\.out===void 0\\?\\{\\}:\\{out:\\1\\.result\\.out\\},\\.\\.\\.(${N})===null\\?\\{\\}:\\{amount:\\2\\}\\}`);
/** receiveShown (group: its name). */
const SHOWN = new RegExp(`function (${N})\\((${N}),(${N}),(${N})\\)\\{return \\2===null\\|\\|\\3===null\\|\\|\\2\\.key!==\\3\\|\\|\\2\\.out===void 0\\|\\|\\4===null\\|\\|\\4<=0n\\?null:\\{out:\\2\\.out,pending:\\2\\.amount!==\\4\\}\\}`);

/** The script an index.html pins, and its integrity. */
const pinned = (index) => {
  const m = /<script[^>]*\bsrc="([^"]+\.js)"[^>]*\bintegrity="([^"]+)"/.exec(index ?? "") ?? /<script[^>]*\bintegrity="([^"]+)"[^>]*\bsrc="([^"]+\.js)"/.exec(index ?? "");
  if (!m) return null;
  return m[1].endsWith(".js") ? { src: m[1], integrity: m[2] } : { src: m[2], integrity: m[1] };
};

/** What the check keeps of the reads: the index, the served script's sha384, and the marks read from it. */
export function facts(index, js) {
  const shown = SHOWN.exec(js);
  // the box's state: `<v>=<onPool>?receiveShown(read,key,amount):null`, returned as its receive
  const wiredM = shown ? new RegExp(`(?:^|[^\\w$.])(${N})=${N}\\?${esc(shown[1])}\\(${N},${N},${N}\\):null`).exec(js) : null;
  const wired = wiredM !== null && new RegExp(`[,{]receive:${esc(wiredM[1])}[,}]`).test(js);
  // the view: `<r>=<t>.receive,<p>=<r>===null?...:<r>.pending,<e>=<r>===null?...:`≈ ${fmt(<r>.out)} ${sym}``, drawn in
  // trade-receive with the pending mark
  const view = /(?:^|[^\w$.])([\w$]+)=[\w$]+\.receive,([\w$]+)=\1===null\?[^,]{0,80}:\1\.pending,([\w$]+)=\1===null\?[^;]{0,120}?:`≈ \$\{[\w$]+\(\1\.out\)\} \$\{[\w$]+\}`/.exec(js);
  const drawn = view !== null && new RegExp(`"data-pending":${esc(view[2])}\\|\\|void 0,"data-testid":\`trade-receive\`,children:${esc(view[3])}\\}`).test(js);
  const hello = /type:`hello`,kit:([\w$]+)\}/.exec(js);
  return {
    index,
    sha384: sha384(js),
    ask: ASK.test(js),
    shown: shown !== null,
    wired,
    drawn,
    hello: hello !== null && new RegExp(`(?:^|[^\\w$.])${esc(hello[1])}=\`1\\.14\``).test(js),
  };
}

export const SAYS = Object.freeze({
  ask: "the trade box's Fee read does not keep the dry answer's out and the amount it asked for",
  shown: "the trade box has no You receive rule for a pool buy (this coin's out, dimmed while another amount is typed, a dash with none)",
  wired: "the trade box's state on a pool path does not carry that rule's value as its receive",
  drawn: "You receive does not draw the dry answer's out (≈ out symbol, dimmed while pending)",
  hello: "the app's kit does not name itself 1.14: the signing page sends it no out",
});

/** The verdict on an answer { index, sha384, ask, shown, wired, drawn, hello }. */
export function judge(a) {
  const lines = [];
  const pin = pinned(a?.index);
  if (!pin) lines.push("BAD APP_HOST's index.html pins no script");
  else if (pin.integrity !== a.sha384) lines.push("BAD APP_HOST's served script is not the one index.html pins");
  for (const [k, say] of Object.entries(SAYS)) if (a?.[k] !== true) lines.push(`BAD ${say}`);
  return { ok: lines.length === 0, lines };
}

export async function read(fetchFn = fetch) {
  const get = async (path) => {
    const r = await fetchFn(`${APP}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status}`);
    return r.text();
  };
  const index = await get("/");
  const pin = pinned(index);
  if (!pin) return facts(index, "");
  return facts(index, await get(pin.src.startsWith("/") ? pin.src : `/${pin.src}`));
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
