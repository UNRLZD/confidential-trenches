#!/usr/bin/env node
// Live check of card signpage-withdraw-handoff on SIGN_HOST (https://confidential.unrealized.trade) and the release
// helper it reads. What it holds, on what is deployed:
//   - SIGN_HOST's build is one network's: its CSP connect-src names the mainnet NEAR pair and no testnet NEAR RPC, so
//     the mainnet build cannot read a testnet RPC;
//   - SIGN_HOST's /app.js is the one its index.html pins (its sha384) and carries this card's code (the withdraw fee
//     path and the form's refusal where its network names no relayer, "names no withdrawal relayer on"), and none of the
//     testnet relayer's ids: the testnet relayer is the testnet build's only (RELEASE_WITHDRAW_RELAYER folds it);
//   - the withdraw form's fee read, run with the page's own code (askWithdrawFee, readTokenStorageMin,
//     readWithdrawFeeMax, in packages/wallet/scripts/withdraw-fee-check.ts as a child process) on the testnet release pair, mainnet's pair for the price, and the deployed helper: the
//     helper's GET /v1/withdraw/fee for the testnet token names exactly the release's relayer and fee recipient, and
//     its relay_fee is a u128 at or below the device's own fee_max at the token's storage minimum. A helper that quotes
//     above the device's cap, or names another relayer, fails it: the form would show the fee unread and hand off nothing.
// The testnet withdrawal itself (the hand-off from the testnet build's form to settled) is a money run, not this check.
// After: sign
//   node scripts/live-checks/signpage-withdraw-handoff.mjs [--record <file>]
//   node scripts/live-checks/signpage-withdraw-handoff.mjs --local [--record <file>]
//     the same with this tree's committed build (index.html, public/app.js, public/_headers) in place of SIGN_HOST's;
//     the helper and the RPCs are still read live
//   node scripts/live-checks/signpage-withdraw-handoff.mjs --answer <file>     judge a recorded answer, no network
// --record writes the answer judge() reads, so the test can replay it. PASS exit 0, FAIL exit 1, error exit 2; the last
// line is "PASS signpage-withdraw-handoff" or "FAIL signpage-withdraw-handoff", each failure a "BAD ..." line.
import "../net-window.mjs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signBuilt } from "../signpage-built.mjs";

const KEY = "signpage-withdraw-handoff";
export const SIGN_URL = "https://confidential.unrealized.trade/";
/** The release values the check judges by: the wallet's own (packages/wallet/scripts/withdraw-fee-check.ts --consts
 *  prints them, and the test holds these equal to them). */
export const RELAYER = { relayer_account: "r-2b700409.bf-vt-20261102t071444.testnet", fee_recipient: "f-2b700409.bf-vt-20261102t071444.testnet" }; // gitleaks:allow (public account ids)
export const TESTNET_HOSTS = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org", "https://near-testnet.drpc.org"];
export const MAINNET_PAIR = ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"];
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const CHILD = path.join(REPO, "packages/wallet/scripts/withdraw-fee-check.ts");
/** The child's one JSON line for `args`. */
export function child(args = []) {
  const r = spawnSync(process.execPath, [CHILD, ...args], { encoding: "utf8", timeout: 120_000 });
  if (r.status !== 0) throw new Error(`withdraw-fee-check exit ${r.status ?? r.signal}: ${(r.stderr ?? "").trim().split("\n").slice(-3).join(" | ")}`);
  return JSON.parse(r.stdout.trim().split("\n").at(-1));
}
const DEC = /^(0|[1-9][0-9]{0,38})$/;
const U128 = 1n << 128n;

/** The verdict on one answer: { ok, lines } with a BAD line per failure. */
export function judge(a) {
  const lines = [];
  const bad = (s) => lines.push(`BAD ${s}`);
  const connect = /(?:^|;)\s*connect-src ([^;]*)/.exec(a?.csp ?? "")?.[1]?.trim().split(/\s+/) ?? null;
  if (connect === null) bad("SIGN_HOST's CSP has no connect-src");
  else {
    for (const h of TESTNET_HOSTS) if (connect.includes(h)) bad(`SIGN_HOST's connect-src names the testnet RPC ${h}: the mainnet build could read testnet`);
    for (const h of MAINNET_PAIR) if (!connect.includes(h)) bad(`SIGN_HOST's connect-src lacks the mainnet pair's ${h}`);
  }
  const pin = /<script type="module" src="\/app\.js" integrity="(sha384-[A-Za-z0-9+/=]+)"/.exec(a?.html ?? "")?.[1] ?? null;
  if (pin === null || pin !== a?.appSha384) bad(`SIGN_HOST's /app.js (${a?.appSha384 ?? "none"}) is not the one its index.html pins (${pin ?? "none"})`);
  if (!a?.app?.noRelayer) bad("SIGN_HOST's /app.js carries no withdraw form fee read: the build is before this card");
  if (a?.app?.testnetRelayer !== false) bad("SIGN_HOST's /app.js carries the testnet withdrawal relayer's ids: the mainnet build is not folded");
  if (!a?.app?.feePath) bad("SIGN_HOST's /app.js carries no withdraw fee path");
  const f = a?.fee;
  if (f === null || typeof f !== "object") bad("the helper gave no fee answer for the testnet token");
  else {
    if (f.relayer_account !== RELAYER.relayer_account || f.fee_recipient !== RELAYER.fee_recipient)
      bad(`the helper's testnet fee answer names ${f.relayer_account} / ${f.fee_recipient}, not the release's ${RELAYER.relayer_account} / ${RELAYER.fee_recipient}`);
    const fee = typeof f.relay_fee === "string" && DEC.test(f.relay_fee) && BigInt(f.relay_fee) < U128 ? BigInt(f.relay_fee) : null;
    const cap = typeof a?.feeMax === "string" && DEC.test(a.feeMax) ? BigInt(a.feeMax) : null;
    if (fee === null) bad(`the helper's relay_fee ${JSON.stringify(f.relay_fee)} is not a u128 decimal`);
    if (cap === null) bad("the device's fee_max was not read");
    if (fee !== null && cap !== null && fee > cap) bad(`the helper's relay_fee ${fee} is above the device's fee_max ${cap}: the form refuses it`);
  }
  if (a?.feeError) bad(`the form's fee read stopped: ${a.feeError}`);
  return { ok: lines.length === 0, lines };
}

const PKG = path.join(REPO, "packages/signpage");
/** This tree's SIGN_HOST build as committed (index.html, public/app.js, public/_headers' /* CSP), for --local. */
function localBuild() {
  const headers = readFileSync(path.join(PKG, "public/_headers"), "utf8");
  const csp = /^\/\*\n(?:\s.*\n)*?\s+Content-Security-Policy:\s*(.*)$/m.exec(headers)?.[1] ?? "";
  return { html: readFileSync(path.join(signBuilt(), "index.html"), "utf8"), csp, js: readFileSync(path.join(signBuilt(), "public/app.js")) };
}

/** The live answer: SIGN_HOST's policy and bundle (or this tree's, `local`), and the form's fee read on the testnet release. */
export async function read(local = false) {
  let html, csp, js;
  if (local) ({ html, csp, js } = localBuild());
  else {
    const res = await fetch(SIGN_URL, { redirect: "error" });
    html = await res.text();
    csp = res.headers.get("content-security-policy") ?? "";
    js = Buffer.from(await (await fetch(new URL("/app.js", SIGN_URL), { redirect: "error" })).arrayBuffer());
  }
  const appSha384 = `sha384-${createHash("sha384").update(js).digest("base64")}`;
  const text = js.toString("utf8");
  const app = {
    noRelayer: text.includes("names no withdrawal relayer on"),
    testnetRelayer: text.includes(RELAYER.relayer_account) || text.includes(RELAYER.fee_recipient),
    feePath: text.includes("/v1/withdraw/fee"),
  };
  // the form's fee read, the page's own code, in a child process (see CHILD)
  const { fee, feeMax, feeError } = child();
  return { at: new Date().toISOString(), csp, html, appSha384, app, fee, feeMax, feeError };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const at = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
  try {
    const answer = at("--answer") ? JSON.parse(readFileSync(at("--answer"), "utf8")) : await read(argv.includes("--local"));
    if (at("--record")) writeFileSync(at("--record"), `${JSON.stringify(answer, null, 2)}\n`);
    const v = judge(answer);
    for (const l of v.lines) console.log(l);
    console.log(`${v.ok ? "PASS" : "FAIL"} ${KEY}`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
