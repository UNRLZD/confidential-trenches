// SPDX-License-Identifier: Apache-2.0
//! `withdraw`'s parse and check part (vault.md 2.5.2 rows 1-3, card vault-withdraw-context) in near-sandbox 2.13.4,
//! through the merged harness: VT-S07 (V:1134) and VT-S18 (V:1145). Runs only with `--features sandbox`, through
//! tests/harness/run.sh (`contracts/vault/tests/harness/run.sh --test withdraw_context`); a plain `cargo test` builds
//! this file empty.
//!
//! The vault here has no deposit, so a request that passes rows 1-3 is refused at row 5 with `UnknownStateRoot` (its
//! state root signal is 4, a root no tree has had): "accepted" here reads as that panic and "refused" as the named
//! check's; tests/withdraw_spend.rs runs rows 4-12 with real proofs. No proof is
//! verified: the proof only has to parse (row 1), and each case's context is made by the vault's own src/context.rs,
//! whose bytes equal the kit's on VT-U02's vectors (src/context.rs and src/withdraw.rs unit tests).
//!
//! 1. `vt_s07_each_field_changed_after_proving_is_refused`: the proof carries one request's context; the call then
//!    changes recipient, `register_deposit`, fee recipient, `relay_fee`, refund precommitment, deadline, `salt`, or the
//!    processor the proof was made for. Each is refused with `ContextMismatch`, the unchanged request passes rows 1-3,
//!    and the vault's raw state is the same bytes before and after (nothing spent: `spent` has no row). A recipient or
//!    fee recipient that is the vault or intents.near, with its own context, is refused with `InvalidRecipient`.
//! 2. `vt_s18_one_block_after_the_deadline_is_refused_and_at_it_passes`: the probe contract sends `withdraw` calls
//!    whose `deadline_ms` is the probe's own block time plus an offset; each lands in a later block, whose time the
//!    vault reads. Offset 0 is a deadline one block before the block it lands in: refused with `DeadlineExpired`. Then
//!    rounds of offsets around the measured block interval until one lands in a block whose time in ms equals its
//!    deadline: it passes. Every call in every round is checked against the rule `block ms <= deadline_ms`, with the
//!    landing block's time read from RPC (`timestamp_nanosec` / 1,000,000, rounded down: what the vault reads).
//!
//! 3. `extra_top_level_arguments_are_refused_at_parse`: a fourth top-level key is refused when the input is read.
//!
//! Each prints its gas table: `vault::withdraw` under failed receipts is the parse and check part's gas.
#![cfg(feature = "sandbox")]

mod harness;

use blindfill_vault::context::{context_of, salt_from_hex, ContextFields};
use blindfill_vault::field;
use harness::{wasm_from_env, Harness, Outcome, R};
use near_sdk::json_types::Base64VecU8;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId};

/// withdraw's attached NEAR for this request (7.1): (710 + 389) × 1e19 + register_deposit + 2 yocto (two transfers).
const REGISTER_DEPOSIT: u128 = 1_250_000_000_000_000_000_000;
const ATTACHED: u128 = 1_099 * 10_000_000_000_000_000_000 + REGISTER_DEPOSIT + 2;
const GAS: Gas = Gas::from_tgas(300);

/// The vault's whole raw state at final, as (key, value) base64 pairs in key order.
async fn vault_state(h: &Harness) -> R<Vec<(String, String)>> {
    let v = h.rpc("query", json!({"request_type": "view_state", "finality": "final", "account_id": h.vault, "prefix_base64": ""})).await?;
    let values = v["result"]["values"].as_array().ok_or_else(|| format!("view_state: {v}"))?;
    let mut kv: Vec<(String, String)> = values
        .iter()
        .map(|e| (e["key"].as_str().unwrap_or_default().to_string(), e["value"].as_str().unwrap_or_default().to_string()))
        .collect();
    kv.sort();
    Ok(kv)
}

/// The vault's scope, from its own `config()`.
async fn scope(h: &Harness) -> R<field::U256> {
    let c = h.view(&h.vault, "config", json!({})).await?;
    Ok(field::from_decimal(c["scope"].as_str().ok_or("config: no scope")?).ok_or("config: scope not a field element")?)
}

/// The request's context for `processor` and `scope`, by the vault's own src/context.rs, as a decimal.
fn context(w: &Value, processor: &str, scope: &field::U256) -> String {
    testing_env!(VMContextBuilder::new().build());
    let st = |k: &str| w[k].as_str().unwrap().to_string();
    let fields = ContextFields {
        processor: processor.parse().unwrap(),
        recipient: st("recipient").parse().unwrap(),
        register_deposit: st("register_deposit").parse().unwrap(),
        fee_recipient: st("fee_recipient").parse().unwrap(),
        relay_fee: st("relay_fee").parse().unwrap(),
        refund_precommitment: field::to_be(&field::from_decimal(&st("refund_precommitment")).unwrap()),
        deadline_ms: w["deadline_ms"].as_u64().unwrap(),
        salt: salt_from_hex(&st("salt")).unwrap(),
    };
    field::to_decimal(&context_of(&fields, scope))
}

fn call_args(w: &Value, ctx: &str) -> Value {
    json!({
        "withdrawal": w,
        "proof": {"a": ["1", "2"], "b": [["3", "4"], ["5", "6"]], "c": ["7", "8"]},
        "public_signals": ["1", "2", "3", "4", "5", "6", "7", ctx],
    })
}

/// The vault's one `withdraw` receipt in `o`, its panic's text.
fn withdraw_failure(h: &Harness, o: &Outcome) -> R<String> {
    let r = o.calls_exactly(&h.vault, "withdraw", 1)?[0];
    Ok(r.failure().ok_or_else(|| format!("withdraw returned: {}", r.line()))?.to_string())
}

/// A request to `relayer`'s and `bob`'s accounts, its deadline 10 minutes ahead of the latest final block.
async fn request(h: &Harness, bob: &AccountId, relayer: &AccountId) -> R<Value> {
    let b = h.rpc("block", json!({"finality": "final"})).await?;
    let ns: u64 = b["result"]["header"]["timestamp_nanosec"].as_str().ok_or("block: no timestamp_nanosec")?.parse()?;
    Ok(json!({
        "recipient": bob,
        "register_deposit": REGISTER_DEPOSIT.to_string(),
        "fee_recipient": relayer,
        "relay_fee": "30000",
        "refund_precommitment": "123456789012345678901234567890",
        "deadline_ms": ns / 1_000_000 + 600_000,
        "salt": "0123456789abcdef0123456789abcdef",
    }))
}

#[tokio::test]
async fn vt_s07_each_field_changed_after_proving_is_refused() -> R<()> {
    let h = Harness::start().await?;
    let _ = h.deploy_vault().await?;
    let relayer = h.account("relayer", 50).await?;
    let bob: AccountId = format!("bob.{}", h.root.id()).parse()?;
    let sc = scope(&h).await?;
    let w = request(&h, &bob, relayer.id()).await?;
    let ctx = context(&w, h.vault.as_str(), &sc);
    let before = vault_state(&h).await?;

    // the unchanged request passes rows 1-3
    let o = h.call_outcome(&relayer, &h.vault, "withdraw", call_args(&w, &ctx), NearToken::from_yoctonear(ATTACHED), GAS).await?;
    let f = withdraw_failure(&h, &o)?;
    assert!(f.contains("UnknownStateRoot"), "the unchanged request: {f}");
    println!("unchanged: passed rows 1-3, {:.3} Tgas", o.calls_exactly(&h.vault, "withdraw", 1)?[0].gas_burnt as f64 / 1e12);

    let set = |k: &str, v: Value| {
        let mut c = w.clone();
        c[k] = v;
        c
    };
    let deadline = w["deadline_ms"].as_u64().unwrap();
    let cases: Vec<(&str, Value, String)> = vec![
        ("recipient", set("recipient", json!(format!("thief.{}", h.root.id()))), ctx.clone()),
        ("register_deposit", set("register_deposit", json!("0")), ctx.clone()),
        ("fee_recipient", set("fee_recipient", json!(format!("other-relayer.{}", h.root.id()))), ctx.clone()),
        ("relay_fee", set("relay_fee", json!("30001")), ctx.clone()),
        ("refund_precommitment", set("refund_precommitment", json!("123456789012345678901234567891")), ctx.clone()),
        ("deadline_ms", set("deadline_ms", json!(deadline + 60_000)), ctx.clone()),
        ("salt", set("salt", json!("0123456789abcdef0123456789abcdee")), ctx.clone()),
        // a proof made for another vault: its context names that vault as processor
        ("processor", w.clone(), context(&w, &format!("other-vault.{}", h.root.id()), &sc)),
    ];
    for (name, req, proof_ctx) in &cases {
        let o = h.call_outcome(&relayer, &h.vault, "withdraw", call_args(req, proof_ctx), NearToken::from_yoctonear(ATTACHED), GAS).await?;
        let f = withdraw_failure(&h, &o).map_err(|e| format!("{name}: {e}"))?;
        assert!(f.contains("ContextMismatch"), "{name} changed: want ContextMismatch, got {f}");
        assert_eq!(vault_state(&h).await?, before, "{name}: a state byte changed");
        println!("{name} changed: refused (ContextMismatch), {:.3} Tgas", o.calls_exactly(&h.vault, "withdraw", 1)?[0].gas_burnt as f64 / 1e12);
    }
    // a payee that is the vault or intents.near, with the context that request carries: row 2 refuses it
    for (k, payee) in [("recipient", h.vault.to_string()), ("recipient", "intents.near".into()), ("fee_recipient", h.vault.to_string()), ("fee_recipient", "intents.near".into())] {
        let req = set(k, json!(payee));
        let o = h.call_outcome(&relayer, &h.vault, "withdraw", call_args(&req, &context(&req, h.vault.as_str(), &sc)), NearToken::from_yoctonear(ATTACHED), GAS).await?;
        let f = withdraw_failure(&h, &o).map_err(|e| format!("{k} = {payee}: {e}"))?;
        assert!(f.contains(&format!("InvalidRecipient: {k} is")), "{k} = {payee}: want InvalidRecipient, got {f}");
        assert_eq!(vault_state(&h).await?, before, "{k} = {payee}: a state byte changed");
        println!("{k} = {payee}: refused (InvalidRecipient)");
    }
    assert_eq!(h.view(&h.vault, "spends", json!({"from": 0, "limit": 10})).await?, json!([]), "a spend was written");
    assert_eq!(vault_state(&h).await?, before, "a state byte changed");
    println!("{}", h.gas_table());
    Ok(())
}

/// The call carries exactly withdraw's three arguments: a fourth top-level key (`processor`, `extra`) is refused when
/// near-sdk reads the input (`#[deny_unknown_arguments]`), before the state is read or any row runs.
#[tokio::test]
async fn extra_top_level_arguments_are_refused_at_parse() -> R<()> {
    let h = Harness::start().await?;
    let _ = h.deploy_vault().await?;
    let relayer = h.account("relayer", 50).await?;
    let bob: AccountId = format!("bob.{}", h.root.id()).parse()?;
    let sc = scope(&h).await?;
    let w = request(&h, &bob, relayer.id()).await?;
    let ctx = context(&w, h.vault.as_str(), &sc);
    let before = vault_state(&h).await?;
    for (k, v) in [("processor", json!(format!("other-vault.{}", h.root.id()))), ("extra", json!(1))] {
        let mut args = call_args(&w, &ctx);
        args[k] = v;
        let o = h.call_outcome(&relayer, &h.vault, "withdraw", args, NearToken::from_yoctonear(ATTACHED), GAS).await?;
        let f = withdraw_failure(&h, &o)?;
        assert!(f.contains("Failed to deserialize input from JSON"), "top-level {k}: want the input refused, got {f}");
        assert_eq!(vault_state(&h).await?, before, "top-level {k}: a state byte changed");
        println!("top-level {k}: refused at parse, {:.3} Tgas", o.calls_exactly(&h.vault, "withdraw", 1)?[0].gas_burnt as f64 / 1e12);
    }
    // the same request without them reaches rows 1-3 and passes them
    let o = h.call_outcome(&relayer, &h.vault, "withdraw", call_args(&w, &ctx), NearToken::from_yoctonear(ATTACHED), GAS).await?;
    assert!(withdraw_failure(&h, &o)?.contains("UnknownStateRoot"));
    println!("{}", h.gas_table());
    Ok(())
}

/// One probe call: `withdraw` calls with deadlines at the probe's block time + each offset. Returns the probe's block
/// time in ms and, per vault receipt, (its deadline, its landing block's ms, its panic text).
async fn probe_round(h: &Harness, probe: &Account, w: &Value, sc: &str, offsets: &[u64]) -> R<(u64, Vec<(u64, u64, String)>)> {
    let args = json!({"vault": h.vault, "scope": sc, "withdrawal": w, "offsets_ms": offsets, "gas_tgas": 10});
    let o = h.call_outcome(&h.root, probe.id(), "probe_withdraw_deadlines", args, NearToken::from_yoctonear(0), GAS).await?;
    let p = o.calls_exactly(probe.id(), "probe_withdraw_deadlines", 1)?[0];
    if !p.ok() {
        return Err(format!("the probe failed: {}", p.line()).into());
    }
    let sent = p.logs.iter().find_map(|l| l.strip_prefix("block_ms ")).ok_or("the probe logged no block_ms")?.parse::<u64>()?;
    assert_eq!(h.block_ms(&p.block_hash).await?, sent, "the probe's block time is not its block's");
    let mut out = vec![];
    for r in o.calls_exactly(&h.vault, "withdraw", offsets.len())? {
        let raw: Base64VecU8 = serde_json::from_value(Value::String(r.args[0].clone()))?;
        let call: Value = serde_json::from_slice(&raw.0)?;
        let deadline = call["withdrawal"]["deadline_ms"].as_u64().ok_or("no deadline_ms in the call")?;
        let landed = h.block_ms(&r.block_hash).await?;
        out.push((deadline, landed, r.failure().ok_or_else(|| format!("withdraw returned: {}", r.line()))?.to_string()));
    }
    Ok((sent, out))
}

#[tokio::test]
async fn vt_s18_one_block_after_the_deadline_is_refused_and_at_it_passes() -> R<()> {
    let h = Harness::start().await?;
    let _ = h.deploy_vault().await?;
    let probe = h.account("probe", 30).await?;
    probe.deploy(&wasm_from_env("PROBE_WASM")?).await?.into_result()?;
    let bob: AccountId = format!("bob.{}", h.root.id()).parse()?;
    let relayer: AccountId = format!("relayer.{}", h.root.id()).parse()?;
    let sc = field::to_decimal(&scope(&h).await?);
    let w = request(&h, &bob, &relayer).await?;
    let before = vault_state(&h).await?;

    // one block after: the deadline is the probe's block, the call lands in a later one
    let (sent, got) = probe_round(&h, &probe, &w, &sc, &[0]).await?;
    let (deadline, landed, f) = &got[0];
    assert_eq!(*deadline, sent);
    assert!(landed > deadline, "the call landed at {landed} ms, not after its deadline {deadline}");
    assert!(f.contains(&format!("DeadlineExpired: block time {landed} ms is past deadline_ms {deadline}")), "one block after: {f}");
    assert_eq!(vault_state(&h).await?, before, "a refused late request changed a state byte");
    println!("one block after: deadline {deadline} ms, landed {landed} ms (+{} ms): refused (DeadlineExpired)", landed - deadline);

    // at the deadline: rounds of offsets around the block intervals seen so far, until one lands at its deadline
    let mut gaps = vec![landed - deadline];
    let (mut at, mut one_ms_late) = (None, None);
    for round in 1..=12 {
        let (lo, hi) = (*gaps.iter().min().unwrap(), *gaps.iter().max().unwrap());
        let mid = (lo + hi) / 2;
        let offsets: Vec<u64> = (mid.saturating_sub(7)..=mid + 7).collect();
        let (sent, got) = probe_round(&h, &probe, &w, &sc, &offsets).await?;
        for (deadline, landed, f) in &got {
            let want = if landed <= deadline { "UnknownStateRoot" } else { "DeadlineExpired" };
            assert!(f.contains(want), "deadline {deadline} ms, landed {landed} ms: want {want}, got {f}");
            if landed == deadline {
                at = Some((*deadline, f.clone()));
            }
            if *landed == deadline + 1 {
                one_ms_late = Some((*deadline, f.clone()));
            }
            gaps.push(landed - sent);
        }
        let landed: Vec<u64> = got.iter().map(|g| g.1).collect();
        println!("round {round}: probe block {sent} ms, offsets {}..={}, landed {:?} ms", offsets[0], offsets[offsets.len() - 1], landed);
        if at.is_some() && one_ms_late.is_some() {
            break;
        }
    }
    let (d, f) = at.ok_or("no call landed in a block whose time equals its deadline in 12 rounds")?;
    assert!(f.contains("UnknownStateRoot"), "at the deadline: {f}");
    println!("at the deadline: deadline {d} ms = the landing block's ms: passed rows 1-3 (UnknownStateRoot)");
    if let Some((d, f)) = one_ms_late {
        assert!(f.contains("DeadlineExpired"), "1 ms after: {f}");
        println!("1 ms after the deadline: deadline {d} ms, landed {} ms: refused (DeadlineExpired)", d + 1);
    }
    assert_eq!(vault_state(&h).await?, before, "a state byte changed");
    println!("{}", h.gas_table());
    Ok(())
}
