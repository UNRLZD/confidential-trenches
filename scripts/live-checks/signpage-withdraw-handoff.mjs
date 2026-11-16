#!/usr/bin/env node
// Live check of card signpage-withdraw-handoff on SIGN_HOST (https://confidential.unrealized.trade) and the release
// helper it reads. What it holds, on what is deployed:
//   - SIGN_HOST's build is one network's: its CSP connect-src names the mainnet NEAR pair and no testnet NEAR RPC, so
//     the mainnet build cannot read a testnet RPC;
//   - SIGN_HOST's /app.js is the one its index.html pins (its sha384) and carries this card's code (the withdraw fee
//     path and the form's refusal where its network names no relayer, "names no withdrawal relayer on"), and none of the
//     testnet relayer's ids: the testnet relayer is the testnet build's only (RELEASE_WITHDRAW_RELAYER folds it).
// It reads SIGN_HOST only, never a test network (card live-checks-read-mainnet-only): the testnet names it must find
// absent come from test-network-names.mjs. The fee read it once ran on the testnet release (withdraw-fee-check.ts) is
// gone; mainnet's fee (the helper's quote names the release's relayer and is at most the device's own fee_max) is
// relayer-withdraw-fee's, which runs after every helper deploy.
// After: sign
// Bundle: out the page's CSP header
//   node scripts/live-checks/signpage-withdraw-handoff.mjs [--record <file>]
//   node scripts/live-checks/signpage-withdraw-handoff.mjs --local [--record <file>]
//     the same with this tree's committed build (index.html, public/app.js, public/_headers) in place of SIGN_HOST's
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
import { NEAR_TESTNET_RELAYER, TEST_HOSTS } from "./test-network-names.mjs";

const KEY = "signpage-withdraw-handoff";
export const SIGN_URL = "https://confidential.unrealized.trade/";
/** The testnet values a mainnet build must not carry: the wallet's own (packages/wallet/scripts/withdraw-fee-check.ts
 *  --consts prints them with no network read, and the test holds these equal to them). */
export const RELAYER = NEAR_TESTNET_RELAYER;
export const TESTNET_HOSTS = TEST_HOSTS.near;
export const MAINNET_PAIR = ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"];
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const CHILD = path.join(REPO, "packages/wallet/scripts/withdraw-fee-check.ts");
/** The child's one JSON line for `args` (the test's --consts only: the check runs no child). */
export function child(args = []) {
  const r = spawnSync(process.execPath, [CHILD, ...args], { encoding: "utf8", timeout: 120_000 });
  if (r.status !== 0) throw new Error(`withdraw-fee-check exit ${r.status ?? r.signal}: ${(r.stderr ?? "").trim().split("\n").slice(-3).join(" | ")}`);
  return JSON.parse(r.stdout.trim().split("\n").at(-1));
}

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
  return { ok: lines.length === 0, lines };
}

const PKG = path.join(REPO, "packages/signpage");
/** This tree's SIGN_HOST build as committed (index.html, public/app.js, public/_headers' /* CSP), for --local. */
function localBuild() {
  const headers = readFileSync(path.join(PKG, "public/_headers"), "utf8");
  const csp = /^\/\*\n(?:\s.*\n)*?\s+Content-Security-Policy:\s*(.*)$/m.exec(headers)?.[1] ?? "";
  return { html: readFileSync(path.join(signBuilt(), "index.html"), "utf8"), csp, js: readFileSync(path.join(signBuilt(), "public/app.js")) };
}

/** The live answer: SIGN_HOST's policy and bundle (or this tree's, `local`). */
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
  return { at: new Date().toISOString(), csp, html, appSha384, app };
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
