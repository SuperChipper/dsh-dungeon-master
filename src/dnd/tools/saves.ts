/** 存档与进度：dnd_progress、dnd_prepare、dnd_end、dnd_undo。 */
import {
addSummary,crossesTurn,snapshotRolls,summarize
} from '../campaign.ts';
import { applyProgressPatch,isEmptyPatch,parseProgressPatch } from '../progress-patch.ts';
import {
str,
int,type ToolKit
} from './shared.ts';

export function registerSaveTools(kit: ToolKit): void {
  const { service, recordOf, mutate, register } = kit;

  register(
    'dnd_progress',
    'Save where the campaign stands without ending it: after a scene wraps up, a deal or quest changes, players '
    + 'say they will stop soon, or they ask to save (存档). Progress is organised in sections 【位置】【队伍】'
    + '【物品与欠账】【任务与线头】【待办】. Send ONLY what changed: `set` replaces whole sections, `append` adds '
    + 'items, `remove` deletes items (any line containing the text); the tool merges them into the latest save. '
    + 'At a session handoff also record 【刚刚发生】【已定行动】【同行与留守】【未结事项】【下次接续】: '
    + 'the exact narrative stopping point, last event, choices already made, NPC whereabouts, open matters and next step. '
    + 'Use `summary` for the first save or a full rewrite. Unsectioned old saves become 【旧进度】, removable with set={"旧进度":""} '
    + 'after keeping unresolved matters. The entire merged save must fit 1500 characters; oversized writes are rejected and the old save stays intact. '
    + 'Only the merged latest one is injected next time. '
    + 'Player-known information only: no DCs, monster stats or DM-only notes. Use this instead of '
    + 'qqbot_notes_save for campaign progress.',
    {
      summary: { type: 'string', description: 'Full rewrite (replaces the whole save). Prefer set/append/remove.' },
      set: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Section → new content, e.g. {"位置":"修道院地窖门口"}. "" deletes the section.',
      },
      append: {
        type: 'object',
        additionalProperties: { type: 'array', items: { type: 'string' } },
        description: 'Section → items to add, e.g. {"待办":["给铁匠还 5gp"]}.',
      },
      remove: {
        type: 'object',
        additionalProperties: { type: 'array', items: { type: 'string' } },
        description: 'Section → items to drop (finished to-dos, paid debts), matched by contained text.',
      },
    },
    [],
    (args, exec) => {
      const text = str(args.summary);
      const patch = parseProgressPatch(args);
      if (text === undefined && isEmptyPatch(patch)) throw new Error('dnd_progress: 要给 summary（整份）或 set/append/remove（改动）');
      return mutate(exec, (c) => {
        // 先整份再叠改动：同一次调用里两者都给也说得通（重写 + 顺手勾掉一条）
        const base = text ?? c.summaries.at(-1)?.text;
        const result = isEmptyPatch(patch) ? { text: text!, changed: [], missed: [] } : applyProgressPatch(base, patch);
        if (result.text.trim() === '') throw new Error('dnd_progress: 合并后进度为空，没有写入');
        addSummary(c, result.text);
        const notes = [
          result.changed.length > 0 ? `改了：${result.changed.join('、')}` : '',
          result.missed.length > 0 ? `没找到要删的：${result.missed.join('；')}` : '',
        ].filter(Boolean);
        return `已写进团档，下次开团的「上次进度」用这一条。${notes.length > 0 ? `\n${notes.join('\n')}` : ''}`;
      });
    },
  );

  register(
    'dnd_prepare',
    'Private DM preparation for the next session; works both while active and paused. show returns current recorded state, '
    + 'handoff, open matters, backstory hooks and any saved plan. save stores a complete DM-only candidate plan (max 2000 characters): '
    + 'possible next scenes/NPCs/rules/hooks and questions to verify; look up stat blocks when needed instead of copying them into the plan. clear removes the plan. This never starts play or changes '
    + 'characters, quests or resources. Plans are NOT events that happened; never send the plan or tool output to players. '
    + 'If state changed since planning, show flags it for review. Read module details with dnd_lookup when preparing.',
    {
      action: { type: 'string', enum: ['show', 'save', 'clear'] },
      plan: { type: 'string', description: 'For save: the full private candidate plan, not a recap of established facts.' },
    },
    ['action'],
    (args, exec) => {
      const key = recordOf(exec).sessionKey;
      if (args.action === 'show') return service.preparationContext(key);
      if (args.action === 'clear') {
        service.savePreparation(key, '');
        return '已清除 DM 备团计划，团况未变。';
      }
      if (args.action !== 'save' || str(args.plan) === undefined) throw new Error('dnd_prepare save 要给非空 plan');
      service.savePreparation(key, str(args.plan)!);
      return '已保存 DM 私有备团计划；它尚未发生，下次开团会核对团况后供参考，不向玩家转发。';
    },
  );

  register(
    'dnd_end',
    'Pause tonight\'s session using the SAME end operation as the player command /dnd end. Combat initiative, positions '
    + 'and pending reactions are preserved. Optional summary (max 1500 characters) is a full handoff: 【位置】【刚刚发生】'
    + '【已定行动】【同行与留守】【未结事项】【下次接续】, player-known facts only. Without summary, keeps the last save '
    + 'and adds a separate handoff of later tool facts. Oversized summaries reject the whole operation; nothing is truncated. '
    + 'May also supplement a handoff after players already paused; this does not restart play. For a save without pausing '
    + 'use dnd_progress. For private future plans use dnd_prepare.',
    { summary: { type: 'string', description: 'Optional complete handoff, at most 1500 characters. Not DM future plans.' } },
    [],
    (args, exec) => {
      const record = recordOf(exec);
      const text = str(args.summary);
      if (args.summary !== undefined && text === undefined) throw new Error('dnd_end: summary 不能为空');
      const stopped = service.stop(record.sessionKey, text);
      if (stopped === undefined) return '现在没有进行中的团。';
      return '已暂停并保存进度与停团交接，战斗状态保留。下次发送 /dnd start 继续。要核对交接用 dnd_prepare show，别把 DM 私有资料发到群里。';
    },
  );

  register(
    'dnd_undo',
    'Roll back the game state when the table agrees an action was resolved wrongly ("卷回到…"). list: show recent '
    + 'changes, newest first. undo: revert in one go, either to just before a roll (`roll`, preferred: the roll and '
    + 'everything after it, its damage, conditions and spent resources included) or the newest `steps` changes. Never '
    + 'fake a rollback by healing dead monsters or restarting initiative. Also use it when a player takes back a choice '
    + 'that was already resolved, or a reaction was missed (e.g. "不用神恩了" after the boosted attack landed): undo the '
    + 'roll, then re-resolve; refunding only the slot while keeping its damage is wrong.',
    {
      action: { type: 'string', enum: ['list', 'undo'] },
      roll: { type: 'string', description: 'For undo: the roll id from a dnd_check result, e.g. "R12". Reverts to just before it.' },
      steps: { type: 'integer', description: 'For undo without roll: how many changes to revert (see list).' },
      confirm: { type: 'boolean', description: 'For undo roll=: required when the rollback also crosses a turn change (next/goto/end).' },
    },
    ['action'],
    (args, exec) => {
      const key = recordOf(exec).sessionKey;
      service.require(key);
      if (args.action === 'undo') {
        let steps = int(args.steps) ?? 1;
        const rollArg = str(args.roll);
        if (rollArg !== undefined) {
          const n = Number(/\d+/.exec(rollArg)?.[0] ?? NaN);
          const list = service.store.snapshots(key);
          const at = Number.isFinite(n) ? list.findIndex((s) => snapshotRolls(s.label).includes(n)) : -1;
          if (at < 0) {
            throw new Error(`撤销记录里找不到 #R${Number.isFinite(n) ? n : rollArg}：没有后果的检定不留记录（不用撤，按对的结果重新判），太早的已经被挤掉了。用 action=list 看能撤到哪。`);
          }
          steps = list.length - at;
          // 存档只能整份往回退：这一骰之后的改动会一起退掉。越过回合推进时先让 DM 看清楚再确认
          if (list.slice(at + 1).some((s) => crossesTurn(s.label)) && args.confirm !== true) {
            const span = list.slice(at).reverse().map((s, i) => `${i + 1}. ${s.label}`).join('\n');
            return `撤回 #R${n} 要连带退掉这 ${steps} 步，中间推进过回合：\n${span}\n确认整段都退，就再调一次 dnd_undo action=undo roll=R${n} confirm=true；只想改其中一步就别撤，用 dnd_apply 修。`;
          }
        }
        const undone = service.store.undo(key, steps);
        const { campaign, adventure } = service.require(key);
        return `已撤销 ${undone.length} 步：\n${undone.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n\n现在的团况：\n${summarize(campaign, adventure)}`;
      }
      const list = service.store.snapshots(key).slice(-15).reverse();
      if (list.length === 0) return '没有可以撤销的改动。';
      return `最近的改动（新→旧，undo steps=N 撤销前 N 条）：\n${list.map((s, i) => `${i + 1}. ${s.label}`).join('\n')}`;
    },
  );
}
