# Confidential Trenches: verdict

Full report: `Pillow-Auditors-Confidential-Trenches.pdf` and `confidential-trenches-audit.html` (Pillow Auditors, v1.0, 2026-11-07).
Commit `46b16ca48be23c19dace0cddfe4c75a3bab0f0d9`.

**GO for hackathon submission. 0 Critical, 0 High, 0 Medium, 5 Low, 8 Info.**

Low: V-01 prepay exposes P (reproduced on shipped bytes + real USDC); E-01 sell minOut counts foreign ETH (PoC with a modelled release); V-02 refund twin (known); V-03 relayer bounce cost; S-01 Solana notes under 2,184,080 lamports uneconomic.

Evidence: vault 285/285 across 31 targets on shipped bytes; EVM 288/288 (fork tests replay recorded RPC); Solana 56/56 LiteSVM on the bytes dumped from mainnet, plus 14 unit. Logs in `logs/`, PoCs in `poc/`.

Not covered: cross-chain product and device checks, privacy, full circuit/ceremony audit, deployed adapters and SellDelegate, live mainnet money run.
