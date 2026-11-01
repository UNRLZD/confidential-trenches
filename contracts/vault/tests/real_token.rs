// SPDX-License-Identifier: Apache-2.0
//! The real tokens in near-sandbox 2.13.4 (vault.md 5, V3.1, card vault-sandbox-usdc): mainnet's USDC and intents.near
//! at DF, run as their pinned bytes (tests/fixtures/real-wasm.json). Runs only with `--features sandbox`, through
//! tests/harness/run.sh (`contracts/vault/tests/harness/run.sh --test real_token`); a plain `cargo test` builds this
//! file empty.
//!
//! 1. `the_pins_refuse_other_bytes`: the fetched USDC and intents.near files are their pins, and one changed byte or
//!    one byte less is refused.
//! 2. `usdc_halt_can_be_driven`: the smoke run. A transfer lands; the pausers halt USDC; the same transfer is refused
//!    at the token with its halt message and nothing moves; the pausers unhalt; the same transfer lands. Balances and
//!    the total supply compared exactly.
//! 3. `intents_at_df_takes_a_usdc_deposit`: intents.near at DF takes a deposit of the real USDC
//!    (`ft_transfer_call` with an empty message credits the sender): its `mt_balance_of` and both USDC balances move by
//!    exactly the amount.
//!
//! Each prints its gas table.
#![cfg(feature = "sandbox")]

mod harness;

use harness::{check_pin, pin, wasm_from_env, Harness, TokenKind, INTENTS, ONE_YOCTO, R, TOKEN, USDC_HALTED};
use near_sdk::json_types::Base64VecU8;
use near_sdk::serde_json::{self, json};
use near_workspaces::types::Gas;
use near_workspaces::{Account, AccountId};

/// 10 USDC (6 decimals).
const HELD: u128 = 10_000_000;
/// 1 USDC.
const AMOUNT: u128 = 1_000_000;

#[test]
fn the_pins_refuse_other_bytes() -> R<()> {
    for name in ["usdc", "intents"] {
        let p = pin(name)?;
        let w = wasm_from_env(&p.env)?;
        check_pin(&p, &w)?;
        let mut flipped = w.clone();
        flipped[w.len() / 2] ^= 1;
        let e = check_pin(&p, &flipped).expect_err("a changed byte passed the pin");
        assert!(e.starts_with("REFUSED"), "{e}");
        assert!(check_pin(&p, &w[..w.len() - 1]).is_err(), "{name}: one byte less passed the pin");
        println!("{name}: {} B sha256 {} is the pin; a changed byte and one byte less are refused", p.bytes, p.sha256);
    }
    Ok(())
}

async fn usdc_balance(h: &Harness, a: &AccountId) -> R<u128> {
    h.token_balance(a).await
}

async fn supply(h: &Harness) -> R<u128> {
    Ok(h.view(&h.token, "ft_total_supply", json!({})).await?.as_str().ok_or("ft_total_supply: not a string")?.parse()?)
}

/// `from`'s `ft_transfer(to, AMOUNT)`, 1 yocto, 30 Tgas, read raw.
async fn transfer(h: &Harness, from: &Account, to: &AccountId) -> R<harness::Outcome> {
    let args = json!({"receiver_id": to, "amount": AMOUNT.to_string()});
    h.call_outcome(from, &h.token, "ft_transfer", args, ONE_YOCTO, Gas::from_tgas(30)).await
}

#[tokio::test]
async fn usdc_halt_can_be_driven() -> R<()> {
    let h = Harness::with_vault_and(TokenKind::Usdc).await?;
    assert_eq!(h.token.as_str(), TOKEN);
    let (a, b) = (h.account("a", 10).await?, h.account("b", 10).await?);
    h.mint(a.id(), HELD).await?;
    let _ = h.storage_deposit(&h.root, b.id()).await?;
    let total = supply(&h).await?;
    assert_eq!((usdc_balance(&h, a.id()).await?, usdc_balance(&h, b.id()).await?), (HELD, 0));

    // 1. a transfer lands
    transfer(&h, &a, b.id()).await?.expect_all_ok("the transfer before the halt")?;
    assert_eq!((usdc_balance(&h, a.id()).await?, usdc_balance(&h, b.id()).await?), (HELD - AMOUNT, AMOUNT));
    println!("1. transfer: a {} b {}", HELD - AMOUNT, AMOUNT);

    // 2. halt: the pausers' multisig Pause, and the token answers every call, views included, with its halt message
    let _ = h.usdc_halt(true).await?;
    // read raw over RPC: near-workspaces' view error drops the contract's message
    let args = serde_json::to_value(Base64VecU8(json!({"account_id": a.id()}).to_string().into_bytes()))?;
    let q = json!({"request_type": "call_function", "finality": "optimistic", "account_id": h.token,
                   "method_name": "ft_balance_of", "args_base64": args});
    let view = h.rpc("query", q).await?.to_string();
    assert!(view.contains(USDC_HALTED), "a view while halted: want {USDC_HALTED:?}, got {view}");
    println!("2. halted: ft_balance_of answers {USDC_HALTED:?}");

    // 3. the same transfer is refused at the token
    let o = transfer(&h, &a, b.id()).await?;
    let f = o.failure().ok_or("a transfer landed while USDC was halted")?;
    assert!(f.contains(USDC_HALTED), "want {USDC_HALTED:?}, got {f}");
    let r = o.calls_exactly(&h.token, "ft_transfer", 1)?[0];
    println!("3. refused while halted: {}", r.line());

    // 4. unhalt: nothing moved while halted, and the same transfer lands
    let _ = h.usdc_halt(false).await?;
    assert_eq!((usdc_balance(&h, a.id()).await?, usdc_balance(&h, b.id()).await?), (HELD - AMOUNT, AMOUNT), "a balance moved while halted");
    assert_eq!(supply(&h).await?, total, "the supply moved while halted");
    transfer(&h, &a, b.id()).await?.expect_all_ok("the transfer after the unhalt")?;
    assert_eq!((usdc_balance(&h, a.id()).await?, usdc_balance(&h, b.id()).await?), (HELD - 2 * AMOUNT, 2 * AMOUNT));
    assert_eq!(supply(&h).await?, total);
    println!("4. unhalted: nothing moved while halted; the same transfer lands: a {} b {}", HELD - 2 * AMOUNT, 2 * AMOUNT);
    println!("{}", h.gas_table());
    Ok(())
}

#[tokio::test]
async fn intents_at_df_takes_a_usdc_deposit() -> R<()> {
    let h = Harness::with_vault_and(TokenKind::Usdc).await?;
    let _admin = h.deploy_intents().await?;
    let intents: AccountId = INTENTS.parse()?;
    let _ = h.storage_deposit(&h.root, &intents).await?;
    let u = h.account("u", 10).await?;
    h.mint(u.id(), HELD).await?;
    let token_id = format!("nep141:{}", h.token);
    let mt_args = json!({"account_id": u.id(), "token_id": token_id});
    assert_eq!(h.view(&intents, "mt_balance_of", mt_args.clone()).await?, json!("0"));
    let args = json!({"receiver_id": intents, "amount": AMOUNT.to_string(), "msg": ""});
    let o = h.call(&u, &h.token, "ft_transfer_call", args, ONE_YOCTO, Gas::from_tgas(100)).await?;
    o.calls_exactly(&intents, "ft_on_transfer", 1)?;
    assert_eq!(h.view(&intents, "mt_balance_of", mt_args).await?, json!(AMOUNT.to_string()), "intents.near credited u another amount");
    assert_eq!(usdc_balance(&h, u.id()).await?, HELD - AMOUNT);
    assert_eq!(usdc_balance(&h, &intents).await?, AMOUNT);
    println!("intents.near at DF: u's deposit of {AMOUNT} credited ({token_id}), USDC u {} intents.near {AMOUNT}", HELD - AMOUNT);
    println!("{}", h.gas_table());
    Ok(())
}
