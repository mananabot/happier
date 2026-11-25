import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentMessage } from '@/agent/core';
import { probeAgentModelsBestEffort } from '@/capabilities/probes/agentModelsProbe';
import { probeAgentModesBestEffort } from '@/capabilities/probes/agentModesProbe';
import { agyDaemonSpawnHooks } from '../daemon/spawnHooks';
import { createAgyAcpBackend } from './backend';

const LIVE = process.env.HAPPIER_LIVE_AGY_TIER2 === '1';

describe.skipIf(!LIVE)('Tier 2: live agy 1.5.x ACP adapter harness', () => {
  let scratchDir: string;

  beforeAll(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'happier-agy-tier2-'));
  });

  afterAll(async () => {
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
  });

  it('validates spawn and probes models + modes dynamically from native agy CLI', async () => {
    const validation = await agyDaemonSpawnHooks.validateSpawn!({
      directory: scratchDir,
      environmentVariables: process.env,
    });
    expect(validation).toEqual({ ok: true });

    const models = await probeAgentModelsBestEffort({
      agentId: 'agy',
      cwd: scratchDir,
      timeoutMs: 25_000,
      bypassCache: true,
      processEnv: process.env,
    });
    console.log('[Tier2] probed models:', JSON.stringify({
      source: models.source,
      count: models.availableModels.length,
      ids: models.availableModels.slice(0, 8).map((m) => m.id),
    }));
    expect(models.source).toBe('dynamic');
    expect(models.availableModels.some((m) => m.id === 'gemini-4-neon-high')).toBe(true);
    expect(models.availableModels.some((m) => m.id === 'gemini-4-neon-xhigh')).toBe(true);

    const modes = await probeAgentModesBestEffort({
      agentId: 'agy',
      cwd: scratchDir,
      timeoutMs: 25_000,
      processEnv: process.env,
    });
    console.log('[Tier2] probed modes:', JSON.stringify(modes));
    expect(modes.source).toBe('dynamic');
    expect(modes.availableModes.map((m) => m.id)).toEqual(
      expect.arrayContaining(['default', 'accept-edits', 'auto', 'plan']),
    );
  }, 60_000);

  it('completes Neon multi-turn chat, mode/model switch, tool execution, and loadSession resume', async () => {
    const token = 'COBALT-9182';
    const bgMarker = 'BG_PROBE_OK_77';
    let capturedSessionId: string | null = null;

    const createHarnessBackend = async () => {
      const messages: AgentMessage[] = [];
      let turnText = '';
      const toolCalls: string[] = [];
      const backend = await createAgyAcpBackend({
        cwd: scratchDir,
        env: process.env,
        permissionMode: 'yolo',
        permissionHandler: {
          handleToolCall: async (toolCallId, toolName, input) => {
            console.log('[Tier2] permission request:', toolCallId, toolName, JSON.stringify(input).slice(0, 120));
            return { decision: 'approved' };
          },
        },
      });
      backend.onMessage((msg) => {
        messages.push(msg);
        if (msg.type === 'model-output') {
          if (typeof msg.textDelta === 'string') turnText += msg.textDelta;
          else if (typeof msg.fullText === 'string') turnText = msg.fullText;
        } else if (msg.type === 'tool-call') {
          toolCalls.push(`${msg.toolName}:${msg.callId}`);
        } else if (msg.type === 'status') {
          console.log('[Tier2] status:', msg.status, msg.detail ?? '');
        }
      });
      return {
        backend: backend as typeof backend & {
          setSessionModel?: (sessionId: string, modelId: string) => Promise<void>;
          setSessionMode?: (sessionId: string, modeId: string) => Promise<void>;
        },
        resetTurnText: () => { turnText = ''; },
        getTurnText: () => turnText,
        toolCalls,
        messages,
      };
    };

    // Session 1: start, switch model & mode, run 3 turns (memory + shell tool)
    const h1 = await createHarnessBackend();
    try {
      const started = await h1.backend.startSession();
      capturedSessionId = started.sessionId;
      console.log('[Tier2] started sessionId:', capturedSessionId);
      expect(capturedSessionId).toBeTruthy();

      await h1.backend.setSessionModel!(capturedSessionId, 'gemini-4-neon-xhigh');
      await h1.backend.setSessionMode!(capturedSessionId, 'auto');

      // Turn 1: store codeword
      h1.resetTurnText();
      await h1.backend.sendPrompt(
        capturedSessionId,
        `Remember the exact codeword ${token}. Do not run any tools. Reply with ONLY the word ACK.`,
      );
      await h1.backend.waitForResponseComplete?.(45_000);
      console.log('[Tier2] Turn 1 output:', JSON.stringify(h1.getTurnText()));
      expect(h1.getTurnText().toUpperCase()).toContain('ACK');

      // Turn 2: recall codeword
      h1.resetTurnText();
      await h1.backend.sendPrompt(
        capturedSessionId,
        'What is the exact codeword I asked you to remember? Do not run any tools. Reply ONLY with the codeword.',
      );
      await h1.backend.waitForResponseComplete?.(45_000);
      console.log('[Tier2] Turn 2 output:', JSON.stringify(h1.getTurnText()));
      expect(h1.getTurnText()).toContain(token);

      // Turn 3: run a short shell command (exercises tool call + background/wait handling)
      h1.resetTurnText();
      await h1.backend.sendPrompt(
        capturedSessionId,
        `Run the shell command \`sleep 2 && echo ${bgMarker}\` and reply with the exact stdout.`,
      );
      await h1.backend.waitForResponseComplete?.(60_000);
      console.log('[Tier2] Turn 3 output:', JSON.stringify(h1.getTurnText()), 'toolCalls:', h1.toolCalls);
      expect(h1.getTurnText()).toContain(bgMarker);
    } finally {
      await h1.backend.dispose();
    }

    // Session 2: fresh backend process, resume via loadSession, verify memory
    const h2 = await createHarnessBackend();
    try {
      expect(capturedSessionId).toBeTruthy();
      const loaded = await h2.backend.loadSession!(capturedSessionId!);
      console.log('[Tier2] loaded sessionId:', loaded.sessionId);
      expect(loaded.sessionId).toBe(capturedSessionId);

      h2.resetTurnText();
      await h2.backend.sendPrompt(
        loaded.sessionId,
        'Repeat the exact codeword from earlier in this conversation. Do not run any tools. Reply ONLY with the codeword.',
      );
      await h2.backend.waitForResponseComplete?.(45_000);
      console.log('[Tier2] Turn 4 (resumed) output:', JSON.stringify(h2.getTurnText()));
      expect(h2.getTurnText()).toContain(token);
    } finally {
      await h2.backend.dispose();
    }
  }, 180_000);
});
