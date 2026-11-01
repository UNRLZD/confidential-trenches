// Who runs each public RPC the money gate reads on Solana, Base and Robinhood: two reads count as two only when two
// different operators answer them (NEAR's map, with its scan, is near-rpc-operators.mjs). Each host is named by its
// operator's own page, read 2026-11-01 between 09:05 and 09:10Z:
//  - api.mainnet-beta.solana.com: the Solana cluster's public RPC (docs.anza.xyz/clusters/available, "RPC URL for
//    Mainnet Beta: https://api.mainnet-beta.solana.com").
//  - public.rpc.solanavibestation.com: Solana Vibe Station, "on hardware we run ourselves" (solanavibestation.com,
//    "curl https://public.rpc.solanavibestation.com").
//  - mainnet.base.org: Base (docs.base.org/base-chain/quickstart/connecting-to-base, "RPC endpoint
//    https://mainnet.base.org").
//  - base.drpc.org: dRPC (drpc.org/chainlist/base-mainnet-rpc, "New RPC URL https://base.drpc.org").
//  - rpc.mainnet.chain.robinhood.com: Robinhood (docs.robinhood.com/chain/connecting, "RPC
//    https://rpc.mainnet.chain.robinhood.com").
//  - robinhood-rpc.publicnode.com: PublicNode (robinhood.publicnode.com, "RPC Endpoint ... https://robinhood-rpc.publicnode.com").
/** chain -> host -> operator */
export const RPC_OPERATORS = Object.freeze({
  solana: Object.freeze({ "api.mainnet-beta.solana.com": "solana", "public.rpc.solanavibestation.com": "solanavibestation" }),
  base: Object.freeze({ "mainnet.base.org": "base", "base.drpc.org": "drpc" }),
  robinhood: Object.freeze({ "rpc.mainnet.chain.robinhood.com": "robinhood", "robinhood-rpc.publicnode.com": "publicnode" }),
});
