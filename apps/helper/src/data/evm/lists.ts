// GET /v1/market/lists?chain=base and ?chain=robinhood: Discover's EVM lists in the frozen Solana row (../solana/lists.ts
// ROW_FIELDS, the terminal's apps/terminal/src/screens/discover/fields.ts), every row tagged with the launchpad whose
// factory made the token (owner 3 Nov 10:11Z), read on chain.
//
// Lists: GeckoTerminal's keyless `networks/<net>/new_pools` and `trending_pools?duration=5m|1h` (D-E2, M:2315; D-E6
// names the same networks), page 1 each (20 pools), with the pools' base tokens included. GeckoTerminal allows 10
// calls a minute per caller (../gecko.ts), shared with the Solana token page's candles, so each chain's three lists
// are read together once per LIST_MS in the "lists" lane, capped at LISTS_PER_MIN per chain.
//
// Launchpad (the maker): the block the token's pool was made in, then on two RPC providers one `eth_getLogs` over that
// block and the one before it, filtered to the chain's FACTORIES and their creation events; the row's launchpad is the
// pad whose factory's creation event names the token where that event puts the new token. Both providers must answer
// and agree; a token no listed factory made gets null, never a guess. A pad's tokens are made with their pool in one
// transaction (each pad's creation event holds the pool or hook), so the pool's block is the token's. A token's maker
// never changes, so it is read once and kept (MAKER_MAX tokens); a refresh reads only tokens it has not settled.
//
// Display only: nothing here feeds a signature. Every vendor and RPC value is hostile input, checked as in the Solana
// lists: a row with no valid address, symbol or name is dropped, numbers are checked finite and bounded or become null,
// text is cut and stripped, a list holds at most LIST_MAX rows, and an RPC log is used only when its emitter, topic0
// and token word match the table exactly.
import { gzipSync } from "node:zlib";
import { dec, LIST_MAX, ROW_FIELDS, text, type ListsAnswer, type Row } from "../solana/lists.ts";
import type { GeckoBudget } from "../gecko.ts";

export const EVM_CHAINS = ["base", "robinhood"] as const;
export type EvmChain = (typeof EVM_CHAINS)[number];
export type EvmSnapshot = { chain: EvmChain; lists: Record<"new" | "trending" | "trending_5m" | "trending_1h" | "graduating", Row[]>; as_of_ms: number };

export const GT_BASE = "https://api.geckoterminal.com/api/v2";
/** GeckoTerminal's network id per chain (read 2026-11-03 11:25Z: `networks/base/new_pools` and `networks/robinhood/new_pools`, 20 pools each). */
export const GT_NETWORK: Readonly<Record<EvmChain, string>> = { base: "base", robinhood: "robinhood" };
export const GT_READS = {
  new: "new_pools?include=base_token&page=1",
  trending_5m: "trending_pools?include=base_token&duration=5m&page=1",
  trending_1h: "trending_pools?include=base_token&duration=1h&page=1",
} as const;
/** Each chain's three lists are read together once a minute: 3 calls a minute per chain from GeckoTerminal's 10. */
export const LIST_MS = 60_000;
export const LISTS_PER_MIN = 3;
/** The snapshot is rebuilt on the Solana lists' cadence (D-S2's 12 s): makers not settled yet are read again. */
export const TICK_MS = 12_000;
/** A snapshot whose oldest list read is older than this answers 503, never a stale list passed as fresh. */
export const STALE_MS = 2 * LIST_MS;
/** A pool younger than this whose block shows no creation event is read again, since a provider may not hold its logs yet. */
export const SETTLE_MS = 60_000;
export const MAKER_MAX = 20_000;
/** Makers read per tick, per provider: one batch of `eth_getLogs` (two filters a token on Base). */
export const MAKER_PER_TICK = 10;
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
export const BATCH_MAX: Readonly<Record<string, number>> = { "https://base.drpc.org": 3, "https://robinhood.drpc.org": 3 };

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
const BAGS_CREATED = "0x643b3b606052cbadac2f906ad0b462da99eda2a1d4f824d315d7f6edd3e4cced"; // TokenCreated(address indexed token,address indexed curve,address indexed creator,address feeShare,address partner,bytes32 poolId,string name,string symbol,string metadataURI)

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
    // docs.bags.fm/robinhood/overview.md: "BagsFactory | 0xe8Cc4431adF8b5A847C113EF0c6af9043219Cb37" (a proxy; its EIP-1967 slot read 2026-11-03 13:41Z names
    // implementation 0x7dfa0131f6c8626f199a2e33e49dfb5660e6ef1c, Sourcify [BagsFactory], whose TokenCreated adds `partner`: every one of the
    // factory's 4449 creation logs on chain carries this topic0, none the older implementation 0x46aD6f53's)
    { pad: "bags", address: "0xe8Cc4431adF8b5A847C113EF0c6af9043219Cb37", topic0: BAGS_CREATED, at: { topic: 1 } },
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
export function toRows(chain: EvmChain, answer: unknown, asOfMs: number): { rows: Row[]; created: Map<string, number> } | null {
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
  return { rows, created };
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

/** The most blocks one second may hold before a block-time answer is refused (Robinhood put 10 or more in one second:
 *  Bags' creation of 0x4dd4aad9887eb3b7615baace5fcd565c0f61008c is the 10th block of its second, block 98761499). */
export const SECOND_BLOCKS_MAX = 1_000;
const hexInt = (v: unknown): number | null => (typeof v === "string" && /^0x[0-9a-f]{1,13}$/i.test(v) ? parseInt(v, 16) : null);

/** Block reads for the search: from the chain's second provider, or its first when the second refuses (a 429). The
 *  search is not trusted for any tag (the logs are read on both), so either may answer it. */
async function blocks(doFetch: Fetch, chain: EvmChain, ns: (number | "latest")[]): Promise<unknown[]> {
  const calls = ns.map((n) => ({ method: "eth_getBlockByNumber", params: [n === "latest" ? n : `0x${n.toString(16)}`, false] }));
  for (const url of [MAKER_RPCS[chain][1], MAKER_RPCS[chain][0], MAKER_RPCS[chain][2]]) {
    const got = await batch(doFetch, url, calls);
    if (got.every((x) => x !== undefined)) return got;
  }
  return calls.map(() => undefined);
}

/** One block's number and time, or null. */
async function blockTime(doFetch: Fetch, chain: EvmChain, n: number | "latest"): Promise<{ n: number; t: number } | null> {
  const [r] = await blocks(doFetch, chain, [n]);
  const o = obj(r);
  const bn = hexInt(o.number);
  const bt = hexInt(o.timestamp);
  return bn === null || bt === null || (n !== "latest" && bn !== n) ? null : { n: bn, t: bt };
}

/**
 * The blocks a pool made at unix second `s` can be in: on a chain with a fixed clock its block and the one before; else
 * every block whose time is `s`: from the first block whose time is at least `s` to the one before the first at least
 * `s + 1` (each searched between block 0 and the head, in rounds of one batch of 10 block reads around the interpolated
 * guess and across the interval, at most 12 rounds; the second search starts from the first's reads). A wrong range
 * finds no creation event, so it can only leave a row untagged, never tag it.
 */
export async function blockRange(chain: EvmChain, s: number, doFetch: Fetch, known: Map<number, number> = new Map()): Promise<[number, number] | null> {
  const b = blockAt(chain, s);
  if (b !== null) return [b - 1, b];
  if (BLOCK_CLOCK[chain] !== null || !Number.isSafeInteger(s)) return null;
  const [head, zero] = await Promise.all([blockTime(doFetch, chain, "latest"), known.has(0) ? { n: 0, t: known.get(0)! } : blockTime(doFetch, chain, 0)]);
  if (head === null || zero === null || s > head.t || s <= zero.t) return null;
  const keep = (m: { n: number; t: number }) => {
    if (known.size >= 4_096) known.delete(known.keys().next().value!);
    known.set(m.n, m.t);
  };
  keep(zero);
  /** The first block whose time is at least `at` (zero.t < at <= head.t), or null when the reads fail. */
  const firstAt = async (at: number): Promise<{ n: number; t: number } | null> => {
    let lo = zero; // lo.t < at <= hi.t
    let hi = head;
    // start from the closest blocks earlier searches read (a block's time never changes)
    for (const [n, t] of known) {
      if (t < at && n > lo.n && n < hi.n) lo = { n, t };
      else if (t >= at && n < hi.n && n > lo.n) hi = { n, t };
    }
    for (let round = 0; hi.n - lo.n > 1; round++) {
      if (round >= 12) return null;
      const g = lo.n + Math.round(((at - lo.t) * (hi.n - lo.n)) / Math.max(1, hi.t - lo.t));
      const span = hi.n - lo.n;
      const picks = [g, g - 2, g + 2, g - 32, g + 32, g - 1_024, g + 1_024, lo.n + Math.floor(span / 4), lo.n + Math.floor(span / 2), lo.n + Math.floor((3 * span) / 4)];
      const ns = [...new Set(picks.map((n) => Math.min(hi.n - 1, Math.max(lo.n + 1, n))))].sort((a, b) => a - b);
      const got = await blocks(doFetch, chain, ns);
      for (const [k, r] of got.entries()) {
        const o = obj(r);
        const m = { n: hexInt(o.number), t: hexInt(o.timestamp) };
        if (m.n !== ns[k] || m.t === null) return null;
        keep(m as { n: number; t: number });
        if (m.t < at && m.n > lo.n) lo = m as { n: number; t: number };
        else if (m.t >= at && m.n < hi.n) hi = m as { n: number; t: number };
      }
      if (lo.t >= hi.t && hi.n - lo.n > 1) return null; // times out of order: not a chain
    }
    return hi;
  };
  const start = await firstAt(s);
  if (start === null || start.t > s) return null; // no block at that second
  const after = s + 1 > head.t ? null : await firstAt(s + 1);
  if (s + 1 <= head.t && after === null) return null;
  const end = after === null ? head.n : after.n - 1;
  return end < start.n || end - start.n >= SECOND_BLOCKS_MAX ? null : [start.n, end];
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

/** JSON-RPC batches to one provider (BATCH_MAX calls each, one after another): each call's `result`, by position;
 *  undefined for any that failed. */
export async function batch(doFetch: Fetch, url: string, calls: { method: string; params: unknown[] }[]): Promise<unknown[]> {
  const max = BATCH_MAX[url] ?? 10;
  if (calls.length <= max) return batchOnce(doFetch, url, calls);
  const out: unknown[] = [];
  for (let i = 0; i < calls.length; i += max) out.push(...(await batchOnce(doFetch, url, calls.slice(i, i + max))));
  return out;
}

async function batchOnce(doFetch: Fetch, url: string, calls: { method: string; params: unknown[] }[]): Promise<unknown[]> {
  const none = calls.map(() => undefined);
  if (calls.length === 0) return [];
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
      return none;
    }
    const body = await r.text();
    if (body.length > ANSWER_MAX) return none;
    const parsed: unknown = JSON.parse(body);
    const answers = Array.isArray(parsed) ? parsed : [parsed];
    const out: unknown[] = [...none];
    for (const a of answers) {
      const o = obj(a);
      if (Number.isSafeInteger(o.id) && (o.id as number) >= 0 && (o.id as number) < calls.length && Object.hasOwn(o, "result") && !Object.hasOwn(o, "error")) out[o.id as number] = o.result;
    }
    return out;
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

/** Tokens per tick whose creation block is searched (EARLIER_READS_MAX block reads each, at most). */
export const EARLIER_PER_TICK = 2;
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

/** The makers of these tokens: a pad, null for none (settled), or absent when not settled yet. A token whose pool
 *  block shows no creation event and whose code is older is read again at the block its code appeared in. */
export async function readMakers(chain: EvmChain, doFetch: Fetch, wanted: readonly { token: string; createdS: number }[], nowMs: number, known?: Map<number, number>): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (FACTORIES[chain].length === 0) {
    // no factory on this chain: nothing can name a maker, so every token is settled as none
    for (const w of wanted) out.set(w.token, null);
    return out;
  }
  const ranges: ([number, number] | null)[] = [];
  for (const w of wanted) ranges.push(await blockRange(chain, w.createdS, doFetch, known)); // one at a time, each from the last's blocks
  const asks = wanted.flatMap((w, i) => (ranges[i] === null ? [] : [{ ...w, range: ranges[i]! }]));
  const first = await padsAt(chain, doFetch, asks);
  const none: (typeof asks)[number][] = [];
  for (const a of asks) {
    const x = first.get(a.token);
    if (x === undefined) continue; // read again later
    if (x === null && nowMs / 1000 - a.createdS < SETTLE_MS / 1000) continue; // too new to call it none
    if (x === null && BLOCK_CLOCK[chain] !== null) none.push(a);
    else out.set(a.token, x);
  }
  // none at the pool: a token with no code before its pool was made there, so none; an older token's creation block is
  // searched, a few a tick (the rest are read again next tick)
  const had = await hadCode(chain, doFetch, none.map((a) => ({ token: a.token, at: a.range[0] - 1 })));
  const older = none.filter((a, i) => {
    if (had[i] === false) out.set(a.token, null);
    return had[i] === true;
  });
  const earlier: { token: string; range: [number, number] }[] = [];
  for (const a of older.slice(0, EARLIER_PER_TICK)) {
    const b = await codeBlock(chain, a.token, a.range[0], doFetch);
    if (b === null) out.set(a.token, null);
    else if (b !== undefined) earlier.push({ token: a.token, range: [b, b] });
  }
  const second = await padsAt(chain, doFetch, earlier);
  for (const e of earlier) if (second.has(e.token)) out.set(e.token, second.get(e.token)!);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The served answer
// ---------------------------------------------------------------------------------------------------------------

const UPSTREAM: ListsAnswer = { status: 503, body: JSON.stringify({ error: { code: "upstream" } }) };
type Read = { rows: Row[]; created: Map<string, number>; at: number };

/** Discover's lists for one EVM chain: GeckoTerminal's lists once per LIST_MS, makers read and kept, rebuilt per TICK_MS. */
export function createEvmLists(chain: EvmChain, gecko: GeckoBudget, deps: { fetch?: Fetch; now?: () => number } = {}) {
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetch ?? fetch;
  const makers = new Map<string, string | null>();
  const known = new Map<number, number>(); // block times the Robinhood search has read
  const tries = new Map<string, number>(); // maker reads that settled nothing, per token
  let read: { new: Read; trending_5m: Read; trending_1h: Read } | null = null;
  let last: (ListsAnswer & { asOfMs: number }) | null = null;
  let running: Promise<void> | null = null;

  async function gt(path: string): Promise<Read | null> {
    if (!gecko.take("lists")) return null;
    try {
      const r = await doFetch(`${GT_BASE}/networks/${GT_NETWORK[chain]}/${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
      if (r.status === 429) {
        const ra = Number(r.headers.get("retry-after"));
        gecko.pause(now() + (Number.isFinite(ra) && ra > 0 ? Math.min(ra, 300) * 1000 : 60_000));
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
      return rows === null ? null : { ...rows, at };
    } catch {
      return null;
    }
  }

  function build() {
    if (read === null) return;
    const tag = (rows: Row[]) => rows.map((r) => ({ ...r, launchpad: makers.get(r.token as string) ?? null }));
    const asOf = Math.min(read.new.at, read.trending_5m.at, read.trending_1h.at);
    const lists = { new: tag(read.new.rows), trending: tag(read.trending_1h.rows), trending_5m: tag(read.trending_5m.rows), trending_1h: tag(read.trending_1h.rows), graduating: [] as Row[] };
    const body = JSON.stringify({ chain, lists, as_of_ms: asOf } satisfies EvmSnapshot);
    last = { status: 200, body, gzip: gzipSync(body), asOfMs: asOf };
  }

  async function tick(): Promise<void> {
    if (read === null || now() - Math.min(read.new.at, read.trending_5m.at, read.trending_1h.at) >= LIST_MS) {
      const [n, t5, t1] = await Promise.all([gt(GT_READS.new), gt(GT_READS.trending_5m), gt(GT_READS.trending_1h)]);
      if (n !== null && t5 !== null && t1 !== null) read = { new: n, trending_5m: t5, trending_1h: t1 };
    }
    if (read === null) return;
    const wanted = new Map<string, number>();
    for (const r of [read.new, read.trending_5m, read.trending_1h]) for (const [t, s] of r.created) if (!makers.has(t) && s >= 0) wanted.set(t, s);
    // the least-tried first, so a token whose read keeps failing never holds the others back
    const ask = [...wanted].sort((a, b) => (tries.get(a[0]) ?? 0) - (tries.get(b[0]) ?? 0)).slice(0, MAKER_PER_TICK).map(([token, createdS]) => ({ token, createdS }));
    if (ask.length > 0) {
      const got = await readMakers(chain, doFetch, ask, now(), known);
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

  /** The snapshot, or 503 when no list read is newer than STALE_MS. A cold call waits for one tick. */
  async function get(): Promise<ListsAnswer> {
    if (last === null) await start();
    if (last === null || now() - last.asOfMs > STALE_MS) {
      void start();
      return UPSTREAM;
    }
    return last;
  }

  /** One tick now and one every TICK_MS; the timer never holds the process open. Returns the stop. */
  function warm(): () => void {
    void start();
    const t = setInterval(() => void start(), TICK_MS);
    t.unref();
    return () => clearInterval(t);
  }

  return { get, warm, tick };
}
