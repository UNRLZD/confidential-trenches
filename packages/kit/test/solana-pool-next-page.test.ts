// Card pool-senders-next-page: every Solana pool insert the kit builds names its tree's next page, the form the program
// takes since d3edab1 (contracts/pool-solana/src/deposit.rs:72-76 tag 1 of 8 accounts, release.rs:155 tag 2 of 9,
// buy.rs:155-159 tag 3 flag bit 1 with the next state page after the tip account), so an insert that lands first and
// carries the index onto a new page no longer fails the deposit or the release (state.rs page_for).
//   node --test test/solana-pool-next-page.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { base58 } from "@scure/base";
import * as kit from "../src/index.ts";
import { buildSolanaPoolBuy, checkSolanaPoolBuy, solanaDecodeMessage, solanaPoolDepositIx, solanaPoolPage, type SolanaPoolBuyVenue } from "../src/index.ts";
import { BLOCKHASH, FEE_PAYER, PROGRAM, W, cfg, release, setup } from "./solana-pool-buy-fx.ts";

const DEPOSITOR = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const note = { value: 10_000_000n, precommitment: 12345n };
const next = (tree: 0 | 1, size: number) => solanaPoolPage(PROGRAM, tree, (Math.floor(size / 1024) + 1) * 1024);

test("tag 1 names each tree's next page as accounts 6 and 7, writable, the page after the one its size reads", () => {
  for (const [s, l] of [[0, 0], [6, 5], [1023, 1022], [1024, 2047], [5000, 4999]] as const) {
    const ix = solanaPoolDepositIx(PROGRAM, DEPOSITOR, note, { stateSize: s, labelSize: l });
    assert.equal(ix.accounts.length, 8, `sizes ${s}/${l}`);
    assert.deepEqual(ix.accounts[6], { key: next(0, s), signer: false, writable: true });
    assert.deepEqual(ix.accounts[7], { key: next(1, l), signer: false, writable: true });
    assert.equal(ix.accounts[2]!.key, solanaPoolPage(PROGRAM, 0, s));
    assert.notEqual(ix.accounts[6]!.key, ix.accounts[2]!.key);
  }
});

test("tag 2 names the next state page as its ninth account, writable, after the release's eight", () => {
  const f = (kit as Record<string, unknown>).solanaPoolTag2Accounts as undefined | ((...a: unknown[]) => { key: string; signer: boolean; writable: boolean }[]);
  assert.equal(typeof f, "function", "the kit exports solanaPoolTag2Accounts");
  for (const s of [6, 1023, 1024, 3000]) {
    const a = f!(cfg, W, FEE_PAYER, release, s);
    assert.equal(a.length, 9);
    assert.deepEqual(a.slice(0, 8), kit.solanaPoolReleaseAccounts(cfg, W, FEE_PAYER, release, s));
    assert.deepEqual(a[8], { key: next(0, s), signer: false, writable: true });
  }
});

test("tag 3 sets flag bit 1 and names the next state page after the tip account when it fits 1,232 bytes; the check passes it", async () => {
  for (const v of ["pump", "pumpswap"] as const) {
    const { venue, req, chain, reads } = await setup(v);
    for (const tip of [0n, req.tip]) {
      const q = { ...req, tip, cluster: tip > 0n ? ("mainnet" as const) : ("devnet" as const) };
      const b = buildSolanaPoolBuy(cfg, release, venue, q, chain, { pick: () => 0 });
      const ix = b.instructions[2]!;
      const at = 8 + (tip > 0n ? 1 : 0);
      if (ix.data[1] === 3) {
        assert.deepEqual(ix.accounts[at], { key: next(0, chain.stateSize), signer: false, writable: true }, `${v} tip ${tip}`);
      } else {
        // only a build that would pass 1,232 bytes with it names none
        assert.equal(ix.data[1], 1);
        assert.ok(b.size + 33 > 1232, `${v} tip ${tip}: ${b.size} B left without the next page`);
      }
      const verdict = checkSolanaPoolBuy(b.wire, cfg, release, venue, q, reads);
      assert.ok(verdict.ok, `${v} tip ${tip}: ${JSON.stringify(verdict.results.filter((r) => !r.ok))}`);
      assert.ok(b.size <= 1232);
    }
  }
});

test("size table with the next page: static (not in our table) +33 B, loaded from our table +2 B; the largest still fits", async () => {
  const rows: string[] = [];
  for (const v of ["pump", "pumpswap"] as const) {
    for (const cashback of [false, true]) {
      const { venue, req, chain, addresses } = await setup(v);
      const ven = { ...venue, cashback } as SolanaPoolBuyVenue;
      // the mainnet and devnet tables hold each tree's pages 0 and 1 (contracts/pool-solana/scripts/deploy.mjs:1263)
      const withNext = kit.solanaDecodeLookupTable(Uint8Array.from([...tableMeta(), ...[...addresses, next(0, chain.stateSize)].flatMap((k) => [...base58.decode(k)])]));
      for (const tip of [0n, req.tip]) {
        const q = { ...req, tip, cluster: tip > 0n ? ("mainnet" as const) : ("devnet" as const) };
        const staticNext = buildSolanaPoolBuy(cfg, release, ven, q, chain, { pick: () => 0 });
        const loaded = buildSolanaPoolBuy(cfg, release, ven, q, { ...chain, table: { address: chain.table.address, table: withNext } }, { pick: () => 0 });
        assert.equal(loaded.instructions[2]!.data[1], 3, "loaded from the table it always fits");
        const m = solanaDecodeMessage(loaded.message);
        assert.ok(!m.staticKeys.includes(next(0, chain.stateSize)));
        rows.push(`size tag3+next ${v.padEnd(8)} cashback ${cashback ? "yes" : "no "} tip ${tip > 0n ? "yes" : "no "} static ${staticNext.size} B (bit 1 ${staticNext.instructions[2]!.data[1] === 3 ? "yes" : "no "}) loaded ${loaded.size} B`);
        assert.ok(loaded.size <= 1232 && staticNext.size <= 1232);
      }
    }
  }
  console.log(rows.join("\n"));
});

test("the check refuses a tag 3 whose next page is not the state tree's next page", async () => {
  const { venue, req, chain, reads } = await setup("pump");
  const b = buildSolanaPoolBuy(cfg, release, venue, req, chain, { pick: () => 0 });
  assert.equal(b.instructions[2]!.data[1], 3);
  // the same build with another page named: the state tree's page after next
  const ixs = b.instructions.map((x, i) => (i === 2 ? { ...x, accounts: x.accounts.map((a, k) => (k === 9 ? { ...a, key: solanaPoolPage(PROGRAM, 0, 2048) } : a)) } : x));
  const { message } = kit.solanaCompileV0(FEE_PAYER, ixs, BLOCKHASH, [chain.table], [FEE_PAYER, W]);
  const wire = new Uint8Array(1 + 128 + message.length);
  wire[0] = 2;
  wire.set(message, 129);
  const v = checkSolanaPoolBuy(wire, cfg, release, venue, req, reads);
  assert.ok(!v.ok);
  assert.ok(v.results.some((r) => r.id === "RELEASE" && !r.ok), JSON.stringify(v.results));
});

function tableMeta(): number[] {
  const meta = new Uint8Array(56);
  const dv = new DataView(meta.buffer);
  dv.setUint32(0, 1, true);
  dv.setBigUint64(4, (1n << 64n) - 1n, true);
  return [...meta];
}
