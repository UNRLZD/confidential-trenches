// The exit tool's note scan (vault paper 2.12 steps 1 and 3, docs/plan1/vault.md l.929-937 and l.941-944; V4.2 l.1243):
// from the 12 words alone, every note the wallet makes and each one followed through its spends.
//
// - The walk is the wallet's own restore (packages/wallet/src/notes/restore.ts restoreNotes), reached through the kit's
//   ./core export and run unchanged: "This paper does not copy that walk; the wallet section is the one rule"
//   (l.936-937). Nothing here derives a note or matches a row. So the tool takes exactly the notes restore takes:
//   deposit-kind notes (deposit, return, move, second arrivals) only from deposit rows on our own precommitment, a
//   change note only at the leaf our spend names, and a refund note only from our own settled spend row on
//   rP = refund(l, j). It never takes any other leaf on one of our precommitments: a stranger's 1 USDC deposit on our
//   refund precommitment R shares the refund note's nullifier, so taking it would burn the refund when spent.
// - The read is the release's: the vault and its pair of public RPCs on the network (./rpc.ts EXIT_NETWORKS), and the
//   vault's token, pinned here from each network's deploy record (contracts/vault/deployments/mainnet-v1.json and
//   testnet-v1.json, asset). Restore reads config() on both RPCs and refuses a vault whose scope or asset is not the
//   one computed from (vault, token), so a wrong token gives a stop, never an empty scan that looks valid.
// - The 12 words go through the wallet's typed-words check (typedSeed: NFKD, lower case, exactly 12 words, the
//   BIP-39 checksum) and become seed64 as the signing page builds it (packages/signpage/src/main.ts openSeed64:
//   wordsToSeed64(entropyToWords(entropy))). The entropy is zeroed once seed64 is made, and seed64 once the scan ends,
//   on every path. The words string itself cannot be zeroed (a JS string), as on the device.
import {
  entropyToWords,
  restoreNotes,
  typedSeed,
  wordsToSeed64,
  type NoteRestore,
} from "@blindfill/kit/core";
import { nearPairNetwork, nearPairRule, type NearNetwork, type VaultSyncRpc } from "@blindfill/kit";
import { EXIT_NETWORKS, ExitRpcRefused, exitRpc } from "./rpc.ts";

/** Per network: the vault's token, as its deploy record names it (asset). */
export const EXIT_TOKENS: Readonly<Record<NearNetwork, string>> = Object.freeze({
  mainnet: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  testnet: "bf-usdc-20261101t022248.testnet",
});

export type ExitScanArgs = {
  /** the 12 words, as typed */
  words: string;
  network: NearNetwork;
  /** The two RPCs; the release's pair on `network`, fetched with `fetchFn`, unless given. Either way the pair must be the release's. */
  rpcs?: readonly [VaultSyncRpc, VaultSyncRpc];
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  /** tests only: the wallet's RESTORE_GAP unless given */
  gap?: number;
};

/** What the scan found: the wallet's restore, on the release's vault and token. */
export type ExitScan = NoteRestore & { network: NearNetwork; vault: string; token: string };

/**
 * seed64 of the typed 12 words, handed to `use` and zeroed when `use` ends, whichever way. The entropy typedSeed gives
 * is zeroed as soon as seed64 is made. Throws the wallet's WordsRefused for words that are not 12 valid BIP-39 words.
 * `seedOf` is typedSeed unless a test says.
 */
export async function withSeed64<T>(words: string, use: (seed64: Uint8Array) => Promise<T>, seedOf: typeof typedSeed = typedSeed): Promise<T> {
  const seed = seedOf(words);
  let seed64: Uint8Array;
  try {
    seed64 = wordsToSeed64(entropyToWords(seed.entropy));
  } finally {
    seed.entropy.fill(0);
  }
  try {
    return await use(seed64);
  } finally {
    seed64.fill(0);
  }
}

/**
 * Every note of the 12 words in the release's vault on `network`, each followed through its spends, by the wallet's
 * own restore. Throws ExitRpcRefused before any read for an unknown network or a pair that is not the release's; the
 * kit's VaultSyncStopped when the two RPCs differ by a byte; and restore's own stops on pages the vault could not write.
 */
export async function exitScan(a: ExitScanArgs): Promise<ExitScan> {
  const { network } = a;
  if (!Object.hasOwn(EXIT_NETWORKS, network)) throw new ExitRpcRefused(`no NEAR network named ${JSON.stringify(network)}`);
  const { vault } = EXIT_NETWORKS[network];
  const token = EXIT_TOKENS[network];
  const fetchFn = a.fetchFn ?? fetch;
  const net = EXIT_NETWORKS[network];
  const rpcs = a.rpcs ?? ([exitRpc(net.rpcs[0], fetchFn), exitRpc(net.rpcs[1], fetchFn)] as const);
  if (nearPairNetwork(rpcs) !== network) throw new ExitRpcRefused(nearPairRule(network));
  const r = await withSeed64(a.words, (seed64) =>
    restoreNotes({ seed64, vault, token, rpcs, ...(a.signal ? { signal: a.signal } : {}), ...(a.gap === undefined ? {} : { gap: a.gap }) }),
  );
  return { ...r, network, vault, token };
}
