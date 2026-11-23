// Card exit-rescan-after-any-open-spend: nearExitWith's scan after its resume, its control flow alone, from the
// independent money review of PR 1195. The scan, the fee wait, the recipient and storage reads, exitCloseOne and
// exitWithdrawOne are mocked; everything else is near-out.ts. A spend the first scan read in_flight can be
// refund_pending when exitCloseOne reads it again (withdraw.ts) and settled by this run, which writes a refund note the
// first scan never saw. Module mocks need a flag, so test/near-out-rescan.test.ts runs this file:
//   node --experimental-test-module-mocks --test test/near-out-rescan.cases.ts
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { RestoredNote } from "@blindfill/kit/core";

const realOut = await import("../src/out.ts");
const realWithdraw = await import("../src/withdraw.ts");
const realFund = await import("../src/fund.ts");
const realScan = await import("../src/scan.ts");
const { EXIT_NETWORKS } = await import("../src/rpc.ts");

type Spend = { l: bigint; j: number; note: string; spend: { status: string; nullifierHash: bigint; index: number; reserve: bigint; refundValue: bigint } };
const scans: { notes: RestoredNote[]; spends: Spend[] }[] = [];
let scanCalls = 0;
let closes: () => { stage: "closed"; txs: string[]; refund: boolean };
const withdrawn: bigint[] = [];

mock.module(new URL("../src/scan.ts", import.meta.url).href, {
  namedExports: {
    ...realScan,
    exitScanSeed: async () => {
      const s = scans[Math.min(scanCalls, scans.length - 1)]!;
      scanCalls++;
      return { ...s, pendingRefunds: [], network: "mainnet", vault: "v", token: "t" };
    },
  },
});
mock.module(new URL("../src/fund.ts", import.meta.url).href, { namedExports: { ...realFund, fundedOrWait: async () => 10n ** 30n } });
const TO = { account: "x.near", network: "mainnet" };
mock.module(new URL("../src/out.ts", import.meta.url).href, {
  namedExports: {
    ...realOut,
    exitRecipient: async () => ({ ok: true, recipient: TO }),
    exitReadStorage: async () => ({ network: "mainnet", account: "x.near", storageMin: 0n, registered: true }),
    exitKey: () => ({ id: "a".repeat(64), secretKey: new Uint8Array(32) }),
  },
});
mock.module(new URL("../src/withdraw.ts", import.meta.url).href, {
  namedExports: {
    ...realWithdraw,
    exitCloseOne: async () => closes(),
    exitWithdrawOne: async () => {
      return { stage: "closed", txs: ["w"], refund: false };
    },
  },
});

const { nearExitWith } = await import("../src/near-out.ts");

const [n0, n1] = EXIT_NETWORKS.mainnet.rpcs;
const vrpc = (name: string) => ({ name, query: async () => ({}) });
const mrpc = (name: string) => ({ name, query: async () => ({}), call: async (m: string) => (m === "gas_price" ? { result: { gas_price: "100000000" } } : {}), block: async () => ({}), tx: async () => ({}) });
const refundNote = (value: bigint): RestoredNote =>
  ({ ref: { kind: "refund", l: 1n, j: 0 }, scope: 9n, precommitment: 3n, state: "UNSPENT", leaf: { value, label: 77n, commitment: 5n, leafIndex: 4n } }) as unknown as RestoredNote;

test("a spend read in_flight by the scan whose callback has since bounced (refund_pending): exitCloseOne settles it on its own fresh read, so its refund note is withdrawn this run and left counts it", async () => {
  scanCalls = 0;
  scans.length = 0;
  // the first scan: one spend of ours, in_flight (its payout's callback not yet run); no note open
  scans.push({ notes: [], spends: [{ l: 1n, j: 0, note: "deposit", spend: { status: "in_flight", nullifierHash: 11n, index: 0, reserve: 1n, refundValue: 0n } }] });
  // after exitCloseOne's settle: the refund note of 5 USDC is in the vault
  scans.push({ notes: [refundNote(5_000_000n)], spends: [{ l: 1n, j: 0, note: "deposit", spend: { status: "settled", nullifierHash: 11n, index: 0, reserve: 0n, refundValue: 5_000_000n } }] });
  // exitCloseOne reads the spend again (withdraw.ts l.352): refund_pending now, so it settles it by A (l.360-373) and closes A
  closes = () => ({ stage: "closed", txs: ["settle", "close"], refund: true });
  const said: string[] = [];
  const r = await nearExitWith({ rpcs: [vrpc(n0), vrpc(n1)] as never, moveRpcs: [mrpc(n0), mrpc(n1)] as never, prover: {} as never, sleep: async () => {}, walk: async () => ({ lanes: [], complete: true }) })({ seed: new Uint8Array(64), to: "x.near", rpcs: [n0, n1], say: (l) => said.push(l) });
  // the refund note the settle wrote is in the vault: this run scans again and withdraws it
  assert.deepEqual([r.sent, r.left, scanCalls], ["5000000", "0", 2], `the run says sent ${r.sent}, left ${r.left}, while a 5 USDC refund note sits in the vault (scans: ${scanCalls}; said: ${said.join(" | ")})`);
});

test("control: the same run with the spend read refund_pending by the scan rescans and withdraws the refund note", async () => {
  scanCalls = 0;
  scans.length = 0;
  scans.push({ notes: [], spends: [{ l: 1n, j: 0, note: "deposit", spend: { status: "refund_pending", nullifierHash: 11n, index: 0, reserve: 1n, refundValue: 5_000_000n } }] });
  scans.push({ notes: [refundNote(5_000_000n)], spends: [] });
  closes = () => ({ stage: "closed", txs: ["settle", "close"], refund: true });
  const r = await nearExitWith({ rpcs: [vrpc(n0), vrpc(n1)] as never, moveRpcs: [mrpc(n0), mrpc(n1)] as never, prover: {} as never, sleep: async () => {}, walk: async () => ({ lanes: [], complete: true }) })({ seed: new Uint8Array(64), to: "x.near", rpcs: [n0, n1], say: () => {} });
  assert.equal(scanCalls, 2);
  assert.deepEqual([r.sent, r.left], ["5000000", "0"]);
});

test("control: a run whose scan read every spend of ours settled has nothing its resume can write, and scans once", async () => {
  scanCalls = 0;
  scans.length = 0;
  scans.push({ notes: [refundNote(2_000_000n)], spends: [{ l: 1n, j: 0, note: "deposit", spend: { status: "settled", nullifierHash: 11n, index: 0, reserve: 0n, refundValue: 0n } }] });
  closes = () => ({ stage: "closed", txs: [], refund: false });
  const r = await nearExitWith({ rpcs: [vrpc(n0), vrpc(n1)] as never, moveRpcs: [mrpc(n0), mrpc(n1)] as never, prover: {} as never, sleep: async () => {}, walk: async () => ({ lanes: [], complete: true }) })({ seed: new Uint8Array(64), to: "x.near", rpcs: [n0, n1], say: () => {} });
  assert.equal(scanCalls, 1);
  assert.deepEqual([r.sent, r.left], ["2000000", "0"]);
});
