import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ImQQBotConfig } from '../config.ts';
import { renderBotDoctorReport, runBotDoctor, type BotDoctorManagerLike } from './bot-doctor.ts';
import { doctorCommand } from '../commands/doctor.ts';

function makeManager(overrides: Partial<BotDoctorManagerLike> = {}): BotDoctorManagerLike {
  return {
    size: 2,
    notesStore: {},
    personaStore: {
      list: () => [{ id: 'dragon', name: '肥龙', names: ['肥龙'], prompt: 'p' }],
      defaultPersona: (scope) => ({
        id: 'default',
        name: '默认',
        names: ['大肥鱼'],
        prompt: scope === 'group' ? 'g' : 'd',
      }),
      currentId: () => 'default',
      handoffs: { read: () => ({ schemaVersion: 1, chatKey: 'qqbot:app:group:g1', received: {}, covered: {} }) },
    },
    sessionKey: (scope, peerId) => `qqbot:app:${scope}:${peerId}`,
    sessionIdFor: () => '12345678-aaaa-bbbb-cccc-1234567890ab',
    getEffectiveModel: () => ({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }),
    getSessionRecord: () => ({ sessionKey: 'qqbot:app:group:g1' } as never),
    getPersonaSwitchState: () => 'idle',
    getContextLockStatus: () => ({ locked: false, reasons: [] }),
    ...overrides,
  };
}

describe('bot-doctor', () => {
  it('健康配置与状态生成无告警报告', async () => {
    const report = await runBotDoctor({
      manager: makeManager(),
      config: {
        groupTriggerMode: 'desire',
        speak: { gsvUrl: 'http://127.0.0.1:8765' } as never,
      },
      scope: 'group',
      peerId: 'g1',
      probeUrl: vi.fn(async () => 'reachable'),
      readScheduleCount: () => 1,
      env: {},
    });

    expect(report.warnings).toEqual([]);
    expect(report.triggerMode).toBe('desire');
    expect(report.gsv.status).toBe('reachable');
    const text = renderBotDoctorReport(report);
    expect(text).toContain('未发现异常或配置漂移');
    expect(text).toContain('groupTriggerMode=desire');
    expect(text).toContain('在线 (http://127.0.0.1:8765)');
  });

  it('识别内嵌 prompt 残留、恢复中状态机、压缩锁与离线 TTS 告警', async () => {
    const manager = makeManager({
      getPersonaSwitchState: () => 'recovering',
      getContextLockStatus: () => ({ locked: true, reasons: ['pending-question', 'background-job'] }),
      personaStore: {
        list: () => [],
        defaultPersona: () => undefined,
        currentId: () => 'dragon',
        handoffs: {
          read: () => ({
            schemaVersion: 1,
            chatKey: 'k',
            received: {},
            covered: {},
            pending: {
              id: 'p1',
              fromPersona: 'default',
              at: '2026-11-18T00:00:00Z',
              status: 'failed',
              cursor: { sessionId: 's0', event: 1 },
              transcript: 't',
              recent: 'r',
            },
          }),
        },
      },
    });
    const report = await runBotDoctor({
      manager,
      config: {
        groupTriggerMode: 'mention',
        replyDesire: { enabled: true } as never,
        groupPrompt: 'legacy prompt',
        notes: { semantic: { enabled: true, apiKey: '' } } as never,
        speak: { gsvUrl: 'http://127.0.0.1:8765' } as never,
      },
      scope: 'group',
      peerId: 'g1',
      probeUrl: vi.fn(async () => 'offline'),
      readScheduleCount: () => 0,
      env: {},
    });

    expect(report.warnings.length).toBeGreaterThanOrEqual(6);
    const text = renderBotDoctorReport(report);
    expect(text).toContain('状态机=recovering');
    expect(text).toContain('压缩锁=锁定 (pending-question、background-job)');
    expect(text).toContain('离线 (http://127.0.0.1:8765)');
  });

  it('检查 ElevenLabs 与 DeepSeek TTS 启用时的密钥（含 envFiles）及角色音色映射缺失提醒', async () => {
    const missingReport = await runBotDoctor({
      manager: makeManager(),
      config: {
        groupTriggerMode: 'desire',
        speak: {
          elevenlabs: { enabled: true, apiKey: '', apiKeyEnv: 'ELEVENLABS_API_KEY', defaultVoiceId: '', roleVoices: {} },
          deepseek: { enabled: true, apiKey: '', apiKeyEnv: 'DEEPSEEK_API_KEY', defaultVoiceId: '', roleVoices: {} },
        } as never,
      },
      scope: 'group',
      peerId: 'g1',
      readScheduleCount: () => 0,
      env: {},
    });
    expect(missingReport.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('ELEVENLABS_API_KEY'),
      expect.stringContaining('speak.elevenlabs 已启用，但未配置 defaultVoiceId'),
      expect.stringContaining('DEEPSEEK_API_KEY'),
      expect.stringContaining('speak.deepseek 已启用，但未配置 defaultVoiceId'),
    ]));
    expect(renderBotDoctorReport(missingReport)).toContain('ElevenLabs=已启用（待补齐配置）');
    expect(renderBotDoctorReport(missingReport)).toContain('DeepSeekTTS=已启用（待补齐配置）');

    const dir = mkdtempSync(join(tmpdir(), 'bot-doctor-el-'));
    try {
      const envPath = join(dir, '.env.local');
      writeFileSync(envPath, 'ELEVENLABS_API_KEY="xi-test"\nDEEPSEEK_API_KEY="ds-test"\n', 'utf8');
      const okReport = await runBotDoctor({
        manager: makeManager(),
        config: {
          groupTriggerMode: 'desire',
          speak: {
            elevenlabs: { enabled: true, apiKeyEnv: 'ELEVENLABS_API_KEY', roleVoices: { dragon: 'v_d' } },
            deepseek: { enabled: true, apiKeyEnv: 'DEEPSEEK_API_KEY', roleVoices: { feiyu: 'stella' } },
          } as never,
        },
        scope: 'group',
        peerId: 'g1',
        readScheduleCount: () => 0,
        env: {},
        envFiles: [envPath],
      });
      expect(okReport.warnings).toEqual([]);
      expect(renderBotDoctorReport(okReport)).toContain('ElevenLabs=已启用 (1 个音色配置)');
      expect(renderBotDoctorReport(okReport)).toContain('DeepSeekTTS=已启用 (1 个音色配置)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('/bot-doctor 仅允许 owner / admin 执行', () => {
    const cmd = doctorCommand({
      manager: makeManager() as never,
      config: { ownerOpenid: 'owner', adminOpenids: ['admin'] } as unknown as ImQQBotConfig,
    });
    expect(cmd.authorized?.({ message: { senderId: 'stranger' } } as never)).toMatch(/只有/);
    expect(cmd.authorized?.({ message: { senderId: 'admin' } } as never)).toBe(true);
    expect(cmd.authorized?.({ message: { senderId: 'owner' } } as never)).toBe(true);
  });
});
