# Releasing

How escape-clause versions and releases are produced, and the one-time setup the
maintainer performs. The design follows the project's own philosophy: **automation
prepares, a human approves**. Nothing reaches npm without a deliberate merge.

## How users get the code

```bash
npm install -g escape-clause   # deliver the code
escape-clause install          # copy it into ~/.escape-clause/app (the trusted location)
escape-clause update           # later: fetch the latest release + re-run install
```

npm is only the **delivery channel** — the code that runs with host privileges is
always the copy `install` places in `~/.escape-clause/app`, outside the agent's
reach. `launch` refuses on version drift between the CLI and that installed copy
(same philosophy as config-drift refusal), so an `npm install -g` upgrade is inert
until the human runs `escape-clause install` again.

## Release flow (per release)

1. PRs that change user-visible behavior include a changeset (`npx changeset` —
   pick the semver bump, write the changelog entry). The
   [changeset-bot](https://github.com/apps/changeset-bot) flags PRs missing one.
2. On merge to `main`, the [release workflow](../.github/workflows/release.yml)
   opens or updates a standing **"Version Packages" PR** that accumulates pending
   changesets, showing the next version and changelog.
3. **Releasing = merging that PR.** The workflow then bumps `package.json`, writes
   `CHANGELOG.md`, tags `vX.Y.Z`, creates the GitHub Release, and runs
   `changeset publish` — an `npm publish` with **provenance**: the package is
   cryptographically linked to this repo, the exact commit, and the workflow run
   that built it (visible on the npm package page).

There is no npm token stored anywhere. CI authenticates via **trusted publishing**:
npm's registry accepts the workflow's GitHub OIDC token because the package on
npmjs.com is configured to trust exactly this repository and workflow file.

## One-time setup (maintainer)

1. **npm account** at npmjs.com with **2FA enabled**.
2. **First publish is manual** (trusted publishing can only be configured on a
   package that already exists):

   ```bash
   npm login
   npm publish        # from the repo root, at the version in package.json
   git tag v0.1.0 && git push origin v0.1.0
   ```

3. **Configure the trusted publisher**: npmjs.com → `escape-clause` → Settings →
   Trusted Publisher → GitHub Actions → repository `tbuckley/escape-clause`,
   workflow `release.yml`. While there, set publishing access to *"Require
   two-factor authentication or a trusted publisher"* so a leaked password alone
   can't ship a release.
4. **Install the [changeset-bot](https://github.com/apps/changeset-bot)** GitHub
   App on the repo (optional but recommended — it comments on PRs that lack a
   changeset).

## Notes

- `npm audit` shows two moderate advisories in `@modelcontextprotocol/sdk`'s
  transitive `@hono/node-server` (a Windows-only static-file path traversal in a
  server role the broker doesn't use). The fix upstream requires an SDK major
  downgrade; revisit when the SDK bumps its dependency.
- Possible follow-up: ship an `npm-shrinkwrap.json` so end-user installs resolve
  the exact locked dependency tree (npm excludes `package-lock.json` from
  published tarballs; shrinkwrap is the published equivalent). Fits the project's
  hash-pinning posture; costs a regeneration step per dependency change.
