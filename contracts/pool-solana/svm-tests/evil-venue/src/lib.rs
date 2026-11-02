// SPDX-License-Identifier: Apache-2.0
//! A hostile venue, for the pool's LiteSVM tests only. Its first data byte picks what it tries:
//! - 0: call the program at account 0 (the pool) with the rest of the data and accounts 1 onward: a re-entry, which
//!   the runtime refuses (`ReentrancyNotAllowed`).
//! - 1: move 1 lamport from account 0 to account 1 directly: an account it does not own, which the runtime refuses.
//! - 2: nothing (it succeeds).

use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::invoke,
    program_error::ProgramError,
    pubkey::Pubkey,
};

solana_program::entrypoint!(process_instruction);

pub fn process_instruction(_program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match data.first() {
        Some(0) => {
            let target = accounts.first().ok_or(ProgramError::NotEnoughAccountKeys)?;
            let metas = accounts[1..].iter().map(|a| AccountMeta { pubkey: *a.key, is_signer: a.is_signer, is_writable: a.is_writable }).collect();
            invoke(&Instruction { program_id: *target.key, accounts: metas, data: data[1..].to_vec() }, accounts)
        }
        Some(1) => {
            let [from, to, ..] = accounts else { return Err(ProgramError::NotEnoughAccountKeys) };
            **from.try_borrow_mut_lamports()? -= 1;
            **to.try_borrow_mut_lamports()? += 1;
            Ok(())
        }
        Some(2) => Ok(()),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}
