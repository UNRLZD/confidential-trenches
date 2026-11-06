CARD wallet-deposit-follow / live: FAIL
Money path: yes

The device follows a deposit from its checked address to its note with no tap: one follower per U, binding every
credit that reaches U as U's next note and counting each note for one op only (packages/wallet/src/deposit/follow.ts,
packages/signpage/src/deposit-follow.ts). Its live check (wallet-deposit-follow.mjs) reads SIGN_HOST's pinned bundle
and the helper's status proxy; it moves no money.

Pending, an owner money step: one real mainnet refund read. A deposit quote is refunded by 1Click (refundType INTENTS)
and the device reads U's balance of the quote's origin asset inside intents.near on two RPCs (readHeld, mt_balance_of),
shows refunded, and keeps reading the chain. Its transactions go on Tx lines here once the owner's run lands; the card
stays in Verify until then. The verdict above reads FAIL only because no money run has landed yet: the money gate refuses this record until its Tx lines are written.
