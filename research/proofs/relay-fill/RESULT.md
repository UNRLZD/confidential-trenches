# Relay fill times (25 Oct 2026, 18:30-19:00Z)

How long Relay takes from the origin-chain transaction to the fill on the destination chain, read from Relay's
public request records (`https://api.relay.link/requests/v2`, successful requests only, newest 6 pages of 50 per
route; the gap is the latest destination tx timestamp minus the earliest origin tx timestamp). This backs the "Relay
hop at a tap" line in merge note M264 and master doc v20 ("0-3 s").

| Route | p50 | p95 |
|---|---|---|
| Solana -> Base | 2 s | 3 s |
| Base -> Solana | <1 s | 1 s |
| Solana -> Robinhood | <1 s | 1 s |
| Base -> Robinhood | <1 s | 1 s |
| Robinhood -> Solana | 1 s | 1 s |
| Robinhood -> Base | 2 s | 3 s |

About 290 fills per route. Relay serves no NEAR, so a NEAR leg falls back to NEAR Intents.

- `fill.py`: the sampler as last run (the Robinhood pairs; the Solana <-> Base run used the same loop with those chain
  ids). Run: `python3 -I fill.py`; it sleeps 3 s per page and backs off on HTTP 429.
- The raw sample page was removed (d9e6027 had it): it carried only public token addresses, which gitleaks flags.
