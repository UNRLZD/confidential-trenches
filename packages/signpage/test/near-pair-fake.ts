// The NEAR flows' deps.pair for the tests' fake worlds (card near-quote-under-the-pace): the world's own W read, then its
// quote, then (with a baseline) W's read of the other side, each read at call time so a test that swaps the world's
// readWallet or quote mid-run is read through. The page binds the kit's readNearSwapPair instead (src/near-buy.ts).
import type { RheaQuote, RheaQuoteArgs } from "../../kit/src/near/rhea.ts";
import type { NearSwapWalletArgs, NearSwapWalletState } from "../../kit/src/trade/near/wallet.ts";
import type { NearPair, NearPairAsk } from "../src/near-trade.ts";

/** The world's own W read and quote (a sell world keeps its quote beside the deps). */
export type Reads = {
  readWallet(a: Pick<NearSwapWalletArgs, "wallet" | "side" | "token">): Promise<NearSwapWalletState>;
  quote(a: Pick<RheaQuoteArgs, "side" | "token" | "amountIn">): Promise<RheaQuote>;
};
export function fakePair(get: () => Reads): (a: NearPairAsk) => Promise<NearPair> {
  return async (a) => {
    const d = get();
    const state = await d.readWallet({ wallet: a.wallet, side: a.side, token: a.token });
    const quote = await d.quote({ side: a.side, token: a.token, amountIn: a.amountIn });
    if (a.baseline === undefined) return { state, quote };
    return { state, quote, baseline: (await d.readWallet({ wallet: a.wallet, side: a.side === "buy" ? "sell" : "buy", token: a.token })).held };
  };
}
/** A sell world's deps keep their quote beside the flow's (the sell's flow reads through deps.pair alone). */
export type WithQuote = Pick<Reads, "quote">;
