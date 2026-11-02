// SPDX-License-Identifier: Apache-2.0
//! `withdraw`'s rows 4-12 (vault.md 2.5.2: the depths, both roots, the amount checks, the Groth16 proof, the nullifier
//! and the change leaf; card vault-withdraw-verify) in near-sandbox 2.13.4 with real proofs: VT-S05 (V:1132) and
//! VT-S06 (V:1133). Runs only with `--features sandbox`, through tests/harness/run.sh
//! (`contracts/vault/tests/harness/run.sh --test withdraw_spend`); a plain `cargo test` builds this file empty.
//!
//! The proofs are tests/fixtures/withdraw-spends.json (the kit's input builder and snarkjs, made by
//! make-withdraw-spends.mjs) over six test deposits on vault.test.near, the harness's vault. The six deposits' tree
//! state is made by the vault's own tree code (`insert_commitment`, `insert_label`) in near-sdk's mocked chain at
//! vault.test.near, with `deposited` their sum, and put into the deployed vault by the sandbox's state patch, so these
//! tests need no token and no prepay; the account's storage use is raised by exactly those records' bytes. The
//! vault's code comes only from the 2.8 deploy recipe. Deposits through `ft_on_transfer` are tests/s02.rs's.
//!
//! 1. `vt_s05_one_nullifier_spends_once`: the same call twice; a second proof with the same nullifier; two proofs of
//!    one nullifier sent at once by two relayers, landing in one block. Each time exactly one succeeds and the others
//!    are refused with `NullifierAlreadySpent`; a refused call changes no byte of the vault's state and logs nothing.
//! 2. `vt_s06_unknown_zero_and_other_vault_roots_are_refused`: a state root or ASP root that is unknown, 0, or another
//!    vault's (the same notes under another scope) is refused (`UnknownStateRoot`, `UnknownLabelRoot`) with no byte
//!    changed; a proof against an older root (4 of the 6 deposits) lands.
//! 3. `rows_4_and_7_to_10_refuse_and_a_landed_call_writes_its_bytes`: rows 4, 7, 8, 9 and 10 refuse with no state byte,
//!    no storage use and no log changed; three landed calls each write 2.3's bytes for their account ids (+74 B when
//!    the state tree grows a level) and log exactly `leaf_inserted`, `withdrawn` then `withdrawal_relayed`.
//!
//! No token is deployed at TOKEN here, so both payout parts of a landed withdrawal fail and `on_payout` turns them
//! into a refund-pending amount (the payouts themselves are tests/payouts.rs'). Each call attaches 1 NEAR, over row
//! 14's charge. Each test prints its gas table: `vault::withdraw` is the vault's own work through the payouts' promises,
//! against vault.md 2.11's 41.202-41.828 Tgas at depth 3.
#![cfg(feature = "sandbox")]

mod harness;

use blindfill_vault::poseidon::PoseidonT3;
use blindfill_vault::{field, Bytes32, Vault};
use harness::{Harness, Outcome, R};
use near_sdk::json_types::Base64VecU8;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{env, testing_env};
use near_workspaces::types::{AccountDetailsPatch, Gas, NearToken};
use near_workspaces::Account;

const SPENDS: &str = include_str!("fixtures/withdraw-spends.json");
const GAS: Gas = Gas::from_tgas(300);
/// Over row 14's charge: (at most 784 B + REFUND_RESERVE_BYTES) x 1e19 + 2 yocto; the rest stays in the reserve.
const ATTACHED: NearToken = NearToken::from_near(1);
/// NEAR's 40 extra bytes per record (`storage_num_extra_bytes_record`).
const RECORD_EXTRA: u64 = 40;

fn fixture() -> Value {
    serde_json::from_str(SPENDS).unwrap()
}

fn be(dec: &str) -> Bytes32 {
    field::to_be(&field::from_decimal(dec).unwrap())
}

/// The vault's raw records after the fixture's six deposits, made by the vault's own code in the mocked chain.
fn deposits_state(vault: &str) -> Vec<(Vec<u8>, Vec<u8>)> {
    let f = fixture();
    assert_eq!(f["vault"], vault, "the fixture's proofs name vault.test.near");
    testing_env!(VMContextBuilder::new().current_account_id(vault.parse().unwrap()).build());
    let mut v = Vault::default();
    let mut h = PoseidonT3::new();
    for (leaf, label) in f["leaves"].as_array().unwrap().iter().zip(f["labels"].as_array().unwrap()) {
        let _ = v.insert_commitment(&mut h, &be(leaf.as_str().unwrap()));
        let _ = v.insert_label(&mut h, &be(label.as_str().unwrap()));
    }
    env::state_write(&v);
    let mut kv: Vec<(Vec<u8>, Vec<u8>)> = near_sdk::mock::with_mocked_blockchain(|b| b.take_storage()).into_iter().collect();
    kv.sort();
    // `totals` is the state struct's last field: three u128 (deposited, spent, returned), little-endian
    let state = kv.iter_mut().find(|(k, _)| k.as_slice() == b"STATE").expect("STATE written");
    let n = state.1.len();
    assert_eq!(state.1[n - 48..], [0u8; 48], "totals start at 0");
    let deposited: u128 = f["deposited"].as_str().unwrap().parse().unwrap();
    state.1[n - 48..n - 32].copy_from_slice(&deposited.to_le_bytes());
    kv
}

/// The deployed vault with the six deposits' records patched in, and its storage use raised by their bytes.
async fn vault_with_deposits() -> R<Harness> {
    let h = Harness::start().await?;
    let _ = h.deploy_vault().await?;
    let records = deposits_state(h.vault.as_str());
    let bytes: u64 = records.iter().map(|(k, v)| k.len() as u64 + v.len() as u64 + RECORD_EXTRA).sum();
    let before = h.account_view(&h.vault, "final").await?;
    assert!(before["storage_usage"].as_u64().is_some());
    h.worker
        .patch(&h.vault)
        .account_from_current(move |a| {
            let su = a.storage_usage;
            // 1 N more, as the deposits' prepays would have brought
            let bal = a.balance.saturating_add(NearToken::from_near(1));
            AccountDetailsPatch::from(a).storage_usage(su + bytes).balance(bal)
        })
        .states(records.iter().map(|(k, v)| (k.as_slice(), v.as_slice())))
        .transact()
        .await?;
    h.wait_final(&h.vault).await?;
    let st = h.view(&h.vault, "state_tree", json!({})).await?;
    let lt = h.view(&h.vault, "label_tree", json!({})).await?;
    assert_eq!((st["size"].as_u64(), lt["size"].as_u64()), (Some(6), Some(6)), "{st} {lt}");
    let t = h.view(&h.vault, "totals", json!({})).await?;
    assert_eq!(t["deposited"], fixture()["deposited"], "{t}");
    // the patch touched state and storage use only: the code and the keys are the recipe's
    assert!(h.access_keys(&h.vault, "final").await?.is_empty(), "the vault has a key");
    println!("vault {}: six deposits patched in ({bytes} B), state root {}", h.vault, st["root"]);
    Ok(h)
}

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

/// The fixture's spend `name` as `withdraw`'s arguments, with public signal `i` set to `x` when given.
fn args(name: &str, set: Option<(usize, &str)>) -> Value {
    let f = fixture();
    let s = f["spends"].as_array().unwrap().iter().find(|s| s["name"] == name).unwrap().clone();
    let mut signals = s["public_signals"].clone();
    if let Some((i, x)) = set {
        signals[i] = json!(x);
    }
    json!({"withdrawal": s["withdrawal"], "proof": s["proof"], "public_signals": signals})
}

fn signal(name: &str, i: usize) -> String {
    args(name, None)["public_signals"][i].as_str().unwrap().to_string()
}

/// The one `withdraw` receipt of `o`: Ok(gas) when it succeeded, else its failure's text.
fn landed(h: &Harness, o: &Outcome) -> R<Result<u64, String>> {
    let r = o.calls_exactly(&h.vault, "withdraw", 1)?[0];
    Ok(match r.failure() {
        None => Ok(r.gas_burnt),
        Some(f) => Err(f.to_string()),
    })
}

async fn withdraw(h: &Harness, by: &Account, a: Value) -> R<Outcome> {
    h.call_outcome(by, &h.vault, "withdraw", a, ATTACHED, GAS).await
}

/// `a` is refused with `want` and no byte of the vault's state changes.
async fn refused(h: &Harness, by: &Account, a: Value, want: &str) -> R<()> {
    let before = vault_state(h).await?;
    let used = h.account_view(&h.vault, "final").await?["storage_usage"].clone();
    let o = withdraw(h, by, a).await?;
    match landed(h, &o)? {
        Ok(_) => return Err(format!("landed, want {want}").into()),
        Err(f) => assert!(f.contains(want), "want {want}, got {f}"),
    }
    // no event or log from a refused call, the change leaf's leaf_inserted included
    let r = o.calls_exactly(&h.vault, "withdraw", 1)?[0];
    assert!(r.logs.is_empty(), "{want}: a refused call logged {:?}", r.logs);
    h.wait_final(&h.vault).await?;
    assert_eq!(vault_state(h).await?, before, "{want}: a state byte changed");
    assert_eq!(h.account_view(&h.vault, "final").await?["storage_usage"], used, "{want}: the storage use changed");
    Ok(())
}

/// The spends view's row for `nullifier`, its fields in the order the vault writes them.
async fn spend_row(h: &Harness, nullifier: &str) -> R<Value> {
    let rows = h.view(&h.vault, "spends", json!({"from": 0, "limit": 100})).await?;
    let rows = rows.as_array().ok_or("spends: not a list")?;
    Ok(rows.iter().find(|r| r["nullifier_hash"] == nullifier).cloned().ok_or_else(|| format!("no spend of {nullifier}"))?)
}

#[tokio::test]
async fn vt_s05_one_nullifier_spends_once() -> R<()> {
    let h = vault_with_deposits().await?;
    let relayer = h.account("relayer", 50).await?;
    let other = h.account("relayer2", 50).await?;

    // 1. the same call twice
    let o = withdraw(&h, &relayer, args("same_call", None)).await?;
    let gas = landed(&h, &o)?.map_err(|f| format!("same_call: {f}"))?;
    println!("same_call: landed, {:.3} Tgas", gas as f64 / 1e12);
    // the record, field by field, in sync.ts's SPEND_FIELDS order (the raw view text, not a sorted map)
    let raw = h.rpc("query", json!({"request_type": "call_function", "finality": "final", "account_id": h.vault,
        "method_name": "spends", "args_base64": Base64VecU8::from(br#"{"from":0,"limit":1}"#.to_vec())})).await?;
    let text = String::from_utf8(raw["result"]["result"].as_array().ok_or("spends raw")?.iter().map(|b| b.as_u64().unwrap() as u8).collect())?;
    let order = ["index", "nullifier_hash", "withdrawn", "new_leaf_index", "refund_precommitment", "refund_value", "refund_label",
        "refund_leaf_index", "status", "payer", "reserve", "recipient", "fee", "context"];
    let at: Vec<usize> = order.iter().map(|k| text.find(&format!("\"{k}\":")).unwrap_or(usize::MAX)).collect();
    assert!(at.windows(2).all(|w| w[0] < w[1]) && at[13] != usize::MAX, "field order: {text}");
    let w = &args("same_call", None)["withdrawal"];
    let r = spend_row(&h, &signal("same_call", 1)).await?;
    assert_eq!(r["withdrawn"], "2000000");
    assert_eq!(r["new_leaf_index"], 6);
    // no token at TOKEN: both parts failed and came back (2.5.4)
    assert_eq!((r["status"].as_str(), r["refund_value"].as_str()), (Some("refund_pending"), Some("2000000")));
    assert_eq!(r["payer"], relayer.id().as_str());
    assert_eq!((&r["recipient"], &r["fee"], &r["refund_precommitment"]), (&w["recipient"], &w["relay_fee"], &w["refund_precommitment"]));
    assert_eq!(r["context"], signal("same_call", 7));
    assert_eq!(h.view(&h.vault, "leaves", json!({"from": 6, "limit": 1})).await?, json!([signal("same_call", 0)]));
    refused(&h, &relayer, args("same_call", None), "NullifierAlreadySpent").await?;
    refused(&h, &other, args("same_call", None), "NullifierAlreadySpent").await?;
    println!("same call twice: one landed, the second refused (NullifierAlreadySpent)");

    // 2. a second proof with the same nullifier (another request, another change note)
    assert_eq!(signal("same_nullifier_a", 1), signal("same_nullifier_b", 1));
    let o = withdraw(&h, &relayer, args("same_nullifier_a", None)).await?;
    landed(&h, &o)?.map_err(|f| format!("same_nullifier_a: {f}"))?;
    refused(&h, &other, args("same_nullifier_b", None), "NullifierAlreadySpent").await?;
    println!("second proof, same nullifier: one landed, the other refused (NullifierAlreadySpent)");

    // 3. two proofs of one nullifier sent at once by two relayers: both land in one block, one is refused
    assert_eq!(signal("one_block_a", 1), signal("one_block_b", 1));
    let before = h.view(&h.vault, "totals", json!({})).await?;
    let (a, b) = tokio::join!(withdraw(&h, &relayer, args("one_block_a", None)), withdraw(&h, &other, args("one_block_b", None)));
    let (a, b) = (a?, b?);
    let (ra, rb) = (a.calls_exactly(&h.vault, "withdraw", 1)?[0], b.calls_exactly(&h.vault, "withdraw", 1)?[0]);
    assert_eq!(ra.block_hash, rb.block_hash, "the two withdraw receipts ran in two blocks");
    let (la, lb) = (landed(&h, &a)?, landed(&h, &b)?);
    assert_eq!(la.is_ok() as u8 + lb.is_ok() as u8, 1, "exactly one lands: {la:?} {lb:?}");
    let refusal = la.err().or(lb.err()).unwrap();
    assert!(refusal.contains("NullifierAlreadySpent"), "{refusal}");
    let after = h.view(&h.vault, "totals", json!({})).await?;
    let spent = |t: &Value| t["spent"].as_str().unwrap().parse::<u128>().unwrap();
    let won = if ra.ok() { 4_000_000 } else { 6_000_000 };
    assert_eq!(spent(&after) - spent(&before), won);
    println!("two in block {}: one landed ({}), the other refused (NullifierAlreadySpent)", ra.block_hash, if ra.ok() { "a" } else { "b" });

    // three spends of three notes in all: 2 + 1 + (4 or 6) USDC, three change leaves
    let spends = h.view(&h.vault, "spends", json!({"from": 0, "limit": 100})).await?;
    assert_eq!(spends.as_array().unwrap().len(), 3);
    assert_eq!(spent(&after), 3_000_000 + won);
    assert_eq!(h.view(&h.vault, "state_tree", json!({})).await?["size"], 9);
    println!("{}", h.gas_table());
    Ok(())
}

#[tokio::test]
async fn vt_s06_unknown_zero_and_other_vault_roots_are_refused() -> R<()> {
    let h = vault_with_deposits().await?;
    let relayer = h.account("relayer", 50).await?;
    let f = fixture();
    let other = &f["other_vault"];
    let theirs_state = other["state_root"].as_str().unwrap();
    let theirs_label = other["label_root"].as_str().unwrap();
    for (x, label) in [("4", "unknown"), ("0", "0"), (theirs_state, "other vault's")] {
        assert_eq!(h.view(&h.vault, "is_known_state_root", json!({"root": x})).await?, json!(false));
        refused(&h, &relayer, args("same_call", Some((3, x))), "UnknownStateRoot").await?;
        println!("state root {label}: refused (UnknownStateRoot)");
    }
    for (x, label) in [("4", "unknown"), ("0", "0"), (theirs_label, "other vault's")] {
        assert_eq!(h.view(&h.vault, "is_known_label_root", json!({"root": x})).await?, json!(false));
        refused(&h, &relayer, args("same_call", Some((5, x))), "UnknownLabelRoot").await?;
        println!("ASP root {label}: refused (UnknownLabelRoot)");
    }
    // a proof against the roots of 4 of the 6 deposits lands
    assert_ne!(signal("old_root", 3), h.view(&h.vault, "state_tree", json!({})).await?["root"]);
    let o = withdraw(&h, &relayer, args("old_root", None)).await?;
    let gas = landed(&h, &o)?.map_err(|f| format!("old_root: {f}"))?;
    println!("older root (4 of 6 deposits): landed, {:.3} Tgas", gas as f64 / 1e12);
    // and the unchanged same_call lands after its refusals
    let o = withdraw(&h, &relayer, args("same_call", None)).await?;
    landed(&h, &o)?.map_err(|f| format!("same_call: {f}"))?;
    println!("{}", h.gas_table());
    Ok(())
}

#[tokio::test]
async fn rows_4_and_7_to_10_refuse_and_a_landed_call_writes_its_bytes() -> R<()> {
    let h = vault_with_deposits().await?;
    let relayer = h.account("relayer", 50).await?;
    let old = args("old_root", None)["public_signals"].clone();
    let at = |i: usize| old[i].as_str().unwrap().to_string();
    for (i, x, want) in [
        (4, "33".to_string(), "InvalidTreeDepth"),
        (6, "33".to_string(), "InvalidTreeDepth"),
        (2, "0".to_string(), "InvalidWithdrawalAmount"),
        (2, "340282366920938463463374607431768211456".to_string(), "AmountOverflow"),
        (2, "999999".to_string(), "RelayFeeGreaterThanMax"),
        (2, "31000001".to_string(), "InvalidPoolState"),
        (2, "1000000".to_string(), "InvalidProof"),
        (3, at(3), "InvalidProof"),
        (5, at(5), "InvalidProof"),
        (6, "4".to_string(), "InvalidProof"),
    ] {
        refused(&h, &relayer, args("same_call", Some((i, &x))), want).await?;
        println!("signal {i} = {x}: refused ({want})");
    }

    // 2.3: 710 B with a 64-byte payer and recipient; these are shorter, and the third grows the state tree a level
    let short = (64 - relayer.id().as_str().len() as u64) + (64 - "alice.test.near".len() as u64);
    let mut wrote = vec![];
    for name in ["same_call", "same_nullifier_a", "one_block_a"] {
        let used = h.account_view(&h.vault, "final").await?["storage_usage"].as_u64().ok_or("storage_usage")?;
        let o = withdraw(&h, &relayer, args(name, None)).await?;
        let gas = landed(&h, &o)?.map_err(|f| format!("{name}: {f}"))?;
        let r = o.calls_exactly(&h.vault, "withdraw", 1)?[0];
        let events: Vec<&str> = r.logs.iter().map(|l| l.split(r#""event":""#).nth(1).and_then(|e| e.split('"').next()).unwrap_or("")).collect();
        assert_eq!(events, ["leaf_inserted", "withdrawn", "withdrawal_relayed"], "{name}: {:?}", r.logs);
        assert!(r.logs[0].contains(r#""tree":"state""#) && r.logs[0].contains(&signal(name, 0)), "{}", r.logs[0]);
        h.wait_final(&h.vault).await?;
        let now = h.account_view(&h.vault, "final").await?["storage_usage"].as_u64().ok_or("storage_usage")?;
        let depth = h.view(&h.vault, "state_tree", json!({})).await?["depth"].clone();
        println!("{name}: landed, {:.3} Tgas, wrote {} B, state tree depth {depth}", gas as f64 / 1e12, now - used);
        wrote.push(now - used);
    }
    assert_eq!(wrote, vec![710 - short, 710 - short, 710 - short + 74]);
    println!("{}", h.gas_table());
    Ok(())
}
