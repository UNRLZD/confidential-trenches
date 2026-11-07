// The mainnet run of card pool-deposit-address: money sent from another chain reaches a note in chain X's pool. NEAR
// Intents has no testnet, so this half runs on mainnet only, once X's pool pin is live; testnet keeps the same-chain half.
// The money is the owner's: they ask pool.address with an origin in the app, send that amount from their own wallet to
// the deposit address it shows, and the page carries it on into the pool. This script moves nothing and holds no key:
// it reads 1Click's public status of that deposit address (keyless, https://1click.chaindefuser.com/v0/status), checks
// it is the device's own pool quote, and writes the run record the money gate reads each tx of on two public RPCs.
//   node packages/signpage/scripts/pool-deposit-address-mainnet.mjs --chain <solana|base|robinhood> \
//     --deposit-address <address> --pool-tx <the pool deposit's tx, from the app's deposit op> [--out <record.md>]
// - Waits for SUCCESS, reading every 10 s for up to 40 min; REFUNDED, FAILED or INCOMPLETE_DEPOSIT stops it with that
//   status and writes nothing (the page moves a refund on by itself; that run is not this record's).
// - The status must be of a live quote to the pool's coin on X (POOL_DEPOSIT_DESTINATION), recipient U_X with
//   DESTINATION_CHAIN, refund INTENTS to a 64-hex id (on Solana the recipient's own key), from a USDC or coin on Solana
//   or Base (a chain the money gate reads), with one origin tx and one delivery tx. Anything else: refused, nothing
//   written.
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
import { base58, hex } from "@scure/base";

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
const SOL_SIG = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/;
const EVM_HASH = /^0x[0-9a-f]{64}$/;
const txOk = (chain, id) => (chain === "solana" ? SOL_SIG.test(id) : EVM_HASH.test(id));

/** The record's lines for a SUCCESS status of `depositAddress` into X's pool, with the pool deposit's tx; throws on any
 *  status that is not the device's own pool quote. */
export function recordOf(chain, depositAddress, status, poolTx) {
  if (!Object.hasOwn(DESTINATION, chain)) throw new Error(`no pool on ${chain}`);
  if (status?.status !== "SUCCESS") throw new Error(`status ${status?.status}: no record`);
  const qr = status.quoteResponse?.quoteRequest ?? {};
  const q = status.quoteResponse?.quote ?? {};
  if (q.depositAddress !== depositAddress) throw new Error("the status is of another deposit address");
  if (qr.dry !== false) throw new Error("not a live quote");
  if (qr.destinationAsset !== DESTINATION[chain]) throw new Error(`the destination ${qr.destinationAsset} is not ${chain}'s pool coin`);
  if (qr.recipientType !== "DESTINATION_CHAIN") throw new Error("the recipient is not on the destination chain");
  if (qr.refundType !== "INTENTS" || !/^[0-9a-f]{64}$/.test(qr.refundTo ?? "")) throw new Error("the refund is not to a 64-hex id inside intents.near");
  if (chain === "solana") {
    let key;
    try {
      key = base58.decode(qr.recipient);
    } catch {
      throw new Error("the recipient is not a Solana address");
    }
    if (key.length !== 32 || hex.encode(key) !== qr.refundTo) throw new Error("a Solana U_X's refund is not its own key");
  } else if (!/^0x[0-9a-fA-F]{40}$/.test(qr.recipient ?? "")) throw new Error("the recipient is not an EVM address");
  const origin = originChainOf(qr.originAsset);
  if (origin === null) throw new Error(`the origin ${qr.originAsset} is not on Solana or Base`);
  const sent = status.swapDetails?.originChainTxHashes ?? [];
  const got = status.swapDetails?.destinationChainTxHashes ?? [];
  if (sent.length !== 1 || got.length !== 1) throw new Error("not one origin tx and one delivery tx");
  const [s, g] = [sent[0].hash, got[0].hash];
  if (!txOk(origin, s)) throw new Error(`the origin tx ${s} is not a ${origin} tx`);
  if (!txOk(chain, g)) throw new Error(`the delivery tx ${g} is not a ${chain} tx`);
  if (!txOk(chain, poolTx)) throw new Error(`the pool tx ${poolTx} is not a ${chain} tx`);
  if (new Set([s, g, poolTx]).size !== 3) throw new Error("a tx twice");
  return ["CARD pool-deposit-address / live: PASS", "Money path: yes", `Tx: ${origin} ${s}`, `Tx: ${chain} ${g}`, `Tx: ${chain} ${poolTx}`];
}

async function main(argv) {
  const opt = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const chain = opt("--chain"), address = opt("--deposit-address"), poolTx = opt("--pool-tx");
  const out = opt("--out") ?? "scripts/live-checks/pool-deposit-address.md";
  if (!chain || !address || !poolTx) throw new Error("usage: --chain <solana|base|robinhood> --deposit-address <address> --pool-tx <tx> [--out <record.md>]");
  const end = Date.now() + 40 * 60_000;
  for (;;) {
    const r = await fetch(`${STATUS_URL}?depositAddress=${encodeURIComponent(address)}`, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    const status = r.ok ? await r.json() : null;
    const s = status?.status;
    console.log(`pool-deposit-address: ${new Date().toISOString()} status ${s ?? `HTTP ${r.status}`}`);
    if (s === "SUCCESS") {
      const lines = recordOf(chain, address, status, poolTx);
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
