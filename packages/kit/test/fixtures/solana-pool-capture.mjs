// Captures the recorded answers for test/solana-pool.test.ts: the device's on-chain reference E for a Solana trade
// (markets paper S12, LD1), on one live pump.fun bonding-curve token and one graduated token in its PumpSwap canonical
// pool. Per token and side: the reference accounts in one getMultipleAccounts at `processed` on two public RPCs (read
// twice, for the re-read), then a real Jupiter route on that venue alone for the same exact input, built for a wallet
// that already holds the input, and simulated on both RPCs (sigVerify false, replaceRecentBlockhash true) with the
// wallet's output account in the answer. Reads only: nothing is signed or sent, and no key is used.
//   node packages/kit/test/fixtures/solana-pool-capture.mjs [<curve mint> <pumpswap mint>] > packages/kit/test/fixtures/solana-pool.json
import { base58, base64 } from "@scure/base";
import { solanaAta, solanaProgramAddress } from "../../src/checks/solana/message.ts";

const RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
const JUP = "https://lite-api.jup.ag/swap/v1";
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const FEES = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
const WSOL = "So11111111111111111111111111111111111111112";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SYSTEM = "11111111111111111111111111111111";
const BUY_LAMPORTS = 10_000_000n; // 0.01 SOL
const enc = (s) => new TextEncoder().encode(s);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function call(url, method, params) {
  for (let i = 0; i < 8; i++) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (r.status === 429) { await sleep(1500); continue; }
    const j = await r.json();
    if (j.error) throw new Error(`${url} ${method}: ${JSON.stringify(j.error)}`);
    return j.result;
  }
  throw new Error(`${url} ${method}: 429 eight times`);
}
async function getJson(url, init) {
  let r = await fetch(url, init);
  for (let i = 0; i < 8 && r.status === 429; i++) { await sleep(3_000); r = await fetch(url, init); }
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// The ten addresses the kit reads (the same derivation as src/trade/solana/pool.ts, written out here so the fixture
// does not depend on the code it tests).
function addresses(mint) {
  const m = base58.decode(mint);
  const authority = solanaProgramAddress([enc("pool-authority"), m], PUMP);
  const pool = solanaProgramAddress([enc("pool"), Uint8Array.of(0, 0), base58.decode(authority), m, base58.decode(WSOL)], AMM);
  return [
    mint,
    solanaProgramAddress([enc("bonding-curve"), m], PUMP),
    solanaProgramAddress([enc("global")], PUMP),
    solanaProgramAddress([enc("fee_config"), base58.decode(PUMP)], FEES),
    pool,
    solanaProgramAddress([enc("global_config")], AMM),
    solanaProgramAddress([enc("fee_config"), base58.decode(AMM)], FEES),
    solanaAta(pool, mint, TOKEN),
    solanaAta(pool, mint, TOKEN22),
    solanaAta(pool, WSOL, TOKEN),
  ];
}
const READ_CONFIG = { encoding: "base64", commitment: "processed" };

// A holder of a token on the venue, from the venue program's latest transactions (getSignaturesForAddress, then
// getTransaction): the fee payer of a clean one that ends holding a token whose venue state fits, still holding it
// now in its own ATA, a plain System wallet with SOL for a 0.01 SOL buy. Both public RPCs refuse
// getTokenLargestAccounts without a key, so the holders come from the trades themselves.
async function discover(program, fits) {
  const sigs = await call(RPCS[0], "getSignaturesForAddress", [program, { limit: 60, commitment: "confirmed" }]);
  const tried = new Set();
  const fit = new Map();
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await call(RPCS[0], "getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]).catch(() => null);
    if (!tx || tx.meta?.err) continue;
    const payer = tx.transaction.message.accountKeys[0];
    for (const b of tx.meta.postTokenBalances ?? []) {
      if (b.owner !== payer || b.mint === WSOL || BigInt(b.uiTokenAmount.amount) === 0n || tried.has(`${payer}:${b.mint}`)) continue;
      tried.add(`${payer}:${b.mint}`);
      if (!fit.has(b.mint)) fit.set(b.mint, await fits(b.mint));
      const need = fit.get(b.mint);
      if (!need) continue;
      const ata = solanaAta(payer, b.mint, b.programId);
      const [w, a] = (await call(RPCS[1], "getMultipleAccounts", [[payer, ata], { encoding: "base64" }])).value;
      if (!w || w.owner !== SYSTEM || w.executable || w.lamports < 30_000_000 || !a || a.owner !== b.programId) continue;
      const d = base64.decode(a.data[0]);
      const balance = new DataView(d.buffer, d.byteOffset).getBigUint64(64, true);
      if (balance >= need) return { mint: b.mint, program: b.programId, wallet: payer, tokenAccount: ata, balance, from: s.signature };
    }
  }
  throw new Error(`no holder found from ${program}'s latest transactions`);
}

async function scenario(mint, venue, side, amount, wallet, outAccount) {
  const addrs = addresses(mint);
  const dex = venue === "pump-curve" ? "Pump.fun" : "Pump.fun Amm";
  const [inputMint, outputMint] = side === "buy" ? [WSOL, mint] : [mint, WSOL];
  const quote = await getJson(`${JUP}/quote?${new URLSearchParams({ inputMint, outputMint, amount: String(amount), slippageBps: "2000", onlyDirectRoutes: "true", dexes: dex })}`);
  const labels = quote.routePlan.map((r) => r.swapInfo.label);
  if (labels.length !== 1 || labels[0] !== dex) throw new Error(`route ${labels.join("+")} is not ${dex} alone`);
  const swap = await getJson(`${JUP}/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: wallet, wrapAndUnwrapSol: side === "buy", dynamicComputeUnitLimit: false }),
  });
  // the reads, the output account's balance and the simulations back to back, after the route is built, so the pool
  // moves as little as it can between the device's read and the simulated fill
  const reads = [];
  for (let n = 0; n < 2; n++) reads.push(await Promise.all(RPCS.map((u) => call(u, "getMultipleAccounts", [addrs, READ_CONFIG]))));
  const pre = await Promise.all(RPCS.map((u) => call(u, "getMultipleAccounts", [[outAccount], { encoding: "base64", commitment: "processed" }])));
  const sims = await Promise.all(RPCS.map((u) => call(u, "simulateTransaction", [swap.swapTransaction, {
    encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "processed",
    accounts: { encoding: "base64", addresses: [outAccount] },
  }])));
  return {
    venue, side, amount: String(amount), wallet, outAccount, addresses: addrs, reads,
    jupiter: { label: labels[0], inAmount: quote.inAmount, outAmount: quote.outAmount, pool: quote.routePlan[0].swapInfo.ammKey },
    pre, sims: sims.map((s) => ({ context: s.context, value: { err: s.value.err, unitsConsumed: s.value.unitsConsumed, accounts: s.value.accounts } })),
  };
}

async function token(venue, h) {
  const { mint, program } = h;
  // the buy's out sizes the sell: the holder sells about what 0.01 SOL buys, at most what it holds
  const q = await getJson(`${JUP}/quote?${new URLSearchParams({ inputMint: WSOL, outputMint: mint, amount: String(BUY_LAMPORTS), slippageBps: "2000", onlyDirectRoutes: "true", dexes: venue === "pump-curve" ? "Pump.fun" : "Pump.fun Amm" })}`);
  const sellAmount = BigInt(q.outAmount) < h.balance ? BigInt(q.outAmount) : h.balance;
  return {
    mint, venue, tokenProgram: program, holder: h.wallet, holderFoundIn: h.from,
    scenarios: [
      await scenario(mint, venue, "buy", BUY_LAMPORTS, h.wallet, h.tokenAccount),
      await scenario(mint, venue, "sell", sellAmount, h.wallet, solanaAta(h.wallet, WSOL, TOKEN)),
    ],
  };
}

// Jupiter has a one-step route for the token on that venue alone: half of what 0.01 SOL buys is the least a holder
// must hold (a dust sell fails the program's own truncation check); 0n when there is no such route.
const routes = (mint, dex) =>
  getJson(`${JUP}/quote?${new URLSearchParams({ inputMint: WSOL, outputMint: mint, amount: String(BUY_LAMPORTS), slippageBps: "2000", onlyDirectRoutes: "true", dexes: dex })}`).then(
    (q) => (q.routePlan.length === 1 && q.routePlan[0].swapInfo.label === dex ? BigInt(q.outAmount) / 2n : 0n),
    () => 0n,
  );
const readAt = new Date().toISOString();
// Optional mints: then the holder comes from that token's own curve or pool transactions.
const [curveArg, ammArg] = process.argv.slice(2);
// a live curve: the curve account exists and is not complete; a graduated token: its PumpSwap canonical pool exists
const curve = await discover(curveArg ? addresses(curveArg)[1] : PUMP, async (mint) => {
  const c = (await call(RPCS[1], "getMultipleAccounts", [[addresses(mint)[1]], { encoding: "base64" }])).value[0];
  return !!c && c.owner === PUMP && base64.decode(c.data[0])[48] === 0 ? routes(mint, "Pump.fun") : 0n;
});
const amm = await discover(ammArg ? addresses(ammArg)[4] : AMM, async (mint) => {
  const p = (await call(RPCS[1], "getMultipleAccounts", [[addresses(mint)[4]], { encoding: "base64" }])).value[0];
  return !!p && p.owner === AMM ? routes(mint, "Pump.fun Amm") : 0n;
});
const out = { readAt, rpcs: RPCS, jupiter: JUP, tokens: [] };
out.tokens.push(await token("pump-curve", curve));
out.tokens.push(await token("pumpswap", amm));
out.readEnd = new Date().toISOString();
process.stdout.write(JSON.stringify(out, null, 1) + "\n");
