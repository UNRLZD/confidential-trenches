#!/usr/bin/env node
// Live check of card relayer-near-trade: HELPER_HOST, at the deployed commit, carries POST /v1/bind's trade kind (a
// fresh NEAR wallet W's Rhea classic buy or sell, apps/helper/src/bind/trade.ts) on every network it carries deposits
// for, and refuses a W the vault never paid before anything is spent. It reads GET /v1/health with Origin APP_HOST (200,
// X-Helper-Commit the commit asked for, the `bind` networks), then, for each carried network, POSTs a trade for a W made
// fresh for this run (64 random hex: no account, no payout) with no delegate: the creation path reads W absent, then no
// vault payout to W, and answers 409 no_payout with no transaction. A helper before this card answers 400 bad_shape (the
// body is not a deposit). Nothing is signed and nothing is sent: the probe holds no delegate, and a W no payout reached
// is never created (trade.ts createW). Then two carry probes per network for another W, made from a key made for this
// run (W is the key's own implicit id, which has no account): one storage_deposit delegate signed by that key, whose
// sender has no account (400 no_account), and the same delegate with one signature byte flipped (400 bad_signature).
// Each is checked in full before anything is sent, its max_block_height is 1 (the chain refuses it as expired), and the
// key is never kept. It moves no money.
// After: helper --commit {commit}
//   node scripts/live-checks/relayer-near-trade.mjs --commit <sha> [--base <url>]   PASS exit 0, FAIL exit 1, error exit 2
import "../net-window.mjs";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { writeFileSync } from "node:fs";

export const KEY = "relayer-near-trade";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
const SHA = /^[0-9a-f]{40}$/;
const IMPLICIT = /^[0-9a-f]{64}$/;
/** A Rhea classic buy per network, as the kit quotes one (packages/kit/src/near/rhea.ts): USDC in, through wNEAR. */
export const PROBE_TRADES = {
  mainnet: {
    side: "buy",
    token: "token.rhealab.near",
    amount_in: "5000000",
    slippage_bps: 100,
    venue_out: "128671138553236071588",
    hops: [
      { pool: 4512, token_in: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", token_out: "wrap.near" }, // gitleaks:allow (a public account id)
      { pool: 6458, token_in: "wrap.near", token_out: "token.rhealab.near" },
    ],
  },
  testnet: {
    side: "buy",
    token: "wrap.testnet",
    amount_in: "1000000",
    slippage_bps: 100,
    venue_out: "1",
    hops: [{ pool: 0, token_in: "bf-usdc-20261101t022248.testnet", token_out: "wrap.testnet" }], // gitleaks:allow (a public account id)
  },
};

/** The trade body for `wallet` on `network`: no delegate, so the helper's creation path runs, and only its reads. */
export const probeBody = (network, wallet) => JSON.stringify({ trade: { network, wallet, ...PROBE_TRADES[network] }, signed_delegates: [] });

const json = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

/** NEP-366's signing prefix, 2^30 + 366 (the kit's and the helper's checks.ts NEP366_PREFIX). */
const NEP366_PREFIX = 2 ** 30 + 366;
const le = (v, n) => {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = Number((BigInt(v) >> BigInt(8 * i)) & 0xffn);
  return b;
};
const str = (x) => Buffer.concat([le(Buffer.byteLength(x), 4), Buffer.from(x)]);

/**
 * A SignedDelegateAction (borsh, as nearcore's DelegateAction): W, made from a fresh ed25519 key, registers itself on
 * `token` with `deposit` yocto; max_block_height 1. With `flip`, one byte of the signature is flipped.
 */
export function carryProbe(token, deposit, flip = false) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const w = pub.toString("hex");
  const args = JSON.stringify({ account_id: w, registration_only: true });
  const action = Buffer.concat([Buffer.from([2]), str("storage_deposit"), str(args), le(30_000_000_000_000n, 8), le(deposit, 16)]);
  const d = Buffer.concat([str(w), str(token), le(1, 4), action, le(1, 8), le(1, 8), Buffer.from([0]), pub]);
  const sig = sign(null, createHash("sha256").update(le(NEP366_PREFIX, 4)).update(d).digest(), privateKey);
  if (flip) sig[0] ^= 1;
  return { wallet: w, delegate: Buffer.concat([d, Buffer.from([0]), sig]).toString("base64") };
}
/** A registration's deposit for the probes: 0.00125 N, the storage minimum of both probe tokens. */
const PROBE_DEPOSIT = 1_250_000_000_000_000_000_000n;
const carryBody = (network, c) => JSON.stringify({ trade: { network, wallet: c.wallet, ...PROBE_TRADES[network] }, signed_delegates: [c.delegate] });

/**
 * One run: health, then per network health lists as carried one trade probe (no delegate) and two carry probes (a
 * signed delegate for an absent W, and one with a flipped signature), each answer kept as read.
 */
export async function read(base = BASE, fetchFn = fetch, commit = "", wallet = randomBytes(32).toString("hex")) {
  const root = base.replace(/\/$/, "");
  const h = await fetchFn(`${root}/v1/health`, { redirect: "manual", headers: { origin: APP }, signal: AbortSignal.timeout(15_000) });
  const healthBody = (await h.text()).slice(0, 4096);
  const health = { status: h.status, commit: h.headers.get("x-helper-commit"), body: healthBody };
  const bind = json(healthBody)?.bind;
  const nets = bind !== null && typeof bind === "object" ? Object.keys(PROBE_TRADES).filter((n) => n in bind) : [];
  const probes = {};
  for (const n of nets) {
    const r = await fetchFn(`${root}/v1/bind`, { method: "POST", redirect: "manual", headers: { origin: APP, "content-type": "application/json" }, body: probeBody(n, wallet), signal: AbortSignal.timeout(30_000) });
    probes[n] = { status: r.status, body: (await r.text()).slice(0, 1024) };
  }
  const carries = {};
  for (const n of nets) {
    carries[n] = {};
    for (const [kind, flip] of [["signed", false], ["flipped", true]]) {
      const c = carryProbe(PROBE_TRADES[n].token, PROBE_DEPOSIT, flip);
      const r = await fetchFn(`${root}/v1/bind`, { method: "POST", redirect: "manual", headers: { origin: APP, "content-type": "application/json" }, body: carryBody(n, c), signal: AbortSignal.timeout(30_000) });
      carries[n][kind] = { wallet: c.wallet, status: r.status, body: (await r.text()).slice(0, 1024) };
    }
  }
  return { base, commit, wallet, readAt: new Date().toISOString(), health, probes, carries };
}

/** The check on one recorded run. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(run.health?.status === 200, `GET /v1/health: ${run.health?.status} (want 200)`);
  say(typeof run.commit === "string" && SHA.test(run.commit) && run.health?.commit === run.commit, `X-Helper-Commit ${run.health?.commit} is the deployed commit ${run.commit || "(no --commit)"}`);
  say(IMPLICIT.test(run.wallet ?? ""), `the probe's W is a 64-hex id made for this run (${run.wallet})`);
  const nets = Object.keys(run.probes ?? {});
  say(nets.length > 0 && nets.every((n) => n in PROBE_TRADES), `trade probes on the carried networks: ${nets.join(", ") || "none (health lists no bind carry)"}`);
  for (const n of nets) {
    const p = run.probes[n];
    const b = json(p.body);
    const code = b?.error?.code;
    say(p.status === 409 && code === "no_payout" && !("tx_hashes" in (b ?? {})) && !("tx_hashes" in (b?.error ?? {})), `${n}: a trade for a W the vault never paid: ${p.status} ${code ?? p.body.slice(0, 80)} (want 409 no_payout, no transaction)`);
  }
  const WANT = { signed: [400, "no_account", "a delegate W signed, W with no account"], flipped: [400, "bad_signature", "the same delegate with a flipped signature"] };
  for (const n of nets) {
    for (const [kind, [status, want, what]] of Object.entries(WANT)) {
      const c = run.carries?.[n]?.[kind];
      const b = json(c?.body ?? "");
      const code = b?.error?.code;
      say(c !== undefined && IMPLICIT.test(c.wallet ?? "") && c.status === status && code === want && !("tx_hashes" in (b ?? {})), `${n}: ${what}: ${c?.status ?? "not read"} ${code ?? c?.body?.slice(0, 80) ?? ""} (want ${status} ${want}, no transaction)`);
    }
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (k) => {
    const i = args.indexOf(k);
    return i === -1 ? undefined : args[i + 1];
  };
  try {
    const commit = opt("--commit");
    if (!SHA.test(commit ?? "")) throw new Error("--commit <the deployed commit's 40-hex sha> is required");
    const run = await read(opt("--base") ?? BASE, fetch, commit);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const r = judge(run);
    for (const l of r.lines) console.log(l);
    console.log(`live-check ${KEY}: ${r.ok ? "PASS" : "FAIL"} (${run.base})`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
