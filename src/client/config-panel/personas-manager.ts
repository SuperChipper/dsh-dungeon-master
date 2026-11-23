import { createElement, useCallback, useEffect, useState, type ChangeEvent, type ReactNode } from 'react';
import {
  BIND_PERSONAS_OPEN_PATH,
  BIND_PERSONAS_PATH,
  type PersonaCreateResponse,
  type PersonaScopeKind,
  type PersonasListResponse,
  type PersonaSummaryWire,
} from '../../shared/bind-protocol.ts';

function scopeBadge(scopes: readonly PersonaScopeKind[]): string {
  const hasGroup = scopes.includes('group');
  const hasDirect = scopes.includes('direct');
  if (scopes.includes('both')) return '';
  if (hasGroup && hasDirect) return '群/私分设';
  if (hasGroup) return '仅群聊';
  if (hasDirect) return '仅私聊';
  return '';
}

function formatChipText(persona: PersonaSummaryWire): string {
  const base = persona.name === persona.id ? persona.id : `${persona.name} (${persona.id})`;
  const badge = scopeBadge(persona.scopes);
  return badge === '' ? base : `${base} · ${badge}`;
}

/** 查看生效人设清单、一键打开人设目录，并支持新建自定义人设文件。 */
export function PersonasManager(): ReactNode {
  const [info, setInfo] = useState<PersonasListResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [scope, setScope] = useState<PersonaScopeKind>('both');
  const [prompt, setPrompt] = useState('');
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const reload = useCallback(async (signal?: { cancelled: boolean }) => {
    try {
      const res = await fetch(BIND_PERSONAS_PATH, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as PersonasListResponse;
      if (signal?.cancelled) return;
      setInfo(body);
      setLoadError(null);
    } catch (err: unknown) {
      if (signal?.cancelled) return;
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    const signal = { cancelled: false };
    void reload(signal);
    return () => { signal.cancelled = true; };
  }, [reload]);

  const handleOpenDir = useCallback(() => {
    if (opening) return;
    setOpening(true);
    setFeedback(null);
    void fetch(BIND_PERSONAS_OPEN_PATH, { method: 'POST' })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
        if (res.ok && body.ok === true) {
          setFeedback({ ok: true, text: body.message ?? '已打开人设目录' });
          return;
        }
        setFeedback({ ok: false, text: body.error ?? `打开目录失败（HTTP ${res.status}）` });
      })
      .catch((err: unknown) => {
        setFeedback({ ok: false, text: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => { setOpening(false); });
  }, [opening]);

  const handleCopyDir = useCallback(() => {
    const dir = info?.dir;
    if (!dir) return;
    const copyWithExecCommand = (): boolean => {
      const textarea = document.createElement('textarea');
      textarea.value = dir;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        return document.execCommand('copy');
      } finally {
        document.body.removeChild(textarea);
      }
    };
    const write = typeof navigator !== 'undefined'
      && navigator.clipboard
      && typeof navigator.clipboard.writeText === 'function'
      ? navigator.clipboard.writeText(dir).catch(() => {
          if (!copyWithExecCommand()) throw new Error('浏览器拒绝访问剪贴板');
        })
      : Promise.resolve().then(() => {
          if (!copyWithExecCommand()) throw new Error('浏览器不支持复制剪贴板');
        });
    void write
      .then(() => {
        setFeedback({ ok: true, text: `已复制路径: ${dir}` });
      })
      .catch((err: unknown) => {
        setFeedback({ ok: false, text: `复制路径失败: ${err instanceof Error ? err.message : String(err)}` });
      });
  }, [info]);

  const handleCreate = useCallback(() => {
    if (creating) return;
    const trimmedId = id.trim();
    if (trimmedId === '') {
      setFeedback({ ok: false, text: '请先填写人设 ID（如 cat-dm）' });
      return;
    }
    setCreating(true);
    setFeedback(null);
    void fetch(BIND_PERSONAS_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: trimmedId,
        name: name.trim(),
        scope,
        prompt,
      }),
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as PersonaCreateResponse;
        if (res.ok && body.ok === true) {
          setFeedback({ ok: true, text: body.message ?? `已创建人设文件 ${body.fileName ?? ''}` });
          setId('');
          setName('');
          setScope('both');
          setPrompt('');
          setShowCreate(false);
          await reload();
          return;
        }
        setFeedback({ ok: false, text: body.error ?? `创建失败（HTTP ${res.status}）` });
      })
      .catch((err: unknown) => {
        setFeedback({ ok: false, text: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => { setCreating(false); });
  }, [creating, id, name, prompt, reload, scope]);

  return createElement('div', { className: 'imqb2-field' },
    createElement('div', { className: 'imqb2-head' },
      createElement('span', { className: 'imqb2-label' }, '人设目录与自定义人设'),
      createElement('button', {
        type: 'button',
        className: 'imqb2-btn-secondary',
        disabled: opening,
        onClick: handleOpenDir,
      }, opening ? '正在打开…' : '打开人设目录'),
      createElement('button', {
        type: 'button',
        className: 'imqb2-btn-secondary',
        disabled: info === null,
        onClick: handleCopyDir,
      }, '复制路径'),
      createElement('button', {
        type: 'button',
        className: 'imqb2-btn-secondary',
        onClick: () => { setShowCreate((v) => !v); setFeedback(null); },
      }, showCreate ? '收起新建' : '新建自定义人设'),
    ),

    info !== null
      ? createElement('p', { className: 'imqb2-readonly' }, `当前目录：${info.dir}`)
      : loadError !== null
        ? createElement('p', { className: 'imqb2-note imqb2-note--error' }, `人设目录读取失败：${loadError}`)
        : createElement('p', { className: 'imqb2-hint' }, '正在读取人设目录…'),

    info?.isBundledDir === true
      ? createElement('p', { className: 'imqb2-hint' },
          '当前为内置人设目录；建议在上方「人设目录」填独立路径（如 ~/.dsh-qqbot/personas），避免升级覆盖自定义文件')
      : null,

    info !== null
      ? info.personas.length > 0
        ? createElement('div', { className: 'imqb2-chip-list' },
            info.personas.map((persona) => createElement('span', {
              key: persona.id,
              className: 'imqb2-chip',
              title: persona.files.join(', '),
            }, formatChipText(persona))))
        : createElement('p', { className: 'imqb2-hint' }, '目录下暂无人设文件，可点击「新建自定义人设」生成模板。')
      : null,

    showCreate
      ? createElement('div', { className: 'imqb2-subcard' },
          createElement('span', { className: 'imqb2-label' }, '人设 ID'),
          createElement('input', {
            className: 'imqb2-input',
            value: id,
            placeholder: '例如 cat-dm，仅限字母/数字/_/-',
            spellCheck: false,
            onChange: (event: ChangeEvent<HTMLInputElement>) => { setId(event.currentTarget.value); },
          }),
          createElement('span', { className: 'imqb2-label' }, '显示名称'),
          createElement('input', {
            className: 'imqb2-input',
            value: name,
            placeholder: '例如 毒舌猫猫（留空同 ID）',
            onChange: (event: ChangeEvent<HTMLInputElement>) => { setName(event.currentTarget.value); },
          }),
          createElement('span', { className: 'imqb2-label' }, '生效范围'),
          createElement('select', {
            className: 'imqb2-input',
            value: scope,
            onChange: (event: ChangeEvent<HTMLSelectElement>) => { setScope(event.currentTarget.value as PersonaScopeKind); },
          },
          createElement('option', { value: 'both' }, 'both（群聊 / 私聊通用：<id>.md）'),
          createElement('option', { value: 'group' }, 'group（仅群聊：<id>.group.md）'),
          createElement('option', { value: 'direct' }, 'direct（仅私聊：<id>.direct.md）'),
          ),
          createElement('span', { className: 'imqb2-label' }, '初始提示词'),
          createElement('textarea', {
            className: 'imqb2-input imqb2-textarea',
            rows: 4,
            value: prompt,
            placeholder: '留空则生成默认人设模板，可随后打开目录用编辑器精修',
            onChange: (event: ChangeEvent<HTMLTextAreaElement>) => { setPrompt(event.currentTarget.value); },
          }),
          createElement('div', { className: 'imqb2-btn-row' },
            createElement('button', {
              type: 'button',
              className: 'imqb2-btn-secondary',
              disabled: creating,
              onClick: handleCreate,
            }, creating ? '正在创建…' : '创建人设文件'),
          ),
        )
      : null,

    feedback !== null
      ? createElement('p', {
          className: `imqb2-note ${feedback.ok ? 'imqb2-note--ok' : 'imqb2-note--error'}`,
        }, feedback.ok ? feedback.text : `⚠️ ${feedback.text}`)
      : null,
  );
}
