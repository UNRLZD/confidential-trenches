#!/usr/bin/env node
// The money gate's Solana readers, read live (card money-gate-solana-reads-on-two-operators): the gate reads a recorded
// Solana tx ok on two operators of its own list (money-gate-reads.mjs RPCS.solana, rpc-operators.mjs), for a tx older than
// PublicNode's history as well as a new one. Before the card the list was api.mainnet-beta, public.rpc.solanavibestation.com
// and PublicNode: Solana Vibe Station refused every connection (from the Mac 26 Nov 05:5xZ, "Couldn't connect to
// server"; from the helper box and the Mac on 24 Nov, apps/helper/src/data/solana/trades.ts) and PublicNode answers null
// before its first available block, so a recorded tx read ok on api.mainnet-beta alone and the gate's --all run said
// COULD NOT READ for 28 Solana txs (main 0ba510633, run 45748862432's money-gate job, 26 Nov 03:2xZ).
// Read, with no key and no transaction: the gate's own code (moneyGate, with its RPCS, FLOOR and rounds) on one record
// that lists TXS, two of scripts/live-checks/pumpswap-table-mainnet-pin.md's mainnet txs (slots 468,415,987 and later, before PublicNode's
// first block).
// Judged: every tx reads ok on two operators (no refusal, nothing unread); a tx read ok on one operator, a refusal, or a
// tx the gate's rounds leave unread FAILs.
// A gate script, not a live check: it reads providers through the gate's own code, which live checks may not
// (live-checks-provider-answer.mjs); money-gate-solana-reads.test.mjs replays its recorded runs among the gate tests.
//   node scripts/ci/money-gate-solana-reads.mjs [--solana <url,url,..>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --solana reads on another list in the gate's place (the recorded bad run:
//   the list before the card); --record writes every answer the run read, so the test can replay it.
import "../net-window.mjs";
import { writeFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LIVE, RPCS, moneyGate } from "./money-gate.mjs";
import { wait } from "./rpc-wait.mjs";
import { RPC_OPERATORS } from "./rpc-operators.mjs";

const KEY = "money-gate-solana-reads-on-two-operators";
/** Two of scripts/live-checks/pumpswap-table-mainnet-pin.md's Tx lines: the first two of the 28 the 03:2xZ run left unread. */
export const TXS = [
  "58Z69tiMh8sNoExBX1ih8wDRYnEYE7mazSr5ntH3z7krXdrpjTj4brwmf6vwkzQi7W4cE5ZfEbKtbMnyu6oCgUR7",
  "2GRmRhU6MkDUQ4ndChjun27d7GEjRLEkpAyKCJZW9FuxUA65zDwHjddHasiCdr7aYJUL2BLtcBAwK5ppzRyWnsWS",
];
/** The list before the card (main 21d4995a7), the recorded bad run's. */
export const BEFORE = ["https://api.mainnet-beta.solana.com", "https://public.rpc.solanavibestation.com", "https://solana-rpc.publicnode.com"];

const record = () => `CARD ${KEY} / live: PASS\nMoney path: yes\n${TXS.map((t) => `Tx: solana ${t}`).join("\n")}\n`;
const operatorOf = (url) => {
  try {
    return RPC_OPERATORS.solana[new URL(url).host] ?? null;
  } catch {
    return null;
  }
};

export async function check({ fetchFn = fetch, solana = RPCS.solana, sleep = wait } = {}) {
  const r = await moneyGate([{ path: `${LIVE}${KEY}.md`, key: KEY, text: record() }], fetchFn, { ...RPCS, solana }, { sleep });
  const lines = [];
  const unknown = solana.filter((u) => operatorOf(u) === null);
  if (unknown.length) lines.push(`BAD the list names a host with no operator in rpc-operators.mjs: ${unknown.join(", ")}`);
  for (const t of TXS) {
    const ops = [...new Set(r.read.filter((l) => l.startsWith(`solana ${t} ok on `)).map((l) => operatorOf(l.slice(`solana ${t} ok on `.length))))];
    const why = [...r.refusals, ...r.unread].filter((l) => l.includes(t)).map((l) => l.replace(/^[^:]+: /, "").slice(0, 400));
    const ok = ops.length >= 2 && why.length === 0;
    lines.push(`${ok ? "GOOD" : "BAD"} ${t.slice(0, 8)} read ok on ${ops.length} operator(s)${ops.length ? ` (${ops.join(", ")})` : ""}${why.length ? `: ${why.join("; ")}` : ""}`);
  }
  for (const l of [...r.refusals, ...r.unread].filter((l) => !TXS.some((t) => l.includes(t)))) lines.push(`BAD ${l.slice(0, 400)}`);
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

// a fetch that keeps every answer it reads: { url, method, params, status, retryAfter, text } or { url, method, params,
// error } for a request that got no reply
export function recorder(fetchFn = fetch) {
  const answers = [];
  const wrapped = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    let r;
    try {
      r = await fetchFn(url, init);
    } catch (e) {
      answers.push({ url, method, params, error: String(e?.message ?? e) });
      throw e;
    }
    const text = await r.text();
    const retryAfter = r.headers.get("retry-after");
    answers.push({ url, method, params, status: r.status, ...(retryAfter === null ? {} : { retryAfter }), text });
    return { ok: r.ok, status: r.status, headers: { get: (k) => (k.toLowerCase() === "retry-after" ? retryAfter : null) }, text: async () => text };
  };
  return { answers, fetchFn: wrapped };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const rec = recorder();
    const solana = opt("--solana") ? opt("--solana").split(",") : RPCS.solana;
    const r = await check({ fetchFn: opt("--record") ? rec.fetchFn : fetch, solana });
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify({ solana, answers: rec.answers }, null, 1)}\n`);
    for (const l of r.lines) console.log(l);
    console.log(`money-gate-solana-reads: ${r.ok ? "PASS" : "FAIL"} (${solana.map((u) => new URL(u).host).join(", ")})`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`money-gate-solana-reads: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
