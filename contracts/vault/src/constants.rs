// SPDX-License-Identifier: Apache-2.0
//! The vault's constants (vault.md 2.2). They are compiled in; the vault has no setter, so none can change.
//! Ported from Privacy Pools v1.3.0 `packages/contracts/src/contracts/State.sol` (MAX_TREE_DEPTH) and
//! `Entrypoint.sol` (minimumDepositAmount, maxRelayFeeBPS, here constants), Copyright 2025 0XBOW LTD, Apache-2.0.

/// One vault per token. Mainnet: Circle's native USDC on NEAR (Circle's USDC contract address page).
#[cfg(not(feature = "testnet"))]
pub const TOKEN: &str = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
/// Testnet: Circle's testnet USDC on NEAR (Circle's USDC contract address page, read 2026-11-01; its `ft_metadata`
/// on NEAR testnet answers symbol USDC at block 275,674,154).
#[cfg(feature = "testnet")]
pub const TOKEN: &str = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";

/// The network this build names, written into `config().version`.
#[cfg(not(feature = "testnet"))]
pub const NETWORK: &str = "mainnet";
#[cfg(feature = "testnet")]
pub const NETWORK: &str = "testnet";

/// PP `State.sol:37`; the withdraw circuit is built at depth 32.
pub const MAX_TREE_DEPTH: u8 = 32;
/// 1 USDC in the token's base units (6 decimals); PP's `minimumDepositAmount` as a constant.
pub const MIN_DEPOSIT: u128 = 1_000_000;
/// The backstop `relay_fee * 10,000 <= withdrawn * MAX_RELAY_FEE_BPS`; the device's own fee bound is the real one.
pub const MAX_RELAY_FEE_BPS: u16 = 5_000;
/// Rows per view call.
pub const PAGE_MAX: u64 = 1_000;
/// Refused as a recipient or fee recipient: a plain `ft_transfer` to it credits no one. Compared, never called.
/// NEAR Intents has no testnet deployment of its verifier (docs.near-intents.org, verifier contract introduction), so
/// both builds name the mainnet account.
pub const INTENTS: &str = "intents.near";
/// Static gas per `ft_transfer`, intents.near's minimum and default for the same call.
pub const GAS_FT_TRANSFER_TGAS: u64 = 15;
/// intents.near's `STORAGE_DEPOSIT_GAS`.
pub const GAS_STORAGE_DEPOSIT_TGAS: u64 = 10;
/// The `on_payout` callback's static gas.
pub const GAS_ON_PAYOUT_TGAS: u64 = 30;
/// What a deposit writes when no tree grows a level; the minimum `storage_prepay`.
pub const DEPOSIT_STORAGE_BYTES: u64 = 756;
/// What a refund note writes when no tree grows a level; reserved by every withdrawal and ragequit.
pub const REFUND_RESERVE_BYTES: u64 = 389;
/// The tag every scope hashes.
pub const SCOPE_TAG: &str = "blindfill-vault-v1";
