// node --test scripts/live-checks/signpage-pool-mainnet.test.mjs: the live check's verdict replays recorded runs
// (signpage-pool-mainnet.answers.json), each read on 5 Nov by signpage-pool-mainnet.mjs collect():
//   good: --local at 17:44:45Z, this card's signing page build (release-36's bundle) served as SIGN_HOST under its own
//         _headers: the bundle is the checkout's and carries the flow and the queue, no testnet pin, the CSP names the
//         mainnet pair, and in a fresh browser pool.sell, pool.deposit, pool.buy and pool.withdraw on Solana are refused
//         not_allowed with no pool read: PASS;
//   bad:  live SIGN_HOST at 17:44:48Z, serving release-35's bundle from before this card (not the checkout's, and it
//         carries no flow or queue): FAIL.
// Planted from the good run: a pinned pool's answers (a kind not refused, the mint read on the pair), a testnet pin in
// the bundle, a bundle without the queue, a CSP without provider A, no ready from the shell.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge } from "./signpage-pool-mainnet.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "signpage-pool-mainnet.answers.json"), "utf8"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("BAD") && re.test(l)), r.lines.join("\n"));
};

test("recorded good answer: this release's bundle with the flow and the queue, and every pool kind refused not_allowed with no read: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("recorded bad answer: live SIGN_HOST on release-35, before this card: FAIL on the bundle and the queue", () => {
  const r = judge(ANSWERS.bad);
  fails(r, /is this release's/);
  fails(r, /carries the pool flow and its proof queue: missing/);
});

test("planted: a pinned pool's answers (a kind that reaches the flow, the mint read on the pair): FAIL", () => {
  fails(mut((rec) => (rec.probe.answers["pool.sell"] = { ok: false, error: { code: "not_funded" } })), /pool\.sell on Solana/);
  fails(mut((rec) => (rec.probe.answers["pool.withdraw"] = { ok: true, result: { pending: true } })), /pool\.withdraw on Solana/);
  fails(mut((rec) => delete rec.probe.answers["pool.deposit"]), /pool\.deposit on Solana with no mainnet pin: none/);
  fails(mut((rec) => (rec.probe.answers["pool.buy"] = { ok: false, error: { code: "not_funded" } })), /pool\.buy on Solana/);
  fails(mut((rec) => rec.probe.poolReads.push("https://solana-rpc.publicnode.com/")), /no request to the pair/);
  fails(mut((rec) => rec.probe.poolReads.push("https://api.mainnet-beta.solana.com/")), /no request to the pair, api\.mainnet-beta\.solana\.com/);
  fails(mut((rec) => delete rec.probe.poolReads), /not recorded/);
});

test("planted: a testnet pin, a bundle without the queue, a CSP without provider A, no ready: FAIL", () => {
  fails(mut((rec) => rec.bundle.testnet.push("api.devnet.solana.com")), /no testnet pin/);
  fails(mut((rec) => (rec.bundle.queue = rec.bundle.queue.filter((m) => m !== "the proof queue is closed"))), /missing "the proof queue is closed"/);
  fails(mut((rec) => (rec.csp = rec.csp.replace(" https://solana-rpc.publicnode.com", ""))), /not https:\/\/solana-rpc\.publicnode\.com/);
  fails(mut((rec) => (rec.probe.ready = false)), /posted ready: no/);
  fails(mut((rec) => (rec.index = rec.index.replace(/integrity="[^"]+"/, 'integrity="sha384-x"'))), /pins the \/app\.js it serves/);
});
