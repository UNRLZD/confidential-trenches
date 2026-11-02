// SPDX-License-Identifier: Apache-2.0
//! `scope`, `label` and `context`: the bytes each one hashes, then keccak256 read big-endian, mod p.
//!
//! Ported from the Blindfill vault (`contracts/vault/src/context.rs`), itself from Privacy Pools v1.3.0
//! `packages/contracts/src/contracts/State.sol:89` (SCOPE), `PrivacyPool.sol:93` (`label = keccak256(abi.encodePacked(
//! SCOPE, ++nonce))`) and `PrivacyPool.sol:48` (context), Copyright 2025 0XBOW LTD, Apache-2.0. `label` is the vault's
//! byte for byte. `scope` and `context` hash Solana's 32-byte addresses where the vault hashes NEAR account ids, in the
//! vault's Borsh layout (a string is a 4-byte little-endian length then its bytes; integers little-endian; fixed
//! arrays raw). keccak256 mod p stays, so the circuit and its keys are unchanged.

use crate::field;
use solana_program::keccak;

/// The tag every scope hashes.
pub const SCOPE_TAG: &str = "blindfill-pool-solana-v1";
/// The asset this pool holds: native SOL, named by the wrapped-SOL mint's address
/// (So11111111111111111111111111111111111111112).
pub const NATIVE_MINT: [u8; 32] = solana_program::pubkey!("So11111111111111111111111111111111111111112").to_bytes();

/// keccak256 of the parts, its 32 bytes read big-endian, then mod p.
pub fn field_of(parts: &[&[u8]]) -> [u8; 32] {
    field::to_be(&field::reduce(field::from_be(&keccak::hashv(parts).to_bytes())))
}

/// `borsh((SCOPE_TAG, program, pool, mint))`: the tag as a Borsh string, then three raw 32-byte addresses.
pub fn scope_preimage(program: &[u8; 32], pool: &[u8; 32]) -> Vec<u8> {
    let mut b = Vec::with_capacity(4 + SCOPE_TAG.len() + 96);
    b.extend_from_slice(&(SCOPE_TAG.len() as u32).to_le_bytes());
    b.extend_from_slice(SCOPE_TAG.as_bytes());
    b.extend_from_slice(program);
    b.extend_from_slice(pool);
    b.extend_from_slice(&NATIVE_MINT);
    b
}

/// `scope = keccak256(scope_preimage) mod p`: one scope per program and pool, so a note of one pool is never
/// spendable at another (every label hashes it, every commitment holds a label).
pub fn scope_of(program: &[u8; 32], pool: &[u8; 32]) -> [u8; 32] {
    field_of(&[&scope_preimage(program, pool)])
}

/// `label = keccak256(scope_be32 ‖ nonce_be32) mod p`, the vault's (and PP's `abi.encodePacked(SCOPE, nonce)`).
pub fn label_of(scope: &[u8; 32], nonce: u64) -> [u8; 32] {
    let mut n = [0u8; 32];
    n[24..].copy_from_slice(&nonce.to_be_bytes());
    field_of(&[scope, &n])
}

/// What a release's proof binds, beside its public signals (withdrawnValue is one). The order is frozen: the device
/// hashes the same bytes when it makes the proof.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContextFields {
    /// this program's id (PP's `processooor`)
    pub program: [u8; 32],
    /// the pool state account
    pub pool: [u8; 32],
    /// W: the only account paid `withdrawnValue - relay_fee`, and a required signer of the transaction
    pub recipient: [u8; 32],
    /// the only account paid `relay_fee`, and a required signer
    pub fee_payer: [u8; 32],
    /// the most `relay_fee` may be, in lamports
    pub relay_fee_cap: u64,
    /// the most a landing tip may be, in lamports (the venue step's; carried here so a proof made now binds it)
    pub tip_cap: u64,
    /// the last ms the release may land in, against the cluster Clock's `unix_timestamp * 1000` (the vault's
    /// `deadline_ms` in the pool's own chain time)
    pub deadline_ms: u64,
    /// so two otherwise equal releases have two contexts
    pub salt: [u8; 16],
}

/// Borsh of the fields in declaration order: 4 x 32 bytes, 3 x u64 little-endian, 16 raw bytes. 168 bytes.
pub fn context_fields_bytes(c: &ContextFields) -> [u8; 168] {
    let mut b = [0u8; 168];
    b[0..32].copy_from_slice(&c.program);
    b[32..64].copy_from_slice(&c.pool);
    b[64..96].copy_from_slice(&c.recipient);
    b[96..128].copy_from_slice(&c.fee_payer);
    b[128..136].copy_from_slice(&c.relay_fee_cap.to_le_bytes());
    b[136..144].copy_from_slice(&c.tip_cap.to_le_bytes());
    b[144..152].copy_from_slice(&c.deadline_ms.to_le_bytes());
    b[152..168].copy_from_slice(&c.salt);
    b
}

/// `context = keccak256(borsh(fields) ‖ scope_be32) mod p` (the vault's rule; PP `PrivacyPool.sol:48`).
pub fn context_of(c: &ContextFields, scope: &[u8; 32]) -> [u8; 32] {
    field_of(&[&context_fields_bytes(c), scope])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dec(s: &str) -> [u8; 32] {
        // decimal string to 32 big-endian bytes (tests only)
        let mut n = [0u8; 32];
        for c in s.bytes() {
            let mut carry = (c - b'0') as u32;
            for byte in n.iter_mut().rev() {
                let v = (*byte as u32) * 10 + carry;
                *byte = v as u8;
                carry = v >> 8;
            }
            assert_eq!(carry, 0);
        }
        n
    }

    /// VT-U02's label vectors (packages/kit/test/vectors/vault-v1.json), which the vault checks too: the label rule is
    /// the vault's byte for byte.
    #[test]
    fn every_vault_label_vector_matches() {
        let v: serde_json::Value =
            serde_json::from_str(include_str!("../../../packages/kit/test/vectors/vault-v1.json")).unwrap();
        let rows = v["label"].as_array().unwrap();
        assert_eq!(rows.len(), 10);
        for t in rows {
            let scope = dec(t["scope"].as_str().unwrap());
            let nonce: u64 = t["nonce"].as_str().unwrap().parse().unwrap();
            assert_eq!(label_of(&scope, nonce), dec(t["label"].as_str().unwrap()), "nonce {nonce}");
        }
    }

    #[test]
    fn each_context_field_changes_the_context() {
        let base = ContextFields {
            program: [1; 32],
            pool: [2; 32],
            recipient: [3; 32],
            fee_payer: [4; 32],
            relay_fee_cap: 5,
            tip_cap: 6,
            deadline_ms: 7,
            salt: [8; 16],
        };
        let scope = scope_of(&[1; 32], &[2; 32]);
        let c0 = context_of(&base, &scope);
        assert!(field::is_field(&c0));
        let variants = [
            ContextFields { program: [9; 32], ..base.clone() },
            ContextFields { pool: [9; 32], ..base.clone() },
            ContextFields { recipient: [9; 32], ..base.clone() },
            ContextFields { fee_payer: [9; 32], ..base.clone() },
            ContextFields { relay_fee_cap: 9, ..base.clone() },
            ContextFields { tip_cap: 9, ..base.clone() },
            ContextFields { deadline_ms: 9, ..base.clone() },
            ContextFields { salt: [9; 16], ..base.clone() },
        ];
        for (i, v) in variants.iter().enumerate() {
            assert_ne!(context_of(v, &scope), c0, "field {i}");
        }
        assert_ne!(context_of(&base, &scope_of(&[1; 32], &[9; 32])), c0, "scope");
        assert_eq!(scope_preimage(&[1; 32], &[2; 32]).len(), 4 + SCOPE_TAG.len() + 96);
    }
}
