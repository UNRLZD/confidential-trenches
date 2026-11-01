// SPDX-License-Identifier: Apache-2.0
//! VT-S03's message rows in near-sandbox 2.13.4 (vault.md 5, V:1132; 2.5.1 rows 1-2, V:240-241): `ft_on_transfer`
//! takes only the pinned token as its caller and only the one deposit message
//! `{"precommitment":"<decimal>","depositor":"<account>"}`, both required, nothing else, at most 1,024 bytes. Runs only
//! with `--features sandbox`, through tests/harness/run.sh (`contracts/vault/tests/harness/run.sh --test deposit_msg`);
//! a plain `cargo test` builds this file empty.
//!
//! A refusal is a panic in `ft_on_transfer` (the 2.5.1 table's header: "fails = panic, so the token refunds the whole
//! amount"), so the token's `ft_resolve_transfer` gives the sender the whole amount back. Every case reads the
//! sender's token balance, the vault's token balance and the vault's whole raw state before and after: the balances
//! end where they began and not one state byte changes.
//!
//! 1. `a_direct_call_is_refused_{mock,usdc}`: anyone but the token calling `ft_on_transfer` (`NotTheToken`).
//! 2. `another_token_is_refused_{mock,usdc}`: a second token's `ft_transfer_call` with a good message (`NotTheToken`); the sender
//!    gets that token back.
//! 3. `every_bad_message_is_refused_{mock,usdc}`: bad JSON, a JSON array, a missing `depositor`, a missing `precommitment`, a third field, a
//!    message over 1,024 B, a precommitment as a JSON number, a non-canonical precommitment, p, an invalid account id
//!    and `depositor` = the vault.
//! 4. `the_kits_message_passes_the_message_checks_{mock,usdc}`: the kit's own bytes (packages/kit/src/vault/shapes.ts
//!    `vaultDepositMessage`), and the same message padded to exactly 1,024 B, pass rows 1-2 and, with no prepay on
//!    their precommitment, stop at row 6 (`NoPrepay`): refused like every case above. A deposit that lands is
//!    tests/s02.rs's.
//!
//! Each case runs on both tokens (vault.md 5): the mock token (`_mock`) and the real USDC wasm (`_usdc`, card
//! vault-sandbox-usdc); on USDC, case 2's other token is the same real USDC code at another account. Each prints its
//! gas table.
#![cfg(feature = "sandbox")]

mod harness;

use harness::{wasm_from_env, Harness, Outcome, Receipt, TokenKind, R, ONE_YOCTO, TOKEN_STORAGE};
use near_sdk::serde_json::json;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId};

/// 10 USDC (6 decimals): what each sender holds.
const HELD: u128 = 10_000_000;
/// 1 USDC, `MIN_DEPOSIT`: what each case sends.
const AMOUNT: u128 = 1_000_000;
/// The gas U signs for its `ft_transfer_call` (vault.md 2.10 (b)).
const GAS: Gas = Gas::from_tgas(180);
const P_DEC: &str = "21888242871839275222246405745257275088548364400416034343698204186575808495617";
/// The kit's bytes for (p − 1, "a" × 64), printed by `vaultDepositMessage` at kit-v1.2.
const KIT_MSG: &str = r#"{"precommitment":"21888242871839275222246405745257275088548364400416034343698204186575808495616","depositor":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#;
const HEX64: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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

/// What a case must leave unchanged: the sender's and the vault's balances on `token`, and the vault's raw state.
#[derive(Debug, PartialEq)]
struct Snapshot {
    sender: u128,
    vault: u128,
    state: Vec<(String, String)>,
}

async fn balance_on(h: &Harness, token: &AccountId, account: &AccountId) -> R<u128> {
    let v = h.view(token, "ft_balance_of", json!({"account_id": account})).await?;
    Ok(v.as_str().ok_or("ft_balance_of: not a string")?.parse()?)
}

async fn snapshot(h: &Harness, token: &AccountId, sender: &AccountId) -> R<Snapshot> {
    Ok(Snapshot { sender: balance_on(h, token, sender).await?, vault: balance_on(h, token, &h.vault).await?, state: vault_state(h).await? })
}

/// `sender`'s own `ft_transfer_call(vault, AMOUNT, msg)` on `token`, 1 yocto, 180 Tgas.
async fn transfer_call(h: &Harness, sender: &Account, token: &AccountId, msg: &str) -> R<Outcome> {
    let args = json!({"receiver_id": h.vault, "amount": AMOUNT.to_string(), "msg": msg});
    h.call_outcome(sender, token, "ft_transfer_call", args, ONE_YOCTO, GAS).await
}

/// The vault's one `ft_on_transfer` receipt in `o`.
fn on_transfer<'a>(h: &Harness, o: &'a Outcome) -> R<&'a Receipt> {
    Ok(o.calls_exactly(&h.vault, "ft_on_transfer", 1)?[0])
}

/// The case was refused in `ft_on_transfer` with `want` in its panic, the token's resolve ran and succeeded, and
/// nothing moved: `before` equals the snapshot read now.
async fn refused(h: &Harness, o: &Outcome, token: &AccountId, sender: &AccountId, before: &Snapshot, want: &str) -> R<()> {
    let r = on_transfer(h, o)?;
    let f = r.failure().ok_or_else(|| format!("{want}: ft_on_transfer succeeded: {}", r.line()))?;
    assert!(f.contains(want), "want {want:?} in the panic, got {f}");
    let resolve = o.calls_exactly(token, "ft_resolve_transfer", 1)?[0];
    assert!(resolve.ok(), "{want}: the resolve failed: {}", resolve.line());
    assert!(o.status.ok(), "{want}: the transaction failed: {:?}", o.status);
    let after = snapshot(h, token, sender).await?;
    assert_eq!(&after, before, "{want}: a balance or a state byte changed");
    println!("{want}: refused, {} Tgas in ft_on_transfer; sender {} and vault {} unchanged", r.gas_burnt as f64 / 1e12, after.sender, after.vault);
    Ok(())
}

/// The vault, `kind`'s token at TOKEN with the vault registered, and a sender `u` holding HELD.
async fn setup(kind: TokenKind) -> R<(Harness, Account)> {
    let h = Harness::with_vault_and(kind).await?;
    let u = h.account("u", 10).await?;
    h.mint(u.id(), HELD).await?;
    Ok((h, u))
}

#[tokio::test]
async fn a_direct_call_is_refused_mock() -> R<()> {
    a_direct_call_is_refused(TokenKind::Mock).await
}

#[tokio::test]
async fn a_direct_call_is_refused_usdc() -> R<()> {
    a_direct_call_is_refused(TokenKind::Usdc).await
}

async fn a_direct_call_is_refused(kind: TokenKind) -> R<()> {
    let (h, u) = setup(kind).await?;
    let token = h.token.clone();
    let before = snapshot(&h, &token, u.id()).await?;
    let args = json!({"sender_id": u.id(), "amount": AMOUNT.to_string(), "msg": KIT_MSG});
    let o = h.call_outcome(&u, &h.vault, "ft_on_transfer", args, NearToken::from_yoctonear(0), GAS).await?;
    let f = o.failure().ok_or("a direct ft_on_transfer succeeded")?;
    assert!(f.contains("NotTheToken"), "want NotTheToken, got {f}");
    assert_eq!(snapshot(&h, &token, u.id()).await?, before, "a direct call changed a balance or a state byte");
    println!("NotTheToken (direct): refused, {} Tgas", on_transfer(&h, &o)?.gas_burnt as f64 / 1e12);
    println!("{}", h.gas_table());
    Ok(())
}

#[tokio::test]
async fn another_token_is_refused_mock() -> R<()> {
    another_token_is_refused(TokenKind::Mock).await
}

#[tokio::test]
async fn another_token_is_refused_usdc() -> R<()> {
    another_token_is_refused(TokenKind::Usdc).await
}

async fn another_token_is_refused(kind: TokenKind) -> R<()> {
    let (h, u) = setup(kind).await?;
    // a second token: the same code as TOKEN's at another account, the vault and u registered on it
    let other = h.root.create_subaccount("othertoken").initial_balance(NearToken::from_near(30)).transact().await?.into_result()?;
    let other_id = other.id().clone();
    let reg = json!({"account_id": h.vault, "registration_only": true});
    match kind {
        TokenKind::Mock => {
            other.deploy(&wasm_from_env("MOCK_TOKEN_WASM")?).await?.into_result()?;
            let _ = h.call(&h.root, &other_id, "storage_deposit", reg, TOKEN_STORAGE, Gas::from_tgas(10)).await?;
            let mint = json!({"account_id": u.id(), "amount": HELD.to_string()});
            let _ = h.call(&h.root, &other_id, "mint", mint, NearToken::from_yoctonear(0), Gas::from_tgas(10)).await?;
        }
        TokenKind::Usdc => {
            let roles = h.usdc_roles()?;
            h.init_usdc(&other, roles).await?;
            let _ = h.call(&h.root, &other_id, "storage_deposit", reg, TOKEN_STORAGE, Gas::from_tgas(10)).await?;
            h.usdc_mint(&other_id, roles, u.id(), HELD).await?;
        }
    }
    let before = snapshot(&h, &other_id, u.id()).await?;
    assert_eq!(before.sender, HELD);
    let o = transfer_call(&h, &u, &other_id, KIT_MSG).await?;
    refused(&h, &o, &other_id, u.id(), &before, "NotTheToken").await?;
    println!("{}", h.gas_table());
    Ok(())
}

#[tokio::test]
async fn every_bad_message_is_refused_mock() -> R<()> {
    every_bad_message_is_refused(TokenKind::Mock).await
}

#[tokio::test]
async fn every_bad_message_is_refused_usdc() -> R<()> {
    every_bad_message_is_refused(TokenKind::Usdc).await
}

async fn every_bad_message_is_refused(kind: TokenKind) -> R<()> {
    let (h, u) = setup(kind).await?;
    let token = h.token.clone();
    let over = format!("{KIT_MSG}{}", " ".repeat(1_025 - KIT_MSG.len()));
    assert_eq!(over.len(), 1_025);
    let cases: Vec<(&str, String, &str)> = vec![
        ("bad JSON", "not json".into(), "InvalidMessage"),
        ("an empty message", "".into(), "InvalidMessage"),
        ("a JSON array", format!(r#"["1","{HEX64}"]"#), "not a JSON object"),
        ("a missing depositor", r#"{"precommitment":"1"}"#.into(), "missing field `depositor`"),
        ("a missing precommitment", format!(r#"{{"depositor":"{HEX64}"}}"#), "missing field `precommitment`"),
        ("a third field", format!(r#"{{"precommitment":"1","depositor":"{HEX64}","x":1}}"#), "unknown field `x`"),
        ("a repeated field", format!(r#"{{"precommitment":"1","precommitment":"2","depositor":"{HEX64}"}}"#), "duplicate field `precommitment`"),
        ("a message over 1,024 B", over, "MessageTooLong"),
        ("a precommitment as a JSON number", format!(r#"{{"precommitment":1,"depositor":"{HEX64}"}}"#), "InvalidMessage"),
        ("a precommitment with a leading zero", format!(r#"{{"precommitment":"01","depositor":"{HEX64}"}}"#), "InvalidNumber"),
        ("precommitment = p", format!(r#"{{"precommitment":"{P_DEC}","depositor":"{HEX64}"}}"#), "FieldOverflow"),
        ("an invalid account id", r#"{"precommitment":"1","depositor":"Not An Account"}"#.into(), "InvalidMessage"),
        ("depositor = the vault", format!(r#"{{"precommitment":"1","depositor":"{}"}}"#, h.vault), "DepositorIsTheVault"),
    ];
    for (name, msg, want) in &cases {
        let before = snapshot(&h, &token, u.id()).await?;
        assert_eq!(before.sender, HELD, "{name}: the sender does not hold HELD before the case");
        let o = transfer_call(&h, &u, &token, msg).await?;
        refused(&h, &o, &token, u.id(), &before, want).await.map_err(|e| format!("{name}: {e}"))?;
    }
    println!("{}", h.gas_table());
    Ok(())
}

#[tokio::test]
async fn the_kits_message_passes_the_message_checks_mock() -> R<()> {
    the_kits_message_passes_the_message_checks(TokenKind::Mock).await
}

#[tokio::test]
async fn the_kits_message_passes_the_message_checks_usdc() -> R<()> {
    the_kits_message_passes_the_message_checks(TokenKind::Usdc).await
}

async fn the_kits_message_passes_the_message_checks(kind: TokenKind) -> R<()> {
    let (h, u) = setup(kind).await?;
    let token = h.token.clone();
    let padded = format!("{KIT_MSG}{}", " ".repeat(1_024 - KIT_MSG.len()));
    assert_eq!(padded.len(), 1_024);
    for (name, msg) in [("the kit's message", KIT_MSG.to_string()), ("exactly 1,024 B", padded)] {
        let before = snapshot(&h, &token, u.id()).await?;
        let o = transfer_call(&h, &u, &token, &msg).await?;
        // rows 1-2 passed: the first refusal is row 6's, as no one prepaid the precommitment
        refused(&h, &o, &token, u.id(), &before, "NoPrepay").await.map_err(|e| format!("{name}: {e}"))?;
    }
    println!("{}", h.gas_table());
    Ok(())
}
