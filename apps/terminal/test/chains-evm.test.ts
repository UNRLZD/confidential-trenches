// Discover on every chain the helper serves lists for (card app-chains-evm): Solana, Base and Robinhood read at once,
// merged in the browser (09-design-brief S1 Chain filter, "`All` merges the four chains' served lists in the browser"),
// narrowed by the shell's one chain filter; each chain held on its own by Discover's 60 s rule.
// test/chains-evm/lists-{base,robinhood}-2026-11-09.json are recorded answers of GET /v1/market/lists?chain=base and
// ?chain=robinhood at HELPER_HOST; test/discover-data/helper-lists-2026-11-01.json is Solana's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { allListsReader, LIST_CHAINS, listsUrl, mergeLists, pickData, pickSnapshot, readChainLists, STALE_MS } from "../src/screens/discover/data.ts";
import { ROW_FIELDS } from "../src/screens/discover/fields.ts";
import { columnRows, COLUMNS, rowView } from "../src/screens/discover/model.ts";
import { padEntries } from "../src/screens/discover/view.ts";
import { chainOf, padOf } from "../src/screens/market/pads.ts";
import { tokenHref } from "../src/routes/routes.ts";
import { allRows, chainsWithData, plan } from "../src/shell/search.ts";
import solanaRec from "./discover-data/helper-lists-2026-11-01.json" with { type: "json" };
import baseRec from "./chains-evm/lists-base-2026-11-09.json" with { type: "json" };
import robinhoodRec from "./chains-evm/lists-robinhood-2026-11-09.json" with { type: "json" };

type Obj = Record<string, unknown>;
type Rec = { chain: string; as_of_ms: number; fields: string[]; lists: Record<string, unknown[][]> };
/** A recording as the helper sends it: each row an object with the keys of the recorded header. */
const answer = (rec: Rec) => ({
  chain: rec.chain,
  as_of_ms: rec.as_of_ms,
  lists: Object.fromEntries(Object.entries(rec.lists).map(([k, rows]) => [k, rows.map((v) => Object.fromEntries(rec.fields.map((f, i) => [f, v[i]])))])) as Record<string, Obj[]>,
});
const ANSWERS: Record<string, ReturnType<typeof answer>> = { solana: answer(solanaRec as Rec), base: answer(baseRec as Rec), robinhood: answer(robinhoodRec as Rec) };

/** A helper answering each chain's lists from the recordings; `down` chains answer 503. */
function helper(down: readonly string[] = []) {
  const calls: string[] = [];
  const fn: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    const chain = new URL(url).searchParams.get("chain") ?? "";
    if (down.includes(chain) || !ANSWERS[chain]) return new Response(JSON.stringify({ error: { code: "upstream" } }), { status: 503 });
    return new Response(JSON.stringify(ANSWERS[chain]), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fn, calls };
}

test("the recorded Base and Robinhood answers are the frozen field list: every row exactly ROW_FIELDS, in order", () => {
  for (const c of ["base", "robinhood"] as const) {
    const a = ANSWERS[c]!;
    assert.equal(a.chain, c);
    let n = 0;
    for (const [name, rows] of Object.entries(a.lists))
      for (const r of rows) {
        n++;
        assert.deepEqual(Object.keys(r), [...ROW_FIELDS], `${c} ${name} ${String(r.symbol)}`);
        assert.equal(r.chain, c);
      }
    assert.ok(n >= 60, `${c}: ${n} rows`);
  }
});

test("readAllLists: one read of each chain's lists on HELPER_HOST, merged; Discover's columns hold Base and Robinhood rows", async () => {
  const h = helper();
  const s = await allListsReader()(h.fn);
  assert.deepEqual(h.calls, LIST_CHAINS.map(listsUrl));
  assert.deepEqual(h.calls, ["solana", "base", "robinhood"].map((c) => `https://ct-api.unrealized.trade/v1/market/lists?chain=${c}`));
  assert.equal(s.chain, "all");
  assert.equal(s.as_of_ms, Math.min(...Object.values(ANSWERS).map((a) => a.as_of_ms)));
  for (const c of LIST_CHAINS) {
    for (const k of ["new", "trending"] as const) assert.ok(columnRows(s, k).some((r) => r.chain === c), `${c} in ${k}`);
  }
  assert.deepEqual(chainsWithData(allRows(s)), ["solana", "base", "robinhood"]);
});

test("the chain filter: one chain's rows only, dated by that chain's own read; All keeps every chain", async () => {
  const s = await allListsReader()(helper().fn);
  assert.equal(pickSnapshot(s, "all"), s);
  for (const c of ["base", "robinhood"] as const) {
    const p = pickSnapshot(s, c);
    assert.equal(p.chain, c);
    assert.equal(p.as_of_ms, ANSWERS[c]!.as_of_ms);
    for (const k of COLUMNS.map((x) => x.key)) assert.ok(columnRows(p, k).every((r) => r.chain === c), `${c} ${k}`);
    assert.ok(columnRows(p, "new").length > 0 && columnRows(p, "trending").length > 0, c);
    const d = pickData({ status: "ready", snapshot: s }, c);
    assert.ok(d.status === "ready" && d.snapshot.chain === c);
  }
  assert.deepEqual(pickData({ status: "loading" }, "base"), { status: "loading" });
});

test("a Base and a Robinhood row draw as Solana's do: the same row view, its chain's mark, its launchpad from the row's own field, its page at /token/<chain>/<id>", async () => {
  const s = await allListsReader()(helper().fn);
  for (const c of ["base", "robinhood"] as const) {
    const top = columnRows(pickSnapshot(s, c), "trending")[0]!;
    const v = rowView(top, "1h", Date.now());
    assert.equal(v.chain, c);
    assert.equal(v.launchpad, top.launchpad);
    assert.ok(chainOf(v.chain), `${c} has a chain mark`);
    assert.equal(tokenHref(top.chain, top.token), `/token/${c}/${top.token}`);
  }
  // the launchpad menu lists each chain's pads by the factory ids the rows carry, under their chain
  const keys = padEntries(s).map((e) => e.key);
  for (const k of ["base:clanker", "robinhood:pons"]) assert.ok(keys.includes(k), k);
  for (const e of padEntries(s)) assert.ok(padOf(e.launchpad), e.key);
});

test("the search finds a Base and a Robinhood token by symbol, and by its 0x address on its chain only", async () => {
  const s = await allListsReader()(helper().fn);
  const rows = allRows(s);
  const chains = chainsWithData(rows);
  for (const c of ["base", "robinhood"] as const) {
    const top = columnRows(pickSnapshot(s, c), "trending")[0]!;
    assert.ok(plan(rows, top.symbol, "all", chains).rows.some((r) => r.chain === c && r.token === top.token), `${c} ${top.symbol}`);
    assert.deepEqual(plan(rows, top.token, c, chains).rows.map((r) => `${r.chain}/${r.token}`), [`${c}/${top.token}`]);
    assert.equal(plan(rows, top.symbol, "solana", chains).rows.filter((r) => r.chain === c).length, 0);
  }
});

test("each chain held on its own: a chain's failed read keeps its last lists for 60 s, then leaves them out; the others stay", async () => {
  let t = 1_000_000;
  const read = allListsReader({ now: () => t });
  await read(helper().fn);
  t += STALE_MS;
  let s = await read(helper(["robinhood"]).fn);
  assert.ok(allRows(s).some((r) => r.chain === "robinhood"), "held at 60 s");
  t += 1;
  s = await read(helper(["robinhood"]).fn);
  assert.deepEqual(chainsWithData(allRows(s)), ["solana", "base"]);
  // a chain that never answered is left out, never an error while another chain draws
  s = await allListsReader()(helper(["solana", "robinhood"]).fn);
  assert.deepEqual(chainsWithData(allRows(s)), ["base"]);
  // no chain to draw: the read fails, so Discover's own rule (afterFail) runs
  await assert.rejects(allListsReader()(helper(["solana", "base", "robinhood"]).fn), /no chain answered/);
});

test("one chain's read: an answer of another chain, or a row of another chain inside it, is not that chain's", async () => {
  const wrong: typeof fetch = async () => new Response(JSON.stringify(ANSWERS.base), { status: 200 });
  await assert.rejects(readChainLists("robinhood", wrong), /not a robinhood snapshot/);
  const a = structuredClone(ANSWERS.base!);
  a.lists.new!.push({ ...a.lists.new![0]!, chain: "robinhood", token: "0x0000000000000000000000000000000000000001" });
  const s = await readChainLists("base", async () => new Response(JSON.stringify(a), { status: 200 }));
  assert.ok(s.lists.new.every((r) => r.chain === "base"));
  assert.equal(mergeLists([s]).lists.new.length, ANSWERS.base!.lists.new!.length);
});
