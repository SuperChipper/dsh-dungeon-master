import { createElement, Fragment, type ReactNode } from 'react';
import { FieldRow, NumberRow, SwitchRow } from './controls.ts';
import type {
  BiliWire,
  ConfigWire,
  DndWire,
  FanartWire,
  ModelFailoverWire,
  NoteJudgeWire,
  NotesSemanticWire,
  NotesWire,
  PatchFn,
  ReverseImageWire,
  SingWire,
} from './types.ts';

function readDndWire(form: ConfigWire): DndWire {
  return form.dnd ?? { enabled: true, root: '', turnButtons: true, interjections: true };
}

/** 首屏跑团基础开关。 */
export function DndCoreSection({ form, patch }: { form: ConfigWire; patch: PatchFn }): ReactNode {
  const dnd = readDndWire(form);
  return createElement(Fragment, null,
    createElement('div', { className: 'imqb2-group-title' }, '跑团'),
    createElement(SwitchRow, {
      label: '启用跑团', checked: dnd.enabled,
      help: '/dnd 命令与 dnd_* 工具',
      onChange: (v) => { patch('dnd', { ...dnd, enabled: v }); },
    }),
    createElement(SwitchRow, {
      label: '回合按钮', checked: dnd.turnButtons,
      help: '轮到 PC 时发「结束回合 / 查看状态」按钮',
      onChange: (v) => { patch('dnd', { ...dnd, turnButtons: v }); },
    }),
    createElement(SwitchRow, {
      label: '开团后允许随机插嘴', checked: dnd.interjections,
      help: '只吐槽、不结算；关闭后开团后只回 @',
      onChange: (v) => { patch('dnd', { ...dnd, interjections: v }); },
    }),
  );
}

/** 折叠抽屉 1：跑团数据目录、快照节流与独立战斗代理。 */
export function DndAdvancedSection({ form, patch }: { form: ConfigWire; patch: PatchFn }): ReactNode {
  const dnd = readDndWire(form);
  const combatAgent = dnd.combatAgent ?? { enabled: false, provider: '', model: '', reasoningEffort: '', contextChars: 8000 };
  return createElement(Fragment, null,
    createElement(FieldRow, {
      label: '跑团数据目录', value: dnd.root, placeholder: '留空 = 工作目录/dnd',
      onChange: (v) => { patch('dnd', { ...dnd, root: v }); },
    }),
    createElement(NumberRow, {
      label: '团况快照注入轮数间隔', value: dnd.snapshotIntervalTurns ?? 4, min: 1, max: 20, step: 1,
      help: '默认每 4 轮对话同步 1 次完整团况（1 = 每轮对话最多 1 次）；单轮内多次攻击/移动工具调用始终锁定零重发，换房间/开战结战/撤销/压缩时自动立即刷新',
      onChange: (v) => { patch('dnd', { ...dnd, snapshotIntervalTurns: v }); },
    }),
    createElement(SwitchRow, {
      label: '独立战斗代理', checked: combatAgent.enabled,
      help: '开战后的下一次回复交给战斗模型，战后把团况交回主 DM；每场独立上下文，用量可用 /dnd combat 查看',
      onChange: (v) => { patch('dnd', { ...dnd, combatAgent: { ...combatAgent, enabled: v } }); },
    }),
    createElement(FieldRow, {
      label: '战斗 Provider', value: combatAgent.provider, placeholder: '填写已配置的 provider id',
      onChange: (v) => { patch('dnd', { ...dnd, combatAgent: { ...combatAgent, provider: v.trim() } }); },
    }),
    createElement(FieldRow, {
      label: '战斗模型', value: combatAgent.model, placeholder: '填写模型 id（如 deepseek-chat / deepseek-v4.1-flash）',
      onChange: (v) => { patch('dnd', { ...dnd, combatAgent: { ...combatAgent, model: v.trim() } }); },
    }),
    createElement(NumberRow, {
      label: '战斗交接字数', value: combatAgent.contextChars, min: 1000, max: 30000, step: 1000,
      onChange: (v) => { patch('dnd', { ...dnd, combatAgent: { ...combatAgent, contextChars: v } }); },
    }),
    createElement(FieldRow, {
      label: '战斗推理强度', value: combatAgent.reasoningEffort, placeholder: '留空使用模型默认',
      onChange: (v) => { patch('dnd', { ...dnd, combatAgent: { ...combatAgent, reasoningEffort: v.trim() } }); },
    }),
  );
}

/** 折叠抽屉 4：共享笔记、上游模型故障切换与默认关闭的扩展工具。 */
export function NotesAndExtrasSection({ form, patch }: { form: ConfigWire; patch: PatchFn }): ReactNode {
  const notes: NotesWire = form.notes ?? {
    enabled: true, root: '', autoInject: true, injectTopK: 2, injectMaxChars: 600, injectPerNoteChars: 0, groupInjectMaxChars: 0, injectMinCoverage: 0.4,
  };
  const injectPerNoteChars = notes.injectPerNoteChars ?? 0;
  const groupInjectMaxChars = notes.groupInjectMaxChars ?? 0;
  const semantic: NotesSemanticWire = notes.semantic ?? {
    enabled: false, baseUrl: 'https://api.siliconflow.cn/v1', model: 'BAAI/bge-m3', minSimilarity: 0.5, minMargin: 0.16, timeoutMs: 3000,
  };
  const noteJudge: NoteJudgeWire = notes.judge ?? {
    enabled: false, timeoutMs: 15000, sampleRate: 1, minSamples: 8, muteBelow: 0,
  };
  const failover: ModelFailoverWire = form.modelFailover ?? {
    enabled: false,
    intervalMinutes: 10,
    failThreshold: 1,
    recoverThreshold: 3,
    primaryProvider: '',
    primaryModel: '',
    primaryApiKeyEnv: '',
    backupProvider: '',
    backupModel: '',
    backupApiKeyEnv: '',
    ttftThresholdMs: 8000,
    notify: true,
  };
  const bili: BiliWire = form.bili ?? { enabled: false };
  const reverseImage: ReverseImageWire = form.reverseImage ?? { enabled: false };
  const sing: SingWire = form.sing ?? { enabled: false, baseUrl: '' };
  const fanart: FanartWire = form.fanart ?? { enabled: false, proxy: '', poolDir: '' };

  return createElement(Fragment, null,
    createElement('div', { className: 'imqb2-group-title' }, '共享笔记'),
    createElement(SwitchRow, {
      label: '启用共享笔记库', checked: notes.enabled,
      help: 'qqbot_notes(search / save) + 自动召回',
      onChange: (v) => { patch('notes', { ...notes, enabled: v }); },
    }),
    createElement(FieldRow, {
      label: '笔记目录', value: notes.root, placeholder: '留空 = 工作目录/notes',
      onChange: (v) => { patch('notes', { ...notes, root: v }); },
    }),
    createElement(SwitchRow, {
      label: '自动注入相关笔记', checked: notes.autoInject,
      help: '每条消息前检索并注入相关片段',
      onChange: (v) => { patch('notes', { ...notes, autoInject: v }); },
    }),
    createElement(NumberRow, {
      label: '最多注入片段数', value: notes.injectTopK, min: 0, max: 8, step: 1,
      onChange: (v) => { patch('notes', { ...notes, injectTopK: v }); },
    }),
    createElement(NumberRow, {
      label: '注入总字数上限', value: notes.injectMaxChars, min: 0, max: 4000, step: 50,
      onChange: (v) => { patch('notes', { ...notes, injectMaxChars: v }); },
    }),
    createElement(NumberRow, {
      label: '单段注入字数上限', value: injectPerNoteChars, min: 0, max: 4000, step: 20,
      help: '0 = 不单独限制，在总预算内按需分配',
      onChange: (v) => { patch('notes', { ...notes, injectPerNoteChars: v }); },
    }),
    createElement(NumberRow, {
      label: '群聊注入总字数上限', value: groupInjectMaxChars, min: 0, max: 4000, step: 50,
      help: '0 = 与注入总字数上限相同；群聊可设更小预算',
      onChange: (v) => { patch('notes', { ...notes, groupInjectMaxChars: v }); },
    }),
    createElement(NumberRow, {
      label: '最低查询词覆盖率', value: notes.injectMinCoverage, min: 0, max: 1, step: 0.05,
      help: '0-1，越高越保守',
      onChange: (v) => { patch('notes', { ...notes, injectMinCoverage: v }); },
    }),
    createElement(SwitchRow, {
      label: '语义检索（向量）', checked: semantic.enabled,
      help: '关键词和字面匹配之外再按意思找笔记（同义词、换种说法）；密钥请用环境变量 QQBOT_EMBEDDING_API_KEY 或 patch 配置',
      onChange: (v) => { patch('notes', { ...notes, semantic: { ...semantic, enabled: v } }); },
    }),
    createElement(FieldRow, {
      label: '向量接口地址', value: semantic.baseUrl, placeholder: 'https://api.siliconflow.cn/v1',
      onChange: (v) => { patch('notes', { ...notes, semantic: { ...semantic, baseUrl: v } }); },
    }),
    createElement(FieldRow, {
      label: '向量模型', value: semantic.model, placeholder: 'BAAI/bge-m3',
      onChange: (v) => { patch('notes', { ...notes, semantic: { ...semantic, model: v } }); },
    }),
    createElement(NumberRow, {
      label: '高出全库中位数至少', value: semantic.minMargin, min: 0, max: 1, step: 0.01,
      help: '主门槛：片段要比这条消息对全部笔记的一般相似度明显更高；过门槛的片段即使没有关键词命中也会注入',
      onChange: (v) => { patch('notes', { ...notes, semantic: { ...semantic, minMargin: v } }); },
    }),
    createElement(NumberRow, {
      label: '最低语义相似度', value: semantic.minSimilarity, min: 0, max: 1, step: 0.05,
      help: '绝对下限兜底（笔记很少时中位数不可靠）',
      onChange: (v) => { patch('notes', { ...notes, semantic: { ...semantic, minSimilarity: v } }); },
    }),
    createElement(NumberRow, {
      label: '向量请求超时（毫秒）', value: semantic.timeoutMs, min: 500, max: 30000, step: 500,
      help: '超时的那条消息只用关键词检索，不会卡住回复',
      onChange: (v) => { patch('notes', { ...notes, semantic: { ...semantic, timeoutMs: v } }); },
    }),
    createElement(SwitchRow, {
      label: '注入相关性打分', checked: noteJudge.enabled,
      help: '每轮回复结束后，让模型评这轮自动注入的笔记和用户消息相不相关（0/1/2 三档），分数记进注入账本；不拖慢回复。用的是「回复欲望」里配的打分模型，那边没填就用会话的主模型',
      onChange: (v) => { patch('notes', { ...notes, judge: { ...noteJudge, enabled: v } }); },
    }),
    createElement(NumberRow, {
      label: '打分抽样比例', value: noteJudge.sampleRate, min: 0, max: 1, step: 0.05,
      help: '1 = 每轮注入都评；调低可以省调用',
      onChange: (v) => { patch('notes', { ...notes, judge: { ...noteJudge, sampleRate: v } }); },
    }),
    createElement(NumberRow, {
      label: '静音阈值（平均相关分）', value: noteJudge.muteBelow, min: 0, max: 1, step: 0.05,
      help: '0 = 只打分、不改变注入。大于 0 时，评够次数且平均分低于它的片段不再自动注入（qqbot_notes action="search" 仍查得到；笔记文件改过会自动恢复）',
      onChange: (v) => { patch('notes', { ...notes, judge: { ...noteJudge, muteBelow: v } }); },
    }),
    createElement(NumberRow, {
      label: '静音前至少评几次', value: noteJudge.minSamples, min: 1, max: 1000, step: 1,
      onChange: (v) => { patch('notes', { ...notes, judge: { ...noteJudge, minSamples: v } }); },
    }),
    createElement(NumberRow, {
      label: '打分超时（毫秒）', value: noteJudge.timeoutMs, min: 1000, max: 120000, step: 1000,
      onChange: (v) => { patch('notes', { ...notes, judge: { ...noteJudge, timeoutMs: v } }); },
    }),

    createElement('div', { className: 'imqb2-group-title' }, '上游监测'),
    createElement(SwitchRow, {
      label: '监测 upstream 状态并自动切模型', checked: failover.enabled,
      help: '目前仅支持 opencode / opencode-go（状态接口）与 commandcode（首 token 时延探测）互为主备；主用降级就切到备用，恢复后再切回',
      onChange: (v) => { patch('modelFailover', { ...failover, enabled: v }); },
    }),
    createElement(NumberRow, {
      label: '轮询间隔（分钟）', value: failover.intervalMinutes, min: 1, max: 60,
      onChange: (v) => { patch('modelFailover', { ...failover, intervalMinutes: v }); },
    }),
    createElement(NumberRow, {
      label: '连续几次异常才切换', value: failover.failThreshold, min: 1, max: 10,
      onChange: (v) => { patch('modelFailover', { ...failover, failThreshold: v }); },
    }),
    createElement(NumberRow, {
      label: '连续几次正常才切回', value: failover.recoverThreshold, min: 1, max: 20,
      onChange: (v) => { patch('modelFailover', { ...failover, recoverThreshold: v }); },
    }),
    createElement(FieldRow, {
      label: '备用 provider', help: '留空则不启用；切换后所有活跃会话都走这里',
      value: failover.backupProvider, placeholder: '填写备用 provider id',
      onChange: (v) => { patch('modelFailover', { ...failover, backupProvider: v }); },
    }),
    createElement(FieldRow, {
      label: '备用模型 id', value: failover.backupModel, placeholder: '填写备用模型 id',
      onChange: (v) => { patch('modelFailover', { ...failover, backupModel: v }); },
    }),
    createElement(NumberRow, {
      label: '首 token 时延阈值（毫秒）', value: failover.ttftThresholdMs, min: 1000, max: 60000,
      help: '没有状态接口的 provider 靠发小请求测时延；超过阈值判降级',
      onChange: (v) => { patch('modelFailover', { ...failover, ttftThresholdMs: v }); },
    }),
    createElement(FieldRow, {
      label: '备用凭据环境变量', value: failover.backupApiKeyEnv,
      placeholder: '环境变量名，如 BACKUP_API_KEY',
      help: '优先读取宿主凭证库，其次环境变量（~/.dsh/.env）；仅 commandcode 等请求探测通道需要',
      onChange: (v) => { patch('modelFailover', { ...failover, backupApiKeyEnv: v }); },
    }),
    createElement(SwitchRow, {
      label: '切换时通知主人', checked: failover.notify,
      onChange: (v) => { patch('modelFailover', { ...failover, notify: v }); },
    }),

    createElement('div', { className: 'imqb2-group-title' }, '扩展工具（默认关闭）'),
    createElement(SwitchRow, {
      label: '启用 B 站只读工具', checked: bili.enabled,
      help: 'qqbot_bili / qqbot_bili_auth（搜索、视频信息、评论、字幕及主人私聊扫码）',
      onChange: (v) => { patch('bili', { ...bili, enabled: v }); },
    }),
    createElement(SwitchRow, {
      label: '启用以图搜图工具', checked: reverseImage.enabled,
      help: 'qqbot_reverse_image（trace.moe + SauceNAO，上传图片查出处）',
      onChange: (v) => { patch('reverseImage', { ...reverseImage, enabled: v }); },
    }),
    createElement(SwitchRow, {
      label: '启用点歌工具', checked: sing.enabled,
      help: 'qqbot_sing（对接外部唱歌 HTTP 服务，异步下载唱完成品发回会话）',
      onChange: (v) => { patch('sing', { ...sing, enabled: v }); },
    }),
    sing.enabled ? createElement(FieldRow, {
      label: '唱歌服务地址', value: sing.baseUrl, placeholder: '留空 = QQBOT_SING_URL 或 http://127.0.0.1:8766',
      onChange: (v) => { patch('sing', { ...sing, baseUrl: v }); },
    }) : null,

    createElement('div', { className: 'imqb2-group-title' }, '搜图'),
    createElement(SwitchRow, {
      label: '启用 qqbot_fanart 搜图', checked: fanart.enabled,
      onChange: (v) => { patch('fanart', { ...fanart, enabled: v }); },
    }),
    createElement(FieldRow, {
      label: 'HTTP 代理', value: fanart.proxy, placeholder: '留空 = HTTPS_PROXY 或系统代理',
      onChange: (v) => { patch('fanart', { ...fanart, proxy: v }); },
    }),
    createElement(FieldRow, {
      label: '标签池目录', value: fanart.poolDir, placeholder: '留空 = 插件根目录/scripts',
      onChange: (v) => { patch('fanart', { ...fanart, poolDir: v }); },
    }),
  );
}
