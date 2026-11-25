import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { waitFor } from '../../src/testkit/timing';
import { repoRootDir } from '../../src/testkit/paths';
import { fetchJson } from '../../src/testkit/http';

const execFileAsync = promisify(execFile);
const LIVE = process.env.HAPPIER_LIVE_AGY_TIER3 === '1';
const run = createRunDirs({ runLabel: 'agy-tier3c-edge' });

describe.skipIf(!LIVE)('Tier 3c: agy edge cases (10s background cmd, set-model, legacy mode=yolo)', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterEach(async () => {
    await daemon?.stop().catch(() => {});
    daemon = null;
    await server?.stop().catch(() => {});
    server = null;
  });

  it('handles 10s backgrounded shell command, mid-session set-model, and legacy --mode yolo', async () => {
    const testDir = run.testDir('agy-edge-cases');
    const cliHomeDir = resolve(join(testDir, 'cli-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(cliHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
    const auth = await createTestAuth(server.baseUrl);
    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome: cliHomeDir, serverUrl: server.baseUrl, token: auth.token, secret });

    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HAPPIER_HOME_DIR: cliHomeDir,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_PUBLIC_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'symlink',
      HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
    };

    daemon = await startTestDaemon({ testDir, happyHomeDir: cliHomeDir, env: baseEnv, startupTimeoutMs: 60_000 });
    await waitFor(async () => {
      const res = await fetchJson<Array<{ id: string }>>(`${server!.baseUrl}/v1/machines`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      });
      return Boolean(res.data?.[0]?.id);
    }, { timeoutMs: 30_000 });

    const cliDist = resolve(repoRootDir(), 'apps/cli/dist/index.mjs');
    const runCli = async (args: string[], timeoutMs = 120_000) => {
      try {
        const { stdout, stderr } = await execFileAsync(process.execPath, [cliDist, ...args], {
          cwd: workspaceDir,
          env: baseEnv,
          timeout: timeoutMs,
        });
        return { ok: true as const, stdout: stdout.trim(), stderr: stderr.trim() };
      } catch (err: any) {
        return {
          ok: false as const,
          code: err?.code,
          stdout: String(err?.stdout ?? '').trim(),
          stderr: String(err?.stderr ?? '').trim(),
          message: String(err?.message ?? err),
        };
      }
    };

    // Edge case 1: What happens when a client passes legacy --mode yolo (like 0.2.16 UI did)?
    const legacyModeRes = await runCli([
      'session', 'create',
      '--backend', 'agy',
      '--auth', 'native',
      '--path', workspaceDir,
      '--title', 'Legacy Mode Yolo Check',
      '--model', 'gemini-4-neon-xhigh',
      '--permission-mode', 'yolo',
      '--mode', 'yolo',
      '--json',
    ]);
    console.log('[Tier3c] legacy --mode yolo create:', JSON.stringify(legacyModeRes).slice(0, 500));

    // Edge case 2: Normal session -> 10s backgrounded command -> set-model -> follow-up
    const created = await runCli([
      'session', 'create',
      '--backend', 'agy',
      '--auth', 'native',
      '--path', workspaceDir,
      '--title', 'Tier3c Edge Cases',
      '--model', 'gemini-4-neon-high',
      '--permission-mode', 'yolo',
      '--json',
    ]);
    expect(created.ok).toBe(true);
    const parsedCreate = JSON.parse(created.stdout);
    const sessionId: string = parsedCreate?.data?.session?.id ?? parsedCreate?.session?.id;
    expect(sessionId).toBeTruthy();

    // 10s command (exceeds default 5s WaitMsBeforeAsync!)
    const marker = 'SLOW_BG_10S_OK_99';
    const slowTurn = await runCli([
      'session', 'send', sessionId,
      `Run the shell command \`sleep 10 && echo ${marker}\` and wait for it to finish, then reply with ONLY its stdout.`,
      '--wait', '--timeout', '90', '--json',
    ], 110_000);
    console.log('[Tier3c] 10s bg turn:', JSON.stringify(slowTurn).slice(0, 400));
    expect(slowTurn.ok).toBe(true);

    const hist = await runCli(['session', 'history', sessionId, '--limit', '15', '--json']);
    console.log('[Tier3c] 10s bg history contains marker:', hist.stdout.includes(marker));
    expect(hist.stdout).toContain(marker);

    // Mid-session model switch
    const switchRes = await runCli(['session', 'set-model', sessionId, 'gemini-4-neon-xhigh', '--json']);
    console.log('[Tier3c] set-model:', JSON.stringify(switchRes).slice(0, 300));
    expect(switchRes.ok).toBe(true);

    const afterSwitch = await runCli([
      'session', 'send', sessionId,
      'Do not run any tools. Reply with ONLY: SWITCH_OK',
      '--wait', '--timeout', '60', '--json',
    ]);
    expect(afterSwitch.ok).toBe(true);
    const hist2 = await runCli(['session', 'history', sessionId, '--limit', '10', '--json']);
    expect(hist2.stdout).toContain('SWITCH_OK');
  }, 240_000);
});
