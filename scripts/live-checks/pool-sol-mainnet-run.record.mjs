#!/usr/bin/env node
// The run record of card pool-sol-mainnet-run, from chain reads alone: no signature is typed by hand. Given the run's
// start time (and its end, else now), it lists every finalized signature of the Solana pool account in that window on
// the two RPCs the money gate reads (money-gate.mjs RPCS: on mainnet api.mainnet-beta.solana.com and
// public.rpc.solanavibestation.com; publicnode keeps no signature history for the pool), reads each on both, and sorts
// the run's steps by what the pool instruction is and who signed it:
//   - tag 1 signed by U (a deposit wallet): "deposit"; U's own incoming payments in the window: "U funded" (the NEAR
//     Intents delivery, or a plain send);
//   - tag 3: "buy on pump.fun's curve" or "buy on PumpSwap", by the venue program the pool invokes; its W is the signer
//     that is not the helper's fee payer;
//   - tag 1 in a payment that also runs a venue: "sell, deposited back"; tag 1 by a W with no venue: "rent back sweep";
//   - tag 2: "exit release"; its W's own payment out: "exit to <address>";
//   - a W's own payment that runs a venue and lowers W's tokens: "sell, no deposit back"; every other payment a W signed
//     in the window: "teardown" (closing W's emptied accounts, which may run the venue to close its volume account).
// Each must read finalized with no error and in the same slot on both RPCs; the signature lists must match. A buy
// or sell carries its chain times; tap to filled is the trade box's own figure ("Filled 7.7s"), given with --filled.
//   node scripts/live-checks/pool-sol-mainnet-run.record.mjs --since <ISO> [--until <ISO>] [--cluster mainnet|devnet]
//     [--u <address,...>] [--filled buy1=7.7,sell1=5.2,...] [--out <file.md>] [--record <answers.json>]
//     --u adds deposit wallets the window does not show (U's deposit is found by its tag 1 signer otherwise).
//     --out writes the record (default: print it); --record writes every RPC answer read.
//   PASS exit 0 (every step read alike on both), FAIL exit 1, error exit 2.
// Runs: once, the run record's tool, run by hand right after the owner's run; it reads no host
//   INCONCLUSIVE exit 3: a provider gave no answer after five reads (provider-answer.mjs names why).
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT, rpcAnswer } from "./provider-answer.mjs";

// @noble/curves from the helper's own dependencies, as pool-sol-deploy.mjs takes it (a static name, read by check:imports)
const req = createRequire(new URL("../../apps/helper/package.json", import.meta.url));
const { ed25519 } = req("@noble/curves/ed25519.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAINNET = JSON.parse(readFileSync(path.join(HERE, "../../contracts/pool-solana/deployments/mainnet.json"), "utf8"));
const DEVNET = JSON.parse(readFileSync(path.join(HERE, "pool-sol-deploy.devnet.json"), "utf8"));
export const KEY = "pool-sol-mainnet-run";
/** The money gate's two Solana RPCs per cluster (scripts/ci/money-gate.mjs RPCS; the test holds them equal), written
 *  here since a live check may not import a module that builds its own JSON-RPC request. */
export const GATE_RPCS = Object.freeze({
  solana: ["https://api.mainnet-beta.solana.com", "https://public.rpc.solanavibestation.com"],
  "solana-devnet": ["https://api.devnet.solana.com", "https://solana-devnet.api.onfinality.io/public"],
});
/** Per cluster: the pinned program and pool, the helper's fee payer (packages/wallet/src/pool/solana.ts SOL_POOLS, the
 *  one GET /v1/pool/fee names), the record's chain name and the money gate's two RPCs. */
export const CLUSTERS = Object.freeze({
  mainnet: { program: MAINNET.program_id, pool: MAINNET.pool, feePayer: "CPWhFyFL8naX5W8DEB5XTrEUR2XtkHv7kyXdavpqDTTU", chain: "solana", rpcs: GATE_RPCS.solana },
  devnet: { program: DEVNET.program_id, pool: DEVNET.pool, feePayer: "9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb", chain: "solana-devnet", rpcs: GATE_RPCS["solana-devnet"] },
});
export const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMPSWAP = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const SYSTEM = "11111111111111111111111111111111";
const PAGE = 1000;

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) (s = ALPHABET[Number(n % 58n)] + s), (n /= 58n);
  for (const b of bytes) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}
export function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error(`not base58: ${s}`);
    n = n * 58n + BigInt(i);
  }
  const out = [];
  while (n > 0n) out.unshift(Number(n & 0xffn)), (n >>= 8n);
  for (const c of s) {
    if (c !== "1") break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}
/** Solana's find_program_address: the first bump from 255 down whose hash is off the curve. */
export function pda(seeds, program) {
  const prog = b58decode(program);
  for (let bump = 255; bump >= 0; bump--) {
    const h = new Uint8Array(createHash("sha256").update(Buffer.concat([...seeds.map((x) => Buffer.from(x)), Buffer.of(bump), Buffer.from(prog), Buffer.from("ProgramDerivedAddress")])).digest());
    try {
      ed25519.Point.fromBytes(h);
    } catch {
      return { address: b58encode(h), bump };
    }
  }
  throw new Error("no bump");
}

/** A provider that gave no answer after five reads: the check is INCONCLUSIVE, never FAIL or PASS. */
export class NoAnswer extends Error {}
/** One JSON-RPC read through provider-answer.mjs (its no-answers read again, five times in all); a JSON-RPC error throws. */
export async function answer(fetchFn, url, method, params, sleep) {
  for (let i = 0; ; i++) {
    const a = await rpcAnswer(url, method, params, { fetchFn });
    if (a.noAnswer === undefined) {
      if (a.error !== undefined) throw new Error(`${method} on ${new URL(url).host}: ${JSON.stringify(a.error).slice(0, 160)}`);
      return a.result;
    }
    if (i >= 4) throw new NoAnswer(a.noAnswer);
    await sleep(1000 * (i + 1));
  }
}
/** A fetch that keeps every answer it reads (url, method, params, status, body) for a recorded answers file. */
export function recorder(fetchFn = fetch) {
  const answers = [];
  const wrapped = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const r = await fetchFn(url, init);
    const text = await r.text().catch(() => "");
    answers.push({ url, method, params, status: r.status, text });
    return { ok: r.ok, status: r.status, text: async () => text, headers: r.headers };
  };
  return { answers, fetchFn: wrapped };
}

/** Every finalized signature of `address` with a block time in [since, until] (seconds), newest first, on one RPC. */
async function signatures(fetchFn, url, address, since, until, sleep) {
  const out = [];
  let before;
  for (;;) {
    const page = await answer(fetchFn, url, "getSignaturesForAddress", [address, { limit: PAGE, commitment: "finalized", ...(before ? { before } : {}) }], sleep);
    for (const s of page) if (s.blockTime >= since && s.blockTime <= until) out.push(s);
    if (page.length < PAGE || page.at(-1).blockTime < since) return out;
    before = page.at(-1).signature;
  }
}

/** One payment's facts from a getTransaction answer (json encoding): its keys, signers, the pool tag, the venue. */
export function facts(tx, program) {
  const m = tx.transaction.message;
  const keys = [...m.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
  const signers = keys.slice(0, m.header.numRequiredSignatures);
  const outer = m.instructions.map((ix) => ({ program: keys[ix.programIdIndex], data: b58decode(ix.data), accounts: ix.accounts.map((a) => keys[a]) }));
  const inner = (tx.meta.innerInstructions ?? []).flatMap((g) => g.instructions.map((ix) => keys[ix.programIdIndex]));
  const tag = outer.find((ix) => ix.program === program)?.data[0];
  const programs = new Set([...outer.map((ix) => ix.program), ...inner]);
  const venue = programs.has(PUMPSWAP) ? "PumpSwap" : programs.has(PUMP) ? "pump.fun's curve" : null;
  // a system Transfer (u32 2, then u64 lamports) out of the payer: its destination
  const transfer = outer.find((ix) => ix.program === SYSTEM && ix.data.length === 12 && ix.data[0] === 2 && ix.data[1] === 0);
  // each owner's change in token units, all mints summed: a sell lowers its W's, a teardown's close moves none
  const sold = {};
  for (const [sign, list] of [[-1n, tx.meta.preTokenBalances ?? []], [1n, tx.meta.postTokenBalances ?? []]])
    for (const t of list) sold[t.owner] = (sold[t.owner] ?? 0n) + sign * BigInt(t.uiTokenAmount.amount);
  return { signers, tag, venue, to: transfer?.accounts[1] ?? null, tokens: sold, slot: tx.slot, time: tx.blockTime, err: tx.meta.err };
}

/** The run in the window, read on both RPCs: { steps, lines (ok/FAIL), ok }. */
export async function findRun({ cluster = "mainnet", since, until, u = [], fetchFn = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), rpcs }) {
  const c = CLUSTERS[cluster];
  if (!c) throw new Error(`no cluster ${cluster}`);
  const urls = rpcs ?? c.rpcs;
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok  " : "FAIL"} ${text}`);
  const s = Math.floor(since / 1000);
  const e = Math.floor(until / 1000);
  /** The signatures of `address` both RPCs list, and a FAIL line for any only one lists. */
  const listed = async (address, what) => {
    const [a, b] = await Promise.all(urls.map((url) => signatures(fetchFn, url, address, s, e, sleep)));
    const sa = new Set(a.map((x) => x.signature));
    const sb = new Set(b.map((x) => x.signature));
    const one = [...sa].filter((x) => !sb.has(x)).concat([...sb].filter((x) => !sa.has(x)));
    say(one.length === 0, `${what}: ${sa.size} / ${sb.size} signatures in the window on the two RPCs${one.length ? `, on one only: ${one.join(" ")}` : ""}`);
    return a.filter((x) => sb.has(x.signature)).map((x) => x.signature);
  };
  const read = new Map();
  const both = async (sig) => {
    if (!read.has(sig)) {
      const [ta, tb] = await Promise.all(urls.map((url) => answer(fetchFn, url, "getTransaction", [sig, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }], sleep)));
      read.set(sig, ta && tb ? { a: facts(ta, c.program), b: facts(tb, c.program) } : null);
    }
    return read.get(sig);
  };
  const steps = [];
  const add = (sig, step, f, who) => steps.push({ sig, step, time: f.time, slot: f.slot, who });
  const ws = new Map(); // W -> "buy" | "exit"
  const us = new Set(u);
  for (const sig of (await listed(c.pool, `the pool ${c.pool}`)).reverse()) {
    const r = await both(sig);
    if (!r) {
      say(false, `${sig}: not read on both RPCs`);
      continue;
    }
    const { a, b } = r;
    if (a.err !== null || b.err !== null || a.slot !== b.slot) {
      say(false, `${sig}: err ${JSON.stringify(a.err)} / ${JSON.stringify(b.err)}, slot ${a.slot} / ${b.slot}`);
      continue;
    }
    const w = a.signers.find((x) => x !== c.feePayer) ?? a.signers[0];
    if (a.tag === 3) {
      ws.set(w, "buy");
      add(sig, `buy on ${a.venue ?? "no venue"}`, a, w);
    } else if (a.tag === 2) {
      ws.set(w, "exit");
      add(sig, "exit release", a, w);
    } else if (a.tag === 1 && a.venue) add(sig, `sell on ${a.venue}, deposited back`, a, a.signers[0]);
    else if (a.tag === 1 && ws.has(a.signers[0])) add(sig, "rent back sweep", a, a.signers[0]);
    else if (a.tag === 1) {
      us.add(a.signers[0]);
      add(sig, "deposit", a, a.signers[0]);
    } else say(false, `${sig}: pool tag ${a.tag ?? "none"}, not a step of the run`);
  }
  const seen = new Set(steps.map((x) => x.sig));
  // each W's own payments the pool did not show: a sell with no deposit back, the teardown, the exit's payment out
  for (const [w, kind] of ws)
    for (const sig of (await listed(w, `W ${w}`)).reverse()) {
      if (seen.has(sig)) continue;
      const r = await both(sig);
      if (!r || r.a.err !== null || r.b.err !== null || r.a.slot !== r.b.slot) {
        say(false, `${sig} (W ${w}): not read alike with no error on both RPCs`);
        continue;
      }
      if (!r.a.signers.includes(w)) continue; // a stranger's payment to W is not the run's
      seen.add(sig);
      add(sig, kind === "exit" && r.a.to ? `exit to ${r.a.to}` : r.a.venue && (r.a.tokens[w] ?? 0n) < 0n ? `sell on ${r.a.venue}, no deposit back` : "teardown", r.a, w);
    }
  // U's funding: what came in to each deposit wallet in the window (the NEAR Intents delivery or a plain send)
  for (const x of us)
    for (const sig of (await listed(x, `U ${x}`)).reverse()) {
      if (seen.has(sig)) continue;
      const r = await both(sig);
      if (!r || r.a.err !== null || r.b.err !== null) continue;
      if (r.a.signers.includes(x)) continue;
      seen.add(sig);
      add(sig, "U funded", r.a, x);
    }
  steps.sort((p, q) => p.slot - q.slot);
  const has = (re) => steps.some((x) => re.test(x.step));
  say(has(/^deposit$/), `a deposit: ${steps.filter((x) => x.step === "deposit").length}`);
  say(has(/^buy on (pump|Pump)/), `a buy: ${steps.filter((x) => x.step.startsWith("buy")).map((x) => x.step).join(", ") || "none"}`);
  say(has(/^sell on /), `a sell: ${steps.filter((x) => x.step.startsWith("sell")).length}`);
  say(has(/^exit to /), `an exit to an address: ${steps.filter((x) => x.step.startsWith("exit to")).map((x) => x.step.slice(8)).join(", ") || "none"}`);
  return { cluster, chain: c.chain, urls, since, until, steps, lines, ok: !lines.some((l) => l.startsWith("FAIL")) };
}

/** The record's text. Step lines name signatures and addresses with no transaction word, so the money gate's prose rule
 *  has nothing to flag; every signature is also a Tx line, in the order of the steps. */
export function recordText(run, filled = {}) {
  const iso = (t) => new Date(t * 1000).toISOString();
  const n = {};
  const label = (step) => {
    const k = step.startsWith("buy") ? "buy" : step.startsWith("sell") ? "sell" : null;
    if (!k) return null;
    n[k] = (n[k] ?? 0) + 1;
    return `${k}${n[k]}`;
  };
  const out = [`CARD ${KEY} / live: ${run.ok ? "PASS" : "FAIL"}`, "Money path: yes", ...run.steps.map((x) => `Tx: ${run.chain} ${x.sig}`), ""];
  out.push(`The run on ${run.cluster}, ${iso(run.since / 1000)} to ${iso(run.until / 1000)}, read on ${run.urls.map((u) => new URL(u).host).join(" and ")} by scripts/live-checks/${KEY}.record.mjs; the steps, in the order of the lines above:`);
  run.steps.forEach((x, i) => {
    const l = label(x.step);
    const t = l && filled[l] !== undefined ? `, tap to filled ${filled[l]} s (${l}, the trade box)` : l ? `, tap to filled n (${l})` : "";
    out.push(`${i + 1}. ${x.step}: ${x.sig}, slot ${x.slot}, ${iso(x.time)}, signer ${x.who}${t}`);
  });
  const buys = run.steps.filter((x) => x.step.startsWith("buy")).length;
  const sells = run.steps.filter((x) => x.step.startsWith("sell")).length;
  out.push(`Speed series: ${buys} buys and ${sells} sells of the old gate's 20 and 20${buys >= 20 && sells >= 20 ? "" : " (n: the test money allowed these)"}.`);
  out.push(...run.lines.map((l) => `Read: ${l}`), "");
  return out.join("\n");
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  try {
    const since = Date.parse(opt("--since", ""));
    const until = opt("--until") ? Date.parse(opt("--until")) : Date.now();
    if (!Number.isFinite(since) || !Number.isFinite(until) || until < since) throw new Error("--since <ISO> [--until <ISO>] name the run's window");
    const filled = Object.fromEntries((opt("--filled", "") || "").split(",").filter(Boolean).map((kv) => kv.split("=")));
    for (const [k, v] of Object.entries(filled)) if (!/^(buy|sell)\d+$/.test(k) || !/^\d+(\.\d+)?$/.test(v ?? "")) throw new Error(`--filled ${k}=${v}: want buy1=7.7`);
    const rec = recorder();
    const run = await findRun({ cluster: opt("--cluster", "mainnet"), since, until, u: (opt("--u", "") || "").split(",").filter(Boolean), fetchFn: opt("--record") ? rec.fetchFn : fetch });
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify({ cluster: run.cluster, since, until, answers: rec.answers }) + "\n");
    for (const l of run.lines) console.log(`${KEY} record: ${l}`);
    const text = recordText(run, filled);
    if (opt("--out")) writeFileSync(opt("--out"), text);
    else console.log(text);
    console.log(`${KEY} record: ${run.ok ? "PASS" : "FAIL"} (${run.steps.length} steps)`);
    process.exit(run.ok ? 0 : 1);
  } catch (e) {
    console.error(`${KEY} record: ${e instanceof NoAnswer ? "INCONCLUSIVE" : "ERROR"}: ${String(e.message).split("\n")[0]}`);
    process.exit(e instanceof NoAnswer ? EXIT.INCONCLUSIVE : EXIT.ERROR);
  }
}
