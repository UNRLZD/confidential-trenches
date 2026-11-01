// SPDX-License-Identifier: Apache-2.0
//! Card vault-vkey-constants: src/verifier_keys.rs, made by scripts/gen-vkey.mjs, against the pinned .vkey files.
//!
//! - Every number of every key decodes back from the constants to the .vkey file, and each file is the pinned one.
//! - NEAR's own alt_bn128 code reads every point: near-sdk's mocked blockchain runs near-vm-runner 0.37.4
//!   (src/logic/alt_bn128.rs), the decoder nearcore's host functions use. A G1 constant comes back byte for byte from
//!   `alt_bn128_g1_sum`; a G2 constant must pass a pairing, which an Fq2 swap breaks (the point leaves the curve).
//! - A real proof of each circuit verifies against the constants through the vault's own src/verifier.rs, and the same
//!   proof with one public signal changed does not. Only a real proof shows the whole encoding is right (VT-U03).
//! - The generator, run again with --check, finds no difference; and it refuses a .vkey that is not the pinned one.

use blindfill_vault::field::{self, U256};
use blindfill_vault::verifier;
use blindfill_vault::verifier_keys::{
    VerifyingKey, COMMITMENT, COMMITMENT_VKEY_SHA256, WITHDRAW, WITHDRAW_VKEY_SHA256,
};
use near_sdk::env;
use near_sdk::serde_json::{self, json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn vkey(name: &str) -> (Vec<u8>, Value) {
    let raw = std::fs::read(repo().join("packages/kit/zk").join(name)).unwrap();
    let v = serde_json::from_slice(&raw).unwrap();
    (raw, v)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// 32 little-endian bytes as a decimal string.
fn dec(le: &[u8]) -> String {
    let mut be = [0u8; 32];
    for (i, b) in le.iter().enumerate() {
        be[31 - i] = *b;
    }
    field::to_decimal(&field::from_be(&be))
}

/// A G1 constant decoded as snarkjs writes it: [x, y, "1"].
fn g1_json(p: &[u8; 64]) -> Value {
    json!([dec(&p[..32]), dec(&p[32..]), "1"])
}

/// A G2 constant decoded as snarkjs writes it: [[x.c0, x.c1], [y.c0, y.c1], ["1", "0"]].
fn g2_json(p: &[u8; 128]) -> Value {
    json!([
        [dec(&p[..32]), dec(&p[32..64])],
        [dec(&p[64..96]), dec(&p[96..])],
        ["1", "0"]
    ])
}

fn decodes_to_file<const N: usize>(k: &VerifyingKey<N>, file: &str, sha: &str) {
    let (raw, v) = vkey(file);
    assert_eq!(
        hex(&env::sha256(&raw)),
        sha,
        "{file} is not the file the constants were made from"
    );
    assert_eq!(v["protocol"], "groth16");
    assert_eq!(v["curve"], "bn128");
    assert_eq!(v["nPublic"], json!(N - 1), "{file}: nPublic");
    assert_eq!(g1_json(&k.alpha_g1), v["vk_alpha_1"], "{file}: vk_alpha_1");
    assert_eq!(g2_json(&k.beta_g2), v["vk_beta_2"], "{file}: vk_beta_2");
    assert_eq!(g2_json(&k.gamma_g2), v["vk_gamma_2"], "{file}: vk_gamma_2");
    assert_eq!(g2_json(&k.delta_g2), v["vk_delta_2"], "{file}: vk_delta_2");
    let ic = v["IC"].as_array().unwrap();
    assert_eq!(ic.len(), N, "{file}: IC length");
    for (i, p) in k.ic.iter().enumerate() {
        assert_eq!(&g1_json(p), &ic[i], "{file}: IC[{i}]");
    }
    // vk_alphabeta_12 is e(alpha, beta), which snarkjs precomputes; the vault pairs alpha and beta itself, so it is not
    // a constant.
}

#[test]
fn withdraw_constants_decode_to_the_pinned_vkey() {
    decodes_to_file(&WITHDRAW, "withdraw.vkey", WITHDRAW_VKEY_SHA256);
}

#[test]
fn commitment_constants_decode_to_the_pinned_vkey() {
    decodes_to_file(&COMMITMENT, "commitment.vkey", COMMITMENT_VKEY_SHA256);
}

/// -P through NEAR's g1_sum (sign byte 1 = minus).
fn neg(p: &[u8; 64]) -> Vec<u8> {
    let mut b = vec![1u8];
    b.extend_from_slice(p);
    env::alt_bn128_g1_sum(&b)
}

fn g1_gen() -> [u8; 64] {
    let mut g = [0u8; 64];
    g[0] = 1;
    g[32] = 2;
    g
}

fn points_read_by_near<const N: usize>(k: &VerifyingKey<N>) {
    for p in [&k.alpha_g1].into_iter().chain(k.ic.iter()) {
        let mut b = vec![0u8];
        b.extend_from_slice(p);
        assert_eq!(
            env::alt_bn128_g1_sum(&b),
            p.to_vec(),
            "a G1 constant is not NEAR's encoding of itself"
        );
    }
    for q in [&k.beta_g2, &k.gamma_g2, &k.delta_g2] {
        // e(G, Q) e(-G, Q) = 1 holds for every Q that NEAR decodes as a point
        let mut b = g1_gen().to_vec();
        b.extend_from_slice(q);
        b.extend_from_slice(&neg(&g1_gen()));
        b.extend_from_slice(q);
        assert!(env::alt_bn128_pairing_check(&b));
    }
}

#[test]
fn every_point_is_read_by_nears_alt_bn128() {
    points_read_by_near(&WITHDRAW);
    points_read_by_near(&COMMITMENT);
}

struct Proof {
    a: [&'static str; 2],
    b: [[&'static str; 2]; 2],
    c: [&'static str; 2],
}

/// The vault's own check (src/verifier.rs `verify`) on a proof and its decimal signals.
fn verify<const N: usize>(k: &VerifyingKey<N>, p: &Proof, signals: &[&str]) -> bool {
    let st = |x: &str| x.to_string();
    let proof = verifier::Proof { a: p.a.map(st), b: p.b.map(|r| r.map(st)), c: p.c.map(st) };
    let signals: Vec<U256> = signals.iter().map(|x| field::from_decimal(x).unwrap()).collect();
    verifier::verify(k, &proof.encode(), &signals)
}

// A real Privacy Pools v1.3.0 withdraw proof made with the pinned withdraw.zkey (test notes only): the research repo's
// proofs/g1-vault-gas/vectors/withdraw-sandbox.json (`proof`, `publicSignals`), made by its prover/prove.mjs at
// 93d7d24; it passed the G1 contract in near-sandbox 2.13.4 and on testnet, and snarkjs 0.7.5's groth16.verify against
// packages/kit/zk/withdraw.vkey (re-run 2026-11-01). Signals: [newCommitmentHash, existingNullifierHash,
// withdrawnValue, stateRoot, stateTreeDepth, ASPRoot, ASPTreeDepth, context].
const WITHDRAW_PROOF: Proof = Proof {
    a: [
        "2787928839905403651450241091567397303504080875902608836646773310836041004585",
        "14009281238143880762828494218276471223813784799039942610780670133330419251103",
    ],
    b: [
        [
            "4621702792543135995411521966462693874033010169256141352303469678685255642835",
            "21431187029878844081189465967013668496104336834869106408120244095665111698922",
        ],
        [
            "5671474744059865948731278936856192353966173967137888504055427531989607562033",
            "19669908714034935927883519039784910677789957804782405420920970962870835176355",
        ],
    ],
    c: [
        "1781203845616027826054401700731492812360667421887488785057999326308607623541",
        "2809802975330351083513995532615096686646381557958049769987743265986779633256",
    ],
};
const WITHDRAW_SIGNALS: [&str; 8] = [
    "6940248765313714341772757871390377231459381550033939610513343095017863513835",
    "7281711342489150522481575112946166043956948595079092888487994583093304373493",
    "2000000",
    "19653807298226943662265677639796838143421948365569918851401674719583149753932",
    "3",
    "14742355778095561659802612499961325813236213151846608975518831588135420342697",
    "3",
    "802377141111801993956095990454547848147819793756653330486998369192452016786",
];

// A real commitment proof (the ragequit circuit) made with the pinned commitment.wasm and commitment.zkey by snarkjs
// 0.7.5 groth16.fullProve on 2026-11-01, test inputs value 1000000, label 2, nullifier 3, secret 4; snarkjs's verify
// against commitment.vkey passed. Signals: [commitment, nullifierHash, value, label].
const COMMITMENT_PROOF: Proof = Proof {
    a: [
        "5082064059914805146632675550669381597061863007124191693244098251273799476750",
        "7602420741945164490259129471948467878794453685690953095403371742347216883736",
    ],
    b: [
        [
            "429537029293954172588109891638953067953181836730077992925109853194586009910",
            "8402391503335386765964108096448294684886562034205883043961631740869595582065",
        ],
        [
            "18096085907765544983690960419794228430059913282770351064091455175336282779491",
            "1571323512779677450550827882062821717199821593562291361586812587193369135990",
        ],
    ],
    c: [
        "12091940622409986179588624093413967246173240274461697909765713143562573449510",
        "10391252256832951778317449937951629640385682451440687435569560106620143693629",
    ],
};
const COMMITMENT_SIGNALS: [&str; 4] = [
    "14017508109828557045353107267770299420900918903210455698751722276766860142487",
    "6018413527099068561047958932369318610297162528491556075919075208700178480084",
    "1000000",
    "2",
];

#[test]
fn a_real_withdraw_proof_verifies_and_a_changed_signal_does_not() {
    assert!(verify(&WITHDRAW, &WITHDRAW_PROOF, &WITHDRAW_SIGNALS));
    let mut wrong = WITHDRAW_SIGNALS;
    wrong[2] = "2000001"; // withdrawnValue
    assert!(!verify(&WITHDRAW, &WITHDRAW_PROOF, &wrong));
}

#[test]
fn a_real_commitment_proof_verifies_and_a_changed_signal_does_not() {
    assert!(verify(&COMMITMENT, &COMMITMENT_PROOF, &COMMITMENT_SIGNALS));
    let mut wrong = COMMITMENT_SIGNALS;
    wrong[2] = "1000001"; // value
    assert!(!verify(&COMMITMENT, &COMMITMENT_PROOF, &wrong));
}

fn gen(root: &Path) -> std::process::Output {
    Command::new("node")
        .arg(root.join("contracts/vault/scripts/gen-vkey.mjs"))
        .arg("--check")
        .output()
        .expect("this test runs the generator with node (Node 24, the repo's engine)")
}

#[test]
fn the_generator_run_again_gives_no_diff() {
    let out = gen(&repo());
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn the_generator_refuses_a_vkey_that_is_not_the_pinned_one() {
    // A copy of the generator, the pins, both keys and the constants in the repo's layout, in a temp folder.
    let copy = |tamper: bool| -> std::process::Output {
        let root = std::env::temp_dir().join(format!("vkey-gen-{}-{tamper}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for f in [
            "contracts/vault/scripts/gen-vkey.mjs",
            "contracts/vault/src/verifier_keys.rs",
            "packages/kit/src/zk/setup-files.ts",
            "packages/kit/zk/withdraw.vkey",
            "packages/kit/zk/commitment.vkey",
        ] {
            let to = root.join(f);
            std::fs::create_dir_all(to.parent().unwrap()).unwrap();
            std::fs::copy(repo().join(f), &to).unwrap();
        }
        if tamper {
            // one digit of vk_alpha_1's x, the size unchanged: only the sha256 tells
            let p = root.join("packages/kit/zk/withdraw.vkey");
            let (_, v) = vkey("withdraw.vkey");
            let x = v["vk_alpha_1"][0].as_str().unwrap().to_string();
            let last = x.as_bytes()[x.len() - 1];
            let y = format!(
                "{}{}",
                &x[..x.len() - 1],
                if last == b'9' {
                    '8'
                } else {
                    (last + 1) as char
                }
            );
            let s = std::fs::read_to_string(&p).unwrap().replacen(&x, &y, 1);
            std::fs::write(&p, s).unwrap();
        }
        let out = gen(&root);
        std::fs::remove_dir_all(&root).unwrap();
        out
    };
    let good = copy(false);
    assert!(
        good.status.success(),
        "{}",
        String::from_utf8_lossy(&good.stderr)
    );
    let bad = copy(true);
    assert!(!bad.status.success());
    let err = String::from_utf8_lossy(&bad.stderr);
    assert!(err.contains("withdraw.vkey: refused"), "{err}");
}
