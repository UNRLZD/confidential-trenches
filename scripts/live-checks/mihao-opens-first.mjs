#!/usr/bin/env node
// Live check of card mihao-opens-first on APP_HOST (https://ct-app.unrealized.trade). What it holds, and only that:
// APP_HOST serves the script its index.html pins (its sha384), and that script opens / on All (a fresh open, no token in
// the address) on mihao, Solana mint 4CxjZyMNoF1p6eXHXHv1TWpS2X47CuUmLwtGe18spump, a pump.fun coin on its PumpSwap pool,
// a venue the private buy fills (owner 14 Nov 21:33Z, "pump fun coin"; card nearkat-opens-first's NEARKAT before it
// trades on Meteora DLMM alone, so its Buy drew Unavailable), read as minified:
//   - the token / opens (apps/terminal/src/routes/routes.ts OPEN_TOKEN): `{chain:`solana`,id:`4Cxj…`}`;
//   - / on All reads that token, a chain pick its own top Trending token (source.ts loadHome): `e===`all`?x(T.chain,T.id`.
// And the token / opens still has a venue the private buy fills, read as the signing page's buy reads it
// (packages/signpage/src/pools.ts readCoinVenue: the kit's readSolanaPoolBuyVenue on pump's curve, else on its canonical
// PumpSwap pool) on two public mainnet RPCs that must agree: NEARKAT lost its buy with no check reading it. A read that
// does not land (a provider down or slow, or the two at different slots) is an error (exit 2), never a FAIL.
// That a token named in the address still wins, and the page drawn, are held by the tests that build them
// (apps/terminal/test/no-test-token.test.ts, test/chains-evm/run.mjs at 1440 in a browser). The recorded answers are
// read() over APP_HOST or over this card's build (apps/terminal/dist), with the venue read on mainnet.
// After: app
// Bundle: read app
//   node scripts/live-checks/mihao-opens-first.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readSolanaPoolBuyVenue, SOLANA_RPC_WINDOW_RETRY, solanaJsonRpc, SolanaRpcTransportError } from "../../packages/kit/src/index.ts";

const KEY = "mihao-opens-first";
export const APP = "https://ct-app.unrealized.trade";
export const MIHAO = "4CxjZyMNoF1p6eXHXHv1TWpS2X47CuUmLwtGe18spump";
const RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const N = "[\\w$]+";
const Q = "[`\"']";
/** The token / opens, as one object, its name kept (the group). */
const OPEN = new RegExp(`(${N})=\\{chain:${Q}solana${Q},id:${Q}${MIHAO}${Q}\\}`);
/** Any Solana token object: its name and its mint. */
const SOLANA_TOKEN = new RegExp(`(${N})=\\{chain:${Q}solana${Q},id:${Q}([1-9A-HJ-NP-Za-km-z]{32,44})${Q}\\}`, "g");
/** / on All reads that token by its chain and id. */
const HOME = (name) => new RegExp(`${N}===${Q}all${Q}\\?${N}\\(${name.replace(/\$/g, "\\$")}\\.chain,${name.replace(/\$/g, "\\$")}\\.id[,)]`);

/** The script an index.html pins, and its integrity. */
const pinned = (index) => {
  const m = /<script[^>]*\bsrc="([^"]+\.js)"[^>]*\bintegrity="([^"]+)"/.exec(index ?? "") ?? /<script[^>]*\bintegrity="([^"]+)"[^>]*\bsrc="([^"]+\.js)"/.exec(index ?? "");
  if (!m) return null;
  return m[1].endsWith(".js") ? { src: m[1], integrity: m[2] } : { src: m[2], integrity: m[1] };
};

/** What the check keeps of the script: the index, its served script's sha384, the two marks read from it, and the mint
 *  of the Solana token / on All reads (null with none), whose venue is read. */
export function facts(app) {
  const open = OPEN.exec(app.js);
  const opens = [...app.js.matchAll(SOLANA_TOKEN)].find((m) => HOME(m[1]).test(app.js))?.[2] ?? null;
  return { app: { index: app.index, sha384: sha384(app.js), open: !!open, home: !!open && HOME(open[1]).test(app.js), opens } };
}

/** The coin's venue as the signing page's buy reads it (readCoinVenue): { mint, kind, at } or, when neither venue is one
 *  the buy fills, { mint, error }. A read that does not land throws. */
// card live-checks-ride-out-a-public-rpc-stall: a stall is asked again within the kit's window, and one that outlasts it
// is the SolanaRpcTransportError thrown below, never a venue's refusal
export async function readVenue(mint, rpcs = RPCS.map((u) => solanaJsonRpc(u, { retry: SOLANA_RPC_WINDOW_RETRY }))) {
  let error;
  for (const kind of ["pump-curve", "pumpswap"]) {
    try {
      const v = await readSolanaPoolBuyVenue(rpcs, kind, mint);
      return { mint, kind: v.kind, at: v.kind === "pump-curve" ? v.curve : v.pool };
    } catch (e) {
      if (e instanceof SolanaRpcTransportError || /disagree|not an accounts read/.test(String(e?.message))) throw e;
      error = String(e?.message ?? e).slice(0, 200);
    }
  }
  return { mint, error };
}

const appLines = (a, bad) => {
  const pin = pinned(a?.app?.index);
  if (!pin) bad("APP_HOST's index.html pins no script");
  else if (pin.integrity !== a.app.sha384) bad("APP_HOST's served script is not the one index.html pins");
  if (a?.app?.open !== true) bad(`the app names no token for / to open: mihao (${MIHAO}) is not in it`);
  else if (a?.app?.home !== true) bad("/ on All does not open mihao: it opens the top Trending token");
};

/** The verdict on an answer { app: { index, sha384, open, home, opens }, venue: { mint, kind, at } | { mint, error } }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  appLines(a, bad);
  const v = a?.venue;
  if (!v || typeof v.mint !== "string") bad("no venue read for the token / opens");
  else if (v.mint !== a?.app?.opens) bad(`the venue read is ${v.mint}'s, not the token / opens`);
  else if (typeof v.error === "string" || (v.kind !== "pump-curve" && v.kind !== "pumpswap")) bad(`the token / opens (${v.mint}) has no venue the private buy fills: ${v.error ?? v.kind}`);
  return { ok: lines.length === 0, lines };
}

export async function read(fetchFn = fetch, venueOf = readVenue) {
  const get = async (path) => {
    const r = await fetchFn(`${APP}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${APP}${path}: HTTP ${r.status}`);
    return r.text();
  };
  const index = await get("/");
  const pin = pinned(index);
  const { app } = facts({ index, js: pin ? await get(pin.src.startsWith("/") ? pin.src : `/${pin.src}`) : "" });
  return { app, venue: app.opens ? await venueOf(app.opens) : null };
}

/** How scripts/ci/bundle-checks.mjs runs this check on a build (its `// Bundle: read` line): the build's script alone,
 *  since the venue is mainnet's, not the build's (read after every deploy). */
export async function bundle(f) {
  const lines = [];
  appLines(await read(f, async () => null), (m) => lines.push(`BAD ${m}`));
  return { ok: lines.length === 0, lines };
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
