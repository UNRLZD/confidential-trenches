#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// VT-T02 on NEAR testnet (vault.md 5: "a deposit by U's own ft_transfer_call as a NEP-366 DelegateAction, carried by
// the relayer (2.10); a withdrawal with a proof made in" a browser), on the keyless vault of contracts/vault/deployments/testnet-v1.json and the team's
// test USDC only. Card vault-testnet-t02. Testnet only: it refuses any other vault, token or network.
//
// The device's side is the wallet's own modules: the note store (packages/wallet/src/notes/store.ts on fake-indexeddb,
// planDeposit), U = U_{s,i} (deposit/account.ts), U's signed call (deposit/delegate.ts) and its follow to the note's leaf
// (deposit/bind.ts bindDeposit). The relayer's side is the helper's own POST /v1/bind carry (apps/helper/src/bind/send.ts
// carryDeposit, createSendReads, startRelayer, createFileStore), run in this process and reached through bindDeposit's
// fetchFn at RELEASE_BIND_URL: the deployed helper mounts no /v1/bind (src/server.ts MOUNTED). The answer honours the
// device's abort (SEND_TIMEOUT_MS) as a server's would: a carry still running goes on, and the device sends the same
// bytes again for its tx hash.
//
// The withdraw leg: the kit's request and circuit input (vaultWithdrawRequest, vaultWithdrawInput on trees vaultSync
// reads on two operators), the proof made in a browser on the page of t02-page/ (the kit's startProver), checked
// against withdraw.vkey, then the helper's own carryWithdraw and outcomeRound (apps/helper/src/withdraw/send.ts) in this
// process with R's key: the deployed helper answers every testnet withdrawal token_halted (src/server.ts gives the
// withdraw sender mainnet's token watch only).
//
// Stand-ins, each named in the run record:
//   - the token watch, on both legs: an answer of a caught-up, open token (the helper has no testnet watch);
//   - the deposit's pausedAt (the watch's pause history): a read of the token's ft_balance_of at that block, which USDC
//     refuses with "FiatToken: paused" while paused (as apps/helper/test/bind-send/carry.ts);
//   - marginK 20: R4's margin K is not pinned in a release yet; 20 is the sandbox carry's (relayer_send.rs MARGIN_K);
//   - the page: served from 127.0.0.1 with no CSP (SIGN_HOST's policy is not applied), so its load time is a local
//     read, not a download;
//   - a 503 from carryWithdraw that sent nothing is asked again, up to 5 more times, 3 s, 6 s, ... apart.
//
// Accounts:
//   P  the vault's parent (--parent, its key from --key-file, outside the repo, never printed): pays NEAR only, from the
//      machine that holds P's key file (`setup`).
//   D  T04's depositor (its key from T04's seed, --t04-state, read only, never printed): sends U the deposit's USDC.
//   U  the deposit account U_{s,i}: s the vault's scope, i the note store's index; its 12 words from this run's seed.
//   G  g-<run>.<P>: the bind relayer's gas account, a full-access key from this run's seed; prepays and carries.
//   R  r-<run>.<P>: the withdrawal relayer of the withdraw leg, a full-access key from this run's seed.
//   F  f-<run>.<P>: the withdrawal's fee recipient, no key. W  w-<run>.<P>: the withdrawal's recipient, no key.
// This run's seed (32 random bytes), its words and its keys live in --state, a file outside the repo (mode 600); `ids`
// prints only account ids and public keys. Nothing secret is printed.
//
//   node contracts/vault/scripts/testnet-t02.ts ids --state <path>
//   node contracts/vault/scripts/testnet-t02.ts setup --parent <P> --key-file <path> --t04-state <path> --state <path>
//        --run <id> --u <U> --g-pub <hex> --r-pub <hex>   (on the machine that holds P's key file; its own --state)
//   node contracts/vault/scripts/testnet-t02.ts deposit --state <path> [--amount <base units>]
//        (plans the note, prints U, waits until U holds the amount, then binds; the record in <state>.deposit.json)
//   node contracts/vault/scripts/testnet-t02.ts withdraw --state <path> [--port <n>]
//        (builds and serves the page; its address, with the run's token, in <state>.page-url; open it in the browser)
//   node contracts/vault/scripts/testnet-t02.ts record --state <path> --setup <setup's setup-json, as a file>
//        (writes contracts/vault/deployments/testnet-t02-run.json and scripts/live-checks/vault-testnet-t02.md)
import "../../../scripts/net-window.mjs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { b58encode } from "./near-tx.mjs";
import { act } from "./testnet-usdc.mjs";
import { loadKey, repoRoots } from "./deploy.mjs";
import { DEPLOYMENT, RPCS, TOKEN, REGISTER, keyOf, successProblems, view2, nearOf, send, readBack, loadState } from "./testnet-t04.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
export const CARD = "vault-testnet-t02";
const NEAR = 10n ** 24n;
const TGAS = 10n ** 12n;
export const AMOUNT = 2_000_000n;
export const G_NEAR = NEAR / 2n;
export const R_NEAR = (NEAR * 8n) / 10n;
export const PLAIN_NEAR = NEAR / 100n;
/** FastNEAR's archival testnet RPC (money-gate.mjs RPCS["near-testnet"]), for the relayer's older outcomes. */
export const ARCHIVAL = "https://archival-rpc.testnet.fastnear.com";
/** R4's margin K: a stand-in, the sandbox carry's (contracts/vault/tests/relayer_send.rs MARGIN_K); no release pins one yet. */
export const MARGIN_K = 20n;
const GAS_PLAIN = 30n * TGAS;
const POLL_MS = 10_000;
const FUND_BOUND_MS = 30 * 60_000;

// ---- pure parts ----

/** The run's short id: names G, R, F and W. */
export const runOf = (seed: Buffer): string => createHash("sha256").update(seed).update("vt-t02/run").digest("hex").slice(0, 8);
export function accountsOf(run: string, parent: string) {
  if (!/^[0-9a-f]{8}$/.test(run)) throw new Error("--run: 8 hex");
  return { G: `g-${run}.${parent}`, R: `r-${run}.${parent}`, F: `f-${run}.${parent}`, W: `w-${run}.${parent}` };
}
/** U's 16 bytes of entropy (its 12 words) from the run's seed. */
export const entropyOf = (seed: Buffer): Uint8Array => Uint8Array.from(createHash("sha256").update(seed).update("vt-t02/words").digest().subarray(0, 16));
/** A key from the run's seed: { pub, privateKey, secretKey } with secretKey ed25519:<base58 of seed ‖ pub>. */
export function keyTextOf(seed: Buffer, tag: string): { pub: Buffer; privateKey: any; secretKey: string } {
  const k = keyOf(seed, `vt-t02/${tag}`);
  const d = Buffer.from(k.privateKey.export({ format: "jwk" }).d, "base64url");
  return { pub: k.pub, privateKey: k.privateKey, secretKey: `ed25519:${b58encode(Buffer.concat([d, k.pub]))}` };
}

function flags(argv: string[], allowed: string[]): Record<string, string> {
  const v: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (allowed.includes(a) && i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) v[a] = argv[++i]!;
    else throw new Error(`unknown argument ${a}`);
  }
  return v;
}
const need = (v: Record<string, string>, ks: string[]) => {
  for (const k of ks) if (!v[k]) throw new Error(`${k} is required`);
};
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const log = (s: string) => console.log(`t02: ${s}`);
const json = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));

function testnetVault(): string {
  const dep = JSON.parse(readFileSync(DEPLOYMENT, "utf8"));
  if (dep.network !== "testnet" || dep.asset !== TOKEN || !String(dep.account_id).endsWith(".testnet")) throw new Error("testnet-v1.json is not the testnet vault on the team's USDC");
  return dep.account_id;
}

/** Every receipt of `hash` read back FINAL and a success on both operators; the problems, [] when none. */
async function readBoth(hash: string, signer: string): Promise<string[]> {
  const reads = await Promise.all(RPCS.map((_: string, i: number) => readBack(hash, signer, i)));
  return reads.flatMap((x: unknown, i: number) => (x ? successProblems(x).map((p: string) => `${RPCS[i]}: ${p}`) : [`${RPCS[i]}: not read`]));
}

// ---- ids: the run's public ids (state on this host) ----

function ids(argv: string[]) {
  const v = flags(argv, ["--state"]);
  need(v, ["--state"]);
  const st = loadState(v["--state"], repoRoots());
  const parent = JSON.parse(readFileSync(DEPLOYMENT, "utf8")).parent;
  const run = runOf(st.seed);
  const a = accountsOf(run, parent);
  const g = keyTextOf(st.seed, "G");
  const r = keyTextOf(st.seed, "R");
  console.log(json({ run, parent, ...a, g_pub: g.pub.toString("hex"), r_pub: r.pub.toString("hex") }));
}

// ---- setup: P's and D's transactions (on the host holding P's key) ----

async function setup(argv: string[]) {
  const v = flags(argv, ["--parent", "--key-file", "--t04-state", "--state", "--run", "--u", "--g-pub", "--r-pub"]);
  need(v, ["--parent", "--key-file", "--t04-state", "--state", "--run", "--u", "--g-pub", "--r-pub"]);
  const dep = JSON.parse(readFileSync(DEPLOYMENT, "utf8"));
  testnetVault();
  if (v["--parent"] !== dep.parent) throw new Error(`--parent must be the vault's parent ${dep.parent}`);
  if (!/^[0-9a-f]{64}$/.test(v["--u"]!) || !/^[0-9a-f]{64}$/.test(v["--g-pub"]!) || !/^[0-9a-f]{64}$/.test(v["--r-pub"]!)) throw new Error("--u, --g-pub, --r-pub: 64 hex");
  const roots = repoRoots();
  const P = { id: v["--parent"]!, key: loadKey(v["--key-file"], v["--parent"], roots) };
  const t04 = JSON.parse(readFileSync(path.resolve(v["--t04-state"]!), "utf8"));
  if (!/^[0-9a-f]{64}$/.test(t04.seed ?? "")) throw new Error("--t04-state: no seed");
  const dk = keyOf(Buffer.from(t04.seed, "hex"), "D");
  const D = { id: dk.pub.toString("hex"), key: dk };
  const st = loadState(v["--state"], roots);
  const a = accountsOf(v["--run"]!, P.id);
  const U = v["--u"]!;
  log(`setup: P ${P.id}, D ${D.id}, U ${U}, G ${a.G}, R ${a.R}, F ${a.F}, W ${a.W}`);
  const txs: { step: string; method: string; hash: string; signer: string }[] = (st.steps.setup?.txs ?? []);
  const tx = async (signer: { id: string; key: unknown }, receiver: string, actions: unknown[], method: string) => {
    const { hash } = await send(signer.id, signer.key, receiver, actions);
    txs.push({ step: "setup", method, hash, signer: signer.id });
    st.steps.setup = { txs };
    st.save();
    const problems = await readBoth(hash, signer.id);
    log(`${method} ${hash} ${problems.length ? `PROBLEMS ${problems.join("; ")}` : "read back on both operators, every receipt a success"}`);
    if (problems.length) throw new Error(`${method} ${hash} did not read back as a success`);
  };
  const pubOf = (h: string) => Buffer.from(h, "hex");
  if ((await nearOf(a.G)) === null) await tx(P, a.G, [act.create(), act.transfer(G_NEAR), act.fullKey(pubOf(v["--g-pub"]!))], "CreateAccount (G) + Transfer 0.5 NEAR + AddKey");
  if ((await nearOf(a.R)) === null) await tx(P, a.R, [act.create(), act.transfer(R_NEAR), act.fullKey(pubOf(v["--r-pub"]!))], "CreateAccount (R) + Transfer 0.8 NEAR + AddKey");
  for (const [n, id] of [["F", a.F], ["W", a.W]] as const)
    if ((await nearOf(id)) === null) await tx(P, id, [act.create(), act.transfer(PLAIN_NEAR)], `CreateAccount (${n}) + Transfer 0.01 NEAR, no key`);
  if ((await nearOf(U)) === null) await tx(P, U, [act.transfer(PLAIN_NEAR)], "Transfer 0.01 NEAR (U, implicit)");
  for (const [n, id] of [["F", a.F], ["W", a.W], ["U", U]] as const)
    if ((await view2(TOKEN, "storage_balance_of", { account_id: id })) === null)
      await tx(P, TOKEN, [act.call("storage_deposit", { account_id: id, registration_only: true }, GAS_PLAIN, REGISTER)], `storage_deposit (${n})`);
  const have = BigInt(await view2(TOKEN, "ft_balance_of", { account_id: U }));
  if (have < AMOUNT) await tx(D, TOKEN, [act.call("ft_transfer", { receiver_id: U, amount: String(AMOUNT - have) }, GAS_PLAIN, 1n)], `ft_transfer ${AMOUNT - have} (D to U)`);
  console.log(`setup-json: ${json({ txs, U, D: D.id, P: P.id, ...a })}`);
}

// ---- deposit: the device and the relayer, in this process ----

async function deposit(argv: string[]) {
  const v = flags(argv, ["--state", "--amount"]);
  need(v, ["--state"]);
  const amount = v["--amount"] ? BigInt(v["--amount"]) : AMOUNT;
  const VAULT = testnetVault();
  const parent = JSON.parse(readFileSync(DEPLOYMENT, "utf8")).parent;
  const st = loadState(v["--state"], repoRoots());
  const run = runOf(st.seed);
  const a = accountsOf(run, parent);
  const G = { id: a.G, ...keyTextOf(st.seed, "G") };

  const wallet = (p: string) => import(pathToFileURL(path.join(ROOT, "packages/wallet/src", p)).href);
  const helper = (p: string) => import(pathToFileURL(path.join(ROOT, "apps/helper/src", p)).href);
  const req = createRequire(path.join(ROOT, "packages/wallet/package.json"));
  const { IDBFactory } = await import(pathToFileURL(req.resolve("fake-indexeddb")).href);
  const { entropyToWords, wordsToSeed64 } = await wallet("derive/index.ts");
  const { openWalletStore } = await wallet("store/index.ts");
  const { openNoteStore } = await wallet("notes/store.ts");
  const { noteSecrets } = await wallet("notes/secrets.ts");
  const { depositAccount, NEAR_NETWORKS } = await wallet("deposit/account.ts");
  const { bindDeposit, bindRpc } = await wallet("deposit/bind.ts");
  const { RELEASE_BIND_URL } = await wallet("deposit/delegate.ts");
  const bind = await helper("bind/send.ts");
  const { USDC_CODE_HASH } = await helper("token-status/status.ts");

  const NET = NEAR_NETWORKS.testnet;
  if (NET.vault !== VAULT || NET.usdc !== TOKEN) throw new Error("the wallet's testnet vault or token is not testnet-v1.json's");
  const cfg = await view2(VAULT, "config", {});
  if (cfg.asset !== TOKEN || !/ testnet$/.test(cfg.version)) throw new Error(`the vault's config is not the testnet build on ${TOKEN}`);
  const scope = BigInt(cfg.scope);

  const seed64: Uint8Array = wordsToSeed64(entropyToWords(entropyOf(st.seed)));
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  const ns = await openNoteStore(w);
  const note = await ns.planDeposit(scope, (ref: unknown) => noteSecrets(seed64, ref).precommitment);
  const i: number = note.ref.i;
  const U: string = depositAccount(seed64, scope, i).account;
  st.steps.deposit = { ...(st.steps.deposit ?? {}), s: String(scope), i, U, note: note.id, amount: String(amount), precommitment: String(note.precommitment) };
  st.save();
  log(`deposit: U ${U} (s = the vault's scope, i ${i}), G ${G.id}; amount ${amount}; waiting for U's key and USDC (run setup with --u ${U})`);

  const t0 = Date.now();
  for (;;) {
    const near = await nearOf(U).catch(() => null);
    const usdc = near === null ? null : await view2(TOKEN, "ft_balance_of", { account_id: U }).catch(() => null);
    const g = await nearOf(G.id).catch(() => null);
    if (near !== null && usdc !== null && BigInt(usdc) >= amount && g !== null) break;
    if (Date.now() - t0 > FUND_BOUND_MS) throw new Error("U was not funded in 30 min");
    await sleep(POLL_MS);
  }
  const balances = async () => ({
    at: new Date().toISOString(),
    U_usdc: await view2(TOKEN, "ft_balance_of", { account_id: U }),
    vault_usdc: await view2(TOKEN, "ft_balance_of", { account_id: VAULT }),
    U_near: String(await nearOf(U)),
    G_near: String(await nearOf(G.id)),
    totals: await view2(VAULT, "totals", {}),
  });
  const before = await balances();
  log(`before: ${json(before)}`);

  // the relayer: the helper's carry on the testnet pair, its store beside --state
  const rpcs = RPCS.map((u: string) => bind.nearRpc(u)) as [unknown, unknown];
  const store = bind.createFileStore(`${path.resolve(v["--state"]!)}.bind`);
  if (!bind.relayerKey(G.secretKey).pub.every((b: number, k: number) => b === G.pub[k])) throw new Error("G's key text is not its key");
  const relayer = await bind.startRelayer(rpcs, bind.nearRpc(ARCHIVAL), G.id, G.secretKey, VAULT, store);
  // stand-in (named in the record): the watch's pause history as a read of the token at that block
  const pausedAt = async (height: bigint): Promise<boolean | null> => {
    try {
      const r = (await (rpcs[0] as any)("query", { request_type: "call_function", block_id: Number(height), account_id: TOKEN, method_name: "ft_balance_of", args_base64: Buffer.from(JSON.stringify({ account_id: VAULT })).toString("base64") })) as { result?: unknown; error?: unknown };
      if (Array.isArray(r.result)) return false;
      if (typeof r.error === "string" && r.error.includes(bind.USDC_PAUSED)) return true;
    } catch (e) {
      if (String((e as Error)?.message ?? e).includes(bind.USDC_PAUSED)) return true;
    }
    return null;
  };
  const sendDeps = {
    cfg: { vault: VAULT, token: TOKEN, marginK: MARGIN_K },
    reads: bind.createSendReads(rpcs, { vault: VAULT, token: TOKEN }),
    store,
    relayer,
    // stand-in (named in the record): the token watch answering a caught-up, open token
    tokenStatus: async () => {
      const h = ((await (rpcs[0] as any)("block", { finality: "final" })) as { header: { height: number } }).header.height;
      return { token: TOKEN, caught_up: true, halted: false, vault_blocked: false, code_hash_ok: true, code_hash: USDC_CODE_HASH, block_height: h, last_event: null };
    },
    pausedAt,
  };
  const carries: { at: number; ms: number | null; status: number | null; body: unknown }[] = [];
  const fetchFn = async (url: unknown, init: { body?: string; signal?: AbortSignal } = {}): Promise<Response> => {
    if (String(url) !== RELEASE_BIND_URL) return fetch(url as string, init as RequestInit);
    const entry: { at: number; ms: number | null; status: number | null; body: unknown } = { at: Date.now(), ms: null, status: null, body: null };
    carries.push(entry);
    const carry = bind.carryDeposit(JSON.parse(init.body ?? "null"), sendDeps).then((ans: { status: number; body: unknown }) => {
      Object.assign(entry, { ms: Date.now() - entry.at, status: ans.status, body: ans.body });
      log(`/v1/bind answered ${ans.status} ${json(ans.body)} in ${entry.ms} ms`);
      return ans;
    });
    const aborted = new Promise<never>((_, no) => {
      const s = init.signal;
      if (!s) return;
      if (s.aborted) no(s.reason);
      s.addEventListener("abort", () => no(s.reason), { once: true });
    });
    const ans = await Promise.race([carry, aborted]);
    return new Response(JSON.stringify(ans.body), { status: ans.status, headers: { "content-type": "application/json" } });
  };
  const tBind = Date.now();
  const outcome = await bindDeposit(seed64, { network: "testnet", s: scope, i, noteId: note.id, amount }, { store: ns, rpcs: [bindRpc(NET.fastnear[0]), bindRpc(NET.drpc)], relayerAccount: G.id, fetchFn });
  const bindMs = Date.now() - tBind;
  log(`bindDeposit: ${outcome.kind} in ${bindMs} ms`);
  if (outcome.kind !== "deposited") throw new Error(`deposit: ${json(outcome)}`);
  const rec = store.get(U);
  const txs = [...(rec?.prepays ?? []).map((t: { tx_hash: string }) => ({ method: "storage_prepay", hash: t.tx_hash })), ...(rec?.sends ?? []).map((t: { tx_hash: string }) => ({ method: "Delegate (U's ft_transfer_call)", hash: t.tx_hash }))];
  for (const t of txs) {
    const problems = await readBoth(t.hash, G.id);
    log(`${t.method} ${t.hash} ${problems.length ? `PROBLEMS ${problems.join("; ")}` : "read back FINAL on both operators, every receipt a success"}`);
    if (problems.length) throw new Error(`${t.hash} did not read back as a success`);
  }
  const after = await balances();
  log(`after: ${json(after)}`);
  const leaf = outcome.note.leaf;
  st.steps.deposit = { ...st.steps.deposit, done: true, txs: txs.map((t) => ({ ...t, signer: G.id })), before, after, bind_ms: bindMs, carries, leaf: { value: String(leaf.value), label: String(leaf.label), commitment: String(leaf.commitment), leaf_index: String(leaf.leafIndex) } };
  st.save();
  writeFileSync(`${path.resolve(v["--state"]!)}.deposit.json`, json({ U, G: G.id, txs, before, after, bind_ms: bindMs, carries, leaf: st.steps.deposit.leaf }) + "\n", { mode: 0o600 });
  ns.close();
  w.close();
  store.close?.();
  process.exit(0);
}

// ---- withdraw: the proof made in a browser, the relayer's carry in this process ----

/**
 * The page server's gate: null to serve, else why it refuses. Every request must name the server as 127.0.0.1:<port>
 * or localhost:<port> (a DNS name rebound to 127.0.0.1 carries its own Host and is refused); the input and the result
 * live only under /<token>/, this run's random token; any other /<hex>/ path is refused.
 */
export function pageRefusal(host: string | undefined, port: number, pathname: string, token: string): "host" | "token" | null {
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return "host";
  const m = /^\/([0-9a-f]{32})\/(input\.json|result)$/.exec(pathname);
  if (pathname === "/input.json" || pathname === "/result") return "token";
  if (m && (m[1]!.length !== token.length || !timingSafeEqual(Buffer.from(m[1]!), Buffer.from(token)))) return "token";
  return null;
}

/** What W gets plus the fee, out of the 2,000,000 note: the change note keeps the rest. */
export const WITHDRAWN = 1_500_000n;
const ROUND_MS = 10_000;
const OUTCOME_BOUND_MS = 300_000;
const RESULT_BOUND_MS = 15 * 60_000;
/** Mainnet's pair for the fee's price pool (fee.ts priceRpcs), as the relayer-withdraw-send run. */
const PRICE_RPCS = ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"];
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".wasm": "application/wasm", ".zkey": "application/octet-stream", ".json": "application/json" };

/** deadline_ms: the newer of two final headers' timestamp_nanosec / 1e6, + 600,000 (as the relayer-withdraw-send run). */
export function deadlineMsOf(a: unknown, b: unknown): number {
  for (const x of [a, b]) if (typeof x !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(x)) throw new Error("timestamp_nanosec: not a decimal string");
  const ms = [BigInt(a as string), BigInt(b as string)].map((n) => n / 1_000_000n);
  return Number(ms[0]! > ms[1]! ? ms[0]! : ms[1]!) + 600_000;
}

async function withdraw(argv: string[]) {
  const v = flags(argv, ["--state", "--port"]);
  need(v, ["--state"]);
  const VAULT = testnetVault();
  const parent = JSON.parse(readFileSync(DEPLOYMENT, "utf8")).parent;
  const stateFile = path.resolve(v["--state"]!);
  const st = loadState(stateFile, repoRoots());
  const dep = st.steps.deposit;
  if (dep?.done !== true) throw new Error("withdraw: the deposit step has not landed");
  const run = runOf(st.seed);
  const a = accountsOf(run, parent);
  const R = { id: a.R, ...keyTextOf(st.seed, "R") };

  const wallet = (p: string) => import(pathToFileURL(path.join(ROOT, "packages/wallet/src", p)).href);
  const helper = (p: string) => import(pathToFileURL(path.join(ROOT, "apps/helper/src", p)).href);
  const { entropyToWords, wordsToSeed64 } = await wallet("derive/index.ts");
  const { noteSecrets, noteCommitment } = await wallet("notes/secrets.ts");
  const bind = await helper("bind/send.ts");
  const { createFeeQuoter } = await helper("withdraw/fee.ts");
  const { createLeavesIndex, createSpendsIndex, createWithdrawSendStore } = await helper("withdraw/index.ts");
  const { carryWithdraw, outcomeRound } = await helper("withdraw/send.ts");
  const { USDC_CODE_HASH } = await helper("token-status/status.ts");
  const { kitModules, synced } = await import("./testnet-t04.mjs");
  const k = await kitModules();

  const cfg = await view2(VAULT, "config", {});
  const scope = BigInt(cfg.scope);
  if (String(scope) !== dep.s) throw new Error("withdraw: the vault's scope is not the deposit's");
  const seed64: Uint8Array = wordsToSeed64(entropyToWords(entropyOf(st.seed)));
  const label = BigInt(dep.leaf.label);
  const N = noteSecrets(seed64, { kind: "deposit", s: scope, i: dep.i });
  if (String(N.precommitment) !== dep.precommitment) throw new Error("withdraw: the seed's note is not the deposit's");
  const CH = noteSecrets(seed64, { kind: "change", l: label, j: 0 });
  const RF = noteSecrets(seed64, { kind: "refund", l: label, j: 0 });
  const note = { value: BigInt(dep.leaf.value), label, nullifier: N.nullifier, secret: N.secret };
  const nf: bigint = N.nullifierHash;

  const rpcs = RPCS.map((u: string) => bind.nearRpc(u)) as [any, any];
  const balances = async () => ({
    at: new Date().toISOString(),
    W_usdc: await view2(TOKEN, "ft_balance_of", { account_id: a.W }),
    F_usdc: await view2(TOKEN, "ft_balance_of", { account_id: a.F }),
    vault_usdc: await view2(TOKEN, "ft_balance_of", { account_id: VAULT }),
    R_near: String(await nearOf(R.id)),
    totals: await view2(VAULT, "totals", {}),
  });
  const w = (st.steps.withdraw ??= {});
  const save = () => st.save();
  w.before ??= await balances();
  save();
  log(`withdraw: before ${json(w.before)}`);

  const quoter = createFeeQuoter({ priceRpcs: PRICE_RPCS.map((u) => bind.nearRpc(u)), networks: { testnet: { rpcs, relayer: { relayer_account: R.id, fee_recipient: a.F } } } });
  const nonceStore = bind.createFileStore(`${stateFile}.nonce`);
  const store = createWithdrawSendStore(`${stateFile}.sends`, { release: 1, keys: nonceStore });
  if (!bind.relayerKey(R.secretKey).pub.every((b: number, i: number) => b === R.pub[i])) throw new Error("R's key text is not its key");
  const relayer = await bind.startRelayer(rpcs, bind.nearRpc(ARCHIVAL), R.id, R.secretKey, VAULT, nonceStore);
  const deps = {
    cfg: { vault: VAULT, token: TOKEN, scope, feeRecipient: a.F },
    rpcs,
    reads: quoter.reads("testnet"),
    index: createSpendsIndex(rpcs, VAULT),
    leaves: createLeavesIndex(rpcs, VAULT),
    store,
    relayers: [relayer],
    // stand-in (named in the record): check 10's watch answering a caught-up, open token (the helper has no testnet watch)
    tokenStatus: async () => ({ token: TOKEN, caught_up: true, halted: false, vault_blocked: false, code_hash_ok: true, code_hash: USDC_CODE_HASH, block_height: 0, last_event: null }),
  };

  if (w.carry?.tx_hash === undefined && store.get(nf) === null) {
    // the request is made when the page asks for its input, so the deadline is fresh
    let pending: { withdrawal: unknown; context: string; relayFee: bigint; validUntil: unknown; deadlineMs: number } | null = null;
    const makeInput = async () => {
      const quote = await quoter.quote(TOKEN);
      const relayFee = BigInt(quote.relay_fee);
      const hs = await Promise.all(rpcs.map(async (r) => ((await r("block", { finality: "final" })) as { header: { timestamp_nanosec: string } }).header.timestamp_nanosec));
      const deadlineMs = deadlineMsOf(hs[0], hs[1]);
      const s = await synced(k, VAULT);
      const nowMs = Date.now();
      const { withdrawal, context } = k.vaultWithdrawRequest({
        vaultId: VAULT, token: TOKEN, recipient: a.W, registerDeposit: 0n, feeRecipient: a.F, relayFee,
        refundPrecommitment: RF.precommitment, deadlineMs, withdrawn: WITHDRAWN, nowMs,
      });
      const stateTree = new k.VaultTree(s.leaves);
      const labelTree = new k.VaultTree(s.labels);
      if (stateTree.root !== s.stateTree.root || labelTree.root !== s.labelTree.root) throw new Error("the synced trees' roots are not the vault's");
      const input = k.vaultWithdrawInput({
        stateTree, labelTree, newestStateRoot: s.stateTree.root, newestLabelRoot: s.labelTree.root,
        note, newNullifier: CH.nullifier, newSecret: CH.secret, withdrawn: WITHDRAWN, withdrawal, vaultId: VAULT, scope, nowMs,
      });
      pending = { withdrawal, context: String(context), relayFee, validUntil: quote.valid_until_block, deadlineMs };
      log(`request: ${WITHDRAWN} withdrawn to W ${a.W}, relay_fee ${relayFee} to F (quote valid to block ${quote.valid_until_block}), deadline_ms ${deadlineMs}`);
      return JSON.stringify(input, (_, x) => (typeof x === "bigint" ? x.toString() : x));
    };

    // the page: built with vite from t02-page/, served on 127.0.0.1 with SIGN_HOST's worker and the pinned setup files
    const req = createRequire(path.join(ROOT, "packages/signpage/package.json"));
    const vite = await import(pathToFileURL(req.resolve("vite")).href);
    const outDir = `${stateFile}.page`;
    await vite.build({ root: path.join(HERE, "t02-page"), configFile: false, logLevel: "warn", build: { outDir, emptyOutDir: true, target: "es2022", modulePreload: false } });
    const { ZK_SETUP_FILES } = await import(pathToFileURL(path.join(ROOT, "packages/kit/src/zk/setup-files.ts")).href);
    const files: Record<string, string> = { "/prover-worker.js": path.join(ROOT, "packages/signpage/public/prover-worker.js") };
    for (const name of ["withdraw.wasm", "withdraw.zkey", "commitment.wasm", "commitment.zkey"]) files[`/assets/zk/${ZK_SETUP_FILES[name].sha256}.${name.split(".").pop()}`] = path.join(ROOT, "packages/kit/zk", name);
    const http = await import("node:http");
    const fs = await import("node:fs");
    let resolveResult: (r: any) => void = () => {};
    const result = new Promise<any>((ok) => (resolveResult = ok));
    const server = http.createServer(async (rq, rs) => {
      try {
        const url = new URL(rq.url ?? "/", "http://127.0.0.1");
        const refused = pageRefusal(rq.headers.host, port, url.pathname, token);
        if (refused !== null) {
          log(`page: refused a request (${refused})`);
          rs.writeHead(403).end();
          return;
        }
        if (url.pathname === `/${token}/input.json`) {
          const body = await makeInput();
          rs.writeHead(200, { "content-type": TYPES[".json"]!, "cache-control": "no-store" }).end(body);
          return;
        }
        if (url.pathname === `/${token}/result` && rq.method === "POST") {
          const chunks: Buffer[] = [];
          for await (const c of rq) chunks.push(c as Buffer);
          rs.writeHead(204).end();
          resolveResult(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          return;
        }
        const file = files[url.pathname] ?? path.join(outDir, url.pathname === "/" ? "index.html" : path.normalize(url.pathname));
        if (!path.resolve(file).startsWith(outDir) && !Object.values(files).includes(file)) throw new Error("outside");
        const buf = fs.readFileSync(file);
        rs.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(buf);
      } catch {
        rs.writeHead(404).end();
      }
    });
    // the input holds the note's spend secrets: its path and the result's carry this run's random token, and every
    // request must name this server by its loopback host and port (a page elsewhere cannot rebind a name to it)
    const token = randomBytes(16).toString("hex");
    let port = 0;
    await new Promise<void>((ok) => server.listen(Number(v["--port"] ?? 0), "127.0.0.1", ok));
    port = (server.address() as { port: number }).port;
    // the token goes in the fragment, which the browser never sends; this prints a local address, not a secret
    const pageUrl = `http://127.0.0.1:${port}/#${token}`;
    writeFileSync(`${stateFile}.page-url`, pageUrl + "\n", { mode: 0o600 });
    log(`page: the address to open is in ${path.basename(stateFile)}.page-url (mode 600)`);
    const r = await Promise.race([result, sleep(RESULT_BOUND_MS).then(() => ({ error: "no result in 15 min" }))]);
    server.close();
    if (r.error) throw new Error(`browser: ${r.error}`);
    const p = pending as { withdrawal: unknown; context: string; relayFee: bigint; validUntil: unknown; deadlineMs: number } | null;
    if (p === null) throw new Error("browser: a result with no input asked");
    const vkey = JSON.parse(readFileSync(path.join(ROOT, "packages/kit/zk/withdraw.vkey"), "utf8"));
    if (!(await k.snarkjs.groth16.verify(vkey, r.publicSignals, r.proof))) throw new Error("browser: the proof does not verify against withdraw.vkey");
    if (r.publicSignals[7] !== p.context) throw new Error("browser: the proof's context is not the request's");
    const request = { withdrawal: p.withdrawal, proof: k.vaultProof(r.proof), public_signals: r.publicSignals, token: TOKEN };
    w.browser = { userAgent: r.userAgent, brands: r.brands, platform: r.platform, hardwareConcurrency: r.hardwareConcurrency, deviceMemory: r.deviceMemory, loadMs: r.loadMs, proveMs: r.proveMs, pageProveMs: r.pageProveMs, totalMs: r.totalMs, violations: r.violations };
    w.request = { relay_fee: String(p.relayFee), valid_until_block: p.validUntil, deadline_ms: p.deadlineMs, body_bytes: JSON.stringify(request).length, R_near_before: String(await nearOf(R.id)) };
    save();
    log(`browser: ${r.userAgent}; load ${r.loadMs} ms, prove ${r.proveMs} ms (worker fullProve), ${r.pageProveMs} ms (page), verified against withdraw.vkey`);
    const t0 = Date.now();
    // a harness retry (named in the record): a 503 that sent nothing (no send record) is asked again, up to 5 more times
    let ans = await carryWithdraw(request, deps);
    let retries = 0;
    for (let i = 1; ans.status === 503 && i < 6 && store.get(nf) === null; i++, retries++) {
      log(`carryWithdraw: ${ans.status} ${json(ans.body)}; again in ${3 * i} s`);
      await sleep(3000 * i);
      ans = await carryWithdraw(request, deps);
    }
    log(`carryWithdraw: ${ans.status} ${json(ans.body)} in ${Date.now() - t0} ms`);
    if (ans.status !== 200 || !("tx_hash" in ans.body)) throw new Error(`carryWithdraw answered ${ans.status} ${json(ans.body)}`);
    w.carry = { tx_hash: ans.body.tx_hash, carry_ms: Date.now() - t0, answered_at: Date.now(), retries };
    save();
  }

  if (w.outcome === undefined) {
    const until = Date.now() + OUTCOME_BOUND_MS;
    for (let round = 1; ; round++) {
      await outcomeRound(deps);
      const rec = store.get(nf);
      const at = Date.now() - (w.carry?.answered_at ?? NaN);
      if (rec && rec !== "unreadable" && rec.outcome === "succeeded" && w.carry.succeeded_ms === undefined) w.carry.succeeded_ms = at;
      if (rec && rec !== "unreadable" && rec.settle?.done === true && w.carry.settled_ms === undefined) w.carry.settled_ms = at;
      save();
      const where = rec === null ? "no send record" : rec === "unreadable" ? "unreadable" : `withdraw ${rec.outcome}${rec.error ? ` (${String(rec.error).slice(0, 200)})` : ""}, settle ${rec.settle ? `${rec.settle.tx?.tx_hash ?? "by another"} done ${rec.settle.done}` : "none"}`;
      log(`outcome round ${round}: ${where}`);
      if (rec === null || rec === "unreadable" || rec.outcome === "failed") throw new Error(`outcome: ${where}`);
      if (rec.outcome === "succeeded" && rec.settle?.done === true) {
        if (rec.settle.tx === null) throw new Error("outcome: settled by another account");
        w.outcome = { withdraw: { method: "withdraw (R, the helper's carryWithdraw)", hash: rec.tx_hash, signer: R.id }, settle: { method: "settle (R, the helper's outcomeRound)", hash: rec.settle.tx.tx_hash, signer: R.id } };
        save();
        break;
      }
      if (Date.now() >= until) throw new Error(`outcome: stopped after ${OUTCOME_BOUND_MS / 1000} s at: ${where}; run again to resume`);
      await sleep(ROUND_MS);
    }
  }
  store.close();
  nonceStore.close();

  for (const t of [w.outcome.withdraw, w.outcome.settle]) {
    const problems = await readBoth(t.hash, t.signer);
    log(`${t.method} ${t.hash} ${problems.length ? `PROBLEMS ${problems.join("; ")}` : "read back FINAL on both operators, every receipt a success"}`);
    if (problems.length) throw new Error(`${t.hash} did not read back as a success`);
  }
  const s = await synced(k, VAULT);
  const row = s.spends.find((x: { nullifierHash: bigint }) => x.nullifierHash === nf);
  if (!row) throw new Error("no spends row for the note's nullifier");
  w.row = { index: row.index, status: row.status, recipient: row.recipient, fee: String(row.fee), payer: row.payer, withdrawn: String(row.withdrawn), new_leaf_index: String(row.newLeafIndex) };
  const change = s.leaves[Number(row.newLeafIndex)];
  const want = noteCommitment(note.value - WITHDRAWN, label, CH.precommitment);
  w.change = { value: String(note.value - WITHDRAWN), leaf_index: String(row.newLeafIndex), matches: change === want };
  w.after = await balances();
  save();
  log(`spends row #${row.index}: ${json(w.row)}; change leaf ${w.change.leaf_index} ${w.change.matches ? "is" : "is NOT"} this seed's change note of ${w.change.value}`);
  log(`after: ${json(w.after)}`);
  process.exit(0);
}

// ---- record: the run record (public values only) and the money record ----

export const RUN_RECORD = "contracts/vault/deployments/testnet-t02-run.json";
export const MONEY_RECORD = `scripts/live-checks/${CARD}.md`;
export const LIVE_CHECK = `scripts/live-checks/${CARD}.mjs`;

/** A host, user or local path in committed text (as testnet-withdraw-send.ts's localProblems). */
export function localProblems(text: string, names: string[]): string[] {
  const res = [/\/(home|Users|private|tmp|var|root|opt)\/|[A-Za-z]:\\/, ...names.filter((n) => n.length >= 4).map((n) => new RegExp(`(^|[^A-Za-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9]|$)`, "i"))];
  return text.split("\n").filter((l) => res.some((re) => re.test(l))).map((l) => `a host, user or local path: ${l.slice(0, 120)}`);
}

async function record(argv: string[]) {
  const v = flags(argv, ["--state", "--setup"]);
  need(v, ["--state", "--setup"]);
  const VAULT = testnetVault();
  const parent = JSON.parse(readFileSync(DEPLOYMENT, "utf8")).parent;
  const st = loadState(path.resolve(v["--state"]!), repoRoots());
  const setupTxs: { method: string; hash: string; signer: string }[] = JSON.parse(readFileSync(path.resolve(v["--setup"]!), "utf8")).txs;
  const d = st.steps.deposit;
  const w = st.steps.withdraw;
  if (d?.done !== true || w?.outcome === undefined || w.change?.matches !== true) throw new Error("record: the run has not landed both legs");
  const a = accountsOf(runOf(st.seed), parent);
  const wallet = (p: string) => import(pathToFileURL(path.join(ROOT, "packages/wallet/src", p)).href);
  const { entropyToWords, wordsToSeed64 } = await wallet("derive/index.ts");
  const { noteSecrets, noteCommitment } = await wallet("notes/secrets.ts");
  const seed64: Uint8Array = wordsToSeed64(entropyToWords(entropyOf(st.seed)));
  const scope = BigInt(d.s);
  const label = BigInt(d.leaf.label);
  const N = noteSecrets(seed64, { kind: "deposit", s: scope, i: d.i });
  const CH = noteSecrets(seed64, { kind: "change", l: label, j: 0 });
  seed64.fill(0);
  const run = {
    card: CARD, network: "testnet", vault: VAULT, asset: TOKEN,
    accounts: { parent, U: d.U, G: a.G, R: a.R, F: a.F, W: a.W },
    deposit: { value: d.leaf.value, precommitment: d.precommitment, label: d.leaf.label, leaf_index: d.leaf.leaf_index, commitment: d.leaf.commitment },
    withdraw: { withdrawn: String(WITHDRAWN), relay_fee: w.request.relay_fee, nullifier_hash: String(N.nullifierHash), change_value: w.change.value, change_leaf_index: w.change.leaf_index, change_commitment: String(noteCommitment(BigInt(w.change.value), label, CH.precommitment)) },
    browser: { name: "Chrome desktop", brands: w.browser.brands, platform: w.browser.platform, hardware_concurrency: w.browser.hardwareConcurrency, device_memory_gb: w.browser.deviceMemory, load_ms: w.browser.loadMs, prove_ms: w.browser.proveMs, page_prove_ms: w.browser.pageProveMs },
  };
  const txs = [
    ...setupTxs.map((t) => ({ ...t, step: "setup" })),
    ...d.txs.map((t: { method: string; hash: string; signer: string }) => ({ ...t, step: "deposit" })),
    { ...w.outcome.withdraw, step: "withdraw" },
    { ...w.outcome.settle, step: "settle" },
  ];
  const b0 = d.before;
  const b1 = d.after;
  const c0 = w.before;
  const c1 = w.after;
  const fee = BigInt(w.request.relay_fee);
  const prose = [
    `The run: contracts/vault/scripts/testnet-t02.ts on NEAR testnet, the keyless vault ${VAULT} on the team's test USDC ${TOKEN}.`,
    `Deposit leg (by script, the wallet's own modules): the note store's planDeposit (fake-indexeddb), U = U_{s,i} (s the vault's scope, i ${d.i}) from this run's 12 words, U's ft_transfer_call signed as a NEP-366 DelegateAction (deposit/delegate.ts) and followed by bindDeposit (deposit/bind.ts) to the deposits pages on FastNEAR and dRPC; /v1/bind served by the helper's own carryDeposit (apps/helper/src/bind/send.ts) in the run's process with G as the gas account, because the deployed helper mounts no /v1/bind. Stand-ins on this leg: the token watch answered a caught-up, open token; its pause history (pausedAt) was a read of the token's ft_balance_of at the asked block; R4's margin K was 20, the sandbox carry's, as no release pins one yet. bindDeposit answered deposited in ${st.steps.deposit.bind_ms} ms; the device's 10 s send timeout (SEND_TIMEOUT_MS) ran out before the carry answered, and bind confirmed the note from the pages.`,
    `Withdraw leg: the proof made in Chrome desktop (Google Chrome ${w.browser.brands?.find((x: { brand: string }) => x.brand === "Google Chrome")?.version ?? "?"}, ${w.browser.platform}, ${w.browser.hardwareConcurrency} threads reported) by the kit's prover (packages/kit/src/prover/client.ts startProver, the worker SIGN_HOST serves, packages/signpage/public/prover-worker.js, and the pinned setup files) on a page served from 127.0.0.1 (contracts/vault/scripts/t02-page/); the input by the kit's vaultWithdrawRequest and vaultWithdrawInput on trees read by vaultSync on two operators, the change and refund secrets the wallet's (noteSecrets change and refund, j 0); the proof checked against withdraw.vkey, then carried by the helper's own carryWithdraw and outcomeRound (apps/helper/src/withdraw/send.ts) in the run's process with R's key, because the deployed helper answers every testnet withdrawal token_halted (no testnet token watch). Stand-ins on this leg: the token watch answered a caught-up, open token; a 503 that sent nothing was asked again up to 5 more times (asked again ${w.carry.retries ?? 0} time(s) in this run); the page stands in for SIGN_HOST's withdraw form, which has no hand-off yet, and set no CSP (SIGN_HOST's policy was not applied).`,
    `Accounts: P ${parent} (pays NEAR for setup), D 4b6c00c36c05f3bc849f158da640409a0d4b395354ba07fdcd94f9316234599a (T04's depositor, sends U the USDC), U ${d.U}, G ${a.G} (bind gas account), R ${a.R} (withdrawal relayer), F ${a.F} (fee recipient, no key), W ${a.W} (recipient, no key).`,
    `Every Tx above read back FINAL on https://test.rpc.fastnear.com and https://near-testnet.drpc.org, every receipt a success.`,
    `Deposit: the deposits page holds P ${d.precommitment} by U with ${d.leaf.value}, label ${d.leaf.label}, leaf ${d.leaf.leaf_index}.`,
    `Withdrawal: ${WITHDRAWN} withdrawn to W, relay_fee ${fee} to F (the testnet quote, valid to block ${w.request.valid_until_block}), deadline_ms ${w.request.deadline_ms}; spends row #${w.row.index}: ${w.row.status}, payer R; the change note of ${w.change.value} at leaf ${w.change.leaf_index} is this seed's.`,
    `Balances before the deposit (${b0.at}): U USDC ${b0.U_usdc}, vault USDC ${b0.vault_usdc}, U NEAR ${b0.U_near}, G NEAR ${b0.G_near}, totals ${JSON.stringify(b0.totals)}.`,
    `After the deposit (${b1.at}): U USDC ${b1.U_usdc}, vault USDC ${b1.vault_usdc}, U NEAR ${b1.U_near}, G NEAR ${b1.G_near}, totals ${JSON.stringify(b1.totals)}.`,
    `Before the withdrawal (${c0.at}): W USDC ${c0.W_usdc}, F USDC ${c0.F_usdc}, vault USDC ${c0.vault_usdc}, R NEAR ${c0.R_near}, totals ${JSON.stringify(c0.totals)}.`,
    `After the withdrawal (${c1.at}): W USDC ${c1.W_usdc} (= ${WITHDRAWN} - ${fee}), F USDC ${c1.F_usdc}, vault USDC ${c1.vault_usdc} (= the change note), R NEAR ${c1.R_near}, totals ${JSON.stringify(c1.totals)} (deposited - spent + returned = ${BigInt(c1.totals.deposited) - BigInt(c1.totals.spent) + BigInt(c1.totals.returned)} = the vault USDC).`,
    `Prover, Chrome desktop: setup files loaded ${w.browser.loadMs} ms (from 127.0.0.1, not a download), fullProve in the worker ${w.browser.proveMs} ms (${w.browser.pageProveMs} ms seen by the page); request body ${w.request.body_bytes} bytes. The iPhone Safari and Android Chrome legs are not run yet.`,
    `Times (the run's clock): carryWithdraw ${w.carry.carry_ms} ms to its 200; from the 200 to the send record reading succeeded ${w.carry.succeeded_ms} ms, to the settle done ${w.carry.settled_ms} ms (outcomeRound every 10 s).`,
  ];
  const text = [`CARD ${CARD} / live: PASS`, "Money path: yes", ...txs.map((t) => `Tx: near-testnet ${t.hash} ${t.signer}`), "", ...prose, ""].join("\n");
  const os = await import("node:os");
  const lp = localProblems(text + JSON.stringify(run), [os.hostname(), os.hostname().split(".")[0]!, os.userInfo().username]);
  if (lp.length) throw new Error(`record: ${lp.join("; ")}`);
  writeFileSync(path.join(ROOT, RUN_RECORD), JSON.stringify(run, null, 2) + "\n");
  writeFileSync(path.join(ROOT, MONEY_RECORD), text);
  console.log(text);
  log(`written ${RUN_RECORD} and ${MONEY_RECORD}; next: node ${LIVE_CHECK}`);
}

const [cmd, ...rest] = process.argv.slice(2);
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const run = cmd === "ids" ? async () => ids(rest) : cmd === "setup" ? () => setup(rest) : cmd === "deposit" ? () => deposit(rest) : cmd === "withdraw" ? () => withdraw(rest) : cmd === "record" ? () => record(rest) : null;
  if (!run) {
    console.error("usage: testnet-t02.ts ids|setup|deposit|withdraw|record --state <path> ...");
    process.exit(2);
  }
  run().catch((e) => {
    console.error(`t02: ${e?.stack ?? e}`);
    process.exit(1);
  });
}
