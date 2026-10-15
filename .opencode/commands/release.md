Release this project using the process in README.md:

1. Confirm the checkout is on `main`. Choose a new unused stable version, asking if the version bump is unclear, and update `Cargo.toml` and `Cargo.lock` to match.
2. Verify the work, building the frontend before Rust. Stage all work and commit everything.
3. Create an annotated `vX.Y.Z` tag matching the committed version, then run `git push --atomic origin main vX.Y.Z` with that version.
4. Watch the tag-triggered `release.yml` GitHub Actions run until it finishes. Report success or failure with the run URL and, on success, the published GitHub Release URL.

Stop and report any failed verification, commit, tag, or push. Do not proceed to publication after a failure.
