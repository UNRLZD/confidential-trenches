#!/usr/bin/env node
// Live check of card relayer-fresh-near: HELPER_HOST prices a fresh recipient's creation in one published fee per epoch
// (apps/helper/src/withdraw/fee.ts "one fee per epoch"), and a withdrawal to a fresh 64-hex NEAR id leaves that id
// created holding only its own key (apps/helper/src/withdraw/send.ts createRecipient). NEAR mainnet only.
//   1. The fee: GET /v1/withdraw/fee for mainnet USDC, --reads times --every ms apart (default 37 x 5 s, about three
//      epochs). Each answer is 200 with relay_fee a u128 decimal and valid_until_block a height; its agreed block
//      (valid_until_block less the 1,200-block window) is read on two providers of two operators, one hash and one
//      timestamp_nanosec, and its epoch is that time's 60 s slot. Every two answers whose blocks fall in one epoch name
//      the same relay_fee (BAD otherwise: a helper that prices each block afresh answers two fees in one epoch once
//      NEAR's price moves in it). The answer's px is the price at its own block, so the rule is exercised only where px
//      moved inside an epoch: a run where it never did is INCONCLUSIVE, never PASS. A provider's no-answer
//      (provider-answer.mjs) leaves that answer unjudged, as does the helper's own 503 upstream (its providers did not
//      answer that read, apps/helper/src/server.ts upstreamWait: the device asks again); any other answer that is not 200
//      is BAD; fewer than two answers in every epoch is INCONCLUSIVE.
//   2. The creation, once a withdrawal to a fresh id is recorded (--created <64-hex id>, the id its payout named): the
//      id read at one final block on both providers exists, and its key list is exactly [its own id key, full access].
//      With no such withdrawal recorded this half prints "held" and judges nothing.
// After: helper
//   node scripts/live-checks/relayer-fresh-near.mjs [--base <url>] [--reads <n>] [--every <ms>] [--created <64-hex id>]
//     [--record <file>] [--answer <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3.
import "../net-window.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";

const KEY = "relayer-fresh-near";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"; // gitleaks:allow (a public account id)
export const PAIR = ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"];
export const WINDOW = 1_200;
export const EPOCH_MS = 60_000n;
export const READS = 37;
export const EVERY_MS = 5_000;
const DEC = /^(0|[1-9][0-9]{0,38})$/;
const HEX64 = /^[0-9a-f]{64}$/;

const json = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Base58 of bytes (Bitcoin's alphabet, as NEAR writes keys). */
export function base58(bytes) {
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = `1${s}`;
  }
  return s;
}
/** A 64-hex implicit id's own key: the ed25519 key whose 32 bytes are the id (send.ts idKeyOf). */
export const idKeyOf = (id) => `ed25519:${base58(Buffer.from(id, "hex"))}`;

/**
 * The check on one recorded run: { reads: [{ readAt, status, body, block: { height, hashes: [a, b], ns: [a, b] } |
 * { noAnswer } | { error } }], created?: { id, height, answers: [{ keys } | { absent: true } | { noAnswer } | { error }] x 2 } }.
 * Returns the verdict (PASS, FAIL or INCONCLUSIVE) and the lines.
 */
export function judge(run) {
  const lines = [];
  let quiet = false;
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const note = (text) => {
    quiet = true;
    lines.push(`--  ${text}`);
  };
  const byEpoch = new Map();
  for (const [i, r] of (run.reads ?? []).entries()) {
    const b = json(r.body);
    if (r.status === 503 && b?.error?.code === "upstream") {
      lines.push(`--  [${i}] ${r.readAt} GET /v1/withdraw/fee 503 upstream: the helper's providers did not answer this read (the device asks again); this answer is not judged`);
      continue;
    }
    const fee = typeof b?.relay_fee === "string" && DEC.test(b.relay_fee) && BigInt(b.relay_fee) < 1n << 128n ? b.relay_fee : null;
    const vub = Number.isSafeInteger(b?.valid_until_block) && b.valid_until_block > WINDOW ? b.valid_until_block : null;
    say(r.status === 200 && fee !== null && vub !== null, `[${i}] ${r.readAt} GET /v1/withdraw/fee ${r.status}: relay_fee ${fee ?? "not a u128 decimal"}, valid_until_block ${vub ?? "not a height"}`);
    const k = r.block;
    if (vub === null || fee === null) continue;
    if (k?.noAnswer !== undefined) {
      lines.push(`--  [${i}] its block ${vub - WINDOW}: ${k.noAnswer}; this answer is not judged`);
      continue;
    }
    const agreed = k && k.error === undefined && k.height === vub - WINDOW && typeof k.hashes?.[0] === "string" && k.hashes[0] === k.hashes[1] && typeof k.ns?.[0] === "string" && DEC.test(k.ns[0]) && k.ns[0] === k.ns[1];
    say(agreed, `[${i}] its block ${vub - WINDOW} read on both providers: ${k?.error ?? (agreed ? "one hash, one time" : "they disagree")}`);
    if (!agreed) continue;
    const ms = BigInt(k.ns[0]) / 1_000_000n;
    const epoch = (ms - (ms % EPOCH_MS)).toString();
    byEpoch.set(epoch, [...(byEpoch.get(epoch) ?? []), { i, fee, px: b.px }]);
  }
  let pairs = 0;
  let moved = 0;
  for (const [epoch, xs] of byEpoch) {
    if (xs.length < 2) continue;
    pairs++;
    const fees = [...new Set(xs.map((x) => x.fee))];
    const pxs = new Set(xs.map((x) => x.px)).size;
    if (pxs > 1) moved++;
    say(fees.length === 1, `epoch ${epoch}: ${xs.length} answers (reads ${xs.map((x) => x.i).join(", ")}), relay_fee ${fees.join(" / ")}${fees.length === 1 ? ": one fee" : ": more than one fee in one epoch"}; ${pxs} px value(s)`);
  }
  if (pairs === 0) note("no epoch held two judged answers: the one-fee rule was not read: INCONCLUSIVE");
  else if (moved > 0) say(true, `px moved ${moved} of ${pairs} epoch(s) with two judged answers: the one-fee rule was read where NEAR's price moved`);
  else if (moved === 0) note("NEAR's price did not move inside any epoch read: one fee per epoch and one fee per block answer alike: INCONCLUSIVE");
  const c = run.created;
  if (c === undefined) {
    lines.push("--  held: no withdrawal to a fresh id is recorded (--created <id>); the creation half judges nothing");
  } else {
    const okId = typeof c.id === "string" && HEX64.test(c.id);
    say(okId, `created id ${c.id}: a 64-hex implicit id`);
    const want = okId ? idKeyOf(c.id) : null;
    const answers = Array.isArray(c.answers) ? c.answers : [];
    for (const [i, a] of answers.entries()) {
      if (a?.noAnswer !== undefined) {
        note(`[rpc ${i}] ${c.id}: ${a.noAnswer}: INCONCLUSIVE`);
        continue;
      }
      const one = a && a.error === undefined && a.absent !== true && Array.isArray(a.keys) && a.keys.length === 1 && a.keys[0]?.public_key === want && a.keys[0]?.permission === "FullAccess";
      say(one, `[rpc ${i}] ${c.id} at block ${c.height}: ${a?.error ?? (a?.absent ? "absent" : `${a?.keys?.length ?? 0} key(s)${one ? ", exactly its own id key, full access" : ""}`)}`);
    }
    say(answers.length === 2, `the id read on ${answers.length} providers, two wanted`);
  }
  const verdict = verdictOf(lines.some((l) => l.startsWith("BAD")), quiet);
  return { ok: verdict === "PASS", verdict, lines };
}

// ---- The reads ----

/** One read on `url`: its result, or { noAnswer } / { error } as provider-answer.mjs names them. */
const ask = (url, method, params, fetchFn) => rpcAnswer(url, method, params, { fetchFn });

async function blockAt(height, fetchFn) {
  const as = await Promise.all(PAIR.map((u) => ask(u, "block", { block_id: height }, fetchFn)));
  const no = as.find((a) => a.noAnswer !== undefined);
  if (no) return { noAnswer: no.noAnswer };
  const err = as.find((a) => a.error !== undefined);
  if (err) return { error: JSON.stringify(err.error).slice(0, 300) };
  return { height, hashes: as.map((a) => a.result?.header?.hash), ns: as.map((a) => String(a.result?.header?.timestamp_nanosec)) };
}

async function createdRead(id, fetchFn) {
  const finals = await Promise.all(PAIR.map((u) => ask(u, "block", { finality: "final" }, fetchFn)));
  const heights = finals.map((f) => f.result?.header?.height).filter((h) => Number.isSafeInteger(h));
  if (heights.length < 2) return { id, height: null, answers: finals.map((f) => ({ noAnswer: f.noAnswer ?? `no final block (${JSON.stringify(f.error).slice(0, 200)})` })) };
  const height = Math.min(...heights);
  const answers = await Promise.all(
    PAIR.map(async (u) => {
      const at = { block_id: height, account_id: id };
      const acc = await ask(u, "query", { request_type: "view_account", ...at }, fetchFn);
      if (acc.noAnswer !== undefined) return { noAnswer: acc.noAnswer };
      if (acc.error !== undefined) return acc.error?.cause?.name === "UNKNOWN_ACCOUNT" ? { absent: true } : { error: JSON.stringify(acc.error).slice(0, 300) };
      const list = await ask(u, "query", { request_type: "view_access_key_list", ...at }, fetchFn);
      if (list.noAnswer !== undefined) return { noAnswer: list.noAnswer };
      if (list.error !== undefined) return { error: JSON.stringify(list.error).slice(0, 300) };
      return { keys: (list.result?.keys ?? []).map((k) => ({ public_key: k.public_key, permission: k.access_key?.permission })) };
    }),
  );
  return { id, height, answers };
}

export async function read(base = BASE, opts = {}, fetchFn = fetch) {
  const reads = [];
  const n = opts.reads ?? READS;
  for (let i = 0; i < n; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, opts.everyMs ?? EVERY_MS));
    const readAt = new Date().toISOString();
    const r = await fetchFn(`${base.replace(/\/$/, "")}/v1/withdraw/fee?token=${USDC}`, { method: "GET", redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" } });
    const body = await r.text();
    const vub = json(body)?.valid_until_block;
    reads.push({ readAt, status: r.status, body, block: Number.isSafeInteger(vub) ? await blockAt(vub - WINDOW, fetchFn) : { error: "no valid_until_block" } });
  }
  const run = { base, pair: PAIR, reads };
  if (opts.created !== undefined) run.created = await createdRead(opts.created, fetchFn);
  return run;
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const created = opt("--created");
    if (created !== undefined && !HEX64.test(created)) throw new Error("--created must be a 64-hex implicit id");
    const reads = Number(opt("--reads", READS));
    const everyMs = Number(opt("--every", EVERY_MS));
    if (!Number.isSafeInteger(reads) || reads < 2 || reads > 200 || !Number.isSafeInteger(everyMs) || everyMs < 500 || everyMs > 60_000) throw new Error("--reads must be 2 to 200 and --every 500 to 60000 ms");
    const run = opt("--answer") ? JSON.parse(readFileSync(opt("--answer"), "utf8")) : await read(opt("--base", BASE), { created, reads, everyMs });
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { verdict, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${verdict} (${run.base})`);
    process.exit(EXIT[verdict]);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(EXIT.ERROR);
  }
}
