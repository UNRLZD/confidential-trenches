// SPDX-License-Identifier: Apache-2.0
//! The vault's two trees (vault.md 2.3, 2.4; V1.2): the state tree holds every note's commitment, the label tree every
//! approved label. Each is a LeanIMT hashed with the trim Poseidon (src/poseidon.rs, t = 3), and each keeps its root
//! set: every root the tree has ever had, kept for good. The sets have no bound and no eviction (vault.md 2.4, Dev 2):
//! leaves are never removed and the spent set is global, so an old root proves only a note that existed and is unspent,
//! and no run of cheap deposits can push a pending proof's root out (Auditware AW-M-02 against PP's 64-slot ring).
//! Each root costs 73 B, paid by the call that inserts it (vault.md 2.3).
//!
//! Ported from zk-kit's LeanIMT, `@zk-kit/lean-imt.sol` 2.0.0 (npm tarball shasum
//! 4b0aee47854b5844455f9361396062139416e12b), `InternalLeanIMT.sol` `_insert` l.40-83, Copyright (c) 2024 Ethereum
//! Foundation, MIT License (its text is in NOTICE); and from Privacy Pools v1.3.0 `State.sol` `_insert` l.136-152 and
//! `_isKnownRoot` l.161-173, Copyright 2025 0XBOW LTD, Apache-2.0. Changes:
//! - LIMT's `leaves` (leaf -> 1-based index, 0 meaning absent) is the vault's `state_leaf_index` (leaf -> 0-based
//!   index), for the state tree only: a label hashes a fresh nonce and cannot repeat (vault.md 2.5.1 row 10).
//! - `leaf_at` (index -> leaf) is a NEAR addition, so any public RPC serves every leaf (vault.md 2.3).
//! - PP's 64-root ring and the ASP's latest-only root are the two root sets above.
//! - PP checks the depth after LIMT's insert (`State.sol:140`); here it is checked before any write. NEAR undoes every
//!   write of a call that panics, so the outcome is the same.
//! - `LeafInserted`'s `index` is the 0-based position (src/events.rs).
//! - An insert logs nothing: it returns `Inserted`, and the method logs its `leaf_inserted` once every check of the call
//!   has passed. NEAR keeps a failed receipt's logs, so an event logged before a later refusal would name a leaf that
//!   was never kept (PP's revert drops its events with its writes).

use crate::constants::MAX_TREE_DEPTH;
use crate::events::{Event, TreeName};
use crate::poseidon::PoseidonT3;
use crate::{field, Bytes32, Key, Vault};
use near_sdk::collections::{LookupMap, LookupSet};
use near_sdk::{env, near};

/// Where a LeanIMT keeps its side nodes: one node per level, the last even position's node at that level, and at the
/// tree's depth its root (LIMT l.12-14).
pub trait SideNodes {
    /// The node at `level`; only read where an insert has written it before.
    fn side(&self, level: u8) -> Bytes32;
    fn set_side(&mut self, level: u8, node: &Bytes32);
}

/// The vault's side nodes, one record per level.
impl SideNodes for LookupMap<u8, Bytes32> {
    fn side(&self, level: u8) -> Bytes32 {
        self.get(&level).unwrap_or_else(|| env::panic_str("SideNodeMissing"))
    }
    fn set_side(&mut self, level: u8, node: &Bytes32) {
        self.insert(&level, node);
    }
}

/// Side nodes in memory, levels 0..=32: the same insert off chain (tests/tree_prop.rs).
impl SideNodes for [Bytes32; MAX_TREE_DEPTH as usize + 1] {
    fn side(&self, level: u8) -> Bytes32 {
        self[level as usize]
    }
    fn set_side(&mut self, level: u8, node: &Bytes32) {
        self[level as usize] = *node;
    }
}

/// LIMT `_insert` (l.40-83) with PP's depth bound (`State.sol:140`), without the leaf records each tree keeps itself.
/// Refuses a leaf not below p (`LeafGreaterThanSnarkScalarField`), a zero leaf (`LeafCannotBeZero`) and an insert that
/// would make the depth over 32 (`MaxTreeDepthReached`), each before any write. Updates `size` and `depth` and returns
/// the new root.
pub fn insert(
    h: &mut PoseidonT3,
    size: &mut u64,
    depth: &mut u8,
    side: &mut impl SideNodes,
    leaf: &Bytes32,
) -> Bytes32 {
    // l.41-44
    if field::from_be(leaf) >= field::P {
        env::panic_str("LeafGreaterThanSnarkScalarField")
    }
    if *leaf == [0; 32] {
        env::panic_str("LeafCannotBeZero")
    }
    let index = *size;
    let mut d = *depth;
    // l.54-59: the depth grows by one when the leaves the depth holds are fewer than the size after the insert
    if (1u64 << d) < index + 1 {
        d += 1;
    }
    // PP `State.sol:140`, before any write
    if d > MAX_TREE_DEPTH {
        env::panic_str("MaxTreeDepthReached")
    }
    // l.63-75: hash with the side node where bit `level` of the index is 1, else this node becomes that level's side
    let mut node = *leaf;
    for level in 0..d {
        if (index >> level) & 1 == 1 {
            node = h.hash(&side.side(level), &node);
        } else {
            side.set_side(level, &node);
        }
    }
    // l.77-79
    *size = index + 1;
    *depth = d;
    side.set_side(d, &node);
    node
}

/// One tree (LIMT `LeanIMTData` l.7-18): `size`, `depth`, a side node per level (an overwrite, except one new key each
/// time the depth grows), every leaf by its index, and every root the tree has had.
#[near]
pub struct Tree {
    pub size: u64,
    pub depth: u8,
    pub(crate) side_nodes: LookupMap<u8, Bytes32>,
    pub(crate) leaf_at: LookupMap<u64, Bytes32>,
    pub(crate) roots: LookupSet<Bytes32>,
}

impl Tree {
    pub(crate) fn new(side: Key, leaves: Key, roots: Key) -> Self {
        Self {
            size: 0,
            depth: 0,
            side_nodes: LookupMap::new(side),
            leaf_at: LookupMap::new(leaves),
            roots: LookupSet::new(roots),
        }
    }

    /// LIMT `_root`: the side node at the tree's depth; 0 for an empty tree.
    pub fn root(&self) -> Bytes32 {
        self.side_nodes.get(&self.depth).unwrap_or([0; 32])
    }

    /// Whether the tree has ever had this root (PP `_isKnownRoot`, l.161-173, over every root): 0 never is.
    pub fn is_known_root(&self, root: &Bytes32) -> bool {
        *root != [0; 32] && self.roots.contains(root)
    }

    /// The leaf at `index`, or None at or past the size.
    pub fn leaf_at(&self, index: u64) -> Option<Bytes32> {
        self.leaf_at.get(&index)
    }

    /// Inserts `leaf` (the checks of `insert`), records it at its index and its root in the root set. Logs nothing:
    /// the caller logs the returned `Inserted`'s `leaf_inserted` (PP `State.sol:151`) after its last check.
    fn push(&mut self, tree: TreeName, h: &mut PoseidonT3, leaf: &Bytes32) -> Inserted {
        let index = self.size;
        let root = insert(h, &mut self.size, &mut self.depth, &mut self.side_nodes, leaf);
        self.leaf_at.insert(&index, leaf);
        self.roots.insert(&root);
        Inserted { tree, index, leaf: *leaf, root }
    }
}

/// A leaf written into a tree, its `leaf_inserted` event not yet logged.
#[must_use = "log its leaf_inserted with `.event().emit()` once every check of the call has passed"]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Inserted {
    pub tree: TreeName,
    /// the leaf's 0-based index
    pub index: u64,
    pub leaf: Bytes32,
    /// the tree's root after the insert
    pub root: Bytes32,
}

impl Inserted {
    /// Its `leaf_inserted` event.
    pub fn event(&self) -> Event<'_> {
        Event::LeafInserted { tree: self.tree, index: self.index, leaf: &self.leaf, root: &self.root }
    }
}

/// The two inserts the vault's methods make (a deposit makes both; a change or refund note makes a state leaf, and a
/// refund note also a label). One `PoseidonT3` serves every hash of a call.
impl Vault {
    /// A commitment into the state tree: LIMT's checks, including `LeafAlreadyExists` (l.45-46). Returns the insert,
    /// its event not yet logged.
    pub fn insert_commitment(&mut self, h: &mut PoseidonT3, commitment: &Bytes32) -> Inserted {
        if self.state_leaf_index.contains_key(commitment) {
            env::panic_str("LeafAlreadyExists")
        }
        let ins = self.state_tree.push(TreeName::State, h, commitment);
        self.state_leaf_index.insert(commitment, &ins.index);
        ins
    }

    /// A label into the label tree, which approves it (vault.md 2.4). Returns the insert, its event not yet logged.
    pub fn insert_label(&mut self, h: &mut PoseidonT3, label: &Bytes32) -> Inserted {
        self.label_tree.push(TreeName::Label, h, label)
    }
}

#[cfg(test)]
#[path = "../tests/leanimt/mod.rs"]
mod leanimt;

#[cfg(test)]
mod tests {
    use super::leanimt::{ceil_log2, fixture, is_checkpoint, str_of, SplitMix64};
    use super::*;
    use near_sdk::serde_json::Value;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    /// A fresh mocked call that keeps the storage written so far: each call has its own gas and log limit, as each NEAR
    /// call has.
    fn call() {
        testing_env!(VMContextBuilder::new()
            .current_account_id("vault.test.near".parse().unwrap())
            .build());
    }

    fn n(x: u64) -> Bytes32 {
        field::to_be(&[0, 0, 0, x])
    }

    fn h2(a: &Bytes32, b: &Bytes32) -> Bytes32 {
        PoseidonT3::new().hash(a, b)
    }

    fn panics_with(f: impl FnOnce() + std::panic::UnwindSafe, want: &str) {
        let err = std::panic::catch_unwind(f).expect_err("must refuse");
        let msg = err
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()));
        assert!(msg.as_deref().unwrap_or("").contains(want), "want {want}, got {msg:?}");
    }

    #[test]
    fn the_first_inserts_give_lean_imt_roots_and_depths() {
        call();
        let mut v = Vault::default();
        let mut h = PoseidonT3::new();
        let (l1, l2, l3, l4, l5) = (n(11), n(22), n(33), n(44), n(55));
        let want = [
            (0, l1),
            (1, h2(&l1, &l2)),
            (2, h2(&h2(&l1, &l2), &l3)),
            (2, h2(&h2(&l1, &l2), &h2(&l3, &l4))),
            (3, h2(&h2(&h2(&l1, &l2), &h2(&l3, &l4)), &l5)),
        ];
        for (i, (leaf, (depth, root))) in [l1, l2, l3, l4, l5].iter().zip(want).enumerate() {
            let ins = v.insert_commitment(&mut h, leaf);
            assert_eq!((ins.tree, ins.index, ins.leaf, ins.root), (TreeName::State, i as u64, *leaf, root));
            if i == 4 {
                ins.event().emit();
            }
            assert_eq!(
                (v.state_tree.size, v.state_tree.depth, v.state_tree.root()),
                (i as u64 + 1, depth, root)
            );
            assert_eq!(v.state_tree.leaf_at(i as u64), Some(*leaf));
            assert_eq!(v.state_leaf_index.get(leaf), Some(i as u64));
        }
        assert_eq!(v.state_tree.leaf_at(5), None);
        // the inserts logged nothing; the one line is the event the test logged from the fifth insert
        let logs = get_logs();
        assert_eq!(logs.len(), 1, "{logs:?}");
        let log = logs[0].clone();
        let want_log = format!(
            r#"{{"tree":"state","index":4,"leaf":"55","root":"{}"}}"#,
            field::to_decimal(&field::from_be(&want[4].1))
        );
        assert!(log.contains(&want_log), "{log}");
        assert_eq!(v.label_tree.size, 0, "the label tree is apart");
    }

    #[test]
    fn every_root_either_tree_has_had_stays_known_and_no_other() {
        call();
        let mut v = Vault::default();
        let mut h = PoseidonT3::new();
        assert!(!v.is_known_state_root("0".into()), "the empty tree's 0 is never a root");
        let mut state = Vec::new();
        let mut label = Vec::new();
        for i in 1..=1_100u64 {
            if i % 20 == 0 {
                call();
            }
            state.push(v.insert_commitment(&mut h, &n(i)).root);
            label.push(v.insert_label(&mut h, &n(i + 1_000_000)).root);
        }
        call();
        // the first root, a root 1,000 inserts old (VT-S06) and the newest are all known, in their own tree only
        for i in [0, 99, 1_099] {
            assert!(
                v.state_tree.is_known_root(&state[i]) && v.label_tree.is_known_root(&label[i]),
                "{i}"
            );
            assert!(
                !v.state_tree.is_known_root(&label[i]) && !v.label_tree.is_known_root(&state[i]),
                "{i}"
            );
        }
        assert!(
            state.iter().all(|r| v.state_tree.is_known_root(r)),
            "no state root is ever evicted"
        );
        assert!(
            label.iter().all(|r| v.label_tree.is_known_root(r)),
            "no label root is ever evicted"
        );
        assert!(!v.state_tree.is_known_root(&[0; 32]) && !v.label_tree.is_known_root(&[0; 32]));
        assert!(!v.state_tree.is_known_root(&n(5_000_000)), "an unknown root");
        assert_eq!(
            (
                v.state_tree.size,
                v.state_tree.depth,
                v.label_tree.size,
                v.label_tree.depth
            ),
            (1_100, 11, 1_100, 11)
        );
    }

    #[test]
    fn hostile_leaves_are_refused_before_any_write() {
        call();
        let mut v = Vault::default();
        let mut h = PoseidonT3::new();
        let _ = v.insert_commitment(&mut h, &n(7));
        let p = field::to_be(&field::P);
        let max = [0xff; 32];
        let before = |v: &Vault| {
            (
                v.state_tree.size,
                v.state_tree.depth,
                v.state_tree.root(),
                env::storage_usage(),
            )
        };
        let start = before(&v);
        for (leaf, want) in [
            (n(7), "LeafAlreadyExists"),
            (n(0), "LeafCannotBeZero"),
            (p, "LeafGreaterThanSnarkScalarField"),
            (max, "LeafGreaterThanSnarkScalarField"),
        ] {
            panics_with(
                std::panic::AssertUnwindSafe(|| {
                    let _ = v.insert_commitment(&mut PoseidonT3::new(), &leaf);
                }),
                want,
            );
            assert_eq!(before(&v), start, "{want}: nothing written");
        }
        for (leaf, want) in [(n(0), "LeafCannotBeZero"), (p, "LeafGreaterThanSnarkScalarField")] {
            let mut t = Tree::new(Key::LabelSideNodes, Key::LabelAt, Key::LabelRoots);
            panics_with(
                std::panic::AssertUnwindSafe(|| {
                    let _ = t.push(TreeName::Label, &mut PoseidonT3::new(), &leaf);
                }),
                want,
            );
        }
        // the largest leaf below p is a leaf
        let mut p_minus_1 = field::P;
        p_minus_1[3] -= 1;
        let _ = v.insert_commitment(&mut h, &field::to_be(&p_minus_1));
        assert_eq!(v.state_tree.size, 2);
    }

    #[test]
    fn the_depth_never_passes_32() {
        // a full tree of 2^32 leaves has depth 32; one more insert is refused before any write
        let mut side = [[0u8; 32]; MAX_TREE_DEPTH as usize + 1];
        let (mut size, mut depth) = (1u64 << 32, 32u8);
        side[32] = n(9);
        let snapshot = side;
        panics_with(
            std::panic::AssertUnwindSafe(|| {
                insert(&mut PoseidonT3::new(), &mut size, &mut depth, &mut side, &n(1));
            }),
            "MaxTreeDepthReached",
        );
        assert_eq!((size, depth, side), (1u64 << 32, 32, snapshot));
        // the 2^32-th leaf (index 2^32 - 1) still goes in at depth 32
        let (mut size, mut depth) = ((1u64 << 32) - 1, 32u8);
        for (level, node) in side.iter_mut().take(32).enumerate() {
            *node = n(level as u64 + 100);
        }
        let root = insert(&mut PoseidonT3::new(), &mut size, &mut depth, &mut side, &n(1));
        assert_eq!((size, depth, side[32]), (1u64 << 32, 32, root));
    }

    fn dec(b: &Bytes32) -> String {
        field::to_decimal(&field::from_be(b))
    }

    fn b(v: &Value) -> Bytes32 {
        field::to_be(&field::from_decimal(str_of(v)).expect("a canonical decimal"))
    }

    /// VT-P01 on the on-chain store: seed 6 (4,696 leaves, depth 13) through `insert_commitment`, so `Tree::push` over
    /// near-sdk's LookupMap, a fresh call every 40 inserts (each call's log limit). Equal to @zk-kit/lean-imt's root
    /// after every insert (the fixture's chain) and at every checkpoint; every leaf served back at its index.
    #[test]
    fn the_on_chain_store_gives_lean_imt_roots_after_every_insert() {
        let fixture = fixture();
        let s = fixture["sequences"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["seed"] == 6)
            .unwrap();
        let count = s["count"].as_u64().unwrap();
        assert_eq!(
            (count, s["final_depth"].as_u64().unwrap()),
            (4_696, 13),
            "deeper than 12 levels"
        );
        call();
        let mut v = Vault::default();
        let mut h = PoseidonT3::new();
        let mut rng = SplitMix64(6);
        let mut chain = [0u8; 32];
        let mut leaves = Vec::new();
        for n in 1..=count {
            if n % 40 == 0 {
                call();
            }
            let leaf = field::to_be(&rng.leaf(&field::P));
            let Inserted { index, root, .. } = v.insert_commitment(&mut h, &leaf);
            assert_eq!(
                (index, v.state_tree.size, v.state_tree.depth),
                (n - 1, n, ceil_log2(n)),
                "size {n}"
            );
            assert_eq!(v.state_tree.root(), root, "size {n}: the stored root");
            assert!(v.state_tree.is_known_root(&root));
            chain = h.hash(&chain, &root);
            if is_checkpoint(n, count) {
                assert_eq!(
                    dec(&root),
                    str_of(&s["checkpoints"][n.to_string()]),
                    "the root at size {n}"
                );
            }
            leaves.push(leaf);
        }
        assert_eq!(dec(&chain), str_of(&s["chain"]), "a root after some insert differs");
        assert_eq!(dec(&v.state_tree.root()), str_of(&s["final_root"]));
        for (i, leaf) in leaves.iter().enumerate() {
            assert_eq!(v.state_tree.leaf_at(i as u64).as_ref(), Some(leaf));
        }
    }

    /// The fixture's boundary roots (the circuit's rule, every level to 32) through the on-chain store: the side nodes
    /// written into the LookupMap, then `insert_commitment`.
    #[test]
    fn the_on_chain_store_gives_the_circuit_rule_root_at_every_level_to_32() {
        let fixture = fixture();
        let set = |v: &mut Vault, c: &Value| {
            for (level, x) in c["side"].as_array().unwrap().iter().enumerate() {
                v.state_tree.side_nodes.insert(&(level as u8), &b(x));
            }
            v.state_tree.size = c["size"].as_u64().unwrap();
            v.state_tree.depth = c["depth"].as_u64().unwrap() as u8;
        };
        call();
        let last = &fixture["boundary"]["last_leaf"];
        let mut v = Vault::default();
        set(&mut v, last);
        let Inserted { index, root, .. } = v.insert_commitment(&mut PoseidonT3::new(), &b(&last["leaf"]));
        assert_eq!(
            (index, dec(&root)),
            ((1 << 32) - 1, str_of(&last["root"]).to_string()),
            "the last leaf"
        );
        assert_eq!(
            (v.state_tree.size, v.state_tree.depth, v.state_tree.root()),
            (1 << 32, 32, root)
        );

        call();
        let g = &fixture["boundary"]["growth"];
        let mut v = Vault::default();
        set(&mut v, g);
        let mut h = PoseidonT3::new();
        for (i, (leaf, want)) in g["leaves"]
            .as_array()
            .unwrap()
            .iter()
            .zip(g["roots"].as_array().unwrap())
            .enumerate()
        {
            let root = v.insert_commitment(&mut h, &b(leaf)).root;
            assert_eq!(dec(&root), str_of(want), "growth insert {i}");
            assert_eq!(
                (v.state_tree.depth, v.state_tree.root()),
                (32, root),
                "growth insert {i}"
            );
        }
    }
}
