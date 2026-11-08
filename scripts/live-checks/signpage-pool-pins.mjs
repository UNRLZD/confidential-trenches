#!/usr/bin/env node
// Live check of card signpage-pool-pins: the signing page's state.pools is its network's pinned pools, with the proof
// queue's ready proofs and, on Solana, tap_max from the Rent sysvar the page reads on its own pair. What SIGN_HOST
// serves today is its mainnet build, so this reads what is deployed of it:
//   1. SIGN_HOST's /app.js has the sha384 of this checkout's signing page bundle (packages/signpage/public/app.js), so the
//      deployed page carries this card's src/pools.ts and main.ts wiring;
//   2. that bundle is the mainnet table: it carries none of the testnet build's pins or providers (signpage-pool-flow's
//      TESTNET_ONLY), so the devnet pool never reaches SIGN_HOST's state;
//   3. the Rent sysvar the page reads for tap_max (src/pools.ts rentOnce: the kit's readSolanaRent on the page's Solana
//      pair, SIGN_HOST's provider A and the helper's keyed route) is read now on that pair, both answers agreeing, and
//      SIGN_HOST's served connect-src names both origins, so the page itself can make that read.
// Not read here, and why: the brief's check opens the deployed testnet SIGN_HOST signed in with devnet notes and reads
// state.pools[].price and ready from the page. No testnet build is deployed anywhere (SIGN_HOST serves the mainnet
// build, which signpage-pool-flow and signpage-pool-notes hold; the testnet build has no host and no CSP of its own),
// and mainnet pins no pool yet, so a signed-in SIGN_HOST answers pools []. That read on the deployed page is card
// signpage-pool-mainnet's, on the mainnet page; the testnet half is proven by packages/signpage/test/
// pools-testnet.test.ts, pool-testnet.test.ts and main-testnet-pools.test.ts, and by the devnet run of
// packages/signpage/scripts/pool-pins-devnet.mjs (signpage-pool-pins.md).
// After: sign
//   node scripts/live-checks/signpage-pool-pins.mjs [--harness] [--record <file>]
//     --harness: this checkout's bundle and public/_headers stand for SIGN_HOST's /app.js and CSP (the pair read is live)
//     PASS exit 0, FAIL exit 1, error exit 2
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSolanaRent, SOLANA_RPC_RETRY, solanaHelperRpc, solanaJsonRpc, solanaSameProvider } from "../../packages/kit/src/index.ts";
import { TESTNET_ONLY } from "./signpage-pool-flow.mjs";

const KEY = "signpage-pool-pins";
export const SIGN_HOST = "https://confidential.unrealized.trade";
const HELPER_HOST = "https://ct-api.unrealized.trade";
/** The signing page's Solana pair (packages/signpage/src/trade.ts SOLANA_PROVIDER_A and TRADE_HELPER's route). */
export const PAGE_PAIR = ["https://solana-rpc.publicnode.com", `${HELPER_HOST}/v1/rpc/solana`];
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TREE_BUNDLE = path.join(REPO, "packages/signpage/public/app.js");
const TREE_HEADERS = path.join(REPO, "packages/signpage/public/_headers");
const sha384 = (b) => `sha384-${createHash("sha384").update(b).digest("base64")}`;

// ------------------------------------------------------------------------------------------------ the verdict
export function judge(rec) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  const b = rec.signBundle ?? {};
  say(b.status === 200 && typeof rec.treeBundle === "string" && b.sha384 === rec.treeBundle,
    `SIGN_HOST's /app.js is this checkout's signing page bundle: ${b.status !== 200 ? `HTTP ${b.status ?? "none"}` : b.sha384 === rec.treeBundle ? b.sha384 : `served ${b.sha384}, the checkout's ${rec.treeBundle}`}`);
  say(b.status === 200 && Array.isArray(b.testnet) && b.testnet.length === 0,
    `the served bundle is the mainnet table, with no testnet pin or provider: ${Array.isArray(b.testnet) ? (b.testnet.length ? `carries ${b.testnet.join(", ")}` : "none") : "not read"}`);
  const r = rec.rent ?? {};
  const pair = Array.isArray(r.rpcs) && r.rpcs.length === 2 && r.rpcs.every((u, i) => u === PAGE_PAIR[i]);
  say(pair, `the Rent read is on the page's Solana pair: ${(r.rpcs ?? []).join(" and ") || "none"}`);
  const read = typeof r.lamportsPerByte === "string" && /^[1-9]\d*$/.test(r.lamportsPerByte) && (r.factor === "1" || r.factor === "2");
  say(read && r.error === undefined, `the pair agrees on the Rent sysvar: ${read ? `${r.lamportsPerByte} lamports per byte, factor ${r.factor}` : (r.error ?? "no read")}`);
  const src = (/(?:^|;)\s*connect-src\s+([^;]*)/.exec(rec.signCsp ?? "")?.[1] ?? "").split(/\s+/);
  const reach = PAGE_PAIR.map((u) => new URL(u).origin).filter((o) => !src.includes(o));
  say(src.length > 1 && reach.length === 0, `SIGN_HOST's connect-src names both: ${reach.length ? `not ${reach.join(", ")}` : PAGE_PAIR.map((u) => new URL(u).origin).join(" and ")}`);
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
export async function rentRead() {
  const rpcs = [solanaJsonRpc(PAGE_PAIR[0], { retry: SOLANA_RPC_RETRY }), solanaHelperRpc(HELPER_HOST, { retry: SOLANA_RPC_RETRY })];
  const out = { rpcs: PAGE_PAIR };
  if (solanaSameProvider(rpcs[0], rpcs[1])) return { ...out, error: "one provider twice" };
  try {
    const rent = await readSolanaRent(rpcs);
    return { ...out, lamportsPerByte: rent.lamportsPerByte.toString(), factor: rent.factor.toString() };
  } catch (e) {
    return { ...out, error: String(e?.message ?? e) };
  }
}

/** `/`'s CSP in this checkout's public/_headers (the rule for every path). */
function treeCsp() {
  const m = /^\s*Content-Security-Policy:\s*(.+)$/m.exec(readFileSync(TREE_HEADERS, "utf8"));
  return m ? m[1].trim() : null;
}

export async function collect({ harness = false } = {}) {
  const at = new Date().toISOString();
  const tree = readFileSync(TREE_BUNDLE);
  const treeBundle = sha384(tree);
  let signBundle;
  let signCsp;
  if (harness) {
    const text = tree.toString("utf8");
    signBundle = { status: 200, sha384: treeBundle, testnet: TESTNET_ONLY.filter((s) => text.includes(s)) };
    signCsp = treeCsp();
  } else {
    signCsp = (await fetch(`${SIGN_HOST}/`, { signal: AbortSignal.timeout(15_000) })).headers.get("content-security-policy");
    const res = await fetch(`${SIGN_HOST}/app.js`, { signal: AbortSignal.timeout(15_000) });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    signBundle = { status: res.status, sha384: sha384(bytes), testnet: TESTNET_ONLY.filter((s) => text.includes(s)) };
  }
  const rent = await rentRead();
  return { check: KEY, at, source: harness ? "harness: this checkout's bundle and _headers as SIGN_HOST's, the pair read live" : `live ${SIGN_HOST}`, treeBundle, signBundle, signCsp, rent };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  try {
    const rec = await collect({ harness: a.includes("--harness") });
    const file = a.includes("--record") ? a[a.indexOf("--record") + 1] : null;
    if (file) writeFileSync(file, `${JSON.stringify(rec, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"} (${rec.source})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
