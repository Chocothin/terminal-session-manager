#!/bin/bash
set -euo pipefail

export TSM_AUTH_TOKEN="${TSM_AUTH_TOKEN:-dev-token-00000000000000000000}"

cd "$(dirname "$0")"
exec pnpm dev
