// SPDX-License-Identifier: Apache-2.0
//! The pool's two LeanIMTs, hashed with circomlib's Poseidon(2) through `sol_poseidon`: the state tree holds every
//! note's commitment, the label tree every deposit's label (the pool approves every deposit itself, so its label tree
//! is the association set). Each tree's size, depth and side nodes live in the pool account; every (leaf, root) pair
//! it has ever had lives in its pages (src/state.rs), kept for good with no eviction, so a proof made against an older
//! root still lands and no run of deposits can push it out (the vault's rule, `contracts/vault/src/tree.rs:4-7`,
//! Auditware AW-M-02 against PP's 64-slot ring).
//!
//! Ported from the Blindfill vault's `contracts/vault/src/tree.rs` `insert`, itself from zk-kit's LeanIMT,
//! `@zk-kit/lean-imt.sol` 2.0.0 `InternalLeanIMT.sol` `_insert` l.40-83, Copyright (c) 2024 Ethereum Foundation, MIT
//! License (its text is in NOTICE), with Privacy Pools v1.3.0's depth bound (`State.sol:140`), Copyright 2025 0XBOW
//! LTD, Apache-2.0. Changes from the vault: a refusal is an error, not a panic (Solana undoes every write of a failed
//! transaction, so the outcome is the same); LIMT's `LeafAlreadyExists` map is not kept (a commitment hashes its
//! deposit's label, unique per deposit, so no one can make another user's commitment again; the vault's own reason it
//! keeps only the state tree's map is the same label rule).

use crate::error::PoolError;
use crate::field;
use solana_poseidon::{hashv, Endianness, Parameters};

pub const MAX_TREE_DEPTH: u8 = 32;
/// Side nodes at levels 0..=32.
pub type Side = [[u8; 32]; MAX_TREE_DEPTH as usize + 1];

/// circomlib's Poseidon(a, b) (t = 3): the syscall on Solana, light-poseidon's `new_circom` on the host.
pub fn poseidon2(a: &[u8; 32], b: &[u8; 32]) -> Result<[u8; 32], PoolError> {
    hashv(Parameters::Bn254X5, Endianness::BigEndian, &[a, b]).map(|h| h.to_bytes()).map_err(|_| PoolError::Poseidon)
}

/// circomlib's Poseidon(a, b, c) (t = 4): a commitment, `Poseidon(value, label, precommitment)`.
pub fn poseidon3(a: &[u8; 32], b: &[u8; 32], c: &[u8; 32]) -> Result<[u8; 32], PoolError> {
    hashv(Parameters::Bn254X5, Endianness::BigEndian, &[a, b, c]).map(|h| h.to_bytes()).map_err(|_| PoolError::Poseidon)
}

/// LIMT `_insert` (l.40-83) with PP's depth bound. Refuses a leaf not below p, a zero leaf and an insert that would
/// make the depth over 32, each before any write. Updates `size`, `depth` and `side`; returns the new root.
pub fn insert(size: &mut u64, depth: &mut u8, side: &mut Side, leaf: &[u8; 32]) -> Result<[u8; 32], PoolError> {
    // l.41-44
    if !field::is_field(leaf) {
        return Err(PoolError::FieldOverflow);
    }
    if *leaf == [0; 32] {
        return Err(PoolError::LeafCannotBeZero);
    }
    let index = *size;
    let mut d = *depth;
    // l.54-59
    if (1u64 << d) < index + 1 {
        d += 1;
    }
    // PP `State.sol:140`, before any write
    if d > MAX_TREE_DEPTH {
        return Err(PoolError::MaxTreeDepthReached);
    }
    // l.63-75
    let mut node = *leaf;
    for level in 0..d {
        if (index >> level) & 1 == 1 {
            node = poseidon2(&side[level as usize], &node)?;
        } else {
            side[level as usize] = node;
        }
    }
    // l.77-79
    *size = index + 1;
    *depth = d;
    side[d as usize] = node;
    Ok(node)
}

#[cfg(test)]
mod tests {
    use super::*;

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

    /// circomlib's vectors, the ones the vault pins (contracts/vault/tests/poseidon.rs:59 and :92).
    #[test]
    fn poseidon_is_circomlibs() {
        assert_eq!(
            poseidon2(&field::of_u64(1), &field::of_u64(2)).unwrap(),
            dec("7853200120776062878684798364095072458815029376092732009249414926327459813530")
        );
        assert_eq!(
            poseidon3(&[0; 32], &[0; 32], &[0; 32]).unwrap(),
            dec("5317387130258456662214331362918410991734007599705406860481038345552731150762")
        );
    }

    /// VT-P01's boundary vectors (contracts/vault/tests/fixtures/leanimt-vectors.json, made with @zk-kit/lean-imt and
    /// checked by the vault's src/tree.rs): the last leaf of a depth-32 tree, and the growth from depth 31 to 32.
    #[test]
    fn leanimt_boundary_vectors_match_at_every_level_to_32() {
        let v: serde_json::Value =
            serde_json::from_str(include_str!("../../vault/tests/fixtures/leanimt-vectors.json")).unwrap();
        let set = |c: &serde_json::Value| {
            let mut side = [[0u8; 32]; 33];
            for (level, x) in c["side"].as_array().unwrap().iter().enumerate() {
                side[level] = dec(x.as_str().unwrap());
            }
            (c["size"].as_u64().unwrap(), c["depth"].as_u64().unwrap() as u8, side)
        };
        let last = &v["boundary"]["last_leaf"];
        let (mut size, mut depth, mut side) = set(last);
        let root = insert(&mut size, &mut depth, &mut side, &dec(last["leaf"].as_str().unwrap())).unwrap();
        assert_eq!((size, depth, root), (1 << 32, 32, dec(last["root"].as_str().unwrap())), "the last leaf");
        let g = &v["boundary"]["growth"];
        let (mut size, mut depth, mut side) = set(g);
        let leaves = g["leaves"].as_array().unwrap();
        let roots = g["roots"].as_array().unwrap();
        assert_eq!(leaves.len(), 4);
        for (i, (leaf, want)) in leaves.iter().zip(roots).enumerate() {
            let root = insert(&mut size, &mut depth, &mut side, &dec(leaf.as_str().unwrap())).unwrap();
            assert_eq!((depth, root), (32, dec(want.as_str().unwrap())), "growth insert {i}");
        }
    }

    #[test]
    fn the_first_inserts_give_lean_imt_roots_and_depths() {
        let (l1, l2, l3, l4, l5) = (field::of_u64(11), field::of_u64(22), field::of_u64(33), field::of_u64(44), field::of_u64(55));
        let h = |a: &[u8; 32], b: &[u8; 32]| poseidon2(a, b).unwrap();
        let want = [
            (0, l1),
            (1, h(&l1, &l2)),
            (2, h(&h(&l1, &l2), &l3)),
            (2, h(&h(&l1, &l2), &h(&l3, &l4))),
            (3, h(&h(&h(&l1, &l2), &h(&l3, &l4)), &l5)),
        ];
        let (mut size, mut depth, mut side) = (0u64, 0u8, [[0u8; 32]; 33]);
        for (i, (leaf, (d, root))) in [l1, l2, l3, l4, l5].iter().zip(want).enumerate() {
            assert_eq!(insert(&mut size, &mut depth, &mut side, leaf).unwrap(), root);
            assert_eq!((size, depth), (i as u64 + 1, d));
        }
    }

    #[test]
    fn a_zero_leaf_a_leaf_of_p_and_a_33rd_level_are_refused_before_any_write() {
        let (mut size, mut depth, mut side) = (0u64, 0u8, [[0u8; 32]; 33]);
        assert_eq!(insert(&mut size, &mut depth, &mut side, &[0; 32]), Err(PoolError::LeafCannotBeZero));
        assert_eq!(insert(&mut size, &mut depth, &mut side, &field::to_be(&field::P)), Err(PoolError::FieldOverflow));
        assert_eq!((size, depth, side), (0, 0, [[0u8; 32]; 33]));
        // a full depth-32 tree: the next insert would need depth 33
        let (mut size, mut depth) = (1u64 << 32, 32u8);
        let mut side = [[7u8; 32]; 33];
        let before = side;
        assert_eq!(insert(&mut size, &mut depth, &mut side, &field::of_u64(1)), Err(PoolError::MaxTreeDepthReached));
        assert_eq!((size, depth, side), (1u64 << 32, 32, before));
    }
}
