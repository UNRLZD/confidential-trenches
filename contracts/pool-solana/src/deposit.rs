// SPDX-License-Identifier: Apache-2.0
//! `init` and `deposit`.
//!
//! `init` (tag 0): accounts `[pool (w), payer (w, signer), system program]`. Creates the pool account at `["pool"]`
//! with its rent from the payer; refused once it exists (`AlreadyInitialized`).
//!
//! `deposit` (tag 1), data `value u64 LE ‖ precommitment (32, big-endian)`: accounts `[pool (w), depositor (w,
//! signer), state page (w), label page (w), precommitment mark (w), system program]`. Ported from the vault's deposit
//! (`contracts/vault/src/deposit.rs`, rows 3-10), itself from Privacy Pools v1.3.0 `Entrypoint.sol:324-329` and
//! `PrivacyPool.sol:90-106`, Copyright 2025 0XBOW LTD, Apache-2.0:
//! - `value >= MIN_DEPOSIT` (`MinimumDepositAmount`); a u64 is below 2^128 (PP's `InvalidDepositValue`).
//! - the precommitment below p (`FieldOverflow`) and not 0 (`InvalidPrecommitment`), and unused: its mark
//!   `["pre", precommitment]` must not exist (`PrecommitmentAlreadyUsed`), then it is made. Two notes with one
//!   precommitment would share one nullifier, so spending one would end the other.
//! - the mark records the deposit in its 17 bytes (`PRE_MARK_LEN`): `value u64 LE ‖ nonce u64 LE ‖ MARK_TAG`, the
//!   nonce the one its label hashes (M353), the tag so that no zero-filled account a stranger makes is read as a mark
//!   (src/state.rs). From the marks alone, one read of every account of this program, a device that knows
//!   its precommitments rebuilds each of its notes (`label = keccak256(scope ‖ nonce) mod p`, `commitment =
//!   Poseidon(value, label, precommitment)`) with no read that names a note. Both values are public in the deposit
//!   transaction already.
//! - `nonce += 1`, `label = keccak256(scope ‖ nonce) mod p`, `commitment = Poseidon(value, label, precommitment)`.
//! - the commitment into the state tree, the label into the label tree (the pool approves every deposit; no ASP),
//!   each with its page entry.
//! - `value` lamports from the depositor to the pool (the system program's transfer), `deposited += value`.
//!
//! The depositor pays every rent the deposit makes: the precommitment mark (17 bytes) and the two page entries.

use crate::context::{label_of, scope_of};
use crate::error::PoolError;
use crate::field;
use crate::state::{self, Pool, TreeState, MARK_TAG, POOL_LEN, POOL_SEED, PRE_MARK_LEN, PRE_SEED, TREE_LABEL, TREE_STATE};
use crate::tree::{self, poseidon3};
use crate::MIN_DEPOSIT;
use solana_program::{account_info::AccountInfo, entrypoint::ProgramResult, program_error::ProgramError, pubkey::Pubkey};

pub fn init(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let [pool, payer, system] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    state::check_system(system)?;
    let (addr, bump) = Pubkey::find_program_address(&[POOL_SEED], program_id);
    if addr != *pool.key {
        return Err(PoolError::WrongAccount.into());
    }
    state::create_pda(program_id, payer, pool, system, &[POOL_SEED, &[bump]], POOL_LEN, PoolError::AlreadyInitialized)?;
    // on the heap: SBF gives each function a 4 KiB stack frame, and the pool is over 2 KiB
    let fresh = Box::new(Pool { bump, nonce: 0, deposited: 0, spent: 0, state: TreeState::empty(), label: TreeState::empty() });
    fresh.store(pool)
}

/// Inserts `leaf` into `t` and writes its page entry.
pub(crate) fn push<'a>(
    program_id: &Pubkey,
    payer: &AccountInfo<'a>,
    page: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    which: u8,
    t: &mut TreeState,
    leaf: &[u8; 32],
) -> Result<(), ProgramError> {
    let index = t.size;
    let root = tree::insert(&mut t.size, &mut t.depth, &mut t.side, leaf)?;
    state::push_entry(program_id, payer, page, system, which, index, leaf, &root)
}

pub fn deposit(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let [pool_acc, depositor, state_page, label_page, pre_mark, system] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if data.len() != 41 {
        return Err(PoolError::InvalidInstructionData.into());
    }
    state::check_system(system)?;
    let mut pool = Pool::load(program_id, pool_acc)?;
    let value = u64::from_le_bytes(data[1..9].try_into().unwrap());
    let precommitment: [u8; 32] = data[9..41].try_into().unwrap();
    if value < MIN_DEPOSIT {
        return Err(PoolError::MinimumDepositAmount.into());
    }
    if !field::is_field(&precommitment) {
        return Err(PoolError::FieldOverflow.into());
    }
    if precommitment == [0; 32] {
        return Err(PoolError::InvalidPrecommitment.into());
    }
    state::put_mark_of(program_id, depositor, pre_mark, system, PRE_SEED, &precommitment, PRE_MARK_LEN, PoolError::PrecommitmentAlreadyUsed)?;
    pool.nonce = pool.nonce.checked_add(1).ok_or(PoolError::Overflow)?;
    {
        // the record a restore reads: value, then the nonce this deposit's label hashes, then the tag
        let mut d = pre_mark.try_borrow_mut_data()?;
        d[0..8].copy_from_slice(&value.to_le_bytes());
        d[8..16].copy_from_slice(&pool.nonce.to_le_bytes());
        d[16] = MARK_TAG;
    }
    let label = label_of(&scope_of(&program_id.to_bytes(), &pool_acc.key.to_bytes()), pool.nonce);
    let commitment = poseidon3(&field::of_u64(value), &label, &precommitment)?;
    push(program_id, depositor, state_page, system, TREE_STATE, &mut pool.state, &commitment)?;
    push(program_id, depositor, label_page, system, TREE_LABEL, &mut pool.label, &label)?;
    state::transfer(depositor, pool_acc, system, value)?;
    pool.deposited = pool.deposited.checked_add(value as u128).ok_or(PoolError::Overflow)?;
    pool.store(pool_acc)
}
