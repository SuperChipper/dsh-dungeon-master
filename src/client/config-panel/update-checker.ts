import { createElement, useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  BIND_UPDATE_CHECK_PATH,
  type UpdateCheckResponse,
} from '../../shared/bind-protocol.ts';

function buildUpgradePrompt(info: UpdateCheckResponse): string {
  const target = info.latestVersion ? `v${info.latestVersion}` : '最新版本';
  return [
    `请帮我将本机的 DSH 插件 ${info.packageName}（插件 ID：im-qqbot）从 v${info.currentVersion} 升级到 ${target}：`,
    '1. 先检查我当前 DSH profile（默认 web）中该插件的安装方式（插件市场 / npm / 本地源码链接），并阅读 docs/AGENT_GUIDE.md 与 CHANGELOG.md 确认本版本是否有配置注意事项。',
    '2. 修改 ~/.dsh/profiles/<profile>/cordis.patch.yml 前务必先备份，且仅使用 YAML 解析器合并 im-qqbot 节点，严禁覆盖或打印 appSecret / apiKey / 个人 voice_id。',
    '3. 执行对应方式的升级（npm：dsh plugin --profile <profile> add dsh-dungeon-master@latest；本地源码则拉取并重新构建）。',
    '4. 升级完成后提醒我重启一次 dsh 进程以刷新后端 ESM 缓存，并在 QQ 发送 /bot-doctor 做升级自检。',
  ].join('\n');
}

function copyTextToClipboard(text: string): Promise<void> {
  const copyWithExecCommand = (): boolean => {
    const textarea = document.createElement('textarea');
    textarea.value = text;
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
  if (
    typeof navigator !== 'undefined'
    && navigator.clipboard
    && typeof navigator.clipboard.writeText === 'function'
  ) {
    return navigator.clipboard.writeText(text).catch(() => {
      if (!copyWithExecCommand()) throw new Error('浏览器拒绝访问剪贴板');
    });
  }
  return Promise.resolve().then(() => {
    if (!copyWithExecCommand()) throw new Error('浏览器不支持复制剪贴板');
  });
}

/**
 * 轻量插件版本与更新检查条（纯只读检查，不自动修改磁盘或重启宿主）。
 * 发现新版时提供「复制升级 Prompt」与「查看更新日志」，把升级交给 AI Agent 处理。
 */
export function UpdateChecker(): ReactNode {
  const [info, setInfo] = useState<UpdateCheckResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const runCheck = useCallback(async (force: boolean, signal?: { cancelled: boolean }) => {
    setChecking(true);
    if (force) setFeedback(null);
    try {
      const url = force ? `${BIND_UPDATE_CHECK_PATH}?force=1` : BIND_UPDATE_CHECK_PATH;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) {
        if (force) {
          const text = res.status === 404
            ? '后端尚未加载到新版检查更新接口，请重启一次 DSH 进程后刷新页面'
            : `检查更新失败（HTTP ${res.status}）`;
          if (!signal?.cancelled) setFeedback({ ok: false, text });
        }
        return;
      }
      const body = (await res.json()) as UpdateCheckResponse;
      if (signal?.cancelled) return;
      setInfo(body);
      if (force) {
        if (body.error) {
          setFeedback({ ok: false, text: `检查更新失败：${body.error}` });
        } else if (body.hasUpdate && body.latestVersion) {
          setFeedback({ ok: true, text: `发现新版本 v${body.latestVersion}` });
        } else {
          setFeedback({ ok: true, text: `当前已是最新版本（v${body.currentVersion}）` });
        }
      }
    } catch (err: unknown) {
      if (force && !signal?.cancelled) {
        setFeedback({ ok: false, text: `检查更新失败：${err instanceof Error ? err.message : String(err)}` });
      }
    } finally {
      if (!signal?.cancelled) setChecking(false);
    }
  }, []);

  useEffect(() => {
    const signal = { cancelled: false };
    void runCheck(false, signal);
    return () => { signal.cancelled = true; };
  }, [runCheck]);

  const handleCopyPrompt = useCallback(() => {
    if (info === null) return;
    void copyTextToClipboard(buildUpgradePrompt(info))
      .then(() => {
        setFeedback({ ok: true, text: '已复制升级 Prompt，直接粘贴给 AI Agent 即可完成升级' });
      })
      .catch((err: unknown) => {
        setFeedback({ ok: false, text: `复制失败：${err instanceof Error ? err.message : String(err)}` });
      });
  }, [info]);

  const versionText = info === null
    ? '读取版本中…'
    : info.hasUpdate && info.latestVersion
      ? `v${info.currentVersion} → 发现新版 v${info.latestVersion}`
      : `v${info.currentVersion}`;

  return createElement('div', { className: 'imqb2-field' },
    createElement('div', { className: 'imqb2-head' },
      createElement('span', { className: 'imqb2-label' }, `插件版本 · ${versionText}`),
      createElement('button', {
        type: 'button',
        className: 'imqb2-btn-secondary',
        disabled: checking,
        onClick: () => { void runCheck(true); },
      }, checking ? '检查中…' : '检查更新'),
    ),

    info?.hasUpdate === true
      ? createElement('div', { className: 'imqb2-subcard' },
          createElement('p', { className: 'imqb2-help' },
            `发现新版本 v${info.latestVersion}（当前 v${info.currentVersion}）。复制下方升级 Prompt 发给 AI Agent 即可自动识别安装方式并升级，升级后重启一次 DSH 进程生效。`),
          createElement('div', { className: 'imqb2-btn-row' },
            createElement('button', {
              type: 'button',
              className: 'imqb2-btn-secondary',
              onClick: handleCopyPrompt,
            }, '复制升级 Prompt'),
            createElement('a', {
              href: info.releaseUrl,
              target: '_blank',
              rel: 'noreferrer',
              className: 'imqb2-btn-secondary',
              style: { textDecoration: 'none' },
            }, '查看更新日志'),
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
