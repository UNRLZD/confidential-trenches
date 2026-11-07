// The device's reads of every account a recorded build writes, for checks on records whose wallet owns nothing: every
// such account reads as no account (card solana-legs-checked: S6 and S11 refuse a written account the device has not
// read). The records' wallets are random addresses made per run, so none of them owns a token account.
import { solanaDecodeTransaction, solanaResolveKeys, type SolanaLookupTable } from "../src/checks/solana/message.ts";

export function noneWritten(wire: Uint8Array, tables: Readonly<Record<string, SolanaLookupTable>>): Record<string, [null, null]> {
  return Object.fromEntries(solanaResolveKeys(solanaDecodeTransaction(wire).message, tables).filter((k) => k.writable).map((k) => [k.key, [null, null]]));
}
