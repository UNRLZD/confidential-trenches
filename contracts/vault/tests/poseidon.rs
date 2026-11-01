// SPDX-License-Identifier: Apache-2.0
//! VT-U01 (vault.md l.1120 at ffcba5e): the vault's Poseidon (src/poseidon.rs, the trim build) equals circomlib.
//!
//! Sources, each pinned:
//! - CL: circomlib 2.0.5 (gitHead cff5ab6288b55ef23602221694a6a38a0239dcc0), `test/poseidoncircuit.js`, which checks
//!   its circuit against circomlibjs (l.5, l.29-31).
//! - LP: light-poseidon 0.4.1 (crates.io), `tests/bn254_fq_x5.rs` l.569-582, "created with circomlibjs poseidon([1, ...])".
//! - JS: circomlibjs 0.1.7 `buildPoseidon` (npm, the reference CL's circuit test asserts against), run 2026-11-01.
//! - PP: a real Groth16 proof of Privacy Pools v1.3.0's withdraw circuit (github.com/0xbow-io/privacy-pools-core @
//!   c312dcd58f6ad085204be61923c49f8065e4e9ae, ceremony key `withdraw.vkey`), made by snarkjs 0.7.5 for the vault's gas
//!   proof (research repo `proofs/g1-vault-gas/vectors/withdraw-sandbox.json` at dcafef8) and verified again with
//!   snarkjs `groth16.verify` on 2026-11-01 (true). Its public signals are outputs of the circuit's own Poseidon:
//!   `[newCommitmentHash, existingNullifierHash, withdrawnValue, stateRoot, stateTreeDepth, ASPRoot, ASPTreeDepth,
//!   context]`. Its note secrets are test values, keccak256("g1-vault-gas/test/<tag>") mod p, never money.

use ark_bn254::Fr;
use ark_ff::{BigInt, PrimeField};
use blindfill_vault::field;
use blindfill_vault::poseidon::*;
use blindfill_vault::Bytes32;
use light_poseidon::parameters::bn254_x5::get_poseidon_parameters;
use light_poseidon::{Poseidon, PoseidonHasher};

const P_MINUS_1: &str = "21888242871839275222246405745257275088548364400416034343698204186575808495616";
const U128_MAX: &str = "340282366920938463463374607431768211455";

fn b(dec: &str) -> Bytes32 {
    field::to_be(&field::from_decimal(dec).expect("a canonical decimal"))
}

fn d(x: &Bytes32) -> String {
    field::to_decimal(&field::from_be(x))
}

fn t3(x: &str, y: &str) -> String {
    d(&PoseidonT3::new().hash(&b(x), &b(y)))
}

fn t4(x: &str, y: &str, z: &str) -> String {
    d(&PoseidonT4::new().hash(&b(x), &b(y), &b(z)))
}

/// Poseidon(x), t = 2: the vault never hashes one input (the nullifier hash is made in the circuit), so this is
/// light-poseidon's `new_circom(1)`, linked into this test only, never into the contract.
fn t2(x: &str) -> String {
    let mut h = Poseidon::<Fr>::new_circom(1).unwrap();
    let le = h.hash(&[Fr::from_bigint(BigInt(rev(field::from_decimal(x).unwrap()))).unwrap()]).unwrap().into_bigint().0;
    field::to_decimal(&rev(le))
}

fn rev(a: [u64; 4]) -> [u64; 4] {
    [a[3], a[2], a[1], a[0]]
}

#[test]
fn circomlib_circuit_vectors_t3() {
    // CL test/poseidoncircuit.js l.47-55 and l.57-65: hash([1, 2]) and hash([3, 4]) with t = 3
    assert_eq!(t3("1", "2"), "7853200120776062878684798364095072458815029376092732009249414926327459813530");
    assert_eq!(t3("3", "4"), "14763215145315200506921711489642608356394854266165572616578112107564877678998");
}

#[test]
fn light_poseidon_circomlibjs_vectors_1_2_3() {
    // LP tests/bn254_fq_x5.rs l.569-582: circomlibjs poseidon([1]), ([1, 1]), ([1, 1, 1]), 32 bytes big-endian
    let want: [[u8; 32]; 3] = [
        [
            41, 23, 97, 0, 234, 169, 98, 189, 193, 254, 108, 101, 77, 106, 60, 19, 14, 150, 164, 209, 22, 139, 51, 132,
            139, 137, 125, 197, 2, 130, 1, 51,
        ],
        [
            0, 122, 243, 70, 226, 211, 4, 39, 158, 121, 224, 169, 243, 2, 63, 119, 18, 148, 167, 138, 203, 112, 231, 63,
            144, 175, 226, 124, 173, 64, 30, 129,
        ],
        [
            2, 192, 6, 110, 16, 167, 42, 189, 43, 51, 195, 178, 20, 203, 62, 129, 188, 177, 182, 227, 9, 97, 205, 35, 194,
            2, 177, 134, 115, 191, 37, 67,
        ],
    ];
    assert_eq!(t2("1"), d(&want[0]));
    assert_eq!(PoseidonT3::new().hash(&b("1"), &b("1")), want[1]);
    assert_eq!(PoseidonT4::new().hash(&b("1"), &b("1"), &b("1")), want[2]);
}

#[test]
fn circomlibjs_edge_vectors() {
    // JS: buildPoseidon() of each input list, the field's ends (0, p - 1) and a u128 amount
    assert_eq!(t2("0"), "19014214495641488759237505126948346942972912379615652741039992445865937985820");
    assert_eq!(t2(P_MINUS_1), "3366645945435192953002076803303112651887535928162668198103357554665518664470");
    assert_eq!(t3("0", "0"), "14744269619966411208579211824598458697587494354926760081771325075741142829156");
    assert_eq!(t3(P_MINUS_1, P_MINUS_1), "20092309280547939997162506796691455192771288143174894022739895715370814071035");
    assert_eq!(t3(U128_MAX, "7"), "7785342774892090324955812289516825018755853198326525057773848155689219699245");
    assert_eq!(t4("0", "0", "0"), "5317387130258456662214331362918410991734007599705406860481038345552731150762");
    assert_eq!(
        t4(P_MINUS_1, P_MINUS_1, P_MINUS_1),
        "18683487716961139917025852198486848170447084985408220123090811624676101526002"
    );
    assert_eq!(
        t4("3000000", U128_MAX, P_MINUS_1),
        "17464584284568214961036682363067403610164183391356227311739072784604104261241"
    );
}

/// LeanIMT's root (zk-kit `InternalLeanIMT.sol`): each level hashes pairs left to right, a last node without a
/// sibling goes up unchanged.
fn lean_imt_root(leaves: &[&str]) -> String {
    let mut h = PoseidonT3::new();
    let mut level: Vec<Bytes32> = leaves.iter().map(|x| b(x)).collect();
    while level.len() > 1 {
        level = level.chunks(2).map(|p| if p.len() == 2 { h.hash(&p[0], &p[1]) } else { p[0] }).collect();
    }
    d(&level[0])
}

#[test]
fn privacy_pools_withdraw_circuit_outputs() {
    // the spent note: deposit nonce 2 (value 5,000,000), test secrets note2/nullifier and note2/secret
    let nullifier = "4579779850524055280390778785568465861362822400109572329207870005057687201925";
    let secret = "914224135872913390182505915610226579805277771944777857686344749365385427514";
    let label = "21191667877100653879994570629138790103806258137606979449794495332957801757350";
    // the change note: change1/nullifier and change1/secret
    let new_nullifier = "10531300431455255572028808184234774035054427483955976770573758788224430801565";
    let new_secret = "13660746393671925602490503333454096758168897613233407577742483964801004630494";

    // public signal 1, existingNullifierHash = Poseidon(existingNullifier) (CI/circuits/commitment.circom:24-25)
    assert_eq!(t2(nullifier), "7281711342489150522481575112946166043956948595079092888487994583093304373493");

    // the spent leaf, which the circuit rebuilds from its private inputs (commitment.circom:28-36) before the path
    let precommitment = t3(nullifier, secret);
    assert_eq!(precommitment, "14969779120028933180208860565560750638548484012025858049212778209829559433283");
    let leaf1 = t4("5000000", label, &precommitment);
    assert_eq!(leaf1, "6934397796372969182309553232815110381776553105121064848778255173544764735678");

    // public signal 0, newCommitmentHash = Poseidon(5,000,000 - 2,000,000, label, Poseidon(newNullifier, newSecret))
    assert_eq!(
        t4("3000000", label, &t3(new_nullifier, new_secret)),
        "6940248765313714341772757871390377231459381550033939610513343095017863513835"
    );

    // public signal 3, stateRoot at depth 3: the circuit hashed leaf 1's path up to it
    let state = [
        "2745018036318415825427482607362638520276197584203520672227676978686206189115",
        &leaf1,
        "21559891263720017373757671842352323241927518175652715767077796411472717506639",
        "2920386468810068099342842991376285603605564895391185562790598993053866246261",
        "5604394960401054458505058094611359979685360364192919516078354871412688837088",
    ];
    assert_eq!(lean_imt_root(&state), "19653807298226943662265677639796838143421948365569918851401674719583149753932");

    // public signal 5, ASPRoot at depth 3: the label tree of the same five deposits
    let labels = [
        "4658404729088525114212902432163076279164051564274758828674194602518397827952",
        label,
        "19085195301950382823573440056248492633217724198468949128283444450451986201927",
        "2903163937002846423513197979085383108989440865111451110121373643713873374575",
        "21849742818759825417587640575331978719810059319426080405927000061567926427032",
    ];
    assert_eq!(lean_imt_root(&labels), "14742355778095561659802612499961325813236213151846608975518831588135420342697");
}

/// The trim build's constants are light-poseidon's own: every ark and mds value and the round counts equal
/// `get_poseidon_parameters`, which `new_circom` uses, and 200 hashes per width equal `new_circom`'s.
#[test]
fn trim_equals_new_circom() {
    for (t, ark, mds, partial) in [(3usize, &ARK3[..], &MDS3[..], PARTIAL3), (4, &ARK4[..], &MDS4[..], PARTIAL4)] {
        let want = get_poseidon_parameters::<Fr>(t as u8).unwrap();
        let got = parameters(t, ark, mds, partial);
        assert_eq!(got.ark, want.ark, "ark t={t}");
        assert_eq!(got.mds, want.mds, "mds t={t}");
        assert_eq!(
            (got.full_rounds, got.partial_rounds, got.width, got.alpha),
            (want.full_rounds, want.partial_rounds, want.width, want.alpha),
            "rounds t={t}"
        );
    }
    let mut a3 = PoseidonT3::new();
    let mut a4 = PoseidonT4::new();
    let mut b3 = Poseidon::<Fr>::new_circom(2).unwrap();
    let mut b4 = Poseidon::<Fr>::new_circom(3).unwrap();
    // xorshift64 inputs, reduced mod p, so every limb is exercised
    let mut s = 0x9e37_79b9_7f4a_7c15u64;
    let mut next = || {
        let mut x = [0u64; 4];
        for limb in x.iter_mut() {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            *limb = s;
        }
        field::to_be(&field::reduce(x))
    };
    let fr = |x: &Bytes32| Fr::from_bigint(BigInt(rev(field::from_be(x)))).unwrap();
    let out = |f: Fr| field::to_be(&rev(f.into_bigint().0));
    for i in 0..200 {
        let (x, y, z) = (next(), next(), next());
        assert_eq!(a3.hash(&x, &y), out(b3.hash(&[fr(&x), fr(&y)]).unwrap()), "t=3 i={i}");
        assert_eq!(a4.hash(&x, &y, &z), out(b4.hash(&[fr(&x), fr(&y), fr(&z)]).unwrap()), "t=4 i={i}");
    }
}

/// Every input is hostile: a value at or above p is refused, never reduced (p would otherwise hash as 0).
#[test]
fn an_input_at_or_above_p_is_refused() {
    let p = field::to_be(&field::P);
    let mut p_plus_1 = p;
    p_plus_1[31] += 1;
    let max = [0xff; 32];
    let zero = [0u8; 32];
    let refused = |f: &dyn Fn()| {
        let e = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).expect_err("accepted an input >= p");
        let msg = e.downcast_ref::<String>().cloned().or(e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap();
        assert!(msg.contains("FieldOverflow"), "{msg}");
    };
    for bad in [p, p_plus_1, max] {
        refused(&|| {
            PoseidonT3::new().hash(&bad, &zero);
        });
        refused(&|| {
            PoseidonT3::new().hash(&zero, &bad);
        });
        refused(&|| {
            PoseidonT4::new().hash(&bad, &zero, &zero);
        });
        refused(&|| {
            PoseidonT4::new().hash(&zero, &bad, &zero);
        });
        refused(&|| {
            PoseidonT4::new().hash(&zero, &zero, &bad);
        });
    }
    // p - 1 is the largest input and is hashed
    PoseidonT3::new().hash(&b(P_MINUS_1), &zero);
    PoseidonT4::new().hash(&zero, &zero, &b(P_MINUS_1));
}
