#!/usr/bin/env node
// Check of card vault-review-fixes-kit (vault review R-03): the vault's lists read whole on public RPCs at any size.
// The kit's sync (packages/kit/src/vault/sync.ts), which the exit tool runs (packages/exit/src/rpc.ts exitReadPages),
// starts each list at a page of about 125 Tgas, reads a page again at half its rows (at most three times) when an RPC
// refuses it as too heavy (vaultViewTooHeavy), and asks a busy answer again after a wait (vaultViewBusy). Two things
// outside this repo can break that, and this reads both:
//   1. The RPCs. Each of the six the release lists (RPCS below, held to the kit's own pair rule, nearPairRule, word
//      for word: both FastNEAR URLs and dRPC, on mainnet and testnet) gets a view over the protocol's gas cap: social's
//      get with PROBE_KEYS copies of one empty key (it passed at 15,429 copies and stopped at 15,546 on all six,
//      2026-11-06 05:48-05:49Z). An RPC that answers it whole has a higher cap, which is fine; one that refuses it must
//      do so in words the kit knows (vaultViewTooHeavy, or vaultViewBusy). If an RPC changes the words of its refusal,
//      the halving stops working without a sound: that alone fails.
//   2. The pages. The kit's vaultSync reads the release's testnet vault on the exit pair (test.rpc.fastnear.com and
//      near-testnet.drpc.org): every list whole, and every list's first page about 125 Tgas by the gas measured for
//      each row (GAS_PER_ROW). This file may import only the kit's public entry (check:imports), so the URLs and the
//      vault are written here; judge() holds the URLs to nearPairRule.
// Runs: once, by hand: no host's bundle runs the kit's vault sync (SIGN_HOST's app.js holds none, and apps/terminal/src
// never calls vaultSync), so no host deploy changes what this reads; the exit tool runs on the user's own machine.
//   node scripts/live-checks/vault-review-fixes-kit.mjs [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read (each probe's answer, each page asked of the exit pair), so the check's test can
// replay it. The verdict runs this checkout's vaultViewTooHeavy and vaultViewBusy over the recorded answers.
import "../net-window.mjs";
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as kit from "../../packages/kit/src/index.ts";

const KEY = "vault-review-fixes-kit";
/**
 * The view gas budget a first page must stay under, in Tgas: well under the lowest cap nearcore has had (200 Tgas). By
 * the per-row shares below, 250 spends come to 124.3 (measured as a page of 250: 125.135, sync.ts VAULT_SYNC_PAGE).
 */
export const BUDGET_TGAS = 125;
/**
 * Tgas a row, at most: a 1,000-row page of each list's largest rows, measured with the release build in near-sandbox
 * 2.13.4 (vault review R-03, contracts/vault/tests/review_viewgas.rs): spends 497.053, deposits 276.385, leaves
 * 162.548; labels share the leaves' view code (lib.rs tree_page). The call's own cost is counted in each row's share.
 */
export const GAS_PER_ROW = { deposits: 0.276385, spends: 0.497053, leaves: 0.162548, labels: 0.162548 };
export const LISTS = Object.keys(GAS_PER_ROW);
export const PROBE_KEYS = 20_000;
/** The release's NEAR RPCs: per network, its FastNEAR URLs and its dRPC URL (packages/kit/src/near/networks.ts). */
export const RPCS = {
  mainnet: { fastnear: ["https://rpc.mainnet.fastnear.com", "https://rpc.mainnet.near.org"], drpc: "https://near.drpc.org" }, // near-rpc-operators: one operator (the release's FastNEAR alternatives, each probed alone, never paired)
  testnet: { fastnear: ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"], drpc: "https://near-testnet.drpc.org" }, // near-rpc-operators: one operator (the same)
};
/** The exit tool's pair and the testnet vault (packages/exit/src/rpc.ts EXIT_NETWORKS.testnet). */
export const EXIT = { rpcs: ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"], vault: "vault.bf-vt-20261102t071444.testnet" }; // gitleaks:allow (a public account id)
const SOCIAL = { mainnet: { account: "social.near", key: "mob.testnet/**" }, testnet: { account: "v1.social08.testnet", key: "mob.testnet/**" } };

// ------------------------------------------------------------------------------------------------ the verdict
/** The check on one record: { at, probes: [{ network, url, answer }], exit: { pages: [{ rpc, method, limit }], rows, sizes } | { error } }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  for (const [network, n] of Object.entries(RPCS)) {
    const rule = `the RPCs must be one of ${n.fastnear.join(", ")} and ${n.drpc}, exactly`;
    say(kit.nearPairRule(network) === rule, `${network}: the URLs read are the release's (the kit's pair rule: ${kit.nearPairRule(network) === rule ? "the same" : kit.nearPairRule(network)})`);
  }
  const urls = Object.values(RPCS).flatMap((n) => [...n.fastnear, n.drpc]);
  const probes = Array.isArray(rec?.probes) ? rec.probes : [];
  for (const url of urls) {
    const p = probes.find((x) => x?.url === url);
    if (p === undefined) {
      say(false, `${url}: no probe read`);
      continue;
    }
    const whole = Array.isArray(p.answer?.result?.result);
    const known = kit.vaultViewTooHeavy(p.answer) ? "a refusal the kit halves on" : kit.vaultViewBusy(p.answer) ? "busy, which the kit asks again" : null;
    say(whole || known !== null, `${url}: a view over the protocol's cap answers ${short(p.answer)}, ${whole ? "whole (a higher cap)" : known ?? "not a refusal the kit knows"}`);
  }
  const ex = rec?.exit;
  if (!ex || ex.error !== undefined || !Array.isArray(ex.pages)) say(false, `the exit pair: the read stopped (${ex?.error ?? "no read"})`);
  else {
    const net = EXIT;
    say(ex.whole === true, `the exit pair (${net.rpcs.join(", ")}): every list read whole (${LISTS.map((l) => `${l} ${ex.rows?.[l]}`).join(", ")})`);
    for (const list of LISTS) {
      const firsts = net.rpcs.map((rpc) => ex.pages.find((q) => q.rpc === rpc && q.method === list));
      const worst = Math.max(...firsts.map((q) => (q === undefined ? Infinity : q.limit * GAS_PER_ROW[list])));
      say(Number.isFinite(worst) && worst <= BUDGET_TGAS, `the exit pair: ${list}'s first page is ${firsts.map((q) => q?.limit ?? "unread").join(" and ")} rows, at most ${Number.isFinite(worst) ? worst.toFixed(1) : "?"} Tgas (budget ${BUDGET_TGAS})`);
    }
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}
const short = (a) => JSON.stringify(a?.result?.error ?? a?.error ?? (a?.result?.result ? "a result" : a)).slice(0, 120);

// ------------------------------------------------------------------------------------------------ the read
async function probe(network, url) {
  const { account, key } = SOCIAL[network];
  const params = { request_type: "call_function", finality: "final", account_id: account, method_name: "get", args_base64: Buffer.from(JSON.stringify({ keys: Array(PROBE_KEYS).fill(key) })).toString("base64") };
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "x", method: "query", params }), signal: AbortSignal.timeout(30_000) });
  const answer = await res.json();
  return { network, url, status: res.status, answer };
}

export async function collect() {
  const rec = { at: new Date().toISOString(), probes: [], exit: null };
  for (const [network, n] of Object.entries(RPCS)) for (const url of [...n.fastnear, n.drpc]) rec.probes.push(await probe(network, url));
  const pages = [];
  const logged = (url) => ({
    name: url,
    async query(params, signal) {
      if (LISTS.includes(params.method_name)) pages.push({ rpc: url, method: params.method_name, limit: JSON.parse(Buffer.from(params.args_base64, "base64").toString("utf8")).limit });
      const timeout = AbortSignal.timeout(15_000);
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "x", method: "query", params }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (res.status !== 200 && res.status !== 408) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    },
  });
  try {
    if (kit.nearPairNetwork(EXIT.rpcs.map((u) => ({ name: u, query() {} }))) !== "testnet") throw new Error("the exit pair is not the kit's testnet pair");
    const r = await kit.vaultSync({ vault: EXIT.vault, rpcs: [logged(EXIT.rpcs[0]), logged(EXIT.rpcs[1])], cursor: kit.vaultSyncStart(EXIT.vault) });
    const rows = Object.fromEntries(LISTS.map((l) => [l, r[l].length]));
    rec.exit = { height: r.height, pages, rows, sizes: { state: r.stateTree.size, label: r.labelTree.size }, whole: rows.leaves === r.stateTree.size && rows.labels === r.labelTree.size };
  } catch (e) {
    rec.exit = { error: e instanceof Error ? e.message : String(e), pages };
  }
  return rec;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  try {
    const rec = await collect();
    const out = a.includes("--record") ? a[a.indexOf("--record") + 1] : null;
    if (out) writeFileSync(out, `${JSON.stringify(rec, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"} (${rec.at})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
