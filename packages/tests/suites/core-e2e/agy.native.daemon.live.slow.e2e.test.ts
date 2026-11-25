import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { CapabilitiesInvokeRequest, CapabilitiesInvokeResponse } from '@happier-dev/protocol/capabilities';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { decryptLegacyBase64, encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { waitFor } from '../../src/testkit/timing';
import { repoRootDir } from '../../src/testkit/paths';
import { fetchJson } from '../../src/testkit/http';

const execFileAsync = promisify(execFile);
const LIVE = process.env.HAPPIER_LIVE_AGY_TIER3 === '1';
const run = createRunDirs({ runLabel: 'agy-tier3-daemon' });

describe.skipIf(!LIVE)('Tier 3b: live agy full-stack daemon + CLI E2E', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterEach(async () => {
    await daemon?.stop().catch(() => {});
    daemon = null;
    await server?.stop().catch(() => {});
    server = null;
  });

  it('probes Neon models over daemon RPC, spawns agy with Neon+yolo, runs multi-turn + shell tool + stop/resume', async () => {
    const testDir = run.testDir('agy-native-daemon-full');
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

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: cliHomeDir,
      env: baseEnv,
      startupTimeoutMs: 60_000,
    });

    // 1. Verify machine registered
    let machineId: string | null = null;
    await waitFor(async () => {
      const res = await fetchJson<Array<{ id: string }>>(`${server!.baseUrl}/v1/machines`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      });
      machineId = res.data?.[0]?.id ?? null;
      return Boolean(machineId);
    }, { timeoutMs: 30_000 });
    expect(machineId).toBeTruthy();

    // 2. Verify encrypted machine RPC capabilities.invoke (probeModels + probeModes)
    const ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
    ui.connect();
    try {
      await waitFor(() => ui.isConnected(), { timeoutMs: 20_000 });
      const invokeCap = async (method: 'probeModels' | 'probeModes') => {
        const req: CapabilitiesInvokeRequest = { id: 'cli.agy', method, params: { timeoutMs: 25_000 } };
        const rpc = await ui.rpcCall<any>(`${machineId}:${RPC_METHODS.CAPABILITIES_INVOKE}`, encryptLegacyBase64(req, secret));
        expect(rpc?.ok).toBe(true);
        const decoded = decryptLegacyBase64(String(rpc.result ?? ''), secret) as CapabilitiesInvokeResponse | null;
        expect(decoded?.ok).toBe(true);
        return (decoded as Extract<CapabilitiesInvokeResponse, { ok: true }>).result as any;
      };

      const modelsRes = await invokeCap('probeModels');
      console.log('[Tier3b] RPC probeModels:', JSON.stringify({
        source: modelsRes?.source,
        count: modelsRes?.availableModels?.length,
        hasNeonHigh: modelsRes?.availableModels?.some((m: any) => m.id === 'gemini-4-neon-high'),
        hasNeonXHigh: modelsRes?.availableModels?.some((m: any) => m.id === 'gemini-4-neon-xhigh'),
      }));
      expect(modelsRes?.source).toBe('dynamic');
      expect(modelsRes?.availableModels?.some((m: any) => m.id === 'gemini-4-neon-high')).toBe(true);
      expect(modelsRes?.availableModels?.some((m: any) => m.id === 'gemini-4-neon-xhigh')).toBe(true);

      const modesRes = await invokeCap('probeModes');
      console.log('[Tier3b] RPC probeModes:', JSON.stringify(modesRes?.availableModes?.map((m: any) => m.id)));
      expect(modesRes?.source).toBe('dynamic');
      expect(modesRes?.availableModes?.map((m: any) => m.id)).toEqual(
        expect.arrayContaining(['default', 'accept-edits', 'auto', 'plan']),
      );
    } finally {
      ui.close();
    }

    // Helper to invoke the built fork CLI against our isolated server + daemon
    const cliDist = resolve(repoRootDir(), 'apps/cli/dist/index.mjs');
    const runCliJson = async (args: string[], timeoutMs = 90_000) => {
      const { stdout, stderr } = await execFileAsync(process.execPath, [cliDist, ...args], {
        cwd: workspaceDir,
        env: baseEnv,
        timeout: timeoutMs,
      });
      try {
        return JSON.parse(stdout.trim());
      } catch (e) {
        throw new Error(`Non-JSON CLI output for [${args.join(' ')}]:\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
      }
    };

    // 3. Create live agy session with Neon XHigh + yolo permission mode
    const created = await runCliJson([
      'session', 'create',
      '--backend', 'agy',
      '--auth', 'native',
      '--path', workspaceDir,
      '--title', 'Tier3b Neon Live Test',
      '--model', 'gemini-4-neon-xhigh',
      '--permission-mode', 'yolo',
      '--json',
    ]);
    console.log('[Tier3b] session create:', JSON.stringify(created));
    const sessionId: string = created?.data?.session?.id ?? created?.session?.id ?? created?.id;
    expect(sessionId).toBeTruthy();

    // 4. Turn 1: remember codeword
    const token = 'ORBIT-4419';
    const turn1 = await runCliJson([
      'session', 'send', sessionId,
      `Remember the exact codeword ${token}. Do not run any tools. Reply with ONLY the word ACK.`,
      '--wait', '--timeout', '60', '--json',
    ]);
    console.log('[Tier3b] Turn 1:', JSON.stringify(turn1).slice(0, 300));

    // 5. Turn 2: recall codeword
    await runCliJson([
      'session', 'send', sessionId,
      'What is the exact codeword I asked you to remember? Do not run any tools. Reply ONLY with the codeword.',
      '--wait', '--timeout', '60', '--json',
    ]);
    const hist2 = await runCliJson(['session', 'history', sessionId, '--limit', '10', '--json']);
    const hist2Text = JSON.stringify(hist2);
    console.log('[Tier3b] History after Turn 2 contains token:', hist2Text.includes(token));
    expect(hist2Text).toContain(token);

    // 6. Turn 3: run a shell command under yolo mode and verify clean completion (no stall)
    const bgMarker = 'DAEMON_BG_OK_55';
    await runCliJson([
      'session', 'send', sessionId,
      `Run the shell command \`sleep 3 && echo ${bgMarker}\` and reply with ONLY its stdout.`,
      '--wait', '--timeout', '75', '--json',
    ], 90_000);
    const hist3 = await runCliJson(['session', 'history', sessionId, '--limit', '15', '--json']);
    const hist3Text = JSON.stringify(hist3);
    console.log('[Tier3b] History after Turn 3 contains bgMarker:', hist3Text.includes(bgMarker));
    expect(hist3Text).toContain(bgMarker);

    // 7. Stop session, then send a follow-up (triggers automatic resume!) and verify memory
    await runCliJson(['session', 'stop', sessionId, '--json']);
    await runCliJson([
      'session', 'send', sessionId,
      'Repeat the exact codeword from earlier in this conversation. Do not run any tools. Reply ONLY with the codeword.',
      '--wait', '--timeout', '60', '--json',
    ]);
    const hist4 = await runCliJson(['session', 'history', sessionId, '--limit', '10', '--json']);
    const hist4Text = JSON.stringify(hist4);
    // Check the latest assistant message specifically
    console.log('[Tier3b] History after stop+resume contains token:', hist4Text.includes(token));
    expect(hist4Text).toContain(token);
  }, 240_000);
});
