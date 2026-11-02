// Naming U ahead on SIGN_HOST's top-level page (card signpage-deposit-quote-wire; docs/plan1/wallet.md §2.3 "The deposit
// index rule", W:351-361; §2.4 step 1, W:416). deposit.quote answers from public records only (./deposit-wire.ts); this
// is where those records come from.
//
// - One source for the deposit index: the note store's PLANNED deposit note of the vault's scope (planDeposit,
//   ../../wallet/src/notes/store.ts), the note bindDeposit later takes by U's index. planDeposit hands back the scope's
//   PLANNED note while there is one and plans the next index only once it has left PLANNED (money reached it, or it was
//   marked taken), so every quote names that same index until money reaches it and never a funded one again. The index
//   is reserved by the note store (counter first, then the note), never here.
// - meta/"deposit/<scope>" is that note's public copy: { scope, index, id: U_{s,i} }, written by the wallet store's
//   nameDeposit under the seed lock with a compare on the seed record. The notes lock (planDeposit) and the seed lock
//   (nameDeposit) are taken one after the other, never one inside the other.
// - The seed is checked first, on the same store handle that plans and names: a seed changes only by a sign out, which
//   deletes the database and closes that handle, so no note is planned for a seed that is not the stored one.
// - Every copy is zeroed: the entropy copy, seed64 and U's secret key; the note's secrets live in bigints the note store
//   never keeps (it holds the precommitment only).
// - The frame names nothing (`top` false). A quote waits for the first load's read, every naming in flight and a
//   resync's naming (named()), so a quote right after a landing or another tab's sign-in reads the new record.
import { depositId as uOf, entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import type { WalletStore } from "@blindfill/wallet/store";
import { noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, type NoteStore } from "../../wallet/src/notes/store.ts";

export interface DepositNamerDeps {
  /** SIGN_HOST's top-level page: true; the frame: false, and it names nothing. */
  top: boolean;
  /** The release's vault scope on the page's network; null while none is named (nothing is named then). */
  scope(): bigint | null;
  /** The page's full wallet store (main.ts open()). */
  open(): Promise<WalletStore>;
  /** The first load's read of the store. */
  startup(): Promise<unknown>;
  /** The resync in flight, or null (main.ts resync()). */
  resyncing(): Promise<unknown> | null;
  /** Tests only: the note store, seed64 and U's derivation. */
  openNotes?: (st: WalletStore) => Promise<Pick<NoteStore, "planDeposit" | "close">>;
  seed64Of?: (entropy: Uint8Array) => Uint8Array;
  derive?: typeof uOf;
}

export interface DepositNamer {
  /** Names U for the seed of `entropy` (a copy is taken; the caller's own stays the caller's to zero). */
  name(entropy: Uint8Array): void;
  /** Settles once the first load's read, every naming in flight and a resync's naming are done. */
  named(): Promise<void>;
}

const sameBytes = (a: unknown, b: Uint8Array): boolean => {
  if (!(a instanceof Uint8Array) || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < b.length; i++) d |= (a[i] as number) ^ (b[i] as number);
  return d === 0;
};

export function depositNamer(deps: DepositNamerDeps): DepositNamer {
  const openNotes = deps.openNotes ?? ((st: WalletStore) => openNoteStore(st));
  const seed64Of = deps.seed64Of ?? ((e: Uint8Array) => wordsToSeed64(entropyToWords(e)));
  const derive = deps.derive ?? uOf;
  let naming: Promise<unknown> = Promise.resolve();

  async function nameNow(entropy: Uint8Array): Promise<void> {
    const scope = deps.scope();
    if (scope === null) return;
    const st = await deps.open();
    // the stored seed is the one given, on this handle (see the top)
    const stored = (await st.get("meta", "seed")) as { entropy?: unknown } | undefined;
    const same = sameBytes(stored?.entropy, entropy);
    if (stored?.entropy instanceof Uint8Array) stored.entropy.fill(0);
    if (!same) return;
    const seed64 = seed64Of(entropy);
    try {
      const notes = await openNotes(st);
      let index: number;
      try {
        const note = await notes.planDeposit(scope, (ref: NoteRef) => noteSecrets(seed64, ref).precommitment);
        if (note.ref.kind !== "deposit" || note.scope !== scope) throw new Error("planDeposit gave no deposit note of this scope");
        index = note.ref.i;
      } finally {
        notes.close();
      }
      const u = derive(seed64, scope, index);
      u.secretKey.fill(0);
      await st.nameDeposit({ entropy }, { scope, index, id: u.id });
    } finally {
      seed64.fill(0);
    }
  }

  return {
    name(seedEntropy) {
      const entropy = seedEntropy.slice();
      if (!deps.top) return void entropy.fill(0);
      // one at a time, in order; a refused or failed naming leaves the record as it was, and the next landing names
      naming = naming
        .then(() => nameNow(entropy))
        .catch(() => {})
        .finally(() => entropy.fill(0));
    },
    async named() {
      await deps.startup();
      for (;;) {
        const r = deps.resyncing();
        const n = naming;
        await r?.catch(() => {});
        await n;
        if (r === deps.resyncing() && n === naming) return;
      }
    },
  };
}
