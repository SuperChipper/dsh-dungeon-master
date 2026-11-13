import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 用实际安装的宿主编解码器验收；仅用内存里的隔离 Session，不连接 QQ、不写真实会话。
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hostRoot = process.argv[2] ?? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'npm/node_modules/@deepseek-ai/dsh');
const host = (name) => pathToFileURL(join(hostRoot, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href;
if (!existsSync(join(root, 'dist/shared/message-source.js'))) throw new Error('请先 npm run build');
const { createPersonaHandoffMessage } = await import(pathToFileURL(join(root, 'dist/shared/message-source.js')).href);
const { generatePersonaHandoff } = await import(pathToFileURL(join(root, 'dist/features/persona-handoff.js')).href);
const { releasedV4SessionFormatCodec: codec } = await import(host('dsh-session-format-v3-to-v4'));
const { Session, SessionId } = await import(host('dsh-session'));
const { createUserMessage } = await import(host('dsh-llm'));
const session = Session.create(SessionId('8e6f7808-c11a-4b4a-a770-476c66e2f045'));
const old = createUserMessage({ content: [{ type: 'text', text: 'old format' }], source: { kind: 'plugin', plugin: 'qqbot-persona-handoff' } });
assert.throws(() => codec.encodeEvent({ type: 'user/message', seq: 0, time: Date.now(), data: old, surfaceOp: 'append' }), /producer-owned source kind/);
for (const text of ['目标人格自身历史', '最新共同交接', '用户的新消息']) {
  const event = session.append('user/message', createPersonaHandoffMessage(text), { surfaceOp: 'append' });
  codec.encodeEvent(event);
}
assert.equal(session.deriveMessages().length, 3);
let requests = 0;
const llm = {
  async *stream(options) {
    for (const message of options.messages) {
      codec.encodeEvent({ type: 'user/message', seq: 0, time: Date.now(), data: message, surfaceOp: 'append' });
    }
    requests++;
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '已验证的交接' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  },
};
assert.equal(await generatePersonaHandoff(llm, { provider: 'offline', model: 'offline' }, '', '最后一句纠正', new AbortController().signal), '已验证的交接');
console.log(JSON.stringify({ hostRoot, rejectedRetiredPluginSource: true, durableMessagesValidated: 3, handoffRequestsValidated: requests, touchedRealChats: false }, null, 2));
