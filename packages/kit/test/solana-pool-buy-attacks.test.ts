// Card sol-pool-buy-tx: the review's attacks on checkSolanaPoolBuy (A1 to A9, A7b), ported to tag 3, plus the
// attacks tag 3 opens (an inner instruction changed, added, reordered or pointed at the fee payer). Each builds a
// message a broken-in helper could hand the device and asserts the check refuses it, naming the check that must fail.
//   node --test test/solana-pool-buy-attacks.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { base58 } from "@scure/base";
import {
  SOLANA_JITO_TIP_ACCOUNTS,
  SOLANA_PUMP_PROGRAM,
  buildSolanaPoolBuy,
  checkSolanaPoolBuy,
  readSolanaPoolBuyVenue,
  solanaCompileV0,
  solanaCompressPoolProof,
  solanaDecodeMessage,
  solanaEncodePoolTag3,
  solanaPoolBuyInstructions,
  solanaPoolBuySteps,
  solanaPoolReleaseAccounts,
  type SolanaApiAccount,
  type SolanaApiInstruction,
} from "../src/index.ts";
import { ALT, BLOCKHASH, FEE_PAYER, SPEND, TIP, W, cfg, fx, providers, release, rent, setup, wireOf } from "./solana-pool-buy-fx.ts";

const SYS = "11111111111111111111111111111111";
const ATTACKER = base58.encode(new Uint8Array(32).fill(0x42));
const JITO = SOLANA_JITO_TIP_ACCOUNTS[0]!;
const failed = (v: ReturnType<typeof checkSolanaPoolBuy>) => v.results.filter((x) => !x.ok).map((x) => x.id);
const transfer = (from: string, to: string, lamports: bigint): SolanaApiInstruction => ({
  program: SYS, accounts: [{ key: from, signer: true, writable: true }, { key: to, signer: false, writable: true }],
  data: Uint8Array.from([2, 0, 0, 0, ...Array.from({ length: 8 }, (_, i) => Number((lamports >> BigInt(8 * i)) & 0xffn))]),
});
type S = Awaited<ReturnType<typeof setup>>;
const compile = (s: S, ixs: SolanaApiInstruction[], payer = FEE_PAYER, signers = [FEE_PAYER, W]) => wireOf(solanaCompileV0(payer, ixs, BLOCKHASH, [s.chain.table], signers).message);
const check = (s: S, wire: Uint8Array) => checkSolanaPoolBuy(wire, cfg, release, s.venue, s.req, s.reads);
/** Tag 3 as the builder lays it out, over any inner steps and tip account a helper might choose. */
function tag3(s: S, steps: SolanaApiInstruction[], tipAccount: string | null, outerExtra: SolanaApiAccount[] = []): SolanaApiInstruction {
  const outer: SolanaApiAccount[] = [...solanaPoolReleaseAccounts(cfg, W, FEE_PAYER, release, 6), ...(tipAccount ? [{ key: tipAccount, signer: false, writable: true }] : [])];
  const indexOf = (a: SolanaApiAccount): number => {
    let i = outer.findIndex((o) => o.key === a.key);
    if (i < 0) i = outer.push({ ...a }) - 1;
    else outer[i] = { key: a.key, signer: outer[i]!.signer || a.signer, writable: outer[i]!.writable || a.writable };
    return i;
  };
  const inner = steps.map((x) => ({ program: indexOf({ key: x.program, signer: false, writable: false }), accounts: x.accounts.map(indexOf), data: x.data }));
  outer.push(...outerExtra);
  return { program: cfg.program, accounts: outer, data: solanaEncodePoolTag3({ ...release, proof: solanaCompressPoolProof(release.proof) }, true, s.req.tip, inner) };
}
const frame = (s: S) => solanaPoolBuyInstructions(cfg, release, s.venue, s.req, 6, rent, JITO).slice(0, 2);
const steps = (s: S) => solanaPoolBuySteps(s.venue, W, s.req.spend, s.req.minOut);

test("the helper's tag 3 builder here is the kit's: the honest message passes", async () => {
  const s = await setup();
  const v = check(s, compile(s, [...frame(s), tag3(s, steps(s), JITO)]));
  assert.ok(v.ok, JSON.stringify(v.results));
});

test("A1: an instruction after tag 3 that moves W's remainder to the relayer is refused (FRAME)", async () => {
  const s = await setup();
  const v = check(s, compile(s, [...solanaPoolBuyInstructions(cfg, release, s.venue, s.req, 6, rent, JITO), transfer(W, FEE_PAYER, 5_000_000n)]));
  assert.ok(failed(v).includes("FRAME"));
});

test("A1, inside: an inner transfer of W's remainder to the relayer after the buy is refused (BUY)", async () => {
  const s = await setup();
  const v = check(s, compile(s, [...frame(s), tag3(s, [...steps(s), transfer(W, FEE_PAYER, 1_000_000n)], JITO)]));
  assert.ok(failed(v).includes("BUY"));
});

test("A2: the tip sent to the relayer, or to an attacker, instead of a Jito account is refused (RELEASE)", async () => {
  const s = await setup();
  for (const to of [FEE_PAYER, ATTACKER]) {
    const v = check(s, compile(s, [...frame(s), tag3(s, steps(s), to)]));
    assert.ok(!v.ok && failed(v).includes("RELEASE"), to);
  }
});

test("A3: W's token-account create swapped for a transfer to the relayer that still names the ATA program is refused (BUY)", async () => {
  const s = await setup();
  const st = steps(s);
  const t = transfer(W, FEE_PAYER, 4_000_000n);
  const bent = { ...t, accounts: [...t.accounts, ...st[0]!.accounts.slice(1).map((a) => ({ ...a, signer: false })), { key: st[0]!.program, signer: false, writable: false }] };
  const v = check(s, compile(s, [...frame(s), tag3(s, [bent, ...st.slice(1)], JITO)]));
  assert.ok(failed(v).includes("BUY"));
});

test("A4: pump's Global flipped to writable, every key and byte the same, is refused (BUY, PRIVILEGES)", async () => {
  const s = await setup();
  const st = steps(s);
  const buy = st[1]!;
  assert.equal(buy.program, SOLANA_PUMP_PROGRAM);
  const bent = { ...buy, accounts: buy.accounts.map((a, j) => (j === 0 ? { ...a, writable: true } : a)) };
  const v = check(s, compile(s, [...frame(s), tag3(s, [st[0]!, bent], JITO)]));
  assert.deepEqual(failed(v), ["BUY", "PRIVILEGES"]);
});

test("A5: provider B's table differs at a readonly index the message loads (pump Global) and is refused (TABLES)", async () => {
  const s = await setup();
  const built = buildSolanaPoolBuy(cfg, release, s.venue, s.req, s.chain, { pick: () => 0 });
  const global = steps(s)[1]!.accounts[0]!.key;
  const i = s.addresses.indexOf(global);
  assert.ok(i >= 0);
  const other = s.tableData.slice();
  other.set(base58.decode(ATTACKER), 56 + 32 * i);
  const v = checkSolanaPoolBuy(built.wire, cfg, release, s.venue, s.req, { ...s.reads, tables: { [s.tableAddr]: [{ owner: ALT, data: s.tableData }, { owner: ALT, data: other }] } });
  assert.deepEqual(failed(v), ["TABLES"]);
});

test("A6: a venue read for another token than the user's is refused", async () => {
  const s = await setup();
  const other = await readSolanaPoolBuyVenue(providers("pumpswap"), "pumpswap", fx.pumpswap.mint, () => 2);
  assert.throws(() => buildSolanaPoolBuy(cfg, release, other, s.req, s.chain), /not the token's/);
  const v = checkSolanaPoolBuy(buildSolanaPoolBuy(cfg, release, s.venue, s.req, s.chain).wire, cfg, release, other, s.req, s.reads);
  assert.ok(!v.ok);
});

test("A7: an extra key in tag 3's accounts that no inner instruction names is refused (BUY, PRIVILEGES)", async () => {
  const s = await setup();
  const v = check(s, compile(s, [...frame(s), tag3(s, steps(s), JITO, [{ key: ATTACKER, signer: false, writable: true }])]));
  assert.deepEqual(failed(v), ["BUY", "PRIVILEGES"]);
});

test("A7b: an unreferenced key loaded from the table (one more readonly index) is refused (PRIVILEGES)", async () => {
  const s = await setup();
  const built = buildSolanaPoolBuy(cfg, release, s.venue, s.req, s.chain, { pick: () => 0 });
  const m = built.message;
  // a table key the buy names nowhere (the table holds no tip account since M362 (4))
  const named = new Set(built.instructions.flatMap((i) => [i.program, ...i.accounts.map((a) => a.key)]));
  const idx = s.addresses.findIndex((k) => !named.has(k));
  assert.ok(idx >= 0);
  const dec = solanaDecodeMessage(m);
  assert.equal(dec.lookups.length, 1);
  const at = m.length - dec.lookups[0]!.readonly.length - 1;
  const nR = m[at]!;
  assert.ok(nR > 0 && nR < 127);
  const bent = Uint8Array.from([...m.subarray(0, at), nR + 1, ...m.subarray(at + 1), idx]);
  assert.deepEqual(failed(check(s, wireOf(bent))), ["PRIVILEGES"]);
});

test("A8: W put first (W pays the fee) is refused (SIGNERS)", async () => {
  const s = await setup();
  const v = check(s, compile(s, solanaPoolBuyInstructions(cfg, release, s.venue, s.req, 6, rent, JITO), W, [W, FEE_PAYER]));
  assert.ok(failed(v).includes("SIGNERS"));
});

test("A9: a CU price raised in the message is refused (FRAME)", async () => {
  const s = await setup();
  const ixs = solanaPoolBuyInstructions(cfg, release, s.venue, { ...s.req, cuPrice: 1_000_000n }, 6, rent, JITO);
  assert.deepEqual(failed(check(s, compile(s, ixs))), ["FRAME"]);
});

test("tag 3: an inner buy with a lower min out, the steps reordered, or one dropped is refused (BUY)", async () => {
  const s = await setup();
  const st = steps(s);
  const lower = solanaPoolBuySteps(s.venue, W, s.req.spend, s.req.minOut - 1n);
  for (const [what, inner] of [["min out", lower], ["reordered", [st[1]!, st[0]!]], ["dropped", [st[1]!]]] as const) {
    const v = check(s, compile(s, [...frame(s), tag3(s, [...inner], JITO)]));
    assert.ok(failed(v).includes("BUY"), what);
  }
});

test("tag 3: an inner instruction naming the fee payer, or the tip, the proof or the spend changed, is refused", async () => {
  const s = await setup();
  const st = steps(s);
  const payerIn = { ...st[0]!, accounts: st[0]!.accounts.map((a, j) => (j === 0 ? { key: FEE_PAYER, signer: true, writable: true } : a)) };
  assert.ok(failed(check(s, compile(s, [...frame(s), tag3(s, [payerIn, st[1]!], JITO)]))).includes("BUY"));
  // a tip of the cap, while the user asked for TIP
  const bigTip = tag3({ ...s, req: { ...s.req, tip: release.tipCap } }, st, JITO);
  assert.ok(failed(check(s, compile(s, [...frame(s), bigTip]))).includes("RELEASE"));
  // the raw proof in place of the compressed one: another flags byte and length
  const raw = tag3(s, st, JITO);
  const rawData = Uint8Array.from([3, 0, ...release.proof, ...raw.data.subarray(130)]);
  assert.ok(failed(check(s, compile(s, [...frame(s), { ...raw, data: rawData }]))).includes("RELEASE"));
  // the user's spend with a larger buy inside
  const more = solanaPoolBuySteps(s.venue, W, SPEND + 1_000_000n, s.req.minOut);
  assert.ok(failed(check(s, compile(s, [...frame(s), tag3(s, more, JITO)]))).includes("BUY"));
  void TIP;
});
