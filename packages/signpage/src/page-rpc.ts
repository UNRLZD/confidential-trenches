// The signing page's one RPC client (card signpage-rpc-throttle-retry): the kit's solanaJsonRpc with the page's retry
// (SOLANA_RPC_RETRY), for every chain's pool reads and sends, testnet and mainnet alike. A throttle (HTTP 429, a 5xx,
// -32029 or -32429 in a 200), an answer that is not JSON, a stall or a dropped connection is tried again within the
// call's 3.5 s, its Retry-After honoured; a call that still fails rejects naming its fault (SolanaRpcTransportError).
import { SOLANA_RPC_RETRY, solanaHelperRpc, solanaJsonRpc, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";

/** A provider the device reaches directly. */
export const pageRpc = (url: string): SolanaRpc => solanaJsonRpc(url, { retry: SOLANA_RPC_RETRY });
/** The helper's POST /v1/rpc/solana, `origin` the helper's origin only. */
export const pageHelperRpc = (origin: string): SolanaRpc => solanaHelperRpc(origin, { retry: SOLANA_RPC_RETRY });
