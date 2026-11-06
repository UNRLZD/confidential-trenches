// Card pool-read-down: one provider down, as OnFinality's public devnet endpoint was in the run at 967c52d6 (256
// HTTP 429s; its getAccountInfo of the mint still failing after the page's four tries). From its `from`-th call on (0:
// the first), every call of the wrapped provider rejects with the page's named fault after its retry
// (SolanaRpcTransportError, src/page-rpc.ts); `fired()` tells whether one did.
import { SolanaRpcTransportError } from "../../kit/src/trade/solana/send.ts";

type Rpc = (method: string, params: readonly unknown[]) => Promise<unknown>;

export function outage<R extends Rpc>(rpc: R, from: number): { rpc: R; fired: () => boolean } {
  let n = 0;
  let fired = false;
  const down = (async (method: string, params: readonly unknown[]) => {
    if (n++ >= from) {
      fired = true;
      throw new SolanaRpcTransportError("http_429", "HTTP 429", 4, "provider.down.example");
    }
    return rpc(method, params);
  }) as R;
  return { rpc: down, fired: () => fired };
}

/** The pair with provider `p` down from its `from`-th call. */
export function pairDown<R extends Rpc>(rpcs: readonly [R, R], p: 0 | 1, from: number): { rpcs: readonly [R, R]; fired: () => boolean } {
  const o = outage(rpcs[p], from);
  return { rpcs: (p === 0 ? [o.rpc, rpcs[1]] : [rpcs[0], o.rpc]) as readonly [R, R], fired: o.fired };
}
