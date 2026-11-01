// SPDX-License-Identifier: Apache-2.0
//! The vault's near-sandbox harness (vault.md 5 and V3.1): every sandbox money test starts here. It starts
//! near-sandbox 2.13.4, deploys the vault build by the 2.8 recipe and the mock token (tests/mock-token) at the token
//! account the build names, sends calls with a chosen deposit and gas, reads every receipt's outcome, and records the
//! gas burnt per method.
//!
//! The wasm files come from `tests/harness/run.sh`, which builds both with cargo-near and runs the sandbox tests
//! through `scripts/heavy.sh`: `VAULT_WASM` and `MOCK_TOKEN_WASM` name them. A plain `cargo test` never builds this:
//! every test that uses it is a `[[test]]` with `required-features = ["sandbox"]`.
//!
//! Gas per method: after each transaction the harness reads `EXPERIMENTAL_tx_status` from the sandbox's RPC, which
//! names each receipt's actions, and files every function-call receipt's `gas_burnt` under `<role>::<method>` (role:
//! `vault`, `token` or the account id). A batch receipt is filed under its function call.
#![allow(dead_code)] // shared by every sandbox test; each uses a part

use near_sdk::serde_json::{self, json, Value};
use near_workspaces::network::Sandbox;
use near_workspaces::operations::Function;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccountDetailsPatch, Gas, NearToken};
use near_workspaces::{Account, AccountId, Worker};
use std::collections::BTreeMap;
use std::sync::Mutex;

pub type R<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

/// The nearcore release the vault ships against (vault.md 5; mainnet's protocol 86, R 2026-10-25).
pub const SANDBOX_VERSION: &str = "2.13.4";
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

/// One receipt of a transaction, from `EXPERIMENTAL_tx_status`.
#[derive(Debug, Clone)]
pub struct Receipt {
    pub id: String,
    pub predecessor: String,
    pub executor: String,
    /// The function call's method; `None` for a receipt without one (a refund, a plain transfer).
    pub method: Option<String>,
    pub gas_burnt: u64,
    /// `SuccessValue` (base64, as RPC gives it) or `SuccessReceiptId`; `None` when the receipt failed.
    pub success: Option<Value>,
    /// The `Failure` object as JSON text.
    pub failure: Option<String>,
    pub logs: Vec<String>,
}

impl Receipt {
    pub fn ok(&self) -> bool {
        self.failure.is_none()
    }
}

/// A transaction's result: the final outcome and every receipt in execution order.
pub struct Outcome {
    pub result: ExecutionFinalResult,
    pub tx_hash: String,
    pub receipts: Vec<Receipt>,
}

impl Outcome {
    pub fn is_success(&self) -> bool {
        self.result.is_success()
    }
    /// The final value as JSON (`None` on failure or an empty value).
    pub fn json(&self) -> Option<Value> {
        self.result.clone().into_result().ok().and_then(|s| s.json::<Value>().ok())
    }
    /// When the transaction failed, the first failed receipt's `Failure` as JSON text (a panic reads
    /// `"Smart contract panicked: <msg>"` inside it); the whole result's debug text if no receipt names one.
    pub fn failure(&self) -> Option<String> {
        if self.result.is_success() {
            return None;
        }
        self.receipts.iter().find_map(|r| r.failure.clone()).or_else(|| Some(format!("{:?}", self.result)))
    }
    /// The function-call receipts of `method` on `executor`.
    pub fn calls<'a>(&'a self, executor: &'a AccountId, method: &'a str) -> impl Iterator<Item = &'a Receipt> + 'a {
        self.receipts.iter().filter(move |r| r.executor == executor.as_str() && r.method.as_deref() == Some(method))
    }
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
}

fn wasm_from_env(var: &str) -> R<Vec<u8>> {
    let p = std::env::var(var).map_err(|_| format!("{var} is not set: run the sandbox tests through tests/harness/run.sh"))?;
    Ok(std::fs::read(&p).map_err(|e| format!("{var}={p}: {e}"))?)
}

impl Harness {
    /// A fresh near-sandbox 2.13.4 with nothing deployed. Reads `VAULT_WASM`.
    pub async fn start() -> R<Self> {
        let worker = near_workspaces::sandbox_with_version(SANDBOX_VERSION).await?;
        let root = worker.root_account()?;
        let vault: AccountId = format!("vault.{}", root.id()).parse()?;
        let rpc = worker.rpc_addr();
        Ok(Self {
            vault,
            token: TOKEN.parse()?,
            vault_wasm: wasm_from_env("VAULT_WASM")?,
            rpc,
            http: reqwest::Client::new(),
            gas: Mutex::new(BTreeMap::new()),
            root,
            worker,
        })
    }

    /// `start`, then the vault by the 2.8 recipe and the mock token with the vault registered on it: the state every
    /// money test begins from.
    pub async fn with_vault_and_mock_token() -> R<Self> {
        let h = Self::start().await?;
        let d = h.deploy_vault().await?;
        if !d.is_success() {
            return Err(format!("the 2.8 recipe failed: {:?}", d.failure()).into());
        }
        h.deploy_mock_token().await?;
        let r = h.storage_deposit(&h.root, &h.vault).await?;
        if !r.is_success() {
            return Err(format!("registering the vault on the token failed: {:?}", r.failure()).into());
        }
        Ok(h)
    }

    /// The deploy recipe of vault.md 2.8: the parent signs one transaction to `vault.<parent>` with [CreateAccount,
    /// Transfer(code storage + 0.01 N), DeployContract(wasm), FunctionCall(config, 0 deposit)] and no AddKey.
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
        self.outcome(self.root.id(), result).await
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

    /// One function call from `signer` to `contract`, with `deposit` and `gas`; every receipt read back and its gas
    /// recorded.
    pub async fn call(
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

    /// `view_access_key_list` at `finality` ("optimistic" or "final"), straight from the sandbox's RPC.
    pub async fn access_keys(&self, id: &AccountId, finality: &str) -> R<Vec<Value>> {
        let v = self
            .rpc("query", json!({"request_type": "view_access_key_list", "finality": finality, "account_id": id}))
            .await?;
        let keys = v["result"]["keys"].as_array().ok_or_else(|| format!("view_access_key_list {id} {finality}: {v}"))?;
        Ok(keys.clone())
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

    pub async fn account_view(&self, id: &AccountId, finality: &str) -> R<Value> {
        let v = self.rpc("query", json!({"request_type": "view_account", "finality": finality, "account_id": id})).await?;
        Ok(v["result"].clone())
    }

    // ---- the mock token ----

    /// `storage_deposit(account_id)` on the token by `payer`, with USDC's 0.00125 N.
    pub async fn storage_deposit(&self, payer: &Account, account: &AccountId) -> R<Outcome> {
        let args = json!({"account_id": account, "registration_only": true});
        self.call(payer, &self.token, "storage_deposit", args, TOKEN_STORAGE, Gas::from_tgas(10)).await
    }

    /// Makes the mock token fail (`fail = true`) or stop failing `method` ("ft_transfer", "ft_transfer_call" or
    /// "storage_deposit"), for calls touching `account` only, or for every call with `None`.
    pub async fn mock_fail(&self, method: &str, account: Option<&AccountId>, fail: bool) -> R<()> {
        let args = json!({"method": method, "account_id": account, "fail": fail});
        let o = self.call(&self.root, &self.token, "set_fail", args, NearToken::from_yoctonear(0), Gas::from_tgas(10)).await?;
        if !o.is_success() {
            return Err(format!("set_fail({method}, {account:?}, {fail}): {:?}", o.failure()).into());
        }
        Ok(())
    }

    pub async fn mint(&self, account: &AccountId, amount: u128) -> R<()> {
        let args = json!({"account_id": account, "amount": amount.to_string()});
        let o = self.call(&self.root, &self.token, "mint", args, NearToken::from_yoctonear(0), Gas::from_tgas(10)).await?;
        if !o.is_success() {
            return Err(format!("mint({account}, {amount}): {:?}", o.failure()).into());
        }
        Ok(())
    }

    pub async fn token_balance(&self, account: &AccountId) -> R<u128> {
        let v = self.view(&self.token, "ft_balance_of", json!({"account_id": account})).await?;
        Ok(v.as_str().ok_or("ft_balance_of: not a string")?.parse()?)
    }

    // ---- receipts and gas ----

    async fn rpc(&self, method: &str, params: Value) -> R<Value> {
        let body = json!({"jsonrpc": "2.0", "id": "harness", "method": method, "params": params}).to_string();
        let text = self.http.post(&self.rpc).header("Content-Type", "application/json").body(body).send().await?.text().await?;
        Ok(serde_json::from_str(&text)?)
    }

    /// Reads every receipt of the transaction and records each function call's gas.
    async fn outcome(&self, signer: &AccountId, result: ExecutionFinalResult) -> R<Outcome> {
        let tx_hash = result.outcome().transaction_hash.to_string();
        let v = self
            .rpc("EXPERIMENTAL_tx_status", json!({"tx_hash": tx_hash, "sender_account_id": signer, "wait_until": "EXECUTED"}))
            .await?;
        let r = &v["result"];
        if r.is_null() {
            return Err(format!("EXPERIMENTAL_tx_status {tx_hash}: {v}").into());
        }
        let mut methods: BTreeMap<String, (String, Option<String>)> = BTreeMap::new();
        for rc in r["receipts"].as_array().into_iter().flatten() {
            let method = rc["receipt"]["Action"]["actions"].as_array().into_iter().flatten().find_map(|a| {
                a["FunctionCall"]["method_name"].as_str().map(str::to_string)
            });
            let id = rc["receipt_id"].as_str().unwrap_or_default().to_string();
            methods.insert(id, (rc["predecessor_id"].as_str().unwrap_or_default().to_string(), method));
        }
        let mut receipts = vec![];
        for ro in r["receipts_outcome"].as_array().into_iter().flatten() {
            let id = ro["id"].as_str().unwrap_or_default().to_string();
            let o = &ro["outcome"];
            let (predecessor, method) = methods.get(&id).cloned().unwrap_or_default();
            let status = &o["status"];
            let failure = status.get("Failure").map(|f| f.to_string());
            let success = if failure.is_some() {
                None
            } else {
                status.get("SuccessValue").or_else(|| status.get("SuccessReceiptId")).cloned()
            };
            receipts.push(Receipt {
                id,
                predecessor,
                executor: o["executor_id"].as_str().unwrap_or_default().to_string(),
                method,
                gas_burnt: o["gas_burnt"].as_u64().unwrap_or_default(),
                success,
                failure,
                logs: o["logs"].as_array().into_iter().flatten().filter_map(|l| l.as_str().map(str::to_string)).collect(),
            });
        }
        {
            let mut gas = self.gas.lock().unwrap();
            for rc in &receipts {
                if let Some(m) = &rc.method {
                    gas.entry(format!("{}::{m}", self.role(&rc.executor))).or_default().push(rc.gas_burnt);
                }
            }
        }
        Ok(Outcome { result, tx_hash, receipts })
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

    /// Every recorded receipt's gas, by `<role>::<method>`.
    pub fn gas(&self) -> BTreeMap<String, Vec<u64>> {
        self.gas.lock().unwrap().clone()
    }

    /// The gas table: calls, min, max and mean Tgas burnt per method.
    pub fn gas_table(&self) -> String {
        let mut s = format!("{:<34} {:>5} {:>10} {:>10} {:>10}\n", "method", "calls", "min Tgas", "max Tgas", "mean Tgas");
        for (m, g) in self.gas() {
            let (min, max) = (*g.iter().min().unwrap_or(&0), *g.iter().max().unwrap_or(&0));
            let mean = g.iter().map(|&x| x as f64).sum::<f64>() / g.len().max(1) as f64;
            s += &format!(
                "{:<34} {:>5} {:>10.3} {:>10.3} {:>10.3}\n",
                m,
                g.len(),
                min as f64 / TGAS,
                max as f64 / TGAS,
                mean / TGAS
            );
        }
        s
    }
}
