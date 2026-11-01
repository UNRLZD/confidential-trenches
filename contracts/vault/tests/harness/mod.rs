// SPDX-License-Identifier: Apache-2.0
//! The vault's near-sandbox harness (vault.md 5 and V3.1): every sandbox money test starts here. It starts
//! near-sandbox 2.13.4, deploys the vault build by the 2.8 recipe and the mock token (tests/mock-token) at the token
//! account the build names, sends calls with a chosen deposit and gas, reads every receipt's outcome, and records the
//! gas burnt per receipt.
//!
//! The wasm files come from `tests/harness/run.sh`, which builds them with cargo-near, and the sandbox tests run
//! through tests/harness/run.sh: `VAULT_WASM`, `MOCK_TOKEN_WASM` and `PROBE_WASM` (tests/harness/probe) name them, and
//! the harness prints each file's size and sha256 as it loads it. A plain `cargo test` never builds this: every test
//! that uses it is a `[[test]]` with `required-features = ["sandbox"]`.
//!
//! Sending fails closed: `call()`, `deploy_vault()` and every helper that sends return an error unless `all_ok()`, so a
//! money test that checks only balances still fails on a detached `on_payout` panic. A failure-path test asks for the
//! raw result by name with `call_outcome()`; `Outcome` is `#[must_use]`.
//!
//! Reading a transaction (`Outcome`):
//! - every call waits for `EXPERIMENTAL_tx_status` at `FINAL`, so every receipt, the signer's gas refunds included,
//!   has run before the call returns and before any balance is read;
//! - `all_ok()` is the success check: the final status and every receipt succeeded. The vault's withdraw, ragequit
//!   and settle never return their payout chain (vault.md 2.8), so a failed callback there reaches no final status;
//!   there is no check of the final status alone;
//! - `failure()` is the transaction's own failure (its final status); `failures()` lists every failed receipt, each
//!   with its receiver and actions;
//! - `calls_exactly(executor, method, n)` counts first: a predicate over no receipts never passes;
//! - the transaction's first receipt is read from the transaction itself when RPC lists no receipt for it (a signer
//!   calling its own account: the receipt is local); a receipt in no list at all makes the read an error;
//! - a failed receipt without a function call (a Transfer to a missing account) counts in `all_ok()` and `failures()`
//!   but in neither gas table, which holds function-call receipts only;
//! - a NEP-366 `Delegate` envelope is read as its outer action (`Delegate`) only: the inner actions are not recorded.
//!
//! Gas: every receipt holding a function call is filed under `<role>::<its whole action list>` (role: `vault`,
//! `token` or the account id; actions joined by `+`, a function call by its method, any other action by its RPC kind),
//! so a [storage_deposit, ft_transfer] receipt is `token::storage_deposit+ft_transfer` and the 2.8 recipe's receipt is
//! `vault::CreateAccount+Transfer+DeployContract+config`, apart from a plain `vault::config`. Failed receipts are
//! filed apart (`gas_failed()`).
//!
//! The sandbox: `start()` refuses unless RPC `status` reports near-sandbox 2.13.4 at protocol 86 (mainnet's,
//! R 2026-10-25), and refuses a `NEAR_SANDBOX_BIN_PATH` the run does not name in `HARNESS_SANDBOX_BIN`. Both variables
//! are read once, at the test binary's first `start()`, before any sandbox runs: near-sandbox 0.3.16 downloads its
//! binary on first use and then sets `NEAR_SANDBOX_BIN_PATH` to it inside this process (src/runner/mod.rs l.272-277),
//! which a later read would take for a foreign binary.
//!
//! The mock token is not NEP-141 as near-contract-standards 5.29.1 builds it (USDC's code), and these gaps stay:
//! - `ft_resolve_transfer` reads up to 64 bytes of the receiver's result; NCS reads 42 and refunds all on a longer one;
//! - `ft_transfer_call` gives the receiver the prepaid gas less 30 Tgas and the resolve 5 Tgas, the unused split
//!   between them (measured: 80.890 and 15.890 Tgas of 100), not NCS's split;
//! - an `ft_transfer` from an unregistered sender panics where USDC burns nothing; no events; no
//!   `storage_unregister`; `mint` registers the account; `ft_resolve_transfer` cannot be made to fail.
//! Those edges (a halted token between a deposit's move and its resolve, deposit gas at 180 Tgas) are owed by card
//! vault-sandbox-usdc on the real USDC wasm. There is no NEP-366 `DelegateAction` sender here: VT-S02 needs one, and
//! VT-S02's card, vault-deposit-insert, brings it (its proof: U's call as a `DelegateAction` sent by a relayer
//! account, in its tests/s02.rs). Gas and code figures hold for one machine: a Linux x86_64 build and a
//! macOS arm64 build give different vault bytes (at 65f3bb7: bc948c2b, 128767 B on Linux x86_64; 91a23f6f,
//! 129937 B on macOS arm64).
#![allow(dead_code)] // shared by every sandbox test; each uses a part

use near_sdk::serde_json::{self, json, Value};
use near_workspaces::network::Sandbox;
use near_workspaces::operations::Function;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccountDetailsPatch, Gas, NearToken};
use near_workspaces::{Account, AccountId, Worker};
use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};

pub type R<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

/// The nearcore release the vault ships against (vault.md 5; mainnet's protocol 86, R 2026-10-25).
pub const SANDBOX_VERSION: &str = "2.13.4";
pub const SANDBOX_PROTOCOL: u64 = 86;
/// The token account the mainnet vault build names (src/constants.rs `TOKEN`).
pub const TOKEN: &str = blindfill_vault::constants::TOKEN;
/// Yocto per storage byte (nearcore `storage_amount_per_byte`, 10^19).
pub const YOCTO_PER_BYTE: u128 = 10_000_000_000_000_000_000;
/// The recipe's config() call gas, as scripts/deploy-testnet.mjs sends it.
pub const CONFIG_GAS: Gas = Gas::from_tgas(100);
/// USDC's `storage_balance_bounds` min = max (vault.md 2.8).
pub const TOKEN_STORAGE: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
pub const TGAS: f64 = 1e12;

/// A receipt's or a transaction's status as RPC gives it.
#[derive(Debug, Clone, PartialEq)]
pub enum Status {
    /// `SuccessValue` (base64, as RPC gives it) or `SuccessReceiptId`, as the RPC object.
    Success(Value),
    /// The `Failure` object as JSON text (a panic reads `"Smart contract panicked: <msg>"` inside it).
    Failure(String),
    /// Anything else (`Unknown`, a status still pending): never ok.
    Unknown(String),
}

impl Status {
    pub fn parse(v: &Value) -> Self {
        if let Some(f) = v.get("Failure") {
            Status::Failure(f.to_string())
        } else if v.get("SuccessValue").is_some() || v.get("SuccessReceiptId").is_some() {
            Status::Success(v.clone())
        } else {
            Status::Unknown(v.to_string())
        }
    }
    pub fn ok(&self) -> bool {
        matches!(self, Status::Success(_))
    }
}

/// Whether an RPC status object reads as success (`Status::parse(v).ok()`).
pub fn status_is_ok(v: &Value) -> bool {
    Status::parse(v).ok()
}

/// One receipt of a transaction, from `EXPERIMENTAL_tx_status` at `FINAL`.
#[derive(Debug, Clone)]
pub struct Receipt {
    pub id: String,
    pub predecessor: String,
    pub executor: String,
    /// Every action, in order: a function call by its method, any other action by its RPC kind (`Transfer`,
    /// `CreateAccount`, `DeployContract`, `AddKey`, ...).
    pub actions: Vec<String>,
    /// The methods of its function calls, in order.
    pub methods: Vec<String>,
    pub gas_burnt: u64,
    pub status: Status,
    pub logs: Vec<String>,
}

impl Receipt {
    pub fn ok(&self) -> bool {
        self.status.ok()
    }
    /// The `Failure` as JSON text, when the receipt failed.
    pub fn failure(&self) -> Option<&str> {
        match &self.status {
            Status::Failure(f) => Some(f),
            _ => None,
        }
    }
    /// The gas table key's action part: every action joined by `+`.
    pub fn action_key(&self) -> String {
        self.actions.join("+")
    }
    /// One line: `<predecessor> -> <executor> <actions>: <Tgas>, <status>`.
    pub fn line(&self) -> String {
        format!("{} -> {} [{}]: {:.3} Tgas, {:?}", self.predecessor, self.executor, self.action_key(), self.gas_burnt as f64 / TGAS, self.status)
    }
}

/// A transaction's result: its final status and every receipt, read at `FINAL`.
#[must_use]
pub struct Outcome {
    result: ExecutionFinalResult,
    pub tx_hash: String,
    /// The transaction's own final status.
    pub status: Status,
    pub receipts: Vec<Receipt>,
}

impl Outcome {
    /// The success check: the final status and every receipt succeeded.
    pub fn all_ok(&self) -> bool {
        self.status.ok() && !self.receipts.is_empty() && self.receipts.iter().all(Receipt::ok)
    }
    /// `Ok` when `all_ok()`, else an error naming the final status and every failed receipt.
    pub fn expect_all_ok(&self, what: &str) -> R<()> {
        if self.all_ok() {
            return Ok(());
        }
        let failed: Vec<String> = self.receipts.iter().filter(|r| !r.ok()).map(Receipt::line).collect();
        Err(format!("{what}: final status {:?}; failed receipts {failed:#?}", self.status).into())
    }
    /// The transaction's own failure (its final status), as JSON text.
    pub fn failure(&self) -> Option<&str> {
        match &self.status {
            Status::Failure(f) => Some(f),
            _ => None,
        }
    }
    /// Every receipt that did not succeed, in RPC order.
    pub fn failures(&self) -> Vec<&Receipt> {
        self.receipts.iter().filter(|r| !r.ok()).collect()
    }
    /// The returned value as JSON (`None` on a failed final status or an empty value). A value, never a success check.
    pub fn json(&self) -> Option<Value> {
        self.result.clone().into_result().ok().and_then(|s| s.json::<Value>().ok())
    }
    /// The receipts on `executor` holding a call to `method`: exactly `n` of them, or an error naming every receipt.
    pub fn calls_exactly(&self, executor: &AccountId, method: &str, n: usize) -> R<Vec<&Receipt>> {
        let found: Vec<&Receipt> = self
            .receipts
            .iter()
            .filter(|r| r.executor == executor.as_str() && r.methods.iter().any(|m| m == method))
            .collect();
        if found.len() != n {
            let all: Vec<String> = self.receipts.iter().map(Receipt::line).collect();
            return Err(format!("{executor}::{method}: {} receipts, expected {n}; receipts {all:#?}", found.len()).into());
        }
        Ok(found)
    }
}

/// The sandbox the run uses: near-sandbox `SANDBOX_VERSION` at `SANDBOX_PROTOCOL`, and a `NEAR_SANDBOX_BIN_PATH`
/// (`bin`) only when the run names the same path (`named`, from `HARNESS_SANDBOX_BIN`).
pub fn check_sandbox(version: &str, protocol: u64, bin: Option<&str>, named: Option<&str>) -> Result<(), String> {
    if let Some(b) = bin {
        if named != Some(b) {
            return Err(format!("NEAR_SANDBOX_BIN_PATH={b} is set and the run does not name it (HARNESS_SANDBOX_BIN={named:?})"));
        }
    }
    if version != SANDBOX_VERSION || protocol != SANDBOX_PROTOCOL {
        return Err(format!("the sandbox is {version} at protocol {protocol}, not {SANDBOX_VERSION} at {SANDBOX_PROTOCOL}"));
    }
    Ok(())
}

/// (`NEAR_SANDBOX_BIN_PATH`, `HARNESS_SANDBOX_BIN`) as the run set them, read once before the first sandbox starts.
fn sandbox_env() -> &'static (Option<String>, Option<String>) {
    static ENV: OnceLock<(Option<String>, Option<String>)> = OnceLock::new();
    ENV.get_or_init(|| (std::env::var("NEAR_SANDBOX_BIN_PATH").ok(), std::env::var("HARNESS_SANDBOX_BIN").ok()))
}

pub struct Harness {
    pub worker: Worker<Sandbox>,
    pub root: Account,
    pub vault: AccountId,
    pub token: AccountId,
    pub vault_wasm: Vec<u8>,
    rpc: String,
    http: reqwest::Client,
    gas: Mutex<BTreeMap<String, Vec<u64>>>,
    gas_failed: Mutex<BTreeMap<String, Vec<u64>>>,
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The wasm `var` names, read and printed with its size and sha256.
pub fn wasm_from_env(var: &str) -> R<Vec<u8>> {
    let p = std::env::var(var).map_err(|_| format!("{var} is not set: run the sandbox tests through tests/harness/run.sh"))?;
    let w = std::fs::read(&p).map_err(|e| format!("{var}={p}: {e}"))?;
    println!("{var} {p} {} B sha256 {}", w.len(), hex(&near_sdk::env::sha256(&w)));
    Ok(w)
}

/// An RPC action's name: a function call's method, any other action's kind.
fn action_name(a: &Value) -> String {
    if let Some(m) = a["FunctionCall"]["method_name"].as_str() {
        return m.to_string();
    }
    match a {
        Value::String(s) => s.clone(),
        Value::Object(o) if o.len() == 1 => o.keys().next().cloned().unwrap_or_default(),
        _ => a.to_string(),
    }
}

impl Harness {
    /// A fresh near-sandbox 2.13.4 with nothing deployed, its version and protocol checked. Reads `VAULT_WASM`.
    pub async fn start() -> R<Self> {
        let (bin, named) = sandbox_env();
        check_sandbox(SANDBOX_VERSION, SANDBOX_PROTOCOL, bin.as_deref(), named.as_deref())?;
        let worker = near_workspaces::sandbox_with_version(SANDBOX_VERSION).await?;
        let root = worker.root_account()?;
        let vault: AccountId = format!("vault.{}", root.id()).parse()?;
        let rpc = worker.rpc_addr();
        let h = Self {
            vault,
            token: TOKEN.parse()?,
            vault_wasm: wasm_from_env("VAULT_WASM")?,
            rpc,
            http: reqwest::Client::new(),
            gas: Mutex::new(BTreeMap::new()),
            gas_failed: Mutex::new(BTreeMap::new()),
            root,
            worker,
        };
        let (version, protocol) = h.sandbox_status().await?;
        check_sandbox(&version, protocol, bin.as_deref(), named.as_deref())?;
        Ok(h)
    }

    /// The running sandbox's (version, protocol), from RPC `status`.
    pub async fn sandbox_status(&self) -> R<(String, u64)> {
        let s = self.rpc("status", json!([])).await?;
        let version = s["result"]["version"]["version"].as_str().ok_or_else(|| format!("status: {s}"))?.to_string();
        let protocol = s["result"]["protocol_version"].as_u64().ok_or_else(|| format!("status: {s}"))?;
        Ok((version, protocol))
    }

    /// `start`, then the vault by the 2.8 recipe and the mock token with the vault registered on it: the state every
    /// money test begins from.
    pub async fn with_vault_and_mock_token() -> R<Self> {
        let h = Self::start().await?;
        let _ = h.deploy_vault().await?;
        h.deploy_mock_token().await?;
        let _ = h.storage_deposit(&h.root, &h.vault).await?;
        Ok(h)
    }

    /// The deploy recipe of vault.md 2.8: the parent signs one transaction to `vault.<parent>` with [CreateAccount,
    /// Transfer(code storage + 0.01 N), DeployContract(wasm), FunctionCall(config, 0 deposit)] and no AddKey. An error
    /// unless `all_ok()`.
    pub async fn deploy_vault(&self) -> R<Outcome> {
        let transfer = (self.vault_wasm.len() as u128 + 100) * YOCTO_PER_BYTE + NearToken::from_millinear(10).as_yoctonear();
        let tx = self
            .root
            .batch(&self.vault)
            .create_account()
            .transfer(NearToken::from_yoctonear(transfer))
            .deploy(&self.vault_wasm)
            .call(Function::new("config").args(vec![]).gas(CONFIG_GAS).deposit(NearToken::from_yoctonear(0)));
        let result = tx.transact().await?;
        let o = self.outcome(self.root.id(), result).await?;
        o.expect_all_ok("the 2.8 recipe")?;
        Ok(o)
    }

    /// The mock token's code at the token account the build names (a 64-hex id no one holds a key to, so the
    /// sandbox's state patch puts it there), with 100 N for its storage.
    pub async fn deploy_mock_token(&self) -> R<()> {
        let wasm = wasm_from_env("MOCK_TOKEN_WASM")?;
        self.worker
            .patch(&self.token)
            .account(AccountDetailsPatch::default().balance(NearToken::from_near(100)).storage_usage(wasm.len() as u64 + 100))
            .code(&wasm)
            .transact()
            .await?;
        Ok(())
    }

    /// A test account `<name>.<root>` holding `near` N, with a key (test actors are not the vault).
    pub async fn account(&self, name: &str, near: u128) -> R<Account> {
        Ok(self.root.create_subaccount(name).initial_balance(NearToken::from_near(near)).transact().await?.into_result()?)
    }

    /// One function call from `signer` to `contract`, with `deposit` and `gas`, read as `call_outcome` reads it: an
    /// error unless `all_ok()`, naming the final status and every failed receipt.
    pub async fn call(
        &self,
        signer: &Account,
        contract: &AccountId,
        method: &str,
        args: Value,
        deposit: NearToken,
        gas: Gas,
    ) -> R<Outcome> {
        let o = self.call_outcome(signer, contract, method, args, deposit, gas).await?;
        o.expect_all_ok(&format!("{}::{method} by {}", contract, signer.id()))?;
        Ok(o)
    }

    /// The failure path's call: one function call, every receipt read back at `FINAL` and its gas recorded, and the raw
    /// `Outcome` whatever happened. A test that uses it checks the outcome itself.
    pub async fn call_outcome(
        &self,
        signer: &Account,
        contract: &AccountId,
        method: &str,
        args: Value,
        deposit: NearToken,
        gas: Gas,
    ) -> R<Outcome> {
        let result = signer.call(contract, method).args_json(args).deposit(deposit).gas(gas).transact().await?;
        self.outcome(signer.id(), result).await
    }

    pub async fn view(&self, contract: &AccountId, method: &str, args: Value) -> R<Value> {
        Ok(self.worker.view(contract, method).args_json(args).await?.json::<Value>()?)
    }

    /// `view_account` at `finality` ("optimistic" or "final"); an account that does not exist is an error.
    pub async fn account_view(&self, id: &AccountId, finality: &str) -> R<Value> {
        let v = self.rpc("query", json!({"request_type": "view_account", "finality": finality, "account_id": id})).await?;
        if !v["result"]["code_hash"].is_string() {
            return Err(format!("view_account {id} {finality}: {v}").into());
        }
        Ok(v["result"].clone())
    }

    /// `view_access_key_list` of `id` at the block where `view_account` at `finality` read it: an account that does
    /// not exist is an error, never `[]`.
    pub async fn access_keys(&self, id: &AccountId, finality: &str) -> R<Vec<Value>> {
        let acct = self.account_view(id, finality).await?;
        let block = acct["block_hash"].as_str().ok_or_else(|| format!("view_account {id} {finality}: no block_hash in {acct}"))?;
        let v = self.rpc("query", json!({"request_type": "view_access_key_list", "block_id": block, "account_id": id})).await?;
        let keys = v["result"]["keys"].as_array().ok_or_else(|| format!("view_access_key_list {id} at {block}: {v}"))?;
        Ok(keys.clone())
    }

    /// The account's NEAR balance in yocto, at `final`.
    pub async fn near_balance(&self, id: &AccountId) -> R<u128> {
        let a = self.account_view(id, "final").await?;
        Ok(a["amount"].as_str().ok_or_else(|| format!("view_account {id}: no amount in {a}"))?.parse()?)
    }

    /// Waits until `id` exists at final finality (at most ~10 s), so a "final" read sees the latest deploy.
    pub async fn wait_final(&self, id: &AccountId) -> R<()> {
        for _ in 0..50 {
            let v = self.rpc("query", json!({"request_type": "view_account", "finality": "final", "account_id": id})).await?;
            if v["result"]["code_hash"].is_string() {
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        Err(format!("{id} not final after 10 s").into())
    }

    // ---- the mock token ----

    /// `storage_deposit(account_id)` on the token by `payer`, with USDC's 0.00125 N; an error unless `all_ok()`.
    pub async fn storage_deposit(&self, payer: &Account, account: &AccountId) -> R<Outcome> {
        let args = json!({"account_id": account, "registration_only": true});
        self.call(payer, &self.token, "storage_deposit", args, TOKEN_STORAGE, Gas::from_tgas(10)).await
    }

    /// Makes the mock token fail (`fail = true`) or stop failing `method` ("ft_transfer", "ft_transfer_call" or
    /// "storage_deposit"), for calls touching `account` only, or for every call with `None`.
    pub async fn mock_fail(&self, method: &str, account: Option<&AccountId>, fail: bool) -> R<()> {
        let args = json!({"method": method, "account_id": account, "fail": fail});
        let _ = self.call(&self.root, &self.token, "set_fail", args, NearToken::from_yoctonear(0), Gas::from_tgas(10)).await?;
        Ok(())
    }

    pub async fn mint(&self, account: &AccountId, amount: u128) -> R<()> {
        let args = json!({"account_id": account, "amount": amount.to_string()});
        let _ = self.call(&self.root, &self.token, "mint", args, NearToken::from_yoctonear(0), Gas::from_tgas(10)).await?;
        Ok(())
    }

    pub async fn token_balance(&self, account: &AccountId) -> R<u128> {
        let v = self.view(&self.token, "ft_balance_of", json!({"account_id": account})).await?;
        Ok(v.as_str().ok_or("ft_balance_of: not a string")?.parse()?)
    }

    // ---- receipts and gas ----

    /// One JSON-RPC call to the sandbox; the whole response (`result` or `error`).
    pub async fn rpc(&self, method: &str, params: Value) -> R<Value> {
        let body = json!({"jsonrpc": "2.0", "id": "harness", "method": method, "params": params}).to_string();
        let text = self.http.post(&self.rpc).header("Content-Type", "application/json").body(body).send().await?.text().await?;
        Ok(serde_json::from_str(&text)?)
    }

    /// Reads the transaction at `FINAL` (every receipt, refunds included), names every receipt's actions and records
    /// each function-call receipt's gas.
    async fn outcome(&self, signer: &AccountId, result: ExecutionFinalResult) -> R<Outcome> {
        let tx_hash = result.outcome().transaction_hash.to_string();
        let v = self
            .rpc("EXPERIMENTAL_tx_status", json!({"tx_hash": tx_hash, "sender_account_id": signer, "wait_until": "FINAL"}))
            .await?;
        let r = &v["result"];
        if r.is_null() || r["final_execution_status"] != "FINAL" {
            return Err(format!("EXPERIMENTAL_tx_status {tx_hash} at FINAL: {v}").into());
        }
        // (predecessor, actions) by receipt id; the transaction's first receipt from the transaction itself, since a
        // local receipt (signer = receiver) has no entry in `receipts`
        let mut origin: BTreeMap<String, (String, Vec<Value>)> = BTreeMap::new();
        if let Some(first) = r["transaction_outcome"]["outcome"]["receipt_ids"][0].as_str() {
            let t = &r["transaction"];
            let actions = t["actions"].as_array().cloned().unwrap_or_default();
            origin.insert(first.to_string(), (t["signer_id"].as_str().unwrap_or_default().to_string(), actions));
        }
        for rc in r["receipts"].as_array().into_iter().flatten() {
            let id = rc["receipt_id"].as_str().unwrap_or_default().to_string();
            let actions = rc["receipt"]["Action"]["actions"].as_array().cloned().unwrap_or_default();
            origin.insert(id, (rc["predecessor_id"].as_str().unwrap_or_default().to_string(), actions));
        }
        let mut receipts = vec![];
        for ro in r["receipts_outcome"].as_array().into_iter().flatten() {
            let id = ro["id"].as_str().unwrap_or_default().to_string();
            let (predecessor, actions) =
                origin.get(&id).cloned().ok_or_else(|| format!("{tx_hash}: receipt {id} is in no receipt list: {v}"))?;
            let o = &ro["outcome"];
            receipts.push(Receipt {
                id,
                predecessor,
                executor: o["executor_id"].as_str().unwrap_or_default().to_string(),
                methods: actions.iter().filter_map(|a| a["FunctionCall"]["method_name"].as_str().map(str::to_string)).collect(),
                actions: actions.iter().map(action_name).collect(),
                gas_burnt: o["gas_burnt"].as_u64().ok_or_else(|| format!("{tx_hash}: no gas_burnt in {ro}"))?,
                status: Status::parse(&o["status"]),
                logs: o["logs"].as_array().into_iter().flatten().filter_map(|l| l.as_str().map(str::to_string)).collect(),
            });
        }
        {
            let (mut gas, mut failed) = (self.gas.lock().unwrap(), self.gas_failed.lock().unwrap());
            for rc in receipts.iter().filter(|rc| !rc.methods.is_empty()) {
                let key = format!("{}::{}", self.role(&rc.executor), rc.action_key());
                let into = if rc.ok() { &mut gas } else { &mut failed };
                into.entry(key).or_default().push(rc.gas_burnt);
            }
        }
        Ok(Outcome { result, tx_hash, status: Status::parse(&r["status"]), receipts })
    }

    fn role(&self, executor: &str) -> String {
        if executor == self.vault.as_str() {
            "vault".into()
        } else if executor == self.token.as_str() {
            "token".into()
        } else {
            executor.into()
        }
    }

    /// Every successful function-call receipt's gas, by `<role>::<actions>`.
    pub fn gas(&self) -> BTreeMap<String, Vec<u64>> {
        self.gas.lock().unwrap().clone()
    }

    /// Every failed function-call receipt's gas, by `<role>::<actions>`, kept apart from `gas()`.
    pub fn gas_failed(&self) -> BTreeMap<String, Vec<u64>> {
        self.gas_failed.lock().unwrap().clone()
    }

    /// The gas table: calls, min, max and mean Tgas burnt per receipt key; failed receipts in their own section.
    pub fn gas_table(&self) -> String {
        let rows = |m: BTreeMap<String, Vec<u64>>| {
            let mut s = String::new();
            for (k, g) in m {
                let (min, max) = (*g.iter().min().unwrap_or(&0), *g.iter().max().unwrap_or(&0));
                let mean = g.iter().map(|&x| x as f64).sum::<f64>() / g.len().max(1) as f64;
                s += &format!("{:<52} {:>5} {:>10.3} {:>10.3} {:>10.3}\n", k, g.len(), min as f64 / TGAS, max as f64 / TGAS, mean / TGAS);
            }
            s
        };
        let head = format!("{:<52} {:>5} {:>10} {:>10} {:>10}\n", "receipt", "calls", "min Tgas", "max Tgas", "mean Tgas");
        let failed = self.gas_failed();
        let mut s = head.clone() + &rows(self.gas());
        if !failed.is_empty() {
            s += &format!("\nfailed receipts\n{head}{}", rows(failed));
        }
        s
    }
}
