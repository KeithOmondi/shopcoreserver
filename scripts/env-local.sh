#!/usr/bin/env bash
# Usage: source scripts/env-local.sh   (exports .env.example + dev public key)
set -a
. "$(dirname "${BASH_SOURCE[0]}")/../.env.example"
JWT_PUBLIC_KEY="$(cat "$(dirname "${BASH_SOURCE[0]}")/../.dev-keys/public.pem")"
set +a
