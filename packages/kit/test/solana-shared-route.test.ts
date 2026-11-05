/// <reference types="node" />
// T2.2's S1, S6 and S7 on Jupiter's shared_accounts_route_v2, the instruction /swap/v2/build answers for many multi-hop
// routes. Every case is a real build read through HELPER_HOST by scripts/live-checks/solana-jupiter-build.mjs --record
// on 2026-11-02 06:25-06:27Z (test/fixtures/solana-shared-routes.json): an SPL Token token (A7bd…XaS: a buy and two
// sells), and three Token-2022 tokens (8RNU…ZHQ: two buys; DEW9…WDP and 8RVB…GkS: three sells), each with the two public
// RPCs' reads of its mint and every table it uses; and two Token-2022 tokens read the same way through the helper on
// 2026-11-05 (BZFY…B96W at 00:35Z: two buys, two sells; 9cRC…pump at 00:40Z: a buy and a sell, the token helper live
// runs 41939321444 and 41942368434 were refused on), whose Token-2022 side goes through Jupiter's authority's ATA. The
// fixture's `mints` are real reads of a transfer-fee mint and a transfer-hook mint. A read whose second provider
// answered the same bytes is kept once ("=a"). Each build is assembled by the kit and checked on its wire bytes; each
// refusal changes one thing in a real build before the assembly, so the change is in the bytes the device would sign.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { base58 } from "@scure/base";
import { assembleSolanaSwap, parseSolanaJupiterBuild, type SolanaBuildRequest } from "../src/trade/solana/build.ts";
import { solanaAta, solanaDecodeLookupTable, solanaProgramAddress, type SolanaLookupTable } from "../src/checks/solana/message.ts";
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
type MintRead = { address: string; readAt: string; slots: [number, number]; read: [Acc, Acc | "=a"] };
const F = JSON.parse(readFileSync(new URL("./fixtures/solana-shared-routes.json", import.meta.url), "utf8")) as { runs: Run[]; mints: Record<"transferFee" | "transferHook", MintRead> };
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
type MintPair = [SolanaAccountRead | null, SolanaAccountRead | null];
// `mint`: the device's two reads of the token's mint, the recorded ones unless a case puts others in their place.
function check(c: Case, change: (swap: Swap, data: Buffer) => Buffer | void = () => {}, minOut = floorOf(c.json), mint: MintPair = pair(c.run, c.run.mint)): SolanaQuoteVerdict {
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
  return checkSolanaQuote(tx.wire, { ...req, spendable: req.amount, minOut, otherWallets: [] }, {
    tables: Object.fromEntries(build.tables.map((t) => [t, pair(c.run, t)])),
    mint,
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
  { what: "the program destination account changed", id: "S6", detail: /program destination account \w+ is (neither Jupiter's authority's account|not the wallet's own account of the Token-2022 mint)/, change: (s) => { s.accounts[4]!.pubkey = randomKey(); } },
  { what: "the program source account changed", id: "S6", detail: /program source account \w+ is (neither Jupiter's authority's account|not the wallet's own account of the Token-2022 mint)/, change: (s) => { s.accounts[3]!.pubkey = randomKey(); } },
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

// A Token-2022 side through Jupiter's authority's own ATA (card solana-shared-2022-side). The rule it replaces, every
// Token-2022 side through the wallet's own account, was disproved by real builds: helper live runs 41939321444 and
// 41942368434 (5 Nov 00:10Z and 00:37Z) were refused on 9cRC…pump's sells and buys, and the builds of BZFY…B96W (four,
// 00:35Z) and 9cRC…pump (two, 00:40Z) in the fixture take the authority's ATA on the Token-2022 side, buys and sells.
// The source side passes: the floor is checked on the output. The destination side passes only when the token's mint,
// read equal on both providers, has no transfer fee and no transfer hook; the fixture's mints are real reads of a
// TransferFeeConfig mint (HuAXPy…CUa7) and a TransferHook mint (7cDSVG…6NEj) on both public RPCs, 5 Nov 00:37Z. The
// recorded mints agree with the rule: the three 11-02 Token-2022 mints (8RNU, DEW9, 8RVB) carry a TransferFeeConfig and
// Jupiter built every one through the wallet's own account; BZFY and 9cRC carry none and it built them through its own.
const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const T22 = SOLANA_TOKEN_2022_PROGRAM;
const swapOf = (c: Case): Swap => c.json.swapInstruction as Swap;
const authorityOf = (c: Case): string => solanaProgramAddress([new TextEncoder().encode("authority"), Uint8Array.of(Buffer.from(swapOf(c).data, "base64")[8] as number)], JUP);
const t22At = (c: Case): number => (c.side === "buy" ? 4 : 3); // the program's account of the Token-2022 side
const authorityAta = (c: Case): string => solanaAta(authorityOf(c), c.run.mint, T22);
const viaAuthority = (c: Case) => (s: Swap): void => { s.accounts[t22At(c)]!.pubkey = authorityAta(c); };
const viaWallet = (c: Case) => (s: Swap): void => { s.accounts[t22At(c)]!.pubkey = solanaAta(c.run.wallet, c.run.mint, T22); };
const mintOf = (k: keyof typeof F.mints): MintPair => { const [a, b] = F.mints[k].read; return [read(a), read(b === "=a" ? a : b)]; };
const both = (m: SolanaAccountRead): MintPair => [m, { owner: m.owner, data: Uint8Array.from(m.data) }];
const changed = (m: SolanaAccountRead, f: (d: Uint8Array) => Uint8Array | void): SolanaAccountRead => { const d = Uint8Array.from(m.data); return { owner: m.owner, data: f(d) ?? d }; };
// The offset of extension `type`'s body in a Token-2022 mint.
const extAt = (d: Uint8Array, type: number): number => {
  for (let o = 166; o + 4 <= d.length; o += 4 + (d[o + 2]! | (d[o + 3]! << 8))) if ((d[o]! | (d[o + 1]! << 8)) === type) return o + 4;
  throw new Error(`no extension ${type}`);
};
const T22_CASES = CASES.filter((c) => c.tp === T22);
const REAL = T22_CASES.filter((c) => swapOf(c).accounts[t22At(c)]!.pubkey === authorityAta(c));
const BUYS = T22_CASES.filter((c) => c.side === "buy");
// The fee-free Token-2022 mint whose bytes the byte-level refusals change: BZFY's, as recorded (MetadataPointer, TokenMetadata).
const CLEAN = pair(F.runs.find((r) => r.mint.startsWith("BZFY"))!, F.runs.find((r) => r.mint.startsWith("BZFY"))!.mint)[0]!;
const hasFee = (c: Case): boolean => { try { extAt(pair(c.run, c.run.mint)[0]!.data, 1); return true; } catch { return false; } };
const SELLS = T22_CASES.filter((c) => c.side === "sell");
const s6 = (v: SolanaQuoteVerdict) => result(v, "S6");

test("S6 real: the 5 Nov builds take Jupiter's authority's ATA on the Token-2022 side and pass every frame check", () => {
  assert.deepEqual(REAL.map((c) => c.name), ["BZFY S-1 buy, maxAccounts=40", "BZFY S-1 buy, uncapped", "BZFY S-2 sell, maxAccounts=40", "BZFY S-2 sell, uncapped", "9cRC S-1 buy, uncapped", "9cRC S-2 sell, maxAccounts=40"]);
  for (const c of REAL) {
    assert.equal(swapOf(c).accounts[0]!.pubkey, authorityOf(c), c.name);
    assert.deepEqual(offFrame(check(c)), [], c.name);
  }
});

test("S6 source: every Token-2022 sell passes with its source through Jupiter's authority's ATA, whatever the mint's extensions", () => {
  assert.ok(SELLS.length >= 6);
  for (const c of SELLS) {
    for (const [what, mint] of [["the recorded mint", pair(c.run, c.run.mint)], ["a transfer-fee mint", mintOf("transferFee")], ["a transfer-hook mint", mintOf("transferHook")]] as const) {
      const got = s6(check(c, viaAuthority(c), undefined, mint));
      assert.equal(got.ok, true, `${c.name}, ${what}: ${got.detail}`);
    }
  }
});

test("S6 destination: every Token-2022 buy passes with its destination through Jupiter's authority's ATA when the mint has no transfer fee or hook", () => {
  assert.ok(BUYS.length >= 5);
  for (const c of BUYS) {
    const v = check(c, viaAuthority(c), undefined, both(CLEAN));
    assert.deepEqual(offFrame(v), [], c.name);
    // a Token-2022 mint without extensions: 82 bytes
    const bare = changed(CLEAN, (d) => d.subarray(0, 82));
    assert.equal(s6(check(c, viaAuthority(c), undefined, both(bare))).ok, true, `${c.name}, an 82-byte mint`);
    // the wallet's own destination takes any mint: the bound is on the authority's account only
    for (const k of ["transferFee", "transferHook"] as const) assert.equal(s6(check(c, viaWallet(c), undefined, mintOf(k))).ok, true, `${c.name}, the wallet's own account, ${k}`);
  }
});

test("S6 destination refused: the recorded transfer-fee mints' own buys (8RNU) through Jupiter's authority's ATA", () => {
  const fee = BUYS.filter(hasFee);
  assert.deepEqual(fee.map((c) => c.name), ["8RNU S-1 buy, maxAccounts=40", "8RNU S-1 buy, uncapped"]);
  for (const c of fee) {
    assert.deepEqual(offFrame(check(c)), [], `${c.name}: as Jupiter built it, through the wallet's own account`);
    assert.equal(s6(check(c, viaAuthority(c))).detail, `program destination account ${authorityAta(c)} is Jupiter's authority's account of the Token-2022 mint ${c.run.mint}: the mint charges a transfer fee (TransferFeeConfig)`, c.name);
  }
});

// Each refusal on a buy whose destination goes through Jupiter's authority's ATA: the mint reads in place of the
// recorded ones, and S6's words.
const DEST_REFUSALS: { what: string; detail: RegExp; mint: () => MintPair; s10?: boolean }[] = [
  { what: "a transfer-fee mint", detail: /: the mint charges a transfer fee \(TransferFeeConfig\)$/, mint: () => mintOf("transferFee"), s10: true },
  { what: "a transfer-hook mint", detail: /: the mint runs a transfer hook \(TransferHook\)$/, mint: () => mintOf("transferHook") },
  {
    what: "a transfer-hook mint whose hook authority is none (S10 lets it through)",
    detail: /: the mint runs a transfer hook \(TransferHook\)$/,
    mint: () => both(changed(mintOf("transferHook")[0]!, (d) => { d.fill(0, extAt(d, 14), extAt(d, 14) + 32); })),
    s10: true,
  },
  { what: "the providers disagree: B reads a transfer-fee mint", detail: /: the providers disagree on the mint$/, mint: () => [CLEAN, mintOf("transferFee")[0]] },
  { what: "the providers disagree on the owner", detail: /: the providers disagree on the mint$/, mint: () => [CLEAN, { owner: SOLANA_TOKEN_PROGRAM, data: CLEAN.data }] },
  { what: "the mint not read on provider B", detail: /: the mint is not read on both providers$/, mint: () => [CLEAN, null] },
  { what: "no mint account type", detail: /: the mint of \d+ bytes has no mint account type$/, mint: () => both(changed(CLEAN, (d) => { d[165] = 2; })) },
  { what: "an extension that runs past the mint", detail: /: the mint's extension \d+ runs past it$/, mint: () => both(changed(CLEAN, (d) => { d[168] = 0xff; d[169] = 0xff; })) },
  { what: "bytes after the last extension", detail: /: the mint has bytes after its last extension$/, mint: () => both(changed(CLEAN, (d) => Uint8Array.from([...d, 0, 0, 0, 0, 7]))) },
];
for (const r of DEST_REFUSALS) {
  test(`S6 destination refused: ${r.what}`, () => {
    for (const c of BUYS) {
      const v = check(c, viaAuthority(c), undefined, r.mint());
      const got = s6(v);
      assert.equal(got.ok, false, `${c.name}: S6 passed: ${got.detail}`);
      assert.match(got.detail, new RegExp(`^program destination account ${authorityAta(c)} is Jupiter's authority's account of the Token-2022 mint ${c.run.mint}: `), c.name);
      assert.match(got.detail, r.detail, c.name);
      if (r.s10) assert.equal(result(v, "S10").ok, true, `${c.name}: S10 refuses it too, so S6 is not the only guard here`);
    }
  });
}
