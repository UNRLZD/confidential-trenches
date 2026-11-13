export interface ExitCtx { seed: Uint8Array; to: string; rpcs: [string, string]; say: (line: string) => void }
export interface ExitResult { chain: "near" | "solana" | "base" | "robinhood"; txs: string[]; sent: string; left: string }
export type ExitChain = (ctx: ExitCtx) => Promise<ExitResult>;
