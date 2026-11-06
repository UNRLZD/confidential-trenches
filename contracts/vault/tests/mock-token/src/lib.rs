// SPDX-License-Identifier: Apache-2.0
//! A test-only NEP-141 / NEP-145 token that fails on demand (vault.md 5: every sandbox money test runs once with "a
//! mock token that fails on demand" and once with the real USDC wasm). Written new for the harness; it follows the
//! NEP-141 and NEP-145 interfaces the vault calls (`storage_deposit`, `ft_transfer`) and the one a depositor calls
//! (`ft_transfer_call`, which calls the receiver's `ft_on_transfer` and refunds what it returns).
//!
//! It is deployed only into a local near-sandbox, at the token account the vault build names (the harness patches the
//! code in), so every method is open to every caller: `mint` and `set_fail` exist for the tests and never for a
//! network.
//!
//! Failing on demand: `set_fail(method, account_id, fail)` adds or removes a rule. A rule with an `account_id` fails
//! only the calls that touch that account (`ft_transfer` and `ft_transfer_call` by receiver, `storage_deposit` by the
//! account registered); without one it fails every call of that method. A failing call panics with
//! `MockTokenFail: <method>` before it changes anything, so the caller's promise result is Failed. This drives the
//! vault's `on_payout` with each part Successful or Failed (VT-S08, VT-S17), a failed registration and VT-P02's random
//! part failures. A rule on `is_blocklisted` makes that view answer true for the account (or for every account),
//! as USDC's blocklist does: the relayer reads it of its fee account before it signs (card vault-review-fixes-1, F-1).

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PromiseOrValue,
};

/// The methods `set_fail` can fail.
const FAILABLE: [&str; 4] = ["ft_transfer", "ft_transfer_call", "storage_deposit", "is_blocklisted"];
/// USDC's `storage_balance_bounds` on NEAR mainnet: min = max = 0.00125 N (vault.md 2.8).
const STORAGE_BYTES_COST: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
/// What `ft_transfer_call` keeps for itself and for `ft_resolve_transfer`, as near-contract-standards' token does.
const GAS_FOR_RESOLVE: Gas = Gas::from_tgas(5);
const GAS_FOR_TRANSFER_CALL: Gas = Gas::from_tgas(30);

#[near]
#[derive(BorshStorageKey)]
enum Key {
    Balances,
}

#[near(contract_state)]
pub struct MockToken {
    balances: LookupMap<AccountId, u128>,
    total_supply: u128,
    /// (method, account) rules; `None` fails every call of the method.
    fail: Vec<(String, Option<AccountId>)>,
}

impl Default for MockToken {
    fn default() -> Self {
        Self { balances: LookupMap::new(Key::Balances), total_supply: 0, fail: Vec::new() }
    }
}

#[near(serializers = [json])]
pub struct StorageBalance {
    pub total: U128,
    pub available: U128,
}

#[near(serializers = [json])]
pub struct StorageBalanceBounds {
    pub min: U128,
    pub max: Option<U128>,
}

#[near(serializers = [json])]
pub struct FailRule {
    pub method: String,
    pub account_id: Option<AccountId>,
}

#[ext_contract(ext_receiver)]
pub trait FungibleTokenReceiver {
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128>;
}

#[ext_contract(ext_self)]
pub trait SelfResolve {
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128;
}

#[near]
impl MockToken {
    /// Adds (`fail = true`) or removes a failure rule. Test-only: open to every caller.
    pub fn set_fail(&mut self, method: String, account_id: Option<AccountId>, fail: bool) {
        require!(FAILABLE.contains(&method.as_str()), "MockTokenUnknownMethod");
        self.fail.retain(|(m, a)| !(m == &method && a == &account_id));
        if fail {
            self.fail.push((method, account_id));
        }
    }

    pub fn fail_rules(&self) -> Vec<FailRule> {
        self.fail.iter().map(|(m, a)| FailRule { method: m.clone(), account_id: a.clone() }).collect()
    }

    /// Credits `amount` to `account_id`, registering it first. Test-only: open to every caller.
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        let b = self.balances.get(&account_id).copied().unwrap_or(0);
        self.balances.insert(account_id, b.checked_add(amount.0).expect("MockTokenOverflow"));
        self.total_supply = self.total_supply.checked_add(amount.0).expect("MockTokenOverflow");
    }

    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        let _ = registration_only; // min = max: there is never anything beyond the registration to keep
        let account = account_id.unwrap_or_else(env::predecessor_account_id);
        self.check_fail("storage_deposit", &account);
        let attached = env::attached_deposit();
        let refund = if self.balances.contains_key(&account) {
            attached
        } else {
            require!(attached >= STORAGE_BYTES_COST, "The attached deposit is less than the minimum storage balance");
            self.balances.insert(account, 0);
            attached.saturating_sub(STORAGE_BYTES_COST)
        };
        if !refund.is_zero() {
            near_sdk::Promise::new(env::predecessor_account_id()).transfer(refund).detach();
        }
        StorageBalance { total: U128(STORAGE_BYTES_COST.as_yoctonear()), available: U128(0) }
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.balances
            .contains_key(&account_id)
            .then(|| StorageBalance { total: U128(STORAGE_BYTES_COST.as_yoctonear()), available: U128(0) })
    }

    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        let b = U128(STORAGE_BYTES_COST.as_yoctonear());
        StorageBalanceBounds { min: b, max: Some(b) }
    }

    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        let _ = memo;
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "Requires attached deposit of exactly 1 yoctoNEAR");
        self.check_fail("ft_transfer", &receiver_id);
        self.move_balance(&env::predecessor_account_id(), &receiver_id, amount.0);
    }

    #[payable]
    pub fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let _ = memo;
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "Requires attached deposit of exactly 1 yoctoNEAR");
        require!(env::prepaid_gas() > GAS_FOR_TRANSFER_CALL, "More gas is required");
        self.check_fail("ft_transfer_call", &receiver_id);
        let sender = env::predecessor_account_id();
        self.move_balance(&sender, &receiver_id, amount.0);
        let on_gas = env::prepaid_gas().saturating_sub(GAS_FOR_TRANSFER_CALL);
        ext_receiver::ext(receiver_id.clone())
            .with_static_gas(on_gas)
            .ft_on_transfer(sender.clone(), amount, msg)
            .then(ext_self::ext(env::current_account_id()).with_static_gas(GAS_FOR_RESOLVE).ft_resolve_transfer(
                sender,
                receiver_id,
                amount,
            ))
            .into()
    }

    /// Gives the sender back what the receiver's `ft_on_transfer` returned (all of it when that call failed), as far as
    /// the receiver still holds it; returns what was used.
    #[private]
    pub fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        // a U128 as JSON is at most 41 bytes; anything longer or unreadable counts as nothing used
        let unused = match env::promise_result_checked(0, 64) {
            Ok(v) => near_sdk::serde_json::from_slice::<U128>(&v).map(|u| u.0.min(amount.0)).unwrap_or(amount.0),
            Err(_) => amount.0,
        };
        if unused > 0 {
            let held = self.balances.get(&receiver_id).copied().unwrap_or(0);
            let back = unused.min(held);
            if back > 0 && self.balances.contains_key(&sender_id) {
                self.balances.insert(receiver_id, held - back);
                let s = self.balances.get(&sender_id).copied().unwrap_or(0);
                self.balances.insert(sender_id, s + back);
                return U128(amount.0 - back);
            }
        }
        amount
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.balances.get(&account_id).copied().unwrap_or(0))
    }

    pub fn ft_total_supply(&self) -> U128 {
        U128(self.total_supply)
    }

    /// USDC's blocklist view: true when an `is_blocklisted` rule names the account, or names none.
    pub fn is_blocklisted(&self, account_id: AccountId) -> bool {
        self.fail.iter().any(|(m, a)| m == "is_blocklisted" && a.as_ref().is_none_or(|a| a == &account_id))
    }
}

impl MockToken {
    fn check_fail(&self, method: &str, account: &AccountId) {
        if self.fail.iter().any(|(m, a)| m == method && a.as_ref().is_none_or(|a| a == account)) {
            env::panic_str(&format!("MockTokenFail: {method}"));
        }
    }

    fn move_balance(&mut self, from: &AccountId, to: &AccountId, amount: u128) {
        require!(amount > 0, "The amount should be a positive number");
        require!(from != to, "Sender and receiver should be different");
        let f = *self.balances.get(from).unwrap_or_else(|| env::panic_str(&format!("The account {from} is not registered")));
        let t = *self.balances.get(to).unwrap_or_else(|| env::panic_str(&format!("The account {to} is not registered")));
        require!(f >= amount, "The account doesn't have enough balance");
        self.balances.insert(from.clone(), f - amount);
        self.balances.insert(to.clone(), t.checked_add(amount).expect("MockTokenOverflow"));
    }
}
