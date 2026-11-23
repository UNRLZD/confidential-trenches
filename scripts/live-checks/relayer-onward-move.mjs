#!/usr/bin/env node
// Live check of card relayer-onward-move: HELPER_HOST, at the deployed commit, carries POST /v1/bind's onward move (a
// fresh NEAR id A's one TOKEN.ft_transfer of its whole USDC to a 1Click deposit address the helper quoted,
// apps/helper/src/bind/onward.ts) and judges it before anything is read or sent. It reads GET /v1/health with Origin
// APP_HOST (200, X-Helper-Commit the commit asked for), then POSTs three onward bodies on NEAR mainnet's USDC (card
// live-checks-read-mainnet-only), each signed by a key made for this run (its implicit id has no account), an
// ft_transfer to a 64-hex address made for this run, 1 yocto, 30 Tgas, max_block_height 1 (the chain refuses it as
// expired whatever a helper did with it):
//   - amount "0": 400 bad_shape, judged from the move's own bytes before its signature and any read. A helper before
//     this card ran the deposit checks on it and answered 400 no_account (its key read first);
//   - amount "1": 400 no_account (the key read on the chain finds no account);
//   - amount "1" with one signature byte flipped: 400 bad_signature;
// none with a tx_hashes field. Nothing is sent and no money moves; the key is never kept.
// After: helper --commit {commit}
//   node scripts/live-checks/relayer-onward-move.mjs --commit <sha> [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { writeFileSync } from "node:fs";

export const KEY = "relayer-onward-move";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
/** Mainnet USDC (Circle's NEAR token, an implicit account id). */
export const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"; // gitleaks:allow (a public account id)
const SHA = /^[0-9a-f]{40}$/;
const IMPLICIT = /^[0-9a-f]{64}$/;
/** NEP-366's signing prefix, 2^30 + 366 (apps/helper/src/bind/checks.ts NEP366_PREFIX). */
const NEP366_PREFIX = 2 ** 30 + 366;

const json = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};
const le = (v, n) => {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = Number((BigInt(v) >> BigInt(8 * i)) % 256n);
  return b;
};
const str = (x) => Buffer.concat([le(Buffer.byteLength(x), 4), Buffer.from(x)]);

/** A key made for this run: its implicit id (no account) and its signer. */
export function freshKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  return { priv: privateKey, pub, id: pub.toString("hex") };
}

/** One onward body: `k`'s id moves `amount` base units of USDC to `to`; nonce 1, max_block_height 1. */
export function onwardBody(k, to, amount, flip = false) {
  const args = JSON.stringify({ receiver_id: to, amount });
  const action = Buffer.concat([Buffer.from([2]), str("ft_transfer"), str(args), le(30_000_000_000_000n, 8), le(1n, 16)]);
  const d = Buffer.concat([str(k.id), str(USDC), le(1, 4), action, le(1, 8), le(1, 8), Buffer.from([0]), k.pub]);
  const sig = sign(null, createHash("sha256").update(le(NEP366_PREFIX, 4)).update(d).digest(), k.priv);
  if (flip) sig[0] = sig[0] === 0 ? 1 : 0;
  return JSON.stringify({ signed_delegate: Buffer.concat([d, Buffer.from([0]), sig]).toString("base64") });
}

/** One run: health, then the three onward bodies, each answer kept as read. */
export async function read(base = BASE, fetchFn = fetch, commit = "") {
  const root = base.replace(/\/$/, "");
  const h = await fetchFn(`${root}/v1/health`, { redirect: "manual", headers: { origin: APP }, signal: AbortSignal.timeout(15_000) });
  const health = { status: h.status, commit: h.headers.get("x-helper-commit"), body: (await h.text()).slice(0, 4096) };
  const k = freshKey();
  const to = randomBytes(32).toString("hex");
  const probes = {};
  for (const [kind, body] of [
    ["shape", onwardBody(k, to, "0")],
    ["fresh", onwardBody(k, to, "1")],
    ["flipped", onwardBody(k, to, "1", true)],
  ]) {
    const r = await fetchFn(`${root}/v1/bind`, { method: "POST", redirect: "manual", headers: { origin: APP, "content-type": "application/json" }, body, signal: AbortSignal.timeout(30_000) });
    probes[kind] = { status: r.status, body: (await r.text()).slice(0, 1024) };
  }
  return { base, commit, readAt: new Date().toISOString(), health, sender: k.id, to, probes };
}

/** The check on one recorded run. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(run.health?.status === 200, `GET /v1/health: ${run.health?.status} (want 200)`);
  say(typeof run.commit === "string" && SHA.test(run.commit) && run.health?.commit === run.commit, `X-Helper-Commit ${run.health?.commit} is the deployed commit ${run.commit || "(no --commit)"}`);
  say(IMPLICIT.test(run.sender ?? "") && IMPLICIT.test(run.to ?? "") && run.sender !== run.to, "the sender and the move's address are 64-hex ids made for this run");
  const WANT = {
    shape: [400, "bad_shape", "amount 0, judged before the signature and any read"],
    fresh: [400, "no_account", "amount 1 from an id with no account"],
    flipped: [400, "bad_signature", "the same with a flipped signature"],
  };
  for (const [kind, [status, want, what]] of Object.entries(WANT)) {
    const p = run.probes?.[kind];
    const b = json(p?.body ?? "");
    const code = b?.error?.code;
    say(p !== undefined && p.status === status && code === want && !("tx_hashes" in (b ?? {})) && !("tx_hashes" in (b?.error ?? {})), `onward move, ${what}: ${p?.status ?? "not read"} ${code ?? p?.body?.slice(0, 80) ?? ""} (want ${status} ${want}, no transaction)`);
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
