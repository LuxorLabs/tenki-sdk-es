# Release process

This repository is a read-only mirror of the `@tenkicloud/sandbox` SDK, which is
developed in Luxor's `tenki.app` monorepo. Source changes arrive here through an
automated sync — open issues here, but code changes are made upstream.

## How a release happens

Releases are automated except for one approval:

1. The version in `package.json` is bumped **upstream**. The sync commits it here
   and pushes the matching `vX.Y.Z` tag.
2. The tag triggers the **Publish** workflow (`.github/workflows/npm-publish.yml`), which builds, tests, packs,
   and **stages** the release to npm via OIDC trusted publishing (`npm stage publish`). Nothing is live yet.
3. **A maintainer of `@tenkicloud/sandbox` approves the staged release with 2FA:**

   ```
   npm stage approve <stage-id>
   ```

   The stage id is printed in the workflow's run summary; you can also approve it
   under **Staged Packages** on npmjs.com. Reject an unwanted stage with
   `npm stage reject <stage-id>`.

Only step 3 is manual — the version is never bumped or tagged by hand in this
repo.

## Dry run

Running the Publish workflow from the Actions tab (`workflow_dispatch`) builds,
tests, and runs `npm publish --dry-run` without publishing. It's a safe check
that never releases, and the only way to run the workflow that doesn't stage.
