// node --test scripts/live-checks/app-no-test-token.test.mjs: the live check's verdict replays recorded runs
// (app-no-test-token.answers.json), each read by app-no-test-token.mjs collect() in headless Chromium:
//   good: card app-chains-evm-rail's build (9 Nov) served at APP_HOST's name inside the stand-in shell (--build),
//         HELPER_HOST answered live: / at 1440 and 390 and /?fx=curve read Solana's, Base's and Robinhood's lists and
//         draw the top Trending token of them all, read on its own chain: PASS;
//   bad:  APP_HOST as deployed before card app-no-test-token (3 Nov, the fixture source): its JS holds
//         GlowFixtureCurve and the other fixture ids, the page draws the fixture token G1owFixtureCurve... and reads no
//         lists: FAIL;
//   bad_one_chain: the build of card/app-chains-evm at 7b5770f3 (9 Nov), served the same way: / reads Solana's lists
//         alone: FAIL.
// Planted from the good run: a script holding a fixture id, a page token other than the top, a failed lists read.
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

test("recorded good answer: / at both widths and /?fx=curve draw the lists' top Trending token, no fixture in the JS: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(ANSWERS.good.loads.length, LOADS.length);
  for (const l of ANSWERS.good.loads) {
    const top = topOf(l.lists);
    assert.deepEqual(l.lists.map((x) => x.url).sort(), CHAINS.map(LISTS_URL).sort(), "every chain's lists read");
    assert.equal(l.shown, top.mint);
    assert.equal(`${l.token.url}?chain=${l.token.chain}&token=${l.token.mint}`, TOKEN_URL(top.chain, top.mint));
    assert.ok(l.scripts.length > 0 && l.scripts.every((s) => s.hits === 0));
    assert.ok(r.lines.some((x) => x.startsWith(`ok  ${l.width} ${l.path}: ready, data-token ${top.chain}/${top.mint} (${l.symbol}) = the top of Trending in every chain's lists it read (`)), r.lines.join("\n"));
  }
});

test("recorded bad answer: the deployed fixture source (GlowFixtureCurve in the JS, the fixture token drawn, no lists read): FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  const b = bad(r.lines);
  assert.ok(b.some((l) => /desktop \/: the served JS .* fixture hit\(s\): .*G1owFixtureCurve/.test(l)), r.lines.join("\n"));
  assert.ok(b.some((l) => /desktop \/: .*data-token G1owFixtureCurve1111111111111111111111pump is a fixture/.test(l)), r.lines.join("\n"));
  assert.ok(b.some((l) => /desktop \/: .*the page read no lists of solana, base, robinhood/.test(l)), r.lines.join("\n"));
  assert.ok(b.some((l) => /desktop \/\?fx=curve: /.test(l)), r.lines.join("\n"));
});

test("recorded bad answer: the build of 7b5770f3, / reading Solana's lists alone: FAIL at every load", () => {
  const r = judge(ANSWERS.bad_one_chain);
  assert.equal(r.ok, false);
  for (const l of LOADS) assert.ok(bad(r.lines).some((x) => x.includes(`${l.name} ${l.path}: `) && /the page read no lists of base, robinhood/.test(x)), r.lines.join("\n"));
});

test("planted: a page token on another chain than the top's fails, so does a token read on the wrong chain", () => {
  const other = mut((rec) => {
    const l = rec.loads[0];
    const notTop = l.lists.find((x) => x.chain !== topOf(l.lists).chain && x.trending?.length);
    l.shown = notTop.trending[0].mint;
  });
  assert.ok(bad(other.lines).some((l) => /^BAD desktop \/: data-token \S+, the lists' top Trending token is/.test(l)), other.lines.join("\n"));
  const chain = mut((rec) => {
    rec.loads[1].token.chain = rec.loads[1].token.chain === "base" ? "solana" : "base";
  });
  assert.ok(bad(chain.lines).some((l) => /^BAD phone \/: token read at .*, not /.test(l)), chain.lines.join("\n"));
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
    rec.loads[1].shown = rec.loads[1].lists.find((x) => x.trending?.length).trending.at(-1).mint;
  });
  assert.equal(other.ok, false);
  assert.ok(bad(other.lines).some((l) => /^BAD phone \/: data-token \S+, the lists' top Trending token is/.test(l)), other.lines.join("\n"));
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
