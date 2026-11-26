// Who runs each public RPC the money gate reads on Solana, Base and Robinhood: two reads count as two only when two
// different operators answer them (NEAR's map, with its scan, is near-rpc-operators.mjs). Each host is named by its
// operator's own page, read 2026-11-01 between 09:05 and 09:10Z:
//  - api.mainnet-beta.solana.com: the Solana cluster's public RPC (docs.anza.xyz/clusters/available, "RPC URL for
//    Mainnet Beta: https://api.mainnet-beta.solana.com").
//  - solana-mainnet.gateway.tatum.io: Tatum (tatum.io/chain/solana names it the Solana mainnet gateway; read 2026-11-26
//    05:5xZ, its answers carry x-ttm-plan anonymous). It stands where public.rpc.solanavibestation.com (Solana Vibe
//    Station) stood until it refused every connection (card money-gate-solana-reads-on-two-operators).
//  - public.rpc.solanavibestation.com: Solana Vibe Station, "on hardware we run ourselves" (solanavibestation.com,
//    "curl https://public.rpc.solanavibestation.com"). No longer in the gate's list (money-gate-reads.mjs); kept here so
//    a recording read on it (the live checks' answers files) still names its operator.
//  - solana-rpc.publicnode.com: PublicNode (solana.publicnode.com, "Endpoint Link ... https://solana-rpc.publicnode.com",
//    read 2026-11-21 at 21:16Z; its page says "Archive data available", but its getFirstAvailableBlock answered
//    471,786,675, 20 Nov 15:25Z, at 21:12Z, so the money gate counts its null only where that block reaches the tx:
//    card money-gate-solana-reads-past-one-stall).
//  - mainnet.base.org: Base (docs.base.org/base-chain/quickstart/connecting-to-base, "RPC endpoint
//    https://mainnet.base.org").
//  - base.drpc.org: dRPC (drpc.org/chainlist/base-mainnet-rpc, "New RPC URL https://base.drpc.org").
//  - rpc.mainnet.chain.robinhood.com: Robinhood (docs.robinhood.com/chain/connecting, "RPC
//    https://rpc.mainnet.chain.robinhood.com").
//  - robinhood-rpc.publicnode.com: PublicNode (robinhood.publicnode.com, "RPC Endpoint ... https://robinhood-rpc.publicnode.com").
//  - api.devnet.solana.com: the Solana cluster's public devnet RPC (docs.anza.xyz/clusters/available, "RPC URL for
//    Devnet: https://api.devnet.solana.com").
//  - solana-devnet.api.onfinality.io: OnFinality's public devnet endpoint (its /public path, keyless, rate-limited);
//    it answered getGenesisHash with devnet's EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG on 2026-11-02 at 23:12Z.
// The EVM test networks, each page read 2026-11-03 at 03:09Z, each host answering its chain id at 03:07Z:
//  - sepolia.base.org: Base (docs.base.org/base-chain/quickstart/connecting-to-base, "RPC endpoint ...
//    https://sepolia.base.org", Base Sepolia, chain ID 84532).
//  - base-sepolia-rpc.publicnode.com: PublicNode (chainid.network/chains.json, chain 84532 "Base Sepolia Testnet").
//  - rpc.testnet.chain.robinhood.com: Robinhood (docs.robinhood.com/chain/connecting, "RPC ...
//    https://rpc.testnet.chain.robinhood.com", Robinhood Chain Testnet, chain ID 46630).
//  - robinhood-sepolia-rpc.publicnode.com: PublicNode (chainid.network/chains.json, chain 46630 "Robinhood Chain
//    Testnet").
/** chain -> host -> operator */
export const RPC_OPERATORS = Object.freeze({
  solana: Object.freeze({ "api.mainnet-beta.solana.com": "solana", "solana-mainnet.gateway.tatum.io": "tatum", "public.rpc.solanavibestation.com": "solanavibestation", "solana-rpc.publicnode.com": "publicnode" }),
  base: Object.freeze({ "mainnet.base.org": "base", "base.drpc.org": "drpc" }),
  robinhood: Object.freeze({ "rpc.mainnet.chain.robinhood.com": "robinhood", "robinhood-rpc.publicnode.com": "publicnode" }),
  "solana-devnet": Object.freeze({ "api.devnet.solana.com": "solana", "solana-devnet.api.onfinality.io": "onfinality" }),
  "base-sepolia": Object.freeze({ "sepolia.base.org": "base", "base-sepolia-rpc.publicnode.com": "publicnode" }),
  "robinhood-testnet": Object.freeze({ "rpc.testnet.chain.robinhood.com": "robinhood", "robinhood-sepolia-rpc.publicnode.com": "publicnode" }),
});
