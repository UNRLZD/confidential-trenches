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
//   or Cancel, so the terminal shows signed out too. The layer is one sheet over the app (src/sheet.ts): the frame stays
//   under it, inert, its messages dropped, and leaves the document only for a screen with a typed field (src/shell.ts).
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
import { cashMover, poolMoveKinds, withCash, type CashToPoolDeps, type MoveFollow, type MoveOpRecord } from "./cash-to-pool.ts";
import { formatUnits as formatPoolUnits, parseUnits as parsePoolUnits } from "./withdraw/pool-form.ts";
import { quotesStop } from "./quotes-stop.ts";
import { depositFollows, FOLLOW_LOCK } from "./deposit-follow.ts";
import { depositToEnd, depositWalletsOf, evmQuoteRoute, poolAgainWait, poolFollows, poolRefundMover, solanaPoolFollowDeps, uxHeldOf, uxNoteLanded, uxNoteOpen, poolFollowEnded, type PoolFollowHost, type PoolFollowRecord } from "./pool-deposit-follow.ts";
import { POOL_ADDRESS_ASSET, POOL_FLOOR_PLACEHOLDER, poolQuotePricing, readEvmPoolFloor, readSolanaPoolFloor, walletOf, type PoolQuotePricing } from "./pool-deposit-address.ts";
import type { EvmRpc } from "../../wallet/src/pool/evm.ts";
import { followRpc, readMoveAt } from "../../wallet/src/deposit/follow.ts";
import { NEAR_NETWORKS } from "../../wallet/src/deposit/account.ts";
import { ONECLICK_USDC_ASSETS } from "../../kit/src/checks/oneclick.ts";
import { POOL_ASSET_DECIMALS, type PoolStatePrice } from "../../kit/src/signpage/messages.ts";
import { PAGE_POOLS, poolBuyDryKind, rentOnce, withDepositWallets, withPools, withSolanaRent } from "./pools.ts";
import { poolPrices, wakeWhenShown } from "./pool-price.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { readSolanaRent } from "../../kit/src/trade/solana/pool-buy.ts";
import { openNoteStore, readNotes, type NoteRecord, type NoteStore } from "../../wallet/src/notes/store.ts";
import { frameState } from "./state.ts";
import { withVaultBalance } from "./vault-balance.ts";
import { returningWallets, withPositions, withReturning } from "./positions.ts";
import { mountShell, type Shell } from "./shell.ts";
import { drawBackdrop, drawSealedGround, groundLogo } from "./backdrop.ts";
import { GROUND_LOGO_SVG } from "./ground-logo.ts";
import { SEALED } from "./frame-cover.ts";
import { afterSaved, pageFor, takes, takesParams, type AccountKind } from "./pages/open.ts";
import { vaultScope } from "./withdraw/checks.ts";
import { drawWithdrawForm } from "./withdraw/form.ts";
import { drawHeldMoveOut, type HeldDeps } from "./withdraw/held.ts";
import { archivalRpc, heldOpOf, moveOutHeld, moveOutRpc } from "../../wallet/src/deposit/moveout.ts";
import type { DepositOp } from "../../wallet/src/deposit/follow.ts";
import { PAGE_NETWORK, withdrawFormDeps, withdrawHandoff, withdrawSettle } from "./withdraw/handoff.ts";
import { nearBuyKind, nearHoldingsPass, nearPositions, nearSellKind, resumeNearBuys, resumeNearSells, type NearBuyPage } from "./near-buy.ts";
import { rheaPoolsKept } from "./near-pools.ts";
import { nearSeatRpc, pacedNearRpc, seatsUp } from "../../wallet/src/pace.ts";
import { proverHost } from "./prover-host.ts";
import { drawPoolWithdrawForm } from "./withdraw/pool-form.ts";
import { releaseTradeDeps, tradeKind } from "./trade.ts";
import { settleTradeOps, timedStore, TRADE_STORE_MS, tradeSettleDue } from "./trade.ts";
import { PAGE_TOKEN_DECIMALS, poolKinds } from "./pool-kinds.ts";
import { liveRuns, poolSellDryKind } from "./pool-sell-dry.ts";
import { PAGE_CLUSTER, PAGE_SOL_PIN, pageEvmFloorPool, pageEvmWalletRpc, pageSolanaRpcs, poolWayOut, testnetPool, testnetPoolDeps } from "./pool-testnet.ts";
import { closeHostLanes, gatedFetch, hostLane, hostLanesClosed } from "../../wallet/src/throttle.ts";
import { poolRestore, restoreUxOf } from "./pool-restore.ts";
import { walkWorkerPort } from "./walk-workers.ts";
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
// the page's one gate (card sign-out-stops-the-pages-reads; ../../wallet/src/throttle.ts): every request of this page
// past its own origin goes through it, whatever reader makes it. It closes once this tab's sign out holds the seed lock
// (the store's `locked`) or when another tab's sign out is heard, and nothing opens it again: the page reloads after a
// sign out (reloadSignedOut), so every loop, timer and closure of the old account ends with it, and the next load
// starts signed out with the gate open.
globalThis.fetch = gatedFetch(globalThis.fetch.bind(globalThis), location.origin);
// from a sign out's tap to its end (or its refusal): no new run of any kind starts on this page; a money run that
// already holds the seed lock finishes, its reads open, before the store's sign out can take the lock
let leaving = false;
function reloadSignedOut(): void {
  closeHostLanes();
  location.reload();
}
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
// the page's own pool price reads (src/pool-price.ts), set once they are made below: a pool buy's cost reads them
let pagePrice: ((chain: PoolChain) => PoolStatePrice | null) | null = null;
const testnet = !framed && prover ? testnetPool({ store: () => open(), held: () => opened(), seed64: () => openSeed64(), openWithdraw: (chain, ctx) => openPoolWithdraw(chain, ctx.id), price: (chain) => pagePrice?.(chain) ?? null }, { prover }) : null;
// the restore kind (src/pool-restore.ts, card pool-restore-wired): every pool the page's network pins read from the
// words, what it finds written to the note store, the proof queue's pass after; top-level only, as the pool flow
const restore = !framed
  ? poolRestore({
      store: () => open(),
      held: () => opened(),
      seed64: () => openSeed64(),
      signedIn: async () => {
        const s = await readSeedSettled();
        s?.entropy.fill(0);
        return s !== undefined;
      },
      // a chain this build gives no deposit address on (pageAddressPools): no U_X there to read, so no stall reason
      addressed: (chain) => pageAddressPools().some((p) => p.chain === chain),
      // the NEAR vault's notes written: each W they show with no record gets it back (card near-holdings-restore), and
      // a W's USDC on its way home goes on; never awaited by the restore
      nearWalked: () => {
        const page = nearBuyPage();
        if (page) void nearHoldings(page, true).then(() => resumeNearSells(page)).catch(() => {});
      },
      // a chain's buy records written (card signpage-positions-evm): its positions read again, with no reload; ahead of
      // `written`, whose neighbours wallet-restore-reads-ux's bundle check reads
      holdingsWritten: (chain) => testnet?.evmHoldingsRestored(chain),
      written: () => void testnet?.proofs().catch(() => {}),
      // a load's first proof passes go ahead of the resume's reads (card a-load-proves-first-and-walks-the-restore-once)
      firstPass: (startMs) => testnet?.firstPass(startMs) ?? Promise.resolve(),
      // a pool's U_X reads and carry on its chain (card wallet-restore-reads-ux, src/pool-restore.ts restoreUxOf): the
      // follow's own reader on the restore's two public operators (never our helper relay: on Base and Robinhood the
      // pool's own pair, card evm-deposit-on-mainnet), and the follow's own deposit (poolFollowDeps below), so a restore
      // and a live pool deposit read U_X and carry it the same way; null on a chain the follow has no reads for (the
      // restore then names U_X unread there)
      // and what it reads U_X holds is U_X's op's `left` (state.deposit_wallets; review r3 P2-1)
      ux: (chain) => {
        const r = restoreUxOf(chain, poolFollowDeps({ chain, s: "", i: 0, u: "", refund_id: "", address: "", deadline_ms: 0, origin: "", min_out: "" }, UX_ONLY), PAGE_SOL_PIN?.program, undefined, (c) => testnet?.evmPoolOf(c) ?? null);
        return r === null ? null : { ...r, leftAt: async (f, low) => void (await poolFollow?.left(f.chain, f.u, low)) };
      },
      // each reason a run ends stalled, on this device's console only: lanes, indices, providers, scopes and the user's own
      // note amounts (an EVM release's "withdrew X of Y", ../../wallet/src/pool/evm-restore.ts), a one-time wallet U_X
      // and its balance; no key, no words
      ended: (stage, why) => void (stage === "stalled" && console.warn(`restore stalled: ${why.join("; ")}`)),
      // step 5's tries after the walk's end, the same reasons: a finding the user is told of (on the last try, what is
      // still unread too) in the `restore stalled:` shape; a read asked again as `restore ids unread:`
      step5: (e) => {
        if (e.named.length > 0) console.warn(`restore stalled: ${e.named.join("; ")}`);
        const unread = [...e.held, ...e.retry];
        if (unread.length > 0) console.warn(`restore ids unread: try ${e.tries}, asked again: ${unread.join("; ")}`);
      },
      // each pool's walk in Workers (card restore-shows-the-balance-in-seconds): a module Worker per lane from this
      // origin's /walk-worker.js, through the Trusted Types policy walk-worker (src/walk-workers.ts); a lane whose Worker
      // cannot start walks on the page. Last, so the neighbours other bundle checks read keep their order
      walkers: walkWorkerPort,
    })
  : null;
// a deposit carried from its checked address to its note with no tap (src/deposit-follow.ts, card wallet-deposit-follow):
// top-level only, as the seed signs U's call; the store and the seed are opened when a follow runs
const follows = !framed ? depositFollows({ network: () => PAGE_NETWORK, store: () => open(), seed64: () => openSeed64() }) : null;
// a pool quote's money carried from U_X into X's pool with no tap, and a refund of it carried back to U_X
// (src/pool-deposit-follow.ts, card pool-deposit-follow): top-level only; its chain reads are set below, where the pool
// kinds' pairs are made, and until then (or on a chain the page pins no pool on) an op waits for the next landing
let poolFollowDeps: PoolFollowHost["deps"] = () => null;
// the op a restore's U_X reads are taken under: it moves no refund (only the follow's refund carry asks these)
const UX_ONLY = { move: async () => undefined, record: async () => Promise.reject(new Error("a restore records no refund move")) };
const poolFollow = !framed
  ? poolFollows({
      store: () => open(),
      decimals: (c) => POOL_ASSET_DECIMALS[POOL_ADDRESS_ASSET[c]],
      deps: (f, op) => poolFollowDeps(f, op),
      // an ended op's U_X read again at a landing: a restore's paced reads, after a drawn wait (review P2-b of the delta)
      again: (chain) => restoreUxOf(chain, poolFollowDeps({ chain, s: "", i: 0, u: "", refund_id: "", address: "", deadline_ms: 0, origin: "", min_out: "" }, UX_ONLY), PAGE_SOL_PIN?.program, undefined, (c) => testnet?.evmPoolOf(c) ?? null),
      againWait: (signal) => poolAgainWait(signal),
    })
  : null;
// pool.withdraw's screen (src/withdraw/pool-form.ts): the chain the app named and the request's id, the op's id in state.ops
let poolWithdraw: { chain: PoolChain; opId: string } | null = null;
// a move out of Cash a reload cut short (src/cash-to-pool.ts resume, card one-balance-buys-on-every-chain): set where
// the mover is built, run at sign-in after the vault's withdrawals are settled
let resumeMoves: (() => Promise<void>) | null = null;
// Sign out (this tab's or another's) stops every quote's asks (card helper-says-why-a-vendor-refused, review P3):
// deposit.quote, pool.address and the deposit sheet's reads send nothing more, a re-ask's pause included.
const quotes = quotesStop();
const quotesStopped = quotes.stopped;
const quotesSignedOut = quotes.signedOut;
const quotesSignedIn = quotes.signedIn;
// declared before the API starts below (its kinds read quotesStopped)
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
  // over it, the sealed screens' ground, shown by the shell while the frame is out of the page (src/backdrop.ts)
  const ground = drawSealedGround(document, groundLogo(GROUND_LOGO_SVG));
  document.body.append(ground);
  // the pool kinds' deps: the network's pins and each chain's two RPCs, which the price reads use too (src/pool-price.ts)
  const poolDeps = testnetPoolDeps(testnet?.flow, testnet ? () => testnet.outSignal() : undefined);
  const prices = poolPrices({ rpcs: (chain) => poolDeps.rpcs(chain) as readonly [SolanaRpc, SolanaRpc] | null });
  // a page shown again reads its prices at once: hidden, it read only every 15 s (src/pool-price.ts)
  wakeWhenShown(document, prices);
  pagePrice = (chain) => prices.get(chain);
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
  // a NEAR buy and sell (src/near-buy.ts, card near-private-trading): the vault pays a fresh NEAR wallet from a picked
  // note, which buys on Rhea; its sell sells all of it back and moves the USDC into the vault; top-level only, as the
  // pool flow
  // one balance on every chain (src/cash-to-pool.ts, card one-balance-buys-on-every-chain): a Solana buy above one tap's
  // spend moves its shortfall from Cash first, through the deposit sheet's own quote into U_X (poolAddress, below) and
  // the vault's hand-off to its deposit address, then buys once one tap spends the ask (tapDry, below: the dry read
  // with no trade gate, since the tap's own run holds it)
  // one mover per signed-in session (its signal is the sign out's): a move on its way is never counted for another
  let cashMoverOf: { signal: AbortSignal; m: ReturnType<typeof cashMover> } | null = null;
  const cashMoverNow = (): ReturnType<typeof cashMover> => {
    const signal = withdrawWait.signal;
    if (cashMoverOf?.signal === signal) return cashMoverOf.m;
    const vault = { store: () => open(), notes: async () => openNoteStore(await open()), seed64: () => openSeed64(), prover: prover!.vault, signal };
    const form = withdrawFormDeps(vault);
    const handoff = withdrawHandoff(vault);
    const m = cashMover({
      price: (chain) => prices.get(chain),
      // NEAR Intents only: no Relay (a hop between pools ties two chains together, lite paper v2 §4)
      rails: ["1click"],
      quote: async (chain, usdc, id) => {
        const r = poolAddress({ chain, origin_asset: `nep141:${NEAR_NETWORKS.mainnet.usdc}`, amount: formatPoolUnits(usdc, 6) }, { id });
        await r.after;
        const a = r.answer();
        if (a === null || "error" in a) return { error: a === null ? "failed" : a.error };
        const q = a.result.quote;
        const amountIn = q === undefined ? null : parsePoolUnits(q.amount_in, 6);
        const minOut = q === undefined ? null : parsePoolUnits(q.min_amount_out, POOL_ASSET_DECIMALS[POOL_ADDRESS_ASSET[chain]]);
        if (q === undefined || amountIn === null || minOut === null) return { error: "quote_check_failed" };
        return { address: q.deposit_address, amountIn, minOut };
      },
      fee: () => form.fee(),
      cash: () => form.available(),
      handoff,
      // the quote's follow op ended: its money is in the pool (or refunded), no longer on its way
      landed: async (id) => {
        const op = await (await open()).get("ops", id).catch(() => undefined);
        return op !== undefined && poolFollowEnded(op as Parameters<typeof poolFollowEnded>[0]);
      },
      now: () => Date.now(),
      // the move op (kind "move", src/state.ts opOf): its stages from the hand-off, then from the quote's follow op
      put: async (id, rec) => void (await (await open()).put("ops", id, rec)),
      follow: async (id) => (await (await open()).get("ops", id).catch(() => undefined)) as MoveFollow | undefined,
      signal,
    });
    cashMoverOf = { signal, m };
    return m;
  };
  if (prover && withdrawHandoff({ store: () => open(), notes: async () => openNoteStore(await open()), seed64: () => openSeed64(), prover: prover.vault }) !== null)
    resumeMoves = async () => {
      const st = await open();
      const moves: { id: string; rec: MoveOpRecord }[] = [];
      for (const id of await st.keys("ops")) {
        const rec = (await st.get("ops", id).catch(() => undefined)) as MoveOpRecord | undefined;
        if (rec?.kind === "move") moves.push({ id, rec });
      }
      cashMoverNow().resume(moves);
    };
  // pool.buy.dry with with_cash on Solana (src/cash-to-pool.ts withCash): the dry answer as it is, plus Cash's largest
  // note less the relayer's fee at the device's price and what moves on their way bring; a read that fails leaves it out
  const dryWithCash = (params: Record<string, unknown>) => {
    const r = poolBuyDry(params);
    if (!prover || params.chain !== "solana" || withdrawHandoff({ store: () => open(), notes: async () => openNoteStore(await open()), seed64: () => openSeed64(), prover: prover.vault }) === null) return r;
    let extra: string | null = null;
    const after = r.after.then(async () => {
      const a = r.answer();
      if (a === null || !("result" in a)) return;
      const vault = { store: () => open(), notes: async () => openNoteStore(await open()), seed64: () => openSeed64(), prover: prover.vault, signal: withdrawWait.signal };
      const form = withdrawFormDeps(vault);
      const [cash, fee] = await Promise.all([form.available(), form.fee()]);
      extra = withCash(a.result.tap_max, cashMoverNow().coming("solana"), cash, fee, prices.get("solana"));
    }).catch(() => {});
    return {
      running: true as const,
      after,
      answer: () => {
        const a = r.answer();
        return a !== null && "result" in a && extra !== null ? { ...a, result: { ...a.result, with_cash: extra } } : a;
      },
    };
  };
  const cashDeps = (): CashToPoolDeps => ({
    // Cash's largest note (the note store, on the device) or a move on its way
    any: async () => {
      if (cashMoverNow().coming("solana") > 0n) return true;
      const vault = { store: () => open(), notes: async () => openNoteStore(await open()), seed64: () => openSeed64(), prover: prover!.vault, signal: withdrawWait.signal };
      return (await withdrawFormDeps(vault).available().catch(() => 0n)) > 0n;
    },
    tapMax: async (token) => {
      const r = tapDry({ chain: "solana", token });
      await r.after;
      const a = r.answer();
      return a !== null && "result" in a ? (parsePoolUnits(a.result.tap_max, 9) ?? 0n) : 0n;
    },
    need: (short) => cashMoverNow().need("solana", short),
    wait: (ms) => new Promise((res) => setTimeout(res, ms)),
    now: () => Date.now(),
    signal: withdrawWait.signal,
  });
  const poolKindMap = poolKinds(prover ? { ...poolDeps, near: { buy: (ask, ctx) => nearBuyKind(nearBuyPage()!)(ask, ctx), sell: (ask, ctx) => nearSellKind(nearBuyPage()!)(ask, ctx) }, ...(withdrawHandoff({ store: () => open(), notes: async () => openNoteStore(await open()), seed64: () => openSeed64(), prover: prover.vault }) === null ? {} : { cash: cashDeps }) } : poolDeps);
  // the sell box's preview (src/pool-sell-dry.ts): the positions pass's holding as held, the sale's own quote on the
  // trades' paced pair as background reads, never while a trade runs: a pool buy from its tap to its first answer (its
  // early "sent", the app's Filled; its read-backs to Final hold no host), a pool sell from its tap to its run's end
  // (liveRuns), or a trade holds a host of the pair (the lanes)
  const buys = liveRuns(poolKindMap["pool.buy"]);
  poolKindMap["pool.buy"] = buys.kind;
  const sells = liveRuns(poolKindMap["pool.sell"]);
  poolKindMap["pool.sell"] = sells.kind;
  // a deposit and a withdraw do not hold the hosts as a trade does, but each changes what the preview read (the trees'
  // sizes, which price the sale's deposit rents; a W's lamports): their starts and ends are counted with the trades'
  const deposits = liveRuns(poolKindMap["pool.deposit"]);
  poolKindMap["pool.deposit"] = deposits.kind;
  const withdraws = liveRuns(poolKindMap["pool.withdraw"]);
  poolKindMap["pool.withdraw"] = withdraws.kind;
  const dryPair = (): readonly [SolanaRpc, SolanaRpc] | null => (PAGE_SOL_PIN === undefined ? null : pageSolanaRpcs("pass"));
  const poolSellDry = poolSellDryKind({
    pinned: (chain) => poolDeps.pinned(chain),
    rpcs: dryPair,
    positions: () => testnet?.positionsNow() ?? null, pin: () => PAGE_SOL_PIN ?? null,
    // the Ws bought since the last whole pass, as the sale's plan finds them (the preview reads each as the sale does)
    bought: (token) => testnet?.boughtSince(token) ?? Promise.resolve(undefined),
    decimals: PAGE_TOKEN_DECIMALS,
    // the sale's priority fee on mainnet (pool-sell.ts solanaSellBudget), in You receive and Network
    cluster: PAGE_CLUSTER,
    // the Rent sysvar state.pools' tap_max already reads, once; none yet: the preview reads it on both
    rent: () => (hasSolana ? rent.get() : null),
    trading: () => buys.live() + sells.live() > 0 || (dryPair() ?? []).some((r) => r.url !== undefined && hostLane(r.url).trading()),
    // every start and end of a pool trade of this page: nothing a preview read before it is used after it
    trades: () => buys.edges() + sells.edges() + deposits.edges() + withdraws.edges(),
  });
  // Max for the coin on screen (src/pools.ts poolBuyDryKind): state.pools' tap_max on the coin's own venue, read on the
  // same paced pair as background reads, never while a trade runs; the notes and ready proofs as state.pools reads them
  const poolBuyDry = poolBuyDryKind({
    pools: PAGE_POOLS,
    rpcs: dryPair,
    rent: () => (hasSolana ? rent.get() : null),
    ready: async () => {
      if (!testnet || !(await fs.state()).signed_in) return null;
      const both = await testnet.readyWith(pageNotes);
      return { notes: both.value, ready: both.ready, open: both.open, landed: both.landed };
    },
    trading: () => buys.live() + sells.live() > 0 || (dryPair() ?? []).some((r) => r.url !== undefined && hostLane(r.url).trading()),
  });
  // the same read for a moving tap (cashDeps.tapMax): never refused busy, since the tap that asks is the trade
  const tapDry = poolBuyDryKind({
    pools: PAGE_POOLS,
    rpcs: dryPair,
    rent: () => (hasSolana ? rent.get() : null),
    ready: async () => {
      if (!testnet || !(await fs.state()).signed_in) return null;
      const both = await testnet.readyWith(pageNotes);
      return { notes: both.value, ready: both.ready, open: both.open, landed: both.landed };
    },
    trading: () => false,
  });
  // a pool quote's price reads (pool-deposit-address.ts priced): USDC in at 1 USD on both reads, X's coin at the page's
  // own Pyth read on its two RPCs (src/pool-price.ts), X's own coin on X (a plain send) at that read; any other origin
  // has none yet, so it gets no quote
  const pricedFor = (chain: PoolChain, origin: string): PoolQuotePricing | null => poolQuotePricing(prices.get(chain), origin, chain);
  const solPair = (): readonly [SolanaRpc, SolanaRpc] | null => (PAGE_SOL_PIN === undefined ? null : (poolDeps.rpcs("solana") as unknown as readonly [SolanaRpc, SolanaRpc] | null));
  // Base's and Robinhood's pool for a quote into U_X (card evm-deposit-route-mainnet): the pool the page's network pins
  // there (the wallet's EVM_POOLS, src/pool-testnet.ts evmPoolOf: its pin and the deposit's own pair) and the one reader
  // U_X's balance is polled on: on a testnet page the pool's pair (no reader: no quote is asked there, 1Click pays out on
  // mainnet only); on mainnet the helper's POST /v1/rpc/{chain} alone (decision M359: a one-time account's holdings
  // never reach a public provider from the device), src/pool-testnet.ts pageEvmWalletRpc, none on a testnet page. With
  // no pool, or on mainnet with no reader: no floor, so no quote, and no follow
  const evmWalletRpc = (chain: "base" | "robinhood"): EvmRpc | undefined => pageEvmWalletRpc(chain);
  const evmRoute = evmQuoteRoute({ network: PAGE_NETWORK, pool: (chain) => testnet?.evmPoolOf(chain) ?? null, wallet: evmWalletRpc, notes: () => pageNotes() });
  // the quote's floor on X's pool, read now on its two RPCs (pool-deposit-address.ts readSolanaPoolFloor on Solana,
  // readEvmPoolFloor on Base and Robinhood); none on a chain the page pins no pool on
  // A sign out ends the Solana read before its fee read, which names U_X (the EVM floor names no account)
  const floorFor = async (chain: PoolChain, wallet: string, signal?: AbortSignal): Promise<bigint | null> => {
    if (chain !== "solana") return evmRoute.floor(chain);
    const pair = solPair();
    return pair !== null && PAGE_SOL_PIN !== undefined ? readSolanaPoolFloor(pair, PAGE_SOL_PIN.program, wallet, signal) : null;
  };
  // where money for a pool goes (src/pool-deposit-address.ts), for a moving tap (cashMoverNow): the same host as the
  // deposit sheet's pool.address below, on the same reads, floor and follow
  const poolAddress = poolAddressHost({ pools: pageAddressPools, network: PAGE_NETWORK, read: fs.depositRead, named: () => namer.named(), priced: pricedFor, floor: floorFor, checked: (id, chain, quote, u) => poolFollow!.quoted(id, chain, quote, u), stop: quotesStopped });
  const nearPair = () => [followRpc(NEAR_NETWORKS.mainnet.fastnear[0]), followRpc(NEAR_NETWORKS.mainnet.drpc)] as const;
  // from U_X alone (review H1): pool.deposit run with the op's own U_{s,i} as its fixed source, never the newest U
  const depositFromUx = (g: PoolFollowRecord, amount: bigint, signal: AbortSignal) =>
    depositToEnd((p, ctx) => (testnet === null ? null : testnet.depositFrom(p, { s: BigInt(g.s), i: g.i, u: g.u }, ctx as KindContext)), g.chain, POOL_ASSET_DECIMALS[POOL_ADDRESS_ASSET[g.chain]], amount, signal);
  // a landed note of U_X's own in this page's store (review P2a): a follow resumed while a rung was landing ends
  const uxNoted = async (g: PoolFollowRecord) => uxNoteLanded(await pageNotes(), g);
  // a note of U_X's still landing holds in_pool and the end on every chain (card evm-deposit-route-mainnet review)
  const uxOpen = async (g: PoolFollowRecord) => uxNoteOpen(await pageNotes(), g);
  // the refund carry, at X's pool's floor read now
  const refundAt = (floor: (g: PoolFollowRecord) => Promise<bigint>, op: Parameters<PoolFollowHost["deps"]>[1]) =>
    poolRefundMover({
      read: (g, nonce) => readMoveAt("intents.near", g.refund_id, nonce, g.origin, nearPair(), NEAR_NETWORKS.mainnet.usdc),
      floor,
      priced: (g) => pricedFor(g.chain, g.origin),
      decimals: (c) => POOL_ASSET_DECIMALS[POOL_ADDRESS_ASSET[c]],
      seed64: () => openSeed64(),
      seedLock: (fn) => navigator.locks.request(WALLET_SEED_LOCK, { mode: "shared" }, fn),
      move: op.move,
      record: op.record,
    });
  poolFollowDeps = (f, op) => {
    if (f.chain !== "solana") {
      const d = evmRoute.deps(f.chain, depositFromUx, (floor) => refundAt(floor, op));
      return d === null ? null : { ...d, noted: uxNoted, open: uxOpen };
    }
    const pair = solPair();
    if (pair === null || PAGE_SOL_PIN === undefined) return null;
    const program = PAGE_SOL_PIN.program;
    return { ...solanaPoolFollowDeps({ rpcs: pair, program, deposit: depositFromUx, refund: refundAt(async (g) => readSolanaPoolFloor(pair, program, g.u), op) }), noted: uxNoted, open: uxOpen };
  };
  // a buy or a sell from the trade box (src/trade.ts): legs from this device's own arm records only, signed here
  const trades = tradeKind({ store: () => open(), seed64: () => openSeed64(), deps: releaseTradeDeps() });
  shell = mountShell(document, {
    // reload waits for a running trade; sign out does too, in every tab (the trade holds the seed lock shared)
    settle: () => trades.idle(),
    ground,
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
        // a trade no tab is running that the store shows open or marked (any tab's: a leg unknown, a lost write, a
        // closed tab) is settled at each state read until none is left (src/trade.ts tradeSettleDue), no reload needed
        if (s.signed_in) void settleTrades(true);
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
        // and each U_X a follow left money at (card deposit-takes-each-pools-own-coin): the ops read after those notes, from
        // the store alone, so a carry the pools count is never listed too (pool-deposit-follow.ts depositWalletsOf)
        const pooled = await withPools(withVault, shared, r === null ? PAGE_POOLS : withSolanaRent(PAGE_POOLS, r), both?.ready, prices.get, both?.open, both?.landed, both?.making).then(async (p) =>
          !p.signed_in || PAGE_POOLS.length === 0 ? p : withDepositWallets(p, depositWalletsOf(await pageOps().catch(() => []), (c) => POOL_ASSET_DECIMALS[POOL_ADDRESS_ASSET[c]], (c) => POOL_ADDRESS_ASSET[c])),
        );
        prices.refresh((pooled.pools ?? []).map((p) => p.chain));
        // the tokens the pool's buys hold (src/positions.ts, card signpage-state-holdings): the last whole pass, never a
        // chain read inside this state read; the first signed-in read starts one, and a buy's or sell's end the next
        const sol = s.signed_in && testnet ? await testnet.positions() : null;
        // and NEAR's, from the buys' own records (src/near-buy.ts nearPositions): a record read, never a chain read
        const nearPage = s.signed_in ? nearBuyPage() : null;
        const near = nearPage ? await nearPositions(nearPage).catch(() => []) : [];
        const positioned = withPositions(pooled, sol === null && near.length === 0 ? null : [...(sol ?? []), ...near]);
        // the Ws whose money waits for its rent back, on their way (src/positions.ts returningWallets): a store read
        const owed = s.signed_in && testnet ? await testnet.returning().catch(() => []) : [];
        // the notes the balance counted, so a W whose sweep's note is counted is not listed too
        const counted = owed.some((o) => o.sweep !== undefined) ? await shared().catch(() => null) : [];
        return withReturning(positioned, returningWallets(owed, prices.get("solana"), counted));
      }),
    // a store change, a new price read (or its next one due), the Rent read landing and a proof made
    watch: (fn) => {
      fs.watch(fn);
      prices.watch(fn);
      told.add(fn);
      testnet?.watch(fn);
    },
    // deposit.quote's checked answer followed (its host's `checked`), deposit.confirm answered where it is (src/deposit-follow.ts)
    kinds: whileSignedIn(follows!.withFollow({
      // src/pages/open.ts decides what each draws, from the page's own state and store. The answer goes first, then the
      // layer opens (and the frame leaves).
      // each with its request's id: the layer it opens tells the app when it has closed (src/shell.ts)
      "signin.open": (p, ctx) => openKind(ctx.id, "signin.open", p.way),
      signout: (_p, ctx) => openKind(ctx.id, "signout"),
      "backup.open": (_p, ctx) => openKind(ctx.id, "backup.open"),
      // the form withdraws from the vault's notes; with a one-time id (from_id) the held deposit's way out
      "withdraw.open": (p, ctx) => (takesParams("withdraw.open", p) ? openKind(ctx.id, "withdraw.open", undefined, typeof p.from_id === "string" ? p.from_id : undefined) : null),
      // from public records only (src/deposit-wire.ts): U named ahead by this page (src/deposit-name.ts), never the seed
      "deposit.quote": depositQuoteHost({ scope: pageScope, read: fs.depositRead, named: () => namer.named(), checked: (id, r, u) => follows!.quoted(id, r, u), stop: quotesStopped }),
      // the deposit sheet's reads before any address (src/deposit-wire.ts depositReadHosts): public data only
      ...depositReadHosts({ stop: quotesStopped, poolFloor: pagePoolFloor }),
      // where money for a pool goes (src/pool-deposit-address.ts): U_X from its scope's public record, named ahead by this
      // page; a quote from another chain at the device's own price reads and floor, its address only once the follow
      // took it (src/pool-deposit-follow.ts), on mainnet only
      "pool.address": poolAddressHost({ pools: pageAddressPools, network: PAGE_NETWORK, read: fs.depositRead, named: () => namer.named(), priced: pricedFor, floor: floorFor, checked: (id, chain, quote, u) => poolFollow!.quoted(id, chain, quote, u), stop: quotesStopped }),
      buy: trades,
      // the pool kinds (src/pool-kinds.ts): each checked by src/rules/pool.ts, answered only on a pool this page's
      // network pins (src/pool-testnet.ts, whose flow runs deposit, buy, sell and withdraw on every build; a network with
      // no pin, mainnet until its pools deploy, refuses every one not_allowed and makes no read); a sell's decimals read
      // on two providers
      ...poolKindMap,
      "pool.sell.dry": (params) => poolSellDry(params),
      // with_cash (card one-balance-buys-on-every-chain): a tap's most with Cash moved first, on Solana
      "pool.buy.dry": (params) => dryWithCash(params),
      // a move between Cash and a pool (card one-balance-buys-on-every-chain): the same mover a buy's shortfall takes
      ...(prover && withdrawHandoff({ store: () => open(), notes: async () => openNoteStore(await open()), seed64: () => openSeed64(), prover: prover.vault }) !== null ? poolMoveKinds(cashMoverNow) : {}),
      // the rebuild from the chain (src/pool-restore.ts): answered started, its stages in state.ops and as progress
      ...(restore ? { restore: restore.kind } : {}),
    })),
  });
  shell.body.append(root);
  // the user's own Esc, close tap or scrim tap: Cancel's step, on a screen Cancel is drawn on (show() below). Esc leaves
  // the backup alone while its 12 words are on the clipboard: a key gives no activation for the write that clears them on
  // Firefox and Safari, so the x, the scrim, Cancel and Saved (taps) leave it then
  shell.onDismiss = (by) => {
    if (by === "key" && copied) return;
    void run(cancel);
  };
}

// Every kind the shell answers, refused not_allowed from a sign out's tap to its end (`leaving`): no new run starts on an
// account that is going (card sign-out-stops-the-pages-reads)
function whileSignedIn<K extends Record<string, ((...a: never[]) => unknown) | undefined>>(kinds: K): K {
  return Object.fromEntries(Object.entries(kinds).map(([k, f]) => [k, f === undefined ? f : (...a: never[]) => (leaving ? null : f(...a))])) as K;
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
function openKind(id: string, kind: AccountKind, way?: unknown, fromId?: string): OpenAnswer | { after: Promise<void>; answer: () => OpenAnswer } | null {
  if (resyncing) return { after: resynced(), answer: () => decide(id, kind, way, fromId) };
  return decide(id, kind, way, fromId);
}
async function resynced(): Promise<void> {
  while (resyncing) await resyncing;
}
// `closes`: the layer the open shows tells the app when it has closed (src/shell.ts); src/kit-version.ts takes it from an
// app below the kit's own version, which reads no such notice
type OpenAnswer = { result: { pending: true; closes: true }; then: () => void } | null;
function decide(id: string, kind: AccountKind, way: unknown, fromId?: string): OpenAnswer {
  // a sheet shown already is never redrawn by the app: a kind the frame sent before it opened is refused
  if (sheetShown() || !takes(kind, root.dataset.signin, busy)) return null;
  return {
    result: { pending: true, closes: true },
    then: () =>
      runOpen(id, async (layer) => {
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
        layer();
      }),
  };
}
// pool.withdraw (card signpage-pool-withdraw-form), top-level only and only with a seed stored, as withdraw.open: the
// answer goes first, then the screen where the user types To and the amount, never passed in by the app; the run's
// stages go to the op under the request's id.
function openPoolWithdraw(chain: PoolChain, opId: string): { result: { pending: true; closes: true }; then: () => void } | null {
  if (framed || !testnet || sheetShown() || !takes("withdraw.open", root.dataset.signin, busy)) return null;
  return {
    result: { pending: true, closes: true },
    then: () =>
      runOpen(opId, async (layer) => {
        poolWithdraw = { chain, opId };
        show("pool-withdraw");
        layer();
      }),
  };
}
// An open answered closes: true (card signing-layer-says-when-it-closes, review P2-1) is told exactly once on every
// ending: by its layer's close when `layer()` opened one for it, else, once its run has ended (a page it does not show:
// signed in or out already, no held op; a read that failed; a run that never started, the page busy), by the shell as a
// close would tell it, PROTECT_MS after, never sooner. The app's document going (a reload) is the one ending that tells
// nothing.
function runOpen(id: string, step: (layer: () => void) => Promise<void>): void {
  let layered = false;
  void run(() =>
    step(() => {
      openLayer(id);
      layered = true;
    }),
  ).finally(() => {
    if (!layered) shell?.told(id);
  });
}
const sheetShown = (): boolean => shell !== null && !shell.layer.hidden;
// The layer opens for the open kind of request `id`, and the activation guard restarts its 500 ms: a click lined up
// before cannot act on what it shows.
function openLayer(id: string): void {
  shell?.open(SEALED.has(root.dataset.signin ?? ""), id);
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

// each show() draws only if no later one came before its fields could be made
let shows = 0;
function show(state: State, seed?: { account: string; code_saved: boolean; signout: boolean }, words?: string): void {
  // a screen with a field typed into, or the 12 words shown, drawn on an open sheet: the frame out of the document before
  // any of its fields is (src/frame-cover.ts)
  if (SEALED.has(state)) shell?.seal();
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
  // back to the app from any sign-in screen; the backup's words stay until Saved or a sign-in elsewhere
  // and from a backup or sign-out page an open kind drew over a signed-in account (the words saved or not, as they were)
  const cancellable = state !== "loading" && state !== "signed-in" && (state !== "backup" || openedBy === "backup.open" || openedBy === "signout");
  shell?.dismissible(cancellable);
  const at = ++shows;
  const draw = (): void => {
    if (at !== shows) return;
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
        parts.push(button("copy", WORDS.copy, () => {
        copied = true;
        void navigator.clipboard?.writeText(words).catch(() => {});
      }));
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
    if (shell && cancellable) parts.push(button("cancel", WORDS.cancel, () => void run(cancel)));
    root.replaceChildren(...parts);
  };
  // a sealed screen's fields (the 12 words' area, To and the amount, the account, the 12 words and their Copy) are made
  // only once the APP_HOST frame is out of the page: an open kind draws its screen while the layer is still hidden and
  // the frame in, then opens the layer, which takes the frame out (openLayer); the fields come in that task, never before
  // (src/shell.ts whenOut). A later show() before then draws instead (shows).
  if (shell && SEALED.has(state)) {
    root.replaceChildren();
    shell.whenOut(draw);
  } else draw();
}

// The withdraw form's reads on the build's network (src/withdraw/handoff.ts): the note value over the note store, the
// relayer's fee bounded by the device's fee_max, and the hand-off where the release names a relayer (the vault pays the
// typed account straight, card wallet-withdraw-move-out); with the last settle pass's drifts, shown on the form.
function withdrawDeps() {
  const page = { store: () => open(), notes: async () => openNoteStore(await open()), seed64: () => openSeed64(), prover: prover!.vault, signal: withdrawWait.signal };
  return { ...withdrawFormDeps(page), unmatched: () => withdrawsUnmatched };
}
// The NEAR buy's page (src/near-buy.ts): the withdraw form's fee, hand-off and settle pass on the build's network, its
// release pair at the provider's pace, and the candidate Rhea pools read once a session (src/near-pools.ts).
// Made at its first use (a tap or the load's settle), never while the module is read: it names the sign out's signal
// and the seed lock, defined further down.
let nearPageMade: NearBuyPage | null | undefined;
function nearBuyPage(): NearBuyPage | null {
  if (nearPageMade !== undefined) return nearPageMade;
  if (!prover) return (nearPageMade = null);
  const vault = () => ({ store: () => open(), notes: async () => openNoteStore(await open()), seed64: () => openSeed64(), prover: prover.vault, signal: withdrawWait.signal });
  const net = NEAR_NETWORKS[PAGE_NETWORK];
  // the FastNEAR seat is the helper's (FastNEAR's key at its pace, FastNEAR's keyless URL its spare: nearSeatRpc), dRPC
  // device-direct (card near-quote-under-the-pace)
  const pair = [nearSeatRpc(PAGE_NETWORK), pacedNearRpc(net.drpc)] as const;
  return (nearPageMade = {
    network: PAGE_NETWORK,
    store: () => open(),
    notes: async () => openNoteStore(await open()),
    seed64: () => openSeed64(),
    seedLock: heldSeedLock,
    fee: () => withdrawFormDeps(vault()).fee(),
    // the hand-off on the sign out's signal of the moment it is asked
    handoff: withdrawHandoff(vault()) === null ? null : (w, fee, note) => withdrawHandoff(vault())!(w, fee, note),
    settle: () => withdrawSettle(vault()),
    rpcs: () => pair,
    signal: () => withdrawWait.signal,
    pools: rheaPoolsKept(PAGE_NETWORK, () => pair),
    log: (line) => console.info(line),
  });
}
// The NEAR buy records rebuilt from the chain (card near-holdings-restore): one pass at a time, on each landing and after
// each restore's NEAR walk; it never throws, a read it could not make is read on the next pass. `fresh` (a restore or a
// Sync): every W one seat answer read empty is read again; asked while a pass runs, it runs once that one ends
let nearHoldingsRun: Promise<void> | null = null;
function nearHoldings(page: NearBuyPage, fresh = false): Promise<void> {
  if (fresh && nearHoldingsRun !== null) return nearHoldingsRun.then(() => nearHoldings(page, true));
  return (nearHoldingsRun ??= nearHoldingsPass(page, { fresh })
    .then((p) => void (p.unread.length > 0 && console.warn(`near holdings unread: ${p.unread.length}, read again on the next load`)))
    .catch((e: unknown) => console.warn(`near holdings: ${e instanceof Error ? e.name : "failed"}`))
    .finally(() => (nearHoldingsRun = null)));
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
      if (walletSeedMoved(e)) moved += 1;
      // a delete or upgrade closed our connection: the next step opens the store again
      // the follows ran on that connection: they end (U's lock freed) and start again on the store opened next
      if (e.kind === "closed") (store = null), (followsClosed = true), follows?.storeClosed(), poolFollow?.stop();
      if (e.kind !== "signout") return;
      store = null;
      followsClosed = false;
      openedBy = null;
      signedOutElsewhere();
      show("signed-out");
    },
  }));
  if (had === null && followsClosed) (followsClosed = false), void follows?.settle(), void poolFollow?.settle().catch(() => {});
  return s;
};

// The store only while one is open: the pool syncs' holds (src/pool-testnet.ts TestnetPage.held), so a round still
// running after a sign out, here or on another tab, never makes the store again (review of 7eb8cfb9, P2-2).
const opened = (): Promise<WalletStore> => (store !== null ? Promise.resolve(store) : Promise.reject(new Error("no wallet store is open")));
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
  // another tab signed out: every read of the account stops now, the proof queue and its seed copy go
  if (e.kind === "signout") signedOutElsewhere();
  void resync();
}
// Another tab's sign out, heard on the shell's channel (storeMoved) or the store's own (open's onEvent), whichever comes
// first, each a task of its own: every read of the account stops in the one task that hears it (card
// sign-out-stops-the-pages-reads: the shell's channel, first, stopped the lanes' waits alone, and the restore's reads,
// a page refused by that stop halved and asked again, went on until the store's channel's task). The restore, the
// follows and the withdrawals first, then the pool flow, whose stop ends every wait for a turn on a host.
function signedOutElsewhere(): void {
  // this tab's own sign out is heard here too (the shell's channel carries the store's post): its own path reloads once
  // the database is deleted
  if (leaving) return;
  // the gate first: nothing past the page's origin leaves from here on, whatever is still running; then the page
  // reloads signed out
  closeHostLanes();
  quotesSignedOut();
  restore?.signedOut();
  follows?.signedOut();
  poolFollow?.stop();
  withdrawsSignedOut();
  void testnet?.signedOut();
  // a NEAR seat taken for down is this session's: the next one asks it again
  seatsUp();
  reloadSignedOut();
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
// the pools pool.address gives a U_X for: those whose withdraw this build carries (src/pool-testnet.ts poolWayOut, card
// evm-deposit-on-mainnet), so money is never sent to an address the page cannot take it out of
function pageAddressPools(): { chain: PoolChain; scope: bigint }[] {
  return pagePoolScopes().filter((p) => poolWayOut(p.chain));
}
// deposit.assets' minimum for each pool's own coin (card deposit-takes-each-pools-own-coin): the pool's floor read now on
// its two RPCs, as pool.address reads it (one deposit's worst-case cost from U_X and the rent U_X keeps), on a pool
// pool.address answers; no U_X named (the Solana fee message is priced at POOL_FLOOR_PLACEHOLDER). The frame and the
// top-level page alike: a function declaration, held by the kinds made above this line
async function pagePoolFloor(chain: PoolChain, signal?: AbortSignal): Promise<bigint | null> {
  if (!pageAddressPools().some((p) => p.chain === chain)) return null;
  if (chain === "solana") return PAGE_SOL_PIN === undefined ? null : readSolanaPoolFloor(pageSolanaRpcs("pass"), PAGE_SOL_PIN.program, POOL_FLOOR_PLACEHOLDER, signal);
  const e = pageEvmFloorPool(chain);
  return e === null ? null : readEvmPoolFloor(e.rpcs, e.pin);
}
const namer = depositNamer({
  top: !framed,
  scope: pageScope,
  pools: pagePoolScopes,
  open,
  startup: () => startup,
  resyncing: () => resyncing,
  // a pool's U_X that still holds what its follow left stays named (review P1 of card deposit-takes-each-pools-own-coin):
  // from the store alone, its newest op (uxHeldOf), never a chain read: the namer runs at every note change, a buy's and
  // a sell's too, and a read naming U_X then would tie U_X to W (review P2-a of the delta)
  held: async (chain, rec) => {
    const u = walletOf(chain, rec);
    if (u === null) return false;
    return uxHeldOf(await pageOps(), chain, u);
  },
});
// state.pools' notes (src/pools.ts): read only, with the wallet's readNotes on this page's own wallet store: no Web Lock,
// no write, so a state read never frees a note or finishes a parent (the note store's own paths do). Top-level only, as
// the frame keeps no note data. A function declaration, as the shell's state, made at the top, holds it.
async function pageNotes(): Promise<NoteRecord[]> {
  return readNotes(await open());
}
// the ops store's records, read only (state.deposit_wallets, and the namer's held: pool-deposit-follow.ts uxHeldOf)
async function pageOps(): Promise<unknown[]> {
  const st = await open();
  return Promise.all((await st.keys("ops")).map((k) => st.get("ops", k).catch(() => undefined)));
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

// The trade ops a closed page or an unknown leg left open, settled from their wallets' marks (src/trade.ts
// settleTradeOps): one pass at a time, on the store bounded as a pick's is (timedStore), on its own paced pair. At a state
// read (`ifDue`) the pass runs only when the store shows one due (tradeSettleDue); that read is inside the same one-pass
// guard and on the same timed store, so a slow store never piles reads up (re-check of efd3845d, P3-b).
let tradeSettling: Promise<void> | null = null;
function settleTrades(ifDue = false): Promise<void> {
  if (framed || !globalThis.navigator?.locks) return Promise.resolve();
  return (tradeSettling ??= open()
    .then(async (s) => {
      const st = timedStore(s, TRADE_STORE_MS);
      if (!ifDue || (await tradeSettleDue(st, navigator.locks))) await settleTradeOps(st, navigator.locks, releaseTradeDeps().providers);
    })
    .catch(() => {})
    .finally(() => (tradeSettling = null)));
}

// Where a sign-in landed (words.ts): the backup screen for a no-PRF seed this sign-in made, else signed in on the seed
// stored, which may be another tab's (never its words then).
async function landed(l: Landing): Promise<void> {
  // a page whose gate a sign out closed lands nowhere: it reloads, and the load lands on the store as it stands
  if (hostLanesClosed()) return void (l.seed.entropy.fill(0), location.reload());
  // signed in again: the page's quotes ask from now (src/quotes-stop.ts)
  quotesSignedIn();
  namer.name(l.seed.entropy);
  // a deposit a reload cut short is finished now (src/pool-testnet.ts), not at the next ask; once the landing's naming
  // is written (card sol-pools-mainnet-pin, review P3-3): the run holds the seed lock shared across its RPC reads, which
  // the naming's write waited out while it asked the lock exclusive, and a deposit.quote waits for the naming
  // (deposit-name.ts named), so a settle started first held the quote for as long as its reads took (3.28 s with both
  // RPCs answering 503). The write takes the lock shared now (card deposit-landing-does-not-queue-a-trade), so it no
  // longer waits on the settle; the order is kept.
  void namer.named().then(() => testnet?.settle()).catch(() => {});
  // a NEAR deposit followed on from its stage (src/deposit-follow.ts)
  void follows?.settle().catch(() => {});
  // a pool quote's money followed on into its pool from its stage (src/pool-deposit-follow.ts); a load reads every
  // ended op's U_X once, paced (a send to an old address is carried from the next load on)
  void poolFollow?.settle({ load: true }).catch(() => {});
  // a vault withdrawal a reload cut short is followed to settled (src/withdraw/handoff.ts withdrawSettle)
  // then a NEAR buy a reload cut short goes on from its record (src/near-buy.ts), after its payout's note is settled
  void settleWithdraws()
    .catch(() => {})
    .then(() => {
      const page = nearBuyPage();
      // then a NEAR sell a reload cut short, from the same records; after both, a W the store holds no record of (a sign
      // out, another device's buy) gets its record back (src/near-buy.ts nearHoldingsPass), behind the trades' own reads,
      // and a USDC-only W it rebuilt goes home
      return page ? resumeNearBuys(page).then(() => resumeNearSells(page)).then(() => nearHoldings(page)).then(() => resumeNearSells(page)) : undefined;
    })
    .catch(() => {})
    // then a move out of Cash a reload cut short follows its quote's follow op on (src/cash-to-pool.ts resume)
    .then(() => resumeMoves?.())
    .catch(() => {});
  // a held deposit's move out a reload cut short (src/withdraw/held.ts)
  void settleHeld().catch(() => {});
  // a restore a closed or reloaded page left running reads stalled, so the app offers Retry; then the load walks every
  // pool once as a pass, after its first proof pass, and reads step 5 again when a page closed before it read every id,
  // with no tap and no sheet (src/pool-restore.ts resume, RESTORE_IDS_KEY)
  void restore?.settle().then(() => restore?.resume()).catch(() => {});
  // a buy or sell a closed or reloaded page left open is settled from its wallets' marks, or refused when it sent
  // nothing (src/trade.ts settleTradeOps): the app's Sell never waits on an op no page will end
  void settleTrades();
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
// Copy put the 12 words on the clipboard (marked at its tap, before the write lands): they are written over with nothing
// once, in the tap that leaves the backup (Saved, Cancel, the x, the scrim: saved() and cancel() run in it; Esc does not
// leave it while they are copied, as a key gives no activation for the write on Firefox and Safari). Every way off the
// backup is one of those taps. A refused write is let go; with no Copy the clipboard is left alone. Known limit: closing
// or reloading the tab clears nothing, on any engine (no write is let through as a page goes).
let copied = false;
function uncopy(): void {
  if (!copied) return;
  copied = false;
  void navigator.clipboard?.writeText("").catch(() => {});
}
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
  uncopy();
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
  uncopy();
  const s = shell ? await readSeed().catch(() => undefined) : undefined;
  if (s) return show("signed-in", shown(s));
  // the error screen, and a sealed one (the 12 words' field, Invalid code), is not left in the hidden screen: the words
  // typed there go with it
  if (root.dataset.signin === "error" || SEALED.has(root.dataset.signin ?? "")) show(typeof PublicKeyCredential === "undefined" ? "unsupported" : "signed-out");
  closeLayer();
}

async function signOut(): Promise<void> {
  topLevelOnly();
  const s = await open();
  // from the tap: no new run starts here (whileSignedIn)
  leaving = true;
  // no quote asks again once Sign out is tapped, until the page is signed in again (src/quotes-stop.ts)
  quotesSignedOut();
  // a restore holds the seed lock shared, which the sign out waits for: it stops first
  restore?.signedOut();
  // a deposit's follow stops too: its op stays at its stage (src/deposit-follow.ts)
  follows?.signedOut();
  poolFollow?.stop();
  withdrawsSignedOut();
  // a Solana or EVM pool settle holds the seed lock shared, which the sign out waits for: each stops first
  testnet?.signingOut();
  // the gate closes once the store holds the seed lock exclusive, after its refusals: a money run that held the lock
  // shared ran to its end with its reads open
  const refused = await s.signOut({ locked: () => closeHostLanes() }).then(
    () => null,
    (e: unknown) => ({ e }),
  );
  if (refused !== null) {
    // refused before the lock's end (the backup first) with this account's seed still stored: still signed in, the
    // handle open and held; refused with none (another tab signed out first, the store closed) or past the gate's
    // close: signed out
    const still = hostLanesClosed() ? undefined : await readSeed().catch(() => undefined);
    if (still !== undefined) {
      still.entropy.fill(0);
      leaving = false;
      // still signed in: its quotes ask again
      quotesSignedIn();
      throw refused.e;
    }
    return reloadSignedOut();
  }
  store = null;
  seatsUp();
  // after the store signed out: a deposit that landed while it waited cannot open the queue again (no seed)
  await testnet?.signedOut();
  // signed out: the page reloads, and with it the app, which then shows signed out
  reloadSignedOut();
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
    kinds: { ...depositReadHosts({ stop: quotesStopped, poolFloor: pagePoolFloor }) },
  });
}
