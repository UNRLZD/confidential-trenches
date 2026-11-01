// The helper image's inputs: every path whose change can change what the deployed helper runs (apps/helper/Dockerfile,
// the root .dockerignore it builds with, each COPY line's source, and apps/helper/deploy). One list for the three
// places that ask "which commit should the helper serve": scripts/live-checks/helper-host-health.mjs (main's newest
// first-parent commit that touched one of these), deploy/local-proof.sh, and deploy/image-layout.test.mjs, which fails
// when a COPY source or the Dockerfile falls outside this list or an entry here covers none of them.
//   node apps/helper/deploy/image-inputs.mjs   prints the list, one path per line
export const IMAGE_INPUTS = Object.freeze(["apps/helper", "packages/kit", ".dockerignore", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]);

if (import.meta.main) console.log(IMAGE_INPUTS.join("\n"));
