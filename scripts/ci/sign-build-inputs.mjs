// What SIGN_HOST's build reads, repository paths: packages/signpage/scripts/deploy.mjs build() copies index.html and
// public/, and build-app.mjs SERVED copies the prover's setup files and licences (packages/kit/zk) and the Apache
// licence (LICENSE). build-app.mjs refuses a SERVED file outside these, and release.test.mjs holds build() to them, so
// the verify gate, which runs from main's scripts/ alone, reads the same list the build does.
export const SIGN_BUILD_INPUTS = Object.freeze(["packages/signpage/index.html", "packages/signpage/public", "packages/kit/zk", "LICENSE"]);

/** True when the repository path `path` is one of SIGN_BUILD_INPUTS or inside one. */
export const isSignBuildInput = (path) => SIGN_BUILD_INPUTS.some((i) => path === i || path.startsWith(`${i}/`));
