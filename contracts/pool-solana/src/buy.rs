// SPDX-License-Identifier: Apache-2.0
//! `release_and_buy` (tag 3): tag 2's release, then the instructions W signed for (a venue's buy), run by this program
//! with `invoke` and W's signer privilege only. One top-level instruction, so the venue's program and accounts load
//! from a lookup table (a v0 message cannot invoke a program it loads from one at the top level).
//!
//! Data (the layout card sol-pool-buy-tx wrote in TAG3.md; integers little-endian):
//! `3 ‖ flags u8 ‖ proof (256 raw, or 128 compressed) ‖ tag 2's FIELDS_LEN field bytes ‖ tip u64 ‖ inner count u8
//! (1 to 8) ‖ per inner instruction: program u8 ‖ n u8 ‖ n account indexes u8 ‖ data length u16 ‖ data`, ending
//! exactly after the last one. Flags: bit 0 set = the proof is the alt_bn128 compressed forms of A (32), B (64) and
//! C (32); every other bit must be 0. Every index is into this instruction's accounts.
//!
//! Accounts: tag 2's eight (src/release.rs), then the tip account when `tip > 0`, then every account and program the
//! inner instructions name.
//!
//! Refusals, all before the first write:
//! - Data: a flag bit other than bit 0, an inner count of 0 or over 8, an index past the accounts, a length that does
//!   not end exactly (`InvalidInstructionData`); a compressed point that is not on its curve (`InvalidProofEncoding`).
//! - An inner program that is this program (`InnerInvokesPool`): the runtime allows a program to call itself, so
//!   this is the one re-entry it does not stop; a venue calling back into the pool is refused by the runtime
//!   (`ReentrancyNotAllowed`).
//! - An inner account, or the tip account, that is the pool, its spent mark or a page this release reads or writes,
//!   or any account this program owns (`InnerNamesPoolAccount`). A callee can never debit an account it does not own,
//!   so this keeps the pool's accounts out of every call: its lamports never ride one.
//! - An inner account that signed this instruction and is not W (`InnerSignerNotW`): the fee payer's signature never
//!   reaches a venue, so a venue cannot debit the relayer.
//! - Then rows 1 to 13 of tag 2 on the same field bytes (src/release.rs `settle`), with the tip: at most the tip cap
//!   the proof binds (`TipOverCap`), and `relay_fee + tip` at most withdrawnValue (`InvalidWithdrawalAmount`).
//!
//! Then one system transfer of 0 lamports from W to the pool, naming the fee payer and the tip account too, so the
//! runtime sees the balances the release moved before any venue runs (`show_balances`). Then each inner instruction
//! runs in order with `invoke`, never `invoke_signed`: the callee gets each account with this instruction's writable
//! flag and a signer flag only on W. A failing one fails the transaction, the release and its spent mark with it. W's signature covers every byte and account, so a relayer cannot change, add or reorder
//! an inner instruction or point the tip elsewhere; the device builds and checks them before W signs.

use crate::error::PoolError;
use crate::release::{settle, Release, FIELDS_LEN};
use crate::verifier::PROOF_LEN;
use solana_bn254::compression::prelude::{alt_bn128_g1_decompress_be, alt_bn128_g2_decompress_be};
use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::invoke,
    program_error::ProgramError,
    pubkey::Pubkey,
};

pub const FLAG_COMPRESSED: u8 = 1;
pub const COMPRESSED_PROOF_LEN: usize = 128;
pub const MAX_INNER: usize = 8;
/// Tag 2's accounts, before the tip account.
const RELEASE_ACCOUNTS: usize = 8;

/// One inner instruction, as the data names it.
struct Inner<'d> {
    program: usize,
    accounts: &'d [u8],
    data: &'d [u8],
}

/// The raw proof from its compressed form: A (32) to 64 bytes, B (64) to 128, C (32) to 64, big-endian as tag 2's.
pub fn decompress_proof(c: &[u8]) -> Result<[u8; PROOF_LEN], PoolError> {
    let bad = |_| PoolError::InvalidProofEncoding;
    let a = alt_bn128_g1_decompress_be(c[0..32].try_into().unwrap()).map_err(bad)?;
    let b = alt_bn128_g2_decompress_be(c[32..96].try_into().unwrap()).map_err(bad)?;
    let cc = alt_bn128_g1_decompress_be(c[96..128].try_into().unwrap()).map_err(bad)?;
    let mut p = [0u8; PROOF_LEN];
    p[0..64].copy_from_slice(&a);
    p[64..192].copy_from_slice(&b);
    p[192..256].copy_from_slice(&cc);
    Ok(p)
}

/// Reads the inner instructions from `d` (after the inner count), each index below `n_accounts`; `d` must end exactly.
fn parse_inner(mut d: &[u8], count: usize, n_accounts: usize) -> Result<Vec<Inner<'_>>, PoolError> {
    let bad = PoolError::InvalidInstructionData;
    if count == 0 || count > MAX_INNER {
        return Err(bad);
    }
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let [program, n, rest @ ..] = d else { return Err(bad) };
        let n = *n as usize;
        if rest.len() < n + 2 {
            return Err(bad);
        }
        let (accounts, rest) = rest.split_at(n);
        let len = u16::from_le_bytes([rest[0], rest[1]]) as usize;
        let rest = &rest[2..];
        if rest.len() < len {
            return Err(bad);
        }
        if *program as usize >= n_accounts || accounts.iter().any(|&i| i as usize >= n_accounts) {
            return Err(bad);
        }
        out.push(Inner { program: *program as usize, accounts, data: &rest[..len] });
        d = &rest[len..];
    }
    if !d.is_empty() {
        return Err(bad);
    }
    Ok(out)
}

/// The pool, its spent mark and the pages this release names (tag 2's accounts 0 and 3 to 6), or anything this
/// program owns.
fn is_pool_account(program_id: &Pubkey, accounts: &[AccountInfo], a: &AccountInfo) -> bool {
    a.owner == program_id || [0, 3, 4, 5, 6].iter().any(|&i| accounts[i].key == a.key)
}

/// The runtime refuses a CPI unless the lamports it has seen still sum to what they were (agave 4.3
/// `TransactionContext::push`, `UnbalancedInstruction`), and it sees this program's own lamport moves only on the
/// accounts a CPI names. So before any venue runs, one system transfer of 0 lamports from W to the pool, with the fee
/// payer and the tip account after its two accounts (the system program reads the first two and allows more), shows
/// it every balance the release moved. The system program moves nothing and cannot debit the pool, which it does not
/// own; no venue ever gets the pool or the fee payer.
fn show_balances<'a>(
    w: &AccountInfo<'a>,
    pool: &AccountInfo<'a>,
    fee_payer: &AccountInfo<'a>,
    tip_to: Option<&AccountInfo<'a>>,
    system: &AccountInfo<'a>,
) -> ProgramResult {
    let mut metas = vec![AccountMeta::new(*w.key, true), AccountMeta::new(*pool.key, false), AccountMeta::new(*fee_payer.key, false)];
    let mut infos = vec![w.clone(), pool.clone(), fee_payer.clone(), system.clone()];
    if let Some(t) = tip_to {
        metas.push(AccountMeta::new(*t.key, false));
        infos.push(t.clone());
    }
    let mut data = vec![2, 0, 0, 0]; // SystemInstruction::Transfer
    data.extend_from_slice(&0u64.to_le_bytes());
    invoke(&Instruction { program_id: *system.key, accounts: metas, data }, &infos)
}

pub fn release_and_buy(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if accounts.len() < RELEASE_ACCOUNTS {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let bad = PoolError::InvalidInstructionData;
    let flags = *data.get(1).ok_or(bad)?;
    if flags & !FLAG_COMPRESSED != 0 {
        return Err(bad.into());
    }
    let proof_len = if flags & FLAG_COMPRESSED != 0 { COMPRESSED_PROOF_LEN } else { PROOF_LEN };
    let fields_at = 2 + proof_len;
    let tip_at = fields_at + FIELDS_LEN;
    if data.len() < tip_at + 9 {
        return Err(bad.into());
    }
    let tip = u64::from_le_bytes(data[tip_at..tip_at + 8].try_into().unwrap());
    let tip_to = if tip > 0 { Some(accounts.get(RELEASE_ACCOUNTS).ok_or(ProgramError::NotEnoughAccountKeys)?) } else { None };
    let inner = parse_inner(&data[tip_at + 9..], data[tip_at + 8] as usize, accounts.len())?;
    let recipient = &accounts[1];
    if let Some(t) = tip_to {
        if is_pool_account(program_id, accounts, t) {
            return Err(PoolError::InnerNamesPoolAccount.into());
        }
    }
    for x in &inner {
        if accounts[x.program].key == program_id {
            return Err(PoolError::InnerInvokesPool.into());
        }
        for &i in x.accounts {
            let a = &accounts[i as usize];
            if is_pool_account(program_id, accounts, a) {
                return Err(PoolError::InnerNamesPoolAccount.into());
            }
            if a.is_signer && a.key != recipient.key {
                return Err(PoolError::InnerSignerNotW.into());
            }
        }
    }
    let proof: [u8; PROOF_LEN] = if proof_len == COMPRESSED_PROOF_LEN {
        decompress_proof(&data[2..fields_at])?
    } else {
        data[2..fields_at].try_into().unwrap()
    };
    let r = Release::of(proof, &data[fields_at..tip_at]);
    settle(program_id, accounts, &r, tip, tip_to)?;
    show_balances(&accounts[1], &accounts[0], &accounts[2], tip_to, &accounts[7])?;
    for x in &inner {
        let program = &accounts[x.program];
        let mut metas = Vec::with_capacity(x.accounts.len());
        let mut infos = Vec::with_capacity(x.accounts.len() + 1);
        for &i in x.accounts {
            let a = &accounts[i as usize];
            // W signs wherever an inner instruction names it, whatever flag that instruction asked for: W's one
            // signature covers every inner instruction, so the device must rebuild and check each one before W signs.
            metas.push(AccountMeta { pubkey: *a.key, is_signer: a.key == recipient.key, is_writable: a.is_writable });
            infos.push(a.clone());
        }
        infos.push(program.clone());
        invoke(&Instruction { program_id: *program.key, accounts: metas, data: x.data.to_vec() }, &infos)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_bn254::compression::prelude::{alt_bn128_g1_compress_be, alt_bn128_g2_compress_be};

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    /// Every fixture proof, compressed with the alt_bn128 `_be` forms, decompresses to its raw bytes.
    #[test]
    fn a_compressed_fixture_proof_decompresses_to_its_raw_bytes() {
        let f: serde_json::Value = serde_json::from_str(include_str!("../fixtures/release-spends.json")).unwrap();
        for s in f["spends"].as_array().unwrap() {
            let raw = unhex(s["proof"].as_str().unwrap());
            let mut c = Vec::new();
            c.extend_from_slice(&alt_bn128_g1_compress_be(raw[0..64].try_into().unwrap()).unwrap());
            c.extend_from_slice(&alt_bn128_g2_compress_be(raw[64..192].try_into().unwrap()).unwrap());
            c.extend_from_slice(&alt_bn128_g1_compress_be(raw[192..256].try_into().unwrap()).unwrap());
            assert_eq!(c.len(), COMPRESSED_PROOF_LEN);
            assert_eq!(decompress_proof(&c).unwrap().to_vec(), raw, "{}", s["name"]);
        }
    }

    #[test]
    fn inner_instructions_parse_exactly() {
        // program 9, accounts [1, 10], data [7, 8]; then program 9, no accounts, no data
        let d = [9u8, 2, 1, 10, 2, 0, 7, 8, 9, 0, 0, 0];
        let v = parse_inner(&d, 2, 11).unwrap();
        assert_eq!((v[0].program, v[0].accounts, v[0].data), (9, &[1u8, 10][..], &[7u8, 8][..]));
        assert_eq!((v[1].program, v[1].accounts.len(), v[1].data.len()), (9, 0, 0));
        assert!(matches!(parse_inner(&d, 2, 10), Err(PoolError::InvalidInstructionData)), "an index past the accounts");
        assert!(parse_inner(&d, 1, 11).is_err(), "bytes after the last");
        assert!(parse_inner(&d[..11], 2, 11).is_err(), "short data");
        assert!(parse_inner(&[], 0, 11).is_err(), "no inner instruction");
        let nine: Vec<u8> = (0..9).flat_map(|_| [9u8, 0, 0, 0]).collect();
        assert!(parse_inner(&nine, 9, 11).is_err(), "nine");
        assert!(parse_inner(&nine[..32], 8, 11).is_ok(), "eight");
    }
}
