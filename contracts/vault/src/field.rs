// SPDX-License-Identifier: Apache-2.0
//! Field elements of BN254's scalar field as 32 big-endian bytes, the decimal strings every view and event writes,
//! and `mod p` of a keccak256 output.
//! Ported from Privacy Pools v1.3.0 `packages/contracts/src/contracts/lib/Constants.sol` (SNARK_SCALAR_FIELD),
//! Copyright 2025 0XBOW LTD, Apache-2.0.

/// Four u64 limbs, most significant first.
pub type U256 = [u64; 4];

/// BN254's scalar field `p`, PP's `SNARK_SCALAR_FIELD`:
/// 21888242871839275222246405745257275088548364400416034343698204186575808495617.
pub const P: U256 = [0x30644e72e131a029, 0xb85045b68181585d, 0x2833e84879b97091, 0x43e1f593f0000001];

pub fn from_be(b: &[u8; 32]) -> U256 {
    let mut r = [0u64; 4];
    for (i, limb) in r.iter_mut().enumerate() {
        let mut w = [0u8; 8];
        w.copy_from_slice(&b[i * 8..i * 8 + 8]);
        *limb = u64::from_be_bytes(w);
    }
    r
}

pub fn to_be(a: &U256) -> [u8; 32] {
    let mut b = [0u8; 32];
    for (i, limb) in a.iter().enumerate() {
        b[i * 8..i * 8 + 8].copy_from_slice(&limb.to_be_bytes());
    }
    b
}

fn ge(a: &U256, b: &U256) -> bool {
    for i in 0..4 {
        if a[i] != b[i] {
            return a[i] > b[i];
        }
    }
    true
}

fn sub(a: &U256, b: &U256) -> U256 {
    let mut r = [0u64; 4];
    let mut borrow = 0u64;
    for i in (0..4).rev() {
        let (d1, o1) = a[i].overflowing_sub(b[i]);
        let (d2, o2) = d1.overflowing_sub(borrow);
        r[i] = d2;
        borrow = (o1 || o2) as u64;
    }
    r
}

/// `a mod p` for any 256-bit `a`: 2^256 < 6p, so at most five subtractions.
pub fn reduce(mut a: U256) -> U256 {
    while ge(&a, &P) {
        a = sub(&a, &P);
    }
    a
}

/// The decimal string of a 256-bit number, without leading zeros ("0" for zero).
pub fn to_decimal(a: &U256) -> String {
    let mut n = *a;
    let mut digits = Vec::new();
    loop {
        let mut rem: u128 = 0;
        for limb in n.iter_mut() {
            let cur = (rem << 64) | (*limb as u128);
            *limb = (cur / 10) as u64;
            rem = cur % 10;
        }
        digits.push(b'0' + rem as u8);
        if n == [0; 4] {
            break;
        }
    }
    digits.reverse();
    String::from_utf8(digits).unwrap()
}

/// A canonical field element from its decimal string: digits only, no sign, no leading zero (except "0"), below p.
/// Anything else is None.
pub fn from_decimal(s: &str) -> Option<U256> {
    let b = s.as_bytes();
    if b.is_empty() || b.len() > 78 || (b.len() > 1 && b[0] == b'0') {
        return None;
    }
    let mut n: U256 = [0; 4];
    for &c in b {
        if !c.is_ascii_digit() {
            return None;
        }
        // n = n * 10 + digit, refusing any overflow of 256 bits
        let mut carry: u128 = (c - b'0') as u128;
        for limb in n.iter_mut().rev() {
            let cur = (*limb as u128) * 10 + carry;
            *limb = cur as u64;
            carry = cur >> 64;
        }
        if carry != 0 {
            return None;
        }
    }
    if ge(&n, &P) {
        return None;
    }
    Some(n)
}
