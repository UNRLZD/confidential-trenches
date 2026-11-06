// SPDX-License-Identifier: Apache-2.0
//! `withdraw`'s rows 4-12 (vault.md 2.5.2: the depths, both roots, the amount checks, the Groth16 proof, the nullifier
//! and the change leaf; card vault-withdraw-verify) in near-sandbox 2.13.4 with real proofs: VT-S05 (V:1132) and
//! VT-S06 (V:1133). Runs only with `--features sandbox`, through tests/harness/run.sh
//! (`contracts/vault/tests/harness/run.sh --test withdraw_spend`); a plain `cargo test` builds this file empty.
//!
//! The proofs are tests/fixtures/withdraw-spends.json (the kit's input builder and snarkjs, made by
//! make-withdraw-spends.mjs) over six test deposits on vault.test.near, the harness's vault. Every test runs twice
//! (vault.md 5, V3.2), on the mock token and on the real USDC wasm at TOKEN: the six deposits are made through each
//! token's `ft_transfer_call` (`ft_on_transfer`, each on its 904 B prepay), as tests/settle.rs makes them, and their
//! leaves and labels are checked against the fixture's. After each test I1 holds (VT-S11, `Harness::i1`).
//!
//! 1. `vt_s05_one_nullifier_spends_once`: the same call twice; a second proof with the same nullifier; two proofs of
//!    one nullifier sent at once by two relayers, landing in one block. Each time exactly one succeeds and the others
//!    are refused with `NullifierAlreadySpent`; a refused call changes no byte of the vault's state and logs nothing.
//! 2. `vt_s06_unknown_zero_and_other_vault_roots_are_refused`: a state root or ASP root that is unknown, 0, or another
//!    vault's (the same notes under another scope) is refused (`UnknownStateRoot`, `UnknownLabelRoot`) with no byte
//!    changed; a proof against an older root (4 of the 6 deposits) lands. VT-S07's last case rides here (V:1134): that
//!    withdrawal's refund precommitment is a stranger's pending deposit precommitment (the stranger prepaid it first);
//!    the withdrawal lands and the stranger's deposit on it still lands.
//! 3. `rows_4_and_7_to_10_refuse_and_a_landed_call_writes_its_bytes`: rows 4, 7, 8, 9 and 10 refuse with no state byte,
//!    no storage use and no log changed; three landed calls each write 2.3's bytes for their account ids (+74 B when
//!    the state tree grows a level) and log exactly `leaf_inserted`, `withdrawn` then `withdrawal_relayed`.
//!
//! The proofs' recipients and fee recipient (alice, newcomer, the relayer) are not registered on the token, so both
//! payout receipt of a landed withdrawal fails whole and `on_payout` turns it into a refund-pending amount, on either token
//! (the payouts themselves are tests/payouts.rs'). Each call attaches 1 NEAR, over row 14's charge. Each test prints its gas table: `vault::withdraw` is the vault's own work through the payouts' promises,
//! against vault.md 2.11's 41.202-41.828 Tgas at depth 3.
#![cfg(feature = "sandbox")]

mod harness;

use harness::{Harness, Outcome, TokenKind, R, YOCTO_PER_BYTE};
use near_sdk::json_types::Base64VecU8;
use near_sdk::serde_json::{self, json, Value};
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::Account;

const SPENDS: &str = include_str!("fixtures/withdraw-spends.json");
const GAS: Gas = Gas::from_tgas(300);
/// Over row 14's charge: (at most 784 B + REFUND_RESERVE_BYTES) x 1e19 + 2 yocto; the rest stays in the reserve.
const ATTACHED: NearToken = NearToken::from_near(1);
/// The kit's prepay whenever a tree may grow (2.10 (h)).
const PREPAY: NearToken = NearToken::from_yoctonear(904 * YOCTO_PER_BYTE);

fn fixture() -> Value {
    serde_json::from_str(SPENDS).unwrap()
}

/// `depositor`'s deposit of `value` on `precommitment`: its prepay by `payer`, then its own `ft_transfer_call` with the
/// kit's message; an error unless both land and the vault took the amount (`ft_on_transfer` ran once).
async fn deposit(h: &Harness, payer: &Account, depositor: &Account, precommitment: &str, value: &str) -> R<()> {
    let _ = h.call(payer, &h.vault, "storage_prepay", json!({"precommitment": precommitment}), PREPAY, Gas::from_tgas(30)).await?;
    let msg = format!(r#"{{"precommitment":"{precommitment}","depositor":"{}"}}"#, depositor.id());
    let o = h
        .call(depositor, &h.token, "ft_transfer_call", json!({"receiver_id": h.vault, "amount": value, "msg": msg}), NearToken::from_yoctonear(1), Gas::from_tgas(180))
        .await?;
    let _ = o.calls_exactly(&h.vault, "ft_on_transfer", 1)?;
    Ok(())
}

/// The vault by the 2.8 recipe on `kind`'s token, holding the fixture's six deposits, made through the token by u.
async fn vault_with_deposits(kind: TokenKind) -> R<Harness> {
    let h = Harness::with_vault_and(kind).await?;
    let f = fixture();
    assert_eq!(f["vault"], h.vault.as_str(), "the fixture's proofs name vault.test.near");
    let u = h.account("u", 50).await?;
    let payer = h.account("payer", 50).await?;
    h.mint(u.id(), f["deposited"].as_str().unwrap().parse()?).await?;
    for (p, value) in f["precommitments"].as_array().unwrap().iter().zip(f["values"].as_array().unwrap()) {
        deposit(&h, &payer, &u, p.as_str().unwrap(), value.as_str().unwrap()).await?;
    }
    assert_eq!(h.view(&h.vault, "leaves", json!({"from": 0, "limit": 10})).await?, f["leaves"], "the deposits' leaves are the fixture's");
    assert_eq!(h.view(&h.vault, "labels", json!({"from": 0, "limit": 10})).await?, f["labels"], "the deposits' labels are the fixture's");
    let t = h.view(&h.vault, "totals", json!({})).await?;
    assert_eq!(t["deposited"], f["deposited"], "{t}");
    assert!(h.access_keys(&h.vault, "final").await?.is_empty(), "the vault has a key");
    println!("{kind:?}: vault {} holds the six deposits, state root {}", h.vault, h.view(&h.vault, "state_tree", json!({})).await?["root"]);
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
async fn vt_s05_one_nullifier_spends_once_mock() -> R<()> {
    vt_s05_one_nullifier_spends_once(TokenKind::Mock).await
}

#[tokio::test]
async fn vt_s05_one_nullifier_spends_once_usdc() -> R<()> {
    vt_s05_one_nullifier_spends_once(TokenKind::Usdc).await
}

async fn vt_s05_one_nullifier_spends_once(kind: TokenKind) -> R<()> {
    let h = vault_with_deposits(kind).await?;
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
    // alice and the relayer are not registered on the token: both parts bounced and came back (2.5.4)
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
    h.i1().await?;
    Ok(())
}

#[tokio::test]
async fn vt_s06_unknown_zero_and_other_vault_roots_are_refused_mock() -> R<()> {
    vt_s06_unknown_zero_and_other_vault_roots_are_refused(TokenKind::Mock).await
}

#[tokio::test]
async fn vt_s06_unknown_zero_and_other_vault_roots_are_refused_usdc() -> R<()> {
    vt_s06_unknown_zero_and_other_vault_roots_are_refused(TokenKind::Usdc).await
}

async fn vt_s06_unknown_zero_and_other_vault_roots_are_refused(kind: TokenKind) -> R<()> {
    let h = vault_with_deposits(kind).await?;
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
    // a proof against the roots of 4 of the 6 deposits lands; VT-S07's last case: its refund precommitment is a
    // stranger's pending deposit precommitment, prepaid before it
    let stranger = h.account("stranger", 50).await?;
    let pending = args("old_root", None)["withdrawal"]["refund_precommitment"].as_str().unwrap().to_string();
    let _ = h.call(&stranger, &h.vault, "storage_prepay", json!({"precommitment": pending}), PREPAY, Gas::from_tgas(30)).await?;
    assert_ne!(signal("old_root", 3), h.view(&h.vault, "state_tree", json!({})).await?["root"]);
    let o = withdraw(&h, &relayer, args("old_root", None)).await?;
    let gas = landed(&h, &o)?.map_err(|f| format!("old_root: {f}"))?;
    println!("older root (4 of 6 deposits): landed, {:.3} Tgas", gas as f64 / 1e12);
    // the stranger's deposit on that precommitment still lands (its prepay is the one above)
    let leaves = h.view(&h.vault, "state_tree", json!({})).await?["size"].as_u64().ok_or("state_tree size")?;
    let held = h.token_balance(&h.vault).await?;
    h.mint(stranger.id(), 1_000_000).await?;
    let msg = format!(r#"{{"precommitment":"{pending}","depositor":"{}"}}"#, stranger.id());
    let d = h
        .call(&stranger, &h.token, "ft_transfer_call", json!({"receiver_id": h.vault, "amount": "1000000", "msg": msg}), NearToken::from_yoctonear(1), Gas::from_tgas(180))
        .await?;
    let _ = d.calls_exactly(&h.vault, "ft_on_transfer", 1)?;
    assert_eq!(h.view(&h.vault, "state_tree", json!({})).await?["size"].as_u64(), Some(leaves + 1), "the stranger's deposit wrote no leaf");
    assert_eq!(h.token_balance(&h.vault).await? - held, 1_000_000, "the vault did not keep the stranger's deposit");
    println!("a refund precommitment equal to a stranger's pending deposit precommitment: the withdrawal landed, then the stranger's deposit landed");
    // and the withdrawal's refund is not lost to that deposit: its row holds P, refund_pending, and settle writes the
    // refund note on P (settle reads no precommitment set, src/settle.rs)
    let n = signal("old_root", 1);
    let r = spend_row(&h, &n).await?;
    assert_eq!((r["refund_precommitment"].as_str(), r["status"].as_str()), (Some(pending.as_str()), Some("refund_pending")), "{r}");
    let refund = r["refund_value"].as_str().ok_or("refund_value")?.to_string();
    assert_eq!(refund, r["withdrawn"].as_str().ok_or("withdrawn")?, "both parts bounce: the whole withdrawal comes back, {r}");
    let size = h.view(&h.vault, "state_tree", json!({})).await?["size"].as_u64().ok_or("state_tree size")?;
    let o = h.call_outcome(&stranger, &h.vault, "settle", json!({"nullifier_hash": n}), NearToken::from_yoctonear(0), Gas::from_tgas(100)).await?;
    o.expect_all_ok("settle old_root")?;
    let r = spend_row(&h, &n).await?;
    assert_eq!(
        (r["refund_precommitment"].as_str(), r["status"].as_str(), r["refund_value"].as_str(), r["refund_leaf_index"].as_u64()),
        (Some(pending.as_str()), Some("settled"), Some(refund.as_str()), Some(size)),
        "{r}"
    );
    println!("settle old_root: the refund note of {refund} on P is leaf {size}, after the stranger's deposit on P");
    // and the unchanged same_call lands after its refusals
    let o = withdraw(&h, &relayer, args("same_call", None)).await?;
    landed(&h, &o)?.map_err(|f| format!("same_call: {f}"))?;
    println!("{}", h.gas_table());
    h.i1().await?;
    Ok(())
}

#[tokio::test]
async fn rows_4_and_7_to_10_refuse_and_a_landed_call_writes_its_bytes_mock() -> R<()> {
    rows_4_and_7_to_10_refuse_and_a_landed_call_writes_its_bytes(TokenKind::Mock).await
}

#[tokio::test]
async fn rows_4_and_7_to_10_refuse_and_a_landed_call_writes_its_bytes_usdc() -> R<()> {
    rows_4_and_7_to_10_refuse_and_a_landed_call_writes_its_bytes(TokenKind::Usdc).await
}

async fn rows_4_and_7_to_10_refuse_and_a_landed_call_writes_its_bytes(kind: TokenKind) -> R<()> {
    let h = vault_with_deposits(kind).await?;
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
    h.i1().await?;
    Ok(())
}
