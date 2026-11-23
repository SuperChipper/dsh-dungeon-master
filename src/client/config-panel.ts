/**
 * QQ 机器人配置面板 — 必要配置的 UI 编辑
 *
 * UI 复刻 DSW 通用设置（settings-form 原语）的视觉风格：
 * 左对齐设置列、0.5px 行分隔、label 13px/500、控件右置；
 * Switch 为 36×20 aria-checked 结构（thumb translateX 动画）；
 * 三值选择用分段控件（滑动指示器按段数/索引的 CSS 变量定位）；
 * 保存按钮为 DSW 反色主按钮（label-primary 底 + bg-layer-3 字）。
 *
 * 数据流：GET /qqbot/im-qqbot/config 回显当前生效配置（appSecret
 * 已由宿主剔除）→ 表单编辑 → dirty diff → POST 仅提交变更键 →
 * 宿主白名单 + Schema 校验 → 最小写入 profile patch → HMR 重载生效。
 *
 * 字段策略：只开放用户必要的配置；cwd 只读展示；超时与性能调优
 * 类字段走 profile patch / 环境变量。
 */
import { createElement, useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { BIND_CONFIG_PATH } from '../shared/bind-protocol.ts';
import { CollapsibleSection, useConfigPanelStyles } from './config-panel/controls.ts';
import { AdvancedSessionSection, QuickStartCoreSection } from './config-panel/sections-core.ts';
import { DndAdvancedSection, DndCoreSection, NotesAndExtrasSection } from './config-panel/sections-features.ts';
import { MediaConfigSections } from './config-panel/sections-media.ts';
import {
  formatRoleVoices,
  normalizeChangedConfig,
  shallowEqual,
  summarizeDndAdvanced,
  summarizeExtrasDrawer,
  summarizeMediaDrawer,
  type ConfigWire,
  type PatchFn,
} from './config-panel/types.ts';

/**
 * 配置面板主体。
 *
 * 保存仅提交变更键（服务端按白名单合并），保存成功后提示
 * HMR 重载语义（进行中的机器人会话将重置）。
 */
export function ConfigPanel(): ReactNode {
  useConfigPanelStyles();
  const [initial, setInitial] = useState<ConfigWire | null>(null);
  const [form, setForm] = useState<ConfigWire | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [extraRoleVoicesText, setExtraRoleVoicesText] = useState<string>('');
  const [extraDsRoleVoicesText, setExtraDsRoleVoicesText] = useState<string>('');

  useEffect(() => {
    let stopped = false;
    void fetch(BIND_CONFIG_PATH, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { config: ConfigWire };
        if (stopped) return;
        setInitial(body.config);
        setForm(body.config);
        setExtraRoleVoicesText(formatRoleVoices(body.config.speak?.elevenlabs?.roleVoices ?? {}));
        setExtraDsRoleVoicesText(formatRoleVoices(body.config.speak?.deepseek?.roleVoices ?? {}));
      })
      .catch((err: unknown) => {
        if (!stopped) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => { stopped = true; };
  }, []);

  const patch = useCallback<PatchFn>((key, value) => {
    setForm((current) => current === null ? current : { ...current, [key]: value });
    setResult(null);
  }, []);

  const submit = useCallback((event: FormEvent): void => {
    event.preventDefault();
    if (busy || initial === null || form === null) return;
    const changed = normalizeChangedConfig(form, initial);
    if (Object.keys(changed).length === 0) return;

    setBusy(true);
    void fetch(BIND_CONFIG_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(changed),
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
        if (res.ok && body.ok === true) {
          setResult({ ok: true, message: body.message ?? '配置已保存，插件将自动重载' });
          setInitial(form);
          return;
        }
        setResult({ ok: false, message: body.error ?? `保存失败（HTTP ${res.status}）` });
      })
      .catch((err: unknown) => {
        setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => { setBusy(false); });
  }, [busy, form, initial]);

  if (loadError !== null) {
    return createElement('p', { className: 'imqb2-hint', style: { padding: '12px 0' } },
      `配置加载失败：${loadError}`);
  }
  if (initial === null || form === null) {
    return createElement('p', { className: 'imqb2-hint', style: { padding: '12px 0' } }, '正在加载配置…');
  }

  const dirty = (Object.keys(form) as Array<keyof ConfigWire>).some((key) => !shallowEqual(form[key], initial[key]));

  return createElement('form', { className: 'imqb2-form', onSubmit: submit },
    createElement(QuickStartCoreSection, { form, patch }),
    createElement(DndCoreSection, { form, patch }),
    createElement(CollapsibleSection, {
      title: '跑团进阶与战斗代理',
      summary: summarizeDndAdvanced(form),
    }, createElement(DndAdvancedSection, { form, patch })),
    createElement(CollapsibleSection, {
      title: '会话、权限与人设进阶',
      summary: '权限 · 压缩 · 人设 · 清理',
    }, createElement(AdvancedSessionSection, { form, patch })),
    createElement(CollapsibleSection, {
      title: '富媒体、视觉、语音与生图',
      summary: summarizeMediaDrawer(form),
    }, createElement(MediaConfigSections, {
      form,
      patch,
      extraRoleVoicesText,
      setExtraRoleVoicesText,
      extraDsRoleVoicesText,
      setExtraDsRoleVoicesText,
    })),
    createElement(CollapsibleSection, {
      title: '共享笔记、上游监测与扩展工具',
      summary: summarizeExtrasDrawer(form),
    }, createElement(NotesAndExtrasSection, { form, patch })),

    form.cwd !== undefined
      ? createElement('div', { className: 'imqb2-field' },
          createElement('div', { className: 'imqb2-head' },
            createElement('span', { className: 'imqb2-label' }, 'Agent 工作目录'),
            createElement('span', { className: 'imqb2-hint' }, '只读'),
          ),
          createElement('p', { className: 'imqb2-readonly' }, form.cwd),
        )
      : null,

    createElement('div', { className: 'imqb2-footer' },
      result !== null
        ? createElement('p', { className: `imqb2-note${result.ok ? ' imqb2-note--ok' : ' imqb2-note--error'}` },
            (result.ok ? '' : '⚠️ ') + result.message)
        : dirty
          ? createElement('p', { className: 'imqb2-note' }, '保存后插件将重载，进行中的机器人会话将重置')
          : createElement('p', { className: 'imqb2-note' }),
      createElement('button', { className: 'imqb2-save', type: 'submit', disabled: busy || !dirty },
        busy ? '正在保存…' : '保存'),
    ),
  );
}
