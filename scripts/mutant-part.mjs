// The part argument of a mutant sweep (card ci-mutant-shards-true-times): `node <sweep>.mjs [<k>/<n>]` runs the sweep
// whole, or part k of n, mutant i (counting from 0) in part (i % n) + 1, as apps/helper/test/pool-evm/mutant-sweep.mjs
// and packages/signpage/scripts/rent-back-mutants.mjs always split theirs. Scripts/ci/test-shards.mjs lists each part
// as a command of its own, so ci.yml's test-mutants shares the parts out by their measured seconds. Refused, with
// nothing run: more than one argument, a part that is not <k>/<n> with 1 <= k <= n, and a part that holds no mutant.
// scripts/ci/mutant-part.test.mjs holds the refusals; each package's mutant-parts test holds that a sweep's parts together
// hold each of its mutants once.

/** The part `args` (a sweep's command-line arguments) names of a sweep whose mutants are `names`:
 *  { k, n, whole, at: the part's mutant indexes in order, pick(i), what }. Throws on anything else. */
export function sweepPart(args, names) {
  if (!Array.isArray(args) || args.length > 1) throw new Error(`one part at most: <k>/<n>, not ${JSON.stringify(args)}`);
  const size = names.length;
  if (args.length === 0) return { k: 1, n: 1, whole: true, at: names.map((_, i) => i), pick: () => true, what: `${size} mutants` };
  const m = /^([1-9]\d*)\/([1-9]\d*)$/.exec(String(args[0]));
  if (!m || Number(m[1]) > Number(m[2])) throw new Error(`the part is <k>/<n> with 1 <= k <= n, not ${JSON.stringify(args[0])}`);
  const [k, n] = [Number(m[1]), Number(m[2])];
  const at = names.map((_, i) => i).filter((i) => i % n === k - 1);
  if (!at.length) throw new Error(`part ${k} of ${n} holds no mutant: the sweep has ${size}`);
  return { k, n, whole: false, at, pick: (i) => i % n === k - 1, what: `${at.length} mutants (part ${k} of ${n})` };
}

/** A sweep's start: the part its command line names, or a line `FAIL <why>` and exit 1 with nothing run. */
export function sweepPartOrExit(args, names, log = console.log, exit = process.exit) {
  try {
    return sweepPart(args, names);
  } catch (e) {
    log(`FAIL ${e.message}`);
    return exit(1);
  }
}

/** The problems with a sweep's parts: for every count of parts n from 1 to the sweep's size, the n parts together hold
 *  each of `names` once and no other, and a part past the sweep's size is refused. `partOf(args)` is the sweep's own
 *  choice of a part (default: sweepPart over `names`). */
export function partProblems(names, partOf = (args) => sweepPart(args, names)) {
  const p = [];
  const size = names.length;
  for (let n = 1; n <= size; n++) {
    const seen = [];
    for (let k = 1; k <= n; k++) {
      try {
        seen.push(...partOf([`${k}/${n}`]).at);
      } catch (e) {
        p.push(`part ${k} of ${n}: ${e.message}`);
      }
    }
    const times = (i) => seen.filter((x) => x === i).length;
    const bad = names.map((_, i) => i).filter((i) => times(i) !== 1).map((i) => `${i + 1} ${JSON.stringify(names[i])} x${times(i)}`);
    if (bad.length || seen.length !== size) p.push(`${n} parts: ${bad.slice(0, 3).join("; ") || "a mutant that is none of the sweep's"}`);
  }
  try {
    partOf([`${size + 1}/${size + 1}`]);
    p.push(`part ${size + 1} of ${size + 1} ran, with no mutant to run`);
  } catch {}
  try {
    if (partOf([]).at.length !== size) p.push("the whole sweep does not hold every mutant");
  } catch (e) {
    p.push(`the whole sweep: ${e.message}`);
  }
  return p;
}
