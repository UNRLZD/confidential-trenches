CARD pool-sol-deploy-sweep / live: PASS
Money path: yes
Tx: solana-devnet 2u9PLJniLvFRs6tkf9ghfmiq2NH7GTRYVz91F55Q4H9vcAhMDGGWuPJXDeRWawDr7Y7d6Qo5hx2Q33h9M1Dx1jo
Tx: solana-devnet 38jNYChqyU1eyWo6kHG2g1qBvmxdg8FPdWDyjGcjG28wBav6n2LThPZp2BXa8RiKiULmXe5TVBto1XAhg7NsMHVA
Tx: solana-devnet 2FoxZAgVjJ1NvRAV2B35YGbTCwT54Lb9u89Wt8MNa41zUzMGeuNghuARDaLFtyXm1e2jYrNSB6z5xF3MQHFsCZGG

The run: contracts/pool-solana/scripts/deploy.mjs on Solana devnet, stopped by SIGHUP during its funding wait, record written 2026-11-05T00:46:50.941Z. Its steps, in the order of the Tx lines above: funding (to the funder), sweep (the funder's rest back), sweep (the funder's rest back).
The funding came after the stop, from the team's devnet wallet 3NSPoKXm5PNTLurbAcJiYRB6oEuK4dfrxJy26JvzMqKx; the run watched the funder's balance for 60 s, swept it back there, and removed its keys only after reading the funder at 0. This live check reads the funder FtDEr9ynw2ZMnnix1yAHpun97c2MDiGkfLXhBMubwnWL at 0 lamports on https://api.devnet.solana.com and https://solana-devnet.api.onfinality.io/public. Its program id 9GiAwNMgKRSWEZqsq9FvhkJWt5EiMTu8U1sqGgdUMNFY was never deployed.
The live check reads each Tx line above finalized with no error on both RPCs, every sweep after the funding's slot.
