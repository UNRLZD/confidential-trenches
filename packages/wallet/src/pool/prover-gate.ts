// One prover shared by every pool's proof queue, Max first (card balance-shows-fast). The signing page runs one prover
// worker for the Solana pool and both EVM pools (signpage src/pool-testnet.ts), and each pool's queue remakes its ready
// set at every 60 s epoch (M350(1): the epoch's shared root, fee and deadline are the privacy, so the timer stays). A
// worker takes calls in the order they come, so one pool's other-note remakes could run before another pool's Max set,
// and a phone (about 8.4 s a proof) that cannot make every pool's remakes in an epoch let Max go late.
// Through the gate the prover makes one proof at a time, and a "rest" proof (the other notes' own proofs, best effort,
// each still takeable for its whole life meanwhile, M351(3)) starts only while no "max" proof waits (a pool's Max set,
// a newest-root proof of fresh money, a tap's own proveFor) and no queue holds the gate: a pass holds it from its
// start until its last "max" proof is made (its reads and writes between two proofs leave the prover idle rather than
// to a "rest" proof that would keep it 8 s). A "max" proof never waits on a "rest" one that has not started.
import type { VaultProver } from "@blindfill/kit";

export type ProverRank = "max" | "rest";
export type ProverGate = {
  /** The prover for one rank. */
  prover(rank: ProverRank): VaultProver;
  /** Holds every "rest" proof back until the returned release (idempotent) is called. */
  hold(): () => void;
};

/** The prover `p` behind one gate: one proof at a time, "max" first, "rest" only while nothing holds. */
export function proverGate(p: VaultProver): ProverGate {
  const waiting: Record<ProverRank, (() => void)[]> = { max: [], rest: [] };
  let busy = false;
  let holds = 0;
  const next = (): void => {
    const go = waiting.max.shift() ?? (holds === 0 ? waiting.rest.shift() : undefined);
    if (go) go();
    else busy = false;
  };
  const turn = (rank: ProverRank): Promise<void> =>
    new Promise<void>((go) => {
      if (!busy && (rank === "max" || holds === 0)) return void ((busy = true), go());
      waiting[rank].push(go);
    });
  const of = (rank: ProverRank): VaultProver => ({
    load: (circuit) => p.load(circuit),
    prove: async (circuit, input) => {
      await turn(rank);
      try {
        return await p.prove(circuit, input);
      } finally {
        next();
      }
    },
  });
  const ranks = { max: of("max"), rest: of("rest") };
  return {
    prover: (rank) => ranks[rank],
    hold() {
      holds++;
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        holds--;
        if (!busy && holds === 0 && waiting.rest.length > 0) {
          busy = true;
          waiting.rest.shift()!();
        }
      };
    },
  };
}
