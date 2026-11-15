// node --test scripts/live-checks/buy-box-quotes-before-funds.test.mjs: the live check replays its recorded answers
// (buy-box-quotes-before-funds.answers.json, its _note says how each was made).
//   appBefore: APP_HOST live before half 2, with the page that quotes a buy with no pool note: FAIL, the box asks no
//     quote on Solana, Base and Robinhood (no Fee row) and drops NEAR's out.
//   thisBuild: this card's app with that page: Base and NEAR draw the quote with Max $0; FAIL on Solana only, where the
//     page answers the box's quote in 10.9-11.2 s, past the kit client's 10 s for pool.buy.dry, so the box shows a dash;
//     Robinhood's page answered no quote (INCONCLUSIVE alone).
//   timeout30: the same app with that 10 s raised to 30 s (an experiment): Solana draws the quote; INCONCLUSIVE, Base and
//     Robinhood unanswered by the page in that run.
// Planted on thisBuild's quoted coins: each fact taken away FAILs; Solana and Robinhood planted from quoted coins PASS.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CHAINS, judge, quoted } from "./buy-box-quotes-before-funds.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./buy-box-quotes-before-funds.answers.json", import.meta.url), "utf8"));
const SOL_LATE = "BAD solana 7SL2VnfYsChvog5oQY9Nmtqu1wceaMiQzWoqoLQpump: the page answered an out, You receive reads \"—\"";

test("recorded appBefore (APP_HOST before half 2): FAIL, no quote asked on the pool chains and NEAR's out dropped", () => {
  const v = judge(ANSWERS.appBefore);
  assert.equal(v.verdict, "FAIL");
  assert.deepEqual(v.lines, [
    "BAD solana C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump: no Fee row",
    "BAD solana C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump: the box asked no quote of the amount",
    "BAD base 0xed664536023d8e4b1640c394777d34abaff1df8f: no Fee row",
    "BAD base 0xed664536023d8e4b1640c394777d34abaff1df8f: the box asked no quote of the amount",
    "BAD robinhood 0xedbf91223639800bcd5756815caf908df3b890be: no Fee row",
    "BAD robinhood 0xedbf91223639800bcd5756815caf908df3b890be: the box asked no quote of the amount",
    'BAD near prl.omft.near: the page answered an out, You receive reads "—"',
  ]);
});

test("recorded thisBuild: Base and NEAR quoted with Max $0; FAIL on Solana alone (the page's answer past the kit's 10 s)", () => {
  const v = judge(ANSWERS.thisBuild);
  assert.equal(v.verdict, "FAIL");
  assert.deepEqual(v.lines.filter((l) => l.startsWith("BAD")), [SOL_LATE]);
  assert.ok(v.lines.some((l) => l.startsWith("ok base ")));
  assert.ok(v.lines.some((l) => l.startsWith("ok near ")));
  assert.ok(v.lines.some((l) => l.startsWith("no-answer robinhood")));
  // the late answers: every Solana quote the page priced came after 10 s
  const late = ANSWERS.thisBuild.chains.solana.coins.flatMap((c) => c.dry).filter((d) => d.amount !== undefined && d.ok);
  assert.ok(late.length > 0 && late.every((d) => d.ms > 10_000), JSON.stringify(late.map((d) => d.ms)));
});

test("recorded timeout30 (experiment): the box draws Solana's quote once the answer is let in; INCONCLUSIVE", () => {
  const v = judge(ANSWERS.timeout30);
  assert.equal(v.verdict, "INCONCLUSIVE");
  assert.ok(v.lines.some((l) => l.startsWith("ok solana ")));
  assert.equal(v.lines.some((l) => l.startsWith("BAD")), false);
});

test("planted: quoted coins on every chain PASS; each fact taken away FAILs", () => {
  const tb = ANSWERS.thisBuild.chains;
  const solQuoted = ANSWERS.timeout30.chains.solana.coins.find((c) => quoted(c.box.receive));
  // a Robinhood coin drawn as Base's was (a plant: no recorded Robinhood quote exists)
  const rhQuoted = { ...tb.base.coins[0], coin: "0xrh" };
  const good = { chains: { solana: { coins: [solQuoted] }, base: tb.base, robinhood: { coins: [rhQuoted] }, near: tb.near } };
  assert.equal(judge(good).verdict, "PASS", judge(good).lines.join("\n"));
  const on = (chain, patch) => {
    const c = good.chains[chain].coins.find((x) => quoted(x.box.receive));
    return { chains: { ...good.chains, [chain]: { coins: [{ ...c, box: { ...c.box, ...patch } }] } } };
  };
  for (const chain of CHAINS) {
    const c = good.chains[chain].coins.find((x) => quoted(x.box.receive));
    const tag = `${chain} ${c.coin}`;
    assert.deepEqual(judge(on(chain, { balance: "$12 available" })).lines.filter((l) => l.startsWith("BAD")), [`BAD ${tag}: Bal reads "$12 available", not a fresh account's "$0 available"`]);
    assert.deepEqual(judge(on(chain, { ctaOff: false })).lines.filter((l) => l.startsWith("BAD")), [`BAD ${tag}: Buy is not off`]);
    assert.deepEqual(judge(on(chain, { fee: null })).lines.filter((l) => l.startsWith("BAD")), [`BAD ${tag}: no Fee row`]);
    assert.deepEqual(judge(on(chain, { receive: "—" })).lines.filter((l) => l.startsWith("BAD")), [`BAD ${tag}: the page answered an out, You receive reads "—"`]);
    if (chain !== "near") {
      assert.deepEqual(judge(on(chain, { max: "Max $5" })).lines.filter((l) => l.startsWith("BAD")), [`BAD ${tag}: the line above Buy reads "Max $5", want "Max $0"`]);
      assert.deepEqual(judge(on(chain, { bad: "false" })).lines.filter((l) => l.startsWith("BAD")), [`BAD ${tag}: the amount 5 is not marked over Max`]);
    }
    // the box asked no quote: FAIL, whatever it draws
    const noAsk = { chains: { ...good.chains, [chain]: { coins: [{ ...c, dry: c.dry.filter((d) => d.amount === undefined) }] } } };
    assert.deepEqual(judge(noAsk).lines.filter((l) => l.startsWith("BAD")), [`BAD ${tag}: the box asked no quote of the amount`]);
    const { [chain]: _, ...rest } = good.chains;
    assert.deepEqual(judge({ chains: rest }).lines.filter((l) => l.startsWith("BAD")), [`BAD ${chain}: the box was not read`]);
  }
  // a page refusal no coin's own read explains (not_funded) is the page's FAIL; quote_check_failed alone INCONCLUSIVE
  const refused = (code) => ({ chains: { ...good.chains, base: { coins: [{ ...tb.base.coins[0], box: { ...tb.base.coins[0].box, receive: "—" }, dry: [{ amount: "0.002", ok: false, code }] }] } } });
  assert.deepEqual(judge(refused("not_funded")).lines.filter((l) => l.startsWith("BAD")), ['BAD base: the page answered the box\'s quote "not_funded": no price for a buy with no pool note']);
  assert.equal(judge(refused("quote_check_failed")).verdict, "INCONCLUSIVE");
  assert.equal(judge(null).ok, false);
});
