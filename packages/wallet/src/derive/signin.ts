// The wallet sign-in bytes (docs/plan1/wallet.md:50 at research ffcba5e), frozen except for the signer's address line.
// The signature signs the user in and is no seed source: it derives nothing and unlocks nothing (decision
// walletsignin, "New 12 words", owner-decisions.md:271). The device signs these exact bytes with personal_sign (EVM)
// or signMessage (Solana), never signIn, which lets the wallet build the bytes.
//   EVM: EIP-4361 (ethereum/ERCs master ERCS/erc-4361.md :44-59, sha256 bf30a6e2…eb4c), Version 1, Chain ID 1,
//        a fixed nonce and issued-at.
//   Solana: Sign In With Solana (phantom/sign-in-with-solana main README.md :83-98, sha256 13d47751…dddc), with
//        statement, URI, Version and Nonce, and no Issued At, Expiration Time or Not Before.
// Both: domain = SIGN_HOST and uri = https://SIGN_HOST/, never APP_HOST.
import { base58 } from "@scure/base";
import { SIGN_HOST } from "./constants.ts";
import { toChecksum } from "./keys.ts";

// DRAFT COPY: the statement is words the user reads in the wallet; its final words are not set yet.
export const SIGNIN_STATEMENT = "Sign in to Confidential Trenches.";
export const SIGNIN_URI = `https://${SIGN_HOST}/`;
export const SIGNIN_VERSION = "1";
export const SIGNIN_CHAIN_ID = 1;
export const SIGNIN_NONCE = "blindfillv1signin";
export const SIGNIN_ISSUED_AT = "2026-11-01T06:00:00Z";

// The EIP-4361 message for one EVM address, which must be in EIP-55 form.
export function evmSignIn(address: string): string {
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address) || toChecksum(address) !== address)
    throw new Error("the address must be a 20-byte address in EIP-55 form");
  return (
    `${SIGN_HOST} wants you to sign in with your Ethereum account:\n${address}\n\n${SIGNIN_STATEMENT}\n\n` +
    `URI: ${SIGNIN_URI}\nVersion: ${SIGNIN_VERSION}\nChain ID: ${SIGNIN_CHAIN_ID}\nNonce: ${SIGNIN_NONCE}\n` +
    `Issued At: ${SIGNIN_ISSUED_AT}`
  );
}

// The Sign In With Solana message for one Solana address (base58 of a 32-byte public key).
export function solanaSignIn(address: string): string {
  let ok = false;
  try {
    ok = typeof address === "string" && base58.decode(address).length === 32;
  } catch {}
  if (!ok) throw new Error("the address must be base58 of a 32-byte public key");
  return (
    `${SIGN_HOST} wants you to sign in with your Solana account:\n${address}\n\n${SIGNIN_STATEMENT}\n\n` +
    `URI: ${SIGNIN_URI}\nVersion: ${SIGNIN_VERSION}\nNonce: ${SIGNIN_NONCE}`
  );
}
