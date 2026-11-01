#!/usr/bin/env node
// Live check of card delete-refund-readback, re-made by card money-gate-delete-sweep: a one-use account swept the
// standard way reads back as swept. Its money moved in a plain Transfer to the beneficiary, every receipt a success, and
// the account then deleted itself in a separate tx (delete-refund-readback.sweep.mjs). The money gate's own code
// (moneyGate, with the RPCs and FLOOR it ships with) reads a record of the Transfer and a Deleted line for the account:
// the Transfer on two operators or by its light-client proof alone once dRPC drops it, the account gone
// (view_account UNKNOWN_ACCOUNT) on dRPC and FastNEAR. The sweep read by default is the testnet one made 2026-11-01
// 14:53Z: Transfer EamCGz2G…, A 69a11523…, deleted into F ct-sweep-20261101145335.testnet (its DeleteAccount
// 61vYxQNX…, kept out of the record). PASS: no refusal.
//   node scripts/live-checks/delete-refund-readback.mjs [--chain near|near-testnet --tx <hash> --account <A>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes every RPC answer the run read to <file>, so the check's test can replay it (each NEAR signature
// replaced, as money-gate-testnet does).
import "../net-window.mjs";
import { writeFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FLOOR, LIVE, RPCS, moneyGate } from "../ci/money-gate.mjs";

const KEY = "delete-refund-readback";
export const SWEEP = { chain: "near-testnet", hash: "EamCGz2G4488WsjqwmCTXzRG9JuVQBEasNfPfUYHe4pG", account: "69a11523eca86476111d3c8ad1f6caeded687aa4e33c546b0eb80268f4d42252" };

export async function check({ sweep = SWEEP, fetchFn = fetch, rpcs = RPCS, floor = FLOOR, sleep }) {
  const text = `CARD ${KEY} / live: PASS\nMoney path: yes\nTx: ${sweep.chain} ${sweep.hash} ${sweep.account}\nDeleted: ${sweep.chain} ${sweep.account}\n`;
  const r = await moneyGate([{ path: `${LIVE}${KEY}.md`, key: KEY, text }], fetchFn, rpcs, { floor, ...(sleep ? { sleep } : {}) });
  const ok = r.refusals.length === 0 && r.gone.length === 1 && r.read.length + r.proven.length > 0;
  const said = r.refusals.length ? r.refusals.map((x) => x.replace(/^[^:]+: /, "")).join("; ") : [...r.read, ...r.proven, ...r.gone].join(", ");
  return { ok, lines: [`${ok ? "ok " : "BAD"} the sweep Transfer reads ok on ${r.read.length} RPC(s), proven ${r.proven.length}, the account gone ${r.gone.length}: ${said}`] };
}

const SIGNATURE = "ed25519:<a signature, not kept>";
const unsigned = (json) => JSON.parse(JSON.stringify(json).replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{86,88}/g, SIGNATURE));

// a fetch that keeps every answer it reads, its signatures dropped: { url, method, params, status, json }
export function recorder(fetchFn = fetch) {
  const answers = [];
  const wrapped = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const r = await fetchFn(url, init);
    const json = r.status === 429 ? null : await r.json();
    answers.push({ url, method, params, status: r.status, json: json && unsigned(json) });
    return { ok: r.ok, status: r.status, headers: r.headers, json: async () => json };
  };
  return { answers, fetchFn: wrapped };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const given = ["--chain", "--tx", "--account"].filter((k) => a.includes(k)).length;
    if (given !== 0 && given !== 3) throw new Error("usage: delete-refund-readback.mjs [--chain near|near-testnet --tx <hash> --account <A>] [--record <file>]");
    const rec = recorder();
    const sweep = { chain: opt("--chain", SWEEP.chain), hash: opt("--tx", SWEEP.hash), account: opt("--account", SWEEP.account) };
    const r = await check({ sweep, fetchFn: opt("--record") ? rec.fetchFn : fetch });
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(rec.answers, null, 1) + "\n");
    for (const l of r.lines) console.log(`live-check ${KEY}: ${l}`);
    console.log(`live-check ${KEY}: ${r.ok ? "PASS" : "FAIL"}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
