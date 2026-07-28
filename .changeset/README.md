# Changesets

Release notes and version bumps are driven by [changesets](https://github.com/changesets/changesets).

When a PR contains a user-visible change, add a changeset to it:

```bash
npx changeset
```

Pick the bump (`patch` / `minor` / `major`) and write a sentence or two for the
changelog — written now, while the context is fresh, not derived from commit subjects.
The result is a small markdown file in this directory that ships with the PR.

On merge to `main`, CI maintains a standing **"Version Packages" PR** that accumulates
pending changesets. Releasing is merging that PR: it bumps `package.json`, writes
`CHANGELOG.md`, tags, creates the GitHub Release, and publishes to npm with provenance.
Nothing publishes without that deliberate merge. See
[docs/RELEASING.md](../docs/RELEASING.md) for the full flow and one-time setup.
