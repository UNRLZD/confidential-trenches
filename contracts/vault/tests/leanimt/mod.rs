// SPDX-License-Identifier: Apache-2.0
//! VT-P01's shared reading of tests/fixtures/leanimt-vectors.json (made by scripts/leanimt-vectors.mjs): its leaf
//! generator and its sequences, for both stores the tree runs on. tests/tree_prop.rs takes it as a module (the side
//! nodes in memory) and src/tree.rs's unit tests by `#[path]` (the on-chain LookupMap store), so it names nothing of
//! the vault's crate: leaves are limbs, the caller turns them into bytes.
#![allow(dead_code)]

use near_sdk::serde_json::{self, Value};

pub const FIXTURE: &str = include_str!("../fixtures/leanimt-vectors.json");

pub fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("the fixture is JSON")
}

/// splitmix64, as the script's.
pub struct SplitMix64(pub u64);

impl SplitMix64 {
    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e3779b97f4a7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
        z ^ (z >> 31)
    }

    /// Four draws as big-endian limbs, the first masked to 62 bits, redrawn while 0 or not below `p`.
    pub fn leaf(&mut self, p: &[u64; 4]) -> [u64; 4] {
        loop {
            let v = [self.next() & ((1 << 62) - 1), self.next(), self.next(), self.next()];
            if v != [0; 4] && v < *p {
                return v;
            }
        }
    }
}

pub fn ceil_log2(n: u64) -> u8 {
    if n <= 1 {
        0
    } else {
        (64 - (n - 1).leading_zeros()) as u8
    }
}

/// Whether the script records the root at `size` for a sequence of `count`: 2^k, 2^k + 1 and the last.
pub fn is_checkpoint(size: u64, count: u64) -> bool {
    size.is_power_of_two() || (size - 1).is_power_of_two() || size == count
}

pub fn str_of(v: &Value) -> &str {
    v.as_str().expect("a decimal string")
}
