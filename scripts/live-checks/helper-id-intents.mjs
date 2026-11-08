#!/usr/bin/env node
// Live check of card helper-id-intents: HELPER_HOST serves POST /v1/intents (markets.md H4.3, the paragraph "The ids'
// intents on /v1/intents"), its gate first. It sends nothing that could be carried and moves no money: every intent it
// posts is refused before the simulation, and its signature is zero bytes. With Origin SIGN_HOST (the device's page) it
// reads:
//   - GET /v1/health: 200, parts.intents "up";
//   - POST /v1/intents {} (the device's probe, wallet refund.ts ask.probe): 400 bad_shape;
//   - an ft_withdraw from a 64-hex signer made at run time, which the helper never saw receive money: 403 id_not_ours,
//     never 404;
//   - the same signer's ft_withdraw to the vault of the mainnet deploy record: 403 id_not_ours (the gate comes before
//     the vault refusal, so an unseen signer learns nothing more);
//   - with --seen <signer> (a one-time id the deployed helper saw receive money through its 1Click records): that
//     signer's ft_withdraw to the vault: 403 receiver_is_vault. Without --seen the line says so and nothing is judged
//     for it: no signer is seen until a real 1Click delivery or refund went through the deployed helper.
// Every answer carries a full-sha X-Helper-Commit, SIGN_HOST echoed, a JSON body under 1 KB and no tx_hash.
// After: helper
//   node scripts/live-checks/helper-id-intents.mjs [--base <url>] [--seen <signer>] [--record <file>]   PASS 0, FAIL 1, error 2
import "../net-window.mjs";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { loadRecord } from "./helper-mainnet-vault-env.mjs";

export const KEY = "helper-id-intents";
export const BASE = "https://ct-api.unrealized.trade";
export const SIGN = "https://confidential.unrealized.trade";
export const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const SHA = /^[0-9a-f]{40}$/;
const IMPLICIT = /^[0-9a-f]{64}$/;
const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const isAccount = (a) => typeof a === "string" && a.length >= 2 && a.length <= 64 && ACCOUNT.test(a);
/** base58 of `n` zero bytes: "1" for each. */
const zeros = (n) => "1".repeat(n);

/** One signed intent of `signer`: an ft_withdraw of 1 base unit of USDC to `to`, dying 2 minutes from `now`. */
export function intent(signer, to, now = Date.now()) {
  const payload = JSON.stringify({
    signer_id: signer,
    verifying_contract: "intents.near",
    deadline: new Date(now + 120_000).toISOString(),
    nonce: Buffer.alloc(32).toString("base64"),
    intents: [{ intent: "ft_withdraw", token: USDC, receiver_id: to, amount: "1" }],
  });
  return { signed_intent: { standard: "raw_ed25519", payload, public_key: `ed25519:${zeros(32)}`, signature: `ed25519:${zeros(64)}` } };
}

/** The asks, each with the answer that passes. `stranger`: the run's fresh signer; `seen`: --seen or null. */
export function asks(vault, stranger, seen, now = Date.now()) {
  const list = [
    { name: "health", method: "GET", path: "/v1/health", want: [200, null] },
    { name: "the probe", method: "POST", path: "/v1/intents", body: "{}", want: [400, "bad_shape"] },
    { name: "a signer never seen", method: "POST", path: "/v1/intents", body: JSON.stringify(intent(stranger, "alice.near", now)), want: [403, "id_not_ours"] },
    { name: "a signer never seen, to the vault", method: "POST", path: "/v1/intents", body: JSON.stringify(intent(stranger, vault, now)), want: [403, "id_not_ours"] },
  ];
  if (seen !== null) list.push({ name: "a seen signer, to the vault", method: "POST", path: "/v1/intents", body: JSON.stringify(intent(seen, vault, now)), want: [403, "receiver_is_vault"] });
  return list;
}

/** One run: a fresh signer, every ask sent, its status, headers and body kept. */
export async function read(base = BASE, seen = null, fetchFn = fetch, vault = loadRecord().account_id) {
  const stranger = randomBytes(32).toString("hex");
  const now = Date.now();
  const reads = [];
  for (const a of asks(vault, stranger, seen, now)) {
    const r = await fetchFn(`${base.replace(/\/$/, "")}${a.path}`, {
      method: a.method,
      redirect: "manual",
      headers: { origin: SIGN, ...(a.body !== undefined && { "content-type": "application/json" }) },
      ...(a.body !== undefined && { body: a.body }),
      signal: AbortSignal.timeout(20_000),
    });
    const headers = Object.fromEntries(["x-helper-commit", "access-control-allow-origin"].map((h) => [h, r.headers.get(h)]));
    reads.push({ asked: a.name, readAt: new Date().toISOString(), status: r.status, headers, body: (await r.text()).slice(0, 4096) });
  }
  return { base, vault, stranger, seen, now, reads };
}

function json(s) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** The check on one recorded run. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(isAccount(run.vault), `the deploy record's vault: ${run.vault}`);
  say(typeof run.stranger === "string" && IMPLICIT.test(run.stranger) && run.stranger !== run.seen, `a fresh signer: ${String(run.stranger).slice(0, 12)}...`);
  if (run.seen === null) lines.push("n/a a seen signer, to the vault: no --seen signer given (none is seen before a real 1Click delivery or refund through the deployed helper)");
  else say(isAccount(run.seen), `the seen signer: ${String(run.seen).slice(0, 12)}...`);
  for (const a of asks(run.vault, run.stranger, run.seen, run.now)) {
    const r = run.reads.find((x) => x.asked === a.name);
    if (!r) {
      say(false, `${a.name}: not read`);
      continue;
    }
    const body = json(r.body);
    const [status, code] = a.want;
    if (a.name === "health") say(r.status === 200 && body?.parts?.intents === "up", `health: ${r.status}, parts.intents ${body?.parts?.intents} (want 200, up)`);
    else say(r.status === status && body?.error?.code === code, `${a.name}: ${r.status} ${body?.error?.code ?? r.body.slice(0, 80)} (want ${status} ${code})`);
    say(typeof r.headers["x-helper-commit"] === "string" && SHA.test(r.headers["x-helper-commit"]), `${a.name}: X-Helper-Commit ${r.headers["x-helper-commit"]}`);
    say(r.headers["access-control-allow-origin"] === SIGN, `${a.name}: SIGN_HOST echoed (${r.headers["access-control-allow-origin"]})`);
    say(Buffer.byteLength(r.body) <= 1024 && !/tx_hash/.test(r.body), `${a.name}: a body under 1 KB with no tx_hash`);
  }
  return { ok: lines.every((l) => !l.startsWith("BAD")), lines };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (k) => {
    const i = args.indexOf(k);
    return i === -1 ? undefined : args[i + 1];
  };
  try {
    const seen = opt("--seen") ?? null;
    if (seen !== null && !isAccount(seen)) throw new Error("--seen must be a NEAR account id");
    const run = await read(opt("--base") ?? BASE, seen);
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
