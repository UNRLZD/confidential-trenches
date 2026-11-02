// SPDX-License-Identifier: Apache-2.0
//! The Blindfill pool on Solana: SOL held as private notes, released only to the fresh wallet W a proof names, in a
//! transaction W signs. A port of the Blindfill NEAR vault (`contracts/vault`), itself a port of Privacy Pools v1.3.0
//! core (0xbow, Apache-2.0, audited by Oxorio and Auditware). The same withdraw circuit and ceremony key.
//!
//! No admin account, no owner, no setter, no pause: no instruction takes a privileged signer, and every constant is
//! compiled in. Deployed with no upgrade authority (the deploy and its live check are a later step).
//!
//! Native `solana-program`, no framework: the instruction is a 1-byte tag and fixed fields, with no 8-byte Anchor
//! discriminator or IDL layer in a 1,232-byte transaction that also carries a venue buy, and auditors read the checks
//! with no macro between them and the bytes.
//!
//! Instructions (tag, then fields, integers little-endian, field elements 32 bytes big-endian):
//! - `0 init`: creates the pool account. Anyone, once; it takes nothing that could differ between callers.
//! - `1 deposit(value u64, precommitment)`: src/deposit.rs. Its precommitment mark `["pre", precommitment]` holds
//!   16 bytes, `value u64 LE ‖ nonce u64 LE` (the nonce its label hashes), so a restore from the 12 words finds
//!   every deposit in one read of the pool's accounts (M353).
//! - `2 release(...)`: src/release.rs.
//! - `3 release_and_buy(...)`: src/buy.rs; its byte layout is TAG3.md.
//!
//! Deviations from the NEAR vault, each for a named reason:
//! - The release pays W and the fee payer in the same transaction, so there is no payout promise, no refund note and
//!   no `refund_precommitment`: a transfer that fails fails the whole transaction, the spent mark with it.
//! - W must sign the transaction. Its signature covers every account and byte, so no relayer can redirect a release
//!   (in place of an ed25519 instruction read by introspection).
//! - The release names its two roots by index into the pages, and the program reads the roots from them: a root the
//!   pool never had cannot be named at all.
//! - Storage is Solana accounts and rent: each insert pays its page entry, each spend its spent mark, each deposit
//!   its precommitment mark, all by the transaction's payer (src/state.rs).
//! - The relay fee is an amount at most the cap the proof binds, under the vault's backstop.
//! - No `LeafAlreadyExists` map (src/tree.rs gives the reason).
//! - Each page entry also holds the Clock's unix_timestamp at its insert, so any client can tell from the pages alone
//!   which root was the newest at a given chain time, and devices prove against a shared root (src/state.rs).
//! - Tag 3 releases and buys in one instruction: the release, then the instructions W signed for, run with `invoke`
//!   and W's signer privilege only (src/buy.rs); the vault has no such call. One transaction must hold the proof and
//!   the venue's accounts in 1,232 bytes, which a v0 message reaches only when the venue's program loads from a
//!   lookup table, and so only when the pool invokes it.
//! - No ragequit. The pool puts every deposit's label into its own label tree, so a release proof always exists for
//!   every note; ragequit would add a public exit that links a deposit to its exit, and a depositor record per label,
//!   and buy nothing a release does not.
//!
//! Deploy rule: a fresh program keypair per cluster. The scope binds the program id and the pool address (itself
//! derived from the program id) but no cluster, so one id on devnet and mainnet would give the same scopes, and a
//! devnet spend would publish the nullifier hash of the same note on mainnet. The deploy's live check asserts the
//! mainnet id differs from the devnet id.
//!
//! Smallest release: W (a fresh system account) must end at least the rent-exempt minimum of 0 bytes, so
//! `withdrawnValue - relay_fee >= rent(0)`, and the backstop needs `withdrawnValue >= 2 * relay_fee`. With the relay
//! fee at the fee payer's floor (src/release.rs, row 8), the smallest chunk is `max(rent(0) + floor, 2 * floor)`. At
//! mainnet rent that is max(650,240 + 1,026,000, 2,052,000) = 2,052,000 lamports, or 3,515,040 when the change opens
//! a page (floor 1,757,520). The device's Solana adapter holds its smallest rung to that; below it the runtime refuses
//! a W left under rent(0), and the program refuses a fee over the backstop.

// solana-poseidon 3.1.6 marks its API deprecated ahead of 4.0.0's `agave-unstable-api` feature; 3.1.6 is the version
// pinned here.
#![allow(deprecated)]

pub mod buy;
pub mod context;
pub mod deposit;
pub mod error;
pub mod field;
pub mod release;
pub mod state;
pub mod tree;
pub mod verifier;
pub mod vk;

use error::PoolError;
use solana_program::{account_info::AccountInfo, entrypoint::ProgramResult, pubkey::Pubkey};

/// The least a deposit may be: 0.001 SOL (PP's `minimumDepositAmount` as a constant, the vault's 1 USDC in kind).
pub const MIN_DEPOSIT: u64 = 1_000_000;
/// The backstop `relay_fee * 10,000 <= withdrawnValue * MAX_RELAY_FEE_BPS` (the vault's); the proof's cap is the real
/// bound.
pub const MAX_RELAY_FEE_BPS: u64 = 5_000;

pub const TAG_INIT: u8 = 0;
pub const TAG_DEPOSIT: u8 = 1;
pub const TAG_RELEASE: u8 = 2;
pub const TAG_RELEASE_AND_BUY: u8 = 3;

#[cfg(feature = "entrypoint")]
solana_program::entrypoint!(process_instruction);

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match data.first() {
        Some(&TAG_INIT) if data.len() == 1 => deposit::init(program_id, accounts),
        Some(&TAG_DEPOSIT) => deposit::deposit(program_id, accounts, data),
        Some(&TAG_RELEASE) => release::release(program_id, accounts, data),
        Some(&TAG_RELEASE_AND_BUY) => buy::release_and_buy(program_id, accounts, data),
        _ => Err(PoolError::InvalidInstructionData.into()),
    }
}
