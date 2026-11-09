// Card sol-pool-venue-tables: every venue the pool buy builds fits 1,232 bytes with its own frozen lookup table, the
// table the venue reader and solanaPoolVenueTableList make (contracts/pool-solana/scripts/venue-table.mjs extends a
// venue's table with exactly that list). Sized on the LiteSVM run's recorded mainnet reads (solana-pool-buy-fx.ts),
// plain, cashback and Token-2022 coins, with and without a tip; a PumpSwap buy given the pump curve's table is too large.
import assert from "node:assert/strict";
import test from "node:test";
import { base58, base64 } from "@scure/base";
import {
  SOLANA_POOL_BUY_VENUES,
  SOLANA_TOKEN_2022_PROGRAM,
  buildSolanaPoolBuy,
  readSolanaPoolTableVenue,
  solanaDecodeLookupTable,
  solanaPoolTableVenueOf,
  solanaPoolVenueTableList,
  type SolanaPoolBuyVenue,
  type SolanaPoolTableVenue,
  type SolanaRpc,
} from "../src/index.ts";
import { cfg, fx, release, setup, TIP } from "./solana-pool-buy-fx.ts";

const tableOf = (list: readonly string[]) => {
  const meta = new Uint8Array(56);
  const dv = new DataView(meta.buffer);
  dv.setUint32(0, 1, true);
  dv.setBigUint64(4, (1n << 64n) - 1n, true);
  return { address: base58.encode(new Uint8Array(32).fill(9)), table: solanaDecodeLookupTable(Uint8Array.from([...meta, ...list.flatMap((k) => [...base58.decode(k)])])) };
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
    const owner = (v: any) => ({ ...v, owner: "11111111111111111111111111111111" });
    await assert.rejects(readSolanaPoolTableVenue([globalProvider(kind, 0, owner), globalProvider(kind, 1, owner)], kind));
  }
  await assert.rejects(readSolanaPoolTableVenue([globalProvider("pump-curve", 0), globalProvider("pump-curve", 1)], "raydium" as "pumpswap"), /no such venue/);
  assert.throws(() => solanaPoolTableVenueOf("toString" as "pumpswap", { owner: "", data: new Uint8Array(0) } as never), /no such venue/);
});

test("size per venue: each venue with its own table fits 1,232 B, plain, cashback and Token-2022, tip or none", async () => {
  const rows: string[] = [];
  const sizes: Record<string, number> = {};
  for (const kind of SOLANA_POOL_BUY_VENUES) {
    const { venue, req, chain } = await setup(FX[kind]);
    const list = solanaPoolVenueTableList(cfg, await tableVenue(kind));
    const own = { ...chain, table: tableOf(list) };
    for (const t22 of [false, true])
      for (const cashback of [false, true])
        for (const tip of [0n, TIP]) {
          const ven = { ...venue, cashback, ...(t22 ? { tokenProgram: SOLANA_TOKEN_2022_PROGRAM, tokenAccountSize: 182 } : {}) } as SolanaPoolBuyVenue;
          const b = buildSolanaPoolBuy(cfg, release, ven, { ...req, tip, cluster: tip > 0n ? "mainnet" : "devnet" }, own, { pick: () => 0 });
          const name = `${kind}${t22 ? " token-2022" : ""}${cashback ? " cashback" : ""} ${tip > 0n ? "tip" : "none"}`;
          sizes[name] = b.size;
          rows.push(`size ${name.padEnd(36)} table ${list.length} addresses: ${b.size} B`);
          assert.ok(b.size <= 1232, `${name}: ${b.size} B`);
        }
  }
  console.log(rows.join("\n"));
  // the largest is PumpSwap on a cashback coin with a tip: 1,203 B, the next state page loaded from the venue's table
  // (its four pages hold it, +2 B) where the fixture's two-page table left it out (1,201 B, M369 (L2)). Token-2022
  // changes no size, since both token programs sit in every venue's table
  assert.equal(Math.max(...Object.values(sizes)), 1203);
  assert.equal(sizes["pumpswap cashback tip"], 1203);
});

test("a PumpSwap buy given the pump curve's table is too large: the reason each venue gets its own", async () => {
  const curve = solanaPoolVenueTableList(cfg, await tableVenue("pump-curve"));
  const { venue, req, chain } = await setup("pumpswap");
  for (const cashback of [false, true]) {
    const ven = { ...venue, cashback } as SolanaPoolBuyVenue;
    assert.throws(() => buildSolanaPoolBuy(cfg, release, ven, { ...req, tip: TIP, cluster: "mainnet" }, { ...chain, table: tableOf(curve) }, { pick: () => 0 }), /too_large: 1[34]\d\d bytes > 1232/);
  }
});

test("a venue's table list: the pool, its four pages, the shared programs and the venue's own, each once; disjoint venue parts", async () => {
  const lists = Object.fromEntries(await Promise.all(SOLANA_POOL_BUY_VENUES.map(async (k) => [k, solanaPoolVenueTableList(cfg, await tableVenue(k))] as const))) as Record<string, string[]>;
  assert.equal(lists["pump-curve"]!.length, 25);
  assert.equal(lists.pumpswap!.length, 34);
  for (const l of Object.values(lists)) {
    assert.equal(new Set(l).size, l.length);
    assert.equal(l[0], cfg.pool);
    assert.ok(l.length <= 256, "a table holds at most 256 addresses");
  }
  // the shared head (pool, pages, programs, wSOL, the fee program) is the same in both; the rest is the venue's own
  assert.deepEqual(lists["pump-curve"]!.slice(0, 11), lists.pumpswap!.slice(0, 11));
  const tv: SolanaPoolTableVenue = await tableVenue("pumpswap");
  assert.ok(tv.kind === "pumpswap" && lists.pumpswap!.includes(tv.protocolFeeRecipient));
});
