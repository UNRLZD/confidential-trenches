// SPDX-License-Identifier: Apache-2.0
//! VT-S14 (vault.md 5, V:1141) in near-sandbox 2.13.4, on the mock token and on the real USDC wasm at TOKEN: the vault
//! not registered on the token, then registered. Runs only with `--features sandbox`, through tests/harness/run.sh
//! (`contracts/vault/tests/harness/run.sh --test s14`); a plain `cargo test` builds this file empty.
//!
//! The vault is deployed by the 2.8 recipe and the token set up as every money test sets it up, but the token's
//! `storage_deposit` for the vault, which `Harness::with_vault_and` sends and the deploy recipe sends before the vault
//! is listed, is left out until step 3.
//!
//! 1. The kit's path (wallet V1): the relayer prepays P, then carries U's own `TOKEN.ft_transfer_call(vault, amount,
//!    msg)` as a NEP-366 `DelegateAction`. The token's `ft_transfer_call` fails ("The account <vault> is not
//!    registered": the mock's `move_balance`, tests/mock-token/src/lib.rs l.208; USDC's own text, as the research gas
//!    proof read it, proofs/g1-vault-gas/sandbox/results/runs/20261026T171345Z-deposit-halt/deposit-halt.json), no
//!    receipt reaches the vault, U keeps every unit, the token's supply, the vault's state and P's prepay are as they
//!    were.
//! 2. Through intents.near (accepted by the vault, never the kit's path): S's tokens inside intents.near go out by S's
//!    signed `ft_withdraw` with the deposit message, carried in `execute_intents`. intents.near debits S
//!    (DF `contracts/defuse/src/contract/tokens/nep141/withdraw.rs` l.60-74), the token's `ft_transfer_call` to the
//!    unregistered vault fails, and `ft_resolve_withdraw` treats a failed `ft_transfer_call` as all of it used, so it
//!    refunds nothing (l.164-173: `Err(_) => amount.0`, "do not refund on failed `ft_transfer_call`"). The test
//!    records that loss exactly: S's balance inside intents.near falls by the amount, the token still holds the amount
//!    at intents.near's account, which is no one's balance inside it, and the vault never sees it. This is why the 2.8
//!    recipe registers the vault before it is listed.
//! 3. The vault registered (`storage_deposit` by root): U's same call, signed again, lands on P's prepay from step 1,
//!    and a second S's `ft_withdraw` lands on step 2's prepay: each returns `"0"`, logs its `deposited` event, its leaf
//!    is the commitment computed here, `totals().deposited` rises by the amount, and I1 holds.
#![cfg(feature = "sandbox")]

mod harness;

use blindfill_vault::constants::TOKEN;
use blindfill_vault::context::{field_of, label_of, scope_for};
use blindfill_vault::field;
use blindfill_vault::poseidon::PoseidonT4;
use blindfill_vault::Bytes32;
use harness::{Harness, Outcome, Receipt, TokenKind, R, YOCTO_PER_BYTE};
use near_sdk::json_types::Base64VecU8;
use near_sdk::serde_json::{self, json, Value};
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId};

/// What each U and S holds: 10 USDC (6 decimals).
const HELD: u128 = 10_000_000;
/// The gas U signs for its `ft_transfer_call` (vault.md 2.5.1, 2.10 (b)).
const GAS: Gas = Gas::from_tgas(180);
const PREPAY_GAS: Gas = Gas::from_tgas(30);
/// The kit's prepay whenever a tree may grow (2.10 (h)); the first two deposits each grow both trees (2.3).
const PREPAY_BYTES: u64 = 904;

fn dec(b: &Bytes32) -> String {
    field::to_decimal(&field::from_be(b))
}

/// A precommitment as the device makes one: a full-size field element, `keccak256(tag) mod p`.
fn precommitment(tag: &str) -> Bytes32 {
    field::to_be(&field_of(tag.as_bytes()))
}

fn message(p: &Bytes32, depositor: &AccountId) -> String {
    format!(r#"{{"precommitment":"{}","depositor":"{depositor}"}}"#, dec(p))
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

async fn prepay(h: &Harness, payer: &Account, p: &Bytes32) -> R<()> {
    let deposit = NearToken::from_yoctonear(PREPAY_BYTES as u128 * YOCTO_PER_BYTE);
    let _ = h.call(payer, &h.vault, "storage_prepay", json!({"precommitment": dec(p)}), deposit, PREPAY_GAS).await?;
    Ok(())
}

/// U's own `ft_transfer_call(vault, amount, msg)` on the token, 1 yocto and 180 Tgas, as a `DelegateAction` the
/// relayer sends.
async fn u_call(h: &Harness, relayer: &Account, u: &Account, amount: u128, msg: &str) -> R<Outcome> {
    let args = json!({"receiver_id": h.vault, "amount": amount.to_string(), "msg": msg});
    h.delegate_call(relayer, u, &h.token, "ft_transfer_call", args, 1, GAS).await
}

fn lines(o: &Outcome) -> Vec<String> {
    o.receipts.iter().map(Receipt::line).collect()
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

/// `totals().deposited`.
async fn deposited(h: &Harness) -> R<u128> {
    let t = h.view(&h.vault, "totals", json!({})).await?;
    Ok(t["deposited"].as_str().ok_or_else(|| format!("totals: {t}"))?.parse()?)
}

async fn supply(h: &Harness) -> R<u128> {
    let v = h.view(&h.token, "ft_total_supply", json!({})).await?;
    Ok(v.as_str().ok_or("ft_total_supply: not a string")?.parse()?)
}

/// The vault's `ft_on_transfer` receipt `r` landed `amount` on `p` for `depositor` as deposit `nonce` (1-based, leaf
/// `nonce - 1`): `"0"` returned, its `deposited` event, its leaf the commitment Poseidon(amount, label, p) with the
/// label from the vault's scope and the nonce (2.5.1 rows 8-10), and `totals().deposited` = `before` + amount.
async fn expect_note(h: &Harness, r: &Receipt, nonce: u64, depositor: &AccountId, p: &Bytes32, amount: u128, before: u128) -> R<()> {
    assert_eq!(returned(r)?, "\"0\"", "deposit {nonce}: ft_on_transfer did not return \"0\"");
    let label = field::to_be(&label_of(&scope_for(h.vault.as_str(), TOKEN), nonce));
    let mut a = [0u8; 32];
    a[16..].copy_from_slice(&amount.to_be_bytes());
    let commitment = PoseidonT4::new().hash(&a, &label, p);
    let event = format!(
        r#"EVENT_JSON:{{"standard":"blindfill-vault","version":"1.0.0","event":"deposited","data":[{{"depositor":"{depositor}","commitment":"{}","label":"{}","value":"{amount}","precommitment":"{}"}}]}}"#,
        dec(&commitment),
        dec(&label),
        dec(p)
    );
    assert!(r.logs.contains(&event), "deposit {nonce}: no deposited event {event} in {:?}", r.logs);
    let leaf = h.view(&h.vault, "leaves", json!({"from": nonce - 1, "limit": 1})).await?;
    assert_eq!(leaf, json!([dec(&commitment)]), "deposit {nonce}: the leaf");
    assert_eq!(deposited(h).await?, before + amount, "deposit {nonce}: totals().deposited");
    println!("deposit {nonce}: the note landed, leaf {} at {}, deposited {before} -> {}", dec(&commitment), nonce - 1, before + amount);
    Ok(())
}

// ---- intents.near's ft_withdraw with msg (as tests/s02.rs sends it) ----

/// `ns` nanoseconds since the Unix epoch as RFC 3339 with milliseconds, the form intents.near reads a deadline in
/// (DF `crates/primitives/time`).
fn rfc3339(ns: u64) -> String {
    let (secs, ms) = (ns / 1_000_000_000, (ns / 1_000_000) % 1_000);
    let (days, rem) = ((secs / 86_400) as i64, secs % 86_400);
    // days to a civil date (H. Hinnant, chrono-compatible)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if mo <= 2 { 1 } else { 0 };
    format!("{y:04}-{mo:02}-{d:02}T{:02}:{:02}:{:02}.{ms:03}Z", rem / 3_600, rem % 3_600 / 60, rem % 60)
}

/// `signer`'s `ft_withdraw` of `amount` to the vault with `msg`, as intents.near's raw_ed25519 signed payload (DF
/// `core/src/payload/raw.rs`): deadline 10 minutes past the final block, a versioned nonce under the current salt.
async fn ft_withdraw_intent(h: &Harness, signer: &Account, amount: u128, msg: &str) -> R<Value> {
    let intents: AccountId = harness::INTENTS.parse()?;
    let salt = h.view(&intents, "current_salt", json!({})).await?;
    let salt = salt.as_str().ok_or_else(|| format!("current_salt: {salt}"))?;
    let salt: Vec<u8> = (0..4).map(|i| u8::from_str_radix(&salt[2 * i..2 * i + 2], 16)).collect::<Result<_, _>>()?;
    let block = h.rpc("block", json!({"finality": "final"})).await?;
    let now: u64 = block["result"]["header"]["timestamp_nanosec"].as_str().ok_or_else(|| format!("block: {block}"))?.parse()?;
    let deadline = now + 600 * 1_000_000_000;
    // magic 5628f6c6, version 0, salt, the nonce's deadline (ns, LE), its start (ns, LE), 7 bytes unique to this call
    let mut nonce = vec![0x56, 0x28, 0xf6, 0xc6, 0];
    nonce.extend(&salt);
    nonce.extend(deadline.to_le_bytes());
    nonce.extend(now.to_le_bytes());
    nonce.extend(&near_sdk::env::sha256(format!("{} {now} {msg}", signer.id()).as_bytes())[..7]);
    let payload = json!({
        "signer_id": signer.id(), "verifying_contract": intents, "deadline": rfc3339(deadline),
        "nonce": serde_json::to_value(Base64VecU8(nonce))?,
        "intents": [{"intent": "ft_withdraw", "token": h.token, "receiver_id": h.vault, "amount": amount.to_string(), "msg": msg}],
    })
    .to_string();
    let sk: near_crypto::SecretKey = signer.secret_key().to_string().parse().map_err(|e| format!("key: {e}"))?;
    Ok(json!({"standard": "raw_ed25519", "payload": payload, "public_key": sk.public_key().to_string(),
              "signature": sk.sign(payload.as_bytes()).to_string()}))
}

/// `who`'s balance of the token inside intents.near (NEP-245 `mt_balance_of`, token id `nep141:<token>`).
async fn held(h: &Harness, who: &AccountId) -> R<u128> {
    let intents: AccountId = harness::INTENTS.parse()?;
    let v = h.view(&intents, "mt_balance_of", json!({"account_id": who, "token_id": format!("nep141:{}", h.token)})).await?;
    Ok(v.as_str().ok_or_else(|| format!("mt_balance_of: {v}"))?.parse()?)
}

/// A fresh S holding HELD of the token inside intents.near, by its own `ft_transfer_call` in (0.5 N for its gas).
async fn new_s(h: &Harness) -> R<Account> {
    let intents: AccountId = harness::INTENTS.parse()?;
    let s = h.implicit_account(500).await?;
    h.mint(s.id(), HELD).await?;
    let into = json!({"receiver_id": intents, "amount": HELD.to_string(), "msg": s.id()});
    let _ = h.call(&s, &h.token, "ft_transfer_call", into, harness::ONE_YOCTO, Gas::from_tgas(100)).await?;
    assert_eq!(held(h, s.id()).await?, HELD, "S's balance inside intents.near");
    Ok(s)
}

/// `s`'s `ft_withdraw` of `amount` to the vault with `msg`, in `execute_intents` carried by the relayer, read raw.
async fn s_withdraw(h: &Harness, relayer: &Account, s: &Account, amount: u128, msg: &str) -> R<Outcome> {
    let intents: AccountId = harness::INTENTS.parse()?;
    let signed = ft_withdraw_intent(h, s, amount, msg).await?;
    h.call_outcome(relayer, &intents, "execute_intents", json!({"signed": [signed]}), NearToken::from_yoctonear(0), Gas::from_tgas(300)).await
}

#[tokio::test]
async fn vt_s14_mock() -> R<()> {
    vt_s14(TokenKind::Mock).await
}

#[tokio::test]
async fn vt_s14_usdc() -> R<()> {
    vt_s14(TokenKind::Usdc).await
}

async fn vt_s14(kind: TokenKind) -> R<()> {
    // the vault by the 2.8 recipe and the token, without the vault's registration on it
    let mut h = Harness::start().await?;
    let _ = h.deploy_vault().await?;
    match kind {
        TokenKind::Mock => h.deploy_mock_token().await?,
        TokenKind::Usdc => h.deploy_usdc().await?,
    }
    assert!(h.view(&h.token, "storage_balance_of", json!({"account_id": h.vault})).await?.is_null(), "the vault is registered on the token");
    let intents: AccountId = harness::INTENTS.parse()?;
    let _admin = h.deploy_intents().await?;
    let _ = h.storage_deposit(&h.root, &intents).await?;
    let relayer = h.account("relayer", 50).await?;
    let unregistered = format!("The account {} is not registered", h.vault);

    // 1. the kit's path: U's call fails whole at the token
    let u = h.implicit_account(10).await?;
    h.mint(u.id(), HELD).await?;
    let p = precommitment(&format!("s14 {kind:?} U"));
    prepay(&h, &relayer, &p).await?;
    let before = (h.token_balance(u.id()).await?, h.token_balance(&h.vault).await?, supply(&h).await?, vault_state(&h).await?);
    assert_eq!(before.0, HELD);
    let o = u_call(&h, &relayer, &u, HELD, &message(&p, u.id())).await?;
    let call = o.calls_exactly(&h.token, "ft_transfer_call", 1)?[0];
    assert_eq!(call.predecessor, u.id().as_str(), "ft_transfer_call's predecessor is not U");
    let f = call.failure().ok_or_else(|| format!("U's call to the unregistered vault did not fail at the token: {}", call.line()))?;
    assert!(f.contains(&unregistered), "want {unregistered:?}, got {f}");
    assert!(!o.receipts.iter().any(|r| r.executor == h.vault.as_str()), "a receipt reached the vault: {:#?}", lines(&o));
    let _ = o.calls_exactly(&h.token, "ft_resolve_transfer", 0)?;
    let after = (h.token_balance(u.id()).await?, h.token_balance(&h.vault).await?, supply(&h).await?, vault_state(&h).await?);
    assert_eq!(after, before, "U's call to the unregistered vault moved a unit or wrote a state byte (P's prepay included)");
    println!("{kind:?} unregistered, U's call: failed whole at the token ({f}), U keeps {HELD}, the vault untouched, P's prepay stays");

    // 2. through intents.near: S is debited inside intents.near and refunded nothing (the loss, recorded)
    let s = new_s(&h).await?;
    let p2 = precommitment(&format!("s14 {kind:?} through intents.near"));
    prepay(&h, &relayer, &p2).await?;
    let before = (h.token_balance(&intents).await?, h.token_balance(&h.vault).await?, supply(&h).await?, vault_state(&h).await?);
    let o = s_withdraw(&h, &relayer, &s, HELD, &message(&p2, s.id())).await?;
    let call = o.calls_exactly(&h.token, "ft_transfer_call", 1)?[0];
    assert_eq!(call.predecessor, intents.as_str(), "ft_transfer_call's predecessor is not intents.near");
    let f = call.failure().ok_or_else(|| format!("intents.near's ft_transfer_call to the unregistered vault did not fail: {}", call.line()))?;
    assert!(f.contains(&unregistered), "want {unregistered:?}, got {f}");
    assert!(!o.receipts.iter().any(|r| r.executor == h.vault.as_str()), "a receipt reached the vault: {:#?}", lines(&o));
    let resolve = o.calls_exactly(&intents, "ft_resolve_withdraw", 1)?[0];
    assert!(resolve.ok(), "ft_resolve_withdraw failed: {}", resolve.line());
    assert_eq!(returned(resolve)?, format!("\"{HELD}\""), "ft_resolve_withdraw counted other than all of it used");
    let after = (h.token_balance(&intents).await?, h.token_balance(&h.vault).await?, supply(&h).await?, vault_state(&h).await?);
    assert_eq!(after, before, "the failed withdraw moved a unit on the token or wrote a vault state byte");
    assert_eq!(held(&h, s.id()).await?, 0, "S's balance inside intents.near: refunded");
    println!(
        "{kind:?} unregistered, through intents.near: LOSS RECORDED: S's {HELD} inside intents.near debited, refunded 0 \
         (DF withdraw.rs l.164-173); the token still holds it at intents.near ({}), no one's balance inside it; the vault untouched",
        after.0
    );

    // 3. registered: U's same call lands on P, and a second S's ft_withdraw lands on P2
    let _ = h.storage_deposit(&h.root, &h.vault).await?;
    assert!(!h.view(&h.token, "storage_balance_of", json!({"account_id": h.vault})).await?.is_null(), "the vault is not registered");
    let o = u_call(&h, &relayer, &u, HELD, &message(&p, u.id())).await?;
    o.expect_all_ok("U's call once the vault is registered")?;
    let r = o.calls_exactly(&h.vault, "ft_on_transfer", 1)?[0];
    expect_note(&h, r, 1, u.id(), &p, HELD, 0).await?;
    assert_eq!((h.token_balance(u.id()).await?, h.token_balance(&h.vault).await?), (0, HELD), "U's and the vault's balances");
    h.i1().await?;
    let s2 = new_s(&h).await?;
    let v0 = h.token_balance(&h.vault).await?;
    let o = s_withdraw(&h, &relayer, &s2, HELD, &message(&p2, s2.id())).await?;
    o.expect_all_ok("the ft_withdraw once the vault is registered")?;
    let r = o.calls_exactly(&h.vault, "ft_on_transfer", 1)?[0];
    expect_note(&h, r, 2, s2.id(), &p2, HELD, HELD).await?;
    assert_eq!(h.token_balance(&h.vault).await?, v0 + HELD, "the vault's balance");
    assert_eq!(held(&h, s2.id()).await?, 0, "S2's balance inside intents.near");
    h.i1().await?;
    println!("{kind:?} registered: U's call landed on P's prepay from step 1, S2's ft_withdraw on P2's\n{}", h.gas_table());
    Ok(())
}
