#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Card sol-pool-buys-mayhem-coins: the kit's buy and sell of a pump.fun Mayhem coin, simulated on mainnet's own
// programs and accounts. Read only: simulateTransaction with sigVerify false and replaceRecentBlockhash, so nothing is
// signed, no key is read or made, and nothing can land.
//
//   node contracts/pool-solana/scripts/mayhem-simulate.mjs [--mint <Mayhem coin on its curve> --user <a wallet holding it>]
//
// Without --mint and --user it takes a Mayhem coin traded now, and a wallet that holds it: the buyer of a recent pump
// buy_v2 that paid the reserved fee recipient's wSOL account (C93K8DX4..., GesfTA3X...'s), whose token account still
// holds some. Then, on each of mainnet's two RPCs (pool-sol-deploy.mjs MAINNET_RPCS):
//   1. the kit's venue read (readSolanaPoolBuyVenue: the mint, the curve and pump Global on both RPCs, the same bytes):
//      a Mayhem curve names Global's reserved fee recipient (byte 483), never its fee recipient (41);
//   2. the kit's buy (solanaPoolVenueBuy, 0.001 SOL in) by that wallet: err null;
//   3. the kit's sell (solanaPoolSellSteps, a tenth of what the wallet holds, read on that RPC just before): err null;
//   4. the same buy naming Global's fee recipient instead (what the build named before this card): refused by pump
//      (NotAuthorized, fee_recipient.rs).
// PASS exit 0 when every one holds on both RPCs; FAIL exit 1, each line saying why; error exit 2. A wallet that sold
// between the read and the sell is a FAIL of step 3 on that RPC: run it again (a live coin, a live holder).
import "../../../scripts/net-window.mjs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MAINNET_RPCS } from "../../../scripts/live-checks/pool-sol-deploy.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const kit = await import(pathToFileURL(path.join(REPO, "packages/kit/src/index.ts")).href);
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const GLOBAL = "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf";
const RESERVED_WSOL = "C93K8DX4YsABYJtHX9awzgZW3LWzBqBVezEbbLJH4yet";
const BUY_V2 = "c2ab1c46684d5b2f";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const isKey = (s) => typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
const hexOf = (s) => { let v = 0n; for (const c of s) v = v * 58n + BigInt(B58.indexOf(c)); return v.toString(16); };
const b58 = (bytes) => { let v = BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0")), o = ""; while (v > 0n) { o = B58[Number(v % 58n)] + o; v /= 58n; } for (const x of bytes) { if (x !== 0) break; o = "1" + o; } return o; };

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
let MINT = arg("--mint");
let USER = arg("--user");
if ((MINT === undefined) !== (USER === undefined) || (MINT !== undefined && (!isKey(MINT) || !isKey(USER)))) {
  console.error("usage: mayhem-simulate.mjs [--mint <address> --user <address>]");
  process.exit(2);
}

const call = async (url, method, params) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 200)}`);
  return j.result;
};
const rpc = (url) => (m, p) => call(url, m, [...p]);
const held = async (url, owner, mint, tp) => {
  const a = await call(url, "getAccountInfo", [kit.solanaAta(owner, mint, tp), { encoding: "base64", commitment: "confirmed" }]);
  return a?.value ? Buffer.from(a.value.data[0], "base64").readBigUInt64LE(64) : 0n;
};

let bad = 0;
const say = (ok, line) => { if (!ok) bad++; console.log(`${ok ? "ok  " : "FAIL"} ${line}`); };
try {
  if (MINT === undefined) {
    const sigs = (await call(MAINNET_RPCS[1], "getSignaturesForAddress", [RESERVED_WSOL, { limit: 15 }])).filter((x) => !x.err);
    for (const sg of sigs) {
      const t = await call(MAINNET_RPCS[1], "getTransaction", [sg.signature, { encoding: "json", maxSupportedTransactionVersion: 1 }]).catch(() => null);
      if (!t) continue;
      const m = t.transaction.message, la = t.meta.loadedAddresses ?? { writable: [], readonly: [] };
      const keys = [...m.accountKeys, ...la.writable, ...la.readonly];
      const ix = [...m.instructions, ...(t.meta.innerInstructions ?? []).flatMap((g) => g.instructions)]
        .find((i) => keys[i.programIdIndex] === PUMP && i.accounts.length >= 26 && hexOf(i.data).startsWith(BUY_V2));
      if (!ix) continue;
      const [mint, who, tp] = [keys[ix.accounts[1]], keys[ix.accounts[13]], keys[ix.accounts[3]]];
      if ((await held(MAINNET_RPCS[1], who, mint, tp)) > 1_000_000n) { MINT = mint; USER = who; console.log(`coin ${mint}, wallet ${who}: the buyer in ${sg.signature}`); break; }
    }
    if (MINT === undefined) throw new Error("no wallet still holding a coin among the reserved recipient's last 15 trades: run it again");
  }
  const venue = await kit.readSolanaPoolBuyVenue([rpc(MAINNET_RPCS[0]), rpc(MAINNET_RPCS[1])], "pump-curve", MINT, () => 0);
  const g = await call(MAINNET_RPCS[0], "getAccountInfo", [GLOBAL, { encoding: "base64", commitment: "confirmed" }]);
  const gd = Buffer.from(g.value.data[0], "base64");
  const reserved = b58(gd.subarray(483, 515));
  const ordinary = b58(gd.subarray(41, 73));
  say(venue.feeRecipient === reserved && reserved !== ordinary, `the venue on both RPCs names Global's reserved fee recipient ${venue.feeRecipient} (483), not its fee recipient ${ordinary} (41)`);
  const wire = (ixs) => {
    const { message } = kit.solanaCompileV0(USER, ixs, "11111111111111111111111111111111", []);
    const w = new Uint8Array(65 + message.length);
    w[0] = 1;
    w.set(message, 65);
    return Buffer.from(w).toString("base64");
  };
  const sim = async (url, w) => {
    const r = await call(url, "simulateTransaction", [w, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }]);
    const why = (r.value.logs ?? []).find((l) => /Error Message/.test(l)) ?? "";
    return { err: r.value.err, slot: r.context.slot, cu: r.value.unitsConsumed, why: why.replace(/^Program log: /, "").slice(0, 160) };
  };
  for (const url of MAINNET_RPCS) {
    const host = new URL(url).host;
    const buy = await sim(url, wire([kit.solanaPoolVenueBuy(venue, USER, 1_000_000n, 1n)]));
    say(buy.err === null, `${host} slot ${buy.slot}: the kit's buy, 0.001 SOL: err ${JSON.stringify(buy.err)}, ${buy.cu} CU ${buy.why}`);
    const has = await held(url, USER, MINT, venue.tokenProgram);
    if (has < 10n) say(false, `${host}: the wallet holds ${has}, too little to sell: run it again`);
    else {
      const sell = await sim(url, wire(kit.solanaPoolSellSteps(venue, USER, has / 10n, 1n)));
      say(sell.err === null, `${host} slot ${sell.slot}: the kit's sell of ${has / 10n} of ${has}: err ${JSON.stringify(sell.err)}, ${sell.cu} CU ${sell.why}`);
    }
    const wrong = await sim(url, wire([kit.solanaPoolVenueBuy({ ...venue, feeRecipient: ordinary }, USER, 1_000_000n, 1n)]));
    say(wrong.err !== null && /not authorized/i.test(wrong.why), `${host} slot ${wrong.slot}: the same buy paying Global's fee recipient: err ${JSON.stringify(wrong.err)} ${wrong.why}`);
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(2);
}
console.log(bad ? `FAIL: ${bad} line(s)` : "PASS");
process.exit(bad ? 1 : 0);
