// Captures the recorded answers for test/pool-usd.test.ts: the kit's own price reads (src/price/pool-usd.ts
// poolUsdPrice) on two public RPCs of two providers per chain, every call and its answer as the RPC gave it. Solana is
// read again until the two RPCs agree on the first read, so the recording holds one round. Reads only: nothing is
// signed or sent, and no key is used.
//   node packages/kit/test/fixtures/pool-usd-capture.mjs > packages/kit/test/fixtures/pool-usd.json
import { poolUsdPrice } from "../../src/price/pool-usd.ts";
import { solanaJsonRpc } from "../../src/trade/solana/send.ts";

const RPCS = {
  solana: ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"],
  base: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
  robinhood: ["https://robinhood-rpc.publicnode.com", "https://robinhood.drpc.org"],
};

function recording(url, calls) {
  const rpc = solanaJsonRpc(url);
  return Object.assign(async (method, params) => {
    const result = await rpc(method, params);
    calls.push({ url, method, params: structuredClone(params), result: structuredClone(result) });
    return result;
  }, { url });
}

const out = {};
for (const [chain, urls] of Object.entries(RPCS)) {
  for (let tries = 0; ; tries++) {
    const calls = [];
    const p = await poolUsdPrice({ chain, rpcs: urls.map((u) => recording(u, calls)) });
    if (chain !== "solana" || calls.length === 2 || tries >= 10) {
      out[chain] = { rpcs: urls, calls };
      console.error(`${chain}: price ${p.price} x 10^${p.expo}, published ${new Date(p.publishedS * 1000).toISOString()}, at ${p.at}`);
      break;
    }
  }
}
const nowMs = Date.now();
console.log(JSON.stringify({ read: new Date(nowMs).toISOString(), nowMs, ...out }, null, 1));
