// node --test scripts/pool-table-devnet.test.mjs: the devnet table's slot comes from the creating RPC's own SlotHashes
// sysvar, and a simulation refused with "is not a recent slot" (the 7 Nov 23:31Z create: a load-balanced RPC's getSlot
// answered from a node ahead of the one that simulated) is built again from a new read, 3 tries in all.
import assert from "node:assert/strict";
import { test } from "node:test";
import { base64 } from "@scure/base";
import { CREATE_TRIES, SLOT_BACK, SLOT_HASHES, recentSlot, simulatedCreate } from "./pool-table-devnet.mjs";

/** SlotHashes bytes: a u64 count, then (u64 slot, 32-byte hash) newest first, from `newest` down. */
const sysvar = (newest, count) => {
  const d = new Uint8Array(8 + 40 * count);
  const dv = new DataView(d.buffer);
  dv.setBigUint64(0, BigInt(count), true);
  for (let i = 0; i < count; i++) dv.setBigUint64(8 + 40 * i, BigInt(newest - i), true);
  return d;
};
const REFUSED = (slot) => ({ err: { InstructionError: [0, "InvalidInstructionData"] }, logs: ["Program AddressLookupTab1e1111111111111111111111111 invoke [1]", `Program log: ${slot} is not a recent slot`, "Program AddressLookupTab1e1111111111111111111111111 failed: invalid instruction data"] });

/** An RPC whose sysvar's newest slot moves on 100 each read, and whose simulations answer `sims` in turn. */
function fakeRpc(sims, { count = 512, owner = "Sysvar1111111111111111111111111111111111111" } = {}) {
  const calls = [];
  let newest = 519_826_000;
  const rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === "getAccountInfo") {
      assert.equal(params[0], SLOT_HASHES);
      assert.equal(params[1].commitment, "confirmed");
      newest += 100;
      const { offset, length } = params[1].dataSlice;
      return { value: { owner, data: [base64.encode(sysvar(newest, count).subarray(offset, offset + length)), "base64"] } };
    }
    if (method === "getLatestBlockhash") return { value: { blockhash: `bh${calls.length}` } };
    if (method === "simulateTransaction") return { value: sims.shift() ?? { err: null, logs: [] } };
    throw new Error(`unexpected ${method}`);
  };
  return { rpc, calls };
}
const build = (slot, bh) => ({ tx: Uint8Array.of(1, 2, 3), table: `table@${slot}`, signature: `sig@${bh}` });

test("the slot is the creating RPC's SlotHashes entry SLOT_BACK back from its newest, read at confirmed; its oldest when it holds fewer", async () => {
  assert.equal(SLOT_BACK, 32);
  assert.equal(await recentSlot(fakeRpc([]).rpc), BigInt(519_826_100 - SLOT_BACK));
  assert.equal(await recentSlot(fakeRpc([], { count: 5 }).rpc), BigInt(519_826_100 - 4));
  await assert.rejects(recentSlot(fakeRpc([], { count: 0 }).rpc), /holds no slot/);
  await assert.rejects(recentSlot(fakeRpc([], { owner: "11111111111111111111111111111111" }).rpc), /no SlotHashes sysvar/);
});

test("a planted 'is not a recent slot' refusal: read again and built again from the new slot; it lands on the next try", async () => {
  const { rpc, calls } = fakeRpc([REFUSED(519_826_068)]);
  const made = await simulatedCreate(rpc, build);
  assert.equal(made.tries, 2);
  assert.equal(made.slot, BigInt(519_826_200 - SLOT_BACK));
  assert.equal(made.table, `table@${519_826_200 - SLOT_BACK}`);
  assert.deepEqual(calls.map((c) => c.method), ["getAccountInfo", "getLatestBlockhash", "simulateTransaction", "getAccountInfo", "getLatestBlockhash", "simulateTransaction"]);
  // every simulation at confirmed, the same node's commitment as the slot read
  for (const c of calls.filter((c) => c.method === "simulateTransaction")) assert.equal(c.params[1].commitment, "confirmed");
});

test("refused every try: it stops after CREATE_TRIES with the last refusal named; any other refusal stops at once", async () => {
  assert.equal(CREATE_TRIES, 3);
  const all = fakeRpc([REFUSED(1), REFUSED(2), REFUSED(3), REFUSED(4)]);
  await assert.rejects(simulatedCreate(all.rpc, build), /try 3 of 3.*is not a recent slot/);
  assert.equal(all.calls.filter((c) => c.method === "simulateTransaction").length, 3);
  const other = fakeRpc([{ err: { InstructionError: [1, { Custom: 1 }] }, logs: ["Program log: insufficient funds"] }]);
  await assert.rejects(simulatedCreate(other.rpc, build), /try 1 of 3/);
  assert.equal(other.calls.filter((c) => c.method === "simulateTransaction").length, 1);
});
