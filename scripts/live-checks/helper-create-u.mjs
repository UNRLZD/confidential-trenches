#!/usr/bin/env node
// Live check of card helper-create-u: the helper creates a deposit's one-time id only after 1Click delivered to it
// (apps/helper/src/bind/create.ts), on the status answers its proxy carries (server.ts, the oneclick/v0/status route;
// bind/env.ts delivered). With no money: the one recorded 1Click delivery of NEAR USDC to a 64-hex id (deposit address
// a998c658…, recipient 386aeb32…, the G1 arm-swap fund deposit; apps/helper/src/bind/fixtures/oneclick-status.json)
// goes through the deployed proxy, and nothing may reach its recipient. That recipient was deleted after its run and
// holds no USDC, so the gate answers no_delivery. Before anything is sent, the check reads that it holds under
// MIN_DEPOSIT on both providers, and it stops (exit 2) when it does not, so a run can never pay for a creation.
//   1. before: at one block, the same hash on FastNEAR and dRPC (two operators, scripts/ci/near-rpc-operators.mjs), the
//      recipient's account (absent, or its NEAR), its USDC and, once one is pinned (BIND_RELAYER_MAINNET below), every
//      key nonce of the mainnet gas account;
//   2. POST /v1/proxy/oneclick/v0/status?depositAddress=… with Origin APP_HOST: 200, SUCCESS, naming that address,
//      recipient and USDC;
//   3. after at least WAIT_MS, the same reads: the recipient as before (a Transfer would create it) and every nonce as
//      before.
// It counts only on a helper that can create: before anything, it reads the deployed commit (GET /v1/health) and that
// commit's own files in this checkout (the hook and createOnDelivery's caller), and whether mainnet deposits are carried
// (POST /v1/bind with a delegate on mainnet USDC that decodes and is refused before any read: token_not_accepted means
// not carried), and it needs the mainnet gas account pinned below. Short of any of the three it stops (exit 2), so it
// joins scripts/ci/helper-live-checks.mjs only once mainnet deposits are carried (card vault-mainnet-deploy).
// The creation itself lands with the first real mainnet deposit, and its record goes in helper-create-u.md.
//   node scripts/live-checks/helper-create-u.mjs [--base <url>] [--record <file>]   PASS exit 0, FAIL exit 1, error exit 2
import "../net-window.mjs";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

export const BASE = "https://api.confidential.unrealized.trade";
export const APP = "https://confidential.unrealized.trade";
export const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"; // gitleaks:allow (a public account id)
export const ADDRESS = "a998c6585100ca4bccbc0e0bcceb9abd66e59666e87bd03b1d83bb9544f7ce2f";
export const RECIPIENT = "386aeb3286b4a6548d1ed2a84557073858cf1b696310359c5100cb06ed233ef8";
/** The vault's MIN_DEPOSIT (packages/kit/src/vault/shapes.ts VAULT_CONSTANTS): 1 USDC. */
export const MIN_DEPOSIT = 1_000_000n;
/**
 * The mainnet deposit gas account (the host's BIND_RELAYER_MAINNET). None exists yet: mainnet deposits start with the
 * mainnet vault. Pin it here when it does; until then the nonce leg is shown, not counted.
 */
export const BIND_RELAYER_MAINNET = null;
/** Two operators: FastNEAR and dRPC. */
export const RPCS = ["https://free.rpc.fastnear.com", "https://near.drpc.org"];
const OPERATOR = { "free.rpc.fastnear.com": "fastnear", "archival-rpc.mainnet.fastnear.com": "fastnear", "archival-rpc.testnet.fastnear.com": "fastnear", "archival-rpc.testnet.near.org": "fastnear", "near.drpc.org": "drpc" };
/** Between the proxy's answer and the after reads: the hook runs at once, a Transfer is final within a few seconds. */
export const WAIT_MS = 15_000;
const SHA = /^[0-9a-f]{40}$/;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function rpc(url, method, params, fetchFn) {
  const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "c", method, params }), signal: AbortSignal.timeout(10_000) });
  const j = await r.json();
  if (j.error) return { error: j.error.cause?.name ?? j.error.name ?? "error" };
  return { result: j.result };
}

/** At one block on both providers: the block, the recipient, its USDC and the gas account's nonces. */
export async function readState(recipient, relayer, fetchFn = fetch, urls = RPCS) {
  const finals = await Promise.all(urls.map((u) => rpc(u, "block", { finality: "final" }, fetchFn)));
  const height = Math.min(...finals.map((f) => f.result.header.height));
  return Promise.all(
    urls.map(async (url) => {
      const b = await rpc(url, "block", { block_id: height }, fetchFn);
      const acct = await rpc(url, "query", { request_type: "view_account", account_id: recipient, block_id: height }, fetchFn);
      const bal = await rpc(url, "query", { request_type: "call_function", account_id: USDC, method_name: "ft_balance_of", args_base64: Buffer.from(JSON.stringify({ account_id: recipient })).toString("base64"), block_id: height }, fetchFn);
      const keys = relayer === null ? null : await rpc(url, "query", { request_type: "view_access_key_list", account_id: relayer, block_id: height }, fetchFn);
      return {
        url,
        height,
        hash: b.result?.header?.hash ?? null,
        recipient: acct.error ? { absent: acct.error === "UNKNOWN_ACCOUNT", error: acct.error } : { amount: acct.result.amount },
        usdc: bal.result ? JSON.parse(Buffer.from(bal.result.result).toString("utf8")) : null,
        nonces: keys === null ? null : keys.error ? { error: keys.error } : Object.fromEntries(keys.result.keys.map((k) => [k.public_key, String(k.access_key.nonce)])),
      };
    }),
  );
}

/** Whether `commit`'s own files in this checkout hold this card's code: the route's hook and the status answer's reader. */
export function commitHasCode(commit) {
  if (!SHA.test(commit ?? "")) return false;
  try {
    const show = (f) => execFileSync("git", ["show", `${commit}:${f}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return show("apps/helper/src/server.ts").includes("bind.delivered?.(body)") && show("apps/helper/src/bind/create.ts").includes("export async function onStatusAnswer");
  } catch {
    return false;
  }
}

/** A SignedDelegateAction on mainnet USDC that decodes (bind/checks.ts decodeSignedDelegate) with no action and a zero
 *  signature: the carry refuses it before any read, and an uncarried network answers token_not_accepted. */
export function bindProbe() {
  const str = (t) => {
    const b = Buffer.from(t, "utf8");
    const n = Buffer.alloc(4);
    n.writeUInt32LE(b.length);
    return Buffer.concat([n, b]);
  };
  const bytes = Buffer.concat([str("probe.near"), str(USDC), Buffer.alloc(4), Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(33), Buffer.alloc(65)]);
  return JSON.stringify({ signed_delegate: bytes.toString("base64") });
}

/** What the check needs of the deployed helper before it counts. */
export async function preflight(base = BASE, fetchFn = fetch, hasCode = commitHasCode) {
  const root = base.replace(/\/$/, "");
  const h = await fetchFn(`${root}/v1/health`, { headers: { origin: APP }, redirect: "manual" });
  const commit = (await h.json().catch(() => ({})))?.commit ?? null;
  const b = await fetchFn(`${root}/v1/bind`, { method: "POST", redirect: "manual", headers: { origin: APP, "content-type": "application/json" }, body: bindProbe() });
  const text = (await b.text()).slice(0, 1024);
  let code = null;
  try {
    code = JSON.parse(text)?.error?.code ?? null;
  } catch {
    code = null;
  }
  return { readAt: new Date().toISOString(), commit, has_code: hasCode(commit), bind: { status: b.status, code }, relayer: BIND_RELAYER_MAINNET };
}

/** Why the check cannot count on this helper, or null when it can. */
export function refusal(p) {
  const why = [];
  if (!p.has_code) why.push(`the deployed commit ${p.commit} does not hold this card's code`);
  // carried: the carry refused it on its own terms (bad_shape at check 1, or relayer_low / token_halted before it);
  // token_not_accepted is no carried network, upstream a network that did not start
  if (typeof p.bind.code !== "string" || ["token_not_accepted", "upstream"].includes(p.bind.code)) why.push(`mainnet deposits are not carried (POST /v1/bind: ${p.bind.status} ${p.bind.code})`);
  if (p.relayer === null) why.push("no mainnet deposit gas account is pinned (BIND_RELAYER_MAINNET)");
  return why.length === 0 ? null : why.join("; ");
}

/** One run: before, the proxy's answer, after. */
export async function read(base = BASE, fetchFn = fetch, wait = WAIT_MS) {
  const pre = await preflight(base, fetchFn);
  const no = refusal(pre);
  if (no !== null) throw new Error(`not counted on this helper: ${no}`);
  const before = await readState(RECIPIENT, BIND_RELAYER_MAINNET, fetchFn);
  for (const s of before) if (!(typeof s.usdc === "string" && /^[0-9]+$/.test(s.usdc) && BigInt(s.usdc) < MIN_DEPOSIT)) throw new Error(`${s.url}: the recipient's USDC reads ${s.usdc}, not under MIN_DEPOSIT: a run could pay for a creation, so nothing is sent`);
  const r = await fetchFn(`${base.replace(/\/$/, "")}/v1/proxy/oneclick/v0/status?depositAddress=${ADDRESS}`, { method: "POST", redirect: "manual", headers: { origin: APP, "content-type": "application/json" }, body: "" });
  const proxy = { readAt: new Date().toISOString(), status: r.status, commit: r.headers.get("x-helper-commit"), body: dropSignature((await r.text()).slice(0, 65_536)) };
  await sleep(wait);
  const after = await readState(RECIPIENT, BIND_RELAYER_MAINNET, fetchFn);
  return { base, recipient: RECIPIENT, relayer: BIND_RELAYER_MAINNET, before: { readAt: proxy.readAt, reads: before }, proxy, after: { readAt: new Date().toISOString(), reads: after } };
}

/** 1Click's quote signature has a NEAR secret key's shape for gitleaks (.gitleaks.toml); the check never reads it. */
export const dropSignature = (text) => text.replace(/"signature":"ed25519:[1-9A-HJ-NP-Za-km-z]+"/g, '"signature":"(dropped)"');

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The check on one recorded run. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(run.recipient === RECIPIENT, `the recipient is the recorded delivery's (${run.recipient})`);
  // the proxy carried 1Click's answer for the recorded delivery
  const p = run.proxy;
  let body = null;
  try {
    body = p ? JSON.parse(p.body) : null;
  } catch {
    body = null;
  }
  say(p?.status === 200, `proxy: ${p ? p.status : "no read"} (want 200)`);
  say(typeof p?.commit === "string" && SHA.test(p.commit), `proxy: X-Helper-Commit ${p?.commit}`);
  const req = body?.quoteResponse?.quoteRequest;
  say(body?.status === "SUCCESS" && body?.quoteResponse?.quote?.depositAddress === ADDRESS && req?.recipient === RECIPIENT && req?.destinationAsset === `nep141:${USDC}`, `proxy: SUCCESS for ${ADDRESS.slice(0, 8)}… to ${RECIPIENT.slice(0, 8)}… on USDC (${body?.status ?? "no body"})`);
  for (const [name, side] of [["before", run.before], ["after", run.after]]) {
    const reads = side?.reads ?? [];
    const ops = new Set(reads.map((s) => OPERATOR[new URL(s.url).host] ?? s.url));
    say(reads.length === 2 && ops.size === 2, `${name}: two operators (${[...ops].join(", ")})`);
    say(reads.length === 2 && reads[0].height === reads[1].height && reads[0].hash !== null && reads[0].hash === reads[1].hash, `${name}: one block on both (${reads.map((s) => `${s.height} ${s.hash}`).join(" / ")})`);
    say(reads.length === 2 && same(reads[0].recipient, reads[1].recipient) && same(reads[0].nonces, reads[1].nonces), `${name}: both providers read the same`);
  }
  const b = run.before?.reads?.[0];
  const a = run.after?.reads?.[0];
  say(b !== undefined && typeof b.usdc === "string" && BigInt(b.usdc) < MIN_DEPOSIT, `before: the recipient holds ${b?.usdc} USDC base units, under MIN_DEPOSIT (no run pays for a creation)`);
  say(a !== undefined && b !== undefined && a.height > b.height && Date.parse(run.after.readAt) - Date.parse(p?.readAt ?? run.before.readAt) >= WAIT_MS, `after: read ${a && b ? a.height - b.height : "?"} blocks and ${p && run.after ? (Date.parse(run.after.readAt) - Date.parse(p.readAt)) / 1000 : "?"} s after`);
  say(a !== undefined && b !== undefined && same(a.recipient, b.recipient), `the recipient as before: ${JSON.stringify(b?.recipient)} -> ${JSON.stringify(a?.recipient)} (a Transfer would create it)`);
  if (run.relayer === null) lines.push(`-- the gas account's nonces: no mainnet deposit gas account yet (BIND_RELAYER_MAINNET), not counted`);
  else say(a !== undefined && b !== undefined && b.nonces !== null && !("error" in b.nonces) && same(a.nonces, b.nonces), `${run.relayer}: every key nonce as before: ${JSON.stringify(b?.nonces)} -> ${JSON.stringify(a?.nonces)}`);
  return { ok: lines.every((l) => !l.startsWith("BAD")), lines };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (k) => {
    const i = args.indexOf(k);
    return i === -1 ? undefined : args[i + 1];
  };
  try {
    const run = await read(opt("--base") ?? BASE);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const r = judge(run);
    for (const l of r.lines) console.log(l);
    console.log(r.ok ? "PASS" : "FAIL");
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
