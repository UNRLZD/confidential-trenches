# G1 proof 2: proofs on a phone (g1-phone-prover)

**Status.** The page, the serving, the desktop baseline and the owner's phone run are done. The owner's phone visit
ran on 2026-10-26 15:47-15:48Z; its 10 posts are committed in `results/phone/` and re-verified 10/10
(`results/runs/20261026T174252Z-phone-verify/verify.txt`). The owner accepted the run at 16:00Z with its one CSP
violation, which came from the page being opened inside an in-app browser (the team lead's record; that page did not yet show
or post a violation's details, which it now does: "The page and CSP violations" below).

**Answer.** In the real setup (snarkjs 0.7.5, one same-origin worker, single thread, vault.md 2.14's policy) a
withdraw proof takes 8.3 s on the owner's iPhone (iOS 26.6.1), about 4.7 s on desktop Chrome and 5.3 s on desktop
Safari (Apple M4 Pro), and 4.6 s on a 16-core x86 box. A commitment proof takes 0.6 s on the phone and 0.3-0.4 s on
desktop. The bound is "a few seconds is acceptable" because proofs are made in the background before a tap
(`docs/plan1/vault.md` l.794-797 "so a few seconds is acceptable", at research main 4c11149; the same text the brief
cited before the paper moved).
The phone's withdraw proof is over it. "If a phone is over the bound" says where a proof can be made ahead (an
arming), where it cannot (a withdraw to the user, whose proof binds the typed amount), and what a later card must
decide.

## What runs

- **Files.** PP v1.3.0's withdraw and commitment wasm, zkey and vkey, fetched and checked by sha256 against
  `pins/setup.txt` (the g1-setup-files pins; same cache, `fetch.sh`), and `snarkjs.min.js` 0.7.5 checked against
  `pins/snarkjs.txt` (710,896 B). `build.mjs` writes `dist/` with the circuit files at `zk/<sha256>.<ext>` (hard links
  into the fetch cache, one copy on disk) and the pins as constants in `page.js`.
- **Inputs.** `vectors/{withdraw,commitment}.input.json` and `expected.json`, made by `gen-vectors.mjs` from
  g1-setup-files' fixed test vectors (`--check` re-derives them).
- **Page.** `page/index.html` + `page.js` fetch each file, check its sha256 before anything else sees it, hand the bytes
  to one worker (`worker.js`, same origin), which runs
  `snarkjs.groth16.fullProve(input, wasm, zkey, undefined, undefined, { singleThread: true })` and times only that call.
  The page verifies each proof with the pinned vkey and POSTs one JSON per proof: prove ms, cold/warm, page verify
  result and ms, user agent, `hardwareConcurrency`, and each file's size, sha256 and fetch time.
- **Policy.** `headers.mjs`: 06b's policy (`docs/spec/06b-wallet-webapp.md` l.1983-1993) with 2.14's changes:
  `script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self'`, `trusted-types prover-worker`, and `connect-src 'self'`
  for this page. `test/serve-local.test.mjs` holds it to that.
- **Re-verify.** Every posted proof is checked again on the Mac by `verify.mjs`: the snarkjs 0.7.5 CLI with the pinned
  vkey (exit 0 and "OK!"), its public signals equal to `expected.json`, and the page's own verify true.

## Results

p50 is the nearest rank over the warm runs (run index > 0); cold is run 0 of each page load. Every row's proofs were
re-verified on the Mac (`verify.mjs`, the "verified" column).

| device | browser | policy | circuit | n | cold ms | warm p50 ms | warm max ms | zkey fetch | verified | run |
|---|---|---|---|---|---|---|---|---|---|---|
| Mac, Apple M4 Pro, 12 cores, 24 GB, macOS 26.6 | Chrome 156.0.8078.47 | 2.14 exact | withdraw | 5 | 4,775 | 4,694 | 4,716 | 17,793,015 B, 121 ms | 5/5, 0 hidden | `20261026T113558Z-desktop-chrome` |
| same | same | same | commitment | 5 | 319 | 302 | 304 | 901,233 B, 3 ms | 5/5, 0 hidden | same |
| Mac, same | Safari 26.6 | 2.14 without upgrade-insecure-requests (finding 1) | withdraw | 5 | 5,360 | 5,305 | 5,351 | 17,793,015 B, 19 ms | 5/5, 0 hidden | `20261026T113644Z-desktop-safari` |
| same | same | same | commitment | 5 | 383 | 380 | 384 | 901,233 B, 3 ms | 5/5, 0 hidden | same |
| Box (not the desktop baseline): x86_64, 16 cores, Linux (WSL2) | headless Chromium 153.0.8010.12 | 2.14 exact | withdraw | 5 | 4,643 | 4,620 | 4,725 | 17,793,015 B, 48 ms | 5/5, 0 hidden | `20261026T113710Z` |
| same | same | same | commitment | 5 | 324 | 309 | 319 | 901,233 B, 5 ms | 5/5, 0 hidden | same |
| Owner's iPhone, iOS 26.6.1, 4 cores reported | WebKit 26.6.1 (Mobile Safari user agent), opened inside an in-app browser (team lead's record, M273) | 2.14 exact, over HTTPS (the funnel), 1 CSP violation, `style-src-elem`, from the in-app browser (team lead's record, M273; the posts carry no violation data) | withdraw | 5 | 8,492 | 8,344 | 8,426 | 17,793,015 B, 30,234 ms | 5/5, 0 hidden | `results/phone/`, `20261026T174252Z-phone-verify` |
| same | same | same | commitment | 5 | 609 | 600 | 616 | 901,233 B, 13,007 ms | 5/5, 0 hidden | same |

- **The phone next to the desktop baseline.** Withdraw warm p50: phone 8,344 ms, desktop Chrome 4,694 ms (phone
  1.78 times), desktop Safari 5,305 ms (1.57 times). Commitment warm p50: phone 600 ms, Chrome 302 ms, Safari 380 ms.
  The cold run costs the phone little more than a warm one (8,492 against 8,344 ms); snarkjs took 1,441 ms to load in
  the worker, once per page load.
- The phone's fetch times are over Tailscale Funnel to the Mac from the owner's network: the withdraw wasm 4,905 ms,
  its zkey 30,234 ms, the commitment wasm 28,137 ms and zkey 13,007 ms. They say how long a phone can take to get the
  files, not how fast our host will serve them.
- The user agent is the only device detail in the posts (plus `hardwareConcurrency` 4 and the label `owner-phone`);
  every proof is on the fixed test vectors, so the posts hold no key and no real note.

- The desktop runs are `desktop.sh chrome 5` and `desktop.sh safari 5`, both through the Mac heavy queue and on the
  page after the fix round.
  - The page was served by `serve-local.mjs` on `127.0.0.1:65219` (Chrome) and `127.0.0.1:49167` (Safari). The
    kernel picked these ports (`--port 0`); they are never 8787.
  - The Mac is shared with other sessions' jobs. The 1-minute load was 4.17 before and 5.60 after the Chrome run, and
    5.81 and 5.95 for Safari (each run's `run.txt`).
  - Chrome ran a fresh profile and was stopped by its PID. Safari was opened in front; its tab stays open.
  - desktop.sh waits up to 20 minutes for the posts. Safari has no PID to watch, so a page that fails early waits
    out the full 20 minutes; this is accepted for a manual bench.
- **Hidden windows.** An unattended Chrome window on a shared Mac sits behind other windows, and Chrome then marks it
  hidden and throttles it. In run `20261026T113310Z-desktop-chrome`, 9 of 10 proofs were flagged hidden and left out
  of the table, and all 10 still verified. desktop.sh therefore starts Chrome with Playwright's own switches
  (`--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`,
  from Playwright's `chromiumSwitches.js`). The box's headless runs already have them, so both time the same way.
  The runs in the table have 0 hidden.
- An earlier Chrome run on the page before the fix round (`20261026T104842Z-desktop-chrome`: withdraw p50 4,767 ms,
  max 5,460; commitment p50 301 ms) agrees with these numbers. It is superseded because it carries no hidden flags.
- The zkey fetch is from 127.0.0.1 (desktop) and says nothing about a phone network; the phone row's fetch is over
  the funnel.
- Box: `run.sh` through `scripts/the build queue` on the build box, `browser.mjs bench`. It shows the same single-thread
  withdraw time as desktop Chrome on a different CPU.

## Proofs side by side (card proof-pool-time)

**Answer.** On the box (headless Chromium), with a pool of 3 workers, as the owner's iPhone has, k withdraw proofs
take ceil(k/3) rounds of 5.0 to 5.4 s each for every k from 1 to 6, so the papers' estimate of about ceil(k/3) rounds
holds there. All 144 proofs were verified. Memory depends on the pool size, not on k. Each warmed worker adds about
175 MB of RSS, and no k up to 6 adds more than 191 MB over the idle pool of 3. The phone series is ready for the
owner's next visit.

**The line the papers can cite:** "A pool of 3 workers makes k = 1 to 6 withdraw proofs in ceil(k/3) rounds of 5.0 to
5.4 s each on the box (wall p50 5,016 ms at k = 1, 5,334 ms at k = 3, 10,745 ms at k = 6), all verified; the pool's
memory is about 175 MB per warmed worker and does not grow with k" (run `results/runs/20261031T175855Z-pool/`).

- **What runs.** `page/pool.html` and `page/pool.js` are served with the same files, `worker.js` and policy as the
  single-proof page. The page fetches each pinned file once and checks its sha256. It then starts a pool of P
  workers, each with its own copy of the 2,607,967 B wasm and the 17,793,015 B zkey. Each worker makes one warm-up
  proof (all P at once). Then, for each rep and each k from 1 to 6, a batch hands k jobs to the pool, and a free
  worker takes the next job. A batch's wall time runs from handing out its jobs to its last answer. Every proof is
  verified on the page after its batch's wall time is taken and posted as one JSON, with its batch in `pool`.
  P = `hardwareConcurrency` - 1 by default, and P = 3 as a second series (`?P=` forces one). This is the small pool of
  the vault paper (`docs/plan1/vault.md` l.783-784 "our own small pool of same-origin workers", at 4c11149).
- **Memory.** `performance.measureUserAgentSpecificMemory` needs cross-origin isolation, and the policy sends no
  COEP, so the page finds no such call and posts `memory: null`. The harness (`browser.mjs pool`) reads
  `ps -A -o pid=,ppid=,rss=` every 100 ms. It sums the browser's process tree (every child of the harness's own
  process) and keeps the largest one process, which is the renderer whose threads are the workers. Then it gives
  each batch the peak inside its own start and end. RSS counts shared pages once per process, so the tree's sum is an
  upper bound.
- **Crashes.** A worker's error event, or a failed prove, counts as a crash, and the lost worker is replaced before
  the next batch. A tab that is killed mid-batch (a phone out of memory reloads the page) leaves a mark in
  sessionStorage. The next load then shows where it stopped and does not start on its own.
- **Re-verify.** `verify.mjs` checks every pool post as it checks the single-proof posts. It also checks the batch
  fields (`poolErrors`: job below k, slot below P, rounds = ceil(k/P), wall time at least the job's wait plus its
  proof) and prints pool results in their own table (`poolTable`), never in the single-proof table.

The desktop series: `scripts/the build queue g1pp-pool -- proofs/g1-phone-prover/pool-run.sh 3` with `BUILD_QUEUE=1`. The
box gave a slot at once. Box: Intel i5-14600K, 16 cpus reported (`hardwareConcurrency` 16, so P = 15), 24 GB,
Linux (WSL2), headless Chromium 153.0.8010.12, the policy exact (upgrade-insecure-requests kept). Three reps per k.
Each pool size ran in its own fresh browser. The tables are from `pool.txt` (harness) and `run.txt` (verify.mjs):

| P | k | rounds | wall p50 ms | wall p50 / round ms | proof p50 ms | proof max ms | RSS peak, browser tree | RSS peak, renderer | crashes | verified |
|---|---|---|---|---|---|---|---|---|---|---|
| 3 | 3 warm-up | 1 | 5,533 | 5,533 | 5,524 | 5,532 | 1,040 MB (511 before) | 668 MB | 0 | 3/3 |
| 3 | 1 | 1 | 5,016 | 5,016 | 5,016 | 5,190 | 1,137 MB | 761 MB | 0 | 3/3 |
| 3 | 2 | 1 | 5,286 | 5,286 | 5,183 | 5,404 | 1,085 MB | 710 MB | 0 | 6/6 |
| 3 | 3 | 1 | 5,334 | 5,334 | 5,266 | 5,521 | 1,097 MB | 722 MB | 0 | 9/9 |
| 3 | 4 | 2 | 10,607 | 5,304 | 5,363 | 5,620 | 1,231 MB | 856 MB | 0 | 12/12 |
| 3 | 5 | 2 | 10,546 | 5,273 | 5,296 | 5,441 | 1,201 MB | 828 MB | 0 | 15/15 |
| 3 | 6 | 2 | 10,745 | 5,373 | 5,311 | 5,448 | 1,156 MB | 782 MB | 0 | 18/18 |
| 15 | 15 warm-up | 1 | 12,762 | 12,762 | 12,260 | 12,759 | 3,220 MB (599 before) | 2,845 MB | 0 | 15/15 |
| 15 | 1 | 1 | 5,878 | 5,878 | 5,877 | 6,050 | 3,197 MB | 2,819 MB | 0 | 3/3 |
| 15 | 2 | 1 | 6,327 | 6,327 | 6,257 | 6,346 | 3,276 MB | 2,900 MB | 0 | 6/6 |
| 15 | 3 | 1 | 6,594 | 6,594 | 6,546 | 6,760 | 3,167 MB | 2,788 MB | 0 | 9/9 |
| 15 | 4 | 1 | 6,848 | 6,848 | 6,712 | 7,107 | 1,947 MB | 1,568 MB | 0 | 12/12 |
| 15 | 5 | 1 | 7,199 | 7,199 | 6,910 | 7,203 | 1,796 MB | 1,419 MB | 0 | 15/15 |
| 15 | 6 | 1 | 7,722 | 7,722 | 7,539 | 8,474 | 2,015 MB | 1,638 MB | 0 | 18/18 |

p50 is the nearest rank over the 3 reps (wall) or over the proofs (proof). The RSS columns are the highest peak
over the reps. The warm-up's "before" is the browser with the pool loaded but no proof made yet. 0 hidden, 0 CSP
violations, 0 page crashes, 144 posts 201. verify.mjs gives ALL 144 RESULTS VERIFIED on the box (`run.txt`) and again
on the Mac (`mac-verify.txt`).

- **Where time per round stops being flat.** With a pool of 3 it stays flat for every k from 1 to 6: 5,016 to 5,373 ms
  per round (+7%), and from k = 4 a second round is added at the same rate. With a pool of 15 every k is one round,
  but the wall time still rises from 5,878 ms (k = 1) to 7,722 ms (k = 6), +31%. The box's cores are shared: the job
  ran in a scope capped at 8 cores (`scripts/heavy-remote.sh` l.32-33 "capped at 8 cores (CPUQuota=800%)"), and
  other jobs pushed the 1-minute load from 4.92 to 30.69 during that series. The third rep, the quietest, runs
  5,707 to 6,162 ms. So this run does not show a k at which side-by-side proofs slow down on their own. They slow
  down when they share cores, and the box's numbers bound that from above. (`run.txt` prints "cgroup cpu quota none"
  because it read the root cgroup's file; `browser.mjs` now reads its own cgroup path.)
- **Memory against a stated bound.** The bound is 1 GiB for the renderer, the process that holds the page and its
  workers. That is our own budget for a phone tab, not a browser's documented limit. A pool of 3 stays under it at
  every k (856 MB at most). A pool of 15 passes it at the warm-up (2,845 MB). Memory is set by P: a warmed worker keeps
  about 175 MB ((1,040 - 511) / 3 and (3,220 - 599) / 15). A batch adds at most 191 MB (P = 3) or 270 MB (P = 15)
  over the idle pool, at any k.
- **What this says for the app's pool.** On a device that reports many cores, P = `hardwareConcurrency` - 1 costs
  memory for workers that a buy of up to 6 sizes never uses: 15 warmed workers took 2.8 GB of renderer RSS here.
  A later card can cap P at the most sizes a buy can carry. That call is not made here.

### The phone series (ready, not run)

- The owner's iPhone reports `hardwareConcurrency` 4, so the page's default pool is 3 and it runs one series (the
  forced pool of 3 is the same size). The run is 1 warm-up batch and 2 reps of k = 1..6: 45 proofs, about 19 rounds
  of about 8.5 s (the single proof's 8.3 s) plus the files' fetch, so about 3 to 4 minutes. That is well under
  serve.mjs's 200-post cap.
- Through the same serving as before (`phone.sh`, "Serving for the owner's phone visit" below): `phone.sh` now also
  prints the pool page's link, just before the prover page's line. Posts land in `results/phone/` (an earlier
  visit's posts are moved first), and `node verify.mjs results/phone --host <funnel host>` re-verifies them and prints
  the pool table.
- **The owner's one step:** open `https://<funnel host>/prover/pool.html?auto=1&device=owner-phone` (the Page URL
  serve.sh prints, followed by `prover/pool.html?auto=1&device=owner-phone`) in Safari itself, not inside another
  app, and keep the tab in front until it says "Done".
- On the phone, the page has no memory reading (no cross-origin isolation, and no harness can read the phone's RSS).
  So the phone's memory answer is whether the tab survives. If iOS kills the tab, the page reloads and says which
  batch it stopped in, and the posts stop at the batch before it.

## The policy: red and green (`results/runs/20261026T113710Z/csp.txt`, the same as `20261026T093336Z/csp.txt` before the fix round)

- **Red**, the policy without `'wasm-unsafe-eval'` (`serve-local.mjs --no-wasm-eval`, nothing else changed): the page
  fails with "WebAssembly.compile(): Compiling or instantiating WebAssembly module violates the following Content
  Security policy directive ...", on the page and in the worker; no proof is made.
- **Green**, the exact policy: "Done: 2 proofs, all verified", 0 CSP violations on the page and in the worker, exactly
  one worker (`/worker.js`), no `blob:` or `data:` request, no CSP or Trusted Types console message.
- The same through the real serving path: `serve.mjs` at `/prover/` (MOUNT E2E PASS before the fix round in
  `results/runs/20261026T094103Z/` and `20261026T101203Z/`, and on the fixed page, with per-run posts, in
  `results/runs/20261026T115724Z/`, 5 per circuit): every proof verified, 0 violations, one worker
  `/prover/worker.js`, 0 requests outside `/prover/`, every post 201 into `results/phone/` (2 before, 10 on the fixed
  page), re-verified by `verify.mjs`.

## The page and CSP violations

The owner's run had one CSP violation, from the in-app browser the page was opened in (the team lead's record, M273), and the
page then showed only its count and directive. Now (`page/page.js`, `recordViolation`) the page shows every violation
on its own line with where it happened (page or worker), its directive, its blocked URI, its source file:line and its
sample, and every result posted after it carries `violations` and `violationCount` (the true count).
- **No origin in a violation.** A phone run's origin is the funnel's host name, and phone results are committed. So a
  same-origin URL in `blocked`, `source` or `sample` keeps only its path (`/prover/snarkjs.min.js:1`; a sample's
  `blob:<origin>/x` reads `blob:/x`), and an origin cut short at the end of a sample (browsers cut a sample at 40
  characters) is dropped. Another origin's URL stays as the browser gave it.
- **Size.** Each field is capped (directive 100, blocked and source 200, sample 120 characters), and a post carries the
  earliest violations, at most 20 and at most 32 KiB of their JSON. A flood of control characters in every field
  (25 violations) posts under serve-local.mjs's 64 KiB `MAX_BODY`, and so under serve.mjs's 256 KiB; at 9f1010c the
  same flood posted 124,511 B.

The browser delivers a violation as a task queued behind the code that caused it, so the page waits one task turn
after its verify (outside `proveMs` and `pageVerifyMs`) before it builds the result: a violation the run's own proof
or verify caused is posted with that run. A violation after the last post, or on a page that posts nothing, is shown
but not posted: `POST /prover/results` takes only a result (serve.mjs needs its `circuit`). verify.mjs checks both
fields: `violations` must be an array of objects and `violationCount` a count of at least its length. Two checks keep
a host name out of a committed post; verify.mjs prints neither host:
- **Any host, written `scheme://host`.** A result is refused when a violation's `blocked`, `source` or `sample`
  holds a `scheme://host` or `scheme:\\host` form whose host is not 127.0.0.1 (`blob:https://host/...` included,
  after control characters are stripped). This covers every cross-origin host written that way, not only the
  funnel's (an in-app browser's own script URL, say), but only in those three fields and only with the scheme and two
  slashes: `//host/x`, a bare host and `https:/host/x` pass it.
- **The run's funnel host, in any form.** A phone run's verify is given the funnel host, `node verify.mjs
  results/phone --host <funnel host>`; a directory whose real path is named `phone*`, in any letter case
  (`results/Phone`, a symlink to `results/phone`), is refused without it (exit 1, "a phone run's results
  (results/phone*) need --host <funnel host>"). There is no flag around it. A directory of any name that holds a
  post named as serve.mjs names it, `phone-<stamp>.json` in any letter case, is refused without it too (exit 1, "a
  phone run's posts (files named phone-<stamp>.json) need --host <funnel host>"), so a copy of the posts in another
  folder needs it; a copy that also renames them is not refused. `mount-run.sh`'s posts come over 127.0.0.1 on the
  box, with no funnel, and serve.mjs names them so as well: it verifies them with `--host no-funnel.invalid`, a
  reserved name (RFC 2606) no post can hold, and the 127.0.0.1 rule above still applies. With `--host`, verify.mjs
  reads three things:
  - every string and every key of the parsed result, anywhere in it (`verifyError`, the user agent and every
    violation field included), so a refusal can name the field;
  - the file's raw text, as the server wrote the POST body (serve.mjs and serve-local.mjs write the body as sent);
  - and, with or without `--host`, it refuses a file in which one object holds the same key twice, since JSON.parse
    keeps only the last copy (the key is not printed).

  Each text is read as a skeleton and refused when it holds the host's skeleton (the host's letters and digits).
  Building the skeleton takes three steps:
  1. Escapes are decoded in rounds until a round changes nothing, in at most 32 decode rounds (`MAX_ROUNDS`): a
     text that still changes in the round after that is refused as if it named the host (fail closed). A browser or
     server encodes a URL once or twice; `%XX` nested 9, 20 or 32 deep is decoded, and 33 or 1000 deep is refused.
     Before this bound a 256 KB post nested 130,088 deep took 48 s to verify on the Mac; now one nested 130,108 deep
     is refused in 59 ms. A round decodes every run of `%XX`, then every `\\`, `\xHH`, `\uHHHH` and `\u{H}`, then
     every HTML numeric entity (`&#46;`, `&#x2e;`). An entity's `;` is optional, so read before its escapes `&#4\x36;`
     would end at `&#4`: the backslash step runs before the entities, and an entity with no `;` that an escape (`\`, `%`, `&`) follows waits
     for the round that decodes that escape (`&#4\x36;`, `&#x2\x65;`, `&#4\u0036;` and `&#4&#54;;` are each a dot).
     A run of `%XX` is read as UTF-8 bytes, so `%E3%80%82` is U+3002 (dropped in step 3, like any dot). A byte that
     is not part of a valid UTF-8 sequence has two readings, alone as Latin-1 (`%E9` is é) and as U+FFFD, which step
     3 drops (`%C0%AE`, `%E3%80%2e`, `%ED%A0%80`); the text is read once each way, and either reading that holds the
     host refuses it.
  2. NFKD is applied, combining marks are dropped (i + U+0307 reads i) and the text is lower-cased.
  3. Every character except a-z and 0-9 is dropped. That covers a dot in any script (U+3002, U+FF0E, U+FF61),
     slashes, backslashes, `@`, colons and every invisible or filler character (zero-width, bidi, U+034F, U+FE0F,
     U+3164).

  So these are refused (`test/verify.test.mjs`): `//host/x`, a bare host, `https:/host/x`, `https:` + a zero-width
  space + `//host/x`, `http://host@127.0.0.1:1/x`, the host behind a duplicate key's first copy, each of those
  splits and encodings, and a host split across two strings with nothing between them in the raw text that the
  skeleton keeps (two array elements, or a key and its value). A refusal names only the field's path (`$.verifyError names the run's host (--host)`, or "the
  file's raw text names the run's host"), and a bad `--host` value is not echoed. `--host` needs a dot and a letter:
  an IP's digits could match inside a proof's numbers. Any output line that would hold the host is withheld and fails
  the run.

  Not caught, and tested as not caught where it can be planted:
  - a host split by other letters or digits (a key between two values, say);
  - letters from another script that look alike (Cyrillic о, dotless ı);
  - a `%XX` run that needs one invalid byte read as Latin-1 and another as U+FFFD (each reading alone is caught);
  - any other encoding (base64, say);
  - a host cut short (the start of its name only).

- Tests in `test/page.test.mjs`:
  - "each CSP violation's blocked URI, source file:line and sample is shown on the page and posted with every later
    result": red against the page at c7507b3, green after (`results/runs/20261026T174252Z-phone-verify/`
    `csp-violations-red.txt`, `csp-violations-green.txt`);
  - "a violation the run's own verify causes, delivered as a queued task, is posted with that run's result": red
    against the page at b34f1a5, green after (`queued-violation-red.txt`, `queued-violation-green.txt`);
  - "a same-origin violation is posted with its path only: the page's origin is nowhere in the post" and the flood
    test's byte check "a page flooded with violations posts the count and the earliest ones, under serve-local.mjs's
    MAX_BODY": red against the page at 9f1010c, green after.
- Tests in `test/verify.test.mjs`: "planted: a violation whose blocked, source or sample names a host other than
  127.0.0.1 is refused; paths and keywords pass" and "planted: violations that is not an array of objects, or a
  violationCount that is not a count of at least its length, is refused": red against verify.mjs at 9f1010c, green
  after. Both files' red/green runs: the worker's `results/runs/20261026T181521Z-w1-tests/` and the lead's re-run
  `results/runs/20261026T183254Z-lead-tests/` (page 5/9 red, 9/9 green; verify 16/18 red, 18/18 green).
- **The browser check of the posted count** (`browser.mjs`, the unseeded case): exactly one result is posted, and its
  `violationCount` equals the violations the page recorded and is more than 0, in headless Chromium and in Playwright
  WebKit 26.6 (the phone's engine; `--local-http`, finding 1). Red: the page at b34f1a5 with this browser.mjs, box run
  `20261026T182013Z-w1-red`: "posted 0, recorded 1" in both browsers, CSP CHECKS FAIL. Green: box run
  `20261026T182826Z`: "posted 1, recorded 1" in both. WebKit fails the unseeded verify on the same Trusted Types refusal as
  Chromium (its message "This assignment requires a TrustedScriptURL"; one `require-trusted-types-for` violation,
  blocked `trusted-types-sink`), and it too delivers the violation as a queued task: posted 0 at b34f1a5, 1 after. In both green posts `127.0.0.1` appears 0 times.
- **The unseeded case also asserts the post is path-only** (card g1pp-p3s): in Chromium and in WebKit the post holds
  neither the page's origin nor `127.0.0.1`, in its raw text or once its JSON escapes are read (`originsInPosts`).
  The check finds `127.0.0.1` and the origin in the real unseeded post of the page at 02baf31 (box run
  `20261026T175516Z`, source `http://127.0.0.1:46575/snarkjs.min.js:1`) and neither in round 2's two
  (`20261026T183513Z`), `test/browser.test.mjs`.
- **WebKit is required.** WebKit not launching fails the CSP checks (CSP CHECKS FAIL, "unseeded webkit: WebKit
  launches (it did not: ...)"); before this card it printed a line and still passed. Only `--webkit-absent`, given on
  a machine with no WebKit, skips the case, said on its own SKIP line (`test/browser.test.mjs`). `run.sh` passes it
  only for `G1PP_WEBKIT_ABSENT=1`; any other value, empty included, stops `run.sh` with exit 2 before anything runs
  (`test/run-sh.test.mjs`).
- In a real browser, before this round: box run `20261026T175216Z` (page at b34f1a5) posted the unseeded case's result with
  `violationCount` 0 although the page recorded a Trusted Types violation; that run is what the second test
  reproduces. Box run `20261026T175516Z` (page at 02baf31) posted it with `violationCount` 1: `require-trusted-types-for`,
  blocked `trusted-types-sink`, source `http://127.0.0.1:46575/snarkjs.min.js:1`, sample `Worker
  constructor|blob:...` (`csp-unseeded-posted/`). The green and bench posts carry `violationCount` 0.

## Findings for the vault and wallet cards

1. **WebKit and `upgrade-insecure-requests` on http://127.0.0.1.** WebKit (Playwright WebKit 26.6 and desktop Safari
   26.6) upgrades the page's own requests to https://127.0.0.1 under that directive, so the page never loads ("Error
   performing TLS handshake", `csp.txt` uir probe). Chromium does not. So the desktop Safari row runs
   `--local-http`, which drops only that directive (`headersFor({ localHttp: true })`, tested to change exactly one
   directive). Over HTTPS (the phone through the funnel, and the real app) the directive is harmless and stays.
2. **Verifying on the device needs a single-thread curve.** `snarkjs.groth16.verify` takes no `singleThread` option
   and builds its own worker from a `blob:` URL, which `trusted-types` and `worker-src 'self'` refuse ("This document
   requires 'TrustedScriptURL' assignment", `csp.txt` unseeded case). The page seeds
   `globalThis.curve_bn128 = await snarkjs.curves.getCurveFromName("bn128", { singleThread: true })` before verifying
   (`page/page.js` l.125-132); ffjavascript then reuses it. Any device-side verify in the kit needs the same. The
   seed relies on ffjavascript's internal `globalThis.curve_bn128` (snarkjs 0.7.5's verify asks for the curve with
   no options), so a snarkjs or ffjavascript bump must re-check it.
3. **`snarkjs.min.js` compiles WebAssembly when it loads,** so the page that loads it (not only the worker) needs
   `'wasm-unsafe-eval'`; the red case shows the violation on both.
4. **The worker needs its own Trusted Types policy** (`prover-worker`) for `importScripts`; it accepts only
   `snarkjs.min.js` (`page/worker.js`). That is the one name in `trusted-types`.

## If a phone is over the bound

It is. The owner's iPhone makes a withdraw proof in 8,344 ms (warm p50; max 8,426, cold 8,492), against "a few
seconds is acceptable" because proofs are made in the background (`docs/plan1/vault.md` l.794-797 "Proofs are made
in the background before a tap"). A commitment proof takes 600 ms and needs no change. 8.3 s is fine in the
background and too long to wait on. A proof made ahead serves an arming (item 1), but not a withdraw to the user
(item 2), and a proof made too early breaks the kit's newest-root rule (item 3). These are decisions for the later
card (proof-ahead), not settled here. Line numbers below are at research main 4c11149; wallet.md and app.md are
unchanged since c7507b3. Each paper cite carries the paper's own words beside it (12 characters at least, over 20
lines at most), and `check-cites.mjs` checks every quote against its lines at 4c11149. `test/cites.test.mjs` reads
those lines from `test/fixtures/cites-papers-4c11149.json` (every line inside a cited range, written from git by
`check-cites.mjs --write-papers`), so it runs on the box too; where 4c11149 is in the history (the Mac), it also
compares the fixture with git line by line.

1. **An arming can prove ahead.** Everything an arming's proof binds is known before the arming: the note, the
   recipient `A_{l,j}`, the refund precommitment, `register_deposit`, the fee recipient, the fee read on two
   providers, and the ladder size s (`docs/plan1/wallet.md` §2.5 steps 1-5, l.486-490 "The device makes the
   withdrawal proof with `context` = hash of the withdrawal data"). So the device can make an arming's proof in its
   worker beforehand, and the arming waits on no proof. When that proof may be made is item 3.
2. **A withdraw to the user proves after the amount is typed.** The proof binds the withdrawn value: `withdrawnValue`
   is public signal 2 of the withdraw circuit ("2000000" in every phone post; `vectors/expected.json`), and PP's own
   SDK passes the amount into the proof (`packages/sdk/src/core/withdrawal.service.ts` at PP c312dcd, read
   2026-10-26 18:12Z, l.25-38 "snarkjs.groth16.fullProve(" and l.102-104 "withdrawnValue: input.withdrawalAmount").
   A withdraw to the user uses the amount the user types (wallet.md l.535-536 "the amount they type"), and WM-06
   allows any amount up to the user's unspent notes (wallet.md l.746 "≤ the user's unspent notes less locked
   orders"). A proof made ahead at a ladder size cannot serve a typed amount such as $37, so as the papers stand the
   device proves after the amount is typed, and the user waits about 8.3 s at the tap on this phone (8.5 s cold),
   behind app.md CH-079 (l.988 "proving on the device").
   - **The conflict.** wallet.md l.671 "amount is a ladder size" is in the "Arming quote and proof" row, which also
     covers a withdraw to the user (l.671 "for a withdraw to the user, the address typed on SIGN_HOST's form").
     l.535-536 "the amount they type" and WM-06 (l.746 "Withdraw to the user") say the typed amount. Round 1 of this
     file cited l.671 ("amount is a ladder size") alone and so claimed the user's withdraw could prove ahead; it
     cannot while the amount is typed.
   - **The decision a later card must take**, with each option's cost:
     - *Ladder-only user withdraws.* The typed amount becomes ladder sizes, each its own withdrawal with a proof made
       ahead. Cost: each part pays its own relay fee, uses its own `A_{l,j}` and its own 1Click leg (wallet.md l.492
       "1Click delivers to W | 1Click | 21-25 s"). Parts from one note run one after another: part k+1 spends the
       change note part k makes (wallet.md l.486 "This withdrawal makes change note j of the note's label l"), whose
       leaf must land before its Merkle path exists, so only part 1's proof can be made ahead. A remainder below the
       smallest size still needs a non-ladder withdrawal or stays in the vault. wallet.md l.535-536 "the amount they
       type" and WM-06 change. Gain: every withdrawal out of the vault is a standard size, the rule of wallet.md
       l.532-533 ("later spent in ladder sizes, so no later withdrawal matches it by amount").
     - *A wait at the tap.* The typed amount stays; the device proves once the amount is typed, as PP's SDK does (it
       proves on the call with the amount as input, withdrawal.service.ts l.25-38 "snarkjs.groth16.fullProve(" above).
       Cost: about 8.3 s on the owner's iPhone on every withdraw to the user, shown by CH-079; nothing else changes.
       wallet.md l.671 ("amount is a ladder size") then holds for an arming only.
     - *A shorter wait.* The same wait, cut by a faster prover (item 6): multi-thread snarkjs (needs cross-origin
       isolation, reverses vault.md l.778-779 "the prover needs no cross-origin isolation headers") or a pool of
       workers (does not make one proof faster). The published multi-thread numbers are for a smaller circuit
       (vault.md l.794-797 "is for Semaphore-32 with snarkjs multi-thread"), so the cut on ours is not measured.
   - The vault lead's recommendation: a wait at the tap for the user's withdraw (the PP baseline, the typed amount
     kept), proofs made ahead for armings only. The wait is user-facing friction, so the team lead may take it to the owner.
3. **When a proof made ahead may be made.** The kit always proves against the newest roots (vault.md l.145-146 "The
   kit always proves against the newest roots, since an old root tells watchers the note existed by then"; again in
   the privacy table, l.844 "The kit proves against the newest roots"). `stateRoot` is public signal 3. A proof made the moment a note's leaf lands binds the root right after that leaf: a withdrawal sent with
   it shows watchers a root that directly follows one particular deposit, which points at that deposit. It also
   undoes wallet.md l.478-479 ("Arming starts at a random delay of minutes after a deposit lands, never at once") for
   every arming that uses such a proof within its 10 minutes. The vault still accepts the proof, since it accepts
   every root it has had and only `deadline_ms` makes it refuse one (wallet.md l.352-353 "a root alone never expires
   a withdrawal proof. The vault refuses a proof after its `deadline_ms`"); under the kit's own rule the proof is
   stale at the next leaf. Round 1 of this file proved "as soon as a note can be spent" and held the proof "until its
   deadline"; both are withdrawn. The choice for the later card, for example:
   - prove at the random delay after landing (l.478-479 "a random delay of minutes after a deposit lands"), against
     the newest root then, and remake the proof whenever new leaves land and before its `deadline_ms` (at most 10
     minutes after the final block it read, l.490 "T is the lower of the two final-block timestamps"). Cost:
     one 8.3 s proof in the worker per spendable note per new leaf, so the battery cost scales with the notes held
     and with how often the vault takes a deposit. In a busy vault the held proof is often a leaf old at use, and
     remaking it then is the wait again;
   - or accept a held proof whose root is a bounded number of leaves or minutes old, which changes vault.md
     l.145-146 ("always proves against the newest roots") and l.844 ("The kit proves against the newest roots") and
     narrows by that bound what an older root tells watchers.
4. **The quote at use.** Today the quote comes before the proof and the proof's deadline sits inside the quote's
   (wallet.md §2.5, step 2 at l.487 "Quote through the helper" before step 5 at l.490 "The device makes the
   withdrawal proof"; app.md l.375-377 "inside the quote's deadline"). With the proof made ahead, the device asks for
   the quote at use, with a `deadline` in its own request (wallet.md l.667 "every signed field equals the device's
   own request, `dry`, `deadline`") that ends after the proof's, and drops a held proof whose note was spent another
   way.
5. **The files are already on the device.** The phone took 30.2 s to fetch the 17.8 MB withdraw zkey. vault.md
   l.787-788 ("`Cache-Control: immutable`, fetched in the background after sign-in") fetches the files in the
   background after sign-in; a proof at app open needs them kept between visits and re-checked by sha256, or every
   open waits on that fetch before it can prove.
6. **Faster proofs, named, not built.**
   - Our own small pool of same-origin workers (vault.md l.783-784 "our own small pool of same-origin workers (no
     policy change)") runs proofs of different notes side by side. It does not make one proof faster.
   - Multi-thread snarkjs needs `SharedArrayBuffer`, which needs cross-origin isolation:
     `Cross-Origin-Opener-Policy: same-origin` (already sent) plus `Cross-Origin-Embedder-Policy: require-corp` on
     every SIGN_HOST document, and every cross-origin resource it loads must then opt in. ffjavascript's thread
     workers are `blob:` URLs (finding 2), which 2.14 refuses, so it also needs a same-origin thread script. It
     reverses vault.md l.778-779 ("the prover needs no cross-origin isolation headers") and app.md l.670 ("| COEP |
     not sent |"), so it is a decision for the vault and app cards.

**Lines a later card must change** (not edited on this card; at research main 4c11149):

- vault.md l.794-797 ("**Speed.** Published phone timing"): the published 0.92-1.05 s and "G1 proof 2 (Oct 29) and
  V2.5 measure ours" become the measured 8.3 s and 0.6 s, and when proofs are made (items 1-3).
- vault.md l.145-146 ("always proves against the newest roots") and l.844 ("The kit proves against the newest
  roots"): either kept, with the remake rule of item 3 written beside them, or changed to a bounded root age with its
  cost (item 3).
- vault.md l.783-784 ("Fallbacks only if the M1 timing says single thread is too slow"): the timing is in; the pool
  and multi-thread with their costs (item 6).
- vault.md l.787-788 ("fetched in the background after sign-in"): the files kept on the device between visits
  (item 5).
- wallet.md l.535-536 ("the amount they type"), l.671 ("amount is a ladder size", in the row that also covers a
  withdraw to the user) and l.746 ("WM-06 | Withdraw to the user", any amount up to the unspent notes): one rule,
  from item 2's decision.
- wallet.md l.478-479 ("Arming starts at a random delay of minutes after a deposit lands"): a proof made ahead is
  made at that delay, never at landing (item 3).
- wallet.md l.355-357 ("takes 0.65-1.05 s in a phone browser") and l.490 ("proof 0.65-1.05 s published"): the
  measured number.
- app.md l.375-377 ("SIGN-TOP makes the withdrawal proof: 0.65-1.05 s published; G1 proof 2 measures ours; never at
  the tap", quote then proof): the withdraw to the user proves after the amount is typed unless item 2 picks
  ladder-only; the quote at use for a proof made ahead (item 4).
- app.md l.988 ("proving on the device (0.65-1.05 s published; G1 proof 2 measures ours)", CH-079): with a wait at
  the tap, the state shows on every withdraw to the user for about 8.3 s on this phone; with ladder-only, only when
  no proof is in hand.
- Only if multi-thread is picked: vault.md l.49 ("in one same-origin worker, single thread"), l.778-779 ("Single
  thread needs no `SharedArrayBuffer`") and l.1020 ("run in one same-origin worker, single thread"), and app.md
  l.670 ("| COEP | not sent |").

## Serving for the owner's phone visit

- `serve.mjs` (card g1-phone-live) mounts this page at `/prover/`:
  - every other route answers byte for byte as before (`test/prover-mount.test.js` test 1, against main's copy in
    `test/fixtures/serve-main.mjs`, blob 795a4c8);
  - 2.14's headers are on every `/prover/` answer;
  - `zk/` serves only the six pinned names. A file is hashed on its first read and must equal its name; later reads
    trust that answer while the realpath, size and mtime stay the same (`serve.mjs` comment at l.173-176), and the
    page re-hashes every file before use;
  - each zk request reads the whole file into memory (17.8 MB for the withdraw zkey). This is accepted for a funnel
    that is up only for one visit;
  - path escapes and symlinks out are refused;
  - `/prover/` answers 404 while `dist/` is missing;
  - `POST /prover/results` writes into `results/phone/`, with the same caps as `/results`. The `.gitignore` lets
    only its `*.json` through, so the owner's run is committed. A later `phone.sh` visit moves `results/phone/` to
    `results/phone-<UTC stamp>/` (ignored), so in that checkout git shows the committed files as deleted until
    that visit's own posts are committed.
  - serve.sh is unchanged.
- **The visit:** the team lead runs `cd ~/Downloads/confidential-trenches/proofs/g1-phone-prover && bash phone.sh` (research
  main, after this card merges), unattended from a non-interactive shell: no prompt, no `read`, nothing waits on a
  key (`test/phone.test.mjs`, stdin from /dev/null). It must run only after the owner's trade run is off: while
  main's own serve.sh holds the funnel on 443, serve.sh refuses a second one, as it should. The owner only opens
  the link on the phone. phone.sh runs
  fetch.sh, npm ci here, `build.mjs --out dist`, then npm ci in `../g1-phone-trade` (serve.sh's own build needs
  esbuild and serve.sh never installs it), then `exec bash ../g1-phone-trade/hosting/serve.sh`. If any step fails, it
  prints one line naming the step and serve.sh never runs. `--off` and `--check` go straight to serve.sh with no
  build.
  - Checked from a clean worktree (no node_modules or dist in either folder) with serve.sh stubbed: it reached the
    stub with the dist built, and g1-phone-trade's `node build.mjs` exited 0
    (`results/runs/20261026T104500Z-phone-trade-ci/`).
  Before the hand-off, a non-empty `results/phone/` from an earlier visit is moved to `results/phone-<UTC stamp>/`,
  and one line says which path to open.
- The phone opens `https://<funnel host>/prover/?runs=5&auto=1&device=owner-phone`. Each proof is posted as soon as
  it is made. After the run, `node verify.mjs results/phone --host <funnel host>` re-verifies every posted proof,
  refuses any post that names the funnel host, and prints the table for the phone row. Run without `--host` on
  `results/phone`, it refuses to start.
- **Posts are outside input.** `POST /prover/results` is open to anyone who has the funnel URL, and every proof has
  the same fixed inputs. So verify.mjs refuses:
  - proof points not in the affine form snarkjs writes (z = 1). This closes Jacobian copies of the same point, which
    an outside read showed passing (`20261026T120000Z-read2-fixes/`);
  - a proof seen twice: the same `pi_a` x, which also catches the negated copy (-A, -B). Both files are named;
  - fetched files that are not the pins;
  - times that cannot hold (finishedAt - startedAt < proveMs).
  These checks stop copies of a posted proof, not a fresh one. A Groth16 proof can be re-randomised into a different valid proof
  of the same statement, so someone holding the URL could post fresh-looking proofs with any times on them. The real
  control on the phone numbers is who holds the funnel URL: it goes only to the owner, and the funnel is up only for
  the visit.
  A run whose tab was hidden (at its start or end, or with a visibility change during it) is verified but left out
  of cold, p50 and max, because a hidden tab is throttled. Someone with the URL could also fill the 200-file cap,
  and the page would then show the 429 on each later post.
- Posts made before the fix round (runs up to `20261026T104842Z`) carry no `hidden` field, so the current
  verify.mjs refuses them as outside its schema. They were verified by the verify.mjs of their own commit, and the
  numbers in the table above come from runs made after the fix.

## Tests and where they run

- `node --test test/*.test.mjs` (this folder): on the box at 8cdc332 (card phone-prover-p3s), 88 tests, 87 pass, 0 fail,
  1 skipped (the macOS-only Safari launch), in `run.sh 2` (`results/runs/20261031T164334Z/run.txt`: CSP CHECKS PASS,
  ALL 2 and ALL 4 RESULTS VERIFIED, exit 0); on the Mac, 88/88, one file at a time, and the new tests red against
  b78d330's files (`results/runs/20261031T163000Z-pp3s-mac/`); `mount-run.sh` on the box at 79b767b, its two
  phone-<stamp>.json posts verified with `--host no-funnel.invalid` (`results/runs/20261031T165256Z/run.txt`: MOUNT E2E
  PASS, ALL 2 RESULTS VERIFIED, 88 tests 87 pass 1 skipped, g1-phone-trade 460/460, MOUNT RUN: ALL STEPS PASS). Card g1pp-p3s round 3: on the box at 5366566, 83 tests, 82 pass,
  0 fail, 1 skipped (the macOS-only Safari launch; every cites test ran, from the committed fixture), in `run.sh 2`
  (`results/runs/20261026T223430Z/run.txt`: CSP CHECKS PASS, WebKit launched, the unseeded post holds neither the
  page's origin nor `127.0.0.1` in Chromium and WebKit, ALL 2 and ALL 4 RESULTS VERIFIED, exit 0). Round 2: at
  6793877, 80 tests, 79 pass, 1 skipped (`20261026T202416Z`). Card g1pp-p3s round 1: at 924df71, 74 tests, 71 pass, 3 skipped (the two cites tests on the real papers then needed history the
  box lacks), `20261026T192740Z`. Round 2 of g1-phone-prover: at
  04c1a75, 63 pass, 0 fail, 1 skipped (the macOS-only Safari launch), in `run.sh 2` (`results/runs/20261026T183513Z/run.txt`: CSP CHECKS PASS with the unseeded
  check "posted 1, recorded 1" in Chromium and WebKit, ALL 2 and ALL 4 RESULTS VERIFIED, exit 0). Round 1: 59 pass,
  1 skipped at 6bb51bc (`20261026T175516Z`). Before this branch: 58/58 on the Mac at 8513c4a (`results/runs/20261026T120000Z-read2-fixes/mac-all-tests.txt`).
  The box ran 55 pass, 0 fail, 1 skipped at c74cfb1 (`20261026T113710Z`); the skipped test is the macOS-only Safari
  launch. It covers:
  - headers and serve-local (path escapes over raw http);
  - verify.mjs, with a planted mutant per refusal (round 2: a foreign host in a violation, and the violations and
    violationCount shape; g1pp-p3s: `--host`, the five host forms, the raw text, duplicate keys, the split and
    encoded forms, and a phone* dir without `--host`; round 3: dots %-encoded 9, 20 and 1000 deep and as
    percent-encoded UTF-8, a host split across two adjacent strings, and `results/Phone` and a symlink to a phone
    dir; card phone-prover-p3s: the 32-round bound and a 256 KB post nested about 130k deep refused in under 2 s,
    entities whose digits are escapes, both readings of an invalid `%XX` byte, and posts named phone-<stamp>.json in a
    dir of any name);
  - run.sh's `G1PP_WEBKIT_ABSENT` (`test/run-sh.test.mjs`);
  - browser.mjs's WebKit gate and the path-only post check (`test/browser.test.mjs`);
  - check-cites.mjs, planted against made-up papers (card phone-prover-p3s: Line794, line:794, L794, p.794 and
    look-alike letters such as fullwidth ｌ.794), and RESULT.md's cites at 4c11149 (`test/cites.test.mjs`);
  - page.js;
  - mount-headers;
  - phone.sh, stubbed and run unattended;
  - desktop.sh's arguments, its dist fallback and the Safari launch, stubbed.
- `npm test` in `../g1-phone-trade`: 330/330 on the Mac (`results/runs/20261026T103001Z-mac-suite/`), with the
  mount tests. **`hosting-serve.test.js` is Mac only:** serve.sh's `started_at` uses BSD `date -j -f`
  (`../g1-phone-trade/hosting/serve.sh` l.161), which the Linux box lacks, so 5 of its tests fail there
  (`results/runs/20261026T101203Z/run.txt`).

## Runs

| run | where | what |
|---|---|---|
| `20261026T091557Z`, `091941Z`, `092305Z` | box | lane 1's own runs while building the page (superseded by the next) |
| `20261026T093336Z` | box | the lead's re-run of `run.sh`: CSP red/green/unseeded/uir, bench 5 per circuit, 10/10 re-verified, tests |
| `20261026T094103Z` | box + Mac | lane 2: mount end to end, red/green of the mount tests |
| `20261026T101203Z` | box | after merging main 6acc6df: mount end to end, 2/2 re-verified, both suites (5 Mac-only fails) |
| `20261026T103001Z-mac-suite` | Mac | g1-phone-trade suite 330/330 |
| `20261026T104500Z-phone-trade-ci` | Mac | phone.sh fix: test red/green, the clean-worktree run |
| `20261026T104842Z-desktop-chrome` | Mac | desktop Chrome, 5 per circuit, 10/10 re-verified |
| `20261026T111705Z-fixes`, `20261026T112754Z-fixes-unattended` | Mac | lane 5: the fix round's red/green (a planted mutant per verify refusal), and phone.sh with stdin /dev/null |
| `20261026T112849Z` | box | `run.sh` at a218647 (the fix round): CSP CHECKS PASS, 10/10 re-verified |
| `20261026T113710Z` | box | `run.sh` at the merged card (c74cfb1): CSP CHECKS PASS, bench 10/10 re-verified, tests 55 pass, 0 fail, 1 skipped (the Safari launch test is macOS only) |
| `20261026T120000Z-read2-fixes` | Mac | the second outside read's fixes: verify red/green (Jacobian and negated copies), phone.sh link red/green, all prover tests 58/58, the three evidence runs re-verified together (ALL 30) |
| `20261026T121253Z-trade-mac` | Mac | the whole g1-phone-trade suite at f447719 through the laptop queue: 329/330, the 5 Linux-only `hosting-serve.test.js` tests green; the one failure is `review-n6-nested-encoding.test.js` "not confirmed within 90 s" while other jobs held the Mac at load 8-32 (this card does not touch that file; it passed on the box in 0.6 s); alone in the queue it passes 6/6 in 0.57 s (`n6-alone-mac.txt`) |
| `20261026T115724Z` | box | `mount-run.sh 5` at f447719: the `/prover/` mount on the fixed page, MOUNT E2E PASS, 10 posts 201, ALL 10 RESULTS VERIFIED (again on the Mac from `posted/`), prover tests 57 + 1 skipped (macOS only); its exit 1 is the 5 Linux-only `hosting-serve.test.js` failures (BSD `date -j`, serve.sh:161), green on the Mac in `20261026T121253Z-trade-mac` |
| `20261026T113310Z-desktop-chrome` | Mac | desktop Chrome on the fixed page, before the switches: 9 of 10 hidden (kept as the record) |
| `20261026T113558Z-desktop-chrome` | Mac | desktop Chrome 156, 5 per circuit, 0 hidden, 10/10 re-verified |
| `20261026T113644Z-desktop-safari` | Mac | desktop Safari 26.6, 5 per circuit, `--local-http`, 0 hidden, 10/10 re-verified |
| `20261026T174252Z-phone-verify` | Mac | `verify.mjs results/phone`: the owner's iPhone run, ALL 10 RESULTS VERIFIED; the red/green runs of both violation tests |
| `20261026T175216Z` | box | `run.sh 2` at 079a945: CSP CHECKS PASS, 2 + 4 verified, tests 58 pass, 1 skipped; its unseeded post has `violationCount` 0 though a violation was recorded (fixed next) |
| `20261026T175516Z` | box | `run.sh 2` at 6bb51bc: CSP CHECKS PASS, 2 + 4 verified, tests 59 pass, 1 skipped; the unseeded post carries its violation |
| `20261026T181532Z-cites` | Mac | round 2: `check-cites.mjs` resolves every vault.md, wallet.md and app.md cite in this file at research main 4c11149 (round 1's text: 11 fail); replaced by `check-cites.mjs` in this folder (card g1pp-p3s), which reads the quote beside each cite |
| `20261026T181521Z-w1-tests` | Mac | round 2 worker: page and verify tests red against 9f1010c, green after |
| `20261026T182013Z-w1-red` | box | round 2: the page at b34f1a5 with the new browser.mjs: unseeded "posted 0, recorded 1" in Chromium and WebKit, CSP CHECKS FAIL |
| `20261026T182826Z` | box | round 2 worker: `run.sh 2` at 6f0b54a: CSP CHECKS PASS (unseeded "posted 1, recorded 1" in Chromium and WebKit), 2 + 4 verified, tests 63 pass, 1 skipped |
| `20261026T183254Z-lead-tests` | Mac | round 2: the lead's re-run of the page and verify tests, red against 9f1010c, green at 3abe4ea |
| `20261026T183513Z` | box | round 2, the lead: `run.sh 2` at 04c1a75: CSP CHECKS PASS (unseeded "posted 1, recorded 1" in Chromium and WebKit, `127.0.0.1` 0 times in both posts), 2 + 4 verified, tests 63 pass, 1 skipped, exit 0 |
| `20261026T192400Z-p3s-mac` | Mac | card g1pp-p3s: the new `verify`, `browser` and `cites` test files red against 0fa837f (2 of 20, 1 of 1 at import, 3 of 3 fail; the old checker passes the planted P2, P3 and P7 and skips P4 and P5) and green after (20/20, 5/5, 3/3); `five-forms.txt`: the five host forms in a sample and in `verifyError` pass verify.mjs at 0fa837f (10 of 10) and are refused with `--host` (10 of 10), the host never printed |
| `20261026T192740Z` | box | card g1pp-p3s: `run.sh 2` at 924df71: CSP CHECKS PASS (WebKit 26.6 launched; unseeded "posted 1, recorded 1" and "found: neither" in Chromium and WebKit), 2 + 4 verified, tests 74, 71 pass, 3 skipped, exit 0 |
| `20261026T202140Z-p3s-r2-mac` | Mac | card g1pp-p3s round 2: `verify`, `cites` and `run-sh` test files red against a0c5fd6 (4 of 24, 3 of 3, 1 of 2 fail) and green after (24/24, 3/3, 2/2); `host-probe.txt`: the round 1 Verifier's 21 hostile posts, 9 pass verify.mjs at a0c5fd6 (the duplicate key and the split and encoded forms), 21 of 21 refused after, the host never printed; `dup/phone-dup.json` refused; `cites-probe.txt`: the Verifier's cite probes, a one-letter quote and a 1000-line range pass at a0c5fd6, all 10 refused after |
| `20261026T202416Z` | box | card g1pp-p3s round 2: `run.sh 2` at 6793877: CSP CHECKS PASS (WebKit launched; "found: neither" in Chromium and WebKit), 2 + 4 verified, tests 80, 79 pass, 1 skipped (Safari, macOS only), 0 cites tests skipped, exit 0 |
| `20261026T223039Z-p3s-r3-mac` | Mac | card g1pp-p3s round 3: `verify` and `cites` test files red against 3494ae7 (3 of 26, 1 of 4 fail) and green at 5366566 (26/26, 4/4; `run-sh` 2/2); `verifier-probes.txt`: the round 2 Verifier's `depth9/` x9 and xutf8 pass at 3494ae7 (exit 0) and all three are refused after (exit 1), its `cites2.md` D1-D4 give "ALL 0 CITES PASS" at 3494ae7 and "CITES FAIL: 4 of 4" after; `phone-gate-probe.txt`: `results/Phone` and a symlink to `results/phone` verify the 10 phone posts without `--host` at 3494ae7, and are refused after, `--no-funnel` unknown; `worst-case-timing.txt`: a 256 KB post nested 130,088 deep, 48 s |
| `20261026T223430Z` | box | card g1pp-p3s round 3: `run.sh 2` at 5366566: CSP CHECKS PASS (WebKit launched; "found: neither" in Chromium and WebKit), 2 + 4 verified, tests 83, 82 pass, 1 skipped (Safari, macOS only), 0 cites tests skipped, exit 0 (`heavy.txt`) |
| `20261026T223557Z` | box | card g1pp-p3s round 3: `mount-run.sh 1` at 5366566: MOUNT E2E PASS, 2 posts 201 written into `posted/` (serve.mjs's results dir for the run), ALL 2 RESULTS VERIFIED from `posted/` without `--host`, prover tests 83, 82 pass, 1 skipped; its exit 1 is 5 `hosting-serve.test.js` failures in g1-phone-trade, which this card does not touch (their output is left out of the committed `run.txt`: it prints the Mac's tailnet name) |
| `20261031T175835Z-pool-red-mac` | Mac | card proof-pool-time: `pool`, `browser-pool` and `verify-pool` test files red against main 64e2cb4 (13 of 13, 4 of 4, 14 of 14 fail) and green on the branch (13/13, 4/4, 14/14); `phone.test.mjs` test (k) red on main's phone.sh (19 of 20 pass) and green after (20/20) |
| `20261031T175855Z-pool` | box | card proof-pool-time: `pool-run.sh 3` at 8db268b: pools of 15 and 3, k = 1..6, 3 reps, POOL RUN PASS, ALL 144 RESULTS VERIFIED (again on the Mac: `mac-verify.txt`), the card's 3 test files 31/31 |
