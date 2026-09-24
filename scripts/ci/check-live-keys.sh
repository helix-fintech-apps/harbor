#!/usr/bin/env bash
# Guard rail for non-production deploys: Harbor is a test subject and must only ever talk to
# Stripe TEST mode and the Plaid SANDBOX (the api function refuses to boot otherwise, too).
set -euo pipefail

key="${STRIPE_SECRET_KEY:-}"
if [[ "$key" == sk_live_* || "$key" == rk_live_* ]]; then
  echo "::error::STRIPE_SECRET_KEY is a LIVE key. Harbor staging and previews use sk_test_ keys only."
  exit 1
fi
if [[ -n "$key" && "$key" != sk_test_* && "$key" != rk_test_* ]]; then
  echo "::error::STRIPE_SECRET_KEY does not look like a Stripe test key (sk_test_/rk_test_)."
  exit 1
fi
plaid_env="${PLAID_ENV:-sandbox}"
if [[ "$plaid_env" != "sandbox" ]]; then
  echo "::error::PLAID_ENV=$plaid_env. Only the Plaid sandbox is allowed."
  exit 1
fi
if [[ -n "$key" ]]; then stripe="test key present"; else stripe="not configured (fake identity + issuer)"; fi
echo "Key check passed: Stripe $stripe, Plaid env sandbox."
