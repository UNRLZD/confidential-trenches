#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// A withdrawal to a NEAR account the user types, paid straight by the vault, on NEAR testnet (card
// wallet-withdraw-move-out): SIGN_HOST's own form deps and hand-off (packages/signpage/src/withdraw/handoff.ts
// withdrawFormDeps, withdrawHandoff, withdrawSettle) run in this process as the testnet build, on the keyless vault of
// contracts/vault/deployments/testnet-v1.json and the team's test USDC only. Testnet only: it refuses any other vault,
// token or network.
//
// The device's side is the wallet's and the page's own modules: the note restored from VT-T02's 12 words
// (packages/wallet/src/notes/restore.ts restoreNotes, writeRestored, on fake-indexeddb), the form's fee (fee()), the
// tap's hand-off (withdrawRequest with `to` = W, so fund_recipient false and register_deposit W's own; relayWithdraw;
// withdrawArrival), then the settle pass a reload runs (withdrawSettle), which must send nothing. The relayer's side is
// the helper's own GET /v1/withdraw/fee quote and POST /v1/withdraw carry (apps/helper/src/withdraw/fee.ts, send.ts
// carryWithdraw, outcomeRound every 10 s), run in this process with R's key and reached through the page's fetchFn at
// the release's URLs: the deployed helper answers every testnet withdrawal token_halted (no testnet token watch).
//
// Stand-ins, each named in the run record: check 10's token watch answers a caught-up, open token; the prover is
// snarkjs in node on the pinned setup files (the page's worker runs the same files in a browser).
//
// Accounts:
//   P  the vault's parent (--parent, its key from --key-file, outside the repo, never printed): pays NEAR only. It
//      makes W.
//   R, F  VT-T02's relayer and fee recipient (the release's testnet pair, wallet relay.ts RELEASE_WITHDRAW_RELAYER): R's
//      key from VT-T02's seed (--t02-state, read only, never printed).
//   W  wt-<run>.<P>: the typed account, named, no key, not registered on the token (so register_deposit is the
//      token's storage minimum); <run> from this run's seed in --state (outside the repo, mode 600).
//   The note: VT-T02's change note (its 12 words from VT-T02's seed), found by the wallet's restore.
//
//   node contracts/vault/scripts/testnet-withdraw-typed.ts --parent <P> --key-file <path> --t02-state <path> --state <path> [--out <file>]
import "../../../scripts/net-window.mjs";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { act } from "./testnet-usdc.mjs";
import { loadKey, repoRoots } from "./deploy.mjs";
import { DEPLOYMENT, RPCS, TOKEN, view2, nearOf, send, readBack, successProblems, loadState } from "./testnet-t04.mjs";
import { entropyOf, keyTextOf, runOf as t02RunOf, accountsOf as t02AccountsOf, ARCHIVAL } from "./testnet-t02.ts";
import { localProblems } from "./testnet-withdraw-send.ts";
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
const PRICE_RPCS = ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"];
const DEFAULT_OUT = `scripts/live-checks/${CARD}.md`;

/** The typed account of a run under `parent`: wt-<8 hex of sha256(seed, tag)>.<parent>. */
export function typedAccountOf(seed: Buffer, parent: string): string {
  const id = createHash("sha256").update(seed).update("wwmo/w").digest("hex").slice(0, 8);
  const a = `wt-${id}.${parent}`;
  if (!isAccountId(a)) throw new Error(`${a}: not a NEAR account id`);
  return a;
}

const FLAGS = new Set(["--parent", "--key-file", "--t02-state", "--state", "--out"]);
function parseArgs(argv: string[]) {
  const v: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (FLAGS.has(a) && i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) v[a] = argv[++i]!;
    else throw new Error(`unknown argument ${a}`);
  }
  for (const k of ["--parent", "--key-file", "--t02-state", "--state"]) if (!v[k]) throw new Error(`${k} is required`);
  return { parent: v["--parent"]!, keyFile: v["--key-file"]!, t02State: v["--t02-state"]!, state: v["--state"]!, out: v["--out"] ?? DEFAULT_OUT };
}
const inside = (file: string, roots: string[]) => {
  const real = path.resolve(file);
  return roots.some((r) => real === r || real.startsWith(r + path.sep));
};
/** VT-T02's seed, read only: never created, never printed. */
function t02Seed(file: string, roots: string[]): Buffer {
  if (inside(file, roots) || !existsSync(file)) throw new Error("--t02-state: no VT-T02 state file outside the repository");
  const s = JSON.parse(readFileSync(file, "utf8")) as { seed?: unknown };
  if (typeof s.seed !== "string" || !/^[0-9a-f]{64}$/.test(s.seed)) throw new Error("--t02-state: no seed");
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
  const { restoreNotes, writeRestored } = await wallet("notes/restore.ts");
  const { RELEASE_WITHDRAW_RELAYER, WITHDRAW_FEE_URL, WITHDRAW_URL, relayRpc } = await wallet("withdraw/relay.ts");
  const { NEAR_NETWORKS } = await wallet("deposit/account.ts");
  const { withdrawFormDeps, withdrawHandoff, withdrawSettle } = await page_("withdraw/handoff.ts");
  const { vaultScope } = await page_("withdraw/checks.ts");

  const NET = NEAR_NETWORKS.testnet;
  if (NET.vault !== VAULT || NET.usdc !== TOKEN) throw new Error("the wallet's testnet vault or token is not testnet-v1.json's");
  const REL = RELEASE_WITHDRAW_RELAYER.testnet;
  if (!REL) throw new Error("the testnet build names no withdrawal relayer");
  const cfg = await view2(VAULT, "config", {});
  if (cfg.asset !== TOKEN || !/ testnet$/.test(cfg.version)) throw new Error(`the vault's config is not the testnet build on ${TOKEN}`);
  const scope = BigInt(cfg.scope);
  if (vaultScope("testnet") !== scope) throw new Error("the page's testnet scope is not the vault's");

  const P = { id: args.parent, key: loadKey(args.keyFile, args.parent, roots) };
  const t02 = t02Seed(args.t02State, roots);
  const t02acc = t02AccountsOf(t02RunOf(t02), args.parent);
  if (t02acc.R !== REL.relayer_account || t02acc.F !== REL.fee_recipient) throw new Error("VT-T02's R and F are not the release's testnet relayer pair");
  const rk = keyTextOf(t02, "R");
  const st = loadState(args.state, roots);
  const W = typedAccountOf(st.seed, args.parent);
  log(`vault ${VAULT}, token ${TOKEN}; P ${P.id}, R ${t02acc.R}, F ${t02acc.F}, W ${W}`);
  const steps = st.steps as Record<string, any>;
  const save = () => st.save();
  const balances = async () => ({
    at: new Date().toISOString(),
    W_usdc: await view2(TOKEN, "ft_balance_of", { account_id: W }).catch(() => null),
    W_registration: await view2(TOKEN, "storage_balance_of", { account_id: W }).catch(() => "unread"),
    F_usdc: await view2(TOKEN, "ft_balance_of", { account_id: t02acc.F }).catch(() => null),
    vault_usdc: await view2(TOKEN, "ft_balance_of", { account_id: VAULT }),
    R_near: String(await nearOf(t02acc.R)),
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

  // ---- the device: VT-T02's words, the note restored ----
  const seed64: Uint8Array = wordsToSeed64(entropyToWords(entropyOf(t02)));
  const tRpcs = [relayRpc(NET.fastnear[0]), relayRpc(NET.drpc)] as const;
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  const ns = await openNoteStore(w);
  const t0 = Date.now();
  const restored = await restoreNotes({ seed64, vault: VAULT, token: TOKEN, rpcs: tRpcs });
  await writeRestored(ns, restored);
  const unspent = (await ns.list()).filter((n: any) => n.state === "UNSPENT" && n.scope === scope);
  log(`restore: ${restored.notes.length} notes of VT-T02's words in ${Date.now() - t0} ms; UNSPENT: ${unspent.map((n: any) => `${n.ref.kind} ${n.leaf.value} at leaf ${n.leaf.leafIndex}`).join(", ") || "none"}`);
  if (unspent.length === 0) throw new Error("no UNSPENT note of VT-T02's words on the testnet vault");
  const note = unspent.reduce((a: any, b: any) => (b.leaf.value > a.leaf.value ? b : a));

  // ---- the relayer: the helper's own quote and carry, at the release's URLs ----
  const helperRpcs = pair(RPCS);
  const quoter = createFeeQuoter({ priceRpcs: pair(PRICE_RPCS), networks: { testnet: { rpcs: helperRpcs, relayer: { relayer_account: t02acc.R, fee_recipient: t02acc.F } } } });
  const nonceStore = createFileStore(`${path.resolve(args.state)}.nonce`);
  const store = createWithdrawSendStore(`${path.resolve(args.state)}.sends`, { release: 1, keys: nonceStore });
  if (!relayerKey(rk.secretKey).pub.every((b: number, i: number) => b === rk.pub[i])) throw new Error("the relayer's key text is not its key");
  const relayer = await startRelayer(helperRpcs, nearRpc(ARCHIVAL), t02acc.R, rk.secretKey, VAULT, nonceStore);
  const deps: WithdrawSendDeps = {
    cfg: { vault: VAULT, token: TOKEN, scope, feeRecipient: t02acc.F },
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
  const drawnFee: bigint = await withdrawFormDeps(page, over).fee();
  const amount: bigint = note.leaf.value;
  log(`tap: ${amount} to ${W} (the whole note ${note.id}), drawn fee ${drawnFee}`);
  const tap0 = Date.now();
  const end = await withdrawHandoff(page, over)!({ recipient: W, amount }, drawnFee);
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
  const txs = [...(steps.setup.txs ?? []), { method: "withdraw (R, through send.ts)", hash: rec.tx_hash, signer: t02acc.R }, { method: "settle (R, through send.ts)", hash: rec.settle!.tx.tx_hash, signer: t02acc.R }];
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
    `The run: contracts/vault/scripts/testnet-withdraw-typed.ts on NEAR testnet, the keyless vault ${VAULT} on the team's test USDC ${TOKEN}. The device's side is SIGN_HOST's own withdraw code run in node as the testnet build: the note restored from VT-T02's 12 words by the wallet's restoreNotes and writeRestored (fake-indexeddb), the form's fee() (withdrawFormDeps), the tap's withdrawHandoff (withdrawRequest with the typed account, relayWithdraw, withdrawArrival), then the settle pass a reload runs (withdrawSettle). The relayer's side is the helper's own GET /v1/withdraw/fee quote and POST /v1/withdraw carryWithdraw with outcomeRound every 10 s, in process with R's key, reached through the page's fetchFn at the release's URLs, because the deployed helper answers every testnet withdrawal token_halted.`,
    `Stand-ins: check 10's token watch answered a caught-up, open token; the prover was snarkjs in node on the pinned setup files (single thread), not the page's worker.`,
    `Accounts: P ${P.id} (makes W), R ${t02acc.R} and F ${t02acc.F} (the release's testnet relayer and fee recipient, VT-T02's), W ${W} (the typed account: named, no key, not registered on the token before the withdrawal).`,
    `The request as sent: recipient ${r.recipient}, fund_recipient ${r.fund_recipient}, register_deposit ${r.register_deposit} (the token's storage minimum, W unregistered), relay_fee ${r.relay_fee} to F, the whole note ${r.amount} (VT-T02's change note, leaf ${r.note.leaf}); request body ${r.body_bytes} bytes; proof ${r.prove_ms} ms.`,
    `The hand-off ended ${r.end} in ${r.tap_ms} ms from the tap; POST /v1/withdraw answers ${r.posts.join(", ")}; the reload's settle pass after it: ${json(r.settle_pass)}, with no POST.`,
    `Every Tx above read back FINAL on https://test.rpc.fastnear.com and https://near-testnet.drpc.org, every receipt a success.`,
    `Before (${b.at}): W USDC ${b.W_usdc}, W registration ${json(b.W_registration)}, F USDC ${b.F_usdc}, vault USDC ${b.vault_usdc}, R NEAR ${b.R_near}, totals ${json(b.totals)}.`,
    `After (${after.at}): W USDC ${after.W_usdc}, W registration ${json(after.W_registration)}, F USDC ${after.F_usdc}, vault USDC ${after.vault_usdc}, R NEAR ${after.R_near}, totals ${json(after.totals)}.`,
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
