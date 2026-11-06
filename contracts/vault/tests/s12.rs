// SPDX-License-Identifier: Apache-2.0
//! VT-S12 (vault.md 5, V3.4): the gas of every vault method at tree index 2^k - 1 for k = 1..16, fitted per Poseidon
//! hash and extrapolated to depth 32 (E), with depth 32 also measured (M), in near-sandbox 2.13.4 on the real USDC
//! wasm at TOKEN. Runs only with `--features sandbox`, through tests/harness/run.sh
//! (`contracts/vault/tests/harness/run.sh --test s12`); a plain `cargo test` builds this file empty.
//!
//! The methods are the vault's 17 exports (tests/s01.rs EXPORTS, src/): storage_prepay, ft_on_transfer (U's own
//! `ft_transfer_call`, and through intents.near's `ft_withdraw` with msg), withdraw, ragequit, on_payout, settle, and
//! the views config, state_tree, label_tree, leaves, labels, deposits, spends, is_known_state_root,
//! is_known_label_root, totals and contract_source_metadata, each sent as a transaction so its gas is burnt and read.
//!
//! An insert at index i of a tree of depth d hashes once per 1-bit of i below d (src/tree.rs `insert`, LIMT l.63-75),
//! so at index 2^k - 1 a tree insert hashes k times: a deposit and a settle insert into both trees (2k hashes), a
//! withdrawal into the state tree (k). Reaching 2^16 - 1 by real inserts would take 65,535 deposits per vault, so the
//! route is tests/s10.rs's and tests/s13.rs's: STATE's size and depth and a side node per level patched in the
//! sandbox (`Harness::seed_trees`), the vault's code untouched. The real inserts below check that route: k = 0..3 of
//! the direct deposit, k = 0 and 1 of the intents.near deposit and k = 1 and 2 of the withdrawal are real trees, never
//! patched. Per method, Tgas = a + b x hashes is fitted on the patched k = 4..16 and must predict every point outside
//! the fit, the real ones and the measured depth 32, within HELD_OUT_TGAS.
//!
//! Four sandboxes, one test each (they run in parallel), each with the mainnet build at vault.test.near:
//! 1. direct: tests/fixtures/s12-spends.json's 22 notes deposited by u in order (labels of nonces 1..22): notes 1-8
//!    at their real indices 0..7 (k = 0, 1, 2, 3 at indices 0, 1, 3, 7), notes 9-21 at 2^k - 1 for k = 4..16, note 22
//!    at 2^32 - 1; each measured deposit's prepay first, and its note ragequit by u after (paid: on_payout and the
//!    payout receipt). Then every view.
//! 2. intents: a 64-hex S's deposits through intents.near with the kit's `min_gas`, k = 0 and 1 real, 2..16 and 32
//!    patched, 300 Tgas attached.
//! 3. withdraw: two funding deposits and the fixture's two roots seeded (as tests/s10.rs seeds a proof's roots); w1
//!    at the real index 1, w2 at the real index 3, w3..w17 at 2^k - 1 (state tree only) for k = 3..16 and 32. Each
//!    pays newcomer 900,000 with its registration and relayer 100,000 (the costliest payout, 70 Tgas of statics).
//! 4. settle: the same 17 withdrawals sent at a patched size 2^20 with relayer not registered on the token, so every
//!    payout bounces whole and the spend waits as refund_pending; then each settle writes its refund note at 2^k - 1
//!    of both trees for k = 1..16 and 32.
//!
//! The asserts (VT-S12's proof, vault.md 5): every method's measured and extrapolated Tgas at depth 32 under 300; the
//! withdrawal's and the ragequit's own work under GAS_OWN_WORK_TGAS, the 100 Tgas `check_gas` keeps for it; every
//! `on_payout` at most a sixth of its static GAS_ON_PAYOUT_TGAS; every payout receipt within the statics of its calls
//! (GAS_STORAGE_DEPOSIT_TGAS, GAS_FT_TRANSFER_TGAS). `VT_S12_PLANT=<on_payout|ft_transfer|storage_deposit|own_work>`
//! reads that static as 1 Tgas, lower than the measure, and the run must fail. Every row names the build measured
//! (the vault wasm's size and sha256), the sandbox (version and protocol, from RPC status) and the platform.
#![cfg(feature = "sandbox")]

mod harness;

use blindfill_vault::constants::{GAS_FT_TRANSFER_TGAS, GAS_ON_PAYOUT_TGAS, GAS_STORAGE_DEPOSIT_TGAS, PAGE_MAX};
use blindfill_vault::context::field_of;
use blindfill_vault::field;
use blindfill_vault::payout::GAS_OWN_WORK_TGAS;
use harness::{Harness, Outcome, Receipt, TokenKind, R, TGAS, YOCTO_PER_BYTE};
use near_sdk::serde_json::{self, json, Value};
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId};

const FIXTURE: &str = include_str!("fixtures/s12-spends.json");
/// The k past 0 that VT-S12 measures: 1..16, and depth 32.
const KS: [u8; 17] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 32];
/// The fit's k; every other measured k is held out.
const FIT: std::ops::RangeInclusive<u8> = 4..=16;
/// How far a held-out point may sit from the fit, in Tgas: under a tenth of one hash's cost (about 1.37 Tgas per
/// level). The real k = 0 (an empty tree's insert, no level at all) and k = 1 (the depth grows) sit 0.04-0.08 Tgas
/// under the fit on the first run.
const HELD_OUT_TGAS: f64 = 0.1;
const LIMIT_TGAS: f64 = 300.0;
const VALUE: u128 = 1_000_000;
const REGISTER: u128 = 1_250_000_000_000_000_000_000;
/// The kit's prepay whenever a tree may grow (2.10 (h)).
const PREPAY: u128 = 904 * YOCTO_PER_BYTE;
/// A withdrawal's and a ragequit's attachment: over row 14's bytes and reserve (at most 710 + 74 + 389 B here), the
/// registration and a yocto per transfer; the rest stays in the spend's reserve.
const SPEND_ATTACH: u128 = 20_000_000_000_000_000_000_000;
const CALL_GAS: Gas = Gas::from_tgas(300);

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).unwrap()
}

fn tgas(g: u64) -> f64 {
    g as f64 / TGAS
}

fn y(n: u128) -> NearToken {
    NearToken::from_yoctonear(n)
}

/// A precommitment as the device makes one: a full-size field element, `keccak256(tag) mod p`, as a decimal.
fn precommitment(tag: &str) -> String {
    field::to_decimal(&field_of(tag.as_bytes()))
}

fn be(dec: &str) -> [u8; 32] {
    field::to_be(&field::from_decimal(dec).unwrap())
}

/// A static as the asserts read it: `VT_S12_PLANT=<name>` reads it as 1 Tgas, under every measure, so the run fails.
fn static_tgas(name: &str, value: u64) -> f64 {
    if std::env::var("VT_S12_PLANT").as_deref() == Ok(name) {
        println!("planted: the {name} static read as 1 Tgas (it is {value})");
        return 1.0;
    }
    value as f64
}

/// How a point was reached.
#[derive(Clone, Copy, PartialEq, Debug)]
enum How {
    Real,
    Patched,
}

struct Row {
    method: String,
    k: u8,
    hashes: u32,
    tgas: f64,
    how: How,
}

/// The rows of one sandbox, and the build, sandbox and platform each row names.
struct Meter {
    name: &'static str,
    build: String,
    sandbox: String,
    platform: String,
    rows: Vec<Row>,
}

impl Meter {
    async fn new(h: &Harness, name: &'static str) -> R<Self> {
        let sha: String = near_sdk::env::sha256(&h.vault_wasm).iter().map(|b| format!("{b:02x}")).collect();
        let (version, protocol) = h.sandbox_status().await?;
        Ok(Self {
            name,
            build: format!("vault {} B sha256 {sha}", h.vault_wasm.len()),
            sandbox: format!("near-sandbox {version} protocol {protocol}"),
            platform: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
            rows: vec![],
        })
    }

    fn add(&mut self, method: &str, k: u8, hashes: u32, r: &Receipt, how: How) {
        let t = tgas(r.gas_burnt);
        println!("S12 {} | {method} | k {k} | {hashes} hashes | {t:.3} Tgas | {how:?} | {}", self.name, r.line());
        self.rows.push(Row { method: method.into(), k, hashes, tgas: t, how });
    }

    /// The table, then per inserting method the fit on FIT and every held-out point against it, and per method its
    /// depth-32 figure against 300 Tgas, M and E.
    fn finish(&self) -> R<()> {
        println!("VT-S12 {}: {} | {} | {}", self.name, self.build, self.sandbox, self.platform);
        println!("VT-S12 {} | method | k | hashes | Tgas | how | build | sandbox | platform", self.name);
        for r in &self.rows {
            println!("VT-S12 {} | {} | {} | {} | {:.3} | M {:?} | {} | {} | {}", self.name, r.method, r.k, r.hashes, r.tgas, r.how, self.build, self.sandbox, self.platform);
        }
        let mut methods: Vec<&str> = self.rows.iter().map(|r| r.method.as_str()).collect();
        methods.sort();
        methods.dedup();
        for m in methods {
            let rows: Vec<&Row> = self.rows.iter().filter(|r| r.method == m).collect();
            let worst = rows.iter().map(|r| r.tgas).fold(0.0, f64::max);
            assert!(worst < LIMIT_TGAS, "{m}: {worst:.3} Tgas measured, not under {LIMIT_TGAS}");
            if rows.iter().all(|r| r.hashes == 0) {
                let best = rows.iter().map(|r| r.tgas).fold(f64::MAX, f64::min);
                println!("VT-S12 {} fit | {m} | no hash | {best:.3}-{worst:.3} Tgas over {} calls", self.name, rows.len());
                continue;
            }
            let fit: Vec<&&Row> = rows.iter().filter(|r| FIT.contains(&r.k) && r.how == How::Patched).collect();
            assert!(fit.len() == FIT.count(), "{m}: {} fit points, want one per k in {FIT:?}", fit.len());
            let n = fit.len() as f64;
            let (sx, sy) = (fit.iter().map(|r| r.hashes as f64).sum::<f64>(), fit.iter().map(|r| r.tgas).sum::<f64>());
            let sxx = fit.iter().map(|r| (r.hashes as f64).powi(2)).sum::<f64>();
            let sxy = fit.iter().map(|r| r.hashes as f64 * r.tgas).sum::<f64>();
            let b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
            let a = (sy - b * sx) / n;
            let resid = fit.iter().map(|r| (r.tgas - (a + b * r.hashes as f64)).abs()).fold(0.0, f64::max);
            println!("VT-S12 {} fit | {m} | Tgas = {a:.4} + {b:.5} x hashes | on k {FIT:?} ({} points), largest residual {resid:.4} Tgas", self.name, fit.len());
            let per_tree = rows.iter().find(|r| r.k > 0).map(|r| r.hashes / r.k as u32).unwrap_or(1);
            let e32 = a + b * (32 * per_tree) as f64;
            println!("VT-S12 {} | {m} | 32 | {} | {e32:.3} | E (the fit) | {} | {} | {}", self.name, 32 * per_tree, self.build, self.sandbox, self.platform);
            assert!(e32 < LIMIT_TGAS, "{m}: {e32:.3} Tgas extrapolated at depth 32, not under {LIMIT_TGAS}");
            for r in rows.iter().filter(|r| !(FIT.contains(&r.k) && r.how == How::Patched)) {
                let p = a + b * r.hashes as f64;
                let off = r.tgas - p;
                println!("VT-S12 {} held out | {m} | k {} ({:?}) | measured {:.3} | fit {p:.3} | {off:+.3} Tgas ({:+.3} %)", self.name, r.k, r.how, r.tgas, off / r.tgas * 100.0);
                assert!(off.abs() <= HELD_OUT_TGAS, "{m} at k {} ({:?}): measured {:.3} Tgas, the fit says {p:.3}: {off:+.3} Tgas off, over {HELD_OUT_TGAS}", r.k, r.how, r.tgas);
            }
        }
        Ok(())
    }
}

/// Every payout receipt and `on_payout` of `o` against the statics: `on_payout` at most a sixth of
/// GAS_ON_PAYOUT_TGAS, the payout receipt within the statics of the calls it holds. Records both at k; returns
/// whether the payout delivered (`on_payout`'s result is the vault's, so read the payout receipt's status).
fn payouts(h: &Harness, m: &mut Meter, o: &Outcome, k: u8, how: How, what: &str) -> R<bool> {
    let cb = o.calls_exactly(&h.vault, "on_payout", 1)?[0];
    assert!(cb.ok(), "{what}: on_payout failed: {}", cb.line());
    let bound = static_tgas("on_payout", GAS_ON_PAYOUT_TGAS) / 6.0;
    assert!(tgas(cb.gas_burnt) <= bound, "{what}: on_payout burnt {:.3} Tgas, over a sixth of its static ({bound:.3})", tgas(cb.gas_burnt));
    let pay: Vec<&Receipt> = o.receipts.iter().filter(|r| r.executor == h.token.as_str() && r.predecessor == h.vault.as_str() && !r.methods.is_empty()).collect();
    assert_eq!(pay.len(), 1, "{what}: want one payout receipt, got {}", pay.len());
    let p = pay[0];
    let statics: f64 = p
        .methods
        .iter()
        .map(|x| match x.as_str() {
            "storage_deposit" => static_tgas("storage_deposit", GAS_STORAGE_DEPOSIT_TGAS),
            "ft_transfer" => static_tgas("ft_transfer", GAS_FT_TRANSFER_TGAS),
            other => panic!("{what}: the payout receipt calls {other}"),
        })
        .sum();
    assert!(tgas(p.gas_burnt) <= statics, "{what}: the payout receipt [{}] burnt {:.3} Tgas, over its statics {statics:.3}", p.action_key(), tgas(p.gas_burnt));
    let delivered = p.ok();
    let tag = if delivered { "paid" } else { "refund_pending" };
    m.add(&format!("on_payout ({tag})"), k, 0, cb, how);
    m.add(&format!("payout receipt [{}] ({tag})", p.action_key()), k, 0, p, how);
    Ok(delivered)
}

/// The own work of a withdrawal or a ragequit under the 100 Tgas `check_gas` keeps for it.
fn own_work(r: &Receipt, what: &str) {
    let bound = static_tgas("own_work", GAS_OWN_WORK_TGAS);
    assert!(tgas(r.gas_burnt) < bound, "{what}: the receipt burnt {:.3} Tgas, not under the {bound} Tgas check_gas keeps for its own work", tgas(r.gas_burnt));
}

/// Each k's tree size before its insert at index 2^k - 1, and the depth a real tree of that size has: k, except 0 for
/// size 1 (src/tree.rs: the depth grows when 2^depth is under size + 1), so the insert at index 1 grows it to 1.
fn at(k: u8) -> (u64, u8) {
    ((1u64 << k) - 1, if k == 1 { 0 } else { k })
}

async fn prepay(h: &Harness, by: &Account, p: &str) -> R<Outcome> {
    h.call(by, &h.vault, "storage_prepay", json!({"precommitment": p}), y(PREPAY), Gas::from_tgas(30)).await
}

/// U's own `ft_transfer_call` of `value` into the vault on `p` for `depositor`; lands, the vault's balance rises by
/// `value`, and the state tree's size is `index + 1`. Returns the vault's `ft_on_transfer` receipt.
async fn deposit(h: &Harness, u: &Account, p: &str, value: u128, depositor: &AccountId, index: u64) -> R<Receipt> {
    let before = h.token_balance(&h.vault).await?;
    let msg = format!(r#"{{"precommitment":"{p}","depositor":"{depositor}"}}"#);
    let args = json!({"receiver_id": h.vault, "amount": value.to_string(), "msg": msg});
    let o = h.call(u, &h.token, "ft_transfer_call", args, y(1), CALL_GAS).await?;
    assert_eq!(h.token_balance(&h.vault).await? - before, value, "the deposit at {index} did not land");
    assert_eq!(h.tree("state_tree").await?.0, index + 1, "the deposit's leaf is not at {index}");
    Ok(o.calls_exactly(&h.vault, "ft_on_transfer", 1)?[0].clone())
}

/// A view sent as a transaction, so its gas is burnt; returns the vault's receipt.
async fn view_tx(h: &Harness, by: &Account, method: &str, args: Value) -> R<Receipt> {
    let o = h.call(by, &h.vault, method, args, y(0), CALL_GAS).await?;
    Ok(o.calls_exactly(&h.vault, method, 1)?[0].clone())
}

/// Seeds `root` into a root set (StateRoots = 5, LabelRoots = 6: src/lib.rs `Key`), as tests/s10.rs does.
async fn seed_root(h: &Harness, prefix: u8, root: &str) -> R<()> {
    let mut k = vec![prefix];
    k.extend_from_slice(&be(root));
    h.patch_data(&h.vault, &[(k, vec![])]).await
}

fn withdraw_args(w: &Value) -> Value {
    json!({"withdrawal": w["withdrawal"], "proof": w["proof"], "public_signals": w["public_signals"]})
}

/// 1. Direct deposits, their prepays and ragequits, then the views.
#[tokio::test]
async fn vt_s12_direct() -> R<()> {
    let h = Harness::with_vault_and(TokenKind::Usdc).await?;
    let mut m = Meter::new(&h, "direct").await?;
    let f = fixture();
    let u = h.account("u", 50).await?;
    let relayer = h.account("relayer", 50).await?;
    assert_eq!((u.id().as_str(), h.vault.as_str()), ("u.test.near", f["vault"].as_str().unwrap()), "the fixture's accounts");
    let ps: Vec<&str> = f["precommitments"].as_array().unwrap().iter().map(|p| p.as_str().unwrap()).collect();
    let rqs = f["ragequits"].as_array().unwrap();
    assert_eq!((ps.len(), rqs.len()), (22, 22));
    h.mint(u.id(), 22 * VALUE).await?;
    for (i, p) in ps.iter().enumerate() {
        // notes 1-8 at their real indices; then one note per k
        let (k, how) = match i {
            0..=7 => (if i + 1 == 1 << ((i + 1).ilog2()) { Some((i + 1).ilog2() as u8) } else { None }, How::Real),
            8..=20 => (Some(i as u8 - 4), How::Patched),
            _ => (Some(32), How::Patched),
        };
        let index = match (k, how) {
            (Some(k), How::Patched) => {
                h.seed(at(k).0, at(k).1).await?;
                at(k).0
            }
            _ => i as u64,
        };
        let pre = prepay(&h, &relayer, p).await?;
        let dep = deposit(&h, &u, p, VALUE, u.id(), index).await?;
        let Some(k) = k else { continue };
        m.add("storage_prepay", k, 0, pre.calls_exactly(&h.vault, "storage_prepay", 1)?[0], how);
        m.add("ft_on_transfer (direct)", k, 2 * k as u32, &dep, how);
        // u ragequits the note it just deposited: paid
        let rq = &rqs[i];
        assert_eq!(rq["public_signals"][0], f["leaves"][i], "ragequit {i}: not note {}", i + 1);
        let args = json!({"proof": rq["proof"], "public_signals": rq["public_signals"], "register_deposit": rq["register_deposit"], "refund_precommitment": rq["refund_precommitment"]});
        let held = h.token_balance(u.id()).await?;
        let o = h.call(&u, &h.vault, "ragequit", args, y(SPEND_ATTACH), CALL_GAS).await?;
        let r = o.calls_exactly(&h.vault, "ragequit", 1)?[0];
        own_work(r, &format!("ragequit at k {k}"));
        m.add("ragequit", k, 0, r, how);
        assert!(payouts(&h, &mut m, &o, k, how, &format!("ragequit at k {k}"))?, "ragequit at k {k}: the payout did not deliver");
        assert_eq!(h.token_balance(u.id()).await? - held, VALUE, "ragequit at k {k}: u was not paid");
    }
    assert_eq!(h.tree("state_tree").await?, ((1 << 32), 32));

    // the views, each as a transaction; the paged ones at one row and at every row the real inserts wrote
    let st = h.view(&h.vault, "state_tree", json!({})).await?;
    let lt = h.view(&h.vault, "label_tree", json!({})).await?;
    let mut views: Vec<(&str, Value, u64)> = vec![
        ("config", json!({}), 0),
        ("state_tree", json!({}), 0),
        ("label_tree", json!({}), 0),
        ("totals", json!({}), 0),
        ("contract_source_metadata", json!({}), 0),
        ("is_known_state_root", json!({"root": st["root"]}), 0),
        ("is_known_label_root", json!({"root": lt["root"]}), 0),
    ];
    for (method, rows) in [("leaves", 8), ("labels", 8), ("deposits", 22), ("spends", 17)] {
        views.push((method, json!({"from": 0, "limit": 1}), 1));
        views.push((method, json!({"from": 0, "limit": rows}), rows));
    }
    let mut one = std::collections::BTreeMap::new();
    for (method, args, rows) in views {
        let r = view_tx(&h, &relayer, method, args.clone()).await?;
        let t = tgas(r.gas_burnt);
        println!("VT-S12 direct | view {method} {args} | {rows} rows | {t:.3} Tgas | M | {} | {} | {}", m.build, m.sandbox, m.platform);
        assert!(t < LIMIT_TGAS, "view {method}: {t:.3} Tgas");
        match rows {
            0 => {}
            1 => {
                one.insert(method, t);
            }
            n => {
                // per row on these rows (ids of 11-18 B), and a page of PAGE_MAX rows of them (E); no bound on it: the
                // largest rows cost more, and the kit's page sizes (packages/kit/src/vault/sync.ts VAULT_SYNC_PAGE) rest
                // on review R-03's measure of them (spends 497.053 Tgas for 1,000 of its largest rows, so 250 a page)
                let per = (t - one[method]) / (n - 1) as f64;
                let page = one[method] + per * (PAGE_MAX - 1) as f64;
                println!("VT-S12 direct | view {method} | {per:.4} Tgas per row of these | {page:.3} Tgas at PAGE_MAX {PAGE_MAX} such rows | E (the per-row fit) | {} | {} | {}", m.build, m.sandbox, m.platform);
            }
        }
    }
    println!("{}", h.gas_table());
    h.i1().await?;
    m.finish()
}

/// 2. Deposits through intents.near's `ft_withdraw` with msg (tests/s13.rs's path).
#[tokio::test]
async fn vt_s12_intents() -> R<()> {
    let h = Harness::with_vault_and(TokenKind::Usdc).await?;
    let mut m = Meter::new(&h, "intents").await?;
    let intents: AccountId = harness::INTENTS.parse()?;
    let _admin = h.deploy_intents().await?;
    let _ = h.storage_deposit(&h.root, &intents).await?;
    let relayer = h.account("relayer", 50).await?;
    let ks: Vec<u8> = std::iter::once(0).chain(KS).collect();
    let s = h.intents_funded(ks.len() as u128 * VALUE).await?;
    let min = harness::kit_intents_min_gas();
    for (i, &k) in ks.iter().enumerate() {
        // k = 0 and 1 are the vault's first two deposits, at their real indices 0 and 1
        let how = if k <= 1 { How::Real } else { How::Patched };
        let index = if how == How::Real { i as u64 } else { at(k).0 };
        if how == How::Patched {
            h.seed(at(k).0, at(k).1).await?;
        }
        let p = precommitment(&format!("s12 intents {k}"));
        let pre = prepay(&h, &relayer, &p).await?;
        let msg = format!(r#"{{"precommitment":"{p}","depositor":"{}"}}"#, s.id());
        let signed = h.ft_withdraw_intent(&s, VALUE, &msg, json!({"min_gas": Gas::from_tgas(min).as_gas().to_string()})).await?;
        let before = h.token_balance(&h.vault).await?;
        let x = h.execute_intents(&relayer, signed, 300).await?;
        x.o.expect_all_ok(&format!("intents deposit at k {k}"))?;
        assert_eq!(h.token_balance(&h.vault).await? - before, VALUE, "the intents deposit at k {k} did not land");
        assert_eq!(h.tree("state_tree").await?.0, index + 1, "the intents deposit's leaf is not at {index}");
        m.add("storage_prepay", k, 0, pre.calls_exactly(&h.vault, "storage_prepay", 1)?[0], how);
        m.add("ft_on_transfer (intents.near)", k, 2 * k as u32, x.one(&h.vault, "ft_on_transfer")?, how);
    }
    assert_eq!(h.intents_held(s.id()).await?, 0, "S's balance inside intents.near after every deposit");
    println!("{}", h.gas_table());
    h.i1().await?;
    m.finish()
}

/// The accounts and roots the withdrawals need: newcomer registered on the token, relayer registered when `paid`,
/// the fixture's two roots seeded, and `funds` deposited by u at index 0.
async fn spend_setup(h: &Harness, paid: bool, funds: u128) -> R<(Account, Account, Account)> {
    let f = fixture();
    let u = h.account("u", 50).await?;
    let relayer = h.account("relayer", 50).await?;
    let newcomer = h.account("newcomer", 5).await?;
    assert_eq!((relayer.id().as_str(), newcomer.id().as_str()), ("relayer.test.near", "newcomer.test.near"), "the fixture's accounts");
    let _ = h.storage_deposit(&h.root, newcomer.id()).await?;
    if paid {
        let _ = h.storage_deposit(&h.root, relayer.id()).await?;
    }
    h.mint(u.id(), funds + VALUE).await?;
    let p = precommitment("s12 funds");
    let _ = prepay(h, &relayer, &p).await?;
    let _ = deposit(h, &u, &p, funds, u.id(), 0).await?;
    seed_root(h, 5, f["state_root"].as_str().unwrap()).await?;
    seed_root(h, 6, f["label_root"].as_str().unwrap()).await?;
    Ok((u, relayer, newcomer))
}

/// 3. Withdrawals at the state tree's 2^k - 1, paid.
#[tokio::test]
async fn vt_s12_withdraw() -> R<()> {
    let h = Harness::with_vault_and(TokenKind::Usdc).await?;
    let mut m = Meter::new(&h, "withdraw").await?;
    let f = fixture();
    let ws = f["withdrawals"].as_array().unwrap();
    assert_eq!(ws.len(), KS.len());
    let (u, relayer, newcomer) = spend_setup(&h, true, 16 * VALUE).await?;
    for (w, &k) in ws.iter().zip(KS.iter()) {
        // k = 1: the real index 1 after the funding deposit at 0; k = 2: the real index 3 after a second one at 2
        let how = if k <= 2 { How::Real } else { How::Patched };
        if k == 2 {
            let p = precommitment("s12 funds 2");
            let _ = prepay(&h, &relayer, &p).await?;
            let _ = deposit(&h, &u, &p, VALUE, u.id(), 2).await?;
        }
        if how == How::Patched {
            h.seed_trees(Some(at(k)), None).await?;
        }
        let (to_new, to_relayer) = (h.token_balance(newcomer.id()).await?, h.token_balance(relayer.id()).await?);
        let o = h.call_outcome(&relayer, &h.vault, "withdraw", withdraw_args(w), y(SPEND_ATTACH + REGISTER + 2), CALL_GAS).await?;
        let r = o.calls_exactly(&h.vault, "withdraw", 1)?[0];
        assert!(r.ok(), "withdraw at k {k}: {}", r.line());
        assert_eq!(h.tree("state_tree").await?.0, at(k).0 + 1, "withdraw at k {k}: the change leaf is not at 2^k - 1");
        own_work(r, &format!("withdraw at k {k}"));
        m.add("withdraw", k, k as u32, r, how);
        assert!(payouts(&h, &mut m, &o, k, how, &format!("withdraw at k {k}"))?, "withdraw at k {k}: the payout did not deliver");
        assert_eq!((h.token_balance(newcomer.id()).await? - to_new, h.token_balance(relayer.id()).await? - to_relayer), (900_000, 100_000), "withdraw at k {k}: the payout");
        let whole = tgas(o.receipts.iter().map(|r| r.gas_burnt).sum());
        println!("VT-S12 withdraw | k {k} | the whole transaction {whole:.3} Tgas; the receipt {:.3} + its 70 Tgas of statics = {:.3}", tgas(r.gas_burnt), tgas(r.gas_burnt) + 70.0);
        assert!(tgas(r.gas_burnt) + 70.0 < LIMIT_TGAS, "withdraw at k {k}: its own work and statics are not under {LIMIT_TGAS}");
    }
    println!("{}", h.gas_table());
    h.i1().await?;
    m.finish()
}

/// 4. Settles writing their refund notes at 2^k - 1 of both trees.
#[tokio::test]
async fn vt_s12_settle() -> R<()> {
    let h = Harness::with_vault_and(TokenKind::Usdc).await?;
    let mut m = Meter::new(&h, "settle").await?;
    let f = fixture();
    let ws = f["withdrawals"].as_array().unwrap();
    let (_u, relayer, _newcomer) = spend_setup(&h, false, 17 * VALUE).await?;
    let stranger = h.account("stranger", 50).await?;
    // the withdrawals at a patched 2^20, out of the way of every 2^k - 1 below; every payout bounces on relayer
    h.seed_trees(Some((1 << 20, 20)), None).await?;
    for (j, w) in ws.iter().enumerate() {
        let o = h.call_outcome(&relayer, &h.vault, "withdraw", withdraw_args(w), y(SPEND_ATTACH + REGISTER + 2), CALL_GAS).await?;
        let r = o.calls_exactly(&h.vault, "withdraw", 1)?[0];
        assert!(r.ok(), "withdraw {j}: {}", r.line());
        assert!(!payouts(&h, &mut m, &o, 20, How::Patched, &format!("withdraw {j}"))?, "withdraw {j}: the payout delivered; it must bounce");
    }
    for (w, &k) in ws.iter().zip(KS.iter()) {
        h.seed(at(k).0, at(k).1).await?;
        let o = h.call(&stranger, &h.vault, "settle", json!({"nullifier_hash": w["public_signals"][1]}), y(0), CALL_GAS).await?;
        let r = o.calls_exactly(&h.vault, "settle", 1)?[0];
        assert_eq!((h.tree("state_tree").await?.0, h.tree("label_tree").await?.0), (at(k).0 + 1, at(k).0 + 1), "settle at k {k}: the refund note is not at 2^k - 1");
        m.add("settle (refund note)", k, 2 * k as u32, r, How::Patched);
    }
    println!("{}", h.gas_table());
    h.i1().await?;
    m.finish()
}
