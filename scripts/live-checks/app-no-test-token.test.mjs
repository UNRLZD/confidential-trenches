// node --test scripts/live-checks/app-no-test-token.test.mjs: the live check's verdict replays recorded runs
// (app-no-test-token.answers.json), each read by app-no-test-token.mjs collect() in headless Chromium:
//   good: APP_HOST as deployed (13 Nov, release 126), signed out: / at 1440 and /?fx=curve read Solana's, Base's,
//         Robinhood's and NEAR's lists and draw the top Trending token of them all, read on its own chain; / at 390
//         draws the Trenches list on Trending, its first row that same top: PASS;
//   bad_phone_page: card app-near-trading's build (12 Nov), the good answer until the phone's / became the Trenches
//         list, served at APP_HOST's name inside the stand-in shell (--build), HELPER_HOST live: / at 390 draws the top
//         token's page, no list: FAIL at the phone alone;
//   bad_no_near: card app-chains-evm-rail's build (9 Nov), the good answer until NEAR joined, served the same way: /
//         reads no NEAR lists: FAIL;
//   bad:  APP_HOST as deployed before card app-no-test-token (3 Nov, the fixture source): its JS holds
//         GlowFixtureCurve and the other fixture ids, the page draws the fixture token G1owFixtureCurve... and reads no
//         lists: FAIL;
//   bad_one_chain: the build of card/app-chains-evm at 7b5770f3 (9 Nov), served the same way: / reads Solana's lists
//         alone: FAIL.
// Planted from the good run: a script holding a fixture id, a page token other than the top, a failed lists read; at
// the phone, a list whose first row is a fixture, one whose first row is not the top of Trending, an empty list, a list
// still loading or on another chip.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CHAINS, judge, LISTS_URL, LOADS, topOf, TOKEN_URL } from "./app-no-test-token.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-no-test-token.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: / and /?fx=curve at 1440 draw the lists' top Trending token, the phone's list starts with it, no fixture in the JS: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(ANSWERS.good.loads.length, LOADS.length);
  for (const l of ANSWERS.good.loads) {
    const top = topOf(l.lists);
    assert.deepEqual(l.lists.map((x) => x.url).sort(), CHAINS.map(LISTS_URL).sort(), "every chain's lists read");
    if (l.width === "phone") {
      assert.equal(l.token, null, "the phone's list reads no token");
      assert.deepEqual([l.list.state, l.list.chip, l.list.first.chain, l.list.first.mint], ["ready", "trending", top.chain, top.mint]);
      assert.ok(r.lines.some((x) => x.startsWith(`ok  phone /: the Trenches list on Trending, ${l.list.rows} row(s), its first ${top.chain}/${top.mint} (${l.list.first.symbol}) = the top of Trending`)), r.lines.join("\n"));
      continue;
    }
    assert.equal(l.shown, top.mint);
    assert.equal(`${l.token.url}?chain=${l.token.chain}&token=${l.token.mint}`, TOKEN_URL(top.chain, top.mint));
    assert.ok(l.scripts.length > 0 && l.scripts.every((s) => s.hits === 0));
    assert.ok(r.lines.some((x) => x.startsWith(`ok  ${l.width} ${l.path}: ready, data-token ${top.chain}/${top.mint} (${l.symbol}) = the top of Trending in every chain's lists it read (`)), r.lines.join("\n"));
  }
});

test("recorded bad answer: the build of 12 Nov, the phone's / drawing the top token's page and no list: FAIL at the phone alone", () => {
  const r = judge(ANSWERS.bad_phone_page);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r.lines), ["BAD phone /: drew no Trenches list (a token page, ready)"], r.lines.join("\n"));
});

test("recorded bad answer: the deployed fixture source (GlowFixtureCurve in the JS, the fixture token drawn, no lists read): FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  const b = bad(r.lines);
  assert.ok(b.some((l) => /desktop \/: the served JS .* fixture hit\(s\): .*G1owFixtureCurve/.test(l)), r.lines.join("\n"));
  assert.ok(b.some((l) => /desktop \/: .*data-token G1owFixtureCurve1111111111111111111111pump is a fixture/.test(l)), r.lines.join("\n"));
  assert.ok(b.some((l) => /desktop \/: .*the page read no lists of solana, base, robinhood, near/.test(l)), r.lines.join("\n"));
  assert.ok(b.some((l) => /desktop \/\?fx=curve: /.test(l)), r.lines.join("\n"));
});

test("recorded bad answer: the build of 7b5770f3, / reading Solana's lists alone: FAIL at every load", () => {
  const r = judge(ANSWERS.bad_one_chain);
  assert.equal(r.ok, false);
  for (const l of LOADS) assert.ok(bad(r.lines).some((x) => x.includes(`${l.name} ${l.path}: `) && /the page read no lists of base, robinhood, near/.test(x)), r.lines.join("\n"));
});

test("recorded bad answer: the build of 9 Nov, / reading Solana's, Base's and Robinhood's lists and no NEAR's: FAIL at every load", () => {
  assert.ok(CHAINS.includes("near"));
  const r = judge(ANSWERS.bad_no_near);
  assert.equal(r.ok, false);
  for (const l of LOADS) assert.ok(bad(r.lines).some((x) => x.includes(`${l.name} ${l.path}: `) && /the page read no lists of near$/.test(x)), r.lines.join("\n"));
});

test("planted: a page token on another chain than the top's fails, so does a token read on the wrong chain", () => {
  const other = mut((rec) => {
    const l = rec.loads[0];
    const notTop = l.lists.find((x) => x.chain !== topOf(l.lists).chain && x.trending?.length);
    l.shown = notTop.trending[0].mint;
  });
  assert.ok(bad(other.lines).some((l) => /^BAD desktop \/: data-token \S+, the lists' top Trending token is/.test(l)), other.lines.join("\n"));
  const chain = mut((rec) => {
    rec.loads[2].token.chain = rec.loads[2].token.chain === "base" ? "solana" : "base";
  });
  assert.ok(bad(chain.lines).some((l) => /^BAD desktop \/\?fx=curve: token read at .*, not /.test(l)), chain.lines.join("\n"));
});

test("planted: one script holding a fixture id fails the JS line", () => {
  const r = mut((rec) => {
    rec.loads[0].scripts[0].hits = 1;
    rec.loads[0].scripts[0].samples = ["curve:`G1owFixtureCurve1111"];
  });
  assert.equal(r.ok, false);
  assert.ok(bad(r.lines).some((l) => /^BAD desktop \/: the served JS .*1 fixture hit/.test(l)), r.lines.join("\n"));
});

test("planted: a page token other than the lists' top fails, and so does a page left loading", () => {
  const other = mut((rec) => {
    rec.loads[2].shown = rec.loads[2].lists.find((x) => x.trending?.length).trending.at(-1).mint;
  });
  assert.equal(other.ok, false);
  assert.ok(bad(other.lines).some((l) => /^BAD desktop \/\?fx=curve: data-token \S+, the lists' top Trending token is/.test(l)), other.lines.join("\n"));
  const loading = mut((rec) => {
    rec.loads[0].state = "loading";
  });
  assert.equal(loading.ok, false);
});

test("planted: a failed lists read or a token read for another mint fails", () => {
  const lists = mut((rec) => {
    for (const x of rec.loads[0].lists) x.status = 503;
  });
  assert.ok(bad(lists.lines).some((l) => /lists status solana 503|lists status \w+ 503, /.test(l)), lists.lines.join("\n"));
  // one chain failing leaves the others' top: the verdict merges only the chains that answered, as the app does
  const oneDown = mut((rec) => {
    const l = rec.loads[0];
    const down = l.lists.find((x) => x.chain !== topOf(l.lists).chain);
    down.status = 503;
  });
  assert.equal(oneDown.ok, true, oneDown.lines.join("\n"));
  const token = mut((rec) => {
    rec.loads[2].token.rowMint = "So11111111111111111111111111111111111111112";
  });
  assert.ok(bad(token.lines).some((l) => /^BAD desktop \/\?fx=curve: token row So111/.test(l)), token.lines.join("\n"));
});

test("planted at the phone: a first row that is a fixture, one that is not the top of Trending, an empty list: FAIL", () => {
  const phoneBad = (r) => bad(r.lines).filter((l) => l.startsWith("BAD phone /: "));
  const fixture = mut((rec) => {
    rec.loads[1].list.first = { chain: "solana", mint: "G1owFixtureCurve1111111111111111111111pump", symbol: "CURVE" };
  });
  assert.equal(fixture.ok, false);
  assert.ok(phoneBad(fixture).some((l) => /first row solana\/G1owFixtureCurve1+pump \(CURVE\) is a fixture/.test(l)), fixture.lines.join("\n"));
  // the same fixture, its id and name the top's own: the fixture rule alone fails it
  const named = mut((rec) => {
    rec.loads[1].list.first.symbol = "FixtureCurve";
  });
  assert.equal(named.ok, false);
  assert.ok(phoneBad(named).some((l) => /is a fixture$/.test(l)), named.lines.join("\n"));
  const notTop = mut((rec) => {
    const l = rec.loads[1];
    const top = topOf(l.lists);
    const second = l.lists.find((x) => x.chain !== top.chain && x.status === 200 && x.trending?.length);
    l.list.first = { chain: second.chain, mint: second.trending[0].mint, symbol: second.trending[0].symbol };
  });
  assert.equal(notTop.ok, false);
  assert.ok(phoneBad(notTop).some((l) => /first row \S+, the lists' top Trending token is /.test(l)), notTop.lines.join("\n"));
  // the top's id on another chain is not the top
  const otherChain = mut((rec) => {
    const f = rec.loads[1].list.first;
    f.chain = f.chain === "base" ? "robinhood" : "base";
  });
  assert.equal(otherChain.ok, false);
  const empty = mut((rec) => {
    rec.loads[1].list.rows = 0;
    rec.loads[1].list.first = null;
  });
  assert.equal(empty.ok, false);
  assert.deepEqual(phoneBad(empty), ["BAD phone /: the list drew no row"], empty.lines.join("\n"));
});

test("planted at the phone: a list still loading, on another chip, or no list at all: FAIL", () => {
  const loading = mut((rec) => {
    rec.loads[1].list.state = "loading";
  });
  assert.ok(bad(loading.lines).some((l) => l.startsWith("BAD phone /: list state loading, not ready")), loading.lines.join("\n"));
  const chip = mut((rec) => {
    rec.loads[1].list.chip = "new";
  });
  assert.ok(bad(chip.lines).some((l) => l.startsWith("BAD phone /: list on new chip, not Trending")), chip.lines.join("\n"));
  const none = mut((rec) => {
    rec.loads[1].list = null;
  });
  assert.ok(bad(none.lines).some((l) => l.startsWith("BAD phone /: drew no Trenches list")), none.lines.join("\n"));
  // the phone's other rules hold as before: every chain's lists read
  const unread = mut((rec) => {
    rec.loads[1].lists = rec.loads[1].lists.filter((x) => x.chain !== "near");
  });
  assert.ok(bad(unread.lines).some((l) => /^BAD phone \/: .*the page read no lists of near/.test(l)), unread.lines.join("\n"));
});
