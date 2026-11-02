/// <reference types="node" />
// T2.2's S1, S6 and S7 on Jupiter's shared_accounts_route_v2, the instruction /swap/v2/build answers for many multi-hop
// routes. Every case is a real build read through HELPER_HOST by scripts/live-checks/solana-jupiter-build.mjs --record
// on 2026-11-02 06:25-06:27Z (test/fixtures/solana-shared-routes.json): an SPL Token token (A7bd…XaS: a buy and two
// sells), and three Token-2022 tokens (8RNU…ZHQ: two buys; DEW9…WDP and 8RVB…GkS: three sells), each with the two public
// RPCs' reads of its mint and every table it uses. A read whose second provider answered the same bytes is kept once
// ("=a"). Each build is assembled by the kit and checked on its wire bytes; each refusal changes one thing in a real
// build before the assembly, so the change is in the bytes the device would sign.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { base58 } from "@scure/base";
import { assembleSolanaSwap, parseSolanaJupiterBuild, type SolanaBuildRequest } from "../src/trade/solana/build.ts";
import { solanaDecodeLookupTable, type SolanaLookupTable } from "../src/checks/solana/message.ts";
import {
  SOLANA_TOKEN_2022_PROGRAM,
  SOLANA_TOKEN_PROGRAM,
  checkSolanaQuote,
  type SolanaAccountRead,
  type SolanaQuoteCheckId,
  type SolanaQuoteVerdict,
} from "../src/checks/solana/checks.ts";

type Acc = { owner: string; data: string } | null;
type Run = {
  readAt: string;
  mint: string;
  wallet: string;
  amounts: { buy: string; sell: string };
  blockhash: { blockhash: string; lastValidBlockHeight: number };
  shapes: { name: string; side: "buy" | "sell"; body: string }[];
  accounts: Record<string, [Acc, Acc | "=a"]>;
};
const F = JSON.parse(readFileSync(new URL("./fixtures/solana-shared-routes.json", import.meta.url), "utf8")) as { runs: Run[] };
const SHARED = "d19853937cfed8e9";
const FRAME: SolanaQuoteCheckId[] = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S13"];
const read = (a: Acc): SolanaAccountRead | null => (a ? { owner: a.owner, data: Uint8Array.from(Buffer.from(a.data, "base64")) } : null);
const pair = (r: Run, k: string): [SolanaAccountRead | null, SolanaAccountRead | null] => {
  const [a, b] = r.accounts[k] ?? [null, null];
  return [read(a), read(b === "=a" ? a : b)];
};
let seed = 0x5a7ed;
const randomKey = (): string => base58.encode(Uint8Array.from({ length: 32 }, () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed & 0xff)));

type Case = { run: Run; name: string; side: "buy" | "sell"; tp: string; json: Record<string, unknown> };
const CASES: Case[] = F.runs.flatMap((run) =>
  run.shapes.map((s) => ({ run, name: `${run.mint.slice(0, 4)} ${s.name}`, side: s.side, tp: run.accounts[run.mint]![0]!.owner, json: JSON.parse(s.body) as Record<string, unknown> })),
);
// The floor the build asks for, from its own JSON: what S7 must decode from the bytes.
const floorOf = (j: Record<string, unknown>): bigint => (BigInt(j.outAmount as string) * BigInt(10_000 - (j.slippageBps as number))) / 10_000n;

type Swap = { accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };
// Assemble the (possibly changed) build on the device's recorded blockhash and tables, then run every check.
function check(c: Case, change: (swap: Swap, data: Buffer) => Buffer | void = () => {}, minOut = floorOf(c.json)): SolanaQuoteVerdict {
  const j = structuredClone(c.json);
  const swap = j.swapInstruction as Swap;
  const data = Buffer.from(swap.data, "base64");
  swap.data = (change(swap, data) ?? data).toString("base64");
  const build = parseSolanaJupiterBuild(j);
  const req: SolanaBuildRequest = { side: c.side, wallet: c.run.wallet, token: c.run.mint, amount: BigInt(c.side === "buy" ? c.run.amounts.buy : c.run.amounts.sell), slippageBps: 1000 };
  const tables: Record<string, SolanaLookupTable> = {};
  for (const t of build.tables) {
    const a = pair(c.run, t)[0];
    if (a) tables[t] = solanaDecodeLookupTable(a.data);
  }
  const tx = assembleSolanaSwap(req, build, { blockhash: c.run.blockhash.blockhash, lastValidBlockHeight: c.run.blockhash.lastValidBlockHeight, tables, tokenProgram: c.tp });
  return checkSolanaQuote(tx.wire, { ...req, spendable: req.amount, minOut }, {
    tables: Object.fromEntries(build.tables.map((t) => [t, pair(c.run, t)])),
    mint: pair(c.run, c.run.mint),
    rent: { tokenAccount: [0n, 0n], pumpVolumeAccumulator: [0n, 0n] },
    simulations: [null, null],
    reference: null,
  });
}
const result = (v: SolanaQuoteVerdict, id: SolanaQuoteCheckId) => v.results.find((r) => r.id === id)!;
const offFrame = (v: SolanaQuoteVerdict) => v.results.filter((r) => FRAME.includes(r.id) && !r.ok).map((r) => `${r.id} ${r.detail}`);

test("the fixture: real shared_accounts_route_v2 builds, a buy and a sell under each token program", () => {
  assert.ok(CASES.length >= 5, `${CASES.length} builds`);
  for (const c of CASES) assert.equal(Buffer.from((c.json.swapInstruction as Swap).data, "base64").subarray(0, 8).toString("hex"), SHARED, c.name);
  for (const tp of [SOLANA_TOKEN_PROGRAM, SOLANA_TOKEN_2022_PROGRAM]) for (const side of ["buy", "sell"]) assert.ok(CASES.some((c) => c.tp === tp && c.side === side), `${tp} ${side}`);
});

test("every recorded shared-route build passes S1, S6, S7 and S10, with the frame checks, and decodes to what Jupiter answered", () => {
  for (const c of CASES) {
    const v = check(c);
    assert.deepEqual(offFrame(v), [], c.name);
    const j = c.json;
    assert.equal(result(v, "S1").detail, `shared_accounts_route_v2: ${c.side} ${j.inAmount} of ${j.inputMint} for ${j.outputMint}, authority the wallet`, c.name);
    assert.equal(result(v, "S7").detail, `floor ${floorOf(j)} (quoted ${j.outAmount} at ${j.slippageBps} bps) vs minOut ${floorOf(j)}`, c.name);
    const id = Buffer.from((j.swapInstruction as Swap).data, "base64")[8];
    assert.match(result(v, "S6").detail, new RegExp(` through Jupiter's authority ${id}$`), c.name);
  }
});

// One build of each kind: SPL Token buy and sell, Token-2022 buy and sell.
const PICK = [SOLANA_TOKEN_PROGRAM, SOLANA_TOKEN_2022_PROGRAM].flatMap((tp) => (["buy", "sell"] as const).map((side) => CASES.find((c) => c.tp === tp && c.side === side)!));
// Each refusal: one change in the signed instruction, the check that refuses it and its words. The unchanged build
// passes that check first, so a check that refuses every shared route fails here too.
const REFUSALS: { what: string; id: SolanaQuoteCheckId; detail: RegExp; change?: (s: Swap, d: Buffer) => Buffer | void; minOut?: (c: Case) => bigint }[] = [
  { what: "the destination changed", id: "S6", detail: /^destination \w+ is not the wallet's account/, change: (s) => { s.accounts[5]!.pubkey = randomKey(); } },
  { what: "the program destination account changed", id: "S6", detail: /program destination account \w+ is neither Jupiter's authority's account/, change: (s) => { s.accounts[4]!.pubkey = randomKey(); } },
  { what: "the program source account changed", id: "S6", detail: /program source account \w+ is neither Jupiter's authority's account/, change: (s) => { s.accounts[3]!.pubkey = randomKey(); } },
  { what: "the program authority changed", id: "S6", detail: /program authority \w+ is not Jupiter's authority/, change: (s) => { s.accounts[0]!.pubkey = randomKey(); } },
  { what: "the authority id changed", id: "S6", detail: /program authority \w+ is not Jupiter's authority/, change: (_, d) => { d[8] = ((d[8] as number) + 1) % 8; } },
  { what: "a lower floor than minOut", id: "S7", detail: /^floor \d+ \(quoted \d+ at 1000 bps\) vs minOut \d+$/, minOut: (c) => floorOf(c.json) + 1n },
  { what: "the quoted out lowered in the bytes", id: "S7", detail: /^floor \d+ \(quoted \d+ at 1000 bps\)/, change: (_, d) => { d.writeBigUInt64LE(d.readBigUInt64LE(17) / 2n, 17); } },
  { what: "the slippage widened in the bytes", id: "S7", detail: /^floor \d+ \(quoted \d+ at 1100 bps\)/, change: (_, d) => { d.writeUInt16LE(d.readUInt16LE(25) + 100, 25); } },
  { what: "a platform fee in the bytes", id: "S7", detail: /^platform fee 50 bps, positive slippage 0 bps$/, change: (_, d) => { d.writeUInt16LE(50, 27); } },
  { what: "the input mint changed", id: "S1", detail: /input mint \w+ != /, change: (s) => { s.accounts[6]!.pubkey = randomKey(); } },
  { what: "the output mint changed", id: "S1", detail: /output mint \w+ != /, change: (s) => { s.accounts[7]!.pubkey = randomKey(); } },
  { what: "the amount changed", id: "S1", detail: /in amount \d+ != \d+/, change: (_, d) => { d.writeBigUInt64LE(d.readBigUInt64LE(9) + 1n, 9); } },
  { what: "the taker changed", id: "S1", detail: /route authority \w+ is not the signing wallet/, change: (s) => { s.accounts[1] = { pubkey: randomKey(), isSigner: false, isWritable: false }; } },
  { what: "the source account changed", id: "S1", detail: /source account \w+ is not the wallet's own/, change: (s) => { s.accounts[2]!.pubkey = randomKey(); } },
  { what: "the instruction data truncated inside its arguments", id: "S1", detail: /^Jupiter instruction d19853937cfed8e9\w* is neither route_v2 nor shared_accounts_route_v2$/, change: (_, d) => d.subarray(0, 34) },
  { what: "the account list truncated", id: "S6", detail: /^shared_accounts_route_v2 with 11 accounts$/, change: (s) => { s.accounts.length = 11; } },
];

for (const c of PICK) {
  for (const r of REFUSALS) {
    test(`${c.tp === SOLANA_TOKEN_PROGRAM ? "SPL Token" : "Token-2022"} ${c.side} (${c.name}): ${r.what} is refused by ${r.id}`, () => {
      assert.equal(result(check(c), r.id).ok, true, `the unchanged build passes ${r.id}`);
      const v = check(c, r.change, r.minOut?.(c));
      assert.equal(v.ok, false);
      const got = result(v, r.id);
      assert.equal(got.ok, false, `${r.id} passed: ${got.detail}`);
      assert.match(got.detail, r.detail);
    });
  }
}
