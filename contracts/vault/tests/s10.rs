// SPDX-License-Identifier: Apache-2.0
//! VT-S10 (vault.md 5, V:1144): every write's bytes against 2.3 (V:105-127), in near-sandbox 2.13.4 on the mock token
//! and on the real USDC wasm at TOKEN. Each figure is the vault account's `storage_usage` after the call less before
//! it, read at final; a refused call must leave it, and every state byte, unchanged. Runs only with
//! `--features sandbox`, through tests/harness/run.sh (`contracts/vault/tests/harness/run.sh --test s10`); a plain
//! `cargo test` builds this file empty.
//!
//! EXPECTED is 2.3's table for the ids these tests use. 2.3 counts a 64-byte payer, recipient and depositor (V:107,
//! V:109); a shorter id takes its missing bytes off (relayer.test.near 17 B, newcomer.test.near 18, alice.test.near 15,
//! u.test.near 11). An insert that grows a tree a level, or a tree's first insert, adds one 74-byte side node (V:119).
//! A deposit's figure is what it wrote: the usage change plus the 89-byte prepay record it deleted (V:113, V:110).
//! `VT_S10_PLANT=<row>` adds one byte to that row's figure, so the run must fail at it.
//!
//! Vault A, the six notes of tests/fixtures/withdraw-spends.json, each deposited for a 64-byte implicit account D:
//! 1. the first prepay writes its record and the contract's state record (89 + 200, V:121), every other prepay 89, a
//!    top-up 0; deposits 1-3 write 904 (both trees' first side node, then a level each), deposit 4 756;
//! 2. deposit 5 grows both trees: on a 756 B prepay it is refused, after a top-up one yocto short it is refused again
//!    (each with no state byte changed and the token back to its sender), and after one more yocto it lands, 904;
//!    deposit 6 on exactly 756 B lands, 756;
//! 3. the withdrawals of tests/fixtures/settle-spends.json, attached exactly 2.5.2 row 14's figure from EXPECTED: one
//!    yocto short is refused with nothing changed; fee_bounces 617 and recipient_bounces (with SURPLUS) 614;
//! 4. settle fee_bounces, the state tree's 9th leaf, grows it a level: 463, the 74 B attached; settle
//!    recipient_bounces 389 from its reserve, and the payer gets exactly SURPLUS back;
//! 5. D ragequits note 3 (tests/fixtures/ragequit-spends.json): 475, 64-byte payer and recipient.
//!
//! Vault B, one deposit (note 5 for u) whose withdrawal proof's two roots are seeded into the root sets by a sandbox
//! state patch (the proof was made against the six-note trees; nothing else is patched): the withdrawal's change leaf
//! is the state tree's 2nd leaf (a level, 617 + 74), and its settle the state tree's 3rd leaf and the label tree's 2nd,
//! growing both trees in one call: 389 + 74 + 74 = 537 (V:488).
//!
//! Depth 32 (vault.md 2.11): on vault B's setup, both trees patched to size 2^32 - 1 and depth 32 with a side node at
//! every level 0-32, so the next insert hashes all 32 levels (LIMT l.63-75), as G1's seeded depth-32 runs did (vault.md 2.11). One
//! vault each for a deposit, a withdrawal and a settle (made pending at a small depth, then patched), so every insert
//! writes new keys; each prints every receipt with its gas and checks 2.3's bytes at depth 32.
//!
//! Every read also checks the contract's state record is STATE_LEN bytes, so the state struct stays a fixed size, and
//! the sources name no `near_sdk::store` collection (which writes only when flushed, V:124-127).
#![cfg(feature = "sandbox")]

mod harness;

use harness::{Harness, Outcome, Receipt, TokenKind, R, YOCTO_PER_BYTE};
use near_sdk::json_types::Base64VecU8;
use near_sdk::serde_json::{self, json, Value};
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId};

const DEPOSITS: &str = include_str!("fixtures/withdraw-spends.json");
const SPENDS: &str = include_str!("fixtures/settle-spends.json");
const RAGEQUITS: &str = include_str!("fixtures/ragequit-spends.json");

/// 2.3's figures (V:105-127) for these tests' ids, row by row.
const EXPECTED: &[(&str, u128)] = &[
    // V:110 the prepay record 1 + 32 + 16 + 40, and V:121 the contract's state record, written once
    ("prepay, the vault's first write", 89 + 200),
    ("prepay", 89),
    ("prepay top-up", 0),
    // V:113 756, + 74 per tree that grows a level or takes its first node (V:119)
    ("deposit, both trees' first node", 756 + 74 + 74),
    ("deposit, both trees grow a level", 756 + 74 + 74),
    ("deposit, no level", 756),
    ("deposit refused", 0),
    // V:114 710 for a 64-byte payer and recipient
    ("withdraw refused", 0),
    ("withdraw fee_bounces", 710 - 47 - 46),
    ("withdraw recipient_bounces", 710 - 47 - 49),
    // V:115 the refund note 389 (V:488)
    ("settle, the state tree grows a level", 389 + 74),
    ("settle, no level", 389),
    // V:116 475, the depositor D 64 bytes as payer and recipient
    ("ragequit", 475),
    ("B deposit, both trees' first node", 756 - 53 + 74 + 74),
    ("B withdraw, the state tree grows a level", 710 - 47 - 46 + 74),
    // V:488 "up to 537 B when a tree grows a level", here both trees at once
    ("B settle, both trees grow a level", 389 + 74 + 74),
    ("depth 32 deposit", 756 - 53),
    ("depth 32 withdraw", 710 - 47 - 46),
    ("depth 32 settle", 389),
];

/// The contract's state record's value (V:121's 200 B = 40 + the 5-byte key `STATE` + this).
const STATE_LEN: usize = 155;
/// The prepay record a landed deposit deletes (V:110).
const PREPAID_RECORD: u128 = 89;
const REFUND_RESERVE_BYTES: u128 = blindfill_vault::constants::REFUND_RESERVE_BYTES as u128;
const LEVEL: u128 = 74;
/// The kit's prepay whenever a tree may grow (2.10 (h)).
const PREPAY_904: u128 = 904 * YOCTO_PER_BYTE;
const PREPAY_756: u128 = 756 * YOCTO_PER_BYTE;
/// USDC's and the mock's registration.
const REGISTER: u128 = 1_250_000_000_000_000_000_000;
const SURPLUS: u128 = 1_234_567_890_123;
/// STATE's offsets: nonce u64; the state tree (size u64, depth u8, three 5-byte prefixes); state_leaf_index; the
/// label tree. Checked against the prefixes before every patch.
const STATE_SIZE_AT: usize = 8;
const LABEL_SIZE_AT: usize = 37;
const FULL: u64 = (1 << 32) - 1;

/// Every source file of the vault, for the `store::` check.
const SOURCES: &[(&str, &str)] = &[
    ("constants.rs", include_str!("../src/constants.rs")),
    ("context.rs", include_str!("../src/context.rs")),
    ("deposit.rs", include_str!("../src/deposit.rs")),
    ("events.rs", include_str!("../src/events.rs")),
    ("field.rs", include_str!("../src/field.rs")),
    ("lib.rs", include_str!("../src/lib.rs")),
    ("payout.rs", include_str!("../src/payout.rs")),
    ("poseidon.rs", include_str!("../src/poseidon.rs")),
    ("prepay.rs", include_str!("../src/prepay.rs")),
    ("promise.rs", include_str!("../src/promise.rs")),
    ("ragequit.rs", include_str!("../src/ragequit.rs")),
    ("settle.rs", include_str!("../src/settle.rs")),
    ("tree.rs", include_str!("../src/tree.rs")),
    ("verifier.rs", include_str!("../src/verifier.rs")),
    ("verifier_keys.rs", include_str!("../src/verifier_keys.rs")),
    ("withdraw.rs", include_str!("../src/withdraw.rs")),
];

fn json_of(s: &str) -> Value {
    serde_json::from_str(s).unwrap()
}

fn y(n: u128) -> NearToken {
    NearToken::from_yoctonear(n)
}

/// The settle fixture's spend `name` as `withdraw`'s arguments.
fn args(name: &str) -> Value {
    let f = json_of(SPENDS);
    let s = f["spends"].as_array().unwrap().iter().find(|s| s["name"] == name).unwrap().clone();
    json!({"withdrawal": s["withdrawal"], "proof": s["proof"], "public_signals": s["public_signals"]})
}

fn signal(name: &str, i: usize) -> String {
    args(name)["public_signals"][i].as_str().unwrap().to_string()
}

fn be(dec: &str) -> [u8; 32] {
    blindfill_vault::field::to_be(&blindfill_vault::field::from_decimal(dec).unwrap())
}

fn expected(row: &str) -> u128 {
    let want = EXPECTED.iter().find(|(n, _)| *n == row).unwrap_or_else(|| panic!("EXPECTED has no row {row}")).1;
    match std::env::var("VT_S10_PLANT") {
        Ok(p) if p == row => {
            println!("planted: {row} expects {} B", want + 1);
            want + 1
        }
        _ => want,
    }
}

/// The vault's storage use at final, and its state record's length checked against STATE_LEN.
async fn usage(h: &Harness) -> R<u128> {
    h.wait_final(&h.vault).await?;
    let used = h.account_view(&h.vault, "final").await?["storage_usage"].as_u64().ok_or("no storage_usage")? as u128;
    // before the vault's first write there is no state record (V:121)
    if let Some(n) = state_record(h).await?.map(|s| s.len()) {
        assert_eq!(n, STATE_LEN, "the state record is {n} B, not a fixed {STATE_LEN}");
    }
    Ok(used)
}

/// The vault's whole raw state at final, in key order.
async fn vault_state(h: &Harness) -> R<Vec<(String, String)>> {
    let v = h.rpc("query", json!({"request_type": "view_state", "finality": "final", "account_id": h.vault, "prefix_base64": ""})).await?;
    let values = v["result"]["values"].as_array().ok_or_else(|| format!("view_state: {v}"))?;
    let mut kv: Vec<(String, String)> =
        values.iter().map(|e| (e["key"].as_str().unwrap_or_default().to_string(), e["value"].as_str().unwrap_or_default().to_string())).collect();
    kv.sort();
    Ok(kv)
}

async fn state_record(h: &Harness) -> R<Option<Vec<u8>>> {
    let v = h.rpc("query", json!({"request_type": "view_state", "finality": "final", "account_id": h.vault, "prefix_base64": "U1RBVEU="})).await?;
    let values = v["result"]["values"].as_array().ok_or_else(|| format!("view_state: {v}"))?;
    let Some(e) = values.iter().find(|e| e["key"] == "U1RBVEU=") else { return Ok(None) };
    let b: Base64VecU8 = serde_json::from_value(e["value"].clone())?;
    Ok(Some(b.into()))
}

/// The measured rows, printed as the table at the end.
struct Meter {
    kind: TokenKind,
    rows: Vec<(String, u128, u128)>,
}

impl Meter {
    fn check(&mut self, row: &str, measured: u128) {
        let want = expected(row);
        println!("bytes {row}: measured {measured} B, 2.3 {want} B");
        self.rows.push((row.to_string(), measured, want));
        assert_eq!(measured, want, "{:?}: {row}: measured {measured} B, 2.3 says {want} B", self.kind);
    }
    fn table(&self) -> String {
        let mut s = format!("VT-S10 {:?}: row | measured B | 2.3 B\n", self.kind);
        for (r, m, w) in &self.rows {
            s += &format!("{r} | {m} | {w}\n");
        }
        s
    }
}

async fn prepay(h: &Harness, by: &Account, p: &str, yocto: u128) -> R<Outcome> {
    h.call(by, &h.vault, "storage_prepay", json!({"precommitment": p}), y(yocto), Gas::from_tgas(30)).await
}

async fn deposit(h: &Harness, u: &Account, p: &str, value: &Value, depositor: &str) -> R<Outcome> {
    let msg = format!(r#"{{"precommitment":"{p}","depositor":"{depositor}"}}"#);
    h.call_outcome(u, &h.token, "ft_transfer_call", json!({"receiver_id": h.vault, "amount": value, "msg": msg}), y(1), Gas::from_tgas(300)).await
}

/// A prepay of `yocto` measured as `row`.
async fn prepay_measured(h: &Harness, m: &mut Meter, by: &Account, p: &str, yocto: u128, row: &str) -> R<()> {
    let u0 = usage(h).await?;
    let _ = prepay(h, by, p, yocto).await?;
    m.check(row, usage(h).await? - u0);
    Ok(())
}

/// A deposit that lands, measured as `row` (what it wrote: the change plus the prepay record it deleted).
async fn deposit_measured(h: &Harness, m: &mut Meter, u: &Account, p: &str, value: &Value, depositor: &str, row: &str) -> R<Receipt> {
    let u0 = usage(h).await?;
    let o = deposit(h, u, p, value, depositor).await?;
    o.expect_all_ok(row)?;
    let r = o.calls_exactly(&h.vault, "ft_on_transfer", 1)?[0].clone();
    m.check(row, usage(h).await? + PREPAID_RECORD - u0);
    Ok(r)
}

/// A call that is refused with `want` at the vault's `method`, leaving every state byte, the storage use and the
/// sender's token balance as they were; measured as `row` (0).
async fn refused(h: &Harness, m: &mut Meter, sender: &AccountId, method: &str, want: &str, row: &str, o: impl std::future::Future<Output = R<Outcome>>) -> R<()> {
    let (state, held) = (vault_state(h).await?, h.token_balance(sender).await?);
    let u0 = usage(h).await?;
    let o = o.await?;
    let r = o.calls_exactly(&h.vault, method, 1)?[0];
    let f = r.failure().ok_or_else(|| format!("{row}: landed, want {want}"))?;
    assert!(f.contains(want), "{row}: want {want}, got {f}");
    m.check(row, usage(h).await? - u0);
    assert_eq!(vault_state(h).await?, state, "{row}: a state byte changed");
    assert_eq!(h.token_balance(sender).await?, held, "{row}: the sender's tokens did not come back");
    println!("{row} ({want}): {}", r.line());
    Ok(())
}

async fn withdraw(h: &Harness, by: &Account, name: &str, yocto: u128) -> R<Outcome> {
    h.call_outcome(by, &h.vault, "withdraw", args(name), y(yocto), Gas::from_tgas(300)).await
}

async fn settle(h: &Harness, by: &Account, name: &str, yocto: u128) -> R<Outcome> {
    h.call_outcome(by, &h.vault, "settle", json!({"nullifier_hash": signal(name, 1)}), y(yocto), Gas::from_tgas(300)).await
}

/// 2.5.2 row 14's attachment: `bytes` (from EXPECTED) and the reserve, the registration and a yocto per transfer.
fn row14(row: &str, register_deposit: u128, transfers: u128) -> u128 {
    (expected(row) + REFUND_RESERVE_BYTES) * YOCTO_PER_BYTE + register_deposit + transfers
}

/// A landed withdrawal and its callback, measured as `row`; returns the withdraw receipt.
async fn withdraw_measured(h: &Harness, m: &mut Meter, by: &Account, name: &str, yocto: u128, row: &str) -> R<Receipt> {
    let u0 = usage(h).await?;
    let o = withdraw(h, by, name, yocto).await?;
    let w = o.calls_exactly(&h.vault, "withdraw", 1)?[0].clone();
    assert!(w.ok(), "{row}: {}", w.line());
    let cb = o.calls_exactly(&h.vault, "on_payout", 1)?[0];
    assert!(cb.ok(), "{row}: {}", cb.line());
    m.check(row, usage(h).await? - u0);
    for r in &o.receipts {
        println!("{row}: {}", r.line());
    }
    Ok(w)
}

async fn settle_measured(h: &Harness, m: &mut Meter, by: &Account, name: &str, yocto: u128, row: &str) -> R<Receipt> {
    let u0 = usage(h).await?;
    let o = settle(h, by, name, yocto).await?;
    o.expect_all_ok(row)?;
    let r = o.calls_exactly(&h.vault, "settle", 1)?[0].clone();
    m.check(row, usage(h).await? - u0);
    for x in &o.receipts {
        println!("{row}: {}", x.line());
    }
    Ok(r)
}

async fn tree(h: &Harness, which: &str) -> R<(u64, u64)> {
    let t = h.view(&h.vault, which, json!({})).await?;
    Ok((t["size"].as_u64().ok_or("size")?, t["depth"].as_u64().ok_or("depth")?))
}

/// Seeds `root` into a root set (StateRoots = 5, LabelRoots = 6: src/lib.rs `Key`); a set's record has no value.
/// Returns once the record reads back at final.
async fn seed_root(h: &Harness, prefix: u8, root: &str) -> R<()> {
    let mut k = vec![prefix];
    k.extend_from_slice(&be(root));
    h.patch_data(&h.vault, &[(k, vec![])]).await
}

/// Both trees at size 2^32 - 1 and depth 32 with a side node at every level, so the next insert into either hashes
/// all 32 levels. Only STATE's two sizes and depths and the side nodes are patched: one patch, the side nodes first and
/// STATE last, read back at final key by key before the next call (a state whose depth is 32 before its side nodes
/// are there is one no real insert makes, and the vault refuses it with SideNodeMissing).
async fn seed_depth32(h: &Harness) -> R<()> {
    let mut s = state_record(h).await?.ok_or("no state record to patch")?;
    // the prefixes Borsh writes for the state tree, state_leaf_index and the label tree (src/lib.rs `Key`)
    let pfx = |b: &[u8], at: usize, k: u8| b[at..at + 5] == [1, 0, 0, 0, k];
    assert!(pfx(&s, 17, 0) && pfx(&s, 22, 1) && pfx(&s, 27, 5) && pfx(&s, 32, 2), "STATE's state tree is not where the patch writes");
    assert!(pfx(&s, 46, 3) && pfx(&s, 51, 4) && pfx(&s, 56, 6), "STATE's label tree is not where the patch writes");
    for at in [STATE_SIZE_AT, LABEL_SIZE_AT] {
        s[at..at + 8].copy_from_slice(&FULL.to_le_bytes());
        s[at + 8] = 32;
    }
    let mut records = vec![];
    for side in [0u8, 3] {
        for level in 0..=32u8 {
            let mut v = vec![0u8; 32];
            v[31] = level + 1;
            records.push((vec![side, level], v));
        }
    }
    records.push((b"STATE".to_vec(), s));
    h.patch_data(&h.vault, &records).await?;
    assert_eq!((tree(h, "state_tree").await?, tree(h, "label_tree").await?), ((FULL, 32), (FULL, 32)), "the views after the depth-32 patch");
    Ok(())
}

struct Small {
    h: Harness,
    u: Account,
    relayer: Account,
    stranger: Account,
}

/// Vault B's setup: one deposit of note 5 for u (7,000,000, fee_bounces' note), fee_bounces' two roots seeded,
/// newcomer registered on the token and the relayer not (so the fee part bounces).
async fn small(kind: TokenKind, m: Option<&mut Meter>) -> R<Small> {
    let h = Harness::with_vault_and(kind).await?;
    let f = json_of(DEPOSITS);
    let u = h.account("u", 50).await?;
    let relayer = h.account("relayer", 50).await?;
    let newcomer = h.account("newcomer", 5).await?;
    let stranger = h.account("stranger", 50).await?;
    assert_eq!((relayer.id().as_str(), newcomer.id().as_str(), u.id().as_str()), ("relayer.test.near", "newcomer.test.near", "u.test.near"));
    let (p, value) = (f["precommitments"][4].as_str().unwrap(), &f["values"][4]);
    assert_eq!(value, "7000000");
    h.mint(u.id(), 8_000_000).await?;
    let _ = prepay(&h, &relayer, p, PREPAY_904).await?;
    match m {
        Some(m) => {
            let _ = deposit_measured(&h, m, &u, p, value, u.id().as_str(), "B deposit, both trees' first node").await?;
        }
        None => deposit(&h, &u, p, value, u.id().as_str()).await?.expect_all_ok("deposit")?,
    }
    seed_root(&h, 5, &signal("fee_bounces", 3)).await?;
    seed_root(&h, 6, &signal("fee_bounces", 5)).await?;
    let _ = h.storage_deposit(&h.root, newcomer.id()).await?;
    Ok(Small { h, u, relayer, stranger })
}

async fn vault_a(kind: TokenKind, m: &mut Meter) -> R<()> {
    let h = Harness::with_vault_and(kind).await?;
    let f = json_of(DEPOSITS);
    let u = h.account("u", 50).await?;
    let relayer = h.account("relayer", 50).await?;
    let alice = h.account("alice", 50).await?;
    let newcomer = h.account("newcomer", 5).await?;
    let stranger = h.account("stranger", 50).await?;
    let d = h.implicit_account(5_000).await?;
    assert_eq!(d.id().as_str().len(), 64);
    assert_eq!(
        (relayer.id().as_str(), alice.id().as_str(), newcomer.id().as_str()),
        ("relayer.test.near", "alice.test.near", "newcomer.test.near"),
        "the fixtures' accounts"
    );
    let total: u128 = f["deposited"].as_str().unwrap().parse()?;
    h.mint(u.id(), total).await?;
    let ps: Vec<&str> = f["precommitments"].as_array().unwrap().iter().map(|p| p.as_str().unwrap()).collect();
    let vs = f["values"].as_array().unwrap();
    let dep = d.id().as_str();

    // 1. deposits 1-4 on the kit's 904 B prepay
    for i in 0..4 {
        let prow = if i == 0 { "prepay, the vault's first write" } else { "prepay" };
        prepay_measured(&h, m, &relayer, ps[i], PREPAY_904, prow).await?;
        let row = match i {
            0 => "deposit, both trees' first node",
            3 => "deposit, no level",
            _ => "deposit, both trees grow a level",
        };
        let _ = deposit_measured(&h, m, &u, ps[i], &vs[i], dep, row).await?;
    }
    assert_eq!((tree(&h, "state_tree").await?, tree(&h, "label_tree").await?), ((4, 2), (4, 2)));

    // 2. deposit 5 grows both trees: 756 B prepaid is refused, one yocto short is refused, exact lands
    prepay_measured(&h, m, &relayer, ps[4], PREPAY_756, "prepay").await?;
    refused(&h, m, u.id(), "ft_on_transfer", "InsufficientStorageDeposit: the deposit wrote 904 B; the prepay covers 756 B", "deposit refused", deposit(&h, &u, ps[4], &vs[4], dep)).await?;
    prepay_measured(&h, m, &relayer, ps[4], PREPAY_904 - PREPAY_756 - 1, "prepay top-up").await?;
    refused(&h, m, u.id(), "ft_on_transfer", "InsufficientStorageDeposit: the deposit wrote 904 B; the prepay covers 903 B", "deposit refused", deposit(&h, &u, ps[4], &vs[4], dep)).await?;
    prepay_measured(&h, m, &relayer, ps[4], 1, "prepay top-up").await?;
    let _ = deposit_measured(&h, m, &u, ps[4], &vs[4], dep, "deposit, both trees grow a level").await?;
    prepay_measured(&h, m, &relayer, ps[5], PREPAY_756, "prepay").await?;
    let _ = deposit_measured(&h, m, &u, ps[5], &vs[5], dep, "deposit, no level").await?;
    assert_eq!(h.view(&h.vault, "leaves", json!({"from": 0, "limit": 10})).await?, f["leaves"], "the deposits' leaves are the fixture's");
    assert_eq!(h.view(&h.vault, "labels", json!({"from": 0, "limit": 10})).await?, f["labels"], "the deposits' labels are the fixture's");
    assert_eq!(h.token_balance(&h.vault).await?, total);

    // 3. withdrawals on exactly row 14's attachment; one yocto short is refused first
    let _ = h.storage_deposit(&h.root, newcomer.id()).await?;
    let need_fb = row14("withdraw fee_bounces", REGISTER, 2);
    refused(&h, m, &h.vault, "withdraw", "InsufficientStorageDeposit", "withdraw refused", withdraw(&h, &relayer, "fee_bounces", need_fb - 1)).await?;
    let _ = withdraw_measured(&h, m, &relayer, "fee_bounces", need_fb, "withdraw fee_bounces").await?;
    let _ = h.storage_deposit(&h.root, relayer.id()).await?;
    let need_rb = row14("withdraw recipient_bounces", 0, 2);
    let _ = withdraw_measured(&h, m, &relayer, "recipient_bounces", need_rb + SURPLUS, "withdraw recipient_bounces").await?;
    assert_eq!(tree(&h, "state_tree").await?, (8, 3));

    // 4. settle fee_bounces at the state tree's 9th leaf: the reserve is 74 B short, attached; then recipient_bounces
    let _ = settle_measured(&h, m, &stranger, "fee_bounces", LEVEL * YOCTO_PER_BYTE, "settle, the state tree grows a level").await?;
    let payer0 = h.near_balance(relayer.id()).await?;
    let _ = settle_measured(&h, m, &stranger, "recipient_bounces", 0, "settle, no level").await?;
    assert_eq!(h.near_balance(relayer.id()).await? - payer0, SURPLUS, "the reserve's rest to the payer");
    assert_eq!(h.view(&h.vault, "leaves", json!({"from": 0, "limit": 20})).await?, json_of(SPENDS)["leaves"], "the state tree is not the fixture's");

    // 5. D ragequits note 3
    let _ = h.storage_deposit(&h.root, d.id()).await?;
    let rq = json_of(RAGEQUITS)["ragequits"].as_array().unwrap().iter().find(|r| r["name"] == "deposit").unwrap().clone();
    let a = json!({"proof": rq["proof"], "public_signals": rq["public_signals"], "register_deposit": rq["register_deposit"], "refund_precommitment": rq["refund_precommitment"]});
    let need = (expected("ragequit") + REFUND_RESERVE_BYTES) * YOCTO_PER_BYTE + 1;
    let u0 = usage(&h).await?;
    let o = h.call(&d, &h.vault, "ragequit", a, y(need), Gas::from_tgas(300)).await?;
    m.check("ragequit", usage(&h).await? - u0);
    for r in &o.receipts {
        println!("ragequit: {}", r.line());
    }
    assert_eq!(h.token_balance(d.id()).await?, 10_000_000, "the ragequit did not pay D");
    println!("{}", h.gas_table());
    h.i1().await?;
    Ok(())
}

async fn vault_b(kind: TokenKind, m: &mut Meter) -> R<()> {
    let s = small(kind, Some(m)).await?;
    let h = &s.h;
    assert_eq!((tree(h, "state_tree").await?, tree(h, "label_tree").await?), ((1, 0), (1, 0)));
    let need = row14("B withdraw, the state tree grows a level", REGISTER, 2);
    let _ = withdraw_measured(h, m, &s.relayer, "fee_bounces", need, "B withdraw, the state tree grows a level").await?;
    assert_eq!((tree(h, "state_tree").await?, tree(h, "label_tree").await?), ((2, 1), (1, 0)));
    let _ = settle_measured(h, m, &s.stranger, "fee_bounces", 2 * LEVEL * YOCTO_PER_BYTE, "B settle, both trees grow a level").await?;
    assert_eq!((tree(h, "state_tree").await?, tree(h, "label_tree").await?), ((3, 2), (2, 1)));
    h.i1().await?;
    Ok(())
}

/// The three depth-32 calls; returns their vault receipts' Tgas (deposit, withdraw, settle).
async fn depth32(kind: TokenKind, m: &mut Meter) -> R<[f64; 3]> {
    let tg = |r: &Receipt| r.gas_burnt as f64 / 1e12;
    // a deposit at index 2^32 - 1 of both trees
    let s = small(kind, None).await?;
    seed_depth32(&s.h).await?;
    let _ = prepay(&s.h, &s.relayer, "12345", PREPAY_756).await?;
    let r = deposit_measured(&s.h, m, &s.u, "12345", &json!("1000000"), s.u.id().as_str(), "depth 32 deposit").await?;
    println!("depth 32 deposit: {}", r.line());
    assert_eq!((tree(&s.h, "state_tree").await?, tree(&s.h, "label_tree").await?), ((FULL + 1, 32), (FULL + 1, 32)));
    let dep = tg(&r);
    // a withdrawal whose change leaf is the state tree's index 2^32 - 1
    let s = small(kind, None).await?;
    seed_depth32(&s.h).await?;
    let r = withdraw_measured(&s.h, m, &s.relayer, "fee_bounces", row14("depth 32 withdraw", REGISTER, 2), "depth 32 withdraw").await?;
    assert_eq!(tree(&s.h, "state_tree").await?, (FULL + 1, 32));
    let wd = tg(&r);
    // a settle made pending at depth 0-1, then both trees patched: its refund note at index 2^32 - 1 of both
    let s = small(kind, None).await?;
    let need = row14("B withdraw, the state tree grows a level", REGISTER, 2);
    let o = withdraw(&s.h, &s.relayer, "fee_bounces", need).await?;
    assert!(o.calls_exactly(&s.h.vault, "on_payout", 1)?[0].ok(), "fee_bounces at depth 1");
    seed_depth32(&s.h).await?;
    let r = settle_measured(&s.h, m, &s.stranger, "fee_bounces", 0, "depth 32 settle").await?;
    assert_eq!((tree(&s.h, "state_tree").await?, tree(&s.h, "label_tree").await?), ((FULL + 1, 32), (FULL + 1, 32)));
    let st = tg(&r);
    println!("{kind:?}: depth 32, the vault's receipt: ft_on_transfer {dep:.3} Tgas, withdraw {wd:.3} Tgas, settle {st:.3} Tgas");
    Ok([dep, wd, st])
}

async fn vt_s10(kind: TokenKind) -> R<()> {
    for (name, src) in SOURCES {
        assert!(!src.contains("store::"), "src/{name} names a near_sdk::store collection, which writes only when flushed");
    }
    let mut m = Meter { kind, rows: vec![] };
    vault_a(kind, &mut m).await?;
    vault_b(kind, &mut m).await?;
    let g = depth32(kind, &mut m).await?;
    println!("{}", m.table());
    println!("{kind:?}: depth 32 Tgas (vault receipt): deposit {:.3}, withdraw {:.3}, settle {:.3}", g[0], g[1], g[2]);
    let seen: Vec<&str> = m.rows.iter().map(|r| r.0.as_str()).collect();
    for (row, _) in EXPECTED {
        assert!(seen.contains(row), "row {row} was never measured");
    }
    println!("{kind:?}: VT-S10 holds");
    Ok(())
}

#[tokio::test]
async fn vt_s10_mock() -> R<()> {
    vt_s10(TokenKind::Mock).await
}

#[tokio::test]
async fn vt_s10_usdc() -> R<()> {
    vt_s10(TokenKind::Usdc).await
}

/// A patch the sandbox loses is sent again: the first send here is dropped on purpose, and `patch_landed` returns only
/// once the record reads back at final, after its second send.
#[tokio::test]
async fn vt_s10_lost_patch_is_sent_again() -> R<()> {
    let h = Harness::with_vault_and(TokenKind::Mock).await?;
    let mut key = vec![5u8];
    key.extend_from_slice(&be(&signal("fee_bounces", 3)));
    let sends = std::sync::atomic::AtomicU32::new(0);
    let send = async || -> R<()> {
        if sends.fetch_add(1, std::sync::atomic::Ordering::SeqCst) > 0 {
            h.worker.patch(&h.vault).state(&key, &[]).transact().await?;
        }
        Ok(())
    };
    let landed = async || -> R<bool> { Ok(h.data_final(&h.vault, &key).await? == Some(vec![])) };
    h.patch_landed("a root record whose first send is lost", send, landed).await?;
    assert_eq!(sends.load(std::sync::atomic::Ordering::SeqCst), 2, "landed on the second send");
    Ok(())
}
