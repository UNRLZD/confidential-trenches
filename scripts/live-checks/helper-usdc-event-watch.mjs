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
//     is_blocklisted of the watched account answers false, and view_account names the pin; the two providers' blocks
//     are within MAX_SKEW of each other;
// and on mainnet, that a view at a height equals the event history: the indexer's list of USDC's blocklist and
// unblocklist receipts (NearBlocks) holds the one pair, each receipt's log on the archival provider is that x-fiat-token
// event for the same account, and is_blocklisted of that account reads false, true, true, false at the blocklist's block
// less one, its block, the unblocklist's block less one and its block (a view at block h includes h's receipts).
//   node scripts/live-checks/helper-usdc-event-watch.mjs [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const KEY = "helper-usdc-event-watch";
export const PIN = "DVJx7F3dHEHJYwpYPwXHu8K9Uo7h4kXFcALucY5oNX8q";
export const PIN_SHA256 = "b98ccd530f7e643cfef32f4529ade060ef87ff73b0101536399470777b86cfe6"; // the pin is base58 of it
export const MAX_SKEW = 30; // blocks between the two providers' final answers (about 18 s): more is a provider behind
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
/** Per network: the token, its two providers (two operators, scripts/ci/near-rpc-operators.mjs), the account whose block is read. */
export const NETS = {
  mainnet: {
    token: USDC,
    pair: ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"],
    // no mainnet vault yet: the one account USDC ever blocklisted, unblocklisted since (the history read below)
    watched: "da179a3b4754fa92c637a90533071075142fd931dcd4987e8f362dedc6e0087d",
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

/** A view's outcome: { at, answer } for a value, { at, panic } for a panic, { error } for anything else. */
export function viewOutcome(j) {
  const r = j?.result;
  if (r && Array.isArray(r.result)) return { at: r.block_height, answer: Buffer.from(r.result).toString("utf8") };
  const text = JSON.stringify(j?.error ?? r?.error ?? j ?? null);
  const m = /GuestPanic \{ panic_msg: \\*"([^"\\]*)/.exec(text) ?? /Smart contract panicked: ([^"\\]*)/.exec(text);
  if (m) return { at: r?.block_height ?? j?.error?.cause?.info?.block_height, panic: m[1] };
  return { error: text.slice(0, 200) };
}

/** The halt as one ft_balance_of answer says it: false for a balance, true for the paused panic, null for anything else. */
export const haltOf = (o) => (o?.answer !== undefined && /^"\d+"$/.test(o.answer) ? false : o?.panic === "FiatToken: paused" ? true : null);

export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  for (const [net, { token, pair, watched }] of Object.entries(NETS)) {
    const n = run.nets?.[net];
    if (!n) {
      say(false, `[${net}] not read`);
      continue;
    }
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
  }
  // mainnet: a view at a height equals the event history
  const h = run.history;
  const bl = h?.indexer?.blocklist ?? [];
  const ub = h?.indexer?.unblocklist ?? [];
  const who = NETS.mainnet.watched;
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
export async function read(fetchFn = fetch, sleep = wait) {
  const run = { readAt: new Date().toISOString(), nets: {}, history: {} };
  for (const [net, { token, pair, watched }] of Object.entries(NETS)) {
    const n = (run.nets[net] = { code: {}, state: {} });
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
      h.views.push(viewOutcome(await post(fetchFn, ARCHIVAL, "query", call(USDC, "is_blocklisted", { account_id: NETS.mainnet.watched }, { block_id: at }), sleep)));
    }
  }
  return run;
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = await read();
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
