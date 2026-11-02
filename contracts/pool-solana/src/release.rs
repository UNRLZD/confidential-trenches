// SPDX-License-Identifier: Apache-2.0
//! `release` (tag 2): a note's chunk to W, the fee to the fee payer, the change note into the state tree.
//!
//! Accounts: `[pool (w), W (w, signer), fee payer (w, signer), spent mark (w), state root page, label root page, state
//! page (w), system program]`. The two root pages hold the roots the proof was made against; the state page is the
//! one the change note's entry goes into (often the same account as the state root page).
//!
//! Data (`RELEASE_LEN` bytes): `proof (256) ‖ newCommitmentHash (32) ‖ existingNullifierHash (32) ‖ withdrawnValue
//! u64 ‖ stateRootIndex u32 ‖ stateTreeDepth u8 ‖ labelRootIndex u32 ‖ labelTreeDepth u8 ‖ relay_fee u64 ‖
//! relay_fee_cap u64 ‖ tip_cap u64 ‖ deadline_ms u64 ‖ salt (16)`.
//!
//! Ported from the vault's `withdraw` rows 1-13 (`contracts/vault/src/withdraw.rs:1-45`), itself from Privacy Pools
//! v1.3.0 `PrivacyPool.sol:44-59`, `:115-128`, `State.sol:123-129` and `Entrypoint.sol:133-157`, Copyright 2025 0XBOW
//! LTD, Apache-2.0. Every refusal comes before the first write; Solana undoes a failed transaction's writes anyway.
//! - Row 1: the length (`InvalidInstructionData`); newCommitmentHash and existingNullifierHash below p
//!   (`FieldOverflow`); the proof's coordinates below q (`InvalidProofEncoding`, in the verifier).
//! - Row 2: the cluster Clock's `unix_timestamp * 1000` at most `deadline_ms` (`DeadlineExpired`); W and the fee payer are not the pool
//!   (`InvalidRecipient`); W signed (`RecipientNotSigner`) and the fee payer signed (`FeePayerNotSigner`).
//! - Row 3: `context` is not taken from the instruction: it is computed here from this program's id, the pool account,
//!   W's and the fee payer's addresses, the cap, the tip cap, deadline_ms and the salt (src/context.rs). A proof made
//!   for any other value of any of them fails row 10.
//! - Row 4: both depths at most 32 (`InvalidTreeDepth`).
//! - Rows 5 and 6: the state root and the label root are read from their pages at the indices given: any root the tree
//!   has had, kept for good (`UnknownStateRoot`, `UnknownLabelRoot` for an index past the tree or a page not its).
//! - Row 7: withdrawnValue not 0 (`InvalidWithdrawalAmount`). Row 8: relay_fee at most the cap (`RelayFeeOverCap`),
//!   then the backstop (`RelayFeeGreaterThanMax`). Row 9: withdrawnValue at most `deposited - spent`
//!   (`InvalidPoolState`).
//! - Row 10: Groth16 verify of the 8 signals (`InvalidProof`).
//! - Row 11: the spent mark `["spent", existingNullifierHash]` must not exist (`NullifierAlreadySpent`); it is made, its
//!   rent from the fee payer.
//! - Row 12: newCommitmentHash into the state tree, even when the change is 0, its page entry's rent from the fee payer.
//! - Row 13: the pool pays `withdrawnValue - relay_fee` to W and `relay_fee` to the fee payer; `spent += withdrawnValue`.
//!
//! Rent: the fee payer pays the spent mark (an empty account's minimum) and the change note's page entry (64 bytes),
//! and the transaction fee. The relay fee the device signs for covers them; the cap in the proof bounds it.

use crate::context::{context_of, scope_of, ContextFields};
use crate::deposit::push;
use crate::error::PoolError;
use crate::field;
use crate::state::{self, Pool, SPENT_SEED, TREE_LABEL, TREE_STATE};
use crate::tree::MAX_TREE_DEPTH;
use crate::verifier::{verify_withdraw, PROOF_LEN};
use crate::MAX_RELAY_FEE_BPS;
use solana_program::{
    account_info::AccountInfo, clock::Clock, entrypoint::ProgramResult, program_error::ProgramError, pubkey::Pubkey,
    sysvar::Sysvar,
};

pub const RELEASE_LEN: usize = 1 + PROOF_LEN + 32 + 32 + 8 + 4 + 1 + 4 + 1 + 8 + 8 + 8 + 8 + 16;

/// A release's instruction data, read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Release {
    pub proof: [u8; PROOF_LEN],
    pub new_commitment: [u8; 32],
    pub nullifier_hash: [u8; 32],
    pub withdrawn: u64,
    pub state_root_index: u32,
    pub state_depth: u8,
    pub label_root_index: u32,
    pub label_depth: u8,
    pub relay_fee: u64,
    pub relay_fee_cap: u64,
    pub tip_cap: u64,
    pub deadline_ms: u64,
    pub salt: [u8; 16],
}

impl Release {
    /// On the heap, as the pool (SBF's 4 KiB stack frame).
    pub fn parse(data: &[u8]) -> Result<Box<Release>, PoolError> {
        if data.len() != RELEASE_LEN {
            return Err(PoolError::InvalidInstructionData);
        }
        let mut at = 1;
        let mut take = |n: usize| {
            let s = &data[at..at + n];
            at += n;
            s
        };
        let proof: [u8; PROOF_LEN] = take(PROOF_LEN).try_into().unwrap();
        let new_commitment: [u8; 32] = take(32).try_into().unwrap();
        let nullifier_hash: [u8; 32] = take(32).try_into().unwrap();
        let withdrawn = u64::from_le_bytes(take(8).try_into().unwrap());
        let state_root_index = u32::from_le_bytes(take(4).try_into().unwrap());
        let state_depth = take(1)[0];
        let label_root_index = u32::from_le_bytes(take(4).try_into().unwrap());
        let label_depth = take(1)[0];
        let relay_fee = u64::from_le_bytes(take(8).try_into().unwrap());
        let relay_fee_cap = u64::from_le_bytes(take(8).try_into().unwrap());
        let tip_cap = u64::from_le_bytes(take(8).try_into().unwrap());
        let deadline_ms = u64::from_le_bytes(take(8).try_into().unwrap());
        let salt: [u8; 16] = take(16).try_into().unwrap();
        Ok(Box::new(Release {
            proof,
            new_commitment,
            nullifier_hash,
            withdrawn,
            state_root_index,
            state_depth,
            label_root_index,
            label_depth,
            relay_fee,
            relay_fee_cap,
            tip_cap,
            deadline_ms,
            salt,
        }))
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut b = Vec::with_capacity(RELEASE_LEN);
        b.push(crate::TAG_RELEASE);
        b.extend_from_slice(&self.proof);
        b.extend_from_slice(&self.new_commitment);
        b.extend_from_slice(&self.nullifier_hash);
        b.extend_from_slice(&self.withdrawn.to_le_bytes());
        b.extend_from_slice(&self.state_root_index.to_le_bytes());
        b.push(self.state_depth);
        b.extend_from_slice(&self.label_root_index.to_le_bytes());
        b.push(self.label_depth);
        b.extend_from_slice(&self.relay_fee.to_le_bytes());
        b.extend_from_slice(&self.relay_fee_cap.to_le_bytes());
        b.extend_from_slice(&self.tip_cap.to_le_bytes());
        b.extend_from_slice(&self.deadline_ms.to_le_bytes());
        b.extend_from_slice(&self.salt);
        b
    }
}

/// Row 8's backstop, exact in u128: `relay_fee * 10,000 <= withdrawn * MAX_RELAY_FEE_BPS`.
pub fn fee_within_backstop(relay_fee: u64, withdrawn: u64) -> bool {
    (relay_fee as u128) * 10_000 <= (withdrawn as u128) * MAX_RELAY_FEE_BPS as u128
}

pub fn release(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let [pool_acc, recipient, fee_payer, spent_mark, state_root_page, label_root_page, state_page, system] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    // row 1
    let r = Release::parse(data)?;
    if !field::is_field(&r.new_commitment) || !field::is_field(&r.nullifier_hash) {
        return Err(PoolError::FieldOverflow.into());
    }
    state::check_system(system)?;
    let mut pool = Pool::load(program_id, pool_acc)?;
    // row 2
    let now_s = Clock::get()?.unix_timestamp;
    let now_ms = u64::try_from(now_s).ok().and_then(|s| s.checked_mul(1000)).ok_or(PoolError::DeadlineExpired)?;
    if now_ms > r.deadline_ms {
        return Err(PoolError::DeadlineExpired.into());
    }
    if recipient.key == pool_acc.key || fee_payer.key == pool_acc.key {
        return Err(PoolError::InvalidRecipient.into());
    }
    if !recipient.is_signer {
        return Err(PoolError::RecipientNotSigner.into());
    }
    if !fee_payer.is_signer {
        return Err(PoolError::FeePayerNotSigner.into());
    }
    // row 3
    let context = context_of(
        &ContextFields {
            program: program_id.to_bytes(),
            pool: pool_acc.key.to_bytes(),
            recipient: recipient.key.to_bytes(),
            fee_payer: fee_payer.key.to_bytes(),
            relay_fee_cap: r.relay_fee_cap,
            tip_cap: r.tip_cap,
            deadline_ms: r.deadline_ms,
            salt: r.salt,
        },
        &scope_of(&program_id.to_bytes(), &pool_acc.key.to_bytes()),
    );
    // row 4
    if r.state_depth > MAX_TREE_DEPTH || r.label_depth > MAX_TREE_DEPTH {
        return Err(PoolError::InvalidTreeDepth.into());
    }
    // rows 5 and 6
    let state_root = state::root_at(program_id, state_root_page, TREE_STATE, pool.state.size, r.state_root_index as u64)
        .ok_or(PoolError::UnknownStateRoot)?;
    let label_root = state::root_at(program_id, label_root_page, TREE_LABEL, pool.label.size, r.label_root_index as u64)
        .ok_or(PoolError::UnknownLabelRoot)?;
    // row 7
    if r.withdrawn == 0 {
        return Err(PoolError::InvalidWithdrawalAmount.into());
    }
    // row 8
    if r.relay_fee > r.relay_fee_cap {
        return Err(PoolError::RelayFeeOverCap.into());
    }
    if !fee_within_backstop(r.relay_fee, r.withdrawn) {
        return Err(PoolError::RelayFeeGreaterThanMax.into());
    }
    // row 9
    let held = pool.deposited.checked_sub(pool.spent).ok_or(PoolError::InvalidPoolState)?;
    if r.withdrawn as u128 > held {
        return Err(PoolError::InvalidPoolState.into());
    }
    // row 10, the signals in snarkjs order
    let signals = [
        r.new_commitment,
        r.nullifier_hash,
        field::of_u64(r.withdrawn),
        state_root,
        field::of_u64(r.state_depth as u64),
        label_root,
        field::of_u64(r.label_depth as u64),
        context,
    ];
    verify_withdraw(&r.proof, &signals)?;
    // row 11
    state::put_mark(program_id, fee_payer, spent_mark, system, SPENT_SEED, &r.nullifier_hash, PoolError::NullifierAlreadySpent)?;
    // row 12
    push(program_id, fee_payer, state_page, system, TREE_STATE, &mut pool.state, &r.new_commitment)?;
    // row 13: the pool owns its account, so it moves lamports out directly; row 9 keeps its rent untouched
    pool.spent = pool.spent.checked_add(r.withdrawn as u128).ok_or(PoolError::Overflow)?;
    pool.store(pool_acc)?;
    let to_recipient = r.withdrawn - r.relay_fee; // the backstop keeps relay_fee at most half of withdrawn
    **pool_acc.try_borrow_mut_lamports()? = pool_acc.lamports().checked_sub(r.withdrawn).ok_or(PoolError::InvalidPoolState)?;
    **recipient.try_borrow_mut_lamports()? = recipient.lamports().checked_add(to_recipient).ok_or(PoolError::Overflow)?;
    **fee_payer.try_borrow_mut_lamports()? = fee_payer.lamports().checked_add(r.relay_fee).ok_or(PoolError::Overflow)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }
    fn h32(v: &serde_json::Value) -> [u8; 32] {
        unhex(v.as_str().unwrap()).try_into().unwrap()
    }
    fn dec(s: &str) -> [u8; 32] {
        let mut n = [0u8; 32];
        for c in s.bytes() {
            let mut carry = (c - b'0') as u32;
            for byte in n.iter_mut().rev() {
                let v = (*byte as u32) * 10 + carry;
                *byte = v as u8;
                carry = v >> 8;
            }
        }
        n
    }

    /// The pool fixture's proofs (fixtures/release-spends.json): the context this program computes from the request
    /// is each proof's 8th signal, and each proof verifies on the signals the release assembles.
    #[test]
    fn the_fixtures_contexts_are_the_programs_and_its_proofs_verify() {
        let f: serde_json::Value = serde_json::from_str(include_str!("../fixtures/release-spends.json")).unwrap();
        let num = |k: &str| f[k].as_str().unwrap().parse::<u64>().unwrap();
        for s in f["spends"].as_array().unwrap().iter().filter(|s| s["name"] != "other_pool") {
            let name = s["name"].as_str().unwrap();
            let c = ContextFields {
                program: h32(&f["program"]),
                pool: h32(&f["pool"]),
                recipient: h32(&f["w"]),
                fee_payer: h32(&f["fee_payer"]),
                relay_fee_cap: num("relay_fee_cap"),
                tip_cap: num("tip_cap"),
                deadline_ms: num("deadline_ms"),
                salt: unhex(s["salt"].as_str().unwrap()).try_into().unwrap(),
            };
            assert_eq!(scope_of(&c.program, &c.pool), h32(&f["scope"]), "scope");
            let ps: Vec<[u8; 32]> = s["public_signals"].as_array().unwrap().iter().map(|x| dec(x.as_str().unwrap())).collect();
            assert_eq!(context_of(&c, &h32(&f["scope"])), ps[7], "{name}: context");
            let signals: [[u8; 32]; 8] = ps.try_into().unwrap();
            let proof: [u8; PROOF_LEN] = unhex(s["proof"].as_str().unwrap()).try_into().unwrap();
            assert_eq!(verify_withdraw(&proof, &signals), Ok(()), "{name}: the proof");
            assert_eq!(signals[2], field::of_u64(s["withdrawn"].as_str().unwrap().parse().unwrap()));
            assert_eq!(signals[4], field::of_u64(s["state_depth"].as_u64().unwrap()));
        }
    }
}
