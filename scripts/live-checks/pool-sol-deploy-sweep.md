CARD pool-sol-deploy-sweep / live: PASS
Money path: yes
Tx: solana-devnet 2urmWKB7QqY8QDe9DUozHD5E8A7LBPuvLAZBFmviXxi3KsfFZYpN75WU9vrYTfcASs2TqUs7g8jvhm4UJvoxfP5g
Tx: solana-devnet 5VLYV6ibcnQ2mmFkrFpYdSmz9P1fk1yTHzEw1uWi1fXe33GbXZDF3US4K7EVPyJRteNLDxzn3K567fi2TFhakYwb

The run: contracts/pool-solana/scripts/deploy.mjs on Solana devnet, stopped by SIGHUP at 2026-11-05T03:40:18.756Z during its funding wait, before any funding; it kept its keys. Its steps, in the order of the Tx lines above: funding (to the funder), sweep (kept keys, to the funding's source 3NSPoKXm5PNTLurbAcJiYRB6oEuK4dfrxJy26JvzMqKx).
The funding came after the run had ended, from the team's devnet wallet; the journal's --sweep-kept command swept it back to the funding's sender and removed the keys once the funder read 0. This live check reads the funder EhhkfuoyW4usuACYWcZKHbX48Ud3zf3V5ZyE9BoKEWkR at 0 lamports on https://api.devnet.solana.com and https://solana-devnet.api.onfinality.io/public. Its program id J7KpQFVgMfjXf8d3geSuAznopjUfy3zVHCQ7RkzCBuk7 was never deployed.
The live check reads each Tx line above finalized with no error on both RPCs, every sweep after the funding's slot.
