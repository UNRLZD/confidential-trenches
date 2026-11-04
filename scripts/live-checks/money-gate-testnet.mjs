#!/usr/bin/env node
// Live check of card money-gate-testnet: the money gate reads NEAR testnet txs on the testnet RPCs, kept apart from
// mainnet records. Three records go through the gate's own code (moneyGate, with the RPCs and FLOOR it ships with):
//   - a near-testnet tx made after FLOOR (--tx and --signer: the vault deploy's) reads ok on two testnet RPCs or more;
//   - a near-testnet tx from before FLOOR (by default the first deposit of the vault-gas run on NEAR testnet,
//     2026-10-26) is refused as old, and no RPC reads it as ok;
//   - the fresh tx written as "Tx: near" is refused on the mainnet RPCs, and no mainnet RPC reads it as ok;
// and the testnet record holds no real-money tx (parseLive's real is empty).
//   node scripts/live-checks/money-gate-testnet.mjs --tx <hash> --signer <account> [--old <hash> --old-signer <account>]
//     [--record <file>]   PASS exit 0, FAIL exit 1, error exit 2
// --record writes every RPC answer the run read to <file>, so the check's test can replay it. A NEAR signature
// ("ed25519:" and 86-88 base58) has the shape of a NEAR secret key, which the secret scan refuses, so the recording keeps
// none: each is replaced by SIGNATURE (the gate reads no signature).
// Runs: once, the money gate's own read of recorded NEAR testnet txs; no host deploy changes it
import "../net-window.mjs";
import { writeFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FLOOR, LIVE, RPCS, moneyGate, parseLive } from "../ci/money-gate.mjs";

const KEY = "money-gate-testnet";
export const OLD = { hash: "EioYwuXPgpEkar6uPohK6bNnQPg54n2Ud5r2kBPkRkou", signer: "g1vg-20261026b.testnet" };

const record = (chain, { hash, signer }) => `CARD ${KEY} / live: PASS\nMoney path: yes\nTx: ${chain} ${hash} ${signer}\n`;

export async function check({ fresh, old = OLD, fetchFn = fetch, rpcs = RPCS, floor = FLOOR }) {
  const run = (chain, tx) => moneyGate([{ path: `${LIVE}${KEY}.md`, key: KEY, text: record(chain, tx) }], fetchFn, rpcs, { floor });
  const said = (r) => (r.refusals.length ? r.refusals.map((x) => x.replace(/^[^:]+: /, "")).join("; ") : r.read.join(", "));
  const lines = [];
  const a = await run("near-testnet", fresh);
  const okA = a.refusals.length === 0 && a.read.length >= 2;
  lines.push(`${okA ? "ok " : "BAD"} the fresh tx as near-testnet reads ok on ${a.read.length} testnet RPC(s): ${said(a)}`);
  const b = await run("near-testnet", old);
  const okB = b.read.length === 0 && b.refusals.length === 1 && / old: \S+ is before /.test(b.refusals[0]);
  lines.push(`${okB ? "ok " : "BAD"} the old tx as near-testnet is refused as old: ${said(b)}`);
  const c = await run("near", fresh);
  const okC = c.read.length === 0 && c.refusals.length > 0;
  lines.push(`${okC ? "ok " : "BAD"} the fresh tx as near is refused on the mainnet RPCs: ${said(c)}`);
  const real = parseLive(record("near-testnet", fresh), KEY).real;
  const okD = real.length === 0;
  lines.push(`${okD ? "ok " : "BAD"} the near-testnet record counts ${real.length} real-money tx(s)`);
  return { ok: okA && okB && okC && okD, lines };
}

const SIGNATURE = "ed25519:<a signature, not kept>";
const unsigned = (json) => JSON.parse(JSON.stringify(json).replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{86,88}/g, SIGNATURE));

// a fetch that keeps every answer it reads, its signatures dropped: { url, method, params, status, json }
export function recorder(fetchFn = fetch) {
  const answers = [];
  const wrapped = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const r = await fetchFn(url, init);
    const json = await r.json();
    answers.push({ url, method, params, status: r.status, json: unsigned(json) });
    return { ok: r.ok, status: r.status, json: async () => json };
  };
  return { answers, fetchFn: wrapped };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    if (!opt("--tx") || !opt("--signer")) throw new Error("usage: money-gate-testnet.mjs --tx <hash> --signer <account> [--old <hash> --old-signer <account>] [--record <file>]");
    const rec = recorder();
    const r = await check({
      fresh: { hash: opt("--tx"), signer: opt("--signer") },
      old: { hash: opt("--old", OLD.hash), signer: opt("--old-signer", OLD.signer) },
      fetchFn: opt("--record") ? rec.fetchFn : fetch,
    });
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(rec.answers, null, 1) + "\n");
    for (const l of r.lines) console.log(`live-check ${KEY}: ${l}`);
    console.log(`live-check ${KEY}: ${r.ok ? "PASS" : "FAIL"}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
