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
//! Every money test runs twice (vault.md 5): `with_vault_and(TokenKind::Mock)` and `with_vault_and(TokenKind::Usdc)`.
//! The real tokens (card vault-sandbox-usdc) are mainnet's own code, pinned by size, sha256 and code hash in
//! tests/fixtures/real-wasm.json and fetched by tests/harness/fetch-wasm.mjs (view_code on two mainnet RPCs; run.sh
//! names them in `USDC_WASM` and `INTENTS_WASM`); the harness refuses any other bytes:
//! - USDC (Circle's FiatToken) at TOKEN, set up as mainnet's was: the token account's own [DeployContract,
//!   FunctionCall init] with a test account in every role, two controllers for one minter and its allowance, each by
//!   a multisig request. Its halt is the pausers' multisig `Pause` / `Unpause` (`usdc_halt`); `mint` mints by the minter.
//! - intents.near at DF (defuse v0.4.5, commit 16d04f6), by its own [DeployContract, FunctionCall new], fee 0, a test
//!   account as super admin and in its pause and unpause roles (`deploy_intents`).
//! A 64-hex implicit id and a `.near` name are ids no sandbox test can create, so each of those two accounts and one
//! test key on it come from a state patch (`keyed_account`); their code and state come only from transactions.
//!
//! The mock token is not NEP-141 as near-contract-standards 5.29.1 builds it (USDC's code), and these gaps stay:
//! - `ft_resolve_transfer` reads up to 64 bytes of the receiver's result; NCS reads 42 and refunds all on a longer one;
//! - `ft_transfer_call` gives the receiver the prepaid gas less 30 Tgas and the resolve 5 Tgas, the unused split
//!   between them (measured: 80.890 and 15.890 Tgas of 100), not NCS's split;
//! - an `ft_transfer` from an unregistered sender panics where USDC burns nothing; no events; no
//!   `storage_unregister`; `mint` registers the account; `ft_resolve_transfer` cannot be made to fail.
//! Those edges (a halted token between a deposit's move and its resolve, deposit gas at 180 Tgas) are the real USDC
//! wasm's to drive: run the case with `TokenKind::Usdc`. A NEP-366 `DelegateAction` is sent by `delegate_call` (U's own call, carried
//! and paid for by a relayer account: VT-S02, tests/s02.rs), and U is made by `implicit_account`. Gas and code figures hold for one machine: a Linux x86_64 build and a
//! macOS arm64 build give different vault bytes (at 65f3bb7: bc948c2b, 128767 B on Linux x86_64; 91a23f6f,
//! 129937 B on macOS arm64).
#![allow(dead_code)] // shared by every sandbox test; each uses a part

use near_sdk::serde_json::{self, json, Value};
use near_workspaces::network::Sandbox;
use near_workspaces::operations::Function;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, AccountDetailsPatch, CryptoHash, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Worker};
use std::collections::BTreeMap;
use std::str::FromStr;
use std::sync::{Mutex, OnceLock};

pub type R<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

/// The nearcore release the vault ships against (vault.md 5; mainnet's protocol 86, R 2026-10-25).
pub const SANDBOX_VERSION: &str = "2.13.4";
pub const SANDBOX_PROTOCOL: u64 = 86;
/// The token account the mainnet vault build names (src/constants.rs `TOKEN`).
pub const TOKEN: &str = blindfill_vault::constants::TOKEN;
/// NEAR Intents' verifier account the vault build names (src/constants.rs `INTENTS`).
pub const INTENTS: &str = blindfill_vault::constants::INTENTS;
/// USDC's own message for every call while halted, its views included.
pub const USDC_HALTED: &str = "FiatToken: paused";
/// The pins of the real wasm files (card vault-sandbox-usdc).
pub const REAL_WASM: &str = include_str!("../fixtures/real-wasm.json");
/// Yocto per storage byte (nearcore `storage_amount_per_byte`, 10^19).
pub const YOCTO_PER_BYTE: u128 = 10_000_000_000_000_000_000;
/// The recipe's config() call gas, as scripts/deploy.mjs sends it (`CONFIG_GAS`).
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
    /// The arguments of its function calls, in order, base64 as RPC gives them.
    pub args: Vec<String>,
    /// The block it ran in (its outcome's `block_hash`).
    pub block_hash: String,
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
    /// near-workspaces' own result; `None` for a transaction the harness signed and sent itself (`delegate_call`).
    result: Option<ExecutionFinalResult>,
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
        self.result.clone()?.into_result().ok().and_then(|s| s.json::<Value>().ok())
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

/// Which token a money test runs on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenKind {
    /// tests/mock-token: fails on demand (`mock_fail`).
    Mock,
    /// The real USDC wasm (tests/fixtures/real-wasm.json), with test accounts in its roles.
    Usdc,
}

/// The test accounts in the real USDC's roles.
pub struct UsdcRoles {
    pub admin: Account,
    pub owner: Account,
    pub pausers: [Account; 2],
    pub blocklister: Account,
    pub master_minters: [Account; 2],
    pub minter: Account,
    pub controllers: [Account; 2],
}

/// A pin of tests/fixtures/real-wasm.json.
pub struct Pin {
    pub env: String,
    pub account: String,
    pub bytes: usize,
    pub sha256: String,
    pub code_hash: String,
    pub source_rev: Option<String>,
}

/// The fixture's pin `name` ("usdc" or "intents").
pub fn pin(name: &str) -> R<Pin> {
    let f: Value = serde_json::from_str(REAL_WASM)?;
    let p = &f["wasm"][name];
    let s = |k: &str| p[k].as_str().map(str::to_string).ok_or_else(|| format!("real-wasm.json: {name}.{k} is not a string"));
    Ok(Pin {
        env: s("env")?,
        account: s("account")?,
        bytes: p["bytes"].as_u64().ok_or_else(|| format!("real-wasm.json: {name}.bytes"))? as usize,
        sha256: s("sha256")?,
        code_hash: s("code_hash")?,
        source_rev: p["source_rev"].as_str().map(str::to_string),
    })
}

/// NEAR's code hash of `wasm`: base58 of its sha256.
pub fn code_hash(wasm: &[u8]) -> String {
    let d: [u8; 32] = near_sdk::env::sha256(wasm).try_into().expect("sha256 is 32 bytes");
    CryptoHash(d).to_string()
}

/// `wasm` is the pin: its size, its sha256, and base58(sha256) = the pin's code hash.
pub fn check_pin(p: &Pin, wasm: &[u8]) -> Result<(), String> {
    let (sha, hash) = (hex(&near_sdk::env::sha256(wasm)), code_hash(wasm));
    if wasm.len() != p.bytes || sha != p.sha256 || hash != p.code_hash {
        return Err(format!(
            "REFUSED: {} wasm is {} B sha256 {sha} (code hash {hash}); the pin is {} B sha256 {} (code hash {})",
            p.account, wasm.len(), p.bytes, p.sha256, p.code_hash
        ));
    }
    Ok(())
}

/// The pinned wasm `name`, read from the file its env var names and refused unless it is the pin.
pub fn pinned_wasm(name: &str) -> R<Vec<u8>> {
    let p = pin(name)?;
    let w = wasm_from_env(&p.env)?;
    check_pin(&p, &w)?;
    Ok(w)
}

pub struct Harness {
    pub worker: Worker<Sandbox>,
    pub root: Account,
    pub vault: AccountId,
    pub token: AccountId,
    pub vault_wasm: Vec<u8>,
    /// The real USDC's role accounts once `deploy_usdc` ran; `None` on the mock token.
    pub usdc: Option<UsdcRoles>,
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
            usdc: None,
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
        Self::with_vault_and(TokenKind::Mock).await
    }

    /// `start`, then the vault by the 2.8 recipe and `kind`'s token at TOKEN with the vault registered on it.
    pub async fn with_vault_and(kind: TokenKind) -> R<Self> {
        let mut h = Self::start().await?;
        let _ = h.deploy_vault().await?;
        match kind {
            TokenKind::Mock => h.deploy_mock_token().await?,
            TokenKind::Usdc => h.deploy_usdc().await?,
        }
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

    // ---- the real USDC and intents.near ----

    /// An account at `id` holding `near` N with one test key, put there by a state patch: the sandbox's only way to
    /// hold an id no test can create (a 64-hex implicit id whose key no one here holds, a `.near` name the sandbox's
    /// registrar cannot create). Only the account and its key are patched; its code and state come from transactions.
    pub async fn keyed_account(&self, id: &AccountId, near: u128) -> R<Account> {
        let sk = SecretKey::from_random(KeyType::ED25519);
        self.worker
            .patch(id)
            .account(AccountDetailsPatch::default().balance(NearToken::from_near(near)).storage_usage(182))
            .access_key(sk.public_key(), AccessKey::full_access())
            .transact()
            .await?;
        Ok(Account::from_secret_key(id.clone(), sk, &self.worker))
    }

    /// `id`'s code hash, read back at optimistic, is the pin `name`'s.
    pub async fn expect_code(&self, id: &AccountId, name: &str) -> R<()> {
        let got = self.account_view(id, "optimistic").await?["code_hash"].clone();
        let want = pin(name)?.code_hash;
        if got != json!(want) {
            return Err(format!("{id} code hash {got}, want the pin {want}").into());
        }
        println!("{id}: code hash {want} (the {name} pin)");
        Ok(())
    }

    /// The real USDC (the pinned wasm) at TOKEN, set up as mainnet's was (NearBlocks reads, research
    /// proofs/g1-vault-gas/sandbox/src/payouts.rs `setup_usdc`): the token account's own [DeployContract, FunctionCall
    /// init] (mainnet tx FEJRCgwWzY58dqG1WYiy1VAiVQZYvUMSQVkQ428t7V82) with a test account in every role, then two
    /// controllers for one minter and the minter's allowance, each by a multisig request, as mainnet's requests 0-4.
    pub async fn deploy_usdc(&mut self) -> R<()> {
        let mut made = vec![];
        for name in ["usdc-admin", "usdc-owner", "usdc-pauser1", "usdc-pauser2", "usdc-blocklister", "usdc-mm1", "usdc-mm2", "usdc-minter", "usdc-ctl1", "usdc-ctl2"] {
            made.push(self.account(name, 10).await?);
        }
        let mut a = made.into_iter();
        let mut next = || a.next().expect("ten role accounts");
        let roles = UsdcRoles {
            admin: next(),
            owner: next(),
            pausers: [next(), next()],
            blocklister: next(),
            master_minters: [next(), next()],
            minter: next(),
            controllers: [next(), next()],
        };
        let token = self.keyed_account(&self.token.clone(), 100).await?;
        self.init_usdc(&token, &roles).await?;
        self.usdc = Some(roles);
        Ok(())
    }

    /// The pinned USDC deployed and initialised by `token` itself with `roles` in its roles: its code hash read back as
    /// the pin, the minter allowed to mint, and its storage bounds read as TOKEN_STORAGE (vault.md 2.8).
    pub async fn init_usdc(&self, token: &Account, roles: &UsdcRoles) -> R<()> {
        let wasm = pinned_wasm("usdc")?;
        let init = json!({
            "admin_ids": [roles.admin.id()], "owner_ids": [roles.owner.id()],
            "pauser_ids": [roles.pausers[0].id(), roles.pausers[1].id()], "blocklister_id": roles.blocklister.id(),
            "master_minter_ids": [roles.master_minters[0].id(), roles.master_minters[1].id()],
            "metadata": {"spec": "ft-1.0.0", "name": "USD Coin", "symbol": "USDC", "icon": null, "reference": null,
                         "reference_hash": null, "decimals": 6},
        });
        let result =
            token.batch(token.id()).deploy(&wasm).call(Function::new("init").args_json(init).gas(Gas::from_tgas(300))).transact().await?;
        self.outcome(token.id(), result).await?.expect_all_ok("USDC deploy + init")?;
        self.expect_code(token.id(), "usdc").await?;
        for ctl in &roles.controllers {
            let action = json!({"ConfigureController": {"minter_id": roles.minter.id(), "controller_id": ctl.id()}});
            let _ = self.multisig(token.id(), &roles.master_minters, action).await?;
        }
        let action = json!({"ConfigureMinterAllowance": {"controller_id": roles.controllers[0].id(), "minter_allowance": "1000000000000000"}});
        let _ = self.multisig(token.id(), &roles.controllers, action).await?;
        let bounds = self.view(token.id(), "storage_balance_bounds", json!({})).await?;
        if bounds["min"] != json!(TOKEN_STORAGE.as_yoctonear().to_string()) {
            return Err(format!("{}: storage_balance_bounds {bounds}, want min {}", token.id(), TOKEN_STORAGE.as_yoctonear()).into());
        }
        Ok(())
    }

    /// One USDC multisig request on `token`: `by[0]` creates it, both approve, `by[1]` executes; the execute's outcome.
    pub async fn multisig(&self, token: &AccountId, by: &[Account; 2], action: Value) -> R<Outcome> {
        let (zero, gas) = (NearToken::from_yoctonear(0), Gas::from_tgas(100));
        let rid = self.view(token, "get_next_multisig_request_id", json!({})).await?;
        let _ = self.call(&by[0], token, "create_multisig_request", json!({"action": action}), zero, gas).await?;
        for a in by {
            let _ = self.call(a, token, "approve_multisig_request", json!({"request_id": rid}), zero, gas).await?;
        }
        self.call(&by[1], token, "execute_multisig_request", json!({"request_id": rid}), zero, gas).await
    }

    /// The real USDC's role accounts; an error on the mock token.
    pub fn usdc_roles(&self) -> R<&UsdcRoles> {
        self.usdc.as_ref().ok_or_else(|| "the real USDC is not deployed (with_vault_and(TokenKind::Usdc))".into())
    }

    /// USDC's own halt: `Pause` (`halt`) or `Unpause` by its two pausers' multisig; the execute must log the token's
    /// `paused` or `unpaused` event.
    pub async fn usdc_halt(&self, halt: bool) -> R<Outcome> {
        let roles = self.usdc_roles()?;
        let (action, event) = if halt { ("Pause", "\"event\":\"paused\"") } else { ("Unpause", "\"event\":\"unpaused\"") };
        let o = self.multisig(&self.token, &roles.pausers, json!(action)).await?;
        if !o.receipts.iter().flat_map(|r| &r.logs).any(|l| l.contains("x-fiat-token") && l.contains(event)) {
            let logs: Vec<&String> = o.receipts.iter().flat_map(|r| &r.logs).collect();
            return Err(format!("{action}: the execute logged no {event} event: {logs:?}").into());
        }
        Ok(o)
    }

    /// USDC's `mint {to, amount}` on `token` by `roles.minter`, `to` registered first (by root) when it is not.
    pub async fn usdc_mint(&self, token: &AccountId, roles: &UsdcRoles, to: &AccountId, amount: u128) -> R<()> {
        if self.view(token, "storage_balance_of", json!({"account_id": to})).await?.is_null() {
            let _ = self.storage_deposit_on(token, &self.root, to).await?;
        }
        let args = json!({"to": to, "amount": amount.to_string()});
        let _ = self.call(&roles.minter, token, "mint", args, NearToken::from_yoctonear(0), Gas::from_tgas(100)).await?;
        Ok(())
    }

    /// intents.near at DF (the pinned wasm) by its own [DeployContract, FunctionCall new]: fee 0, `intents-admin` as
    /// super admin and in its PauseManager and UnpauseManager roles. Its code hash is read back as the pin and its
    /// NEP-330 `contract_source_metadata` must name DF's commit. Returns the role account.
    pub async fn deploy_intents(&self) -> R<Account> {
        let id: AccountId = INTENTS.parse()?;
        let admin = self.account("intents-admin", 10).await?;
        let acct = self.keyed_account(&id, 100).await?;
        let wasm = pinned_wasm("intents")?;
        let config = json!({"config": {
            "wnear_id": "wrap.near",
            "fees": {"fee": 0, "fee_collector": admin.id()},
            "roles": {"super_admins": [admin.id()], "admins": {},
                      "grantees": {"PauseManager": [admin.id()], "UnpauseManager": [admin.id()]}},
        }});
        let result = acct.batch(&id).deploy(&wasm).call(Function::new("new").args_json(config).gas(Gas::from_tgas(300))).transact().await?;
        self.outcome(&id, result).await?.expect_all_ok("intents.near deploy + new")?;
        self.expect_code(&id, "intents").await?;
        let meta = self.view(&id, "contract_source_metadata", json!({})).await?;
        let rev = pin("intents")?.source_rev.ok_or("real-wasm.json: intents.source_rev")?;
        if meta["link"] != json!(format!("https://github.com/near/intents/tree/{rev}")) {
            return Err(format!("intents.near contract_source_metadata {meta} names no DF commit {rev}").into());
        }
        println!("intents.near: contract_source_metadata version {} link {}", meta["version"], meta["link"]);
        Ok(admin)
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

    /// A block's time in ms as the vault's `env::block_timestamp_ms()` reads it in that block: the header's
    /// `timestamp_nanosec` (a decimal string; the `timestamp` JSON number is past 2^53, where a JSON reader in JS
    /// rounds it) divided by 1,000,000 and rounded down (near-sdk 5.29.1 `env.rs` l.390-392).
    pub async fn block_ms(&self, block_hash: &str) -> R<u64> {
        let v = self.rpc("block", json!({"block_id": block_hash})).await?;
        let ns: u64 = v["result"]["header"]["timestamp_nanosec"].as_str().ok_or_else(|| format!("block {block_hash}: {v}"))?.parse()?;
        Ok(ns / 1_000_000)
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

    // ---- the token at TOKEN (mock or real USDC) ----

    /// `storage_deposit(account_id)` on the token by `payer`, with USDC's 0.00125 N; an error unless `all_ok()`.
    pub async fn storage_deposit(&self, payer: &Account, account: &AccountId) -> R<Outcome> {
        self.storage_deposit_on(&self.token, payer, account).await
    }

    /// `storage_deposit(account_id)` on `token` by `payer`, with USDC's 0.00125 N; an error unless `all_ok()`.
    pub async fn storage_deposit_on(&self, token: &AccountId, payer: &Account, account: &AccountId) -> R<Outcome> {
        let args = json!({"account_id": account, "registration_only": true});
        self.call(payer, token, "storage_deposit", args, TOKEN_STORAGE, Gas::from_tgas(10)).await
    }

    /// Makes the mock token fail (`fail = true`) or stop failing `method` ("ft_transfer", "ft_transfer_call" or
    /// "storage_deposit"), for calls touching `account` only, or for every call with `None`.
    pub async fn mock_fail(&self, method: &str, account: Option<&AccountId>, fail: bool) -> R<()> {
        if self.usdc.is_some() {
            return Err("mock_fail: the token is the real USDC, which fails only by its own roles (usdc_halt)".into());
        }
        let args = json!({"method": method, "account_id": account, "fail": fail});
        let _ = self.call(&self.root, &self.token, "set_fail", args, NearToken::from_yoctonear(0), Gas::from_tgas(10)).await?;
        Ok(())
    }

    /// Mints `amount` to `account` on the token at TOKEN: the mock's `mint`, or the real USDC's minter.
    pub async fn mint(&self, account: &AccountId, amount: u128) -> R<()> {
        if let Some(roles) = &self.usdc {
            return self.usdc_mint(&self.token, roles, account, amount).await;
        }
        let args = json!({"account_id": account, "amount": amount.to_string()});
        let _ = self.call(&self.root, &self.token, "mint", args, NearToken::from_yoctonear(0), Gas::from_tgas(10)).await?;
        Ok(())
    }

    pub async fn token_balance(&self, account: &AccountId) -> R<u128> {
        let v = self.view(&self.token, "ft_balance_of", json!({"account_id": account})).await?;
        Ok(v.as_str().ok_or("ft_balance_of: not a string")?.parse()?)
    }

    /// VT-S11 (vault.md 5; invariant I1, 4): the vault's token balance is at least `deposited - spent + returned`
    /// (`totals()`), and equal to it once no spend is `in_flight` (every `spends` page read). An error names the
    /// figures. Prints one line: `I1: balance <b> = deposited <d> - spent <s> + returned <r> (<k> in flight)`.
    pub async fn i1(&self) -> R<()> {
        let t = self.view(&self.vault, "totals", json!({})).await?;
        let n = |k: &str| -> R<u128> { Ok(t[k].as_str().ok_or_else(|| format!("totals: {t}"))?.parse()?) };
        let (deposited, spent, returned) = (n("deposited")?, n("spent")?, n("returned")?);
        let held = deposited.checked_add(returned).and_then(|x| x.checked_sub(spent)).ok_or_else(|| format!("I1: totals {t} sum below 0"))?;
        let (mut from, mut in_flight) = (0u64, 0usize);
        loop {
            let page = self.view(&self.vault, "spends", json!({"from": from, "limit": blindfill_vault::constants::PAGE_MAX})).await?;
            let rows = page.as_array().ok_or_else(|| format!("spends: {page}"))?;
            if rows.is_empty() {
                break;
            }
            in_flight += rows.iter().filter(|r| r["status"] == "in_flight").count();
            from += rows.len() as u64;
        }
        let balance = self.token_balance(&self.vault).await?;
        let line = format!("I1: balance {balance} {} deposited {deposited} - spent {spent} + returned {returned} ({in_flight} in flight)", if balance == held { "=" } else { "vs" });
        println!("{line}");
        if balance < held || (in_flight == 0 && balance != held) {
            return Err(format!("{line}: want balance >= the sum, and equal with nothing in flight").into());
        }
        Ok(())
    }

    // ---- NEP-366: a call signed by one account, sent and paid for by another ----

    /// The NEAR-implicit account (64 hex, its ed25519 public key) of a fresh random key, made as the kit's U is: by a
    /// plain Transfer of `millinear` from root, which gives it that one full-access key and no other (NC
    /// `runtime/src/lib.rs` l.549-550). Its key signs its `DelegateAction`s.
    pub async fn implicit_account(&self, millinear: u128) -> R<Account> {
        let sk = SecretKey::from_random(KeyType::ED25519);
        let pk = near_crypto::SecretKey::from_str(&sk.to_string()).map_err(|e| format!("key: {e}"))?.public_key();
        let id: AccountId = hex(pk.key_data()).parse()?;
        let r = self.root.transfer_near(&id, NearToken::from_millinear(millinear)).await?;
        if !r.is_success() {
            return Err(format!("the Transfer creating {id}: {r:?}").into());
        }
        let keys = self.access_keys(&id, "optimistic").await?;
        if keys.len() != 1 || keys[0]["public_key"] != json!(pk.to_string()) {
            return Err(format!("{id}: keys {keys:?}, want only {pk}").into());
        }
        Ok(Account::from_secret_key(id, sk, &self.worker))
    }

    /// The nonce of `id`'s access key `pk`, at optimistic.
    async fn key_nonce(&self, id: &AccountId, pk: &near_crypto::PublicKey) -> R<u64> {
        let q = json!({"request_type": "view_access_key", "finality": "optimistic", "account_id": id, "public_key": pk.to_string()});
        let v = self.rpc("query", q).await?;
        Ok(v["result"]["nonce"].as_u64().ok_or_else(|| format!("view_access_key {id}: {v}"))?)
    }

    /// `signer`'s own call `receiver.method(args)` with `deposit` yocto and `gas`, signed by `signer`'s key as a
    /// NEP-366 `DelegateAction` (valid for 100 blocks past the final head) and sent by `relayer` in its own
    /// transaction [Delegate] to `signer`, which the relayer pays for and cannot change (NEPs `nep-0366.md` l.35-90).
    /// Read as `call_outcome` reads a transaction: the raw `Outcome`, every receipt at `FINAL`, its gas recorded.
    pub async fn delegate_call(
        &self,
        relayer: &Account,
        signer: &Account,
        receiver: &AccountId,
        method: &str,
        args: Value,
        deposit: u128,
        gas: Gas,
    ) -> R<Outcome> {
        use near_primitives::action::delegate::{DelegateAction, NonDelegateAction, SignedDelegateAction};
        use near_primitives::action::{Action, FunctionCallAction};
        use near_primitives::transaction::{SignedTransaction, Transaction, TransactionV0};
        let key = |a: &Account| near_crypto::SecretKey::from_str(&a.secret_key().to_string()).map_err(|e| format!("key: {e}"));
        let (u_sk, r_sk) = (key(signer)?, key(relayer)?);
        let block = self.rpc("block", json!({"finality": "final"})).await?;
        let height = block["result"]["header"]["height"].as_u64().ok_or_else(|| format!("block: {block}"))?;
        let block_hash: near_primitives::hash::CryptoHash =
            block["result"]["header"]["hash"].as_str().ok_or_else(|| format!("block: {block}"))?.parse().map_err(|e| format!("block hash: {e}"))?;
        let call = Action::FunctionCall(Box::new(FunctionCallAction {
            method_name: method.into(),
            args: args.to_string().into_bytes(),
            gas: near_primitives::gas::Gas::from_gas(gas.as_gas()),
            deposit: near_primitives::types::Balance::from_yoctonear(deposit),
        }));
        let da = DelegateAction {
            sender_id: signer.id().clone(),
            receiver_id: receiver.clone(),
            actions: vec![NonDelegateAction::try_from(call).map_err(|e| format!("{e}"))?],
            nonce: self.key_nonce(signer.id(), &u_sk.public_key()).await? + 1,
            max_block_height: height + 100,
            public_key: u_sk.public_key(),
        };
        let sda = SignedDelegateAction::sign(&near_crypto::InMemorySigner::from_secret_key(signer.id().clone(), u_sk), da);
        let tx = Transaction::V0(TransactionV0 {
            signer_id: relayer.id().clone(),
            public_key: r_sk.public_key(),
            nonce: self.key_nonce(relayer.id(), &r_sk.public_key()).await? + 1,
            receiver_id: signer.id().clone(),
            block_hash,
            actions: vec![Action::Delegate(Box::new(sda))],
        });
        let (hash, _) = tx.get_hash_and_size();
        let r_signer = near_crypto::InMemorySigner::from_secret_key(relayer.id().clone(), r_sk);
        let signed = SignedTransaction::new(r_signer.sign(hash.as_ref()), tx);
        let b64 = serde_json::to_value(near_sdk::json_types::Base64VecU8(near_primitives::borsh::to_vec(&signed)?))?;
        let sent = self.rpc("send_tx", json!({"signed_tx_base64": b64, "wait_until": "FINAL"})).await?;
        if sent.get("error").is_some() {
            return Err(format!("send_tx (relayer {} carrying {}'s {method}): {sent}", relayer.id(), signer.id()).into());
        }
        self.outcome_of(relayer.id(), hash.to_string(), None).await
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
        self.outcome_of(signer, tx_hash, Some(result)).await
    }

    /// `outcome` for the transaction `tx_hash` signed by `signer`.
    async fn outcome_of(&self, signer: &AccountId, tx_hash: String, result: Option<ExecutionFinalResult>) -> R<Outcome> {
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
                args: actions.iter().filter_map(|a| a["FunctionCall"]["args"].as_str().map(str::to_string)).collect(),
                block_hash: ro["block_hash"].as_str().ok_or_else(|| format!("{tx_hash}: no block_hash in {ro}"))?.to_string(),
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
