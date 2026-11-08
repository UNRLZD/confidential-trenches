/// <reference types="node" />
// One planted bad case per rule of the teardown check (checkSolanaTeardown and solanaTeardownPlan): each case is
// refused by the check as it stands, and each would pass if its rule were removed. The world is the recorded wallet
// BJDTm4fj… (test/fixtures/solana-teardown.json): an SPL Token account with no tokens and both pump volume accounts.
// Frames are compiled here by hand (static keys only), so a case can hold what buildSolanaTeardown never makes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { base58, base64 } from "@scure/base";
import {
  SOLANA_CLOSE_VOLUME_ACCUMULATOR,
  SOLANA_COMPUTE_BUDGET_PROGRAM,
  SOLANA_PUMP_AMM_PROGRAM,
  SOLANA_PUMP_PROGRAM,
  SOLANA_SYSTEM_PROGRAM,
  SOLANA_TOKEN_2022_PROGRAM,
  SOLANA_TOKEN_PROGRAM,
  checkSolanaTeardown,
  solanaEventAuthority,
  solanaTeardownPlan,
  solanaVolumeAccumulator,
  type SolanaHeldRead,
  type SolanaTeardownReads,
  type SolanaTeardownSimulation,
} from "../src/checks/solana/checks.ts";
import { solanaAta } from "../src/checks/solana/message.ts";
import { buildSolanaTeardown } from "../src/trade/solana/build.ts";

type RawAcc = { owner: string; lamports: number; data: [string, string] } | null;
const F = JSON.parse(readFileSync(new URL("./fixtures/solana-teardown.json", import.meta.url), "utf8")) as {
  wallets: { wallet: string; addresses: string[]; reads: { value: RawAcc[] }[]; chain: { blockhash: string } }[];
};
const R = F.wallets.find((w) => w.wallet === "BJDTm4fjHgMjSLAMe9sYdrjjvEY13wQBZRMj5WWNhmLz")!;
const W = R.wallet;
const held = (a: RawAcc): SolanaHeldRead | null => (a ? { owner: a.owner, lamports: BigInt(a.lamports), data: base64.decode(a.data[0]) } : null);
const ACCOUNTS = Object.fromEntries(R.addresses.map((x, i) => [x, [held(R.reads[0]!.value[i + 1]!), held(R.reads[1]!.value[i + 1]!)] as const]));
const W0 = BigInt(R.reads[0]!.value[0]!.lamports);
const PLAN = solanaTeardownPlan(W, ACCOUNTS);
const TOK = PLAN.close.find((h) => h.kind === "token")!;
const UVA_P = solanaVolumeAccumulator(W, SOLANA_PUMP_PROGRAM);
const UVA_A = solanaVolumeAccumulator(W, SOLANA_PUMP_AMM_PROGRAM);
const LAM = new Map(PLAN.close.map((h) => [h.address, h.lamports]));
const STRANGER = "9Egm6XfbVdNpL7ouFfmeRjnLsYJUE4qh8AuVFjHyKrCp";

type A = { key: string; signer: boolean; writable: boolean };
type I = { program: string; accounts: A[]; data: number[] };
const a = (key: string, signer = false, writable = false): A => ({ key, signer, writable });
const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const u64 = (n: bigint) => Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
const compact = (n: number) => (n < 0x80 ? [n] : [(n & 0x7f) | 0x80, n >> 7]);

// A v0 wire with only static keys: signers (payer first) writable then read-only, then the rest writable then read-only.
function wire(ixs: I[], payer = W, lookup = false): Uint8Array {
  const meta = new Map<string, { s: boolean; w: boolean }>([[payer, { s: true, w: true }]]);
  const touch = (k: string, s: boolean, w: boolean) => { const o = meta.get(k) ?? { s: false, w: false }; meta.set(k, { s: o.s || s, w: o.w || w }); };
  for (const x of ixs) { touch(x.program, false, false); for (const y of x.accounts) touch(y.key, y.signer, y.writable); }
  const e = [...meta];
  const g = (s: boolean, w: boolean) => e.filter(([k, m]) => m.s === s && m.w === w && !(s && w && k === payer)).map(([k]) => k);
  const keys = [payer, ...g(true, true), ...g(true, false), ...g(false, true), ...g(false, false)];
  const sig = 1 + g(true, true).length + g(true, false).length;
  const at = (k: string) => keys.indexOf(k);
  const m = [0x80, sig, g(true, false).length, g(false, false).length, ...compact(keys.length), ...keys.flatMap((k) => [...base58.decode(k)]), ...base58.decode(R.chain.blockhash), ...compact(ixs.length)];
  for (const x of ixs) m.push(at(x.program), ...compact(x.accounts.length), ...x.accounts.map((y) => at(y.key)), ...compact(x.data.length), ...x.data);
  if (lookup) m.push(1, ...base58.decode(STRANGER), 1, 0, 0);
  else m.push(0);
  return Uint8Array.from([sig, ...new Array(64 * sig).fill(0), ...m]);
}
const limit = (n: number): I => ({ program: SOLANA_COMPUTE_BUDGET_PROGRAM, accounts: [], data: [2, ...u32(n)] });
const price = (n: bigint): I => ({ program: SOLANA_COMPUTE_BUDGET_PROGRAM, accounts: [], data: [3, ...u64(n)] });
const close = (acc: string, o: { dest?: string; auth?: string; program?: string; destWritable?: boolean } = {}): I => ({
  program: o.program ?? TOK.program,
  accounts: [a(acc, false, true), a(o.dest ?? W, false, o.destWritable ?? true), a(o.auth ?? W, (o.auth ?? W) === W, false)],
  data: [9],
});
const vclose = (p: string, o: { ev?: string; data?: number[] } = {}): I => ({
  program: p,
  accounts: [a(W, true, true), a(solanaVolumeAccumulator(W, p), false, true), a(o.ev ?? solanaEventAuthority(p)), a(p)],
  data: o.data ?? [...SOLANA_CLOSE_VOLUME_ACCUMULATOR],
});
const harvest = (mint: string, acc: string): I => ({ program: SOLANA_TOKEN_2022_PROGRAM, accounts: [a(mint, false, true), a(acc, false, true)], data: [26, 4] });
const S4 = (): I[] => [limit(6_600), close(TOK.address)];
const S5 = (): I[] => [limit(50_600), vclose(SOLANA_PUMP_PROGRAM), vclose(SOLANA_PUMP_AMM_PROGRAM)];

// Honest simulations for a frame set: what each frame closes is gone, the wallet up by those lamports less the fee.
function sims(frames: I[][], fees?: bigint[]): [SolanaTeardownSimulation, SolanaTeardownSimulation][] {
  return frames.map((f, i) => {
    const closes = f.flatMap((x) => (x.data[0] === 9 ? [x.accounts[0]!.key] : x.program === SOLANA_PUMP_PROGRAM || x.program === SOLANA_PUMP_AMM_PROGRAM ? [x.accounts[1]!.key] : []));
    const gain = [...new Set(closes)].reduce((n, k) => n + (LAM.get(k) ?? 0n), 0n);
    const s: SolanaTeardownSimulation = { err: null, wallet: W0 + gain - (fees?.[i] ?? 5_000n), accounts: Object.fromEntries(closes.map((k) => [k, null])) };
    return [s, s];
  });
}
const reads = (frames: I[][], o: Partial<SolanaTeardownReads> = {}): SolanaTeardownReads => ({ accounts: ACCOUNTS, wallet: [W0, W0], simulations: sims(frames), ...o });
const run = (frames: I[][], o: Partial<SolanaTeardownReads> = {}, payer = W) => checkSolanaTeardown(frames.map((f) => wire(f, payer)), W, reads(frames, o));
const failing = (v: ReturnType<typeof checkSolanaTeardown>, id: string) => v.results.filter((r) => r.id === id && !r.ok).map((r) => r.detail).join(" | ");

test("baseline: the hand-compiled S-4 and S-5 pass every check, at a price too", () => {
  assert.deepEqual(run([S4(), S5()]).results.filter((r) => !r.ok), []);
  // With a price the fee holds price x limit: 5,000 + ceil(1,000 x 6,600 / 1e6) = 5,007.
  const priced = [[limit(6_600), price(1_000n), close(TOK.address)], S5()];
  const v = checkSolanaTeardown(priced.map((f) => wire(f)), W, { accounts: ACCOUNTS, wallet: [W0, W0], simulations: sims(priced, [5_007n, 5_000n]) });
  assert.deepEqual(v.results.filter((r) => !r.ok), []);
});

const FRAME_CASES: [string, () => I[][], RegExp, string?][] = [
  ["the rent to a stranger", () => [[limit(6_600), close(TOK.address, { dest: STRANGER })], S5()], /close of/],
  ["a stranger as the close authority", () => [[limit(6_600), close(TOK.address, { auth: STRANGER })], S5()], /close of/],
  ["the close under the other token program", () => [[limit(6_600), close(TOK.address, { program: SOLANA_TOKEN_2022_PROGRAM })], S5()], /close of/],
  ["a close of a read-only account", () => [[limit(6_600), { ...close(TOK.address), accounts: [a(TOK.address, false, false), a(W, false, true), a(W, true, false)] }], S5()], /close of/],
  ["a System transfer beside the close", () => [[limit(6_600), close(TOK.address), { program: SOLANA_SYSTEM_PROGRAM, accounts: [a(W, true, true), a(STRANGER, false, true)], data: [...u32(2), ...u64(1_000_000n)] }], S5()], /program 1111/],
  ["a volume close naming a stranger as event authority", () => [S4(), [limit(50_600), vclose(SOLANA_PUMP_PROGRAM, { ev: STRANGER }), vclose(SOLANA_PUMP_AMM_PROGRAM)]], /instruction/],
  ["claim_cashback in place of the volume close", () => [S4(), [limit(50_600), vclose(SOLANA_PUMP_PROGRAM, { data: [37, 58, 35, 126, 190, 53, 228, 197] }), vclose(SOLANA_PUMP_AMM_PROGRAM)]], /instruction/],
  ["a heap frame request", () => [[limit(6_600), { program: SOLANA_COMPUTE_BUDGET_PROGRAM, accounts: [], data: [1, ...u32(256 * 1024)] }, close(TOK.address)], S5()], /compute budget/],
  ["a price above the cap", () => [[limit(6_600), price(1_000_001n), close(TOK.address)], S5()], /compute budget/],
  ["a frame that closes nothing", () => [S4(), S5(), [limit(600)]], /closes nothing/],
  ["a limit above the frame's instructions", () => [[limit(1_400_000), price(1_000_000n), close(TOK.address)], S5()], /compute limit 1400000/],
  ["no limit", () => [[close(TOK.address)], S5()], /compute limit unset/],
];
for (const [name, frames, detail] of FRAME_CASES) {
  test(`FRAME refuses ${name}`, () => {
    const v = run(frames());
    assert.match(failing(v, "FRAME"), detail, JSON.stringify(v.results));
  });
}

test("FRAME refuses a second signer, and a stranger paying the fee", () => {
  const two = run([[limit(6_600), close(TOK.address, { auth: STRANGER }), { program: SOLANA_SYSTEM_PROGRAM, accounts: [a(STRANGER, true, true), a(W, false, true)], data: [...u32(2), ...u64(1n)] }], S5()]);
  assert.match(failing(two, "FRAME"), /signers/);
  const paid = checkSolanaTeardown([wire(S4(), STRANGER), wire(S5())], W, reads([S4(), S5()]));
  assert.match(failing(paid, "FRAME"), /signers/);
});

test("DECODE refuses a frame that loads a lookup table", () => {
  const v = checkSolanaTeardown([wire(S4(), W, true), wire(S5())], W, reads([S4(), S5()]));
  // (Without this rule the key resolution still refuses, as it reads no table: the rule names the cause.)
  assert.match(failing(v, "DECODE"), /^frame 0: lookup tables$/);
});

test("COVER refuses an account closed twice", () => {
  const v = run([S4(), [limit(75_600), vclose(SOLANA_PUMP_PROGRAM), vclose(SOLANA_PUMP_PROGRAM), vclose(SOLANA_PUMP_AMM_PROGRAM)]]);
  assert.match(failing(v, "COVER"), new RegExp(`${UVA_P} closed 2 times`));
});

// ---- SIM

const base = [S4(), S5()];
const simCase = (edit: (s: [SolanaTeardownSimulation | null, SolanaTeardownSimulation | null][]) => void) => {
  const s = sims(base) as [SolanaTeardownSimulation | null, SolanaTeardownSimulation | null][];
  edit(s);
  return checkSolanaTeardown(base.map((f) => wire(f)), W, { accounts: ACCOUNTS, wallet: [W0, W0], simulations: s });
};
test("SIM refuses: fewer simulations than frames, an error, a provider missing, a closed account not read back, a lamport short", () => {
  assert.match(failing(checkSolanaTeardown(base.map((f) => wire(f)), W, { accounts: ACCOUNTS, wallet: [W0, W0], simulations: sims(base).slice(0, 1) }), "SIM"), /1 simulations for 2 frames/);
  assert.match(failing(simCase((s) => { s[1] = [s[1]![0], { ...s[1]![1]!, err: { InstructionError: [1, { Custom: 6000 }] } }]; }), "SIM"), /simulation error/);
  assert.match(failing(simCase((s) => { s[0] = [s[0]![0], null]; }), "SIM"), /frame 0 provider B: no simulation/);
  assert.match(failing(simCase((s) => { s[1] = [s[1]![0], { ...s[1]![1]!, accounts: { [UVA_P]: null } }]; }), "SIM"), new RegExp(`${UVA_A} not read after`));
  assert.match(failing(simCase((s) => { s[0] = [{ ...s[0]![0]!, wallet: s[0]![0]!.wallet - 1n }, s[0]![1]]; }), "SIM"), /the wallet gains/);
});

// ---- READ: the plan

const T22 = SOLANA_TOKEN_2022_PROGRAM;
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
function token(o: { program?: string; owner?: string; mint?: string; amount?: bigint; state?: number; native?: boolean; closeAuth?: string; exts?: [number, number[]][]; len?: number }): SolanaHeldRead {
  const program = o.program ?? T22;
  const tlv = (o.exts ?? []).flatMap(([t, d]) => [t & 0xff, t >> 8, d.length & 0xff, d.length >> 8, ...d]);
  const d = new Uint8Array(o.len ?? (tlv.length ? 166 + tlv.length : 165));
  d.set(base58.decode(o.mint ?? MINT), 0);
  d.set(base58.decode(o.owner ?? W), 32);
  d.set(u64(o.amount ?? 0n), 64);
  d[108] = o.state ?? 1;
  if (o.native) d.set([1, 0, 0, 0], 109);
  if (o.closeAuth) { d.set([1, 0, 0, 0], 129); d.set(base58.decode(o.closeAuth), 133); }
  if (d.length > 165) d[165] = 2;
  if (tlv.length) d.set(tlv, 166);
  return { owner: program, lamports: 2_039_280n, data: d };
}
const ADDR = solanaAta(W, MINT, T22);
const planOf = (x: SolanaHeldRead, y: SolanaHeldRead = x, at = ADDR) => solanaTeardownPlan(W, { [at]: [x, y] });
const why = (x: SolanaHeldRead) => planOf(x).keep.map((k) => k.why).join("; ");

test("the plan keeps what CloseAccount refuses or must not take", () => {
  assert.equal(why(token({ closeAuth: STRANGER })), `close authority ${STRANGER}`);
  assert.equal(why(token({ exts: [[5, new Array(8).fill(0)]] })), "confidential balance");
  assert.equal(why(token({ exts: [[17, new Array(8).fill(0)]] })), "confidential balance");
  // A native (wSOL) account closes with its wrapped lamports in it.
  assert.deepEqual(planOf(token({ program: SOLANA_TOKEN_PROGRAM, native: true, amount: 5n })).close.map((h) => h.address), [ADDR]);
});

test("the plan harvests only withheld fees there are", () => {
  const fee = (w: bigint) => token({ exts: [[2, u64(w)], [7, []]] });
  assert.deepEqual(planOf(fee(3n)).close.map((h) => h.kind === "token" && h.harvest), [true]);
  assert.deepEqual(planOf(fee(0n)).close.map((h) => h.kind === "token" && h.harvest), [false]);
  // Harvest under SPL Token never happens: the extension exists only on Token-2022.
  assert.deepEqual(planOf(token({ exts: [[7, []]] })).close.map((h) => h.kind === "token" && h.harvest), [false]);
});

test("the plan refuses reads it cannot trust", () => {
  assert.throws(() => planOf(token({}), { ...token({}), lamports: 1n }), /disagree/);
  assert.throws(() => planOf(token({}), { ...token({}), owner: SOLANA_TOKEN_PROGRAM }), /disagree/);
  assert.throws(() => planOf({ owner: SOLANA_SYSTEM_PROGRAM, lamports: 1n, data: new Uint8Array(0) }), /not a token program/);
  assert.throws(() => planOf(token({ program: SOLANA_TOKEN_PROGRAM, len: 166 })), /not a token account/);
  assert.throws(() => planOf(token({ owner: STRANGER })), /not the wallet's/);
  const v = checkSolanaTeardown([], W, { accounts: ACCOUNTS, wallet: [W0, W0 + 1n], simulations: [] });
  assert.match(failing(v, "READ"), /wallet's lamports/);
});

// The volume accounts: the recorded pump one, edited field by field.
const VOL = ACCOUNTS[UVA_P]![0]!;
const VOL_A = ACCOUNTS[UVA_A]![0]!;
const vol = (src: SolanaHeldRead, at: number, bytes: number[]) => { const d = Uint8Array.from(src.data); d.set(bytes, at); return { ...src, data: d }; };
const vwhy = (x: SolanaHeldRead, at = UVA_P) => planOf(x, x, at).keep.map((k) => k.why).join("; ");

test("the plan keeps a volume account while anything is owed through it", () => {
  assert.equal(vwhy(vol(VOL, 40, [1])), "unclaimed incentive tokens 0");
  assert.equal(vwhy(vol(VOL, 41, u64(9n))), "unclaimed incentive tokens 9");
  assert.equal(vwhy(vol(VOL, 57, u64(1n))), "volume 1 not settled");
  // PumpSwap cashback: earned @74 above claimed @82.
  // (Its claim cannot run here: the volume account's WSOL account is not among the reads, so it stays, with why.)
  assert.equal(vwhy(vol(VOL_A, 74, u64(12_742_862n)), UVA_A), "cashback 12742862 unclaimed (the volume account's So11111111111111111111111111111111111111112 account holds nothing read)");
  assert.equal(vwhy(vol(vol(VOL_A, 74, u64(5n)), 82, u64(5n)), UVA_A), "");
  // Pump's stable cashback: earned @90 above claimed @98. Pump's lamport cashback (@74) comes back with the close.
  assert.equal(vwhy(vol(VOL, 90, u64(7n))), "stable cashback 7 unclaimed (the volume account's EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v account holds nothing read)");
  assert.equal(vwhy(vol(VOL, 74, u64(7n))), "");
});

test("the plan refuses a volume account that is not the wallet's", () => {
  assert.throws(() => planOf({ ...VOL, owner: SOLANA_PUMP_AMM_PROGRAM }, undefined, UVA_P), /is owned by/);
  assert.throws(() => planOf(vol(VOL, 8, [...base58.decode(STRANGER)]), undefined, UVA_P), /not the wallet's volume account/);
});

// ---- harvests, on two Token-2022 accounts of the wallet: FEE holds withheld fees, NOFEE has the extension at 0

const FEE_MINT = "So11111111111111111111111111111111111111112";
const NOFEE_MINT = MINT;
const FEE = solanaAta(W, FEE_MINT, T22);
const NOFEE = solanaAta(W, NOFEE_MINT, T22);
const HARVEST_READS = {
  [FEE]: [token({ mint: FEE_MINT, exts: [[2, u64(3n)]] }), token({ mint: FEE_MINT, exts: [[2, u64(3n)]] })] as const,
  [NOFEE]: [token({ exts: [[2, u64(0n)]] }), token({ exts: [[2, u64(0n)]] })] as const,
};
const t22close = (acc: string) => close(acc, { program: T22 });
const harvestFrame = (ixs: I[]) => checkSolanaTeardown([wire(ixs)], W, { accounts: HARVEST_READS, wallet: [W0, W0], simulations: [[null, null]] });

test("harvest frames: the honest one passes FRAME and COVER; each misplaced harvest is refused", () => {
  const ok = harvestFrame([limit(20_600), harvest(FEE_MINT, FEE), t22close(FEE), t22close(NOFEE)]);
  assert.deepEqual(ok.results.filter((r) => !r.ok).map((r) => r.id), ["SIM"]);
  // Not right before its close.
  assert.match(failing(harvestFrame([limit(20_600), harvest(FEE_MINT, FEE), t22close(NOFEE), t22close(FEE)]), "FRAME"), new RegExp(`harvest of ${FEE}`));
  // Another mint named.
  assert.match(failing(harvestFrame([limit(20_600), harvest(NOFEE_MINT, FEE), t22close(FEE), t22close(NOFEE)]), "FRAME"), new RegExp(`harvest of ${FEE}`));
  // A harvest the plan does not ask for (no fees withheld: a harvest into a closed mint would sink the frame).
  assert.match(failing(harvestFrame([limit(28_600), harvest(FEE_MINT, FEE), t22close(FEE), harvest(NOFEE_MINT, NOFEE), t22close(NOFEE)]), "FRAME"), new RegExp(`harvest of ${NOFEE}`));
});

test("the plan refuses an SPL Token account longer than 165 bytes", () => {
  assert.throws(() => planOf(token({ program: SOLANA_TOKEN_PROGRAM, len: 166 })), /166 bytes is not a token account/);
});

// ---- burns (card sol-rent-back-dust-burn): a balance the caller names burned, exactly, right before its close

const DUST_MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
const DUST = solanaAta(W, DUST_MINT, T22);
const SPL_DUST = solanaAta(W, DUST_MINT, SOLANA_TOKEN_PROGRAM);
const OTHER_MINT = "So11111111111111111111111111111111111111112";
const OTHER = solanaAta(W, NOFEE_MINT, T22);
const dust = (o: Parameters<typeof token>[0] = {}) => token({ mint: DUST_MINT, amount: 1n, exts: [[7, []]], ...o });
const burnIx = (acc: string, mint: string, n: bigint, o: { program?: string; auth?: string; signer?: boolean } = {}): I => ({
  program: o.program ?? T22,
  accounts: [a(acc, false, true), a(mint, false, true), a(o.auth ?? W, o.signer ?? true, false)],
  data: [8, ...u64(n)],
});
const DUST_READS = { [DUST]: [dust(), dust()] as const, [OTHER]: [token({ amount: 1n, exts: [[7, []]] }), token({ amount: 1n, exts: [[7, []]] })] as const };
// Honest simulations: DUST gone, the wallet up by its rent less the fee.
const burnSims = (n = 1): [SolanaTeardownSimulation, SolanaTeardownSimulation][] => {
  const s: SolanaTeardownSimulation = { err: null, wallet: W0 + 2_039_280n - 5_000n, accounts: { [DUST]: null } };
  return Array.from({ length: n }, () => [s, s]);
};
const burnRun = (ixs: I[][], o: Partial<SolanaTeardownReads> = {}) => checkSolanaTeardown(ixs.map((f) => wire(f)), W, { accounts: DUST_READS, wallet: [W0, W0], simulations: burnSims(ixs.length), burn: [DUST], ...o });
const BURN_OK = (): I[] => [limit(14_600), burnIx(DUST, DUST_MINT, 1n), t22close(DUST)];

test("the plan burns only a balance the caller names, on an account that would close but for it", () => {
  const at = (x: SolanaHeldRead, burn: string[], addr = DUST) => solanaTeardownPlan(W, { [addr]: [x, x] }, undefined, burn);
  // named: burned exactly, then closed; not named: kept holding it, as before
  assert.deepEqual(at(dust(), [DUST]).close.map((h) => h.kind === "token" && h.burn), [1n]);
  assert.deepEqual(at(dust(), []).keep.map((k) => k.why), [`holds 1 of ${DUST_MINT}`]);
  assert.deepEqual(at(dust({ amount: 123_456n }), [DUST]).close.map((h) => h.kind === "token" && h.burn), [123_456n]);
  // SPL Token, no extensions at all
  assert.deepEqual(at(dust({ program: SOLANA_TOKEN_PROGRAM, exts: [] }), [SPL_DUST], SPL_DUST).close.map((h) => h.kind === "token" && h.burn), [1n]);
  // an empty account named burns nothing (it closes as before)
  assert.deepEqual(at(dust({ amount: 0n }), [DUST]).close.map((h) => h.kind === "token" && h.burn), [undefined]);
  // Token-2022 with any extension but ImmutableOwner: kept, with the extension named (a fee 2, a hook account 15,
  // a memo 8, a CPI guard 11, a non-transferable 13, a paused 27 account)
  for (const t of [2, 8, 11, 13, 15, 27]) assert.deepEqual(at(dust({ exts: [[7, []], [t, t === 2 ? u64(0n) : [0]]] }), [DUST]).keep.map((k) => k.why), [`holds 1 of ${DUST_MINT} (no burn: Token-2022 extension ${t})`], `extension ${t}`);
  // frozen, another close authority, a confidential balance: kept as before
  assert.deepEqual(at(dust({ state: 2 }), [DUST]).keep.map((k) => k.why), ["frozen"]);
  assert.deepEqual(at(dust({ closeAuth: STRANGER }), [DUST]).keep.map((k) => k.why), [`close authority ${STRANGER}`]);
  // the wallet's account a cashback claim pays into (USDC under SPL Token) is never burned
  const usdc = solanaAta(W, MINT, SOLANA_TOKEN_PROGRAM);
  assert.deepEqual(at(token({ program: SOLANA_TOKEN_PROGRAM, amount: 1n }), [usdc], usdc).keep.map((k) => k.why), [`holds 1 of ${MINT}`]);
  // a native (wSOL) account named closes with its lamports, nothing burned
  assert.deepEqual(at(token({ program: SOLANA_TOKEN_PROGRAM, native: true, amount: 5n, mint: OTHER_MINT }), [DUST]).close.map((h) => h.kind === "token" && h.burn), [undefined]);
});

test("burn frames: the honest one passes every check; the builder makes it", () => {
  assert.deepEqual(burnRun([BURN_OK()]).results.filter((r) => !r.ok), []);
  const plan = solanaTeardownPlan(W, DUST_READS, undefined, [DUST]);
  const built = buildSolanaTeardown(W, plan, { blockhash: R.chain.blockhash, lastValidBlockHeight: 1 });
  assert.equal(built.length, 1);
  const v = checkSolanaTeardown(built.map((f) => f.wire), W, { accounts: DUST_READS, wallet: [W0, W0], simulations: burnSims(), burn: [DUST] });
  assert.deepEqual(v.results.filter((r) => !r.ok), []);
  assert.equal(built[0]!.cuLimit, 14_600);
});

const BURN_CASES: [string, () => I[][], string, RegExp][] = [
  ["a burn over the balance", () => [[limit(14_600), burnIx(DUST, DUST_MINT, 2n), t22close(DUST)]], "FRAME", /burn of 2 from/],
  ["a burn under the balance", () => [[limit(14_600), burnIx(DUST, DUST_MINT, 0n), t22close(DUST)]], "FRAME", /burn of 0 from/],
  ["a burn naming another mint", () => [[limit(14_600), burnIx(DUST, OTHER_MINT, 1n), t22close(DUST)]], "FRAME", /burn of 1 from .* of So111/],
  ["a burn of another of the wallet's accounts", () => [[limit(22_600), burnIx(OTHER, NOFEE_MINT, 1n), burnIx(DUST, DUST_MINT, 1n), t22close(DUST)]], "FRAME", new RegExp(`burn of 1 from ${OTHER}`)],
  ["a burn of a stranger's account", () => [[limit(22_600), burnIx(STRANGER, DUST_MINT, 1n), burnIx(DUST, DUST_MINT, 1n), t22close(DUST)]], "FRAME", new RegExp(`burn of 1 from ${STRANGER}`)],
  ["a burn under the other token program", () => [[limit(14_600), burnIx(DUST, DUST_MINT, 1n, { program: SOLANA_TOKEN_PROGRAM }), t22close(DUST)]], "FRAME", /burn of 1 from/],
  ["a burn a stranger signs", () => [[limit(14_600), burnIx(DUST, DUST_MINT, 1n, { auth: STRANGER }), t22close(DUST)]], "FRAME", /burn of 1 from/],
  ["a burn not right before its close", () => [[limit(22_600), burnIx(DUST, DUST_MINT, 1n), burnIx(DUST, DUST_MINT, 1n), t22close(DUST)]], "FRAME", /burn of 1 from/],
  ["a close with no burn first", () => [[limit(6_600), t22close(DUST)]], "COVER", new RegExp(`${DUST} burned 0 times`)],
];
for (const [name, frames, id, detail] of BURN_CASES) {
  test(`${id} refuses ${name}`, () => {
    const v = burnRun(frames());
    assert.match(failing(v, id), detail, JSON.stringify(v.results));
  });
}

test("FRAME refuses a burn the plan has not asked for: none named, or a Token-2022 account with a hook or a fee extension", () => {
  assert.match(failing(burnRun([BURN_OK()], { burn: [] }), "FRAME"), new RegExp(`burn of 1 from ${DUST}`));
  for (const ext of [[15, [0]], [2, u64(0n)]] as [number, number[]][]) {
    const x = dust({ exts: [[7, []], ext] });
    const v = burnRun([BURN_OK()], { accounts: { [DUST]: [x, x] } });
    assert.match(failing(v, "FRAME"), new RegExp(`burn of 1 from ${DUST}`), `extension ${ext[0]}`);
    assert.match(failing(v, "FRAME"), new RegExp(`close of ${DUST}`), `extension ${ext[0]}`);
  }
});
