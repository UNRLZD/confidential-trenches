#!/usr/bin/env node
// Card solana-buy-never-below-a-hidden-market: records test/vectors/<name>-clmm-sim.json, a Raydium CLMM pool's own
// swap_v2 out beside the accounts the kit's market read takes, so test/solana-clmm.test.ts holds the kit's floor
// (clmm.ts solanaClmmCellOut) to what the program pays. Read only: simulateTransaction with sigVerify false and
// replaceRecentBlockhash, so nothing is signed, no key is read or made, and nothing can land. The payer is a public
// wallet with SOL (any wallet works unsigned); the transaction wraps `amount` SOL into its wSOL account, then swaps it
// in on the pool (swap_v2, exact input, no price limit), with the pool's current tick array and the next two in the
// swap's direction, and the bitmap extension when it exists.
//   node packages/kit/test/fixtures/solana-clmm-capture.mjs <name> <coin mint> <pool> <lamports>...
// Each amount is simulated with the pool's accounts read just before and just after on both providers; a run whose
// pool moved between them is read again (at most 6 tries).
import "../../../../scripts/net-window.mjs";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const kit = await import(pathToFileURL(path.join(KIT, "src/index.ts")).href);
const [name, MINT, POOL, ...amounts] = process.argv.slice(2);
if (!name || !MINT || !POOL || amounts.length === 0) throw new Error("usage: solana-clmm-capture.mjs <name> <coin mint> <pool> <lamports>...");
const RPCS = { A: "https://solana-rpc.publicnode.com", B: "https://api.mainnet-beta.solana.com" };
const PAYER = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";
const CLMM = kit.SOLANA_CLMM_PROGRAM;
const WSOL = "So11111111111111111111111111111111111111112";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN22 = kit.SOLANA_TOKEN_2022_PROGRAM;
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM = "11111111111111111111111111111111";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const dec = (s) => { let v = 0n; for (const c of s) v = v * 58n + BigInt(B58.indexOf(c)); const out = []; while (v > 0n) { out.unshift(Number(v & 255n)); v >>= 8n; } for (const c of s) { if (c !== "1") break; out.unshift(0); } return Uint8Array.from(out); };
const key32 = (s) => { const b = dec(s); if (b.length !== 32) throw new Error(`not a key: ${s}`); return b; };

let id = 0;
async function rpc(url, method, params) {
  for (let i = 0; i < 4; i++) {
    let r;
    try {
      r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      console.error(`${new URL(url).host} ${method}: ${e.name}, asked again`);
      continue;
    }
    if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 1500)); continue; }
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  }
  throw new Error(`${method}: rate limited`);
}

const head = await rpc(RPCS.B, "getAccountInfo", [POOL, { encoding: "base64" }]);
const pool = kit.solanaDecodeClmmPool({ owner: head.value.owner, data: Buffer.from(head.value.data[0], "base64") });
const side = kit.solanaClmmSide(pool, MINT);
if (!side || side.quote !== "sol") throw new Error("not the coin's wSOL pool");
const list = kit.solanaClmmReadList(POOL, pool, MINT);
const observation = (() => { const d = Buffer.from(head.value.data[0], "base64"); let v = BigInt("0x" + d.subarray(201, 233).toString("hex")); let o = ""; while (v > 0n) { o = B58[Number(v % 58n)] + o; v /= 58n; } return o; })();
const coinProgram = (await rpc(RPCS.B, "getAccountInfo", [MINT, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }])).value.owner;
const ata = (owner, mint, program) => kit.solanaAta(owner, mint, program);
const wsolAta = ata(PAYER, WSOL, TOKEN);
const coinAta = ata(PAYER, MINT, coinProgram);
// a buy puts wSOL in: zero_for_one when wSOL is token 0
const zeroForOne = side.quoteIs0;
const span = pool.tickSpacing * 60;
const start = (t) => Math.floor(t / span) * span;
const enc = new TextEncoder();
const be32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, n, false); return b; };
const arrays = [0, 1, 2].map((k) => kit.solanaProgramAddress([enc.encode("tick_array"), key32(POOL), be32(start(pool.tickCurrent) + (zeroForOne ? -k : k) * span)], CLMM));
const bitmap = kit.solanaProgramAddress([enc.encode("pool_tick_array_bitmap_extension"), key32(POOL)], CLMM);
const exists = (await rpc(RPCS.B, "getMultipleAccounts", [[...arrays, bitmap], { encoding: "base64", dataSlice: { offset: 0, length: 0 } }])).value.map((v) => v !== null);
const remaining = [...(exists[3] ? [bitmap] : []), ...arrays.filter((_, i) => exists[i])];

const u64 = (x) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(x), true); return b; };
const disc = (n) => createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
function tx(amount) {
  const ixs = [
    { program: ATA, keys: [[PAYER, 1, 1], [wsolAta, 0, 1], [PAYER, 0, 0], [WSOL, 0, 0], [SYSTEM, 0, 0], [TOKEN, 0, 0]], data: Uint8Array.of(1) },
    { program: ATA, keys: [[PAYER, 1, 1], [coinAta, 0, 1], [PAYER, 0, 0], [MINT, 0, 0], [SYSTEM, 0, 0], [coinProgram, 0, 0]], data: Uint8Array.of(1) },
    { program: SYSTEM, keys: [[PAYER, 1, 1], [wsolAta, 0, 1]], data: Uint8Array.from([2, 0, 0, 0, ...u64(amount)]) },
    { program: TOKEN, keys: [[wsolAta, 0, 1]], data: Uint8Array.of(17) },
    {
      program: CLMM,
      keys: [[PAYER, 1, 0], [pool.ammConfig, 0, 0], [POOL, 0, 1], [wsolAta, 0, 1], [coinAta, 0, 1], [zeroForOne ? pool.vault0 : pool.vault1, 0, 1], [zeroForOne ? pool.vault1 : pool.vault0, 0, 1], [observation, 0, 1], [TOKEN, 0, 0], [TOKEN22, 0, 0], [MEMO, 0, 0], [WSOL, 0, 0], [MINT, 0, 0], ...remaining.map((k) => [k, 0, 1])],
      data: Uint8Array.from([...disc("swap_v2"), ...u64(amount), ...u64(0), ...new Uint8Array(16), 1]),
    },
  ];
  // a legacy message: signers first (writable then not), then the rest (writable then not)
  const metas = new Map([[PAYER, { s: 1, w: 1 }]]);
  for (const ix of ixs) {
    for (const [k, s, w] of ix.keys) { const m = metas.get(k) ?? { s: 0, w: 0 }; metas.set(k, { s: m.s | s, w: m.w | w }); }
    if (!metas.has(ix.program)) metas.set(ix.program, { s: 0, w: 0 });
  }
  const order = [...metas].sort(([, a], [, b]) => (b.s - a.s) || (b.w - a.w)).map(([k]) => k);
  const at = new Map(order.map((k, i) => [k, i]));
  const sig = order.filter((k) => metas.get(k).s);
  const cu = (n) => { const o = []; for (;;) { let b = n & 0x7f; n >>= 7; if (n) b |= 0x80; o.push(b); if (!n) return o; } };
  const msg = [sig.length, sig.filter((k) => !metas.get(k).w).length, order.filter((k) => !metas.get(k).s && !metas.get(k).w).length, ...cu(order.length)];
  for (const k of order) msg.push(...key32(k));
  msg.push(...new Uint8Array(32), ...cu(ixs.length));
  for (const ix of ixs) msg.push(at.get(ix.program), ...cu(ix.keys.length), ...ix.keys.map(([k]) => at.get(k)), ...cu(ix.data.length), ...ix.data);
  return Buffer.from([...cu(sig.length), ...new Uint8Array(64 * sig.length), ...msg]).toString("base64");
}

const read = async () => Object.fromEntries(await Promise.all(Object.entries(RPCS).map(async ([k, u]) => [k, await rpc(u, "getMultipleAccounts", [list, { encoding: "base64", commitment: "confirmed" }])])));
const moving = (r) => r.value[0].data[0];
const runs = [];
for (const amount of amounts) {
  let got = null;
  for (let t = 0; t < 6 && got === null; t++) {
    const before = await read();
    const sim = await rpc(RPCS.B, "simulateTransaction", [tx(amount), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "base64", addresses: [coinAta] } }]);
    const after = await read();
    if (sim.value.err) throw new Error(`simulation failed: ${JSON.stringify(sim.value.err)} ${JSON.stringify(sim.value.logs?.slice(-6))}`);
    const same = ["A", "B"].every((k) => moving(before[k]) === moving(after[k])) && moving(before.A) === moving(before.B);
    if (!same) continue;
    const acc = sim.value.accounts[0];
    const programOut = Buffer.from(acc.data[0], "base64").readBigUInt64LE(64).toString();
    got = { amount, providers: before, simSlot: sim.value.context?.slot ?? null, programOut };
  }
  if (got === null) throw new Error(`the pool moved on every try for ${amount}`);
  runs.push(got);
  console.log(`${amount} lamports in: program out ${got.programOut}`);
}
const out = path.join(KIT, `test/vectors/${name}-clmm-sim.json`);
writeFileSync(out, `${JSON.stringify({ source: `mainnet, read ${new Date().toISOString()} on solana-rpc.publicnode.com (A) and api.mainnet-beta.solana.com (B); programOut is the coin account's amount after simulateTransaction (sigVerify false, replaceRecentBlockhash) of a wSOL wrap and the pool's swap_v2 on B, the pool's bytes the same on both providers before and after`, coin: MINT, pool: POOL, list, payer: PAYER, remaining, runs })}\n`);
console.log(`wrote ${out}`);
