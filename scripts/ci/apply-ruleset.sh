#!/usr/bin/env bash
# Create or update the `main` branch ruleset from scripts/ci/ruleset-main.json.
#
#   scripts/ci/apply-ruleset.sh [owner/repo]     # defaults to the current gh repo (nizamali1-coder/harbor)
#
# Needs `gh auth login` as a repo admin. Idempotent: updates the ruleset named "main"
# if it exists, otherwise creates it.
set -euo pipefail

repo="${1:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
file="$(dirname "$0")/ruleset-main.json"
name="$(jq -r .name "$file")"

id="$(gh api "repos/$repo/rulesets" --jq ".[] | select(.name == \"$name\") | .id" | head -n1)"

if [[ -n "$id" ]]; then
  gh api --method PUT "repos/$repo/rulesets/$id" --input "$file" --jq '"updated ruleset \(.name) (#\(.id))"'
else
  gh api --method POST "repos/$repo/rulesets" --input "$file" --jq '"created ruleset \(.name) (#\(.id))"'
fi
