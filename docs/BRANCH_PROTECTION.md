# Branch protection for `main`

`main` is protected by a repository **ruleset** named `main` (Settings → Rules → Rulesets). Rulesets replace classic branch protection: they can be layered, read via API by anyone with read access, and they support the `code_scanning` rule. The machine-readable source of truth is `scripts/ci/ruleset-main.json`.

## Settings

**Target:** default branch (`~DEFAULT_BRANCH`). **Enforcement:** Active. **Bypass list:** empty (nobody, including admins, bypasses).

| Rule                                                  | Setting                                                                                                                           |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Restrict deletions                                    | on                                                                                                                                |
| Block force pushes (`non_fast_forward`)               | on                                                                                                                                |
| Require linear history                                | on                                                                                                                                |
| Require a pull request before merging                 | on                                                                                                                                |
| → Required approvals                                  | **1**                                                                                                                             |
| → Dismiss stale approvals when new commits are pushed | on                                                                                                                                |
| → Require review from Code Owners                     | on (`.github/CODEOWNERS`, money code (domain, service, stores, migrations, seed, fee page) → `@nizamali1-coder`)                  |
| → Require approval of the most recent reviewable push | on                                                                                                                                |
| → Require conversation resolution before merging      | on                                                                                                                                |
| → Allowed merge methods                               | squash, rebase (merge commits would break linear history)                                                                         |
| Require status checks to pass                         | on                                                                                                                                |
| → Require branches to be up to date before merging    | on (strict)                                                                                                                       |
| → Required checks                                     | `lint`, `typecheck`, `unit`, `integration`, `db`, `e2e`, `build` (source: GitHub Actions, app id 15368), `CodeQL` (code scanning) |
| Require code scanning results                         | CodeQL: security alerts **High or higher**, alerts **Errors**                                                                     |

The check names are the job ids in `.github/workflows/ci.yml`. A check must have reported at least once (open a PR first) before the UI lets you pick it. The API accepts it straight away.

## Apply with `gh`

Needs `gh auth login` as a repository admin, and `jq`.

```bash
# Create or update (idempotent). Defaults to the current repo.
scripts/ci/apply-ruleset.sh                    # or: scripts/ci/apply-ruleset.sh nizamali1-coder/harbor
```

Or directly, creating it the first time:

```bash
gh api --method POST repos/{owner}/{repo}/rulesets \
  -H "Accept: application/vnd.github+json" \
  --input scripts/ci/ruleset-main.json
```

To update it later: `gh api repos/{owner}/{repo}/rulesets` gives the ruleset id. Then run:

```bash
gh api --method PUT repos/{owner}/{repo}/rulesets/<id> --input scripts/ci/ruleset-main.json
```

To check what is enforced on `main`:

```bash
gh api repos/{owner}/{repo}/rules/branches/main --jq '.[].type'
```

## Notes

- **Solo maintainer caveat.** GitHub never counts a PR author's own approval, and "most recent push approval" is on. So while `@nizamali1-coder` is the only code owner, their own PRs cannot merge. Add a second code owner (preferred), or temporarily add a bypass actor in pull-request-only mode, for example `{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "pull_request"}` (5 = Admin). Don't remove the review requirement.
- **Private repos** need GitHub Team (or higher) for rulesets and required reviews. Code scanning rules on private repos need GitHub Code Security.
- **Merge queue (optional).** `ci.yml` and `codeql.yml` already listen to `merge_group`, so you can add a `merge_queue` rule (squash, build concurrency 5) without workflow changes. With a merge queue you can turn off "require branches to be up to date".
- **Adding a check** (for example `helix`, see `docs/CI.md#helix-drop-in`): add it to `required_status_checks` in `scripts/ci/ruleset-main.json`, re-run `scripts/ci/apply-ruleset.sh`, and update the table above.
- Deploy environments: give the `staging` environment (Settings → Environments) a deployment branch rule of `main` only, so no other branch can read the staging secrets.
