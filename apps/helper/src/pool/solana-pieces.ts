// POST /v1/pool/solana/pieces (card buy-spends-several-pieces): one pool buy made of several pieces, every tag 2 first
// and the tag 3 that buys last, all W-signed. The carry is solanaPoolSender's carryPieces (./solana.ts), which shares
// the one-piece route's state (one send per nullifier, failed_this_epoch, the per-client in-flight limit) and sends the
// tag 2s plain, then the tag 3 as the one-piece route does (card owners-solana-buy-lands).

/** POST /v1/pool/solana/pieces's body limit: the kit's HELPER_V1_PATHS row (8 KB), SOLANA_POOL_BUY_PIECES_MAX
 *  transactions in base64 and the JSON around them. */
export const POOL_SOLANA_PIECES_BODY_MAX = 8_192;
