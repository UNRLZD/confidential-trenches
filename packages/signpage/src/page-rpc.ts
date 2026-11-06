// The signing page's one RPC client (card signpage-rpc-throttle-retry): the kit's solanaJsonRpc with the page's retry
// (SOLANA_RPC_RETRY), for every chain's pool reads and sends, testnet and mainnet alike. A throttle (HTTP 429, a 5xx,
// -32029 or -32429 in a 200), an answer that is not JSON, a stall or a dropped connection is tried again within the
// call's 3.5 s, its Retry-After honoured; a call that still fails rejects naming its fault (SolanaRpcTransportError).
import { readSolanaReference, type SolanaReference, type SolanaReferenceRequest } from "../../kit/src/trade/solana/pool.ts";
import { SOLANA_RPC_RETRY, SolanaRpcTransportError, solanaHelperRpc, solanaJsonRpc, solanaSameProvider, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";

/** A provider the device reaches directly. */
export const pageRpc = (url: string): SolanaRpc => solanaJsonRpc(url, { retry: SOLANA_RPC_RETRY });
/** The helper's POST /v1/rpc/solana, `origin` the helper's origin only. */
export const pageHelperRpc = (origin: string): SolanaRpc => solanaHelperRpc(origin, { retry: SOLANA_RPC_RETRY });

/**
 * The kit's readSolanaReference on the page's two providers, where a provider whose read still failed after the page's
 * own retry is that fault, thrown, never "no reference" (card pool-read-down): the kit answers a failed read and a pool
 * that is not there alike, as null, and the pool kinds answer null quote_check_failed. Both providers' reads are still
 * the reference's, and only a null with a failed read is the fault's; the kit's one-provider refusal is held here first,
 * since the watch wraps each provider.
 */
export async function pageReference(rpcs: readonly [SolanaRpc, SolanaRpc], req: SolanaReferenceRequest): Promise<SolanaReference | null> {
  if (solanaSameProvider(rpcs[0], rpcs[1])) throw new Error("the two providers are the same provider: a reference must never rest on one provider's word");
  let fault: SolanaRpcTransportError | null = null;
  const watch = (rpc: SolanaRpc): SolanaRpc => {
    const w = async (method: string, params: readonly unknown[]): Promise<unknown> => {
      try {
        return await rpc(method, params);
      } catch (e) {
        if (e instanceof SolanaRpcTransportError) fault ??= e;
        throw e;
      }
    };
    return rpc.url === undefined ? w : Object.assign(w, { url: rpc.url });
  };
  const ref = await readSolanaReference([watch(rpcs[0]), watch(rpcs[1])], req);
  if (ref === null && fault !== null) throw fault;
  return ref;
}
