// Records the reads the trade carry makes (src/bind/trade.ts createTradeReads, and carryTrade's creation path), as
// JSON-RPC calls and their answers on testnet's two providers, for src/bind/trade-reads.test.ts to replay (card
// relayer-near-trade). Reads only; no key, nothing signed or sent.
//   node apps/helper/test/record-trade-reads.ts <out.json>
// PAID is the recipient of the testnet vault's paid spends rows 0 and 2 (and settled 3, 4 with refund_value 0); FRESH an
// id with no account and no payout. A block is kept to the header fields the reads use.
import { writeFileSync } from "node:fs";
import { nearRpc, RpcError, type Rpc } from "../src/bind/send.ts";
import { carryTrade, createTradeReads, type TradeDeps } from "../src/bind/trade.ts";
import { WATCHED } from "../src/token-status/status.ts";

export const PAIR = ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"] as const;
export const PAID = "4b6c00c36c05f3bc849f158da640409a0d4b395354ba07fdcd94f9316234599a";
export const FRESH = "c0ffee".padEnd(64, "0");
export const OUT_TOKEN = "wrap.testnet";
/** The testnet exchange (the kit's NEAR_RHEA.testnet), whose pool 0 is read for the hop check. */
export const EXCHANGE = "ref-finance-101.testnet";

type Call = { url: string; method: string; params: unknown; result?: unknown; error?: unknown };
const calls: Call[] = [];
const logged = (url: string): Rpc => {
  const r = nearRpc(url);
  return async (method, params) => {
    try {
      const result = await r(method, params);
      const h = method === "block" ? (result as { header: Record<string, unknown> }).header : undefined;
      const kept = h ? { header: { height: h.height, hash: h.hash, prev_height: h.prev_height, gas_price: h.gas_price, timestamp_nanosec: h.timestamp_nanosec } } : result;
      calls.push({ url, method, params, result: kept });
      return result;
    } catch (e) {
      if (e instanceof RpcError) calls.push({ url, method, params, error: e.data });
      throw e;
    }
  };
};

const now = Date.now();
const rpcs = [logged(PAIR[0]), logged(PAIR[1])] as const;
// the testnet vault (contracts/vault/deployments/testnet-v1.json account_id) and its asset, the helper's testnet token
const net = { vault: "vault.bf-vt-20261102t071444.testnet", usdc: WATCHED.testnet.token };
const reads = createTradeReads(rpcs, net.vault, net.usdc, () => now, EXCHANGE);
const got = {
  paidLanded: await reads.payoutLanded(PAID),
  freshLanded: await reads.payoutLanded(FRESH),
  paidAccount: await reads.account(PAID),
  freshAccount: await reads.account(FRESH),
  storageMin: (await reads.storageMin(OUT_TOKEN)).toString(),
  freshRegistered: (await reads.registered([OUT_TOKEN], FRESH))[0],
  paidUsdc: (await reads.ftBalance(net.usdc, PAID)).toString(),
  hopUsdcWrap: await reads.hopsReal([{ pool: 0, tokenIn: net.usdc, tokenOut: OUT_TOKEN }]),
};
// the creation path on the real reads, with a relayer that may not send: every answer is a refusal before it
const relayer = {
  account: "standin.testnet",
  key: "standin.testnet/ed25519:none",
  balance: async () => 10n ** 27n,
  send: async () => {
    throw new Error("the recorder never sends");
  },
  resolve: async () => {
    throw new Error("the recorder never sends");
  },
};
const store = { get: () => null, create: (rec: never) => ({ created: true, rec }), put() {}, close() {} };
const deps = { cfg: { network: "testnet", marginK: 30n }, reads, store, relayer, held: async () => false } as unknown as TradeDeps;
const trade = (wallet: string) => ({ network: "testnet", side: "buy", token: OUT_TOKEN, wallet, amount_in: "1000000", slippage_bps: 100, venue_out: "1", hops: [{ pool: 0, token_in: net.usdc, token_out: OUT_TOKEN }] });
const answers = {
  paid: await carryTrade({ trade: trade(PAID), signed_delegates: [] }, deps),
  fresh: await carryTrade({ trade: trade(FRESH), signed_delegates: [] }, deps),
};
const out = process.argv[2];
if (out === undefined) throw new Error("usage: record-trade-reads.ts <out.json>");
writeFileSync(out, `${JSON.stringify({ recorded: new Date(now).toISOString(), now, pair: PAIR, vault: net.vault, usdc: net.usdc, got, answers, calls })}\n`);
console.log(JSON.stringify({ got, answers, calls: calls.length }));
