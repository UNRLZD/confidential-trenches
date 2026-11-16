// Card helper-ready-never-waits-on-a-testnet-pool: the helper's ready is mainnet's alone (owner, 12 Nov: no test
// networks). Each pool's start check was part of ready (server.ts poolsChecked, readyGate), so a test network's
// provider could hold every deploy: on 16 Nov 13:4xZ Robinhood testnet's dRPC answered eth_call -32601 and PublicNode
// 403, the robinhood-testnet pool's ready() refused after its 90 s bound, and the new helper never got ready. A test
// network's pool still loads while live checks read it; its start check runs beside ready and never holds it.

/** The pool networks whose start checks the helper's ready waits for: the mainnets, by name. Any other is a test
 *  network, so a network the readers learn later is a test network unless it is listed here. */
export const MAINNET_POOL_NETWORKS = { evm: ["base", "robinhood"], solana: ["mainnet"] } as const;

/** Whether an EVM pool's network is a mainnet (MAINNET_POOL_NETWORKS.evm). */
export const isMainnetEvm = (network: string): boolean => (MAINNET_POOL_NETWORKS.evm as readonly string[]).includes(network);
/** Whether a Solana pool's cluster is mainnet (MAINNET_POOL_NETWORKS.solana). */
export const isMainnetSolana = (cluster: string): boolean => (MAINNET_POOL_NETWORKS.solana as readonly string[]).includes(cluster);
