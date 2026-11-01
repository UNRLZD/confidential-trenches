// SPDX-License-Identifier: Apache-2.0
//! The harness's smoke test, in near-sandbox 2.13.4 (vault.md 5, V3.1). Runs only with `--features sandbox`, through
//! tests/harness/run.sh on scripts/heavy.sh.
//!
//! 1. `deploy_recipe_is_keyless`: the skeleton deployed by the 2.8 recipe ([CreateAccount, Transfer, DeployContract,
//!    FunctionCall(config)], no AddKey) lands, `view_access_key_list` reads `keys: []` at optimistic and at final, and
//!    `config()` answers the same from the recipe's call and from a view, naming the build's token.
//! 2. `mock_token_fails_on_demand`: each failure rule of the mock token fails its call (`MockTokenFail: <method>`) with
//!    nothing moved, and the same call passes once the rule is cleared; `ft_transfer_call` to the skeleton (which has
//!    no `ft_on_transfer` yet) gives the sender everything back.
//!
//! Each prints the gas table.
mod harness;

use harness::{Harness, R, ONE_YOCTO, TOKEN};
use near_sdk::serde_json::{json, Value};
use near_workspaces::types::Gas;

#[tokio::test]
async fn deploy_recipe_is_keyless() -> R<()> {
    let h = Harness::start().await?;
    let d = h.deploy_vault().await?;
    for r in &d.receipts {
        println!("recipe receipt {} -> {} {:?}: {:.3} Tgas, ok {}", r.predecessor, r.executor, r.method, r.gas_burnt as f64 / 1e12, r.ok());
    }
    assert!(d.is_success(), "the 2.8 recipe failed: {:?}", d.failure());
    let from_recipe = d.json().expect("config() returned no JSON in the recipe's receipt");
    assert_eq!(d.calls(&h.vault, "config").count(), 1, "the recipe's receipt is the config() call");

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

fn failed_with(o: &harness::Outcome, msg: &str) -> bool {
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
    assert!(h.storage_deposit(&h.root, bob.id()).await?.is_success());
    let transfer = |to: &near_workspaces::AccountId| json!({"receiver_id": to, "amount": "1000000"});
    let g30 = Gas::from_tgas(30);

    // ft_transfer to bob: fails while the rule names bob, passes once cleared
    h.mock_fail("ft_transfer", Some(bob.id()), true).await?;
    let o = h.call(&alice, &h.token, "ft_transfer", transfer(bob.id()), ONE_YOCTO, g30).await?;
    println!("ft_transfer with the rule: {:?}", o.failure());
    assert!(failed_with(&o, "MockTokenFail: ft_transfer"), "ft_transfer did not fail on demand");
    assert_eq!((h.token_balance(alice.id()).await?, h.token_balance(bob.id()).await?), (5_000_000, 0), "a failed transfer moved money");
    h.mock_fail("ft_transfer", Some(bob.id()), false).await?;
    let o = h.call(&alice, &h.token, "ft_transfer", transfer(bob.id()), ONE_YOCTO, g30).await?;
    assert!(o.is_success(), "ft_transfer failed with no rule: {:?}", o.failure());
    assert_eq!((h.token_balance(alice.id()).await?, h.token_balance(bob.id()).await?), (4_000_000, 1_000_000));

    // a rule without an account fails every ft_transfer
    h.mock_fail("ft_transfer", None, true).await?;
    let o = h.call(&bob, &h.token, "ft_transfer", transfer(alice.id()), ONE_YOCTO, g30).await?;
    assert!(failed_with(&o, "MockTokenFail: ft_transfer"), "a rule for every receiver did not fail the call");
    h.mock_fail("ft_transfer", None, false).await?;

    // storage_deposit
    let carol: near_workspaces::AccountId = format!("carol.{}", h.root.id()).parse()?;
    h.mock_fail("storage_deposit", Some(&carol), true).await?;
    let o = h.storage_deposit(&h.root, &carol).await?;
    println!("storage_deposit with the rule: {:?}", o.failure());
    assert!(failed_with(&o, "MockTokenFail: storage_deposit"), "storage_deposit did not fail on demand");
    assert!(h.view(&h.token, "storage_balance_of", json!({"account_id": carol})).await?.is_null());
    h.mock_fail("storage_deposit", Some(&carol), false).await?;
    assert!(h.storage_deposit(&h.root, &carol).await?.is_success());
    assert!(!h.view(&h.token, "storage_balance_of", json!({"account_id": carol})).await?.is_null());

    // ft_transfer_call to the vault: refused on demand at the token; without the rule, the skeleton's missing
    // ft_on_transfer fails and ft_resolve_transfer gives alice everything back
    let call = json!({"receiver_id": h.vault, "amount": "1000000", "msg": "{}"});
    h.mock_fail("ft_transfer_call", Some(&h.vault), true).await?;
    let o = h.call(&alice, &h.token, "ft_transfer_call", call.clone(), ONE_YOCTO, Gas::from_tgas(100)).await?;
    assert!(failed_with(&o, "MockTokenFail: ft_transfer_call"), "ft_transfer_call did not fail on demand");
    h.mock_fail("ft_transfer_call", Some(&h.vault), false).await?;
    let o = h.call(&alice, &h.token, "ft_transfer_call", call, ONE_YOCTO, Gas::from_tgas(100)).await?;
    for r in &o.receipts {
        println!("ft_transfer_call receipt {} -> {} {:?}: {:.3} Tgas, ok {}", r.predecessor, r.executor, r.method, r.gas_burnt as f64 / 1e12, r.ok());
    }
    assert!(o.calls(&h.vault, "ft_on_transfer").all(|r| !r.ok()), "the skeleton has no ft_on_transfer: that receipt must fail");
    let resolve: Vec<_> = o.calls(&h.token, "ft_resolve_transfer").collect();
    assert_eq!(resolve.len(), 1);
    assert!(resolve[0].ok());
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
