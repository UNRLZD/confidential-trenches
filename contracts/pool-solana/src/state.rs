// SPDX-License-Identifier: Apache-2.0
//! The pool's accounts, all owned by this program and all at addresses derived from fixed seeds:
//!
//! | Account | Seeds | Holds |
//! |---|---|---|
//! | pool | `["pool"]` | the lamports every note holds, plus its own rent; `nonce`, `deposited`, `spent`; each tree's size, depth and 33 side nodes (`POOL_LEN` bytes) |
//! | page | `["page", tree, page_no u32 LE]` | up to `PAGE_ENTRIES` entries (leaf, root, time) of one tree, in insert order: entry `i` is leaf `page_no * PAGE_ENTRIES + i`, the tree's root right after it, and the cluster Clock's `unix_timestamp` (i64 LE) at that insert |
//! | spent mark | `["spent", nullifierHash]` | the release that spent the note (`SPENT_MARK_LEN` bytes): withdrawnValue u64 LE, then the release's number u32 LE (how many releases came before it), then `MARK_TAG` |
//! | precommitment mark | `["pre", precommitment]` | the deposit that used it (`PRE_MARK_LEN` bytes): value u64 LE, then its nonce u64 LE, the one its label hashes, then `MARK_TAG` |
//!
//! A page grows by one entry (72 bytes) per insert, its rent paid by the inserting transaction's payer; the insert
//! at a page's first entry creates it. Nothing is ever removed or closed: a closed spent mark would reopen the spend.
//!
//! The time in each entry lets any client tell, from the pages alone, which root was the newest at a given chain
//! time, so devices can prove against a shared root (the newest one before an epoch's start) instead of each
//! reading its own. The program itself never reads it: a release names any root the pool had, by index.

use crate::error::PoolError;
use crate::tree::Side;
use solana_program::{
    account_info::AccountInfo,
    clock::Clock,
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};

/// The system program's id (32 zero bytes).
pub const SYSTEM_PROGRAM: Pubkey = solana_program::pubkey!("11111111111111111111111111111111");

pub const POOL_SEED: &[u8] = b"pool";
/// The last byte of every mark, constant and not 0. Anyone can make a zero-filled account of a mark's size that this
/// program owns (the system program's CreateAccount or Assign takes any owner, and only the owner writes its data), so
/// a device that reads the marks by their counter (a getProgramAccounts memcmp from offset 9, the counter's bytes past
/// its low byte) would find every such account in its first bucket, and about 4,400 of them push that one answer past
/// an RPC's 1 MiB cap for good. The tag sits right after the counter, inside the bytes that memcmp compares, so a
/// zero-filled account matches no bucket however many a stranger makes; only this program writes a mark's data.
pub const MARK_TAG: u8 = 1;
/// A precommitment mark's data: the deposit's value u64 LE ‖ its nonce u64 LE ‖ `MARK_TAG`.
pub const PRE_MARK_LEN: usize = 17;
/// A spent mark's data: the release's withdrawnValue u64 LE (M355 (3)), so a restore from the 12 words knows each
/// spent note's change exactly from the marks alone; then the release's number u32 LE, the count of releases before it
/// (the state tree's size less the label tree's, before its change leaf goes in). Releases are numbered 0, 1, 2, ... with
/// no gap, as deposits are by their nonce 1, 2, 3, ..., so a restore reads the marks in buckets of consecutive numbers
/// (one memcmp on the number's bytes and the tag) and checks that a cut holds every one (M376); then `MARK_TAG`. 13
/// bytes, so a spent mark is told from a precommitment mark (17) by its size alone.
pub const SPENT_MARK_LEN: usize = 13;
pub const PAGE_SEED: &[u8] = b"page";
pub const SPENT_SEED: &[u8] = b"spent";
pub const PRE_SEED: &[u8] = b"pre";

pub const POOL_DISC: [u8; 8] = *b"bfpool01";
pub const PAGE_DISC: [u8; 8] = *b"bfpage01";

pub const TREE_STATE: u8 = 0;
pub const TREE_LABEL: u8 = 1;

/// One tree's part of the pool account: size u64 LE, depth u8, 33 side nodes.
const TREE_LEN: usize = 8 + 1 + 33 * 32;
const OFF_BUMP: usize = 8;
const OFF_NONCE: usize = 9;
const OFF_DEPOSITED: usize = 17;
const OFF_SPENT: usize = 33;
const OFF_TREES: usize = 49;
pub const POOL_LEN: usize = OFF_TREES + 2 * TREE_LEN;

pub const PAGE_HEADER: usize = 16;
/// One entry: leaf (32) ‖ root (32) ‖ unix_timestamp i64 LE (8).
pub const PAGE_ENTRY: usize = 72;
pub const PAGE_ENTRIES: u64 = 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreeState {
    pub size: u64,
    pub depth: u8,
    pub side: Side,
}

impl TreeState {
    pub const fn empty() -> Self {
        TreeState { size: 0, depth: 0, side: [[0; 32]; 33] }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pool {
    pub bump: u8,
    pub nonce: u64,
    /// every deposit's lamports, summed
    pub deposited: u128,
    /// every release's withdrawnValue, summed
    pub spent: u128,
    pub state: TreeState,
    pub label: TreeState,
}

fn read_tree(d: &[u8]) -> TreeState {
    let mut side = [[0u8; 32]; 33];
    for (i, s) in side.iter_mut().enumerate() {
        s.copy_from_slice(&d[9 + 32 * i..9 + 32 * i + 32]);
    }
    TreeState { size: u64::from_le_bytes(d[0..8].try_into().unwrap()), depth: d[8], side }
}

fn write_tree(t: &TreeState, d: &mut [u8]) {
    d[0..8].copy_from_slice(&t.size.to_le_bytes());
    d[8] = t.depth;
    for (i, s) in t.side.iter().enumerate() {
        d[9 + 32 * i..9 + 32 * i + 32].copy_from_slice(s);
    }
}

impl Pool {
    /// Reads the pool account: this program's, at `["pool", bump]`, with the pool's layout.
    /// On the heap: SBF gives each function a 4 KiB stack frame, and the pool is over 2 KiB.
    pub fn load(program_id: &Pubkey, acc: &AccountInfo) -> Result<Box<Pool>, ProgramError> {
        if acc.owner != program_id {
            return Err(PoolError::NotInitialized.into());
        }
        let d = acc.try_borrow_data()?;
        if d.len() != POOL_LEN || d[0..8] != POOL_DISC {
            return Err(PoolError::NotInitialized.into());
        }
        let bump = d[OFF_BUMP];
        let want = Pubkey::create_program_address(&[POOL_SEED, &[bump]], program_id)
            .map_err(|_| ProgramError::from(PoolError::NotInitialized))?;
        if want != *acc.key {
            return Err(PoolError::NotInitialized.into());
        }
        Ok(Box::new(Pool {
            bump,
            nonce: u64::from_le_bytes(d[OFF_NONCE..OFF_NONCE + 8].try_into().unwrap()),
            deposited: u128::from_le_bytes(d[OFF_DEPOSITED..OFF_DEPOSITED + 16].try_into().unwrap()),
            spent: u128::from_le_bytes(d[OFF_SPENT..OFF_SPENT + 16].try_into().unwrap()),
            state: read_tree(&d[OFF_TREES..OFF_TREES + TREE_LEN]),
            label: read_tree(&d[OFF_TREES + TREE_LEN..OFF_TREES + 2 * TREE_LEN]),
        }))
    }

    pub fn store(&self, acc: &AccountInfo) -> Result<(), ProgramError> {
        let mut d = acc.try_borrow_mut_data()?;
        d[0..8].copy_from_slice(&POOL_DISC);
        d[OFF_BUMP] = self.bump;
        d[OFF_NONCE..OFF_NONCE + 8].copy_from_slice(&self.nonce.to_le_bytes());
        d[OFF_DEPOSITED..OFF_DEPOSITED + 16].copy_from_slice(&self.deposited.to_le_bytes());
        d[OFF_SPENT..OFF_SPENT + 16].copy_from_slice(&self.spent.to_le_bytes());
        write_tree(&self.state, &mut d[OFF_TREES..OFF_TREES + TREE_LEN]);
        write_tree(&self.label, &mut d[OFF_TREES + TREE_LEN..OFF_TREES + 2 * TREE_LEN]);
        Ok(())
    }
}

fn system_ix(accounts: Vec<AccountMeta>, data: Vec<u8>) -> Instruction {
    Instruction { program_id: SYSTEM_PROGRAM, accounts, data }
}

/// The system program's `Transfer` (tag 2): `lamports` from `from` (a signer the system program owns) to `to`.
pub fn transfer<'a>(from: &AccountInfo<'a>, to: &AccountInfo<'a>, system: &AccountInfo<'a>, lamports: u64) -> Result<(), ProgramError> {
    let mut data = 2u32.to_le_bytes().to_vec();
    data.extend_from_slice(&lamports.to_le_bytes());
    invoke(
        &system_ix(vec![AccountMeta::new(*from.key, true), AccountMeta::new(*to.key, false)], data),
        &[from.clone(), to.clone(), system.clone()],
    )
}

/// The system program account, checked.
pub fn check_system(acc: &AccountInfo) -> Result<(), ProgramError> {
    if *acc.key != SYSTEM_PROGRAM {
        return Err(PoolError::WrongAccount.into());
    }
    Ok(())
}

/// Creates the program-owned account `target` of `space` bytes at the address `seeds` (with its bump) derive, its rent
/// paid by `payer`. A target that already holds lamports (anyone can send lamports to an address) is topped up,
/// allocated and assigned instead, so no one can block an address by funding it first. A target this program already
/// owns is refused with `exists`.
pub fn create_pda<'a>(
    program_id: &Pubkey,
    payer: &AccountInfo<'a>,
    target: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    seeds: &[&[u8]],
    space: usize,
    exists: PoolError,
) -> Result<(), ProgramError> {
    if target.owner == program_id {
        return Err(exists.into());
    }
    let rent = Rent::get()?.minimum_balance(space);
    let have = target.lamports();
    if have == 0 {
        let mut data = 0u32.to_le_bytes().to_vec();
        data.extend_from_slice(&rent.to_le_bytes());
        data.extend_from_slice(&(space as u64).to_le_bytes());
        data.extend_from_slice(program_id.as_ref());
        invoke_signed(
            &system_ix(vec![AccountMeta::new(*payer.key, true), AccountMeta::new(*target.key, true)], data),
            &[payer.clone(), target.clone(), system.clone()],
            &[seeds],
        )
    } else {
        if rent > have {
            transfer(payer, target, system, rent - have)?;
        }
        let mut data = 8u32.to_le_bytes().to_vec();
        data.extend_from_slice(&(space as u64).to_le_bytes());
        invoke_signed(&system_ix(vec![AccountMeta::new(*target.key, true)], data), &[target.clone(), system.clone()], &[seeds])?;
        let mut data = 1u32.to_le_bytes().to_vec();
        data.extend_from_slice(program_id.as_ref());
        invoke_signed(&system_ix(vec![AccountMeta::new(*target.key, true)], data), &[target.clone(), system.clone()], &[seeds])
    }
}

/// A mark: the program-owned account of `space` bytes at `[seed, key]`, zeroed, for its maker to fill (the
/// precommitment mark's record, `PRE_MARK_LEN`; the spent mark's, `SPENT_MARK_LEN`). Refuses an account that is not
/// that address (`WrongAccount`) and a mark that exists (`exists`).
#[allow(clippy::too_many_arguments)]
pub fn put_mark_of<'a>(
    program_id: &Pubkey,
    payer: &AccountInfo<'a>,
    mark: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    seed: &[u8],
    key: &[u8; 32],
    space: usize,
    exists: PoolError,
) -> Result<(), ProgramError> {
    // the canonical bump only: another bump would give the same key a second address
    let (addr, bump) = Pubkey::find_program_address(&[seed, key], program_id);
    if addr != *mark.key {
        return Err(PoolError::WrongAccount.into());
    }
    create_pda(program_id, payer, mark, system, &[seed, key, &[bump]], space, exists)
}

/// Reads the page header: this program's, a page of `tree` numbered `page_no`. Returns its entry count.
fn page_entries(program_id: &Pubkey, page: &AccountInfo, tree: u8, page_no: u32) -> Option<u64> {
    if page.owner != program_id {
        return None;
    }
    let d = page.try_borrow_data().ok()?;
    if d.len() < PAGE_HEADER || d[0..8] != PAGE_DISC || d[8] != tree || d[9..13] != page_no.to_le_bytes() {
        return None;
    }
    let body = d.len() - PAGE_HEADER;
    if body % PAGE_ENTRY != 0 {
        return None;
    }
    Some((body / PAGE_ENTRY) as u64)
}

/// The root `tree` had right after leaf `index` went in, read from its page; None when the tree has no such index
/// (`index >= size`) or `page` is not the page holding it.
pub fn root_at(program_id: &Pubkey, page: &AccountInfo, tree: u8, size: u64, index: u64) -> Option<[u8; 32]> {
    if index >= size {
        return None;
    }
    let page_no = u32::try_from(index / PAGE_ENTRIES).ok()?;
    let slot = index % PAGE_ENTRIES;
    if page_entries(program_id, page, tree, page_no)? <= slot {
        return None;
    }
    let d = page.try_borrow_data().ok()?;
    let at = PAGE_HEADER + slot as usize * PAGE_ENTRY + 32;
    let root: [u8; 32] = d[at..at + 32].try_into().ok()?;
    // 0 is never a root (a leaf is never 0, and Poseidon of field elements hitting 0 is not a case to accept)
    if root == [0; 32] {
        return None;
    }
    Some(root)
}

/// Writes entry `index` (the leaf, the root after it and the Clock's unix_timestamp now) into `page`, creating the
/// page at its first entry and growing it by one entry otherwise; the rent comes from `payer`. Refuses a page that
/// is not `index`'s, or not at its end (`WrongAccount`).
pub fn push_entry<'a>(
    program_id: &Pubkey,
    payer: &AccountInfo<'a>,
    page: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    tree: u8,
    index: u64,
    leaf: &[u8; 32],
    root: &[u8; 32],
) -> Result<(), ProgramError> {
    let now = Clock::get()?.unix_timestamp;
    let page_no = u32::try_from(index / PAGE_ENTRIES).map_err(|_| ProgramError::from(PoolError::MaxTreeDepthReached))?;
    let slot = index % PAGE_ENTRIES;
    let new_len = PAGE_HEADER + (slot as usize + 1) * PAGE_ENTRY;
    if slot == 0 {
        let no = page_no.to_le_bytes();
        let (addr, bump) = Pubkey::find_program_address(&[PAGE_SEED, &[tree], &no], program_id);
        if addr != *page.key {
            return Err(PoolError::WrongAccount.into());
        }
        create_pda(program_id, payer, page, system, &[PAGE_SEED, &[tree], &no, &[bump]], new_len, PoolError::WrongAccount)?;
        let mut d = page.try_borrow_mut_data()?;
        d[0..8].copy_from_slice(&PAGE_DISC);
        d[8] = tree;
        d[9..13].copy_from_slice(&no);
    } else {
        if page_entries(program_id, page, tree, page_no) != Some(slot) {
            return Err(PoolError::WrongAccount.into());
        }
        page.resize(new_len)?;
        let need = Rent::get()?.minimum_balance(new_len).saturating_sub(page.lamports());
        if need > 0 {
            transfer(payer, page, system, need)?;
        }
    }
    let mut d = page.try_borrow_mut_data()?;
    let at = PAGE_HEADER + slot as usize * PAGE_ENTRY;
    d[at..at + 32].copy_from_slice(leaf);
    d[at + 32..at + 64].copy_from_slice(root);
    d[at + 64..at + 72].copy_from_slice(&now.to_le_bytes());
    Ok(())
}
