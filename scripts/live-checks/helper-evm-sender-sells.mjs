// The sells the helper sent on the testnets (6 Nov), read back for helper-evm-sender.test.mjs's replay (card
// live-checks-read-mainnet-only moved them here out of helper-evm-sender.mjs, a listed check that reads the mainnets
// alone): pool-evm-testnet-run's recorded runs, never read after a deploy.
// Runs: once, no check: helper-evm-sender's testnet sell read-back, kept for its replay; the live check reads the mainnets
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cat, hex, int, keccak_256, rlpShort, secp256k1, SELL_GAS, show, TESTNETS, unhex, w32 } from "./helper-evm-sender.mjs";
import { check as runCheck, RPCS as RUN_RPCS } from "./pool-evm-testnet-run.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---- The sells the helper sent (a run of contracts/pool-evm/script/testnet-run.mjs --sell-helper) ----

/** Each testnet's run through the helper: helper-evm-sender.run.<network>.json, testnet-run.mjs --out (checkSells only) */
export const sellRunFile = (network, dir = HERE) => path.join(dir, `helper-evm-sender.run.${network}.json`);

/**
 * The runs' sells through the helper, each read back on both RPCs of its chain: pool-evm-testnet-run's check of the
 * whole run (every transaction landed on both, each sell a type-4 transaction to W whose one authorization names the
 * chain's pinned SellDelegate with the chain's id, W's Deposited into the pool), and for each sell the helper sent:
 * the sender is the helper's sell sender (`senders[network]`, its fee answer's sell_sender), the gas limit exactly
 * 1,000,000, the authorization's signer W, and the fee it took (the call's fee word: the SellDelegate these runs used paid
 * it to its caller, pool-review-3's pays it to the Sell's feeRecipient) at least the sale's cost (gasUsed x
 * effectiveGasPrice, plus the receipt's L1 fee on Base); and every testnet has one such sell.
 */
export async function checkSells(runs, transportOf, senders) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  // the networks with a sell the helper sent whose run and own reads were all ok on both RPCs (a record lists only the
  // rows that landed, testnet-run.mjs, so its rows carry no landed field: landing is what these reads show)
  const readBack = new Set();
  for (const run of runs) {
    const rec = run.record;
    const n = rec.chain;
    const transport = transportOf(run);
    const urls = run.urls ?? RUN_RPCS[n];
    const r = await runCheck(rec, transport, urls);
    for (const l of r.lines) say(r.ok, `[${n} run] ${l}`);
    if (!r.ok) continue;
    for (const t of rec.txs.filter((x) => x.kind === "sell" && x.via === "helper")) {
      const before = lines.length;
      // the fields read here, equal on both RPCs (one Robinhood RPC adds blockTimestamp to a transaction, the other not)
      const both = async (method, params, fields) => {
        const rs = await Promise.all(urls.map((u) => transport(u, method, params)));
        if (rs.some((x) => "error" in x || x.result == null)) throw new Error(`${method} ${t.hash}: ${show(rs.map((x) => x.error ?? null))}`);
        const [a, b] = rs.map((x) => JSON.stringify(fields.map((f) => x.result[f] ?? null)));
        if (a !== b) throw new Error(`${method} ${t.hash}: the two RPCs answer ${a} and ${b}`);
        return rs[0].result;
      };
      try {
        const tx = await both("eth_getTransactionByHash", [t.hash], ["hash", "blockHash", "type", "from", "to", "gas", "input", "authorizationList"]);
        const rc = await both("eth_getTransactionReceipt", [t.hash], ["transactionHash", "blockHash", "status", "gasUsed", "effectiveGasPrice", "l1Fee"]);
        const from = String(tx.from).toLowerCase();
        say(senders[n] != null && from === senders[n], `[${n} sell ${t.hash}] sent by ${from}, the helper's sell sender ${show(senders[n])}`);
        say(BigInt(tx.gas) === SELL_GAS, `[${n} sell ${t.hash}] gas limit ${BigInt(tx.gas)}, want ${SELL_GAS}`);
        const a = (tx.authorizationList ?? [])[0];
        const items = cat(rlpShort([int(BigInt(a.chainId)), unhex(a.address), int(BigInt(a.nonce))]));
        const digest = keccak_256(cat(Uint8Array.of(5), items));
        const sig = Uint8Array.from([Number(BigInt(a.yParity ?? a.v)), ...unhex(w32(BigInt(a.r))), ...unhex(w32(BigInt(a.s)))]);
        const pub = secp256k1.Point.fromBytes(secp256k1.recoverPublicKey(sig, digest, { prehash: false })).toBytes(false);
        const signer = `0x${hex(keccak_256(pub.subarray(1)).subarray(12))}`;
        say(signer === String(t.w).toLowerCase(), `[${n} sell ${t.hash}] the authorization is signed by ${signer}, W ${t.w}`);
        const fee = BigInt(`0x${String(tx.input).slice(10 + 64, 10 + 128)}`);
        const cost = BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice) + (rc.l1Fee ? BigInt(rc.l1Fee) : 0n);
        say(fee >= cost, `[${n} sell ${t.hash}] the fee ${fee} covers the cost ${cost}, by ${fee - cost}`);
      } catch (e) {
        say(false, `[${n} sell ${t.hash}] ${e.message}`);
      }
      if (lines.slice(before).every((l) => l.startsWith("ok "))) readBack.add(n);
    }
  }
  for (const n of TESTNETS) {
    say(readBack.has(n), `[${n}] a sell the helper sent, read back (${path.basename(sellRunFile(n))})`);
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}
