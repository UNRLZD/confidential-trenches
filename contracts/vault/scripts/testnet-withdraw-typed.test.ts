// The testnet driver of card wallet-withdraw-move-out (testnet-withdraw-typed.ts), its pure parts: the tap's amount
// for the whole note through the form's own check, and the guard that keeps every state file out of the repository.
//   node --test contracts/vault/scripts/testnet-withdraw-typed.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, symlinkSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { inside, ROOT as DRIVER_ROOT, tapAmountOf } from "./testnet-withdraw-typed.ts";
import { checkAmount, vaultScope } from "../../../packages/signpage/src/withdraw/checks.ts";
import { formatUnits } from "../../../packages/signpage/src/withdraw/form.ts";
import { NEAR_NETWORKS } from "../../../packages/wallet/src/deposit/account.ts";
import { withdrawRequest } from "../../../packages/wallet/src/withdraw/request.ts";

const form = { checkAmount, formatUnits };
const NET = NEAR_NETWORKS.testnet;
const NOTE = 500_000n; // the driver's NOTE
const FEE = 206_282n; // relayer-withdraw-send's recorded testnet quote
const REACHED = "REACHED registerDepositOf: the pick passed";

// withdrawRequest up to its register read, which comes after the note pick (amount + fee must fit in one note)
function requestArgs(amount: bigint) {
  const scope = vaultScope("testnet")!;
  const notes = { list: async () => [{ id: "n1", scope, state: "UNSPENT", ref: { kind: "deposit", i: 0 }, leaf: { value: NOTE, label: 7n, commitment: 1n, leafIndex: 0n } }] } as never;
  const ns = (BigInt(Date.now()) * 1_000_000n).toString();
  return {
    seed64: new Uint8Array(64), notes, prover: {} as never, vaultId: NET.vault!, token: NET.usdc,
    stateTree: {} as never, labelTree: {} as never, newestStateRoot: 1n, newestLabelRoot: 1n,
    registerDepositOf: async () => { throw new Error(REACHED); },
    feeRecipient: "f.testnet", relayFee: FEE, network: "testnet" as const, rpcs: [] as never, priceRpcs: [] as never,
    amount, to: "wt-00000000.bf-vt-20261102t071444.testnet", deadlineMs: Number(BigInt(ns) / 1_000_000n) + 500_000, blockTimestampNanosec: ns,
  };
}

test("the tap's amount for the whole note is the note less the fee, and withdrawRequest takes it past the note pick", async () => {
  const amount = tapAmountOf(NOTE, FEE, form);
  assert.equal(amount, NOTE - FEE);
  await assert.rejects(withdrawRequest(requestArgs(amount)), new RegExp(REACHED));
  // the whole note as the amount is what withdrawRequest refuses before any proof (review of c19ad399, H1)
  await assert.rejects(withdrawRequest(requestArgs(NOTE)), /no unspent note covers the amount and its fee/);
});

test("the tap's amount is refused as the form refuses it: a fee that leaves the amount at or below it, or no amount", () => {
  assert.throws(() => tapAmountOf(NOTE, NOTE / 2n, form), /the form refuses .*min/);
  assert.throws(() => tapAmountOf(NOTE, NOTE, form), /does not cover the fee/);
  assert.throws(() => tapAmountOf(NOTE, NOTE + 1n, form), /does not cover the fee/);
});

const ROOT = realpathSync.native(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."));
const target = path.join(ROOT, "contracts/vault/deployments");

test("a state path inside the repository is refused however it is spelled: plain, through a symlink, in another case", (t) => {
  assert.equal(inside(path.join(target, "x.json"), [ROOT]), true, "plain");
  assert.equal(inside(path.join(tmpdir(), "wwmo-outside", "state.json"), [ROOT]), false, "outside");
  const dir = mkdtempSync(path.join(tmpdir(), "wwmo-inside-"));
  const link = path.join(dir, "in-repo");
  symlinkSync(target, link);
  assert.equal(inside(path.join(link, "x.json"), [ROOT]), true, "a symlink into the repository");
  assert.equal(inside(path.join(link, "new-dir", "state.json"), [ROOT]), true, "a file not made yet under the symlink");
  const changed = ROOT.replace(/[a-z]/, (c) => c.toUpperCase());
  if (changed === ROOT || !existsSync(changed)) return t.skip("case-sensitive disk");
  assert.equal(inside(path.join(changed, "x.json"), [ROOT]), true, "another case on a case-insensitive disk");
});

// review of a6903d91, N2: node keeps the spelling it was started by in import.meta.url, so a ROOT spelled in another
// case met the canonical real path of the default --out, and the run threw only after it had spent its deposit.
test("the driver's ROOT is the canonical spelling, and a root spelled in another case still holds its own files", (t) => {
  assert.equal(DRIVER_ROOT, realpathSync.native(DRIVER_ROOT), "ROOT is the real path");
  const miscased = ROOT.replace(/[a-z]/, (c) => c.toUpperCase());
  if (miscased === ROOT || !existsSync(miscased)) return t.skip("case-sensitive disk");
  // the reviewer's probe p2-out-miscased-root: the default --out under a ROOT node was given in another case
  assert.equal(inside(path.resolve(miscased, "scripts/live-checks/wallet-withdraw-move-out.md"), [miscased]), true);
});

test("a --out outside the repository is refused before anything is read or sent", () => {
  const parent = JSON.parse(readFileSync(path.join(ROOT, "contracts/vault/deployments/testnet-v1.json"), "utf8")).parent as string;
  const away = mkdtempSync(path.join(tmpdir(), "wwmo-out-"));
  const r = spawnSync(process.execPath, [path.join(ROOT, "contracts/vault/scripts/testnet-withdraw-typed.ts"),
    "--parent", parent, "--key-file", path.join(away, "no-key.json"), "--t04-state", path.join(away, "t04.json"),
    "--rws-state", path.join(away, "rws.json"), "--state", path.join(away, "state.json"), "--out", path.join(away, "record.md")],
    { encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /ERROR: --out must be inside the repository/);
  assert.equal(r.stdout.includes("wwmo:"), false, "nothing ran before the refusal");
  assert.equal(existsSync(path.join(away, "state.json")), false, "no state made");
});
