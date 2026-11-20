// node --test scripts/live-checks/buy-box-quotes-before-funds.test.mjs: the live check replays its recorded answers
// (buy-box-quotes-before-funds.answers.json, its _note says how each was made).
//   appBefore: APP_HOST live before half 2, with the page that quotes a buy with no pool note: FAIL, the box asks no
//     quote on Solana, Base and Robinhood (no Fee row) and drops NEAR's out.
//   thisBuild: this card's app with that page: Base and NEAR draw the quote with Max $0; FAIL on Solana only, where the
//     page answers the box's quote in 10.9-11.2 s, past the kit client's 10 s for pool.buy.dry, so the box shows a dash;
//     Robinhood's page answered no quote (INCONCLUSIVE alone).
//   timeout30: the same app with that 10 s raised to 30 s (an experiment): Solana draws the quote; INCONCLUSIVE, Base and
//     Robinhood unanswered by the page in that run.
//   askAgain: the app that asks a dry again after the kit client's 10 s (client_timeout), SIGN_HOST live at release 159:
//     PASS on every chain; Solana's and Robinhood's first answers came past 10 s and the box drew the next ones.
// Those four were read before card app-money-sheets-read-right (922), whose $0 main button is the Deposit offer: each is
// judged here as read (FAIL on the offer alone where it held every other fact) and with the offer given (offered), so
// its quote facts keep their verdicts (card buy-box-check-reads-the-deposit-offer).
//   deposit: release-167 live (APP_HOST and SIGN_HOST): every chain quoted, Max $0 and the amount marked on the pool
//     chains, Deposit on, its tap opens the deposit sheet and posts no buy: PASS.
//   checkBefore: the same hosts read by the check before this card (Buy off asked of the offer, run 43962188152's FAIL):
//     on every chain the main button was on (ctaOff false), the fact it failed on.
//   nearLate: release-171 live, each amount ask timed (askedMs from the amount going in, ms to the page's answer): NEAR
//     drew qtc.omft.near after two coins stayed on Quoting, each answered past the kit client's 10 s.
// Planted on deposit: each fact taken away FAILs, an enabled Buy on $0 first.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CHAINS, answersOf, judge, quoted } from "./buy-box-quotes-before-funds.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./buy-box-quotes-before-funds.answers.json", import.meta.url), "utf8"));
/** A line on the main button or its tap (this card's), not on the quote. */
const OFFER = /: the main button |: the Deposit tap /;
/** A read before 922, given the Deposit offer and a tap that opened the sheet and sent nothing, on every coin. */
const offered = (a) => {
  const b = structuredClone(a);
  for (const ch of Object.values(b.chains)) for (const c of ch.coins) if (c.box) Object.assign(c, { box: { ...c.box, cta: { text: "Deposit", offer: "deposit", disabled: false } }, tap: { opened: true, sent: [] } });
  return b;
};
const SOL_LATE = "BAD solana 7SL2VnfYsChvog5oQY9Nmtqu1wceaMiQzWoqoLQpump: the page answered an out, You receive reads \"—\"; its answers: 11139 ms out";

test("recorded before 922 (Buy off, no Deposit offer): FAIL on the offer on every chain, as read", () => {
  for (const k of ["appBefore", "thisBuild", "timeout30", "askAgain"]) {
    const v = judge(ANSWERS[k]);
    assert.equal(v.verdict, "FAIL", k);
    for (const chain of CHAINS) assert.ok(v.lines.some((l) => l.startsWith(`BAD ${chain} `) && l.includes('data-offer null, off; want the Deposit offer')), `${k} ${chain}: ${v.lines.join(" | ")}`);
  }
  // askAgain held every other fact: the offer is its only fault
  assert.deepEqual(judge(ANSWERS.askAgain).lines.filter((l) => l.startsWith("BAD") && !OFFER.test(l)), []);
});

test("recorded deposit (release-167 live): PASS on every chain, Deposit on, its tap opens the deposit sheet, no buy sent", () => {
  const v = judge(ANSWERS.deposit);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  for (const chain of CHAINS) assert.ok(v.lines.some((l) => l.startsWith(`ok ${chain} `) && l.includes("Deposit on and its tap opens the deposit sheet, no buy sent")), chain);
});

test("recorded checkBefore (the check before this card, on the same hosts): the main button on with $0 on every chain", () => {
  for (const chain of CHAINS) {
    const c = ANSWERS.checkBefore.chains[chain].coins.at(-1);
    assert.equal(c.box.ctaOff, false, chain);
    assert.equal(c.box.balance, "$0 available", chain);
  }
});

test("recorded appBefore (APP_HOST before half 2): FAIL, no quote asked on the pool chains and NEAR's out dropped", () => {
  const v = judge(offered(ANSWERS.appBefore));
  assert.equal(v.verdict, "FAIL");
  assert.deepEqual(v.lines, [
    "BAD solana C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump: no Fee row",
    "BAD solana C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump: the box asked no quote of the amount",
    "BAD base 0xed664536023d8e4b1640c394777d34abaff1df8f: no Fee row",
    "BAD base 0xed664536023d8e4b1640c394777d34abaff1df8f: the box asked no quote of the amount",
    "BAD robinhood 0xedbf91223639800bcd5756815caf908df3b890be: no Fee row",
    "BAD robinhood 0xedbf91223639800bcd5756815caf908df3b890be: the box asked no quote of the amount",
    'BAD near prl.omft.near: the page answered an out, You receive reads "—"; its answers: 3405 ms out',
  ]);
});

test("recorded thisBuild: Base and NEAR quoted with Max $0; FAIL on Solana alone (the page's answer past the kit's 10 s)", () => {
  const v = judge(offered(ANSWERS.thisBuild));
  assert.equal(v.verdict, "FAIL");
  assert.deepEqual(v.lines.filter((l) => l.startsWith("BAD")), [SOL_LATE]);
  assert.ok(v.lines.some((l) => l.startsWith("ok base ")));
  assert.ok(v.lines.some((l) => l.startsWith("ok near ")));
  assert.ok(v.lines.some((l) => l.startsWith("no-answer robinhood")));
  // the late answers: every Solana quote the page priced came after 10 s
  const late = ANSWERS.thisBuild.chains.solana.coins.flatMap((c) => c.dry).filter((d) => d.amount !== undefined && d.ok);
  assert.ok(late.length > 0 && late.every((d) => d.ms > 10_000), JSON.stringify(late.map((d) => d.ms)));
});

test("recorded askAgain (a dry the client ended at 10 s asked again): PASS on every chain, Solana's quote from the second ask", () => {
  const v = judge(offered(ANSWERS.askAgain));
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  for (const chain of CHAINS) assert.ok(v.lines.some((l) => l.startsWith(`ok ${chain} `)), chain);
  // the Solana coin judged: its first amount ask answered past 10 s (the client had ended it), the next one inside it
  const sol = ANSWERS.askAgain.chains.solana.coins.find((c) => quoted(c.box.receive));
  const asks = sol.dry.filter((d) => d.amount !== undefined);
  assert.ok(asks.length >= 2 && asks[0].ms > 10_000 && asks.at(-1).ms < 10_000, JSON.stringify(asks.map((d) => d.ms)));
});

test("recorded timeout30 (experiment): the box draws Solana's quote once the answer is let in; INCONCLUSIVE", () => {
  const v = judge(offered(ANSWERS.timeout30));
  assert.equal(v.verdict, "INCONCLUSIVE");
  assert.ok(v.lines.some((l) => l.startsWith("ok solana ")));
  assert.equal(v.lines.some((l) => l.startsWith("BAD")), false);
});

/** The deposit read's judged coins: how long the page took to answer each one's amount ask (its recorded ms). */
const DEPOSIT_MS = { solana: 1421, base: 9383, robinhood: 9004, near: 9873 };

test("planted on deposit: each fact taken away FAILs; an enabled Buy on $0 FAILs", () => {
  const good = ANSWERS.deposit;
  assert.equal(judge(good).verdict, "PASS");
  const on = (chain, patch, coinPatch = {}) => {
    const c = good.chains[chain].coins.find((x) => quoted(x.box.receive));
    return { chains: { ...good.chains, [chain]: { coins: [{ ...structuredClone(c), box: { ...c.box, ...patch }, ...coinPatch }] } } };
  };
  const bads = (a) => judge(a).lines.filter((l) => l.startsWith("BAD"));
  for (const chain of CHAINS) {
    const c = good.chains[chain].coins.find((x) => quoted(x.box.receive));
    const tag = `${chain} ${c.coin}`;
    // the main button
    assert.deepEqual(bads(on(chain, { cta: { text: "Buy GG", offer: null, disabled: false } })), [`BAD ${tag}: the main button "Buy GG" is on with $0, a buy that can be tapped; want the Deposit offer`]);
    assert.deepEqual(bads(on(chain, { cta: { text: "Deposit", offer: null, disabled: false } })), [`BAD ${tag}: the main button "Deposit" is on with $0, a buy that can be tapped; want the Deposit offer`]);
    assert.deepEqual(bads(on(chain, { cta: { text: "Buy GG", offer: null, disabled: true } })), [`BAD ${tag}: the main button reads "Buy GG", data-offer null, off; want the Deposit offer: Deposit, data-offer "deposit", on`]);
    assert.deepEqual(bads(on(chain, { cta: { text: "Deposit", offer: "deposit", disabled: true } })), [`BAD ${tag}: the main button reads "Deposit", data-offer "deposit", off; want the Deposit offer: Deposit, data-offer "deposit", on`]);
    assert.deepEqual(bads(on(chain, { cta: null })), [`BAD ${tag}: the main button reads null, data-offer null, off; want the Deposit offer: Deposit, data-offer "deposit", on`]);
    // its tap
    assert.deepEqual(bads(on(chain, {}, { tap: { opened: false, sent: [] } })), [`BAD ${tag}: the Deposit tap did not open the deposit sheet`]);
    assert.deepEqual(bads(on(chain, {}, { tap: { opened: true, sent: ["pool.buy"] } })), [`BAD ${tag}: the Deposit tap sent ["pool.buy"], want no buy`]);
    assert.deepEqual(bads(on(chain, {}, { tap: { opened: true, sent: ["buy"] } })), [`BAD ${tag}: the Deposit tap sent ["buy"], want no buy`]);
    assert.deepEqual(bads(on(chain, {}, { tap: null })), [`BAD ${tag}: the Deposit tap did not open the deposit sheet`, `BAD ${tag}: the Deposit tap sent null, want no buy`]);
    // the quote, Bal, Max $0 and the over-max mark, kept
    assert.deepEqual(bads(on(chain, { balance: "$12 available" })), [`BAD ${tag}: Bal reads "$12 available", not a fresh account's "$0 available"`]);
    assert.deepEqual(bads(on(chain, { fee: null })), [`BAD ${tag}: no Fee row`]);
    assert.deepEqual(bads(on(chain, { receive: "—" })), [`BAD ${tag}: the page answered an out, You receive reads "—"; its answers: ${DEPOSIT_MS[chain]} ms out`]);
    if (chain !== "near") {
      assert.deepEqual(bads(on(chain, { max: "Max $5" })), [`BAD ${tag}: the line above Buy reads "Max $5", want "Max $0"`]);
      assert.deepEqual(bads(on(chain, { bad: "false" })), [`BAD ${tag}: the amount 5 is not marked over Max`]);
    }
    assert.deepEqual(bads(on(chain, {}, { dry: c.dry.filter((d) => d.amount === undefined) })), [`BAD ${tag}: the box asked no quote of the amount`]);
    const { [chain]: _, ...rest } = good.chains;
    assert.deepEqual(bads({ chains: rest }), [`BAD ${chain}: the box was not read`]);
  }
});

test("planted (card near-buy-box-draws-every-answer): the BAD line names each answer's ms, so a late page reads apart from a dropped answer", () => {
  const c = ANSWERS.deposit.chains.near.coins.find((x) => quoted(x.box.receive));
  // app live run 44201271127 run 2's shape, at the times read on the live hosts 18 Nov 00:0xZ (token.intear.near: the
  // page answered each ask past the kit client's 10 s, so the box asked again, and drew the third's out at 28.1 s)
  const late = [
    { amount: "5.00", askedMs: 251, ok: true, ms: 13467, result: { tap_max: "0", out: "397.16" } },
    { amount: "5.00", askedMs: 10252, ok: true, ms: 12180, result: { tap_max: "0", out: "397.16" } },
    { amount: "5.00", askedMs: 20253, ok: false, code: "no answer" },
  ];
  const near = (coin) => ({ chains: { ...ANSWERS.deposit.chains, near: { coins: [coin] } } });
  const v = judge(near({ ...structuredClone(c), box: { ...c.box, receive: "Quoting" }, dry: late }));
  assert.equal(v.verdict, "FAIL");
  assert.deepEqual(v.lines.filter((l) => l.startsWith("BAD")), [
    `BAD near ${c.coin}: the page answered an out, You receive reads "Quoting"; its answers: 13467 ms out (asked at 251 ms), 12180 ms out (asked at 10252 ms), no answer (asked at 20253 ms)`,
  ]);
  // a refusal by its code, an answer with no out as "no out"; the ask with no amount (Max's) is not listed
  const mixed = [{ ok: true, ms: 40, result: { tap_max: "0" } }, { amount: "5.00", ok: false, ms: 61, code: "down" }, { amount: "5.00", ok: true, ms: 900, result: { tap_max: "0" } }, { amount: "5.00", ok: true, ms: 11000, result: { tap_max: "0", out: "1.5" } }];
  assert.equal(answersOf({ dry: mixed }), "61 ms down, 900 ms no out, 11000 ms out");
  // the box drew the out: no BAD, whatever the times
  assert.equal(judge(near({ ...structuredClone(c), dry: late })).verdict, "PASS");
});

test("recorded nearLate (release-171 live, each ask timed): NEAR ok on qtc; the coins left on Quoting were answered past 10 s", () => {
  const v = judge(ANSWERS.nearLate);
  // Base answered no ask on that run (card base-buy-box-answers-a-fresh-account): INCONCLUSIVE, no BAD
  assert.equal(v.verdict, "INCONCLUSIVE", v.lines.join("\n"));
  assert.ok(v.lines.some((l) => l.startsWith("ok near qtc.omft.near: ")));
  // the coin read before it, judged alone, is the red of run 44201271127 run 2 with its times named
  const hoot = ANSWERS.nearLate.chains.near.coins.find((c) => c.coin === "hoot-8ecf65.launchpad.justhoot.near");
  const alone = judge({ chains: { ...ANSWERS.nearLate.chains, near: { coins: [hoot] } } });
  assert.equal(alone.verdict, "FAIL");
  assert.deepEqual(alone.lines.filter((l) => l.startsWith("BAD")), [
    'BAD near hoot-8ecf65.launchpad.justhoot.near: the page answered an out, You receive reads "Quoting"; its answers: 11826 ms out (asked at 221 ms), 10728 ms out (asked at 10227 ms), no answer (asked at 20222 ms)',
  ]);
});

test("planted on the reads before 922 (given the offer): quoted coins on every chain PASS; a page refusal FAILs", () => {
  const tb = offered(ANSWERS.thisBuild).chains;
  const solQuoted = offered(ANSWERS.timeout30).chains.solana.coins.find((c) => quoted(c.box.receive));
  const rhQuoted = { ...tb.base.coins[0], coin: "0xrh" };
  const good = { chains: { solana: { coins: [solQuoted] }, base: tb.base, robinhood: { coins: [rhQuoted] }, near: tb.near } };
  assert.equal(judge(good).verdict, "PASS", judge(good).lines.join("\n"));
  // a page refusal no coin's own read explains (not_funded) is the page's FAIL; quote_check_failed alone INCONCLUSIVE
  const refused = (code) => ({ chains: { ...good.chains, base: { coins: [{ ...tb.base.coins[0], box: { ...tb.base.coins[0].box, receive: "—" }, dry: [{ amount: "0.002", ok: false, code }] }] } } });
  assert.deepEqual(judge(refused("not_funded")).lines.filter((l) => l.startsWith("BAD")), ['BAD base: the page answered the box\'s quote "not_funded": no price for a buy with no pool note']);
  assert.equal(judge(refused("quote_check_failed")).verdict, "INCONCLUSIVE");
  assert.equal(judge(null).ok, false);
});
