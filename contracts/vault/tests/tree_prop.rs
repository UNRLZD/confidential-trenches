// SPDX-License-Identifier: Apache-2.0
//! VT-P01 (vault.md l.1126): random insert sequences into the vault's Rust LeanIMT (src/tree.rs `insert`, the code
//! both trees run on chain, here over side nodes in memory) give the same root after every insert as
//! `@zk-kit/lean-imt` 2.2.4 and the kit's VaultTree, and the depth is ceil(log2 size) after every insert.
//!
//! The reference is tests/fixtures/leanimt-vectors.json, made by scripts/leanimt-vectors.mjs from the same seeds:
//! seed 1 with 100,000 leaves and seeds 2-9 with counts below 5,000. Each sequence pins a Poseidon chain over the root
//! after every insert (chain = Poseidon(chain, root), from 0), so one wrong root at any size fails it; the roots at
//! sizes 2^k and 2^k + 1 name the first size that differs. That script also checks every leaf's path by the circuit's
//! rule against the same roots. The sequences reach depth 17; the fixture's `boundary` roots, made by the circuit's
//! rule alone, check every level up to 32. src/tree.rs's unit tests run seed 6 and the boundary through the on-chain
//! store. `node contracts/vault/scripts/leanimt-vectors.mjs --check` recomputes the fixture (CI runs `--fast`).

mod leanimt;

use blindfill_vault::constants::MAX_TREE_DEPTH;
use blindfill_vault::field;
use blindfill_vault::poseidon::PoseidonT3;
use blindfill_vault::tree::insert;
use blindfill_vault::Bytes32;
use leanimt::{ceil_log2, fixture, is_checkpoint, str_of, SplitMix64};
use near_sdk::serde_json::Value;

fn dec(b: &Bytes32) -> String {
    field::to_decimal(&field::from_be(b))
}

fn b(v: &Value) -> Bytes32 {
    field::to_be(&field::from_decimal(str_of(v)).expect("a canonical decimal"))
}

#[test]
fn rust_tree_roots_equal_lean_imt_after_every_insert() {
    let fixture = fixture();
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
            let leaf = field::to_be(&rng.leaf(&field::P));
            if n == 1 {
                assert_eq!(
                    dec(&leaf),
                    str_of(&s["first_leaf"]),
                    "seed {seed}: the leaves differ from the script's"
                );
            }
            root = insert(&mut h, &mut size, &mut depth, &mut side, &leaf);
            assert_eq!((size, depth), (n, ceil_log2(n)), "seed {seed} size {n}: size or depth");
            assert_eq!(
                side[depth as usize], root,
                "seed {seed} size {n}: the root is the side node at the depth"
            );
            chain = h.hash(&chain, &root);
            if is_checkpoint(n, count) {
                assert_eq!(
                    dec(&root),
                    str_of(&checkpoints[&n.to_string()]),
                    "seed {seed}: the root at size {n}"
                );
                seen += 1;
            }
        }
        assert_eq!(seen, checkpoints.len(), "seed {seed}: every checkpoint reached");
        assert_eq!(dec(&root), str_of(&s["final_root"]), "seed {seed}: final root");
        assert_eq!(
            depth as u64,
            s["final_depth"].as_u64().unwrap(),
            "seed {seed}: final depth"
        );
        assert_eq!(
            dec(&chain),
            str_of(&s["chain"]),
            "seed {seed}: a root after some insert differs"
        );
        println!(
            "seed {seed}: {count} inserts, depth {depth}, root {}, chain equal",
            dec(&root)
        );
        total += count;
    }
    assert_eq!(
        sequences[0]["count"], 100_000,
        "the longest sequence holds 100,000 leaves"
    );
    println!("VT-P01: {total} inserts over 9 sequences, every root equal to @zk-kit/lean-imt and the kit's VaultTree");
}

/// The boundary's side nodes 0..31 as the in-memory store (side 32 empty).
fn side_of(v: &Value) -> [Bytes32; MAX_TREE_DEPTH as usize + 1] {
    let given = v.as_array().unwrap();
    assert_eq!(given.len(), 32);
    let mut side = [[0u8; 32]; MAX_TREE_DEPTH as usize + 1];
    for (s, x) in side.iter_mut().zip(given) {
        *s = b(x);
    }
    side
}

#[test]
fn every_level_to_32_gives_the_circuit_rule_root() {
    let fixture = fixture();
    let mut h = PoseidonT3::new();
    // the last leaf of a depth-32 tree: hashed at all 32 levels
    let last = &fixture["boundary"]["last_leaf"];
    let mut side = side_of(&last["side"]);
    let (mut size, mut depth) = (last["size"].as_u64().unwrap(), last["depth"].as_u64().unwrap() as u8);
    assert_eq!((size, depth), ((1 << 32) - 1, 32));
    let root = insert(&mut h, &mut size, &mut depth, &mut side, &b(&last["leaf"]));
    assert_eq!(dec(&root), str_of(&last["root"]), "the last leaf at depth 32");
    assert_eq!((size, depth, side[32]), (1 << 32, 32, root));
    // 2^31 leaves, then four more: the depth grows to 32 and level 31 is hashed
    let g = &fixture["boundary"]["growth"];
    let mut side = side_of(&g["side"]);
    let (mut size, mut depth) = (g["size"].as_u64().unwrap(), g["depth"].as_u64().unwrap() as u8);
    assert_eq!((size, depth), (1 << 31, 31));
    for (i, (leaf, want)) in g["leaves"]
        .as_array()
        .unwrap()
        .iter()
        .zip(g["roots"].as_array().unwrap())
        .enumerate()
    {
        let root = insert(&mut h, &mut size, &mut depth, &mut side, &b(leaf));
        assert_eq!(dec(&root), str_of(want), "growth insert {i}");
        assert_eq!((size, depth), ((1 << 31) + i as u64 + 1, 32), "growth insert {i}");
    }
}
