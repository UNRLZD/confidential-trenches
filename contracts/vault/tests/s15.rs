// SPDX-License-Identifier: Apache-2.0
//! VT-S15 (vault.md 5, V:1142; wallet V2) in near-sandbox 2.13.4, on the mock token and on the real USDC wasm at
//! TOKEN, with intents.near at DF (defuse v0.4.5, commit 16d04f6, the pinned wasm): an arming end to end while
//! intents.near's deposits are halted, then resumed. Runs only with `--features sandbox`, through tests/harness/run.sh
//! (`contracts/vault/tests/harness/run.sh --test s15`); a plain `cargo test` builds this file empty.
//!
//! The vault holds tests/fixtures/withdraw-spends.json's six notes (deposited as tests/s04.rs deposits them). A is the
//! arming's one-use account: the fixture's `same_call` spend names alice.test.near as its recipient (2,000,000
//! withdrawn, a 500,000 fee to the relayer), so alice plays A. The deposit address is a 64-hex id, as a 1Click quote's
//! is, held only inside intents.near.
//!
//! intents.near's deposit halt is its own: `ft_on_transfer` carries near-plugins' `#[pause]` (DF
//! `contracts/defuse/src/contract/tokens/nep141/deposit.rs` l.18), so a PauseManager's `pa_pause_feature
//! ("ft_on_transfer")` makes it panic "Pausable: Method is paused" (near-plugins-derive 0.5.3 `src/pausable.rs`
//! l.165-168, l.64-90; DF `contracts/defuse/src/contract/mod.rs` l.75-78 names the roles), and an UnpauseManager's
//! `pa_unpause_feature` ends it (l.92-120). The harness's `deploy_intents` puts `intents-admin` in both roles.
//!
//! 1. halted: the relayer's `withdraw` lands whole: A gets withdrawn − fee, the relayer the fee, the vault gives
//!    withdrawn, the spend reads `paid`. Then A's onward `TOKEN.ft_transfer_call(intents.near, amount, msg = deposit
//!    address)`, signed by A as a NEP-366 `DelegateAction` that the relayer carries (packages/kit/src/helper/v1.ts
//!    `HelperBindOnward`): intents.near's `ft_on_transfer` fails with the pause, the token's `ft_transfer_call` resolve
//!    gives A the whole amount back; the deposit address holds 0 inside intents.near, intents.near's token balance
//!    and the vault's are as they were, and I1 holds (the vault holds nothing of the payout).
//! 2. resumed: A's same call, signed again, lands: the deposit address's balance inside intents.near rises by exactly
//!    the amount, A holds 0, intents.near's token balance rises by the amount, the vault's is unchanged.
#![cfg(feature = "sandbox")]

mod harness;

use harness::{Harness, Outcome, Receipt, TokenKind, R, YOCTO_PER_BYTE};
use near_sdk::serde_json::{self, json, Value};
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId};

const SPENDS: &str = include_str!("fixtures/withdraw-spends.json");
const SPEND: &str = "same_call";
const A: &str = "alice.test.near";
const FEE_RECIPIENT: &str = "relayer.test.near";
const WITHDRAWN: u128 = 2_000_000;
const FEE: u128 = 500_000;
/// The kit's prepay whenever a tree may grow (2.10 (h)).
const PREPAY_BYTES: u128 = 904;
/// 2.3: a spend's bytes with a 64-byte payer and recipient (710, + 81 for its refund precommitment's
/// `precommitments` row), when the state tree grows no level; + 74 when it does
/// (tests/s04.rs `row14`).
const SPEND_BYTES: u128 = 791;
const LEVEL_BYTES: u128 = 74;
const REFUND_RESERVE_BYTES: u128 = blindfill_vault::constants::REFUND_RESERVE_BYTES as u128;
/// The gas A signs for its onward `ft_transfer_call` (none is fixed by the kit yet; tests/s02.rs sends the same call
/// into intents.near at 100 Tgas).
const ONWARD_GAS: Gas = Gas::from_tgas(100);
const PAUSED: &str = "Pausable: Method is paused";

fn fixture() -> Value {
    serde_json::from_str(SPENDS).unwrap()
}

/// The fixture's spend as `withdraw`'s arguments.
fn args() -> Value {
    let f = fixture();
    let s = f["spends"].as_array().unwrap().iter().find(|s| s["name"] == SPEND).unwrap().clone();
    json!({"withdrawal": s["withdrawal"], "proof": s["proof"], "public_signals": s["public_signals"]})
}

fn lines(o: &Outcome) -> Vec<String> {
    o.receipts.iter().map(Receipt::line).collect()
}

/// `who`'s balance of the token inside intents.near (NEP-245 `mt_balance_of`, token id `nep141:<token>`).
async fn held(h: &Harness, who: &AccountId) -> R<u128> {
    let intents: AccountId = harness::INTENTS.parse()?;
    let v = h.view(&intents, "mt_balance_of", json!({"account_id": who, "token_id": format!("nep141:{}", h.token)})).await?;
    Ok(v.as_str().ok_or_else(|| format!("mt_balance_of: {v}"))?.parse()?)
}

/// intents.near's `ft_on_transfer` halted (`pause`) or resumed by its pause or unpause manager; reads back
/// `pa_is_paused`.
async fn halt(h: &Harness, admin: &Account, pause: bool) -> R<()> {
    let intents: AccountId = harness::INTENTS.parse()?;
    let method = if pause { "pa_pause_feature" } else { "pa_unpause_feature" };
    let o = h.call(admin, &intents, method, json!({"key": "ft_on_transfer"}), NearToken::from_yoctonear(0), Gas::from_tgas(30)).await?;
    assert_eq!(o.json(), Some(json!(true)), "{method}: the feature's state did not change");
    assert_eq!(h.view(&intents, "pa_is_paused", json!({"key": "ft_on_transfer"})).await?, json!(pause), "pa_is_paused after {method}");
    Ok(())
}

/// A's onward `ft_transfer_call(intents.near, amount, msg = to)`, signed by A and carried by the relayer.
async fn onward(h: &Harness, relayer: &Account, a: &Account, amount: u128, to: &AccountId) -> R<Outcome> {
    let args = json!({"receiver_id": harness::INTENTS, "amount": amount.to_string(), "msg": to});
    h.delegate_call(relayer, a, &h.token, "ft_transfer_call", args, 1, ONWARD_GAS).await
}

#[tokio::test]
async fn vt_s15_mock() -> R<()> {
    vt_s15(TokenKind::Mock).await
}

#[tokio::test]
async fn vt_s15_usdc() -> R<()> {
    vt_s15(TokenKind::Usdc).await
}

async fn vt_s15(kind: TokenKind) -> R<()> {
    let h = Harness::with_vault_and(kind).await?;
    let intents: AccountId = harness::INTENTS.parse()?;
    let admin = h.deploy_intents().await?;
    let _ = h.storage_deposit(&h.root, &intents).await?;
    let f = fixture();
    let u = h.account("u", 50).await?;
    let relayer = h.account("relayer", 50).await?;
    let a = h.account("alice", 50).await?;
    assert_eq!((relayer.id().as_str(), a.id().as_str()), (FEE_RECIPIENT, A), "the fixture's accounts");
    let w = &args()["withdrawal"];
    assert_eq!((&w["recipient"], &w["fee_recipient"], &w["relay_fee"], &w["register_deposit"]), (&json!(A), &json!(FEE_RECIPIENT), &json!(FEE.to_string()), &json!("0")));
    assert_eq!(args()["public_signals"][2], json!(WITHDRAWN.to_string()), "withdrawnValue");

    // the fixture's six notes
    let total: u128 = f["deposited"].as_str().unwrap().parse()?;
    h.mint(u.id(), total).await?;
    let prepay = NearToken::from_yoctonear(PREPAY_BYTES * YOCTO_PER_BYTE);
    for (p, value) in f["precommitments"].as_array().unwrap().iter().zip(f["values"].as_array().unwrap()) {
        let p = p.as_str().unwrap();
        let _ = h.call(&relayer, &h.vault, "storage_prepay", json!({"precommitment": p}), prepay, Gas::from_tgas(30)).await?;
        let msg = format!(r#"{{"precommitment":"{p}","depositor":"{}"}}"#, u.id());
        let _ = h
            .call(&u, &h.token, "ft_transfer_call", json!({"receiver_id": h.vault, "amount": value, "msg": msg}), NearToken::from_yoctonear(1), Gas::from_tgas(180))
            .await?;
    }
    assert_eq!(h.view(&h.vault, "leaves", json!({"from": 0, "limit": 10})).await?, f["leaves"], "the deposits' leaves are the fixture's");
    for x in [&relayer, &a] {
        let _ = h.storage_deposit(&h.root, x.id()).await?;
    }
    // the deposit address: a 64-hex id, never an account on chain, as a 1Click quote's
    let to: AccountId = near_sdk::env::sha256(format!("s15 {kind:?} deposit address").as_bytes()).iter().map(|b| format!("{b:02x}")).collect::<String>().parse()?;

    // 1. halted
    halt(&h, &admin, true).await?;
    let size = h.view(&h.vault, "state_tree", json!({})).await?["size"].as_u64().ok_or("state_tree size")?;
    let level = if size.is_power_of_two() { LEVEL_BYTES } else { 0 };
    let bytes = SPEND_BYTES - (64 - FEE_RECIPIENT.len() as u128) - (64 - A.len() as u128) + level;
    let attach = NearToken::from_yoctonear((bytes + REFUND_RESERVE_BYTES) * YOCTO_PER_BYTE + 2);
    let (v0, a0, r0) = (h.token_balance(&h.vault).await?, h.token_balance(a.id()).await?, h.token_balance(relayer.id()).await?);
    let o = h.call(&relayer, &h.vault, "withdraw", args(), attach, Gas::from_tgas(300)).await?;
    let _ = o.calls_exactly(&h.vault, "on_payout", 1)?;
    let paid = WITHDRAWN - FEE;
    assert_eq!(h.token_balance(a.id()).await?, a0 + paid, "A's payout");
    assert_eq!(h.token_balance(relayer.id()).await?, r0 + FEE, "the relayer's fee");
    assert_eq!(h.token_balance(&h.vault).await?, v0 - WITHDRAWN, "the vault's balance");
    let n = &args()["public_signals"][1];
    let spends = h.view(&h.vault, "spends", json!({"from": 0, "limit": 100})).await?;
    let row = spends.as_array().ok_or("spends: not a list")?.iter().find(|s| &s["nullifier_hash"] == n).ok_or("no spend row")?.clone();
    assert_eq!((&row["status"], &row["recipient"], &row["refund_value"]), (&json!("paid"), &json!(A), &json!("0")), "the spend row");
    h.i1().await?;
    println!("{kind:?} halted: the payout reached A ({a0} -> {}), the fee the relayer, the vault {v0} -> {}", a0 + paid, v0 - WITHDRAWN);

    let before = (h.token_balance(a.id()).await?, h.token_balance(&intents).await?, h.token_balance(&h.vault).await?, held(&h, &to).await?);
    assert_eq!(before.0, paid);
    let o = onward(&h, &relayer, &a, paid, &to).await?;
    let call = o.calls_exactly(&h.token, "ft_transfer_call", 1)?[0];
    assert!(call.ok() && call.predecessor == A, "A's ft_transfer_call: {}", call.line());
    let on = o.calls_exactly(&intents, "ft_on_transfer", 1)?[0];
    let f = on.failure().ok_or_else(|| format!("intents.near took a deposit while halted: {}", on.line()))?;
    assert!(f.contains(PAUSED), "want {PAUSED:?}, got {f}");
    let resolve = o.calls_exactly(&h.token, "ft_resolve_transfer", 1)?[0];
    assert!(resolve.ok(), "the token's resolve failed: {}", resolve.line());
    assert!(!o.receipts.iter().any(|r| r.executor == h.vault.as_str()), "a receipt reached the vault: {:#?}", lines(&o));
    let after = (h.token_balance(a.id()).await?, h.token_balance(&intents).await?, h.token_balance(&h.vault).await?, held(&h, &to).await?);
    assert_eq!(after, before, "A's onward call while halted: A's, intents.near's, the vault's or the deposit address's balance changed");
    h.i1().await?;
    println!("{kind:?} halted: A's onward call came back to A ({f}); A holds {}, the deposit address 0, the vault {}", after.0, after.2);

    // 2. resumed
    halt(&h, &admin, false).await?;
    let o = onward(&h, &relayer, &a, paid, &to).await?;
    o.expect_all_ok("A's onward call once resumed")?;
    let on = o.calls_exactly(&intents, "ft_on_transfer", 1)?[0];
    assert!(on.ok(), "{}", on.line());
    let now = (h.token_balance(a.id()).await?, h.token_balance(&intents).await?, h.token_balance(&h.vault).await?, held(&h, &to).await?);
    assert_eq!(now, (0, before.1 + paid, before.2, before.3 + paid), "(A, intents.near, the vault, the deposit address) once resumed");
    h.i1().await?;
    println!("{kind:?} resumed: the deposit address's balance inside intents.near {} -> {} (exactly {paid}), A holds 0\n{}", before.3, now.3, h.gas_table());
    Ok(())
}
