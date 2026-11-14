# B3: Robinhood Chain factory and pool-manager addresses (read from the chain and from the vendors)

Status 2026-10-22 19:09Z (from `date -u`): **done. All seven rows have an address that the chain and the vendor agree on.**
The chain read used two RPCs. Six rows also have a vendor listing. Pons v2's own docs give its factory. Clanker's docs page has no
Robinhood section, but Clanker's own SDK has it. The Pools.trade launch strategy that GeckoTerminal's `uniswap-pools-trade` pools
come from is not in Uniswap's README, so its only proof is the chain read. No mismatch between a vendor's address and the chain was found.

Prep lane PR1, merge note M190 (12) ("reads B1-B3 ... Robinhood's factory and pool manager"). These are the addresses that paper 03 §2A.1 rows 1-6 and paper 11
§1.5 item 5 list as "Not read". L2b was going to read them on Nov 5. Read-only, keyless. No key, wallet or UNRLZD repo file was used.

## Method

1. **Vendor pages** (19:01-19:04Z). Each page was fetched with `curl -sSL -A "Mozilla/5.0"`. The Robinhood rows are copied in
   `results/docs-excerpts.md` with each URL and fetch time. The full pages are not kept; their SHA-256 values are in `results/docs-sha256.txt`.
2. **Chain read** (`node read.mjs`, 19:06:09Z to 19:07:28Z, raw output in `results/reads-2026-10-22T19-06-09-369Z.json`, log in `results/run-2026-10-22T19-06Z.log`, kept local only: `*.log` is gitignored, and the JSON holds every read).
   - RPCs: the official `https://rpc.mainnet.chain.robinhood.com` and `https://4663.rpc.thirdweb.com`. Both answered `eth_chainId`
     `0x1237` (4663), and so did `robinhood.drpc.org`.
   - Per address, on both RPCs: `eth_getCode` at `latest` (byte length plus the keccak-256 of the code, computed with
     `proofs/p3-coverage/keccak.mjs`), and one or two identifying `eth_call`s at `latest`.
   - On the official RPC only: `eth_getLogs` for the address's launch or pool-creation event over 864,000 blocks, from
     94,477,257 (2026-10-21T18:04:27Z) to 95,341,257 (2026-10-22T19:06:11Z), which is 25.03 h. This RPC is used because it serves
     address-filtered logs up to 10 M blocks a call (paper 11 F24); thirdweb and dRPC cap logs at about 1,000 and 100 blocks (F27, F28).
3. **Pools.trade map** (`node pools-trade-map.mjs`, 19:08:13Z, `results/pools-trade-map-2026-10-22T19-08-13-750Z.json`).
   - One keyless GeckoTerminal page: `GET https://api.geckoterminal.com/api/v2/networks/robinhood/dexes/uniswap-pools-trade/pools?page=1`
     (200, 20 pools, its default order).
   - Every `TokenLaunched(bytes32,address,address,PoolKey)` from the three candidate strategies over 9,000,000 blocks (about
     10.5 days), on the official RPC. topic1 of that event is the v4 pool id.
   - A pool id that appears in both lists ties that pool to that strategy.
4. **Event names**: two topics were looked up keyless on openchain (19:08:28Z):
   - `GET https://api.openchain.xyz/signature-database/v1/lookup?event=0x0afd26d7…b44b` → `DistributionInitialized(address,address,uint256)`;
   - `…?event=0x68ff1cfc…79ab` → `Create(address,address,address,address)` (Doppler's Airlock `Create`).

Requests, exactly as sent (JSON-RPC 2.0 POST; `<A>` = the address, `<SEL>` = the 4-byte selector):
`{"method":"eth_getCode","params":["<A>","latest"]}`; `{"method":"eth_call","params":[{"to":"<A>","data":"<SEL>[arg]"},"latest"]}`;
`{"method":"eth_getLogs","params":[{"address":"<A>","topics":["<topic0>"],"fromBlock":"0x5a19209","toBlock":"0x5aec0c9"}]}`.

## Result

"Code" is the byte length on official / thirdweb, both equal, and the code hashes were equal on every row (`codeAgree: true` for all 21 addresses).
"Logs" is the count of the event on the official RPC over the 25.03 h.

| Paper row | Name | Address | Code (bytes) | Identifying read (official = thirdweb) | Logs in 25.03 h | Vendor source | Verdict |
|---|---|---|---|---|---|---|---|
| 03 §2A.1 row 1 | **Pons V2 factory** | `0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e` | 24,177 | `owner()` = `0x263ed295…19dd` | `TokenLaunched(address,address,address,address,uint256,uint256)` 1,675 | docs.ponsfamily.com/v2 "Contracts": Factory `0x7eD598Bc…01EC7e`, and the same event signature | **CONFIRMED** (chain + vendor; P6 §16.5 agrees) |
| row 1 (note) | Pons v1 active factory (`pons-dot-family`) | `0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb` | 24,353 | `owner()` = `0x263ed295…19dd` (same owner as v2) | docs topic0 `0xdb51ea9a…235a`: **0** | docs.ponsfamily.com "Contracts": Active factory, start block 8,991,118 | Code live, **no launch in 25 h**. Pons launches now go through v2 |
| row 2 | **Pools.trade launch strategy** (the launch event) | `0x23f8209572b4a1c2ad88a42749e830791fb027f1` | 10,822 | `poolManager()` = `0x8366a39c…0951` (the v4 PoolManager) | `TokenLaunched(bytes32,address,address,PoolKey)` 30 (259 in 10.5 days) | **Not in Uniswap's Liquidity Launcher README** (it lists `0x7c48DDe3…` and `0xC9566675…` for Robinhood) | **CHAIN ONLY**: 17 of 20 GeckoTerminal `uniswap-pools-trade` pools map to it. The 3 that do not map (FRONG 07-30, HOOKR 08-06, PROLOGUE 08-17) predate the 10.5-day window |
| row 2 | Pools.trade entry: Liquidity Launcher v3.2.0 | `0x0000ffffbe8efe702c8703ae3477ff5de3d319c0` | 4,127 | (no view called) | `TokenCreated(address)` 53 | Liquidity Launcher README: v3.2.0, same address on all chains with canonical Permit2 | CONFIRMED. It is the entry point for every Liquidity Launcher launch, not only Pools.trade's |
| row 2 | Pools.trade token factory: UERC20Factory v2.0.0 | `0x000000e200088d55c39a11f609e5f667729ad49b` | 13,380 | (no view called) | `TokenCreated(address,(string,string,string,bytes))` 139 | uerc20-factory README: "Robinhood" row | CONFIRMED. It creates every UERC20 token (139), more than Pools.trade launches |
| row 2 (README) | InstantLaunchStrategy v3.3.0 (a) | `0x7c48dde3b447381f4d986334679b3afc7f2d35c2` | 11,287 | `poolManager()` = `0x8366a39c…0951` | `TokenLaunched` 5 (83 in 10.5 days) | Liquidity Launcher README | CONFIRMED. None of the 20 GeckoTerminal Pools.trade pools come from it |
| row 2 (README) | InstantLaunchStrategy v3.3.0 (b) | `0xc9566675b1ea42861546f3c5b74ace2c79c49572` | 11,287 | `poolManager()` = `0x8366a39c…0951` | `TokenLaunched` 0 (8 in 10.5 days) | Liquidity Launcher README | CONFIRMED, quiet |
| row 3 | **Uniswap v4 PoolManager** | `0x8366a39cc670b4001a1121b8f6a443a643e40951` | 24,009 | `owner()` = `0x2bad8182…46cd`; `protocolFeeController()` = `0x6d000950…314c`; `poolManager()` of v4 PositionManager, StateView, Quoter, the Pools.trade strategy and Doppler's DopplerHookInitializer all return it | `Initialize` 5,478 | Uniswap v4 deployments, "Robinhood Chain: 4663" | **CONFIRMED** |
| row 4 | **Uniswap v3 Factory** | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` | 24,535 | `owner()` = `0x05c420bc…aa25`; `feeAmountTickSpacing(3000)` = 60, `(500)` = 10; `factory()` of NonfungiblePositionManager `0x73991a25…e0d3`, QuoterV2 `0x33e885ed…a9e7` and SwapRouter02 `0xcaf681a6…5cb2` all return it | `PoolCreated` 237 | Uniswap v3 "Robinhood Chain Deployments" (also lists NPM `0x73991a25…`, QuoterV2 `0x33e885ed…`, SwapRouter02 `0xcaf681a6…`) | **CONFIRMED** |
| row 5 | **Uniswap v2 Factory** | `0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f` | 13,859 | `allPairsLength()` = 126,926; `feeToSetter()` = `0x2bad8182…46cd`; Router02 `0x89e5db8b…9eba` `factory()` returns it and `WETH()` = `0x0bd7d308…ad73`; SwapRouter02 `factoryV2()` returns it | `PairCreated` 1,853 | Uniswap v2 deployments: Robinhood Chain row (Factory, V2Router02 `0x89e5db8b…`) | **CONFIRMED** |
| row 6 | **Clanker v4 factory** | `0xd3f2cc1731b7fd17f28798835c2e02f0a1839a94` | 12,070 | `owner()` = `0xeea96d95…eab8` | `TokenCreated` (v4 ABI, topic0 `0x9299d1d1…fb67`) 16 | **Docs page: no Robinhood section.** Clanker SDK 4.2.19 (`clanker_v4_robinhood`, chainId 4663) lists it | **CONFIRMED** (chain + vendor SDK; P6's MFISH receipt agrees) |
| row 6 | **Bankr = Doppler Airlock** | `0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862` | 5,695 | `owner()` = `0x21e2ce70…7a66` | `Create(address,address,address,address)` 1,392 | Doppler "Robinhood Mainnet (4663)": Airlock. Bankr support: "Launches go to Robinhood Chain by default", "Tokens launch with fair launch mechanics on the Doppler protocol." | **CONFIRMED**. The Airlock's `Create` is every Doppler launch on 4663, not only Bankr's. P6 §16.5 tells Bankr's apart by the `…ba3` asset suffix |
| (P6) | Doppler DopplerHookInitializer | `0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544` | 25,533 | `poolManager()` = `0x8366a39c…0951` | (not read) | Doppler "Robinhood Mainnet (4663)" | CONFIRMED (P6's main initializer, 1,600 of 1,605) |

Both "(no view called)" rows are identified by their own launch events, which P6 §16.5 also saw in the FUNS receipt. `0x1242c943…dcee`, the second
`0x0afd26d7` emitter in that receipt, is not a launch contract: its `poolManager()` reverts on both RPCs, it emitted no `TokenLaunched`
in 25 h, and `0x0afd26d7` is `DistributionInitialized(address,address,uint256)`.

## What this answers for the papers

- **Pools.trade (03 §2A.1 row 2, "which of the three contracts is the factory").**
  - The label event is `TokenLaunched(bytes32 poolId, address, address, PoolKey)` (topic0 `0x3b3d2baf…42a4`) from
    `0x23f82095…27f1`. It carries the v4 pool id and the PoolKey, and it matched 17 of 20 GeckoTerminal Pools.trade pools.
  - The Liquidity Launcher's `TokenCreated(address)` and the UERC20Factory's `TokenCreated` count every Liquidity Launcher or
    UERC20 launch, so they are too wide for a Pools.trade label.
  - Uniswap does not list this strategy. A later redeploy would change the address with no docs change, so it needs the same
    boot-time read as any baked address.
- **Bankr (row 6).** The Airlock is shared by every Doppler launch on 4663 (1,392 `Create` in 25 h). The Bankr label stays
  P6's `…ba3` asset-suffix rule. Bankr publishes no factory of its own.
- **Clanker (row 6).** Clanker's docs page lists no Robinhood deployment (sections: Base, Arbitrum One, Unichain, Mainnet,
  Binance, Monad, Solana, two testnets). The address comes from Clanker's npm SDK and from the chain.
- **Not asked but seen:** Pons v1's factory is live but quiet (0 launches in 25 h). INFERENCE, not read: GeckoTerminal's `pons-dot-family` id is that v1.

## Reproduce

`node read.mjs` (about 80 s, 111 keyless calls) and `node pools-trade-map.mjs` (5 calls). Node ≥ 18, no dependencies.
