// SPDX-License-Identifier: Apache-2.0
//! Every refusal, as `ProgramError::Custom(code)`. The names are the vault's where the vault has the same rule.

use solana_program::program_error::ProgramError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum PoolError {
    /// the instruction's tag or length is not one this program reads
    InvalidInstructionData = 1,
    /// a value that must be a field element is not below p
    FieldOverflow = 2,
    /// a proof coordinate is not below q
    InvalidProofEncoding = 3,
    /// the cluster's clock is past the release's deadline
    DeadlineExpired = 4,
    /// W or the fee payer is the pool itself
    InvalidRecipient = 5,
    /// W did not sign the transaction
    RecipientNotSigner = 6,
    /// the fee payer did not sign the transaction
    FeePayerNotSigner = 7,
    /// a tree depth is over 32
    InvalidTreeDepth = 8,
    /// no state root at that index: the index is past the tree, or the page is not that index's
    UnknownStateRoot = 9,
    /// no label root at that index
    UnknownLabelRoot = 10,
    /// withdrawnValue is 0
    InvalidWithdrawalAmount = 11,
    /// relay_fee is over the cap the proof binds
    RelayFeeOverCap = 12,
    /// relay_fee is over the backstop, MAX_RELAY_FEE_BPS of withdrawnValue
    RelayFeeGreaterThanMax = 13,
    /// withdrawnValue is over what the pool's notes hold
    InvalidPoolState = 14,
    /// the proof does not verify for these signals
    InvalidProof = 15,
    /// the note's nullifier hash has a spent mark
    NullifierAlreadySpent = 16,
    /// a tree leaf is 0
    LeafCannotBeZero = 17,
    /// the insert would make a tree deeper than 32
    MaxTreeDepthReached = 18,
    /// the deposit is under MIN_DEPOSIT
    MinimumDepositAmount = 19,
    /// the precommitment is 0
    InvalidPrecommitment = 20,
    /// the precommitment has been used by a deposit
    PrecommitmentAlreadyUsed = 21,
    /// an account is not the one this instruction takes at that place
    WrongAccount = 22,
    /// the pool account exists already
    AlreadyInitialized = 23,
    /// the pool account is not this program's pool
    NotInitialized = 24,
    /// sol_poseidon failed
    Poseidon = 25,
    /// a lamport sum would overflow
    Overflow = 26,
}

impl From<PoolError> for ProgramError {
    fn from(e: PoolError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
