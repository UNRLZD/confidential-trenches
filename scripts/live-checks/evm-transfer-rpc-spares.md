CARD evm-transfer-rpc-spares / live: PASS
Money path: no

Run 2026-11-05 19:03:55-19:12:58Z on the card's final code (node scripts/live-checks/evm-transfer-rpc-spares.mjs --record), the newest 2,000 blocks of each network, every pool list (the kit's evmPoolVenues providers) and each testnet's Transfer list (EVM_TRANSFER_RPCS) read once with every provider live, then once per provider but thirdweb's with that provider answering as thirdweb's daily quota (HTTP 429, Retry-After 26,741,000 ms).

- Base pool (5 providers): every case read alike on two others; the out one asked at most once.
- Robinhood pool (5 providers): every case read alike on two others. robinhood-rpc.publicnode.com, the list's first, refuses a log read 2,000 blocks back with HTTP 403 "Archive requests require a personal token" (18:55Z), so it is swapped out as a provider out (HTTP 401 or 403); before that rule the first run failed on it.
- Skipped, not passed: a provider out on Base Sepolia's and Robinhood testnet's pool lists, which hold two providers, and no third keyless operator answers there.
- Skipped, not passed: a provider out on Base Sepolia's and Robinhood testnet's Transfer lists while thirdweb, each one's only third keyless operator, was out for the day (HTTP 429) at the run.
- Base's and Robinhood's Ws are read on the helper's route, never on a list (decision M359): ./wallet-restore-transfer-rpcs.mjs reads them.

The bad run beside it: every answer of Base's pool list but base-rpc.publicnode.com's a quota 429 too (one provider left): FAIL on Base's pool list only.
