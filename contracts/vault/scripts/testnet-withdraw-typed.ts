#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// A withdrawal to a NEAR account the user types, paid straight by the vault, on NEAR testnet (card
// wallet-withdraw-move-out), on the keyless vault of contracts/vault/deployments/testnet-v1.json and the team's test USDC
// only. Testnet only: it refuses any other vault, token or network.
//
// The device's side is the wallet's and the signing page's own modules, run in this process as the testnet build: this
// run's 12 words, one note planned in the note store (packages/wallet/src/notes/store.ts on fake-indexeddb, deposit index
// 0) and deposited by D; then the hand-off's own steps (packages/signpage/src/withdraw/handoff.ts withdrawHandoff:
// askWithdrawFee, the trees by vaultSync, lowerFinalTime, withdrawRequest with `to` = W, so fund_recipient false and
// register_deposit the token's minimum read naming no account, relayWithdraw, withdrawArrival), and then the settle pass a
// reload runs (withdrawSettle), which must send nothing. withdrawHandoff itself is not called: it pins the release's
// testnet relayer, VT-T02's R, whose key lived only in VT-T02's run state, which is gone; this run's relayer is
// relayer-withdraw-send's, whose key is in its state. The relayer's side is the helper's own GET /v1/withdraw/fee quote
// and POST /v1/withdraw carry (apps/helper/src/withdraw/fee.ts, send.ts carryWithdraw, outcomeRound every 10 s), run in
// this process with R's key and reached through the page's fetchFn at the release's URLs: the deployed helper answers
// every testnet withdrawal token_halted (no testnet token watch).
//
// Stand-ins, each named in the run record: check 10's token watch answers a caught-up, open token; the prover is
// snarkjs in node on the pinned setup files (the page's worker runs the same files in a browser).
//
// Accounts:
//   P  the vault's parent (--parent, its key from --key-file, outside the repo, never printed): pays NEAR only. It
//      makes W.
//   D  T04's depositor (its key from T04's seed, --t04-state, read only, never printed): deposits the note.
//   R  relayer-withdraw-send's relayer relay-<id>.<P> (its key from that run's seed, --rws-state, read only, never
//      printed): carries the withdrawal and settles it, and is its own fee recipient (registered on the token).
//   W  wt-<run>.<P>: the typed account, named, no key, not registered on the token (register_deposit is the token's
//      storage minimum for every recipient; the vault's payout registers W). <run> and this run's 12 words come from
//      this run's seed in --state (outside the repo, mode 600).
//
//   node contracts/vault/scripts/testnet-withdraw-typed.ts --parent <P> --key-file <path> --t04-state <path> --rws-state <path> --state <path> [--out <file>]
import "../../../scripts/net-window.mjs";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { act } from "./testnet-usdc.mjs";
import { loadKey, repoRoots } from "./deploy.mjs";
import { DEPLOYMENT, RPCS, TOKEN, view2, nearOf, send, readBack, successProblems, loadState, keyOf, kitModules, synced } from "./testnet-t04.mjs";
import { ARCHIVAL, localProblems, relayAccountOf, relayKeyOf } from "./testnet-withdraw-send.ts";
import { createFileStore, nearRpc, relayerKey, startRelayer, type Rpc } from "../../../apps/helper/src/bind/send.ts";
import { isAccountId } from "../../../apps/helper/src/withdraw/checks.ts";
import { createFeeQuoter } from "../../../apps/helper/src/withdraw/fee.ts";
import { createLeavesIndex, createSpendsIndex, createWithdrawSendStore } from "../../../apps/helper/src/withdraw/index.ts";
import { carryWithdraw, outcomeRound, type WithdrawSendDeps } from "../../../apps/helper/src/withdraw/send.ts";
import { USDC_CODE_HASH } from "../../../apps/helper/src/token-status/status.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
export const CARD = "wallet-withdraw-move-out";
const NEAR = 10n ** 24n;
/** W's NEAR at creation: its own account storage, no key. */
export const W_NEAR = NEAR / 100n;
const ROUND_MS = 10_000;
const TGAS = 10n ** 12n;
/** The note D deposits for this run's words, in USDC base units. */
export const NOTE = 500_000n;
const GAS = { prepay: 30n * TGAS, deposit: 180n * TGAS };
const PRICE_RPCS = ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"];
const DEFAULT_OUT = `scripts/live-checks/${CARD}.md`;

/** The typed account of a run under `parent`: wt-<8 hex of sha256(seed, tag)>.<parent>. */
export function typedAccountOf(seed: Buffer, parent: string): string {
  const id = createHash("sha256").update(seed).update("wwmo/w").digest("hex").slice(0, 8);
  const a = `wt-${id}.${parent}`;
  if (!isAccountId(a)) throw new Error(`${a}: not a NEAR account id`);
  return a;
}

const FLAGS = new Set(["--parent", "--key-file", "--t04-state", "--rws-state", "--state", "--out"]);
function parseArgs(argv: string[]) {
  const v: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (FLAGS.has(a) && i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) v[a] = argv[++i]!;
    else throw new Error(`unknown argument ${a}`);
  }
  for (const k of ["--parent", "--key-file", "--t04-state", "--rws-state", "--state"]) if (!v[k]) throw new Error(`${k} is required`);
  return { parent: v["--parent"]!, keyFile: v["--key-file"]!, t04State: v["--t04-state"]!, rwsState: v["--rws-state"]!, state: v["--state"]!, out: v["--out"] ?? DEFAULT_OUT };
}
const inside = (file: string, roots: string[]) => {
  const real = path.resolve(file);
  return roots.some((r) => real === r || real.startsWith(r + path.sep));
};
/** Another run's seed (T04's, relayer-withdraw-send's), read only: never created, never printed. */
function seedOf(file: string, roots: string[], flag: string): Buffer {
  if (inside(file, roots) || !existsSync(file)) throw new Error(`${flag}: no state file outside the repository`);
  const s = JSON.parse(readFileSync(file, "utf8")) as { seed?: unknown };
  if (typeof s.seed !== "string" || !/^[0-9a-f]{64}$/.test(s.seed)) throw new Error(`${flag}: no seed`);
  return Buffer.from(s.seed, "hex");
}
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const pair = (urls: string[]) => urls.map((u) => nearRpc(u)) as unknown as readonly [Rpc, Rpc];
const json = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));
const log = (s: string) => console.log(`wwmo: ${s}`);

async function readBoth(hash: string, signer: string): Promise<string[]> {
  const reads = await Promise.all(RPCS.map((_: string, i: number) => readBack(hash, signer, i)));
  return reads.flatMap((x: unknown, i: number) => (x ? successProblems(x).map((p: string) => `${RPCS[i]}: ${p}`) : [`${RPCS[i]}: not read`]));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const deployment = JSON.parse(readFileSync(DEPLOYMENT, "utf8"));
  const VAULT: string = deployment.account_id;
  if (deployment.network !== "testnet" || deployment.asset !== TOKEN || !VAULT.endsWith(".testnet")) throw new Error("testnet-v1.json is not the testnet vault on the team's USDC");
  if (args.parent !== deployment.parent) throw new Error(`--parent must be the vault's parent ${deployment.parent}`);
  const roots: string[] = repoRoots();
  if (inside(args.state, roots)) throw new Error("--state is inside the repository: the run's seed never lives in the repo");
  mkdirSync(path.dirname(path.resolve(args.state)), { recursive: true, mode: 0o700 });

  // the testnet build: set before the page's modules load (relay.ts folds the testnet relayer on it)
  (globalThis as { __SIGN_NETWORK__?: string }).__SIGN_NETWORK__ = "testnet";
  const wallet = (p: string) => import(pathToFileURL(path.join(ROOT, "packages/wallet/src", p)).href);
  const page_ = (p: string) => import(pathToFileURL(path.join(ROOT, "packages/signpage/src", p)).href);
  const { IDBFactory } = await import(pathToFileURL(createRequire(path.join(ROOT, "packages/wallet/package.json")).resolve("fake-indexeddb")).href);
  const { entropyToWords, wordsToSeed64 } = await wallet("derive/index.ts");
  const { openWalletStore } = await wallet("store/index.ts");
  const { openNoteStore } = await wallet("notes/store.ts");
  const { noteSecrets, noteCommitment } = await wallet("notes/secrets.ts");
  const { WITHDRAW_FEE_URL, WITHDRAW_URL, askWithdrawFee, relayRpc, relayWithdraw } = await wallet("withdraw/relay.ts");
  const { withdrawRequest, withdrawDeadlineMs } = await wallet("withdraw/request.ts");
  const { withdrawArrival } = await wallet("withdraw/arrival.ts");
  const { typedRegisterDepositOf } = await wallet("arming/accounts.ts");
  const { NEAR_NETWORKS } = await wallet("deposit/account.ts");
  const { lowerFinalTime, treesOf, withdrawSettle } = await page_("withdraw/handoff.ts");
  const { vaultSync, vaultSyncStart } = await import(pathToFileURL(path.join(ROOT, "packages/kit/src/index.ts")).href);
  const { vaultScope } = await page_("withdraw/checks.ts");

  const NET = NEAR_NETWORKS.testnet;
  if (NET.vault !== VAULT || NET.usdc !== TOKEN) throw new Error("the wallet's testnet vault or token is not testnet-v1.json's");
  const cfg = await view2(VAULT, "config", {});
  if (cfg.asset !== TOKEN || !/ testnet$/.test(cfg.version)) throw new Error(`the vault's config is not the testnet build on ${TOKEN}`);
  const scope = BigInt(cfg.scope);
  if (vaultScope("testnet") !== scope) throw new Error("the page's testnet scope is not the vault's");

  const P = { id: args.parent, key: loadKey(args.keyFile, args.parent, roots) };
  const dk = keyOf(seedOf(args.t04State, roots, "--t04-state"), "D");
  const D = { id: dk.pub.toString("hex") as string, key: dk };
  const rwsSeed = seedOf(args.rwsState, roots, "--rws-state");
  const rk = relayKeyOf(rwsSeed);
  const R = relayAccountOf(rwsSeed, args.parent);
  const acc = { R, F: R }; // the relayer is its own fee recipient, as in relayer-withdraw-send's run (registered)
  const st = loadState(args.state, roots);
  const W = typedAccountOf(st.seed, args.parent);
  log(`vault ${VAULT}, token ${TOKEN}; P ${P.id}, D ${D.id}, R ${R} (also the fee recipient), W ${W}`);
  const steps = st.steps as Record<string, any>;
  const save = () => st.save();
  const balances = async () => ({
    at: new Date().toISOString(),
    W_usdc: await view2(TOKEN, "ft_balance_of", { account_id: W }).catch(() => null),
    W_registration: await view2(TOKEN, "storage_balance_of", { account_id: W }).catch(() => "unread"),
    R_usdc: await view2(TOKEN, "ft_balance_of", { account_id: acc.F }).catch(() => null),
    vault_usdc: await view2(TOKEN, "ft_balance_of", { account_id: VAULT }),
    R_near: String(await nearOf(acc.R)),
    totals: await view2(VAULT, "totals", {}),
  });

  // ---- setup: P makes W, named, no key, not registered on the token ----
  if (!steps.setup?.done) {
    if ((await nearOf(W)) === null) {
      const { hash } = await send(P.id, P.key, W, [act.create(), act.transfer(W_NEAR)]);
      const pr = await readBoth(hash, P.id);
      steps.setup = { txs: [{ method: "CreateAccount (W) + Transfer 0.01 NEAR, no key", hash, signer: P.id }] };
      save();
      log(`setup: ${hash} ${pr.length ? `PROBLEMS ${pr.join("; ")}` : "read back on both operators, every receipt a success"}`);
      if (pr.length) throw new Error("setup did not read back as a success");
    }
    if ((await view2(TOKEN, "storage_balance_of", { account_id: W })) !== null) throw new Error("W is registered on the token: this run needs an unregistered typed account");
    steps.setup = { ...(steps.setup ?? { txs: [] }), done: true };
    save();
  }

  // ---- the device: this run's 12 words, one note planned in the note store and deposited by D ----
  const words = createHash("sha256").update(st.seed).update("wwmo/words").digest().subarray(0, 16);
  const seed64: Uint8Array = wordsToSeed64(entropyToWords(Uint8Array.from(words)));
  const tRpcs = [relayRpc(NET.fastnear[0]), relayRpc(NET.drpc)] as const;
  const priceRpcs = [relayRpc(NEAR_NETWORKS.mainnet.fastnear[0]), relayRpc(NEAR_NETWORKS.mainnet.drpc)] as const;
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  const ns = await openNoteStore(w);
  // deposit index 0 of these words in a fresh store: the same note on every run of this state
  let note = await ns.planDeposit(scope, (ref: unknown) => noteSecrets(seed64, ref).precommitment);
  const pc: bigint = note.precommitment;
  const k = await kitModules();
  const tx = async (method: string, signer: { id: string; key: unknown }, receiver: string, actions: unknown[]) => {
    const { hash } = await send(signer.id, signer.key, receiver, actions);
    (steps.deposit ??= { txs: [] }).txs.push({ method, hash, signer: signer.id });
    save();
    const pr = await readBoth(hash, signer.id);
    log(`deposit: ${method} ${hash} ${pr.length ? `PROBLEMS ${pr.join("; ")}` : "read back on both operators, every receipt a success"}`);
    if (pr.length) throw new Error(`${method} did not read back as a success`);
  };
  if (!steps.deposit?.done) {
    const usdc = BigInt(await view2(TOKEN, "ft_balance_of", { account_id: D.id }));
    if (usdc < NOTE) throw new Error(`D holds ${usdc} USDC, needs ${NOTE}`);
    if (!steps.deposit?.txs?.some((t: { method: string }) => t.method === "storage_prepay"))
      await tx("storage_prepay", D, VAULT, [act.call("storage_prepay", { precommitment: String(pc) }, GAS.prepay, k.vaultPrepayYocto(true))]);
    await tx("ft_transfer_call (deposit)", D, TOKEN, [act.call("ft_transfer_call", { receiver_id: VAULT, amount: String(NOTE), msg: k.vaultDepositMessage(pc, D.id) }, GAS.deposit, 1n)]);
    steps.deposit.done = true;
    save();
  }
  const s0 = await synced(k, VAULT);
  const row = s0.deposits.find((d: { precommitment: bigint }) => d.precommitment === pc);
  if (!row || row.value !== NOTE || row.depositor !== D.id) throw new Error("no deposit row of the note by D on its precommitment");
  const commitment = noteCommitment(row.value, row.label, pc);
  if (s0.leaves[Number(row.leafIndex)] !== commitment) throw new Error("the deposit's leaf is not the note's commitment");
  note = await ns.move(note.id, "PLANNED", "INCOMING");
  note = await ns.move(note.id, "INCOMING", "UNSPENT", { leaf: { value: row.value, label: row.label, commitment, leafIndex: BigInt(row.leafIndex) } });
  log(`note: ${NOTE} at leaf ${row.leafIndex}, UNSPENT in the note store`);

  // ---- the relayer: the helper's own quote and carry, at the release's URLs ----
  const helperRpcs = pair(RPCS);
  const quoter = createFeeQuoter({ priceRpcs: pair(PRICE_RPCS), networks: { testnet: { rpcs: helperRpcs, relayer: { relayer_account: acc.R, fee_recipient: acc.F } } } });
  const nonceStore = createFileStore(`${path.resolve(args.state)}.nonce`);
  const store = createWithdrawSendStore(`${path.resolve(args.state)}.sends`, { release: 1, keys: nonceStore });
  if (!relayerKey(rk.secretKey).pub.every((b: number, i: number) => b === rk.pub[i])) throw new Error("the relayer's key text is not its key");
  const relayer = await startRelayer(helperRpcs, nearRpc(ARCHIVAL), R, rk.secretKey, VAULT, nonceStore);
  const deps: WithdrawSendDeps = {
    cfg: { vault: VAULT, token: TOKEN, scope, feeRecipient: acc.F },
    rpcs: helperRpcs,
    reads: quoter.reads("testnet"),
    index: createSpendsIndex(helperRpcs, VAULT),
    leaves: createLeavesIndex(helperRpcs, VAULT),
    store,
    relayers: [relayer],
    tokenStatus: async () => ({ token: TOKEN, caught_up: true, halted: false, vault_blocked: false, code_hash_ok: true, code_hash: USDC_CODE_HASH, block_height: 0, last_event: null }),
  };
  const carried: { at: number; status: number; body: unknown }[] = [];
  const posted: any[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url === `${WITHDRAW_FEE_URL}?token=${encodeURIComponent(TOKEN)}`) return reply(200, await quoter.quote(TOKEN));
    if (url === WITHDRAW_URL && init?.method === "POST") {
      const sent = JSON.parse(String(init.body));
      posted.push(sent);
      const a = await carryWithdraw(sent, deps);
      carried.push({ at: Date.now(), status: a.status, body: a.body });
      log(`POST /v1/withdraw: ${a.status} ${json(a.body)}`);
      return reply(a.status, a.body);
    }
    return reply(404, { error: { code: "not_found" } });
  }) as typeof fetch;
  let rounds = true;
  const outcomes = (async () => {
    while (rounds) {
      await outcomeRound(deps).catch((e: unknown) => log(`outcomeRound: ${String((e as Error)?.message ?? e).slice(0, 160)}`));
      await sleep(ROUND_MS);
    }
  })();

  // ---- the page: the form's fee, the tap, then a reload's settle pass ----
  const snarkjs = createRequire(path.join(ROOT, "packages/kit/package.json"))("snarkjs");
  const zk = (f: string) => new Uint8Array(readFileSync(path.join(ROOT, "packages/kit/zk", f)));
  let proveMs = 0;
  const prover = {
    async load() {},
    async prove(_c: unknown, input: unknown) {
      const p0 = Date.now();
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, zk("withdraw.wasm"), zk("withdraw.zkey"), undefined, undefined, { singleThread: true });
      proveMs = Date.now() - p0;
      return { proof, publicSignals, proveMs };
    },
  };
  const page = { store: async () => w, notes: async () => ns, seed64: async () => Uint8Array.from(seed64), prover };
  const over = { network: "testnet", fetchFn };
  steps.before ??= await balances();
  save();
  const amount: bigint = note.leaf!.value;
  const signal = AbortSignal.timeout(600_000);
  log(`tap: ${amount} to ${W} (the whole note ${note.id})`);
  const tap0 = Date.now();
  // the hand-off's own steps (handoff.ts withdrawHandoff), with this run's relayer in place of the release's pair
  const quote = await askWithdrawFee({ token: TOKEN, relayer: { relayer_account: R, fee_recipient: R }, amount, fetchFn });
  const drawnFee: bigint = quote.relayFee;
  const [trees, blockNs] = await Promise.all([vaultSync({ vault: VAULT, rpcs: tRpcs, cursor: vaultSyncStart(VAULT), lists: ["leaves", "labels"] }).then(treesOf), lowerFinalTime(tRpcs)]);
  const seedCopy = Uint8Array.from(seed64);
  const req = await withdrawRequest({
    seed64: seedCopy, notes: ns, prover, vaultId: VAULT, token: TOKEN, ...trees,
    registerDepositOf: typedRegisterDepositOf("testnet", tRpcs), feeRecipient: quote.feeRecipient, relayFee: quote.relayFee,
    network: "testnet", rpcs: tRpcs, priceRpcs, amount, to: W, deadlineMs: withdrawDeadlineMs(blockNs), blockTimestampNanosec: blockNs,
  });
  const relayed = await relayWithdraw(seedCopy, req, { notes: ns, network: "testnet", rpcs: tRpcs, priceRpcs, fetchFn, signal });
  seedCopy.fill(0);
  log(`relay: ${relayed.kind}${relayed.kind === "landed" ? ` (own ${relayed.own})` : ""} in ${Date.now() - tap0} ms`);
  if (relayed.kind !== "landed" || !relayed.own) throw new Error(`the relay ended ${relayed.kind}`);
  const end = await withdrawArrival({ network: "testnet", rpcs: tRpcs, nullifierHash: relayed.spend.nullifierHash, recipient: W, signal });
  const tapMs = Date.now() - tap0;
  const reserved = await ns.get(note.id);
  log(`hand-off: ${json(end)} in ${tapMs} ms; the note is ${reserved?.state}`);
  const sentBefore = carried.length;
  const pass = await withdrawSettle(page, over);
  log(`reload's settle pass: ${json(pass)}; POSTs during it: ${carried.length - sentBefore}`);
  if (end.kind !== "arrived") throw new Error(`the hand-off ended ${end.kind}, not arrived`);
  if (carried.length !== sentBefore) throw new Error("the settle pass after the arrival sent again");

  // ---- the relayer's settle, then every tx read back ----
  const sentBody = posted[0];
  if (!sentBody) throw new Error("no POST /v1/withdraw was made");
  const nf = BigInt(sentBody.public_signals[1]);
  const until = Date.now() + 300_000;
  let rec = store.get(nf);
  while (!(rec !== null && rec !== "unreadable" && rec.outcome === "succeeded" && rec.settle?.done === true)) {
    if (rec === "unreadable" || (rec !== null && rec.outcome === "failed")) throw new Error(`the send record: ${json(rec)}`);
    if (Date.now() >= until) throw new Error(`the relayer's settle not done in 300 s: ${json(rec)}`);
    await sleep(ROUND_MS);
    rec = store.get(nf);
  }
  rounds = false;
  await outcomes;
  if (rec.settle!.tx === null) throw new Error("settled by another account: no settle of R's to record");
  const txs = [...(steps.setup.txs ?? []), ...(steps.deposit.txs ?? []), { method: "withdraw (R, through send.ts)", hash: rec.tx_hash, signer: acc.R }, { method: "settle (R, through send.ts)", hash: rec.settle!.tx.tx_hash, signer: acc.R }];
  for (const t of txs) {
    const pr = await readBoth(t.hash, t.signer);
    log(`readback: ${t.method} ${t.hash} ${pr.length ? `PROBLEMS ${pr.join("; ")}` : "FINAL on both operators, every receipt a success"}`);
    if (pr.length) throw new Error(`readback: ${t.hash}`);
  }
  const after = await balances();
  const want = amount - BigInt(sentBody.withdrawal.relay_fee);
  if (BigInt(after.W_usdc ?? -1) !== want) throw new Error(`W holds ${after.W_usdc} USDC, want ${want} (the note less the relay fee)`);
  steps.run = {
    amount: String(amount), drawn_fee: String(drawnFee), relay_fee: String(sentBody.withdrawal.relay_fee), register_deposit: String(sentBody.withdrawal.register_deposit),
    recipient: sentBody.withdrawal.recipient, fund_recipient: sentBody.fund_recipient, end: end.kind, tap_ms: tapMs, prove_ms: proveMs, body_bytes: JSON.stringify(sentBody).length,
    settle_pass: pass.outcomes, posts: carried.map((c) => c.status), txs, note: { id: note.id, value: String(note.leaf.value), leaf: String(note.leaf.leafIndex) },
  };
  steps.after = after;
  save();
  store.close();
  nonceStore.close();

  const b = steps.before;
  const r = steps.run;
  const prose = [
    `The run: contracts/vault/scripts/testnet-withdraw-typed.ts on NEAR testnet, the keyless vault ${VAULT} on the team's test USDC ${TOKEN}. The device's side is the signing page's and the wallet's own withdraw code run in node as the testnet build: this run's 12 words and one note planned in the note store (fake-indexeddb) and deposited by D; the hand-off's own steps (askWithdrawFee, the trees by vaultSync, lowerFinalTime, withdrawRequest with the typed account, relayWithdraw, withdrawArrival); then the settle pass a reload runs (withdrawSettle). withdrawHandoff itself pins the release's testnet relayer, whose key is not held, so its steps run with this run's relayer. The relayer's side is the helper's own GET /v1/withdraw/fee quote and POST /v1/withdraw carryWithdraw with outcomeRound every 10 s, in process with R's key, reached through the page's fetchFn at the release's URLs, because the deployed helper answers every testnet withdrawal token_halted.`,
    `Stand-ins: check 10's token watch answered a caught-up, open token; the prover was snarkjs in node on the pinned setup files (single thread), not the page's worker.`,
    `Accounts: P ${P.id} (makes W), D ${D.id} (T04's depositor, deposits the note), R ${R} (relayer-withdraw-send's relayer, also the fee recipient), W ${W} (the typed account: named, no key, not registered on the token before the withdrawal).`,
    `The request as sent: recipient ${r.recipient}, fund_recipient ${r.fund_recipient}, register_deposit ${r.register_deposit} (the token's storage minimum, read naming no account), relay_fee ${r.relay_fee} to R, the whole note ${r.amount} (leaf ${r.note.leaf}); request body ${r.body_bytes} bytes; proof ${r.prove_ms} ms.`,
    `The withdrawal ended ${r.end} (withdrawArrival) in ${r.tap_ms} ms from the tap; POST /v1/withdraw answers ${r.posts.join(", ")}; the reload's settle pass after it: ${json(r.settle_pass)}, with no POST.`,
    `Every Tx above read back FINAL on https://test.rpc.fastnear.com and https://near-testnet.drpc.org, every receipt a success.`,
    `Before (${b.at}): W USDC ${b.W_usdc}, W registration ${json(b.W_registration)}, R USDC ${b.R_usdc}, vault USDC ${b.vault_usdc}, R NEAR ${b.R_near}, totals ${json(b.totals)}.`,
    `After (${after.at}): W USDC ${after.W_usdc}, W registration ${json(after.W_registration)}, R USDC ${after.R_usdc}, vault USDC ${after.vault_usdc}, R NEAR ${after.R_near}, totals ${json(after.totals)}.`,
  ];
  const text = [`CARD ${CARD} / live: PASS`, "Money path: yes", ...txs.map((t: { hash: string; signer: string }) => `Tx: near-testnet ${t.hash} ${t.signer}`), "", ...prose, ""].join("\n");
  const lp = localProblems(text);
  if (lp.length) throw new Error(`the record: ${lp.join("; ")}`);
  const out = path.resolve(ROOT, args.out);
  if (!inside(out, [ROOT])) throw new Error("--out must be inside the repository");
  writeFileSync(out, text);
  console.log(text);
  log(`record written to ${path.relative(ROOT, out)}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(() => process.exit(0), (e) => {
    console.error(`testnet-withdraw-typed: ERROR: ${String(e?.message ?? e).split("\n")[0]}`);
    process.exit(1);
  });
}
