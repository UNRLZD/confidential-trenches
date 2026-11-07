#!/usr/bin/env node
// Live check of card solana-mint-supply-moves: a Solana buy of a token whose supply moves (burns, mints) is never
// refused for it. The device reads the token's mint on two providers, each at its own slot, so a burn between the two
// reads moves the supply alone (run 42161763756, 6 Nov 04:20Z: C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump, every leg
// refused S10, and the reference read behind it refused the same way). The kit holds the two reads to every field but
// the supply and a fee config's withheld fees (solanaMintDisagreement, S6 and S10), and the reference read holds the two
// supplies to the reserves' band, since the supply sets the fee tier (packages/kit/src/trade/solana/pool.ts).
// It reads two tokens, since the token whose supply burns move most often has no SOL pool the reference read prices
// (C5xph…pump: its curve is complete and quoted in another token, 6 Nov 08:20Z), and no pump.fun token with a SOL pool
// on the lists moved its supply in 60 s of reads (nine tokens, 6 Nov 08:22Z):
// - the reference: the first pump.fun token on HELPER_HOST's Solana Discover lists with at least $50k of liquidity whose
//   supply is under pump's 1e15 (burns have moved it) and whose pool the kit's reference read finds, or --token. ROUNDS
//   rounds GAP_MS apart each read, on the two public RPCs, the mint at processed (as runSolanaTrade does) and the kit's
//   reference read (readSolanaReference, at confirmed);
// - the burn: of C5xph…pump and the listed pump.fun tokens, the one whose supply moved most often in PROBE_MS of reads
//   (C5xph…pump on a tie), or --burn. Its mint is read on both RPCs at processed every BURN_GAP_MS, and each round
//   pairs provider A's read with provider B's next one, BURN_GAP_MS later: a provider that lags by that much, as
//   public RPCs do. Two reads at the same moment are mostly the same slot or the next (527 rounds of C5xph…pump,
//   6 Nov 08:09-08:19Z: B-A slot gaps of 0 or 1 in 503, and no burn between the two of any round in 3 burns), so a
//   burn lands between a pair only with that lag. It reads until a round's two reads differ in supply and at least
//   ROUNDS rounds are in, for at most BURN_BUDGET_MS.
// Each token gets one dry buy built through the helper's Jupiter proxy (nothing is signed or sent), from a random taker
// nobody holds a key for.
// It passes only when: at least ROUNDS rounds of each; in every reference round the reference read, replayed through
// the kit on the round's recorded answers, gives a reference; the build passes S6 and S10 on every round's two mint
// reads; and at least one burn round read the supply moved, which is the read main's kit before this card refused
// (it compared the mint byte for byte). A run in which no burn landed between two reads proves nothing either way: it
// says so and exits 2, never PASS.
//   node scripts/live-checks/solana-mint-supply-moves.mjs [--base <helper origin>] [--token <mint>] [--burn <mint>] [--rounds <n>] [--record <file>]
//   PASS exit 0, FAIL exit 1, no burn seen or error exit 2. --record writes every answer the run read, so the test
//   can replay it.
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
import { BASE, BUY_LAMPORTS, RPCS, SLIPPAGE_BPS, base58, mintLine, noneWritten } from "./solana-jupiter-build.mjs";

const KEY = "solana-mint-supply-moves";
export const ROUNDS = 20;
const GAP_MS = 1_500;
export const BURN_MINT = "C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump";
const PROBE_MS = 30_000;
const BURN_GAP_MS = 1_000;
const BURN_BUDGET_MS = 600_000;
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

/** The S6 and S10 refusals of one dry buy on one round's two mint reads. */
function mintChecks(build, req, ma, mb) {
  if (!build?.wire) return ["no build"];
  const pairs = Object.fromEntries(Object.entries(build.tables ?? {}).map(([k, v]) => [k, v.map(accRead)]));
  const v = checkSolanaQuote(b64(build.wire), { ...req, spendable: req.amount, minOut: 1n, otherWallets: [] }, {
    tables: pairs,
    mint: [accRead(ma), accRead(mb)],
    rent: { tokenAccount: [0n, 0n], pumpVolumeAccumulator: [0n, 0n] },
    simulations: [null, null],
    writable: noneWritten(b64(build.wire), pairs),
    reference: null,
  });
  return v.results.filter((y) => (y.id === "S6" || y.id === "S10") && !y.ok).map((y) => `${y.id} ${y.detail}`);
}
const supplyMoved = (ma, mb) => !!ma && !!mb && supplyOf(ma) !== supplyOf(mb);

/** The check on one recorded run: { ok, inconclusive, lines }. */
export async function judge(r) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const req = { side: "buy", wallet: r.build?.wallet, token: r.mint, amount: BigInt(r.build?.amount ?? 0) };
  const rounds = r.rounds ?? [];
  say(rounds.length >= ROUNDS, `${rounds.length} reference rounds (at least ${ROUNDS}) of ${r.mint}`);
  say(!!r.build?.wire, `one dry buy of it built through ${r.base}: ${r.build?.wire ? `${b64(r.build.wire).length} bytes` : "none"}`);
  let moved = 0;
  for (const [i, x] of rounds.entries()) {
    const [ma, mb] = x.mint ?? [null, null];
    const [ok0, text] = mintLine("mint", r.mint, ma, mb);
    if (supplyMoved(ma, mb)) moved++;
    let ref = null;
    let why = "";
    try {
      ref = await readSolanaReference([replayRpc(x.calls?.[0] ?? [], RPCS[0]), replayRpc(x.calls?.[1] ?? [], RPCS[1])], { side: "buy", token: r.mint, amount: req.amount });
    } catch (e) {
      why = `: ${e.message}`;
    }
    const off = mintChecks(r.build, req, ma, mb);
    say(ok0 && ref !== null && off.length === 0, `round ${i + 1}: slots ${x.slots?.[0]}/${x.slots?.[1]}; ${text.replace(/^mint \S+ /, "")}; ${ref ? `reference on ${ref.pools.map((p) => p.venue).join(",")}, E ${ref.expectedOut}` : `no reference${why}`}; ${off.length ? `refused: ${off.join("; ")}` : "S6,S10 pass"}`);
  }
  lines.push(`--  ${moved} of ${rounds.length} reference rounds read the mint at two different supplies`);
  // the burn: every round's two mint reads through S6 and S10; the rounds that read a moved supply each get a line
  const b = r.burn ?? {};
  const breq = { side: "buy", wallet: b.build?.wallet, token: b.mint, amount: BigInt(b.build?.amount ?? 0) };
  const brounds = b.rounds ?? [];
  say(brounds.length >= ROUNDS, `${brounds.length} burn rounds (at least ${ROUNDS}) of ${b.mint}`);
  say(!!b.build?.wire, `one dry buy of it built through ${r.base}: ${b.build?.wire ? `${b64(b.build.wire).length} bytes` : "none"}`);
  let burned = 0;
  for (const [i, x] of brounds.entries()) {
    const [ma, mb] = x.mint ?? [null, null];
    const [ok0, text] = mintLine("mint", b.mint, ma, mb);
    const off = mintChecks(b.build, breq, ma, mb);
    const ok = ok0 && off.length === 0;
    if (supplyMoved(ma, mb)) burned++;
    if (!ok || supplyMoved(ma, mb)) say(ok, `burn round ${i + 1}: slots ${x.slots?.[0]}/${x.slots?.[1]}; ${text.replace(/^mint \S+ /, "")}; ${off.length ? `refused: ${off.join("; ")}` : "S6,S10 pass"}`);
  }
  lines.push(`--  ${burned} of ${brounds.length} burn rounds read the mint at two different supplies`);
  const clean = lines.some((l) => l.startsWith("ok ")) && lines.every((l) => !l.startsWith("BAD"));
  if (clean && burned === 0) lines.push("--  no burn landed between two reads: the run proves nothing either way");
  return { ok: clean && burned > 0, inconclusive: clean && burned === 0, lines };
}

async function get(base, path) {
  const res = await fetch(`${base}${path}`, { redirect: "error", credentials: "omit", headers: { "cache-control": "no-cache" } });
  return { status: res.status, body: await res.text() };
}

export async function read({ base = BASE, token, burn, rounds = ROUNDS } = {}) {
  base = base.replace(/\/$/, "");
  const live = RPCS.map((u) => solanaJsonRpc(u));
  const mintPair = async (m) => {
    const got = await Promise.all(live.map((rpc) => rpc("getMultipleAccounts", [[m], { encoding: "base64", commitment: "processed" }])));
    return { slots: got.map((g) => g?.context?.slot), mint: got.map((g) => (g?.value?.[0] ? { owner: g.value[0].owner, data: g.value[0].data[0] } : null)) };
  };
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const amount = BUY_LAMPORTS;
  const l = await get(base, "/v1/market/lists?chain=solana");
  if (l.status !== 200) throw new Error(`Solana lists: HTTP ${l.status}`);
  const lists = JSON.parse(l.body)?.lists ?? {};
  const rows = ["trending_1h", "trending", "trending_5m", "graduating", "new"].flatMap((k) => (Array.isArray(lists[k]) ? lists[k] : []));
  const pump = [...new Set(rows.filter((t) => typeof t?.token === "string" && t.launchpad === "pump.fun").map((t) => t.token))];
  if (!token) {
    for (const t of rows) {
      if (typeof t?.token !== "string" || t.launchpad !== "pump.fun" || Number(t.liq_usd ?? 0) < 50_000) continue;
      const s = supplyOf((await mintPair(t.token)).mint[0]);
      if (s === null || s >= PUMP_SUPPLY) continue;
      if (await readSolanaReference([live[0], live[1]], { side: "buy", token: t.token, amount }).catch(() => null)) { token = t.token; break; }
    }
    if (!token) throw new Error("no listed pump.fun token with $50k of liquidity, a moved supply and a pool the kit reads");
  }
  if (!burn) {
    // the token whose supply moved most often in PROBE_MS of reads on one provider, C5xph…pump first on a tie
    const probe = [BURN_MINT, ...pump.filter((m) => m !== BURN_MINT)].slice(0, 100);
    const seen = probe.map(() => new Set());
    for (const until = Date.now() + PROBE_MS; Date.now() < until; await sleep(2_000)) {
      const g = await live[1]("getMultipleAccounts", [probe, { encoding: "base64", commitment: "processed" }]).catch(() => null);
      g?.value?.forEach((a, k) => a && seen[k].add(supplyOf({ data: a.data[0] })));
    }
    burn = probe[seen.reduce((best, s, k) => (s.size > seen[best].size ? k : best), 0)];
  }
  // a dry buy: one build through the helper's Jupiter proxy, assembled on the device's blockhash and tables
  const buildFor = async (m) => {
    const wallet = base58(globalThis.crypto.getRandomValues(new Uint8Array(32)));
    const req = { side: "buy", wallet, token: m, amount, slippageBps: SLIPPAGE_BPS };
    const blockhash = await readSolanaBlockhash(live[0]);
    const tables = {};
    const first = await mintPair(m);
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
    return { wallet, amount: String(amount), wire: Buffer.from(f.fitted.wire).toString("base64"), tables: Object.fromEntries(f.build.tables.map((t) => [t, tables[t]])) };
  };
  const build = await buildFor(token);
  const out = [];
  for (let i = 0; i < rounds; i++) {
    const calls = [[], []];
    const [m] = await Promise.all([mintPair(token), readSolanaReference([recordingRpc(live[0], calls[0]), recordingRpc(live[1], calls[1])], { side: "buy", token, amount }).catch(() => null)]);
    out.push({ ...m, calls });
    if (i + 1 < rounds) await sleep(GAP_MS);
  }
  const burnBuild = await buildFor(burn);
  // each round: provider A's read of the last tick beside provider B's of this one, BURN_GAP_MS later, so a burn
  // anywhere in the run lands between some round's two reads
  const burnRounds = [];
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < BURN_BUDGET_MS) {
    const m = await mintPair(burn).catch(() => null);
    if (m && last) burnRounds.push({ slots: [last.slots[0], m.slots[1]], mint: [last.mint[0], m.mint[1]] });
    last = m ?? last;
    if (burnRounds.length >= rounds && burnRounds.some((x) => supplyMoved(x.mint[0], x.mint[1]))) break;
    await sleep(BURN_GAP_MS);
  }
  return { base, readAt: new Date().toISOString(), mint: token, build, rounds: out, burn: { mint: burn, readMs: Date.now() - t0, build: burnBuild, rounds: burnRounds } };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const answer = await read({ base: opt("--base", BASE), token: opt("--token"), burn: opt("--burn"), rounds: Number(opt("--rounds", ROUNDS)) });
    // `mint`, not `token`, in the record: gitleaks' generic-api-key rule reads a long value after "token" as a key
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(answer, null, 1)}\n`);
    const { ok, inconclusive, lines } = await judge(answer);
    for (const l of lines) console.log(l);
    const verdict = ok ? "PASS" : inconclusive ? "INCONCLUSIVE" : "FAIL";
    console.log(`live-check ${KEY}: ${verdict} (${answer.base}, token ${answer.mint}, ${answer.rounds.length} rounds; burn ${answer.burn.mint}, ${answer.burn.rounds.length} rounds in ${Math.round(answer.burn.readMs / 1000)} s)`);
    process.exit(ok ? 0 : inconclusive ? 2 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
