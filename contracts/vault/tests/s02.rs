// SPDX-License-Identifier: Apache-2.0
//! VT-S02, VT-S10 and VT-S11 for deposits in near-sandbox 2.13.4 (vault.md 5, V:1129, V:1137-1138; 2.5.1 rows 3-12),
//! on the kit's one deposit path: U, the NEAR-implicit account of a device key, signs its own
//! `TOKEN.ft_transfer_call(vault, amount, msg)` with 1 yocto and 180 Tgas as a NEP-366 `DelegateAction`, and a relayer
//! account sends it in its own transaction and pays its gas, after the relayer's `storage_prepay` on the precommitment
//! (2.10). Runs only with `--features sandbox`, through tests/harness/run.sh
//! (`contracts/vault/tests/harness/run.sh --test s02`); a plain `cargo test` builds this file empty.
//!
//! 1. `deposits_land_{mock,usdc}` (VT-S02, VT-S10, VT-S11): five deposits from five U, the first three and the fifth
//!    each growing both trees by a level. Each returns `"0"`; its receipt logs exactly `leaf_inserted` state,
//!    `leaf_inserted` label and `deposited`, every field equal to the leaf, label, roots and commitment this file
//!    computes off chain (the label from the scope and nonce, Poseidon(amount, label, precommitment), the LeanIMT of
//!    src/tree.rs over in-memory side nodes); `leaves`, `labels`, both trees' views and the root sets read the same
//!    back; the `deposits` row is exactly the bytes the kit's vaultSync parses (packages/kit/src/vault/sync.ts
//!    `DEPOSIT_FIELDS`, field order included); U's tokens fall and the vault's rise by the amount exactly; the prepay
//!    and the deposit together add exactly 756 B to the vault's storage, 904 B when the trees grow (2.3); and after
//!    each, the vault's token balance equals `totals().deposited` (I1 with nothing in flight).
//! 2. `a_756_prepay_on_a_growing_deposit_is_refused_then_a_top_up_lands_{mock,usdc}` (VT-S10): the second deposit grows
//!    both trees; on a 756 B prepay it is refused (`InsufficientStorageDeposit`) with U's tokens back and not one
//!    state byte changed; a stranger's 148 B top-up, then U's same deposit signed again, lands on the same record.
//! 3. `no_prepay_is_refused_{mock,usdc}` (the card's risk; VT-S03's "no prepay"): U's call with no prepay is refused
//!    (`NoPrepay`), the token's resolve gives U the whole amount back, and not one state byte changes.
//!
//! Each case runs on both tokens (vault.md 5): the mock token and the real USDC wasm. Each prints its gas table, whose
//! `vault::ft_on_transfer` row is the deposit's gas with the insert.
#![cfg(feature = "sandbox")]

mod harness;

use blindfill_vault::constants::{MAX_TREE_DEPTH, TOKEN};
use blindfill_vault::context::{field_of, label_of, scope_for};
use blindfill_vault::field;
use blindfill_vault::poseidon::{PoseidonT3, PoseidonT4};
use blindfill_vault::tree::insert;
use blindfill_vault::Bytes32;
use harness::{Harness, Outcome, Receipt, TokenKind, R, YOCTO_PER_BYTE};
use near_sdk::json_types::Base64VecU8;
use near_sdk::serde_json::{self, json, Value};
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId};

/// What each U holds: 10 USDC (6 decimals).
const HELD: u128 = 10_000_000;
/// The gas U signs for its `ft_transfer_call` (vault.md 2.5.1, 2.10 (b)).
const GAS: Gas = Gas::from_tgas(180);
const PREPAY_GAS: Gas = Gas::from_tgas(30);

fn dec(b: &Bytes32) -> String {
    field::to_decimal(&field::from_be(b))
}

/// The gross bytes the `n`th deposit (1-based) writes with a 64-byte depositor (vault.md 2.3): 756, and 74 more per
/// tree when its insert writes a new side node (the first insert, and each time the size passes a power of two).
fn gross(n: u64) -> u64 {
    if n == 1 || (n - 1).is_power_of_two() {
        904
    } else {
        756
    }
}

/// The vault's state off chain: both trees as src/tree.rs inserts them, and the nonce.
struct Model {
    nonce: u64,
    scope: field::U256,
    trees: [(u64, u8, [Bytes32; MAX_TREE_DEPTH as usize + 1]); 2],
    deposited: u128,
}

/// What one deposit must write, computed off chain.
struct Expected {
    precommitment: Bytes32,
    label: Bytes32,
    commitment: Bytes32,
    state_root: Bytes32,
    label_root: Bytes32,
    index: u64,
}

impl Model {
    fn new(vault: &AccountId) -> Self {
        Model { nonce: 0, scope: scope_for(vault.as_str(), TOKEN), trees: [(0, 0, [[0; 32]; 33]), (0, 0, [[0; 32]; 33])], deposited: 0 }
    }

    /// Rows 8-10 for `amount` on `precommitment`.
    fn deposit(&mut self, precommitment: Bytes32, amount: u128) -> Expected {
        self.nonce += 1;
        let label = field::to_be(&label_of(&self.scope, self.nonce));
        let mut a = [0u8; 32];
        a[16..].copy_from_slice(&amount.to_be_bytes());
        let commitment = PoseidonT4::new().hash(&a, &label, &precommitment);
        let mut h = PoseidonT3::new();
        let index = self.trees[0].0;
        let [s, l] = &mut self.trees;
        let state_root = insert(&mut h, &mut s.0, &mut s.1, &mut s.2, &commitment);
        let label_root = insert(&mut h, &mut l.0, &mut l.1, &mut l.2, &label);
        self.deposited += amount;
        Expected { precommitment, label, commitment, state_root, label_root, index }
    }
}

/// A precommitment as the device makes one: a full-size field element, `keccak256(tag) mod p`.
fn precommitment(tag: &str) -> Bytes32 {
    field::to_be(&field_of(tag.as_bytes()))
}

fn message(p: &Bytes32, depositor: &AccountId) -> String {
    format!(r#"{{"precommitment":"{}","depositor":"{depositor}"}}"#, dec(p))
}

/// A view's raw answer, as the bytes the vault wrote (the kit compares these bytes).
async fn raw_view(h: &Harness, method: &str, args: Value) -> R<String> {
    let q = json!({"request_type": "call_function", "finality": "final", "account_id": h.vault, "method_name": method,
                   "args_base64": serde_json::to_value(Base64VecU8(args.to_string().into_bytes()))?});
    let v = h.rpc("query", q).await?;
    let bytes: Vec<u8> = serde_json::from_value(v["result"]["result"].clone()).map_err(|e| format!("{method}: {e}: {v}"))?;
    Ok(String::from_utf8(bytes)?)
}

async fn storage_usage(h: &Harness) -> R<u64> {
    let a = h.account_view(&h.vault, "final").await?;
    Ok(a["storage_usage"].as_u64().ok_or_else(|| format!("view_account: {a}"))?)
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

/// The bytes the contract's state record (key `STATE`) takes: key, value and NEAR's 40 per record.
async fn state_record_bytes(h: &Harness) -> R<u64> {
    let state = vault_state(h).await?;
    let key = serde_json::to_value(Base64VecU8(b"STATE".to_vec()))?;
    let (_, v) = state.iter().find(|(k, _)| json!(k) == key).ok_or("no STATE record")?;
    let value: Base64VecU8 = serde_json::from_value(json!(v))?;
    Ok(5 + value.0.len() as u64 + 40)
}

/// The vault, `kind`'s token, and a relayer account holding 50 N.
async fn setup(kind: TokenKind) -> R<(Harness, Account)> {
    let h = Harness::with_vault_and(kind).await?;
    let relayer = h.account("relayer", 50).await?;
    Ok((h, relayer))
}

/// A fresh U (the implicit account of a new key, made by a plain Transfer) holding HELD of the token.
async fn new_u(h: &Harness) -> R<Account> {
    let u = h.implicit_account(10).await?;
    h.mint(u.id(), HELD).await?;
    Ok(u)
}

async fn prepay(h: &Harness, payer: &Account, p: &Bytes32, bytes: u64) -> R<()> {
    let deposit = NearToken::from_yoctonear(bytes as u128 * YOCTO_PER_BYTE);
    let _ = h.call(payer, &h.vault, "storage_prepay", json!({"precommitment": dec(p)}), deposit, PREPAY_GAS).await?;
    Ok(())
}

/// U's own `ft_transfer_call(vault, amount, msg)` on the token, 1 yocto and 180 Tgas, as a `DelegateAction` the
/// relayer sends.
async fn u_call(h: &Harness, relayer: &Account, u: &Account, amount: u128, msg: &str) -> R<Outcome> {
    let args = json!({"receiver_id": h.vault, "amount": amount.to_string(), "msg": msg});
    h.delegate_call(relayer, u, &h.token, "ft_transfer_call", args, 1, GAS).await
}

/// The kit's path, read from the receipts: the relayer's [Delegate] ran on U, U's own call ran on the token, and the
/// token called the vault once. Returns the vault's `ft_on_transfer` receipt.
fn kits_path<'a>(h: &Harness, o: &'a Outcome, relayer: &Account, u: &Account) -> R<&'a Receipt> {
    let delegate: Vec<&Receipt> = o.receipts.iter().filter(|r| r.executor == u.id().as_str() && r.actions == ["Delegate"]).collect();
    if delegate.len() != 1 || delegate[0].predecessor != relayer.id().as_str() {
        return Err(format!("no one [Delegate] receipt from the relayer on U: {:#?}", o.receipts.iter().map(Receipt::line).collect::<Vec<_>>()).into());
    }
    let call = o.calls_exactly(&h.token, "ft_transfer_call", 1)?[0];
    if call.predecessor != u.id().as_str() {
        return Err(format!("ft_transfer_call's predecessor is {}, not U {}", call.predecessor, u.id()).into());
    }
    let r = o.calls_exactly(&h.vault, "ft_on_transfer", 1)?[0];
    if r.predecessor != h.token.as_str() {
        return Err(format!("ft_on_transfer's predecessor is {}, not the token", r.predecessor).into());
    }
    Ok(r)
}

/// The receipt's return value as text (`SuccessValue` decoded).
fn returned(r: &Receipt) -> R<String> {
    let value = match &r.status {
        harness::Status::Success(v) => v.get("SuccessValue").cloned(),
        _ => None,
    }
    .ok_or_else(|| format!("no value: {}", r.line()))?;
    let raw: Base64VecU8 = serde_json::from_value(value)?;
    Ok(String::from_utf8(raw.0)?)
}

/// I1 with nothing in flight (VT-S11): the vault's token balance = deposited − spent + returned, and `totals()` is
/// what the model deposited.
async fn i1(h: &Harness, m: &Model) -> R<()> {
    let t = h.view(&h.vault, "totals", json!({})).await?;
    let n = |k: &str| -> R<u128> { Ok(t[k].as_str().ok_or_else(|| format!("totals: {t}"))?.parse()?) };
    let (deposited, spent, returned) = (n("deposited")?, n("spent")?, n("returned")?);
    let balance = h.token_balance(&h.vault).await?;
    assert_eq!((deposited, spent, returned), (m.deposited, 0, 0), "totals()");
    assert_eq!(balance, deposited - spent + returned, "I1: the vault's token balance against totals()");
    println!("VT-S11: vault token balance {balance} = deposited {deposited} - spent {spent} + returned {returned}");
    Ok(())
}

/// One deposit that must land: U's call after the relayer's prepay of the deposit's gross bytes, every read of case 1.
async fn lands(h: &Harness, m: &mut Model, relayer: &Account, u: &Account, p: Bytes32, amount: u128) -> R<()> {
    let n = m.nonce + 1;
    let usage0 = storage_usage(h).await?;
    prepay(h, relayer, &p, gross(n)).await?;
    let (u0, v0) = (h.token_balance(u.id()).await?, h.token_balance(&h.vault).await?);
    let o = u_call(h, relayer, u, amount, &message(&p, u.id())).await?;
    o.expect_all_ok(&format!("deposit {n}"))?;
    let r = kits_path(h, &o, relayer, u)?;
    assert_eq!(returned(r)?, "\"0\"", "deposit {n}: ft_on_transfer did not return \"0\"");
    let e = m.deposit(p, amount);
    // events: exactly these three lines, in PP's order
    let head = r#"EVENT_JSON:{"standard":"blindfill-vault","version":"1.0.0","event":"#;
    let want = vec![
        format!(r#"{head}"leaf_inserted","data":[{{"tree":"state","index":{},"leaf":"{}","root":"{}"}}]}}"#, e.index, dec(&e.commitment), dec(&e.state_root)),
        format!(r#"{head}"leaf_inserted","data":[{{"tree":"label","index":{},"leaf":"{}","root":"{}"}}]}}"#, e.index, dec(&e.label), dec(&e.label_root)),
        format!(
            r#"{head}"deposited","data":[{{"depositor":"{}","commitment":"{}","label":"{}","value":"{amount}","precommitment":"{}"}}]}}"#,
            u.id(),
            dec(&e.commitment),
            dec(&e.label),
            dec(&e.precommitment)
        ),
    ];
    assert_eq!(r.logs, want, "deposit {n}: the events");
    // the leaf and the roots read back
    let page = json!({"from": e.index, "limit": 1});
    assert_eq!(h.view(&h.vault, "leaves", page.clone()).await?, json!([dec(&e.commitment)]), "deposit {n}: leaves");
    assert_eq!(h.view(&h.vault, "labels", page.clone()).await?, json!([dec(&e.label)]), "deposit {n}: labels");
    let (s, l) = (&m.trees[0], &m.trees[1]);
    assert_eq!(h.view(&h.vault, "state_tree", json!({})).await?, json!({"size": s.0, "depth": s.1, "root": dec(&e.state_root)}));
    assert_eq!(h.view(&h.vault, "label_tree", json!({})).await?, json!({"size": l.0, "depth": l.1, "root": dec(&e.label_root)}));
    assert_eq!(h.view(&h.vault, "is_known_state_root", json!({"root": dec(&e.state_root)})).await?, json!(true));
    assert_eq!(h.view(&h.vault, "is_known_label_root", json!({"root": dec(&e.label_root)})).await?, json!(true));
    // the row the kit parses, as the vault's own bytes
    assert_eq!(
        raw_view(h, "deposits", page).await?,
        format!(
            r#"[{{"index":{0},"precommitment":"{1}","label":"{2}","value":"{amount}","leaf_index":{0},"depositor":"{3}"}}]"#,
            e.index,
            dec(&e.precommitment),
            dec(&e.label),
            u.id()
        ),
        "deposit {n}: the deposits row"
    );
    // balances exact
    assert_eq!(h.token_balance(u.id()).await?, u0 - amount, "deposit {n}: U's balance");
    assert_eq!(h.token_balance(&h.vault).await?, v0 + amount, "deposit {n}: the vault's balance");
    // VT-S10: the prepay's record and the deposit together add the deposit's gross bytes; the vault's first write (the
    // first prepay) also makes the contract's state record from `Default` (2.3), a fixed size from then on
    let added = storage_usage(h).await? - usage0;
    let state = if n == 1 { state_record_bytes(h).await? } else { 0 };
    assert_eq!(added, gross(n) + state, "deposit {n}: bytes (state record {state})");
    i1(h, m).await?;
    println!("deposit {n}: landed, leaf {} at {}, {added} B, ft_on_transfer {:.3} Tgas", dec(&e.commitment), e.index, r.gas_burnt as f64 / 1e12);
    Ok(())
}

#[tokio::test]
async fn deposits_land_mock() -> R<()> {
    deposits_land(TokenKind::Mock).await
}

#[tokio::test]
async fn deposits_land_usdc() -> R<()> {
    deposits_land(TokenKind::Usdc).await
}

async fn deposits_land(kind: TokenKind) -> R<()> {
    let (h, relayer) = setup(kind).await?;
    let mut m = Model::new(&h.vault);
    for n in 1..=5u64 {
        let u = new_u(&h).await?;
        // amounts: MIN_DEPOSIT, then other sizes up to U's whole balance
        let amount = [1_000_000, 2_500_000, 1_000_001, HELD, 7_654_321][n as usize - 1];
        lands(&h, &mut m, &relayer, &u, precommitment(&format!("s02 {kind:?} {n}")), amount).await?;
    }
    println!("{}", h.gas_table());
    Ok(())
}

#[tokio::test]
async fn a_756_prepay_on_a_growing_deposit_is_refused_then_a_top_up_lands_mock() -> R<()> {
    a_756_prepay_on_a_growing_deposit_is_refused_then_a_top_up_lands(TokenKind::Mock).await
}

#[tokio::test]
async fn a_756_prepay_on_a_growing_deposit_is_refused_then_a_top_up_lands_usdc() -> R<()> {
    a_756_prepay_on_a_growing_deposit_is_refused_then_a_top_up_lands(TokenKind::Usdc).await
}

async fn a_756_prepay_on_a_growing_deposit_is_refused_then_a_top_up_lands(kind: TokenKind) -> R<()> {
    let (h, relayer) = setup(kind).await?;
    let mut m = Model::new(&h.vault);
    let u1 = new_u(&h).await?;
    lands(&h, &mut m, &relayer, &u1, precommitment("s10 first"), 1_000_000).await?;
    // the second deposit grows both trees: 904 B, on a 756 B prepay
    let u = new_u(&h).await?;
    let p = precommitment("s10 second");
    prepay(&h, &relayer, &p, 756).await?;
    let before = (h.token_balance(u.id()).await?, h.token_balance(&h.vault).await?, vault_state(&h).await?);
    let msg = message(&p, u.id());
    let o = u_call(&h, &relayer, &u, 2_000_000, &msg).await?;
    let r = kits_path(&h, &o, &relayer, &u)?;
    let f = r.failure().ok_or_else(|| format!("the deposit on a 756 B prepay landed: {}", r.line()))?;
    assert!(f.contains("InsufficientStorageDeposit: the deposit wrote 904 B; the prepay covers 756 B"), "{f}");
    assert!(o.calls_exactly(&h.token, "ft_resolve_transfer", 1)?[0].ok(), "the resolve failed");
    let after = (h.token_balance(u.id()).await?, h.token_balance(&h.vault).await?, vault_state(&h).await?);
    assert_eq!(after, before, "a balance or a state byte changed on the refusal");
    println!("756 B prepay on a growing deposit: refused, U's {} back, {:.3} Tgas", 2_000_000, r.gas_burnt as f64 / 1e12);
    i1(&h, &m).await?;
    // a stranger's top-up of 148 B, then U signs the same deposit again: it lands on the same record
    let stranger = h.account("stranger", 10).await?;
    let usage0 = storage_usage(&h).await?;
    prepay(&h, &stranger, &p, 148).await?;
    let o = u_call(&h, &relayer, &u, 2_000_000, &msg).await?;
    o.expect_all_ok("the retry after the top-up")?;
    let r = kits_path(&h, &o, &relayer, &u)?;
    assert_eq!(returned(r)?, "\"0\"");
    let e = m.deposit(p, 2_000_000);
    assert_eq!(h.view(&h.vault, "state_tree", json!({})).await?["root"], json!(dec(&e.state_root)));
    // the 89 B record was already there: the top-up and the deposit add 904 − 89
    assert_eq!(storage_usage(&h).await? - usage0, 904 - 89, "the retry's bytes");
    assert_eq!(h.token_balance(u.id()).await?, HELD - 2_000_000);
    i1(&h, &m).await?;
    println!("{}", h.gas_table());
    Ok(())
}

#[tokio::test]
async fn no_prepay_is_refused_mock() -> R<()> {
    no_prepay_is_refused(TokenKind::Mock).await
}

#[tokio::test]
async fn no_prepay_is_refused_usdc() -> R<()> {
    no_prepay_is_refused(TokenKind::Usdc).await
}

async fn no_prepay_is_refused(kind: TokenKind) -> R<()> {
    let (h, relayer) = setup(kind).await?;
    let mut m = Model::new(&h.vault);
    // a landed deposit first, so the refusal runs on a vault with state, then U's call with no prepay
    let u1 = new_u(&h).await?;
    lands(&h, &mut m, &relayer, &u1, precommitment("no-prepay first"), 1_000_000).await?;
    let u = new_u(&h).await?;
    let before = (h.token_balance(u.id()).await?, h.token_balance(&h.vault).await?, vault_state(&h).await?);
    assert_eq!(before.0, HELD);
    let o = u_call(&h, &relayer, &u, HELD, &message(&precommitment("no-prepay"), u.id())).await?;
    let r = kits_path(&h, &o, &relayer, &u)?;
    let f = r.failure().ok_or_else(|| format!("a deposit with no prepay landed: {}", r.line()))?;
    assert!(f.contains("NoPrepay"), "want NoPrepay, got {f}");
    assert!(o.calls_exactly(&h.token, "ft_resolve_transfer", 1)?[0].ok(), "the resolve failed");
    assert!(o.status.ok(), "the transaction failed: {:?}", o.status);
    let after = (h.token_balance(u.id()).await?, h.token_balance(&h.vault).await?, vault_state(&h).await?);
    assert_eq!(after, before, "a balance or a state byte changed on the refusal");
    i1(&h, &m).await?;
    println!("NoPrepay: refused, U's {HELD} back, {:.3} Tgas in ft_on_transfer", r.gas_burnt as f64 / 1e12);
    println!("{}", h.gas_table());
    Ok(())
}
