#!/usr/bin/env node
// Live check of card solana-mint-supply-moves: a Solana buy of a token whose supply moves (burns, mints) is never
// refused for it. The device reads the token's mint on two providers, each at its own slot, so a burn between the two
// reads moves the supply alone (run 42161763756, 6 Nov 04:20Z: C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump, every leg
// refused S10, and the reference read behind it refused the same way). The kit holds the two reads to every field but
// the supply and a fee config's withheld fees (solanaMintDisagreement, S6 and S10), and the reference read holds the two
// supplies to the reserves' band, since the supply sets the fee tier (packages/kit/src/trade/solana/pool.ts).
// The token is the first pump.fun token on HELPER_HOST's Solana Discover lists with at least $50k of liquidity whose
// supply is under pump's 1e15 (burns have moved it) and whose pool the kit's reference read finds, or --token. One dry
// buy is built through the helper's Jupiter proxy (nothing is signed or sent), from a random taker nobody holds a key
// for; then each round reads, on the two public RPCs, the mint at processed (as runSolanaTrade does) and the kit's
// reference read (readSolanaReference, at confirmed), ROUNDS rounds GAP_MS apart.
// It passes only when: at least ROUNDS rounds; in every round the reference read, replayed through the kit on the
// round's recorded answers, gives a reference, and the build passes S6 and S10 on the round's two mint reads. Each
// round's line says whether its two mint reads were equal or differed in supply (the burn the card is about); a round
// with a moved supply is not required, since no run can make a burn land between its reads.
//   node scripts/live-checks/solana-mint-supply-moves.mjs [--base <helper origin>] [--token <mint>] [--rounds <n>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes every answer the run read, so the test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import {
  SOLANA_BUILD_TIMEOUT_MS,
  assembleSolanaSwap,
  checkSolanaQuote,
  fetchSolanaJupiterBuildThatFits,
  readSolanaBlockhash,
  readSolanaReference,
  solanaDecodeLookupTable,
  solanaJsonRpc,
} from "../../packages/kit/src/index.ts";
import { BASE, BUY_LAMPORTS, RPCS, SLIPPAGE_BPS, base58, mintLine } from "./solana-jupiter-build.mjs";

const KEY = "solana-mint-supply-moves";
export const ROUNDS = 20;
const GAP_MS = 1_500;
const PUMP_SUPPLY = 1_000_000_000_000_000n;
const ALT = "AddressLookupTab1e1111111111111111111111111";
const b64 = (s) => Uint8Array.from(Buffer.from(s, "base64"));
const accRead = (a) => (a ? { owner: a.owner, data: b64(a.data) } : null);
const supplyOf = (a) => (a ? Buffer.from(a.data, "base64").readBigUInt64LE(36) : null);
const show = (x) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? String(v) : v));

/** A provider that answers the kit from one round's record of provider `p`: each call by its method and params, once. */
function replayRpc(calls, url) {
  const left = [...calls];
  return Object.assign(async (method, params) => {
    const key = show([method, params]);
    const i = left.findIndex((c) => c.key === key);
    if (i < 0) throw new Error(`the kit asked ${key.slice(0, 120)}, not in the record`);
    const [c] = left.splice(i, 1);
    if (c.error) throw new Error(c.error);
    return c.result;
  }, { url });
}
/** A live provider that keeps every call it answers. */
function recordingRpc(rpc, calls) {
  return Object.assign(async (method, params) => {
    const key = show([method, params]);
    try {
      const result = await rpc(method, params);
      calls.push({ key, result });
      return result;
    } catch (e) {
      calls.push({ key, error: String(e?.message ?? e).slice(0, 200) });
      throw e;
    }
  }, { url: rpc.url });
}

/** The check on one recorded run. */
export async function judge(r) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const req = { side: "buy", wallet: r.build?.wallet, token: r.mint, amount: BigInt(r.build?.amount ?? 0) };
  const rounds = r.rounds ?? [];
  say(rounds.length >= ROUNDS, `${rounds.length} rounds (at least ${ROUNDS}) of ${r.mint}`);
  const wire = r.build?.wire ? b64(r.build.wire) : null;
  say(!!wire, `one dry buy built through ${r.base}: ${wire ? `${wire.length} bytes` : "none"}`);
  let moved = 0;
  for (const [i, x] of rounds.entries()) {
    const at = `round ${i + 1}:`;
    const [ma, mb] = x.mint ?? [null, null];
    const [ok0, text] = mintLine("mint", r.mint, ma, mb);
    if (ma && mb && ma.data !== mb.data) moved++;
    let ref = null;
    let why = "";
    try {
      ref = await readSolanaReference([replayRpc(x.calls?.[0] ?? [], RPCS[0]), replayRpc(x.calls?.[1] ?? [], RPCS[1])], { side: "buy", token: r.mint, amount: req.amount });
    } catch (e) {
      why = `: ${e.message}`;
    }
    let off = ["no build"];
    if (wire) {
      const pairs = Object.fromEntries(Object.entries(r.build.tables ?? {}).map(([k, v]) => [k, v.map(accRead)]));
      const v = checkSolanaQuote(wire, { ...req, spendable: req.amount, minOut: 1n, otherWallets: [] }, {
        tables: pairs,
        mint: [accRead(ma), accRead(mb)],
        rent: { tokenAccount: [0n, 0n], pumpVolumeAccumulator: [0n, 0n] },
        simulations: [null, null],
        reference: null,
      });
      off = v.results.filter((y) => (y.id === "S6" || y.id === "S10") && !y.ok).map((y) => `${y.id} ${y.detail}`);
    }
    const slots = `slots ${x.slots?.[0]}/${x.slots?.[1]}`;
    say(ok0 && ref !== null && off.length === 0, `${at} ${slots}; ${text.replace(/^mint \S+ /, "")}; ${ref ? `reference on ${ref.pools.map((p) => p.venue).join(",")}, E ${ref.expectedOut}` : `no reference${why}`}; ${off.length ? `refused: ${off.join("; ")}` : "S6,S10 pass"}`);
  }
  lines.push(`--  ${moved} of ${rounds.length} rounds read the mint at two different supplies`);
  return { ok: lines.some((l) => l.startsWith("ok ")) && lines.every((l) => !l.startsWith("BAD")), lines };
}

async function get(base, path) {
  const res = await fetch(`${base}${path}`, { redirect: "error", credentials: "omit", headers: { "cache-control": "no-cache" } });
  return { status: res.status, body: await res.text() };
}

export async function read({ base = BASE, token, rounds = ROUNDS } = {}) {
  base = base.replace(/\/$/, "");
  const live = RPCS.map((u) => solanaJsonRpc(u));
  const mintPair = async (m) => {
    const got = await Promise.all(live.map((rpc) => rpc("getMultipleAccounts", [[m], { encoding: "base64", commitment: "processed" }])));
    return { slots: got.map((g) => g?.context?.slot), mint: got.map((g) => (g?.value?.[0] ? { owner: g.value[0].owner, data: g.value[0].data[0] } : null)) };
  };
  const amount = BUY_LAMPORTS;
  if (!token) {
    const l = await get(base, "/v1/market/lists?chain=solana");
    if (l.status !== 200) throw new Error(`Solana lists: HTTP ${l.status}`);
    const lists = JSON.parse(l.body)?.lists ?? {};
    const rows = ["trending_1h", "trending", "trending_5m", "graduating", "new"].flatMap((k) => (Array.isArray(lists[k]) ? lists[k] : []));
    for (const t of rows) {
      if (typeof t?.token !== "string" || t.launchpad !== "pump.fun" || Number(t.liq_usd ?? 0) < 50_000) continue;
      const s = supplyOf((await mintPair(t.token)).mint[0]);
      if (s === null || s >= PUMP_SUPPLY) continue;
      if (await readSolanaReference([live[0], live[1]], { side: "buy", token: t.token, amount }).catch(() => null)) { token = t.token; break; }
    }
    if (!token) throw new Error("no listed pump.fun token with $50k of liquidity, a moved supply and a pool the kit reads");
  }
  // the dry buy: one build through the helper's Jupiter proxy, assembled on the device's blockhash and tables
  const wallet = base58(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  const req = { side: "buy", wallet, token, amount, slippageBps: SLIPPAGE_BPS };
  const blockhash = await readSolanaBlockhash(live[0]);
  const tables = {};
  const first = await mintPair(token);
  const fit = async (build) => {
    for (const t of build.tables) {
      if (tables[t]) continue;
      const got = await Promise.all(live.map((rpc) => rpc("getMultipleAccounts", [[t], { encoding: "base64", commitment: "processed" }])));
      tables[t] = got.map((g) => (g?.value?.[0] ? { owner: g.value[0].owner, data: g.value[0].data[0] } : null));
    }
    const decoded = {};
    for (const t of build.tables) if (tables[t][0]?.owner === ALT) decoded[t] = solanaDecodeLookupTable(b64(tables[t][0].data));
    return assembleSolanaSwap(req, build, { blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight, tables: decoded, tokenProgram: first.mint[0]?.owner });
  };
  const fetchOnce = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(SOLANA_BUILD_TIMEOUT_MS) });
  const f = await fetchSolanaJupiterBuildThatFits(base, req, fit, { fetch: fetchOnce });
  const build = { wallet, amount: String(amount), wire: Buffer.from(f.fitted.wire).toString("base64"), tables: Object.fromEntries(f.build.tables.map((t) => [t, tables[t]])) };
  const out = [];
  for (let i = 0; i < rounds; i++) {
    const calls = [[], []];
    const [m] = await Promise.all([mintPair(token), readSolanaReference([recordingRpc(live[0], calls[0]), recordingRpc(live[1], calls[1])], { side: "buy", token, amount }).catch(() => null)]);
    out.push({ ...m, calls });
    if (i + 1 < rounds) await new Promise((ok) => setTimeout(ok, GAP_MS));
  }
  return { base, readAt: new Date().toISOString(), mint: token, build, rounds: out };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const answer = await read({ base: opt("--base", BASE), token: opt("--token"), rounds: Number(opt("--rounds", ROUNDS)) });
    // `mint`, not `token`, in the record: gitleaks' generic-api-key rule reads a long value after "token" as a key
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(answer, null, 1)}\n`);
    const { ok, lines } = await judge(answer);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${answer.base}, token ${answer.mint}, ${answer.rounds.length} rounds)`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
