// SPDX-License-Identifier: Apache-2.0
//! The harness's smoke test and its own planted cases, in near-sandbox 2.13.4 (vault.md 5, V3.1). Runs only with
//! `--features sandbox`, through tests/harness/run.sh on scripts/heavy.sh.
//!
//! 1. `deploy_recipe_is_keyless`: the skeleton deployed by the 2.8 recipe ([CreateAccount, Transfer, DeployContract,
//!    FunctionCall(config)], no AddKey) lands, `view_access_key_list` reads `keys: []` at optimistic and at final, and
//!    `config()` answers the same from the recipe's call and from a view, naming the build's token.
//! 2. `mock_token_fails_on_demand`: each failure rule of the mock token fails its call (`MockTokenFail: <method>`) with
//!    nothing moved, and the same call passes once the rule is cleared; `ft_transfer_call` to the skeleton (which has
//!    no `ft_on_transfer` yet) gives the sender everything back.
//!
//! The `harness_*` tests plant each case the review of 1 Nov found the harness reading wrong at 65f3bb7 (probes
//! P1-P8), with the probe contract (tests/harness/probe) making the vault's receipt shapes:
//! - `harness_detached_callback_panic_fails_all_ok` (P1): a callback panic off the returned chain;
//! - `harness_call_fails_closed` (round 3): `call()` errs on it, so a test that checks only a balance fails;
//! - `harness_gas_key_is_the_whole_action_list` (P3, P3b): a [storage_deposit, ft_transfer] receipt; the recipe's
//!   receipt against a plain config();
//! - `harness_reads_every_receipt_before_returning` (P6b): the signer's gas refund, and its NEAR balance after a call;
//! - `harness_failure_is_the_final_status` (P2a): a failed side receipt and a failed returned callback;
//! - `harness_counts_calls_first_and_reads_local_receipts` (P8, P4): a call that never happened; a signer calling its
//!   own contract; failed receipts' gas apart;
//! - `harness_access_keys_of_a_missing_account_is_an_error` (P5);
//! - `harness_sandbox_and_status_checks` (P7): the sandbox's version and protocol, a sandbox binary the run does not
//!   name, and an `Unknown` status.
//!
//! Each prints the gas table.
mod harness;

use harness::{check_sandbox, status_is_ok, wasm_from_env, Harness, Outcome, R, ONE_YOCTO, TOKEN, TOKEN_STORAGE};
use near_sdk::serde_json::{json, Value};
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId};

const ZERO: NearToken = NearToken::from_yoctonear(0);

#[tokio::test]
async fn deploy_recipe_is_keyless() -> R<()> {
    let h = Harness::start().await?;
    let d = h.deploy_vault().await?;
    for r in &d.receipts {
        println!("recipe receipt {}", r.line());
    }
    let from_recipe = d.json().expect("config() returned no JSON in the recipe's receipt");
    d.calls_exactly(&h.vault, "config", 1)?;

    h.wait_final(&h.vault).await?;
    let optimistic = h.access_keys(&h.vault, "optimistic").await?;
    let fin = h.access_keys(&h.vault, "final").await?;
    println!("view_access_key_list {}: optimistic keys {:?}, final keys {:?}", h.vault, optimistic, fin);
    assert!(optimistic.is_empty(), "the vault has an access key (optimistic): {optimistic:?}");
    assert!(fin.is_empty(), "the vault has an access key (final): {fin:?}");

    let view = h.view(&h.vault, "config", json!({})).await?;
    println!("config(): {view}");
    assert_eq!(view, from_recipe, "config() from a view differs from the recipe's call");
    assert_eq!(view["asset"], TOKEN);
    assert_eq!(view["version"], "blindfill-vault 0.1.0 mainnet");
    assert_eq!(view["max_tree_depth"], 32);
    assert_eq!(view["min_deposit"], "1000000");
    let acct = h.account_view(&h.vault, "final").await?;
    println!("vault account: amount {}, storage_usage {}, code_hash {}", acct["amount"], acct["storage_usage"], acct["code_hash"]);
    println!("vault wasm: {} B\n\ngas table\n{}", h.vault_wasm.len(), h.gas_table());
    Ok(())
}

/// The transaction failed and its own failure names `msg`.
fn failed_with(o: &Outcome, msg: &str) -> bool {
    o.failure().is_some_and(|f| f.contains(msg))
}

#[tokio::test]
async fn mock_token_fails_on_demand() -> R<()> {
    let h = Harness::with_vault_and_mock_token().await?;
    let reg = h.view(&h.token, "storage_balance_of", json!({"account_id": h.vault})).await?;
    assert!(!reg.is_null(), "the vault is not registered on the token");

    let alice = h.account("alice", 20).await?;
    let bob = h.account("bob", 20).await?;
    h.mint(alice.id(), 5_000_000).await?;
    let _ = h.storage_deposit(&h.root, bob.id()).await?;
    let transfer = |to: &AccountId| json!({"receiver_id": to, "amount": "1000000"});
    let g30 = Gas::from_tgas(30);

    // ft_transfer to bob: fails while the rule names bob, passes once cleared
    h.mock_fail("ft_transfer", Some(bob.id()), true).await?;
    let o = h.call_outcome(&alice, &h.token, "ft_transfer", transfer(bob.id()), ONE_YOCTO, g30).await?;
    println!("ft_transfer with the rule: {:?}", o.failure());
    assert!(failed_with(&o, "MockTokenFail: ft_transfer"), "ft_transfer did not fail on demand");
    assert_eq!((h.token_balance(alice.id()).await?, h.token_balance(bob.id()).await?), (5_000_000, 0), "a failed transfer moved money");
    h.mock_fail("ft_transfer", Some(bob.id()), false).await?;
    let _ = h.call(&alice, &h.token, "ft_transfer", transfer(bob.id()), ONE_YOCTO, g30).await?;
    assert_eq!((h.token_balance(alice.id()).await?, h.token_balance(bob.id()).await?), (4_000_000, 1_000_000));

    // a rule without an account fails every ft_transfer
    h.mock_fail("ft_transfer", None, true).await?;
    let o = h.call_outcome(&bob, &h.token, "ft_transfer", transfer(alice.id()), ONE_YOCTO, g30).await?;
    assert!(failed_with(&o, "MockTokenFail: ft_transfer"), "a rule for every receiver did not fail the call");
    h.mock_fail("ft_transfer", None, false).await?;

    // storage_deposit
    let carol: AccountId = format!("carol.{}", h.root.id()).parse()?;
    h.mock_fail("storage_deposit", Some(&carol), true).await?;
    let reg = json!({"account_id": carol, "registration_only": true});
    let o = h.call_outcome(&h.root, &h.token, "storage_deposit", reg, TOKEN_STORAGE, Gas::from_tgas(10)).await?;
    println!("storage_deposit with the rule: {:?}", o.failure());
    assert!(failed_with(&o, "MockTokenFail: storage_deposit"), "storage_deposit did not fail on demand");
    assert!(h.view(&h.token, "storage_balance_of", json!({"account_id": carol})).await?.is_null());
    h.mock_fail("storage_deposit", Some(&carol), false).await?;
    let _ = h.storage_deposit(&h.root, &carol).await?;
    assert!(!h.view(&h.token, "storage_balance_of", json!({"account_id": carol})).await?.is_null());

    // ft_transfer_call to the vault: refused on demand at the token; without the rule, the skeleton's missing
    // ft_on_transfer fails and ft_resolve_transfer gives alice everything back
    let call = json!({"receiver_id": h.vault, "amount": "1000000", "msg": "{}"});
    h.mock_fail("ft_transfer_call", Some(&h.vault), true).await?;
    let o = h.call_outcome(&alice, &h.token, "ft_transfer_call", call.clone(), ONE_YOCTO, Gas::from_tgas(100)).await?;
    assert!(failed_with(&o, "MockTokenFail: ft_transfer_call"), "ft_transfer_call did not fail on demand");
    h.mock_fail("ft_transfer_call", Some(&h.vault), false).await?;
    let o = h.call_outcome(&alice, &h.token, "ft_transfer_call", call, ONE_YOCTO, Gas::from_tgas(100)).await?;
    for r in &o.receipts {
        println!("ft_transfer_call receipt {}", r.line());
    }
    let [on] = o.calls_exactly(&h.vault, "ft_on_transfer", 1)?[..] else { unreachable!() };
    assert!(on.failure().is_some_and(|f| f.contains("MethodNotFound")), "the skeleton has no ft_on_transfer: {}", on.line());
    let [resolve] = o.calls_exactly(&h.token, "ft_resolve_transfer", 1)?[..] else { unreachable!() };
    assert!(resolve.ok(), "ft_resolve_transfer failed: {}", resolve.line());
    let failed: Vec<String> = o.failures().iter().map(|r| r.line()).collect();
    assert_eq!(failed.len(), 1, "only ft_on_transfer may fail: {failed:#?}");
    assert!(o.failure().is_none() && !o.all_ok(), "the call itself succeeds with one failed receipt");
    assert_eq!(o.json(), Some(Value::String("0".into())), "ft_transfer_call must report 0 used");
    assert_eq!(h.token_balance(alice.id()).await?, 4_000_000, "alice did not get the refused deposit back");
    assert_eq!(h.token_balance(&h.vault).await?, 0);

    let rules = h.view(&h.token, "fail_rules", json!({})).await?;
    assert_eq!(rules, json!([]), "a rule was left on");
    // the vault is still keyless after all of it
    assert!(h.access_keys(&h.vault, "optimistic").await?.is_empty());
    println!("\ngas table\n{}", h.gas_table());
    Ok(())
}

// ---- the harness's planted cases ----

/// A test account `<name>.<root>` holding 30 N with the probe contract deployed.
async fn probe(h: &Harness, name: &str) -> R<Account> {
    let a = h.account(name, 30).await?;
    a.deploy(&wasm_from_env("PROBE_WASM")?).await?.into_result()?;
    Ok(a)
}

async fn probe_chain(h: &Harness, p: &Account, first_fails: bool, boom: bool, returned: bool) -> R<Outcome> {
    let args = json!({"first_fails": first_fails, "boom": boom, "returned": returned});
    h.call_outcome(&h.root, p.id(), "probe_chain", args, ZERO, Gas::from_tgas(50)).await
}

fn dump(tag: &str, o: &Outcome) {
    println!("[{tag}] all_ok {} failure() {:?}", o.all_ok(), o.failure());
    for r in &o.receipts {
        println!("[{tag}]   {}", r.line());
    }
}

/// Finding 1 (P1): withdraw, ragequit and settle never return their payout chain, so a panic in the callback reaches
/// no final status. The default check must still fail.
#[tokio::test]
async fn harness_detached_callback_panic_fails_all_ok() -> R<()> {
    let h = Harness::start().await?;
    let p = probe(&h, "probe").await?;
    let good = probe_chain(&h, &p, false, false, false).await?;
    dump("P1 good", &good);
    good.expect_all_ok("a detached chain with no panic")?;

    let o = probe_chain(&h, &p, false, true, false).await?;
    dump("P1", &o);
    assert!(o.failure().is_none(), "the final status follows the returned value only, so it reads success here");
    assert!(!o.all_ok(), "a callback panic off the returned chain read as success");
    assert!(o.expect_all_ok("P1").is_err());
    let failed = o.failures();
    assert_eq!(failed.len(), 1, "exactly the callback failed");
    assert_eq!(failed[0].executor, p.id().as_str());
    assert!(failed[0].failure().is_some_and(|f| f.contains("ProbeCallbackPanic")), "{}", failed[0].line());
    assert!(failed[0].line().contains("probe_cb"), "the failed receipt names its method: {}", failed[0].line());
    Ok(())
}

/// Round 3 (fail closed): a money test that sends with `call()` and checks only a balance still fails on a detached
/// callback panic.
#[tokio::test]
async fn harness_call_fails_closed() -> R<()> {
    let h = Harness::start().await?;
    let p = probe(&h, "probe").await?;
    // the careless test: send, then check a balance only
    async fn careless(h: &Harness, p: &Account) -> R<()> {
        let before = h.near_balance(p.id()).await?;
        let args = json!({"first_fails": false, "boom": true, "returned": false});
        let _ = h.call(&h.root, p.id(), "probe_chain", args, ZERO, Gas::from_tgas(50)).await?;
        assert!(h.near_balance(p.id()).await? >= before, "the probe lost NEAR");
        Ok(())
    }
    let r = careless(&h, &p).await;
    println!("fail closed: careless test -> {:?}", r.as_ref().map_err(|e| e.to_string().chars().take(300).collect::<String>()));
    let e = r.err().ok_or("call() returned Ok on a detached callback panic")?.to_string();
    assert!(e.contains("ProbeCallbackPanic"), "the error does not name the panic: {e}");
    let args = json!({"first_fails": false, "boom": false, "returned": false});
    let _ = h.call(&h.root, p.id(), "probe_chain", args, ZERO, Gas::from_tgas(50)).await?; // and passes when nothing failed
    Ok(())
}

/// Finding 2 (P3, P3b): a receipt's gas is filed under its whole action list.
#[tokio::test]
async fn harness_gas_key_is_the_whole_action_list() -> R<()> {
    let h = Harness::with_vault_and_mock_token().await?;
    let p = probe(&h, "payer").await?;
    h.mint(p.id(), 5_000_000).await?;
    let count = |k: &str| h.gas().get(k).map_or(0, Vec::len);
    let before = (count("token::storage_deposit"), count("token::ft_transfer"));
    let dave: AccountId = format!("dave.{}", h.root.id()).parse()?;
    let args = json!({"token": h.token, "account": dave, "amount": "1000", "register_deposit": TOKEN_STORAGE.as_yoctonear().to_string()});
    let o = h.call(&h.root, p.id(), "probe_part", args, ZERO, Gas::from_tgas(100)).await?;
    dump("P3", &o);
    assert_eq!(h.token_balance(&dave).await?, 1000, "the batch's ft_transfer ran");
    println!("P3 gas keys {:?}", h.gas().keys().collect::<Vec<_>>());
    assert_eq!(count("token::storage_deposit+ft_transfer"), 1, "the batch receipt is filed under both its calls");
    assert_eq!((count("token::storage_deposit"), count("token::ft_transfer")), before, "the batch receipt went under one call");

    let recipe = "vault::CreateAccount+Transfer+DeployContract+config";
    assert_eq!((count(recipe), count("vault::config")), (1, 0), "the recipe's receipt is filed apart");
    let _ = h.call(&h.root, &h.vault, "config", json!({}), ZERO, Gas::from_tgas(30)).await?;
    assert_eq!((count(recipe), count("vault::config")), (1, 1), "a plain config() is filed apart from the recipe");
    println!("\ngas table\n{}", h.gas_table());
    Ok(())
}

/// Finding 3 (P6b): a call returns only after every receipt, the signer's gas refund included, so a NEAR balance read
/// right after it is the final one.
#[tokio::test]
async fn harness_reads_every_receipt_before_returning() -> R<()> {
    let h = Harness::with_vault_and_mock_token().await?;
    let alice = h.account("alice", 20).await?;
    h.mint(alice.id(), 5_000_000).await?;
    for i in 0..3 {
        let call = json!({"receiver_id": h.vault, "amount": "1000000", "msg": "{}"});
        let o = h.call_outcome(&alice, &h.token, "ft_transfer_call", call, ONE_YOCTO, Gas::from_tgas(100)).await?;
        let right_after = h.account_view(alice.id(), "optimistic").await?["amount"].clone();
        let fin = h
            .rpc("EXPERIMENTAL_tx_status", json!({"tx_hash": o.tx_hash, "sender_account_id": alice.id(), "wait_until": "FINAL"}))
            .await?;
        let all = fin["result"]["receipts_outcome"].as_array().map_or(0, Vec::len);
        for _ in 0..3 {
            h.worker.fast_forward(1).await?; // later blocks: nothing of this transaction is left to land
        }
        let later = h.account_view(alice.id(), "optimistic").await?["amount"].clone();
        println!("P6b run {i}: harness {} receipts, FINAL {all}; alice right after the call {right_after}, later {later}", o.receipts.len());
        assert_eq!(o.receipts.len(), all, "the harness returned before every receipt ran");
        assert!(o.receipts.iter().any(|r| r.predecessor == "system" && r.executor == alice.id().as_str()), "no refund to alice");
        assert_eq!(right_after, later, "alice's NEAR moved after the call returned");
    }
    Ok(())
}

/// Finding 4 (P2a): the transaction's failure is its final status; every other failed receipt is listed apart.
#[tokio::test]
async fn harness_failure_is_the_final_status() -> R<()> {
    let h = Harness::start().await?;
    let p = probe(&h, "probe").await?;
    let o = probe_chain(&h, &p, true, true, true).await?;
    dump("P2a", &o);
    let f = o.failure().unwrap_or_default();
    assert!(f.contains("ProbeCallbackPanic"), "failure() is not the final status: {f}");
    assert!(!f.contains("ProbeFirstFail"), "failure() named a side receipt: {f}");
    let failed: Vec<String> = o.failures().iter().map(|r| r.line()).collect();
    assert_eq!(failed.len(), 2, "{failed:#?}");
    assert!(failed.iter().any(|l| l.contains("probe_first") && l.contains("ProbeFirstFail")), "{failed:#?}");
    assert!(failed.iter().any(|l| l.contains("probe_cb") && l.contains("ProbeCallbackPanic")), "{failed:#?}");
    Ok(())
}

/// Finding 5 (P8, P4) and 8 (failed gas apart): a check over calls counts them first; a signer calling its own
/// contract has its receipt read from the transaction.
#[tokio::test]
async fn harness_counts_calls_first_and_reads_local_receipts() -> R<()> {
    let h = Harness::with_vault_and_mock_token().await?;
    let alice = h.account("alice", 20).await?;
    let bob = h.account("bob", 20).await?;
    h.mint(alice.id(), 5_000_000).await?;
    let _ = h.storage_deposit(&h.root, bob.id()).await?;
    // no ft_on_transfer ever runs in an ft_transfer
    let o = h.call(&alice, &h.token, "ft_transfer", json!({"receiver_id": bob.id(), "amount": "10"}), ONE_YOCTO, Gas::from_tgas(30)).await?;
    assert!(o.calls_exactly(&h.vault, "ft_on_transfer", 1).is_err(), "a check over a call that never ran passed");
    assert_eq!(o.calls_exactly(&h.vault, "ft_on_transfer", 0)?.len(), 0);

    // a signer calling its own contract: the first receipt is local
    let selfie = probe(&h, "selfie").await?;
    let o = h.call_outcome(&selfie, selfie.id(), "probe_first", json!({"fail": true}), ZERO, Gas::from_tgas(10)).await?;
    dump("P4", &o);
    let calls = o.calls_exactly(selfie.id(), "probe_first", 1)?;
    assert_eq!(calls.len(), 1, "the local receipt is not read");
    assert_eq!(calls[0].predecessor, selfie.id().as_str());
    assert!(!calls[0].ok() && calls[0].failure().is_some_and(|f| f.contains("ProbeFirstFail")), "{}", calls[0].line());
    let key = format!("{}::probe_first", selfie.id());
    println!("P4 gas keys {:?}; failed {:?}", h.gas().keys().collect::<Vec<_>>(), h.gas_failed().keys().collect::<Vec<_>>());
    assert_eq!(h.gas_failed().get(&key).map_or(0, Vec::len), 1, "the failed receipt's gas is not filed apart");
    assert!(!h.gas().contains_key(&key), "a failed receipt is in the gas stats");
    println!("\ngas table\n{}", h.gas_table());
    Ok(())
}

/// Finding 6 (P5): the keys of an account that does not exist are an error, never [].
#[tokio::test]
async fn harness_access_keys_of_a_missing_account_is_an_error() -> R<()> {
    let h = Harness::start().await?;
    let nobody: AccountId = format!("nobody.{}", h.root.id()).parse()?;
    for f in ["optimistic", "final"] {
        let k = h.access_keys(&nobody, f).await;
        println!("P5 access_keys(missing, {f}) = {:?}", k.as_ref().map_err(|e| e.to_string()));
        assert!(k.is_err(), "a missing account read as {k:?} at {f}");
        assert!(h.access_keys(&h.vault, f).await.is_err(), "the vault before its deploy read as an account at {f}");
    }
    let _ = h.deploy_vault().await?;
    h.wait_final(&h.vault).await?;
    assert!(h.access_keys(&h.vault, "final").await?.is_empty());
    Ok(())
}

/// Finding 8 (P7): the sandbox's version and protocol, a sandbox binary the run does not name, an `Unknown` status.
#[tokio::test]
async fn harness_sandbox_and_status_checks() -> R<()> {
    assert!(check_sandbox("2.13.4", 86, None, None).is_ok());
    assert!(check_sandbox("2.13.3", 86, None, None).is_err(), "another nearcore release passed");
    assert!(check_sandbox("2.13.4", 85, None, None).is_err(), "another protocol passed");
    assert!(check_sandbox("2.13.4", 86, Some("/x/near-sandbox"), None).is_err(), "an unnamed NEAR_SANDBOX_BIN_PATH passed");
    assert!(check_sandbox("2.13.4", 86, Some("/x/near-sandbox"), Some("/y")).is_err(), "a differently named binary passed");
    assert!(check_sandbox("2.13.4", 86, Some("/x/near-sandbox"), Some("/x/near-sandbox")).is_ok());

    assert!(status_is_ok(&json!({"SuccessValue": ""})));
    assert!(status_is_ok(&json!({"SuccessReceiptId": "11111111111111111111111111111111"})));
    assert!(!status_is_ok(&json!({"Failure": {"ActionError": {}}})));
    assert!(!status_is_ok(&json!("Unknown")), "an Unknown status read as ok");

    let h = Harness::start().await?;
    let (version, protocol) = h.sandbox_status().await?;
    println!("P7 sandbox {version} protocol {protocol}");
    assert_eq!((version.as_str(), protocol), ("2.13.4", 86));
    Ok(())
}
