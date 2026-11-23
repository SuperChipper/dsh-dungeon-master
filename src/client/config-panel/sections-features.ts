import { createElement, Fragment, type ReactNode } from 'react';
import type { BrowserConfig } from '../../config.ts';
import { BrowserSelectRow, FieldRow, ListRow, NumberRow, SwitchRow } from './controls.ts';
import type {
  BiliWire,
  CleanupWire,
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
  ToolAccessWire,
} from './types.ts';

export function FeatureConfigSections({ form, patch }: { form: ConfigWire; patch: PatchFn }): ReactNode {
  const notes: NotesWire = form.notes ?? {
    enabled: true, root: '', autoInject: true, injectTopK: 2, injectMaxChars: 600, injectPerNoteChars: 0, groupInjectMaxChars: 0, injectMinCoverage: 0.4,
  };
  const injectPerNoteChars = notes.injectPerNoteChars ?? 0;
  const groupInjectMaxChars = notes.groupInjectMaxChars ?? 0;
  // 旧配置没有 semantic 组时按默认值显示
  const semantic: NotesSemanticWire = notes.semantic ?? {
    enabled: false, baseUrl: 'https://api.siliconflow.cn/v1', model: 'BAAI/bge-m3', minSimilarity: 0.5, minMargin: 0.16, timeoutMs: 3000,
  };
  // 旧配置没有 judge 组时按默认值显示
  const noteJudge: NoteJudgeWire = notes.judge ?? {
    enabled: false, timeoutMs: 15000, sampleRate: 1, minSamples: 8, muteBelow: 0,
  };
  const toolAccess: ToolAccessWire = form.toolAccess ?? {
    enabled: true, fullAccessGroups: [], fullAccessUsers: [], readRoots: [],
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
  const cleanup: CleanupWire = form.cleanup ?? { dryRun: false };
  const bili: BiliWire = form.bili ?? { enabled: false };
  const reverseImage: ReverseImageWire = form.reverseImage ?? { enabled: false };
  const sing: SingWire = form.sing ?? { enabled: false, baseUrl: '' };
  const fanart: FanartWire = form.fanart ?? { enabled: false, proxy: '', poolDir: '' };
  const browser: BrowserConfig = form.browser ?? {
    enabled: false, allowedGroups: [], mode: 'local', channel: 'chrome', userDataDir: '', headless: false,
    locale: 'zh-CN', timezoneId: 'Asia/Shanghai', timeoutMs: 30000, maxTextChars: 12000,
  };
  const dnd: DndWire = form.dnd ?? { enabled: true, root: '', turnButtons: true, interjections: true };
  const combatAgent = dnd.combatAgent ?? { enabled: false, provider: '', model: '', reasoningEffort: '', contextChars: 8000 };

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

    createElement('div', { className: 'imqb2-group-title' }, '工具权限'),
    createElement(SwitchRow, {
      label: '按会话限制工具', checked: toolAccess.enabled,
      help: '关闭后所有 QQ 会话都能用终端、读写任意路径',
      onChange: (v) => { patch('toolAccess', { ...toolAccess, enabled: v }); },
    }),
    createElement(ListRow, {
      label: '可完全访问的群 openid', help: '每行一个；这些群里能用终端、读写任意路径',
      value: toolAccess.fullAccessGroups, rows: 2,
      onChange: (v) => { patch('toolAccess', { ...toolAccess, fullAccessGroups: v }); },
    }),
    createElement(ListRow, {
      label: '可完全访问的用户 openid', help: '每行一个；主人私聊始终可以',
      value: toolAccess.fullAccessUsers, rows: 2,
      onChange: (v) => { patch('toolAccess', { ...toolAccess, fullAccessUsers: v }); },
    }),
    createElement(ListRow, {
      label: '受限会话可读目录', help: '每行一个；media、表情库、临时目录始终允许',
      value: toolAccess.readRoots, rows: 3,
      onChange: (v) => { patch('toolAccess', { ...toolAccess, readRoots: v }); },
    }),

    createElement('div', { className: 'imqb2-group-title' }, '上游监测'),
    createElement(SwitchRow, {
      label: '监测 upstream 状态并自动切模型', checked: failover.enabled,
      help: '支持自动查询上游状态接口或测试首 token 时延；主用降级就切到备用，恢复后再切回',
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
      help: '从 ~/.dsh/.env 或凭证库读取，不填则只认环境里已有的',
      onChange: (v) => { patch('modelFailover', { ...failover, backupApiKeyEnv: v }); },
    }),
    createElement(SwitchRow, {
      label: '切换时通知主人', checked: failover.notify,
      onChange: (v) => { patch('modelFailover', { ...failover, notify: v }); },
    }),

    createElement('div', { className: 'imqb2-group-title' }, '临时目录与清理'),
    createElement(FieldRow, {
      label: '临时目录', value: form.tmpDir ?? '', placeholder: '留空 = 工作目录/tmp',
      help: '下载、抽帧、截图等中间文件放这里',
      onChange: (v) => { patch('tmpDir', v); },
    }),
    createElement(NumberRow, {
      label: '临时文件保留（小时）', value: form.tmpTtlHours ?? 72, min: 0, max: 8760, step: 1,
      help: '0 = 不按时间清理',
      onChange: (v) => { patch('tmpTtlHours', v); },
    }),
    createElement(NumberRow, {
      label: '临时目录总量上限（MB）', value: form.tmpMaxTotalMB ?? 4096, min: 0, max: 1048576, step: 256,
      help: '0 = 不限',
      onChange: (v) => { patch('tmpMaxTotalMB', v); },
    }),
    createElement(SwitchRow, {
      label: '清理只记日志（dry run）', checked: cleanup.dryRun,
      help: '自定义清理规则（cleanup.rules）只能在 cordis.patch.yml 里配',
      onChange: (v) => { patch('cleanup', { ...cleanup, dryRun: v }); },
    }),

    createElement('div', { className: 'imqb2-group-title' }, '浏览器'),
    createElement(SwitchRow, {
      label: '启用 Playwright 浏览', checked: browser.enabled,
      help: '主人私聊及白名单群可用，请先配置 ownerOpenid。第一次打开网站后在浏览器中手动登录。',
      onChange: (v) => { patch('browser', { ...browser, enabled: v }); },
    }),
    createElement(ListRow, {
      label: '浏览群白名单', value: browser.allowedGroups ?? [], rows: 3,
      help: '每行一个群 openid（不是 QQ 群号）；留空仅主人私聊可用。授权群内所有成员均可调用，各群登录态与主人私聊隔离。',
      onChange: (v) => { patch('browser', { ...browser, allowedGroups: v }); },
    }),
    createElement(BrowserSelectRow, {
      label: '连接方式', value: browser.mode,
      options: [{ value: 'local', label: '本机浏览器' }, { value: 'cdp', label: '指纹浏览器 CDP' }],
      onChange: (v) => { patch('browser', { ...browser, mode: v as BrowserConfig['mode'] }); },
    }),
    createElement('p', { className: 'imqb2-help' }, 'CDP 地址请设环境变量 QQBOT_BROWSER_CDP_ENDPOINT；代理可设 QQBOT_BROWSER_PROXY_SERVER。本机模式保存登录态，指纹由外接浏览器管理。'),
    createElement(BrowserSelectRow, {
      label: '本机浏览器', value: browser.channel,
      options: [{ value: 'chrome', label: 'Chrome' }, { value: 'msedge', label: 'Edge' }, { value: 'chromium', label: 'Chromium' }],
      onChange: (v) => { patch('browser', { ...browser, channel: v as BrowserConfig['channel'] }); },
    }),
    createElement(FieldRow, {
      label: '独立配置目录', value: browser.userDataDir, placeholder: '留空 = 工作目录/.qqbot-browser',
      help: '不要填写日常使用的 Chrome 用户目录；此目录包含登录凭据，请勿提交或共享。',
      onChange: (v) => { patch('browser', { ...browser, userDataDir: v }); },
    }),
    createElement(SwitchRow, {
      label: '无头模式', checked: browser.headless, help: '首次登录请关闭，以便在窗口中扫码或验证。',
      onChange: (v) => { patch('browser', { ...browser, headless: v }); },
    }),
    createElement(FieldRow, {
      label: '语言', value: browser.locale,
      onChange: (v) => { patch('browser', { ...browser, locale: v }); },
    }),
    createElement(FieldRow, {
      label: '时区', value: browser.timezoneId,
      onChange: (v) => { patch('browser', { ...browser, timezoneId: v }); },
    }),
    createElement(NumberRow, {
      label: '操作超时（毫秒）', value: browser.timeoutMs, min: 1000, max: 120000, step: 1000,
      onChange: (v) => { patch('browser', { ...browser, timeoutMs: v }); },
    }),
    createElement(NumberRow, {
      label: '返回文本上限', value: browser.maxTextChars, min: 1000, max: 50000, step: 1000,
      onChange: (v) => { patch('browser', { ...browser, maxTextChars: v }); },
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

    createElement('div', { className: 'imqb2-group-title' }, '跑团'),
    createElement(SwitchRow, {
      label: '启用跑团', checked: dnd.enabled,
      help: '/dnd 命令与 dnd_* 工具',
      onChange: (v) => { patch('dnd', { ...dnd, enabled: v }); },
    }),
    createElement(FieldRow, {
      label: '跑团数据目录', value: dnd.root, placeholder: '留空 = 工作目录/dnd',
      onChange: (v) => { patch('dnd', { ...dnd, root: v }); },
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
