import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const required = [
  'README.md',
  'docs/CONTRACT_ALIGNMENT.md',
  'docs/ENV.md',
  'docs/LOCAL_DEV.md',
  'docs/HOSTED.md',
  'docs/PARITY_AUDIT.md',
  'docs/SIGNOFF.md',
  'docs/FASTAPI_ORACLE.md',
  'docs/CUTOVER.md',
  'docs/DEPLOYMENT.md',
  'docs/FEATURE_MATRIX.md',
  '.env.example',
  '.github/workflows/ci.yml',
  '.github/workflows/deploy.yml',
  'supabase/config.toml',
  'supabase/migrations/20260806000001_canonical_schema.sql',
  'supabase/migrations/20260806000002_grants_and_rls.sql',
  'supabase/migrations/20260806000003_search_sync.sql',
  'supabase/migrations/20260806000004_search_sync_extra.sql',
  'supabase/migrations/20260806000005_seed_platform_channel.sql',
  'supabase/functions/gateway/index.ts',
  'supabase/functions/_shared/access.ts',
  'supabase/functions/_shared/feeds.ts',
  'supabase/functions/_shared/mutations.ts',
  'supabase/functions/_shared/votes.ts',
  'supabase/functions/_shared/moderation.ts',
  'supabase/functions/_shared/board.ts',
  'supabase/functions/_shared/lifecycle.ts',
  'supabase/functions/_shared/detail.ts',
  'supabase/functions/_shared/phases.ts',
  'supabase/functions/_shared/conversion.ts',
  'supabase/functions/_shared/tags.ts',
  'supabase/functions/_shared/handlers.ts',
  'src/auth/README.md',
  'src/feeds/README.md',
  'src/content/README.md',
  'src/messages/README.md',
  'src/notifications/README.md',
  'src/search/README.md',
  'src/locations/README.md',
  'src/scopes/README.md'
];

const missing = required.filter((path) => !existsSync(join(root, path)));
if (missing.length > 0) {
  console.error('web-supabase scaffold missing paths:\n- ' + missing.join('\n- '));
  process.exit(1);
}

console.log('web-supabase structure ok');
