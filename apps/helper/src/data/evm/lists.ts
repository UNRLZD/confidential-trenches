// GET /v1/market/lists?chain=base and ?chain=robinhood: Discover's EVM lists in the frozen Solana row (../solana/lists.ts
// ROW_FIELDS, the terminal's apps/terminal/src/screens/discover/fields.ts), every row tagged with the launchpad whose
// factory made the token (owner 3 Nov 10:11Z), read on chain.
//
// Lists: GeckoTerminal's keyless `networks/<net>/new_pools` and `trending_pools?duration=5m|1h` (D-E2, M:2315; D-E6
// names the same networks), page 1 each (20 pools), with the pools' base tokens included. GeckoTerminal answers one
// address a few calls a minute (../gecko.ts), shared with the Solana token page's candles, which go first: each tick
// reads the stalest list older than LIST_MS, one call at a time while the "lists" lane yields a call, so the lists
// slow down while pages are opened. Once a list is read the lists never answer 503: a snapshot behind STALE_MS is
// served as is, dated by its as_of_ms and X-Helper-Fetched-At (the oldest list read), while the next tick reads again.
//
// Launchpad (the maker), read on two RPC providers that must answer and agree; a token no listed launchpad made gets
// null, never a guess. A token's maker never changes, so it is read once and kept (MAKER_MAX tokens); a refresh reads
// only tokens it has not settled.
// - Robinhood: each launchpad's own record of the tokens it made (RECORDS), read at the latest block, so a later pool
//   of an older token (the row's time is the pool's, not the token's) never settles it as none, with no archive read
//   (none of Robinhood's keyless providers serves old state).
// - Base: the block the token's pool was made in, then one `eth_getLogs` over that block and the one before it,
//   filtered to the chain's FACTORIES and their creation events; the row's launchpad is the pad whose factory's
//   creation event names the token where that event puts the new token. A pad's tokens are made with their pool in one
//   transaction, so the pool's block is the token's; a token with code before its pool is read again where its code
//   first appears (Base's first provider serves old state).
//
// Display only: nothing here feeds a signature. Every vendor and RPC value is hostile input, checked as in the Solana
// lists: a row with no valid address, symbol or name is dropped, numbers are checked finite and bounded or become null,
// text is cut and stripped, a list holds at most LIST_MAX rows, and an RPC log is used only when its emitter, topic0
// and token word match the table exactly.
import { gzipSync } from "node:zlib";
import { dec, LIST_MAX, ROW_FIELDS, text, type ListsAnswer, type Row } from "../solana/lists.ts";
import { throttledUntil, type GeckoBudget } from "../gecko.ts";
import { evmThrottleS, upstreamRetryAfterS, type ProviderHolds } from "../../limits/limits.ts";

export const EVM_CHAINS = ["base", "robinhood"] as const;
export type EvmChain = (typeof EVM_CHAINS)[number];
/** `unsettled`: the listed tokens whose maker is not read yet; their rows' launchpad null means "not read yet", every
 *  other row's null means no listed factory made the token. `pools`: each listed token's pool as its list names it (a
 *  v4 pool id or a pool's address; Trending 1h's row first, then 5m's, then New's), which the swap reads take as a hint
 *  and check on chain before reading it (swaps.ts fromHint, card helper-robinhood-capacity fold 3). Neither is a row
 *  field: the frozen rows are unchanged. */
export type EvmSnapshot = { chain: EvmChain; lists: Record<"new" | "trending" | "trending_5m" | "trending_1h" | "graduating", Row[]>; as_of_ms: number; unsettled: string[]; pools: Record<string, string> };

export const GT_BASE = "https://api.geckoterminal.com/api/v2";
/** GeckoTerminal's network id per chain (read 2026-11-03 11:25Z: `networks/base/new_pools` and `networks/robinhood/new_pools`, 20 pools each). */
export const GT_NETWORK: Readonly<Record<EvmChain, string>> = { base: "base", robinhood: "robinhood" };
export const LIST_KEYS = ["new", "trending_5m", "trending_1h"] as const;
type ListKey = (typeof LIST_KEYS)[number];
export const GT_READS = {
  new: "new_pools?include=base_token&page=1",
  trending_5m: "trending_pools?include=base_token&duration=5m&page=1",
  trending_1h: "trending_pools?include=base_token&duration=1h&page=1",
} as const;
/** A list is read again once its last read is this old, when the lists lane yields a call. */
export const LIST_MS = 60_000;
/** A list this old, or never read, is read even while pages are being opened (still leaving a page one call), so it
 *  never reaches STALE_MS and a helper started while token pages are open still serves its lists. */
export const LIST_URGENT_MS = 240_000;
/** The snapshot is rebuilt on the Solana lists' cadence (D-S2's 12 s): makers not settled yet are read again. */
export const TICK_MS = 12_000;
/** A snapshot whose oldest list read is older than this is behind: still served, dated by its oldest read, never
 *  passed as fresh; a warm file older than this is not taken over (../warm.ts). */
export const STALE_MS = 300_000;
/** A pool younger than this whose block shows no creation event is read again, since a provider may not hold its logs yet. */
export const SETTLE_MS = 60_000;
export const MAKER_MAX = 20_000;
/** Makers read per tick, per provider: one batch of `eth_getLogs` (two filters a token on Base). */
export const MAKER_PER_TICK = 10;
/** Makers read per tick on a chain with RECORDS: every token of the three lists GT_READS reads (page 1, 20 pools each),
 *  one `eth_call` a record in batches of BATCH_MAX, so a helper started fresh settles its lists in its first tick. */
export const RECORDS_PER_TICK = 60;
const ANSWER_MAX = 2 * 1024 * 1024;
const TIMEOUT_MS = 8_000;
const LOGS_MAX = 2_000;

/**
 * Each chain's RPC providers for the maker read, public and keyless, in the order they are asked: a tag needs two that
 * answer and agree (the first two; the third only for a token one of them could not answer). Read 2026-11-03 12:00-12:05Z:
 * Base: base-mainnet.public.blastapi.io answered a batch of 20 `eth_getLogs` over 2023-2026 blocks; base-rpc.publicnode.com
 * answers only recent blocks ("Archive requests require a personal token") and at most 10 addresses a filter;
 * base.drpc.org answers old blocks but batches of at most 3 ("Batch of more than 3 requests are not allowed on free
 * plan") and rate-limits; mainnet.base.org answered every `eth_getLogs` with "request limit reached".
 * Robinhood: rpc.mainnet.chain.robinhood.com, robinhood-rpc.publicnode.com and robinhood.drpc.org each answered a block
 * read; the kit's Robinhood pins read the first and drpc (packages/kit/src/trade/evm/buy-unpinned.ts).
 */
export const MAKER_RPCS: Readonly<Record<EvmChain, readonly [string, string, string]>> = {
  base: ["https://base-mainnet.public.blastapi.io", "https://base-rpc.publicnode.com", "https://base.drpc.org"],
  robinhood: ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood-rpc.publicnode.com", "https://robinhood.drpc.org"],
};
/** Requests per JSON-RPC batch a provider takes (drpc's free plan: 3); others 10. */
/** daybreak counts each call of a batch as one of the about 4 concurrent requests it takes (a batch of 5 at 4 posts a
 *  second refused at its 4th post with -32005 "too many concurrent requests", 2026-11-04 20:51Z, from the Mac): one call a
 *  post, three posts out at once (limits.ts PROVIDER_PACE). */
export const BATCH_MAX: Readonly<Record<string, number>> = { "https://base.drpc.org": 3, "https://robinhood.drpc.org": 3, "https://robinhood.daybreak-rpc.network": 1 };

/** Base makes a block every 2 s from genesis at 1686789347 (eth_getBlockByNumber latest on mainnet.base.org and
 *  base.drpc.org, 2026-11-03 11:28Z: block 53457954 at 1793705255, 1793705255 - 2 x 53457954 = 1686789347). */
export const BLOCK_CLOCK: Readonly<Record<EvmChain, { genesisS: number; blockS: number } | null>> = {
  base: { genesisS: 1686789347, blockS: 2 },
  robinhood: null,
};

/** A factory row: the pad, the contract that makes its tokens (the log's emitter: a proxy's own address), that
 *  contract's creation event (topic0), and where the new token's address sits in it (an indexed topic 1-3, or a 32-byte
 *  word of the data). `shared` marks a factory other pads launch through (Doppler's Airlock): a pad's own factory
 *  naming the same token wins over it. */
export type Factory = { pad: string; address: string; topic0: string; at: { topic: 1 | 2 | 3 } | { word: number }; shared?: true };

// Each event's topic0 is keccak-256 of its signature as the contract's verified ABI writes it, and each token place is
// read from that ABI (Sourcify, sourcify.dev/server/v2/contract/<chain id>/<address>?fields=abi,compilation, every row
// read 2026-11-03 11:52Z, contract name in brackets; a proxy's ABI is its implementation's). Event signatures:
const ZORA_V4 = "0x2de436107c2096e039c98bbcc3c5a2560583738ce15c234557eecb4d3221aa81"; // CoinCreatedV4(address indexed caller,address indexed payoutRecipient,address indexed platformReferrer,address currency,string uri,string name,string symbol,address coin,(address,address,uint24,int24,address) poolKey,bytes32 poolKeyHash,string version)
const ZORA_V3 = "0x3d1462491f7fa8396808c230d95c3fa60fd09ef59506d0b9bd1cf072d2a03f56"; // CoinCreated(address indexed caller,address indexed payoutRecipient,address indexed platformReferrer,address currency,string uri,string name,string symbol,address coin,address pool,string version)
const ZORA_CREATOR = "0x74b670d628e152daa36ca95dda7cb0002d6ea7a37b55afe4593db7abd1515781"; // CreatorCoinCreated(same fields as CoinCreatedV4)
const ZORA_TREND = "0xfb9e81c36dd4134d4eb5055e20d3238cb29a63daef0dd0f8b0f131da85891959"; // TrendCoinCreated(address indexed caller,string symbol,address coin,(address,address,uint24,int24,address) poolKey,bytes32 poolKeyHash,bytes poolConfig,string version)
const CLANKER_V4 = "0x9299d1d1a88d8e1abdc591ae7a167a6bc63a8f17d695804e9091ee33aa89fb67"; // TokenCreated(address msgSender,address indexed tokenAddress,address indexed tokenAdmin,string tokenImage,...)
const CLANKER_V31 = "0x6b04d68ca5c822b9c981d731c83ecb1356b96c8596c7659d397d234856a4537b"; // TokenCreated(address indexed tokenAddress,address indexed creatorAdmin,address indexed interfaceAdmin,...)
const CLANKER_V3 = "0x8df367d10c042c43a79f6842addf298c4b250b4cb2145cae311c9ba110ff8e17"; // TokenCreated(address tokenAddress,uint256 positionId,address deployer,uint256 fid,string name,string symbol,uint256 supply,string castHash)
const CLANKER_V1 = "0x0e9d60e5c5597233717659e7b39411e0a61e7177252521b9c6f515f75f6fef01"; // TokenCreated(address tokenAddress,uint256 positionId,address deployer,uint256 fid,string name,string symbol,uint256 supply,address lockerAddress,string castHash)
const CLANKER_V0 = "0xcd465acec733178787a0c3bc8cd8f6eae657c45b61c6a3e15d13c176c9c536ad"; // TokenCreated(address tokenAddress,uint256 lpNftId,address deployer,string name,string symbol,uint256 supply,uint256 _supply,address lockerAddress)
const DOPPLER_CREATE = "0x68ff1cfcdcf76864161555fc0de1878d8f83ec6949bf351df74d8a4a1a2679ab"; // Create(address asset,address indexed numeraire,address initializer,address poolOrHook)
const VIRTUALS_LAUNCHED = "0x714aa39317ad9a7a7a99db52b44490da5d068a0b2710fffb1a1282ad3cadae1f"; // Launched(address indexed token,address indexed pair,uint256)
const VIRTUALS_GRADUATED = "0x381d54fa425631e6266af114239150fae1d5db67bb65b4fa9ecc65013107e07e"; // Graduated(address indexed token,address agentToken): the agent token, made in this transaction
const VIRTUALS_PERSONA = "0xf9d151d23a5253296eb20ab40959cf48828ea2732d337416716e302ed83ca658"; // NewPersona(uint256 virtualId,address token,address dao,address tba,address veToken,address lp)
const FLAUNCH_POOL = "0xba4a1a749cfb812cb3d32c76acc5ea9089875a6ca8bdf9d0c29382be94088bf5"; // PoolCreated(bytes32 indexed _poolId,address _memecoin,address _memecoinTreasury,uint256 _tokenId,bool _currencyFlipped,uint256 _flaunchFee,(string,string,string,uint256,address,uint24,uint256,bytes,bytes,address) _params)
const PONS_LAUNCHED = "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607"; // TokenLaunched(address indexed token,address indexed curve,address indexed deployer,address pairToken,uint256 launchConfigId,uint256 graduationThreshold)
const PONS_V1_LAUNCHED = "0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a"; // TokenLaunched(address indexed token,address indexed deployer,address indexed dexFactory,address pairToken,address pool,uint256 dexId,uint256 launchConfigId,uint256 positionId,uint256 restrictionsEndBlock,uint256 initialBuyAmount)
const BAGS_CREATED = "0x643b3b606052cbadac2f906ad0b462da99eda2a1d4f824d315d7f6edd3e4cced"; // TokenCreated(address indexed token,address indexed curve,address indexed creator,address feeShare,address partner,bytes32 poolId,string name,string symbol,string metadataURI)
const TORCH_LAUNCHED = "0xea6baf14ec1f4c08d18114c1eea0e6a2a018eef994f9db19ea8a41526e49d28c"; // TokenLaunched(address indexed token,address indexed creator,bytes32 poolId,uint256 buyTaxBps,uint24 lpFee,uint256 antiSnipeSeconds,(uint16,uint16,uint16,uint16) split,string contractURI,address quote)

/** The launchpads' factories per chain; each address's cite is on its line. A pad with no row on a chain is one whose
 *  factory there is not published or could not be cited (the hand-back of card market-data-evm-lists names them). */
export const FACTORIES: Readonly<Record<EvmChain, readonly Factory[]>> = {
  base: [
    // docs.zora.co/coins/contracts/factory: "Factory address (Base mainnet): 0x777777751622c0d3258f214F9DF38E35BF45baF3" (Sourcify: proxy, implementation 0xbbAe128a65239c3328fAa0c70B8D5F9C961a8038 [ZoraFactoryImpl])
    { pad: "zora", address: "0x777777751622c0d3258f214F9DF38E35BF45baF3", topic0: ZORA_V4, at: { word: 4 } },
    { pad: "zora", address: "0x777777751622c0d3258f214F9DF38E35BF45baF3", topic0: ZORA_V3, at: { word: 4 } },
    { pad: "zora", address: "0x777777751622c0d3258f214F9DF38E35BF45baF3", topic0: ZORA_CREATOR, at: { word: 4 } },
    { pad: "zora", address: "0x777777751622c0d3258f214F9DF38E35BF45baF3", topic0: ZORA_TREND, at: { word: 1 } },
    // github.com/clanker-devco/v4-contracts README, Base Mainnet v4.0: "Clanker: 0xE85A59c628F7d27878ACeB4bf3b35733630083a9" (Sourcify [Clanker])
    { pad: "clanker", address: "0xE85A59c628F7d27878ACeB4bf3b35733630083a9", topic0: CLANKER_V4, at: { topic: 1 } },
    // clanker docs, deployed contracts v3.1.0: "Clanker | 0x2A787b2362021cC3eEa3C24C4748a6cD5B687382" (Sourcify [Clanker])
    { pad: "clanker", address: "0x2A787b2362021cC3eEa3C24C4748a6cD5B687382", topic0: CLANKER_V31, at: { topic: 1 } },
    // clanker docs v3.0.0: "Clanker | 0x375C15db32D28cEcdcAB5C03Ab889bf15cbD2c5E" (Sourcify [Clanker])
    { pad: "clanker", address: "0x375C15db32D28cEcdcAB5C03Ab889bf15cbD2c5E", topic0: CLANKER_V3, at: { word: 0 } },
    // clanker docs v2.0.0: 0x732560fa1d1A76350b1A500155BA978031B53833; v1.0.0: 0x9B84fcE5Dcd9a38d2D01d5D72373F6b6b067c3e1 (Sourcify [Clanker], both)
    { pad: "clanker", address: "0x732560fa1d1A76350b1A500155BA978031B53833", topic0: CLANKER_V1, at: { word: 0 } },
    { pad: "clanker", address: "0x9B84fcE5Dcd9a38d2D01d5D72373F6b6b067c3e1", topic0: CLANKER_V1, at: { word: 0 } },
    // clanker docs v0.0.0: "SocialDexDeployer | 0x250c9FB2b411B48273f69879007803790A6AeA47" (Sourcify [SocialDexDeployer])
    { pad: "clanker", address: "0x250c9FB2b411B48273f69879007803790A6AeA47", topic0: CLANKER_V0, at: { word: 0 } },
    // docs.doppler.lol/resources/contract-addresses, Base: "Airlock | 0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12" (Sourcify [Airlock]); Bankr launches through it (docs.bankr.bot/token-launching/overview, launch type "Doppler")
    { pad: "doppler", address: "0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12", topic0: DOPPLER_CREATE, at: { word: 0 }, shared: true },
    // github.com/flayerlabs/flaunchgg-contracts README: "PositionManager (hook) | 0x588C683EcC450F8b2aAdb13D7f63792b840425DC" (Sourcify [PositionManager])
    { pad: "flaunch", address: "0x588C683EcC450F8b2aAdb13D7f63792b840425DC", topic0: FLAUNCH_POOL, at: { word: 0 } },
    // Virtuals: Sourcify only (no pad-own page lists them): Bonding proxy 0xF66DeA7b3e897cD44A5a231c61B6B4423d613259 (implementation 0xC9A91ccACFdc0001e2c41a56a75384598b70B89F [Bonding]),
    // AgentFactoryV3 proxy 0x71b8efc8bcad65a5d9386d07f2dff57ab4eaf533 (implementation 0xfd8c35798eAA6fF8d1902f1B804d3341df09e895 [AgentFactoryV3]),
    // AgentFactoryV7 proxy 0xc169a24010fd4d47ca7be4b4c7863b76520442a3 (implementation 0x5E357d0219E3a15674f18A5a197fB45E93568Ae9 [AgentFactoryV7])
    { pad: "virtuals", address: "0xF66DeA7b3e897cD44A5a231c61B6B4423d613259", topic0: VIRTUALS_LAUNCHED, at: { topic: 1 } },
    { pad: "virtuals", address: "0xF66DeA7b3e897cD44A5a231c61B6B4423d613259", topic0: VIRTUALS_GRADUATED, at: { word: 0 } },
    { pad: "virtuals", address: "0x71b8efc8bcad65a5d9386d07f2dff57ab4eaf533", topic0: VIRTUALS_PERSONA, at: { word: 1 } },
    { pad: "virtuals", address: "0xc169a24010fd4d47ca7be4b4c7863b76520442a3", topic0: VIRTUALS_PERSONA, at: { word: 1 } },
  ],
  robinhood: [
    // Clanker v4 on Robinhood: Sourcify chain 4663 [Clanker], src/Clanker.sol, the same TokenCreated; Clanker's docs list no Robinhood section
    { pad: "clanker", address: "0xd3f2cc1731b7fd17f28798835c2e02f0a1839a94", topic0: CLANKER_V4, at: { topic: 1 } },
    // docs.doppler.lol/resources/contract-addresses, "Robinhood Mainnet (4663)": "Airlock: 0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862" (Sourcify [Airlock])
    { pad: "doppler", address: "0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862", topic0: DOPPLER_CREATE, at: { word: 0 }, shared: true },
    // Pons v2: Sourcify chain 4663 [PonsV2LaunchFactory] (no Pons-own page found)
    { pad: "pons", address: "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e", topic0: PONS_LAUNCHED, at: { topic: 1 } },
    // Pons v1: Sourcify chain 4663 [PonsLaunchFactory] (read 2026-11-03 17:00Z; no Pons-own page found); it made YOLO
    // 0x62c71cd34a52c30d894419cbcc55db2afa8032ea, on the Robinhood lists that minute
    { pad: "pons", address: "0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb", topic0: PONS_V1_LAUNCHED, at: { topic: 1 } },
    // docs.bags.fm/robinhood/overview.md: "BagsFactory | 0xe8Cc4431adF8b5A847C113EF0c6af9043219Cb37" (a proxy; its EIP-1967 slot read 2026-11-03 13:41Z names
    // implementation 0x7dfa0131f6c8626f199a2e33e49dfb5660e6ef1c, Sourcify [BagsFactory], whose TokenCreated adds `partner`: every one of the
    // factory's 4449 creation logs on chain carries this topic0, none the older implementation 0x46aD6f53's)
    { pad: "bags", address: "0xe8Cc4431adF8b5A847C113EF0c6af9043219Cb37", topic0: BAGS_CREATED, at: { topic: 1 } },
    // docs.torchpad.fun/protocol/contract-addresses: "Torch launchpad (factory) | Robinhood Chain | 0x7891eA889899928aFE637e4Cca8106188427776a"
    // (Sourcify chain 4663, exact match [TorchFactory], not a proxy; read 2026-11-03 19:25Z: 2082 creation logs on chain, every token ending in 1111)
    { pad: "torch", address: "0x7891eA889899928aFE637e4Cca8106188427776a", topic0: TORCH_LAUNCHED, at: { topic: 1 } },
  ],
};

/** A launchpad's own record of the tokens it made: a view on its factory that takes the token and answers `words` 32-byte
 *  words (every output static), where word `word` is the token itself, any nonzero address, or `true` exactly when the
 *  pad made it. `shared` as in Factory. */
export type MakerRecord = { pad: string; address: string; signature: string; selector: string; words: number; made: { word: number; is: "token" | "address" | "true" }; shared?: true };

/** The chains whose makers are read from the launchpads' records (null: from creation events, FACTORIES). Each view's
 *  outputs are read from the ABI Sourcify holds for chain 4663 (sourcify.dev/server/v2/contract/4663/<address>?fields=abi,
 *  read 2026-11-04 08:20Z; a proxy's from its implementation), each selector keccak-256 of the signature, and each answer
 *  read at latest on rpc.mainnet.chain.robinhood.com, robinhood-rpc.publicnode.com and robinhood.drpc.org for a token of
 *  the pad and for tokens of the other pads, which answer zeros (fixtures/maker-records-robinhood.json.gz). */
export const RECORDS: Readonly<Record<EvmChain, readonly MakerRecord[] | null>> = {
  base: null,
  robinhood: [
    // [Clanker] deploymentInfoForToken(address) -> (address token, address hook, address locker)
    { pad: "clanker", address: "0xd3f2cc1731b7fd17f28798835c2e02f0a1839a94", signature: "deploymentInfoForToken(address)", selector: "0x06562980", words: 3, made: { word: 0, is: "token" } },
    // [PonsV2LaunchFactory] getLaunchedToken(address) -> (address token, address curve, ... 15 static fields)
    { pad: "pons", address: "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e", signature: "getLaunchedToken(address)", selector: "0x3cf28b5a", words: 15, made: { word: 0, is: "token" } },
    // [PonsLaunchFactory] getLaunchedToken(address) -> (address token, address deployer, ... 13 static fields)
    { pad: "pons", address: "0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb", signature: "getLaunchedToken(address)", selector: "0x3cf28b5a", words: 13, made: { word: 0, is: "token" } },
    // [BagsFactory] (behind the BagsFactory proxy) curveForToken(address) -> address
    { pad: "bags", address: "0xe8cc4431adf8b5a847c113ef0c6af9043219cb37", signature: "curveForToken(address)", selector: "0x8580756c", words: 1, made: { word: 0, is: "address" } },
    // [TorchFactory] isTorchToken(address) -> bool
    { pad: "torch", address: "0x7891ea889899928afe637e4cca8106188427776a", signature: "isTorchToken(address)", selector: "0x498d5beb", words: 1, made: { word: 0, is: "true" } },
    // [Airlock] getAssetData(address) -> (numeraire, timelock, governance, liquidityMigrator, poolInitializer, pool,
    // migrationPool, numTokensToSell, totalSupply, integrator): an asset Airlock made has its pool initializer set
    { pad: "doppler", address: "0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862", signature: "getAssetData(address)", selector: "0x1652e7b7", words: 10, made: { word: 4, is: "address" }, shared: true },
  ],
};

// ---------------------------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------------------------

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;
const DATA = /^0x([0-9a-fA-F]{64})*$/;
/** An EVM address in lowercase, or null. */
export const evmAddress = (v: unknown): string | null => (typeof v === "string" && HEX_ADDRESS.test(v) ? v.toLowerCase() : null);
const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const DECIMAL = /^-?\d{1,30}(\.\d{1,40})?$/;
/** GeckoTerminal writes numbers as decimal strings; one as a number, or undefined. */
function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string" || !DECIMAL.test(v)) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
const usd = (v: unknown): string | null => dec(num(v));
function bps(pct: unknown): number | null {
  const p = num(pct);
  if (p === undefined || p < -100 || Math.abs(p) > 1e9) return null;
  return Math.round(p * 100) || 0;
}
const count = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : null);
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?Z$/;
function seconds(v: unknown, nowMs: number): number | null {
  if (typeof v !== "string" || !ISO.test(v)) return null;
  const ms = Date.parse(v.replace(/(\.\d{3})\d+Z$/, "$1Z"));
  return Number.isFinite(ms) && ms >= Date.UTC(2015, 0, 1) && ms <= nowMs + 86_400_000 ? Math.floor(ms / 1000) : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------------------------

/** A GeckoTerminal pools answer as rows (at most LIST_MAX, each token once, invalid rows dropped), with each row's pool
 *  creation time kept aside for the maker read; null when it is not a pools answer. */
export function toRows(chain: EvmChain, answer: unknown, asOfMs: number): { rows: Row[]; created: Map<string, number>; pools: Map<string, string> } | null {
  const a = obj(answer);
  if (!Array.isArray(a.data)) return null;
  const tokens = new Map<string, Record<string, unknown>>();
  if (Array.isArray(a.included))
    for (const t of a.included.slice(0, 4 * LIST_MAX)) {
      const o = obj(t);
      if (o.type === "token" && typeof o.id === "string") tokens.set(o.id, obj(o.attributes));
    }
  const net = GT_NETWORK[chain];
  const rows: Row[] = [];
  const created = new Map<string, number>();
  const pools = new Map<string, string>();
  for (const raw of a.data.slice(0, LIST_MAX)) {
    const p = obj(raw);
    if (p.type !== "pool") continue;
    const at = obj(p.attributes);
    const id = obj(obj(obj(p.relationships).base_token).data).id;
    if (typeof id !== "string" || !id.startsWith(`${net}_`)) continue;
    const token = evmAddress(id.slice(net.length + 1));
    const t = tokens.get(id) ?? {};
    if (token === null || evmAddress(t.address) !== token || created.has(token)) continue;
    const symbol = text(t.symbol, 32);
    const name = text(t.name, 64) ?? symbol;
    if (symbol === null || name === null) continue;
    const vol = obj(at.volume_usd);
    const chg = obj(at.price_change_percentage);
    const tx = obj(at.transactions);
    const [m5, h1, h24] = [obj(tx.m5), obj(tx.h1), obj(tx.h24)];
    const createdS = seconds(at.pool_created_at, asOfMs);
    created.set(token, createdS ?? -1);
    // the row's pool, as the list names it: a v4 pool id or a pool's address (checked on chain before any read of it)
    const pool = typeof at.address === "string" && /^0x([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(at.address) ? at.address.toLowerCase() : null;
    if (pool !== null) pools.set(token, pool);
    rows.push({
      chain,
      token,
      symbol,
      name,
      icon: false, // GET /v1/logo/{chain}/{token} is not served yet; the app draws its own
      venue: null,
      label: null,
      created_s: createdS, // the pool's; a pad makes the token and its pool in one transaction
      price_usd: usd(at.base_token_price_usd),
      mc_usd: usd(at.market_cap_usd) ?? usd(at.fdv_usd),
      vol_24h_usd: usd(vol.h24),
      chg_5m_bps: bps(chg.m5),
      chg_1h_bps: bps(chg.h1),
      chg_24h_bps: bps(chg.h24),
      liq_usd: usd(at.reserve_in_usd),
      holders: null,
      top10_bps: null,
      src: "geckoterminal",
      as_of_ms: asOfMs,
      creator: null,
      creator_sold_bps: null,
      dev_bps: null,
      snipers_bps: null,
      mint_auth: null,
      freeze_auth: null,
      vol_5m_usd: usd(vol.m5),
      buys_5m: count(m5.buys),
      sells_5m: count(m5.sells),
      net_5m_usd: null,
      risk_src: null,
      launchpad: null, // filled from the maker read
      curve_bps: null,
      vol_1h_usd: usd(vol.h1),
      chg_4h_bps: null,
      buys_24h: count(h24.buys),
      sells_24h: count(h24.sells),
      buys_1h: count(h1.buys),
      sells_1h: count(h1.sells),
    } satisfies Record<(typeof ROW_FIELDS)[number], unknown>);
  }
  return { rows, created, pools };
}

// ---------------------------------------------------------------------------------------------------------------
// The maker read
// ---------------------------------------------------------------------------------------------------------------

/** The block a time falls in on a chain with a fixed clock, or null. */
export function blockAt(chain: EvmChain, s: number): number | null {
  const c = BLOCK_CLOCK[chain];
  if (c === null || !Number.isSafeInteger(s) || s < c.genesisS) return null;
  return Math.floor((s - c.genesisS) / c.blockS);
}

/** Factory addresses per `eth_getLogs` filter: base-rpc.publicnode.com answers more with "A maximum of 10 addresses is
 *  allowed" (2026-11-03 11:56Z). */
export const FILTER_ADDRESSES_MAX = 10;

/** The `eth_getLogs` filters for the creation events of a chain's factories over blocks `from` to `to`: one per
 *  FILTER_ADDRESSES_MAX factory addresses, each with the topic0s of its own rows. */
export function makerFilters(chain: EvmChain, from: number, to: number): Record<string, unknown>[] {
  const addresses = [...new Set(FACTORIES[chain].map((r) => r.address.toLowerCase()))];
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < addresses.length; i += FILTER_ADDRESSES_MAX) {
    const part = addresses.slice(i, i + FILTER_ADDRESSES_MAX);
    out.push({
      address: part,
      topics: [[...new Set(FACTORIES[chain].filter((r) => part.includes(r.address.toLowerCase())).map((r) => r.topic0.toLowerCase()))]],
      fromBlock: `0x${Math.max(0, from).toString(16)}`,
      toBlock: `0x${to.toString(16)}`,
    });
  }
  return out;
}

/** The logs of several filters' answers as one, or undefined when any is not a list. */
export const joinLogs = (answers: readonly unknown[]): unknown[] | undefined => (answers.every(Array.isArray) ? (answers as unknown[][]).flat() : undefined);

/** The blocks a pool made at unix second `s` can be in on a chain with a fixed clock: its block and the one before; null
 *  on a chain without one (its makers come from RECORDS). A wrong range finds no creation event, so it can only leave a
 *  row untagged, never tag it. */
export function blockRange(chain: EvmChain, s: number): [number, number] | null {
  const b = blockAt(chain, s);
  return b === null ? null : [b - 1, b];
}

const tokenWord = (token: string) => `000000000000000000000000${token.slice(2).toLowerCase()}`;

/**
 * The pad whose factory's creation event in `logs` names `token`; null when no log does; undefined when `logs` is not
 * an `eth_getLogs` answer. A log counts only when its emitter, topic0 and the token's place all match one table row;
 * two pads naming the same token is no answer.
 */
export function padOf(chain: EvmChain, token: string, logs: unknown): string | null | undefined {
  if (!Array.isArray(logs) || logs.length > LOGS_MAX) return undefined;
  const word = tokenWord(token);
  const pads = new Set<string>();
  for (const raw of logs) {
    const l = obj(raw);
    const emitter = evmAddress(l.address);
    const topics = l.topics;
    if (emitter === null || !Array.isArray(topics) || topics.length < 1 || topics.length > 4 || !topics.every((t) => typeof t === "string" && WORD.test(t))) return undefined;
    if (typeof l.data !== "string" || l.data.length > 2 + 64 * 64 || !DATA.test(l.data)) return undefined;
    if (l.removed === true) continue;
    const t0 = (topics[0] as string).toLowerCase();
    for (const f of FACTORIES[chain]) {
      if (f.address.toLowerCase() !== emitter || f.topic0.toLowerCase() !== t0) continue;
      const at = f.at;
      const hit = "topic" in at
        ? typeof topics[at.topic] === "string" && (topics[at.topic] as string).slice(2).toLowerCase() === word
        : l.data.slice(2 + 64 * at.word, 2 + 64 * (at.word + 1)).toLowerCase() === word;
      if (hit) pads.add(f.pad);
    }
  }
  // a pad's own factory wins over a shared one it launched through; two own pads naming one token is no answer
  const own = [...pads].filter((p) => !FACTORIES[chain].some((f) => f.pad === p && f.shared === true));
  if (own.length > 1 || (own.length === 0 && pads.size > 1)) return undefined;
  return own[0] ?? (pads.size === 1 ? [...pads][0]! : null);
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * The maker reads' fetch kept by the helper's one hold and pace per provider (limits.ts providerHolds, card
 * helper-robinhood-capacity): a provider that is held is sent nothing and answers a 429 here (batch() stops on it); its
 * 429 holds it for the wait it names, and a JSON-RPC throttle in its answer (evmThrottleS) for that one's.
 */
export function heldFetch(doFetch: Fetch, holds: ProviderHolds, now: () => number = Date.now): Fetch {
  return async (url, init) => {
    const left = holds.heldFor(url);
    if (left > 0) return new Response("{}", { status: 429, headers: { "retry-after": String(left) } });
    // the provider's pace, drawn as a background read (limits.ts take): its calls wait for their units; a wait past a
    // second answers as a hold does, so the maker read asks its next provider
    let calls = 1;
    try {
      const b: unknown = JSON.parse(String(init.body));
      if (Array.isArray(b)) calls = b.length;
    } catch {}
    const w = holds.take(url, calls, true);
    const busy = new Response("{}", { status: 429, headers: { "retry-after": String(Math.max(1, Math.ceil(w / 1000))) } });
    if (w > 1_000) return busy;
    if (w > 0) {
      await new Promise((go) => setTimeout(go, w));
      if (holds.take(url, calls, true) > 0) return busy;
    }
    const r = await doFetch(url, init);
    if (r.status === 429) {
      holds.hold(url, upstreamRetryAfterS(r.headers, now()));
      return r;
    }
    if (r.status !== 200) return r;
    const text = await r.text();
    try {
      const parsed: unknown = JSON.parse(text);
      for (const a of Array.isArray(parsed) ? parsed : [parsed]) {
        const wait = Object.hasOwn(obj(a), "error") ? evmThrottleS(obj(a).error) : 0;
        if (wait > 0) holds.hold(url, wait);
      }
    } catch {}
    return new Response(text, { status: r.status, headers: r.headers });
  };
}

/** JSON-RPC batches to one provider (BATCH_MAX calls each, one after another): each call's `result`, by position;
 *  undefined for any that failed. A provider that refuses a batch (its HTTP 429, a JSON-RPC -32005 or limit message) is
 *  sent none of the batches after it: they fail as refused reads, so the caller's third provider answers (card
 *  helper-rpc-hold-queued: the chain's own Robinhood RPC, the first of MAKER_RPCS, answered the helper box's address
 *  429 on 10 of 10 probes at 2026-11-04 18:53Z, and another address 200 on 6 of 6). */
export async function batch(doFetch: Fetch, url: string, calls: { method: string; params: unknown[] }[]): Promise<unknown[]> {
  const max = BATCH_MAX[url] ?? 10;
  const out: unknown[] = [];
  let refused = false;
  for (let i = 0; i < calls.length; i += max) {
    const part = calls.slice(i, i + max);
    if (refused) {
      out.push(...part.map(() => undefined));
      continue;
    }
    const got = await batchOnce(doFetch, url, part);
    refused = got.refused;
    out.push(...got.out);
  }
  return out;
}

async function batchOnce(doFetch: Fetch, url: string, calls: { method: string; params: unknown[] }[]): Promise<{ out: unknown[]; refused: boolean }> {
  const none = { out: calls.map(() => undefined), refused: false };
  if (calls.length === 0) return none;
  try {
    const r = await doFetch(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(calls.map((c, id) => ({ jsonrpc: "2.0", id, method: c.method, params: c.params }))),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (r.status !== 200 || Number(r.headers.get("content-length") ?? "0") > ANSWER_MAX) {
      await r.body?.cancel();
      return { ...none, refused: r.status === 429 };
    }
    const body = await r.text();
    if (body.length > ANSWER_MAX) return none;
    const parsed: unknown = JSON.parse(body);
    const answers = Array.isArray(parsed) ? parsed : [parsed];
    const out: unknown[] = [...none.out];
    let refused = false;
    for (const a of answers) {
      const o = obj(a);
      if (Object.hasOwn(o, "error")) {
        if (evmThrottleS(o.error) > 0) refused = true;
        continue;
      }
      if (Number.isSafeInteger(o.id) && (o.id as number) >= 0 && (o.id as number) < calls.length && Object.hasOwn(o, "result")) out[o.id as number] = o.result;
    }
    return { out, refused };
  } catch {
    return none;
  }
}

/** The pad each token's creation logs over its block range name on two providers that answer and agree (the third
 *  asked for a token one of the first two could not answer); a token is absent when that does not hold. */
async function padsAt(chain: EvmChain, doFetch: Fetch, asks: readonly { token: string; range: [number, number] }[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (asks.length === 0) return out;
  const per = makerFilters(chain, 0, 0).length;
  const calls = asks.flatMap((a) => makerFilters(chain, ...a.range).map((f) => ({ method: "eth_getLogs", params: [f] })));
  const [u0, u1, u2] = MAKER_RPCS[chain];
  const pads = (got: unknown[]) => asks.map((a, i) => padOf(chain, a.token, joinLogs(got.slice(i * per, (i + 1) * per))));
  const [p, q] = (await Promise.all([batch(doFetch, u0, calls), batch(doFetch, u1, calls)])).map(pads) as [(string | null | undefined)[], (string | null | undefined)[]];
  const short = asks.flatMap((_, i) => (p[i] === undefined || q[i] === undefined ? [i] : []));
  const r = new Map<number, string | null | undefined>();
  if (short.length > 0) {
    const got = await batch(doFetch, u2, short.flatMap((i) => calls.slice(i * per, (i + 1) * per)));
    short.forEach((i, k) => r.set(i, padOf(chain, asks[i]!.token, joinLogs(got.slice(k * per, (k + 1) * per)))));
  }
  asks.forEach((a, i) => {
    const answered = [p[i], q[i], r.get(i)].filter((x) => x !== undefined);
    if (answered.length >= 2 && answered.every((x) => x === answered[0])) out.set(a.token, answered[0] as string | null);
  });
  return out;
}

/** The `eth_call`s that read a token's records on a chain, in RECORDS order. */
export const recordCalls = (chain: EvmChain, token: string) =>
  (RECORDS[chain] ?? []).map((r) => ({ method: "eth_call", params: [{ to: r.address, data: `${r.selector}${tokenWord(token)}` }, "latest"] }));

const ADDRESS_WORD = /^0{24}[0-9a-f]{40}$/;

/**
 * The pad whose record says it made `token`, from the answers to recordCalls (in order): null when none does; undefined
 * when any answer is not its view's exact static answer (a revert, an error, another length, a word out of its type) or
 * when two own pads claim the token. A shared pad's record counts only when no own pad's does.
 */
export function recordPad(chain: EvmChain, token: string, answers: readonly unknown[]): string | null | undefined {
  const recs = RECORDS[chain] ?? [];
  if (answers.length !== recs.length) return undefined;
  const word = tokenWord(token);
  const pads = new Set<string>();
  for (const [i, r] of recs.entries()) {
    const a = answers[i];
    if (typeof a !== "string" || a.length !== 2 + 64 * r.words || !DATA.test(a)) return undefined;
    const w = a.slice(2 + 64 * r.made.word, 2 + 64 * (r.made.word + 1)).toLowerCase();
    if (r.made.is === "true" ? !/^0{63}[01]$/.test(w) : !ADDRESS_WORD.test(w)) return undefined;
    const made = r.made.is === "token" ? w === word : r.made.is === "address" ? !/^0{64}$/.test(w) : w.endsWith("1");
    if (made) pads.add(r.pad);
  }
  const own = [...pads].filter((p) => !recs.some((r) => r.pad === p && r.shared === true));
  if (own.length > 1) return undefined;
  return own[0] ?? (pads.size === 1 ? [...pads][0]! : pads.size === 0 ? null : undefined);
}

/** The pad each token's records name on two providers that answer and agree (the third asked for a token one of the
 *  first two could not answer); a token is absent when that does not hold. */
async function recordsAt(chain: EvmChain, doFetch: Fetch, tokens: readonly string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (tokens.length === 0) return out;
  const per = (RECORDS[chain] ?? []).length;
  const calls = tokens.flatMap((t) => recordCalls(chain, t));
  const [u0, u1, u2] = MAKER_RPCS[chain];
  const pads = (got: unknown[]) => tokens.map((t, i) => recordPad(chain, t, got.slice(i * per, (i + 1) * per)));
  const [p, q] = (await Promise.all([batch(doFetch, u0, calls), batch(doFetch, u1, calls)])).map(pads) as [(string | null | undefined)[], (string | null | undefined)[]];
  const short = tokens.flatMap((_, i) => (p[i] === undefined || q[i] === undefined ? [i] : []));
  const r = new Map<number, string | null | undefined>();
  if (short.length > 0) {
    const got = await batch(doFetch, u2, short.flatMap((i) => calls.slice(i * per, (i + 1) * per)));
    short.forEach((i, k) => r.set(i, recordPad(chain, tokens[i]!, got.slice(k * per, (k + 1) * per))));
  }
  tokens.forEach((t, i) => {
    const answered = [p[i], q[i], r.get(i)].filter((x) => x !== undefined);
    if (answered.length >= 2 && answered.every((x) => x === answered[0])) out.set(t, answered[0] as string | null);
  });
  return out;
}

/** Creation-block searches run at once (EARLIER_READS_MAX block reads each, at most); every older token a tick asks
 *  about is searched in that tick, so none waits behind newer tokens with a null that means "not read yet". */
export const EARLIER_PARALLEL = 3;
export const EARLIER_READS_MAX = 120;

/**
 * The block a token's code first appears in, when that is before block `before` (a token whose pool came later, as a
 * new pool of an old token does): null when it has no code at `before` - 1 (made at its pool), undefined when the
 * reads fail. Searched on the chain's first provider (it serves old state), in rounds of 10 `eth_getCode` reads across
 * the interval. Base only: Robinhood's providers serve no old state.
 */
export async function codeBlock(chain: EvmChain, token: string, before: number, doFetch: Fetch): Promise<number | null | undefined> {
  const url = MAKER_RPCS[chain][0];
  const code = async (ns: number[]): Promise<(boolean | undefined)[]> =>
    (await batch(doFetch, url, ns.map((n) => ({ method: "eth_getCode", params: [token, `0x${n.toString(16)}`] })))).map((c) => (typeof c === "string" && /^0x([0-9a-f]{2})*$/i.test(c) ? c !== "0x" : undefined));
  const [first] = await code([before - 1]);
  if (first === undefined) return undefined;
  if (!first) return null;
  return search(code, before - 1);
}

/** Whether each token had code at block `at[i]` (one batch on the chain's first provider); undefined where a read failed. */
export async function hadCode(chain: EvmChain, doFetch: Fetch, asks: readonly { token: string; at: number }[]): Promise<(boolean | undefined)[]> {
  const got = await batch(doFetch, MAKER_RPCS[chain][0], asks.map((a) => ({ method: "eth_getCode", params: [a.token, `0x${a.at.toString(16)}`] })));
  return got.map((c) => (typeof c === "string" && /^0x([0-9a-f]{2})*$/i.test(c) ? c !== "0x" : undefined));
}

async function search(code: (ns: number[]) => Promise<(boolean | undefined)[]>, withCode: number): Promise<number | undefined> {
  let lo = 0; // no code
  let hi = withCode; // code
  for (let reads = 1; hi - lo > 1; ) {
    const ns = [...new Set(Array.from({ length: 10 }, (_, k) => lo + Math.max(1, Math.floor(((k + 1) * (hi - lo)) / 11))))].filter((n) => n > lo && n < hi);
    if (reads + ns.length > EARLIER_READS_MAX) return undefined;
    reads += ns.length;
    const got = await code(ns);
    if (got.some((x) => x === undefined)) return undefined;
    // code never goes away for these tokens; the first block with code bounds hi, the last without bounds lo
    for (const [k, has] of got.entries()) {
      if (has && ns[k]! < hi) hi = ns[k]!;
      if (!has && ns[k]! > lo && ns[k]! < hi) lo = ns[k]!;
    }
  }
  return hi;
}

/** The makers of these tokens: a pad, null for none (settled), or absent when not settled yet. On a chain with RECORDS,
 *  from the launchpads' records at latest; else from the creation events at the pool's block, and a token whose pool
 *  block shows none and whose code is older is read again at the block its code appeared in. None is never settled
 *  within SETTLE_MS of the pool, since a provider may not hold the creation yet. */
export async function readMakers(chain: EvmChain, doFetch: Fetch, wanted: readonly { token: string; createdS: number }[], nowMs: number): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (FACTORIES[chain].length === 0) {
    // no factory on this chain: nothing can name a maker, so every token is settled as none
    for (const w of wanted) out.set(w.token, null);
    return out;
  }
  if (RECORDS[chain] !== null) {
    const got = await recordsAt(chain, doFetch, wanted.map((w) => w.token));
    for (const w of wanted) {
      const x = got.get(w.token);
      if (x === undefined || (x === null && nowMs / 1000 - w.createdS < SETTLE_MS / 1000)) continue; // read again later
      out.set(w.token, x);
    }
    return out;
  }
  const ranges = wanted.map((w) => blockRange(chain, w.createdS));
  const asks = wanted.flatMap((w, i) => (ranges[i] === null ? [] : [{ ...w, range: ranges[i]! }]));
  const first = await padsAt(chain, doFetch, asks);
  const none: (typeof asks)[number][] = [];
  for (const a of asks) {
    const x = first.get(a.token);
    if (x === undefined) continue; // read again later
    if (x === null && nowMs / 1000 - a.createdS < SETTLE_MS / 1000) continue; // too new to call it none
    if (x === null) none.push(a);
    else out.set(a.token, x);
  }
  // none at the pool: a token with no code before its pool was made there, so none; an older token's creation block is
  // searched, EARLIER_PARALLEL at a time
  const had = await hadCode(chain, doFetch, none.map((a) => ({ token: a.token, at: a.range[0] - 1 })));
  const older = none.filter((a, i) => {
    if (had[i] === false) out.set(a.token, null);
    return had[i] === true;
  });
  const earlier: { token: string; range: [number, number] }[] = [];
  for (let i = 0; i < older.length; i += EARLIER_PARALLEL) {
    const part = older.slice(i, i + EARLIER_PARALLEL);
    const found = await Promise.all(part.map((a) => codeBlock(chain, a.token, a.range[0], doFetch)));
    for (const [k, b] of found.entries()) {
      if (b === null) out.set(part[k]!.token, null);
      else if (b !== undefined) earlier.push({ token: part[k]!.token, range: [b, b] });
    }
  }
  const second = await padsAt(chain, doFetch, earlier);
  for (const e of earlier) if (second.has(e.token)) out.set(e.token, second.get(e.token)!);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The served answer
// ---------------------------------------------------------------------------------------------------------------

const UPSTREAM: ListsAnswer = { status: 503, body: JSON.stringify({ error: { code: "upstream" } }) };
type Read = { rows: Row[]; created: Map<string, number>; pools: Map<string, string>; at: number; raw: string };
/** What a restart's next process takes over (../warm.ts, card helper-ready-gate): each list's GeckoTerminal answer as
 *  read and its read time, and the makers read. The answers are parsed again by toRows, as from GeckoTerminal. */
export type EvmListsState = { reads: Partial<Record<string, { raw: string; at: number }>>; makers: [string, string | null][] };

/** Discover's lists for one EVM chain: GeckoTerminal's lists once per LIST_MS, makers read and kept, rebuilt per TICK_MS. */
/** `holds`: the helper's one hold per provider (limits.ts providerHolds), which the maker reads keep (heldFetch). */
export function createEvmLists(chain: EvmChain, gecko: GeckoBudget, deps: { fetch?: Fetch; now?: () => number; holds?: ProviderHolds } = {}) {
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetch ?? fetch;
  const rpcFetch = deps.holds === undefined ? doFetch : heldFetch(doFetch, deps.holds, now);
  const makers = new Map<string, string | null>();
  const tries = new Map<string, number>(); // maker reads that settled nothing, per token
  const reads: Partial<Record<ListKey, Read>> = {};
  let last: (ListsAnswer & { asOfMs: number }) | null = null;
  let running: Promise<void> | null = null;

  async function gt(path: string, urgent: boolean, first: boolean): Promise<Read | null> {
    if (!gecko.take("lists", urgent, first)) return null;
    try {
      const r = await doFetch(`${GT_BASE}/networks/${GT_NETWORK[chain]}/${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
      if (r.status === 429) {
        throttledUntil(gecko, r.headers.get("retry-after"), now());
        await r.body?.cancel();
        return null;
      }
      if (r.status !== 200 || Number(r.headers.get("content-length") ?? "0") > ANSWER_MAX) {
        await r.body?.cancel();
        return null;
      }
      const body = await r.text();
      if (body.length > ANSWER_MAX) return null;
      const at = now();
      const rows = toRows(chain, JSON.parse(body), at);
      return rows === null ? null : { ...rows, at, raw: body };
    } catch {
      return null;
    }
  }

  const all = (): { new: Read; trending_5m: Read; trending_1h: Read } | null =>
    reads.new && reads.trending_5m && reads.trending_1h ? { new: reads.new, trending_5m: reads.trending_5m, trending_1h: reads.trending_1h } : null;

  function build() {
    const read = all();
    if (read === null) return;
    const tag = (rows: Row[]) => rows.map((r) => ({ ...r, launchpad: makers.get(r.token as string) ?? null }));
    const asOf = Math.min(read.new.at, read.trending_5m.at, read.trending_1h.at);
    const lists = { new: tag(read.new.rows), trending: tag(read.trending_1h.rows), trending_5m: tag(read.trending_5m.rows), trending_1h: tag(read.trending_1h.rows), graduating: [] as Row[] };
    const unsettled = [...new Set([read.new, read.trending_5m, read.trending_1h].flatMap((r) => r.rows.map((x) => x.token as string)))].filter((t) => !makers.has(t));
    const pools: Record<string, string> = {};
    for (const r of [read.trending_1h, read.trending_5m, read.new]) for (const [t, p] of r.pools) if (!Object.hasOwn(pools, t)) pools[t] = p;
    const body = JSON.stringify({ chain, lists, as_of_ms: asOf, unsettled, pools } satisfies EvmSnapshot);
    last = { status: 200, body, gzip: gzipSync(body), asOfMs: asOf };
    for (const fn of listeners) fn();
  }
  /** Called as each new answer is built (swaps.ts ahead: the tokens' pools looked for as the lists load), and at once
   *  when one is held already. */
  const listeners = new Set<() => void>();
  function onAnswer(fn: () => void): void {
    listeners.add(fn);
    if (last !== null) fn();
  }

  async function tick(): Promise<void> {
    // the stalest list first (a missing one before any), one call at a time while the lists lane yields one
    const age = (k: ListKey) => (reads[k] === undefined ? Infinity : now() - reads[k]!.at);
    for (const k of LIST_KEYS.filter((x) => age(x) >= LIST_MS).sort((a, b) => age(b) - age(a))) {
      const r = await gt(GT_READS[k], age(k) >= LIST_URGENT_MS, reads[k] === undefined);
      if (r === null) break;
      reads[k] = r;
    }
    const read = all();
    if (read === null) return;
    const wanted = new Map<string, number>();
    for (const r of [read.new, read.trending_5m, read.trending_1h]) for (const [t, s] of r.created) if (!makers.has(t) && s >= 0) wanted.set(t, s);
    // the least-tried first, so a token whose read keeps failing never holds the others back
    const ask = [...wanted].sort((a, b) => (tries.get(a[0]) ?? 0) - (tries.get(b[0]) ?? 0)).slice(0, RECORDS[chain] === null ? MAKER_PER_TICK : RECORDS_PER_TICK).map(([token, createdS]) => ({ token, createdS }));
    if (ask.length > 0) {
      const got = await readMakers(chain, rpcFetch, ask, now());
      for (const a of ask) {
        const pad = got.get(a.token);
        if (pad === undefined) {
          // not settled (a provider failed, the two differ, or too new to call none): untagged for now, read again
          // behind every token tried fewer times; a failing provider never settles a token as none
          if (tries.size >= MAKER_MAX) tries.delete(tries.keys().next().value!);
          tries.set(a.token, (tries.get(a.token) ?? 0) + 1);
          continue;
        }
        tries.delete(a.token);
        if (makers.size >= MAKER_MAX) makers.delete(makers.keys().next().value!);
        makers.set(a.token, pad);
      }
    }
    build();
  }

  function start(): Promise<void> {
    if (!running) running = tick().catch(() => undefined).finally(() => (running = null));
    return running;
  }

  /** The snapshot, dated by its oldest list read however far behind, with a read started when it is behind; 503 only
   *  while no list was ever read. A cold call waits for one tick. */
  async function get(): Promise<ListsAnswer> {
    if (last === null) await start();
    if (last === null) return UPSTREAM;
    if (now() - last.asOfMs > LIST_MS) void start();
    return last;
  }

  /** One tick now and one every TICK_MS; the timer never holds the process open. Returns the stop. */
  function warm(): () => void {
    void start();
    const t = setInterval(() => void start(), TICK_MS);
    t.unref();
    return () => clearInterval(t);
  }

  /** This chain's lists as a next process takes them over. */
  function state(): EvmListsState {
    const out: EvmListsState = { reads: {}, makers: [...makers] };
    for (const k of LIST_KEYS) if (reads[k] !== undefined) out.reads[k] = { raw: reads[k]!.raw, at: reads[k]!.at };
    return out;
  }

  /** A previous process's state (hostile input, as a vendor's): each list read, however old, is parsed again by
   *  toRows; a maker is kept only as an address and one of this chain's pads or null. Reads held already are kept.
   *  True when every list is held after it, so the lists answer without a GeckoTerminal call. */
  function restore(st: unknown): boolean {
    const t = now();
    const o = (st ?? {}) as { reads?: unknown; makers?: unknown };
    const rs = (o.reads ?? {}) as Record<string, unknown>;
    for (const k of LIST_KEYS) {
      const r = (Object.hasOwn(rs, k) ? rs[k] : undefined) as { raw?: unknown; at?: unknown } | undefined;
      if (reads[k] !== undefined || typeof r?.raw !== "string" || r.raw.length > ANSWER_MAX || typeof r.at !== "number" || !Number.isFinite(r.at) || r.at > t) continue;
      try {
        const rows = toRows(chain, JSON.parse(r.raw), r.at);
        if (rows !== null) reads[k] = { ...rows, at: r.at, raw: r.raw };
      } catch {
        // not an answer: the list is read from GeckoTerminal
      }
    }
    const pads = new Set(FACTORIES[chain].map((f) => f.pad));
    if (Array.isArray(o.makers))
      for (const m of o.makers.slice(0, MAKER_MAX)) {
        if (!Array.isArray(m) || m.length !== 2 || typeof m[0] !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(m[0]) || !(m[1] === null || (typeof m[1] === "string" && pads.has(m[1])))) continue;
        if (!makers.has(m[0])) makers.set(m[0], m[1]);
      }
    build();
    return all() !== null;
  }

  return { get, warm, tick, state, restore, onAnswer };
}
