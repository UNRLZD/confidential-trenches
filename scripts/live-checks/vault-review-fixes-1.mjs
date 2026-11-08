#!/usr/bin/env node
// Live check: every fee account HELPER_HOST quotes can take its fee (card vault-review-fixes-1, review F-1). The vault
// pays the relay fee in the same receipt as the recipient's amount (review A-01: one payout receipt, all or none), so a
// fee account the token refuses would fail every relayed payout whole. The helper holds such a send (503 relayer_low,
// apps/helper/src/withdraw/send.ts check 7b); this check reads the same thing on what is deployed, after each deploy.
// For each network (mainnet USDC, the testnet token) it reads GET /v1/withdraw/fee with Origin APP_HOST:
//   - 200: the answer's fee_recipient, then on that network's two NEAR RPCs of two operators, at one final block both
//     hold (finals at most 30 blocks apart, one hash), the token's storage_balance_of(fee_recipient) and
//     is_blocklisted(fee_recipient), each answered at that block with the same bytes on both. It passes when the
//     balance is set (a NEP-145 balance, not null) and is_blocklisted is exactly false.
//   - 404 not_found: the helper quotes no relayer on that network, so it carries no withdrawal there and has no fee
//     account to check: listed as "na", never a pass on its own (relayer-withdraw-fee is the check that the release's
//     relayer is quoted).
//   - anything else: FAIL.
// At least one network must be quoted. Every RPC read that fails or disagrees is a FAIL.
//   node scripts/live-checks/vault-review-fixes-1.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";

const KEY = "vault-review-fixes-1";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const TOKENS = { mainnet: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", testnet: "bf-usdc-20261101t022248.testnet" }; // gitleaks:allow (public account ids)
export const PAIRS = { mainnet: ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"], testnet: ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"] };
const SPREAD = 30;
const ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const DEC = /^(0|[1-9][0-9]{0,38})$/;

async function rpc(fetchFn, url, method, params) {
  const r = await fetchFn(url, { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "lc", method, params }), signal: AbortSignal.timeout(10_000) });
  const a = await r.json();
  if (a.error !== undefined || a.result === undefined) throw new Error(`${url} ${method}: ${JSON.stringify(a.error ?? "no result").slice(0, 200)}`);
  return a.result;
}

/** One final block both RPCs hold: the lower of the two finals, read by height on both, one hash. */
async function agreed(fetchFn, urls) {
  const finals = await Promise.all(urls.map((u) => rpc(fetchFn, u, "block", { finality: "final" })));
  const hs = finals.map((f) => f.header.height);
  if (Math.abs(hs[0] - hs[1]) > SPREAD) throw new Error(`finals ${hs.join(", ")} more than ${SPREAD} apart`);
  const height = Math.min(...hs);
  const [x, y] = (await Promise.all(urls.map((u) => rpc(fetchFn, u, "block", { block_id: height })))).map((b) => b.header);
  if (x.height !== height || y.height !== height || x.hash !== y.hash) throw new Error(`block ${height}: the RPCs disagree`);
  return { height, hash: x.hash };
}

/** A view at block `b` on both RPCs: answered at `b` on each, the same bytes, JSON. */
async function viewBoth(fetchFn, urls, b, account, method, args) {
  const params = { request_type: "call_function", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64"), block_id: b.height };
  const rs = await Promise.all(urls.map((u) => rpc(fetchFn, u, "query", params)));
  for (const r of rs) if (r.block_height !== b.height || r.block_hash !== b.hash || !Array.isArray(r.result)) throw new Error(`${method}: not answered at block ${b.height}`);
  const [p, q] = rs.map((r) => Buffer.from(r.result));
  if (!p.equals(q)) throw new Error(`${method}: the RPCs' bytes differ`);
  return JSON.parse(p.toString("utf8"));
}

async function quoted(fetchFn, base, token) {
  const r = await fetchFn(`${base.replace(/\/$/, "")}/v1/withdraw/fee?token=${encodeURIComponent(token)}`, { method: "GET", redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" } });
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: r.status, body, text };
}

/** The check: { ok, lines }. `fetchFn` takes both the helper's GETs and the RPCs' POSTs (a recorded run replays both). */
export async function check({ base = BASE, fetchFn = fetch } = {}) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  let checked = 0;
  for (const network of ["mainnet", "testnet"]) {
    const tag = `[${network}]`;
    let q;
    try {
      q = await quoted(fetchFn, base, TOKENS[network]);
    } catch (e) {
      say(false, `${tag} GET /v1/withdraw/fee: ${e.message.slice(0, 200)}`);
      continue;
    }
    if (q.status === 404 && q.body?.error?.code === "not_found") {
      lines.push(`na  ${tag} GET /v1/withdraw/fee answers 404 not_found: the helper quotes no relayer here, so it has no fee account to check`);
      continue;
    }
    if (q.status !== 200 || typeof q.body?.fee_recipient !== "string" || !ACCOUNT.test(q.body.fee_recipient)) {
      say(false, `${tag} GET /v1/withdraw/fee answers ${q.status} ${q.text.slice(0, 120)}: not a quote naming a fee_recipient`);
      continue;
    }
    const fee = q.body.fee_recipient;
    checked++;
    try {
      const b = await agreed(fetchFn, PAIRS[network]);
      const [bal, listed] = await Promise.all([
        viewBoth(fetchFn, PAIRS[network], b, TOKENS[network], "storage_balance_of", { account_id: fee }),
        viewBoth(fetchFn, PAIRS[network], b, TOKENS[network], "is_blocklisted", { account_id: fee }),
      ]);
      const registered = bal !== null && typeof bal === "object" && DEC.test(bal.total ?? "");
      say(registered, `${tag} storage_balance_of(${fee}) on ${TOKENS[network]} at block ${b.height}: ${JSON.stringify(bal)} on both RPCs${registered ? "" : ": not registered, the token refuses its fee"}`);
      say(listed === false, `${tag} is_blocklisted(${fee}) at block ${b.height}: ${JSON.stringify(listed)} on both RPCs${listed === false ? "" : ": the token refuses its fee"}`);
    } catch (e) {
      say(false, `${tag} ${fee} on ${TOKENS[network]}: ${e.message.slice(0, 200)}`);
    }
  }
  if (checked === 0) say(false, "no network quoted a relayer: no fee account read");
  return { ok: lines.every((l) => !l.startsWith("BAD")), lines };
}

/**
 * A block answer as recorded: its header's height and hash only, the two fields the check reads. A whole block carries
 * its chunks' and approvals' ed25519 signatures, which have a NEAR secret key's shape (.gitleaks.toml), and none is read.
 */
export function recordedText(request, text) {
  if (request?.method !== "block") return text;
  try {
    const j = JSON.parse(text);
    if (j.result?.header === undefined) return text;
    return JSON.stringify({ ...j, result: { header: { height: j.result.header.height, hash: j.result.header.hash } } });
  } catch {
    return text;
  }
}

/** A fetch that keeps every answer it passes on: { url, method, request, status, text } (the replay's record). */
export function recording(fetchFn = fetch) {
  const answers = [];
  const f = async (url, init) => {
    const r = await fetchFn(url, init);
    const text = await r.text();
    const request = init.method === "POST" ? JSON.parse(init.body) : null;
    // a GET's token apart from its url, as "asked" (relayer-withdraw-fee's record does the same): "token=<id>" or a
    // "token" key beside the id reads as a key to the secret scan's generic rule
    const u = new URL(url);
    const asked = init.method === "GET" ? u.searchParams.get("token") : null;
    answers.push({ url: asked === null ? url : `${u.origin}${u.pathname}`, asked, method: init.method, request, status: r.status, text: recordedText(request, text) });
    return new Response(text, { status: r.status, headers: r.headers });
  };
  return { fetchFn: f, answers };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const rec = recording();
    const base = opt("--base", BASE);
    const { ok, lines } = await check({ base, fetchFn: rec.fetchFn });
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify({ base, readAt: new Date().toISOString(), answers: rec.answers }, null, 1)}\n`);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
