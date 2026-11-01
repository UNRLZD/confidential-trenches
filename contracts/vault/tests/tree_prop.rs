// SPDX-License-Identifier: Apache-2.0
//! VT-P01 (vault.md l.1126): random insert sequences into the vault's Rust LeanIMT (src/tree.rs `insert`, the code
//! both trees run on chain, here over side nodes in memory) give the same root after every insert as
//! `@zk-kit/lean-imt` 2.2.4 and the kit's VaultTree, and the depth is ceil(log2 size) after every insert.
//!
//! The reference is tests/fixtures/leanimt-vectors.json, made by scripts/leanimt-vectors.mjs from the same seeds:
//! seed 1 with 100,000 leaves and seeds 2-9 with counts below 5,000. Each sequence pins a Poseidon chain over the root
//! after every insert (chain = Poseidon(chain, root), from 0), so one wrong root at any size fails it; the roots at
//! sizes 2^k and 2^k + 1 name the first size that differs. That script also checks every leaf's path by the circuit's
//! rule against the same roots. `node contracts/vault/scripts/leanimt-vectors.mjs --check` recomputes the fixture.

use blindfill_vault::constants::MAX_TREE_DEPTH;
use blindfill_vault::field;
use blindfill_vault::poseidon::PoseidonT3;
use blindfill_vault::tree::insert;
use blindfill_vault::Bytes32;
use near_sdk::serde_json::{self, Value};

const FIXTURE: &str = include_str!("fixtures/leanimt-vectors.json");

/// splitmix64, as the script's.
struct SplitMix64(u64);

impl SplitMix64 {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e3779b97f4a7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
        z ^ (z >> 31)
    }

    /// Four draws as big-endian limbs, the first masked to 62 bits, redrawn while 0 or not below p.
    fn leaf(&mut self) -> Bytes32 {
        loop {
            let v = [self.next() & ((1 << 62) - 1), self.next(), self.next(), self.next()];
            if v != [0; 4] && v < field::P {
                return field::to_be(&v);
            }
        }
    }
}

fn dec(b: &Bytes32) -> String {
    field::to_decimal(&field::from_be(b))
}

fn ceil_log2(n: u64) -> u8 {
    if n <= 1 {
        0
    } else {
        (64 - (n - 1).leading_zeros()) as u8
    }
}

#[test]
fn rust_tree_roots_equal_lean_imt_after_every_insert() {
    let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
    let sequences = fixture["sequences"].as_array().unwrap();
    assert_eq!(sequences.len(), 9);
    assert_eq!(fixture["lean_imt"], "2.2.4");
    let mut h = PoseidonT3::new();
    let mut total = 0u64;
    for s in sequences {
        let seed = s["seed"].as_u64().unwrap();
        let count = s["count"].as_u64().unwrap();
        let checkpoints = s["checkpoints"].as_object().unwrap();
        let mut rng = SplitMix64(seed);
        let mut side = [[0u8; 32]; MAX_TREE_DEPTH as usize + 1];
        let (mut size, mut depth) = (0u64, 0u8);
        let mut chain = [0u8; 32];
        let mut root = [0u8; 32];
        let mut seen = 0;
        for n in 1..=count {
            let leaf = rng.leaf();
            if n == 1 {
                assert_eq!(dec(&leaf), s["first_leaf"].as_str().unwrap(), "seed {seed}: the leaves differ from the script's");
            }
            root = insert(&mut h, &mut size, &mut depth, &mut side, &leaf);
            assert_eq!((size, depth), (n, ceil_log2(n)), "seed {seed} size {n}: size or depth");
            assert_eq!(side[depth as usize], root, "seed {seed} size {n}: the root is the side node at the depth");
            chain = h.hash(&chain, &root);
            if let Some(want) = checkpoints.get(&n.to_string()) {
                assert_eq!(dec(&root), want.as_str().unwrap(), "seed {seed}: the root at size {n}");
                seen += 1;
            }
        }
        assert_eq!(seen, checkpoints.len(), "seed {seed}: every checkpoint reached");
        assert_eq!(dec(&root), s["final_root"].as_str().unwrap(), "seed {seed}: final root");
        assert_eq!(depth as u64, s["final_depth"].as_u64().unwrap(), "seed {seed}: final depth");
        assert_eq!(dec(&chain), s["chain"].as_str().unwrap(), "seed {seed}: a root after some insert differs");
        println!("seed {seed}: {count} inserts, depth {depth}, root {}, chain equal", dec(&root));
        total += count;
    }
    assert_eq!(sequences[0]["count"], 100_000, "the longest sequence holds 100,000 leaves");
    println!("VT-P01: {total} inserts over 9 sequences, every root equal to @zk-kit/lean-imt and the kit's VaultTree");
}
