# Release guide

Pi Aevin is published to npm and discovered by the
[Pi gallery](https://pi.dev/packages/pi-aevin) via the `pi-package`
keyword. No separate Pi publish step is needed.

## 1. Prepare

- Bump the version with `npm version patch --no-git-tag-version` (or `minor` / `major`).
- Move changes from **Unreleased** into a dated `CHANGELOG.md` section and update its links.
- Run `npm ci`, `npm run typecheck`, `npm test`, and `npm pack --dry-run`.
- Optionally run `pi -e .` to test locally; stop other Pi Aevin instances first.
- Commit and push the changes.

## 2. Release and approve

1. Create a published, non-prerelease GitHub release for the commit. Its tag
   must match the package version, e.g. `v0.1.3` for `0.1.3`.
2. [GitHub Actions](https://github.com/0Tarun0709/pi-aevin/actions/workflows/publish.yml)
   runs the checks and stages the npm package. A tag push alone won't trigger it.
3. Once npm's automated review finishes, review and approve the stage with 2FA:

   ```sh
   npm stage list pi-aevin
   npm stage view <stage-id>
   npm stage approve <stage-id>
   ```

   Don't rerun the workflow while the package is staged. Never share tokens,
   2FA codes, or authentication links. The GitHub release is public before npm approval.
4. Verify with `npm view pi-aevin version dist-tags --json` and
   check the [Pi gallery](https://pi.dev/packages/pi-aevin).
   Website updates may take time.

For npm trusted publishing, use owner `0Tarun0709`, repository `pi-aevin`,
and workflow `publish.yml`. Direct publishing permission isn't needed. A newly
configured trusted publisher must complete its first successful publish within
two days.
