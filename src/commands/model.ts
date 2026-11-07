/**
 * 模型命令：/model — 查看或切换模型
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import { getScopePeer, sendMarkdownChunked } from '../shared/index.ts';
import { isPrivilegedSender } from '../shared/permissions.ts';

export function modelCommand({ manager, config }: CommandDeps): CategorizedCommand {
  return {
    name: 'model',
    category: 'agent',
    description: '查看或切换模型（用法: /model [provider/model]｜/model reset 回到默认）',
    authorized: (ctx) => {
      // 无参数只是查看/列出模型，不限制；带参数才是修改
      const raw = (ctx.command?.raw ?? '').trim();
      if (raw === '') return true;
      return isPrivilegedSender(ctx.message.senderId, config)
        || '⚠️ 只有 bot 主人或管理员可以修改模型。';
    },
    handler: async (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);
      const args = (cmdCtx.command?.raw ?? '').trim();

      // 无参数：显示当前模型 + 可用模型列表（可点击）
      if (!args) {
        const current = manager.getEffectiveModel(scope, peerId);
        const models = await manager.listAvailableModels();

        // 当前模型展示：优先用别名（name），找不到别名时回退到 provider/model id
        let currentDisplay = '宿主默认配置';
        if (current) {
          const matched = models.find((m) => m.provider === current.provider && m.id === current.model);
          currentDisplay = matched?.name ?? `${current.provider}/${current.model}`;
        }

        const lines: string[] = [
          '### 🤖 模型配置',
          '',
          `**当前模型:** ${currentDisplay}`,
        ];

        if (models.length > 0) {
          lines.push('', '**可用模型（点击切换）:**');
          for (const m of models) {
            const modelPath = `${m.provider}/${m.id}`;
            const displayName = m.name ? `${m.name}` : modelPath;
            lines.push(`<qqbot-cmd-input text="/model ${modelPath}" show="/model ${displayName}"/>`);
          }
        }

        lines.push('', '手动指定: `/model provider/model`');

        await sendMarkdownChunked(cmdCtx, lines.join('\n'), config.textChunkLimit);
        return { kind: 'noop' as const };
      }

      // /model reset：清掉这个会话的覆盖，回到配置默认路由。
      // 没有这一步，/model 写进去的 per-chat 覆盖就是单向的，永远回不去。
      if (args === 'reset' || args === 'clear' || args === '默认') {
        const route = await manager.clearModelOverride(scope, peerId);
        const label = route === undefined ? '宿主默认配置' : `${route.provider}/${route.model}`;
        return `✅ 已清掉本会话的模型覆盖，回到默认：${label}
立即生效，对话上下文保留。`;
      }
      // 解析 provider/model 格式
      let provider: string;
      let model: string;

      if (args.includes('/')) {
        const parts = args.split('/');
        provider = parts[0] ?? '';
        model = parts.slice(1).join('/');
      } else {
        // 仅指定 model 名，provider 从当前路由继承
        const current = manager.getEffectiveModel(scope, peerId);
        provider = current?.provider ?? 'deepseek-official';
        model = args;
      }

      if (!provider || !model) {
        return '用法: /model provider/model\n示例: /model deepseek-official/deepseek-v4-flash';
      }

      const applied = await manager.setModelOverride(scope, peerId, { provider, model });
      if (!applied) {
        return `✅ 已记下: ${provider}/${model}\n这一轮还在跑，下一句开口就用新模型（上下文不动）。`;
      }
      return `✅ 模型已切换: ${provider}/${model}\n立即生效，对话上下文保留。`;
    },
  };
}
