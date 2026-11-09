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
//      SIGN_HOST's served connect-src names both origins, so the page itself can make that read;
//   4. the mainnet Solana pool pin (card sol-pools-mainnet-pin: packages/wallet/src/pool/solana.ts SOL_POOLS.mainnet, its
//      program and the fee payer every proof binds), read from the served bundle itself, since scripts reach Blindfill
//      only through the kit's entry: the bundle carries the deploy record's program
//      (contracts/pool-solana/deployments/mainnet.json program_id, as SOL_MAINNET_DEPLOY) and exactly one fee payer
//      literal (`feePayer:` and a base58 key; the testnet build's devnet one is folded out), and the helper's mainnet fee
//      answer (GET /v1/pool/fee?cluster=mainnet&pool=<the program's pool, the kit's solanaPoolAccount>, Origin
//      SIGN_HOST, as the page's poolRelayFee asks it) names that program, pool and fee payer, with a fee exactly the
//      kit's solanaPoolFee at the Rent sysvar of 3 (the device's bind refuses any other: a wrong pin refuses every
//      mainnet release);
//   5. on two keyless mainnet RPCs of two operators (CHAIN_PAIR, not the helper's route: the helper's word is what is
//      checked), at finalized, the pin's program is an executable of the upgradeable loader and its fee payer a system
//      account with no data holding lamports. Each read goes through provider-answer.mjs's rpcAnswer: a provider that
//      answers nothing usable (read again once) is named on a `---` line and not judged, and the run is INCONCLUSIVE
//      (exit 3) unless another line is BAD.
// Not read here, and why: the brief's check opens the deployed testnet SIGN_HOST signed in with devnet notes and reads
// state.pools[].price and ready from the page. No testnet build is deployed anywhere (SIGN_HOST serves the mainnet
// build, which signpage-pool-flow and signpage-pool-notes hold; the testnet build has no host and no CSP of its own),
// and a signed-in SIGN_HOST's pools read needs a mainnet note. That read on the deployed page is card
// signpage-pool-mainnet's, on the mainnet page; the testnet half is proven by packages/signpage/test/
// pools-testnet.test.ts, pool-testnet.test.ts and main-testnet-pools.test.ts, and by the devnet run of
// packages/signpage/scripts/pool-pins-devnet.mjs (signpage-pool-pins.md).
// After: sign
//   node scripts/live-checks/signpage-pool-pins.mjs [--harness] [--record <file>]
//     --harness: this checkout's bundle and public/_headers stand for SIGN_HOST's /app.js and CSP (the pair read is live)
//     PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSolanaRent, SOLANA_RPC_RETRY, solanaHelperRpc, solanaJsonRpc, solanaPoolAccount, solanaPoolFee, solanaSameProvider } from "../../packages/kit/src/index.ts";
import { TESTNET_ONLY } from "./signpage-pool-flow.mjs";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";
import { signBuilt } from "../signpage-built.mjs";

const KEY = "signpage-pool-pins";
export const SIGN_HOST = "https://confidential.unrealized.trade";
const HELPER_HOST = "https://ct-api.unrealized.trade";
/** The signing page's Solana pair (packages/signpage/src/trade.ts SOLANA_PROVIDER_A and TRADE_HELPER's route). */
export const PAGE_PAIR = ["https://solana-rpc.publicnode.com", `${HELPER_HOST}/v1/rpc/solana`];
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** Two keyless mainnet RPCs of two operators for the pin's accounts (helper-sol-fee-payer-mainnet's RPCS). */
export const CHAIN_PAIR = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const SYSTEM = "11111111111111111111111111111111";
const DEPLOY_RECORD = path.join(REPO, "contracts/pool-solana/deployments/mainnet.json");
/** A fee payer literal in the minified bundle: the pin's `feePayer:` key and a base58 key in any quote. */
const FEE_PAYER_LITERAL = /feePayer:[`"']([1-9A-HJ-NP-Za-km-z]{32,44})[`"']/g;
/** This tree's bundle, built from its sources at the read (card signpage-generated-merge-free). */
const treeBundlePath = () => path.join(signBuilt(), "public/app.js");
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
  // 4. the mainnet pin the served bundle carries, and the helper's answer
  const d = rec.deploy ?? {};
  const payers = Array.isArray(b.feePayers) ? b.feePayers : [];
  say(b.status === 200 && typeof d.program === "string" && b.program === true, `the served bundle carries the deploy record's program: ${b.program === true ? d.program : `not ${d.program ?? "(no record)"}`}`);
  say(b.status === 200 && payers.length === 1, `the served bundle pins one fee payer: ${payers.length ? payers.join(", ") : "none"}`);
  const pinned = b.status === 200 && b.program === true && payers.length === 1;
  const pin = pinned ? { program: d.program, pool: d.pool, feePayer: payers[0] } : null;
  const f = rec.helperFee ?? {};
  const fb = f.body ?? {};
  say(pinned && f.status === 200 && fb.chain === "solana" && fb.cluster === "mainnet" && fb.program === pin.program && fb.pool === pin.pool,
    `the helper's mainnet fee answer is the pinned pool's: ${f.status !== 200 ? `HTTP ${f.status ?? "none"}` : JSON.stringify([fb.chain, fb.cluster, fb.program, fb.pool])}`);
  say(pinned && f.status === 200 && fb.fee_payer === pin.feePayer, `the helper signs with the pinned fee payer: ${f.status === 200 ? `${String(fb.fee_payer)}${fb.fee_payer === pin?.feePayer ? "" : `, the bundle's ${pin?.feePayer ?? "none"}`}` : "no answer"}`);
  const want = read ? solanaPoolFee({ lamportsPerByte: BigInt(r.lamportsPerByte), factor: BigInt(r.factor) }).toString() : null;
  say(want !== null && fb.fee === want, `the helper's fee is solanaPoolFee at that rent: ${String(fb.fee)}${want !== null && fb.fee !== want ? `, not ${want}` : ""}`);
  // 5. the pin's accounts on two mainnet RPCs
  const c = rec.chain ?? {};
  const onPair = Array.isArray(c.rpcs) && c.rpcs.length === 2 && c.rpcs.every((u, i) => u === CHAIN_PAIR[i]);
  const acct = (list, ok) => Array.isArray(list) && list.length === 2 && list.every((a) => a && a.error === undefined && ok(a));
  say(onPair, `the pin's accounts are read on ${CHAIN_PAIR.join(" and ")}: ${(c.rpcs ?? []).join(" and ") || "none"}`);
  const of = (list, address) => Array.isArray(list) && list.every((a) => a?.address === address);
  // a provider with no usable answer is named, and its read not judged (provider-answer.mjs)
  const quiet = [];
  const judged = (list, ok, s) => {
    const none = Array.isArray(list) ? list.filter((a) => typeof a?.noAnswer === "string") : [];
    if (none.length) return void quiet.push(...none.map((a) => `${a.noAnswer} (${s})`));
    say(ok, s);
  };
  judged(c.program, onPair && pinned && of(c.program, pin.program) && acct(c.program, (a) => a.executable === true && a.owner === LOADER), `the program is an executable on both: ${JSON.stringify(c.program ?? null)}`);
  judged(c.feePayer, onPair && pinned && of(c.feePayer, pin.feePayer) && acct(c.feePayer, (a) => a.owner === SYSTEM && a.executable === false && a.space === 0 && /^[1-9]\d*$/.test(String(a.lamports))),
    `the fee payer is a system account holding lamports on both: ${JSON.stringify(c.feePayer ?? null)}`);
  for (const q of quiet) lines.push(`--- ${q}`);
  const verdict = verdictOf(lines.some((l) => l.startsWith("BAD")), quiet.length > 0);
  return { ok: verdict === "PASS", verdict, lines };
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

/** The helper's mainnet fee answer for the pinned pool, asked as the page asks it. */
export async function helperFeeRead(pool) {
  try {
    const res = await fetch(`${HELPER_HOST}/v1/pool/fee?cluster=mainnet&pool=${pool}`, { headers: { origin: SIGN_HOST }, redirect: "error", signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 300);
    }
    return { status: res.status, commit: res.headers.get("x-helper-commit"), body };
  } catch (e) {
    return { status: 0, error: String(e?.message ?? e) };
  }
}

/** getAccountInfo of `address` on one RPC at finalized through rpcAnswer, its data left out: { owner, executable,
 *  lamports, space }, { error } (a JSON-RPC error or no account) or { noAnswer }. */
async function accountRead(url, address) {
  const a = await rpcAnswer(url, "getAccountInfo", [address, { encoding: "base64", commitment: "finalized", dataSlice: { offset: 0, length: 0 } }], { timeoutMs: 15_000 });
  if (a.noAnswer !== undefined) return { url, address, noAnswer: a.noAnswer };
  if (a.error !== undefined) return { url, address, error: JSON.stringify(a.error) };
  const v = a.result?.value;
  if (v === undefined) return { url, address, error: "no value" };
  if (v === null) return { url, address, error: "no account" };
  return { url, address, owner: v.owner, executable: v.executable, lamports: String(v.lamports), space: v.space };
}

export async function collect({ harness = false } = {}) {
  const at = new Date().toISOString();
  const tree = readFileSync(treeBundlePath());
  const treeBundle = sha384(tree);
  const r = JSON.parse(readFileSync(DEPLOY_RECORD, "utf8"));
  const deploy = r.cluster === "mainnet" && typeof r.program_id === "string" ? { program: r.program_id, pool: solanaPoolAccount(r.program_id) } : null;
  const pins = (text) => ({ program: deploy !== null && text.includes(deploy.program), feePayers: [...new Set([...text.matchAll(FEE_PAYER_LITERAL)].map((m) => m[1]))] });
  let signBundle;
  let signCsp;
  if (harness) {
    const text = tree.toString("utf8");
    signBundle = { status: 200, sha384: treeBundle, testnet: TESTNET_ONLY.filter((s) => text.includes(s)), ...pins(text) };
    signCsp = treeCsp();
  } else {
    signCsp = (await fetch(`${SIGN_HOST}/`, { signal: AbortSignal.timeout(15_000) })).headers.get("content-security-policy");
    const res = await fetch(`${SIGN_HOST}/app.js`, { signal: AbortSignal.timeout(15_000) });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    signBundle = { status: res.status, sha384: sha384(bytes), testnet: TESTNET_ONLY.filter((s) => text.includes(s)), ...pins(text) };
  }
  const rent = await rentRead();
  // the helper and the chain are read for the deploy's pool and the one fee payer the bundle pins (none read if it pins none or several)
  const payer = signBundle.feePayers.length === 1 ? signBundle.feePayers[0] : null;
  const helperFee = deploy === null ? null : await helperFeeRead(deploy.pool);
  const chain = deploy === null ? null : { rpcs: CHAIN_PAIR, program: await Promise.all(CHAIN_PAIR.map((u) => accountRead(u, deploy.program))), feePayer: payer === null ? [] : await Promise.all(CHAIN_PAIR.map((u) => accountRead(u, payer))) };
  return { check: KEY, at, source: harness ? "harness: this checkout's bundle and _headers as SIGN_HOST's, the pair, the helper and the chain read live" : `live ${SIGN_HOST}`, treeBundle, signBundle, signCsp, rent, deploy, helperFee, chain };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  try {
    const rec = await collect({ harness: a.includes("--harness") });
    const file = a.includes("--record") ? a[a.indexOf("--record") + 1] : null;
    if (file) writeFileSync(file, `${JSON.stringify(rec, null, 1)}\n`);
    const { verdict, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`CARD ${KEY} / live: ${verdict} (${rec.source})`);
    process.exit(EXIT[verdict]);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
