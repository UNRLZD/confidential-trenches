// SPDX-License-Identifier: Apache-2.0
// node --test contracts/pool-solana/scripts/venue-table.test.mjs (card sol-pool-venue-tables): the venue table script's
// list is the kit's own for the record's program and pool, and it is exactly what the pool buy builder loads from the
// table (every program-wide account of a buy loads from it, no account outside it does); every transaction it builds fits
// 1,232 bytes and together they extend exactly the list; a cluster RPC on another genesis, an unknown venue, and a
// venue the record already names are refused. Offline: the RPC answers are the LiteSVM run's recorded mainnet reads
// (packages/kit/test/fixtures/solana-pool-buy.json).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { compileMessage, priceIx, PRIORITY_MICRO_LAMPORTS, TX_MAX } from "./deploy.mjs";
import { CLUSTERS, needOf, plan, runLine, tableSteps } from "./venue-table.mjs";
import { b58decode, b58encode } from "../../../scripts/live-checks/pool-sol-deploy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "../../..");
const fx = JSON.parse(readFileSync(path.join(REPO, "packages/kit/test/fixtures/solana-pool-buy.json"), "utf8"));
const kit = await import(path.join(REPO, "packages/kit/src/index.ts"));
const MAINNET = JSON.parse(readFileSync(path.join(REPO, "contracts/pool-solana/deployments/mainnet.json"), "utf8"));
const FX = { "pump-curve": "pump", pumpswap: "pumpswap" };
const { release: fxRelease, FEE_PAYER, W, rent } = await import(path.join(REPO, "packages/kit/test/solana-pool-buy-fx.ts"));
const req = (kind) => ({ wallet: W, feePayer: FEE_PAYER, token: fx[FX[kind]].mint, spend: 5_000_000n, minOut: 1n, tip: 0n, cuPrice: 1n, cluster: "devnet" });

/** Each venue's global account as the recorded run read it: the third account of the buy's [mint, curve or pool, global]. */
function globalOf(kind, p) {
  const rec = fx[FX[kind]];
  const k = Object.keys(rec.reads[p]).find((x) => JSON.parse(x).length === 3);
  const ans = rec.reads[p][k];
  return { at: JSON.parse(k)[2], value: ans.value[2], context: ans.context };
}
/** A fetch that answers as cluster `genesis` would, from the recorded reads; `edit` changes an answer. */
const fakeFetch = (genesis, edit = (u, m, x) => x) => async (url, init) => {
  const { method, params } = JSON.parse(init.body);
  const p = CLUSTERS.mainnet.rpcs.indexOf(url) === 1 ? 1 : 0;
  let result;
  if (method === "getGenesisHash") result = genesis;
  else if (method === "getAccountInfo" && params[0] === fx.rent.account) result = { context: { slot: 1 }, value: { owner: fx.rent.answers[p].owner, data: [fx.rent.answers[p].data, "base64"], lamports: 1, executable: false } };
  else if (method === "getMultipleAccounts") {
    const g = ["pump-curve", "pumpswap"].map((k) => globalOf(k, p)).find((x) => x.at === params[0][0]);
    assert.ok(g && params[0].length === 1 && params[1].commitment === "finalized", `unexpected read ${JSON.stringify(params)}`);
    result = { context: g.context, value: [g.value] };
  } else throw new Error(`unexpected ${method}`);
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: edit(url, method, result) }), { status: 200, headers: { "content-type": "application/json" } });
};

test("the list is the kit's own for the mainnet record's program and pool, and exactly what the builder loads", async () => {
  for (const kind of ["pump-curve", "pumpswap"]) {
    const p = await plan("mainnet", kind, { fetchFn: fakeFetch(CLUSTERS.mainnet.genesis) });
    const cfg = { program: MAINNET.program_id, pool: MAINNET.pool };
    const g = globalOf(kind, 0);
    const want = kit.solanaPoolVenueTableList(cfg, kit.solanaPoolTableVenueOf(kind, { owner: g.value.owner, data: Buffer.from(g.value.data[0], "base64") }));
    assert.deepEqual(p.list, want, kind);
    if (kind === "pump-curve") assert.deepEqual(p.list, MAINNET.tables["pump-curve"].addresses, "the curve's list is the frozen mainnet table's");
    // the builder: a buy on the recorded venue with this table loads every one of its program-wide accounts from it
    const venue = await kit.readSolanaPoolBuyVenue([0, 1].map((i) => async (_m, params) => fx[FX[kind]].reads[i][JSON.stringify(params[0])]), kind, fx[FX[kind]].mint, () => 0);
    const meta = new Uint8Array(56);
    new DataView(meta.buffer).setUint32(0, 1, true);
    new DataView(meta.buffer).setBigUint64(4, (1n << 64n) - 1n, true);
    const table = kit.solanaDecodeLookupTable(Uint8Array.from([...meta, ...p.list.flatMap((a) => [...b58decode(a)])]));
    const instructions = kit.solanaPoolBuyInstructions(cfg, fxRelease, venue, req(kind), 6, rent, null, true);
    const used = new Set(instructions.flatMap((x) => [x.program, ...x.accounts.map((a) => a.key)]));
    const built = kit.solanaCompileV0(FEE_PAYER, instructions, "11111111111111111111111111111111", [{ address: b58encode(new Uint8Array(32).fill(9)), table }], [FEE_PAYER, W]);
    const m = kit.solanaDecodeMessage(built.message);
    const loaded = m.lookups.flatMap((l) => [...l.writable, ...l.readonly].map((i) => table.addresses[i]));
    for (const a of p.list) if (used.has(a)) assert.ok(loaded.includes(a), `${kind}: ${a} is used and in the table, so it loads from it`);
    for (const a of loaded) assert.ok(p.list.includes(a));
  }
});

test("each built transaction fits 1,232 B; the create comes first, the freeze last; the extends hold exactly the list", () => {
  const funder = b58encode(new Uint8Array(32).fill(3));
  const table = b58encode(new Uint8Array(32).fill(4));
  for (const n of [1, 25, 34, 60, 256])
    for (const price of [0n, PRIORITY_MICRO_LAMPORTS]) {
      const list = Array.from({ length: n }, (_, i) => b58encode(Uint8Array.from({ length: 32 }, (_, j) => (i * 7 + j + 1) & 0xff)));
      const steps = tableSteps(funder, table, 123n, 254, list, price);
      const got = [];
      steps.forEach((s, i) => {
        const m = compileMessage(funder, s.ixs, "11111111111111111111111111111111");
        assert.ok(1 + 64 * m.signers.length + m.bytes.length <= TX_MAX, `${n} ${price} step ${i}`);
        assert.equal(s.ixs[0].program === priceIx(1n).program, price > 0n, "a priced cluster's sends carry the price");
        for (const x of s.ixs.filter((x) => x.program === "AddressLookupTab1e1111111111111111111111111")) {
          const tag = x.data[0];
          if (tag === 0) assert.equal(i, 0, "create first");
          if (tag === 1) assert.equal(i, steps.length - 1, "freeze last");
          if (tag === 2) for (let o = 12; o < x.data.length; o += 32) got.push(b58encode(x.data.subarray(o, o + 32)));
        }
      });
      assert.deepEqual(got, list, `${n} ${price}`);
    }
});

test("the need: the table's rent, a fee per transaction and the sweep, and mainnet's priority bound", () => {
  const funder = b58encode(new Uint8Array(32).fill(3));
  const steps = tableSteps(funder, funder, 1n, 255, Array.from({ length: 34 }, (_, i) => b58encode(new Uint8Array(32).fill(i + 10))), PRIORITY_MICRO_LAMPORTS);
  assert.equal(steps.length, 3, "create and extend 28, extend 6, freeze");
  assert.deepEqual(needOf(6_461_760n, steps, PRIORITY_MICRO_LAMPORTS, 650_240n), { lookup_table: 6_461_760n, fees: 20_000n, priority: 80_000n, funder_floor: 650_240n, total: 7_212_000n });
  assert.equal(needOf(1n, steps, 0n, 0n).priority, 0n);
  // a resume: the rest of the list in extends only, then the freeze; nothing left to add: the freeze alone
  const rest = tableSteps(funder, funder, 1n, 255, Array.from({ length: 4 }, (_, i) => b58encode(new Uint8Array(32).fill(i + 10))), 0n, { create: false });
  assert.deepEqual(rest.map((s) => s.step), ["lookup table: extend with 4 addresses", "lookup table: freeze (authority none)"]);
  assert.ok(rest[0].ixs.every((x) => x.data[0] === 2));
  assert.deepEqual(tableSteps(funder, funder, 1n, 255, [], 0n, { create: false }).map((s) => s.step), ["lookup table: freeze (authority none)"]);
  assert.match(runLine("mainnet", "pumpswap"), /^node contracts\/pool-solana\/scripts\/venue-table\.mjs --cluster mainnet --venue pumpswap --return </);
});

test("refused: an RPC on another genesis, an unknown venue or cluster, a record of another cluster", async () => {
  await assert.rejects(plan("mainnet", "pumpswap", { fetchFn: fakeFetch(CLUSTERS.devnet.genesis) }), /not mainnet's/);
  await assert.rejects(plan("mainnet", "raydium", { fetchFn: fakeFetch(CLUSTERS.mainnet.genesis) }), /--venue must be/);
  await assert.rejects(plan("testnet", "pumpswap", { fetchFn: fakeFetch(CLUSTERS.mainnet.genesis) }), /--cluster must be/);
  const dir = mkdtempSync(path.join(tmpdir(), "venue-table-"));
  writeFileSync(path.join(dir, "mainnet.json"), JSON.stringify({ ...MAINNET, cluster: "devnet" }));
  await assert.rejects(plan("mainnet", "pumpswap", { fetchFn: fakeFetch(CLUSTERS.mainnet.genesis), dir }), /devnet's record/);
  // the two providers disagree on the venue's global account
  const flip = (u, m, r) => (m === "getMultipleAccounts" && u === CLUSTERS.mainnet.rpcs[1] ? { ...r, value: [{ ...r.value[0], data: [Buffer.from(Buffer.from(r.value[0].data[0], "base64").map((b, i) => (i === 900 ? b ^ 1 : b))).toString("base64"), "base64"] }] } : r);
  await assert.rejects(plan("mainnet", "pumpswap", { fetchFn: fakeFetch(CLUSTERS.mainnet.genesis, flip) }), /disagree/);
});

test("regression (devnet 9 Nov 23:12Z): the need keeps the funder's rent floor; the create's slot is SLOT_BACK back in the sending node's SlotHashes", async () => {
  const funder = b58encode(new Uint8Array(32).fill(3));
  const steps = tableSteps(funder, funder, 1n, 255, Array.from({ length: 34 }, (_, i) => b58encode(new Uint8Array(32).fill(i + 10))), 0n);
  // the run's funder must hold the rent, the fees and rent(0) until the sweep: without the floor the second extend was refused
  assert.equal(needOf(6_461_760n, steps, 0n, 650_240n).total, 6_461_760n + 20_000n + 650_240n);
  const { recentSlot, SLOT_BACK, SLOT_HASHES } = await import("./venue-table.mjs");
  const d = Buffer.alloc(8 + 40 * 40);
  d.writeBigUInt64LE(512n, 0);
  for (let i = 0; i < 40; i++) d.writeBigUInt64LE(1000n - BigInt(i), 8 + 40 * i);
  const call = async (m, params) => {
    assert.equal(m, "getAccountInfo");
    assert.equal(params[0], SLOT_HASHES);
    return { value: { owner: "Sysvar1111111111111111111111111111111111111", data: [d.subarray(0, 8 + 40 * (SLOT_BACK + 1)).toString("base64"), "base64"] } };
  };
  assert.equal(await recentSlot(call), 1000n - BigInt(SLOT_BACK));
});
