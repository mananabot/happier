import { test, expect } from '@playwright/test';
import { randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { spawnLoggedProcess, type SpawnedProcess } from '../../src/testkit/process/spawnProcess';
import { waitForOkHealth } from '../../src/testkit/http';
import type { StartedDaemon } from '../../src/testkit/daemon/daemon';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { gotoDomContentLoadedWithRetries } from '../../src/testkit/uiE2e/pageNavigation';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';

const LIVE = process.env.HAPPIER_LIVE_AGY_TIER4 === '1';
const PROD_SERVER_BIN = '/Users/david/.happier/self-host/bin/happier-server';
const PROD_UI_DIR = '/Users/david/.happier/self-host/ui-web/current';
const PROD_MIGRATIONS_DIR = '/Users/david/.happier/self-host/data/migrations/sqlite';
const PROD_PRISMA_LIB = '/Users/david/.happier/self-host/bin/node_modules/.prisma/client/libquery_engine-darwin-arm64.dylib.node';
const PROD_NODE_PATH = '/Users/david/.happier/self-host/bin/node_modules';
const CHROMIUM_SHELL = '/Users/david/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell';

const run = createRunDirs({ runLabel: 'ui-e2e-agy-prod-compat' });

test.use({
  viewport: { width: 1280, height: 900 },
  ...(existsSync(CHROMIUM_SHELL) ? { launchOptions: { executablePath: CHROMIUM_SHELL } } : {}),
});

test.describe('Tier 4: 0.2.16 server + Web UI with forked PR #958 daemon (live agy 1.5.17)', () => {
  test.skip(!LIVE, 'Set HAPPIER_LIVE_AGY_TIER4=1 to run live Tier 4 UI E2E');

  const suiteDir = run.testDir('agy-prod-ui-compat');
  const cliHomeDir = join(suiteDir, 'cli-home');
  const dataDir = join(suiteDir, 'server-data');
  const workspaceDir = join(suiteDir, 'workspace');
  let serverProc: SpawnedProcess | null = null;
  let daemon: StartedDaemon | null = null;
  let baseUrl = '';

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    await mkdir(cliHomeDir, { recursive: true });
    await mkdir(join(dataDir, 'files'), { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const port = randomInt(35_000, 49_000);
    baseUrl = `http://127.0.0.1:${port}`;
    const dbFile = join(dataDir, 'happier-server-light.sqlite');

    serverProc = spawnLoggedProcess({
      command: PROD_SERVER_BIN,
      args: [],
      cwd: suiteDir,
      stdoutPath: join(suiteDir, 'prod-server.stdout.log'),
      stderrPath: join(suiteDir, 'prod-server.stderr.log'),
      env: {
        ...process.env,
        PORT: String(port),
        HAPPIER_SERVER_HOST: '127.0.0.1',
        HAPPIER_DB_PROVIDER: 'sqlite',
        HAPPIER_FILES_BACKEND: 'local',
        DATABASE_URL: `file://${dbFile}?socket_timeout=30&connection_limit=1`,
        HAPPIER_SERVER_LIGHT_DATA_DIR: dataDir,
        HAPPIER_SERVER_LIGHT_DB_DIR: join(dataDir, 'pglite'),
        HAPPIER_SERVER_LIGHT_FILES_DIR: join(dataDir, 'files'),
        HAPPIER_SQLITE_AUTO_MIGRATE: '1',
        HAPPIER_SQLITE_MIGRATIONS_DIR: PROD_MIGRATIONS_DIR,
        HAPPIER_SERVER_UI_DIR: PROD_UI_DIR,
        HAPPIER_PUBLIC_SERVER_URL: baseUrl,
        HAPPIER_WEBAPP_URL: baseUrl,
        HAPPIER_SERVER_TRUST_PROXY: '1',
        METRICS_ENABLED: 'false',
        NODE_PATH: PROD_NODE_PATH,
        PRISMA_CLIENT_ENGINE_TYPE: 'library',
        PRISMA_QUERY_ENGINE_LIBRARY: PROD_PRISMA_LIB,
      },
    });

    await waitForOkHealth(baseUrl, 45_000);
    console.log('[Tier4] Isolated 0.2.16 server + UI ready at', baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(60_000);
    await daemon?.stop().catch(() => {});
    await serverProc?.stop().catch(() => {});
    // Keep screenshots/logs in suiteDir, only remove large sqlite if needed
    await rm(join(dataDir, 'happier-server-light.sqlite'), { force: true }).catch(() => {});
  });

  test('authenticates forked daemon against 0.2.16 UI, selects agy + Neon, chats, reloads, and resumes', async ({ page }) => {
    test.setTimeout(240_000);
    const diagnostics = collectBrowserDiagnostics({ page });

    try {
      daemon = await authenticateAndStartDaemon({
        page,
        testDir: suiteDir,
        cliHomeDir,
        serverUrl: baseUrl,
        uiBaseUrl: baseUrl,
        extraEnv: {
          HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'symlink',
          HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
        },
      });
      console.log('[Tier4] Authenticated and started forked daemon against 0.2.16 server');

      // Navigate to New Session screen
      await gotoDomContentLoadedWithRetries(page, `${baseUrl}/new`, 90_000);
      await page.waitForTimeout(3000);
      await page.screenshot({ path: join(suiteDir, '01-new-session-initial.png'), fullPage: true });

      // Open agent/model picker by clicking the agent chip ("Use CLI settings")
      const agentSelector = page.locator('[data-testid="agent-input-agent-chip"]').first();
      await expect(agentSelector).toBeVisible({ timeout: 30_000 });
      await agentSelector.click();
      await page.waitForTimeout(1500);

      // Select Antigravity in the left agent rail
      const agyButton = page.getByRole('button', { name: /^Antigravity/i }).first();
      await expect(agyButton).toBeVisible({ timeout: 30_000 });
      await agyButton.click();
      await page.waitForTimeout(4000);
      await page.screenshot({ path: join(suiteDir, '03-agy-selected.png'), fullPage: true });

      // Verify Neon models appear in the right-hand MODEL pane!
      const neonButton = page.getByRole('button', { name: /Gemini 4 Neon \(High\)/i }).first();
      await expect(neonButton).toBeVisible({ timeout: 45_000 });
      console.log('[Tier4] Gemini 4 Neon (High) visible in 0.2.16 UI model picker!');
      await neonButton.click();
      await page.waitForTimeout(500);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(suiteDir, '04-neon-selected.png'), fullPage: true });

      // Check whether the 0.2.16 UI caused the forked daemon to install pinned agy-acp-server
      const pinnedDirExists = existsSync(join(cliHomeDir, 'tools', 'agy-acp-server'));
      console.log('[Tier4] pinned agy-acp-server dir exists in cliHomeDir:', pinnedDirExists);

      const composer = page.getByTestId('new-session-composer-input').first();
      await composer.click();
      const token = 'UI_NEON_7741';
      await composer.fill(`Remember the exact token ${token}. Compute 17 * 23. Do not run any tools. Reply with ONLY the integer result.`);
      await page.waitForTimeout(500);

      const startBtn = page.getByRole('button', { name: 'Start New Session' }).last();
      await expect(startBtn).toBeEnabled({ timeout: 15_000 });
      await startBtn.click();

      // Wait for navigation to the real /session/<id> view
      await page.waitForURL(/\/session\//, { timeout: 60_000 });
      const sessionUrl = page.url();
      console.log('[Tier4] Navigated to session URL:', sessionUrl);

      // Wait for computed assistant reply (391 does not appear in prompt!)
      await expect(page.getByText('391').first()).toBeVisible({ timeout: 90_000 });
      await page.screenshot({ path: join(suiteDir, '05-turn1-reply.png'), fullPage: true });
      console.log('[Tier4] Turn 1 computed reply (391) rendered cleanly!');

      // Reload page and verify transcript persists + send Turn 2!
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByText('391').first()).toBeVisible({ timeout: 45_000 });

      const sessionComposer = page.locator('[data-testid="session-composer-input"], textarea').first();
      await expect(sessionComposer).toBeVisible({ timeout: 30_000 });
      await sessionComposer.fill('What exact token did I ask you to remember? Prefix your answer with RECALL_OK: and nothing else. Do not run any tools.');
      await sessionComposer.press('Enter');

      await expect(page.getByText(`RECALL_OK: ${token}`).or(page.getByText(`RECALL_OK:${token}`)).first()).toBeVisible({ timeout: 90_000 });
      await page.screenshot({ path: join(suiteDir, '06-turn2-recalled.png'), fullPage: true });
      console.log('[Tier4] Turn 2 after reload rendered cleanly!');
    } catch (error) {
      await page.screenshot({ path: join(suiteDir, '99-failure.png'), fullPage: true }).catch(() => {});
      throw appendBrowserDiagnostics(error, diagnostics());
    }
  });
});
