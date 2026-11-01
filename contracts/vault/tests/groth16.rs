// SPDX-License-Identifier: Apache-2.0
//! Card vault-groth16-verify, VT-U03 (vault.md 5): src/verifier.rs verifies a real withdraw proof with the generated
//! keys and refuses every changed one.
//!
//! The proof is tests/fixtures/withdraw-proof.json: snarkjs 0.7.5 made it with the pinned packages/kit/zk/withdraw.zkey,
//! and snarkjs's own verify passes it against withdraw.vkey. Unit tests run in near-sdk's mocked blockchain, whose
//! alt_bn128 calls are nearcore's own code (near-vm-runner); a changed proof must return false or fail the call,
//! never pass:
//! - one flipped bit in each coordinate of a, b and c, at five bit positions;
//! - one flipped bit in each public signal;
//! - a, b or c negated (each still a point on its curve, so the pairing itself refuses it); b's Fq2 halves swapped;
//! - a signal = p, refused before any host call (`FieldOverflow`); a coordinate + q (`InvalidProofEncoding`); a
//!   coordinate that is not a canonical decimal (`InvalidNumber`).
//!
//! With `--features sandbox` (tests/harness/run.sh) it also runs the same verifier.rs in near-sandbox 2.13.4, inside
//! the harness's probe contract, and prints the gas it burns (vault.md 2.11's row: 33.575 Tgas).

use blindfill_vault::field::{self, U256, P};
use blindfill_vault::verifier::{verify_withdraw, Proof, Q};
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{env, testing_env, Gas};
use std::panic::{catch_unwind, AssertUnwindSafe};

#[cfg(feature = "sandbox")]
#[path = "harness/mod.rs"]
mod harness;

fn fixture() -> (Proof, Vec<String>) {
    let f: Value = serde_json::from_str(include_str!("fixtures/withdraw-proof.json")).unwrap();
    let p = &f["proof"];
    let s = |v: &Value| v.as_str().unwrap().to_string();
    assert_eq!(p["protocol"], "groth16");
    assert_eq!(p["curve"], "bn128");
    assert_eq!(p["pi_a"][2], "1");
    assert_eq!(p["pi_c"][2], "1");
    assert_eq!(p["pi_b"][2], serde_json::json!(["1", "0"]));
    let proof = Proof {
        a: [s(&p["pi_a"][0]), s(&p["pi_a"][1])],
        b: [[s(&p["pi_b"][0][0]), s(&p["pi_b"][0][1])], [s(&p["pi_b"][1][0]), s(&p["pi_b"][1][1])]],
        c: [s(&p["pi_c"][0]), s(&p["pi_c"][1])],
    };
    let signals: Vec<String> = f["publicSignals"].as_array().unwrap().iter().map(s).collect();
    assert_eq!(signals.len(), 8);
    (proof, signals)
}

#[derive(Debug, PartialEq)]
enum Got {
    Pass,
    Fail,
    Panic(String),
}

/// The vault's path in a fresh mocked call with 300 Tgas: parse the signals (row 1's canonical decimal), encode the
/// proof, verify. Returns what happened and the gas the call was charged.
fn run_gas(proof: &Proof, signals: &[String]) -> (Got, u64) {
    quiet_expected_panics();
    testing_env!(VMContextBuilder::new().prepaid_gas(Gas::from_tgas(300)).build());
    let r = catch_unwind(AssertUnwindSafe(|| {
        let s: Vec<U256> = signals.iter().map(|x| field::parse_decimal(x).expect("InvalidNumber")).collect();
        verify_withdraw(&proof.encode(), &s.try_into().unwrap())
    }));
    let gas = env::used_gas().as_gas();
    let got = match r {
        Ok(true) => Got::Pass,
        Ok(false) => Got::Fail,
        Err(e) => Got::Panic(
            e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default(),
        ),
    };
    (got, gas)
}

/// The refusals these tests expect print nothing; any other panic (a failed assert) prints as usual.
fn quiet_expected_panics() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let default = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let m = info.payload().downcast_ref::<String>().map(String::as_str).or_else(|| info.payload().downcast_ref::<&str>().copied()).unwrap_or("");
            let expected = ["AltBn128InvalidInput", "InvalidProofEncoding", "InvalidNumber", "FieldOverflow"];
            if !expected.iter().any(|e| m.contains(e)) {
                default(info);
            }
        }));
    });
}

impl Got {
    /// One short word for the log: pass, fail, or the refusal's name.
    fn short(&self) -> &str {
        match self {
            Got::Pass => "PASS",
            Got::Fail => "false",
            Got::Panic(m) => ["AltBn128InvalidInput", "InvalidProofEncoding", "InvalidNumber", "FieldOverflow"]
                .into_iter()
                .find(|e| m.contains(e))
                .unwrap_or("panic"),
        }
    }
}

fn run(proof: &Proof, signals: &[String]) -> Got {
    run_gas(proof, signals).0
}

fn dec(x: &U256) -> String {
    field::to_decimal(x)
}

fn num(s: &str) -> U256 {
    field::parse_decimal(s).unwrap()
}

/// `s` with bit `bit` (0 = least significant) flipped.
fn flip(s: &str, bit: usize) -> String {
    let mut x = num(s);
    x[3 - bit / 64] ^= 1u64 << (bit % 64);
    dec(&x)
}

/// q - y, a coordinate's negative.
fn neg(s: &str) -> String {
    dec(&field::sub(&Q, &num(s)))
}

fn add_q(s: &str) -> String {
    // x + q < 2^256 for every x < q (2q < 2^255)
    let (x, mut out, mut carry) = (num(s), [0u64; 4], 0u128);
    for i in (0..4).rev() {
        let t = x[i] as u128 + Q[i] as u128 + carry;
        out[i] = t as u64;
        carry = t >> 64;
    }
    assert_eq!(carry, 0);
    dec(&out)
}

/// The eight coordinates in a fixed order, by name, for changing one at a time.
fn coord_mut(p: &mut Proof, i: usize) -> (&'static str, &mut String) {
    match i {
        0 => ("a.x", &mut p.a[0]),
        1 => ("a.y", &mut p.a[1]),
        2 => ("b.x.c0", &mut p.b[0][0]),
        3 => ("b.x.c1", &mut p.b[0][1]),
        4 => ("b.y.c0", &mut p.b[1][0]),
        5 => ("b.y.c1", &mut p.b[1][1]),
        6 => ("c.x", &mut p.c[0]),
        _ => ("c.y", &mut p.c[1]),
    }
}

#[test]
fn the_real_withdraw_proof_verifies() {
    let (proof, signals) = fixture();
    let (got, gas) = run_gas(&proof, &signals);
    assert_eq!(got, Got::Pass);
    // the mocked blockchain charges the host functions' gas, not the wasm's; the sandbox test measures the whole call
    println!("host-function gas of one verify (mocked blockchain): {:.3} Tgas", gas as f64 / 1e12);
}

#[test]
fn one_flipped_bit_in_each_coordinate_of_a_b_and_c_is_refused() {
    let (proof, signals) = fixture();
    for i in 0..8 {
        let mut line = vec![];
        let mut name = "";
        for bit in [0, 1, 64, 200, 253] {
            let mut p = proof.clone();
            let (n, x) = coord_mut(&mut p, i);
            name = n;
            *x = flip(x, bit);
            let got = run(&p, &signals);
            assert_ne!(got, Got::Pass, "{name} with bit {bit} flipped verifies");
            line.push(format!("bit {bit} {}", got.short()));
        }
        println!("{name}: {}", line.join(", "));
    }
}

#[test]
fn one_flipped_bit_in_each_public_signal_fails_the_pairing() {
    let (proof, signals) = fixture();
    for i in 0..8 {
        let mut s = signals.clone();
        s[i] = flip(&s[i], 0);
        // still below p, so the pairing itself must refuse it
        let got = run(&proof, &s);
        println!("signal {i} bit 0: {}", got.short());
        assert_eq!(got, Got::Fail, "signal {i} with bit 0 flipped");
    }
}

#[test]
fn a_changed_point_still_on_its_curve_fails_the_pairing() {
    let (proof, signals) = fixture();
    let mut p = proof.clone();
    p.a[1] = neg(&p.a[1]);
    assert_eq!(run(&p, &signals), Got::Fail, "-a");
    let mut p = proof.clone();
    p.b[1] = [neg(&p.b[1][0]), neg(&p.b[1][1])];
    assert_eq!(run(&p, &signals), Got::Fail, "-b");
    let mut p = proof.clone();
    p.c[1] = neg(&p.c[1]);
    assert_eq!(run(&p, &signals), Got::Fail, "-c");
    // b's Fq2 halves in the other order (the Solidity verifiers' order): not this point, never a pass
    let mut p = proof.clone();
    p.b[0].swap(0, 1);
    p.b[1].swap(0, 1);
    assert_ne!(run(&p, &signals), Got::Pass, "b with c0 and c1 swapped");
    // a and c in each other's place
    let mut p = proof.clone();
    std::mem::swap(&mut p.a, &mut p.c);
    assert_ne!(run(&p, &signals), Got::Pass, "a and c swapped");
}

#[test]
fn a_signal_equal_to_p_is_refused_before_any_host_call() {
    let (proof, signals) = fixture();
    let p = dec(&P);
    for i in 0..8 {
        let mut s = signals.clone();
        s[i] = p.clone();
        let (got, spent) = run_gas(&proof, &s);
        assert!(matches!(&got, Got::Panic(m) if m.contains("FieldOverflow")), "signal {i} = p: {got:?}");
        // no multiexp ran: its base cost alone (0.713 Tgas, vault.md 2.11) is far above what was charged
        assert!(spent < 100_000_000_000, "signal {i} = p: {spent} gas charged, a host call ran");
    }
}

#[test]
fn a_coordinate_plus_q_is_refused_at_parse() {
    let (proof, signals) = fixture();
    for i in 0..8 {
        let mut p = proof.clone();
        let (name, x) = coord_mut(&mut p, i);
        *x = add_q(x);
        let got = run(&p, &signals);
        assert!(matches!(&got, Got::Panic(m) if m.contains("InvalidProofEncoding")), "{name} + q: {got:?}");
    }
    // q itself, the first value refused
    let mut p = proof.clone();
    p.c[0] = dec(&Q);
    assert!(matches!(run(&p, &signals), Got::Panic(m) if m.contains("InvalidProofEncoding")));
}

#[test]
fn a_coordinate_that_is_not_a_canonical_decimal_is_refused() {
    let (proof, signals) = fixture();
    let a0 = proof.a[0].clone();
    for bad in [format!("0{a0}"), format!("+{a0}"), format!("{a0} "), String::new(), "1".repeat(79), "0x1".into()] {
        let mut p = proof.clone();
        p.a[0] = bad.clone();
        let got = run(&p, &signals);
        assert!(matches!(&got, Got::Panic(m) if m.contains("InvalidNumber")), "{bad:?}: {got:?}");
    }
}

#[test]
fn the_proof_reads_from_the_calls_json() {
    let (proof, _) = fixture();
    let j = serde_json::json!({"a": proof.a, "b": proof.b, "c": proof.c});
    assert_eq!(serde_json::from_value::<Proof>(j).unwrap(), proof);
    // snarkjs's own JSON (pi_a with its third element) is not the call's form
    let extra = serde_json::json!({"a": proof.a, "b": proof.b, "c": proof.c, "protocol": "groth16"});
    assert!(serde_json::from_value::<Proof>(extra).is_err(), "an unknown field");
    let long = serde_json::json!({"a": [&proof.a[0], &proof.a[1], "1"], "b": proof.b, "c": proof.c});
    assert!(serde_json::from_value::<Proof>(long).is_err(), "a with three elements");
    let short = serde_json::json!({"a": proof.a, "b": [&proof.b[0]], "c": proof.c});
    assert!(serde_json::from_value::<Proof>(short).is_err(), "b with one row");
}

/// The same src/verifier.rs in near-sandbox 2.13.4 (the harness's probe contract includes it by path): the real proof
/// verifies, a changed one does not, and the gas of each step is printed beside vault.md 2.11's 33.575 Tgas.
#[cfg(feature = "sandbox")]
#[tokio::test]
async fn sandbox_gas_of_one_verify() -> harness::R<()> {
    use near_sdk::serde_json::json;
    use near_workspaces::types::{Gas, NearToken};
    let h = harness::Harness::start().await?;
    let probe = h.account("probe", 30).await?;
    probe.deploy(&harness::wasm_from_env("PROBE_WASM")?).await?.into_result()?;
    let (proof, signals) = fixture();
    let call = |proof: Proof| {
        let args = json!({"proof": proof, "public_signals": signals});
        h.call_outcome(&h.root, probe.id(), "probe_verify_withdraw", args, NearToken::from_yoctonear(0), Gas::from_tgas(300))
    };
    let good = call(proof.clone()).await?;
    good.expect_all_ok("probe_verify_withdraw, the real proof")?;
    assert_eq!(good.json(), Some(json!(true)));
    let r = good.calls_exactly(probe.id(), "probe_verify_withdraw", 1)?[0];
    println!("real proof: receipt {:.3} Tgas burnt; {}", r.gas_burnt as f64 / 1e12, r.logs.join("; "));
    let mut bad = proof.clone();
    bad.a[1] = neg(&bad.a[1]);
    let o = call(bad).await?;
    o.expect_all_ok("probe_verify_withdraw, -a")?;
    assert_eq!(o.json(), Some(json!(false)), "-a verifies in the sandbox");
    let mut off = proof.clone();
    off.c[0] = flip(&off.c[0], 0);
    let o = call(off).await?;
    assert!(!o.all_ok(), "c.x bit 0 flipped: the call did not fail");
    println!("{}", h.gas_table());
    Ok(())
}
