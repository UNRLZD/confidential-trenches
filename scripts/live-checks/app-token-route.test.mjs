// node --test scripts/live-checks/app-token-route.test.mjs: the live check's verdict replays recorded runs
// (app-token-route.answers.json), each read on 3 Nov by app-token-route.mjs collect() in headless Chromium, HELPER_HOST live:
//   good: this card's build served at APP_HOST's name inside the stand-in shell (--build): /token/solana/<a live mint>
//         at 1440 and 390 draws that token with the address following, and an unknown id draws the not-found state: PASS;
//   bad:  APP_HOST's build before this card (main at 406beb0): the route does not exist, so the deep link falls back to
//         "/" (the top Trending token, the address "/"): FAIL.
// Card app-chains-evm re-recorded good on 9 Nov with a live Base and a live Robinhood token (the third row of each chain's
// Trending column) opened at 1440 beside the Solana loads: the build of card/app-chains-evm in the stand-in shell, HELPER_HOST
// live, headless Chrome 157: PASS. The bad run stays 406beb0's (it fails on its own loads, and on the two it lacks): main
// before this card already drew /token/base and /token/robinhood, so no build of main fails the EVM loads alone.
// Planted from the good run: a page that draws another token, an address that stays at "/", an unknown id that draws a
// token, a failed lists read, a token read for another mint.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { drawnRead, EVM_CHAINS, judge, listsUrl, LISTS_URL, LOADS, NO_ANSWER_MS, pickOf, SIGN_HOST, TOKEN_URL, tokenMisses, UNKNOWN } from "./app-token-route.mjs";
import { verdictOf } from "./helper-misses.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-token-route.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: a live mint opens its own page at both widths with the address following, an unknown id is not found: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(ANSWERS.good.loads.length, LOADS.length);
  const mint = pickOf(ANSWERS.good.lists.trending);
  assert.equal(ANSWERS.good.lists.url, LISTS_URL);
  for (const l of ANSWERS.good.loads.filter((x) => x.state === "ready" && x.opened.includes("/token/solana/"))) {
    assert.equal(l.shown, mint);
    assert.equal(l.top, `${SIGN_HOST}/token/solana/${mint}`);
    assert.equal(`${l.token.url}?chain=${l.token.chain}&token=${l.token.mint}`, TOKEN_URL(mint));
  }
  assert.ok(ANSWERS.good.loads.some((l) => l.state === "empty" && l.top.endsWith(`/token/solana/${UNKNOWN}`)));
  // card app-chains-evm: a live Base and Robinhood token, each its chain's third Trending row, drawn at its own address
  for (const c of EVM_CHAINS) {
    const e = ANSWERS.good.evm[c];
    assert.equal(e.url, listsUrl(c));
    const id = pickOf(e.trending);
    const l = ANSWERS.good.loads.find((x) => x.opened.includes(`/token/${c}/`));
    assert.equal(l.state, "ready");
    assert.equal(l.shown, id);
    assert.equal(l.top, `${SIGN_HOST}/token/${c}/${id}`);
    assert.equal(`${l.token.url}?chain=${l.token.chain}&token=${l.token.mint}`, TOKEN_URL(id, c));
    assert.ok(r.lines.includes(`ok  desktop /token/${c}/<live token>: ready, data-token ${id} (${l.symbol}), the address ${l.top}, its token read 200 for that mint`), r.lines.join("\n"));
  }
});

test("planted (card app-chains-evm): a Base list read that fails, or a Base page that draws a Solana token, fails", () => {
  let r = mut((rec) => (rec.evm.base.status = 429));
  assert.ok(bad(r.lines).some((l) => /the helper's base lists: status 429/.test(l)), r.lines.join("\n"));
  r = mut((rec) => {
    const l = rec.loads.find((x) => x.opened.includes("/token/base/"));
    l.shown = rec.lists.trending[0].mint;
  });
  assert.ok(bad(r.lines).some((l) => /^BAD desktop \/token\/base\/<live token>: data-token \S+, the mint is 0x/.test(l)), r.lines.join("\n"));
});

test("recorded bad answer: the build before this card (the deep link falls back to /, the top Trending token): FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  const b = bad(r.lines);
  assert.ok(b.some((l) => /desktop \/token\/solana\/<live mint>: .*the top window's address is .*not /.test(l)), r.lines.join("\n"));
  assert.ok(b.some((l) => /data-token \S+, the mint is /.test(l)), r.lines.join("\n"));
  assert.ok(b.some((l) => /<unknown>: .*not the not-found state/.test(l)), r.lines.join("\n"));
});

test("planted: a deep link whose address stays at / fails", () => {
  const r = mut((rec) => {
    rec.loads[1].top = `${SIGN_HOST}/`;
  });
  assert.equal(r.ok, false);
  assert.ok(bad(r.lines).some((l) => /^BAD phone .*the top window's address is /.test(l)), r.lines.join("\n"));
});

test("planted: a page that draws another token, or is left loading, fails", () => {
  const other = mut((rec) => {
    rec.loads[0].shown = rec.lists.trending[0].mint;
  });
  assert.ok(bad(other.lines).some((l) => /data-token \S+, the mint is/.test(l)), other.lines.join("\n"));
  const loading = mut((rec) => {
    rec.loads[0].state = "loading";
  });
  assert.equal(loading.ok, false);
});

test("planted: an unknown id that draws a token, or a read not answered 404, fails", () => {
  const drawn = mut((rec) => {
    rec.loads[2].state = "ready";
    rec.loads[2].shown = rec.lists.trending[0].mint;
  });
  assert.ok(bad(drawn.lines).some((l) => /<unknown>: /.test(l)), drawn.lines.join("\n"));
  const read = mut((rec) => {
    rec.loads[2].token.status = 200;
  });
  assert.ok(bad(read.lines).some((l) => /token status 200, not 404/.test(l)), read.lines.join("\n"));
});

test("planted: a failed lists read or a token read for another mint fails", () => {
  const lists = mut((rec) => {
    rec.lists.status = 503;
  });
  assert.ok(bad(lists.lines).some((l) => /lists status 503/.test(l)), lists.lines.join("\n"));
  const token = mut((rec) => {
    rec.loads[0].token.rowMint = "So11111111111111111111111111111111111111112";
  });
  assert.ok(bad(token.lines).some((l) => /^BAD desktop .*token row So111/.test(l)), token.lines.join("\n"));
});

// Card app-token-page-rides-out-a-slow-token-read: merge group 44618685462 (main 66a4a0232 + PR 1089), test-browser (4)
// job 135894248598, 21:34:17Z: "BAD desktop /token/robinhood/<live token>: state error, not ready; ... the page read no
// token answer", no helper miss printed, "FAIL, never run again". Its record is planted from the good run: the
// Robinhood load drawn in the error state, its one token read cut by the page's 10 s wait (net::ERR_ABORTED, which
// helper-misses.mjs's watch read a few ms under MISS_MS as the page's own abort).
const robinhood = (rec) => rec.loads.find((x) => x.opened.includes("/token/robinhood/"));
const slow = (reads, source) => {
  const rec = structuredClone(ANSWERS.good);
  if (source) rec.source = source;
  const l = robinhood(rec);
  Object.assign(l, { state: "error", shown: null, symbol: null, id: null, reads });
  l.token = drawnRead(reads) >= 0 ? { ...l.token, status: reads[drawnRead(reads)].status } : null;
  return rec;
};
const verdict = (rec) => verdictOf(judge(rec).ok ? "PASS" : "FAIL", tokenMisses(rec)).verdict;

test("planted (merge group 44618685462): an error page after a token read the helper never answered is a helper miss, INCONCLUSIVE, never a page fault", () => {
  for (const reads of [
    [{ ms: 9_998, failed: "net::ERR_ABORTED" }],
    [{ ms: 10_001, failed: "net::ERR_ABORTED" }, { ms: 9_499, failed: "net::ERR_ABORTED" }],
    [{ ms: 7_000, failed: "net::ERR_CONNECTION_RESET" }],
    [{ ms: 25_000, pending: true }],
    [{ ms: 300, status: 503 }, { ms: 200, status: 502 }, { ms: 400, status: 429 }],
  ]) {
    const rec = slow(reads);
    const r = judge(rec);
    assert.equal(r.ok, false);
    assert.ok(bad(r.lines).some((l) => /^BAD desktop \/token\/robinhood\/<live token>: state error, not ready/.test(l)), r.lines.join("\n"));
    assert.ok(tokenMisses(rec).length > 0, JSON.stringify(reads));
    assert.equal(verdict(rec), "INCONCLUSIVE", JSON.stringify(reads));
  }
  assert.deepEqual(tokenMisses(slow([{ ms: 9_998, failed: "net::ERR_ABORTED" }])), ["ct-api.unrealized.trade: no answer (/v1/market/token failed after 10.0 s: net::ERR_ABORTED)"]);
});

test("planted: an error page on token answers the helper gave still FAILs (no miss): a 200, a refusal, or a read the page cut short", () => {
  for (const reads of [
    [{ ms: 700, status: 200 }],
    [{ ms: 600, status: 400 }],
    [{ ms: NO_ANSWER_MS - 1, failed: "net::ERR_ABORTED" }],
    [{ ms: 300, failed: "net::ERR_ABORTED" }, { ms: 300, failed: "net::ERR_ABORTED" }],
  ]) {
    const rec = slow(reads);
    assert.deepEqual(tokenMisses(rec), [], JSON.stringify(reads));
    assert.equal(verdict(rec), "FAIL", JSON.stringify(reads));
  }
});

test("a deployed run names no token miss: there the helper is part of what is checked", () => {
  const rec = slow([{ ms: 10_001, failed: "net::ERR_ABORTED" }], "live");
  assert.deepEqual(tokenMisses(rec), []);
  assert.equal(verdict(rec), "FAIL");
});

test("the token answer judged is the one the page drew: its last read the helper answered, past a 503", () => {
  assert.equal(drawnRead([{ ms: 300, status: 503 }, { ms: 700, status: 200 }]), 1);
  assert.equal(drawnRead([{ ms: 10_000, failed: "net::ERR_ABORTED" }, { ms: 700, status: 200 }, { ms: 9_000, failed: "net::ERR_ABORTED" }]), 1);
  assert.equal(drawnRead([{ ms: 300, status: 503 }, { ms: 10_000, failed: "net::ERR_ABORTED" }]), 0);
  assert.equal(drawnRead([{ ms: 10_000, failed: "net::ERR_ABORTED" }]), -1);
  assert.equal(drawnRead([]), -1);
  // a page that rode out a 503 and drew the token PASSes
  const rec = structuredClone(ANSWERS.good);
  robinhood(rec).reads = [{ ms: 300, status: 503 }, { ms: 700, status: 200 }];
  assert.equal(judge(rec).ok, true);
});
