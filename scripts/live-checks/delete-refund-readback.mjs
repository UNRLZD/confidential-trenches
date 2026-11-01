#!/usr/bin/env node
// Live check of card delete-refund-readback: a one-use account that deletes itself into its funder reads back as ok.
// The money gate's own code (moneyGate, with the RPCs and FLOOR it ships with) reads a record holding the sweep's last
// tx, mainnet Dw1nbvYGcjXs3HocsCxxz1GXr6wH8QNUkQV5FxffJPrM (paste 3 of proofs/g1-arm-swap, 2026-11-01T03:43Z: A, an
// implicit account, deletes itself into F). That tx succeeded, and NEAR's gas refund to the deleted A failed
// AccountDoesNotExist, the one failed receipt the gate passes. PASS: no refusal, and two RPCs or more read it ok.
//   node scripts/live-checks/delete-refund-readback.mjs [--tx <hash> --signer <account>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes every RPC answer the run read to <file>, so the check's test can replay it (each NEAR signature
// replaced, as money-gate-testnet does).
import { writeFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FLOOR, LIVE, RPCS, moneyGate } from "../ci/money-gate.mjs";

const KEY = "delete-refund-readback";
export const SWEEP = { hash: "Dw1nbvYGcjXs3HocsCxxz1GXr6wH8QNUkQV5FxffJPrM", signer: "386aeb3286b4a6548d1ed2a84557073858cf1b696310359c5100cb06ed233ef8" };

export async function check({ tx = SWEEP, fetchFn = fetch, rpcs = RPCS, floor = FLOOR }) {
  const text = `CARD ${KEY} / live: PASS\nMoney path: yes\nTx: near ${tx.hash} ${tx.signer}\n`;
  const r = await moneyGate([{ path: `${LIVE}${KEY}.md`, key: KEY, text }], fetchFn, rpcs, { floor });
  const ok = r.refusals.length === 0 && r.read.length >= 2;
  const said = r.refusals.length ? r.refusals.map((x) => x.replace(/^[^:]+: /, "")).join("; ") : r.read.join(", ");
  return { ok, lines: [`${ok ? "ok " : "BAD"} the self-deleting sweep tx reads ok on ${r.read.length} NEAR RPC(s): ${said}`] };
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
    if (a.includes("--tx") !== a.includes("--signer")) throw new Error("usage: delete-refund-readback.mjs [--tx <hash> --signer <account>] [--record <file>]");
    const rec = recorder();
    const r = await check({ tx: { hash: opt("--tx", SWEEP.hash), signer: opt("--signer", SWEEP.signer) }, fetchFn: opt("--record") ? rec.fetchFn : fetch });
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(rec.answers, null, 1) + "\n");
    for (const l of r.lines) console.log(`live-check ${KEY}: ${l}`);
    console.log(`live-check ${KEY}: ${r.ok ? "PASS" : "FAIL"}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
