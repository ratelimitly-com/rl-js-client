# Releasing the JavaScript client

The repository publishes only the `ratelimitly-client` npm package. It does not
build or publish a RateLimitly server package.

## Release artifacts

The `release` workflow runs automatically on push to `main` when `package.json`
has a new version. It builds the package tarball, proves reproducibility, tests
that the tarball installs cleanly in an isolated consumer project, attests build
provenance, and publishes an atomic GitHub release.

The separate `publish-npm` workflow never rebuilds the distribution. Given a
numeric version, it downloads that version's existing GitHub release, verifies
`SHA256SUMS` and package metadata, and uploads that exact tarball to npm.

## Authentication and setup

npm publishing uses an authentication token stored as a GitHub Actions secret:

- Secret name: `NPM_TOKEN` (or `NODE_AUTH_TOKEN`)
- Permission: Automation token with publish rights for `ratelimitly-client`

## Publish an existing release

1. Confirm that `vX.Y.Z` is a complete, public GitHub release and that its tag
   targets the intended commit on `main`.
2. In GitHub Actions, manually dispatch the `publish-npm` workflow from `main`
   with version `X.Y.Z` (without the `v` prefix).
3. Verify that the workflow succeeds.
4. Install the exact version from npm in a clean project and verify imports:
   ```bash
   npm install ratelimitly-client@X.Y.Z
   ```

npm versions are immutable. If any verification fails, publish a new version;
never attempt to replace an existing npm release.
