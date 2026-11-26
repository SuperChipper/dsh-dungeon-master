import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { dndCommand } from './dnd.ts';
import { DndService } from '../dnd/dnd-service.ts';
import { CampaignStore } from '../dnd/campaign.ts';
import { AdventureLibrary } from '../dnd/adventure.ts';

function setup(openCheckIn?: (...args: unknown[]) => Promise<boolean>) {
  const root = mkdtempSync(join(tmpdir(), 'dnd-cmd-'));
  const dndService = new DndService({ store: new CampaignStore(join(root, 'campaigns')), library: new AdventureLibrary(), mapDir: root });
  const dndButtons = openCheckIn === undefined ? undefined : { openCheckIn: vi.fn(openCheckIn) };
  const manager = { dndService, dndButtons, sessionKey: (s: string, id: string) => `${s}:${id}` };
  const cmd = dndCommand({ manager, config: {} } as never);
  const run = (raw: string, kind: 'group' | 'c2c' = 'group') => cmd.handler({
    message: { kind, groupOpenid: 'G1', senderId: 'U1', messageId: 'M1' },
    command: { raw },
  } as never);
  return { run, dndButtons };
}

describe('/dnd 子命令只认英文', () => {
  it('search / spells 可用，中文子命令不再认', async () => {
    const { run } = setup();
    expect(await run('search 火球术')).toContain('search=%E7%81%AB%E7%90%83%E6%9C%AF');
    expect(await run('spells 牧师')).toContain('牧师法表');
    expect(await run('查 火球术')).toContain('用法：');
    expect(await run('法表 牧师')).toContain('用法：');
    expect(await run('help')).not.toMatch(/\/dnd (查|法表|签到)/);
  });

  it('群里开团：开团文字交给签到消息一起发，命令本身不再回复', async () => {
    const { run, dndButtons } = setup(() => Promise.resolve(true));
    expect(await run('start sunken-bell')).toEqual({ kind: 'noop' });
    const [key, target, text, reset] = dndButtons!.openCheckIn.mock.calls[0]!;
    expect(key).toBe('group:G1');
    expect(target).toMatchObject({ scope: 'group', targetId: 'G1', msgId: 'M1' });
    expect(text).toContain('🎲 开团');
    expect(reset).toBe(true);
  });

  it('按钮发不出去时退回纯文字；私聊不发签到', async () => {
    const failing = setup(() => Promise.resolve(false));
    expect(await failing.run('start sunken-bell')).toContain('🎲 开团');
    const dm = setup(() => Promise.resolve(true));
    expect(await dm.run('start sunken-bell', 'c2c')).toContain('🎲 开团');
    expect(dm.dndButtons!.openCheckIn).not.toHaveBeenCalled();
  });

  it('new 用 blank 不带旧角色卡', async () => {
    const { run } = setup();
    expect(await run('new sunken-bell blank', 'c2c')).toContain('🎲 开团');
  });

  it('end 委派 SessionManager 原子停团并静默交接，不再发旧静态「已暂停」文字', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dnd-cmd-end-'));
    const dndService = new DndService({ store: new CampaignStore(join(root, 'campaigns')), library: new AdventureLibrary(), mapDir: root });
    let nextOutcome: unknown = { status: 'handed_off' };
    const endDndSession = vi.fn(async () => nextOutcome);
    const waitForDndTransition = vi.fn(async () => {});
    const manager = {
      dndService,
      sessionKey: (s: string, id: string) => `${s}:${id}`,
      endDndSession,
      waitForDndTransition,
    };
    const cmd = dndCommand({ manager, config: {} } as never);
    const run = (raw: string) => cmd.handler({
      message: { kind: 'group', groupOpenid: 'G1', senderId: 'U1', messageId: 'M1' },
      command: { raw },
    } as never);

    expect(await run('end 营地休整')).toEqual({ kind: 'noop' });
    expect(endDndSession).toHaveBeenCalledWith({
      scope: 'group',
      peerId: 'G1',
      senderId: 'U1',
      target: expect.objectContaining({ scope: 'group', targetId: 'G1', msgId: 'M1' }),
      summary: '营地休整',
    });

    nextOutcome = { status: 'busy' };
    expect(await run('end')).toEqual({ kind: 'noop' });

    nextOutcome = { status: 'inactive' };
    expect(await run('end')).toBe('现在没有进行中的团。');

    nextOutcome = { status: 'error', message: '摘要过长，未保存' };
    expect(await run('end 很长')).toBe('摘要过长，未保存');

    await run('start sunken-bell');
    expect(waitForDndTransition).toHaveBeenCalledWith('group', 'G1');
  });
});

describe('/dnd map 和 DM 发的是同一张图', () => {
  const hasSharp = async (): Promise<boolean> => import('sharp').then(() => true, () => false);

  it('能发图就发图，图下附一段说明', async () => {
    if (!(await hasSharp())) return;
    const { run, service } = setupWithService();
    await run('start sunken-bell');
    const sendImage = vi.fn(() => Promise.resolve());
    service.sendImage = sendImage;
    expect(await run('map')).toEqual({ kind: 'noop' });
    const [target, path, caption] = sendImage.mock.calls[0]! as unknown as [unknown, string, string];
    expect(target).toMatchObject({ scope: 'group', targetId: 'G1', msgId: 'M1' });
    expect(path).toMatch(/\.(png|jpg)$/);
    expect(caption).toContain('📍');
  });

  it('没接上发图时退回文字地图；没开战要战斗图就说还没有场地图', async () => {
    const { run, service } = setupWithService();
    await run('start sunken-bell');
    expect(await run('map')).toContain('🗺️');
    service.sendImage = vi.fn(() => Promise.resolve());
    if (await hasSharp()) expect(await run('map battle')).toContain('还没有场地图');
  });
  it('checkpoint / undo 支持命名检查点保存、列表脱敏与一键回退（停团同样可用）', async () => {
    const { run, service } = setupWithService();
    const key = 'group:G1';
    await run('start sunken-bell');
    service.store.update(key, (c) => {
      c.currentRoom = 'nave';
      c.revealed.push('nave');
    }, 'dnd_move room=nave secret_dc=18');

    const savedCp = await run('checkpoint 谈判前');
    expect(savedCp).toContain('cp-1「谈判前」');

    service.store.update(key, (c) => {
      c.currentRoom = 'ossuary';
      c.revealed.push('ossuary');
    }, 'dnd_check character=甲 dc=17 #R9');

    const listed = await run('undo list');
    expect(listed).toContain('cp-1「谈判前」');
    expect(listed).toContain('检定/掷骰 (#R9)');
    // 不向玩家群聊泄露 DC 等工具内部参数
    expect(listed).not.toContain('dc=17');
    expect(listed).not.toContain('secret_dc=18');

    // 停团状态下也能按检查点回退，且保持停团状态不变
    service.stop(key);
    const restored = await run('undo cp-1');
    expect(restored).toContain('已回退到检查点 cp-1「谈判前」');
    const after = service.store.load(key)!;
    expect(after.currentRoom).toBe('nave');
    expect(after.active).toBe(false);

    // 误回退可再 /dnd undo 1 回到回退前状态
    const reverted = await run('undo 1');
    expect(reverted).toContain('已回退最近 1 步');
    expect(service.store.load(key)!.currentRoom).toBe('ossuary');
    expect(service.store.load(key)!.active).toBe(false);
  });
});

function setupWithService() {
  const root = mkdtempSync(join(tmpdir(), 'dnd-cmd-'));
  const service = new DndService({ store: new CampaignStore(join(root, 'campaigns')), library: new AdventureLibrary(), mapDir: root });
  const manager = { dndService: service, sessionKey: (s: string, id: string) => `${s}:${id}` };
  const cmd = dndCommand({ manager, config: {} } as never);
  const run = (raw: string) => cmd.handler({
    message: { kind: 'group', groupOpenid: 'G1', senderId: 'U1', messageId: 'M1' },
    command: { raw },
  } as never);
  return { run, service };
}
