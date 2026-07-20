# Releasing NotDone

NotDone publishes two standalone npm packages, `notdone` and `notdone-mcp`,
from one versioned repository. Runtime plugins and the Gemini CLI extension use
the same version.

## One-time repository setup

1. Create an `npm` GitHub environment and add any desired reviewer protection.
2. For both npm packages, configure npm trusted publishing for
   `bbdyno/NotDone`, workflow file `.github/workflows/release.yml`, and the
   `npm` environment.
3. Protect `main`, require the CI checks, and restrict creation of `v*` tags to
   release maintainers.

The first publication of a new npm package name requires an npm granular access
token because the package settings page does not exist yet. Add a short-lived
token as the `NPM_TOKEN` secret in the `npm` GitHub environment. The release
workflow consumes it only as `NODE_AUTH_TOKEN` while retaining npm provenance.
Do not store or paste the token into the repository.

After the first release:

1. configure the trusted publisher for both packages with GitHub owner
   `bbdyno`, repository `NotDone`, workflow `release.yml`, environment `npm`,
   and the `npm publish` action;
2. delete the `NPM_TOKEN` environment secret; and
3. require 2FA and disallow token-based publishing in each package's settings.

## Release checklist

1. Update every version source and all five README guides.
2. Move the release notes in `CHANGELOG.md` out of `Unreleased`.
3. Run:

   ```sh
   pnpm install --frozen-lockfile
   pnpm check
   pnpm pack:release
   pnpm pack:verify
   node scripts/check-release-version.mjs v0.1.0
   ```

4. Merge the release commit to `main`.
5. Create and push an annotated version tag:

   ```sh
   git tag -a v0.1.0 -m "NotDone v0.1.0"
   git push origin v0.1.0
   ```

The tag workflow verifies that the tagged commit belongs to `main`, repeats the
complete test and package suite, generates SHA-256 checksums, creates GitHub
build-provenance attestations, publishes both npm packages using OIDC, and
creates the GitHub release.

Use the manual `workflow_dispatch` path to build and attest a candidate without
publishing it.

## Verification after publishing

```sh
npm view notdone version
npm view notdone-mcp version
gh release view v0.1.0
gh attestation verify artifacts/notdone-0.1.0.tgz --repo bbdyno/NotDone
```

Confirm that both package versions, checksums, provenance, release notes, and
five localized guides agree before announcing the release.
