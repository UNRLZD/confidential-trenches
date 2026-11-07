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
//!
//! The long run (card vault-property-p02-exits): seed 1's 100,000 leaves through the on-chain store, the vault's own
//! `insert_commitment` (`Tree::push` over near-sdk's LookupMap), read back through the public views `state_tree`,
//! `is_known_state_root` and `leaves` after every insert, against the same chain and checkpoints. Ignored by a plain
//! `cargo test`; run it with
//!   cargo +1.96.0 test --locked --manifest-path contracts/vault/Cargo.toml --test tree_prop -- --ignored
//! next to `node contracts/vault/scripts/leanimt-vectors.mjs --check` (no `--fast`: the 100,000 roots recomputed by
//! @zk-kit/lean-imt and the kit's VaultTree). CI's vault-sandbox job runs it (tests/harness/run.sh passes
//! `--include-ignored`), on pull requests that touch the vault and nightly on main. `VT_P01_PLANT=leaf:<n>` swaps the n-th leaf for another and
//! `VT_P01_PLANT=zero:<n>` writes 0 over the stored side node the n-th insert hashes with; either must fail it. The
//! normal suite runs both plants on seed 6, so the comparison that catches them stays checked on every push.

mod leanimt;

use blindfill_vault::constants::MAX_TREE_DEPTH;
use blindfill_vault::field;
use blindfill_vault::poseidon::PoseidonT3;
use blindfill_vault::constants::PAGE_MAX;
use blindfill_vault::tree::insert;
use blindfill_vault::{Bytes32, Vault};
use leanimt::{ceil_log2, fixture, is_checkpoint, str_of, SplitMix64};
use near_sdk::serde_json::Value;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{env, testing_env};

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

/// A fault put into the on-chain run to show the comparison catches it.
#[derive(Clone, Copy, Debug)]
enum Plant {
    /// the n-th leaf (1-based) replaced by another valid leaf
    Leaf(u64),
    /// before the n-th insert (n even, so its index is odd and it hashes with the level-0 side node), 0 written over
    /// that stored side node: the value a tree with zero hashes would read where LeanIMT keeps a real node
    Zero(u64),
}

/// The raw storage key of the state tree's side node at `level`: the collection prefix (`Key::StateSideNodes`, the
/// enum's first variant, borsh 0) and the borsh u8 level.
fn state_side_key(level: u8) -> [u8; 2] {
    [0, level]
}

/// A fresh mocked call that keeps the storage written so far, as src/tree.rs's tests make one: each NEAR call has its
/// own gas.
fn call() {
    testing_env!(VMContextBuilder::new()
        .current_account_id("vault.test.near".parse().unwrap())
        .build());
}

/// Seed `seed`'s sequence through the vault's `insert_commitment`, read back through its public views after every
/// insert. Ok holds the result line; Err names the first value that differs.
fn on_chain(seed: u64, plant: Option<Plant>) -> Result<String, String> {
    let fixture = fixture();
    let s = fixture["sequences"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["seed"] == seed)
        .unwrap_or_else(|| panic!("no seed {seed} in the fixture"));
    let count = s["count"].as_u64().unwrap();
    // an empty store: the mocked chain keeps a thread's storage from run to run
    call();
    near_sdk::mock::with_mocked_blockchain(|b| drop(b.take_storage()));
    call();
    let mut v = Vault::default();
    let mut h = PoseidonT3::new();
    let mut rng = SplitMix64(seed);
    let mut chain = [0u8; 32];
    let mut leaves = Vec::with_capacity(count as usize);
    let mut last = [0u8; 32];
    for n in 1..=count {
        if n % 40 == 0 {
            call();
        }
        let mut leaf = field::to_be(&rng.leaf(&field::P));
        if n == 1 && dec(&leaf) != str_of(&s["first_leaf"]) {
            return Err(format!("seed {seed}: the leaves differ from the script's"));
        }
        match plant {
            Some(Plant::Leaf(at)) if at == n => leaf[31] ^= 1,
            Some(Plant::Zero(at)) if at == n => {
                assert!(n % 2 == 0, "a zero plant at an even size, whose insert reads side node 0");
                // the key is the side node's: before the plant it holds the last leaf, kept at level 0 by the even index
                assert_eq!(env::storage_read(&state_side_key(0)), Some(last.to_vec()), "the side node's key");
                env::storage_write(&state_side_key(0), &[0u8; 32]);
            }
            _ => {}
        }
        let ins = v.insert_commitment(&mut h, &leaf);
        let view = v.state_tree();
        let root = dec(&ins.root);
        if (ins.index, view.size, view.depth) != (n - 1, n, ceil_log2(n)) {
            return Err(format!("seed {seed} size {n}: index, size or depth"));
        }
        if view.root != root || !v.is_known_state_root(root.clone()) {
            return Err(format!("seed {seed} size {n}: the stored root or the root set"));
        }
        chain = h.hash(&chain, &ins.root);
        if is_checkpoint(n, count) && root != str_of(&s["checkpoints"][n.to_string()]) {
            return Err(format!("seed {seed}: the root at size {n} differs from the TS tree's"));
        }
        leaves.push(dec(&leaf));
        last = leaf;
    }
    if dec(&chain) != str_of(&s["chain"]) {
        return Err(format!("seed {seed}: a root after some insert differs from the TS tree's"));
    }
    let view = v.state_tree();
    if view.root != str_of(&s["final_root"]) || view.depth as u64 != s["final_depth"].as_u64().unwrap() {
        return Err(format!("seed {seed}: the final root or depth"));
    }
    // every leaf served back at its index, page by page, as a public RPC serves them
    for from in (0..count).step_by(PAGE_MAX as usize) {
        call();
        let page = v.leaves(from, PAGE_MAX);
        let want = &leaves[from as usize..(from + PAGE_MAX).min(count) as usize];
        if page != want {
            return Err(format!("seed {seed}: the leaves served from index {from}"));
        }
    }
    Ok(format!(
        "VT-P01 on chain: seed {seed}, {count} inserts through insert_commitment, depth {}, root {}, every root equal to \
         @zk-kit/lean-imt and the kit's VaultTree (chain and {} checkpoints), every leaf served back",
        view.depth,
        view.root,
        s["checkpoints"].as_object().unwrap().len()
    ))
}

/// The plant named by VT_P01_PLANT (`leaf:<n>` or `zero:<n>`), if any.
fn plant_from_env() -> Option<Plant> {
    let v = std::env::var("VT_P01_PLANT").ok()?;
    let (kind, at) = v.split_once(':').expect("VT_P01_PLANT is leaf:<n> or zero:<n>");
    let at = at.parse().expect("VT_P01_PLANT's n is a number");
    Some(match kind {
        "leaf" => Plant::Leaf(at),
        "zero" => Plant::Zero(at),
        _ => panic!("VT_P01_PLANT is leaf:<n> or zero:<n>"),
    })
}

/// VT-P01's long run: 100,000 inserts through the on-chain store, the root after every insert equal to the TS tree's.
#[test]
#[ignore = "the long run (47 s on the Mac): cargo test --test tree_prop -- --ignored; run.sh runs it"]
fn the_on_chain_store_gives_lean_imt_roots_after_every_insert_to_100000() {
    let plant = plant_from_env();
    let t0 = std::time::Instant::now();
    let out = on_chain(1, plant);
    let secs = t0.elapsed().as_secs_f64();
    match out {
        Ok(line) => {
            assert!(plant.is_none(), "{plant:?} was planted and the run still passed: {line}");
            assert!(line.contains("100000 inserts"), "{line}");
            println!("{line} in {secs:.1} s");
        }
        Err(e) => panic!("{e} ({plant:?} planted; {secs:.1} s)"),
    }
}

/// Both plants fail the on-chain run (seed 6, 4,696 leaves), each at the first checkpoint after it, and the unplanted
/// run passes: what the long run relies on, checked on every push.
#[test]
fn a_wrong_leaf_or_a_zero_side_node_fails_the_on_chain_run() {
    assert!(on_chain(6, None).is_ok(), "seed 6 unplanted");
    assert_eq!(
        on_chain(6, Some(Plant::Leaf(3_000))),
        Err("seed 6: the root at size 4096 differs from the TS tree's".into())
    );
    assert_eq!(
        on_chain(6, Some(Plant::Zero(3_002))),
        Err("seed 6: the root at size 4096 differs from the TS tree's".into())
    );
    // the last insert (no checkpoint after it but the final one)
    assert_eq!(
        on_chain(6, Some(Plant::Leaf(4_696))),
        Err("seed 6: the root at size 4696 differs from the TS tree's".into())
    );
}
