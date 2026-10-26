import {defineConfig} from '@playwright/test';
import {join} from 'node:path';

// CYC_MD_TABLE_RIG points at an isolated scratch production engine/app rig.
// Evidence and measurements go outside the worktree, beside the owner screenshot.
export default defineConfig({
  testDir: './e2e/media',
  testMatch: 'md-table.spec.ts',
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: join(process.env.CYC_MD_TABLE_EVIDENCE ?? 'test-results', 'playwright'),
  use: {headless: true}
});
