import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { InlineKeyboard, InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import { BrowserSchema, ImageGenSchema, type ImQQBotConfig } from '../config.ts';
import type { SessionManager } from '../session/index.ts';
import type { Logger, ReplyTarget } from '../types.ts';
import { ACCESS_TOOL_NAME, registerAccessTool } from './access-tool.ts';
import { GroupAccess } from './group-access.ts';
import { ToolAccess, ToolAccessStore } from './tool-access.ts';

interface ToolDef {
  name: string;
  parameters: { properties: { capability: { enum: string[] } } };
  execute(args: unknown, exec: { agent?: unknown }): Promise<{ message: string }>;
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(opts: { browser?: boolean; imageGen?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'access-tool-'));
  tempDirs.push(dir);
  const store = new ToolAccessStore(join(dir, 'tool-access.json'));
  const config = {
    ownerOpenid: 'OWNER',
    toolAccess: { enabled: true, fullAccessGroups: [], fullAccessUsers: [], readRoots: [] },
    browser: BrowserSchema({ enabled: opts.browser ?? true, allowedGroups: [] }),
    imageGen: ImageGenSchema({ enabled: opts.imageGen ?? true, allowedGroups: [] }),
  } as unknown as ImQQBotConfig;

  const ownerAgent = { followup: vi.fn() };
  const groupAgent = { followup: vi.fn() };
  const records = new Map<object, unknown>([
    [ownerAgent, { scope: 'c2c', peerId: 'OWNER', senderId: 'OWNER', replyTarget: { scope: 'c2c', targetId: 'OWNER' }, agent: ownerAgent }],
    [groupAgent, { scope: 'group', peerId: 'G1', senderId: 'U1', replyTarget: { scope: 'group', targetId: 'G1' }, agent: groupAgent }],
  ]);
  const manager = { findByAgent: (a: object) => records.get(a) } as unknown as SessionManager;
  const sender = { sendMarkdown: vi.fn(async (_t: ReplyTarget, _c: string, _o?: { keyboard?: InlineKeyboard }) => {}) };
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger;

  const terminal = new ToolAccess(config, store, manager, sender, logger);
  (manager as unknown as { toolAccess: ToolAccess }).toolAccess = terminal;
  const browser = opts.browser === false ? undefined : new GroupAccess('browser', config, manager, sender, logger, () => true);
  const imageGen = opts.imageGen === false ? undefined : new GroupAccess('imageGen', config, manager, sender, logger, () => true);

  let registered: ToolDef | undefined;
  let teardown!: () => void;
  const ctx = {
    get: () => ({ register: (def: ToolDef) => { registered = def; } }),
    effect: (fn: () => () => void) => { teardown = fn(); },
  } as unknown as Context;

  registerAccessTool(ctx, { terminal, browser, imageGen }, logger);
  return { tool: registered!, terminal, browser, imageGen, sender, ownerAgent, groupAgent, teardown };
}

describe('qqbot_access', () => {
  it('按启用状态暴露 capability enum，并统一路由 terminal / browser / image_gen', async () => {
    const partial = setup({ browser: false, imageGen: false });
    expect(partial.tool.name).toBe(ACCESS_TOOL_NAME);
    expect(partial.tool.parameters.properties.capability.enum).toEqual(['terminal']);

    const s = setup();
    expect(s.tool.parameters.properties.capability.enum).toEqual(['terminal', 'browser', 'image_gen']);

    // 主人私聊直接修改 3 类白名单并严格隔离
    await s.tool.execute({ capability: 'terminal', action: 'grant', group: 'G_TERM', user: undefined }, { agent: s.ownerAgent });
    expect(s.terminal.isFullAccess({ scope: 'group', peerId: 'G_TERM' })).toBe(true);
    expect(s.browser!.isAllowedGroup('G_TERM')).toBe(false);

    await s.tool.execute({ capability: 'terminal', action: 'grant', user: 'U_FRIEND' }, { agent: s.ownerAgent });
    expect(s.terminal.isFullAccess({ scope: 'c2c', peerId: 'U_FRIEND' })).toBe(true);

    await s.tool.execute({ capability: 'browser', action: 'grant', group: 'G_BROWSE' }, { agent: s.ownerAgent });
    expect(s.browser!.isAllowedGroup('G_BROWSE')).toBe(true);
    expect(s.imageGen!.isAllowedGroup('G_BROWSE')).toBe(false);

    await s.tool.execute({ capability: 'image_gen', action: 'grant', group: 'G_IMG' }, { agent: s.ownerAgent });
    expect(s.imageGen!.isAllowedGroup('G_IMG')).toBe(true);
    expect(s.browser!.isAllowedGroup('G_IMG')).toBe(false);
  });

  it('群内申请通过原交互按钮生效，同时拒绝非 terminal 传 user 或未启用能力', async () => {
    const s = setup({ imageGen: false });
    await expect(s.tool.execute({ capability: 'browser', action: 'grant', user: 'U1' }, { agent: s.ownerAgent }))
      .rejects.toThrow('只有 capability="terminal"');
    await expect(s.tool.execute({ capability: 'image_gen', action: 'status' }, { agent: s.groupAgent }))
      .rejects.toThrow('不支持或未启用');

    const res = await s.tool.execute({ capability: 'browser', action: 'grant' }, { agent: s.groupAgent });
    expect(res.message).toContain('当前权限尚未修改');
    const buttonData = s.sender.sendMarkdown.mock.calls[0]![2]!.keyboard!.content.rows[0]!.buttons[0]!.action.data!;
    expect(s.browser!.handleInteraction({
      scene: 'group',
      group_openid: 'G1',
      group_member_openid: 'OWNER',
      data: { resolved: { button_data: buttonData } },
    } as InteractionEvent)).toBe(0);
    expect(s.browser!.isAllowedGroup('G1')).toBe(true);

    // registerAccessTool 绑定生命周期：teardown 后标记 disposed
    s.teardown();
    await expect(s.tool.execute({ capability: 'browser', action: 'grant' }, { agent: s.groupAgent }))
      .rejects.toThrow('已关闭');
  });
});
