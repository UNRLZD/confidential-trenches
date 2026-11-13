// node --test scripts/live-checks/trade-box-pool.test.mjs: the live check's verdict replays recorded runs
// (trade-box-pool.answers.json), each read by trade-box-pool.mjs collect() in headless Chromium, the stand-in
// shell sending a signed-in state with the devnet Solana pool (one 0.01 SOL note), its money ready to spend and still being
// made ready. The bad answer (4 Nov) is the deployed APP_HOST before the card trade-box-pool: the box is on the vault's
// path: FAIL.
// Recorded on 10 Nov (card live-check-pool-price-own-token), on the token's own page /token/solana/<DJT>, which also reads
// the token and chain the page drew; on 13 Nov 07:53Z the app named no proof, and the good answer was recorded again
// (--harness) on card screens-never-say-proof's build:
//   good: that build: DJT on Solana at both widths, the box on the pool path, no proof line and no text of proof, the
//         line above Buy reading Max $N with the money ready and empty while it is made ready, Buy data-kind live and
//         aria-busy true then (aria-disabled true, no disabled attribute), a tap asks for no vault buy: PASS;
//   main: main's build 4c1826a75 before that card (--harness --build): the box draws its proof line, and the making state
//         draws no busy Buy: FAIL;
//   wrongChain: the same check opening / (its old path) at 03:27Z, when the live Trending column's top was "Anthropic"
//         (0xecc4...1627) on Robinhood: the box is on the vault path, and the verdict names the token and chain: FAIL.
// Planted from the good run: a tap that sends the vault's buy, a proof line or a text of proof, a Max line missing with the
// money ready or shown while it is being made ready, a Buy that is not live and busy then, a box off the pool path, a
// missing run, a terminal outside the shell, no entry script.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CHAIN, judge, POOL } from "./trade-box-pool.mjs";
import { MINT } from "./app-sell-mount.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "trade-box-pool.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const run = (rec, w, p) => rec.runs.find((r) => r.width === w && r.state === p);
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bad(r).some((l) => re.test(l)), r.lines.join("\n"));
};

test("the state's pool is the devnet one: a 0.01 SOL note, one tap's most by the kit's rule (1,736,080 lamports)", () => {
  assert.deepEqual(POOL.ready, { chain: "solana", asset: "SOL", balance: "0.01", ready: "0.01", tap_max: "0.00173608" });
  // the making state names the money being made ready: with `making` and no tap_max the box draws no Max and a busy Buy
  assert.deepEqual(POOL.making, { chain: "solana", asset: "SOL", balance: "0.01", ready: "0", making: "0.01" });
});

test("recorded good answer: the pool path, no proof line, Max with the money ready and the busy Buy while it is made ready, no vault buy, at both widths: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(ANSWERS.good.runs.length, 4);
  for (const x of ANSWERS.good.runs) {
    assert.equal(x.box.proofMarks, 0, `${x.width} ${x.state}`);
    assert.equal(x.box.says, false, `${x.width} ${x.state}`);
    if (x.state === "ready") assert.match(x.box.max, /^Max \$\d/, `${x.width}`);
    else assert.deepEqual([x.box.max, x.box.cta.kind, x.box.cta.busy, x.box.cta.ariaDisabled, x.box.cta.disabled], ["", "live", "true", "true", false], `${x.width}`);
  }
});

test("recorded bad answer: the deployed app before this card keeps the vault's path: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => /^BAD desktop ready: .*the box is on the (vault|unmarked) path/.test(l)), r.lines.join("\n"));
});

test("main's build before the screens named no proof: it draws the proof line and the making state's Buy is not busy: FAIL", () => {
  const r = judge(ANSWERS.main);
  assert.equal(r.ok, false);
  for (const w of ["desktop", "phone"]) {
    assert.ok(bad(r).some((l) => l.startsWith(`BAD ${w} ready: `) && /the box draws a proof line \(1 \[data-testid="trade-proof"\]\); the box's text says proof/.test(l)), r.lines.join("\n"));
    assert.ok(bad(r).some((l) => l.startsWith(`BAD ${w} making: `) && /Buy is data-kind trade, not live/.test(l)), r.lines.join("\n"));
  }
  // what main got right stays right: the pool path, the shell, no vault buy
  assert.ok(!bad(r).some((l) => /path, not the pool's|vault's buy|not inside SIGN_HOST|screenshot/.test(l)), bad(r).join("\n"));
});

test("planted: a tap that sends the vault's buy, or anything but pool.buy, fails", () => {
  fails(mut((rec) => (run(rec, "desktop", "ready").sent = ["buy"])), /^BAD desktop ready: a tap asked the shell for the vault's buy/);
  fails(mut((rec) => (run(rec, "phone", "ready").sent = ["withdraw.open"])), /^BAD phone ready: a tap asked the shell for withdraw\.open/);
  fails(mut((rec) => (run(rec, "phone", "making").sent = null)), /^BAD phone making: the tap was not read/);
});

test("planted: a proof line, a text of proof, a missing or empty Max with the money ready, and a box off the pool path fail", () => {
  fails(mut((rec) => (run(rec, "desktop", "ready").box.proofMarks = 1)), /^BAD desktop ready: the box draws a proof line \(1 \[data-testid="trade-proof"\]\)/);
  fails(mut((rec) => (run(rec, "phone", "making").box.says = true)), /^BAD phone making: the box's text says proof/);
  fails(mut((rec) => delete run(rec, "phone", "making").box.says), /^BAD phone making: the box's text was not read/);
  fails(mut((rec) => (run(rec, "phone", "ready").box.max = "")), /^BAD phone ready: the line above Buy reads "", not Max \$N/);
  fails(mut((rec) => (run(rec, "desktop", "ready").box.max = "Max $0")), /^BAD desktop ready: the line above Buy reads "Max \$0", not Max \$N/);
  fails(mut((rec) => (run(rec, "desktop", "ready").box.path = "vault")), /^BAD desktop ready: the box is on the vault path/);
  fails(mut((rec) => (run(rec, "phone", "ready").box = null)), /^BAD phone ready: no trade box/);
});

test("planted: while the money is made ready, a Max line or a Buy that is not live, busy and aria-disabled with no disabled attribute fails", () => {
  fails(mut((rec) => (run(rec, "desktop", "making").box.max = "Max $0.31")), /^BAD desktop making: the box shows "Max \$0\.31" while the money is still being made ready, not no Max/);
  fails(mut((rec) => (run(rec, "phone", "making").box.cta.kind = "trade")), /^BAD phone making: Buy is data-kind trade, not live/);
  fails(mut((rec) => (run(rec, "phone", "making").box.cta.busy = null)), /^BAD phone making: Buy is aria-busy unset, not true/);
  fails(mut((rec) => (run(rec, "desktop", "making").box.cta.disabled = true)), /^BAD desktop making: Buy is not aria-disabled true with no disabled attribute/);
  fails(mut((rec) => (run(rec, "desktop", "making").box.cta.ariaDisabled = null)), /^BAD desktop making: Buy is not aria-disabled true/);
  fails(mut((rec) => (run(rec, "desktop", "making").box.cta = null)), /^BAD desktop making: no Buy button/);
});

test("planted: with the money ready, a Buy that looks busy fails", () => {
  fails(mut((rec) => (run(rec, "desktop", "ready").box.cta.busy = "true")), /^BAD desktop ready: Buy looks busy with the money ready/);
  fails(mut((rec) => (run(rec, "phone", "ready").box.cta.kind = "live")), /^BAD phone ready: Buy looks busy with the money ready/);
});

test("planted: a missing run, a terminal outside the shell, no screenshot, no entry script fail", () => {
  fails(mut((rec) => rec.runs.pop()), /^BAD 3 run\(s\) of 4/);
  fails(mut((rec) => (run(rec, "desktop", "ready").framed = false)), /^BAD desktop ready: not inside SIGN_HOST's shell/);
  fails(mut((rec) => (run(rec, "desktop", "making").shot = null)), /^BAD desktop making: no screenshot/);
  fails(mut((rec) => (rec.entry = null)), /^BAD the served \/ names its entry script none/);
});

test("recorded good answer: the check drew the Solana token it opened (DJT), on solana, in every run", () => {
  assert.ok(ANSWERS.good.runs.every((r) => r.mint === MINT && r.chain === CHAIN), JSON.stringify(ANSWERS.good.runs.map((r) => [r.mint, r.chain])));
});

test("recorded wrong-chain answer: the old open path drew the live Trending top on Robinhood, and the verdict names the token and chain: FAIL", () => {
  const r = judge(ANSWERS.wrongChain);
  assert.equal(r.ok, false);
  const named = bad(r).filter((l) => /the token page drew 0x\w+ on robinhood, not the Solana token DJT\w+ on solana/.test(l));
  assert.equal(named.length, ANSWERS.wrongChain.runs.length, r.lines.join("\n"));
});

test("planted: a page of another token or chain, or one that names neither, fails with a line that says so", () => {
  fails(mut((rec) => (run(rec, "desktop", "ready").chain = "base")), /^BAD desktop ready: the token page drew DJT\w+ on base, not the Solana token DJT\w+ on solana/);
  fails(mut((rec) => (run(rec, "phone", "making").mint = "So11111111111111111111111111111111111111112")), /^BAD phone making: the token page drew So1\w+ on solana, not the Solana token DJT/);
  fails(mut((rec) => (run(rec, "desktop", "making").chain = null)), /^BAD desktop making: the token page drew DJT\w+ on no chain/);
  fails(mut((rec) => (run(rec, "phone", "ready").mint = null)), /^BAD phone ready: the token page drew no token on solana/);
});
