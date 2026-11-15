import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

// 实际宿主服务与离线模型运行完整 turn；只用内存 Session，不连接 QQ、不写真实会话。
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hostRoot = process.argv[2] ?? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'npm/node_modules/@deepseek-ai/dsh');
const host = (name) => pathToFileURL(join(hostRoot, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href;
if (!existsSync(join(root, 'dist/shared/message-source.js'))) throw new Error('请先 npm run build');
const { createPersonaHandoffMessage } = await import(pathToFileURL(join(root, 'dist/shared/message-source.js')).href);
const { generatePersonaHandoff } = await import(pathToFileURL(join(root, 'dist/features/persona-handoff.js')).href);
const { releasedV4SessionFormatCodec: codec, restoreReleasedV4Artifact } = await import(host('dsh-session-format-v3-to-v4'));
const { KNOWN_SESSION_EVENT_TYPES, Session, SessionId } = await import(host('dsh-session'));
const { createUserMessage } = await import(host('dsh-llm'));
const { Context } = await import(host('cordis'));
const old = createUserMessage({ content: [{ type: 'text', text: 'old format' }], source: { kind: 'plugin', plugin: 'qqbot-persona-handoff' } });
assert.throws(() => codec.encodeEvent({ type: 'user/message', seq: 0, time: Date.now(), data: old, surfaceOp: 'append' }), /producer-owned source kind/);

function roundtrip(session) {
  // 一头帧 + 每事件一帧；每个frame分别解压，不能只解连接buffer的首帧。
  const records = [codec.encodeHeader(session.header, session.inheritedEventCount), ...session.snapshotEvents().map(event => codec.encodeEvent(event))];
  const frames = records.map(record => zstdCompressSync(Buffer.from(JSON.stringify(record) + '\n')));
  const rows = frames.map(frame => JSON.parse(zstdDecompressSync(frame).toString()));
  const decoder = codec.createDecoder(rows[0], 'strict');
  const events = [];
  const sink = { emitEvent: event => events.push(event), emitRun: run => events.push(...run.expand()) };
  for (const row of rows.slice(1)) decoder.decodeRow(row, sink);
  const artifact = { header: decoder.header, inheritedEventCount: decoder.finish(sink), events };
  return restoreReleasedV4Artifact(artifact, KNOWN_SESSION_EVENT_TYPES);
}

const ctx = new Context();
const fibers = [];
let modelRequests = 0;
ctx.provide('llm', {
  prepareCall: async config => ({ config, async *stream(options) {
    modelRequests++;
    assert(options.messages.some(message => message.role === 'system'));
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'offline regression reply' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } }),
});
let handles = [];
try {
  for (const name of ['dsh-session', 'dsh-agent', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent-loop']) {
    const plugin = await import(host(name));
    const fiber = ctx.plugin(plugin.default, { agents: [], includeRuntimeContext: false, personaPrefix: 'Isolated regression system.', maxParallelToolCalls: 1 });
    fibers.push(fiber);
    await fiber.await();
  }
  const create = async id => {
    const handle = await ctx.agents.create({ sessionId: id, meta: { delegationDepth: 0 }, agentOptions: { provider: 'offline', model: 'offline' } });
    handles.push(handle);
    return handle.agent;
  };
  const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
  const broken = await create('e2a352e4-c0a8-498b-8ddf-b9d6ea38f255');
  broken.session.append('user/message', createPersonaHandoffMessage('broken direct append'), { surfaceOp: 'append' });
  await broken.followup(user('continue'));
  await broken.whenIdle();
  // 原测试只 encodeEvent，逐行编码能过，跨事件关系在真实恢复阶段才拒绝。
  assert.throws(() => roundtrip(broken.session), /protected first surface head/);

  const fresh = await create('8e6f7808-c11a-4b4a-a770-476c66e2f045');
  fresh.send(createPersonaHandoffMessage('latest shared handoff'), 'next-step', false);
  assert.equal(fresh.status, 'idle');
  assert.equal(fresh.session.deriveMessages().length, 0);
  assert.equal(fresh.session.snapshotEvents()[0].type, 'agent/inbox/spliced');
  roundtrip(fresh.session); // 尚未唤醒的持久化收件箱也应可恢复。
  fresh.followup(user('new user request'));
  await fresh.whenIdle();
  const restored = roundtrip(fresh.session);
  const surfaces = restored.events.filter(event => 'surfaceOp' in event);
  assert.equal(surfaces[0].type, 'system/message');
  const inputs = restored.events.filter(event => event.type === 'user/message');
  assert.equal(inputs[0].data.source.kind, 'qqbot-persona-handoff');
  assert.equal(inputs[1].data.source.kind, 'user');
  assert.equal(inputs.filter(event => event.data.source.kind === 'qqbot-persona-handoff').length, 1);

  // 已有自身历史的目标也通过下一步输入，保留历史→交接→新请求顺序。
  fresh.send(createPersonaHandoffMessage('second handoff after own history'), 'next-step', false);
  fresh.followup(user('second new request'));
  await fresh.whenIdle();
  roundtrip(fresh.session);
  const history = fresh.session.deriveMessages().filter(message => message.role === 'user');
  assert.equal(history.length, 4);
  assert.equal(history[2].source.kind, 'qqbot-persona-handoff');
  assert.match(JSON.stringify(history[3]), /second new request/);
} finally {
  for (const handle of handles.reverse()) await handle.dispose();
  for (const fiber of fibers.reverse()) await fiber.dispose();
}

let handoffRequests = 0;
const llm = {
  async *stream(options) {
    for (const message of options.messages) codec.encodeEvent({ type: 'user/message', seq: 0, time: Date.now(), data: message, surfaceOp: 'append' });
    handoffRequests++;
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '已验证的交接' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  },
};
assert.equal(await generatePersonaHandoff(llm, { provider: 'offline', model: 'offline' }, '', '最后一句纠正', new AbortController().signal), '已验证的交接');
console.log(JSON.stringify({ rejectedRetiredPluginSource: true, reproducedDirectAppendRestoreFailure: true, restoredQueuedInbox: true, restoredFreshAndExistingHistoryTurns: true, actualHostModelRequests: modelRequests, handoffRequestsValidated: handoffRequests, touchedRealChats: false }, null, 2));
