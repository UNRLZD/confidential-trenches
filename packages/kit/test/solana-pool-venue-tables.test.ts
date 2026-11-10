// Card sol-pool-venue-tables: every venue the pool buy builds fits 1,232 bytes on its own frozen lookup tables, the
// generations solanaPoolNextTableRange and solanaPoolVenueTableList make (contracts/pool-solana/scripts/venue-table.mjs
// extends each with exactly that list), at every tree position: the last entry a generation lists, the first past it,
// both trees past it. buildSolanaPoolBuyOnTables builds on the generation that makes the smallest transaction and
// refuses no_table_fits when none fits. Sized on the LiteSVM run's recorded mainnet reads (solana-pool-buy-fx.ts), for
// every case the page can build: plain or cashback, tip or none, Token-2022 or not, coin creator set or not.
import assert from "node:assert/strict";
import test from "node:test";
import { base58, base64 } from "@scure/base";
import {
  SOLANA_POOL_BUY_VENUES,
  SOLANA_TOKEN_2022_PROGRAM,
  SOLANA_JITO_TIP_ACCOUNTS,
  SOLANA_POOL_CURVE_FIRST_RANGE,
  solanaPoolRangeWarn,
  SOLANA_SYSTEM_PROGRAM,
  buildSolanaPoolBuy,
  buildSolanaPoolBuyOnTables,
  readSolanaPoolTableVenue,
  solanaPoolNextTableRange,
  solanaPoolRangeEnd,
  solanaDecodeLookupTable,
  solanaPoolTableVenueOf,
  solanaPoolVenueTableList,
  type SolanaPoolBuyVenue,
  type SolanaRpc,
} from "../src/index.ts";
import { cfg, fx, release, setup, TIP } from "./solana-pool-buy-fx.ts";

const tableOf = (list: readonly string[], fill = 9) => {
  const meta = new Uint8Array(56);
  const dv = new DataView(meta.buffer);
  dv.setUint32(0, 1, true);
  dv.setBigUint64(4, (1n << 64n) - 1n, true);
  return { address: base58.encode(new Uint8Array(32).fill(fill)), table: solanaDecodeLookupTable(Uint8Array.from([...meta, ...list.flatMap((k) => [...base58.decode(k)])])) };
};
const FX = { "pump-curve": "pump", pumpswap: "pumpswap" } as const;
/** The venue's global account (pump Global, PumpSwap GlobalConfig) as provider `p` answered it in the recorded run:
 *  the third account of the buy's own [mint, curve or pool, global] read. */
const globalRead = (kind: "pump-curve" | "pumpswap", p: 0 | 1) => {
  const rec = fx[FX[kind]];
  const ans = rec.reads[p][JSON.stringify([rec.mint, ...Object.keys(rec.reads[p]).map((k) => JSON.parse(k)).find((l: string[]) => l.length === 3 && l[0] === rec.mint)!.slice(1)])];
  return { list: JSON.parse(Object.keys(rec.reads[p]).find((k) => JSON.parse(k).length === 3)!) as string[], value: ans.value[2], context: ans.context };
};
const globalProvider = (kind: "pump-curve" | "pumpswap", p: 0 | 1, edit?: (v: any) => any): SolanaRpc =>
  (async (method: string, params: readonly unknown[]) => {
    assert.equal(method, "getMultipleAccounts");
    const g = globalRead(kind, p);
    assert.deepEqual(params[0], [g.list[2]], "reads the venue's global account only");
    assert.equal((params[1] as { commitment: string }).commitment, "finalized");
    const value = structuredClone(g.value);
    return { context: g.context, value: [edit ? edit(value) : value] };
  }) as SolanaRpc;
const tableVenue = (kind: "pump-curve" | "pumpswap") => readSolanaPoolTableVenue([globalProvider(kind, 0), globalProvider(kind, 1)], kind);

test("the table venue reader gives the fee accounts the buy's own venue reader gives, for every venue the buy builds", async () => {
  assert.deepEqual([...SOLANA_POOL_BUY_VENUES], ["pump-curve", "pumpswap"]);
  for (const kind of SOLANA_POOL_BUY_VENUES) {
    const { venue } = await setup(FX[kind]);
    const t = await tableVenue(kind);
    if (t.kind === "pump-curve" && venue.kind === "pump-curve") assert.deepEqual(t, { kind, feeRecipient: venue.feeRecipient, buybackFeeRecipients: venue.buybackFeeRecipients });
    else if (t.kind === "pumpswap" && venue.kind === "pumpswap") assert.deepEqual(t, { kind, protocolFeeRecipient: venue.protocolFeeRecipient, buybackFeeRecipients: venue.buybackFeeRecipients });
    else assert.fail(`${kind}: read as ${t.kind}`);
  }
});

test("the table venue reader refuses: providers that disagree, an unset buyback recipient, a wrong owner, an unknown venue", async () => {
  for (const kind of SOLANA_POOL_BUY_VENUES) {
    const flip = (v: any) => {
      const d = base64.decode(v.data[0]);
      d[d.length - 1] = d[d.length - 1]! ^ 1;
      return { ...v, data: [base64.encode(d), "base64"] };
    };
    await assert.rejects(readSolanaPoolTableVenue([globalProvider(kind, 0), globalProvider(kind, 1, flip)], kind), /disagree/);
    const at = kind === "pump-curve" ? 741 : 643;
    const unset = (v: any) => {
      const d = base64.decode(v.data[0]);
      d.fill(0, at + 32 * 3, at + 32 * 4);
      return { ...v, data: [base64.encode(d), "base64"] };
    };
    await assert.rejects(readSolanaPoolTableVenue([globalProvider(kind, 0, unset), globalProvider(kind, 1, unset)], kind), /buyback recipient is unset/);
    // the two providers name different owners for the same bytes (mutant C5)
    await assert.rejects(readSolanaPoolTableVenue([globalProvider(kind, 0), globalProvider(kind, 1, (v: any) => ({ ...v, owner: "11111111111111111111111111111111" }))], kind), /disagree/);
    const owner = (v: any) => ({ ...v, owner: "11111111111111111111111111111111" });
    await assert.rejects(readSolanaPoolTableVenue([globalProvider(kind, 0, owner), globalProvider(kind, 1, owner)], kind));
  }
  await assert.rejects(readSolanaPoolTableVenue([globalProvider("pump-curve", 0), globalProvider("pump-curve", 1)], "raydium" as "pumpswap"), /no such venue/);
  assert.throws(() => solanaPoolTableVenueOf("toString" as "pumpswap", { owner: "", data: new Uint8Array(0) } as never), /no such venue/);
});

/** Every case the page can build for a venue: Token-2022 or not, cashback or not, tip or none, coin creator set or not
 *  (PumpSwap; the curve's creator is always set). */
function* cases(venue: SolanaPoolBuyVenue) {
  for (const t22 of [false, true])
    for (const cashback of [false, true])
      for (const tip of [0n, TIP])
        for (const creator of venue.kind === "pumpswap" ? [true, false] : [true]) {
          const ven = { ...venue, cashback, ...(t22 ? { tokenProgram: SOLANA_TOKEN_2022_PROGRAM, tokenAccountSize: 182 } : {}), ...(creator ? {} : { coinCreator: SOLANA_SYSTEM_PROGRAM }) } as SolanaPoolBuyVenue;
          yield { ven, tip, name: `${venue.kind}${t22 ? " token-2022" : ""}${cashback ? " cashback" : ""}${creator ? "" : " no-creator"} ${tip > 0n ? "tip" : "none"}` };
        }
}
/** A venue's generations, each made when the trees held the sizes given (null: the curve's frozen first). */
const generations = async (kind: "pump-curve" | "pumpswap", made: readonly ({ state: number; label: number } | null)[]) => {
  const tv = await tableVenue(kind);
  return made.map((sizes, g) => {
    const range = sizes === null ? SOLANA_POOL_CURVE_FIRST_RANGE : solanaPoolNextTableRange(cfg, tv, sizes);
    const list = solanaPoolVenueTableList(cfg, tv, range);
    return { range, list, table: tableOf(list, 20 + g) };
  });
};
const FIRST = { state: 0, label: 0 };

test("generations: PumpSwap's first fills its table, 136 state pages and 90 label pages; a next one starts a page behind each tree's end", async () => {
  const [g1] = await generations("pumpswap", [FIRST]);
  assert.deepEqual(g1!.range, { state: [0, 135], label: [0, 89] });
  assert.equal(g1!.list.length, 256);
  // entries covered: state 0 to 139,263, label 0 to 92,159; it warns past 111,411 and 73,727
  assert.deepEqual(solanaPoolRangeEnd(g1!.range), { state: 139_264, label: 92_160 });
  assert.deepEqual(solanaPoolRangeWarn(g1!.range), { state: 111_411, label: 73_728 });
  // made when the state tree passed generation 1's warning and the label tree lags far behind: each from its own page
  const [, g2] = await generations("pumpswap", [FIRST, { state: 111_412, label: 5_000 }]);
  assert.deepEqual(g2!.range, { state: [107, 242], label: [3, 92] });
  assert.equal(g2!.list.length, 256);
  // the curve: its first generation is the frozen mainnet table's (pages 0 and 1, 25 addresses); a next fills 256
  const [c1, c2] = await generations("pump-curve", [null, { state: 1_500, label: 1_500 }]);
  assert.equal(c1!.list.length, 25);
  assert.deepEqual(c2!.range, { state: [0, 140], label: [0, 93] });
  assert.equal(c2!.list.length, 256);
  for (const g of [g1!, g2!, c1!, c2!]) {
    assert.equal(new Set(g.list).size, g.list.length);
    assert.equal(g.list[0], cfg.pool);
  }
  // a fee recipient that is also a buyback recipient is listed once (mutant C13)
  const tv = await tableVenue("pumpswap");
  if (tv.kind !== "pumpswap") assert.fail();
  assert.equal(solanaPoolVenueTableList(cfg, { ...tv, protocolFeeRecipient: tv.buybackFeeRecipients[0]! }, g1!.range).length, 254);
  assert.throws(() => solanaPoolVenueTableList(cfg, tv, { state: [0, 300], label: [0, 0] }), /at most 256 addresses/);
  assert.throws(() => solanaPoolVenueTableList(cfg, tv, { state: [3, 2], label: [0, 0] }), /from <= to/);
  assert.throws(() => solanaPoolNextTableRange(cfg, tv, { state: -1, label: 0 }), /u32/);
});

test("size at the edges: PumpSwap on two generations, every case: the last entry generation 1 lists, the first past it, both trees past it", async () => {
  const { venue, req, chain } = await setup("pumpswap");
  const { table: _t, ...bare } = chain;
  const rows: string[] = [];
  let largest = 0;
  // generation 2 made at generation 1's state warning, the label tree lagging far behind or near its own warning
  for (const lag of [5_000, 74_000]) {
    const [g1, g2] = await generations("pumpswap", [FIRST, { state: 111_412, label: lag }]);
    const end = solanaPoolRangeEnd(g1!.range);
    // [name, state size, state root index, label root index]: roots at most a page behind each tree's end
    const spots: [string, number, number, number][] = [
      ["trees small", 6, release.stateRootIndex, release.labelRootIndex],
      ["the last state entry generation 1 lists, the root on the page before", end.state - 1, end.state - 1 - 1024, lag + 10],
      ["the first state entry past generation 1, the root on the page before", end.state, end.state - 1, lag + 10],
      ["the first state entry past generation 1, the label root a page behind where generation 2 was made", end.state, end.state - 1, Math.max(0, lag - 1024)],
      ["both trees past generation 1", end.state + 5, end.state + 2, Math.max(end.label + 3, lag + 10)],
    ];
    for (const [spot, stateSize, sri, lri] of spots)
      for (const { ven, tip, name } of cases(venue)) {
        const rel = { ...release, stateRootIndex: sri, labelRootIndex: lri };
        const r = { ...req, tip, cluster: tip > 0n ? "mainnet" : "devnet" } as typeof req;
        const b = buildSolanaPoolBuyOnTables(cfg, rel, ven, r, { ...bare, stateSize }, [g1!.table, g2!.table], { pick: () => 0 });
        rows.push(`label at ${lag} | ${spot} | ${name} => ${b.size} B on generation ${b.table === g1!.table ? 1 : 2}`);
        largest = Math.max(largest, b.size);
        // the one built is the smallest of the two alone; each alone fits or is refused by name, never a bare size error
        const alone = [g1!, g2!].map((g) => {
          try {
            return buildSolanaPoolBuyOnTables(cfg, rel, ven, r, { ...bare, stateSize }, [g.table], { pick: () => 0 }).size;
          } catch (e) {
            assert.match((e as Error).message, /^no_table_fits: the smallest is \d+ bytes > 1232$/);
            return Infinity;
          }
        });
        assert.equal(b.size, Math.min(...alone), `${spot} ${name}`);
        // past generation 1's state pages, generation 2 holds every page the buy names, so it is the one built
        if (stateSize >= end.state) assert.equal(b.table, g2!.table, `${spot} ${name}`);
      }
  }
  console.log(rows.join("\n"));
  // measured: 1,204 B at worst (a cashback coin with a tip once the state tree is past generation 1), 28 B to spare
  assert.equal(largest, 1204);
});

test("size: the curve's one frozen generation fits every case at any tree size (1,137 B at worst), so it never becomes a limit", async () => {
  const { venue, req, chain } = await setup("pump");
  const [g1] = await generations("pump-curve", [null]);
  const { table: _t, ...bare } = chain;
  let largest = 0;
  for (const stateSize of [6, 2047, 2048, 3072, 1_000_000, 0xffff_ffff - 1])
    for (const [sri, lri] of [[Math.max(0, stateSize - 1025), 5], [stateSize - 1, 1_000_000], [0, 0]] as const)
      for (const { ven, tip } of cases(venue)) {
        const b = buildSolanaPoolBuyOnTables(cfg, { ...release, stateRootIndex: sri, labelRootIndex: lri }, ven, { ...req, tip, cluster: tip > 0n ? "mainnet" : "devnet" }, { ...bare, stateSize }, [g1!.table], { pick: () => 0 });
        largest = Math.max(largest, b.size);
      }
  assert.ok(largest <= 1137, `${largest} B`);
});

test("the selector: the smallest of the given tables, one tip account for all; none, or none that fits: no_table_fits", async () => {
  const { venue, req, chain } = await setup("pumpswap");
  const [g1, g2] = await generations("pumpswap", [FIRST, { state: 111_412, label: 74_000 }]);
  const { table: _t, ...bare } = chain;
  const curve = solanaPoolVenueTableList(cfg, await tableVenue("pump-curve"), SOLANA_POOL_CURVE_FIRST_RANGE);
  const r = { ...req, tip: TIP, cluster: "mainnet" as const };
  const ven = { ...venue, cashback: true } as SolanaPoolBuyVenue;
  // equal sizes: the last given, the newest generation
  const twin = { ...g1!.table, address: base58.encode(new Uint8Array(32).fill(77)) };
  assert.equal(buildSolanaPoolBuyOnTables(cfg, release, ven, r, { ...bare, stateSize: 6 }, [g1!.table, twin], { pick: () => 3 }).table, twin);
  // in either order, generation 1 serves a small tree (generation 2, made at 111,412, has no page 0)
  for (const order of [[g1!.table, g2!.table], [g2!.table, g1!.table]]) assert.equal(buildSolanaPoolBuyOnTables(cfg, release, ven, r, { ...bare, stateSize: 6 }, order, { pick: () => 3 }).table, g1!.table);
  const b = buildSolanaPoolBuyOnTables(cfg, release, ven, r, { ...bare, stateSize: 6 }, [g2!.table, g1!.table], { pick: () => 3 });
  assert.ok(b.instructions[2]!.accounts.some((a) => a.key === SOLANA_JITO_TIP_ACCOUNTS[3]));
  assert.throws(() => buildSolanaPoolBuyOnTables(cfg, release, ven, r, { ...bare, stateSize: 6 }, [], {}), /^Error: no_table_fits: no table$/);
  assert.throws(() => buildSolanaPoolBuyOnTables(cfg, release, ven, r, { ...bare, stateSize: 6 }, [tableOf(curve)], {}), /^Error: no_table_fits: the smallest is 1[34]\d\d bytes > 1232$/);
});

test("a PumpSwap buy given the pump curve's table is too large: the reason each venue has its own", async () => {
  const curve = solanaPoolVenueTableList(cfg, await tableVenue("pump-curve"), SOLANA_POOL_CURVE_FIRST_RANGE);
  const { venue, req, chain } = await setup("pumpswap");
  for (const cashback of [false, true]) {
    const ven = { ...venue, cashback } as SolanaPoolBuyVenue;
    assert.throws(() => buildSolanaPoolBuy(cfg, release, ven, { ...req, tip: TIP, cluster: "mainnet" }, { ...chain, table: tableOf(curve) }, { pick: () => 0 }), /too_large: 1[34]\d\d bytes > 1232/);
  }
});
