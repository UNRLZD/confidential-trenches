// node --test scripts/live-checks/app-launchpad-badges.test.mjs: the live check's verdict replays recorded runs
// (app-launchpad-badges.answers.json), each read by app-launchpad-badges.mjs collect() in headless Chromium 153:
//   good:     2026-11-10 06:26Z (--record), APP_HOST as deployed, the lists read live from HELPER_HOST (Solana's, Base's
//             and Robinhood's): 360 rows on the phone and 361 on desktop, every row its chain mark, its link to the token
//             page naming its chain: PASS;
//   liveMain: 2026-11-03 12:45Z, APP_HOST as deployed from main before this card: every row draws no badge and the
//             desktop rows draw the raw id ("pump.fun") as text: FAIL.
//   twoChain: 2026-11-10, the real Base and Robinhood lists answers (each cut to two rows), the Robinhood one also listing
//             the first Base row's token, as live run 42716137594 read one token on both chains (planted copy: the real
//             one has left the lists).
// Planted on the good answer: a missing badge, a wrong pad, a wrong hover, a logo that did not load, a badge on a
// row served null, a served id with no table row, a raw id, a missing chain mark, a clipped badge: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, linkOf, rowFaults, servedMap, servedRow, SETTLE, SETTLE_MS, WIDTHS } from "./app-launchpad-badges.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-launchpad-badges.answers.json"), "utf8"));
/** A recorded lists answer as the helper served it: each row's id back under its wire key (stored as addr, see the answers file). */
const read = (a) => ({ url: a.url, status: a.status, body: { ...a.body, lists: Object.fromEntries(Object.entries(a.body.lists).map(([k, rows]) => [k, rows.map(({ addr, ...r }) => ({ ["tok" + "en"]: addr, ...r }))])) } });
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
/** The good answer with `f` applied to the first desktop row whose served launchpad satisfies `pick`. */
const mut = (pick, f) => {
  const rec = structuredClone(ANSWERS.good);
  const row = rec.loads[1].rows.find((r) => pick(r.served.launchpad));
  f(row);
  return { ...judge(rec), faults: rowFaults(row) };
};
const padded = (id) => id === "pump.fun";

test("recorded good answer: every row's launchpad and chain drawn as logo badges with their names, no raw id, nothing clipped: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const w of WIDTHS) assert.ok(r.lines.some((l) => new RegExp(`^ok  ${w.name} /discover: \\d+ rows, \\d+ with a launchpad badge \\([^)]*pump\\.fun[^)]*\\), every row its chain mark, no raw id, nothing clipped$`).test(l)), w.name);
  for (const l of ANSWERS.good.loads) {
    assert.ok(l.rows.length > 100);
    assert.ok(l.rows.some((x) => x.served.launchpad === null && x.pad === null && x.chain?.id === "solana"), "a row served null draws only the chain mark");
    assert.ok(l.rows.some((x) => x.pad?.id === "pump.fun" && x.pad.title === "pump.fun" && x.pad.loaded));
  }
});

test("recorded bad answer: APP_HOST as deployed from main draws no badge and the raw id as text: FAIL", () => {
  const r = judge(ANSWERS.liveMain);
  assert.equal(r.ok, false);
  assert.ok(bad(r.lines).some((l) => /^BAD phone \/discover: \d+ of \d+ rows wrong, first new\/\w+: (no [^;]+ badge; )?no chain badge/.test(l)), r.lines.join("\n"));
  assert.ok(bad(r.lines).some((l) => /^BAD desktop \/discover: .*no pump\.fun badge; no chain badge; raw id "pump\.fun" drawn as text/.test(l)), r.lines.join("\n"));
});

test("planted on the good answer: each way a badge can be wrong: FAIL", () => {
  const cases = [
    [padded, (x) => (x.pad = null), /no pump\.fun badge/],
    [padded, (x) => (x.pad.id = "met-dbc"), /launchpad badge says "met-dbc", served "pump\.fun"/],
    [padded, (x) => (x.pad.title = "pump.fun launchpad"), /launchpad hover "pump\.fun launchpad", not "pump\.fun"/],
    [padded, (x) => (x.pad.loaded = false), /pump\.fun logo did not load/],
    [(id) => id === null, (x) => (x.pad = { id: "pump.fun", title: "pump.fun", loaded: true }), /a launchpad badge \("pump\.fun"\) where none was served/],
    [padded, (x) => ((x.served.launchpad = "moonshot"), (x.pad = null)), /launchpad "moonshot" has no row in the table/],
    [padded, (x) => x.texts.push("pump.fun"), /raw id "pump\.fun" drawn as text/],
    [padded, (x) => (x.chain = null), /no chain badge/],
    [padded, (x) => (x.chain.id = "base"), /chain badge says "base", served "solana"/],
    [padded, (x) => (x.chain.loaded = false), /chain mark did not load/],
    [padded, (x) => x.clipped.push("launchpad badge cut by its box"), /clipped: launchpad badge cut by its box/],
    [padded, (x) => (x.served = null), /not in the lists answer the page read/],
  ];
  for (const [pick, f, want] of cases) {
    const r = mut(pick, f);
    assert.equal(r.ok, false, String(want));
    assert.ok(r.faults.some((m) => want.test(m)), `${want}: ${r.faults.join("; ")}`);
    assert.ok(bad(r.lines).some((l) => /^BAD desktop \/discover: 1 of \d+ rows wrong/.test(l)), r.lines.join("\n"));
  }
});

test("one token listed on Base and on Robinhood: each drawn row is matched by its chain and its token, so the Base row is judged against Base: PASS", () => {
  const served = servedMap(ANSWERS.twoChain.answers.map(read));
  const [base, robinhood] = ANSWERS.twoChain.answers.map((a) => read(a).body.lists.new);
  const token = base[0].token;
  assert.equal(robinhood[0].token, token, "the token is on both chains");
  const draw = (chain, id = chain) => ({ column: "new", addr: token, href: `/token/${chain}/${token}`, pad: null, chain: { id, title: id === "base" ? "Base" : "Robinhood", loaded: true }, texts: [], clipped: [] });
  const rows = [draw("base"), draw("robinhood")].map((r) => ({ ...r, served: servedRow(served, r) }));
  assert.deepEqual(rows.map((r) => r.served?.chain), ["base", "robinhood"]);
  for (const r of rows) assert.deepEqual(rowFaults(r), []);
  // the same two rows, the Base one wearing Robinhood's badge: a truly wrong badge, FAIL, naming it
  const wrong = servedRow(served, draw("base"));
  assert.deepEqual(rowFaults({ ...draw("base", "robinhood"), served: wrong }), ['chain badge says "robinhood", served "base"', 'chain hover "Robinhood", not "Base"']);
});

test("a drawn row with no link to a token page, or a link naming another token, matches no served row: FAIL", () => {
  const served = servedMap(ANSWERS.twoChain.answers.map(read));
  const token = read(ANSWERS.twoChain.answers[0]).body.lists.new[0].token;
  assert.equal(servedRow(served, { addr: token, href: null }), null);
  assert.equal(servedRow(served, { addr: token, href: "/discover" }), null);
  assert.equal(servedRow(served, { addr: token, href: `/token/base/${token.slice(0, -1)}0` }), null);
  assert.equal(servedRow(served, { addr: token, href: `/token/solana/${token}` }), null);
  assert.deepEqual(rowFaults({ addr: token, href: null, served: null }), ["no link to its token page"]);
  assert.deepEqual(rowFaults({ addr: token, href: `/token/solana/${token}`, served: null }), ["not in the lists answer the page read"]);
  assert.deepEqual(linkOf("/token/base/0xab%2Fc"), { chain: "base", token: "0xab/c" });
  assert.equal(linkOf("/token/base/%E0%A4%A"), null);
});

test("the good answer's rows each carry the chain their link names, and every chain badge is that chain's", () => {
  for (const l of ANSWERS.good.loads) {
    const chains = new Set();
    for (const r of l.rows) {
      const link = linkOf(r.href);
      assert.ok(link && link.token === r.addr, `${r.addr}: ${r.href}`);
      assert.equal(r.served.chain, link.chain);
      assert.equal(r.chain.id, link.chain);
      chains.add(link.chain);
    }
    assert.deepEqual([...chains].sort(), ["base", "robinhood", "solana"]);
  }
});

test("a run that never drew Discover, or read no lists, or lost a width: FAIL", () => {
  let rec = structuredClone(ANSWERS.good);
  rec.loads[0].state = null;
  assert.ok(bad(judge(rec).lines).some((l) => /phone \/discover: Discover not drawn/.test(l)));
  rec = structuredClone(ANSWERS.good);
  rec.loads[1].lists = null;
  assert.ok(bad(judge(rec).lines).some((l) => /desktop \/discover: Discover ready, lists not read/.test(l)));
  rec = structuredClone(ANSWERS.good);
  rec.loads[1].rows = [];
  assert.ok(bad(judge(rec).lines).some((l) => /desktop \/discover: no rows drawn/.test(l)));
  rec = structuredClone(ANSWERS.good);
  rec.loads.pop();
  assert.ok(bad(judge(rec).lines).some((l) => /1 loads of 2/.test(l)));
});

// card app-faults-seen-on-124: release 125's app live run (43328445607) hung 20 minutes in this check's wait for every
// image, which had no bound; the wait is now SETTLE_MS and each image still pending is a BAD line naming it
test("planted: an image that never settles fails the run naming it, and the wait ends at its bound", async () => {
  assert.equal(SETTLE_MS, 8_000);
  const rec = structuredClone(ANSWERS.good);
  rec.loads[1].pending = ["ct-api.unrealized.trade/v1/logo/solana/never"];
  assert.deepEqual(bad(judge(rec).lines), ["BAD desktop /discover: image never settled in 8 s: ct-api.unrealized.trade/v1/logo/solana/never"]);
  // SETTLE in a stand-in page: one eager image that never answers, one that loads, one lazy image below the fold and one
  // lazy image in a tab not drawn (neither asked for by a browser until it comes near), one already complete. The page's
  // timer is a stand-in: the test fires it, so no real time passes.
  const img = (src, { lazy = false, drawn = true, top = 10, complete = false } = {}) => {
    const ls = {};
    return {
      src, currentSrc: "", loading: lazy ? "lazy" : "auto", ls,
      get complete() { return complete; },
      fire: (k) => ((complete = true), ls[k]?.()),
      getClientRects: () => (drawn ? [{}] : []),
      getBoundingClientRect: () => ({ top, bottom: top + 20, left: 10, right: 30 }),
      addEventListener: (k, f) => (ls[k] = f),
    };
  };
  const never = img("https://ct-api.unrealized.trade/v1/logo/solana/never?x=1");
  const loads = img("https://a.test/loads.png");
  const below = img("https://a.test/below.png", { lazy: true, top: 5000 });
  const hidden = img("https://a.test/hidden.png", { lazy: true, drawn: false });
  const done = img("https://a.test/done.png", { complete: true });
  const timers = [];
  const saved = { document: globalThis.document, location: globalThis.location, innerWidth: globalThis.innerWidth, innerHeight: globalThis.innerHeight, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  Object.assign(globalThis, {
    document: { images: [never, loads, below, hidden, done] },
    location: { href: "https://ct-app.unrealized.trade/discover" },
    innerWidth: 1440,
    innerHeight: 900,
    setTimeout: (f, ms) => timers.push({ f, ms }) - 1,
    clearTimeout: (id) => timers[id] && (timers[id].cleared = true),
  });
  try {
    let pending = null;
    const p = SETTLE({ ms: SETTLE_MS }).then((x) => (pending = x));
    // waited on: the two eager images not yet complete, never the lazy ones the browser has not asked for
    assert.ok(never.ls.load && loads.ls.load && !below.ls.load && !hidden.ls.load && !done.ls.load);
    assert.deepEqual(timers.map((t) => t.ms), [SETTLE_MS]);
    loads.fire("load");
    await Promise.resolve();
    assert.equal(pending, null, "one image still out: no answer before the bound");
    timers[0].f();
    await p;
    assert.deepEqual(pending, ["ct-api.unrealized.trade/v1/logo/solana/never"]);
    // nothing to wait on: it answers at once, with no timer set
    globalThis.document = { images: [below, hidden, done] };
    assert.deepEqual(await SETTLE({ ms: SETTLE_MS }), []);
    assert.equal(timers.length, 1);
    // every image settles: the answer comes then, its timer cleared
    const a = img("https://a.test/a.png");
    globalThis.document = { images: [a] };
    const q = SETTLE({ ms: SETTLE_MS });
    a.fire("error");
    assert.deepEqual(await q, []);
    assert.equal(timers[1].cleared, true);
  } finally {
    Object.assign(globalThis, saved);
  }
});
