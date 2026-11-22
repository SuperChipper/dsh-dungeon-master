import { createElement, Fragment, type ReactNode } from 'react';
import type { GroupTriggerMode } from '../../config.ts';
import { AreaRow, FieldRow, ListRow, NumberRow, SegmentedRow, SelectRow, SwitchRow } from './controls.ts';
import {
  GROUP_TRIGGER_OPTIONS,
  MODE_OPTIONS,
  REPLY_JUDGE_DEFAULTS,
  type AccessControlWire,
  type ConfigWire,
  type PatchFn,
  type PersonasWire,
  type ReplyDesireWire,
  type ReplyJudgeWire,
  type StickersWire,
} from './types.ts';

export function CoreConfigSections({ form, patch }: { form: ConfigWire; patch: PatchFn }): ReactNode {
  const access: AccessControlWire = form.access ?? { c2cMode: 'open', c2cAllow: [], groupMode: 'open', groupAllow: [] };
  const fileAccess = form.fileAccess ?? { sensitivePaths: [] };
  const stickers: StickersWire = form.stickers ?? {
    enabled: true, root: '', extraRoots: [], maxBytes: 8 * 1024 * 1024, maxAutoEntries: 200,
  };
  const personas: PersonasWire = { root: '', ...form.personas };
  const replyDesire: ReplyDesireWire = {
    enabled: false, threshold: 0.6, names: [], engagedMs: 90000, engagedMaxTurns: 8,
    ...form.replyDesire,
    judge: { ...REPLY_JUDGE_DEFAULTS, ...form.replyDesire?.judge },
  };
  const judge = replyDesire.judge;
  const patchDesire = (next: Partial<ReplyDesireWire>): void => {
    patch('replyDesire', { ...replyDesire, enabled: true, ...next });
  };
  const patchJudge = (next: Partial<ReplyJudgeWire>): void => {
    patchDesire({ judge: { ...judge, ...next } });
  };
  const effectiveTriggerMode: GroupTriggerMode = form.groupTriggerMode ?? (
    form.requireMention === false
      ? 'all'
      : (replyDesire.enabled ? 'desire' : ((form.groupReplyProbability ?? 0) > 0 ? 'probability' : 'mention'))
  );

  return createElement(Fragment, null,
    createElement('div', { className: 'imqb2-group-title' }, '服务范围'),
    createElement(SegmentedRow, {
      label: '私聊', value: access.c2cMode, options: MODE_OPTIONS,
      onChange: (v) => { patch('access', { ...access, c2cMode: v }); },
    }),
    access.c2cMode === 'allowlist'
      ? createElement(AreaRow, {
          label: '私聊白名单', help: '请输入用户 openid，多个请换行输入', rows: 3,
          value: access.c2cAllow.join('\n'),
          onChange: (v) => { patch('access', { ...access, c2cAllow: v.split('\n').map((s) => s.trim()) }); },
        })
      : null,
    createElement(SegmentedRow, {
      label: '群聊', value: access.groupMode, options: MODE_OPTIONS,
      onChange: (v) => { patch('access', { ...access, groupMode: v }); },
    }),
    access.groupMode === 'allowlist'
      ? createElement(AreaRow, {
          label: '群聊白名单', help: '请输入群 openid，多个请换行输入', rows: 3,
          value: access.groupAllow.join('\n'),
          onChange: (v) => { patch('access', { ...access, groupAllow: v.split('\n').map((s) => s.trim()) }); },
        })
      : null,

    createElement('div', { className: 'imqb2-group-title' }, '主人与文件访问'),
    createElement(FieldRow, {
      label: '主人 openid', value: form.ownerOpenid ?? '', placeholder: '留空表示未设置主人',
      help: '用于识别私聊主人：主人私聊不受工具限制，也只有主人能批准权限申请',
      onChange: (v) => { patch('ownerOpenid', v); },
    }),
    createElement(AreaRow, {
      label: '管理员 openid', help: '每行一个；除主人外，允许修改模型/preset 和点击审批按钮', rows: 2,
      value: (form.adminOpenids ?? []).join('\n'),
      onChange: (v) => { patch('adminOpenids', v.split('\n').map((s) => s.trim())); },
    }),
    createElement(AreaRow, {
      label: '敏感路径（拦截）', help: '每行一个目录或文件前缀；受限会话命中后禁止访问/发送，主人私聊和白名单会话不拦', rows: 3,
      value: fileAccess.sensitivePaths.join('\n'),
      onChange: (v) => { patch('fileAccess', { sensitivePaths: v.split('\n').map((s) => s.trim()) }); },
    }),

    createElement('div', { className: 'imqb2-group-title' }, '基础设置'),
    createElement(SelectRow, {
      label: '群聊触发模式', value: effectiveTriggerMode, options: GROUP_TRIGGER_OPTIONS,
      help: '统一控制群里未 @ 机器人时如何决定是否接话（私聊始终直接回复）',
      onChange: (v) => { patch('groupTriggerMode', v as GroupTriggerMode); },
    }),
    effectiveTriggerMode === 'probability'
      ? createElement(NumberRow, {
          label: '群聊未 @ 时回复概率', value: form.groupReplyProbability ?? 0,
          min: 0, max: 1, step: 0.05,
          help: '0.1 表示约 10% 的群消息会主动接话',
          onChange: (v) => { patch('groupReplyProbability', v); },
        })
      : null,
    createElement(SwitchRow, {
      label: '流式输出', checked: form.streaming ?? true,
      help: '回复内容分段实时推送到聊天',
      onChange: (v) => { patch('streaming', v); },
    }),
    createElement(SwitchRow, {
      label: '显示工具调用结果', checked: form.showToolResults ?? false,
      help: '在聊天中展示 agent 工具调用的结构化结果',
      onChange: (v) => { patch('showToolResults', v); },
    }),
    createElement(NumberRow, {
      label: '群历史缓冲条数', value: form.historyLimit ?? 10,
      min: 0, max: 200, step: 1,
      help: '注入到群聊上下文的最近消息条数',
      onChange: (v) => { patch('historyLimit', v); },
    }),
    createElement(NumberRow, {
      label: '会话闲置超时（毫秒）', value: form.sessionIdleTimeout ?? 1800000,
      min: 60000, max: 2592000000, step: 60000,
      help: '超过该时长未活动会回收会话；86400000 = 24 小时',
      onChange: (v) => { patch('sessionIdleTimeout', v); },
    }),
    createElement(NumberRow, {
      label: '单条消息最大字符数', value: form.textChunkLimit ?? 4500,
      min: 200, max: 5000, step: 100,
      help: 'QQ 单条约 5000 字符上限，长回复会拆成多条',
      onChange: (v) => { patch('textChunkLimit', v); },
    }),
    createElement(NumberRow, {
      label: '并发队列上限', value: form.maxQueue ?? 20,
      min: 1, max: 100, step: 1,
      help: '同时排队的消息数，超出会拒绝新消息',
      onChange: (v) => { patch('maxQueue', v); },
    }),
    createElement(NumberRow, {
      label: '短时插话打断窗口（毫秒）', value: form.steerWindowMs ?? 10000,
      min: 0, max: 300000, step: 1000,
      help: '该时间窗内群聊显式 @bot 或私聊连发会自动打断当前思考并追加（steer）；0 = 关闭',
      onChange: (v) => { patch('steerWindowMs', v); },
    }),
    createElement(NumberRow, {
      label: '单次处理超时（毫秒）', value: form.processingTimeoutMs ?? 1800000,
      min: 10000, max: 21600000, step: 60000,
      help: '超时中断当前 LLM 调用',
      onChange: (v) => { patch('processingTimeoutMs', v); },
    }),
    createElement(NumberRow, {
      label: '待答问题超时（毫秒）', value: form.askTimeoutMs ?? 300000,
      min: 10000, max: 21600000, step: 30000,
      help: 'ask_user_question 等待用户回答的上限',
      onChange: (v) => { patch('askTimeoutMs', v); },
    }),
    createElement(NumberRow, {
      label: '自动压缩阈值（token）', value: form.autoCompactTokens ?? 160000,
      min: 0, max: 1000000, step: 10000,
      help: '群聊上下文超过该值后自动压缩（私聊不低于它）；0 = 插件不自动压缩，交给 dsh 默认阈值',
      onChange: (v) => { patch('autoCompactTokens', v); },
    }),
    createElement(NumberRow, {
      label: '私聊压缩阈值（占模型窗口）', value: form.autoCompactPrivateRatio ?? 0.5,
      min: 0, max: 0.9, step: 0.05,
      help: '私聊做多步任务需要更长上下文：按模型窗口比例算阈值，取不到窗口时用上面的固定值；0 = 与群聊相同',
      onChange: (v) => { patch('autoCompactPrivateRatio', v); },
    }),
    createElement(SwitchRow, {
      label: '工具链进行中推迟压缩', checked: form.autoCompactDeferOnTools ?? true,
      help: '上一轮还在调工具时先不压，等一轮没调工具的收尾轮再压；上下文到阈值 1.5 倍时仍会强制压缩',
      onChange: (v) => { patch('autoCompactDeferOnTools', v); },
    }),
    createElement(NumberRow, {
      label: '空闲压缩：空闲分钟数', value: form.idleCompactMinutes ?? 20,
      min: 0, max: 1440, step: 5,
      help: '会话空闲这么久后压缩一次，之后的冷启动只读摘要；需小于会话闲置超时；0 = 关闭',
      onChange: (v) => { patch('idleCompactMinutes', v); },
    }),
    createElement(NumberRow, {
      label: '空闲压缩：上下文下限（token）', value: form.idleCompactTokens ?? 100000,
      min: 0, max: 1000000, step: 10000,
      help: '上下文低于该值不做空闲压缩；应低于上面的自动压缩阈值',
      onChange: (v) => { patch('idleCompactTokens', v); },
    }),
    createElement(FieldRow, {
      label: '空闲压缩：生效的 provider', value: form.idleCompactProviders ?? 'google',
      placeholder: 'google',
      help: '逗号分隔；留空 = 所有 provider。只有提示缓存几分钟就过期的上游（如 Gemini）才需要',
      onChange: (v) => { patch('idleCompactProviders', v); },
    }),
    createElement(SwitchRow, {
      label: '调试模式', checked: form.debug ?? false,
      help: '输出更详细的运行日志',
      onChange: (v) => { patch('debug', v); },
    }),

    ...(effectiveTriggerMode === 'desire' ? [
      createElement('div', { className: 'imqb2-group-title' }, '回复欲望'),
      createElement(NumberRow, {
        label: '放行阈值（0-1）', value: replyDesire.threshold, min: 0, max: 1, step: 0.05,
        help: '越高越安静：点名 bot 得 0.7、窗口内的人 0.6、像提问再 +0.2；默认 0.6',
        onChange: (v) => { patchDesire({ threshold: v }); },
      }),
      createElement(ListRow, {
        label: 'bot 的昵称/别名', help: '每行一个；群里提到这些词就算在叫 bot（大小写不敏感）',
        value: replyDesire.names, rows: 2,
        onChange: (v) => { patchDesire({ names: v }); },
      }),
      createElement(NumberRow, {
        label: '对话窗口时长（毫秒）', value: replyDesire.engagedMs, min: 5000, max: 600000, step: 5000,
        help: '被 @ 或接话后开窗；没开模型打分时，窗口内刚聊过的人再说话基本都会被接，默认 90000（90 秒）',
        onChange: (v) => { patchDesire({ engagedMs: v }); },
      }),
      createElement(NumberRow, {
        label: '窗口内连续接话轮数上限', value: replyDesire.engagedMaxTurns, min: 0, max: 50, step: 1,
        help: '靠打分接的轮数到上限就关窗（这一条仍接）；0 = 不进入对话窗口，默认 8',
        onChange: (v) => { patchDesire({ engagedMaxTurns: v }); },
      }),
      createElement(SwitchRow, {
        label: '规则拿不准时让模型打分', checked: judge.enabled,
        help: '没点名的普通文字交给模型判断要不要接，打开后文字不再靠对话窗口直接放行；语气词、表情包、开团期间不调模型',
        onChange: (v) => { patchJudge({ enabled: v }); },
      }),
      ...(judge.enabled ? [
        createElement(FieldRow, {
          label: '打分 provider', value: judge.provider, placeholder: '留空 = 这个群的主模型',
          onChange: (v) => { patchJudge({ provider: v.trim() }); },
        }),
        createElement(FieldRow, {
          label: '打分模型', value: judge.model, placeholder: '留空 = 这个群的主模型',
          onChange: (v) => { patchJudge({ model: v.trim() }); },
        }),
        createElement(FieldRow, {
          label: '推理档位', value: judge.reasoningEffort, placeholder: '留空 = 自动选最低档',
          help: '启动后第一次打分会在日志里列出这个模型支持的档位',
          onChange: (v) => { patchJudge({ reasoningEffort: v.trim() }); },
        }),
        createElement(NumberRow, {
          label: '安静多久才打分（毫秒）', value: judge.debounceMs, min: 0, max: 60000, step: 500,
          help: '连着说的几条只给最后一条打一次分，默认 2500',
          onChange: (v) => { patchJudge({ debounceMs: v }); },
        }),
        createElement(NumberRow, {
          label: '最多攒多久也要打分（毫秒）', value: judge.maxWaitMs, min: 0, max: 300000, step: 1000,
          help: '群里一直有人说话时的上限，默认 15000',
          onChange: (v) => { patchJudge({ maxWaitMs: v }); },
        }),
        createElement(NumberRow, {
          label: '给模型看的消息条数', value: judge.contextMessages, min: 1, max: 100, step: 1,
          help: '越多越准也越贵，默认 20',
          onChange: (v) => { patchJudge({ contextMessages: v }); },
        }),
        createElement(NumberRow, {
          label: '打分超时（毫秒）', value: judge.timeoutMs, min: 1000, max: 120000, step: 1000,
          help: '超时按不接处理，默认 15000',
          onChange: (v) => { patchJudge({ timeoutMs: v }); },
        }),
      ] : []),
    ] : []),

    createElement('div', { className: 'imqb2-group-title' }, '表情收藏'),
    createElement(SwitchRow, {
      label: '允许 bot 自动收藏表情', checked: stickers.enabled,
      help: '开启后 bot 可在看到喜欢的图时调用 qqbot_sticker(action="save")；收藏会更新索引并进入后续对话的表情清单',
      onChange: (v) => { patch('stickers', { ...stickers, enabled: v }); },
    }),
    createElement(FieldRow, {
      label: '表情包目录', value: stickers.root, placeholder: '留空 = 插件根目录/stickers',
      onChange: (v) => { patch('stickers', { ...stickers, root: v }); },
    }),
    createElement(ListRow, {
      label: '额外允许的收藏来源目录', help: '每行一个；media 目录始终允许', value: stickers.extraRoots, rows: 2,
      onChange: (v) => { patch('stickers', { ...stickers, extraRoots: v }); },
    }),
    createElement(NumberRow, {
      label: '单张表情大小上限（字节）', value: stickers.maxBytes,
      min: 1024, max: 104857600, step: 1048576,
      onChange: (v) => { patch('stickers', { ...stickers, maxBytes: v }); },
    }),
    createElement(NumberRow, {
      label: '自动收藏条目上限', value: stickers.maxAutoEntries,
      min: 0, max: 5000, step: 50,
      help: '防止索引无限增长',
      onChange: (v) => { patch('stickers', { ...stickers, maxAutoEntries: v }); },
    }),

    createElement('div', { className: 'imqb2-group-title' }, '模型'),
    createElement(FieldRow, {
      label: 'Provider', value: form.provider ?? '', placeholder: '留空继承宿主默认',
      onChange: (v) => { patch('provider', v); },
    }),
    createElement(FieldRow, {
      label: 'Model', value: form.model ?? '', placeholder: '留空继承宿主默认',
      onChange: (v) => { patch('model', v); },
    }),
    createElement(FieldRow, {
      label: 'Preset', value: form.preset ?? '', placeholder: 'Agent preset id',
      onChange: (v) => { patch('preset', v); },
    }),

    createElement('div', { className: 'imqb2-group-title' }, '聊天人设'),
    createElement(FieldRow, {
      label: '人设目录',
      value: personas.root,
      placeholder: '留空 = 插件根目录/personas 或 ~/.dsh-qqbot/personas',
      help: '存放 <id>.md / <id>.group.md / <id>.direct.md（相对路径按工作目录解析）；运行态会话绑定仍保存在 ~/.dsh-qqbot/persona-state.json',
      onChange: (v) => { patch('personas', { ...personas, root: v }); },
    }),

    createElement('div', { className: 'imqb2-group-title' }, '个性化提示词'),
    createElement(AreaRow, {
      label: '群聊额外 system prompt', value: form.groupPrompt ?? '',
      onChange: (v) => { patch('groupPrompt', v); },
    }),
    createElement(AreaRow, {
      label: '私聊额外 system prompt', value: form.directPrompt ?? '',
      onChange: (v) => { patch('directPrompt', v); },
    }),
  );
}
