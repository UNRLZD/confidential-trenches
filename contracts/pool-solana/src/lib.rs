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
//! - `1 deposit(value u64, precommitment)`: src/deposit.rs.
//! - `2 release(...)`: src/release.rs.
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
//! - No ragequit yet: the vault's ragequit needs the commitment circuit's key and a depositor per label (a later card).

// solana-poseidon 3.1.6 marks its API deprecated ahead of 4.0.0's `agave-unstable-api` feature; 3.1.6 is the version
// pinned here.
#![allow(deprecated)]

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

#[cfg(feature = "entrypoint")]
solana_program::entrypoint!(process_instruction);

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match data.first() {
        Some(&TAG_INIT) if data.len() == 1 => deposit::init(program_id, accounts),
        Some(&TAG_DEPOSIT) => deposit::deposit(program_id, accounts, data),
        Some(&TAG_RELEASE) => release::release(program_id, accounts, data),
        _ => Err(PoolError::InvalidInstructionData.into()),
    }
}
