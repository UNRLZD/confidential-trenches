// SPDX-License-Identifier: Apache-2.0
//! `storage_prepay(precommitment)` in near-sandbox 2.13.4 (vault.md 2.5.1; VT-S10's prepay rows, V:1137: "prepay
//! exact, short, topped up"). Runs only with `--features sandbox`, through tests/harness/run.sh
//! (`contracts/vault/tests/harness/run.sh --test prepay`); a plain `cargo test` builds this file empty.
//!
//! 1. `a_prepay_record_is_89_bytes`: a new `prepaid` record grows the vault's `storage_usage` by exactly 89 B (2.3:
//!    1 + 32 + 16 + 40); a top-up writes 0 B; the vault's very first write adds its state record once, measured.
//! 2. `exact_short_and_topped_up`: 756 B × 1e19 less one yocto is refused with nothing written and the attachment back
//!    with the payer; exactly 756 B lands; a stranger tops it up by 148 B to 904 B, the size the kit prepays whenever a
//!    tree may grow (2.10 (h)); the record holds 904 B × 1e19, read from the vault's raw state.
//! 3. `p_and_above_are_refused`: p, p + 1, 2^256 − 1 (`FieldOverflow`) and a non-canonical decimal (`InvalidNumber`)
//!    are refused with nothing written; p − 1 lands.
//! 4. `a_short_prepay_is_a_failed_receipt`: what 2.10 (i) counts toward a (U, P)'s three (V:721-726) is a
//!    `storage_prepay` that fails. Each short attachment on a new record is one failed transaction on the vault's
//!    receipt with gas burnt and nothing written, so the relayer indexing its own `storage_prepay` transactions (R7)
//!    sees each one. The vault keeps no count: it has no notion of U and no prepaid view (2.5.6). A short attachment
//!    does not close P on chain: a later full prepay on P lands, so "after a failed prepay nothing more on that P
//!    succeeds" holds for a short one only because the relayer never sends one (2.10 (i), "the relayer's own sizing").
//!
//! Each prints its gas table.
#![cfg(feature = "sandbox")]

mod harness;

use harness::{Harness, Outcome, R, YOCTO_PER_BYTE};
use near_sdk::json_types::Base64VecU8;
use near_sdk::serde_json::{self, json, Value};
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::Account;

const P: &str = "21888242871839275222246405745257275088548364400416034343698204186575808495617";
const P_PLUS_1: &str = "21888242871839275222246405745257275088548364400416034343698204186575808495618";
const P_MINUS_1: &str = "21888242871839275222246405745257275088548364400416034343698204186575808495616";
const MAX_256: &str = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
/// vault.md 2.3: `prepaid` precommitment (32) -> amount (16), 1-byte prefix, 40 B per record
const PREPAID_RECORD_BYTES: u64 = 1 + 32 + 16 + 40;
/// `Key::Prepaid`'s Borsh byte: the 13th variant of `Key` in src/lib.rs
const PREPAID_PREFIX: u8 = 12;
const DEPOSIT_STORAGE_BYTES: u64 = blindfill_vault::constants::DEPOSIT_STORAGE_BYTES;
const MIN: u128 = DEPOSIT_STORAGE_BYTES as u128 * YOCTO_PER_BYTE;
const GAS: Gas = Gas::from_tgas(30);
/// a failed call's gas costs its payer far less than this; the attachment is 7.56 milli-NEAR
const GAS_COST_BOUND: u128 = 1_000_000_000_000_000_000_000;

fn yocto(n: u128) -> NearToken {
    NearToken::from_yoctonear(n)
}

fn be32(dec: &str) -> Vec<u8> {
    let n = blindfill_vault::field::from_decimal(dec).expect("a field element");
    blindfill_vault::field::to_be(&n).to_vec()
}

async fn prepay(h: &Harness, by: &Account, p: &str, attached: u128) -> R<Outcome> {
    h.call_outcome(by, &h.vault, "storage_prepay", json!({"precommitment": p}), yocto(attached), GAS).await
}

async fn usage(h: &Harness) -> R<u64> {
    Ok(h.account_view(&h.vault, "final").await?["storage_usage"].as_u64().ok_or("no storage_usage")?)
}

/// `prepaid[p]` read from the vault's raw state at final (the vault has no prepaid view, 2.5.6), or None.
async fn record(h: &Harness, p: &str) -> R<Option<u128>> {
    let mut key = vec![PREPAID_PREFIX];
    key.extend(be32(p));
    let prefix = serde_json::to_value(Base64VecU8::from(key.clone()))?;
    let v = h
        .rpc("query", json!({"request_type": "view_state", "finality": "final", "account_id": h.vault, "prefix_base64": prefix}))
        .await?;
    let values = v["result"]["values"].as_array().ok_or_else(|| format!("view_state: {v}"))?;
    let mut found = None;
    for kv in values {
        let k: Base64VecU8 = serde_json::from_value(kv["key"].clone())?;
        if k.0 == key {
            let val: Base64VecU8 = serde_json::from_value(kv["value"].clone())?;
            let bytes: [u8; 16] = val.0.as_slice().try_into().map_err(|_| format!("prepaid value of {} B", val.0.len()))?;
            found = Some(u128::from_le_bytes(bytes));
        }
    }
    Ok(found)
}

fn failed_with(o: &Outcome, msg: &str) -> bool {
    o.failure().is_some_and(|f| f.contains(msg))
}

fn event(o: &Outcome) -> Option<Value> {
    let line = o.receipts.iter().flat_map(|r| r.logs.iter()).find(|l| l.starts_with("EVENT_JSON:"))?;
    serde_json::from_str(&line["EVENT_JSON:".len()..]).ok()
}

/// A refused prepay: the vault's error, no vault state change, no record, the attachment back with the payer.
async fn refused(h: &Harness, by: &Account, p: &str, attached: u128, msg: &str) -> R<Outcome> {
    let (u0, b0) = (usage(h).await?, h.near_balance(by.id()).await?);
    let o = prepay(h, by, p, attached).await?;
    assert!(failed_with(&o, msg), "prepay {p} with {attached}: want {msg}, got {:?}", o.status);
    o.calls_exactly(&h.vault, "storage_prepay", 1)?;
    assert!(event(&o).is_none(), "a refused prepay logged an event");
    assert_eq!(usage(h).await?, u0, "a refused prepay changed the vault's storage");
    if blindfill_vault::field::from_decimal(p).is_some() {
        assert_eq!(record(h, p).await?, None, "a refused prepay left a record");
    }
    let spent = b0 - h.near_balance(by.id()).await?;
    assert!(spent < GAS_COST_BOUND, "the payer lost {spent} yocto: the attachment did not come back");
    Ok(o)
}

#[tokio::test]
async fn a_prepay_record_is_89_bytes() -> R<()> {
    let h = Harness::start().await?;
    let _ = h.deploy_vault().await?;
    let relayer = h.account("relayer", 10).await?;

    let u0 = usage(&h).await?;
    prepay(&h, &relayer, "1", MIN).await?.expect_all_ok("the vault's first prepay")?;
    let first = usage(&h).await? - u0;
    println!("the vault's first write (a prepay): {first} B = {PREPAID_RECORD_BYTES} B record + {} B state record", first - PREPAID_RECORD_BYTES);
    assert!(first > PREPAID_RECORD_BYTES, "the first write did not add the state record");
    // the minimum prepay pays the first write whole, so a grown state record never draws on the deploy's spare NEAR
    assert!(first <= DEPOSIT_STORAGE_BYTES, "the first write, {first} B, is over the {DEPOSIT_STORAGE_BYTES} B a prepay must bring");

    let u1 = usage(&h).await?;
    prepay(&h, &relayer, "2", MIN).await?.expect_all_ok("a second prepay")?;
    let second = usage(&h).await? - u1;
    println!("a new prepaid record: {second} B (2.3: {PREPAID_RECORD_BYTES})");
    assert_eq!(second, PREPAID_RECORD_BYTES);

    let u2 = usage(&h).await?;
    prepay(&h, &relayer, "2", 148 * YOCTO_PER_BYTE).await?.expect_all_ok("a top-up")?;
    assert_eq!(usage(&h).await? - u2, 0, "a top-up wrote bytes");
    println!("a top-up: 0 B\n\ngas table\n{}", h.gas_table());
    Ok(())
}

#[tokio::test]
async fn exact_short_and_topped_up() -> R<()> {
    let h = Harness::start().await?;
    let _ = h.deploy_vault().await?;
    let relayer = h.account("relayer", 10).await?;
    let stranger = h.account("stranger", 10).await?;
    let p = "4242";

    let _ = refused(&h, &relayer, p, MIN - 1, "InsufficientStorageDeposit").await?;

    let v0 = h.near_balance(&h.vault).await?;
    let o = prepay(&h, &relayer, p, MIN).await?;
    o.expect_all_ok("exactly 756 B")?;
    assert_eq!(
        event(&o),
        Some(json!({"standard": "blindfill-vault", "version": "1.0.0", "event": "storage_prepaid",
            "data": [{"precommitment": p, "payer": relayer.id(), "amount": MIN.to_string()}]}))
    );
    assert_eq!(record(&h, p).await?, Some(MIN));
    let gained = h.near_balance(&h.vault).await? - v0;
    assert!(gained >= MIN, "the vault gained {gained} yocto, less than the attachment");

    let o = prepay(&h, &stranger, p, 148 * YOCTO_PER_BYTE).await?;
    o.expect_all_ok("the top-up to 904 B")?;
    assert_eq!(event(&o).unwrap()["data"][0]["payer"], stranger.id().as_str());
    // this call's attachment, never the record's running total (904 B)
    assert_eq!(event(&o).unwrap()["data"][0]["amount"], (148 * YOCTO_PER_BYTE).to_string());
    assert_eq!(record(&h, p).await?, Some(904 * YOCTO_PER_BYTE), "756 B + 148 B");
    println!("prepaid[{p}] = 904 B x 1e19 after 756 B by the relayer and 148 B by a stranger\n\ngas table\n{}", h.gas_table());
    Ok(())
}

#[tokio::test]
async fn p_and_above_are_refused() -> R<()> {
    let h = Harness::start().await?;
    let _ = h.deploy_vault().await?;
    let relayer = h.account("relayer", 10).await?;
    // the vault's state record first, so every refusal below is measured against a written state
    prepay(&h, &relayer, "1", MIN).await?.expect_all_ok("a first prepay")?;

    for p in [P, P_PLUS_1, MAX_256] {
        let _ = refused(&h, &relayer, p, MIN, "FieldOverflow").await?;
    }
    for p in ["0x1", "007", "-1", "1e3", ""] {
        let _ = refused(&h, &relayer, p, MIN, "InvalidNumber").await?;
    }
    prepay(&h, &relayer, P_MINUS_1, MIN).await?.expect_all_ok("p - 1")?;
    assert_eq!(record(&h, P_MINUS_1).await?, Some(MIN));
    println!("p, p + 1, 2^256 - 1 refused (FieldOverflow); non-canonical refused (InvalidNumber); p - 1 lands\n\ngas table\n{}", h.gas_table());
    Ok(())
}

#[tokio::test]
async fn a_short_prepay_is_a_failed_receipt() -> R<()> {
    let h = Harness::start().await?;
    let _ = h.deploy_vault().await?;
    let relayer = h.account("relayer", 10).await?;
    prepay(&h, &relayer, "1", MIN).await?.expect_all_ok("a first prepay")?;
    let p = "777";

    // three short prepays on one P: each is its own failed transaction, failed on the vault's receipt with gas burnt
    for (i, short) in [0, MIN / 2, MIN - 1].into_iter().enumerate() {
        let o = refused(&h, &relayer, p, short, "InsufficientStorageDeposit").await?;
        let f = o.failures();
        assert!(f.iter().any(|r| r.executor == h.vault.as_str() && r.gas_burnt > 0), "failed prepay {i}: no failed vault receipt");
        println!("failed prepay {} ({short} yocto): tx {} failed on the vault, {:.3} Tgas", i + 1, o.tx_hash, f[0].gas_burnt as f64 / 1e12);
    }
    // the chain does not close P after a short prepay: a full one lands (the relayer's count, not the vault, ends it)
    prepay(&h, &relayer, p, MIN).await?.expect_all_ok("a full prepay after three short ones")?;
    assert_eq!(record(&h, p).await?, Some(MIN));
    println!("\ngas table\n{}", h.gas_table());
    Ok(())
}
