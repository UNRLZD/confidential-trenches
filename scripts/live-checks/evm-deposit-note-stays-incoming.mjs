#!/usr/bin/env node
// Live check of card evm-deposit-note-stays-incoming: every state read of the signing page's EVM pool deposit
// (packages/signpage/src/pool-deposit-evm.ts) is one the page's own providers answer. Robinhood is Arbitrum Nitro, whose
// public nodes keep about 10 to 24 s of state: U's nonce at "finalized" is refused there with -32000 "historical state
// ... is not available", so a deposit whose verdict read it never settled. The path now reads state only at the newest
// block both RPCs hold, and block headers. On each chain's pool pair as the deployed page seats it (the kit's
// evmPoolProvidersOf(evmPoolVenues()[chain]), which test/pool-restore.test.ts holds equal to the page's
// MAINNET_POOL_RPCS), read now, with the pool's own public address standing in for U (no user's wallet is named):
//   - the newest block both hold: eth_getBlockByNumber "latest" on both, the lower read by number on both, one hash;
//   - the price's reads at that block by number (accountReads): eth_getTransactionCount and eth_getBalance;
//   - the dead-send judgment's (spentFinal): eth_getTransactionCount at that block's hash (EIP-1898), the "finalized"
//     header on both at or below that block, and the header at the lower finalized number with one hash on both.
// Each must answer a well-formed value on both seats. A seat that refuses one (a state miss is judged a wrong answer,
// judgeStateMiss) fails the check; a seat that answers nothing usable on its last try makes it INCONCLUSIVE.
// After: sign
//   node scripts/live-checks/evm-deposit-note-stays-incoming.mjs [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3
// --record writes every answer read as the good run, and as the bad run a real run of the read the path made before
// (U's nonce at "finalized"), which Robinhood's providers refuse.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evmPoolProvidersOf, evmPoolVenues } from "../../packages/kit/src/index.ts";
import { EXIT, rpcAnswer } from "./provider-answer.mjs";

const KEY = "evm-deposit-note-stays-incoming";
export const CHAINS = Object.freeze({ base: "0x2105", robinhood: "0x1237" });
const TRIES = 3;
const QTY = /^0x[0-9a-fA-F]{1,64}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

/** Each chain's pool pair as the page seats it, and the public address read in U's place. */
export function pagePairs() {
  return Object.keys(CHAINS).map((chain) => {
    const v = evmPoolVenues()[chain];
    return { chain, seats: [...(evmPoolProvidersOf(v) ?? [])].slice(0, 2), address: (v.pool ?? v.poolManager).toLowerCase() };
  });
}

export const post = (url, method, params) => rpcAnswer(url, method, params, { timeoutMs: 20_000, judgeStateMiss: true });
export function recorder() {
  const log = [];
  const transport = async (url, method, params) => {
    const a = await post(url, method, params);
    log.push({ url, method, params, ...a });
    return a;
  };
  return { transport, log };
}
/** Replays each call's recorded answers in order (past the last, the last again); an unrecorded call is a no-answer. */
export function replayer(log) {
  const queues = new Map();
  for (const e of log) {
    const k = JSON.stringify([e.url, e.method, e.params]);
    if (!queues.has(k)) queues.set(k, []);
    queues.get(k).push(e);
  }
  return async (url, method, params) => {
    const q = queues.get(JSON.stringify([url, method, params]));
    const e = q?.length > 1 ? q.shift() : q?.[0];
    if (e === undefined) return { noAnswer: `${new URL(url).host}: no recorded answer to ${method} ${JSON.stringify(params)}` };
    return "noAnswer" in e ? { noAnswer: e.noAnswer } : "error" in e ? { error: e.error } : { result: e.result };
  };
}

class ReadFailed extends Error {
  constructor(message, quiet) {
    super(message);
    this.quiet = quiet;
  }
}
const host = (u) => new URL(u).host;
async function ask(transport, url, method, params, what) {
  let a;
  for (let t = 1; t <= TRIES; t++) {
    a = await transport(url, method, params);
    if (a?.noAnswer === undefined && a?.error === undefined) return a?.result;
  }
  if (a.noAnswer !== undefined) throw new ReadFailed(`${what}: no answer: ${a.noAnswer}`, true);
  throw new ReadFailed(`${host(url)}: ${what}: RPC error ${a.error?.code}: ${a.error?.message ?? JSON.stringify(a.error)}`, false);
}
const qty = (x, what) => {
  if (typeof x !== "string" || !QTY.test(x)) throw new Error(`${what}: not a quantity: ${JSON.stringify(x)}`);
  return BigInt(x);
};
const header = (x, what) => {
  if (typeof x?.hash !== "string" || !HASH.test(x.hash)) throw new Error(`${what}: not a block`);
  return { number: qty(x.number, `${what} number`), hash: x.hash.toLowerCase() };
};
const hx = (n) => `0x${n.toString(16)}`;

/** The deposit path's reads on one pair (`before`: the read the path made before this card, U's nonce at "finalized"). */
async function pairReads(transport, { chain, seats, address }, before) {
  const lines = [];
  const both = (f) => Promise.all(seats.map((u, k) => f(u, k)));
  for (const u of seats) {
    const id = await ask(transport, u, "eth_chainId", [], "eth_chainId");
    if (typeof id !== "string" || id.toLowerCase() !== CHAINS[chain]) throw new Error(`${host(u)}: eth_chainId ${JSON.stringify(id)}, not ${CHAINS[chain]}`);
  }
  if (before) {
    const n = await both(async (u) => qty(await ask(transport, u, "eth_getTransactionCount", [address, "finalized"], "U's nonce at finalized"), `${host(u)}: U's nonce at finalized`));
    lines.push(`${chain}: U's nonce at finalized answered on both (${n.join(", ")})`);
    return lines;
  }
  const tops = await both(async (u) => header(await ask(transport, u, "eth_getBlockByNumber", ["latest", false], "the latest block"), `${host(u)}: the latest block`));
  const n = tops[0].number < tops[1].number ? tops[0].number : tops[1].number;
  const at = await both(async (u) => header(await ask(transport, u, "eth_getBlockByNumber", [hx(n), false], `block ${n}`), `${host(u)}: block ${n}`));
  if (at[0].hash !== at[1].hash) throw new Error(`${chain}: the seats hold different blocks at ${n}`);
  const blk = at[0];
  for (const [method, what] of [["eth_getTransactionCount", "U's nonce"], ["eth_getBalance", "U's balance"]])
    await both(async (u) => qty(await ask(transport, u, method, [address, hx(n)], `${what} at the newest block ${n}`), `${host(u)}: ${what}`));
  await both(async (u) => qty(await ask(transport, u, "eth_getTransactionCount", [address, { blockHash: blk.hash }], `U's nonce at the newest block's hash`), `${host(u)}: U's nonce at the block hash`));
  const fin = await both(async (u) => header(await ask(transport, u, "eth_getBlockByNumber", ["finalized", false], "the finalized header"), `${host(u)}: the finalized header`));
  const low = fin[0].number < fin[1].number ? fin[0].number : fin[1].number;
  if (low > n) throw new Error(`${chain}: a finalized header ${low} above the newest agreed block ${n}`);
  const f = await both(async (u) => header(await ask(transport, u, "eth_getBlockByNumber", [hx(low), false], `block ${low}`), `${host(u)}: block ${low}`));
  if (f[0].hash !== f[1].hash) throw new Error(`${chain}: the seats hold different final blocks at ${low}`);
  lines.push(`${chain} (${seats.map(host).join(", ")}): newest agreed block ${n}; U's nonce and balance at it, U's nonce at its hash, the finalized header ${low} (${n - low} blocks behind) with one hash on both: all answered`);
  return lines;
}

/** The check: { verdict, ok, lines }. */
export async function check(transport, { pairs = pagePairs(), before = false } = {}) {
  const lines = [];
  try {
    for (const p of pairs) {
      if (p.seats.length !== 2) throw new Error(`${p.chain}: the pool list seats ${p.seats.length} providers, not two`);
      lines.push(...(await pairReads(transport, p, before)));
    }
    return { verdict: "PASS", ok: true, lines };
  } catch (e) {
    lines.push(`${e?.message ?? e}`);
    return { verdict: e?.quiet === true ? "INCONCLUSIVE" : "FAIL", ok: false, lines };
  }
}

async function main(argv) {
  const record = argv.includes("--record") ? argv[argv.indexOf("--record") + 1] : undefined;
  const pairs = pagePairs();
  const rec = recorder();
  const r = await check(rec.transport, { pairs });
  for (const l of r.lines) console.log(`${r.verdict} ${l}`);
  if (record) {
    if (r.verdict !== "PASS") throw new Error(`the good run is ${r.verdict}: no good run to record`);
    const bad = recorder();
    const b = await check(bad.transport, { pairs, before: true });
    if (b.verdict !== "FAIL") throw new Error(`the read before is ${b.verdict}, not FAIL: no bad run to record`);
    writeFileSync(record, `${JSON.stringify({ key: KEY, recorded: new Date().toISOString(), good: { pairs, log: rec.log }, before: { pairs, log: bad.log } }, null, 1)}\n`);
    console.log(`recorded ${record}`);
  }
  console.log(`${r.verdict} ${KEY}`);
  return EXIT[r.verdict];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => (console.error(`error: ${e?.stack ?? e}`), process.exit(2)));
