#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// The mainnet money run (card vault-mainnet-money): one deposit and one relayed withdrawal on the real vault of
// contracts/vault/deployments/mainnet-v1.json, both carried by the deployed helper, the withdrawal paid straight to a
// NEAR account the owner names. testnet-t02.ts and testnet-withdraw-send.ts opened to mainnet: their device side is
// kept (the wallet's own modules), and their in-process carry, with relayer keys of their own, is what this drops. With
// --network testnet the same run goes to the testnet vault of testnet-v1.json, its release relayers, for the rehearsal.
//
// The device side, every step the wallet's own call:
//   - the deposit: the note store's planDeposit, U = U_{s,i} (packages/wallet/src/deposit/account.ts), U's signed call
//     and its follow to the note's leaf (deposit/bind.ts bindDeposit), sent to RELEASE_BIND_URL, for whatever lands at U
//     at or above the vault's min_deposit (an exchange's fee taken from the sum does not stall the run);
//   - the withdrawal: the release relayer's fee (withdraw/relay.ts askWithdrawFee), then withdrawRequest with `to` (card
//     wallet-withdraw-move-out: the vault pays the named account, fund_recipient false) for the note's whole value less
//     that fee, so no change is left (the form's two-quote draw is the one step of the signing page's hand-off not used:
//     a lower second quote leaves its difference as a change note), then relayWithdraw (POST /v1/withdraw) and
//     withdrawArrival (the spend row paid to that account, on two RPCs);
//   - a stop at any point resumes: the notes are restored from the seed and the vault's pages (notes/restore.ts
//     restoreNotes, every lane), into a note store of the run's own lane, so the deposit index and U are the run's
//     again (a fresh store draws its lane at random, store/index.ts); a note that landed is withdrawn, one that did not
//     is planned again at the same index and its USDC at U deposited.
// The one stand-in: the prover. The page's prover worker runs snarkjs' groth16.fullProve on the pinned setup files in a
// browser; here the same call runs in this process on the same files, each refused unless its sha256 is the kit's pin,
// and the proof is checked against withdraw.vkey.
//
// Refused before anything is read, signed or sent (runProblems): a record that is not mainnet-v1.pin.json field for
// field, or not deployed; a vault id or asset other than the kit's row; RPCs that are not the release pair (two
// operators); a release with no deposit or withdrawal relayer. Then the vault is read on both operators (no key, the
// record's code, asset and scope), the named recipient on both (it must exist: recipientProblems), and the fee is held
// to the device's own fee_max before any deposit (feeProblems).
//
// The state, --state <dir> (mode 700, outside the repo; stateDir): the run's seed (32 random bytes, its 12 words) in
// <dir>/seed, written once (a mode 600 temporary file, fsync, then link: never overwritten, never rewritten); each step
// in its own <dir>/<step>.json (temporary file, fsync, rename), so a stop mid-write leaves the old step whole and the
// seed untouched. Keep the folder: it is the only key to the run's money until the withdrawal arrives. Nothing secret
// is printed. No shipped tool other than this one withdraws from it yet (packages/exit reads the vault's lists only).
//
//   node contracts/vault/scripts/mainnet-money.ts check [--network n] [--state <dir>] [--to <account>]
//        the gate, the vault read; with --state, the run's U (its seed's, checked), U's state on both RPCs
//   node contracts/vault/scripts/mainnet-money.ts run --state <dir> --to <account> [--network n] [--bind-relayer r]
//        makes the seed when the folder has none, else goes on from where the run stopped; waits for U's USDC
//   node contracts/vault/scripts/mainnet-money.ts resume --state <dir> --to <account> [--network n] [--bind-relayer r]
//        the same, refused when the folder holds no seed
//   node contracts/vault/scripts/mainnet-money.ts open-u --state <dir> --payer <account> --key-file <path> [--network n]
//        [--register <account>]   with --register, the payer also registers that existing account on the token
//        the payer opens U: 0.01 NEAR (an implicit account exists once it holds NEAR) and its USDC registration,
//        signed here from the key file (no binary of anyone else's sees it); each tx kept in <dir>/open-u.json
//   node contracts/vault/scripts/mainnet-money.ts sweep-u --state <dir> [--network n]
//        U signs (its key derived here from the seed) one ft_transfer of all the USDC it holds to the run's named
//        account: the way out for USDC at U that was not deposited (a second transfer, a refused or struck bind, a
//        front-run's refund, USDC sent after the deposit); kept in <dir>/sweep.json for the record
//   node contracts/vault/scripts/mainnet-money.ts record --state <dir> --fund-tx <hash> <signer> [--fund-tx ...]
//        [--settle-tx <hash> <signer>] [--deposit-tx <hash> <signer>] [--withdraw-tx <hash> <signer>]   writes vault-mainnet-money.run.json
//        and .md into the --state folder (recordFiles), outside the checkout
import "../../../scripts/net-window.mjs";
import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NEAR_NETWORKS, nearPairNetwork, nearPairRule } from "../../../packages/kit/src/near/networks.ts";
import { depositId } from "../../../packages/wallet/src/derive/keys.ts";
import { cloneProblems } from "./source-gate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
export const CARD = "vault-mainnet-money";
export const RECORD = path.join(HERE, "..", "deployments", "mainnet-v1.json");
export const PIN = path.join(HERE, "..", "deployments", "mainnet-v1.pin.json");
export const TESTNET_RECORD = path.join(HERE, "..", "deployments", "testnet-v1.json");
const NEAR = 10n ** 24n;
const TGAS = 10n ** 12n;
/** What opens U: an implicit account exists once it holds NEAR; 0.01 N covers its 182 B and its one key. */
export const U_OPEN_YOCTO = NEAR / 100n;
const POLL_MS = 10_000;
const LANES = 8;
const INTENTS = "intents.near";

type Network = "mainnet" | "testnet";
type Rpcish = { name: string; query: (p: Record<string, unknown>) => Promise<unknown> };
type Relayers = { bind: string | null; withdraw: { relayer_account: string; fee_recipient: string } | null };
type Net = { vault: string | null; usdc: string };

// ---- the refusals (pure; mainnet-money.test.ts) ----

/** [] when the run may start: the deployed record is the pin (mainnet), the kit's row, on the release pair, with both relayers. */
export function runProblems(a: { record: any; pin: any; net: Net; rpcs: readonly Rpcish[]; relayers: Relayers; network?: Network }): string[] {
  const { record, pin, net, rpcs, relayers } = a;
  const network = a.network ?? "mainnet";
  const p: string[] = [];
  if (record === null || typeof record !== "object") return ["the record is not a JSON object"];
  if (record.network !== network) p.push(`the record's network is ${String(record.network)}, not ${network}`);
  if (network === "mainnet") {
    if (pin === null || typeof pin !== "object") p.push("no pin to hold the mainnet record to");
    else for (const k of Object.keys(pin)) if (k !== "sources" && JSON.stringify(record[k]) !== JSON.stringify(pin[k])) p.push(`the record's ${k} is not the pin's (mainnet-v1.pin.json)`);
  }
  if (typeof record.tx_hash !== "string" || typeof record.code_hash !== "string") p.push("the record has no tx_hash or code_hash: no deploy wrote it");
  if (net.vault === null || record.account_id !== net.vault) p.push(`the record's vault ${String(record.account_id)} is not the kit's ${network} vault ${String(net.vault)}`);
  if (record.asset !== net.usdc) p.push(`the record's asset ${String(record.asset)} is not the kit's ${network} USDC ${net.usdc}`);
  if (nearPairNetwork(rpcs) !== network) p.push(`RPCs ${rpcs.map((r) => r?.name).join(", ")}: ${nearPairRule(network)}`);
  if (!relayers.bind) p.push(`the release names no ${network} deposit relayer (packages/wallet/src/deposit/bind.ts RELEASE_RELAYER.${network} is null)`);
  if (!relayers.withdraw) p.push(`the release names no ${network} withdrawal relayer (packages/wallet/src/withdraw/relay.ts RELEASE_WITHDRAW_RELAYER.${network} is null)`);
  return p;
}

/** [] when both operators read the vault as the record says: no key, the record's code, asset and scope. */
export function vaultReadProblems(record: any, reads: readonly (null | { keys: unknown[]; code_hash: string; config: { asset: string; scope: string } })[]): string[] {
  if (reads.length !== 2 || reads.some((r) => r === null || typeof r !== "object")) return ["the vault was not read on two operators"];
  const p: string[] = [];
  reads.forEach((r, i) => {
    const at = `on read ${i + 1}`;
    if (!Array.isArray(r!.keys) || r!.keys.length !== 0) p.push(`the vault has a key ${at}`);
    if (r!.code_hash !== record.code_hash) p.push(`the vault's code ${r!.code_hash} is not the record's ${record.code_hash} ${at}`);
    if (r!.config?.asset !== record.asset) p.push(`the vault's asset ${r!.config?.asset} is not the record's ${at}`);
    if (String(r!.config?.scope) !== record.scope) p.push(`the vault's scope ${r!.config?.scope} is not the record's ${at}`);
  });
  return p;
}

/** [] when the relayer's fee is at most the device's own fee_max and leaves something of the note to withdraw. */
export function feeProblems(a: { relayFee: bigint; feeMax: bigint; note: bigint }): string[] {
  const { relayFee, feeMax, note } = a;
  if (typeof relayFee !== "bigint" || typeof feeMax !== "bigint" || relayFee < 0n || feeMax < 0n) return ["the fee or its cap is not a whole number of base units"];
  const p: string[] = [];
  if (relayFee > feeMax) p.push(`the relay fee ${relayFee} is above the device's fee_max ${feeMax}`);
  // withdrawRequest refuses fee >= amount (= note - fee) and the vault fee > withdrawn / 2: both hold when 2 * fee < note
  if (relayFee >= note) p.push(`the relay fee ${relayFee} leaves nothing of the ${note} note to withdraw`);
  else if (2n * relayFee >= note) p.push(`the relay fee ${relayFee} is half the note ${note} or more: the withdrawal would be refused`);
  return p;
}

/** nearcore's account id rule (as the wallet's request.ts reads `to`). */
const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
/**
 * [] when `to` may be paid: a NEAR account id, not the vault, intents.near or the token, that exists on both RPCs (its
 * view_account on each: the amounts may differ by a block, existence may not). An implicit id that does not exist yet
 * is refused too: nobody may have its key, and the owner names an account they hold.
 */
export function recipientProblems(to: unknown, a: { vault: string; token: string; others?: readonly string[]; reads: readonly (null | { amount: string } | "absent")[] }): string[] {
  if (typeof to !== "string" || !ACCOUNT_ID.test(to)) return [`--to ${String(to)}: not a NEAR account id`];
  if (to === a.vault || to === INTENTS || to === a.token) return [`--to ${to}: the vault, intents.near or the token`];
  if ((a.others ?? []).includes(to)) return [`--to ${to}: U, the fee recipient or the relayer, an account of the run's own`];
  if (a.reads.length !== 2 || a.reads.some((r) => r === null)) return [`--to ${to}: not read on two operators`];
  if (a.reads.some((r) => r === "absent")) return [`--to ${to}: no such account on ${a.reads.every((r) => r === "absent") ? "either RPC" : "one RPC"}; name an existing account you hold`];
  return [];
}

/** [] when a request the wallet made spends the picked note and pays `to` straight, with no change note: what the run sends, checked before it is sent. */
export function requestProblems(req: { noteId?: string; recipient: string; changeValue: bigint; body: { fund_recipient: unknown } }, to: string, noteId: string): string[] {
  const p: string[] = [];
  if (req.noteId !== noteId) p.push(`the wallet's request spends note ${req.noteId}, not the run's ${noteId}`);
  if (req.recipient !== to) p.push(`the wallet's request pays ${req.recipient}, not ${to}: this wallet does not pay a named account yet (card wallet-withdraw-move-out)`);
  if (req.body.fund_recipient !== false) p.push(`the request's fund_recipient is ${String(req.body.fund_recipient)}, not false`);
  if (req.changeValue !== 0n) p.push(`the request leaves a change note of ${req.changeValue}`);
  return p;
}

/**
 * [] when `account` may be registered on the token by the payer (open-u --register): a NEAR account id that exists on
 * both RPCs and that both read as not registered (storage_balance_of null).
 */
export function registerProblems(account: unknown, a: { reads: readonly (null | { amount: string } | "absent")[]; registered: readonly boolean[] }): string[] {
  if (typeof account !== "string" || !ACCOUNT_ID.test(account)) return [`--register ${String(account)}: not a NEAR account id`];
  if (a.reads.length !== 2 || a.reads.some((r) => r === null)) return [`--register ${account}: not read on two operators`];
  if (a.reads.some((r) => r === "absent")) return [`--register ${account}: does not exist on ${a.reads.every((r) => r === "absent") ? "either RPC" : "one RPC"}`];
  if (a.registered.length !== 2 || a.registered[0] !== a.registered[1]) return [`--register ${account}: the two RPCs disagree on its registration`];
  if (a.registered[0]) return [`--register ${account}: already registered on the token, nothing to send`];
  return [];
}

/** U's signing key, derived from the seed (derive/keys.ts depositId), refused unless its public side is the run's U. */
export function uSigner(seed64: Uint8Array, scope: bigint, i: number, U: string) {
  const u = depositId(seed64, scope, i);
  try {
    if (u.id !== U) throw new Error(`index ${i} derives ${u.id}, not the run's U ${U}: nothing signed`);
    const pub = Buffer.from(u.publicKey);
    const privateKey = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: Buffer.from(u.secretKey).toString("base64url"), x: pub.toString("base64url") }, format: "jwk" });
    return { pub, privateKey };
  } finally {
    u.secretKey.fill(0);
  }
}

/** [] when U's USDC may be swept to the named account: U holds some, and the account is registered on the token. */
export function sweepProblems(a: { balance: bigint; toRegistered: boolean }): string[] {
  if (a.balance <= 0n) return ["U holds no USDC: nothing to sweep"];
  if (!a.toRegistered) return ["the named account is not registered on the token, so the transfer would fail: register it (storage_deposit) first"];
  return [];
}

/**
 * The note the run withdraws next: the UNSPENT note with a value in the deposit's line, the deposit note at index i or a
 * note born of it (store.add names each change and refund note's parent), followed by parent, never by label: the vault
 * gives a refund note a fresh label (settle.rs). Null when the deposit is not in the store or nothing of its line is left
 * (a zero change note is never withdrawn).
 */
export function noteToWithdraw<N extends { id: string; ref: { kind: string; i?: number }; state: string; parent?: string; leaf?: { label: bigint; value: bigint } }>(notes: N[], i: number): N | null {
  const dep = notes.find((n) => n.ref.kind === "deposit" && n.ref.i === i && n.leaf !== undefined);
  if (dep === undefined) return null;
  const line = new Set([dep.id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const n of notes)
      if (n.parent !== undefined && line.has(n.parent) && !line.has(n.id)) {
        line.add(n.id);
        grew = true;
      }
  }
  return notes.find((n) => line.has(n.id) && n.state === "UNSPENT" && n.leaf !== undefined && n.leaf.value > 0n) ?? null;
}

type DepositRow = { precommitment: bigint; depositor: string; value: bigint };
/**
 * Whether the row of P in the deposits pages is U's own deposit: { why: null, row } only when one of `txs` (the deposit
 * relayer's hashes the device heard, the note's calls, or one the owner names) reads back a success on both RPCs
 * (`readTx`, which throws otherwise) and is the run's: the deposit relayer carrying U's one signed ft_transfer_call of the
 * row's value to the vault with P and U (relayerTxProblems). The row's depositor is named by whoever transfers
 * (deposit.rs takes it from the msg), so a row naming U never proves it alone: a front-runner may name U. `rows` null:
 * the pages were not read. Else why the run stops.
 */
export async function ownDeposit(a: { rows: readonly DepositRow[] | null; want: Omit<RunTxs, "value">; amount: bigint; txs: readonly string[]; readTx: (hash: string) => Promise<unknown> }): Promise<{ why: string | null; row?: DepositRow }> {
  if (a.rows === null) return { why: "front_run, and the deposits pages were not read: nothing is taken for U's own" };
  const P = BigInt(a.want.P);
  const row = a.rows.find((r) => r.precommitment === P);
  if (row === undefined) return { why: "front_run, and the deposits page holds no row of P on this read" };
  const stays = `U's ${a.amount} USDC stays at U (sweep-u sends it on)`;
  if (row.depositor !== a.want.U) return { why: `front-run: P was deposited by ${row.depositor}, not U, with ${row.value}; ${stays}`, row };
  if (await landedOwn(a.txs, a.want, row.value, a.readTx)) return { why: null, row };
  return { why: `front-run: P was deposited naming U with ${row.value}, but no deposit tx of U for P with that value reads back a success on both RPCs (${a.txs.length} heard); ${stays}. ${NAME_IT}`, row };
}

/** The way out when U's own deposit tx was not heard: the owner names it on line 1. */
const NAME_IT = "If it is U's own and its hash was not heard, name it: paste line 1 again with --deposit-tx <hash> at its end";

/** Whether one of `txs` reads back a success on both RPCs (`readTx` throws otherwise) as the run's deposit of `value`: the deposit relayer carrying U's one delegate for P (relayerTxProblems). */
async function landedOwn(txs: readonly string[], want: Omit<RunTxs, "value">, value: bigint, readTx: (hash: string) => Promise<unknown>): Promise<boolean> {
  for (const h of new Set(txs)) {
    const t = await readTx(h).catch(() => null);
    if (t !== null && relayerTxProblems("deposit", t, { ...want, value: String(value) }).length === 0) return true;
  }
  return false;
}

/**
 * Null when the run's deposit leaf (the deposit note of index i, as the bind, the wait or a restore put it in the store)
 * is U's own: one of `txs` reads back a success on both RPCs as the deposit relayer carrying U's delegate for P at the
 * leaf's value. Every path to the prover passes here: restore matches a row by P alone, and a row's depositor and value
 * are whoever transferred, so no note is withdrawn on a row nobody proved U's. Else why the run stops.
 */
export async function leafProblem(a: { notes: readonly { ref: { kind: string; i?: number }; leaf?: { value: bigint } }[]; i: number; want: Omit<RunTxs, "value">; txs: readonly string[]; readTx: (hash: string) => Promise<unknown> }): Promise<string | null> {
  const dep = a.notes.find((n) => n.ref.kind === "deposit" && n.ref.i === a.i && n.leaf !== undefined);
  if (dep === undefined) return `no deposit note of index ${a.i} with a leaf is in the store: nothing is withdrawn`;
  if (await landedOwn(a.txs, a.want, dep.leaf!.value, a.readTx)) return null;
  return `no deposit tx of U for P with ${dep.leaf!.value} reads back a success on both RPCs (${new Set(a.txs).size} held): the leaf of P is not proven U's own, so nothing is withdrawn. ${NAME_IT}`;
}

/** Null when the run goes on with what bindDeposit landed: deposited, its tx read back as U's at U's amount, or a front_run that ownDeposit proves U's own. Else why the run stops. */
export async function bindProblem(kind: string, a: Parameters<typeof ownDeposit>[0]): Promise<{ why: string | null; row?: DepositRow }> {
  if (kind === "deposited") return { why: (await landedOwn(a.txs, a.want, a.amount, a.readTx)) ? null : `no deposit tx of U for P with ${a.amount} reads back a success on both RPCs (${new Set(a.txs).size} held): bindDeposit's "deposited" is not taken alone. ${NAME_IT}` };
  if (kind !== "front_run") return { why: kind };
  return ownDeposit(a);
}

/** [] when the folder's run step is this seed's and network's, and pays the `--to` this line names. */
export function runStepProblems(run: { fingerprint?: unknown; network?: unknown; to?: unknown }, want: { fingerprint: string; network: Network; to: string }): string[] {
  if (run.fingerprint !== want.fingerprint || run.network !== want.network) return ["the folder's run step is not this seed's, or another network's: keep the folder as it is and say so"];
  if (run.to !== want.to) return [`refused, nothing sent: this run pays ${String(run.to)}; paste the same line with ${String(run.to)}`];
  return [];
}

/** `fn` asked up to `tries` times (a provider a block behind the other, a dropped answer); null when every try failed. */
export async function retried<T>(fn: () => Promise<T>, tries: number, wait: () => Promise<void> = () => sleep(3000)): Promise<T | null> {
  for (let t = 0; t < tries; t++) {
    try {
      return await fn();
    } catch {
      if (t + 1 < tries) await wait();
    }
  }
  return null;
}

/** send_tx's error, as text, when the RPC refused the tx; null for a result, no answer or a timeout (the read-back decides). */
export function sendAnswerError(j: any): string | null {
  if (j === null || typeof j !== "object" || j.error === undefined) return null;
  const cause = String(j.error?.cause?.name ?? j.error?.name ?? "error");
  if (cause === "TIMEOUT_ERROR") return null;
  return `${cause}: ${JSON.stringify(j.error?.data ?? j.error?.cause?.info ?? j.error?.message ?? "").slice(0, 300)}`;
}

/** A run's fingerprint of its seed, kept in its run step: a step of another seed is never used. */
export const fingerprintOf = (seed: Buffer): string => createHash("sha256").update(seed).update("vault-mainnet-money/fingerprint").digest("hex");

// ---- the state folder (mainnet-money-state.test.ts) ----

type Fs = { openSync: typeof openSync; writeSync: typeof writeSync; fsyncSync: typeof fsyncSync; closeSync: typeof closeSync; linkSync: typeof linkSync; renameSync: typeof renameSync; unlinkSync: typeof unlinkSync };
const REAL_FS: Fs = { openSync, writeSync, fsyncSync, closeSync, linkSync, renameSync, unlinkSync };

/** Writes `text` to a new mode 600 temporary file beside `file`, fsyncs it, then puts it at `file` by `place`. */
function durable(file: string, text: string, place: "link" | "rename", fs: Fs): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    if (place === "link") fs.linkSync(tmp, file); // refuses an existing file: the seed is never overwritten
    else fs.renameSync(tmp, file);
  } finally {
    if (place === "link") fs.unlinkSync(tmp);
  }
  const dfd = fs.openSync(path.dirname(file), "r");
  try {
    fs.fsyncSync(dfd);
  } finally {
    fs.closeSync(dfd);
  }
}

export const STEPS = ["run", "deposit", "withdraw", "open-u", "heard", "sweep"] as const;
export type Step = (typeof STEPS)[number];

/** The run's folder: its seed (made once when `create`), and its steps, each its own file. */
export function stateDir(dir: string, roots: string[], { create, fs = REAL_FS, commit = null }: { create: boolean; fs?: Fs; commit?: string | null }) {
  const real = path.resolve(dir);
  for (const r of roots) if (real === r || real.startsWith(r + path.sep)) throw new Error(`--state is inside the repository (${r}): the run's seed never lives in the repo`);
  const seedFile = path.join(real, "seed");
  if (!existsSync(seedFile)) {
    if (!create) throw new Error(`--state ${real} holds no seed: resume goes on with a run that has one; keep the folder the run made`);
    mkdirSync(real, { recursive: true, mode: 0o700 });
    try {
      durable(seedFile, randomBytes(32).toString("hex") + "\n", "link", fs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; // another run made it first: use that one
    }
  }
  if ((statSync(seedFile).mode & 0o077) !== 0) throw new Error(`${seedFile} is readable by others: chmod 600 it`);
  // the driver's own format only (what it writes above): a seed file of any other shape, another tool's or an earlier
  // version's, is never taken for this run's
  const text = readFileSync(seedFile, "utf8");
  if (!/^[0-9a-f]{64}\n$/.test(text)) throw new Error(`${seedFile} is not a seed this driver wrote: keep the folder and do not edit it`);
  const seed = Buffer.from(text.slice(0, 64), "hex");
  const fileOf = (step: Step) => {
    if (!STEPS.includes(step)) throw new Error(`no step ${step}`);
    return path.join(real, `${step}.json`);
  };
  // every step file names the commit that wrote it (--commit; null for a testnet run without one): a folder another
  // commit wrote is never gone on with, so one run's every signature is one commit's
  const withCommit = (value: unknown) => (value !== null && typeof value === "object" && !Array.isArray(value) ? { ...(value as object), commit } : value);
  for (const step of STEPS) {
    const f = fileOf(step);
    if (!existsSync(f)) continue;
    const at = JSON.parse(readFileSync(f, "utf8"))?.commit ?? null;
    if (at !== commit) throw new Error(`${f} was written by commit ${at ?? "none"}, not this paste's ${commit ?? "none"}: paste the line that names ${at ?? "no commit"}, keep the folder as it is`);
  }
  return {
    dir: real,
    seed,
    commit,
    read(step: Step): any {
      const f = fileOf(step);
      if (!existsSync(f)) return undefined;
      const { commit: _, ...value } = JSON.parse(readFileSync(f, "utf8")); // checked when the folder was opened
      return value;
    },
    write(step: Step, value: unknown): void {
      durable(fileOf(step), json(withCommit(value)) + "\n", "rename", fs);
    },
    /** Writes the step once (link, as the seed): another process that wrote it first wins, and this one is refused. */
    writeOnce(step: Step, value: unknown): void {
      try {
        durable(fileOf(step), json(withCommit(value)) + "\n", "link", fs);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`another run on this folder planned first: nothing more is done here; paste the same line again and it goes on with that plan`);
        throw e;
      }
    },
  };
}

// ---- the network ----

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const log = (s: string) => console.log(`mainnet-money: ${s}`);
function json(x: unknown): string {
  return JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));
}
const wallet = (p: string) => import(pathToFileURL(path.join(ROOT, "packages/wallet/src", p)).href);

async function q(rpc: Rpcish, params: Record<string, unknown>): Promise<any> {
  const j: any = await rpc.query({ finality: "final", ...params });
  if (!j?.result || j.result.error) {
    const e = new Error(`${rpc.name}: ${String(j?.error?.cause?.name ?? j?.error?.message ?? j?.result?.error ?? "no result").slice(0, 200)}`);
    (e as any).unknownAccount = /UNKNOWN_ACCOUNT|does not exist/.test(JSON.stringify(j?.error ?? j?.result?.error ?? ""));
    throw e;
  }
  return j.result;
}
const viewOn = async (rpc: Rpcish, account_id: string, method_name: string, args: unknown) =>
  JSON.parse(Buffer.from((await q(rpc, { request_type: "call_function", account_id, method_name, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") })).result).toString("utf8"));
async function view2(rpcs: readonly Rpcish[], account: string, method: string, args: unknown): Promise<any> {
  const [a, b] = await Promise.all(rpcs.map((r) => viewOn(r, account, method, args)));
  if (json(a) !== json(b)) throw new Error(`${account}.${method}: the two operators disagree`);
  return a;
}
/** view_account on each operator: its amount, or "absent" for an account that does not exist; a failed read throws. */
const accountOn = (rpcs: readonly Rpcish[], account: string) =>
  Promise.all(rpcs.map((r) => q(r, { request_type: "view_account", account_id: account }).then((v) => ({ amount: String(v.amount) }), (e) => (e.unknownAccount ? ("absent" as const) : Promise.reject(e)))));

/** The vault on each operator at final: its key list, its code hash and its config. */
export async function readVault(rpcs: readonly Rpcish[], vault: string) {
  return Promise.all(
    rpcs.map(async (r) => ({
      keys: (await q(r, { request_type: "view_access_key_list", account_id: vault })).keys,
      code_hash: (await q(r, { request_type: "view_account", account_id: vault })).code_hash,
      config: await viewOn(r, vault, "config", {}),
    })),
  );
}

/** --network: mainnet unless testnet is named. The testnet build's release values need __SIGN_NETWORK__ set before the wallet loads. */
function networkOf(v: Record<string, string>): Network {
  const n = v["--network"] ?? "mainnet";
  if (n !== "mainnet" && n !== "testnet") throw new Error("--network: mainnet or testnet");
  if (n === "testnet") (globalThis as any).__SIGN_NETWORK__ = "testnet";
  return n;
}

/** The gate and the vault's reads, then the release's values the run uses. */
async function opened(network: Network, bindRelayer?: string) {
  const record = JSON.parse(readFileSync(network === "mainnet" ? RECORD : TESTNET_RECORD, "utf8"));
  const pin = network === "mainnet" ? JSON.parse(readFileSync(PIN, "utf8")) : null;
  const { relayRpc, RELEASE_WITHDRAW_RELAYER } = await wallet("withdraw/relay.ts");
  const { RELEASE_RELAYER } = await wallet("deposit/bind.ts");
  const net = NEAR_NETWORKS[network];
  const urls = [net.fastnear[0], net.drpc] as const;
  const rpcs = [relayRpc(urls[0]), relayRpc(urls[1])] as const;
  // testnet's deposit relayer: the release names none (bind.ts RELEASE_RELAYER.testnet), so the rehearsal names the
  // helper's testnet gas account with --bind-relayer; on mainnet only the release's own is used
  if (bindRelayer !== undefined && network !== "testnet") throw new Error("--bind-relayer is for --network testnet only: mainnet uses the release's deposit relayer");
  const bind = network === "testnet" ? (bindRelayer ?? null) : RELEASE_RELAYER.mainnet;
  const relayers: Relayers = { bind, withdraw: RELEASE_WITHDRAW_RELAYER[network] };
  const gate = runProblems({ record, pin, net, rpcs, relayers, network });
  if (gate.length) throw new Error(`refused, nothing read or sent:\n  ${gate.join("\n  ")}`);
  const vp = vaultReadProblems(record, await readVault(rpcs, record.account_id));
  if (vp.length) throw new Error(`refused, nothing sent:\n  ${vp.join("\n  ")}`);
  const cfg = await view2(rpcs, record.account_id, "config", {});
  log(`the vault ${record.account_id} reads as the record on ${urls.join(" and ")}: no key, code ${record.code_hash}, asset ${record.asset}, scope ${record.scope}`);
  return { network, record, net, urls, rpcs, relayers: relayers as { bind: string; withdraw: { relayer_account: string; fee_recipient: string } }, vault: record.account_id as string, token: record.asset as string, scope: BigInt(record.scope), minDeposit: BigInt(cfg.min_deposit) };
}

type Opened = Awaited<ReturnType<typeof opened>>;

async function checkRecipient(o: Opened, to: unknown, others: string[] = []): Promise<string> {
  const reads = typeof to === "string" && ACCOUNT_ID.test(to) ? await accountOn(o.rpcs, to).catch(() => [null, null]) : [null, null];
  const p = recipientProblems(to, { vault: o.vault, token: o.token, others: [o.relayers.withdraw.relayer_account, o.relayers.withdraw.fee_recipient, ...others], reads });
  if (p.length) throw new Error(`refused, nothing sent: ${p.join("; ")}`);
  return to as string;
}

/** The run's seed64 from its words (16 bytes of entropy from the seed, testnet-t02.ts entropyOf's rule, its own tag). */
export async function seed64Of(seed: Buffer): Promise<Uint8Array> {
  const { entropyToWords, wordsToSeed64 } = await wallet("derive/index.ts");
  const entropy = Uint8Array.from(createHash("sha256").update(seed).update("vault-mainnet-money/words").digest().subarray(0, 16));
  const s: Uint8Array = wordsToSeed64(entropyToWords(entropy));
  entropy.fill(0);
  return s;
}

/** A fresh in-memory wallet store whose lane is `lane` (each fresh store draws one of 8 at random), and its note store. */
export async function storeOfLane(lane: number | null) {
  const req = createRequire(path.join(ROOT, "packages/wallet/package.json"));
  const { IDBFactory } = await import(pathToFileURL(req.resolve("fake-indexeddb")).href);
  const { openWalletStore } = await wallet("store/index.ts");
  const { openNoteStore } = await wallet("notes/store.ts");
  for (let t = 0; t < 256; t++) {
    const w = await openWalletStore({ indexedDB: new IDBFactory() });
    if (lane === null || w.lane === lane) return { w, ns: await openNoteStore(w) };
    w.close?.();
  }
  throw new Error(`no store drew lane ${lane} in 256 opens`);
}

/**
 * The run's deposit note at index i again, in a store of i's lane with its counter raised to i (store/index.ts
 * raiseDepositIndex, as a restore does): the same i, so the same U and precommitment, whatever lane a fresh store drew.
 */
export async function replanAt(w: { raiseDepositIndex(s: bigint, min: number): Promise<number> }, ns: { planDeposit(s: bigint, p: (ref: any) => bigint): Promise<any> }, seed64: Uint8Array, scope: bigint, i: number) {
  const { noteSecrets } = await wallet("notes/secrets.ts");
  await w.raiseDepositIndex(scope, i);
  return ns.planDeposit(scope, (ref: unknown) => noteSecrets(seed64, ref as never).precommitment);
}

/** The node stand-in for the page's prover worker: the pinned setup files, snarkjs fullProve, its own time. */
export async function nodeProver() {
  const { ZK_SETUP_FILES } = await import(pathToFileURL(path.join(ROOT, "packages/kit/src/zk/setup-files.ts")).href);
  const req = createRequire(path.join(ROOT, "packages/kit/package.json"));
  const snarkjs = await import(pathToFileURL(req.resolve("snarkjs")).href);
  const file = (name: string) => {
    const f = path.join(ROOT, "packages/kit/zk", name);
    const sha = createHash("sha256").update(readFileSync(f)).digest("hex");
    if (sha !== ZK_SETUP_FILES[name].sha256) throw new Error(`${name}: sha256 ${sha} is not the kit's pin`);
    return f;
  };
  const times: number[] = [];
  return {
    times,
    async load(circuit: string) {
      file(`${circuit}.wasm`);
      file(`${circuit}.zkey`);
    },
    async prove(circuit: string, input: Record<string, unknown>) {
      const t = Date.now();
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, file(`${circuit}.wasm`), file(`${circuit}.zkey`));
      const vkey = JSON.parse(readFileSync(file(`${circuit}.vkey`), "utf8"));
      if (!(await snarkjs.groth16.verify(vkey, publicSignals, proof))) throw new Error(`${circuit}: the proof does not verify against ${circuit}.vkey`);
      const proveMs = Date.now() - t;
      times.push(proveMs);
      return { proof, publicSignals, proveMs };
    },
  };
}

// ---- check: the gate, the vault read and, with --state, the run's U ----

async function check(argv: string[]) {
  const v = flags(argv, [], ["--network", "--state", "--to", "--bind-relayer", "--commit"], ["--not-on-main"]);
  const network = networkOf(v);
  if (v["--commit"] !== undefined || v["--not-on-main"] !== undefined) SOURCE = sourceOf(v, network);
  const o = await opened(network, v["--bind-relayer"]);
  const out: Record<string, unknown> = { network: o.network, vault: o.vault, token: o.token, min_deposit: o.minDeposit, bind_relayer: o.relayers.bind, withdraw_relayer: o.relayers.withdraw };
  if (v["--to"] !== undefined) out.to = await checkRecipient(o, v["--to"]);
  if (v["--state"] !== undefined) {
    const { repoRoots } = await import("./deploy.mjs");
    const st = stateDir(v["--state"], repoRoots(), { create: false, commit: SOURCE?.commit ?? null });
    const run = st.read("run");
    if (run === undefined) throw new Error("the run has not planned its note yet: paste 1 first, and this once it prints U");
    if (run.fingerprint !== fingerprintOf(st.seed) || run.network !== o.network) throw new Error("the folder's run step is not this seed's, or another network's: nothing is sent to its U");
    const U = run.U as string;
    const [a, b] = await accountOn(o.rpcs, U);
    const reg = await view2(o.rpcs, o.token, "storage_balance_of", { account_id: U });
    Object.assign(out, { U, u_exists: a !== "absent" && b !== "absent", u_registered: reg !== null, u_usdc: reg === null ? "0" : await view2(o.rpcs, o.token, "ft_balance_of", { account_id: U }) });
  }
  console.log(json(out));
  process.exit(0);
}

// ---- run / resume: plan, U's USDC, the deposit, the withdrawal to --to; every stop goes on from the chain ----

/** The commit this process signs from (--commit), held by sourceGate before every signature; null: a testnet run without one. */
let SOURCE: { commit: string; onMain: boolean } | null = null;

/**
 * The source a command runs from. Mainnet: --commit is required (the reviewed, merged commit the paste line names and
 * clones), and --not-on-main is refused. Testnet: --commit holds the same gate, --not-on-main skipping only its origin and
 * main check (the rehearsal of a commit not merged yet); no --commit, no gate (the offline tests).
 */
export function sourceOf(v: Record<string, string>, network: Network): { commit: string; onMain: boolean } | null {
  const notOnMain = v["--not-on-main"] !== undefined;
  if (notOnMain && network !== "testnet") throw new Error("refused, nothing signed: --not-on-main is for the testnet rehearsal only; a mainnet paste runs only a commit on main");
  if (v["--commit"] === undefined) {
    if (network === "mainnet") throw new Error("refused, nothing signed: a mainnet command runs only from a fresh clone at the commit its paste line names (--commit <sha>)");
    if (notOnMain) throw new Error("--not-on-main names no commit: give --commit <sha>");
    return null;
  }
  return { commit: v["--commit"], onMain: !notOnMain };
}

/**
 * Refuses unless the process runs from a fresh clone at SOURCE's commit, every file the commit's and node_modules
 * resolving inside it (source-gate.mjs cloneProblems), read again right before each signature and each load of code
 * that sees a secret: a tree changed while the run waited never signs.
 */
function sourceGate(at: string): void {
  if (SOURCE === null) return;
  const p = cloneProblems({ root: ROOT, commit: SOURCE.commit, onMain: SOURCE.onMain });
  if (p.length) throw new Error(`refused before ${at}, nothing signed: ${p.join("; ")}`);
}

/** The command's start: its source held, before anything is read. */
function started(v: Record<string, string>): Network {
  const network = networkOf(v);
  SOURCE = sourceOf(v, network);
  sourceGate("anything is read");
  return network;
}

async function go(argv: string[], create: boolean) {
  const v = flags(argv, ["--state", "--to"], ["--network", "--bind-relayer", "--commit", "--deposit-tx"], ["--not-on-main"]);
  const o = await opened(started(v), v["--bind-relayer"]);
  const { rpcs, vault, token, scope, relayers, network, minDeposit } = o;
  const to = await checkRecipient(o, v["--to"]);
  const { readWithdrawFeeMax } = await wallet("withdraw/feemax.ts");
  const { askWithdrawFee, relayWithdraw, WITHDRAW_URL } = await wallet("withdraw/relay.ts");
  const accounts = await wallet("arming/accounts.ts");
  const { readTokenStorageMin } = accounts;
  // the typed account's register deposit as SIGN_HOST's hand-off reads it (card wallet-withdraw-move-out), else main's
  // reader, which names no account (relayer-cost-guards: always the token's storage minimum)
  const registerDepositOf = (accounts.typedRegisterDepositOf ?? accounts.armingRegisterDepositOf)(network, rpcs);
  // the wallet must pay a named account and read its arrival (card wallet-withdraw-move-out): refused before any money
  // moves when it does not, so no deposit is made that this run cannot withdraw to --to
  const { withdrawArrival } = await wallet("withdraw/arrival.ts").catch(() => {
    throw new Error("refused, nothing sent: this wallet has no withdraw/arrival.ts, so it cannot pay a named account yet (card wallet-withdraw-move-out)");
  });
  const { bindDeposit, bindRpc } = await wallet("deposit/bind.ts");
  const { RELEASE_BIND_URL } = await wallet("deposit/delegate.ts");
  const { noteSecrets } = await wallet("notes/secrets.ts");
  const { depositAccount } = await wallet("deposit/account.ts");
  const { restoreNotes, writeRestored } = await wallet("notes/restore.ts");
  const { withdrawRequest, withdrawDeadlineMs } = await wallet("withdraw/request.ts");
  const { lowerFinalTime, treesOf } = await import(pathToFileURL(path.join(ROOT, "packages/signpage/src/withdraw/handoff.ts")).href);
  const { vaultSync, vaultSyncStart } = await import(pathToFileURL(path.join(ROOT, "packages/kit/src/vault/sync.ts")).href);
  // what a wait or a resume reads txs with (readBackBoth, recordRead), loaded here under the start's gate, before the
  // seed: no code loads later with seed64 in memory but the prover's, which has its own gate
  await import("./testnet-t04.mjs");
  await import("../../../scripts/ci/money-gate.mjs");

  // the fee, before any money moves: held to the device's own fee_max at the token's storage minimum (the register
  // deposit every withdrawal carries, arming/accounts.ts), on the smallest note the vault takes
  const feeOf = async (note: bigint) => {
    const quote = await askWithdrawFee({ token, relayer: relayers.withdraw, amount: note });
    const feeMax: bigint = await readWithdrawFeeMax({ network, rpcs, priceRpcs: network === "mainnet" ? rpcs : (await opened_mainnet_pair()), registerDeposit: await readTokenStorageMin(network, rpcs) });
    const fp = feeProblems({ relayFee: quote.relayFee, feeMax, note });
    if (fp.length) throw new Error(`refused: ${fp.join("; ")}`);
    return { relayFee: quote.relayFee as bigint, feeMax, feeRecipient: quote.feeRecipient as string };
  };
  const fee0 = await feeOf(minDeposit);
  log(`fee now: ${fee0.relayFee} to ${fee0.feeRecipient}, at most the device's fee_max ${fee0.feeMax}`);

  const { repoRoots } = await import("./deploy.mjs");
  const st = stateDir(v["--state"]!, repoRoots(), { create, commit: SOURCE?.commit ?? null });
  const seed64 = await seed64Of(st.seed);
  const fp = fingerprintOf(st.seed);
  let run = st.read("run");
  if (run !== undefined && (run.fingerprint !== fp || run.network !== network)) throw new Error("the folder's run step is not this seed's, or another network's: keep the folder as it is and say so");
  if (run === undefined) {
    // the first plan: a store of any lane; its index i and U are the run's from now on
    const first = await storeOfLane(null);
    const note = await first.ns.planDeposit(scope, (ref: unknown) => noteSecrets(seed64, ref).precommitment);
    run = { network, fingerprint: fp, i: note.ref.i, U: depositAccount(seed64, scope, note.ref.i).account, precommitment: String(note.precommitment), to };
    st.writeOnce("run", run);
    first.ns.close();
    first.w.close?.();
  }
  const rsp = runStepProblems(run, { fingerprint: fp, network, to });
  if (rsp.length) throw new Error(rsp.join("; "));
  const { i, U } = run as { i: number; U: string };
  await checkRecipient(o, v["--to"], [U]);
  log(`U is ${U} (U_{s,i}, i ${i}); the withdrawal goes to ${to}`);

  // the notes from the chain, in a store of the run's lane: the run's deposit note, if it landed, comes back UNSPENT
  // (or SPENT once withdrawn), and the deposit index i is the next the store plans when it did not
  let { w, ns } = await storeOfLane(i % LANES);
  const restored = await restoreNotes({ seed64, vault, token, rpcs });
  await writeRestored(ns, restored);
  const mine = (await ns.list()).find((n: any) => n.ref.kind === "deposit" && n.ref.i === i);
  // the balances kept beside each leg: asked again while the two operators are a block apart, never a stop (a leg that
  // landed goes on with "unread" balances)
  const balances = async (extra: Record<string, string> = {}): Promise<Record<string, unknown>> => (await retried(async () => {
    const out: Record<string, unknown> = { at: new Date().toISOString(), vault_usdc: await view2(rpcs, token, "ft_balance_of", { account_id: vault }), totals: await view2(rpcs, vault, "totals", {}) };
    for (const [k, id] of Object.entries(extra)) out[`${k}_usdc`] = await view2(rpcs, token, "ft_balance_of", { account_id: id });
    return out;
  }, 5)) ?? { at: new Date().toISOString(), unread: true };
  // every tx hash a relayer answers, kept the moment it is heard: a stop after it loses none of the record's txs
  const heard: { bind: string[]; withdraw: string[] } = st.read("heard") ?? { bind: [], withdraw: [] };
  const watch = async (url: unknown, init?: RequestInit): Promise<Response> => {
    const res = await fetch(url as string, init);
    const leg = String(url) === RELEASE_BIND_URL ? "bind" : String(url) === WITHDRAW_URL ? "withdraw" : null;
    if (leg !== null && res.status === 200) {
      const h = ((await res.clone().json().catch(() => null)) as { tx_hash?: unknown } | null)?.tx_hash;
      if (typeof h === "string" && !heard[leg].includes(h)) {
        heard[leg].push(h);
        st.write("heard", heard);
      }
    }
    return res;
  };

  // what proves a row of P is U's own (ownDeposit): the deposit relayer's txs heard or named, read back on both RPCs
  const named = v["--deposit-tx"];
  if (named !== undefined && !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(named)) throw new Error("--deposit-tx takes a tx hash");
  const wantOf = (): Omit<RunTxs, "value"> => ({ U, G: relayers.bind, R: relayers.withdraw.relayer_account, vault, token, P: run.precommitment, nf: "" });
  const depositTxs = (): string[] => [...heard.bind, ...(named === undefined ? [] : [named])];
  // a tx older than the release pair keeps (a resume days later) is read as the record reads it (recordRead)
  const readTx = (h: string) => readBackBoth(o.urls, h, relayers.bind).catch(() => recordRead(network, h, relayers.bind));

  let note = mine;
  if (note === undefined) {
    // not landed: plan index i again (the store's counter raised to it, in its lane) and deposit what is at U
    note = await replanAt(w, ns, seed64, scope, i);
    if (note.ref.i !== i || String(note.precommitment) !== run.precommitment) throw new Error(`planned index ${note.ref.i}, not the run's ${i}: nothing signed`);
    log(`waiting for U ${U} to exist and hold at least ${minDeposit} USDC (paste 2, then USDC from any wallet or exchange); no time limit, Ctrl-C and resume at any time`);
    let amount = 0n;
    let landed: any = undefined;
    for (let t = 0; ; t++) {
      const acct = await accountOn(rpcs, U).catch(() => null);
      const usdc = acct === null || acct.some((x) => x === "absent") ? null : await view2(rpcs, token, "ft_balance_of", { account_id: U }).catch(() => null);
      if (usdc !== null && BigInt(usdc) >= minDeposit) {
        amount = BigInt(usdc);
        break;
      }
      // U's call may have landed after the restore above (a stop while it was carried): its P in the deposits pages
      // ends the wait, and the note is restored into a fresh store of the lane, so nothing is signed twice
      const rows = await vaultSync({ vault, rpcs, cursor: vaultSyncStart(vault), lists: ["deposits"] }).then((x: any) => x.deposits as DepositRow[], () => null);
      if (rows !== null && rows.some((r) => r.precommitment === BigInt(run.precommitment))) {
        // a row of P ends the wait: U's own only when one of its txs reads back as the run's (ownDeposit), else a stop
        const own = await ownDeposit({ rows, want: wantOf(), amount: usdc === null ? 0n : BigInt(usdc), txs: depositTxs(), readTx });
        if (own.why !== null) throw new Error(`deposit: ${own.why}: resume goes on from here, and sweep-u sends what is at U to ${to}`);
        ns.close();
        w.close();
        ({ w, ns } = await storeOfLane(i % LANES));
        await writeRestored(ns, await restoreNotes({ seed64, vault, token, rpcs }));
        landed = (await ns.list()).find((n: any) => n.ref.kind === "deposit" && n.ref.i === i && n.leaf !== undefined);
        if (landed !== undefined) break;
      }
      if (t % 30 === 0) log(`U ${acct === null ? "not read" : acct.some((x) => x === "absent") ? "does not exist yet" : `holds ${usdc ?? "?"} USDC`}`);
      await sleep(POLL_MS);
    }
    if (landed !== undefined) {
      note = landed;
      log(`the deposit of P by U is in the vault's pages (leaf ${landed.leaf.leafIndex}): nothing signed again`);
    } else {
    // the fee held again on what is at U, right before U signs: a note the fee would leave unwithdrawable is not made
    await feeOf(amount);
    const before = await balances({ U });
    const tBind = Date.now();
    const deps: Record<string, unknown> = { store: ns, rpcs: [bindRpc(o.urls[0]), bindRpc(o.urls[1])], fetchFn: watch };
    if (network === "testnet") deps.relayerAccount = relayers.bind;
    sourceGate("U signs its deposit");
    const outcome = await bindDeposit(seed64, { network, s: scope, i, noteId: note.id, amount }, deps);
    log(`bindDeposit: ${outcome.kind} in ${Date.now() - tBind} ms`);
    const calls = outcome.note?.id === undefined ? [] : ((await ns.get(outcome.note.id))?.calls ?? []);
    const callTxs: string[] = calls.flatMap((c: { tx_hashes?: string[] }) => c.tx_hashes ?? []);
    const rows = outcome.kind !== "front_run" ? [] : await vaultSync({ vault, rpcs, cursor: vaultSyncStart(vault), lists: ["deposits"] }).then((x: any) => x.deposits as DepositRow[], () => null);
    const { why, row } = await bindProblem(outcome.kind, { rows, want: wantOf(), amount, txs: [...callTxs, ...depositTxs()], readTx });
    if (why !== null) throw new Error(`deposit: ${why} (${json(outcome)}); the USDC is at U or in the vault: resume goes on from here, and sweep-u sends what is at U to ${to}`);
    if (outcome.kind === "front_run") log(`U's own deposit of P landed first with ${row!.value}, its tx read back as the run's (U then held ${amount}: a later transfer): the run goes on with that note`);
    note = outcome.note;
    const txs = [...new Set([...callTxs, ...heard.bind])];
    const leaf = note.leaf;
    st.write("deposit", { amount: String(leaf.value), bind_ms: Date.now() - tBind, txs, relayer: relayers.bind, before, after: await balances({ U }), leaf: { value: String(leaf.value), label: String(leaf.label), commitment: String(leaf.commitment), leaf_index: String(leaf.leafIndex) } });
    log(`deposited ${leaf.value}: leaf ${leaf.leafIndex}; relayer txs ${txs.join(", ") || "none heard"}`);
    const left = BigInt(await view2(rpcs, token, "ft_balance_of", { account_id: U }).catch(() => "0"));
    if (left > 0n) log(`U still holds ${left} USDC that was not deposited: sweep-u sends it to ${to} (the run goes on)`);
    }
  }
  // every path (the bind, the wait's row, a resume's restore): the run's deposit leaf is U's own only by a landed tx of
  // U for P at its value; the hashes are the note's calls, the deposit step's, the heard and the named
  const noteTxs: string[] = ((await ns.get(note.id))?.calls ?? []).flatMap((c: { tx_hashes?: string[] }) => c.tx_hashes ?? []);
  const why = await leafProblem({ notes: await ns.list(), i, want: wantOf(), txs: [...noteTxs, ...(st.read("deposit")?.txs ?? []), ...depositTxs()], readTx });
  if (why !== null) throw new Error(`deposit: ${why}; the USDC is at U or in the vault: sweep-u sends what is at U to ${to}`);
  // the txs that may have proved it are kept in the deposit step (a --deposit-tx too), so a later resume and paste 3
  // need no retyped hash
  const held = st.read("deposit");
  if (held === undefined && note.leaf !== undefined) {
    // landed in an earlier attempt whose step file was not written: the record takes the leaf from the chain
    st.write("deposit", { amount: String(note.leaf.value), txs: [...new Set([...noteTxs, ...depositTxs()])], relayer: relayers.bind, restored: true, leaf: { value: String(note.leaf.value), label: String(note.leaf.label), commitment: String(note.leaf.commitment), leaf_index: String(note.leaf.leafIndex) } });
  } else if (held !== undefined && named !== undefined && !(held.txs ?? []).includes(named)) st.write("deposit", { ...held, txs: [...(held.txs ?? []), named] });

  // the note to withdraw: the run's UNSPENT note in the deposit's line (by parent), the deposit note or, after a refunded payout, its refund
  // note (settle writes it); none once the last one is spent, and the arrival read follows the note withdrawn last
  const pick = noteToWithdraw(await ns.list(), i);
  const last = st.read("withdraw");
  const nf: bigint = pick !== null ? noteSecrets(seed64, pick.ref).nullifierHash : last?.nullifier_hash !== undefined ? BigInt(last.nullifier_hash) : noteSecrets(seed64, note.ref).nullifierHash;
  if (pick !== null) {
    // the whole note to `to`, less the fee of this one quote: withdrawn = value, so no change note is left
    const value: bigint = pick.leaf.value;
    const fee = await feeOf(value);
    sourceGate("the prover loads and sees the note's secrets");
    const prover = await nodeProver();
    const trees = treesOf(await vaultSync({ vault, rpcs, cursor: vaultSyncStart(vault), lists: ["leaves", "labels"] }));
    const ns2 = await lowerFinalTime(rpcs);
    const before = await balances({ to, F: fee.feeRecipient });
    const req = await withdrawRequest({
      seed64, notes: ns, prover, vaultId: vault, token, ...trees, registerDepositOf,
      feeRecipient: fee.feeRecipient, relayFee: fee.relayFee, network, rpcs, priceRpcs: network === "mainnet" ? rpcs : await opened_mainnet_pair(),
      amount: value - fee.relayFee, to, deadlineMs: withdrawDeadlineMs(ns2), blockTimestampNanosec: ns2,
    });
    const rp = requestProblems(req, to, pick.id);
    if (rp.length) throw new Error(`refused, the proof made and nothing sent: ${rp.join("; ")}; the note stays in the vault, and resume makes a new request`);
    st.write("withdraw", { to, value: String(value), relay_fee: String(fee.relayFee), fee_recipient: fee.feeRecipient, nullifier_hash: String(nf), prove_ms: prover.times, before });
    sourceGate("the withdrawal is signed");
    const out = await relayWithdraw(seed64, req, { notes: ns, network, rpcs, priceRpcs: network === "mainnet" ? rpcs : await opened_mainnet_pair(), fetchFn: watch });
    log(`relayWithdraw: ${out.kind}`);
    if (out.kind !== "landed") throw new Error(`withdrawal: ${out.kind}; the note is in the vault: resume makes a new request`);
  }
  // the arrival at `to`: the spend row paid to it, read on both RPCs (arrival.ts)
  const arrival = await withdrawArrival({ network, rpcs, nullifierHash: nf, recipient: to });
  if (arrival.kind === "refunded") throw new Error(`the payout to ${to} was refunded into the vault (${json(arrival.spend)}): once its settle writes the refund note, resume withdraws that note to ${to}`);
  if (arrival.kind !== "arrived") throw new Error(`the withdrawal ${arrival.kind}: ${json(arrival.spend)}`);
  const s = await vaultSync({ vault, rpcs, cursor: vaultSyncStart(vault), lists: ["spends", "leaves"] });
  const row = s.spends.find((x: { nullifierHash: bigint }) => x.nullifierHash === nf)!;
  const prev = st.read("withdraw") ?? {};
  st.write("withdraw", {
    ...prev, done: true, to, nullifier_hash: String(nf),
    row: { index: row.index, status: row.status, recipient: row.recipient, withdrawn: String(row.withdrawn), fee: String(row.fee), payer: row.payer, new_leaf_index: String(row.newLeafIndex), refund_value: String(row.refundValue) },
    change_commitment: String(s.leaves[Number(row.newLeafIndex)]), after: await balances({ to, F: prev.fee_recipient ?? to }),
  });
  seed64.fill(0);
  log(`arrived: spends row #${row.index} ${row.status}, ${row.withdrawn} withdrawn, fee ${row.fee}, to ${row.recipient}; withdraw txs heard ${heard.withdraw.join(", ") || "none"}`);
  log("next: paste 3, the record");
  process.exit(0);
}

/** Mainnet's release pair, for fee_max's NEAR price pool on a testnet run (the wallet's priceRpcs rule). */
async function opened_mainnet_pair() {
  const { relayRpc } = await wallet("withdraw/relay.ts");
  return [relayRpc(NEAR_NETWORKS.mainnet.fastnear[0]), relayRpc(NEAR_NETWORKS.mainnet.drpc)] as const;
}

// ---- open-u: the payer opens U, signed here ----

/** Signs and sends one transaction on the pair's first RPC, then reads it back FINAL on both; { hash } or throws. */
async function sendTx(o: Opened, signer: string, key: any, receiver: string, actions: unknown[], keep: (hash: string, error?: string) => void) {
  sourceGate(`${signer} signs`);
  const { encodeTx } = await import("./testnet-usdc.mjs");
  const { b58decode, b58encode } = await import("./near-tx.mjs");
  const pk = `ed25519:${b58encode(key.pub)}`;
  const ak = await q(o.rpcs[0], { request_type: "view_access_key", account_id: signer, public_key: pk });
  const block: any = await (o.rpcs[0] as any).block({ finality: "final" });
  const tx = encodeTx({ signer, publicKey: key.pub, nonce: BigInt(ak.nonce) + 1n, receiver, blockHash: b58decode(block.result.header.hash), actions });
  const h = createHash("sha256").update(tx).digest();
  const signed = Buffer.concat([tx, Buffer.from([0]), sign(null, h, key.privateKey)]);
  const hash = b58encode(h);
  keep(hash); // the hash is kept before it is sent: a stop after the send loses no tx of the record
  const answer = await fetch(o.urls[0], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: CARD, method: "send_tx", params: { signed_tx_base64: signed.toString("base64"), wait_until: "FINAL" } }), signal: AbortSignal.timeout(60_000) })
    .then((r) => r.json(), () => null)
    .catch(() => null);
  const err = sendAnswerError(answer);
  if (err !== null) {
    keep(hash, err); // the RPC's refusal kept beside the hash, and reported now rather than after the read-back's minute
    throw new Error(`${hash} (${signer}) refused by ${o.urls[0]}: ${err}`);
  }
  await readBackBoth(o.urls, hash, signer);
  return hash;
}

/** Every receipt of `hash` FINAL and a success on both RPCs (asked again for up to a minute while unknown); else throws. Returns the transaction as read. */
async function readBackBoth(urls: readonly string[], hash: string, signer: string): Promise<unknown> {
  const { successProblems } = await import("./testnet-t04.mjs");
  let tx: unknown = null;
  for (const url of urls) {
    let p: string[] = ["not read"];
    for (let t = 0; t < 20; t++) {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: CARD, method: "EXPERIMENTAL_tx_status", params: { tx_hash: hash, sender_account_id: signer, wait_until: "FINAL" } }), signal: AbortSignal.timeout(30_000) }).catch(() => null);
      const j: any = await res?.json().catch(() => null);
      if (j?.result) {
        p = successProblems(j.result);
        if (j.result.final_execution_status !== "FINAL") p.push("not FINAL");
        if (tx === null) tx = j.result.transaction ?? null;
        else if (json(tx) !== json(j.result.transaction ?? null)) p.push("the two RPCs return different transactions");
        break;
      }
      p = [`not read: ${JSON.stringify(j?.error ?? null).slice(0, 160)}`];
      await sleep(3000);
    }
    if (p.length) throw new Error(`${hash} (${signer}) on ${url}: ${p.join("; ")}`);
  }
  return tx;
}

/**
 * The record's read of a tx, as the money gate reads it after (scripts/ci/money-gate.mjs: readTx on each host of its
 * list, which holds FastNEAR's archival hosts, so a tx older than the release pair keeps is still read): a success,
 * FINAL, every receipt a success, on or after the build's start, and no host reading it failed. Read ok by two operators,
 * their transactions must be one; read by one only (FastNEAR: dRPC keeps recent txs only, and no second keyless archival
 * operator exists), it passes as the gate passes it, by proveRead: its signed bytes, rebuilt from FastNEAR's tx JSON,
 * hash to the id, and its outcomes are proven against a final block dRPC names. Returns the transaction; throws why not.
 */
export async function recordRead(network: Network, hash: string, signer: string, fetchFn: typeof fetch = fetch, pause?: (ms: number) => Promise<void>): Promise<any> {
  const gate: any = await import("../../../scripts/ci/money-gate.mjs");
  const chain = network === "mainnet" ? "near" : "near-testnet";
  const tx = { chain, hash, signer };
  const list: string[] = gate.RPCS[chain];
  const answers: { url: string; r: string; result?: any }[] = [];
  for (const url of list) {
    const out: { result?: any } = {};
    // the gate's rule (moneyGate): a 429 is waited out only while the host could add a second operator, so a host
    // whose operator already read it ok, or one asked after two operators have, is asked once and never waited
    const ops = gate.okOperators(chain, answers);
    const rateWait = ops.size < 2 && !ops.has(gate.operatorOf(chain, url));
    answers.push({ url, r: await gate.readTx(fetchFn, url, tx, gate.FLOOR, pause, rateWait, out), result: out.result });
  }
  const said = answers.map((a) => `${a.r} on ${a.url}`).join(", ");
  if (answers.some((a) => /^(failed|old)/.test(a.r))) throw new Error(`${hash} (${signer}): ${said}`);
  const ok = answers.filter((a) => a.r === "ok" && a.result);
  if (new Set(ok.map((a) => json(a.result.transaction ?? null))).size > 1) throw new Error(`${hash} (${signer}): the RPCs return different transactions`);
  const ops = gate.okOperators(chain, answers);
  if (ops.size >= 2) return ok[0]!.result.transaction;
  if (ops.size === 1) {
    try {
      await gate.proveRead(fetchFn, tx, answers, list, gate.FLOOR, pause);
    } catch (e) {
      throw new Error(`${hash} (${signer}): ${said}; read by one operator and not proven: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
    }
    return ok[0]!.result.transaction;
  }
  throw new Error(`${hash} (${signer}): ${said}`);
}

type RunTxs = { U: string; G: string; R: string; vault: string; token: string; P: string; value: string; nf: string };
const argsOf = (fc: any): any => {
  try {
    return JSON.parse(Buffer.from(String(fc?.args ?? ""), "base64").toString("utf8"));
  } catch {
    return null;
  }
};
/**
 * [] when a relayer's transaction (EXPERIMENTAL_tx_status's `transaction`) is the run's own: the deposit is the
 * deposit relayer G carrying U's one signed ft_transfer_call of the note's value to the vault with the run's P; the
 * withdrawal is the withdrawal relayer R calling the vault's withdraw with the note's nullifier hash and its whole value.
 */
export function relayerTxProblems(kind: "deposit" | "withdraw", t: any, want: RunTxs): string[] {
  if (t === null || typeof t !== "object" || !Array.isArray(t.actions) || t.actions.length !== 1) return [`the ${kind} tx is not one action`];
  const p: string[] = [];
  if (kind === "deposit") {
    if (t.signer_id !== want.G) p.push(`signed by ${t.signer_id}, not the deposit relayer ${want.G}`);
    if (t.receiver_id !== want.U) p.push(`sent to ${t.receiver_id}, not U ${want.U}`);
    const da = t.actions[0]?.Delegate?.delegate_action;
    const fc = Array.isArray(da?.actions) && da.actions.length === 1 ? da.actions[0]?.FunctionCall : undefined;
    const args = argsOf(fc);
    let msg: any = null;
    try {
      msg = JSON.parse(String(args?.msg));
    } catch {}
    if (da?.sender_id !== want.U || da?.receiver_id !== want.token) p.push("not U's delegate to the token");
    if (fc?.method_name !== "ft_transfer_call") p.push(`calls ${fc?.method_name}, not ft_transfer_call`);
    if (args?.receiver_id !== want.vault || String(args?.amount) !== want.value) p.push(`moves ${args?.amount} to ${args?.receiver_id}, not ${want.value} to the vault`);
    if (String(msg?.precommitment) !== want.P || msg?.depositor !== want.U) p.push("not the run's precommitment by U");
  } else {
    if (t.signer_id !== want.R) p.push(`signed by ${t.signer_id}, not the withdrawal relayer ${want.R}`);
    if (t.receiver_id !== want.vault) p.push(`sent to ${t.receiver_id}, not the vault`);
    const fc = t.actions[0]?.FunctionCall;
    const sig = argsOf(fc)?.public_signals;
    if (fc?.method_name !== "withdraw") p.push(`calls ${fc?.method_name}, not withdraw`);
    if (!Array.isArray(sig) || String(sig[1]) !== want.nf || String(sig[2]) !== want.value) p.push("not the note's nullifier hash and whole value");
  }
  return p;
}

async function openU(argv: string[]) {
  const v = flags(argv, ["--state", "--payer", "--key-file"], ["--network", "--bind-relayer", "--register", "--commit"], ["--not-on-main"]);
  const o = await opened(started(v), v["--bind-relayer"]);
  const { repoRoots, loadKey } = await import("./deploy.mjs");
  const { act } = await import("./testnet-usdc.mjs");
  const st = stateDir(v["--state"]!, repoRoots(), { create: false, commit: SOURCE?.commit ?? null });
  const run = st.read("run");
  if (run === undefined || run.fingerprint !== fingerprintOf(st.seed) || run.network !== o.network) throw new Error("the folder holds no run step of this seed and network: paste 1 first; nothing sent");
  const U = run.U as string;
  const payer = v["--payer"]!;
  const key = loadKey(v["--key-file"], payer, repoRoots());
  const kept = st.read("open-u") ?? { txs: [] as { hash: string; signer: string; what: string }[] };
  // each hash is kept before its tx is sent (sendTx), so a stop between the send and the read-back loses none
  const keep = (what: string) => (hash: string, error?: string) => {
    const at = kept.txs.find((t: { hash: string }) => t.hash === hash);
    if (at === undefined) kept.txs.push({ hash, signer: payer, what, ...(error ? { error } : {}) });
    else if (error) at.error = error;
    st.write("open-u", kept);
  };
  const done = (hash: string, what: string) => log(`${what}: ${hash} read back FINAL on both RPCs, every receipt a success`);
  // --register: an existing account the payer registers on the token, checked on both RPCs before anything is sent
  const reg = v["--register"];
  const regBal = reg !== undefined && ACCOUNT_ID.test(reg) ? await Promise.all(o.rpcs.map((r) => viewOn(r, o.token, "storage_balance_of", { account_id: reg }).then((x) => x !== null, () => null))) : [];
  const rp = v["--register"] === undefined ? [] : registerProblems(reg, { reads: reg !== undefined && ACCOUNT_ID.test(reg) ? await accountOn(o.rpcs, reg).catch(() => [null, null]) : [null, null], registered: regBal.some((x) => x === null) ? [] : (regBal as boolean[]) });
  if (rp.length) throw new Error(`refused, nothing sent: ${rp.join("; ")}`);
  const bounds = async () => {
    const b = await view2(o.rpcs, o.token, "storage_balance_bounds", {});
    if (b?.min !== b?.max) throw new Error(`the token's storage_balance_bounds ${json(b)} is not min = max: nothing sent`);
    return BigInt(b.min);
  };
  const acct = await accountOn(o.rpcs, U);
  if (acct.every((x) => x === "absent")) done(await sendTx(o, payer, key, U, [act.transfer(U_OPEN_YOCTO)], keep(`Transfer 0.01 NEAR to U ${U}`)), `Transfer 0.01 NEAR to U ${U}`);
  else if (acct.some((x) => x === "absent")) throw new Error(`U ${U} exists on one RPC only: nothing sent; run this again in a minute`);
  if ((await view2(o.rpcs, o.token, "storage_balance_of", { account_id: U })) === null) {
    const b = await view2(o.rpcs, o.token, "storage_balance_bounds", {});
    if (b?.min !== b?.max) throw new Error(`the token's storage_balance_bounds ${json(b)} is not min = max: nothing sent`);
    done(await sendTx(o, payer, key, o.token, [act.call("storage_deposit", { account_id: U, registration_only: true }, 30n * TGAS, BigInt(b.min))], keep(`storage_deposit of U on ${o.token}`)), `storage_deposit of U on ${o.token}`);
  }
  if (reg !== undefined) done(await sendTx(o, payer, key, o.token, [act.call("storage_deposit", { account_id: reg, registration_only: true }, 30n * TGAS, await bounds())], keep(`storage_deposit of ${reg} on ${o.token}`)), `storage_deposit of ${reg} on ${o.token}`);
  log(`U ${U} exists and is registered on both RPCs: send at least ${o.minDeposit} USDC (base units) to it from any wallet or exchange`);
  process.exit(0);
}

// ---- sweep-u: U's USDC to the named account, signed by U ----

async function sweepU(argv: string[]) {
  const v = flags(argv, ["--state"], ["--network", "--bind-relayer", "--commit"], ["--not-on-main"]);
  const o = await opened(started(v), v["--bind-relayer"]);
  const { repoRoots } = await import("./deploy.mjs");
  const { act } = await import("./testnet-usdc.mjs");
  const st = stateDir(v["--state"]!, repoRoots(), { create: false, commit: SOURCE?.commit ?? null });
  const run = st.read("run");
  if (run === undefined || run.fingerprint !== fingerprintOf(st.seed) || run.network !== o.network) throw new Error("the folder holds no run step of this seed and network: nothing sent");
  const U = run.U as string;
  const to = await checkRecipient(o, run.to, [U]);
  const balance = BigInt(await view2(o.rpcs, o.token, "ft_balance_of", { account_id: U }));
  const toRegistered = (await view2(o.rpcs, o.token, "storage_balance_of", { account_id: to })) !== null;
  const sp = sweepProblems({ balance, toRegistered });
  if (balance <= 0n) {
    log(sp[0]!);
    process.exit(0);
  }
  if (sp.length) throw new Error(`refused, nothing sent: ${sp.join("; ")}`);
  const seed64 = await seed64Of(st.seed);
  const key = uSigner(seed64, o.scope, run.i, U);
  seed64.fill(0);
  const kept = st.read("sweep") ?? { txs: [] as { hash: string; signer: string; amount: string; to: string }[] };
  const hash = await sendTx(o, U, key, o.token, [act.call("ft_transfer", { receiver_id: to, amount: String(balance) }, 30n * TGAS, 1n)], (h, error) => {
    const at = kept.txs.find((t: { hash: string }) => t.hash === h);
    if (at === undefined) kept.txs.push({ hash: h, signer: U, amount: String(balance), to, ...(error ? { error } : {}) });
    else if (error) (at as any).error = error;
    st.write("sweep", kept);
  });
  log(`ft_transfer of ${balance} from U ${U} to ${to}: ${hash} read back FINAL on both RPCs, every receipt a success`);
  process.exit(0);
}

// ---- record: public values only ----

/** The record the money gate reads: Money path, one Tx line per transaction, then the prose. */
export function recordText(txs: { hash: string; signer: string }[], prose: string[], network: Network = "mainnet"): string {
  return [`CARD ${recordKey(network)} / live: PASS`, "Money path: yes", ...txs.map((t) => `Tx: ${network === "mainnet" ? "near" : "near-testnet"} ${t.hash} ${t.signer}`), "", ...prose, ""].join("\n");
}

/**
 * [] when the record names every transaction of the run: U's opening (open-u.json; none when U was opened another
 * way), its USDC funding (--fund-tx, the sender's: the run cannot see it), at least one deposit and one withdrawal tx
 * of the relayers that read back a success, and the settle (--settle-tx) when the spend row is settled.
 */
export function recordProblems(a: { fund: number; deposit: number; withdraw: number; status: string; settle: number }): string[] {
  const p: string[] = [];
  if (a.fund === 0) p.push("no --fund-tx: name the transaction(s) that sent U its USDC (the wallet's or the exchange's), with its signer");
  if (a.deposit === 0) p.push("no deposit tx heard from the relayer reads back a success");
  if (a.withdraw === 0) p.push("no withdrawal tx heard from the relayer reads back a success");
  if (a.status === "settled" && a.settle === 0) p.push("the spend row is settled: name its settle tx with --settle-tx");
  if (a.status !== "settled" && a.status !== "paid") p.push(`the spend row is ${a.status}, not paid or settled`);
  return p;
}

/** The relayers' heard txs that read back a success (recordRead) and are the run's; the rest (a resend the vault refused) are left out. */
async function landedOf(network: Network, hashes: string[], signer: string, mine: (t: unknown) => string[]) {
  const ok: { hash: string; signer: string }[] = [];
  for (const hash of [...new Set(hashes)]) {
    try {
      const p = mine(await recordRead(network, hash, signer));
      if (p.length) throw new Error(`not the run's: ${p.join("; ")}`);
      ok.push({ hash, signer });
    } catch (e) {
      log(`${hash} (${signer}) left out: ${(e as Error).message}`);
    }
  }
  return ok;
}

async function record(argv: string[]) {
  type Named = "--fund-tx" | "--settle-tx" | "--deposit-tx" | "--withdraw-tx";
  const named: Record<Named, { hash: string; signer: string }[]> = { "--fund-tx": [], "--settle-tx": [], "--deposit-tx": [], "--withdraw-tx": [] };
  const rest: string[] = [];
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k]!;
    if (a === "--fund-tx" || a === "--settle-tx" || a === "--deposit-tx" || a === "--withdraw-tx") {
      if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(argv[k + 1] ?? "") || !ACCOUNT_ID.test(argv[k + 2] ?? "")) throw new Error(`${a} takes a tx hash and its signer`);
      named[a].push({ hash: argv[k + 1]!, signer: argv[k + 2]! });
      k += 2;
    } else rest.push(a);
  }
  const v = flags(rest, ["--state"], ["--network", "--bind-relayer", "--commit"], ["--not-on-main"]);
  const o = await opened(started(v), v["--bind-relayer"]);
  const { repoRoots } = await import("./deploy.mjs");
  const st = stateDir(v["--state"]!, repoRoots(), { create: false, commit: SOURCE?.commit ?? null });
  const run = st.read("run"), d = st.read("deposit"), w = st.read("withdraw"), u = st.read("open-u") ?? { txs: [] };
  const heard = st.read("heard") ?? { bind: [], withdraw: [] };
  const sweepTxs: { hash: string; signer: string }[] = (st.read("sweep") ?? { txs: [] }).txs;
  if (run?.fingerprint !== fingerprintOf(st.seed) || run.network !== o.network || d === undefined || w?.done !== true) throw new Error("record: the run has not landed both legs");
  // the owner's named txs must each read back a success, or nothing is written; open-u's and sweep-u's are kept before
  // they are sent, so one whose send never reached the chain is left out (logged), as a relayer's resend is
  for (const t of [...named["--fund-tx"], ...named["--settle-tx"]]) await recordRead(o.network, t.hash, t.signer);
  const opens = (await Promise.all([...new Set(u.txs.map((t: any) => t.signer))].map((sg) => landedOf(o.network, u.txs.filter((t: any) => t.signer === sg).map((t: any) => t.hash), sg as string, () => [])))).flat();
  const sweeps = await landedOf(o.network, sweepTxs.map((t) => t.hash), run.U, () => []);
  // each relayer tx, heard or named (a hash the device never heard: the relayer's answer came after its timeout), is
  // read back and held to the run: signer, receiver, method, amount, P or nullifier hash; a named one that is not refuses
  const want: RunTxs = { U: run.U, G: d.relayer, R: o.relayers.withdraw.relayer_account, vault: o.vault, token: o.token, P: run.precommitment, value: d.leaf.value, nf: w.nullifier_hash };
  for (const [flag, kind, signer] of [["--deposit-tx", "deposit", want.G], ["--withdraw-tx", "withdraw", want.R]] as const)
    for (const t of named[flag]) {
      if (t.signer !== signer) throw new Error(`record: ${flag} ${t.hash} names ${t.signer}, not the ${kind} relayer ${signer}`);
      const p = relayerTxProblems(kind, await recordRead(o.network, t.hash, t.signer), want);
      if (p.length) throw new Error(`record: ${flag} ${t.hash} is not the run's ${kind}: ${p.join("; ")}`);
    }
  const deposits = await landedOf(o.network, [...d.txs, ...heard.bind, ...named["--deposit-tx"].map((t) => t.hash)], want.G, (t) => relayerTxProblems("deposit", t, want));
  const withdraws = await landedOf(o.network, [...heard.withdraw, ...named["--withdraw-tx"].map((t) => t.hash)], want.R, (t) => relayerTxProblems("withdraw", t, want));
  const rp = recordProblems({ fund: named["--fund-tx"].length, deposit: deposits.length, withdraw: withdraws.length, status: w.row.status, settle: named["--settle-tx"].length });
  if (rp.length) throw new Error(`record: ${rp.join("; ")}`);
  const txs = [...opens, ...named["--fund-tx"], ...deposits, ...withdraws, ...sweeps, ...named["--settle-tx"]];
  for (const t of txs) log(`${t.hash} (${t.signer}) read back FINAL, every receipt a success, as the money gate reads it`);
  const runRec = {
    card: CARD, network: o.network, commit: st.commit, vault: o.vault, asset: o.token,
    accounts: { U: run.U, to: w.to, F: w.fee_recipient, R: o.relayers.withdraw.relayer_account, G: d.relayer },
    deposit: { value: d.leaf.value, precommitment: run.precommitment, label: d.leaf.label, leaf_index: d.leaf.leaf_index, commitment: d.leaf.commitment },
    withdraw: { withdrawn: w.row.withdrawn, relay_fee: w.row.fee, nullifier_hash: w.nullifier_hash, change_leaf_index: w.row.new_leaf_index, change_commitment: w.change_commitment },
  };
  const prose = [
    `The run: contracts/vault/scripts/mainnet-money.ts on NEAR ${o.network}, the keyless vault ${o.vault} on USDC ${o.token}, both legs carried by the deployed helper.`,
    st.commit === null ? "Signed from a checkout with no commit named (a testnet run without --commit)." : `Every signature of the run was made from a fresh clone of ${o.network === "mainnet" || SOURCE?.onMain ? "the public repo" : "a commit not yet on main (the testnet rehearsal)"} at commit ${st.commit}, every file read against that commit's tree right before each signature (contracts/vault/scripts/source-gate.mjs); each step file of the run names it.`,
    `Deposit: U ${run.U} (U_{s,i} of the run's 12 words, i ${run.i}) signed its ft_transfer_call as a NEP-366 DelegateAction (packages/wallet/src/deposit/bind.ts bindDeposit), carried by ${d.relayer}; the deposits page holds P ${run.precommitment} by U with ${d.leaf.value}, label ${d.leaf.label}, leaf ${d.leaf.leaf_index}.`,
    `Withdrawal: the wallet's withdrawRequest to ${w.to} (fund_recipient false, no change: withdrawn = the note), proved in this process by snarkjs fullProve on the kit's pinned setup files (the stand-in for the page's prover worker), carried by ${o.relayers.withdraw.relayer_account}; spends row #${w.row.index}: ${w.row.withdrawn} withdrawn to ${w.row.recipient}, fee ${w.row.fee} to ${w.fee_recipient}, payer ${w.row.payer}, ${w.row.status}.`,
    `Every Tx above read back FINAL, every receipt a success, as scripts/ci/money-gate.mjs reads it: on two operators, or, older than dRPC keeps, on FastNEAR's archival RPC and proven against a final block dRPC names.`,
    d.before ? `Before the deposit (${d.before.at}): U USDC ${d.before.U_usdc}, vault USDC ${d.before.vault_usdc}, totals ${JSON.stringify(d.before.totals)}. After (${d.after.at}): U USDC ${d.after.U_usdc}, vault USDC ${d.after.vault_usdc}, totals ${JSON.stringify(d.after.totals)}.` : "The deposit's balances were not kept: its step was restored from the chain.",
    w.before ? `Before the withdrawal (${w.before.at}): ${w.to} USDC ${w.before.to_usdc}, F USDC ${w.before.F_usdc}, vault USDC ${w.before.vault_usdc}. After (${w.after.at}): ${w.to} USDC ${w.after.to_usdc}, F USDC ${w.after.F_usdc}, vault USDC ${w.after.vault_usdc}, totals ${JSON.stringify(w.after.totals)}.` : "",
  ].filter(Boolean);
  const text = recordText(txs, prose, o.network);
  const { localProblems } = await import("./testnet-t02.ts");
  const os = await import("node:os");
  const lp = localProblems(text + JSON.stringify(runRec), [os.hostname(), os.hostname().split(".")[0]!, os.userInfo().username]);
  if (lp.length) throw new Error(`record: ${lp.join("; ")}`);
  // beside the step state, never in the checkout: a later paste's clean-tree gate never meets them, and the team commits
  // them from there as scripts/live-checks/<name>
  const files = recordFiles(st.dir, o.network);
  writeFileSync(files.run, JSON.stringify(runRec, null, 2) + "\n");
  writeFileSync(files.md, text);
  console.log(text);
  log(`the record: ${files.md} and ${files.run} (outside the checkout; commit them as scripts/live-checks/${path.basename(files.md)} and ${path.basename(files.run)})`);
}

/** The record's key: the card's on mainnet, its own on testnet (the rehearsal), so the money gate reads each under its own name. */
export function recordKey(network: Network): string {
  return network === "mainnet" ? CARD : `${CARD}-testnet`;
}

/** Where record writes: the run's folder, named as the money gate's records are (scripts/live-checks/<key>.{run.json,md}, the key <card> or <card>-testnet). */
export function recordFiles(dir: string, network: Network) {
  const key = recordKey(network);
  return { run: path.join(dir, `${key}.run.json`), md: path.join(dir, `${key}.md`) };
}

function flags(argv: string[], required: string[], optional: string[] = [], booleans: string[] = []): Record<string, string> {
  const v: Record<string, string> = {};
  const allowed = [...required, ...optional];
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k]!;
    if (booleans.includes(a)) v[a] = "yes";
    else if (allowed.includes(a) && k + 1 < argv.length && !argv[k + 1]!.startsWith("--")) v[a] = argv[++k]!;
    else throw new Error(`unknown argument ${a}`);
  }
  for (const k of required) if (!v[k]) throw new Error(`${k} is required`);
  return v;
}

const [cmd, ...rest] = process.argv.slice(2);
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const commands: Record<string, () => Promise<void>> = { check: () => check(rest), run: () => go(rest, true), resume: () => go(rest, false), "open-u": () => openU(rest), "sweep-u": () => sweepU(rest), record: () => record(rest) };
  const fn = cmd === undefined ? undefined : commands[cmd];
  if (!fn) {
    console.error("usage: mainnet-money.ts check|run|resume|open-u|sweep-u|record ... (see the file's head)");
    process.exit(2);
  }
  fn().catch((e) => {
    console.error(`mainnet-money: ${e?.message ?? e}`);
    console.error("mainnet-money: keep the --state folder as it is; resume goes on from where this stopped");
    process.exit(1);
  });
}
