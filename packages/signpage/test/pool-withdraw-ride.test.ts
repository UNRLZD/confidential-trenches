// Card every-lamport-can-move T3, the ride's release (src/pool-withdraw.ts runPoolRide): one spare piece of the pool's
// own notes, the least list size whose change moves and that fits, released to the sale's W (never the note's own W) by
// the withdraw's own part: the helper's bind names the sale's W as recipient, the fee the device's; no onward send is
// owed or sent; the note taken. With no note that gives such a piece, nothing is bound.
//   node --test test/pool-withdraw-ride.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { freshWallet } from "../../wallet/src/derive/keys.ts";
import { SOL_PIECES } from "../../wallet/src/pool/solana.ts";
import { runPoolRide } from "../src/pool-withdraw.ts";
import { FEE, SEED64, closers, world } from "./pool-withdraw-world.ts";

after(async () => {
  for (const c of closers.splice(0)) await c();
});

const sale = freshWallet(SEED64, "sol", 99n, 0);
sale.secretKey.fill(0);
const to = { address: sale.address, l: 99n, j: 0 };

test("a ride releases the least fitting piece of a spare note to the sale's W through the withdraw's part, with no onward send", async () => {
  const wd = await world([30_000_000n, 5_000_000n]);
  (wd.host.pool as { pieces?: unknown }).pieces = SOL_PIECES;
  const r = await runPoolRide(wd.host, to, (got) => got >= 3_000_000n);
  assert.deepEqual(r.state === "landed" ? [r.state, r.got] : r, ["landed", 5_000_000n - FEE]);
  assert.deepEqual(wd.binds.map((b) => [b.recipient, b.chunk, b.relayFee, b.tipCap]), [[sale.address, 5_000_000n, FEE, 0n]]);
  assert.equal(wd.onwards().length, 0, "no onward send");
  assert.equal(wd.owed.length, 0, "no onward owed");
  assert.equal(wd.balance.get(sale.address), 5_000_000n - FEE, "the sale's W got the piece less the relay fee");
  // the release took the note (RESERVED by it; the state reads' settle writes it SPENT, as a withdraw part's)
  assert.equal((await wd.ns.get(wd.ids[1]!))?.state, "RESERVED");
  assert.equal((await wd.ns.get(wd.ids[0]!))?.state, "UNSPENT", "the other note untouched");
});

test("a ride with no note that gives a fitting piece binds nothing", async () => {
  const wd = await world([7_500_000n]);
  (wd.host.pool as { pieces?: unknown }).pieces = SOL_PIECES;
  assert.deepEqual(await runPoolRide(wd.host, to, () => true), { state: "none" });
  assert.equal(wd.binds.length, 0);
});
