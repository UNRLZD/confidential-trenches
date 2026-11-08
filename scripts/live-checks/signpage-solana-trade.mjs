#!/usr/bin/env node
// Live check of card signpage-solana-trade: SIGN_HOST can sign a Solana buy and sell from the trade box. It reads what
// SIGN_HOST serves and, after the owner's run, the run's transactions:
//   - the page's CSP connect-src lets the page reach every host the trade uses: the helper (the Jupiter build, LD1's
//     provider B and the helper's send path), provider A device-direct (solana-rpc.publicnode.com) and the kit's three
//     keyless send paths (Helius Sender, Jito, the public RPC); the hosts are written out here, not read from the repo;
//   - the served /app.js is the one index.html pins (its sha384) and holds the trade kind (its own refusal codes
//     no_ready_set and over_held, which no other kind has);
//   - with --record-file <run.md>: every "Tx: solana <signature>" line of the run record is a landed transaction with no
//     error on two public RPCs (api.mainnet-beta.solana.com and solana-rpc.publicnode.com).
// After: sign
//   node scripts/live-checks/signpage-solana-trade.mjs [--record-file <run.md>] [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2. --record writes the answer read; --answer replays one (the test's).
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export const SIGN = "https://confidential.unrealized.trade";
export const TRADE_HOSTS = [
  "https://ct-api.unrealized.trade",
  "https://solana-rpc.publicnode.com",
  "https://sender.helius-rpc.com",
  "https://mainnet.block-engine.jito.wtf",
  "https://api.mainnet-beta.solana.com",
];
export const TX_RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
const MARKERS = ["no_ready_set", "over_held"];

const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** The verdict on an answer { csp, index, app: { sha384, markers }, txs?: [{ signature, reads: [status, status] }] }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const connect = (a.csp ?? "").split(";").map((d) => d.trim().split(/\s+/)).find((d) => d[0] === "connect-src") ?? [];
  for (const h of TRADE_HOSTS) if (!connect.includes(h)) bad(`connect-src lacks ${h}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a.index ?? "")?.[1];
  if (!pin) bad("index.html pins no /app.js");
  else if (pin !== a.app?.sha384) bad("the served /app.js is not the one index.html pins");
  for (const m of MARKERS) if (!(a.app?.markers ?? []).includes(m)) bad(`the served /app.js holds no trade kind (${m})`);
  for (const t of a.txs ?? []) {
    const ok = t.reads.length === 2 && t.reads.every((s) => s && s.err === null && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized"));
    if (!ok) bad(`tx ${t.signature} did not land with no error on both RPCs`);
  }
  if (!lines.length) lines.push(`OK the trade's ${TRADE_HOSTS.length} hosts, the pinned /app.js with the trade kind${a.txs?.length ? `, ${a.txs.length} txs landed on two RPCs` : ""}`);
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

async function rpc(url, method, params) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return (await r.json()).result;
}

/** Reads SIGN_HOST, and the run record's txs on two RPCs. */
export async function read(recordFile) {
  const page = await fetch(`${SIGN}/`);
  const csp = page.headers.get("content-security-policy") ?? "";
  const index = await page.text();
  const js = await (await fetch(`${SIGN}/app.js`)).text();
  const app = { sha384: sha384(js), markers: MARKERS.filter((m) => js.includes(m)) };
  const sigs = recordFile ? [...readFileSync(recordFile, "utf8").matchAll(/^Tx: solana ([1-9A-HJ-NP-Za-km-z]{64,88})$/gm)].map((m) => m[1]) : [];
  const txs = [];
  for (const signature of sigs) {
    const reads = await Promise.all(TX_RPCS.map((u) => rpc(u, "getSignatureStatuses", [[signature], { searchTransactionHistory: true }]).then((r) => r?.value?.[0] ?? null)));
    txs.push({ signature, reads });
  }
  return { csp, index, app, txs };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read(arg("--record-file"));
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(answer)}\n`);
    const v = judge(answer);
    for (const l of v.lines) console.log(l);
    console.log(v.ok ? "PASS signpage-solana-trade" : "FAIL signpage-solana-trade");
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR signpage-solana-trade: ${e?.message ?? e}`);
    process.exit(2);
  }
}
