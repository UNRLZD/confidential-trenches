// node --test packages/kit/test/solana-token-account.test.ts (card wallet-per-buy): solanaDecodeTokenAccount reads the
// base layout of a Token or Token-2022 account, and refuses an account longer than 165 bytes whose account type at
// byte 165 is not Account (2): a Token-2022 mint is padded to 165 bytes and typed 1 there (spl-token-2022 AccountType).
import assert from "node:assert/strict";
import { test } from "node:test";
import { base58 } from "@scure/base";
import { SOLANA_TOKEN_2022_PROGRAM, SOLANA_TOKEN_PROGRAM, solanaDecodeTokenAccount } from "@blindfill/kit";

const MINT = base58.encode(new Uint8Array(32).fill(7)), OWNER = base58.encode(new Uint8Array(32).fill(9));
function bytes(len: number, type?: number): Uint8Array {
  const b = new Uint8Array(len);
  b.set(base58.decode(MINT), 0);
  b.set(base58.decode(OWNER), 32);
  new DataView(b.buffer).setBigUint64(64, 123n, true);
  b[108] = 1;
  if (type !== undefined) b[165] = type;
  return b;
}

test("a 165-byte account of either program, and a Token-2022 account with extensions (type 2 at 165), decode at the base layout", () => {
  for (const owner of [SOLANA_TOKEN_PROGRAM, SOLANA_TOKEN_2022_PROGRAM]) assert.deepEqual(solanaDecodeTokenAccount({ owner, data: bytes(165) }), { mint: MINT, owner: OWNER, amount: 123n, state: 1 });
  assert.equal(solanaDecodeTokenAccount({ owner: SOLANA_TOKEN_2022_PROGRAM, data: bytes(182, 2) }).amount, 123n);
});

test("an account longer than 165 bytes that is not typed Account at byte 165 is refused: a Token-2022 mint, or no type", () => {
  assert.throws(() => solanaDecodeTokenAccount({ owner: SOLANA_TOKEN_2022_PROGRAM, data: bytes(166, 1) }), /not a token account: account type 1/);
  assert.throws(() => solanaDecodeTokenAccount({ owner: SOLANA_TOKEN_2022_PROGRAM, data: bytes(200, 0) }), /not a token account: account type 0/);
});
