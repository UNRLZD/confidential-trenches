// SPDX-License-Identifier: Apache-2.0
//! Groth16 on BN254 through Solana's alt_bn128 `_be` calls, with the withdraw circuit's ceremony key (src/vk.rs). The
//! check is snarkjs's, as the NEAR vault makes it (`contracts/vault/src/verifier.rs`): e(-A, B) e(vk_x, gamma)
//! e(C, delta) e(alpha, beta) = 1 with vk_x = IC[0] + sum(signal_i * IC[i + 1]), the shape of groth16-solana 0.2.0's
//! `verify` (`src/groth16.rs` l.87-145, Apache-2.0), written here on solana-bn254 3.2.1's calls.
//!
//! Every input is hostile. Before any curve call:
//! - each proof coordinate is below q (`InvalidProofEncoding`), so a coordinate + q, the same point written another
//!   way, is refused (the vault's rule);
//! - each public signal is below p (`FieldOverflow`), so no signal is reduced into another.
//!
//! A point off the curve or outside its subgroup makes the call itself fail (`InvalidProof`). A Groth16 proof can be
//! re-randomised, so a spend is keyed on its nullifier hash, never on the proof's bytes.

use crate::error::PoolError;
use crate::field;
use crate::vk;
use solana_bn254::prelude::{alt_bn128_g1_addition_be, alt_bn128_g1_multiplication_be, alt_bn128_pairing_be};

/// A proof as the release carries it: A (64), B (128), C (64), each coordinate 32 bytes big-endian, B's Fq2 parts
/// imaginary first. A is not negated.
pub const PROOF_LEN: usize = 256;

/// Groth16 verify of `proof` against the withdraw key and its 8 public signals in snarkjs order
/// `[newCommitmentHash, existingNullifierHash, withdrawnValue, stateRoot, stateTreeDepth, ASPRoot, ASPTreeDepth,
/// context]`.
pub fn verify_withdraw(proof: &[u8; PROOF_LEN], signals: &[[u8; 32]; 8]) -> Result<(), PoolError> {
    for i in 0..8 {
        let c: &[u8; 32] = proof[32 * i..32 * i + 32].try_into().unwrap();
        if !field::is_coord(c) {
            return Err(PoolError::InvalidProofEncoding);
        }
    }
    for s in signals {
        if !field::is_field(s) {
            return Err(PoolError::FieldOverflow);
        }
    }
    // -A = (x, q - y); the point at infinity (0, 0) is its own negative
    let mut neg_a = [0u8; 64];
    neg_a.copy_from_slice(&proof[0..64]);
    let ay: [u8; 32] = proof[32..64].try_into().unwrap();
    if ay != [0; 32] {
        neg_a[32..].copy_from_slice(&field::to_be(&field::sub(&field::Q, &field::from_be(&ay))));
    }
    // vk_x = IC[0] + sum(s_i * IC[i + 1])
    let mut acc = vk::IC[0];
    let mut buf = [0u8; 128];
    for (s, ic) in signals.iter().zip(&vk::IC[1..]) {
        buf[..64].copy_from_slice(ic);
        buf[64..96].copy_from_slice(s);
        let m = alt_bn128_g1_multiplication_be(&buf[..96]).map_err(|_| PoolError::InvalidProof)?;
        buf[..64].copy_from_slice(&m);
        buf[64..].copy_from_slice(&acc);
        let sum = alt_bn128_g1_addition_be(&buf).map_err(|_| PoolError::InvalidProof)?;
        acc.copy_from_slice(&sum);
    }
    // on the heap: SBF gives each function a 4 KiB stack frame
    let mut pi = vec![0u8; 4 * 192];
    pi[0..64].copy_from_slice(&neg_a);
    pi[64..192].copy_from_slice(&proof[64..192]);
    pi[192..256].copy_from_slice(&acc);
    pi[256..384].copy_from_slice(&vk::GAMMA_G2);
    pi[384..448].copy_from_slice(&proof[192..256]);
    pi[448..576].copy_from_slice(&vk::DELTA_G2);
    pi[576..640].copy_from_slice(&vk::ALPHA_G1);
    pi[640..768].copy_from_slice(&vk::BETA_G2);
    let r = alt_bn128_pairing_be(&pi).map_err(|_| PoolError::InvalidProof)?;
    // the pairing call returns 32 bytes: 1 when the product is the identity, else 0
    if r.len() != 32 || r[..31] != [0; 31] || r[31] != 1 {
        return Err(PoolError::InvalidProof);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn dec(s: &str) -> [u8; 32] {
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

    /// The vault's real withdraw proof (contracts/vault/tests/fixtures/withdraw-proof.json) in this order.
    fn fixture() -> ([u8; PROOF_LEN], [[u8; 32]; 8]) {
        let v: serde_json::Value =
            serde_json::from_str(include_str!("../../vault/tests/fixtures/withdraw-proof.json")).unwrap();
        let s = |x: &serde_json::Value| dec(x.as_str().unwrap());
        let p = &v["proof"];
        let (pa, pb, pc) = (&p["pi_a"], &p["pi_b"], &p["pi_c"]);
        let mut proof = [0u8; PROOF_LEN];
        proof[0..32].copy_from_slice(&s(&pa[0]));
        proof[32..64].copy_from_slice(&s(&pa[1]));
        // B: x.c1, x.c0, y.c1, y.c0
        proof[64..96].copy_from_slice(&s(&pb[0][1]));
        proof[96..128].copy_from_slice(&s(&pb[0][0]));
        proof[128..160].copy_from_slice(&s(&pb[1][1]));
        proof[160..192].copy_from_slice(&s(&pb[1][0]));
        proof[192..224].copy_from_slice(&s(&pc[0]));
        proof[224..256].copy_from_slice(&s(&pc[1]));
        let mut signals = [[0u8; 32]; 8];
        for (i, x) in v["publicSignals"].as_array().unwrap().iter().enumerate() {
            signals[i] = s(x);
        }
        (proof, signals)
    }

    #[test]
    fn the_vaults_real_proof_verifies() {
        let (p, s) = fixture();
        assert_eq!(verify_withdraw(&p, &s), Ok(()));
    }

    #[test]
    fn each_changed_signal_fails() {
        let (p, s) = fixture();
        for i in 0..8 {
            let mut t = s;
            t[i][31] ^= 1;
            assert_eq!(verify_withdraw(&p, &t), Err(PoolError::InvalidProof), "signal {i}");
        }
    }

    #[test]
    fn a_signal_at_or_over_p_and_a_coordinate_at_or_over_q_are_refused_before_any_curve_call() {
        let (p, s) = fixture();
        let mut t = s;
        t[7] = field::to_be(&field::P);
        assert_eq!(verify_withdraw(&p, &t), Err(PoolError::FieldOverflow));
        t[7] = [0xff; 32];
        assert_eq!(verify_withdraw(&p, &t), Err(PoolError::FieldOverflow));
        for i in 0..8 {
            // coordinate i + q: the same point written another way
            let mut q = p;
            let c = field::from_be(&q[32 * i..32 * i + 32].try_into().unwrap());
            let mut sum = [0u64; 4];
            let mut carry = 0u128;
            for k in (0..4).rev() {
                let v = c[k] as u128 + field::Q[k] as u128 + carry;
                sum[k] = v as u64;
                carry = v >> 64;
            }
            if carry != 0 {
                continue;
            }
            q[32 * i..32 * i + 32].copy_from_slice(&field::to_be(&sum));
            assert_eq!(verify_withdraw(&q, &s), Err(PoolError::InvalidProofEncoding), "coordinate {i}");
        }
    }

    /// The key here is the one in packages/kit/zk/withdraw.vkey, parsed again.
    #[test]
    fn the_key_is_withdraw_vkeys() {
        let v: serde_json::Value = serde_json::from_str(include_str!("../../../packages/kit/zk/withdraw.vkey")).unwrap();
        let g1 = |p: &serde_json::Value| {
            let mut b = [0u8; 64];
            b[..32].copy_from_slice(&dec(p[0].as_str().unwrap()));
            b[32..].copy_from_slice(&dec(p[1].as_str().unwrap()));
            b
        };
        let g2 = |p: &serde_json::Value| {
            let mut b = [0u8; 128];
            for (k, (i, j)) in [(0, 1), (0, 0), (1, 1), (1, 0)].iter().enumerate() {
                b[32 * k..32 * k + 32].copy_from_slice(&dec(p[*i][*j].as_str().unwrap()));
            }
            b
        };
        assert_eq!(g1(&v["vk_alpha_1"]), vk::ALPHA_G1);
        assert_eq!(g2(&v["vk_beta_2"]), vk::BETA_G2);
        assert_eq!(g2(&v["vk_gamma_2"]), vk::GAMMA_G2);
        assert_eq!(g2(&v["vk_delta_2"]), vk::DELTA_G2);
        let ic = v["IC"].as_array().unwrap();
        assert_eq!(ic.len(), 9);
        for (i, p) in ic.iter().enumerate() {
            assert_eq!(g1(p), vk::IC[i], "IC {i}");
        }
    }
}
