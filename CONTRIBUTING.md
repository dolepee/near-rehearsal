# Contributing and review gate

This repository is private and its current GitHub plan does not enforce branch
protection with rulesets. The following is therefore an enforced team procedure,
not a claim that GitHub is blocking bypasses.

## Required review path

1. Create a feature branch and open a pull request.
2. Push every candidate change and run the required checks.
3. Add a top-level PR comment `@codex review` that names the **full final head
   SHA** under review.
4. Wait for a completed, clean Codex review of **that exact SHA**.
5. Resolve every actionable finding and thread, and get CI green.
6. Re-read the PR head immediately before merging. Merge only that exact reviewed
   SHA.

Any new commit invalidates the review and requires a fresh `@codex review` of the
new full head SHA. Do not automerge, direct-push to `main`, or treat local tests
and source inspection as a substitute for the formal PR review.

The current release and merge hold remains in effect until the owner explicitly
lifts it.
