// What SIGN_HOST's build reads, repository paths: packages/signpage/scripts/deploy.mjs build() copies public/'s tracked
// files (the _headers file), build-app.mjs builds index.html, app.js and the prover's worker and thread file from the
// page's, the wallet's and the kit's sources and the packages the lockfile pins (card signpage-generated-merge-free: the
// bundle is no longer committed, so its sources are the inputs), and build-app.mjs SERVED copies the prover's setup files
// and licences (packages/kit/zk) and the Apache licence (LICENSE). build-app.mjs refuses a SERVED file outside these, and
// release.test.mjs holds every module the bundle carries to them, so the verify gate, which runs from main's scripts/
// alone, reads the same list the build does. The configuration the build reads by construction is SIGN_BUILD_CONFIG.
export const SIGN_BUILD_CONFIG = Object.freeze([
  "packages/signpage/package.json",
  "packages/signpage/scripts/build-app.mjs",
  "packages/wallet/package.json",
  "packages/kit/package.json",
  "packages/kit/tsconfig.json",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
]);
export const SIGN_BUILD_INPUTS = Object.freeze([
  "packages/signpage/src",
  "packages/signpage/public",
  "packages/wallet/src",
  "packages/kit/src",
  "packages/kit/zk",
  "LICENSE",
  ...SIGN_BUILD_CONFIG,
]);

/** True when the repository path `path` is one of SIGN_BUILD_INPUTS or inside one. */
export const isSignBuildInput = (path) => SIGN_BUILD_INPUTS.some((i) => path === i || path.startsWith(`${i}/`));

/** What SIGN_HOST's build writes from its sources (packages/signpage/scripts/build-app.mjs), repository paths: built at
 *  every read and every deploy, never committed (card signpage-generated-merge-free: a committed bundle conflicts on
 *  every pair of signing page branches). scripts/ci/no-tracked-build-output.mjs refuses a tree that tracks one or does
 *  not ignore one. */
export const SIGN_BUILD_OUTPUTS = Object.freeze([
  "packages/signpage/index.html",
  "packages/signpage/public/app.js",
  "packages/signpage/public/prover-worker.js",
  "packages/signpage/public/prover-thread.js",
]);
