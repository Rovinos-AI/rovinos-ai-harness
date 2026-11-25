# Spec archive

The `specs-archive` tag preserves the epic and task specifications that will
be removed in task 27.4. Issue links can then point to the same paths at that
tag instead of following `main`.

Immediately before 27.4 merges, a maintainer should create and push the
annotated tag at the current `main` commit:

```sh
git fetch origin main
git tag -a specs-archive origin/main -m "Archive task specifications"
git push origin specs-archive
```

After confirming the tag exists, run from the repository root with Node and
the workspace dependencies installed. Build the schemas package first:

```sh
yarn build:schemas
```

Set `GH_TOKEN` or `GITHUB_TOKEN` to a
GitHub token with repository issue read and write permissions. The default and
`--dry-run` list matching issue numbers and link counts without writing; the
script reads all open and closed issues. Pull requests are excluded.

```sh
node --experimental-strip-types scripts/maintainers/archive-spec-links.ts
node --experimental-strip-types scripts/maintainers/archive-spec-links.ts --dry-run
node --experimental-strip-types scripts/maintainers/archive-spec-links.ts --apply
```

Review the dry-run results before applying and arrange an exclusive editing
window for the affected issues. The script checks that the tag exists before
editing and stops if a matching issue changed since it was read. The GitHub
update is not atomic with that check, so a concurrent edit could be overwritten.
If GitHub rejects a request, wait before rerunning; links already pointing at
the tag are skipped.
