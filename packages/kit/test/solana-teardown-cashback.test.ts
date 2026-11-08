/// <reference types="node" />
// The teardown's cashback claims (card solana-teardown-cashback): before a volume account closes, what it owes is
// claimed to the wallet in the same frame, PumpSwap's claim_cashback (WSOL out of the volume account's WSOL account) and
// pump's claim_cashback_v2 (stable cashback out of its USDC account). close_user_volume_accumulator does not check for
// owed cashback (simulated on 12FzhSyn…), so a close without its claim would leave the WSOL in an account whose owner
// is gone. Good: the recorded mainnet wallet GATRKVEP… (test/fixtures/solana-teardown-cashback.json, captured with
// solana-teardown-capture.mjs on two public RPCs), its PumpSwap volume account owed 12,742,862, gains exactly that
// claim on both providers. Bad: planted frames that claim to another account, close before the claim, or a simulation
// that pays short, are refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { base58, base64 } from "@scure/base";
import {
  SOLANA_CLAIM_CASHBACK,
  SOLANA_CLAIM_CASHBACK_V2,
  SOLANA_CLOSE_VOLUME_ACCUMULATOR,
  SOLANA_COMPUTE_BUDGET_PROGRAM,
  SOLANA_PUMP_AMM_PROGRAM,
  SOLANA_PUMP_PROGRAM,
  SOLANA_PUMP_STABLE_MINT,
  SOLANA_SOL_MINT,
  SOLANA_SYSTEM_PROGRAM,
  SOLANA_TOKEN_PROGRAM,
  checkSolanaTeardown,
  solanaCashbackAccounts,
  solanaEventAuthority,
  solanaTeardownAddresses,
  solanaTeardownPlan,
  solanaTeardownUnclaimed,
  solanaVolumeAccumulator,
  type SolanaHeldRead,
  type SolanaTeardownPlan,
  type SolanaTeardownReads,
  type SolanaTeardownSimulation,
} from "../src/checks/solana/checks.ts";
import { SOLANA_ATA_PROGRAM, solanaAta, solanaDecodeMessage } from "../src/checks/solana/message.ts";
import { buildSolanaTeardown, simulateSolanaTeardown, solanaCompileV0, solanaTeardownChecked, type SolanaApiInstruction, type SolanaAssembled } from "../src/trade/solana/build.ts";
import type { SolanaRpc } from "../src/trade/solana/send.ts";

type RawAcc = { owner: string; lamports: number; data: [string, string] } | null;
type RawSim = { context: { slot: number }; value: { err: unknown; unitsConsumed: number; accounts: RawAcc[] } };
type Rec = { wallet: string; mints: { mint: string; program: string }[]; addresses: string[]; reads: { context: { slot: number }; value: RawAcc[] }[]; chain: { blockhash: string; lastValidBlockHeight: number }; frames: string[]; sims: RawSim[][][] };
const F = JSON.parse(readFileSync(new URL("./fixtures/solana-teardown-cashback.json", import.meta.url), "utf8")) as { readAt: string; rpcs: string[]; wallets: Rec[] };
const R = F.wallets[0]!;
const W = R.wallet;
const held = (a: RawAcc): SolanaHeldRead | null => (a ? { owner: a.owner, lamports: BigInt(a.lamports), data: base64.decode(a.data[0]) } : null);
const ACCOUNTS = Object.fromEntries(R.addresses.map((x, i) => [x, [held(R.reads[0]!.value[i + 1]!), held(R.reads[1]!.value[i + 1]!)] as const]));
const W0 = BigInt(R.reads[0]!.value[0]!.lamports);
const UVA_A = solanaVolumeAccumulator(W, SOLANA_PUMP_AMM_PROGRAM);
const UVA_P = solanaVolumeAccumulator(W, SOLANA_PUMP_PROGRAM);
const STRANGER = "9Egm6XfbVdNpL7ouFfmeRjnLsYJUE4qh8AuVFjHyKrCp";
const replay = (answers: RawSim[]): SolanaRpc => {
  const q = [...answers];
  return async (method) => {
    assert.equal(method, "simulateTransaction");
    const a = q.shift();
    if (!a) throw new Error("no more recorded answers");
    return a;
  };
};
async function readsOf(sims: RawSim[][][] = R.sims): Promise<SolanaTeardownReads> {
  const simulations: [SolanaTeardownSimulation, SolanaTeardownSimulation][] = [];
  for (const [f, pair] of sims.entries()) {
    const wire = base64.decode(R.frames[f] as string);
    simulations.push([await simulateSolanaTeardown(replay(pair[0]!), wire, W, R.addresses), await simulateSolanaTeardown(replay(pair[1]!), wire, W, R.addresses)]);
  }
  return { accounts: ACCOUNTS, wallet: [W0, BigInt(R.reads[1]!.value[0]!.lamports)], simulations };
}
const failed = (v: ReturnType<typeof checkSolanaTeardown>) => v.results.filter((r) => !r.ok).map((r) => `${r.id} ${r.detail}`);
const acc = (key: string, signer = false, writable = false) => ({ key, signer, writable });
const ix = (program: string, accounts: ReturnType<typeof acc>[], data: readonly number[]): SolanaApiInstruction => ({ program, accounts, data: Uint8Array.from(data) });
const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const frame = (ixs: SolanaApiInstruction[], payer = W): Uint8Array => {
  const { message } = solanaCompileV0(payer, ixs, R.chain.blockhash, []);
  const w = new Uint8Array(1 + 64 + message.length);
  w[0] = 1;
  w.set(message, 65);
  return w;
};
const limit = (n: number) => ix(SOLANA_COMPUTE_BUDGET_PROGRAM, [], [2, ...u32(n)]);
const openIx = (to: string, mint: string, owner = W) => ix(SOLANA_ATA_PROGRAM, [acc(W, true, true), acc(to, false, true), acc(owner), acc(mint), acc(SOLANA_SYSTEM_PROGRAM), acc(SOLANA_TOKEN_PROGRAM)], [1]);
const ammClaim = (o: { user?: string; to?: string; from?: string } = {}) => {
  const c = solanaCashbackAccounts(W, SOLANA_PUMP_AMM_PROGRAM);
  return ix(SOLANA_PUMP_AMM_PROGRAM, [acc(o.user ?? W, false, true), acc(UVA_A, false, true), acc(SOLANA_SOL_MINT), acc(SOLANA_TOKEN_PROGRAM), acc(o.from ?? c.from, false, true), acc(o.to ?? c.to, false, true), acc(SOLANA_SYSTEM_PROGRAM), acc(solanaEventAuthority(SOLANA_PUMP_AMM_PROGRAM)), acc(SOLANA_PUMP_AMM_PROGRAM)], SOLANA_CLAIM_CASHBACK);
};
const unwrap = (a: string, dest = W) => ix(SOLANA_TOKEN_PROGRAM, [acc(a, false, true), acc(dest, false, true), acc(W, true, false)], [9]);
const vclose = (p: string) => ix(p, [acc(W, true, true), acc(solanaVolumeAccumulator(W, p), false, true), acc(solanaEventAuthority(p)), acc(p)], SOLANA_CLOSE_VOLUME_ACCUMULATOR);
const WSOL_W = solanaAta(W, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM);
const WSOL_STRANGER = solanaAta(STRANGER, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM);

test("recorded: GATRKVEP…'s PumpSwap volume account is owed 12,742,862 of WSOL, held in its own WSOL account; the plan claims it to the wallet and closes both volume accounts", () => {
  assert.deepEqual(F.rpcs.length, 2);
  assert.deepEqual(R.addresses, solanaTeardownAddresses(W, R.mints));
  // the volume account the review named, derived from the wallet, never typed
  assert.ok(UVA_A.startsWith("12FzhSyn"), UVA_A);
  const plan = solanaTeardownPlan(W, ACCOUNTS);
  const c = solanaCashbackAccounts(W, SOLANA_PUMP_AMM_PROGRAM);
  assert.deepEqual(plan.claim, [{ program: SOLANA_PUMP_AMM_PROGRAM, uva: UVA_A, mint: SOLANA_SOL_MINT, from: c.from, to: WSOL_W, amount: 12_742_862n, open: true, unwrap: true, fromAmount: 12_742_862n, toAmount: 0n, prefund: 0n }]);
  assert.deepEqual(plan.close.map((h) => h.address).sort(), [UVA_A, UVA_P].sort());
  assert.deepEqual(plan.keep, []);
});

test("good: the frame rebuilds byte for byte; on both providers the claim lands in full and the wallet gains exactly 12,742,862 plus the closed accounts' lamports less the fee", async () => {
  const plan = solanaTeardownPlan(W, ACCOUNTS);
  const frames = buildSolanaTeardown(W, plan, R.chain);
  assert.deepEqual(frames.map((f) => base64.encode(f.wire)), R.frames);
  assert.equal(frames.length, 1);
  const reads = await readsOf();
  const v = checkSolanaTeardown(frames.map((f) => f.wire), W, reads);
  assert.deepEqual(failed(v), []);
  const closed = plan.close.reduce((s, h) => s + h.lamports, 0n);
  for (const s of reads.simulations[0]!) {
    assert.equal(s!.err, null);
    assert.equal(s!.wallet - W0 - closed + 5_000n, 12_742_862n);
    assert.equal(s!.amounts![plan.claim[0]!.from], 0n);
    // gone: one provider answers no account, the other an empty system account
    assert.ok(s!.accounts[WSOL_W] === null || s!.accounts[WSOL_W] === 0n);
  }
  for (const p of [0, 1]) for (const a of R.sims[0]![p]!) assert.ok(a.value.unitsConsumed <= frames[0]!.cuLimit);
});

test("bad: a frame that claims to another account, for another user, or from another account is refused", async () => {
  const reads = await readsOf();
  const cases: [string, Uint8Array][] = [
    ["claim to a stranger's WSOL account", frame([limit(121_600), openIx(WSOL_STRANGER, SOLANA_SOL_MINT, STRANGER), ammClaim({ to: WSOL_STRANGER }), unwrap(WSOL_STRANGER), vclose(SOLANA_PUMP_PROGRAM), vclose(SOLANA_PUMP_AMM_PROGRAM)])],
    ["claim naming a stranger as the user", frame([limit(121_600), openIx(WSOL_W, SOLANA_SOL_MINT), ammClaim({ user: STRANGER }), unwrap(WSOL_W), vclose(SOLANA_PUMP_PROGRAM), vclose(SOLANA_PUMP_AMM_PROGRAM)])],
    ["claim from another account", frame([limit(121_600), openIx(WSOL_W, SOLANA_SOL_MINT), ammClaim({ from: STRANGER }), unwrap(WSOL_W), vclose(SOLANA_PUMP_PROGRAM), vclose(SOLANA_PUMP_AMM_PROGRAM)])],
    ["the claim's WSOL closed to a stranger", frame([limit(121_600), openIx(WSOL_W, SOLANA_SOL_MINT), ammClaim(), unwrap(WSOL_W, STRANGER), vclose(SOLANA_PUMP_PROGRAM), vclose(SOLANA_PUMP_AMM_PROGRAM)])],
  ];
  for (const [what, wire] of cases) {
    const v = checkSolanaTeardown([wire], W, reads);
    assert.equal(v.ok, false, what);
    assert.ok(failed(v).some((x) => x.startsWith("FRAME")), `${what}: ${failed(v).join(" | ")}`);
  }
  // A plan edited to pay a stranger, built by the kit's own builder: the check's own plan from the reads refuses it.
  const plan = solanaTeardownPlan(W, ACCOUNTS);
  const evil: SolanaTeardownPlan = { ...plan, claim: plan.claim.map((c) => ({ ...c, to: WSOL_STRANGER })) };
  const v = checkSolanaTeardown(buildSolanaTeardown(W, evil, R.chain).map((f) => f.wire), W, reads);
  assert.equal(v.ok, false);
  assert.ok(failed(v).some((x) => x.startsWith("FRAME")), failed(v).join(" | "));
});

test("bad: an owed volume account closed without its claim, or before it, and a claim's WSOL closed before the claim, are refused", async () => {
  const reads = await readsOf();
  const noClaim = checkSolanaTeardown([frame([limit(56_600), vclose(SOLANA_PUMP_PROGRAM), vclose(SOLANA_PUMP_AMM_PROGRAM)])], W, reads);
  assert.equal(noClaim.ok, false);
  assert.ok(failed(noClaim).some((x) => x.includes(`close of ${UVA_A} before its claim`)), failed(noClaim).join(" | "));
  assert.ok(failed(noClaim).some((x) => x.includes(`${UVA_A}'s cashback claimed 0 times (want 1)`)), failed(noClaim).join(" | "));
  const closeFirst = checkSolanaTeardown([frame([limit(121_600), vclose(SOLANA_PUMP_AMM_PROGRAM), openIx(WSOL_W, SOLANA_SOL_MINT), ammClaim(), unwrap(WSOL_W), vclose(SOLANA_PUMP_PROGRAM)])], W, reads);
  assert.ok(failed(closeFirst).some((x) => x.includes(`close of ${UVA_A} before its claim`)), failed(closeFirst).join(" | "));
  const unwrapFirst = checkSolanaTeardown([frame([limit(121_600), openIx(WSOL_W, SOLANA_SOL_MINT), unwrap(WSOL_W), ammClaim(), vclose(SOLANA_PUMP_PROGRAM), vclose(SOLANA_PUMP_AMM_PROGRAM)])], W, reads);
  assert.equal(unwrapFirst.ok, false);
  assert.ok(failed(unwrapFirst).some((x) => x.includes(`close of ${WSOL_W} not right after its claim`)), failed(unwrapFirst).join(" | "));
  // The claim's WSOL closed after another instruction, not right after the claim.
  const between = checkSolanaTeardown([frame([limit(121_600), openIx(WSOL_W, SOLANA_SOL_MINT), ammClaim(), vclose(SOLANA_PUMP_AMM_PROGRAM), unwrap(WSOL_W), vclose(SOLANA_PUMP_PROGRAM)])], W, reads);
  assert.ok(failed(between).some((x) => x.includes(`close of ${WSOL_W} not right after its claim`)), failed(between).join(" | "));
  // The open: for a stranger as the owner, not right before its claim, or left out when the plan opens.
  const strangerOwner = checkSolanaTeardown([frame([limit(121_600), openIx(WSOL_W, SOLANA_SOL_MINT, STRANGER), ammClaim(), unwrap(WSOL_W), vclose(SOLANA_PUMP_PROGRAM), vclose(SOLANA_PUMP_AMM_PROGRAM)])], W, reads);
  assert.ok(failed(strangerOwner).some((x) => x.includes(`open of ${WSOL_W}`)), failed(strangerOwner).join(" | "));
  const openEarly = checkSolanaTeardown([frame([limit(121_600), openIx(WSOL_W, SOLANA_SOL_MINT), vclose(SOLANA_PUMP_PROGRAM), ammClaim(), unwrap(WSOL_W), vclose(SOLANA_PUMP_AMM_PROGRAM)])], W, reads);
  assert.ok(failed(openEarly).some((x) => x.includes(`open of ${WSOL_W}`)), failed(openEarly).join(" | "));
  const noOpen = checkSolanaTeardown([frame([limit(96_600), ammClaim(), unwrap(WSOL_W), vclose(SOLANA_PUMP_PROGRAM), vclose(SOLANA_PUMP_AMM_PROGRAM)])], W, reads);
  assert.ok(failed(noOpen).some((x) => x.includes(`${WSOL_W} opened 0 times (want 1)`)), failed(noOpen).join(" | "));
  const noUnwrap = checkSolanaTeardown([frame([limit(115_600), openIx(WSOL_W, SOLANA_SOL_MINT), ammClaim(), vclose(SOLANA_PUMP_PROGRAM), vclose(SOLANA_PUMP_AMM_PROGRAM)])], W, reads);
  assert.ok(failed(noUnwrap).some((x) => x.includes(`${WSOL_W} closed 0 times after its claim (want 1)`)), failed(noUnwrap).join(" | "));
  // The claim's source read-only (the claim could not move it).
  const ro = ammClaim();
  const roFrom = { ...ro, accounts: ro.accounts.map((x, i) => (i === 4 ? { ...x, writable: false } : x)) };
  for (const c of [roFrom]) {
    const v = checkSolanaTeardown([frame([limit(121_600), openIx(WSOL_W, SOLANA_SOL_MINT), c, unwrap(WSOL_W), vclose(SOLANA_PUMP_PROGRAM), vclose(SOLANA_PUMP_AMM_PROGRAM)])], W, reads);
    assert.ok(failed(v).some((x) => x.includes("no claim of the plan's")), failed(v).join(" | "));
  }
  // PumpSwap's claim with another instruction's data (pump's claim_cashback_v2) in its place.
  const otherData = checkSolanaTeardown([frame([limit(121_600), openIx(WSOL_W, SOLANA_SOL_MINT), { ...ammClaim(), data: Uint8Array.from(SOLANA_CLAIM_CASHBACK_V2) }, unwrap(WSOL_W), vclose(SOLANA_PUMP_PROGRAM), vclose(SOLANA_PUMP_AMM_PROGRAM)])], W, reads);
  assert.ok(failed(otherData).some((x) => x.includes("no claim of the plan's")), failed(otherData).join(" | "));
  // The claim twice in one frame.
  const twice = checkSolanaTeardown([frame([limit(200_000), openIx(WSOL_W, SOLANA_SOL_MINT), ammClaim(), ammClaim(), unwrap(WSOL_W), vclose(SOLANA_PUMP_PROGRAM), vclose(SOLANA_PUMP_AMM_PROGRAM)])], W, reads);
  assert.ok(failed(twice).some((x) => x.includes(`claimed 2 times (want 1)`)), failed(twice).join(" | "));
});

test("bad: a simulation that pays the claim short, or leaves the claim's WSOL account open, is refused", async () => {
  // Provider B's answer edited: the volume account's WSOL account keeps 1 token (simulateSolanaTeardown reads three
  // addresses a call after the wallet; from is the sixth address).
  const at = R.addresses.indexOf(solanaCashbackAccounts(W, SOLANA_PUMP_AMM_PROGRAM).from);
  const sims = structuredClone(R.sims);
  const slot = sims[0]![1]![Math.floor(at / 3)]!.value.accounts[(at % 3) + 1]!;
  const d = base64.decode(slot.data[0]);
  new DataView(d.buffer).setBigUint64(64, 1n, true);
  slot.data[0] = base64.encode(d);
  const v = checkSolanaTeardown(R.frames.map((x) => base64.decode(x)), W, await readsOf(sims));
  assert.equal(v.ok, false);
  assert.deepEqual(failed(v), [`SIM frame 0 provider B: ${solanaCashbackAccounts(W, SOLANA_PUMP_AMM_PROGRAM).from} holds 1 after the claim (want 0)`]);
  // The wallet short by one lamport on provider A.
  const short = structuredClone(R.sims);
  for (const call of short[0]![0]!) call.value.accounts[0]!.lamports -= 1;
  const v2 = checkSolanaTeardown(R.frames.map((x) => base64.decode(x)), W, await readsOf(short));
  assert.equal(v2.ok, false);
  assert.match(failed(v2).join(" | "), /SIM frame 0 provider A: the wallet gains/);
  // The wallet's WSOL account still there after.
  const wat = R.addresses.indexOf(WSOL_W);
  const open = structuredClone(R.sims);
  open[0]![0]![Math.floor(wat / 3)]!.value.accounts[(wat % 3) + 1] = { owner: SOLANA_TOKEN_PROGRAM, lamports: 2_039_280, data: [base64.encode(new Uint8Array(165)), "base64"] };
  const v3 = checkSolanaTeardown(R.frames.map((x) => base64.decode(x)), W, await readsOf(open));
  assert.ok(failed(v3).some((x) => x.includes(`${WSOL_W} still holds 2039280 lamports`)), failed(v3).join(" | "));
});

// ---- pump's stable cashback (no real owed account found to record: built from the IDL's layouts on GATRKVEP…'s reads)

const STABLE = solanaCashbackAccounts(W, SOLANA_PUMP_PROGRAM);
function tokenAccount(mint: string, owner: string, amount: bigint, state = 1): SolanaHeldRead {
  const d = new Uint8Array(165);
  d.set(base58.decode(mint), 0);
  d.set(base58.decode(owner), 32);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  d[108] = state;
  return { owner: SOLANA_TOKEN_PROGRAM, lamports: 2_039_280n, data: d };
}
// GATRKVEP…'s pump volume account with stable_cashback_earned @90 = 500,000 and total_stable_cashback_claimed @98 = 0.
function stableWorld(o: { source?: bigint; to?: SolanaHeldRead | null } = {}) {
  const real = ACCOUNTS[UVA_P]![0]!;
  assert.ok(real.data.length >= 106);
  const d = Uint8Array.from(real.data);
  new DataView(d.buffer).setBigUint64(90, 500_000n, true);
  new DataView(d.buffer).setBigUint64(98, 0n, true);
  const uva = { ...real, data: d };
  const src = tokenAccount(SOLANA_PUMP_STABLE_MINT, UVA_P, o.source ?? 500_000n);
  const to = o.to === undefined ? null : o.to;
  return { ...ACCOUNTS, [UVA_P]: [uva, uva] as const, [STABLE.from]: [src, src] as const, [STABLE.to]: [to, to] as const };
}
// Honest simulations of one frame: W up by what closes and the WSOL claim, less the fee and the USDC account's rent.
function stableSims(plan: SolanaTeardownPlan, rentPaid: bigint, over: Partial<{ to: bigint; from: bigint; rent: bigint }> = {}) {
  const closed = plan.close.reduce((s, h) => s + h.lamports, 0n) + plan.claim.reduce((s, c) => s + (c.unwrap ? c.amount : 0n), 0n);
  const sc = plan.claim.find((c) => c.program === SOLANA_PUMP_PROGRAM)!;
  const ac = plan.claim.find((c) => c.program === SOLANA_PUMP_AMM_PROGRAM)!;
  const s: SolanaTeardownSimulation = {
    err: null,
    wallet: W0 + closed - 5_000n - rentPaid,
    accounts: { ...Object.fromEntries(plan.close.map((h) => [h.address, null])), [ac.to]: null, [sc.to]: over.rent ?? 2_039_280n },
    amounts: { [ac.from]: 0n, [sc.from]: over.from ?? 0n, [sc.to]: over.to ?? sc.toAmount + sc.amount },
  };
  return [[s, s]] as const;
}

test("stable cashback: the plan claims it to the wallet's own USDC account (opened when there is none, kept after), right before the pump close; checked like the WSOL claim", () => {
  const accounts = stableWorld();
  const plan = solanaTeardownPlan(W, accounts);
  const sc = plan.claim.find((c) => c.program === SOLANA_PUMP_PROGRAM)!;
  assert.deepEqual(sc, { program: SOLANA_PUMP_PROGRAM, uva: UVA_P, mint: SOLANA_PUMP_STABLE_MINT, from: STABLE.from, to: solanaAta(W, SOLANA_PUMP_STABLE_MINT, SOLANA_TOKEN_PROGRAM), amount: 500_000n, open: true, unwrap: false, fromAmount: 500_000n, toAmount: 0n, prefund: 0n });
  assert.deepEqual(plan.keep, [{ address: STABLE.to, why: `takes stable cashback 500000 of ${SOLANA_PUMP_STABLE_MINT}` }]);
  const frames = buildSolanaTeardown(W, plan, R.chain);
  assert.equal(frames.length, 1);
  assert.ok(frames[0]!.size <= 1232, `${frames[0]!.size} bytes`);
  const base = { accounts, wallet: [W0, W0] as const };
  assert.deepEqual(failed(checkSolanaTeardown(frames.map((f) => f.wire), W, { ...base, simulations: stableSims(plan, 2_039_280n) })), []);
  // short to the wallet, left in the source, an open that takes more than a token account's rent: refused
  assert.match(failed(checkSolanaTeardown(frames.map((f) => f.wire), W, { ...base, simulations: stableSims(plan, 2_039_280n, { to: 499_999n }) })).join(" | "), new RegExp(`${STABLE.to} holds 499999 after the claim`));
  assert.match(failed(checkSolanaTeardown(frames.map((f) => f.wire), W, { ...base, simulations: stableSims(plan, 2_039_280n, { from: 1n }) })).join(" | "), new RegExp(`${STABLE.from} holds 1 after the claim`));
  assert.match(failed(checkSolanaTeardown(frames.map((f) => f.wire), W, { ...base, simulations: stableSims(plan, 3_000_000n, { rent: 3_000_000n }) })).join(" | "), /opened with 3000000 lamports/);
  // the stable claim to a stranger's USDC account, built by the kit's builder from an edited plan: refused
  const strangerUsdc = solanaAta(STRANGER, SOLANA_PUMP_STABLE_MINT, SOLANA_TOKEN_PROGRAM);
  const evil = { ...plan, claim: plan.claim.map((c) => (c === sc ? { ...c, to: strangerUsdc } : c)) };
  assert.ok(failed(checkSolanaTeardown(buildSolanaTeardown(W, evil, R.chain).map((f) => f.wire), W, { ...base, simulations: stableSims(plan, 2_039_280n) })).some((x) => x.startsWith("FRAME")));
  // the v2 claim's discriminator on the PumpSwap program (or the reverse) is no claim
  const v2OnAmm = { ...plan, claim: plan.claim.map((c) => (c === sc ? c : { ...c, program: SOLANA_PUMP_PROGRAM })) } as SolanaTeardownPlan;
  assert.equal(checkSolanaTeardown(buildSolanaTeardown(W, v2OnAmm, R.chain).map((f) => f.wire), W, { ...base, simulations: stableSims(plan, 2_039_280n) }).ok, false);
  assert.deepEqual(SOLANA_CLAIM_CASHBACK_V2, [122, 243, 204, 65, 94, 116, 29, 55]);
});

test("stable cashback: an existing USDC account of the wallet takes it without an open; one that is frozen, or a source short of what is owed, keeps the volume account open", () => {
  const usdc = tokenAccount(SOLANA_PUMP_STABLE_MINT, W, 7n);
  const plan = solanaTeardownPlan(W, stableWorld({ to: usdc }));
  const sc = plan.claim.find((c) => c.program === SOLANA_PUMP_PROGRAM)!;
  assert.equal(sc.open, false);
  assert.equal(sc.toAmount, 7n);
  assert.ok(plan.close.some((h) => h.address === UVA_P));
  const frozen = solanaTeardownPlan(W, stableWorld({ to: tokenAccount(SOLANA_PUMP_STABLE_MINT, W, 0n, 2) }));
  assert.ok(!frozen.claim.some((c) => c.program === SOLANA_PUMP_PROGRAM));
  assert.ok(!frozen.close.some((h) => h.address === UVA_P));
  assert.match(frozen.keep.find((k) => k.address === UVA_P)!.why, /^stable cashback 500000 unclaimed/);
  const shortSrc = solanaTeardownPlan(W, stableWorld({ source: 499_999n }));
  assert.ok(!shortSrc.claim.some((c) => c.program === SOLANA_PUMP_PROGRAM));
  assert.match(shortSrc.keep.find((k) => k.address === UVA_P)!.why, /holds 499999/);
  // the claim into the existing account: an open the plan does not ask for, or the account read-only, is refused
  const accounts = stableWorld({ to: usdc });
  const v2 = (o: { open?: boolean; roTo?: boolean } = {}) => {
    const k = [acc(W, false, true), acc(UVA_P, false, true), acc(SOLANA_PUMP_STABLE_MINT), acc(SOLANA_TOKEN_PROGRAM), acc(SOLANA_ATA_PROGRAM), acc(STABLE.from, false, true), acc(STABLE.to, false, !o.roTo), acc(SOLANA_SYSTEM_PROGRAM), acc(solanaEventAuthority(SOLANA_PUMP_PROGRAM)), acc(SOLANA_PUMP_PROGRAM)];
    const amm = plan.claim.find((c) => c.program === SOLANA_PUMP_AMM_PROGRAM)!;
    return frame([limit(150_000), ...(o.open ? [openIx(STABLE.to, SOLANA_PUMP_STABLE_MINT)] : []), ix(SOLANA_PUMP_PROGRAM, k, SOLANA_CLAIM_CASHBACK_V2), openIx(amm.to, SOLANA_SOL_MINT), ammClaim(), unwrap(amm.to), vclose(SOLANA_PUMP_PROGRAM), vclose(SOLANA_PUMP_AMM_PROGRAM)]);
  };
  const sims = [[{ err: null, wallet: 0n, accounts: {} }, { err: null, wallet: 0n, accounts: {} }]] as const;
  const r = (w: Uint8Array) => failed(checkSolanaTeardown([w], W, { accounts, wallet: [W0, W0], simulations: sims })).filter((x) => !x.startsWith("SIM"));
  assert.deepEqual(r(v2()), []);
  assert.deepEqual(r(v2({ open: true })), [`COVER ${STABLE.to} opened 1 times (want 0)`]);
  assert.ok(r(v2({ roTo: true })).some((x) => x.includes("no claim of the plan's")), r(v2({ roTo: true })).join(" | "));
  // an empty USDC account of the wallet that takes the claim is not closed by S-4
  const empty = solanaTeardownPlan(W, stableWorld({ to: tokenAccount(SOLANA_PUMP_STABLE_MINT, W, 0n) }));
  assert.ok(!empty.close.some((h) => h.address === STABLE.to));
  assert.ok(empty.claim.some((c) => c.to === STABLE.to && !c.open));
});

test("a volume account kept for another reason still has its cashback claimed: a frame that only claims passes", () => {
  const real = ACCOUNTS[UVA_A]![0]!;
  const d = Uint8Array.from(real.data);
  new DataView(d.buffer).setBigUint64(57, 1n, true); // current_sol_volume: volume not settled
  const uva = { ...real, data: d };
  const accounts = { ...ACCOUNTS, [UVA_A]: [uva, uva] as const };
  const plan = solanaTeardownPlan(W, accounts);
  assert.equal(plan.claim.length, 1);
  assert.ok(!plan.close.some((h) => h.address === UVA_A));
  assert.deepEqual(plan.keep, [{ address: UVA_A, why: "volume 1 not settled" }]);
  const only = { ...plan, close: [] };
  const frames = buildSolanaTeardown(W, only, R.chain);
  const s: SolanaTeardownSimulation = { err: null, wallet: W0 + 12_742_862n - 5_000n, accounts: { [WSOL_W]: null }, amounts: { [plan.claim[0]!.from]: 0n } };
  const pump = plan.close.find((h) => h.address === UVA_P)!;
  const withPump = { ...s, wallet: s.wallet + pump.lamports, accounts: { ...s.accounts, [UVA_P]: null } };
  assert.deepEqual(failed(checkSolanaTeardown(buildSolanaTeardown(W, plan, R.chain).map((f) => f.wire), W, { accounts, wallet: [W0, W0], simulations: [[withPump, withPump]] })), []);
  // the claim alone, with the pump close left out, is refused only for the missing close
  assert.deepEqual(failed(checkSolanaTeardown(frames.map((f) => f.wire), W, { accounts, wallet: [W0, W0], simulations: [[s, s]] })), [`COVER ${UVA_P} closed 0 times (want 1)`]);
});

test("WSOL claim: a source short of what is owed, or one not read, keeps the PumpSwap volume account open with the reason", () => {
  const src = solanaCashbackAccounts(W, SOLANA_PUMP_AMM_PROGRAM).from;
  const short = tokenAccount(SOLANA_SOL_MINT, UVA_A, 12_742_861n);
  const p = solanaTeardownPlan(W, { ...ACCOUNTS, [src]: [short, short] });
  assert.deepEqual(p.claim, []);
  assert.ok(!p.close.some((h) => h.address === UVA_A));
  assert.match(p.keep.find((k) => k.address === UVA_A)!.why, /^cashback 12742862 unclaimed \(the volume account's .* holds 12742861\)$/);
  const { [src]: _, ...unread } = ACCOUNTS;
  const p2 = solanaTeardownPlan(W, unread);
  assert.ok(!p2.close.some((h) => h.address === UVA_A));
  assert.match(p2.keep.find((k) => k.address === UVA_A)!.why, /holds nothing read\)$/);
  // the wallet's WSOL account there but not closable by the wallet (another close authority): no claim into it
  const wsol = tokenAccount(SOLANA_SOL_MINT, W, 0n);
  const d = Uint8Array.from(wsol.data);
  new DataView(d.buffer).setUint32(129, 1, true);
  d.set(base58.decode(STRANGER), 133);
  const locked = { ...wsol, data: d };
  const p3 = solanaTeardownPlan(W, { ...ACCOUNTS, [WSOL_W]: [locked, locked] });
  assert.deepEqual(p3.claim, []);
  assert.match(p3.keep.find((k) => k.address === UVA_A)!.why, new RegExp(`cannot take it \\(close authority ${STRANGER}\\)`));
  // a source that is not the volume account's own WSOL account is refused as a read
  const other = tokenAccount(SOLANA_SOL_MINT, STRANGER, 12_742_862n);
  assert.throws(() => solanaTeardownPlan(W, { ...ACCOUNTS, [src]: [other, other] }), /not the volume account's/);
});

test("the reads: one traded mint's teardown accounts and the wallet fit in one getMultipleAccounts of 10 (solana-rpc.publicnode.com's cap)", () => {
  const list = solanaTeardownAddresses(W, [{ mint: STRANGER, program: SOLANA_TOKEN_PROGRAM }]);
  assert.ok(1 + list.length <= 10, `${1 + list.length}`);
  for (const p of [SOLANA_PUMP_PROGRAM, SOLANA_PUMP_AMM_PROGRAM]) {
    const c = solanaCashbackAccounts(W, p);
    assert.ok(list.includes(c.from) && list.includes(c.to));
  }
});

test("funding: a wallet a pool sell left at rent(0) opens its WSOL account with the rent of a close in the same frame: the claim rides after the frame's closes, the owed close after it", () => {
  // GATRKVEP…'s PumpSwap reads with its pump volume account gone and a token account of the wallet's to close (the
  // pool sell's own: SPL Token, no tokens, rent 2,039,280); the wallet holds rent(0), 890,880, under one open's rent.
  const mint = STRANGER;
  const ata = solanaAta(W, mint, SOLANA_TOKEN_PROGRAM);
  const tok = tokenAccount(mint, W, 0n);
  const accounts = { ...ACCOUNTS, [UVA_P]: [null, null] as const, [ata]: [tok, tok] as const };
  const plan = solanaTeardownPlan(W, accounts);
  assert.deepEqual(plan.close.map((h) => h.address).sort(), [ata, UVA_A].sort());
  const frames = buildSolanaTeardown(W, plan, R.chain);
  assert.equal(frames.length, 1, "the claim in the frame whose close funds its open");
  // the order, read back from the frame's own message
  const msg = solanaDecodeMessage(frames[0]!.message);
  const order = msg.instructions.map((x) => msg.staticKeys[x.programIndex]);
  assert.deepEqual(order, [SOLANA_COMPUTE_BUDGET_PROGRAM, SOLANA_TOKEN_PROGRAM, SOLANA_ATA_PROGRAM, SOLANA_PUMP_AMM_PROGRAM, SOLANA_TOKEN_PROGRAM, SOLANA_PUMP_AMM_PROGRAM]);
  // simulated as the runtime runs it from 890,880: the token close first (+2,039,280), then the open (-2,039,280),
  // the claim, the unwrap (+2,039,280 + the claim), the volume close: the wallet never goes under 0
  let lamports = 890_880n - 5_000n;
  for (const step of [2_039_280n, -2_039_280n, 0n, 2_039_280n + 12_742_862n, plan.close.find((h) => h.address === UVA_A)!.lamports]) {
    lamports += step;
    assert.ok(lamports >= 0n);
  }
});

// Review L2 of 5592a871: the verdict covers every frame and the claims ride in the last one, so a claim that does not
// simulate (claim_cashback_v2 never run on a real owed account, cashback switched off, more compute than its budget,
// more paid than owed) refused the whole teardown, every close with it; before the card only the owed account stayed.
// solanaTeardownChecked plans again once with claims off: the owed account stays open with its reason, the rest closes.
const SIM_ERR = { InstructionError: [2, { Custom: 6000 }] };
// A clean simulation of a frame on the pre-state: the closes it names gone, the wallet up by their lamports less the fee.
const cleanSim = (plan: SolanaTeardownPlan, f: SolanaAssembled): SolanaTeardownSimulation => {
  const keys = new Set(solanaDecodeMessage(f.wire.subarray(65)).staticKeys);
  const here = plan.close.filter((h) => keys.has(h.address));
  return { err: null, wallet: W0 + here.reduce((x, h) => x + h.lamports, 0n) - 5_000n, accounts: Object.fromEntries(here.map((h) => [h.address, null])), amounts: {} };
};

test("L2: a claim whose frame does not simulate on either provider is planned around, its program's claims off: the owed volume account stays open with the reason, every other close is framed, simulated and passes", async () => {
  const plan = solanaTeardownPlan(W, ACCOUNTS);
  assert.equal(plan.claim.length, 1);
  // what claims off closes, whatever the reason: the lamports a clean simulation gives back
  const off = solanaTeardownPlan(W, ACCOUNTS, { [SOLANA_PUMP_AMM_PROGRAM]: "any reason" });
  const calls: SolanaAssembled[][] = [];
  const t = await solanaTeardownChecked(W, plan, ACCOUNTS, [W0, W0], R.chain, async (fs) => {
    calls.push([...fs]);
    // first: the claim's frame fails on both providers; then the claims-off frames are clean
    return calls.length === 1 ? fs.map(() => [{ err: SIM_ERR, wallet: 0n, accounts: {} }, { err: SIM_ERR, wallet: 0n, accounts: {} }] as const) : fs.map((f) => [cleanSim(off, f), cleanSim(off, f)] as const);
  });
  assert.equal(calls.length, 2, "simulated twice: with the claim, then claims off");
  assert.deepEqual(failed(t.verdict), []);
  assert.deepEqual(t.plan.claim, []);
  assert.deepEqual(t.plan.close.map((h) => h.address), [UVA_P], "the pump volume account still closes");
  assert.equal(t.plan.keep.length, 1);
  assert.equal(t.plan.keep[0]!.address, UVA_A);
  // the reason names what failed: the claim's frame, on both providers, each provider's error
  assert.match(t.plan.keep[0]!.why, /^cashback 12742862 unclaimed \(its claim did not simulate on either provider: A .*Custom.*6000.*, B .*Custom.*6000/);
  assert.deepEqual(Object.keys(t.reads.unclaimed ?? {}), [SOLANA_PUMP_AMM_PROGRAM]);
  assert.equal(t.reads.unclaimed![SOLANA_PUMP_AMM_PROGRAM], t.plan.keep[0]!.why.slice("cashback 12742862 unclaimed (".length, -1));
  // the frames close nothing owed and claim nothing
  for (const f of t.frames) {
    const m = solanaDecodeMessage(f.wire.subarray(65));
    assert.ok(!m.staticKeys.includes(UVA_A) && !m.staticKeys.includes(WSOL_W), "the owed account and its claim are out of the frames");
  }
  // the check is bound to the mode: the same frames judged with claims on are refused (the plan's claim is not there)
  const { unclaimed: _off, ...claimsOn } = t.reads;
  const on = checkSolanaTeardown(t.frames.map((f) => f.wire), W, claimsOn);
  assert.equal(on.ok, false);
});

// Review M1 of 11c963f9: any SIM refusal turned claims off, so one provider erring once (a lagging backend, a stale
// balancer, one hostile provider) dropped the claim for good. Only a claim frame that errs on both providers, with
// every other frame clean on both, is planned around; anything else is a refusal the caller reads again.
test("M1: one provider erring on the claim's frame, or a frame before it dirty, is no fallback: one simulation, the first verdict stands", async () => {
  const plan = solanaTeardownPlan(W, ACCOUNTS);
  const ok = (await readsOf()).simulations[0]!;
  for (const which of [0, 1] as const) {
    let n = 0;
    const t = await solanaTeardownChecked(W, plan, ACCOUNTS, [W0, W0], R.chain, async (fs) => (n++, fs.map(() => (which === 0 ? [{ err: SIM_ERR, wallet: 0n, accounts: {} }, ok[1]] : [ok[0], { err: SIM_ERR, wallet: 0n, accounts: {} }]) as never)));
    assert.equal(n, 1, `provider ${which} alone`);
    assert.equal(t.verdict.ok, false);
    assert.deepEqual(t.plan.claim.length, 1, "the claim stays planned");
    assert.equal(t.reads.unclaimed, undefined);
    // a provider that answered nothing is no error on both either
    assert.equal(solanaTeardownUnclaimed(t.verdict, t.frames.map((f) => f.wire), [[{ err: SIM_ERR, wallet: 0n, accounts: {} }, null]]), null);
  }
  // two frames: the claim's (the last) errs on both, but the one before is dirty on one provider: no fallback
  const v = checkSolanaTeardown(R.frames.map((x) => base64.decode(x)), W, { ...(await readsOf()), simulations: [[{ err: SIM_ERR, wallet: 0n, accounts: {} }, { err: SIM_ERR, wallet: 0n, accounts: {} }]] });
  const wire = base64.decode(R.frames[0]!);
  const bad = { err: SIM_ERR, wallet: 0n, accounts: {} };
  assert.notEqual(solanaTeardownUnclaimed(v, [wire], [[bad, bad]]), null, "the claim frame on both: planned around");
  assert.equal(solanaTeardownUnclaimed(v, [wire, wire], [[ok[0]!, bad], [bad, bad]]), null);
  assert.equal(solanaTeardownUnclaimed(v, [wire, wire], [[null, ok[1]!], [bad, bad]]), null);
  assert.equal(solanaTeardownUnclaimed(v, [wire, wire], [[ok[0]!, ok[1]!], [bad, bad]])?.[SOLANA_PUMP_AMM_PROGRAM]?.startsWith("its claim did not simulate on either provider"), true);
  // the claim frame clean on both (the refusal is elsewhere, a lamport count): no fallback
  assert.equal(solanaTeardownUnclaimed(v, [wire], [[ok[0]!, ok[1]!]]), null);
  // wires and simulations that do not pair: none
  assert.equal(solanaTeardownUnclaimed(v, [], []), null);
  assert.equal(solanaTeardownUnclaimed(v, [wire], [[bad, bad], [bad, bad]]), null);
});

// Review L1 of 11c963f9: one failing claim dropped every claim. The program whose instruction both providers name as
// failing has its claims off; the other program's claim stays, and goes off only when it fails too (two more
// simulations at most). An error that names no claim's instruction turns every claim off at once.
test("L1: the failing program's claim alone goes off; the other's goes off only when it fails too; an unmapped error turns all off", async () => {
  const accounts = stableWorld();
  const plan = solanaTeardownPlan(W, accounts);
  assert.deepEqual(plan.claim.map((c) => c.program).sort(), [SOLANA_PUMP_AMM_PROGRAM, SOLANA_PUMP_PROGRAM].sort());
  const at = (f: SolanaAssembled, program: string): number => {
    const m = solanaDecodeMessage(f.wire.subarray(65));
    const want = program === SOLANA_PUMP_PROGRAM ? SOLANA_CLAIM_CASHBACK_V2 : SOLANA_CLAIM_CASHBACK;
    return m.instructions.findIndex((x) => m.staticKeys[x.programIndex] === program && x.data.length === 8 && x.data.every((b, i) => b === want[i]));
  };
  const failOn = (f: SolanaAssembled, program: string) => {
    const e = { err: { InstructionError: [at(f, program), { Custom: 6000 }] }, wallet: 0n, accounts: {} };
    return [e, e] as const;
  };
  // v2 refuses, the PumpSwap claim would land: the second simulation keeps the PumpSwap claim, and stops there
  const calls: SolanaTeardownPlan[] = [];
  const one = await solanaTeardownChecked(W, plan, accounts, [W0, W0], R.chain, async (fs) => {
    calls.push(calls.length === 0 ? plan : solanaTeardownPlan(W, accounts, { [SOLANA_PUMP_PROGRAM]: "x" }));
    return calls.length === 1 ? fs.map((f, i) => (i === fs.length - 1 ? failOn(f, SOLANA_PUMP_PROGRAM) : [cleanSim(plan, f), cleanSim(plan, f)] as const)) : fs.map((f) => [cleanSim(plan, f), cleanSim(plan, f)] as const);
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(one.plan.claim.map((c) => c.program), [SOLANA_PUMP_AMM_PROGRAM], "the PumpSwap claim stays");
  assert.deepEqual(Object.keys(one.reads.unclaimed ?? {}), [SOLANA_PUMP_PROGRAM]);
  assert.match(one.plan.keep.find((k) => k.address === UVA_P)!.why, /^stable cashback 500000 unclaimed \(its claim did not simulate on either provider/);
  // both refuse: v2 off first, then the PumpSwap claim off too; three simulations in all
  let n = 0;
  const both = await solanaTeardownChecked(W, plan, accounts, [W0, W0], R.chain, async (fs) => {
    n++;
    const last = fs.length - 1;
    if (n === 1) return fs.map((f, i) => (i === last ? failOn(f, SOLANA_PUMP_PROGRAM) : [cleanSim(plan, f), cleanSim(plan, f)] as const));
    if (n === 2) return fs.map((f, i) => (i === last ? failOn(f, SOLANA_PUMP_AMM_PROGRAM) : [cleanSim(plan, f), cleanSim(plan, f)] as const));
    return fs.map((f) => [cleanSim(plan, f), cleanSim(plan, f)] as const);
  });
  assert.equal(n, 3, "at most two more simulations");
  assert.deepEqual(both.plan.claim, []);
  assert.deepEqual(Object.keys(both.reads.unclaimed ?? {}).sort(), [SOLANA_PUMP_AMM_PROGRAM, SOLANA_PUMP_PROGRAM].sort());
  // an error naming no claim's instruction (a string, an index out of range, the two providers naming different ones):
  // every claim off at once
  for (const errs of [["x", "x"], [{ InstructionError: [99, {}] }, { InstructionError: [99, {}] }], "split"] as const) {
    let k = 0;
    const all = await solanaTeardownChecked(W, plan, accounts, [W0, W0], R.chain, async (fs) => {
      k++;
      const last = fs.length - 1;
      if (k > 1) return fs.map((f) => [cleanSim(plan, f), cleanSim(plan, f)] as const);
      return fs.map((f, i) => {
        if (i !== last) return [cleanSim(plan, f), cleanSim(plan, f)] as const;
        if (errs === "split") return [failOn(f, SOLANA_PUMP_PROGRAM)[0], failOn(f, SOLANA_PUMP_AMM_PROGRAM)[0]] as const;
        return [{ err: errs[0], wallet: 0n, accounts: {} }, { err: errs[1], wallet: 0n, accounts: {} }] as const;
      });
    });
    assert.equal(k, 2, JSON.stringify(errs));
    assert.deepEqual(all.plan.claim, [], JSON.stringify(errs));
  }
});

test("L2: nothing planned around when the plan claims nothing, or when a check other than SIM refuses: one simulation, the first verdict stands", async () => {
  // no claim (the PumpSwap volume account's WSOL account not read): SIM fails, simulated once, refused as before
  const noClaim = { ...ACCOUNTS };
  delete (noClaim as Record<string, unknown>)[solanaCashbackAccounts(W, SOLANA_PUMP_AMM_PROGRAM).from];
  const plan = solanaTeardownPlan(W, noClaim);
  assert.equal(plan.claim.length, 0);
  let n = 0;
  const t = await solanaTeardownChecked(W, plan, noClaim, [W0, W0], R.chain, async (fs) => (n++, fs.map(() => [{ err: SIM_ERR, wallet: 0n, accounts: {} }, { err: SIM_ERR, wallet: 0n, accounts: {} }] as const)));
  assert.equal(n, 1);
  assert.equal(t.verdict.ok, false);
  assert.deepEqual(failed(t.verdict).map((x) => x.split(" ")[0]), ["SIM"]);
  assert.equal(t.reads.unclaimed, undefined);
  // a refusal at FRAME, COVER, READ or DECODE is never planned around, nor a passing verdict
  const wires = R.frames.map((x) => base64.decode(x));
  const bad = { err: SIM_ERR, wallet: 0n, accounts: {} };
  const v = checkSolanaTeardown(wires, W, await readsOf());
  assert.equal(v.ok, true);
  assert.equal(solanaTeardownUnclaimed(v, wires, [[bad, bad]]), null);
  for (const id of ["READ", "DECODE", "FRAME", "COVER"] as const) {
    const refused = { ...v, ok: false, results: v.results.map((x) => (x.id === id || x.id === "SIM" ? { ...x, ok: false } : x)) };
    assert.equal(solanaTeardownUnclaimed(refused, wires, [[bad, bad]]), null, id);
  }
  // the reason is bounded: each provider's error at most 120 characters
  const simOnly = { ...v, ok: false, results: v.results.map((x) => (x.id === "SIM" ? { ...x, ok: false } : x)) };
  const long = { err: "y".repeat(500), wallet: 0n, accounts: {} };
  assert.equal(solanaTeardownUnclaimed(simOnly, wires, [[long, long]])?.[SOLANA_PUMP_AMM_PROGRAM], `its claim did not simulate on either provider: A "${"y".repeat(119)}, B "${"y".repeat(119)}`);
});

// Review 6 of 13898c19, F1: a stranger's lamports at the wallet's unmade WSOL or USDC account, which a claim opens. The
// ATA program keeps them in the account it makes there and the wallet pays only the rest of the rent, so the wallet
// ends that much richer (WSOL: the close after the claim brings them back) and the check, which wanted the wallet's
// gain without them, refused every teardown: the cashback could never be claimed. The plan now carries them.
test("a stranger's lamports at the wallet's unmade WSOL and USDC accounts: each claim carries them, the check takes the wallet's gain with them, and a gain without them is refused", () => {
  const X = 1n;
  const Y = 7_000n;
  const sys = (lamports: bigint): SolanaHeldRead => ({ owner: SOLANA_SYSTEM_PROGRAM, lamports, data: new Uint8Array(0) });
  const accounts = { ...stableWorld({ to: sys(Y) }), [WSOL_W]: [sys(X), sys(X)] as const };
  const plan = solanaTeardownPlan(W, accounts);
  const sc = plan.claim.find((c) => c.program === SOLANA_PUMP_PROGRAM)!;
  const ac = plan.claim.find((c) => c.program === SOLANA_PUMP_AMM_PROGRAM)!;
  assert.deepEqual([ac.open, ac.prefund, sc.open, sc.prefund], [true, X, true, Y]);
  const frames = buildSolanaTeardown(W, plan, R.chain).map((f) => f.wire);
  const base = { accounts, wallet: [W0, W0] as const };
  // as the programs run it: WSOL's X comes back with the close, the USDC account keeps Y and the wallet pays rent - Y
  const real = stableSims(plan, 2_039_280n - Y);
  const s = { ...real[0][0], wallet: real[0][0].wallet + X };
  assert.deepEqual(failed(checkSolanaTeardown(frames, W, { ...base, simulations: [[s, s]] })), []);
  // a wallet that gains the lamports twice, or not at all, is refused
  for (const wallet of [s.wallet + X, s.wallet - X, s.wallet + Y]) assert.match(failed(checkSolanaTeardown(frames, W, { ...base, simulations: [[{ ...s, wallet }, { ...s, wallet }]] })).join(" | "), /SIM .*the wallet gains/);
  // a USDC account opened with less than the lamports there before is refused
  const less = { ...s, accounts: { ...s.accounts, [sc.to]: Y - 1n } };
  assert.match(failed(checkSolanaTeardown(frames, W, { ...base, simulations: [[less, less]] })).join(" | "), /opened with 6999 lamports/);
  // the two providers' raw reads of an unmade account must agree on its lamports
  assert.throws(() => solanaTeardownPlan(W, { ...accounts, [WSOL_W]: [sys(X), null] as const }), /the providers disagree on .*: 1\/0 lamports/);
});

// Card signers-own-bytes: the bytes solanaTeardownChecked checks are copies taken before it simulates and handed to no
// one. A frame changed while it simulates is refused (review 5 F6), so the bytes simulated are the bytes checked; and a
// frame whose bytes read differently afterwards (an accessor here: any holder of the frame that changes it later) is never
// what is judged, planned around or signed (review 5 F4: the reviewer's mutants T1 and T4 die here, T6 and T7 below).
/** The frame's first byte of its fee payer (after the signatures, the v0 prefix, the header and the key count): every check refuses its change. */
const payerByte = (wire: Uint8Array): number => 1 + 64 * wire[0]! + 1 + 3 + 1;
/** Makes `f.wire` read as itself once (the refusal's read), then as `later` on every read after. */
/** The recorded wallet's lamports on each provider, as readsOf reads them. */
const WALLET: [bigint, bigint] = [W0, BigInt(R.reads[1]!.value[0]!.lamports)];
const readsLater = (f: SolanaAssembled, later: Uint8Array): void => {
  const first = f.wire;
  let n = 0;
  Object.defineProperty(f, "wire", { configurable: true, enumerable: true, get: () => (n++ === 0 ? first : later) });
};

test("solanaTeardownChecked refuses a frame changed while it simulates, in place or replaced: the bytes simulated are the bytes checked and signed (review 5 F6)", async () => {
  // the recorded wallet: its one frame rebuilds byte for byte and its recorded simulations pass
  const plan = solanaTeardownPlan(W, ACCOUNTS);
  const recorded = (await readsOf()).simulations;
  const sims = (_fs: readonly SolanaAssembled[]) => recorded;
  const changes: [string, (f: SolanaAssembled) => void][] = [
    ["a signature byte flipped in place", (f) => { f.wire[1] = (f.wire[1]! ^ 1) & 0xff; }],
    ["the fee payer's byte flipped in place", (f) => { const k = payerByte(f.wire); f.wire[k] = (f.wire[k]! ^ 1) & 0xff; }],
    ["the wire replaced by other bytes", (f) => { (f as { wire: Uint8Array }).wire = Uint8Array.from(f.wire, (b, j) => (j === f.wire.length - 1 ? b ^ 1 : b)); }],
    ["the wire cut short", (f) => { (f as { wire: Uint8Array }).wire = f.wire.slice(0, -1); }],
  ];
  for (const [name, change] of changes) {
    await assert.rejects(
      solanaTeardownChecked(W, plan, ACCOUNTS, WALLET, R.chain, async (fs) => {
        const out = sims(fs);
        change(fs[0]!);
        return out;
      }),
      /teardown frame 0 changed while it simulated/,
      name,
    );
  }
  // the same bytes in a new array are the same frame
  const t = await solanaTeardownChecked(W, plan, ACCOUNTS, WALLET, R.chain, async (fs) => {
    const out = sims(fs);
    (fs[0] as { wire: Uint8Array }).wire = Uint8Array.from(fs[0]!.wire);
    return out;
  });
  assert.equal(t.verdict.ok, true);
});

test("the verdict judges the copies, never the frames: a frame whose bytes read otherwise after it simulated leaves the copies' verdict passing while the frames' fails (review 5 F4, mutant T1)", async () => {
  const plan = solanaTeardownPlan(W, ACCOUNTS);
  const recorded = (await readsOf()).simulations;
  const built = buildSolanaTeardown(W, plan, R.chain).map((f) => Uint8Array.from(f.wire));
  const evil = built.map((w) => { const e = Uint8Array.from(w); const k = payerByte(e); e[k] = e[k]! ^ 1; return e; });
  const t = await solanaTeardownChecked(W, plan, ACCOUNTS, WALLET, R.chain, async (fs) => {
    const out = recorded;
    fs.forEach((f, i) => readsLater(f, evil[i]!));
    return out;
  });
  assert.equal(t.wires.length, built.length);
  t.wires.forEach((w, i) => assert.deepEqual(w, built[i], `frame ${i}: the checked copy is the frame as built`));
  assert.deepEqual(failed(t.verdict), [], "the verdict is the copies', and they pass");
  assert.deepEqual(t.frames.map((f) => f.wire), evil, "the frames now read otherwise");
  assert.equal(checkSolanaTeardown(t.frames.map((f) => f.wire), W, t.reads).ok, false, "the frames' own bytes are refused");
});

test("the re-plan around a claim that does not simulate reads the copies, never the frames: with two claims, the copies name the failing one alone while the frames, read otherwise afterwards, would turn both off (review 5 F4, mutant T4)", async () => {
  const accounts = stableWorld();
  const plan = solanaTeardownPlan(W, accounts);
  assert.deepEqual(plan.claim.map((c) => c.program).sort(), [SOLANA_PUMP_AMM_PROGRAM, SOLANA_PUMP_PROGRAM].sort());
  // the v2 claim's instruction in the frame's own bytes: both providers name it as failing
  const failOnPump = (f: SolanaAssembled) => {
    const m = solanaDecodeMessage(f.wire.subarray(65));
    const i = m.instructions.findIndex((x) => m.staticKeys[x.programIndex] === SOLANA_PUMP_PROGRAM && x.data.length === 8 && x.data.every((b, j) => b === SOLANA_CLAIM_CASHBACK_V2[j]));
    assert.ok(i >= 0);
    const e = { err: { InstructionError: [i, { Custom: 6000 }] }, wallet: 0n, accounts: {} };
    return [e, e] as const;
  };
  let calls = 0;
  const t = await solanaTeardownChecked(W, plan, accounts, [W0, W0], R.chain, async (fs) => {
    calls++;
    if (calls > 1) return fs.map((f) => [cleanSim(plan, f), cleanSim(plan, f)] as const);
    const last = fs.length - 1;
    const out = fs.map((f, i) => (i === last ? failOnPump(f) : [cleanSim(plan, f), cleanSim(plan, f)] as const));
    // then every frame reads as a cut-short wire: no instruction in it names a program, so it would turn every claim off
    fs.forEach((f) => readsLater(f, f.wire.slice(0, 70)));
    return out;
  });
  assert.equal(calls, 2, "planned around once: the PumpSwap claim never failed");
  assert.deepEqual(Object.keys(t.reads.unclaimed ?? {}), [SOLANA_PUMP_PROGRAM], "only the claim the copies name as failing goes off");
  assert.deepEqual(t.plan.claim.map((c) => c.program), [SOLANA_PUMP_AMM_PROGRAM], "the PumpSwap claim stays");
});

test("the trade flow registers a teardown frame only after its verdict passes, and only with the copy checked (review 5 F4, mutants T6 and T7)", () => {
  // the frames never leave the flow (its simulation sends providers base64 of the bytes), so after the F6 refusal a
  // swap of either line changes nothing a run can see today; this holds the shape that keeps it so
  const src = readFileSync(new URL("../src/trade/solana/flow.ts", import.meta.url), "utf8");
  assert.match(src, /\n {2}const \{ frames, wires: checkedWires, verdict \} = await solanaTeardownChecked\([^\n]*\n {2}if \(!verdict\.ok \|\| frames\.length === 0\) return \{ verdict, frames: frames\.length, [^\n]*\n {2}frames\.forEach\(\(f, i\) => ownSolanaWire\(f, checkedWires\[i\]!\)\);\n/);
  assert.equal(src.match(/ownSolanaWire\(/g)?.length, 2, "the legs' one and the teardown's one");
  assert.doesNotMatch(src, /ownSolanaWire\([^,()]+, [^()]*\.wire\)/, "never registered with its own wire");
});
