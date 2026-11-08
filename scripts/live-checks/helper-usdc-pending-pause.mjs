#!/usr/bin/env node
// Live check of card helper-usdc-pending-pause: no deposit is carried while a Pause multisig request on USDC may be
// pending (check 10, M:1388-1404; V:303, the M1 row V:1091). USDC exports no view of a request, so on each network
// (mainnet USDC, and the testnet token, which runs USDC's code) it reads what HELPER_HOST's token watch reads
// (apps/helper/src/token-status/status.ts), on two providers of two operators at one final block H, the lower final:
//   - get_next_multisig_request_id: N on both, equal, at H (the live N: no pinned id, so N may grow without bound);
//   - for the last ids below N, at most 16, approve_multisig_request run as a view: ProhibitedInView
//     predecessor_account_id is a stored request, the pinned code's unwrap panic at src/fiat_token.rs:627:87 is no
//     request, both providers alike;
//   - a stored one's kind, where both providers serve view_state on the token (testnet; mainnet's state is too large
//     for every keyless provider): the request's bytes at ~am\x02 + the id as u32 LE, equal on both at H; tag 6 is
//     Pause (near-sdk-contract-tools' FiatTokenAction, the order of the wasm's variant names), any other kind is not;
//   - else a stored one is proven expired when the network's FastNEAR archive reads N above its id at a block whose
//     timestamp is at least the token's validity (432000 s) before H's: made before then, it can never execute;
// then the deposit carry itself, POST /v1/bind with Origin APP_HOST: a SignedDelegateAction to the network's token with
// no action and an all-zero key and signature, which moves nothing. The carry answers the token hold before any check
// (bind/send.ts carryDeposit): token_halted when it holds, else a check's code (bad_signature), token_not_accepted
// where the network is not carried, relayer_low below the gas floor. It passes only when each network's chain read is
// complete and agreed, and either no request that may be pending is stored, or one is and the carry sends nothing
// (token_halted, token_not_accepted or relayer_low). A request that may be pending while the carry runs its checks is
// the bad end state. /v1/token-status is not read: the request hold gates only the deposit carry.
// After: helper
//   node scripts/live-checks/helper-usdc-pending-pause.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";

const KEY = "helper-usdc-pending-pause";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const NETS = {
  mainnet: { token: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", rpcs: ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"], archive: "https://archival-rpc.mainnet.fastnear.com" },
  testnet: { token: "bf-usdc-20261101t022248.testnet", rpcs: ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"], archive: "https://archival-rpc.testnet.fastnear.com" }, // gitleaks:allow (a public account id)
};
export const VALIDITY_NS = 432_000_000_000_000n;
export const WINDOW = 16;
export const STORED = 'wasm execution failed with error: HostError(ProhibitedInView { method_name: "predecessor_account_id" })';
export const NO_REQUEST = "wasm execution failed with error: HostError(GuestPanic { panic_msg: \"panicked at 'called `Option::unwrap()` on a `None` value', src/fiat_token.rs:627:87\" })";
/** The carry's answers that send nothing. */
export const SENDS_NOTHING = ["token_halted", "token_not_accepted", "relayer_low"];
const MAX_BYTES = 65_536;

const show = (v) => (v === undefined ? "none" : JSON.stringify(v));
const json = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

/** One recorded RPC answer's result at height h, else undefined (an answer of another block is none). */
const atH = (body, h) => {
  const r = json(body ?? "")?.result;
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
/** FiatTokenAction::Pause's borsh tag (the wasm's variant names in declaration order; header). */
export const PAUSE_TAG = 6;
/** The storage key of request `id`: ~am, 2, the id as u32 LE (near-sdk-contract-tools ApprovalManager). */
export const requestKey = (id) => {
  const b = Buffer.alloc(8);
  b.write("~am", 0, "latin1");
  b[3] = 2;
  b.writeUInt32LE(id, 4);
  return b.toString("base64");
};
/** A recorded view_state answer at h for request `id`: its kind tag, else null (refused, another block, no such key). */
export function kindOf(body, h, id) {
  const r = atH(body, h);
  const v = Array.isArray(r?.values) ? r.values.find((x) => x?.key === requestKey(id)) : undefined;
  if (typeof v?.value !== "string") return null;
  const b = Buffer.from(v.value, "base64");
  return b.length > 0 ? b[0] : null;
}

/** The ids read below N: the last WINDOW of them. */
export const windowOf = (n) => Array.from({ length: Math.min(n, WINDOW) }, (_, i) => n - Math.min(n, WINDOW) + i);

/** The check on one network's recorded read: { network, h, chain: [{ rpc, next, stored: [{ id, body }] }], archive?, carry }. */
function judgeNet(r, say, info) {
  const tag = `[${r.network}]`;
  const h = r.h;
  say(Number.isSafeInteger(h) && h > 0, `${tag} H, the lower final: ${show(h)}`);
  const sides = (r.chain ?? []).map((c) => ({ rpc: c.rpc, n: nextOf(c.next, h), stored: c.stored ?? [], state: c.state ?? [] }));
  say(sides.length === 2 && sides[0].rpc !== sides[1].rpc, `${tag} two providers: ${show(sides.map((s) => s.rpc))}`);
  const n = sides[0]?.n;
  const agreed = sides.length === 2 && n !== null && n === sides[1].n;
  say(agreed, `${tag} N at ${h} on both: ${show(sides.map((s) => s.n))}`);
  const hHead = headOf(r.archive?.h);
  const old = headOf(r.archive?.old);
  const oldN = old === null ? null : nextOf(r.archive?.oldNext, old.height);
  const longAgo = hHead !== null && hHead.height === h && old !== null && hHead.ns - old.ns >= VALIDITY_NS;
  let pending = false;
  if (agreed) {
    for (const id of windowOf(n)) {
      const each = sides.map((s) => storedOf(s.stored.find((x) => x.id === id)?.body, h));
      say(!each.includes(null), `${tag} request ${id} at ${h}: ${each.map((e) => (e === null ? "unread" : e ? "stored" : "none")).join(", ")}`);
      if (!each.includes(true)) continue;
      const kinds = sides.map((s) => kindOf(s.state.find((x) => x.id === id)?.body, h, id));
      if (kinds[0] !== null && kinds[0] === kinds[1] && kinds[0] !== PAUSE_TAG) {
        info(`${tag}   request ${id}: kind tag ${kinds[0]} on both, not a Pause`);
        continue;
      }
      const expired = longAgo && oldN !== null && oldN > id;
      info(`${tag}   request ${id}: ${expired ? `expired (N ${oldN} at ${old.height}, ${(hHead.ns - old.ns) / 1_000_000_000n} s before H)` : "not proven expired"}`);
      if (!expired) pending = true;
    }
  }
  const code = json(r.carry?.body ?? "")?.error?.code;
  say(typeof code === "string", `${tag} POST /v1/bind (a delegate that moves nothing) answers ${show(r.carry?.status)} ${show(code)}`);
  if (pending) say(SENDS_NOTHING.includes(code), `${tag} a request that may be pending is stored, so the deposit carry sends nothing: ${show(code)}`);
  else say(true, `${tag} no Pause pending: no request in ${agreed ? `${Math.max(0, n - WINDOW)}-${n - 1}` : "the window"} may be pending`);
  return pending;
}

/** The check on one recorded run: { nets: [judgeNet's input, one per network] }. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const info = (text) => lines.push(text);
  const nets = run.nets ?? [];
  say(JSON.stringify(nets.map((x) => x.network)) === JSON.stringify(Object.keys(NETS)), `networks read: ${show(nets.map((x) => x.network))}`);
  const pending = nets.map((r) => judgeNet(r, say, info));
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines, pending };
}

async function rpc(url, fetchFn, params, method = "query") {
  const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), redirect: "error", signal: AbortSignal.timeout(10_000) });
  const t = await r.text();
  return t.length > MAX_BYTES ? "" : t;
}
const call = (url, fetchFn, token, h, method_name, args) => rpc(url, fetchFn, { request_type: "call_function", block_id: h, account_id: token, method_name, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });

/** borsh SignedDelegateAction to `receiver` with no action, nonce 0, max_block_height 0, an all-zero ed25519 key and signature. */
export function probeDelegate(receiver) {
  const str = (t) => {
    const b = Buffer.from(t);
    const l = Buffer.alloc(4);
    l.writeUInt32LE(b.length);
    return Buffer.concat([l, b]);
  };
  return Buffer.concat([str("probe.near"), str(receiver), Buffer.alloc(4), Buffer.alloc(16), Buffer.from([0]), Buffer.alloc(32), Buffer.from([0]), Buffer.alloc(64)]).toString("base64");
}

/** The archive's H block and a block at least the validity older, found from the block rate and stepped back until it is. */
async function archiveOf(net, fetchFn, h, token) {
  const blk = async (height) => trimBlock(await rpc(net.archive, fetchFn, { block_id: height }, "block"));
  const archive = { h: await blk(h) };
  const hHead = headOf(archive.h);
  const ref = headOf(await blk(h - 100_000));
  if (hHead === null || ref === null) return archive;
  const nsPerBlock = (hHead.ns - ref.ns) / 100_000n;
  let c = h - Number((VALIDITY_NS * 101n) / 100n / nsPerBlock);
  for (let tries = 0; tries < 6 && c > 0; tries++) {
    archive.old = await blk(c);
    const o = headOf(archive.old);
    if (o === null) {
      c -= 10;
      continue;
    }
    if (hHead.ns - o.ns >= VALIDITY_NS) {
      archive.oldNext = await call(net.archive, fetchFn, token, o.height, "get_next_multisig_request_id", {});
      break;
    }
    c -= Number((VALIDITY_NS - (hHead.ns - o.ns)) / nsPerBlock) + 1_000;
  }
  return archive;
}

export async function read(base = BASE, fetchFn = fetch) {
  const nets = [];
  for (const [network, net] of Object.entries(NETS)) {
    const finals = await Promise.all(net.rpcs.map(async (u) => json((await rpc(u, fetchFn, { finality: "final" }, "block")) || "{}")?.result?.header?.height));
    const h = finals.every((x) => Number.isSafeInteger(x)) ? Math.min(...finals) : null;
    const chain = await Promise.all(
      net.rpcs.map(async (u) => {
        const next = h === null ? "" : await call(u, fetchFn, net.token, h, "get_next_multisig_request_id", {});
        const n = h === null ? null : nextOf(next, h);
        const stored = n === null ? [] : await Promise.all(windowOf(n).map(async (id) => ({ id, body: await call(u, fetchFn, net.token, h, "approve_multisig_request", { request_id: id }) })));
        // each stored request's bytes, where the provider serves the token's state (a refusal is kept as answered)
        const state = await Promise.all(stored.filter((x) => storedOf(x.body, h) === true).map(async ({ id }) => ({ id, body: await rpc(u, fetchFn, { request_type: "view_state", block_id: h, account_id: net.token, prefix_base64: requestKey(id) }) })));
        return { rpc: u, next, stored, state };
      }),
    );
    const anyStored = h !== null && chain.some((c) => c.stored.some((x) => storedOf(x.body, h) === true));
    const archive = anyStored ? await archiveOf(net, fetchFn, h, net.token) : undefined;
    const r = await fetchFn(`${base.replace(/\/$/, "")}/v1/bind`, { method: "POST", redirect: "manual", headers: { origin: APP, "content-type": "application/json" }, body: JSON.stringify({ signed_delegate: probeDelegate(net.token) }), signal: AbortSignal.timeout(15_000) });
    nets.push({ network, h, chain, ...(archive ? { archive } : {}), carry: { status: r.status, body: (await r.text()).slice(0, 512) } });
  }
  return { base, readAt: new Date().toISOString(), nets };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = await read(opt("--base", BASE));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { ok, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${run.base}, H ${run.nets.map((x) => `${x.network} ${x.h}`).join(", ")})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
