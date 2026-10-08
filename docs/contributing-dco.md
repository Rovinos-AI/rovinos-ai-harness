# Developer Certificate of Origin

Every non-merge commit in a pull request must include a `Signed-off-by` trailer that
matches this format:

```text
Signed-off-by: Your Name <you@example.com>
```

Use `git commit -s -m "Describe the change"` when creating commits. If a branch
already has unsigned commits, add the trailers with `git rebase --signoff` and
push the updated branch.

The configured `copilot-swe-agent[bot]` exemption is limited to commits authored
by that bot because it cannot provide a human DCO certification. The human
maintainer who squash-merges the pull request certifies the change; maintainers
can also require sign-off on web-based commits in the repository settings so the
squash commit on `main` carries the sign-off.
