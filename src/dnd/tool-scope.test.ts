import { describe, expect, it, vi } from 'vitest';
import { DndToolScope, hiddenDndTools, PAUSED_DND_TOOLS, type DndToolLevel } from './tool-scope.ts';

const ALL = ['dnd_roll', 'dnd_check', 'dnd_chronicle', 'dnd_prepare', 'dnd_end', 'dnd_lookup', 'dnd_character', 'dnd_resource', 'dnd_move'];

function setup(initial: DndToolLevel, options: { restrict?: boolean; fail?: boolean } = {}) {
  let level = initial;
  const service = {
    active: () => (level === 'active' ? {} : undefined),
    saved: () => (level === 'paused' ? {} : undefined),
  };
  /** 当前生效的各条限制（deny 名单） */
  const live: string[][] = [];
  const restrict = vi.fn((filter: { deny: readonly string[] }) => {
    if (options.fail === true) throw new Error('unknown tool name');
    const entry = [...filter.deny];
    live.push(entry);
    return () => { live.splice(live.indexOf(entry), 1); };
  });
  const agent = { ctx: { get: () => (options.restrict === false ? {} : { restrict }) } };
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  const scope = new DndToolScope(service, ALL, logger as never);
  const record = { sessionKey: 'k', agent };
  return { scope, record, restrict, live, logger, set: (next: DndToolLevel) => { level = next; } };
}

describe('hiddenDndTools', () => {
  it('没团档全藏，停团可查账本、备团和写卡，开团全部可见', () => {
    expect(hiddenDndTools('none', ALL)).toEqual(ALL);
    expect(hiddenDndTools('active', ALL)).toEqual([]);
    expect(hiddenDndTools('paused', ALL)).toEqual(['dnd_roll', 'dnd_check', 'dnd_move']);
    for (const name of PAUSED_DND_TOOLS) expect(hiddenDndTools('paused', ALL)).not.toContain(name);
  });
});

describe('DndToolScope', () => {
  it('新会话没开团：一次把全部跑团工具藏起来；状态没变不重复操作', () => {
    const { scope, record, restrict, live } = setup('none');
    scope.sync(record);
    scope.sync(record);
    expect(restrict).toHaveBeenCalledTimes(1);
    expect(live).toEqual([ALL]);
  });

  it('开团后撤掉限制，停团后只留停团用的，再开团又全部可见', () => {
    const { scope, record, live, set } = setup('none');
    scope.sync(record);

    set('active');
    scope.sync(record);
    expect(live).toEqual([]);

    set('paused');
    scope.sync(record);
    expect(live).toEqual([['dnd_roll', 'dnd_check', 'dnd_move']]);

    set('active');
    scope.sync(record);
    expect(live).toEqual([]);
  });

  it('各会话互不影响', () => {
    const a = setup('none');
    const other = { sessionKey: 'k2', agent: { ctx: { get: () => ({ restrict: a.restrict }) } } };
    a.scope.sync(a.record);
    a.scope.sync(other);
    expect(a.restrict).toHaveBeenCalledTimes(2);
  });

  it('agent 一出现先全藏；QQ 会话建好记录后按团的状态放开', () => {
    const { scope, record, restrict, live, set } = setup('active');
    scope.hideAll(record.agent);
    scope.hideAll(record.agent);
    expect(restrict).toHaveBeenCalledTimes(1);
    expect(live).toEqual([ALL]);

    scope.sync(record);
    expect(live).toEqual([]);

    // 没开团的 QQ 会话：已经全藏了，不再动
    const idle = setup('none');
    idle.scope.hideAll(idle.record.agent);
    idle.scope.sync(idle.record);
    expect(idle.restrict).toHaveBeenCalledTimes(1);
    set('none');
  });

  it('hideAll 绝不抛错（挂在 agent/created 上，抛错会否决 agent 的创建）', () => {
    const failing = setup('none', { fail: true });
    expect(() => failing.scope.hideAll(failing.record.agent)).not.toThrow();
    const unsupported = setup('none', { restrict: false });
    expect(() => unsupported.scope.hideAll(unsupported.record.agent)).not.toThrow();
    expect(() => unsupported.scope.hideAll({ ctx: { get: () => { throw new Error('no tools service'); } } })).not.toThrow();
  });

  it('插件卸载时撤掉所有限制；已销毁的 agent 只丢记录不再撤', () => {
    const { scope, record, live } = setup('none');
    const gone = { ctx: record.agent.ctx };
    scope.hideAll(record.agent);
    scope.hideAll(gone);
    expect(live).toHaveLength(2);

    scope.release(gone);
    scope.disposeAll();
    // gone 的限制随它的作用域消失，不归这里撤；活着的那个被撤掉
    expect(live).toHaveLength(1);

    // 卸载后重新加载：对同一个 agent 重新来过，不受旧记录影响
    scope.sync(record);
    expect(live).toHaveLength(2);
  });

  it('宿主不支持或限制失败：只记一条警告，原有限制不动，下次还会再试', () => {
    const unsupported = setup('none', { restrict: false });
    unsupported.scope.sync(unsupported.record);
    expect(unsupported.logger.warn).toHaveBeenCalledTimes(1);

    const failing = setup('none', { fail: true });
    failing.scope.sync(failing.record);
    failing.scope.sync(failing.record);
    expect(failing.restrict).toHaveBeenCalledTimes(2);
    expect(failing.live).toEqual([]);
  });
});
