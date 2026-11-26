// What the money gate reads with: its public RPCs per chain and its FLOOR, held here alone and imported by
// money-gate.mjs, which exports both, so a live check that reads on the gate's hosts takes this one list and never
// drifts from it, without taking the gate's code (card money-gate-solana-reads-past-one-stall).
// Public RPCs, none ours; each answered a tx read on 2026-10-26 between 11:48 and 11:54Z. NEAR lists two operators on
// three hosts: FastNEAR's archival RPC, dRPC (which keeps only recent txs, enough for a fresh live record), and
// near.org's archival RPC, which FastNEAR runs (near-rpc-operators.mjs): a second door to FastNEAR when its own host
// rate-limits, never a second operator.
export const RPCS = {
  near: ["https://archival-rpc.mainnet.fastnear.com", "https://near.drpc.org", "https://archival-rpc.mainnet.near.org"],
  // card money-gate-solana-reads-past-one-stall: PublicNode, a third operator, so a tx passes on two operators' reads
  // while one stalls past the rounds. It keeps recent history only (its first available block 471,786,675, 20 Nov
  // 15:25Z, read 21 Nov 21:12Z; the oldest recorded tx, 5wGExGur at slot 466,032,982, reads null there and ok on the two
  // others): its null counts only where its history reaches the tx (solanaAbsent)
  // card money-gate-solana-reads-on-two-operators: Tatum's keyless gateway in Solana Vibe Station's place, which refused
  // every connection (24 Nov from the helper box and the Mac; 26 Nov 05:5xZ from the Mac), so an old tx read ok on
  // api.mainnet-beta alone and run 45748862432's --all left 28 Solana txs unread. Tatum read 26 Nov 05:5xZ from the Mac:
  // getTransaction of 58Z69tiM (slot 468,415,987) ok, the same slot as api.mainnet-beta, which PublicNode answers null;
  // keyless, 5 calls a minute (x-ttm-plan anonymous, then HTTP 429 with Retry-After 60, which rpc() waits out)
  solana: ["https://api.mainnet-beta.solana.com", "https://solana-mainnet.gateway.tatum.io", "https://solana-rpc.publicnode.com"],
  base: ["https://mainnet.base.org", "https://base.drpc.org"],
  robinhood: ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood-rpc.publicnode.com"],
  // NEAR testnet, read 2026-10-31 at 16:16Z: the same two operators on three hosts, as for mainnet.
  // test.rpc.fastnear.com and near-testnet.drpc.org keep only recent txs (each answered UNKNOWN_TRANSACTION for a
  // 2026-10-26 tx that both archival RPCs read), so FastNEAR's archival RPC stands in for its test.rpc.
  "near-testnet": ["https://archival-rpc.testnet.fastnear.com", "https://near-testnet.drpc.org", "https://archival-rpc.testnet.near.org"],
  // Solana devnet, read 2026-11-02 between 23:12 and 23:14Z: the cluster's public RPC and OnFinality's public devnet
  // endpoint each answered getTransaction for one devnet signature (rpc-operators.mjs names both).
  "solana-devnet": ["https://api.devnet.solana.com", "https://solana-devnet.api.onfinality.io/public"],
  // Base Sepolia and Robinhood's testnet, read 2026-11-03 between 03:07:14 and 03:07:19Z: each host answered its
  // chain's eth_chainId (0x14a34, 0xb626) and eth_getTransactionReceipt with status 0x1 for one testnet tx, which the
  // mainnet RPCs above answered as unknown (rpc-operators.mjs names each host's operator).
  "base-sepolia": ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"],
  "robinhood-testnet": ["https://rpc.testnet.chain.robinhood.com", "https://robinhood-sepolia-rpc.publicnode.com"],
};

// The build starts here: a tx before it is not this repo's (a pasted research tx, say).
export const FLOOR = Date.parse("2026-11-01T00:00:00Z");
