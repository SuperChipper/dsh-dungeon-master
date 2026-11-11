import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

// Keep GPT-6 tool calls on Responses while preserving the rest of the user's profile.
const profileFile = path.join(process.env.USERPROFILE, '.dsh/profiles/web/cordis.patch.yml');
const original = fs.readFileSync(profileFile, 'utf8');
const config = yaml.load(original);
const provider = config.find((item) => item.id === 'llm-pi-ai')?.config?.providers?.hapi;
assert(provider, 'HAPI provider is missing');
assert.equal(provider.baseURL, 'https://hapiopen.cc/v1', 'Unexpected HAPI endpoint');
assert(provider.models.some((model) => model.id === 'gpt-6.1-sol'), 'GPT-6.1 Sol is missing');
assert(['openai-completions', 'openai-responses'].includes(provider.api), 'Unexpected HAPI protocol');

const lines = original.split('\n');
const start = lines.findIndex((line) => /^      hapi:\s*\r?$/.test(line));
assert(start >= 0, 'HAPI YAML block is missing');
let end = start + 1;
while (end < lines.length && !/^      [^\s#][^:]*:/.test(lines[end]) && !/^(?:\S| {1,5}\S)/.test(lines[end])) end++;
const indexes = [];
for (let index = start + 1; index < end; index++) if (/^        api:/.test(lines[index])) indexes.push(index);
assert.equal(indexes.length, 1, 'Expected exactly one HAPI api field');
lines[indexes[0]] = lines[indexes[0]].replace(/^(        api: )openai-(?:completions|responses)(\s*)$/, '$1openai-responses$2');
const updated = lines.join('\n');
const expected = structuredClone(config);
expected.find((item) => item.id === 'llm-pi-ai').config.providers.hapi.api = 'openai-responses';
assert.deepEqual(yaml.load(updated), expected, 'Unexpected profile mutation');

console.log(JSON.stringify({ mode: process.argv.includes('--apply') ? 'apply' : 'preview', profileFile, provider: 'hapi',
  previousApi: provider.api, api: 'openai-responses', changed: updated !== original, models: provider.models.map((model) => model.id) }));
if (process.argv.includes('--apply') && updated !== original) {
  assert.equal(fs.readFileSync(profileFile, 'utf8'), original, 'Profile changed during validation');
  const backup = `${profileFile}.bak-hapi-responses-${Date.now()}`;
  fs.copyFileSync(profileFile, backup, fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(profileFile, updated, 'utf8');
  assert.equal(fs.readFileSync(profileFile, 'utf8'), updated);
  console.log(JSON.stringify({ saved: true, backup }));
}
