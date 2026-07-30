# Changesets

This project uses [Changesets](https://github.com/changesets/changesets) for independent versioning of `@libris/api-hono` and `@libris/web`.

## Adding a changeset

When you make a change that should result in a version bump, run:

```bash
pnpm changeset
```

This will prompt you to:

1. Select which workspace(s) are affected
2. Choose a semver bump type (patch / minor / major)
3. Write a summary of the change

A `.changeset/<random-id>.md` file is created — commit it with your PR.

## Releasing

Trigger the **Publish Images** workflow. It automatically runs `changeset version` to consume pending changesets, bump versions, and generate changelogs — then only builds and pushes images for workspaces whose version changed since the last tagged release.
