// The mainnet run of card pool-deposit-address: money sent from another chain reaches a note in chain X's pool. NEAR
// Intents has no testnet, so this half runs on mainnet only, once X's pool pin is live; testnet keeps the same-chain half.
// The money is the owner's: they ask pool.address with an origin in the app, send that amount from their own wallet to
// the deposit address it shows, and the page carries it on into the pool. This script moves nothing and holds no key:
// it reads 1Click's public status of that deposit address (keyless, https://1click.chaindefuser.com/v0/status), checks
// it is the device's own pool quote, and writes the run record the money gate reads each tx of on two public RPCs.
//   node packages/signpage/scripts/pool-deposit-address-mainnet.mjs --chain <solana|base|robinhood> \
//     --deposit-address <address> --u <U_X, the address pool.address answered> [--refund-id <U_{s,i}'s 64-hex id, on
//     Base and Robinhood>] --pool-tx <the pool deposit's tx, from the app's deposit op> [--out <record.md>]
// - Waits for SUCCESS, reading every 10 s for up to 40 min; REFUNDED, FAILED or INCOMPLETE_DEPOSIT stops it with that
//   status and writes nothing (the page moves a refund on by itself; that run is not this record's).
// - The status must be of a live quote to the pool's coin on X (POOL_DEPOSIT_DESTINATION), recipient exactly --u (U_X;
//   EIP-55 on Base and Robinhood) with DESTINATION_CHAIN, refund INTENTS to U_{s,i}'s 64-hex id (on Solana U_X's own
//   key; on Base and Robinhood exactly --refund-id), from a USDC or coin on Solana or Base (a chain the money gate reads)
//   other than the pool's coin, with one origin tx and one delivery tx, nothing refunded (refundedAmount "0") and the
//   whole quoted amount deposited (depositedAmount = amountIn). Anything else: refused, nothing written.
// - The pool tx must read, on both of X's public RPCs (the money gate's RPCS), as U_X's deposit into the pinned pool:
//   on Solana a finalized tx with no error, signed by U_X, with a tag 1 instruction of the pinned program
//   (SOL_MAINNET_DEPLOY); on Base and Robinhood a succeeded receipt from U_X with the pinned pool's Deposited log
//   (EVM_POOLS; none pinned yet, so refused). Anything else: refused, nothing written.
// - The record (scripts/live-checks/pool-deposit-address.md by default) is appended with one run section:
//     CARD pool-deposit-address / live: PASS
//     Money path: yes
//     Tx: <origin chain> <the owner's send>
//     Tx: <X> <1Click's delivery to U_X>
//     Tx: <X> <U_X's deposit into the pool>
//   then run `node scripts/ci/money-gate.mjs --all`: every Tx must read back as succeeded on two operators.
// Nothing here logs a key or the 12 words: it never has them.
import { appendFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { base58, hex } from "@scure/base";
import { EVM_POOL_EVENTS, EVM_POOLS } from "../../wallet/src/pool/evm.ts";
import { SOL_MAINNET_DEPLOY } from "../../wallet/src/pool/solana.ts";

export const STATUS_URL = "https://1click.chaindefuser.com/v0/status";
/** The pools' coins on 1Click (packages/wallet/src/deposit/quote.ts POOL_DEPOSIT_DESTINATION). */
export const DESTINATION = Object.freeze({ solana: "nep141:sol.omft.near", base: "nep141:base.omft.near", robinhood: "nep141:hood.omft.near" });
/** An origin asset's chain as the money gate names it: Solana and Base only (an origin on NEAR needs its signer). */
export function originChainOf(asset) {
  if (typeof asset !== "string") return null;
  if (asset === "nep141:sol.omft.near" || asset.startsWith("nep141:sol-")) return "solana";
  if (asset === "nep141:base.omft.near" || asset.startsWith("nep141:base-")) return "base";
  return null;
}
/** X's two public RPCs, of two operators: the money gate's (scripts/ci/money-gate.mjs RPCS; its test holds them equal). */
export const POOL_RPCS = Object.freeze({
  solana: ["https://api.mainnet-beta.solana.com", "https://public.rpc.solanavibestation.com"],
  base: ["https://mainnet.base.org", "https://base.drpc.org"],
  robinhood: ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood-rpc.publicnode.com"],
});
const enc = new TextEncoder();
const TOPIC_DEPOSITED = `0x${hex.encode(keccak_256(enc.encode(EVM_POOL_EVENTS.Deposited)))}`;
/** An EIP-55 address: its letters' case is keccak-256 of its lowercase hex (high nibble >= 8: upper). */
function isEip55(v) {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) return false;
  const low = v.slice(2).toLowerCase();
  const h = keccak_256(enc.encode(low));
  for (let i = 0; i < 40; i++) {
    const nibble = (h[i >> 1] >> (i % 2 === 0 ? 4 : 0)) & 15;
    if (v[i + 2] !== (nibble >= 8 ? low[i].toUpperCase() : low[i])) return false;
  }
  return true;
}
const SOL_SIG = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/;
const EVM_HASH = /^0x[0-9a-f]{64}$/;
const txOk = (chain, id) => (chain === "solana" ? SOL_SIG.test(id) : EVM_HASH.test(id));

/** U_X and the refund id the device's pool.address answered: on Solana the id is U_X's own key, on Base and Robinhood
 *  U_X is EIP-55 and the id is given. Throws on any other pair. */
export function ownOf(chain, own) {
  const u = own?.u;
  if (chain === "solana") {
    let key;
    try {
      key = base58.decode(u);
    } catch {
      throw new Error("--u is not a Solana address");
    }
    if (key.length !== 32) throw new Error("--u is not a Solana address");
    const id = hex.encode(key);
    if (own.refundId !== undefined && own.refundId !== id) throw new Error("a Solana U_X's refund id is its own key");
    return { u, refundId: id };
  }
  if (!isEip55(u)) throw new Error("--u is not an EIP-55 address");
  if (!/^[0-9a-f]{64}$/.test(own.refundId ?? "")) throw new Error("--refund-id is not U_{s,i}'s 64-hex id");
  return { u, refundId: own.refundId };
}

/** The record's lines for a SUCCESS status of `depositAddress` into X's pool, to the device's own U_X and refund id
 *  (`own`, ownOf), with the pool deposit's tx; throws on any status that is not the device's own pool quote. */
export function recordOf(chain, depositAddress, status, poolTx, own) {
  if (!Object.hasOwn(DESTINATION, chain)) throw new Error(`no pool on ${chain}`);
  const me = ownOf(chain, own);
  if (status?.status !== "SUCCESS") throw new Error(`status ${status?.status}: no record`);
  const qr = status.quoteResponse?.quoteRequest ?? {};
  const q = status.quoteResponse?.quote ?? {};
  if (q.depositAddress !== depositAddress) throw new Error("the status is of another deposit address");
  if (qr.dry !== false) throw new Error("not a live quote");
  if (qr.destinationAsset !== DESTINATION[chain]) throw new Error(`the destination ${qr.destinationAsset} is not ${chain}'s pool coin`);
  if (qr.recipientType !== "DESTINATION_CHAIN") throw new Error("the recipient is not on the destination chain");
  if (qr.refundType !== "INTENTS" || !/^[0-9a-f]{64}$/.test(qr.refundTo ?? "")) throw new Error("the refund is not to a 64-hex id inside intents.near");
  if (qr.recipient !== me.u) throw new Error("the recipient is not the device's U_X (--u)");
  if (qr.refundTo !== me.refundId) throw new Error(chain === "solana" ? "a Solana U_X's refund is not its own key" : "the refund is not the device's U_{s,i} (--refund-id)");
  if (qr.originAsset === DESTINATION[chain]) throw new Error("the origin is the pool's own coin");
  const origin = originChainOf(qr.originAsset);
  if (origin === null) throw new Error(`the origin ${qr.originAsset} is not on Solana or Base`);
  const sent = status.swapDetails?.originChainTxHashes ?? [];
  const got = status.swapDetails?.destinationChainTxHashes ?? [];
  if (sent.length !== 1 || got.length !== 1) throw new Error("not one origin tx and one delivery tx");
  const sw = status.swapDetails;
  if (sw.refundedAmount !== "0") throw new Error(`refunded ${sw.refundedAmount}: not the whole deposit`);
  if (typeof q.amountIn !== "string" || sw.depositedAmount !== q.amountIn) throw new Error(`deposited ${sw.depositedAmount}, not the quote's ${q.amountIn}`);
  const [s, g] = [sent[0].hash, got[0].hash];
  if (!txOk(origin, s)) throw new Error(`the origin tx ${s} is not a ${origin} tx`);
  if (!txOk(chain, g)) throw new Error(`the delivery tx ${g} is not a ${chain} tx`);
  if (!txOk(chain, poolTx)) throw new Error(`the pool tx ${poolTx} is not a ${chain} tx`);
  if (new Set([s, g, poolTx]).size !== 3) throw new Error("a tx twice");
  return ["CARD pool-deposit-address / live: PASS", "Money path: yes", `Tx: ${origin} ${s}`, `Tx: ${chain} ${g}`, `Tx: ${chain} ${poolTx}`];
}

const rpcPost = async (fetchFn, url, method, params) => {
  const r = await fetchFn(url, {
    method: "POST", headers: { "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (r.status !== 200) throw new Error(`${new URL(url).host}: HTTP ${r.status}`);
  const j = await r.json();
  if (j?.error !== undefined || j?.result == null) throw new Error(`${new URL(url).host}: ${method} has no answer`);
  return j.result;
};

/** One RPC's read of the pool tx as U_X's deposit into the pinned pool; a short summary both RPCs must agree on. */
async function readOne(chain, url, poolTx, u, pin, fetchFn) {
  if (chain === "solana") {
    const t = await rpcPost(fetchFn, url, "getTransaction", [poolTx, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
    if (t.meta?.err !== null) throw new Error(`${new URL(url).host}: the pool tx failed or is not final`);
    const m = t.transaction?.message ?? {};
    const keys = [...(m.accountKeys ?? []), ...(t.meta.loadedAddresses?.writable ?? []), ...(t.meta.loadedAddresses?.readonly ?? [])];
    const signers = (m.accountKeys ?? []).slice(0, m.header?.numRequiredSignatures ?? 0);
    if (!signers.includes(u)) throw new Error(`${new URL(url).host}: the pool tx is not signed by U_X`);
    const deposit = (m.instructions ?? []).some((ix) => {
      if (keys[ix.programIdIndex] !== pin) return false;
      try {
        return base58.decode(ix.data)[0] === 1;
      } catch {
        return false;
      }
    });
    if (!deposit) throw new Error(`${new URL(url).host}: the pool tx has no deposit (tag 1) into the pinned pool ${pin}`);
    return `slot ${t.slot}`;
  }
  const r = await rpcPost(fetchFn, url, "eth_getTransactionReceipt", [poolTx]);
  if (r.status !== "0x1") throw new Error(`${new URL(url).host}: the pool tx did not succeed`);
  if (typeof r.from !== "string" || r.from.toLowerCase() !== u.toLowerCase()) throw new Error(`${new URL(url).host}: the pool tx is not sent by U_X`);
  const ok = (r.logs ?? []).some((l) => typeof l.address === "string" && l.address.toLowerCase() === pin && l.topics?.[0] === TOPIC_DEPOSITED);
  if (!ok) throw new Error(`${new URL(url).host}: the pool tx has no Deposited log of the pinned pool ${pin}`);
  return `block ${r.blockHash}`;
}

/** Reads the pool tx on X's two RPCs as U_X's deposit into the pinned pool; throws unless both read it so, alike. */
export async function readPoolTx(chain, poolTx, u, opts = {}) {
  const fetchFn = opts.fetch ?? fetch;
  const rpcs = opts.rpcs ?? POOL_RPCS[chain];
  const pin = opts.pin !== undefined ? opts.pin : chain === "solana" ? SOL_MAINNET_DEPLOY?.program : EVM_POOLS[chain]?.pool?.toLowerCase();
  if (typeof pin !== "string") throw new Error(`no pool pinned on ${chain}: the pool tx cannot be read as a deposit into it`);
  if (!Array.isArray(rpcs) || rpcs.length !== 2) throw new Error(`${chain}: not two RPCs`);
  const [a, b] = await Promise.all(rpcs.map((url) => readOne(chain, url, poolTx, u, pin, fetchFn)));
  if (a !== b) throw new Error(`the two RPCs read the pool tx apart (${a}, ${b})`);
}

async function main(argv) {
  const opt = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const chain = opt("--chain"), address = opt("--deposit-address"), poolTx = opt("--pool-tx");
  const own = { u: opt("--u"), refundId: opt("--refund-id") };
  const out = opt("--out") ?? "scripts/live-checks/pool-deposit-address.md";
  if (!chain || !address || !poolTx || !own.u) throw new Error("usage: --chain <solana|base|robinhood> --deposit-address <address> --u <U_X> [--refund-id <64-hex>] --pool-tx <tx> [--out <record.md>]");
  ownOf(chain, own); // a wrong pair stops before any read
  const end = Date.now() + 40 * 60_000;
  for (;;) {
    const r = await fetch(`${STATUS_URL}?depositAddress=${encodeURIComponent(address)}`, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    const status = r.ok ? await r.json() : null;
    const s = status?.status;
    console.log(`pool-deposit-address: ${new Date().toISOString()} status ${s ?? `HTTP ${r.status}`}`);
    if (s === "SUCCESS") {
      const lines = recordOf(chain, address, status, poolTx, own);
      await readPoolTx(chain, poolTx, own.u);
      appendFileSync(out, `\n${lines.join("\n")}\n`);
      console.log(`pool-deposit-address: wrote ${out}; now run: node scripts/ci/money-gate.mjs --all`);
      return;
    }
    if (s === "REFUNDED" || s === "FAILED" || s === "INCOMPLETE_DEPOSIT") throw new Error(`status ${s}: nothing written`);
    if (Date.now() > end) throw new Error("no SUCCESS in 40 min: nothing written");
    await new Promise((ok) => setTimeout(ok, 10_000));
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`pool-deposit-address: ${e.message}`);
    process.exit(1);
  });
}
