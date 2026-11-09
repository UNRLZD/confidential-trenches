// Every word the Verify panel draws, each with where the owner OK'd it (the shape of src/screens/deposit/words.ts). A
// word the owner's lists do not hold yet is `draft: true`: drawn with data-draft-copy and listed in the card's report.
// Numbers, amounts, hashes, account ids, block heights, symbols and RPC names are data, not copy.
//
// The owner's lists: the signed CN rows of docs/spec/09-design-brief.md, its draft copy (S18.3, S18.4), owner-words-pass
// (docs/owner-decisions.md:351) and the Nov 2 words page, which took every S18 row and check label as drafted (owner
// 2 Nov 06:08Z, all approved). Labels only, no claim words: the panel shows what it read (OD:343).

export interface Word {
  text: string;
  source: string;
  draft: boolean;
}

const ok = (text: string, source: string): Word => ({ text, source, draft: false });
const draft = (text: string, source: string): Word => ({ text, source, draft: true });

export const WORDS = {
  title: ok("Verify", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S18 (the footer's Verify pill, the panel it opens); the route's name"),
  close: ok("Close", "owner 1 Nov 16:45Z (Keep the drafts); the close icon's accessible name only (never drawn)"),
  code: ok("Code", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S18 code row (CN-128 copy needed); the S18 check name"),
  funds: ok("Funds", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S18 funds row (CN-129 copy needed)"),
  keys: ok("Vault keys", "owner 2 Nov 06:08Z, all approved; drafted from app.md A7 view_access_key_list (CN-130 copy needed)"),
  codeHash: ok("Code hash", "owner 2 Nov 06:08Z, all approved; drafted from app.md A7 view_account code_hash (CN-130 copy needed)"),
  release: ok("Release", "owner 2 Nov 06:08Z, all approved; drafted from app.md A7 the release's code hash (CN-130 copy needed)"),
  asset: ok("Asset", "CN-06, owner round 16 (the deposit sheet's Asset label); here config().asset, app.md A7"),
  registration: ok("Registration", "owner 2 Nov 06:08Z, all approved; drafted from app.md A7 storage_balance_of(vault), CH-120 (CN-130 copy needed)"),
  tokenCode: ok("Token code", "owner 2 Nov 06:08Z, all approved; drafted from app.md A7 view_account(token) code_hash (CN-130 copy needed)"),
  balance: ok("Balance", "owner 2 Nov 06:08Z, all approved; drafted from app.md A7 ft_balance_of(vault) (CN-130 copy needed)"),
  deposited: ok("Deposited", "owner 2 Nov 06:08Z, all approved; drafted from app.md A7 totals().deposited (CN-130 copy needed)"),
  spent: ok("Spent", "owner 2 Nov 06:08Z, all approved; drafted from app.md A7 totals().spent (CN-130 copy needed)"),
  returned: ok("Returned", "owner 2 Nov 06:08Z, all approved; drafted from app.md A7 totals().returned (CN-130 copy needed)"),
  surplus: ok("Surplus", "owner 2 Nov 06:08Z, all approved; drafted from app.md CH-093 balance - (deposited - spent + returned) (CN-130 copy needed)"),
  block: ok("Block", "owner 2 Nov 06:08Z, all approved; drafted from the R5 footer's Block label (design/proto/assets/app.js:384, `Block 220,948,200`)"),
  rpcs: ok("RPCs", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S18.4 [draft copy: RPCs disagree]"),
  unverified: ok("Unverified", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S18.3 [draft copy: Unverified]"),
  disagree: ok("RPCs disagree", "owner 2 Nov 06:08Z, all approved; drafted from 09-design-brief S18.4 [draft copy: RPCs disagree]"),
  // the pool rows (card verify-pools); each chain's row is named by its chain, data as deposit/model.ts CHAIN_NAME draws it
  pools: draft("Pools", "card verify-pools: the heading over the Solana, Base and Robinhood pool rows"),
  authority: draft("Upgrade authority", "card verify-pools: the Solana pool program's programdata upgrade authority (none drawn as —)"),
  owner: draft("Owner", "card verify-pools: owner() of the Base and Robinhood pool (none drawn as —)"),
  proxy: draft("Proxy", "card verify-pools: the EIP-1967 implementation, admin and beacon slots of the EVM pool (none drawn as —)"),
  solscan: ok("Solscan", "token/words.ts solscan (R5 token.js EXPL.solana); the Solana pool's first explorer"),
  solanaExplorer: draft("Solana Explorer", "card verify-pools: explorer.solana.com, the Solana pool's second explorer"),
  basescan: ok("BaseScan", "token/words.ts basescan (R5 token.js EXPL.base); the Base pool's first explorer"),
  blockscout: draft("Blockscout", "card verify-pools: base.blockscout.com, the Base pool's second explorer"),
  rhExplorer: ok("Robinhood explorer", "token/words.ts rhExplorer (R5 token.js EXPL.robinhood); the Robinhood pool's first explorer"),
  hoodscan: draft("HoodScan", "card verify-pools: hoodscan.co, the Robinhood pool's second explorer (chainid.network 4663 explorers)"),
} as const satisfies Record<string, Word>;

export type WordId = keyof typeof WORDS;

export const DRAFTS = (Object.keys(WORDS) as WordId[]).filter((k) => WORDS[k].draft);
