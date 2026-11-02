#!/usr/bin/env node
// A relayed withdrawal on NEAR testnet through the helper's own send (card relayer-withdraw-send): POST /v1/withdraw's
// carryWithdraw and the outcome rounds' outcomeRound (src/withdraw/send.ts), run in this process on the keyless vault
// of contracts/vault/deployments/testnet-v1.json and the team's test USDC only. Testnet only: it refuses any other
// vault, token or network. Built on contracts/vault/scripts/testnet-t04.mjs (its accounts, sends, read-backs, kit
// modules and prover).
//
// Accounts:
//   P  the vault's parent (--parent, its key from --key-file, outside the repo, never printed): pays NEAR only. It
//      makes R and registers R on the token.
//   D  T04's depositor (a NEAR-implicit account, its key from T04's seed in --t04-state, read only, never printed):
//      deposits one 1,000,000 note and is the withdrawal's recipient (registered on the token, so register_deposit 0).
//   R  the relayer: relay-<run>.<P>, a full-access key from this run's seed, 2 NEAR. It signs withdraw and settle
//      through send.ts and is the fee recipient.
// This run's seed (32 random bytes) and its note's secrets live in --state, a file outside the repo (mode 600); the
// relayer's nonce counters and send records live beside it (<state>.nonce/, <state>.sends/), so a stopped run resumes
// at its next step and send.ts finds its open send again. Nothing secret is printed.
//
// Steps, each recorded in --state once it landed:
//   setup     P: CreateAccount R + Transfer 2 NEAR + AddKey (R's full-access key); storage_deposit(R) on the token
//   deposit   D (balances read first: stops when short): storage_prepay + ft_transfer_call(vault, 1,000,000)
//   carry     the request as the kit builds it (vaultWithdrawRequest, vaultWithdrawInput, snarkjs on the pinned zk
//             files): the whole note to D, fee_recipient R, relay_fee the helper's testnet quote (fee.ts quote),
//             deadline_ms = the newer of the two providers' final header.timestamp_nanosec / 1e6 + 600,000,
//             fund_recipient true; then carryWithdraw(request, deps) with the two testnet RPCs; check 10's token
//             watch is a stand-in answering not halted (the event watch is not built)
//   outcome   outcomeRound(deps) every 10 s until the send record reads succeeded and its settle done (5 min bound)
//   readback  every tx on FastNEAR and dRPC testnet, every receipt a success; the vault's spends row: settled,
//             recipient D, fee = relay_fee, payer R; R's NEAR after the withdraw and after the settle, at their blocks
//   record    --out (default scripts/live-checks/relayer-withdraw-send.md), printed too
//
//   node contracts/vault/scripts/testnet-withdraw-send.ts --dry
//   node contracts/vault/scripts/testnet-withdraw-send.ts --parent <P> --key-file <path> --t04-state <path> --state <path>
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { b58encode } from "./near-tx.mjs";
import { act } from "./testnet-usdc.mjs";
import { loadKey, repoRoots } from "./deploy.mjs";
import { DEPLOYMENT, RPCS, TOKEN, REGISTER, keyOf, successProblems, view2, nearOf, send, readBack, loadState, kitModules, noteSecrets, prove, synced } from "./testnet-t04.mjs";
import { createFileStore, nearRpc, relayerKey, startRelayer, type Rpc } from "../../../apps/helper/src/bind/send.ts";
import { isAccountId } from "../../../apps/helper/src/withdraw/checks.ts";
import { createFeeQuoter, TESTNET_TOKEN } from "../../../apps/helper/src/withdraw/fee.ts";
import { createLeavesIndex, createSpendsIndex, createWithdrawSendStore } from "../../../apps/helper/src/withdraw/index.ts";
import { carryWithdraw, outcomeRound, type WithdrawSendDeps } from "../../../apps/helper/src/withdraw/send.ts";
import { USDC_CODE_HASH } from "../../../apps/helper/src/token-status/status.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
export const CARD = "relayer-withdraw-send";
export const NOTE = 1_000_000n;
const NEAR = 10n ** 24n;
const TGAS = 10n ** 12n;
export const R_NEAR = 2n * NEAR;
/** D's NEAR for its prepay plus the up-front gas of a 30 and a 180 Tgas call (refunded after), with room. */
export const D_GAS_YOCTO = NEAR / 4n;
export const DEADLINE_AHEAD_MS = 600_000;
export const ROUND_MS = 10_000;
export const OUTCOME_BOUND_MS = 300_000;
/** FastNEAR's archival testnet RPC: the relayer's lookups of an older outcome (money-gate.mjs RPCS["near-testnet"]). */
export const ARCHIVAL = "https://archival-rpc.testnet.fastnear.com";
/** Mainnet's pair for the fee's price pool (fee.ts priceRpcs; token-status WATCH_RPCS' fallbacks). */
export const PRICE_RPCS = ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"];
const GAS = { prepay: 30n * TGAS, deposit: 180n * TGAS, plain: 30n * TGAS };
const DEFAULT_OUT = `scripts/live-checks/${CARD}.md`;

// ---- pure parts (tested in testnet-withdraw-send.test.ts) ----

/** The relayer account of a run under `parent`: relay-<8 hex of sha256(seed, tag)>.<parent>. */
export function relayAccountOf(seed: Buffer, parent: string): string {
  const id = createHash("sha256").update(seed).update("rws/run").digest("hex").slice(0, 8);
  const a = `relay-${id}.${parent}`;
  if (!isAccountId(a)) throw new Error(`${a}: not a NEAR account id`);
  return a;
}

/** The relayer's key from the seed: { pub, privateKey } as T04's keyOf, and its text ed25519:<base58 of seed ‖ pub>. */
export function relayKeyOf(seed: Buffer): { pub: Buffer; privateKey: unknown; secretKey: string } {
  const k = keyOf(seed, "rws/relay");
  const d = Buffer.from((k.privateKey.export({ format: "jwk" }) as { d: string }).d, "base64url");
  return { pub: k.pub, privateKey: k.privateKey, secretKey: `ed25519:${b58encode(Buffer.concat([d, k.pub]))}` };
}

const NS = /^(0|[1-9][0-9]{0,19})$/;
/** deadline_ms: the newer of two final headers' timestamp_nanosec (decimal strings) / 1e6, + 600,000. */
export function deadlineMsOf(a: unknown, b: unknown): number {
  for (const x of [a, b]) if (typeof x !== "string" || !NS.test(x)) throw new Error("timestamp_nanosec: not a decimal string");
  const ms = [BigInt(a as string), BigInt(b as string)].map((n) => n / 1_000_000n);
  const newest = ms[0]! > ms[1]! ? ms[0]! : ms[1]!;
  return Number(newest) + DEADLINE_AHEAD_MS;
}

/** null when D can deposit the note: NOTE USDC and its prepay plus gas in NEAR; else what is short. */
export function dShortfall(have: { usdc: bigint | null; near: bigint | null }, needNear: bigint): string | null {
  if (have.usdc === null || have.usdc < NOTE) return `D holds USDC ${have.usdc ?? "none"}, needs ${NOTE}`;
  if (have.near === null || have.near < needNear) return `D holds NEAR ${have.near ?? "none"} yocto, needs ${needNear}`;
  return null;
}

type Row = { status: string; recipient: string; fee: bigint; payer: string; withdrawn: bigint };
/** [] when the spends row is the relayed withdrawal settled: the whole note to D, fee = relay_fee, paid by R. */
export function spendRowProblems(row: Row | undefined, want: { recipient: string; fee: bigint; payer: string; withdrawn: bigint }): string[] {
  if (!row) return ["no spends row for the nullifier"];
  const p: string[] = [];
  if (row.status !== "settled") p.push(`status ${row.status}, want settled`);
  if (row.recipient !== want.recipient) p.push(`recipient ${row.recipient}, want ${want.recipient}`);
  if (row.fee !== want.fee) p.push(`fee ${row.fee}, want ${want.fee}`);
  if (row.payer !== want.payer) p.push(`payer ${row.payer}, want ${want.payer}`);
  if (row.withdrawn !== want.withdrawn) p.push(`withdrawn ${row.withdrawn}, want ${want.withdrawn}`);
  return p;
}

/** The record the money gate reads: the live header, Money path, one Tx line per tx, then the prose. */
export function recordText(r: { txs: { hash: string; signer: string }[]; prose: string[] }): string {
  return [`CARD ${CARD} / live: PASS`, "Money path: yes", ...r.txs.map((t) => `Tx: near-testnet ${t.hash} ${t.signer}`), "", ...r.prose, ""].join("\n");
}

/** A host, user or local path of ours in committed text. */
const LOCAL = /\/(home|Users|private|tmp|var|root|opt)\/|[A-Za-z]:\\/;
const word = (w: string) => new RegExp(`(^|[^A-Za-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9]|$)`, "i");
/** This machine's host name and user name (read here, never written in the repo), each 4 characters or more. */
export const localNames = (): string[] => [hostname(), hostname().split(".")[0]!, userInfo().username].filter((n) => n.length >= 4);
export function localProblems(text: string, names: string[] = localNames()): string[] {
  const res = [LOCAL, ...names.map(word)];
  return text.split("\n").filter((l) => res.some((re) => re.test(l))).map((l) => `a host, user or local path: ${l.slice(0, 120)}`);
}

const FLAGS = new Set(["--parent", "--key-file", "--t04-state", "--state", "--out"]);
export type Args = { dry: true } | { dry: false; parent: string; keyFile: string; t04State: string; state: string; out: string };
export function parseArgs(argv: string[]): Args {
  const v: Record<string, string> = {};
  let dry = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry") dry = true;
    else if (FLAGS.has(a) && i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) v[a] = argv[++i]!;
    else throw new Error(`unknown argument ${a}`);
  }
  if (dry) return { dry: true };
  if (!v["--parent"] || !v["--key-file"] || !v["--t04-state"] || !v["--state"]) throw new Error("--parent, --key-file, --t04-state and --state are required");
  return { dry: false, parent: v["--parent"], keyFile: v["--key-file"], t04State: v["--t04-state"], state: v["--state"], out: v["--out"] ?? DEFAULT_OUT };
}

// ---- the network ----

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const pair = (urls: string[]) => urls.map((u) => nearRpc(u)) as unknown as readonly [Rpc, Rpc];

/** A read that a public provider's rate limit (429) or a lag can refuse: asked up to 6 times, 3 s, 6 s, ... apart. */
async function retried<T>(what: string, f: () => Promise<T>): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= 6) throw e;
      console.log(`rws: ${what}: ${String((e as Error)?.message ?? e).slice(0, 160)}; again in ${3 * i} s`);
      await sleep(3000 * i);
    }
  }
}

/** Both providers' final headers' timestamp_nanosec. */
async function finalTimes(rpcs: readonly [Rpc, Rpc]): Promise<[unknown, unknown]> {
  const hs = await Promise.all(rpcs.map(async (r) => ((await r("block", { finality: "final" })) as { header?: { timestamp_nanosec?: unknown } }).header?.timestamp_nanosec));
  return [hs[0], hs[1]];
}

/** An account's NEAR at block `hash`, the same on both providers. */
async function nearAt(rpcs: readonly [Rpc, Rpc], account: string, hash: string): Promise<bigint> {
  const a = await Promise.all(rpcs.map(async (r) => String(((await r("query", { request_type: "view_account", block_id: hash, account_id: account })) as { amount?: unknown }).amount)));
  if (a[0] !== a[1]) throw new Error(`${account}'s NEAR at ${hash} differs on the two providers`);
  return BigInt(a[0]!);
}

/** The block of a tx's last receipt (the highest), from a read-back answer: its height and hash. */
async function lastBlockOf(rpc: Rpc, r: { receipts_outcome?: { block_hash: string }[] }): Promise<{ height: number; hash: string }> {
  let best = { height: -1, hash: "" };
  for (const o of r.receipts_outcome ?? []) {
    const h = ((await rpc("block", { block_id: o.block_hash })) as { header: { height: number } }).header.height;
    if (h > best.height) best = { height: h, hash: o.block_hash };
  }
  if (best.height < 0) throw new Error("no receipt block");
  return best;
}

function inside(file: string, roots: string[]): boolean {
  const real = path.resolve(file);
  return roots.some((r) => real === r || real.startsWith(r + path.sep));
}

/** T04's seed, read only: never created, never printed. */
function t04Seed(file: string, roots: string[]): Buffer {
  if (inside(file, roots) || !existsSync(file)) throw new Error("--t04-state: no T04 state file outside the repository");
  const s = JSON.parse(readFileSync(file, "utf8")) as { seed?: unknown };
  if (typeof s.seed !== "string" || !/^[0-9a-f]{64}$/.test(s.seed)) throw new Error("--t04-state: no seed");
  return Buffer.from(s.seed, "hex");
}

// ---- the run ----

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const deployment = JSON.parse(readFileSync(DEPLOYMENT, "utf8"));
  const VAULT: string = deployment.account_id;
  if (deployment.network !== "testnet" || deployment.asset !== TOKEN || TOKEN !== TESTNET_TOKEN || !VAULT.endsWith(".testnet")) throw new Error("testnet-v1.json is not the testnet vault on the team's USDC");
  const k = await kitModules();
  const cfg = await view2(VAULT, "config", {});
  if (cfg.asset !== TOKEN || !/ testnet$/.test(cfg.version)) throw new Error(`the vault's config is not the testnet build on ${TOKEN}`);
  const scope = BigInt(cfg.scope);
  const tRpcs = pair(RPCS);
  if (args.dry) return dryRun(k, VAULT, scope, deployment.parent, tRpcs);

  if (args.parent !== deployment.parent) throw new Error(`--parent must be the vault's parent ${deployment.parent}`);
  const roots: string[] = repoRoots();
  if (inside(args.state, roots)) throw new Error("--state is inside the repository: the run's seed never lives in the repo");
  mkdirSync(path.dirname(path.resolve(args.state)), { recursive: true, mode: 0o700 });
  const P = { id: args.parent, key: loadKey(args.keyFile, args.parent, roots) };
  const st = loadState(args.state, roots);
  const dk = keyOf(t04Seed(args.t04State, roots), "D");
  const D = { id: dk.pub.toString("hex") as string, key: dk };
  const rk = relayKeyOf(st.seed);
  const R = { id: relayAccountOf(st.seed, args.parent), key: rk };
  const N = noteSecrets(k, st.seed, "rws/note");
  const CH = noteSecrets(k, st.seed, "rws/change");
  const RF = noteSecrets(k, st.seed, "rws/refund");
  const log = (s: string) => console.log(`rws: ${s}`);
  log(`vault ${VAULT}, token ${TOKEN}; accounts: P ${P.id}, D ${D.id}, R ${R.id}`);

  const balances = async () => ({
    at: new Date().toISOString(),
    D_usdc: await view2(TOKEN, "ft_balance_of", { account_id: D.id }).catch(() => null),
    R_usdc: await view2(TOKEN, "ft_balance_of", { account_id: R.id }).catch(() => null),
    vault_usdc: await view2(TOKEN, "ft_balance_of", { account_id: VAULT }),
    D_near: String(await nearOf(D.id)),
    R_near: String(await nearOf(R.id)),
    P_near: String(await nearOf(P.id)),
    totals: await view2(VAULT, "totals", {}),
  });
  const tx = async (step: string, signer: { id: string; key: unknown }, receiver: string, actions: unknown[], method: string) => {
    const { hash } = await send(signer.id, signer.key, receiver, actions);
    const reads = await Promise.all(RPCS.map((_: string, i: number) => readBack(hash, signer.id, i)));
    const problems = reads.flatMap((x: unknown, i: number) => (x ? successProblems(x).map((p: string) => `${RPCS[i]}: ${p}`) : [`${RPCS[i]}: not read`]));
    (st.steps[step] ??= { txs: [] }).txs.push({ step, method, hash, signer: signer.id });
    st.save();
    log(`${step}: ${method} ${hash} ${problems.length ? `PROBLEMS ${problems.join("; ")}` : "read back on both operators, every receipt a success"}`);
    if (problems.length) throw new Error(`${step}: ${method} ${hash} did not read back as a success`);
  };
  const done = (step: string) => st.steps[step]?.done === true;
  const finish = (step: string, extra = {}) => {
    Object.assign((st.steps[step] ??= { txs: [] }), extra, { done: true });
    st.save();
  };

  if (!done("setup")) {
    if ((await nearOf(R.id)) === null) await tx("setup", P, R.id, [act.create(), act.transfer(R_NEAR), act.fullKey(R.key.pub)], "CreateAccount (R) + Transfer 2 NEAR + AddKey");
    if ((await view2(TOKEN, "storage_balance_of", { account_id: R.id })) === null)
      await tx("setup", P, TOKEN, [act.call("storage_deposit", { account_id: R.id, registration_only: true }, GAS.plain, REGISTER)], "storage_deposit (R)");
    finish("setup");
  }
  st.steps.before ??= await balances();
  st.save();

  if (!done("deposit")) {
    const needNear = k.vaultPrepayYocto(true) + D_GAS_YOCTO;
    const usdc = await view2(TOKEN, "ft_balance_of", { account_id: D.id }).catch(() => null);
    const short = dShortfall({ usdc: usdc === null ? null : BigInt(usdc), near: await nearOf(D.id) }, needNear);
    if (short !== null) {
      log(`deposit: stopped, ${short}`);
      process.exit(3);
    }
    if (!st.steps.deposit?.txs?.some((t: { method: string }) => t.method === "storage_prepay"))
      await tx("deposit", D, VAULT, [act.call("storage_prepay", { precommitment: String(N.precommitment) }, GAS.prepay, k.vaultPrepayYocto(true))], "storage_prepay");
    await tx("deposit", D, TOKEN, [act.call("ft_transfer_call", { receiver_id: VAULT, amount: String(NOTE), msg: k.vaultDepositMessage(N.precommitment, D.id) }, GAS.deposit, 1n)], "ft_transfer_call (deposit)");
    const s = await synced(k, VAULT);
    const row = s.deposits.find((d: { precommitment: bigint }) => d.precommitment === N.precommitment);
    if (!row || row.value !== NOTE || row.depositor !== D.id) throw new Error("deposit: no deposit row of 1000000 by D on the precommitment");
    finish("deposit", { label: String(row.label), leaf_index: String(row.leafIndex) });
  }

  // send.ts's deps: the testnet pair, the fee quoter on mainnet's price pair, the durable stores beside --state
  const quoter = createFeeQuoter({ priceRpcs: pair(PRICE_RPCS), networks: { testnet: { rpcs: tRpcs, relayer: { relayer_account: R.id, fee_recipient: R.id } } } });
  const nonceStore = createFileStore(`${path.resolve(args.state)}.nonce`);
  const store = createWithdrawSendStore(`${path.resolve(args.state)}.sends`, { release: 1, keys: nonceStore });
  if (!relayerKey(rk.secretKey).pub.every((b, i) => b === R.key.pub[i])) throw new Error("the relayer's key text is not its key");
  const relayer = await startRelayer(tRpcs, nearRpc(ARCHIVAL), R.id, rk.secretKey, VAULT, nonceStore);
  const deps: WithdrawSendDeps = {
    cfg: { vault: VAULT, token: TOKEN, scope, feeRecipient: R.id },
    rpcs: tRpcs,
    reads: quoter.reads("testnet"),
    index: createSpendsIndex(tRpcs, VAULT),
    leaves: createLeavesIndex(tRpcs, VAULT),
    store,
    relayers: [relayer],
    // check 10's watch: a stand-in answering a caught-up open token (the event watch is not built)
    tokenStatus: async () => ({ token: TOKEN, caught_up: true, halted: false, vault_blocked: false, code_hash_ok: true, code_hash: USDC_CODE_HASH, block_height: 0, last_event: null }),
  };
  const nf = N.nullifierHash as bigint;

  if (!done("carry")) {
    const held = store.get(nf);
    if (held === null) {
      const quote = await retried("quote", () => quoter.quote(TOKEN));
      const relayFee = BigInt(quote.relay_fee);
      const deadlineMs = deadlineMsOf(...(await retried("final headers", () => finalTimes(tRpcs))));
      const s = await synced(k, VAULT);
      const note = { value: NOTE, label: BigInt(st.steps.deposit.label), nullifier: N.nullifier, secret: N.secret };
      const nowMs = Date.now();
      const { withdrawal, context } = k.vaultWithdrawRequest({
        vaultId: VAULT, token: TOKEN, recipient: D.id, registerDeposit: 0n, feeRecipient: R.id, relayFee,
        refundPrecommitment: RF.precommitment, deadlineMs, withdrawn: NOTE, nowMs,
      });
      const stateTree = new k.VaultTree(s.leaves);
      const labelTree = new k.VaultTree(s.labels);
      if (stateTree.root !== s.stateTree.root || labelTree.root !== s.labelTree.root) throw new Error("the synced trees' roots are not the vault's");
      const input = k.vaultWithdrawInput({
        stateTree, labelTree, newestStateRoot: s.stateTree.root, newestLabelRoot: s.labelTree.root,
        note, newNullifier: CH.nullifier, newSecret: CH.secret, withdrawn: NOTE, withdrawal, vaultId: VAULT, scope, nowMs,
      });
      const p = await prove(k, "withdraw", input);
      if (p.publicSignals[7] !== context) throw new Error("the proof's context is not the request's");
      const request = { withdrawal, proof: p.proof, public_signals: p.publicSignals, fund_recipient: true, token: TOKEN };
      const rNear = await nearOf(R.id);
      st.steps.request = { relay_fee: String(relayFee), valid_until_block: quote.valid_until_block, deadline_ms: deadlineMs, prove_ms: p.proveMs, body_bytes: JSON.stringify(request).length, R_near_before: String(rNear) };
      st.save();
      log(`request: whole note ${NOTE} to D, relay_fee ${relayFee} to R (quote valid to block ${quote.valid_until_block}), deadline_ms ${deadlineMs}, proof ${p.proveMs} ms`);
      // a 503 (upstream, index_behind, token_halted) sent nothing: asked again while no send record exists
      const t0 = Date.now();
      let a = await carryWithdraw(request, deps);
      for (let i = 1; a.status === 503 && i < 6 && store.get(nf) === null; i++) {
        log(`carryWithdraw: ${a.status} ${JSON.stringify(a.body)}; again in ${3 * i} s`);
        await sleep(3000 * i);
        a = await carryWithdraw(request, deps);
      }
      log(`carryWithdraw: ${a.status} ${JSON.stringify(a.body)}`);
      if (a.status !== 200 || !("tx_hash" in a.body)) throw new Error(`carryWithdraw answered ${a.status} ${JSON.stringify(a.body)}`);
      const t200 = Date.now();
      log(`carryWithdraw: ${t200 - t0} ms from the request to the 200`);
      finish("carry", { tx_hash: a.body.tx_hash, carry_ms: t200 - t0, answered_at: t200 });
    } else {
      if (held === "unreadable" || !st.steps.request) throw new Error("carry: a send record exists but does not read, or the request was not kept");
      log(`carry: resumed, the send record holds ${held.tx_hash} (${held.outcome})`);
      finish("carry", { tx_hash: held.tx_hash });
    }
  }

  if (!done("outcome")) {
    const until = Date.now() + OUTCOME_BOUND_MS;
    for (let round = 1; ; round++) {
      await outcomeRound(deps);
      const rec = store.get(nf);
      // the times from the 200 to the record reading succeeded and to the settle done, as seen after each round
      const at = Date.now() - (st.steps.carry.answered_at ?? NaN);
      if (rec !== null && rec !== "unreadable" && rec.outcome === "succeeded" && st.steps.carry.succeeded_ms === undefined) st.steps.carry.succeeded_ms = at;
      if (rec !== null && rec !== "unreadable" && rec.settle?.done === true && st.steps.carry.settled_ms === undefined) st.steps.carry.settled_ms = at;
      st.save();
      const where = rec === null ? "no send record (deleted: deadline or never applied)" : rec === "unreadable" ? "unreadable" : `withdraw ${rec.outcome}${rec.error ? ` (${rec.error.slice(0, 200)})` : ""}, settle ${rec.settle ? `${rec.settle.tx?.tx_hash ?? "by another"} done ${rec.settle.done}` : "none"}`;
      log(`outcome round ${round}: ${where}`);
      if (rec === null || rec === "unreadable" || rec.outcome === "failed") throw new Error(`outcome: ${where}`);
      if (rec.outcome === "succeeded" && rec.settle?.done === true) {
        if (rec.settle.tx === null) throw new Error("outcome: settled, but by another account: no settle of R's to record");
        finish("outcome", { withdraw: { hash: rec.tx_hash, signer: R.id }, settle: { hash: rec.settle.tx.tx_hash, signer: R.id } });
        break;
      }
      if (Date.now() >= until) {
        log(`outcome: stopped after ${OUTCOME_BOUND_MS / 1000} s at: ${where}; run again to resume`);
        process.exit(4);
      }
      await sleep(ROUND_MS);
    }
  }
  store.close();
  nonceStore.close();

  if (!done("readback")) {
    const o = st.steps.outcome;
    const all = [...st.steps.setup.txs, ...st.steps.deposit.txs, { step: "withdraw", method: "withdraw (R, through send.ts)", ...o.withdraw }, { step: "settle", method: "settle (R, through send.ts)", ...o.settle }];
    const last: Record<string, { height: number; hash: string }> = {};
    for (const t of all) {
      const reads = await Promise.all(RPCS.map((_: string, i: number) => readBack(t.hash, t.signer, i)));
      const problems = reads.flatMap((x: unknown, i: number) => (x ? successProblems(x).map((p: string) => `${RPCS[i]}: ${p}`) : [`${RPCS[i]}: not read`]));
      log(`readback: ${t.method} ${t.hash} ${problems.length ? `PROBLEMS ${problems.join("; ")}` : "FINAL on both operators, every receipt a success"}`);
      if (problems.length) throw new Error(`readback: ${t.hash}`);
      if (t.step === "withdraw" || t.step === "settle") last[t.step] = await lastBlockOf(tRpcs[0], reads[0]);
    }
    const nearAfter = { withdraw: String(await nearAt(tRpcs, R.id, last.withdraw!.hash)), settle: String(await nearAt(tRpcs, R.id, last.settle!.hash)) };
    const s = await synced(k, VAULT);
    const row = s.spends.find((x: { nullifierHash: bigint }) => x.nullifierHash === nf);
    const fee = BigInt(st.steps.request.relay_fee);
    const rp = spendRowProblems(row, { recipient: D.id, fee, payer: R.id, withdrawn: NOTE });
    log(`spends row ${row ? `#${row.index}` : "none"}: ${rp.length ? `PROBLEMS ${rp.join("; ")}` : `settled, recipient D, fee ${fee}, payer R, withdrawn ${NOTE}`}`);
    if (rp.length) throw new Error("readback: the spends row is not the relayed withdrawal settled");
    finish("readback", { txs: all, heights: { withdraw: last.withdraw!.height, settle: last.settle!.height }, R_near_after: nearAfter, row: { index: row.index, status: row.status, recipient: row.recipient, fee: String(row.fee), payer: row.payer, withdrawn: String(row.withdrawn), new_leaf_index: String(row.newLeafIndex) } });
  }
  st.steps.after ??= await balances();
  st.save();

  const rb = st.steps.readback;
  const rq = st.steps.request;
  const b = st.steps.before;
  const a = st.steps.after;
  const prose = [
    `The run: contracts/vault/scripts/testnet-withdraw-send.ts on NEAR testnet, the keyless vault ${VAULT} on the team's test USDC ${TOKEN}; the withdraw and the settle signed and sent by apps/helper/src/withdraw/send.ts (carryWithdraw, then outcomeRound every 10 s) in process, with the release's two testnet RPCs (FastNEAR, dRPC) and the fee quoter's mainnet price pair. Check 10's token watch was a stand-in answering a caught-up, open token: the event watch is not built.`,
    `Accounts: P ${P.id} (makes R), D ${D.id} (T04's depositor, the recipient, registered: register_deposit 0), R ${R.id} (the relayer and, for this testnet run, the fee recipient too; the plan's fee recipient is an account of its own apart from the relayer).`,
    `Steps: P makes R with 2 NEAR and a full-access key and registers it on the token; D prepays and deposits one 1000000 note; the request spends the whole note (no change value) to D, relay_fee ${rq.relay_fee} (the helper's testnet quote, valid to block ${rq.valid_until_block}) to R, deadline_ms ${rq.deadline_ms} (the newer final header's timestamp_nanosec / 1e6 + 600000), fund_recipient true; carryWithdraw answered 200 submitted; the outcome rounds read the withdraw succeeded from blocks and R settled the spend.`,
    `Every Tx above read back FINAL on https://test.rpc.fastnear.com and https://near-testnet.drpc.org, every receipt a success.`,
    `Spends row #${rb.row.index}: status ${rb.row.status}, recipient ${rb.row.recipient}, fee ${rb.row.fee}, payer ${rb.row.payer}, withdrawn ${rb.row.withdrawn}.`,
    `R's NEAR: ${rq.R_near_before} before the withdraw; ${rb.R_near_after.withdraw} at block ${rb.heights.withdraw} (the withdraw's last receipt); ${rb.R_near_after.settle} at block ${rb.heights.settle} (the settle's last receipt).`,
    `Balances after setup, before the deposit (${b.at}): D USDC ${b.D_usdc}, R USDC ${b.R_usdc}, vault USDC ${b.vault_usdc}, D NEAR ${b.D_near}, R NEAR ${b.R_near}, P NEAR ${b.P_near}, totals ${JSON.stringify(b.totals)}.`,
    `Balances after (${a.at}): D USDC ${a.D_usdc}, R USDC ${a.R_usdc}, vault USDC ${a.vault_usdc}, D NEAR ${a.D_near}, R NEAR ${a.R_near}, P NEAR ${a.P_near}, totals ${JSON.stringify(a.totals)}.`,
    `Prover (node, snarkjs, kit inputs): withdraw ${rq.prove_ms} ms; request body ${rq.body_bytes} bytes.`,
    `Times (this process's clock): carryWithdraw ${st.steps.carry.carry_ms ?? "not timed"} ms from the request to the 200; from the 200 to the send record reading succeeded ${st.steps.carry.succeeded_ms ?? "not timed"} ms, to the settle done ${st.steps.carry.settled_ms ?? "not timed"} ms (outcomeRound runs every 10 s, so both are read at round ends).`,
  ];
  const text = recordText({ txs: rb.txs, prose });
  const lp = localProblems(text);
  if (lp.length) throw new Error(`the record: ${lp.join("; ")}`);
  const out = path.resolve(ROOT, args.out);
  if (!inside(out, [ROOT])) throw new Error("--out must be inside the repository");
  writeFileSync(out, text);
  console.log(text);
  log(`record written to ${path.relative(ROOT, out)}`);
}

/** The plan with no key and no tx: the vault now, a dry seed's R, the testnet quote and a deadline as the run reads them. */
async function dryRun(k: any, VAULT: string, scope: bigint, parent: string, tRpcs: readonly [Rpc, Rpc]) {
  const seed = randomBytes(32);
  const R = relayAccountOf(seed, parent);
  const s0 = await synced(k, VAULT);
  const say = (s: string) => console.log(`dry: ${s}`);
  say(`vault ${VAULT} (scope ${scope}) on ${TOKEN}: ${s0.stateTree.size} leaves, ${s0.labelTree.size} labels, ${s0.deposits.length} deposits, ${s0.spends.length} spends`);
  say(`accounts (this dry seed): P ${parent}, D T04's depositor (from --t04-state), R ${R}`);
  say(`setup: P CreateAccount R + Transfer ${R_NEAR} yocto + AddKey; P storage_deposit(R) ${REGISTER}`);
  say(`deposit: D needs ${NOTE} USDC and ${k.vaultPrepayYocto(true) + D_GAS_YOCTO} yocto; storage_prepay ${k.vaultPrepayYocto(true)}; ft_transfer_call ${NOTE}`);
  const quoter = createFeeQuoter({ priceRpcs: pair(PRICE_RPCS), networks: { testnet: { rpcs: tRpcs, relayer: { relayer_account: R, fee_recipient: R } } } });
  const q = await retried("quote", () => quoter.quote(TOKEN));
  say(`carry: relay_fee ${q.relay_fee} (gp ${q.gp}, px ${q.px}, valid to block ${q.valid_until_block}); deadline_ms ${deadlineMsOf(...(await finalTimes(tRpcs)))}; R attaches ${k.vaultWithdrawYocto(0n, BigInt(q.relay_fee), true)} yocto to withdraw`);
  say(`outcome: outcomeRound every ${ROUND_MS / 1000} s, ${OUTCOME_BOUND_MS / 1000} s bound; readback on ${RPCS.join(" and ")}`);
  say("nothing signed, nothing sent");
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // snarkjs keeps worker threads alive after its last proof, so the run ends itself
  main().then(() => process.exit(0), (e) => {
    console.error(`testnet-withdraw-send: ERROR: ${String(e?.message ?? e).split("\n")[0]}`);
    process.exit(1);
  });
}
