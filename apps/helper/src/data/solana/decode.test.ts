// Decoders on recorded mainnet transactions, one per venue and side (fixtures/sol-trades-txs.json, recorded 2026-11-03
// 21:2xZ on api.mainnet-beta.solana.com; each signature below is the transaction's own).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { b58encode } from "./lists.ts";
import { b58data, cutTrades, dbcPair, decodeEvent, eventsInInner, fromInner, fromLogs, METEORA_DAMM2, METEORA_DBC, METEORA_DLMM, ORCA, poolMints, poolPair, PUMP, PUMP_AMM, RAY_CLMM, RAY_CPMM, RAY_LAUNCHLAB, USDC, WSOL, type RawTrade } from "./decode.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const F = JSON.parse(readFileSync(path.join(HERE, "fixtures/sol-trades-txs.json"), "utf8")) as {
  txs: Record<string, { signature: string; result: { meta: { logMessages: string[] } } }>;
  pools: Record<string, { owner: string; data: string }>;
};
const logs = (k: string): string[] => F.txs[k]!.result.meta.logMessages;
/** The pump.fun and PumpSwap trades of a recorded transaction (a route may also cross a pool venue: Orca, below). */
const pumps = (t: RawTrade[]): RawTrade[] => t.filter((x) => x.venue === "pump" || x.venue === "pumpswap");
const one = (k: string): RawTrade => {
  const f = fromLogs(logs(k));
  assert.equal(f.truncated, false);
  assert.equal(pumps(f.trades).length, 1);
  return pumps(f.trades)[0]!;
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
  for (const k of Object.keys(F.txs)) assert.deepEqual(fromInner(F.txs[k]!.result), pumps(fromLogs(logs(k)).trades), k);
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

// Venues past pump.fun (card helper-listed-charts-own-reads), recorded 2026-11-15 23:2xZ (fixtures/sol-venue-txs.json):
// the newest successful transactions of coins on the helper's lists, each event checked against the pool's own token
// balance changes in the same transaction.
const V = JSON.parse(readFileSync(path.join(HERE, "fixtures/sol-venue-txs.json"), "utf8")) as typeof F;
const vlogs = (k: string): string[] => V.txs[k]!.result.meta.logMessages;
const pool = (a: string) => ({ owner: V.pools[a]!.owner, data: Buffer.from(V.pools[a]!.data, "base64") });

test("Orca Whirlpool: a `Traded` event is a trade told as the pool's mint A sees it, the pool naming A and B", () => {
  assert.equal(V.txs["orca-buy"]!.signature, "5eGN7iUzj3BTnmd97GNd6noiXqzvQJKmk2yqFvx9r8HD9oPUnTQN2rrxEQjmJpHx6XESNcz1v4i5GM7bFq5FKPbH");
  const f = fromLogs(vlogs("orca-buy"));
  assert.equal(f.truncated, false);
  // b to a: the pool paid 25,103 of mint A (SKHY) and took 2,008,725 of mint B (its balances in the same transaction)
  assert.deepEqual(f.trades, [{ venue: "orca", mint: null, pool: "EBJyPRtXTiUtjKZ5JDNLPmdjTyat48jEpmSD5VDLrHyq", side: "b", amt: 25103n, quote: 2008725n, quoteMint: null, user: "", ts: 0 }]);
  const p = pool("EBJyPRtXTiUtjKZ5JDNLPmdjTyat48jEpmSD5VDLrHyq");
  assert.equal(p.owner, ORCA);
  assert.deepEqual(poolPair("orca", p.owner, p.data), { a: "SKHYhSjuRWHgikq8eRKbtBbpABgJSkd7ytQV14i9EQ3", b: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh" });
  // the pool taken only from its own program and with its own discriminator
  assert.equal(poolPair("orca", RAY_CLMM, p.data), null);
  assert.equal(poolPair("raydium-clmm", ORCA, p.data), null);
  assert.equal(poolPair("orca", ORCA, Buffer.alloc(653)), null);
});

test("Orca Whirlpool: a log the runtime cut keeps the trades it logged before the cut (an event Orca logs, never sends to itself)", () => {
  const f = fromLogs(vlogs("orca-cut"));
  assert.equal(f.truncated, true);
  const cut = cutTrades(f, V.txs["orca-cut"]!.result).filter((t) => t.venue === "orca");
  // the pool JUP/USDC paid 242,083 JUP for 63,886 USDC (the route's Meteora DLMM hop, read from the inner instructions:
  // card index-sol-trades-2, below)
  assert.deepEqual(cut, [{ venue: "orca", mint: null, pool: "4Ui9QdDNuUaAGqCPcDSp191QrixLzQiLxJ1Gnqvz3szP", side: "b", amt: 242083n, quote: 63886n, quoteMint: null, user: "", ts: 0 }]);
  assert.deepEqual(poolPair("orca", ORCA, pool("4Ui9QdDNuUaAGqCPcDSp191QrixLzQiLxJ1Gnqvz3szP").data), { a: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", b: USDC });
  // a pump event CPI in the inner instructions still comes from them: the recorded pump transactions, cut, read the same
  for (const k of Object.keys(F.txs)) assert.deepEqual(cutTrades({ trades: [] }, F.txs[k]!.result), pumps(fromLogs(logs(k)).trades), k);
  // a recorded PumpSwap route also crosses an Orca pool, whose event is in the log only
  assert.deepEqual(fromLogs(logs("pumpswap-sell")).trades.map((t) => t.venue), ["pumpswap", "orca"]);
});

test("Raydium CLMM: a `SwapEvent` is a trade told as the pool's token 0 sees it, its sender the trader; the pool names token 0 and 1", () => {
  assert.equal(V.txs["clmm-buy"]!.signature, "mLRvbN2p3pp4ygRfziJSxbvzJiyqZbwCWxpFV21g5vLS7U2Nd8o9cSbNbUN2gtrMAVvtUwkpNEJAQcf5ynWgRGv");
  // zero for one: the trader paid 2,082,875,407 lamports of token 0 (SOL) for 19,699,205 of token 1 (SPYx)
  assert.deepEqual(fromLogs(vlogs("clmm-buy")), { trades: [{ venue: "raydium-clmm", mint: null, pool: "BS9uyGV6XmNnPkM4f3xgxCdQEaFv7RSKs6fwrpvYHxfL", side: "s", amt: 2082875407n, quote: 19699205n, quoteMint: null, user: "4GQeEya6ZTwvXre4Br6ZfDyfe2WQMkcDz2QbkJZazVqS", ts: 0 }], truncated: false });
  const p = pool("BS9uyGV6XmNnPkM4f3xgxCdQEaFv7RSKs6fwrpvYHxfL");
  assert.equal(p.owner, RAY_CLMM);
  assert.deepEqual(poolPair("raydium-clmm", p.owner, p.data), { a: WSOL, b: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W" });
  // a route through two pools: SOL into CLMM SOL/Xs3eBt, then Xs3eBt into an Orca pool for AMZN
  assert.deepEqual(fromLogs(vlogs("clmm-sol-in")).trades.map((t) => [t.venue, t.pool, t.side, t.amt, t.quote]), [["raydium-clmm", "HWZk6MfN28mYqDN1igNETjN2kueEryL33oVgt92Wkv6N", "s", 10000000n, 268947n], ["orca", "Af6Rt3zE8ZCFPtSQEePvAHfqpdqzsYA6H3bzY7P3tgCt", "s", 268947n, 2688n]]);
  assert.deepEqual(poolPair("raydium-clmm", RAY_CLMM, pool("HWZk6MfN28mYqDN1igNETjN2kueEryL33oVgt92Wkv6N").data), { a: WSOL, b: "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg" });
  // the same event bytes under another program are no trade
  const line = vlogs("clmm-buy").find((l) => l.startsWith("Program data: QMbN"))!;
  assert.equal(decodeEvent(ORCA, Buffer.from(line.slice(14), "base64")), null);
  assert.equal(decodeEvent(RAY_CLMM, Buffer.from(line.slice(14), "base64").subarray(0, 100)), null);
});

test("Raydium CPMM: a `SwapEvent` names its own input and output mints and the pool-side amounts (transfer fees apart)", () => {
  assert.equal(V.txs["cpmm-buy"]!.signature, "4oKbTj5LtH7wtKDM5euLG6EjrZ9SDKffro4WNHfWes65E6CBsxZ6r8Qv3dW5Mah9WpfjFfsNxSBnqZxhTnT29ATE");
  // told as the input mint sees it: the trader paid it (a sell of it). The pool took 186,367 of AoHVuF... (the trader
  // paid 192,131, the rest a token-2022 transfer fee) and paid 461,944 STONK
  const f = fromLogs(vlogs("cpmm-buy"));
  // the route's first hop is the CPMM pool, its second a Raydium CLMM pool (the STONK on into USDC)
  assert.deepEqual(f.trades.map((x) => x.venue), ["raydium-cpmm", "raydium-clmm"]);
  assert.deepEqual({ trades: f.trades.slice(0, 1), truncated: f.truncated }, { trades: [{ venue: "raydium-cpmm", mint: null, pool: "63QdCBr47JyM7jjtbYFY3iwdhmUQupe4v4uCEGbhAzvT", pair: { a: "AoHVuFNKTAEUc5aiC8HLWUWytNC3nkJ4jcnjyFQaiCJg", b: "6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx" }, side: "s", amt: 186367n, quote: 461944n, quoteMint: null, user: "", ts: 0 }], truncated: false });
  // the pool paid 3,264,281,114,937 FCAT, the trader got that less the 97,928,433,449 output transfer fee
  const t = fromLogs(vlogs("cpmm-buy-fee")).trades;
  assert.deepEqual(t.map((x) => [x.venue, x.pair, x.side, x.amt, x.quote]), [["raydium-cpmm", { a: "WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp", b: "2YPWT4QK1Why57mxBZGwBAFckBC4nLwEAL2t6CcCQtvw" }, "s", 114146586323n, 3264281114937n]]);
  // under another program, or cut short, no trade
  const line = vlogs("cpmm-buy").find((l) => l.startsWith("Program data: QMbN"))!;
  const bytes = Buffer.from(line.slice(14), "base64");
  assert.equal(decodeEvent(RAY_CLMM, bytes), null, "CLMM's SwapEvent shares the discriminator: CPMM's 162 bytes are short of CLMM's 197, no trade");
  assert.equal(decodeEvent(RAY_CPMM, bytes.subarray(0, 8 + 144)), null);
  // a cut log keeps CPMM's logged event as it does Orca's
  assert.deepEqual(cutTrades({ trades: fromLogs(vlogs("cpmm-buy")).trades }, { meta: {}, transaction: { message: { accountKeys: [] } } }), fromLogs(vlogs("cpmm-buy")).trades);
});

test("Raydium LaunchLab: a `TradeEvent` is a trade told as the pool's base mint sees it (amount_in what the trader paid, amount_out what it got); the pool names base and quote", () => {
  assert.equal(V.txs["launchlab-buy"]!.signature, "5GNEWxwwLV7mEJS9GZ2uuHKTmd2a4QM37EQiYzjS13hCmuKmTL8mETeDjxffkgdSarREpda8ubteaWuhLQYHb2TL");
  // a buy: the trader paid 6,000,000 lamports (5,700,000 to the vault, 300,000 platform fee) for 940,352,945,779 base
  assert.deepEqual(fromLogs(vlogs("launchlab-buy")), { trades: [{ venue: "raydium-launchlab", mint: null, pool: "8rHq4DwFfgUG4m4CK4ADQZsme1byBAwVV7Bbtb3BboUW", side: "b", amt: 940352945779n, quote: 6000000n, quoteMint: null, user: "", ts: 0 }], truncated: false });
  // a sell: the vault took 934,846,646,878 base, the trader got 4,457,627 lamports
  assert.deepEqual(fromLogs(vlogs("launchlab-sell")).trades.map((t) => [t.venue, t.side, t.amt, t.quote]), [["raydium-launchlab", "s", 934846646878n, 4457627n]]);
  const p = pool("8rHq4DwFfgUG4m4CK4ADQZsme1byBAwVV7Bbtb3BboUW");
  assert.equal(p.owner, RAY_LAUNCHLAB);
  assert.deepEqual(poolPair("raydium-launchlab", p.owner, p.data), { a: "EREcNf2Uz8E3VHxqeM5jnaCtiqbgWfWYHXXZLvjTCFQt", b: WSOL });
  // CLMM's and CPMM's pools share LaunchLab's account discriminator: the owner tells them apart
  assert.equal(poolPair("raydium-launchlab", RAY_CLMM, p.data), null);
  assert.equal(poolPair("raydium-clmm", RAY_LAUNCHLAB, p.data), null);
  // LaunchLab also sends the event to itself: a cut log reads it from the inner instructions, once
  for (const k of ["launchlab-buy", "launchlab-sell"]) {
    assert.deepEqual(fromInner(V.txs[k]!.result), fromLogs(vlogs(k)).trades, k);
    assert.deepEqual(cutTrades({ trades: fromLogs(vlogs(k)).trades }, V.txs[k]!.result), fromLogs(vlogs(k)).trades, k);
  }
  // pump.fun's TradeEvent discriminator is LaunchLab's too: each program's bytes count only under that program
  const line = vlogs("launchlab-buy").find((l) => l.startsWith("Program data: vdt/"))!;
  const bytes = Buffer.from(line.slice(14), "base64");
  assert.equal(decodeEvent(PUMP, bytes), null);
  assert.equal(decodeEvent(RAY_LAUNCHLAB, bytes.subarray(0, 8 + 138)), null);
  const flipped = Buffer.from(bytes);
  flipped[8 + 136] = 2; // a trade direction past Buy and Sell
  assert.equal(decodeEvent(RAY_LAUNCHLAB, flipped), null);
});

// card sol-tape-trader-is-the-events-user: a venue program's own swap, made inside another decoded venue's instruction,
// is marked off the tape (tape false); a trader's route, whose venue swaps sit side by side under the trader's or a
// router's instruction, is never marked. The own swap copies the recorded pump-buy (router 6Vo3 at [1], the curve at
// [2], its TradeEvent at log line 31): a sell of the curve made by the curve inside the trader's buy, by its own account.
const OWN = new Uint8Array(32).fill(7);
const PUMP_KEY = 21; // the curve's place in pump-buy's account keys (its inner instructions' programIdIndex)
const ownEvent = (): Buffer => {
  const b = Buffer.from(logs("pump-buy")[31]!.slice("Program data: ".length), "base64");
  b.writeBigUInt64LE(b.readBigUInt64LE(8 + 32) / 10n, 8 + 32);
  b.writeBigUInt64LE(b.readBigUInt64LE(8 + 40) / 10n, 8 + 40);
  b[8 + 48] = 0;
  Buffer.from(OWN).copy(b, 8 + 49);
  return b;
};
const ownFrame = (depth: number): string[] => [
  `Program ${PUMP} invoke [${depth}]`,
  "Program log: Instruction: Sell",
  `Program data: ${ownEvent().toString("base64")}`,
  `Program ${PUMP} invoke [${depth + 1}]`,
  `Program ${PUMP} success`,
  `Program ${PUMP} success`,
];

test("card sol-tape-trader-is-the-events-user: an event logged inside another decoded venue's frame is that venue's own swap (off the tape); a route's swaps side by side are traders'", () => {
  const l = logs("pump-buy");
  const nested = fromLogs([...l.slice(0, 35), ...ownFrame(3), ...l.slice(35)]);
  assert.equal(nested.truncated, false);
  assert.deepEqual(nested.trades.map((t) => [t.side, t.tape]), [["b", undefined], ["s", false]]);
  // the same sell as its own instruction, after the router's: a trader's, on the tape
  const apart = fromLogs([...l.slice(0, 39), ...ownFrame(1), ...l.slice(39)]);
  assert.deepEqual(apart.trades.map((t) => [t.side, t.tape]), [["b", undefined], ["s", undefined]]);
  // under a router that is no decoded venue (Jupiter, GMGN's, 6Vo3): a trader's
  assert.deepEqual(fromLogs(l).trades.map((t) => t.tape), [undefined]);
  // every recorded mainnet transaction, routes through two venues included: none marked
  for (const k of Object.keys(F.txs)) for (const t of fromLogs(logs(k)).trades) assert.equal(t.tape, undefined, k);
});

test("card sol-tape-trader-is-the-events-user: a cut log's inner instructions mark the event CPI of a swap made inside a decoded venue's instruction, by stackHeight; heights that build no stack mark none", () => {
  const r = structuredClone(F.txs["pump-buy"]!.result) as unknown as { transaction: { message: Record<string, unknown> }; meta: { innerInstructions: { index: number; instructions: Record<string, unknown>[] }[] } };
  const cpi = (b: Buffer) => b58encode(Uint8Array.from([...Buffer.from("e445a52e51cb9a1d", "hex"), ...b]));
  const group = r.meta.innerInstructions[0]!;
  assert.equal(group.instructions[0]!.programIdIndex, PUMP_KEY);
  // the curve (height 2, under the router's top-level instruction) sells by itself (3) and sends its event to itself (4)
  group.instructions.push({ programIdIndex: PUMP_KEY, accounts: [], data: "3c5s1W8njd38", stackHeight: 3 }, { programIdIndex: PUMP_KEY, accounts: [], data: cpi(ownEvent()), stackHeight: 4 });
  assert.deepEqual(fromInner(r).map((t) => [t.side, t.tape]), [["b", undefined], ["s", false]]);
  // the curve at the top level (height 1): its own sell at 2, the event at 3
  const top = structuredClone(r);
  top.transaction.message.instructions = [{}, {}, {}, { programIdIndex: PUMP_KEY, accounts: [], data: "" }];
  top.meta.innerInstructions[0]!.instructions = [{ programIdIndex: PUMP_KEY, accounts: [], data: "3c5s1W8njd38", stackHeight: 2 }, { programIdIndex: PUMP_KEY, accounts: [], data: cpi(ownEvent()), stackHeight: 3 }];
  assert.deepEqual(fromInner(top).map((t) => [t.side, t.tape]), [["s", false]]);
  // the same sell at height 2 under a top-level instruction that is no venue: a trader's
  top.transaction.message.instructions = [{}, {}, {}, { programIdIndex: 0, accounts: [], data: "" }];
  assert.deepEqual(fromInner(top).map((t) => [t.side, t.tape]), [["s", undefined]]);
  // a height that builds no stack (missing, or past the frame under it): nothing marked, the trades still decoded
  const bad = structuredClone(r);
  delete bad.meta.innerInstructions[0]!.instructions[5]!.stackHeight;
  assert.deepEqual(fromInner(bad).map((t) => [t.side, t.tape]), [["b", undefined], ["s", undefined]]);
  const jump = structuredClone(r);
  jump.meta.innerInstructions[0]!.instructions.at(-2)!.stackHeight = 9;
  assert.deepEqual(fromInner(jump).map((t) => [t.side, t.tape]), [["b", undefined], ["s", undefined]]);
});

// card index-sol-trades-2: the Meteora venues (fixtures/sol-meteora-txs.json, recorded 2026-11-18 14:28Z on
// solana-rpc.publicnode.com and api.mainnet-beta.solana.com, each transaction equal on both). DLMM, DBC and DAMM v2 send
// their swap event to themselves only (Anchor's event CPI): the log holds no event of theirs, so the trades come from the
// inner instructions (`cutTrades`, read whenever `eventsInInner` says one of them ran). Each event's amounts are its
// pool's own token balance changes in the same transaction (checked below from the recorded balances).
const M = JSON.parse(readFileSync(path.join(HERE, "fixtures/sol-meteora-txs.json"), "utf8")) as typeof F;
const mlogs = (k: string): string[] => M.txs[k]!.result.meta.logMessages;
const mpool = (a: string) => ({ owner: M.pools[a]!.owner, data: Buffer.from(M.pools[a]!.data, "base64") });
const meteora = (k: string): RawTrade[] => cutTrades(fromLogs(mlogs(k)), M.txs[k]!.result).filter((t) => t.venue.startsWith("meteora"));
/** A transaction's token balance change of `owner` in `mint` (post less pre), from its recorded balances. */
const moved = (k: string, owner: string, mint: string): bigint => {
  const m = M.txs[k]!.result.meta as unknown as Record<string, { owner: string; mint: string; uiTokenAmount: { amount: string } }[]>;
  const sum = (l: string) => m[l]!.filter((b) => b.owner === owner && b.mint === mint).reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
  return sum("postTokenBalances") - sum("preTokenBalances");
};
const TTW = "TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo";

test("card index-sol-trades-2: every recorded Meteora transaction names a Meteora venue ran, and its log holds no Meteora event; a log with none of them reads no inner instructions", () => {
  for (const k of Object.keys(M.txs)) {
    assert.equal(eventsInInner(mlogs(k)), true, k);
    assert.deepEqual(fromLogs(mlogs(k)).trades.filter((t) => t.venue.startsWith("meteora")), [], k);
  }
  for (const k of Object.keys(F.txs)) assert.equal(eventsInInner(logs(k)), false, k);
  assert.equal(eventsInInner(vlogs("clmm-buy")), false);
  // the venue fixture's routes that cross DLMM (an Orca route cut short, a CPMM route) name it
  assert.equal(eventsInInner(vlogs("orca-cut")), true);
  assert.equal(eventsInInner(vlogs("cpmm-buy-fee")), true);
  assert.equal(eventsInInner("not a list"), false);
  assert.equal(eventsInInner([`Program log: Program ${METEORA_DLMM} invoke [1]`]), false);
});

test("card index-sol-trades-2: Meteora DLMM: a `Swap` event is a trade told as the pool's token X sees it, `from` the trader; the pool names X and Y", () => {
  assert.equal(M.txs["dlmm-buy"]!.signature, "4u4YWsk5kQ62jhhWudgRLm6yF6Por1DJBkQrjDA29HrtufJGtZMdMLR2aKvZwHE6Jr3BUUQUhpPMi2fD97HTBoNQ");
  // swap_for_y false: the pool took 800,000,000 lamports of Y (its fee inside) and paid 276,952 of X
  assert.deepEqual(meteora("dlmm-buy"), [{ venue: "meteora-dlmm", mint: null, pool: "E8NTyKJzdaTHSftbkEZPHQ1a32s58z2bR5jZ7WxAFnWN", side: "b", amt: 276952n, quote: 800000000n, quoteMint: null, user: "GPCp5rTs2j6PQG51cUBRejspiQW3VMY1T4BUDY9vZBPY", ts: 0 }]);
  assert.equal(moved("dlmm-buy", "E8NTyKJzdaTHSftbkEZPHQ1a32s58z2bR5jZ7WxAFnWN", TTW), -276952n);
  assert.equal(moved("dlmm-buy", "E8NTyKJzdaTHSftbkEZPHQ1a32s58z2bR5jZ7WxAFnWN", WSOL), 800000000n);
  // the same route then sells the TTW into PumpSwap: its event once, from the inner instructions, beside DLMM's
  assert.deepEqual(cutTrades(fromLogs(mlogs("dlmm-buy")), M.txs["dlmm-buy"]!.result).map((t) => t.venue), ["meteora-dlmm", "pumpswap"]);
  // swap_for_y true: the pool took 156,051 of X and paid 452,058,240 lamports
  assert.deepEqual(meteora("dlmm-sell").map((t) => [t.pool, t.side, t.amt, t.quote, t.user]), [["E8NTyKJzdaTHSftbkEZPHQ1a32s58z2bR5jZ7WxAFnWN", "s", 156051n, 452058240n, "62e471ndp1F71EsqQjb3HWxAMDgZZTMBBWnFHLVvECnC"]]);
  assert.equal(moved("dlmm-sell", "E8NTyKJzdaTHSftbkEZPHQ1a32s58z2bR5jZ7WxAFnWN", TTW), 156051n);
  assert.equal(moved("dlmm-sell", "E8NTyKJzdaTHSftbkEZPHQ1a32s58z2bR5jZ7WxAFnWN", WSOL), -452058240n);
  const p = mpool("E8NTyKJzdaTHSftbkEZPHQ1a32s58z2bR5jZ7WxAFnWN");
  assert.equal(p.owner, METEORA_DLMM);
  assert.deepEqual(poolPair("meteora-dlmm", p.owner, p.data), { a: TTW, b: WSOL });
  assert.equal(poolPair("meteora-dlmm", ORCA, p.data), null);
  assert.equal(poolPair("meteora-dlmm", METEORA_DLMM, Buffer.alloc(904)), null);
  // the venue fixture's routes through DLMM read their DLMM swap too: the Orca route cut short, the CPMM route whole
  // (their router logs each hop: "MeteoraDlmmSwap2 amount_in: 48416 ... amount_out: 178562", and "MeteoraDlmmDynamic
  // ... amount_in: 782848769, amount_out: 114146586323"; each is the pool's in and out)
  assert.deepEqual(cutTrades(fromLogs(vlogs("orca-cut")), V.txs["orca-cut"]!.result).map((t) => [t.venue, t.amt, t.quote]), [["meteora-dlmm", 178562n, 48416n], ["orca", 242083n, 63886n]]);
  assert.deepEqual(cutTrades(fromLogs(vlogs("cpmm-buy-fee")), V.txs["cpmm-buy-fee"]!.result).map((t) => [t.venue, t.amt, t.quote]), [["meteora-dlmm", 114146586323n, 782848769n], ["raydium-cpmm", 114146586323n, 3264281114937n]]);
});

test("card index-sol-trades-2: Meteora DBC: an `EvtSwap2` is a trade told as the pool's base mint sees it, at the event's clock; the pool names its base and its config the quote", () => {
  assert.equal(M.txs["dbc-buy"]!.signature, "34ThoAsik275GA82aN1cZ7bpQtXeVhrGZ4fd2TNK3afkYGc4cQS3hXSp7LxoTCiD73DsgpkjZY7ffpjphCSEmntQ");
  // QuoteToBase: the pool took 19,900,000 lamports (its fee inside) and paid 111,805,885,269,579 base
  assert.deepEqual(meteora("dbc-buy"), [{ venue: "meteora-dbc", mint: null, pool: "4H7ji7AWAkJP6NxnkhvLsE1PDqzYs4YsKFG6rp3xApfp", config: "Bg9svMVKRf4Ci94xV6BE76QJG1SsdwvhpZmAxhARfByq", side: "b", amt: 111805885269579n, quote: 19900000n, quoteMint: null, user: "", ts: 1795011862 }]);
  // DBC's pool signer PDA, the owner of every DBC pool's vaults
  const VAULTS = "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM";
  assert.equal(moved("dbc-buy", VAULTS, WSOL), 19900000n);
  assert.equal(moved("dbc-buy", VAULTS, "9HvcdB9SGRY1qCYFXhTtdgcF6C7SGR1PZH1KjzV8BAGS"), -111805885269579n);
  // BaseToQuote: the pool took 2,476,882,604,592,232 base and paid 248,063,617 lamports
  assert.deepEqual(meteora("dbc-sell").map((t) => [t.pool, t.side, t.amt, t.quote, t.ts]), [["8Tp5wm2uG2XQCnokawES2cL4QgCg8bWq992XepiQzhC5", "s", 2476882604592232n, 248063617n, 1795011812]]);
  assert.equal(moved("dbc-sell", VAULTS, WSOL), -248063617n);
  // each pool's mints: its base from the pool, its quote from its own config (SOL, USDC)
  const pair = (pool: string, config: string) => dbcPair(mpool(pool), mpool(config), config);
  assert.deepEqual(pair("4H7ji7AWAkJP6NxnkhvLsE1PDqzYs4YsKFG6rp3xApfp", "Bg9svMVKRf4Ci94xV6BE76QJG1SsdwvhpZmAxhARfByq"), { a: "9HvcdB9SGRY1qCYFXhTtdgcF6C7SGR1PZH1KjzV8BAGS", b: WSOL });
  assert.deepEqual(meteora("dbc-buy-usdc").map((t) => [t.side, t.amt, t.quote, t.config]), [["b", 140195474297n, 4846455n, "FbKf76ucsQssF7XZBuzScdJfugtsSKwZFYztKsMEhWZM"]]);
  assert.deepEqual(pair("2vHhAP3Z2uVHvjeSgDPrckXsmYByd7hGzVuK5UQ6ucMV", "FbKf76ucsQssF7XZBuzScdJfugtsSKwZFYztKsMEhWZM"), { a: "8HuYsEpBS2WZACBCbAKcoh8XmbNYYqRjoJrCqC3Cmoon", b: USDC });
  // a config the pool does not name, or either account owned by another program, gives no pair
  assert.equal(pair("2vHhAP3Z2uVHvjeSgDPrckXsmYByd7hGzVuK5UQ6ucMV", "Bg9svMVKRf4Ci94xV6BE76QJG1SsdwvhpZmAxhARfByq"), null);
  const pool = mpool("4H7ji7AWAkJP6NxnkhvLsE1PDqzYs4YsKFG6rp3xApfp");
  const cfg = mpool("Bg9svMVKRf4Ci94xV6BE76QJG1SsdwvhpZmAxhARfByq");
  assert.equal(dbcPair({ ...pool, owner: METEORA_DAMM2 }, cfg, "Bg9svMVKRf4Ci94xV6BE76QJG1SsdwvhpZmAxhARfByq"), null);
  assert.equal(dbcPair(pool, { ...cfg, owner: RAY_CLMM }, "Bg9svMVKRf4Ci94xV6BE76QJG1SsdwvhpZmAxhARfByq"), null);
  assert.equal(dbcPair(cfg, pool, "Bg9svMVKRf4Ci94xV6BE76QJG1SsdwvhpZmAxhARfByq"), null);
  assert.equal(poolPair("meteora-dbc", METEORA_DBC, pool.data), null, "a DBC pool needs its config: dbcPair");
});

test("card index-sol-trades-2: Meteora DAMM v2: an `EvtSwap2` is a trade told as the pool's token A sees it, at the event's clock; the pool names A and B", () => {
  assert.equal(M.txs["damm-buy"]!.signature, "48UrxbY9r7rmskyE9EF9NcEBLBENaUDA5eqvdxBifCStRP9RTkVi4YhyJtcPWr5mBiY6fkhNindCCym4Y1bNSvCR");
  // B to A: the pool took 1,372,417,910 lamports of B and paid 164,412,686,233 of A
  assert.deepEqual(meteora("damm-buy"), [{ venue: "meteora-damm2", mint: null, pool: "5DJKBkCNGSj1DryDHM5kdZBh1KysMH5jfMiVVy9dWtJb", side: "b", amt: 164412686233n, quote: 1372417910n, quoteMint: null, user: "", ts: 1795011890 }]);
  // DAMM v2's pool signer PDA, the owner of every DAMM v2 pool's vaults
  const VAULTS = "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC";
  assert.equal(moved("damm-buy", VAULTS, WSOL), 1372417910n);
  assert.deepEqual(poolPair("meteora-damm2", METEORA_DAMM2, mpool("5DJKBkCNGSj1DryDHM5kdZBh1KysMH5jfMiVVy9dWtJb").data), { a: "26Ekp9mYjJS3CjFMHKkuTS4uP75oysve4A4c8CPeayBG", b: WSOL });
  // B to A where A is SOL: told as SOL sees it (the reader turns it round for the token, B)
  assert.deepEqual(meteora("damm-sell").map((t) => [t.pool, t.side, t.amt, t.quote]), [["4Fk2beWHZ3DYn8cLkRs31dP6eTw7Vwpq7kNDSNvW8dWz", "b", 698738224n, 2340517796257n]]);
  assert.equal(moved("damm-sell", VAULTS, "467cTkm8GXBA96QDGG5Spm1WbpVHp2LnPA1VAcrMctem"), 2340517796257n);
  assert.deepEqual(poolPair("meteora-damm2", METEORA_DAMM2, mpool("4Fk2beWHZ3DYn8cLkRs31dP6eTw7Vwpq7kNDSNvW8dWz").data), { a: WSOL, b: "467cTkm8GXBA96QDGG5Spm1WbpVHp2LnPA1VAcrMctem" });
  // DAMM v2's pool shares PumpSwap's account discriminator ("account:Pool"): the owner tells them apart
  const d = mpool("5DJKBkCNGSj1DryDHM5kdZBh1KysMH5jfMiVVy9dWtJb").data;
  assert.equal(poolPair("meteora-damm2", PUMP_AMM, d), null);
  // DBC's and DAMM v2's EvtSwap2 share a discriminator: each program's bytes count only under that program and length
  const ev = (k: string, program: string): Buffer => {
    const r = M.txs[k]!.result as unknown as { meta: { innerInstructions: { instructions: { programIdIndex: number; data: string }[] }[]; loadedAddresses: { writable: string[]; readonly: string[] } }; transaction: { message: { accountKeys: string[] } } };
    const keys = [...r.transaction.message.accountKeys, ...r.meta.loadedAddresses.writable, ...r.meta.loadedAddresses.readonly];
    const ix = r.meta.innerInstructions.flatMap((g) => g.instructions).find((i) => keys[i.programIdIndex] === program && Buffer.from(b58data(i.data)!).subarray(8, 16).toString("hex") === "bd4233a826507599")!;
    return Buffer.from(b58data(ix.data)!).subarray(8);
  };
  const damm = ev("damm-buy", METEORA_DAMM2);
  const dbc = ev("dbc-buy", METEORA_DBC);
  assert.notEqual(decodeEvent(METEORA_DAMM2, damm), null);
  assert.equal(decodeEvent(METEORA_DAMM2, dbc), null, "DBC's 179 bytes are short of DAMM v2's 180");
  assert.equal(decodeEvent(METEORA_DAMM2, damm.subarray(0, 8 + 179)), null);
  assert.equal(decodeEvent(METEORA_DBC, dbc.subarray(0, 8 + 178)), null);
  assert.equal(decodeEvent(PUMP_AMM, damm), null);
  const bad = Buffer.from(damm);
  bad[8 + 32] = 2; // a trade direction past AtoB and BtoA
  assert.equal(decodeEvent(METEORA_DAMM2, bad), null);
  const zero = Buffer.from(damm);
  zero.fill(0, 8 + 76, 8 + 84); // output_amount 0
  assert.equal(decodeEvent(METEORA_DAMM2, zero), null);
  // a clock past a safe integer is no clock: the trade stays, dated by its block (ts 0)
  const late = Buffer.from(damm);
  late.writeBigUInt64LE(2n ** 63n, 8 + 156);
  assert.equal(decodeEvent(METEORA_DAMM2, late)?.ts, 0);
  assert.equal(decodeEvent(METEORA_DAMM2, damm)?.ts, 1795011890);
});

test("card index-sol-trades-2: a Meteora event CPI made by another program is no trade", () => {
  const r = structuredClone(M.txs["damm-buy"]!.result) as unknown as { meta: { innerInstructions: { instructions: { programIdIndex: number }[] }[] }; transaction: { message: { accountKeys: string[] } } };
  const keys = r.transaction.message.accountKeys;
  const at = keys.indexOf(METEORA_DAMM2);
  // the same bytes sent by the token program are not DAMM v2's event
  for (const g of r.meta.innerInstructions) for (const i of g.instructions) if (i.programIdIndex === at) i.programIdIndex = keys.indexOf("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  assert.deepEqual(fromInner(r), []);
});
