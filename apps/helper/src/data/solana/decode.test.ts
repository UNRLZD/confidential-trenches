// Decoders on recorded mainnet transactions, one per venue and side (fixtures/sol-trades-txs.json, recorded 2026-11-03
// 21:2xZ on api.mainnet-beta.solana.com; each signature below is the transaction's own).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { decodeEvent, fromInner, fromLogs, poolMints, PUMP, PUMP_AMM, WSOL, type RawTrade } from "./decode.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const F = JSON.parse(readFileSync(path.join(HERE, "fixtures/sol-trades-txs.json"), "utf8")) as {
  txs: Record<string, { signature: string; result: { meta: { logMessages: string[] } } }>;
  pools: Record<string, { owner: string; data: string }>;
};
const logs = (k: string): string[] => F.txs[k]!.result.meta.logMessages;
const one = (k: string): RawTrade => {
  const f = fromLogs(logs(k));
  assert.equal(f.truncated, false);
  assert.equal(f.trades.length, 1);
  return f.trades[0]!;
};

test("pump.fun curve buy and sell (SOL quote): mint, side, token and SOL legs, user, time", () => {
  assert.equal(F.txs["pump-buy"]!.signature, "431J5L4cobB2ZEdV2YUmvJkP2c5kdkrWcThkzWZdAUwyDkJXTX4PrysSM2S2CBLxfAeojbkHbaEMoKYnAFv237tV");
  assert.deepEqual(one("pump-buy"), { venue: "pump", mint: "4Tdj8MDuQ7Nx1drP1fkf1H4FVvUDrgZ3kbgQpHWXpump", pool: null, side: "b", amt: 2156510335886n, quote: 98320987n, quoteMint: WSOL, user: "4ZvukwqXc2AFAHcuvW8VrKD9j3zGHuoqW4hvEQfANH2n", ts: 1793739241 });
  assert.equal(F.txs["pump-sell"]!.signature, "3aFhm2hUvcuGPMLBCNgrJkA1KumjecgBWVNDKV8T3QohjnByG2CUebEqT9mxp6NqMCeerpmSJ4Eo8HgeLumrMxPd");
  assert.deepEqual(one("pump-sell"), { venue: "pump", mint: "9o7WZC3tmcBn2o3Lo76B35uKTW164HoZzYgEteBNvTeU", pool: null, side: "s", amt: 20328535828539n, quote: 701758600n, quoteMint: WSOL, user: "4qivKqjeHZtM9SDpqJesZBo4TisbM1u9WqjdcHedUTfP", ts: 1793739241 });
});

test("pump.fun curve trades of a quote-coin launch name that quote and its amount (sol_amount is 0)", () => {
  assert.equal(F.txs["pump-buy-quotecoin"]!.signature, "56Wz8bPwbpibqmdJWStdFBfrrntbTAM5NmBuFXNgDBBMyNfHnPaZZGmJv9VEucZRA8g7PtTtjDTWdBbFMYRvq2ZU");
  const b = one("pump-buy-quotecoin");
  assert.deepEqual([b.side, b.amt, b.quote, b.quoteMint], ["b", 8807983864593n, 6658392n, "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu"]);
  const s = one("pump-sell-quotecoin");
  assert.deepEqual([s.side, s.amt, s.quote, s.quoteMint], ["s", 2157237492304n, 1924565n, "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu"]);
});

test("PumpSwap buy and sell: pool, side, base and quote legs, user; the pool account names its mints", () => {
  assert.equal(F.txs["pumpswap-buy"]!.signature, "5qaMzhT3NyDNP2nU9btxr9N49xcAFaXJQLqgTvTZztrg2JG4sna4AnzEnMBQk3yP1uwzAu1dWiisEntsVK4GwHP9");
  assert.deepEqual(one("pumpswap-buy"), { venue: "pumpswap", mint: null, pool: "MywAbX7A1q79NAaBdSqdsk2Ari1dCBgFmdCR6PFBp1j", side: "b", amt: 624594981815n, quote: 1081942713n, quoteMint: null, user: "GekkhQoYConyu9cVGFG3FwTM37Bkr86e1KPfqgDr7Td4", ts: 1793739241 });
  assert.equal(F.txs["pumpswap-sell"]!.signature, "2b5mq7hLJCWbVYGvpRMzEBe1if4kkVgHvxc4Py7C6qhaYvi33DgR4u4MiJyXRZHT1UgKDz2K9UYT1WzyvGq8RFey");
  assert.deepEqual(one("pumpswap-sell"), { venue: "pumpswap", mint: null, pool: "4TaXp3uBwguwPMjJ4CvwBR646ERwyzp6tuJcpSEm2xQt", side: "s", amt: 865108834792n, quote: 21288211106n, quoteMint: null, user: "FKwaXB38FhYvCZqaijYScCAgK8PYNv7VLSa23JmCSyAP", ts: 1793739241 });
  const p = F.pools["MywAbX7A1q79NAaBdSqdsk2Ari1dCBgFmdCR6PFBp1j"]!;
  assert.equal(p.owner, PUMP_AMM);
  assert.deepEqual(poolMints(Buffer.from(p.data, "base64")), { base: "7B85zY7xFXypiEZ2W4YsPQ8AP9V5TYV8Na9aoB16pump", quote: WSOL });
  assert.equal(poolMints(Buffer.alloc(300)), null);
});

test("the inner-instruction event CPI decodes to the same trades as the log, for every recorded transaction", () => {
  for (const k of Object.keys(F.txs)) assert.deepEqual(fromInner(F.txs[k]!.result), fromLogs(logs(k)).trades, k);
});

test("an event line counts only while its own program is running: the same bytes logged by another program are ignored", () => {
  const line = logs("pump-buy").find((l) => l.startsWith("Program data: vdt/"))!;
  const fake = ["Program FakeProgram1111111111111111111111111111 invoke [1]", line, "Program FakeProgram1111111111111111111111111111 success"];
  assert.deepEqual(fromLogs(fake), { trades: [], truncated: false });
  // a pump event under PumpSwap, and the reverse, are not trades either
  const bytes = Buffer.from(line.slice("Program data: ".length), "base64");
  assert.equal(decodeEvent(PUMP_AMM, bytes), null);
  assert.notEqual(decodeEvent(PUMP, bytes), null);
});

test("a cut log, a broken invoke stack and hostile lines are reported, never decoded into trades", () => {
  assert.equal(fromLogs([...logs("pump-buy").slice(0, 10), "Log truncated"]).truncated, true);
  assert.deepEqual(fromLogs(["Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [2]"]), { trades: [], truncated: true });
  assert.equal(fromLogs("not a list").truncated, true);
  assert.equal(fromLogs([42]).truncated, true);
  assert.equal(fromLogs(new Array(2_001).fill("Program log: x")).truncated, true);
  // a short or zero-amount event body
  assert.equal(decodeEvent(PUMP, Buffer.from("bddb7fd34ee661ee00", "hex")), null);
  const zero = Buffer.from(logs("pump-buy").find((l) => l.startsWith("Program data: vdt/"))!.slice(14), "base64");
  zero.fill(0, 8 + 40, 8 + 48); // token_amount 0
  assert.equal(decodeEvent(PUMP, zero), null);
});
