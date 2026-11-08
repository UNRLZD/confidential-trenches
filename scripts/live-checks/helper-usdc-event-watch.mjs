#!/usr/bin/env node
// Live check of card helper-usdc-event-watch: the sources the helper's token watch reads USDC's halt, the vault's block
// and USDC's code from, on each network (markets paper H3.4 check 10, "Where the watch starts"). USDC has no view of its
// halt (W D48), but while it is halted its views fail with its own panic "FiatToken: paused" (the real wasm in a
// sandbox, the vault paper's proof RESULT 3.1), so a view read at one block on two NEAR providers of two operators gives
// the halt, the block and the code at that block. It passes only when, per network:
//   - both providers serve the token's code: its sha256 is the release's pin, both equal, and the wasm exports the
//     methods that switch the halt and the block (execute_multisig_request runs Pause and Unpause; blocklist,
//     unblocklist; upgrade) and the views the watch reads (ft_balance_of, is_blocklisted), with the x-fiat-token event
//     names and the paused panic in its data;
//   - on each provider, at the block its final ft_balance_of answered at: ft_balance_of answers a balance (not halted),
//     is_blocklisted of the network's vault (mainnet's the v1 deploy record's) answers false, and view_account names
//     the pin; the two providers' blocks are within MAX_SKEW of each other;
// and on mainnet, that a view at a height equals the event history: the indexer's list of USDC's blocklist and
// unblocklist receipts (NearBlocks) holds the one pair, each receipt's log on the archival provider is that x-fiat-token
// event for the same account, and is_blocklisted of that account reads false, true, true, false at the blocklist's block
// less one, its block, the unblocklist's block less one and its block (a view at block h includes h's receipts).
// Then the helper itself (HELPER_HOST's GET /v1/token-status, read with Origin APP_HOST before the providers): on each
// network it carries (CARRIED: both, mainnet's watch on the v1 vault the host's WITHDRAW_VAULT_MAINNET names once the
// env cutover moves it, apps/helper/deploy/vault-lines.sh), caught_up true, not halted, the vault not blocked, the pin,
// at a block no more than MAX_LAG behind the providers' final reads that follow it. A network not in CARRIED would be
// read for the kit's not-caught-up answer (halted, vault_blocked and code_hash_ok null: with no vault named the watch
// never answers caught up); CARRIED names both today, so that branch runs on none. Until the env cutover the
// deployed helper answers no caught-up watch on the v1 vault, and this check FAILs on it (as its recorded
// bad_mainnet_not_carried run does), so the helper redeploy for it goes with the cutover, never before.
// And the halt itself, seen once (PROBE): testnet's probe token, mainnet USDC's pinned code made with two pausers
// (contracts/vault/deployments/testnet-usdc-probe.json), paused and unpaused at once by its pausers' multisig on
// 2026-11-03. On FastNEAR's testnet archive (the one keyless archive), the four transactions read succeeded, and the
// watch's own pausedAt rule (block h's header, ft_balance_of at its parent and at h by hash, the pin at both) reads
// open then halted at the Pause's block and halted then open at the Unpause's. Every view is read through the helper's
// own functions (apps/helper/src/token-status/status.ts viewOutcome, haltOf and pausedFrom), never a copy.
// After: helper
//   node scripts/live-checks/helper-usdc-event-watch.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { haltOf, pausedFrom, viewOutcome } from "../../apps/helper/src/token-status/status.ts";
export { haltOf, viewOutcome };

const KEY = "helper-usdc-event-watch";
export const PIN = "DVJx7F3dHEHJYwpYPwXHu8K9Uo7h4kXFcALucY5oNX8q";
export const PIN_SHA256 = "b98ccd530f7e643cfef32f4529ade060ef87ff73b0101536399470777b86cfe6"; // the pin is base58 of it
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
/** The networks the helper carries, so its watch must answer caught up there. Mainnet is carried because the host names
 *  its vault (WITHDRAW_VAULT_MAINNET, BIND_VAULT_MAINNET: token-status/status.ts vaultOf), not because the release forces
 *  it: withdraw/send.ts starts a helper that names no mainnet vault and refuses only one other than MAINNET_VAULT. The
 *  env cutover names the v1 record's. */
export const CARRIED = ["testnet", "mainnet"];
export const MAX_LAG = 100; // blocks (about 60 s) the helper's answer may trail the providers' final reads after it
export const MAX_SKEW = 30; // blocks between the two providers' final answers (about 18 s): more is a provider behind
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
/** Mainnet's vault: the v1 deploy record's account (contracts/vault/deployments/mainnet-v1.json), the kit's and the helper's. */
const MAINNET_VAULT = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../contracts/vault/deployments/mainnet-v1.json"), "utf8")).account_id;
/** The one account USDC ever blocklisted on mainnet, unblocklisted since: the event history below is read for it. */
export const HISTORY_ACCOUNT = "da179a3b4754fa92c637a90533071075142fd931dcd4987e8f362dedc6e0087d";
/** Per network: the token, its two providers (two operators, scripts/ci/near-rpc-operators.mjs), the vault whose block is read. */
export const NETS = {
  mainnet: {
    token: USDC,
    pair: ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"],
    watched: MAINNET_VAULT,
  },
  testnet: {
    token: "bf-usdc-20261101t022248.testnet", // gitleaks:allow (contracts/vault/deployments/testnet-usdc.json)
    pair: ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"],
    watched: "vault.bf-vt-20261102t071444.testnet", // gitleaks:allow (contracts/vault/deployments/testnet-v1.json)
  },
};
export const ARCHIVAL = "https://archival-rpc.mainnet.fastnear.com"; // the one keyless archival operator (FastNEAR)
export const INDEXER = "https://api.nearblocks.io/v1";
export const METHODS = ["execute_multisig_request", "blocklist", "unblocklist", "upgrade", "ft_balance_of", "is_blocklisted"];
export const STRINGS = ["x-fiat-token", "paused", "unpaused", "blocklist", "unblocklist", "FiatToken: paused", "EVENT_JSON:"];
const RATE_CAP_S = 120;
const GAP_MS = 1000; // one read a second per run: public providers, never a burst
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const show = (v) => (v === undefined ? "none" : JSON.stringify(v));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

/** The probe (header): its token and holder, the four transactions, the Pause's and the Unpause's blocks. */
export const PROBE = {
  token: "bf-usdc-20261102t164926.testnet", // gitleaks:allow (contracts/vault/deployments/testnet-usdc-probe.json)
  holder: "holder.bf-usdc-20261102t164926.testnet", // gitleaks:allow
  archive: "https://archival-rpc.testnet.fastnear.com",
  txs: [
    { hash: "GfFB4jfhviTTj4xQd3tLPLBKRSCbGZjwaLGsdRTeL8fK", signer: "pauser.bf-usdc-20261102t164926.testnet", what: "Pause: create and approve request 3" }, // gitleaks:allow
    { hash: "3GXgvpDwGpf8v9j5NerAGUWdbYFqxatvueR7X86ZgPth", signer: "pauser2.bf-usdc-20261102t164926.testnet", what: "Pause: approve and execute request 3" }, // gitleaks:allow
    { hash: "2eUSm5iLg8k8DRkSW444jWCWk7ebHsNue8D4Uyi3XmwZ", signer: "pauser.bf-usdc-20261102t164926.testnet", what: "Unpause: create and approve request 4" }, // gitleaks:allow
    { hash: "DoQYjLCp6rwwxyHt4hiJXDy2pupUDETeg1zpDA9Tfmni", signer: "pauser2.bf-usdc-20261102t164926.testnet", what: "Unpause: approve and execute request 4" }, // gitleaks:allow
  ],
  paused: 275929377,
  open: 275929392,
};

export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  for (const [net, { token, pair, watched }] of Object.entries(NETS)) {
    const n = run.nets?.[net];
    if (!n) {
      say(false, `[${net}] not read`);
      continue;
    }
    say(n.watched === watched, `[${net}] the block read for ${n.watched}${n.watched === watched ? "" : `, not ${watched}`}`);
    const codes = pair.map((u) => n.code?.[u]);
    for (const [i, c] of codes.entries()) {
      say(c?.sha256 === PIN_SHA256 && c?.hash === PIN, `[${net}] ${pair[i]} view_code of ${token}: sha256 ${show(c?.sha256)}, hash ${show(c?.hash)} is the pin`);
      const missing = [...METHODS.filter((m) => !c?.exports?.includes(m)), ...STRINGS.filter((s) => !c?.strings?.includes(s))];
      say(missing.length === 0, `[${net}] ${pair[i]} the wasm exports ${METHODS.join(", ")} and holds the event names and the paused panic${missing.length ? `; missing ${show(missing)}` : ""}`);
    }
    say(codes[0]?.sha256 !== undefined && codes[0]?.sha256 === codes[1]?.sha256, `[${net}] both providers serve the same code`);
    const at = [];
    for (const u of pair) {
      const s = n.state?.[u];
      const halt = haltOf(s?.halt);
      say(halt === false, `[${net}] ${u} ft_balance_of at ${show(s?.halt?.at)}: ${halt === false ? "a balance, not halted" : halt ? "FiatToken: paused, halted" : `not known ${show(s?.halt)}`}`);
      say(s?.blocked?.answer === "false" && s?.blocked?.at === s?.halt?.at, `[${net}] ${u} is_blocklisted(${watched}) at the same block: ${show(s?.blocked?.answer ?? s?.blocked)}`);
      say(s?.account?.code_hash === PIN && s?.account?.block_height === s?.halt?.at, `[${net}] ${u} view_account at the same block: code_hash ${show(s?.account?.code_hash)}`);
      at.push(s?.halt?.at);
    }
    say(at.every(Number.isSafeInteger) && Math.abs(at[0] - at[1]) <= MAX_SKEW, `[${net}] the two providers' blocks ${show(at)} within ${MAX_SKEW}`);
    const hr = run.helper?.[net];
    let hb;
    try {
      hb = JSON.parse(hr?.body ?? "");
    } catch {}
    say(hr?.status === 200 && hb?.token === token, `[${net}] helper GET /v1/token-status?token=${token} answers ${show(hr?.status)} for ${show(hb?.token)}`);
    if (CARRIED.includes(net)) {
      say(hb?.caught_up === true && hb.halted === false && hb.vault_blocked === false && hb.code_hash_ok === true && hb.code_hash === PIN, `[${net}] helper: caught_up ${show(hb?.caught_up)}, halted ${show(hb?.halted)}, vault_blocked ${show(hb?.vault_blocked)}, code_hash_ok ${show(hb?.code_hash_ok)}, code_hash the pin`);
      const low = Math.min(...at);
      say(Number.isSafeInteger(hb?.block_height) && hb.block_height > 0 && low - hb.block_height <= MAX_LAG, `[${net}] helper's block ${show(hb?.block_height)} at most ${MAX_LAG} behind the providers' ${show(low)}`);
    } else {
      say(hb?.caught_up === false && hb.halted === null && hb.vault_blocked === null && hb.code_hash_ok === null, `[${net}] helper, not carried yet: caught_up ${show(hb?.caught_up)}, halted, vault_blocked and code_hash_ok null`);
    }
  }
  // the probe: the halt seen once, on FastNEAR's testnet archive, by the watch's own rule
  const pr = run.probe;
  for (const t of PROBE.txs) {
    const r = pr?.txs?.[t.hash];
    say(r?.final === "FINAL" && r?.ok === true, `[testnet] ${PROBE.archive} ${t.what} ${t.hash}: ${show(r?.final)}, ${r?.ok ? "succeeded" : show(r?.status)}`);
  }
  for (const [name, h, want] of [["Pause", PROBE.paused, [false, true]], ["Unpause", PROBE.open, [true, false]]]) {
    const b = pr?.blocks?.[h];
    const pair = [b?.before, b?.at];
    const halts = pair.map((o) => haltOf(o));
    const ofBlock = b?.height === h && b?.before?.block_hash === b?.prev_hash && b?.at?.block_hash === b?.hash;
    const pinned = b?.code?.before === PIN && b?.code?.at === PIN;
    say(ofBlock && pinned && halts[0] === want[0] && halts[1] === want[1] && pausedFrom(pair, pair) === true, `[testnet] ${PROBE.archive} the ${name}'s block ${h}: ft_balance_of(${PROBE.holder}) at its parent ${halts[0] ? "halted" : halts[0] === false ? "open" : "not known"}, at the block ${halts[1] ? "halted" : halts[1] === false ? "open" : "not known"}; the pin at both ${pinned}; answers of the blocks asked ${ofBlock}; pausedAt ${show(pausedFrom(pair, pair))}`);
  }
  // mainnet: a view at a height equals the event history
  const h = run.history;
  const bl = h?.indexer?.blocklist ?? [];
  const ub = h?.indexer?.unblocklist ?? [];
  const who = HISTORY_ACCOUNT;
  say(bl.length === 1 && ub.length === 1 && bl[0].account === who && ub[0].account === who && bl[0].height < ub[0].height, `[mainnet] the indexer lists one blocklist ${show(bl[0]?.height)} and one unblocklist ${show(ub[0]?.height)} of ${who}`);
  for (const [name, rec] of [["blocklist", bl[0]], ["unblocklist", ub[0]]]) {
    const log = h?.logs?.[name];
    let ev;
    try {
      ev = JSON.parse(String(log?.log ?? "").replace(/^EVENT_JSON:/, ""));
    } catch {}
    say(log?.executor === USDC && ev?.standard === "x-fiat-token" && ev?.event === name && ev?.data?.account_id === who && log?.receipt_id === rec?.receipt_id, `[mainnet] ${ARCHIVAL} the ${name} receipt ${show(rec?.receipt_id)} logs ${show(log?.log)}`);
  }
  const want = bl[0] && ub[0] ? [[bl[0].height - 1, "false"], [bl[0].height, "true"], [ub[0].height - 1, "true"], [ub[0].height, "false"]] : [];
  const views = h?.views ?? [];
  say(want.length === 4 && want.every(([ht, v]) => views.some((x) => x.at === ht && x.answer === v)), `[mainnet] is_blocklisted read at ${show(want.map((w) => w[0]))} answers ${show(want.map((w) => w[0]).map((ht) => views.find((x) => x.at === ht)?.answer))}, the history's ${show(want.map((w) => w[1]))}`);
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

async function post(fetchFn, url, method, params, sleep) {
  for (let i = 0; ; i++) {
    const r = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(30000),
    });
    if (r.status === 429 && i < 3) {
      const after = Number(r.headers?.get?.("retry-after") ?? 10);
      if (!(after <= RATE_CAP_S)) throw new Error(`${url} rate limited, Retry-After ${after} s`);
      await sleep(Math.max(after, 1) * 1000);
      continue;
    }
    const j = await r.json();
    await sleep(GAP_MS);
    return j;
  }
}

async function get(fetchFn, url, sleep) {
  for (let i = 0; ; i++) {
    const r = await fetchFn(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
    if (r.status === 429 && i < 3) {
      await sleep(Math.min(Number(r.headers?.get?.("retry-after") ?? 60), RATE_CAP_S) * 1000);
      continue;
    }
    if (r.status !== 200) throw new Error(`${url} answered ${r.status}`);
    const j = await r.json();
    await sleep(10_000); // the indexer's keyless tier: a few calls a minute
    return j;
  }
}

const call = (token, method, args, at) => ({ request_type: "call_function", ...at, account_id: token, method_name: method, args_base64: b64(args) });

/** Everything the check reads; the code is kept as its digest, never its 321 KB. */
export async function read(fetchFn = fetch, sleep = wait, base = BASE) {
  const run = { readAt: new Date().toISOString(), base, helper: {}, nets: {}, history: {}, probe: { txs: {}, blocks: {} } };
  for (const [net, { token, pair, watched }] of Object.entries(NETS)) {
    // the helper's answer first, so the providers' final reads after it bound how far it trails
    const r = await fetchFn(`${base.replace(/\/$/, "")}/v1/token-status?token=${encodeURIComponent(token)}`, { method: "GET", redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" }, signal: AbortSignal.timeout(30000) });
    run.helper[net] = { status: r.status, body: (await r.text()).slice(0, 4096) };
    const n = (run.nets[net] = { watched, code: {}, state: {} });
    // the two final reads first, back to back, so their blocks compare; then each provider's reads at its own block
    for (const u of pair) n.state[u] = { halt: viewOutcome(await post(fetchFn, u, "query", call(token, "ft_balance_of", { account_id: watched }, { finality: "final" }), sleep)) };
    for (const u of pair) {
      const s = n.state[u];
      if (Number.isSafeInteger(s.halt.at)) {
        s.blocked = viewOutcome(await post(fetchFn, u, "query", call(token, "is_blocklisted", { account_id: watched }, { block_id: s.halt.at }), sleep));
        const a = (await post(fetchFn, u, "query", { request_type: "view_account", block_id: s.halt.at, account_id: token }, sleep))?.result;
        s.account = { code_hash: a?.code_hash, block_height: a?.block_height };
      }
    }
    for (const u of pair) {
      const c = (await post(fetchFn, u, "query", { request_type: "view_code", finality: "final", account_id: token }, sleep))?.result;
      if (c?.code_base64) {
        const wasm = Buffer.from(c.code_base64, "base64");
        let exports = [];
        try {
          exports = WebAssembly.Module.exports(new WebAssembly.Module(wasm)).map((e) => e.name);
        } catch {}
        const text = wasm.toString("latin1");
        n.code[u] = { hash: c.hash, block_height: c.block_height, bytes: wasm.length, sha256: createHash("sha256").update(wasm).digest("hex"), exports: METHODS.filter((m) => exports.includes(m)), strings: STRINGS.filter((s) => text.includes(s)) };
      } else n.code[u] = { error: JSON.stringify(c ?? null).slice(0, 200) };
    }
  }
  const h = run.history;
  h.indexer = {};
  const rec = {};
  for (const m of ["blocklist", "unblocklist"]) {
    const j = await get(fetchFn, `${INDEXER}/account/${USDC}/receipts?method=${m}&per_page=25`, sleep);
    h.indexer[m] = (j?.txns ?? []).map((t) => {
      let account;
      try {
        account = JSON.parse(t.actions?.find((x) => x.method === m)?.args ?? "null")?.account_id;
      } catch {}
      return { height: t.receipt_block?.block_height, receipt_id: t.receipt_id, tx: t.transaction_hash, signer: t.predecessor_account_id, account, ok: t.receipt_outcome?.status };
    });
    rec[m] = h.indexer[m][0];
  }
  h.logs = {};
  for (const m of ["blocklist", "unblocklist"]) {
    const r = rec[m];
    if (!r) continue;
    const st = (await post(fetchFn, ARCHIVAL, "EXPERIMENTAL_tx_status", { tx_hash: r.tx, sender_account_id: r.signer, wait_until: "NONE" }, sleep))?.result;
    const o = st?.receipts_outcome?.find((x) => x.id === r.receipt_id);
    h.logs[m] = { receipt_id: o?.id, executor: o?.outcome?.executor_id, log: o?.outcome?.logs?.find((l) => l.includes("x-fiat-token")) };
  }
  h.views = [];
  if (rec.blocklist && rec.unblocklist) {
    for (const at of [rec.blocklist.height - 1, rec.blocklist.height, rec.unblocklist.height - 1, rec.unblocklist.height]) {
      h.views.push(viewOutcome(await post(fetchFn, ARCHIVAL, "query", call(USDC, "is_blocklisted", { account_id: HISTORY_ACCOUNT }, { block_id: at }), sleep)));
    }
  }
  // the probe on FastNEAR's testnet archive: each transaction's outcome; each switch block's header, then ft_balance_of
  // and the code at its parent and at it, by hash, each answer kept with the block hash it names
  for (const t of PROBE.txs) {
    const st = (await post(fetchFn, PROBE.archive, "EXPERIMENTAL_tx_status", { tx_hash: t.hash, sender_account_id: t.signer, wait_until: "NONE" }, sleep))?.result;
    run.probe.txs[t.hash] = { final: st?.final_execution_status, ok: st?.status !== undefined && Object.hasOwn(st.status, "SuccessValue"), status: st?.status };
  }
  for (const h of [PROBE.paused, PROBE.open]) {
    const head = (await post(fetchFn, PROBE.archive, "block", { block_id: h }, sleep))?.result?.header;
    const b = (run.probe.blocks[h] = { height: head?.height, hash: head?.hash, prev_hash: head?.prev_hash, code: {} });
    if (typeof head?.hash !== "string" || typeof head?.prev_hash !== "string") continue;
    for (const [k, id] of [["before", head.prev_hash], ["at", head.hash]]) {
      const j = await post(fetchFn, PROBE.archive, "query", call(PROBE.token, "ft_balance_of", { account_id: PROBE.holder }, { block_id: id }), sleep);
      b[k] = { ...viewOutcome(j), block_hash: j?.result?.block_hash };
      b.code[k] = (await post(fetchFn, PROBE.archive, "query", { request_type: "view_account", block_id: id, account_id: PROBE.token }, sleep))?.result?.code_hash;
    }
  }
  return run;
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = await read(fetch, wait, opt("--base", BASE));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { ok, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"}`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
