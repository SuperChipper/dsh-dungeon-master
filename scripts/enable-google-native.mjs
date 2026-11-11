import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

// Keep this repair repeatable: a dsh upgrade can replace the installed adapter.
const runtimeFile = path.join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js');
const profileFile = path.join(process.env.USERPROFILE, '.dsh/profiles/web/cordis.patch.yml');
const source = fs.readFileSync(runtimeFile, 'utf8');
const profileText = fs.readFileSync(profileFile, 'utf8');
const profile = yaml.load(profileText);
const plugin = profile.find((item) => item.id === 'llm-pi-ai');
assert(plugin?.config?.providers?.['google-ai-studio'], 'google-ai-studio provider missing');
const oldProvider = plugin.config.providers['google-ai-studio'];
const provider = { ...oldProvider, api: 'google-generative-ai', baseURL: 'https://generativelanguage.googleapis.com/v1beta' };
delete provider.compat;
assert.equal(provider.apiKeyEnv, 'GEMINI_API_KEY');
assert.equal(provider.models[0].id, 'gemini-4-carbon');

let patched = source;
if (!patched.includes('import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";')) {
  const anchor = 'import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";';
  assert.equal(patched.split(anchor).length, 2, 'Adapter import layout changed; review before patching');
  patched = patched.replace(anchor, `${anchor}\nimport { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";`);
}
if (!patched.includes('"google-generative-ai": googleGenerativeAIApi')) {
  const anchor = 'const PROTOCOLS = {\n\t"openai-completions": openAICompletionsApi,';
  assert.equal(patched.split(anchor).length, 2, 'Adapter protocol table changed; review before patching');
  patched = patched.replace(anchor, 'const PROTOCOLS = {\n\t"google-generative-ai": googleGenerativeAIApi,\n\t"openai-completions": openAICompletionsApi,');
}

const request = createRequire(runtimeFile);
const hash = createHash('sha256').update(patched).digest('hex').slice(0, 12);
const previewDir = path.resolve('tmp/google-native-repair');
fs.mkdirSync(previewDir, { recursive: true });
const previewFile = path.join(previewDir, `adapter-${hash}.mjs`);
const specifiers = [...patched.matchAll(/from "([^"\n]+)"/g)].map((match) => match[1]);
const resolution = spawnSync(process.execPath, ['--input-type=module', '-e', `console.log(JSON.stringify(${JSON.stringify(specifiers)}.map(specifier => [specifier, import.meta.resolve(specifier)])))`], {
  cwd: path.dirname(runtimeFile), encoding: 'utf8', windowsHide: true,
});
assert.equal(resolution.status, 0, resolution.stderr);
const resolvedImports = new Map(JSON.parse(resolution.stdout));
const previewSource = patched.replace(/from "([^"\n]+)"/g, (all, specifier) => {
  if (specifier.startsWith('node:')) return all;
  return `from ${JSON.stringify(resolvedImports.get(specifier))}`;
}) + '\nexport { resolveProfiles, toPiAssistant, toPiContext, toStreamChunks };\n';
fs.writeFileSync(previewFile, previewSource);
const adapterModule = await import(pathToFileURL(previewFile).href);
adapterModule.Config({ providers: { 'google-ai-studio': provider } });
assert(adapterModule.supportedProtocols().includes('google-generative-ai'));
const profiles = adapterModule.resolveProfiles({ ...plugin.config.providers, 'google-ai-studio': provider });
assert.equal(profiles.get('google').baseURL, plugin.config.providers.google.baseURL, 'Existing Argon route changed');
const adapter = new adapterModule.PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => 'offline-key' });
assert.equal((await adapter.resolveModel('google-ai-studio', provider.models[0].id)).reasoning.defaultEffort, provider.reasoning);

const llm = await import(pathToFileURL(request.resolve('@deepseek-ai/dsh-llm')).href);
const signature = Buffer.from('offline-signature-for-exact-replay').toString('base64');
const emptySignature = Buffer.from('offline-empty-text-signature').toString('base64');
const captured = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  assert(String(url).startsWith(provider.baseURL), 'Unexpected outbound URL in offline test');
  const body = JSON.parse(options.body);
  captured.push(body);
  const parts = captured.length === 1
    ? [{ text: '', thoughtSignature: emptySignature }, { functionCall: { name: 'lookup_weather', args: { city: 'Paris' } }, thoughtSignature: signature }]
    : [{ text: 'Paris: sunny.' }];
  const reply = { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, totalTokenCount: 25 }, modelVersion: provider.models[0].id };
  return new Response(`data: ${JSON.stringify(reply)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
try {
  const options = { provider: 'google-ai-studio', model: provider.models[0].id, reasoningEffort: 'medium', maxTokens: 256,
    tools: [{ name: 'lookup_weather', description: 'Read the weather.', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Use lookup_weather for Paris.' }], source: { kind: 'user' } }] };
  async function collect(input) {
    const assembler = new llm.BlockAssembler();
    let replayState;
    for await (const chunk of adapter.stream(input)) {
      assembler.push(chunk);
      if (chunk.type === 'finish') replayState = chunk.replayState;
    }
    return { content: assembler.blocks(), replayState };
  }
  const first = await collect(options);
  const call = first.content.find((block) => block.type === 'tool-call');
  assert(call, 'Native tool call was not decoded');
  assert(first.replayState.blocks.some((block) => block.thoughtSignature === signature), 'Tool signature not persisted');
  assert(first.replayState.blocks.some((block) => block.textSignature === emptySignature), 'Empty signed text was lost');
  const assistant = { role: 'assistant', content: first.content,
    source: { kind: 'model', provider: options.provider, model: options.model, replayState: first.replayState } };
  const durable = JSON.parse(JSON.stringify(assistant));
  const second = await collect({ ...options, messages: [...options.messages, durable,
    { role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: 'sunny' }], isError: false, source: { kind: 'tool', callId: call.id } }] });
  const signedParts = captured[1].contents.find((item) => item.role === 'model').parts;
  assert.equal(signedParts.find((part) => part.functionCall)?.thoughtSignature, signature, 'Tool signature not replayed');
  assert.equal(signedParts.find((part) => part.text === '')?.thoughtSignature, emptySignature, 'Empty text signature not replayed');
  assert.equal(captured[0].generationConfig.thinkingConfig.thinkingLevel, 'MEDIUM');
  assert(!Object.hasOwn(captured[0], 'store'));
  assert(second.content.some((block) => block.text?.includes('sunny')), 'Continuation failed');
  console.log(JSON.stringify({ offlineRoundtrip: 'passed', nativeProtocol: true, toolSignaturePersistedAndReplayed: true, emptyTextSignaturePreserved: true, existingArgonUnchanged: true }));
} finally {
  globalThis.fetch = originalFetch;
}

const lines = profileText.split('\n');
const start = lines.findIndex((line) => /^      google-ai-studio:\s*\r?$/.test(line));
assert(start >= 0);
let end = start + 1;
while (end < lines.length && !/^      [^\s#][^:]*:/.test(lines[end]) && !/^(?:\S| {1,5}\S)/.test(lines[end])) end++;
const block = yaml.dump({ 'google-ai-studio': provider }, { lineWidth: -1, noRefs: true }).trimEnd().split('\n').map((line) => `      ${line}`).join('\n') + '\n';
const updatedProfile = lines.slice(0, start).join('\n') + '\n' + block + lines.slice(end).join('\n');
const expected = structuredClone(profile);
expected.find((item) => item.id === 'llm-pi-ai').config.providers['google-ai-studio'] = provider;
assert.deepEqual(yaml.load(updatedProfile), expected, 'Unexpected profile changes');
console.log(JSON.stringify({ mode: process.argv.includes('--apply') ? 'apply' : 'preview', runtimeFile, profileFile,
  runtimeChanges: patched !== source, api: provider.api, baseURL: provider.baseURL, reasoning: provider.reasoning }));

if (process.argv.includes('--apply')) {
  assert.equal(fs.readFileSync(runtimeFile, 'utf8'), source, 'Runtime changed during validation');
  assert.equal(fs.readFileSync(profileFile, 'utf8'), profileText, 'Profile changed during validation');
  const suffix = `.bak-google-native-${Date.now()}`;
  fs.copyFileSync(runtimeFile, runtimeFile + suffix, fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(profileFile, profileFile + suffix, fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(runtimeFile, patched, 'utf8');
  try {
    fs.writeFileSync(profileFile, updatedProfile, 'utf8');
  } catch (error) {
    fs.writeFileSync(runtimeFile, source, 'utf8');
    throw error;
  }
  assert.equal(fs.readFileSync(runtimeFile, 'utf8'), patched);
  assert.equal(fs.readFileSync(profileFile, 'utf8'), updatedProfile);
  console.log(JSON.stringify({ saved: true, backupSuffix: suffix }));
}
