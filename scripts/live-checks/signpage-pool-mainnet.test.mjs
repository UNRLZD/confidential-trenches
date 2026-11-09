// node --test scripts/live-checks/signpage-pool-mainnet.test.mjs: the live check's verdict replays recorded runs
// (signpage-pool-mainnet.answers.json), each read on 9 Nov by signpage-pool-mainnet.mjs collect() (card
// sol-pools-mainnet-pin flipped it to a pinned mainnet):
//   good: --local at 17:17:32Z, card sol-pools-mainnet-pin's signing page build served as SIGN_HOST under its own
//         _headers (the pair and the helper answering 503): the bundle is the checkout's and carries the flow and the
//         queue, no testnet pin, the CSP names the mainnet pair; in a fresh browser, signed out, pool.sell (down: its
//         mint read got 503s), pool.deposit and pool.buy (failed) reached the pinned flow, the sell read the USDC mint on
//         both of the pair, pool.withdraw was refused not_allowed (no stored seed), and no pool read went to
//         api.mainnet-beta.solana.com: PASS;
//   bad:  live SIGN_HOST at 17:17:39Z, serving the bundle from before this card: not the checkout's, every kind
//         refused not_allowed and no mint read (no mainnet pin): FAIL;
//   bad_unpinned_build: --local at 17:17:36Z on c9324d92's committed build (index.html and public/, as deploy.mjs
//         copies them), the build just before the pin: the same refusals: FAIL.
// Planted from the good run: an unpinned answer (a kind refused not_allowed, no answer), a withdraw that opens signed
// out, the mint read on one of the pair or not at all, a pool read on api.mainnet-beta, a testnet pin in the bundle, a
// bundle without the queue, a CSP without provider A, no ready from the shell.
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

test("recorded good answer: this release's bundle, the Solana kinds reach the pinned flow, the mint read on the pair, withdraw needs a seed: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("recorded bad answers: live SIGN_HOST and c9324d92's build, both before the pin: FAIL on the refusals and the missing mint read", () => {
  for (const rec of [ANSWERS.bad, ANSWERS.bad_unpinned_build]) {
    const r = judge(rec);
    fails(r, /is this release's/);
    for (const k of ["sell", "deposit", "buy"]) fails(r, new RegExp(`^BAD pool\\.${k} on Solana reaches the pinned pool's flow: not_allowed`));
    fails(r, /the sell read its mint on both of the page's pair: solana-rpc\.publicnode\.com no, ct-api\.unrealized\.trade\/v1\/rpc\/solana no/);
  }
});

test("planted: an unpinned answer, a withdraw that opens signed out, the mint read on one of the pair or none, a read on api.mainnet-beta: FAIL", () => {
  fails(mut((rec) => (rec.probe.answers["pool.sell"] = { ok: false, error: { code: "not_allowed" } })), /^BAD pool\.sell on Solana reaches the pinned pool's flow: not_allowed/);
  fails(mut((rec) => delete rec.probe.answers["pool.deposit"]), /^BAD pool\.deposit on Solana reaches the pinned pool's flow: none/);
  fails(mut((rec) => (rec.probe.answers["pool.buy"] = { ok: false, error: { code: "not_allowed" } })), /^BAD pool\.buy on Solana/);
  fails(mut((rec) => (rec.probe.answers["pool.withdraw"] = { ok: true, result: { pending: true } })), /^BAD pool\.withdraw on Solana, signed out: ok/);
  fails(mut((rec) => (rec.probe.poolReads = rec.probe.poolReads.filter((r) => !r.url.startsWith("https://ct-api.unrealized.trade/")))), /mint on both of the page's pair: solana-rpc\.publicnode\.com yes, ct-api\.unrealized\.trade\/v1\/rpc\/solana no/);
  fails(mut((rec) => (rec.probe.poolReads = rec.probe.poolReads.map((r) => ({ ...r, body: r.body.replaceAll("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "So11111111111111111111111111111111111111112") })))), /mint on both of the page's pair: .* no/);
  fails(mut((rec) => rec.probe.poolReads.push({ url: "https://api.mainnet-beta.solana.com/", body: "{}" })), /^BAD no pool read to api\.mainnet-beta\.solana\.com: 1 read/);
  fails(mut((rec) => delete rec.probe.poolReads), /not recorded/);
});

test("planted: a testnet pin, a bundle without the queue, a CSP without provider A, no ready: FAIL", () => {
  fails(mut((rec) => rec.bundle.testnet.push("api.devnet.solana.com")), /no testnet pin/);
  fails(mut((rec) => (rec.bundle.queue = rec.bundle.queue.filter((m) => m !== "the proof queue is closed"))), /missing "the proof queue is closed"/);
  fails(mut((rec) => (rec.csp = rec.csp.replace(" https://solana-rpc.publicnode.com", ""))), /not https:\/\/solana-rpc\.publicnode\.com/);
  fails(mut((rec) => (rec.probe.ready = false)), /posted ready: no/);
  fails(mut((rec) => (rec.index = rec.index.replace(/integrity="[^"]+"/, 'integrity="sha384-x"'))), /pins the \/app\.js it serves/);
});
