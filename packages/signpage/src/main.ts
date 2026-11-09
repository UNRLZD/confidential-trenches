// SIGN_HOST's sign-in screen, top-level (docs/plan1/wallet.md §2.2 :47-56 and "Storage and unlock" :151-160 at research
// ffcba5e). Card wallet-passkey-prf: the passkey with PRF way in.
//
// - On open the page reads its own store first (wallet.md:50): with a seed there it is signed in, with no passkey sheet
//   (wallet.md:155); with none it offers the passkey ways in.
// - Sign-in and sign-out run top-level only (wallet.md:921-922). In a frame (APP_HOST may frame this page) it shows
//   neither control and both steps refuse, so a framing page cannot get a click on them. In the frame the page speaks
//   the postMessage API (src/api.ts, card signpage-postmessage), started below, with the state the store holds
//   (src/state.ts, card signpage-frame-state): signed in, words saved, the way in and the ops, posted again on each change.
//   The frame never opens the seed record and opens the store read-only: it reads the seed's key and the status record
//   meta/"status" { v, source, code_saved }, which the store writes in the seed's own transaction. A database from
//   before the status record gets it on the next top-level load (syncStatus, below).
// - Create passkey / Use passkey run the ceremony (@blindfill/wallet/signin/passkey). A PRF result becomes the seed's
//   entropy, written by the store's insertSeed only if no seed is stored (two tabs never write one over the other); the
//   record is 06b:459's { v, entropy, source: "prf", code_saved: false, created_ms } (ses.2, ses.7, 06b:776, :781), so
//   the Backup dot shows (data-code-saved="false"). A no-PRF gate keys on source, never on code_saved.
// - A seed already stored is never replaced and no ceremony runs (wallet.md:919: sign out first).
// - The no-PRF path and the typed words (card wallet-typed-words, @blindfill/wallet/signin/words; wallet.md:48-49, W:914;
//   06b ses.4, ses.5, ses.8, ses.10-12). Create passkey with a passkey that has no PRF makes a random seed { source:
//   "random", code_saved: false } (ses.4) and goes on, in the same top-level visit, to the backup screen
//   (data-signin="backup"): the 12 words, Copy and Saved. Saved sets code_saved (ses.5); leaving without it keeps the
//   Backup dot, and the signed-in screen then offers Backup again. Use passkey with a passkey that has no PRF makes
//   nothing (ses.8) and offers the 12 words. Recovery code takes typed words: the BIP-39 checksum is checked on the
//   device first, a failure shows "Invalid code" (CN-41) and stores nothing, and good words store { source: "code",
//   code_saved: true } (ses.12). Words are drawn and typed on the top-level page only, never in a frame (W:914).
// - Sign out deletes the store (wallet.md:156); another tab's sign out shows signed-out here too. It is not drawn, and the
//   store refuses it, while the 12 words are the only copy and not saved (backupFirst: source not "prf" and code_saved
//   false; wallet.md:922). Its activation guard is Chromium's own rule for its permission and payment sheets (./guard.ts):
//   a press is ignored when it is a repeated key, when it comes within 500 ms of the window's previous pointerdown or
//   keydown, or within 500 ms of Sign out being drawn, the page becoming visible (visibilitychange, pageshow) or the
//   window gaining focus; the same for mouse, touch, pen and keyboard. A click that a cross-site page lined up before
//   sending this window here (a double-click trick, a burst of clicks, a held Enter) does nothing; a press after a
//   500 ms pause works on every input. It guards every control that acts with no sheet of the browser's own (GUARDED):
//   Sign out; the backup's Saved, which opens the deposit gate of a seed whose 12 words are the only copy (W:888), so a
//   lined-up click cannot mark words saved that the user never saw; Backup, which draws the 12 words; and Copy, which
//   puts them on the clipboard, so a lined-up burst cannot draw the words and copy them for a paste the page asks for.
//   Create passkey and Use passkey open the browser's own passkey sheet, which carries the browser's protection.
// - The page shows public values only, but for the backup screen's 12 words: the account's profile key T_0 (wallet.md:68,
//   a public key, never a NEAR account or money), in data-account, so a check can compare it. The entropy and seed64
//   are zeroed once used; the 12 words are a JS string, which cannot be zeroed, and reach the DOM only on the backup
//   screen, top-level, and leave it only by the user's own tap on Copy (W:914).
// - Top-level, the page is the shell (src/shell.ts, card signpage-shell): it frames APP_HOST with this URL's path and
//   query and answers the kit's API to that frame alone, with the state src/state.ts reads from this document's own
//   store (the read-only reader: the state needs the seed's key, the status record and the ops, never the seed, and
//   it makes no database before a sign-in). These screens draw in the shell's layer over the frame, hidden in every
//   state until the app sends signin.open (signed out: the passkey or the words screen), and closed again on signed in
//   or Cancel, so the terminal shows signed out too. While the layer shows, the frame is out of the document (src/shell.ts).
//   Card signpage-signin-kinds adds the account's other open kinds (src/pages/open.ts decides which page each draws):
//   signout (the backup first while the 12 words are the only copy, then Sign out, which closes the layer back to the
//   app signed out), backup.open (the 12 words, then Saved or Cancel back to the app) and signin.open's wallet way (the
//   store read first, then the two choices before the wallet is asked anything; I already have one draws Use passkey
//   and Recovery code). Each opens the layer through openLayer(), which resets the activation guard (guard.shown()).
//   Card signpage-withdraw-form adds withdraw.open: with a seed stored it draws the withdraw form (src/withdraw/), where
//   the user types the address and the amount, refused before any proof when bad; a withdraw.open with a one-time id
//   draws the held deposit's way out (src/withdraw/held.ts, card held-deposit-way-out) for the held op of that id in
//   this page's own store, and a move a reload cut short is resumed at sign-in, its same signed bytes. Withdraw is guarded like Sign out; its note value, fee and hand-off are the
//   build's network's (src/withdraw/handoff.ts, card signpage-withdraw-handoff), drawn not offered where that network
//   names no vault or relayer. export.open stays refused until its card.
// - DOM by createElement and textContent only: the page's CSP requires Trusted Types for every script sink.
import { entropyToWords, profileKey, wordsToSeed64 } from "@blindfill/wallet/derive";
import { createPasskey, getPasskey, type PasskeyOutcome } from "@blindfill/wallet/signin/passkey";
import { backupFirst, openWalletStore, openWalletStoreReader, SeedChanged, WALLET_CHANNEL, WALLET_SEED_LOCK, walletSeedMoved, type WalletEvent, type WalletStore } from "@blindfill/wallet/store";
import { backupWords, checkSeed, saveWords, signInNoPrf, signInPrf, signInTyped, WordsRefused, type Landing, type Seed } from "@blindfill/wallet/signin/words";
import { activationGuard, type Press } from "./guard.ts";
import { startApi, type KindContext } from "./api.ts";
import { depositQuoteHost, depositReadHosts } from "./deposit-wire.ts";
import { depositNamer } from "./deposit-name.ts";
import { poolAddressHost } from "./pool-deposit-address.ts";
import { depositFollows, FOLLOW_LOCK } from "./deposit-follow.ts";
import { depositToEnd, poolFollows, poolRefundMover, solanaPoolFollowDeps, type PoolFollowHost } from "./pool-deposit-follow.ts";
import { POOL_ADDRESS_ASSET, readSolanaPoolFloor, type PoolQuotePricing } from "./pool-deposit-address.ts";
import { followRpc, readMoveAt } from "../../wallet/src/deposit/follow.ts";
import { NEAR_NETWORKS } from "../../wallet/src/deposit/account.ts";
import { ONECLICK_USDC_ASSETS } from "../../kit/src/checks/oneclick.ts";
import { POOL_ASSET_DECIMALS } from "../../kit/src/signpage/messages.ts";
import { PAGE_POOLS, rentOnce, withPools, withSolanaRent } from "./pools.ts";
import { poolPrices } from "./pool-price.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { readSolanaRent } from "../../kit/src/trade/solana/pool-buy.ts";
import { openNoteStore, readNotes, type NoteRecord, type NoteStore } from "../../wallet/src/notes/store.ts";
import { frameState } from "./state.ts";
import { withVaultBalance } from "./vault-balance.ts";
import { mountShell, type Shell } from "./shell.ts";
import { drawBackdrop } from "./backdrop.ts";
import { afterSaved, pageFor, takes, takesParams, type AccountKind } from "./pages/open.ts";
import { vaultScope } from "./withdraw/checks.ts";
import { drawWithdrawForm } from "./withdraw/form.ts";
import { drawHeldMoveOut, type HeldDeps } from "./withdraw/held.ts";
import { archivalRpc, heldOpOf, moveOutHeld, moveOutRpc } from "../../wallet/src/deposit/moveout.ts";
import type { DepositOp } from "../../wallet/src/deposit/follow.ts";
import { PAGE_NETWORK, withdrawFormDeps, withdrawSettle } from "./withdraw/handoff.ts";
import { proverHost } from "./prover-host.ts";
import { drawPoolWithdrawForm } from "./withdraw/pool-form.ts";
import { releaseTradeDeps, tradeKind } from "./trade.ts";
import { settleTradeOps } from "./trade.ts";
import { poolKinds } from "./pool-kinds.ts";
import { PAGE_SOL_PIN, testnetPool, testnetPoolDeps } from "./pool-testnet.ts";
import { poolRestore } from "./pool-restore.ts";
import type { PoolChain } from "./rules/pool.ts";

type State =
  | "loading" | "signed-out" | "signed-in" | "no-prf" | "cancelled" | "unsupported" | "error" | "backup" | "words" | "invalid-code"
  | "choose" | "existing" | "signout" | "withdraw" | "pool-withdraw" | "held";

// DRAFT COPY: the final words are not set yet, but for copy and saved (S3.1's labels, 09-design-brief.md:801),
// "invalid-code" (CN-41, signed, 09-design-brief.md:2335) and the six the owner picked, each with its pick on its line.
// Picked: recovery, S2.1's option (09-design-brief.md:1811); backup, 06b ses.17's menu item; next, S2.5's submit; cancel,
// closing the shell's layer back to the app; new-account and have-one, wallet.md:50's two choices (OD:343, OD:349).
const WORDS = {
  create: "Create passkey",
  use: "Use passkey",
  signout: "Sign out",
  "signed-in": "Signed in",
  "no-prf": "This passkey can't unlock an account here. Use your 12 words.",
  cancelled: "Cancelled",
  unsupported: "This browser has no passkeys. Use your 12 words.",
  error: "Something went wrong. Try again.",
  recovery: "Recovery code", // owner 1 Nov 16:45Z, keep
  backup: "Backup", // owner 1 Nov 16:45Z, keep
  copy: "Copy",
  saved: "Saved",
  next: "Continue", // owner 2 Nov 06:08Z, all approved
  "invalid-code": "Invalid code",
  cancel: "Cancel", // owner 2 Nov 06:08Z, all approved
  "new-account": "New account", // owner 2 Nov 06:08Z, all approved
  "have-one": "I already have one", // owner 2 Nov 06:08Z, all approved
} as const;

const framed = window.top !== window;
const root = document.createElement("main");
root.id = "signin";
if (framed) root.dataset.framed = "true";
// top-level: the shell, with these screens in its layer over the APP_HOST frame; the layer opens only when the app
// asks (signin.open, signout, backup.open and withdraw.open here; export.open is refused until its card builds it) and
// closes on signed in, signed out by the signout kind, or Cancel
let shell: Shell | null = null;
// top-level, on every build: the page network's pool flow, its settling and the next buy's proofs (src/pool-testnet.ts,
// card signpage-pool-mainnet); with no pool pinned on the network it refuses every pool kind and reads nothing; the
// store and the seed are opened when a run needs them
// the page's one prover (src/prover-host.ts: one prover-worker per page, the CSP allows no second), shared by the pool
// flow's proofs and the withdraw form's hand-off (src/withdraw/handoff.ts), top-level only
const prover = !framed ? proverHost() : null;
const testnet = !framed && prover ? testnetPool({ store: () => open(), seed64: () => openSeed64(), openWithdraw: (chain, ctx) => openPoolWithdraw(chain, ctx.id) }, { prover }) : null;
// the restore kind (src/pool-restore.ts, card pool-restore-wired): every pool the page's network pins read from the
// words, what it finds written to the note store, the proof queue's pass after; top-level only, as the pool flow
const restore = !framed
  ? poolRestore({
      store: () => open(),
      seed64: () => openSeed64(),
      signedIn: async () => {
        const s = await readSeedSettled();
        s?.entropy.fill(0);
        return s !== undefined;
      },
      written: () => void testnet?.proofs().catch(() => {}),
      // each reason a run ends stalled, on this device's console only: lanes, indices, providers, scopes and the user's own
      // note amounts (an EVM release's "withdrew X of Y", ../../wallet/src/pool/evm-restore.ts); no key, no words
      ended: (stage, why) => void (stage === "stalled" && console.warn(`restore stalled: ${why.join("; ")}`)),
    })
  : null;
// a deposit carried from its checked address to its note with no tap (src/deposit-follow.ts, card wallet-deposit-follow):
// top-level only, as the seed signs U's call; the store and the seed are opened when a follow runs
const follows = !framed ? depositFollows({ network: () => PAGE_NETWORK, store: () => open(), seed64: () => openSeed64() }) : null;
// a pool quote's money carried from U_X into X's pool with no tap, and a refund of it carried back to U_X
// (src/pool-deposit-follow.ts, card pool-deposit-follow): top-level only; its chain reads are set below, where the pool
// kinds' pairs are made, and until then (or on a chain the page pins no pool on) an op waits for the next landing
let poolFollowDeps: PoolFollowHost["deps"] = () => null;
const poolFollow = !framed
  ? poolFollows({ store: () => open(), decimals: (c) => POOL_ASSET_DECIMALS[POOL_ADDRESS_ASSET[c]], deps: (f, op) => poolFollowDeps(f, op) })
  : null;
// pool.withdraw's screen (src/withdraw/pool-form.ts): the chain the app named and the request's id, the op's id in state.ops
let poolWithdraw: { chain: PoolChain; opId: string } | null = null;
if (framed) document.body.append(root);
else {
  // the shell's own channel: it hears this document's store and other tabs' (a sign-in, Saved, a sign out)
  const channel = new BroadcastChannel(WALLET_CHANNEL);
  const fs = frameState(
    (onEvent) => openWalletStoreReader({ onEvent }),
    (fn) => channel.addEventListener("message", (m) => fn(m.data)),
  );
  // another tab's seed write or sign out: the page's own state follows, so the open kinds it takes match what the app
  // shows (it reads the same store); the page's store handle hears nothing once a sign out has closed it
  channel.addEventListener("message", (m) => storeMoved(m.data as WalletEvent));
  channel.addEventListener("message", (m) => notesMoved(m.data as WalletEvent));
  // under the APP_HOST frame: the app's boot frame as shapes, for the moment before a new frame paints (src/backdrop.ts)
  document.body.append(drawBackdrop(document));
  // the pool kinds' deps: the network's pins and each chain's two RPCs, which the price reads use too (src/pool-price.ts)
  const poolDeps = testnetPoolDeps(testnet?.flow);
  const prices = poolPrices({ rpcs: (chain) => poolDeps.rpcs(chain) as readonly [SolanaRpc, SolanaRpc] | null });
  // the Solana pool's tap spend (state.pools' tap_max, src/pools.ts withSolanaRent): the Rent sysvar, read once on the
  // pool kinds' own pair, and only while the table holds a Solana pool; its landing reads the state again
  const told = new Set<() => void>();
  const rent = rentOnce(
    () => {
      const pair = poolDeps.rpcs("solana");
      if (pair === null) throw new Error("no Solana pair");
      return readSolanaRent(pair as unknown as readonly [SolanaRpc, SolanaRpc]);
    },
    () => {
      for (const f of told) f();
    },
  );
  const hasSolana = PAGE_POOLS.some((p) => p.chain === "solana");
  const poolKindMap = poolKinds(poolDeps);
  // a pool quote's price reads (pool-deposit-address.ts priced): USDC in at 1 USD on both reads, X's coin at the page's
  // own Pyth read on its two RPCs (src/pool-price.ts); any other origin has none yet, so it gets no quote
  const pricedFor = (chain: PoolChain, origin: string): PoolQuotePricing | null => {
    if (!ONECLICK_USDC_ASSETS.includes(origin)) return null;
    const p = prices.get(chain);
    if (p === null) return null;
    const d = -p.expo, digits = p.price.padStart(d + 1, "0");
    const usd = d === 0 ? digits : `${digits.slice(0, digits.length - d)}.${digits.slice(digits.length - d)}`;
    return { decimalsIn: 6, pricing: { in: ["1", "1"], out: [usd, usd] } };
  };
  const solPair = (): readonly [SolanaRpc, SolanaRpc] | null => (PAGE_SOL_PIN === undefined ? null : (poolDeps.rpcs("solana") as unknown as readonly [SolanaRpc, SolanaRpc] | null));
  // the quote's floor on X's pool, read now on its two RPCs (pool-deposit-address.ts readSolanaPoolFloor); none on a
  // chain whose reads are not built here yet (Base and Robinhood: no mainnet pool is pinned)
  const floorFor = async (chain: PoolChain, wallet: string): Promise<bigint | null> => {
    const pair = solPair();
    return chain === "solana" && pair !== null && PAGE_SOL_PIN !== undefined ? readSolanaPoolFloor(pair, PAGE_SOL_PIN.program, wallet) : null;
  };
  const nearPair = () => [followRpc(NEAR_NETWORKS.mainnet.fastnear[0]), followRpc(NEAR_NETWORKS.mainnet.drpc)] as const;
  poolFollowDeps = (f, op) => {
    const pair = solPair();
    if (f.chain !== "solana" || pair === null || PAGE_SOL_PIN === undefined) return null;
    const program = PAGE_SOL_PIN.program;
    return solanaPoolFollowDeps({
      rpcs: pair,
      program,
      // from U_X alone (review H1): pool.deposit run with the op's own U_{s,i} as its fixed source, never the newest U
      deposit: (g, amount, signal) =>
        depositToEnd((p, ctx) => (testnet === null ? null : testnet.depositFrom(p, { s: BigInt(g.s), i: g.i, u: g.u }, ctx as KindContext)), "solana", POOL_ASSET_DECIMALS.SOL, amount, signal),
      refund: poolRefundMover({
        read: (g, nonce) => readMoveAt("intents.near", g.refund_id, nonce, g.origin, nearPair(), NEAR_NETWORKS.mainnet.usdc),
        floor: async (g) => readSolanaPoolFloor(pair, program, g.u),
        priced: (g) => pricedFor(g.chain, g.origin),
        decimals: (c) => POOL_ASSET_DECIMALS[POOL_ADDRESS_ASSET[c]],
        seed64: () => openSeed64(),
        seedLock: (fn) => navigator.locks.request(WALLET_SEED_LOCK, { mode: "shared" }, fn),
        move: op.move,
        record: op.record,
      }),
    });
  };
  // a buy or a sell from the trade box (src/trade.ts): legs from this device's own arm records only, signed here
  const trades = tradeKind({ store: () => open(), seed64: () => openSeed64(), deps: releaseTradeDeps() });
  shell = mountShell(document, {
    // reload waits for a running trade; sign out does too, in every tab (the trade holds the seed lock shared)
    settle: () => trades.idle(),
    // the private balance per chain's pool, from this page's own notes (src/pools.ts); the frame's state has none
    // a state read while a deposit note is still landing settles it again (src/pool-testnet.ts)
    // each pool's USD price, read by this page on the pool kinds' own RPC pair (src/pool-price.ts); each state read
    // starts the next read of a chain it names that is due one
    // card signpage-pool-pins: the table is the network's pins (src/pools.ts PAGE_POOLS); `ready` is the proof queue's
    // ready proofs (src/pool-testnet.ts, on every build; none while no queue is open); the Solana entry's tap_max once
    // the Rent sysvar is read
    state: () =>
      fs.state().then(async (s) => {
        if (s.signed_in) void testnet?.stateRead();
        const r = s.signed_in && hasSolana ? rent.get() : null;
        // the ready list and the notes in one turn of the queue (card pool-ready-no-flicker): a remake's swap never
        // falls between them, so a note that stays ready never reads as ready "0". A failed notes read is kept and
        // thrown inside withPools, whose own catch answers the state without pools, as before: state never throws
        const both = s.signed_in && testnet && PAGE_POOLS.length > 0 ? await testnet.readyWith(notesOrError).catch(() => null) : null;
        const notes = both ? async () => ("e" in both.value ? Promise.reject(both.value.e) : both.value.v) : pageNotes;
        // the vault's USDC from the same notes (src/vault-balance.ts, card signpage-state-holdings): one read shared
        // with state.pools, so both totals come from one view of the store
        let read: Promise<NoteRecord[]> | null = null;
        const shared = () => (read ??= notes());
        const withVault = await withVaultBalance(s, shared, pageScope());
        const out = await withPools(withVault, shared, r === null ? PAGE_POOLS : withSolanaRent(PAGE_POOLS, r), both?.ready, prices.get);
        prices.refresh((out.pools ?? []).map((p) => p.chain));
        return out;
      }),
    // a store change, a new price read (or its next one due), the Rent read landing and a proof made
    watch: (fn) => {
      fs.watch(fn);
      prices.watch(fn);
      told.add(fn);
      testnet?.watch(fn);
    },
    // deposit.quote's checked answer followed (its host's `checked`), deposit.confirm answered where it is (src/deposit-follow.ts)
    kinds: follows!.withFollow({
      // src/pages/open.ts decides what each draws, from the page's own state and store. The answer goes first, then the
      // layer opens (and the frame leaves).
      "signin.open": (p) => openKind("signin.open", p.way),
      signout: () => openKind("signout"),
      "backup.open": () => openKind("backup.open"),
      // the form withdraws from the vault's notes; with a one-time id (from_id) the held deposit's way out
      "withdraw.open": (p) => (takesParams("withdraw.open", p) ? openKind("withdraw.open", undefined, typeof p.from_id === "string" ? p.from_id : undefined) : null),
      // from public records only (src/deposit-wire.ts): U named ahead by this page (src/deposit-name.ts), never the seed
      "deposit.quote": depositQuoteHost({ scope: pageScope, read: fs.depositRead, named: () => namer.named(), checked: (id, r, u) => follows!.quoted(id, r, u) }),
      // the deposit sheet's reads before any address (src/deposit-wire.ts depositReadHosts): public data only
      ...depositReadHosts(),
      // where money for a pool goes (src/pool-deposit-address.ts): U_X from its scope's public record, named ahead by this
      // page; a quote from another chain at the device's own price reads and floor, its address only once the follow
      // took it (src/pool-deposit-follow.ts), on mainnet only
      "pool.address": poolAddressHost({ pools: pagePoolScopes, network: PAGE_NETWORK, read: fs.depositRead, named: () => namer.named(), priced: pricedFor, floor: floorFor, checked: (id, chain, quote, u) => poolFollow!.quoted(id, chain, quote, u) }),
      buy: trades,
      // the pool kinds (src/pool-kinds.ts): each checked by src/rules/pool.ts, answered only on a pool this page's
      // network pins (src/pool-testnet.ts, whose flow runs deposit, buy, sell and withdraw on every build; a network with
      // no pin, mainnet until its pools deploy, refuses every one not_allowed and makes no read); a sell's decimals read
      // on two providers
      ...poolKindMap,
      // the rebuild from the chain (src/pool-restore.ts): answered started, its stages in state.ops and as progress
      ...(restore ? { restore: restore.kind } : {}),
    }),
  });
  shell.layer.append(root);
}

// The account's open kinds (src/pages/open.ts): refused unless the page's state takes them; else the answer goes first,
// then the page reads its own store, draws the kind's page and opens the layer. Nothing is asked of a wallet and no seed
// is made before that read and the page it draws.
let openedBy: AccountKind | null = null;
// I already have one (W:932): Face ID or the typed 12 words and restore, before any seed is made; while it holds, no
// screen offers Create passkey (a passkey without PRF, a cancelled sheet or an error included)
let restoreOnly = false;
// A kind that comes while a resync reads the store waits for it and is decided on what it read: refused only by the
// store's own state, never for coming at that moment (the app takes not_allowed as a refusal no retry changes).
function openKind(kind: AccountKind, way?: unknown, fromId?: string): OpenAnswer | { after: Promise<void>; answer: () => OpenAnswer } | null {
  if (resyncing) return { after: resynced(), answer: () => decide(kind, way, fromId) };
  return decide(kind, way, fromId);
}
async function resynced(): Promise<void> {
  while (resyncing) await resyncing;
}
type OpenAnswer = { result: { pending: true }; then: () => void } | null;
function decide(kind: AccountKind, way: unknown, fromId?: string): OpenAnswer {
  if (!takes(kind, root.dataset.signin, busy)) return null;
  return {
    result: { pending: true },
    then: () =>
      void run(async () => {
        const seed = await readSeedSettled();
        const page = pageFor(kind, way, seed, typeof PublicKeyCredential !== "undefined", fromId);
        openedBy = kind;
        restoreOnly = false;
        if (page === "signed-in") return landed({ screen: "signed-in", seed: seed! });
        if (page === "signed-out") return show("signed-out");
        if (page === "backup") showBackup(seed!);
        else if (page === "signout") show("signout", shown(seed!));
        else if (page === "withdraw") {
          // the form needs no seed: its entropy is zeroed at once
          seed!.entropy.fill(0);
          show("withdraw");
        } else if (page === "held") {
          seed!.entropy.fill(0);
          // the held op of that id in this page's own store, never the app's word; none: back to the app
          heldOp = await heldOpFor(fromId!);
          if (heldOp === null) return show("signed-in", shown(seed!));
          show("held");
        } else show(page === "passkey" ? "signed-out" : page);
        openLayer();
      }),
  };
}
// pool.withdraw (card signpage-pool-withdraw-form), top-level only and only with a seed stored, as withdraw.open: the
// answer goes first, then the screen where the user types To and the amount, never passed in by the app; the run's
// stages go to the op under the request's id.
function openPoolWithdraw(chain: PoolChain, opId: string): { result: { pending: true }; then: () => void } | null {
  if (framed || !testnet || !takes("withdraw.open", root.dataset.signin, busy)) return null;
  return {
    result: { pending: true },
    then: () =>
      void run(async () => {
        poolWithdraw = { chain, opId };
        show("pool-withdraw");
        openLayer();
      }),
  };
}
// The layer opens, and the activation guard restarts its 500 ms: a click lined up before cannot act on what it shows.
function openLayer(): void {
  shell?.open();
  reshown();
}
// Back to the app: the layer closes on the page's signed-in or signed-out state.
function closeLayer(): void {
  openedBy = null;
  restoreOnly = false;
  shell?.close();
}

// The activation guard of the GUARDED controls (./guard.ts). Every trusted pointerdown and keydown in the window reaches it first
// (capture phase), so the gap to the previous input is known when Sign out sees its press.
const guard = activationGuard(performance.now());
const reshown = (): void => guard.shown(performance.now());
addEventListener("pageshow", reshown);
addEventListener("focus", (e) => e.target === window && reshown());
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && reshown());
let last: { e: Event; press: Press } | null = null;
const input = (e: Event): void => {
  if (e.isTrusted) last = { e, press: guard.input(e.timeStamp, e instanceof KeyboardEvent && e.repeat) };
};
addEventListener("pointerdown", input, true);
addEventListener("keydown", input, true);

const GUARDED = new Set(["signout", "saved", "backup", "copy", "withdraw", "move-out"]);
function button(action: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.action = action;
  b.textContent = label;
  if (!GUARDED.has(action)) {
    b.addEventListener("click", onClick);
    return b;
  }
  // drawn now, and on screen by the next frame
  reshown();
  requestAnimationFrame(reshown);
  // the press is the pointerdown or Enter or Space keydown that starts the click, with the verdict the window's capture
  // listener just gave it; a click with none seen (an assistive tool's click) is its own press
  let press: Press | null = null;
  const pressed = (e: Event): void => {
    if (e.isTrusted && last?.e === e) press = last.press;
  };
  b.addEventListener("pointerdown", pressed);
  b.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && pressed(e));
  b.addEventListener("click", (e) => {
    const p = press;
    press = null;
    if (!e.isTrusted || !guard.allows(p, e.timeStamp)) return;
    onClick();
  });
  return b;
}

function show(state: State, seed?: { account: string; code_saved: boolean; signout: boolean }, words?: string): void {
  root.dataset.signin = state;
  if (state !== "backup" && drawn) {
    drawn.fill(0);
    drawn = null;
  }
  if (state === "signed-in") closeLayer();
  if (seed) {
    root.dataset.account = seed.account;
    root.dataset.codeSaved = String(seed.code_saved);
  } else {
    delete root.dataset.account;
    delete root.dataset.codeSaved;
  }
  const parts: HTMLElement[] = [];
  if (state !== "loading" && state !== "signed-out" && state !== "signed-in" && state !== "backup" && state !== "words"
    && state !== "choose" && state !== "existing" && state !== "signout" && state !== "withdraw" && state !== "pool-withdraw" && state !== "held") {
    const p = document.createElement("p");
    p.textContent = WORDS[state];
    parts.push(p);
  }
  if (state === "signed-in") {
    const p = document.createElement("p");
    p.textContent = WORDS["signed-in"];
    parts.push(p);
    if (!framed && seed?.signout) parts.push(button("signout", WORDS.signout, () => void run(signOut)));
    // the Backup dot: the 12 words are the only copy and not saved (ses.17, ses.18)
    if (!framed && seed && !seed.signout) parts.push(button("backup", WORDS.backup, () => void run(openBackup)));
  } else if (state === "signout") {
    // the sign-out page (W:913): top-level only, and drawn only once the 12 words are saved or are not the only copy
    if (!framed && seed?.signout) parts.push(button("signout", WORDS.signout, () => void run(signOut)));
  } else if (!framed && state === "choose") {
    // wallet.md:50: the two choices, before the wallet is asked anything or any seed is made. New account asks the
    // wallet to sign; that request has no code yet, so it is drawn and not offered (data-pending) until it lands.
    const fresh = button("new-account", WORDS["new-account"], () => {});
    fresh.disabled = true;
    fresh.dataset.pending = "wallet-signature";
    parts.push(fresh);
    parts.push(button("have-one", WORDS["have-one"], () => ((restoreOnly = true), show("existing"))));
  } else if (!framed && state === "withdraw") {
    // the withdraw form (src/withdraw/form.ts), top-level only: the address and the amount are typed here, never
    // passed in by the app (W:927)
    parts.push(drawWithdrawForm(document, withdrawDeps(), button, (step) => void run(step)));
  } else if (!framed && state === "held" && heldOp !== null) {
    // the held deposit's way out (src/withdraw/held.ts): the account typed here, never passed in by the app
    parts.push(drawHeldMoveOut(document, heldDeps(heldOp), button, (step) => void run(step)));
  } else if (!framed && state === "pool-withdraw" && testnet && poolWithdraw) {
    // the pool withdraw screen: To and the amount typed here; the press starts the run and the layer closes, its
    // stages read back in state.ops
    const { chain, opId } = poolWithdraw;
    const deps = testnet.withdrawDeps(chain, opId);
    const handoff = deps.handoff;
    parts.push(drawPoolWithdrawForm(document, handoff ? { ...deps, handoff: async (r) => (void handoff(r), (poolWithdraw = null), await cancel()) } : deps, button, (step) => void run(step)));
  } else if (!framed && state === "existing") {
    // I already have one: Face ID (the passkey with PRF) or the typed 12 words, then restore (W:50); never a new seed
    if (typeof PublicKeyCredential !== "undefined") parts.push(button("use", WORDS.use, () => void run(() => signIn(getPasskey, false))));
    parts.push(button("recovery", WORDS.recovery, () => show("words")));
  } else if (state === "backup") {
    // the 12 words, top-level only (W:914): show() is never asked for them in a frame, and backupWords refuses there
    if (!framed && words) {
      const list = document.createElement("ol");
      list.dataset.words = "12";
      for (const w of words.split(" ")) {
        const li = document.createElement("li");
        li.textContent = w;
        list.append(li);
      }
      parts.push(list);
      parts.push(button("copy", WORDS.copy, () => void navigator.clipboard?.writeText(words).catch(() => {})));
      parts.push(button("saved", WORDS.saved, () => void run(saved)));
    }
  } else if (!framed && (state === "words" || state === "invalid-code")) {
    const box = document.createElement("textarea");
    box.dataset.input = "words";
    box.rows = 3;
    box.autocomplete = "off";
    box.spellcheck = false;
    box.setAttribute("autocapitalize", "none");
    box.setAttribute("autocorrect", "off");
    parts.push(box);
    parts.push(button("next", WORDS.next, () => {
      const typed = box.value;
      box.value = "";
      void run(() => signInWords(typed));
    }));
  } else if (!framed && state !== "loading") {
    if (state !== "unsupported") {
      if (!restoreOnly) parts.push(button("create", WORDS.create, () => void run(() => signIn(createPasskey, true))));
      parts.push(button("use", WORDS.use, () => void run(() => signIn(getPasskey, false))));
    }
    parts.push(button("recovery", WORDS.recovery, () => show("words")));
  }
  // back to the app from any sign-in screen; the backup's words stay until Saved or a sign-in elsewhere
  // and from a backup or sign-out page an open kind drew over a signed-in account (the words saved or not, as they were)
  const cancellable = state !== "loading" && state !== "signed-in" && (state !== "backup" || openedBy === "backup.open" || openedBy === "signout");
  if (shell && cancellable) parts.push(button("cancel", WORDS.cancel, () => void run(cancel)));
  root.replaceChildren(...parts);
}

// The withdraw form's reads on the build's network (src/withdraw/handoff.ts): the note value over the note store, the
// relayer's fee bounded by the device's fee_max, and the hand-off where the release names a relayer (the vault pays the
// typed account straight, card wallet-withdraw-move-out); with the last settle pass's drifts, shown on the form.
function withdrawDeps() {
  const page = { store: () => open(), notes: async () => openNoteStore(await open()), seed64: () => openSeed64(), prover: prover!.vault, signal: withdrawWait.signal };
  return { ...withdrawFormDeps(page), unmatched: () => withdrawsUnmatched };
}
// How many RESERVED vault withdrawals the last settle pass read "unmatched" (a spend of the note whose change is not this
// device's): kept for the form, never dropped (card wallet-withdraw-move-out).
let withdrawsUnmatched = 0;
// Sign out (this tab's or another's) stops a vault withdrawal's wait; its note stays RESERVED with its request.
let withdrawWait = new AbortController();
function withdrawsSignedOut(): void {
  withdrawWait.abort();
  withdrawWait = new AbortController();
}
// The held deposit's way out (card held-deposit-way-out): the op is this page's own, found by its U; the move is the
// wallet's (moveOutHeld), U's key opened under the wallet's seed lock, shared, as the deposit follow opens it.
let heldOp: string | null = null;
const heldRpcs = () => [moveOutRpc(NEAR_NETWORKS[PAGE_NETWORK].fastnear[0]), moveOutRpc(NEAR_NETWORKS[PAGE_NETWORK].drpc)] as const;
// the network's archival RPCs, every one, read only for a recorded move both of the pair forgot (card held-move-forgotten-tx),
// each asked again after a throttle (archivalRpc)
const heldArchival = () => NEAR_NETWORKS[PAGE_NETWORK].archival.map((u) => archivalRpc(u));
const heldSeedLock = <T,>(fn: () => Promise<T>): Promise<T> => (navigator.locks ? (navigator.locks.request(WALLET_SEED_LOCK, { mode: "shared" }, fn) as Promise<T>) : fn());
// U's own lock, the deposit follow's (deposit-follow.ts FOLLOW_LOCK/<network>/<U>), only if free: while a follow of U runs
// (it may bind U's USDC), no move of U is signed (review of d791adda, M1)
const heldULock = (u: string) => <T,>(fn: () => Promise<T>): Promise<T | null> =>
  navigator.locks ? (navigator.locks.request(`${FOLLOW_LOCK}${PAGE_NETWORK}/${u}`, { mode: "exclusive", ifAvailable: true }, (lock) => (lock === null ? null : fn())) as Promise<T | null>) : fn();
async function heldOpFor(u: string): Promise<string | null> {
  const ops = await open();
  for (const k of await ops.keys("ops")) {
    const op = (await ops.get("ops", k).catch(() => undefined)) as DepositOp | undefined;
    if (op?.kind === "deposit" && op.follow?.u === u && op.follow.network === PAGE_NETWORK && (await heldOpOf(ops, k).then(() => true, () => false))) return k;
  }
  return null;
}
function heldDeps(opId: string): HeldDeps {
  const rpcs = heldRpcs();
  return {
    network: PAGE_NETWORK,
    rpcs,
    recorded: async () => ((await (await open()).get("ops", opId)) as DepositOp | undefined)?.follow?.out,
    moveOut: async (to) => {
      const ops = await open();
      const u = ((await ops.get("ops", opId)) as DepositOp | undefined)?.follow?.u ?? "";
      return moveOutHeld(opId, to, { ops, rpcs, archival: heldArchival(), seed64: () => openSeed64(), seedLock: heldSeedLock, uLock: heldULock(u) });
    },
  };
}
// a move a closed or reloaded page left out is resumed once per sign-in: its same signed bytes, never a new signature
// (moveOutHeld with null never signs: a record that can no longer land waits for the user's tap, review of d791adda L6)
async function settleHeld(): Promise<void> {
  const ops = await open();
  for (const k of await ops.keys("ops")) {
    const op = (await ops.get("ops", k).catch(() => undefined)) as DepositOp | undefined;
    // a moved one too: a later deposit in its U is open again (moveOutHeld reads U for it; card held-move-forgotten-tx)
    if (op?.kind === "deposit" && op.stage === "held" && op.follow?.out !== undefined && op.follow.network === PAGE_NETWORK)
      await moveOutHeld(k, null, { ops, rpcs: heldRpcs(), archival: heldArchival(), seed64: () => openSeed64(), seedLock: heldSeedLock, uLock: heldULock(op.follow.u) }).catch(() => {});
  }
}
// The vault withdrawals a closed or reloaded page left RESERVED, followed to settled once per sign-in (src/withdraw/
// handoff.ts withdrawSettle); its own note store, closed after. Nothing where the build's network names no vault.
async function settleWithdraws(): Promise<void> {
  if (!prover) return;
  let ns: NoteStore | null = null;
  try {
    const pass = await withdrawSettle({
      store: () => open(),
      notes: async () => (ns ??= await openNoteStore(await open())),
      seed64: () => openSeed64(),
      prover: prover.vault,
      signal: withdrawWait.signal,
    });
    withdrawsUnmatched = Object.values(pass.outcomes).filter((k) => k === "unmatched").length;
  } finally {
    (ns as NoteStore | null)?.close();
  }
}

// The account's public id from its entropy: entropy -> 12 words -> seed64 -> T_0 (wallet.md:47, :54, :68). seed64 is
// zeroed here, and so is T_0's secret key, which only its id is wanted from; the caller zeroes the entropy.
function accountOf(entropy: Uint8Array): string {
  const seed64 = wordsToSeed64(entropyToWords(entropy));
  try {
    const t = profileKey(seed64, 0);
    t.secretKey.fill(0);
    return t.id;
  } finally {
    seed64.fill(0);
  }
}
// What the screen shows of a seed, the seed's entropy zeroed after.
function shown(s: Seed): { account: string; code_saved: boolean; signout: boolean } {
  try {
    return { account: accountOf(s.entropy), code_saved: s.code_saved, signout: !backupFirst(s) };
  } finally {
    s.entropy.fill(0);
  }
}

let store: WalletStore | null = null;
// the store's connection closed under the deposit follows: they start again once it is opened next
let followsClosed = false;
const open = async (): Promise<WalletStore> => {
  const had = store;
  const s = (store ??= await openWalletStore({
    // another tab signed out: its store closed ours; drop it and show signed-out
    onEvent: (e) => {
      moved += 1;
      // a delete or upgrade closed our connection: the next step opens the store again
      // the follows ran on that connection: they end (U's lock freed) and start again on the store opened next
      if (e.kind === "closed") (store = null), (followsClosed = true), follows?.storeClosed(), poolFollow?.stop();
      if (e.kind !== "signout") return;
      store = null;
      followsClosed = false;
      openedBy = null;
      void testnet?.signedOut();
      restore?.signedOut();
      follows?.signedOut();
      poolFollow?.stop();
      show("signed-out");
    },
  }));
  if (had === null && followsClosed) (followsClosed = false), void follows?.settle(), void poolFollow?.settle().catch(() => {});
  return s;
};

const readSeed = async (): Promise<Seed | undefined> => checkSeed(await (await open()).get("meta", "seed"));
// The seed for a trade's signer (src/trade.ts), opened only once a wallet passed its arm check; the entropy is zeroed
// here and the seed64 by the signer when the trade ends.
async function openSeed64(): Promise<Uint8Array> {
  const s = await readSeedSettled();
  if (!s) throw new Error("no seed is stored");
  try {
    return wordsToSeed64(entropyToWords(s.entropy));
  } finally {
    s.entropy.fill(0);
  }
}
// The store moved (another tab signed in, saved or signed out) since `moved` was last read: a read that spans a move
// may hold a seed that is no longer stored, so it is read again; a store that keeps moving reads as no seed.
let moved = 0;
async function readSeedSettled(): Promise<Seed | undefined> {
  for (let i = 0; i < 3; i++) {
    const at = moved;
    const s = await readSeed();
    if (at === moved && store !== null) return s;
    s?.entropy.fill(0);
  }
  return undefined;
}
// Another tab's write to the seed or its sign out, heard on the shell's channel: while the layer is hidden and no step
// runs, the page reads its store again and shows signed in or signed out, as the app does.
function storeMoved(e: WalletEvent): void {
  if (walletSeedMoved(e)) moved += 1;
  else return;
  // another tab signed out: the proof queue and its seed copy go now
  if (e.kind === "signout") {
    void testnet?.signedOut();
    withdrawsSignedOut();
  }
  void resync();
}
// the resync in flight, which open kinds wait for (openKind)
let resyncing: Promise<void> | null = null;
function resync(): Promise<void> {
  if (resyncing) return resyncing;
  if (busy || !shell?.layer.hidden) return Promise.resolve();
  const r: Promise<void> = run(async () => {
    const s = await readSeedSettled();
    if (!shell?.layer.hidden) return void s?.entropy.fill(0);
    if (s) return landed({ screen: "signed-in", seed: s });
    show(typeof PublicKeyCredential === "undefined" ? "unsupported" : "signed-out");
  }, false).finally(() => {
    if (resyncing === r) resyncing = null;
  });
  resyncing = r;
  return r;
}

const topLevelOnly = (): void => {
  if (framed) throw new Error("sign-in and sign-out run top-level only, never in a frame");
};

// deposit.quote's U (card signpage-deposit-quote-wire; src/deposit-name.ts): this top-level page, which reads the seed
// to sign in, copies the note store's one PLANNED deposit note of the vault's scope into the public record
// meta/"deposit/<scope>", so the API answers from public data and never opens the seed. Named on every landing and
// again on every change to the notes (a note that left PLANNED: the next index is planned and named); while no vault
// is named on the page's network, nothing is.
// a function declaration: the shell's kinds, made at the top, hold it before this line runs
function pageScope(): bigint | null {
  return vaultScope(PAGE_NETWORK);
}
// each pool the network pins is named the same way, under its own scope (card pool-deposit-address): pool.address
// answers its U_X from that record
function pagePoolScopes(): { chain: PoolChain; scope: bigint }[] {
  return PAGE_POOLS.flatMap((p) => (p.chain === "near" ? [] : [{ chain: p.chain, scope: p.scope }]));
}
const namer = depositNamer({
  top: !framed,
  scope: pageScope,
  pools: pagePoolScopes,
  open,
  startup: () => startup,
  resyncing: () => resyncing,
});
// state.pools' notes (src/pools.ts): read only, with the wallet's readNotes on this page's own wallet store: no Web Lock,
// no write, so a state read never frees a note or finishes a parent (the note store's own paths do). Top-level only, as
// the frame keeps no note data. A function declaration, as the shell's state, made at the top, holds it.
async function pageNotes(): Promise<NoteRecord[]> {
  return readNotes(await open());
}
// pageNotes for the queue's readyWith: its failure kept as a value, so the turn ends and the state's withPools throws it
// in its own catch
const notesOrError = (): Promise<{ v: NoteRecord[] } | { e: unknown }> => pageNotes().then((v) => ({ v }), (e: unknown) => ({ e }));
// a change to the notes, heard on the shell's channel (this document's store and other tabs'): name again
function notesMoved(e: WalletEvent): void {
  if (!shell || (pageScope() === null && PAGE_POOLS.length === 0) || e?.kind !== "changed" || !Array.isArray(e.stores) || !e.stores.includes("notes")) return;
  void readSeed()
    .then((s) => {
      if (!s) return;
      namer.name(s.entropy);
      s.entropy.fill(0);
    })
    .catch(() => {});
}

// Where a sign-in landed (words.ts): the backup screen for a no-PRF seed this sign-in made, else signed in on the seed
// stored, which may be another tab's (never its words then).
async function landed(l: Landing): Promise<void> {
  namer.name(l.seed.entropy);
  // a deposit a reload cut short is finished now (src/pool-testnet.ts), not at the next ask
  void testnet?.settle();
  // a NEAR deposit followed on from its stage (src/deposit-follow.ts)
  void follows?.settle().catch(() => {});
  // a pool quote's money followed on into its pool from its stage (src/pool-deposit-follow.ts)
  void poolFollow?.settle().catch(() => {});
  // a vault withdrawal a reload cut short is followed to settled (src/withdraw/handoff.ts withdrawSettle)
  void settleWithdraws().catch(() => {});
  // a held deposit's move out a reload cut short (src/withdraw/held.ts)
  void settleHeld().catch(() => {});
  // a restore a closed or reloaded page left running reads stalled, so the app offers Retry (src/pool-restore.ts)
  void restore?.settle().catch(() => {});
  // a buy or sell a closed or reloaded page left open is settled from its wallets' marks, or refused when it sent
  // nothing (src/trade.ts settleTradeOps): the app's Sell never waits on an op no page will end
  // (its own paced pair: a few status reads once per sign-in)
  if (!framed && globalThis.navigator?.locks) void open().then((s) => settleTradeOps(s, navigator.locks, releaseTradeDeps().providers)).catch(() => {});
  if (l.screen === "backup") return void showBackup(l.seed);
  show("signed-in", shown(l.seed));
}

async function signIn(ceremony: () => Promise<PasskeyOutcome>, create: boolean): Promise<void> {
  topLevelOnly();
  // never replace a seed already stored here, and run no ceremony: sign out first (wallet.md:919)
  const had = await readSeed();
  if (had) return landed({ screen: "signed-in", seed: had });
  const r = await ceremony();
  // ses.4: a random seed, and the backup screen in the same visit; insert-only, so another tab's seed stays
  if (r.kind === "no-prf" && create) return landed(await signInNoPrf(open));
  if (r.kind !== "prf") return show(r.kind);
  // insert-only: when another tab stored a seed meanwhile, that one stays and is the account shown; the entropy is
  // zeroed on every path, an open that fails included (words.ts storeSeed)
  await landed(await signInPrf(open, r.entropy));
  // a passkey that opens an existing account on this browser: its notes are rebuilt from the chain with no tap
  if (!create) void restore?.auto().catch(() => {});
}

// ses.10-12: the typed 12 words, checked on the device before anything else; a failure stores nothing
async function signInWords(typed: string): Promise<void> {
  topLevelOnly();
  const had = await readSeed();
  if (had) return landed({ screen: "signed-in", seed: had });
  let l: Landing;
  try {
    l = await signInTyped(open, typed);
  } catch (e) {
    if (e instanceof WordsRefused) return show("invalid-code");
    throw e;
  }
  await landed(l);
  // the words on a new browser: an empty note store is rebuilt from the chain once, with no tap (src/pool-restore.ts)
  void restore?.auto().catch(() => {});
}

// The backup screen (S3.1): the stored seed's 12 words, top-level only; the entropy is zeroed once they are made.
// `drawn` keeps the entropy of the words on screen until the page leaves the backup, so Saved marks that seed alone.
let drawn: Uint8Array | null = null;
function showBackup(s: Seed): void {
  topLevelOnly();
  const seen = shown({ ...s, entropy: s.entropy.slice() });
  try {
    show("backup", seen, backupWords(s));
    drawn?.fill(0);
    drawn = s.entropy.slice();
  } finally {
    s.entropy.fill(0);
  }
}
async function openBackup(): Promise<void> {
  const s = await readSeed();
  if (!s) return show("signed-out");
  showBackup(s);
}
// Saved (ses.5): code_saved becomes true; the Backup dot clears and Sign out is drawn. Opened by signout, it goes on to
// the sign-out page (W:913), else back to the app signed in.
async function saved(): Promise<void> {
  topLevelOnly();
  if (!drawn) throw new Error("no 12 words are on screen");
  try {
    await saveWords(await open(), { entropy: drawn });
  } catch (e) {
    // another tab signed out and in since the words were drawn: nothing is marked, and the page shows the store as it is
    if (!(e instanceof SeedChanged)) throw e;
    const now = await readSeed();
    return now ? show("signed-in", shown(now)) : (show("signed-out"), closeLayer());
  }
  const s = await readSeed();
  if (!s) return show("signed-out");
  if (afterSaved(openedBy) === "signout") return show("signout", shown(s));
  show("signed-in", shown(s));
}
// Cancel: back to the app as the store stands (signed in with a seed, signed out with none), from any page, an error's
// included, so the state the open kinds read is the store's; a store that cannot be read (a broken seed record, a
// failed decrypt) still lets Cancel go back to the app
async function cancel(): Promise<void> {
  const s = shell ? await readSeed().catch(() => undefined) : undefined;
  if (s) return show("signed-in", shown(s));
  if (root.dataset.signin === "error") show(typeof PublicKeyCredential === "undefined" ? "unsupported" : "signed-out");
  closeLayer();
}

async function signOut(): Promise<void> {
  topLevelOnly();
  const s = await open();
  // a restore holds the seed lock shared, which the sign out waits for: it stops first
  restore?.signedOut();
  // a deposit's follow stops too: its op stays at its stage (src/deposit-follow.ts)
  follows?.signedOut();
  poolFollow?.stop();
  withdrawsSignedOut();
  // the handle is dropped only once the store has signed out: a refused sign out leaves it open and still held
  await s.signOut();
  store = null;
  // after the store signed out: a deposit that landed while it waited cannot open the queue again (no seed)
  await testnet?.signedOut();
  show("signed-out");
  // signed out by the signout kind: back to the app, which shows signed out
  if (openedBy === "signout") closeLayer();
}

let busy = false;
async function run(step: () => Promise<void>, again = true): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    await step();
  } catch {
    show("error");
  } finally {
    busy = false;
  }
  // a step that failed with the layer hidden (an open kind's read) leaves no page on screen: read the store again
  if (again && root.dataset.signin === "error" && shell?.layer.hidden) void resync();
}

show("loading");
// top-level only: the frame never opens the seed record (src/state.ts reads the status instead); it draws nothing
if (framed) root.dataset.signin = "framed";
const startup: Promise<void> = framed
  ? Promise.resolve()
  : run(async () => {
    // one backfill: a database from before the status record gets it from the seed (the store writes it itself since);
    // a failed one leaves the frame reading the seed's key alone (signed in, the Backup dot) until the next load
    await open()
      .then((st) => st.syncStatus())
      .catch(() => {});
    const s = await readSeed();
    if (s) await landed({ screen: "signed-in", seed: s });
    else show(typeof PublicKeyCredential === "undefined" ? "unsupported" : "signed-out");
  });

if (framed) {
  // the frame's own channel: it hears another tab's sign-in even when no database exists yet to open
  const channel = new BroadcastChannel(WALLET_CHANNEL);
  const fs = frameState(
    (onEvent) => openWalletStoreReader({ onEvent }),
    (fn) => channel.addEventListener("message", (m) => fn(m.data)),
  );
  // deposit.quote reads U's public record, which a top-level SIGN_HOST page names; the frame names nothing
  startApi({
    parent: window.parent,
    listen: (fn) => window.addEventListener("message", fn),
    state: fs.state,
    watch: fs.watch,
    // deposit.quote only on the top-level page, which follows its address (src/deposit-follow.ts): the frame refuses it
    kinds: { ...depositReadHosts() },
  });
}
