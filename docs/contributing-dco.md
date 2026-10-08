# Developer Certificate of Origin

Every non-merge commit in a pull request must include a `Signed-off-by` trailer that
matches this format:

```text
Signed-off-by: Your Name <you@example.com>
```

Use `git commit -s -m "Describe the change"` when creating commits. If a branch
already has unsigned commits, replay them on the PR target and push the updated
history:

```sh
git rebase --signoff origin/main
git push --force-with-lease
```

Replace `main` with the PR target branch when it differs.

The DCO CI check requires Git and GnuPG (`gpg`) on its runner to verify
signatures for commits matching the configured bot exemption. Local checks do
not need GnuPG unless a commit has that exact exempt author and committer
identity.

The configured `copilot-swe-agent[bot]` exemption applies only to commits with
its exact configured author identity, the `GitHub <noreply@github.com>`
committer, and a valid signature from a pinned GitHub web-flow key. The bot
cannot provide a human DCO certification, so the human maintainer who
squash-merges the pull request certifies the change. Maintainers can also require
sign-off on web-based commits in the repository settings so the squash commit
on `main` carries the sign-off.
