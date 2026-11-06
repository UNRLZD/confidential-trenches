// SPDX-License-Identifier: Apache-2.0
//! VT-S13 (vault.md 5, V:1149; V3.4) in near-sandbox 2.13.4, on the mock token and on the real USDC wasm at TOKEN:
//! a deposit's gas through intents.near's `ft_withdraw` with msg (a path the vault accepts and the kit never signs),
//! at tree sizes 1, 2^10 and a forced depth 32, and the intents.near path's `min_gas` set from it. Runs only with
//! `--features sandbox`, through tests/harness/run.sh (`contracts/vault/tests/harness/run.sh --test s13`); a plain
//! `cargo test` builds this file empty.
//!
//! The path: S's tokens inside intents.near at DF go out by S's signed `ft_withdraw` with the deposit message and a
//! `min_gas`, carried in `execute_intents` by a relayer. intents.near calls the token's `ft_transfer_call` with
//! `min_gas` as its static gas and every unused gas unit on top (DF `contracts/defuse/src/contract/tokens/nep141/
//! withdraw.rs` l.136-140, unused weight 1); the token passes most of it to the vault's `ft_on_transfer` (NCS
//! `core_impl.rs`; the mock's split in tests/harness/mod.rs): the box's run read 19.4 Tgas kept by the token, under
//! the 30 the rule counts. With no `min_gas` signed, DF uses
//! 50 Tgas, and never less than 30 (`contracts/defuse/core/src/intents/tokens.rs` l.159-203).
//!
//! One vault per token, three deposits by one S (a 64-hex implicit account, the longest depositor a message names),
//! each read at final with every receipt's gas burnt and the gas each function call was given:
//! 1. size 1: the vault's first deposit, into both empty trees;
//! 2. size 2^10: both trees patched to size 2^10 - 1 and depth 10 with a side node at every level, so the insert at
//!    index 2^10 - 1 hashes all 10 levels, the costliest insert at that size (tests/s10.rs `seed_depth32`'s patch);
//! 3. depth 32: both trees patched to size 2^32 - 1 and depth 32, so the insert hashes all 32 levels, as tests/s10.rs
//!    forces it (vault.md 2.11). Here the relayer attaches about what `execute_intents` needs, so the token's call
//!    gets the signed `min_gas` and under SLACK + 1 Tgas more (read from its receipt; 1.728 over in the box's run).
//!    Runs 1 and 2 attach 300 Tgas, and their leftover (the token call's gas less `min_gas`) sizes run 3's attachment.
//!    a. No `min_gas` signed (DF's 50 Tgas): the vault refuses for want of gas, S is refunded in full inside
//!       intents.near, and no state byte or token unit moves.
//!    b. The kit's `min_gas` signed, and the relayer attaching 1 Tgas under what that floor needs: intents.near fails
//!       the whole `execute_intents`, so no token call is made and S's balance inside intents.near is unchanged. This
//!       is the run that depends on the signed value: DF gives the token `min_gas` plus every unused gas unit
//!       (withdraw.rs l.136-140), so with gas to spare a wrong `min_gas` (in the wrong units, or under a key DF does
//!       not read: FtWithdraw has no deny_unknown_fields) lands as well as the right one. `VT_S13_PLANT=units` signs
//!       it as gas units instead of Tgas, and `VT_S13_PLANT=key` under `minGas`: either must fail here.
//!    c. The kit's `min_gas` signed and SLACK attached over its need: lands. This proves the value is enough, not that
//!       less fails: on this measure about 113 Tgas would land (94.027 for the vault and the 19.4 the token kept);
//!       only the rule's assert below holds the value at 156.
//!
//! Every landed deposit returns `"0"`, logs its `deposited` event for S, the amount and P, its leaf is that event's
//! commitment = Poseidon(value, label, P) at the insert's index, and I1 holds. The rule (vault.md 2.5.1, V:349):
//! `min_gas` = (the vault's worst `ft_on_transfer` × 1.059, testnet's trie-read margin, + the token's 30 Tgas) × 1.2,
//! rounded up to a whole Tgas. The kit's `VAULT_ALSO_ACCEPTS[0].min_gas_tgas` (packages/kit/src/vault/shapes.ts),
//! read here as tests/events.rs reads the kit's events, must not be under it (else a deposit can run short) nor a
//! Tgas or more over it (else it is stale and must be derived again). The 180 Tgas U signs for its own `ft_transfer_call`
//! rests on U's measured call (vault.md 2.5.1, tests/s02.rs) and is not this figure.
#![cfg(feature = "sandbox")]

mod harness;

use blindfill_vault::context::field_of;
use blindfill_vault::field;
use blindfill_vault::Bytes32;
use harness::{Harness, Receipt, Sent, TokenKind, R, TGAS, YOCTO_PER_BYTE};
use near_sdk::json_types::Base64VecU8;
use near_sdk::serde_json::{self, json, Value};
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId};

/// The `min_gas` an intents.near `ft_withdraw` into the vault signs, in Tgas: the kit's `VAULT_ALSO_ACCEPTS[0]
/// .min_gas_tgas`, the only line of shapes.ts that declares VAULT_ALSO_ACCEPTS. Measured on run.sh's host build of
/// the vault (cargo-near non-reproducible-wasm on Linux x86_64, the box's and CI's), whose code the review found equal
/// to the reproducible build's apart from data bytes, in near-sandbox 2.13.4: the vault's `ft_on_transfer` at depth
/// 32 burnt 94.027 Tgas on the mock token and 94.023 on the real USDC wasm; (94.027 × 1.059 + 30) × 1.2 = 155.489,
/// rounded up to 156. It was 180 (vault.md 2.5.1, D) until this measure.
fn kit_min_gas() -> u64 {
    harness::kit_intents_min_gas()
}
/// testnet's trie-read margin over the sandbox (vault.md 2.5.1, G1 RESULT §3).
const TESTNET_MARGIN: f64 = 1.059;
/// What the token keeps of its `ft_transfer_call`'s gas (NCS `GAS_FOR_FT_TRANSFER_CALL`).
const TOKEN_KEEPS: f64 = 30.0;
const HEADROOM: f64 = 1.2;
/// DF's `min_gas` for an `ft_transfer_call` when none is signed.
const DF_DEFAULT_MIN_GAS: u64 = 50;
/// What the tight runs of step 3 attach over `execute_intents`' need (the token's call gets under SLACK + 1 Tgas over
/// `min_gas`, since the leftover is cut in whole Tgas).
const SLACK: u64 = 1;
const RELAYER_GAS: u64 = 300;
/// What S holds inside intents.near, and each deposit: 10 USDC and 1 USDC (MIN_DEPOSIT), 6 decimals.
const HELD: u128 = 10_000_000;
const AMOUNT: u128 = 1_000_000;
const PREPAY_GAS: Gas = Gas::from_tgas(30);
/// The kit's prepay whenever a tree may grow (2.10 (h)).
const PREPAY_BYTES: u128 = 904;
const SIZE_2_10: u64 = (1 << 10) - 1;
const SIZE_2_32: u64 = (1 << 32) - 1;

/// vault.md 2.5.1's rule on a worst case of `worst` Tgas.
fn rule(worst: f64) -> f64 {
    (worst * TESTNET_MARGIN + TOKEN_KEEPS) * HEADROOM
}

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

fn tgas(g: u64) -> f64 {
    g as f64 / TGAS
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
    let deposit = NearToken::from_yoctonear(PREPAY_BYTES * YOCTO_PER_BYTE);
    let _ = h.call(payer, &h.vault, "storage_prepay", json!({"precommitment": dec(p)}), deposit, PREPAY_GAS).await?;
    Ok(())
}

// ---- intents.near's ft_withdraw with msg (as tests/s02.rs and tests/s14.rs send it, with min_gas) ----

/// `signer`'s `ft_withdraw` of `amount` to the vault with `msg` and `min_gas` (Tgas; `None` signs none), signed by
/// the harness (`ft_withdraw_intent`). near-gas serialises Gas as a decimal string of gas units; VT_S13_PLANT signs it
/// wrong, so 3b must fail.
async fn ft_withdraw_intent(h: &Harness, signer: &Account, amount: u128, msg: &str, min_gas: Option<u64>) -> R<Value> {
    let extra = match (min_gas, std::env::var("VT_S13_PLANT").as_deref()) {
        (None, _) => json!({}),
        (Some(g), Ok("units")) => json!({"min_gas": g.to_string()}),
        (Some(g), Ok("key")) => json!({"minGas": Gas::from_tgas(g).as_gas().to_string()}),
        (Some(g), _) => json!({"min_gas": Gas::from_tgas(g).as_gas().to_string()}),
    };
    h.ft_withdraw_intent(signer, amount, msg, extra).await
}

async fn held(h: &Harness, who: &AccountId) -> R<u128> {
    h.intents_held(who).await
}

/// One deposit through intents.near: `s`'s `ft_withdraw` of AMOUNT on `p` with `min_gas`, in `execute_intents` sent by
/// the relayer with `gas` Tgas, read raw.
async fn send(h: &Harness, relayer: &Account, s: &Account, p: &Bytes32, min_gas: Option<u64>, gas: u64) -> R<Sent> {
    let signed = ft_withdraw_intent(h, s, AMOUNT, &message(p, s.id()), min_gas).await?;
    h.execute_intents(relayer, signed, gas).await
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

/// One row of the gas table: Tgas burnt per receipt, and the gas the token's call and the vault's were given.
struct Row {
    what: &'static str,
    execute_intents: f64,
    ft_transfer_call: f64,
    ft_on_transfer: f64,
    ft_resolve_transfer: f64,
    ft_resolve_withdraw: f64,
    all: f64,
    token_given: f64,
    vault_given: f64,
    attached: u64,
}

fn row(h: &Harness, x: &Sent, what: &'static str, attached: u64) -> R<Row> {
    let intents: AccountId = harness::INTENTS.parse()?;
    let ftc = x.one(&h.token, "ft_transfer_call")?;
    let oft = x.one(&h.vault, "ft_on_transfer")?;
    Ok(Row {
        what,
        execute_intents: tgas(x.one(&intents, "execute_intents")?.gas_burnt),
        ft_transfer_call: tgas(ftc.gas_burnt),
        ft_on_transfer: tgas(oft.gas_burnt),
        ft_resolve_transfer: tgas(x.one(&h.token, "ft_resolve_transfer")?.gas_burnt),
        ft_resolve_withdraw: tgas(x.one(&intents, "ft_resolve_withdraw")?.gas_burnt),
        all: tgas(x.o.receipts.iter().map(|r| r.gas_burnt).sum()),
        token_given: tgas(x.given_to(ftc)?),
        vault_given: tgas(x.given_to(oft)?),
        attached,
    })
}

/// The deposit landed at leaf `index`: every receipt ok, `ft_on_transfer` returned `"0"` and logged its `deposited`
/// event for S, AMOUNT and P, and the leaf at `index` is that event's commitment, Poseidon(value, label, P).
async fn expect_landed(h: &Harness, x: &Sent, s: &Account, p: &Bytes32, index: u64, what: &str) -> R<()> {
    if !x.o.all_ok() {
        let lines: Vec<String> = x.o.receipts.iter().map(Receipt::line).collect();
        return Err(format!("{what}: the deposit did not land:\n{}", lines.join("\n")).into());
    }
    let r = x.one(&h.vault, "ft_on_transfer")?;
    assert_eq!(returned(r)?, "\"0\"", "{what}: ft_on_transfer did not return \"0\"");
    let event = r
        .logs
        .iter()
        .find_map(|l| l.strip_prefix("EVENT_JSON:").and_then(|j| serde_json::from_str::<Value>(j).ok()).filter(|e| e["event"] == "deposited"))
        .ok_or_else(|| format!("{what}: no deposited event in {:?}", r.logs))?;
    let d = &event["data"][0];
    assert_eq!((d["depositor"].as_str(), d["value"].as_str(), d["precommitment"].as_str()), (Some(s.id().as_str()), Some(AMOUNT.to_string().as_str()), Some(dec(p).as_str())), "{what}: the deposited event {event}");
    let commitment = d["commitment"].as_str().ok_or("commitment")?;
    let label = d["label"].as_str().ok_or("label")?;
    assert_eq!(harness::commitment_on(&AMOUNT.to_string(), label, &dec(p)), commitment, "{what}: the event's commitment");
    let leaf = h.view(&h.vault, "leaves", json!({"from": index, "limit": 1})).await?;
    assert_eq!(leaf, json!([commitment]), "{what}: the leaf at {index}");
    Ok(())
}

#[tokio::test]
async fn vt_s13_mock() -> R<()> {
    vt_s13(TokenKind::Mock).await
}

#[tokio::test]
async fn vt_s13_usdc() -> R<()> {
    vt_s13(TokenKind::Usdc).await
}

async fn vt_s13(kind: TokenKind) -> R<()> {
    let h = Harness::with_vault_and(kind).await?;
    let intents: AccountId = harness::INTENTS.parse()?;
    let _admin = h.deploy_intents().await?;
    let _ = h.storage_deposit(&h.root, &intents).await?;
    let relayer = h.account("relayer", 50).await?;
    let s = h.intents_funded(HELD).await?;
    let min = kit_min_gas();
    let mut rows = vec![];

    // 1. size 1: the first deposit, into both empty trees, 300 Tgas attached
    let p = precommitment(&format!("s13 {kind:?} size 1"));
    prepay(&h, &relayer, &p).await?;
    let x = send(&h, &relayer, &s, &p, Some(min), RELAYER_GAS).await?;
    expect_landed(&h, &x, &s, &p, 0, "size 1").await?;
    assert_eq!((h.tree("state_tree").await?, h.tree("label_tree").await?), ((1, 0), (1, 0)));
    rows.push(row(&h, &x, "size 1", RELAYER_GAS)?);

    // 2. size 2^10: the insert at index 2^10 - 1 hashes all 10 levels, 300 Tgas attached
    h.seed(SIZE_2_10, 10).await?;
    let p = precommitment(&format!("s13 {kind:?} size 2^10"));
    prepay(&h, &relayer, &p).await?;
    let x = send(&h, &relayer, &s, &p, Some(min), RELAYER_GAS).await?;
    expect_landed(&h, &x, &s, &p, SIZE_2_10, "size 2^10").await?;
    assert_eq!((h.tree("state_tree").await?, h.tree("label_tree").await?), ((SIZE_2_10 + 1, 10), (SIZE_2_10 + 1, 10)));
    let r = row(&h, &x, "size 2^10", RELAYER_GAS)?;
    // the gas left over at 300 Tgas, which the token's call got on top of min_gas; the tight runs attach it less
    let leftover = r.token_given - min as f64;
    assert!(leftover > SLACK as f64, "300 Tgas left {leftover:.3} Tgas over min_gas: nothing to cut");
    let tight = |min_gas: u64| -> u64 { RELAYER_GAS + min_gas + SLACK - min - leftover.floor() as u64 };
    rows.push(r);

    // 3. depth 32, the relayer's gas cut so the token's call gets min_gas and under SLACK + 1 Tgas more
    h.seed(SIZE_2_32, 32).await?;
    let p = precommitment(&format!("s13 {kind:?} depth 32"));
    prepay(&h, &relayer, &p).await?;
    // 3a. no min_gas signed (DF's 50 Tgas): the vault runs out of gas and S gets every unit back
    let before = (vault_state(&h).await?, h.token_balance(&h.vault).await?, h.token_balance(&intents).await?, held(&h, s.id()).await?);
    let g = tight(DF_DEFAULT_MIN_GAS);
    let x = send(&h, &relayer, &s, &p, None, g).await?;
    let ftc = x.one(&h.token, "ft_transfer_call")?;
    let given = tgas(x.given_to(ftc)?);
    assert!(given >= DF_DEFAULT_MIN_GAS as f64 && given <= (DF_DEFAULT_MIN_GAS + SLACK + 1) as f64, "depth 32, no min_gas: the token's call got {given:.3} Tgas, not about DF's 50");
    assert!(ftc.ok(), "depth 32, no min_gas: the token's ft_transfer_call failed: {}", ftc.line());
    let oft = x.one(&h.vault, "ft_on_transfer")?;
    let f = oft.failure().ok_or_else(|| format!("depth 32 on DF's 50 Tgas: ft_on_transfer did not fail: {}", oft.line()))?;
    assert!(f.contains("Exceeded the prepaid gas"), "depth 32 on DF's 50 Tgas: want the vault out of gas, got {f}");
    assert_eq!(returned(x.one(&intents, "ft_resolve_withdraw")?)?, "\"0\"", "ft_resolve_withdraw counted some of it used");
    let after = (vault_state(&h).await?, h.token_balance(&h.vault).await?, h.token_balance(&intents).await?, held(&h, s.id()).await?);
    assert!(after == before, "depth 32 on DF's 50 Tgas: a vault state byte, a token unit or S's balance moved");
    println!(
        "{kind:?} depth 32, no min_gas signed, {g} Tgas attached: the token's call got {given:.3} Tgas, the vault {:.3}: refused \
         (out of gas, {:.3} Tgas burnt), S refunded in full ({} inside intents.near), the vault's state unchanged",
        tgas(x.given_to(oft)?),
        tgas(oft.gas_burnt),
        after.3
    );
    // 3b. the kit's min_gas signed, 1 Tgas under what its floor needs attached: intents.near fails the whole call, so
    // no token call is made and nothing moves. With gas to spare a wrong min_gas would land; here only the signed
    // floor stops it (VT_S13_PLANT=units or key must fail this).
    let g = tight(min) - SLACK - 1;
    let x = send(&h, &relayer, &s, &p, Some(min), g).await?;
    let lines: Vec<String> = x.o.receipts.iter().map(Receipt::line).collect();
    let run = x.one(&intents, "execute_intents")?;
    let f = run.failure().ok_or_else(|| format!("depth 32, {min} Tgas signed, {g} attached: execute_intents did not fail:\n{}", lines.join("\n")))?;
    assert!(!x.o.receipts.iter().any(|r| r.executor == h.token.as_str()), "depth 32, {g} attached: a token receipt ran:\n{}", lines.join("\n"));
    let after = (vault_state(&h).await?, h.token_balance(&h.vault).await?, h.token_balance(&intents).await?, held(&h, s.id()).await?);
    assert!(after == before, "depth 32, {g} attached under the signed floor: a vault state byte, a token unit or S's balance moved");
    println!("{kind:?} depth 32, {min} Tgas signed, {g} Tgas attached (under the floor): execute_intents failed whole ({f}), no token call, S keeps {}", after.3);
    // 3c. the kit's min_gas signed: lands
    let g = tight(min);
    let x = send(&h, &relayer, &s, &p, Some(min), g).await?;
    expect_landed(&h, &x, &s, &p, SIZE_2_32, "depth 32").await?;
    assert_eq!((h.tree("state_tree").await?, h.tree("label_tree").await?), ((SIZE_2_32 + 1, 32), (SIZE_2_32 + 1, 32)));
    let r = row(&h, &x, "depth 32", g)?;
    assert!(r.token_given <= (min + SLACK + 1) as f64, "depth 32: the token's call got {:.3} Tgas, not about min_gas alone", r.token_given);
    rows.push(r);
    assert_eq!(held(&h, s.id()).await?, HELD - 3 * AMOUNT, "S's balance inside intents.near after three deposits");
    h.i1().await?;

    // the table and the rule
    println!(
        "{kind:?} VT-S13, Tgas burnt per receipt (given: the gas the token's ft_transfer_call and the vault's ft_on_transfer were given)\n\
         {:<10} {:>8} {:>15} {:>16} {:>14} {:>14} {:>14} {:>8} {:>11} {:>11}",
        "tree", "attached", "execute_intents", "ft_transfer_call", "ft_on_transfer", "ft_resolve_tr.", "ft_resolve_wd.", "all", "token given", "vault given"
    );
    for r in &rows {
        println!(
            "{:<10} {:>8} {:>15.3} {:>16.3} {:>14.3} {:>14.3} {:>14.3} {:>8.3} {:>11.3} {:>11.3}",
            r.what, r.attached, r.execute_intents, r.ft_transfer_call, r.ft_on_transfer, r.ft_resolve_transfer, r.ft_resolve_withdraw, r.all, r.token_given, r.vault_given
        );
    }
    println!("{}", h.gas_table());
    let worst = rows.iter().map(|r| r.ft_on_transfer).fold(0.0, f64::max);
    let want = rule(worst);
    println!(
        "{kind:?} VT-S13: the vault's worst ft_on_transfer {worst:.3} Tgas (depth 32); ({worst:.3} x {TESTNET_MARGIN} + {TOKEN_KEEPS}) x {HEADROOM} = {want:.3} Tgas; the kit's min_gas_tgas {min}"
    );
    assert_eq!(worst, rows[2].ft_on_transfer, "the worst case is not the depth-32 deposit");
    assert!(min as f64 >= want, "the kit's min_gas_tgas {min} is below the rule's {want:.3} Tgas: a deposit can run short");
    assert!((min as f64) < want + 1.0, "the kit's min_gas_tgas {min} is stale, a Tgas or more over the rule's {want:.3}: derive it again ({})", want.ceil());
    Ok(())
}
