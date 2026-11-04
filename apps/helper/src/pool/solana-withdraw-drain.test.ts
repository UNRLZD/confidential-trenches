// Card signpage-pool-withdraw-form, the review of PR #232 at 6a55271 (HIGH 1): a tag 2 with W's trailing transfer had an
// on-chain failure W's holder controls (W assigned away or drained, or the destination closed, by W's own racing tx
// after the helper's simulation), sent plain on mainnet, so each epoch's retry was a paid failure of the fee payer.
// The fold: a tag 2 is the release alone again (main's rule), and W sends onward in its own transaction, paying its own
// fee. Ten notes, sixty epochs: no such send is ever made, so the fee payer's drain is 0.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import * as kit from "@blindfill/kit";
import { base58 } from "../bind/checks.ts";
import { POOL_EPOCH_MS } from "./fee.ts";
import { solanaPoolSender } from "./solana.ts";
import { jitoSender } from "./jito.ts";
const { SOLANA_COMPUTE_BUDGET_PROGRAM, SOLANA_SYSTEM_PROGRAM, solanaCompileV0, solanaEncodePoolRelease, solanaPoolAccount, solanaPoolReleaseAccounts, solanaPoolPriorityBudget } = kit;

const key = (n: string) => {
  const seed = new Uint8Array(createHash("sha256").update(`review232/${n}`).digest());
  const pub = ed25519.getPublicKey(seed);
  return { seed, address: base58(pub), secret: base58(Uint8Array.from([...seed, ...pub])) };
};
const FP = key("FP"), W = key("W");
const PROGRAM = key("PROGRAM").address;
const POOL = solanaPoolAccount(PROGRAM);
const TO = key("TO").address, BH = key("BH").address;
const MAINNET = { lamportsPerByte: 5_080n, factor: 1n } as const;
const FEE = 1_300_000n;
const NOW = 1_800_000_000_000;
const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const u64 = (n: bigint) => Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
const f32 = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : 0));
const cuLimit = (n: number) => ({ program: SOLANA_COMPUTE_BUDGET_PROGRAM, accounts: [], data: Uint8Array.from([2, ...u32(n)]) });
const cuPrice = (n: bigint) => ({ program: SOLANA_COMPUTE_BUDGET_PROGRAM, accounts: [], data: Uint8Array.from([3, ...u64(n)]) });

function tag2WithTransfer(nullifier: number, pre: kit.SolanaApiInstruction[]): Uint8Array {
  const r = { proof: new Uint8Array(256), newCommitmentHash: f32(1), existingNullifierHash: f32(nullifier), withdrawnValue: 10_000_000n, stateRootIndex: 0, stateTreeDepth: 1, labelRootIndex: 0, labelTreeDepth: 1, relayFee: FEE, relayFeeCap: FEE, tipCap: 1_000_000n, deadlineMs: BigInt(NOW + 3_700_000), salt: new Uint8Array(16) };
  const accounts = solanaPoolReleaseAccounts({ program: PROGRAM, pool: POOL }, W.address, FP.address, r, 6);
  const transfer = { program: SOLANA_SYSTEM_PROGRAM, accounts: [{ key: W.address, signer: true, writable: true }, { key: TO, signer: false, writable: true }], data: Uint8Array.from([2, 0, 0, 0, ...u64(r.withdrawnValue - FEE)]) };
  const { message } = solanaCompileV0(FP.address, [...pre, { program: PROGRAM, accounts, data: solanaEncodePoolRelease(r) }, transfer], BH, [], [FP.address, W.address]);
  return Uint8Array.from([2, ...new Uint8Array(64), ...ed25519.sign(message, W.seed), ...message]);
}
const stub = () => Object.assign(async (m: string) => {
  if (m === "simulateTransaction") return { context: { slot: 1 }, value: { err: null } };
  if (m === "getLatestBlockhash") return { context: { slot: 1 }, value: { blockhash: BH, lastValidBlockHeight: 1000 } };
  throw new Error(m);
}, { url: `https://stub.invalid/${Math.random()}` });
const okEngine = async (url: string, init: RequestInit) => {
  const w = Buffer.from(JSON.parse(String(init.body)).params[0], "base64");
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: base58(w.subarray(1, 65)) }), { status: 200 });
};
function mainnet(paths: string[][], now: () => number) {
  return solanaPoolSender({ cluster: "mainnet", program: PROGRAM, feePayerSecret: FP.secret, fee: String(FEE) }, {
    providers: [stub(), stub()], now, readRent: async () => MAINNET,
    jito: jitoSender({ fetch: okEngine, timeoutMs: 1_000, intervalMs: 0 }),
    // the chain: W's racing tx made the transfer fail; bundle-only never lands it, a plain send lands a paid failure
    send: ((set: { wire: Uint8Array }[], opts: { paths: { name: string }[] }) => {
      const names = opts.paths.map((p) => p.name);
      paths.push(names);
      const sig = base58(set[0]!.wire.subarray(1, 65));
      return { signatures: [sig], done: Promise.resolve({ txs: [{ signature: sig, state: names.includes("jito") ? "expired" : "failed", sends: [] }] }), stop() {} };
    }) as never,
  });
}
const body = (w: Uint8Array) => ({ pool: POOL, tx: Buffer.from(w).toString("base64") });

test("a mainnet tag 2 + W's transfer never lands a paid failure: ten notes, sixty epochs, the fee payer's drain is 0", async () => {
  const paths: string[][] = [];
  let now = NOW;
  const s = mainnet(paths, () => now);
  const top = (solanaPoolPriorityBudget(MAINNET, FEE) * 1_000_000n) / 1_400_000n;
  const notes = Array.from({ length: 10 }, (_, i) => tag2WithTransfer(100 + i, [cuLimit(1_400_000), cuPrice(top)]));
  for (let e = 0; e < 60; e++) {
    for (const n of notes) await s.carry(body(n));
    await new Promise((r) => setImmediate(r));
    now += POOL_EPOCH_MS;
  }
  const plain = paths.filter((p) => !p.includes("jito")).length;
  assert.equal(plain, 0, `${plain} plain sends, each a paid failure of up to base fee + ${solanaPoolPriorityBudget(MAINNET, FEE)} lamports priority`);
});
