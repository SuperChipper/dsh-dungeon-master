import { describe, expect, it } from 'vitest';
import type { ImQQBotConfig } from '../config.ts';
import { biliPermission } from './permissions.ts';
import { registerBiliTools } from './tools.ts';
import type { BiliClient } from './client.ts';

const config = { ownerOpenid: 'owner', adminOpenids: ['admin'] } as ImQQBotConfig;

describe('Bilibili read-only subtitle permission', () => {
  it('普通群友和私聊都可以读取字幕，不受 owner 配置和发送者变化影响', () => {
    for (const record of [{ scope: 'group', peerId: 'group' }, { scope: 'c2c', peerId: 'member' }]) {
      expect(biliPermission(record, 'subtitle', config).allowed).toBe(true);
      expect(biliPermission(record, 'subtitle', {} as ImQQBotConfig).allowed).toBe(true);
      expect(biliPermission(record, 'login', config).allowed).toBe(false);
    }
  });

  it('扫码和登录轮询仍限主人/管理员私聊，本地 Web 保持原行为', () => {
    expect(biliPermission({ scope: 'group', peerId: 'owner' }, 'login', config).allowed).toBe(false);
    expect(biliPermission({ scope: 'c2c', peerId: 'owner' }, 'login', config).allowed).toBe(true);
    expect(biliPermission({ scope: 'c2c', peerId: 'admin' }, 'login', config).allowed).toBe(true);
    expect(biliPermission({ scope: 'c2c', peerId: 'owner' }, 'login', {} as ImQQBotConfig).allowed).toBe(false);
    expect(biliPermission(undefined, 'login', config).allowed).toBe(true);
  });

  it('有登录凭证的普通群聊能实际进入字幕读取，不能生成二维码或轮询登录', async () => {
    type Tool = { name: string; execute(args: unknown, ctx: { signal: AbortSignal; agent?: unknown }): Promise<unknown> };
    const definitions = new Map<string, Tool>();
    let reads = 0;
    const record = { scope: 'group', peerId: 'group' };
    registerBiliTools({ register: (value) => { const tool = value as Tool; definitions.set(tool.name, tool); } }, {
      client: {
        hasCredential: () => true,
        subtitle: async () => { reads += 1; return { lan: 'zh-CN', lines: 1, text: '测试字幕', truncated: false }; },
      } as unknown as BiliClient,
      logger: { info: () => {}, warn: () => {} },
      permission: (_agent, kind = 'login') => biliPermission(record, kind, config),
    });
    const context = { signal: new AbortController().signal, agent: {} };
    expect(await definitions.get('bili_subtitle')!.execute({ bvid: 'BV139HA6JEE6' }, context)).toContain('测试字幕');
    expect(reads).toBe(1);
    await expect(definitions.get('bili_login')!.execute({}, context)).rejects.toThrow('扫码登录只能');
    await expect(definitions.get('bili_login_check')!.execute({ qrcodeKey: 'test' }, context)).rejects.toThrow('扫码登录只能');
  });
});
