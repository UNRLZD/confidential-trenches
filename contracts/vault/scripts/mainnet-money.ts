#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// The mainnet money run (card vault-mainnet-money): one 5 USDC deposit and one relayed withdrawal on the real vault of
// contracts/vault/deployments/mainnet-v1.json, both carried by the deployed helper. testnet-t02.ts and
// testnet-withdraw-send.ts opened to mainnet: their device side is kept (the wallet's and the signing page's own
// modules), and their in-process carry, with relayer keys of this script's own, is what mainnet drops. Here the
// release's helper carries both legs, so nothing in this script holds a key that sends a transaction:
//   - the deposit: the note store's planDeposit, U = U_{s,i} (packages/wallet/src/deposit/account.ts), U's signed call and
//     its follow to the note's leaf (deposit/bind.ts bindDeposit), sent to RELEASE_BIND_URL with the release's deposit
//     relayer (RELEASE_RELAYER.mainnet), exactly as the signing page sends it;
//   - the withdrawal: the signing page's withdrawHandoff (packages/signpage/src/withdraw/handoff.ts), which asks the
//     release relayer's fee, makes the wallet's withdrawRequest (the kit's request and circuit input, the device's own
//     fee_max, the note RESERVED) and follows relayWithdraw (POST /v1/withdraw) to the change note on two RPCs.
// The one stand-in: the prover. The page's prover worker (packages/signpage/public/prover-worker.js) runs snarkjs'
// groth16.fullProve on the pinned setup files in a browser; here the same call runs in this process on the same files,
// each refused unless its sha256 is the kit's pin (ZK_SETUP_FILES), and the proof is checked against withdraw.vkey.
//
// Refused before anything is read, signed or sent (runProblems, tested in mainnet-money.test.ts): a record that is not
// mainnet-v1.pin.json field for field, or not deployed; a vault id or asset other than the kit's mainnet row; RPCs that
// are not mainnet's release pair (one FastNEAR URL and dRPC: two operators); a release that names no mainnet deposit or
// withdrawal relayer. Then the vault is read on both operators (vaultReadProblems): no key, the record's code hash, its
// asset and scope. The fee is asked and held to the device's fee_max before the deposit (feeProblems), so no USDC goes
// into the vault while its way out would be refused.
//
// Accounts: U  the deposit account U_{s,i} of this run's 12 words (s the vault's scope, i a fresh note store's first);
//              opened by the owner's paste 2 (0.01 NEAR and its USDC registration, mainnet-money/2-open-u.sh) and
//              funded with 5 USDC from any wallet or exchange, while paste 1 (1-run.sh) waits.
//           A  the withdrawal's recipient, A_{l,j} of the spent note (the wallet's rule, request.ts): this seed's.
// This run's seed (32 random bytes: its 12 words) lives in --state, a file outside the repo (mode 600, t04's loadState);
// it holds 5 USDC at most, and the exit tool takes it out with the words alone. Nothing secret is printed.
//
//   node contracts/vault/scripts/mainnet-money.ts check [--u <U>]        the gate, the vault read, U's state (no money)
//   node contracts/vault/scripts/mainnet-money.ts run --state <path>     plans U (written alone to <path>.u), waits for
//        its NEAR account and 5 USDC, deposits, withdraws: one process, as its note store lives in memory
//   node contracts/vault/scripts/mainnet-money.ts record --state <path> [--tx <hash> <signer>]...
//        writes scripts/live-checks/vault-mainnet-money.run.json and .md (the txs the device did not see, the owner's
//        pastes and the helper's settle, are named with --tx; every tx is read back on both operators first)
import "../../../scripts/net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NEAR_NETWORKS, nearPairNetwork, nearPairRule } from "../../../packages/kit/src/near/networks.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
export const CARD = "vault-mainnet-money";
export const RECORD = path.join(HERE, "..", "deployments", "mainnet-v1.json");
export const PIN = path.join(HERE, "..", "deployments", "mainnet-v1.pin.json");
export const RUN_RECORD = `scripts/live-checks/${CARD}.run.json`;
export const MONEY_RECORD = `scripts/live-checks/${CARD}.md`;
/** The deposit: 5 USDC in base units (6 decimals). */
export const AMOUNT = 5_000_000n;
const POLL_MS = 10_000;
const FUND_BOUND_MS = 60 * 60_000;
const FEE_TRIES = 3;
/** Mainnet's release pair, the two operators every read and the record's read-back use. */
const RPC_URLS = [NEAR_NETWORKS.mainnet.fastnear[0], NEAR_NETWORKS.mainnet.drpc] as const;

type Rpcish = { name: string; query: (p: Record<string, unknown>) => Promise<unknown> };
type Relayers = { bind: string | null; withdraw: { relayer_account: string; fee_recipient: string } | null };
type Net = { vault: string | null; usdc: string };

// ---- the refusals (pure; mainnet-money.test.ts) ----

/** [] when the run may start: the deployed record is the pin, the kit's mainnet row, on mainnet's release pair, with both relayers. */
export function runProblems(a: { record: any; pin: any; net: Net; rpcs: readonly Rpcish[]; relayers: Relayers }): string[] {
  const { record, pin, net, rpcs, relayers } = a;
  const p: string[] = [];
  if (record === null || typeof record !== "object") return ["the record is not a JSON object"];
  if (record.network !== "mainnet") p.push(`the record's network is ${String(record.network)}, not mainnet`);
  for (const k of Object.keys(pin)) if (k !== "sources" && JSON.stringify(record[k]) !== JSON.stringify(pin[k])) p.push(`the record's ${k} is not the pin's (mainnet-v1.pin.json)`);
  if (typeof record.tx_hash !== "string" || typeof record.code_hash !== "string") p.push("the record has no tx_hash or code_hash: no deploy wrote it");
  if (net.vault === null || record.account_id !== net.vault) p.push(`the record's vault ${String(record.account_id)} is not the kit's mainnet vault ${String(net.vault)}`);
  if (record.asset !== net.usdc) p.push(`the record's asset ${String(record.asset)} is not the kit's mainnet USDC ${net.usdc}`);
  if (nearPairNetwork(rpcs) !== "mainnet") p.push(`RPCs ${rpcs.map((r) => r?.name).join(", ")}: ${nearPairRule("mainnet")}`);
  if (!relayers.bind) p.push("the release names no mainnet deposit relayer (packages/wallet/src/deposit/bind.ts RELEASE_RELAYER.mainnet is null)");
  if (!relayers.withdraw) p.push("the release names no mainnet withdrawal relayer (packages/wallet/src/withdraw/relay.ts RELEASE_WITHDRAW_RELAYER.mainnet is null)");
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
  if (relayFee >= note) p.push(`the relay fee ${relayFee} leaves nothing of the ${note} note to withdraw`);
  return p;
}

// ---- the network ----

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const log = (s: string) => console.log(`mainnet-money: ${s}`);
const json = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));
const wallet = (p: string) => import(pathToFileURL(path.join(ROOT, "packages/wallet/src", p)).href);

/** One query on one operator, at final; a JSON-RPC error throws. */
async function q(rpc: Rpcish, params: Record<string, unknown>): Promise<any> {
  const j: any = await rpc.query({ finality: "final", ...params });
  if (!j?.result || j.result.error) throw new Error(`${rpc.name}: ${String(j?.error?.cause?.name ?? j?.error?.message ?? j?.result?.error ?? "no result").slice(0, 200)}`);
  return j.result;
}
const viewOn = async (rpc: Rpcish, account_id: string, method_name: string, args: unknown) =>
  JSON.parse(Buffer.from((await q(rpc, { request_type: "call_function", account_id, method_name, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") })).result).toString("utf8"));
/** The same view on both operators; they must agree. */
async function view2(rpcs: readonly Rpcish[], account: string, method: string, args: unknown): Promise<any> {
  const [a, b] = await Promise.all(rpcs.map((r) => viewOn(r, account, method, args)));
  if (json(a) !== json(b)) throw new Error(`${account}.${method}: the two operators disagree`);
  return a;
}
async function near2(rpcs: readonly Rpcish[], account: string): Promise<bigint | null> {
  const r = await Promise.all(rpcs.map((x) => q(x, { request_type: "view_account", account_id: account }).then((v) => String(v.amount)).catch((e) => (/UNKNOWN_ACCOUNT|does not exist/.test(String(e.message)) ? null : Promise.reject(e)))));
  if (r[0] !== r[1]) throw new Error(`${account}: the two operators disagree on its NEAR`);
  return r[0] === null ? null : BigInt(r[0]!);
}

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

/** The gate and the vault's reads, then the release's values the run uses. */
async function opened() {
  const record = JSON.parse(readFileSync(RECORD, "utf8"));
  const pin = JSON.parse(readFileSync(PIN, "utf8"));
  const { relayRpc, RELEASE_WITHDRAW_RELAYER } = await wallet("withdraw/relay.ts");
  const { RELEASE_RELAYER } = await wallet("deposit/bind.ts");
  const net = NEAR_NETWORKS.mainnet;
  const rpcs = [relayRpc(RPC_URLS[0]), relayRpc(RPC_URLS[1])] as const;
  const relayers: Relayers = { bind: RELEASE_RELAYER.mainnet, withdraw: RELEASE_WITHDRAW_RELAYER.mainnet };
  const gate = runProblems({ record, pin, net, rpcs, relayers });
  if (gate.length) throw new Error(`refused, nothing read or sent:\n  ${gate.join("\n  ")}`);
  const vp = vaultReadProblems(record, await readVault(rpcs, record.account_id));
  if (vp.length) throw new Error(`refused, nothing sent:\n  ${vp.join("\n  ")}`);
  log(`the vault ${record.account_id} reads as the record on ${rpcs.map((r: Rpcish) => r.name).join(" and ")}: no key, code ${record.code_hash}, asset ${record.asset}, scope ${record.scope}`);
  return { record, net, rpcs, relayers: relayers as { bind: string; withdraw: { relayer_account: string; fee_recipient: string } }, vault: record.account_id as string, token: record.asset as string, scope: BigInt(record.scope) };
}

/** The run's words, its seed64 and a fresh in-memory note store with the run's one deposit note planned. */
export async function device(stateFile: string, scope: bigint) {
  const { loadState } = await import("./testnet-t04.mjs");
  const { repoRoots } = await import("./deploy.mjs");
  const st = loadState(stateFile, repoRoots());
  const req = createRequire(path.join(ROOT, "packages/wallet/package.json"));
  const { IDBFactory } = await import(pathToFileURL(req.resolve("fake-indexeddb")).href);
  const { entropyToWords, wordsToSeed64 } = await wallet("derive/index.ts");
  const { openWalletStore } = await wallet("store/index.ts");
  const { openNoteStore } = await wallet("notes/store.ts");
  const { noteSecrets } = await wallet("notes/secrets.ts");
  const { depositAccount } = await wallet("deposit/account.ts");
  // the words: 16 bytes of entropy from the run's seed (testnet-t02.ts entropyOf's rule, its own tag)
  const entropy = Uint8Array.from(createHash("sha256").update(st.seed).update("vault-mainnet-money/words").digest().subarray(0, 16));
  const seed64: Uint8Array = wordsToSeed64(entropyToWords(entropy));
  entropy.fill(0);
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  const ns = await openNoteStore(w);
  const note = await ns.planDeposit(scope, (ref: unknown) => noteSecrets(seed64, ref).precommitment);
  // the index a fresh store gives its first deposit note: the same on every run of this seed, so U is too
  const i: number = note.ref.i;
  const U: string = depositAccount(seed64, scope, i).account;
  return { st, seed64, w, ns, note, i, U, noteSecrets };
}

// ---- check: the gate, the vault read and, with --u, U's state on both operators (no money, no state) ----

async function check(argv: string[]) {
  const v = argv.length ? flags(argv, ["--u"]) : {};
  const o = await opened();
  const out: Record<string, unknown> = { vault: o.vault, token: o.token, amount: AMOUNT, bind_relayer: o.relayers.bind, withdraw_relayer: o.relayers.withdraw };
  if (v["--u"] !== undefined) {
    const U = v["--u"];
    if (!/^[0-9a-f]{64}$/.test(U)) throw new Error("--u: a NEAR-implicit account id, 64 hex");
    // does U exist (its key usable for a delegate), is it registered on USDC, what it holds
    const uNear = await near2(o.rpcs, U);
    const uReg = await view2(o.rpcs, o.token, "storage_balance_of", { account_id: U });
    Object.assign(out, { U, u_exists: uNear !== null, u_registered: uReg !== null, u_usdc: uReg === null ? "0" : await view2(o.rpcs, o.token, "ft_balance_of", { account_id: U }) });
  }
  console.log(json(out));
  process.exit(0);
}

// ---- run: U's 5 USDC, the deposit and the withdrawal, all carried by the deployed helper ----

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
    snarkjs,
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

async function run(argv: string[]) {
  const v = flags(argv, ["--state"]);
  const o = await opened();
  const { rpcs, vault, token, scope, relayers } = o;
  const { readWithdrawFeeMax } = await wallet("withdraw/feemax.ts");
  const { askWithdrawFee, WITHDRAW_URL } = await wallet("withdraw/relay.ts");
  const { readTokenStorageMin } = await wallet("arming/accounts.ts");
  const { bindDeposit, bindRpc } = await wallet("deposit/bind.ts");
  const { RELEASE_BIND_URL } = await wallet("deposit/delegate.ts");
  const { withdrawHandoff } = await import(pathToFileURL(path.join(ROOT, "packages/signpage/src/withdraw/handoff.ts")).href);

  // the fee, before any money moves: the release relayer's quote, held to the device's own fee_max at the largest
  // register_deposit any A can need (the token's storage minimum), as the withdraw form draws it
  const feeOf = async () => {
    const quote = await askWithdrawFee({ token, relayer: relayers.withdraw, amount: AMOUNT });
    const feeMax: bigint = await readWithdrawFeeMax({ network: "mainnet", rpcs, priceRpcs: rpcs, registerDeposit: await readTokenStorageMin("mainnet", rpcs) });
    const fp = feeProblems({ relayFee: quote.relayFee, feeMax, note: AMOUNT });
    if (fp.length) throw new Error(`refused: ${fp.join("; ")}`);
    return { relayFee: quote.relayFee as bigint, feeMax, feeRecipient: quote.feeRecipient as string };
  };
  const fee0 = await feeOf();
  log(`fee: ${fee0.relayFee} to ${fee0.feeRecipient}, at most the device's fee_max ${fee0.feeMax}`);

  const d = await device(v["--state"]!, scope);
  const { st, seed64, ns, note, U } = d;
  // one process holds the run's note store from plan to change note: a fresh store draws a new lane (wallet.md:247),
  // so a stopped run is never planned again; its note, if it landed, is the 12 words' (restore, or the exit tool)
  if (st.steps.run !== undefined) throw new Error("this state has a run already: a stopped run is not started again (its deposit, if it landed, is the run's 12 words'); start a new --state");
  st.steps.run = { U, i: d.i, note: note.id, precommitment: String(note.precommitment), amount: String(AMOUNT) };
  st.save();
  // U alone, public, for paste 2 (2-open-u.sh): the state file holds the seed and is never read by a paste
  writeFileSync(`${path.resolve(v["--state"]!)}.u`, U + "\n", { mode: 0o600 });
  const balances = async (extra: Record<string, string> = {}) => {
    const out: Record<string, unknown> = { at: new Date().toISOString(), vault_usdc: await view2(rpcs, token, "ft_balance_of", { account_id: vault }), totals: await view2(rpcs, vault, "totals", {}) };
    for (const [k, id] of Object.entries(extra)) out[`${k}_usdc`] = await view2(rpcs, token, "ft_balance_of", { account_id: id });
    return out;
  };

  // U: its NEAR account (paste 1) and its 5 USDC (paste 2), read on both operators
  log(`U is ${U}: waiting up to an hour for it to exist and hold ${AMOUNT} USDC (paste 2, then 5 USDC from any wallet or exchange)`);
  for (const t0 = Date.now(); ; ) {
    const n = await near2(rpcs, U).catch(() => null);
    const u = n === null ? null : await view2(rpcs, token, "ft_balance_of", { account_id: U }).catch(() => null);
    if (n !== null && u !== null && BigInt(u) >= AMOUNT) break;
    if (Date.now() - t0 > FUND_BOUND_MS) throw new Error("U was not funded within an hour: nothing was signed");
    await sleep(POLL_MS);
  }
  const before = await balances({ U });
  log(`before the deposit: ${json(before)}`);

  // the deposit: the wallet's bindDeposit to the release's helper, its answers kept (the relayer's tx hashes)
  const seen: { url: string; status: number; body: unknown }[] = [];
  const watch = async (url: unknown, init?: RequestInit): Promise<Response> => {
    const res = await fetch(url as string, init);
    if (String(url) === RELEASE_BIND_URL || String(url).startsWith(WITHDRAW_URL)) seen.push({ url: String(url), status: res.status, body: await res.clone().json().catch(() => null) });
    return res;
  };
  const tBind = Date.now();
  const outcome = await bindDeposit(seed64, { network: "mainnet", s: scope, i: d.i, noteId: note.id, amount: AMOUNT }, { store: ns, rpcs: [bindRpc(NEAR_NETWORKS.mainnet.fastnear[0]), bindRpc(NEAR_NETWORKS.mainnet.drpc)], fetchFn: watch });
  log(`bindDeposit: ${outcome.kind} in ${Date.now() - tBind} ms`);
  if (outcome.kind !== "deposited") throw new Error(`deposit: ${json(outcome)}`);
  const leaf = outcome.note.leaf;
  const calls = (await ns.get(note.id))?.calls ?? [];
  const depositTxs = [...new Set([...calls.flatMap((c: { tx_hashes?: string[] }) => c.tx_hashes ?? []), ...seen.filter((s) => s.url === RELEASE_BIND_URL).map((s: any) => s.body?.tx_hash)].filter((h): h is string => typeof h === "string"))];
  const afterDeposit = await balances({ U });
  st.steps.run.deposit = { done: true, bind_ms: Date.now() - tBind, txs: depositTxs, before, after: afterDeposit, leaf: { value: String(leaf.value), label: String(leaf.label), commitment: String(leaf.commitment), leaf_index: String(leaf.leafIndex) } };
  st.save();
  log(`deposited: leaf ${leaf.leafIndex}, label ${leaf.label}; relayer txs ${depositTxs.join(", ") || "none heard"}; after: ${json(afterDeposit)}`);

  // the withdrawal: the signing page's hand-off, the whole note less the fee to A
  const prover = await nodeProver();
  const page = { store: async () => d.w, notes: async () => ns, seed64: async () => Uint8Array.from(seed64), prover };
  const handoff = withdrawHandoff(page, { network: "mainnet", fetchFn: watch });
  if (handoff === null) throw new Error("the signing page gives no mainnet hand-off (no vault, scope or relayer in the release)");
  const nf: bigint = d.noteSecrets(seed64, note.ref).nullifierHash;
  const beforeW = await balances({ F: fee0.feeRecipient });
  let end: { kind: string; fee?: bigint } = { kind: "fee", fee: fee0.relayFee };
  let fee = fee0;
  for (let i = 0; i < FEE_TRIES && end.kind === "fee"; i++) {
    if (i > 0) fee = await feeOf();
    end = await handoff({ recipient: "", amount: AMOUNT - fee.relayFee }, fee.relayFee);
    log(`withdrawHandoff: ${end.kind}${end.kind === "fee" ? ` (a fresh quote ${end.fee} is above the drawn ${fee.relayFee}: nothing proved)` : ""}`);
  }
  if (end.kind !== "landed") throw new Error(`withdrawal: ${end.kind}`);
  const { vaultSync, vaultSyncStart } = await import(pathToFileURL(path.join(ROOT, "packages/kit/src/vault/sync.ts")).href);
  const s = await vaultSync({ vault, rpcs, cursor: vaultSyncStart(vault), lists: ["spends", "leaves"] });
  const row = s.spends.find((x: { nullifierHash: bigint }) => x.nullifierHash === nf);
  if (!row) throw new Error("no spends row for the note's nullifier");
  const withdrawTx = seen.filter((x) => x.url === WITHDRAW_URL && x.status === 200).map((x: any) => x.body?.tx_hash).find((h) => typeof h === "string");
  const afterW = await balances({ F: fee0.feeRecipient, A: row.recipient });
  st.steps.run.withdraw = {
    done: true, nullifier_hash: String(nf), withdraw_tx: withdrawTx ?? null, prove_ms: prover.times,
    row: { index: row.index, status: row.status, recipient: row.recipient, withdrawn: String(row.withdrawn), fee: String(row.fee), payer: row.payer, new_leaf_index: String(row.newLeafIndex) },
    change_commitment: String(s.leaves[Number(row.newLeafIndex)]), fee_recipient: fee0.feeRecipient, before: beforeW, after: afterW,
  };
  st.save();
  seed64.fill(0);
  log(`spends row #${row.index}: ${json(st.steps.run.withdraw.row)}; withdraw tx ${withdrawTx ?? "not heard"}; after: ${json(afterW)}`);
  log("next: paste 3, the record (mainnet-money/3-record.sh), with the USDC send to U and the settle tx the helper sent");
  process.exit(0);
}

// ---- record: public values only ----

/** The record the money gate reads: Money path, one Tx line per transaction (near = mainnet), then the prose. */
export function recordText(txs: { hash: string; signer: string }[], prose: string[]): string {
  return [`CARD ${CARD} / live: PASS`, "Money path: yes", ...txs.map((t) => `Tx: near ${t.hash} ${t.signer}`), "", ...prose, ""].join("\n");
}

async function record(argv: string[]) {
  const extra: { hash: string; signer: string }[] = [];
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tx" && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(argv[i + 1] ?? "") && /^[a-z0-9._-]{2,64}$/.test(argv[i + 2] ?? "")) {
      extra.push({ hash: argv[i + 1]!, signer: argv[i + 2]! });
      i += 2;
    } else rest.push(argv[i]!);
  }
  const v = flags(rest, ["--state"]);
  const o = await opened();
  const { loadState } = await import("./testnet-t04.mjs");
  const { repoRoots } = await import("./deploy.mjs");
  const st = loadState(v["--state"]!, repoRoots());
  const r = st.steps.run;
  if (r?.deposit?.done !== true || r?.withdraw?.done !== true) throw new Error("record: the run has not landed both legs");
  const txs = [...extra.filter((t) => t.signer !== o.relayers.bind), ...r.deposit.txs.map((hash: string) => ({ hash, signer: o.relayers.bind })), ...(r.withdraw.withdraw_tx ? [{ hash: r.withdraw.withdraw_tx, signer: o.relayers.withdraw.relayer_account }] : []), ...extra.filter((t) => t.signer === o.relayers.bind)];
  if (txs.length === 0) throw new Error("record: no transaction to record");
  const { successProblems } = await import("./testnet-t04.mjs");
  for (const t of txs) {
    for (const url of RPC_URLS) {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: CARD, method: "EXPERIMENTAL_tx_status", params: { tx_hash: t.hash, sender_account_id: t.signer, wait_until: "FINAL" } }), signal: AbortSignal.timeout(30_000) });
      const j: any = await res.json();
      const p = j?.result ? successProblems(j.result) : [`not read: ${JSON.stringify(j?.error ?? j).slice(0, 200)}`];
      if (p.length) throw new Error(`record: ${t.hash} (${t.signer}) on ${url}: ${p.join("; ")}`);
    }
    log(`${t.hash} (${t.signer}) read back FINAL on both operators, every receipt a success`);
  }
  const run = {
    card: CARD, network: "mainnet", vault: o.vault, asset: o.token,
    accounts: { U: r.U, A: r.withdraw.row.recipient, F: r.withdraw.fee_recipient, R: o.relayers.withdraw.relayer_account, G: o.relayers.bind },
    deposit: { value: r.deposit.leaf.value, precommitment: r.precommitment, label: r.deposit.leaf.label, leaf_index: r.deposit.leaf.leaf_index, commitment: r.deposit.leaf.commitment },
    withdraw: { withdrawn: r.withdraw.row.withdrawn, relay_fee: r.withdraw.row.fee, nullifier_hash: r.withdraw.nullifier_hash, change_leaf_index: r.withdraw.row.new_leaf_index, change_commitment: r.withdraw.change_commitment },
  };
  const b = r.deposit.before, a = r.deposit.after, c = r.withdraw.before, e = r.withdraw.after;
  const prose = [
    `The run: contracts/vault/scripts/mainnet-money.ts on NEAR mainnet, the keyless vault ${o.vault} (contracts/vault/deployments/mainnet-v1.json) on USDC ${o.token}, both legs carried by the deployed helper.`,
    `Deposit: U ${r.U} (U_{s,i} of the run's 12 words, i a fresh note store's first) signed its ft_transfer_call as a NEP-366 DelegateAction (packages/wallet/src/deposit/bind.ts bindDeposit), carried by the release's deposit relayer ${o.relayers.bind}; the deposits page holds P ${r.precommitment} by U with ${r.deposit.leaf.value}, label ${r.deposit.leaf.label}, leaf ${r.deposit.leaf.leaf_index}.`,
    `Withdrawal: the signing page's withdrawHandoff (packages/signpage/src/withdraw/handoff.ts), proved in this process by snarkjs fullProve on the kit's pinned setup files (the stand-in for the page's prover worker), carried by the release's relayer ${o.relayers.withdraw.relayer_account}; spends row #${r.withdraw.row.index}: ${r.withdraw.row.withdrawn} withdrawn to A ${r.withdraw.row.recipient}, fee ${r.withdraw.row.fee} to ${r.withdraw.fee_recipient}, payer ${r.withdraw.row.payer}, ${r.withdraw.row.status}.`,
    `Every Tx above read back FINAL on https://rpc.mainnet.fastnear.com and https://near.drpc.org, every receipt a success.`,
    `Before the deposit (${b.at}): U USDC ${b.U_usdc}, vault USDC ${b.vault_usdc}, totals ${JSON.stringify(b.totals)}. After (${a.at}): U USDC ${a.U_usdc}, vault USDC ${a.vault_usdc}, totals ${JSON.stringify(a.totals)}.`,
    `Before the withdrawal (${c.at}): F USDC ${c.F_usdc}, vault USDC ${c.vault_usdc}, totals ${JSON.stringify(c.totals)}. After (${e.at}): A USDC ${e.A_usdc}, F USDC ${e.F_usdc}, vault USDC ${e.vault_usdc}, totals ${JSON.stringify(e.totals)}.`,
  ];
  const text = recordText(txs, prose);
  const { localProblems } = await import("./testnet-t02.ts");
  const os = await import("node:os");
  const lp = localProblems(text + JSON.stringify(run), [os.hostname(), os.hostname().split(".")[0]!, os.userInfo().username]);
  if (lp.length) throw new Error(`record: ${lp.join("; ")}`);
  writeFileSync(path.join(ROOT, RUN_RECORD), JSON.stringify(run, null, 2) + "\n");
  writeFileSync(path.join(ROOT, MONEY_RECORD), text);
  console.log(text);
  log(`written ${RUN_RECORD} and ${MONEY_RECORD}; next: node scripts/ci/money-gate.mjs ${MONEY_RECORD} and node scripts/live-checks/${CARD}.mjs`);
}

function flags(argv: string[], allowed: string[]): Record<string, string> {
  const v: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (allowed.includes(a) && i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) v[a] = argv[++i]!;
    else throw new Error(`unknown argument ${a}`);
  }
  for (const k of allowed) if (!v[k]) throw new Error(`${k} is required`);
  return v;
}

const [cmd, ...rest] = process.argv.slice(2);
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const go = cmd === "check" ? () => check(rest) : cmd === "run" ? () => run(rest) : cmd === "record" ? () => record(rest) : null;
  if (!go) {
    console.error("usage: mainnet-money.ts check [--u <U>] | run --state <path> | record --state <path> [--tx <hash> <signer>]...");
    process.exit(2);
  }
  go().catch((e) => {
    console.error(`mainnet-money: ${e?.message ?? e}`);
    process.exit(1);
  });
}
