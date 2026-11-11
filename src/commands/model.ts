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
下一条消息起生效，会话和上下文都不动。`;
      }
      // 解析 provider/model 格式
      const tokens = args.split(/\s+/).filter(Boolean);
      const knownProviders = manager.listProviders();
      let provider: string;
      let model: string;

      if (args.includes('/')) {
        const parts = args.split('/');
        provider = parts[0] ?? '';
        model = parts.slice(1).join('/');
      } else if (tokens.length >= 2 && knownProviders.includes(tokens[0]!)) {
        // `/model hapi gpt-6.1-sol` 这种空格写法也认。以前它整串被当成模型名存下去，
        // 于是 model 变成 "hapi gpt-6.1-sol"：请求还发得出去（中转站会兜底），但 web 端
        // 拿它去对目录永远对不上，模型标签一直显示「请选择模型」。
        provider = tokens[0]!;
        model = tokens.slice(1).join(' ');
      } else {
        // 仅指定 model 名，provider 从当前路由继承
        const current = manager.getEffectiveModel(scope, peerId);
        provider = current?.provider ?? 'deepseek-official';
        model = args;
      }

      if (!provider || !model) {
        return '用法: /model provider/model\n示例: /model deepseek-official/deepseek-v4-flash';
      }

      // 对不上目录就不写进去：写进去也只会变成一个谁也解析不了的字符串
      const models = await manager.listAvailableModels();
      if (models.length > 0 && !models.some((m) => m.provider === provider && m.id === model)) {
        const sameProvider = models.filter((m) => m.provider === provider);
        const near = (sameProvider.length > 0 ? sameProvider : models)
          .slice(0, 8)
          .map((m) => `\`${m.provider}/${m.id}\``)
          .join(' · ');
        return `❌ 没有这个模型: ${provider}/${model}
${sameProvider.length > 0 ? `${provider} 下可选` : '全部可选'}: ${near || '（无）'}`;
      }

      await manager.setModelOverride(scope, peerId, { provider, model });
      return `✅ 模型已切换: ${provider}/${model}
下一条消息起生效，会话和上下文都不动。`;
    },
  };
}
