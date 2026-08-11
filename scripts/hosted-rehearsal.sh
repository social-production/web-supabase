#!/usr/bin/env bash
# Hosted Supabase dress rehearsal.
# Requires: SUPABASE_ACCESS_TOKEN (or prior `supabase login`), PROJECT_REF,
# and hosted JWT anon key.
#
# Example:
#   export SUPABASE_ACCESS_TOKEN=sbp_...
#   export PROJECT_REF=abcdefghijklmnop
#   export SUPABASE_ANON_KEY=eyJ...
#   bash ./scripts/hosted-rehearsal.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PROJECT_REF="${PROJECT_REF:-${SUPABASE_PROJECT_REF:-}}"
if [[ -z "$PROJECT_REF" ]]; then
  echo "Set PROJECT_REF to the hosted Supabase project ref (from https://<ref>.supabase.co)."
  exit 1
fi

if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  echo "Set SUPABASE_ACCESS_TOKEN (Account → Access Tokens) or run \`npx supabase login\` in a TTY first."
  exit 1
fi

HOSTED_URL="https://${PROJECT_REF}.supabase.co"
ANON_KEY="${SUPABASE_ANON_KEY:-${VITE_SUPABASE_ANON_KEY:-}}"
if [[ -z "$ANON_KEY" ]]; then
  echo "Set SUPABASE_ANON_KEY to the hosted JWT anon key (eyJ…), not sb_publishable_…"
  exit 1
fi

echo "== link =="
npx --yes supabase@latest link --project-ref "$PROJECT_REF"

echo "== db push =="
npx --yes supabase@latest db push --linked

echo "== deploy gateway =="
npx --yes supabase@latest functions deploy gateway --project-ref "$PROJECT_REF"

echo "== hosted smoke =="
SUPABASE_URL="$HOSTED_URL" \
SUPABASE_ANON_KEY="$ANON_KEY" \
VITE_SUPABASE_FUNCTIONS_URL="${HOSTED_URL}/functions/v1" \
npm run smoke

echo "Hosted rehearsal smoke OK."
echo "Next: set Auth Site URL / Redirect URLs for the frontend origin, then walk docs/SIGNOFF.md Hosted row."
echo "Cutover checklist: docs/CUTOVER.md"
