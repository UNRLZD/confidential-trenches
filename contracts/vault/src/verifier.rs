// SPDX-License-Identifier: Apache-2.0
//! Groth16 on BN254 through NEAR's alt_bn128 host functions, with the ceremony keys of `verifier_keys` (vault.md 2.5.2
//! rows 1 and 10, V2.2, Dev 6). PP's Solidity verifiers are snarkJS output (GPL-3.0) and are not ported: this is the
//! same check written for NEAR.
//!
//! The check is snarkjs's: e(-A, B) e(alpha, beta) e(vk_x, gamma) e(C, delta) = 1 with
//! vk_x = IC[0] + sum(signal_i * IC[i + 1]): one `alt_bn128_g1_multiexp`, one `alt_bn128_g1_sum` and one 4-pair
//! `alt_bn128_pairing_check`. Byte order is the host functions' (nearcore `runtime/near-vm-runner/src/logic/
//! alt_bn128.rs`): every number 32 bytes little-endian; G1 = x ‖ y; G2 = x ‖ y with each Fq2 real (c0) ‖ imaginary
//! (c1), which is snarkjs's [c0, c1] order; a multiexp item G1 ‖ Fr; a sum item sign ‖ G1; a pairing item G1 ‖ G2.
//!
//! Every input is hostile. Before any host call:
//! - each proof coordinate is one canonical decimal (`InvalidNumber`) below q (`InvalidProofEncoding`), so a
//!   coordinate + q, the same point written another way, is refused;
//! - each public signal is below p (`FieldOverflow`), so no signal is reduced into another.
//!
//! A point off the curve or outside its subgroup makes the host function itself fail the call. A proof that does not
//! verify returns false; the caller refuses it (`InvalidProof`, row 10).
//!
//! A Groth16 proof can be re-randomised: (-A, -B, C) is r = -1 and verifies for the same signals (tests/groth16.rs
//! pins it), and anyone holding a proof can make others. So a spend is keyed on its nullifier hash, never on the
//! proof's bytes; the withdraw (V1.4) must keep it that way.

use crate::field::{self, U256};
use crate::verifier_keys::{VerifyingKey, WITHDRAW};
use near_sdk::{env, near};

/// BN254's base field q, the curve's coordinates:
/// 21888242871839275222246405745257275088696311157297823662689037894645226208583. Limbs most significant first.
pub const Q: U256 = [0x30644e72e131a029, 0xb85045b68181585d, 0x97816a916871ca8d, 0x3c208c16d87cfd47];

/// A proof as the call carries it, snarkjs's decimal strings: `a = [x, y]`, `b = [[x.c0, x.c1], [y.c0, y.c1]]`,
/// `c = [x, y]` (snarkjs's `pi_a`, `pi_b`, `pi_c` without their projective last element).
/// Unknown fields and wrong array lengths are refused when the call's JSON is read.
#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Proof {
    pub a: [String; 2],
    pub b: [[String; 2]; 2],
    pub c: [String; 2],
}

/// A proof in the host functions' bytes, with A already negated.
pub struct EncodedProof {
    neg_a: [u8; 64],
    b: [u8; 128],
    c: [u8; 64],
}

/// 32 little-endian bytes.
fn le(x: &U256) -> [u8; 32] {
    let mut b = field::to_be(x);
    b.reverse();
    b
}

/// A proof coordinate: a canonical decimal below q.
fn coord(s: &str) -> U256 {
    let x = field::parse_decimal(s)
        .unwrap_or_else(|| env::panic_str("InvalidNumber: a proof coordinate is not a canonical decimal"));
    if field::ge(&x, &Q) {
        env::panic_str("InvalidProofEncoding: a proof coordinate is not below q");
    }
    x
}

impl Proof {
    /// Parses every coordinate (row 1) and writes the host functions' bytes, -A as (x, q - y).
    pub fn encode(&self) -> EncodedProof {
        let ax = coord(&self.a[0]);
        let ay = coord(&self.a[1]);
        let b = [&self.b[0][0], &self.b[0][1], &self.b[1][0], &self.b[1][1]].map(|s| coord(s));
        let c = [coord(&self.c[0]), coord(&self.c[1])];
        // -(x, y) = (x, q - y); the point at infinity (0, 0) is its own negative
        let neg_ay = if ay == [0; 4] { ay } else { field::sub(&Q, &ay) };
        let mut e = EncodedProof { neg_a: [0; 64], b: [0; 128], c: [0; 64] };
        e.neg_a[..32].copy_from_slice(&le(&ax));
        e.neg_a[32..].copy_from_slice(&le(&neg_ay));
        for (i, x) in b.iter().enumerate() {
            e.b[32 * i..32 * i + 32].copy_from_slice(&le(x));
        }
        for (i, x) in c.iter().enumerate() {
            e.c[32 * i..32 * i + 32].copy_from_slice(&le(x));
        }
        e
    }
}

/// Groth16 verify of `proof` against `vk` and its `N - 1` public signals, each below p.
pub fn verify<const N: usize>(vk: &VerifyingKey<N>, proof: &EncodedProof, signals: &[U256]) -> bool {
    if signals.len() + 1 != N {
        env::panic_str("InvalidSignals: the key takes another number of public signals");
    }
    let mut me = Vec::with_capacity(96 * signals.len());
    for (s, ic) in signals.iter().zip(&vk.ic[1..]) {
        if field::ge(s, &field::P) {
            env::panic_str("FieldOverflow: a public signal is not below p");
        }
        me.extend_from_slice(ic);
        me.extend_from_slice(&le(s));
    }
    let m = env::alt_bn128_g1_multiexp(&me);
    let mut su = Vec::with_capacity(130);
    su.push(0);
    su.extend_from_slice(&vk.ic[0]);
    su.push(0);
    su.extend_from_slice(&m);
    let vk_x = env::alt_bn128_g1_sum(&su);
    let mut pi = Vec::with_capacity(4 * 192);
    pi.extend_from_slice(&proof.neg_a);
    pi.extend_from_slice(&proof.b);
    pi.extend_from_slice(&vk.alpha_g1);
    pi.extend_from_slice(&vk.beta_g2);
    pi.extend_from_slice(&vk_x);
    pi.extend_from_slice(&vk.gamma_g2);
    pi.extend_from_slice(&proof.c);
    pi.extend_from_slice(&vk.delta_g2);
    env::alt_bn128_pairing_check(&pi)
}

/// Row 10: the withdraw circuit's proof against its 8 public signals, in snarkjs order `[newCommitmentHash,
/// existingNullifierHash, withdrawnValue, stateRoot, stateTreeDepth, ASPRoot, ASPTreeDepth, context]`.
pub fn verify_withdraw(proof: &EncodedProof, signals: &[U256; 8]) -> bool {
    verify(&WITHDRAW, proof, signals)
}
