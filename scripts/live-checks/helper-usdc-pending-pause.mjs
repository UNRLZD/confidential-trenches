#!/usr/bin/env node
// Live check of card helper-usdc-pending-pause: no deposit is carried while a Pause multisig request on USDC may be
// pending (check 10, M:1388-1404; V:303, the M1 row V:1091). USDC exports no view of a request, so this reads what
// HELPER_HOST's token watch reads (apps/helper/src/token-status/status.ts), on two providers of two operators at one
// final block H (the lower of their finals):
//   - get_next_multisig_request_id: N on both, equal, at H;
//   - for each id from the pin (218: N on 2026-10-31 and since, so no id below it can be pending) up to N, at most 16,
//     approve_multisig_request run as a view: ProhibitedInView predecessor_account_id is a stored request, the pinned
//     code's unwrap panic at src/fiat_token.rs:627:87 is no request, both providers alike;
// then HELPER_HOST's GET /v1/token-status for USDC with Origin APP_HOST. It passes only when the chain read is complete
// and agreed, and either no new request is stored ("no Pause pending"), or one is and the helper holds (caught_up
// false or halted true), or every stored one is proven expired: FastNEAR's archive reads N above its id at a block
// whose timestamp is at least the token's validity (432000 s) before H's, so it was made before then and can never
// execute (the watch frees it the same way, from its own first sight). A stored new request not proven expired while
// the helper reports caught up and not halted is the bad end state: the relayers would carry during a request this read
// cannot rule out as a Pause.
//   node scripts/live-checks/helper-usdc-pending-pause.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";

const KEY = "helper-usdc-pending-pause";
export const BASE = "https://api.confidential.unrealized.trade";
export const APP = "https://confidential.unrealized.trade";
export const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const RPCS = ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"];
export const PIN = 218;
export const ARCHIVE = "https://archival-rpc.mainnet.fastnear.com";
export const VALIDITY_NS = 432_000_000_000_000n;
export const NEW_MAX = 16;
export const STORED = 'wasm execution failed with error: HostError(ProhibitedInView { method_name: "predecessor_account_id" })';
export const NO_REQUEST = "wasm execution failed with error: HostError(GuestPanic { panic_msg: \"panicked at 'called `Option::unwrap()` on a `None` value', src/fiat_token.rs:627:87\" })";
const MAX_BYTES = 65_536;

const show = (v) => (v === undefined ? "none" : JSON.stringify(v));
const json = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

/** One recorded RPC answer's result at height h: its call_function result, or undefined when it is of another block. */
const atH = (body, h) => {
  const r = json(body)?.result;
  return r && r.block_height === h ? r : undefined;
};
/** N from a recorded get_next_multisig_request_id answer at h: a u32's digits, else null. */
export function nextOf(body, h) {
  const r = atH(body, h);
  if (!r || !Array.isArray(r.result) || !r.result.every((x) => Number.isInteger(x) && x >= 0 && x < 256)) return null;
  const t = Buffer.from(r.result).toString("utf8");
  return /^(0|[1-9]\d{0,9})$/.test(t) && Number(t) <= 0xffffffff ? Number(t) : null;
}
/** A recorded approve_multisig_request answer at h: true stored, false no request, null anything else. */
export function storedOf(body, h) {
  const r = atH(body, h);
  return r?.error === STORED ? true : r?.error === NO_REQUEST ? false : null;
}

/** A recorded block answer's height and timestamp in ns, else null. */
export function headOf(body) {
  const h = json(body ?? "")?.result?.header;
  return h && Number.isSafeInteger(h.height) && typeof h.timestamp_nanosec === "string" && /^\d{1,25}$/.test(h.timestamp_nanosec) ? { height: h.height, ns: BigInt(h.timestamp_nanosec) } : null;
}

/**
 * A block answer as the run keeps it: only the header fields headOf reads (height, hash, timestamp_nanosec), so a
 * record holds no validator signature (an approval has a NEAR secret key's shape, gitleaks near-ed25519-secret-key).
 */
export function trimBlock(body) {
  const h = json(body ?? "")?.result?.header;
  return h ? JSON.stringify({ result: { header: { height: h.height, hash: h.hash, timestamp_nanosec: h.timestamp_nanosec } } }) : "";
}

/**
 * The check on one recorded run: { h, chain: [{ rpc, next, stored: [{ id, body }] }], helper: { status, headers, body } }
 * (next and each stored body: the provider's JSON answer as text).
 */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const h = run.h;
  say(Number.isSafeInteger(h) && h > 0, `H, the lower final: ${show(h)}`);
  const sides = (run.chain ?? []).map((c) => ({ rpc: c.rpc, n: nextOf(c.next, h), stored: c.stored ?? [] }));
  say(sides.length === 2 && sides[0].rpc !== sides[1].rpc, `two providers: ${show(sides.map((s) => s.rpc))}`);
  for (const s of sides) say(s.n !== null, `${s.rpc}: get_next_multisig_request_id at ${h} = ${show(s.n)}`);
  const n = sides[0]?.n;
  const agreed = sides.length === 2 && n !== null && n === sides[1].n;
  say(agreed, `N agrees on both: ${show(sides.map((s) => s.n))}`);
  say(agreed && n >= PIN && n - PIN <= NEW_MAX, `N ${show(n)} is at least the pin ${PIN} and at most ${NEW_MAX} above it`);
  let pending = false;
  // the archive's old block: its timestamp at least the validity before H's, and N there
  const hHead = headOf(run.archive?.h);
  const old = headOf(run.archive?.old);
  const oldN = old === null ? null : nextOf(run.archive?.oldNext, old.height);
  const longAgo = hHead !== null && hHead.height === h && old !== null && hHead.ns - old.ns >= VALIDITY_NS;
  if (agreed && n >= PIN && n - PIN <= NEW_MAX) {
    for (let id = PIN; id < n; id++) {
      const each = sides.map((s) => storedOf(s.stored.find((x) => x.id === id)?.body, h));
      say(!each.includes(null), `request ${id} at ${h}: ${each.map((e) => (e === null ? "unread" : e ? "stored" : "none")).join(", ")}`);
      if (!each.includes(true)) continue;
      const expired = longAgo && oldN !== null && oldN > id;
      lines.push(`    request ${id}: ${expired ? `expired (N ${oldN} at ${old.height}, ${(hHead.ns - old.ns) / 1_000_000_000n} s before H)` : "not proven expired"}`);
      if (!expired) pending = true;
    }
  }
  const hb = run.helper ?? {};
  const b = json(hb.body ?? "");
  say(hb.status === 200 && b?.token === USDC, `GET /v1/token-status?token=USDC answers ${show(hb.status)}, token ${show(b?.token)}`);
  const holds = b?.caught_up === false || b?.halted === true;
  if (pending) say(holds, `a new request is stored, so the helper holds: caught_up ${show(b?.caught_up)}, halted ${show(b?.halted)}`);
  else say(true, `no Pause pending: no request from ${PIN} up to N ${show(n)} is stored, or each stored one is expired`);
  const ok = !lines.some((l) => l.startsWith("BAD"));
  return { ok, lines, pending, helperHolds: holds };
}

async function rpc(url, fetchFn, params, method = "query") {
  const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), redirect: "error", signal: AbortSignal.timeout(10_000) });
  const t = await r.text();
  return t.length > MAX_BYTES ? "" : t;
}
const call = (url, fetchFn, h, method_name, args) => rpc(url, fetchFn, { request_type: "call_function", block_id: h, account_id: USDC, method_name, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });

export async function read(base = BASE, fetchFn = fetch) {
  const finals = await Promise.all(RPCS.map(async (u) => json(await rpc(u, fetchFn, { finality: "final" }, "block").then((t) => t || "{}"))?.result?.header?.height));
  const h = finals.every((x) => Number.isSafeInteger(x)) ? Math.min(...finals) : null;
  const chain = await Promise.all(
    RPCS.map(async (u) => {
      const next = h === null ? "" : await call(u, fetchFn, h, "get_next_multisig_request_id", {});
      const n = h === null ? null : nextOf(next, h);
      const ids = n !== null && n > PIN && n - PIN <= NEW_MAX ? Array.from({ length: n - PIN }, (_, i) => PIN + i) : [];
      const stored = await Promise.all(ids.map(async (id) => ({ id, body: await call(u, fetchFn, h, "approve_multisig_request", { request_id: id }) })));
      return { rpc: u, next, stored };
    }),
  );
  // the archive only when a new id is stored: H's block, and a block at least the validity older (stepped back until it is)
  let archive;
  if (h !== null && chain.some((c) => c.stored.some((x) => storedOf(x.body, h) === true))) {
    const blk = async (height) => trimBlock(await rpc(ARCHIVE, fetchFn, { block_id: height }, "block"));
    archive = { h: await blk(h) };
    const hHead = headOf(archive.h);
    for (let back = 750_000; hHead !== null && back <= 1_250_000; back += 100_000) {
      archive.old = await blk(h - back);
      const o = headOf(archive.old);
      if (o !== null && hHead.ns - o.ns >= VALIDITY_NS) {
        archive.oldNext = await call(ARCHIVE, fetchFn, o.height, "get_next_multisig_request_id", {});
        break;
      }
    }
  }
  const r = await fetchFn(`${base.replace(/\/$/, "")}/v1/token-status?token=${USDC}`, { method: "GET", redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" } });
  const headers = {};
  for (const [k, v] of r.headers) headers[k.toLowerCase()] = v;
  return { base, readAt: new Date().toISOString(), h, chain, ...(archive ? { archive } : {}), helper: { status: r.status, headers, body: await r.text() } };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = await read(opt("--base", BASE));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { ok, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${run.base}, H ${run.h})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
