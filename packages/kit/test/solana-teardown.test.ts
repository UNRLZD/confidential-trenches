/// <reference types="node" />
// The teardown after a full sell (markets paper M1.4; 06c §3.1 S-4, S-5): replays real mainnet wallets that hold what a
// full sell leaves, recorded by test/fixtures/solana-teardown-capture.mjs (their accounts read on two public RPCs, the
// frames built from those reads, and every simulateTransaction answer of every frame on both RPCs, sigVerify false).
// Good: every account the plan closes is gone after its frame and the wallet gains every lamport less the fee. Bad: a
// frame set that leaves one open, or a simulation answer that shows one still holding lamports, is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { base58, base64 } from "@scure/base";
import {
  SOLANA_PUMP_AMM_PROGRAM,
  SOLANA_PUMP_PROGRAM,
  SOLANA_TOKEN_2022_PROGRAM,
  SOLANA_TEARDOWN_CU,
  SOLANA_TOKEN_PROGRAM,
  SOLANA_VOLUME_PROGRAMS,
  checkSolanaTeardown,
  solanaCashbackAccounts,
  solanaTeardownAddresses,
  solanaTeardownPlan,
  solanaVolumeAccumulator,
  type SolanaHeldRead,
  type SolanaTeardownPlan,
  type SolanaTeardownReads,
  type SolanaTeardownSimulation,
} from "../src/checks/solana/checks.ts";
import { solanaAta } from "../src/checks/solana/message.ts";
import { buildSolanaTeardown, simulateSolanaTeardown } from "../src/trade/solana/build.ts";
import type { SolanaRpc } from "../src/trade/solana/send.ts";

type RawAcc = { owner: string; lamports: number; data: [string, string] } | null;
type RawSim = { context: { slot: number }; value: { err: unknown; unitsConsumed: number; accounts: RawAcc[] } };
type Rec = {
  wallet: string;
  mints: { mint: string; program: string }[];
  addresses: string[];
  reads: { context: { slot: number }; value: RawAcc[] }[];
  chain: { blockhash: string; lastValidBlockHeight: number };
  frames: string[];
  sims: RawSim[][][];
};
const F = JSON.parse(readFileSync(new URL("./fixtures/solana-teardown.json", import.meta.url), "utf8")) as { readAt: string; rpcs: string[]; wallets: Rec[] };

const held = (a: RawAcc): SolanaHeldRead | null => (a ? { owner: a.owner, lamports: BigInt(a.lamports), data: base64.decode(a.data[0]) } : null);
const accountsOf = (w: Rec) => Object.fromEntries(w.addresses.map((x, i) => [x, [held(w.reads[0]!.value[i + 1]!), held(w.reads[1]!.value[i + 1]!)] as const]));
// The recorded answers, replayed in order through the device's own simulation call.
const replay = (answers: RawSim[]): SolanaRpc => {
  const q = [...answers];
  return async (method) => {
    assert.equal(method, "simulateTransaction");
    const a = q.shift();
    if (!a) throw new Error("no more recorded answers");
    return a;
  };
};
async function readsOf(w: Rec, sims: RawSim[][][] = w.sims): Promise<SolanaTeardownReads> {
  const simulations: [SolanaTeardownSimulation, SolanaTeardownSimulation][] = [];
  for (const [f, pair] of sims.entries()) {
    const wire = base64.decode(w.frames[f] as string);
    simulations.push([await simulateSolanaTeardown(replay(pair[0]!), wire, w.wallet, w.addresses), await simulateSolanaTeardown(replay(pair[1]!), wire, w.wallet, w.addresses)]);
  }
  return { accounts: accountsOf(w), wallet: [BigInt(w.reads[0]!.value[0]!.lamports), BigInt(w.reads[1]!.value[0]!.lamports)], simulations };
}
const failed = (v: ReturnType<typeof checkSolanaTeardown>) => v.results.filter((r) => !r.ok).map((r) => `${r.id} ${r.detail}`);
const volumeCount = (p: SolanaTeardownPlan) => p.close.filter((h) => h.kind === "volume").length;

test("recorded: real wallets on both pump programs, two providers each", () => {
  assert.ok(F.wallets.length >= 2);
  assert.deepEqual(F.rpcs.length, 2);
  for (const w of F.wallets) {
    const plan = solanaTeardownPlan(w.wallet, accountsOf(w));
    // Both volume accounts, the curve's and PumpSwap's, exist on every recorded wallet: each is closed or kept with its reason.
    for (const p of [SOLANA_PUMP_PROGRAM, SOLANA_PUMP_AMM_PROGRAM]) {
      const uva = solanaVolumeAccumulator(w.wallet, p);
      assert.ok(plan.close.some((h) => h.address === uva) !== plan.keep.some((k) => k.address === uva), `${w.wallet} ${p}`);
    }
    // Recorded 2026-11-02, before the claims' accounts joined the list (card solana-teardown-cashback): today's list
    // is the recorded one, then only those (test/solana-teardown-cashback.test.ts replays a capture of the full list).
    const today = solanaTeardownAddresses(w.wallet, w.mints);
    assert.deepEqual(today.slice(0, w.addresses.length), w.addresses);
    const claims = new Set(SOLANA_VOLUME_PROGRAMS.flatMap((p) => { const c = solanaCashbackAccounts(w.wallet, p); return [c.from, c.to]; }));
    for (const x of today.slice(w.addresses.length)) assert.ok(claims.has(x), x);
  }
  const plans = F.wallets.map((w) => solanaTeardownPlan(w.wallet, accountsOf(w)));
  assert.ok(plans.some((p) => p.close.some((h) => h.kind === "token" && h.program === SOLANA_TOKEN_PROGRAM)), "an SPL Token account to close");
  assert.ok(plans.some((p) => p.close.some((h) => h.kind === "token" && h.program === SOLANA_TOKEN_2022_PROGRAM)), "a Token-2022 account to close");
  assert.ok(plans.some((p) => volumeCount(p) === 2), "a wallet closing both volume accounts");
  assert.ok(plans.some((p) => p.keep.some((k) => /^holds /.test(k.why))), "a token account that stays, holding tokens");
  // GATRKVEP…: its PumpSwap volume account is owed cashback (earned 12,742,862 lamports of WSOL, none claimed); this
  // recording has no read of the volume account's WSOL account, so no claim can be planned and it stays out of every
  // frame; the good test below reads it untouched after the frame on both providers.
  const gatr = F.wallets.findIndex((w) => w.wallet === "GATRKVEPTF8smVdYcWVody5gUc768N2HxTfVDmcCb4zp");
  assert.ok(gatr >= 0);
  const uva = solanaVolumeAccumulator(F.wallets[gatr]!.wallet, SOLANA_PUMP_AMM_PROGRAM);
  assert.deepEqual(plans[gatr]!.keep, [{ address: uva, why: "cashback 12742862 unclaimed (the volume account's So11111111111111111111111111111111111111112 account holds nothing read)" }]);
  assert.ok(!plans[gatr]!.close.some((h) => h.address === uva));
});

test("good: the frames rebuild byte for byte from the reads, and every account the plan closes is gone with every lamport back", async () => {
  for (const w of F.wallets) {
    const accounts = accountsOf(w);
    const plan = solanaTeardownPlan(w.wallet, accounts);
    const frames = buildSolanaTeardown(w.wallet, plan, w.chain);
    assert.deepEqual(frames.map((f) => base64.encode(f.wire)), w.frames, w.wallet);
    const reads = await readsOf(w);
    const v = checkSolanaTeardown(frames.map((f) => f.wire), w.wallet, reads);
    assert.deepEqual(failed(v), [], w.wallet);
    // The post-state each simulation reports for every account the wallet held before: the ones its frame closes are
    // gone (0 lamports or no account) and the wallet is up by exactly their lamports less the 5,000-lamport fee; every
    // other account is untouched. Over all frames, every account the plan closes is gone once.
    const gone = new Set<string>();
    for (const [f, frame] of frames.entries()) {
      assert.ok(frame.size <= 1232);
      for (const sim of reads.simulations[f]!) {
        assert.equal(sim!.err, null);
        const closes = plan.close.filter((h) => sim!.accounts[h.address] === null || sim!.accounts[h.address] === 0n);
        assert.ok(closes.length > 0, `${w.wallet} frame ${f} closes nothing`);
        assert.equal(sim!.wallet - reads.wallet[0], closes.reduce((s, h) => s + h.lamports, 0n) - 5_000n, `${w.wallet} frame ${f}`);
        for (const x of w.addresses) {
          const before = accounts[x]![0];
          if (!closes.some((h) => h.address === x)) assert.equal(sim!.accounts[x], before ? before.lamports : null, `${x} untouched by frame ${f}`);
        }
        for (const h of closes) gone.add(h.address);
      }
      for (const p of [0, 1]) for (const a of w.sims[f]![p]!) assert.ok(a.value.unitsConsumed <= frame.cuLimit, `${a.value.unitsConsumed} CU > ${frame.cuLimit}`);
    }
    assert.deepEqual([...gone].sort(), plan.close.map((h) => h.address).sort(), w.wallet);
  }
});

test("bad: a frame set that leaves one account open is refused", async () => {
  for (const w of F.wallets) {
    const plan = solanaTeardownPlan(w.wallet, accountsOf(w));
    const reads = await readsOf(w);
    const wires = w.frames.map((x) => base64.decode(x));
    // The S-5 frame left out: every volume account the plan closes stays open.
    const noS5 = checkSolanaTeardown(wires.slice(0, -1), w.wallet, { ...reads, simulations: reads.simulations.slice(0, -1) });
    assert.equal(noS5.ok, false);
    const cover = failed(noS5).find((x) => x.startsWith("COVER")) ?? "";
    for (const h of plan.close.filter((x) => x.kind === "volume")) assert.ok(cover.includes(`${h.address} closed 0 times (want 1)`), cover);
    // The last volume account dropped from the plan the frames are built from: it alone is left open.
    const last = plan.close.filter((h) => h.kind === "volume").at(-1)!;
    const short = { ...plan, close: plan.close.filter((h) => h !== last) };
    const v = checkSolanaTeardown(buildSolanaTeardown(w.wallet, short, w.chain).map((f) => f.wire), w.wallet, reads);
    assert.equal(v.ok, false);
    assert.deepEqual(failed(v).filter((x) => x.startsWith("COVER")), [`COVER ${last.address} closed 0 times (want 1)`]);
  }
});

test("bad: a simulation answer that shows one closed account still holding its rent is refused", async () => {
  const w = F.wallets[0]!;
  const uva = solanaVolumeAccumulator(w.wallet, SOLANA_PUMP_AMM_PROGRAM);
  const at = w.addresses.indexOf(uva);
  const last = w.sims.length - 1;
  // Provider B's recorded answer for the S-5 frame, edited so the PumpSwap volume account keeps its 1,346,200 lamports
  // (simulateSolanaTeardown reads 3 addresses per call, after the wallet).
  const sims = structuredClone(w.sims);
  sims[last]![1]![Math.floor(at / 3)]!.value.accounts[(at % 3) + 1] = { owner: SOLANA_PUMP_AMM_PROGRAM, lamports: 1_346_200, data: ["", "base64"] };
  const v = checkSolanaTeardown(w.frames.map((x) => base64.decode(x)), w.wallet, await readsOf(w, sims));
  assert.equal(v.ok, false);
  assert.deepEqual(failed(v), [`SIM frame ${last} provider B: ${uva} still holds 1346200 lamports`]);
});

test("bad: an account closed twice, or closed under the wrong token program, is refused", async () => {
  const w = F.wallets.find((x) => solanaTeardownPlan(x.wallet, accountsOf(x)).close.some((h) => h.kind === "token"))!;
  const plan = solanaTeardownPlan(w.wallet, accountsOf(w));
  const reads = await readsOf(w);
  const tok = plan.close.find((h) => h.kind === "token")!;
  const wires = buildSolanaTeardown(w.wallet, plan, w.chain).map((f) => f.wire);
  const v1 = checkSolanaTeardown([...wires, wires[0]!], w.wallet, { ...reads, simulations: [...reads.simulations, reads.simulations[0]!] });
  assert.equal(v1.ok, false);
  assert.ok(failed(v1).join(" | ").includes(`${tok.address} closed 2 times (want 1)`), failed(v1).join(" | "));
  const wrongProgram: SolanaTeardownPlan = { ...plan, close: plan.close.map((h) => (h === tok ? { ...tok, program: tok.program === SOLANA_TOKEN_PROGRAM ? SOLANA_TOKEN_2022_PROGRAM : SOLANA_TOKEN_PROGRAM } : h)) };
  const v2 = checkSolanaTeardown(buildSolanaTeardown(w.wallet, wrongProgram, w.chain).map((f) => f.wire), w.wallet, reads);
  assert.equal(v2.ok, false);
  assert.match(failed(v2).join(" | "), /FRAME frame 0 ix 1: close of/);
});

// ---- Token-2022 withheld transfer fees (no recorded real account: built from the account layout)

const WALLET = "BJDTm4fjHgMjSLAMe9sYdrjjvEY13wQBZRMj5WWNhmLz";
const MINT = "9Egm6XfbVdNpL7ouFfmeRjnLsYJUE4qh8AuVFjHyKrCp";
// A Token-2022 account of WALLET: amount 0, initialized, with the TransferFeeAmount extension holding withheld fees.
function feeAccount(amount: bigint, withheld: bigint, state = 1): SolanaHeldRead {
  const d = new Uint8Array(165 + 1 + 4 + 8 + 4);
  d.set(base58.decode(MINT), 0);
  d.set(base58.decode(WALLET), 32);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  d[108] = state;
  d[165] = 2; // AccountType::Account
  new DataView(d.buffer).setUint16(166, 2, true); // TransferFeeAmount
  new DataView(d.buffer).setUint16(168, 8, true);
  new DataView(d.buffer).setBigUint64(170, withheld, true);
  new DataView(d.buffer).setUint16(178, 7, true); // ImmutableOwner, no data
  return { owner: SOLANA_TOKEN_2022_PROGRAM, lamports: 2_074_080n, data: d };
}
const feeAddr = solanaAta(WALLET, MINT, SOLANA_TOKEN_2022_PROGRAM);
const CHAIN = { blockhash: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi", lastValidBlockHeight: 1 };

test("withheld fees: a Token-2022 fee account is harvested right before its close; without the harvest it is refused", () => {
  const accounts = { [feeAddr]: [feeAccount(0n, 5n), feeAccount(0n, 5n)] as const };
  const plan = solanaTeardownPlan(WALLET, accounts);
  assert.deepEqual(plan.close.map((h) => h.kind === "token" && h.harvest), [true]);
  const [frame] = buildSolanaTeardown(WALLET, plan, CHAIN);
  assert.equal(frame!.cuLimit, 2 * SOLANA_TEARDOWN_CU.budget + SOLANA_TEARDOWN_CU.close + SOLANA_TEARDOWN_CU.harvest);
  const sim = { err: null, wallet: 2_074_080n - 5_000n, accounts: { [feeAddr]: null } };
  const ok = checkSolanaTeardown([frame!.wire], WALLET, { accounts, wallet: [0n, 0n], simulations: [[sim, sim]] });
  assert.deepEqual(failed(ok), []);
  const noHarvest = buildSolanaTeardown(WALLET, { ...plan, close: plan.close.map((h) => ({ ...h, harvest: false }) as typeof h) }, CHAIN);
  const v = checkSolanaTeardown(noHarvest.map((f) => f.wire), WALLET, { accounts, wallet: [0n, 0n], simulations: [[sim, sim]] });
  assert.equal(v.ok, false);
  assert.deepEqual(failed(v), [`COVER ${feeAddr} harvested 0 times before its close (want 1)`]);
});

test("what stays: an account holding tokens, a frozen one, a volume account owed incentive tokens; reads the providers disagree on are refused", () => {
  assert.deepEqual(solanaTeardownPlan(WALLET, { [feeAddr]: [feeAccount(7n, 0n), feeAccount(7n, 0n)] }).keep.map((k) => k.why), [`holds 7 of ${MINT}`]);
  assert.deepEqual(solanaTeardownPlan(WALLET, { [feeAddr]: [feeAccount(0n, 0n, 2), feeAccount(0n, 0n, 2)] }).keep.map((k) => k.why), ["frozen"]);
  assert.throws(() => solanaTeardownPlan(WALLET, { [feeAddr]: [feeAccount(0n, 0n), feeAccount(0n, 1n)] }), /disagree/);
  assert.throws(() => solanaTeardownPlan(WALLET, { [feeAddr]: [feeAccount(0n, 0n), null] }), /disagree/);
  assert.throws(() => solanaTeardownPlan("Fh2Wf4WixB1EbtnBqxNKWHA7YsSbVkJrY5eWmUL2FFUy", { [feeAddr]: [feeAccount(0n, 0n), feeAccount(0n, 0n)] }), /not the wallet's/);
  // A volume account with incentive tokens still to claim stays open (the recorded BJDT… curve account, edited).
  const w = F.wallets[0]!;
  const uva = solanaVolumeAccumulator(w.wallet, SOLANA_PUMP_PROGRAM);
  const real = accountsOf(w)[uva]![0]!;
  const owed = { ...real, data: Uint8Array.from(real.data) };
  new DataView(owed.data.buffer).setBigUint64(41, 9n, true);
  const p = solanaTeardownPlan(w.wallet, { ...accountsOf(w), [uva]: [owed, owed] });
  assert.deepEqual(p.keep.filter((k) => k.address === uva).map((k) => k.why), ["unclaimed incentive tokens 9"]);
  assert.ok(!p.close.some((h) => h.address === uva));
  const v = checkSolanaTeardown([], WALLET, { accounts: { [feeAddr]: [feeAccount(0n, 0n), feeAccount(0n, 1n)] }, wallet: [0n, 0n], simulations: [] });
  assert.deepEqual(v.results.map((r) => [r.id, r.ok]), [["READ", false]]);
});

test("many accounts: S-4 splits into frames of at most 1,232 bytes, every account closed once across them", () => {
  const accounts: Record<string, readonly [SolanaHeldRead, SolanaHeldRead]> = {};
  for (let i = 0; i < 40; i++) {
    const mint = base58.encode(Uint8Array.from({ length: 32 }, (_, j) => (i * 7 + j * 13 + 1) % 256));
    const d = new Uint8Array(165);
    d.set(base58.decode(mint), 0);
    d.set(base58.decode(WALLET), 32);
    d[108] = 1;
    const a = { owner: SOLANA_TOKEN_PROGRAM, lamports: 2_039_280n, data: d };
    accounts[solanaAta(WALLET, mint, SOLANA_TOKEN_PROGRAM)] = [a, a];
  }
  const plan = solanaTeardownPlan(WALLET, accounts);
  assert.equal(plan.close.length, 40);
  const frames = buildSolanaTeardown(WALLET, plan, CHAIN);
  assert.ok(frames.length > 1);
  for (const f of frames) assert.ok(f.size <= 1232, `${f.size} bytes`);
  // Every frame's simulation: the accounts it closes gone, the wallet up by their rent less the fee.
  const sims = frames.map((f) => {
    const msg = Buffer.from(f.message);
    const closes = plan.close.filter((h) => msg.includes(Buffer.from(base58.decode(h.address))));
    const s = { err: null, wallet: closes.reduce((n, h) => n + h.lamports, 0n) - 5_000n, accounts: Object.fromEntries(closes.map((h) => [h.address, null])) };
    return [s, s] as const;
  });
  assert.deepEqual(failed(checkSolanaTeardown(frames.map((f) => f.wire), WALLET, { accounts, wallet: [0n, 0n], simulations: sims })), []);
  const dropped = checkSolanaTeardown(frames.slice(1).map((f) => f.wire), WALLET, { accounts, wallet: [0n, 0n], simulations: sims.slice(1) });
  assert.equal(dropped.ok, false);
});
