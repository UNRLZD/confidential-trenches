// SPDX-License-Identifier: Apache-2.0
//! Field elements of BN254's scalar field as 32 big-endian bytes, and `mod p` of a keccak256 output.
//! Ported from the Blindfill vault (`contracts/vault/src/field.rs`), itself from Privacy Pools v1.3.0
//! `packages/contracts/src/contracts/lib/Constants.sol` (SNARK_SCALAR_FIELD), Copyright 2025 0XBOW LTD, Apache-2.0.
//! The decimal parse is not ported: the pool's instructions carry raw big-endian bytes.

/// Four u64 limbs, most significant first.
pub type U256 = [u64; 4];

/// BN254's scalar field `p`, PP's `SNARK_SCALAR_FIELD`:
/// 21888242871839275222246405745257275088548364400416034343698204186575808495617.
pub const P: U256 = [0x30644e72e131a029, 0xb85045b68181585d, 0x2833e84879b97091, 0x43e1f593f0000001];

/// BN254's base field `q`, the curve's coordinates:
/// 21888242871839275222246405745257275088696311157297823662689037894645226208583.
pub const Q: U256 = [0x30644e72e131a029, 0xb85045b68181585d, 0x97816a916871ca8d, 0x3c208c16d87cfd47];

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

/// `a >= b`.
pub fn ge(a: &U256, b: &U256) -> bool {
    for i in 0..4 {
        if a[i] != b[i] {
            return a[i] > b[i];
        }
    }
    true
}

/// `a - b`, for `a >= b`.
pub fn sub(a: &U256, b: &U256) -> U256 {
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

/// 32 big-endian bytes below p.
pub fn is_field(b: &[u8; 32]) -> bool {
    !ge(&from_be(b), &P)
}

/// 32 big-endian bytes below q.
pub fn is_coord(b: &[u8; 32]) -> bool {
    !ge(&from_be(b), &Q)
}

/// A u64 as a field element, 32 big-endian bytes.
pub fn of_u64(n: u64) -> [u8; 32] {
    let mut b = [0u8; 32];
    b[24..].copy_from_slice(&n.to_be_bytes());
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn p_and_q_are_bn254s() {
        // p - 1 and q - 1 are in range, p and q are not
        let pm1 = sub(&P, &[0, 0, 0, 1]);
        assert!(is_field(&to_be(&pm1)) && !is_field(&to_be(&P)));
        let qm1 = sub(&Q, &[0, 0, 0, 1]);
        assert!(is_coord(&to_be(&qm1)) && !is_coord(&to_be(&Q)));
        assert!(ge(&Q, &P), "q > p on BN254");
        assert_eq!(reduce([u64::MAX; 4]), sub(&sub(&sub(&sub(&sub(&[u64::MAX; 4], &P), &P), &P), &P), &P));
        assert_eq!(reduce(P), [0; 4]);
        assert_eq!(of_u64(258)[30..], [1, 2]);
    }
}
