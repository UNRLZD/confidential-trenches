// Builds and signs the fork sells with the kit (card evm-pool-sell-tx) into contracts/pool-evm/test/fixtures/
// kit-sells.json, which SellFork.t.sol test_theKitsSellLands sends through SellDelegate.sell. FORK holds the fork's own
// values at the pinned blocks (W's token balance after the setUp buy, QuoterV2's quote for it, the block's timestamp,
// W's account nonce; the pool and delegate the test deploys), which that test asserts equal before it sends. The sells
// go through the pinned functions the index exports, with the test's pool and delegate as the venue list's pins, and
// the device's clock at each block's time. test/evm-pool-sell.test.ts holds forkSells() equal to the fixture.
//   node packages/kit/test/make-kit-sells.ts
import { writeFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hmac } from "@noble/hashes/hmac.js";
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { fileURLToPath } from "node:url";
import { evmPoolVenues, type EvmPoolVenue } from "../src/trade/evm/buy-unpinned.ts";
import { pinnedBuildSell, pinnedSignSell, pinnedSignSellAuthorization } from "../src/trade/evm/sell-unpinned.ts";
const hex = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");
const N = secp256k1.Point.CURVE().n;
function key(): Uint8Array {
  const seed = pbkdf2(sha512, new TextEncoder().encode("test test test test test test test test test test test junk"), new TextEncoder().encode("mnemonic"), { c: 2048, dkLen: 64 });
  let I = hmac(sha512, new TextEncoder().encode("Bitcoin seed"), seed);
  let k = BigInt(hex(I.slice(0, 32))); let c = I.slice(32);
  for (const [i, hard] of [[44, true], [60, true], [0, true], [0, false], [0, false]] as [number, boolean][]) {
    const kb = Buffer.from(k.toString(16).padStart(64, "0"), "hex");
    const head = hard ? Uint8Array.of(0, ...kb) : secp256k1.getPublicKey(kb, true);
    const idx = Buffer.alloc(4); idx.writeUInt32BE(hard ? i + 0x80000000 : i);
    I = hmac(sha512, c, Uint8Array.of(...head, ...idx)); k = (BigInt(hex(I.slice(0, 32))) + k) % N; c = I.slice(32);
  }
  return Buffer.from(k.toString(16).padStart(64, "0"), "hex");
}
const W = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const POOL = "0x2e234DAe75C793f67A35089C9d99245E1C58470b";
const DELEGATE = "0xF62849F9A0B5Bf2913b396098F7c7019b51A820a";
const FORK = {
  base: { sells: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", fee: 500, amount: 903370169n, quote: 399600103610838585n, ts: 1793669347, wNonce: 3442025n },
  robinhood: { sells: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", fee: 100, amount: 903193966n, quote: 399920003955851420n, ts: 1793669311, wNonce: 1885n },
} as const;
// the venue list with the fork's pool and delegate pinned
const pinned = (v: EvmPoolVenue): EvmPoolVenue => Object.freeze({ ...v, pool: POOL, sellDelegate: DELEGATE });
const VENUES = Object.freeze({ base: pinned(evmPoolVenues().base), robinhood: pinned(evmPoolVenues().robinhood) });

/** The fork sells, built and signed by the kit; `at(sec, f)` runs f with the device's clock at `sec`. */
export function forkSells(at: <T>(sec: number, f: () => T) => T): Record<string, unknown> {
const out: Record<string, unknown> = {};
const W_KEY = key();
for (const [chain, f] of Object.entries(FORK) as [keyof typeof FORK, (typeof FORK)[keyof typeof FORK]][]) {
  const v = evmPoolVenues()[chain];
  const minOut = (f.quote * 99n) / 100n;
  const built = at(f.ts, () => pinnedBuildSell(VENUES, chain, {
    w: W, token: f.sells, amount: f.amount, target: v.routers[0]!, route: { venue: "uniswap-v3", tokens: [f.sells, v.weth], fees: [f.fee] },
    minOut, precommitment: 0x5e11n, feeCap: 5n * 10n ** 14n, deadline: BigInt(f.ts + 300), nonce: 0n,
  }));
  const a = pinnedSignSellAuthorization(VENUES, W_KEY, chain, f.wNonce);
  out[chain] = {
    sells: built.token, amount: built.amount.toString(), target: built.target, data: built.data, minOut: built.minOut.toString(), pool: built.pool,
    precommitment: built.precommitment.toString(), feeCap: built.feeCap.toString(), deadline: built.deadline.toString(), nonce: built.nonce.toString(),
    signature: hex(pinnedSignSell(VENUES, W_KEY, chain, built)),
    authorization: { chainId: a.chainId, delegate: a.address, nonce: a.nonce.toString(), yParity: a.yParity, r: a.r, s: a.s },
  };
}
return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const clock = <T>(sec: number, f: () => T): T => {
    const now = Date.now;
    Date.now = () => sec * 1000;
    try {
      return f();
    } finally {
      Date.now = now;
    }
  };
  writeFileSync(fileURLToPath(new URL("../../../contracts/pool-evm/test/fixtures/kit-sells.json", import.meta.url)), JSON.stringify(forkSells(clock), null, 1) + "\n");
  console.log("wrote kit-sells.json");
}
