/** Drafts are owner-private and never enter NotesStore. */
import { createHash, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LearnScope { scope: string; peerId: string; sessionId: string }
interface LearnDraft {
  id: string;
  kind: 'preference' | 'verified-check';
  summary: string;
  evidence: { sessionId: string; messageId?: string; agentMessageId?: string; toolCallIds?: string[] };
  createdAt: string;
}
type DraftInput = Omit<LearnDraft, 'id' | 'createdAt'>;
interface StagedInput { sessionId: string; messageId: string; agentMessageId: string; review: boolean; preference: boolean }
interface LearnTurn {
  number: number;
  user?: StagedInput;
  preferences: StagedInput[];
  revision: number;
  lastEdit?: string;
  failed: Map<string, { callId: string; revision: number; total: number }>;
  verified?: DraftInput;
}
interface LearnEvent { type: string; data: Record<string, unknown> }
interface LearnExec { name: string; callId: string; arguments: unknown }
interface LearnResult { isError: boolean; value?: unknown }

const MAX_PENDING = 24;
const SAFE_REF = /^[\p{L}\p{N}_.:@/+=-]{1,200}$/u;
const UNSUITABLE = /[\x00-\x1f<>\x60「」『』“”"]|https?:\/\/|[\\/]|\b(?:bearer|cookie|password|api[_ -]?key|token|secret)\b|密码|密钥|凭证|验证码|住址|身份证|手机号|\d{8}|[A-Za-z0-9_=-]{24}/iu;

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Return a candidate for review. Only the message pointer is persisted. */
export function preferenceExcerpt(raw: string): string | undefined {
  const durable = /我(?:个人)?(?:更|比较|不太|不)?(?:喜欢|习惯|偏好|倾向|看重)|(?:请)?记住|别再|不要再|遇到.{1,35}就|凡是.{1,35}(?:都|先)|比.{1,18}更(?:重要|值得|优先)/u;
  const recurring = /(?:从今以后|今后|以后|往后|下次|每次|平时|通常|默认|一律|习惯上)/u;
  const practice = /用|按|照|做|都|只|别|不要|先|保持|优先|直接|发|给|写|看|说|提醒|记|叫|回复|回答|检查|简短|中文|英文|列表|纯文本/u;
  const correction = /(?:回复|回答|总结|汇报|解释|给我.{0,8}(?:方案|建议)).{0,12}(?:尽量|优先|简短点|简洁点|直接说|先说|先给)|我(?:希望|更想要)你.{0,18}(?:先|少|多|直接|尽量|优先)|(?:别|不要)(?:总是|老是|每次|给我发长篇)|(?:先给|先说|直接给|直接说)(?:我)?(?:结论|重点|结果).{0,6}(?:就好|就行|即可)/u;
  // Quoted examples, fenced code and forwarded material may span sentences.
  if (/转发|引用如下|举例|比如|```|(?:^|\n)\s*>/u.test(raw)) return undefined;
  const clauses = raw.replace(/[，,；;]\s*(?=以后|今后|往后|下次|我(?:更|喜欢|习惯|偏好))/gu, '\n');
  for (const match of clauses.matchAll(/[^。！？!?\r\n]+[。！？!?]?/gu)) {
    const sentence = match[0].trim();
    const cues = sentence.replace(/`[^`]*`|“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"/gu, '…');
    if (sentence.length < 4 || sentence.length > 420 || UNSUITABLE.test(sentence.replace(/[`「」『』“”"]/gu, ' '))
        || /[`「」『』“”"?？]|(?:吗|么)[。！!]?\s*$|假设|要不要|是不是|这次|仅本次|临时|今天先|他说|她说/u.test(cues)) continue;
    if (durable.test(cues) || correction.test(cues) || (recurring.test(cues) && practice.test(cues))) return sentence;
  }
  return undefined;
}

export function isLearnRequest(text: string): boolean {
  return /^\/learn(?:\s|$)/iu.test(text.trim());
}

function checkRun(exec: LearnExec, result: LearnResult): { key: string; target: string; failed: number; passed: number } | undefined {
  if (exec.name !== 'pwsh' && exec.name !== 'bash') return undefined;
  const cmd = object(exec.arguments)?.command;
  // Narrow initial adapter: exact test file(s), not arbitrary shell programs or exit codes.
  if (typeof cmd !== 'string' || /[\r\n]/u.test(cmd) || cmd.length > 240) return undefined;
  const run = /^\s*(?:npx\s+vitest|pnpm\s+(?:exec\s+)?vitest|vitest)\s+run\s+((?:[\w./-]+\.test\.[cm]?[jt]sx?\s*)+)(?:--pool[= ]threads\s*)?$/u.exec(cmd);
  if (!run) return undefined;
  const target = run[1]!.trim().split(/\s+/u).join(' ');
  if (target.length > 180 || /(?:\.\.\/|(?:^| )\/)/u.test(target)) return undefined;
  const value = object(result.value);
  const out = object(value?.stdout);
  if (value?.kind !== 'foreground' || value.aborted !== false || value.timedOut !== false || value.signal !== null || value.stopped !== undefined
      || typeof value.cwd !== 'string' || object(value.sandbox)?.denied === true || typeof out?.text !== 'string' || out.truncated !== false) return undefined;
  const text = out.text.replace(/\x1b\[[\d;]*m/gu, '');
  const matches = [...text.matchAll(/^\s*Tests\s+([^\r\n]+?)\s*\((\d+)\)\s*$/gmu)];
  if (matches.length !== 1) return undefined;
  const stats = matches[0]![1]!.trim();
  if (!/^(?:\d+ failed(?: \| \d+ passed)?|\d+ passed)$/u.test(stats)) return undefined;
  const failed = Number(/(\d+) failed/u.exec(stats)?.[1] ?? 0);
  const passed = Number(/(\d+) passed/u.exec(stats)?.[1] ?? 0);
  if (passed + failed !== Number(matches[0]![2]) || passed + failed < 1 || value.exitCode !== (failed > 0 ? 1 : 0)) return undefined;
  return { key: digest([exec.name, cmd.trim().replace(/\s+/gu, ' '), value.cwd]), target, failed, passed };
}

export class LearnInbox {
  private readonly staged = new Map<string, StagedInput>();
  private readonly turns = new Map<string, LearnTurn>();

  constructor(private readonly root: string, private readonly appId: string,
    private readonly getOwner: () => string | undefined, private readonly warn: () => void = () => {}) {}

  allows(chat: LearnScope): boolean {
    const owner = this.getOwner()?.trim();
    return chat.scope === 'c2c' && !!owner && chat.peerId === owner;
  }

  stage(chat: LearnScope, agentId: string, qqMessageId: string, directText: string): void {
    if (!this.allows(chat) || !SAFE_REF.test(agentId) || !SAFE_REF.test(qqMessageId)) return;
    this.staged.set(agentId, {
      sessionId: chat.sessionId, messageId: qqMessageId, agentMessageId: agentId, review: isLearnRequest(directText),
      preference: preferenceExcerpt(directText) !== undefined,
    });
    while (this.staged.size > MAX_PENDING) this.staged.delete(this.staged.keys().next().value!);
  }

  unstage(agentId: string): void { this.staged.delete(agentId); }

  forget(sessionId: string): void {
    this.turns.delete(sessionId);
    for (const [key, staged] of this.staged) if (staged.sessionId === sessionId) this.staged.delete(key);
  }

  observe(chat: LearnScope, event: LearnEvent): void {
    if (!this.allows(chat)) return;
    if (event.type === 'turn/start' && typeof event.data.turn === 'number') {
      this.turns.set(chat.sessionId, { number: event.data.turn, preferences: [], revision: 0, failed: new Map() });
      return;
    }
    const turn = this.turns.get(chat.sessionId);
    if (!turn) return;
    if (event.type === 'user/message' && object(event.data.source)?.kind === 'user' && typeof event.data.id === 'string') {
      const selected = this.staged.get(event.data.id);
      // A fresh, unstaged human message must not inherit the previous request's access.
      if (turn.user?.review) turn.user = undefined;
      if (selected?.sessionId === chat.sessionId) {
        turn.user = selected;
        if (selected.preference && !selected.review) turn.preferences.push(selected);
        this.staged.delete(event.data.id);
      }
    }
    if (event.type !== 'turn/end' || event.data.turn !== turn.number) return;
    this.turns.delete(chat.sessionId);
    if (object(event.data.reason)?.kind !== 'completed') return;
    const drafts: DraftInput[] = turn.preferences.map(input => ({
      kind: 'preference', summary: '可能适用于后续的偏好或纠正，请核对原消息及范围。',
      evidence: { sessionId: chat.sessionId, messageId: input.messageId, agentMessageId: input.agentMessageId },
    }));
    if (turn.user && !turn.user.review && turn.verified) drafts.push(turn.verified);
    for (const draft of drafts) {
      try { this.save(chat, draft); } catch { this.warn(); }
    }
  }

  observeTool(chat: LearnScope, exec: LearnExec, result: LearnResult): void {
    if (!this.allows(chat) || result.isError !== false || !SAFE_REF.test(exec.callId)) return;
    const turn = this.turns.get(chat.sessionId);
    if (!turn?.user || turn.user.review) return;
    const value = object(result.value);
    const patched = exec.name === 'apply_patch' && value?.cancelled === false && Array.isArray(value.operations)
      && value.operations.length > 0 && value.operations.every(op => object(op)?.status === 'completed');
    const edited = (exec.name === 'edit' || exec.name === 'write') && typeof value?.path === 'string'
      && typeof value.after === 'string' && value.before !== value.after;
    if (patched || edited) {
      turn.revision++;
      turn.lastEdit = exec.callId;
      turn.verified = undefined; // A later edit invalidates earlier verification.
      return;
    }
    const check = checkRun(exec, result);
    if (!check) return;
    const previous = turn.failed.get(check.key);
    if (check.failed > 0) {
      turn.verified = undefined;
      if (turn.failed.size < MAX_PENDING || previous) {
        turn.failed.set(check.key, { callId: exec.callId, revision: turn.revision, total: check.failed + check.passed });
      }
    } else if (previous && previous.total === check.passed && previous.revision < turn.revision && turn.lastEdit && previous.callId !== exec.callId) {
      turn.verified = {
        kind: 'verified-check',
        summary: 'Vitest：同一检查 ' + check.target + ' 曾失败，改动后复验 ' + check.passed + ' 项通过；修正做法和适用范围需回看证据。',
        evidence: { sessionId: chat.sessionId, toolCallIds: [previous.callId, turn.lastEdit, exec.callId] },
      };
    }
  }

  canReview(chat: LearnScope): boolean {
    return this.allows(chat) && this.turns.get(chat.sessionId)?.user?.review === true;
  }

  private dir(owner: string): string { return join(this.root, digest([this.appId, owner])); }

  private save(chat: LearnScope, input: DraftInput): void {
    if (!SAFE_REF.test(chat.sessionId)) return;
    const id = digest([input.kind, input.evidence.messageId ?? input.evidence]);
    const dir = this.dir(chat.peerId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = join(dir, '.' + randomUUID() + '.tmp');
    const target = join(dir, id + '.json');
    const draft: LearnDraft = { id, ...input, createdAt: new Date().toISOString() };
    const payload = JSON.stringify(draft);
    try {
      writeFileSync(temp, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      try {
        linkSync(temp, target); // Atomic publish; replay cannot overwrite a draft.
      } catch (linkErr) {
        const code = object(linkErr)?.code;
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'EXDEV') {
          writeFileSync(target, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        } else {
          throw linkErr;
        }
      }
    } catch (err) {
      if (object(err)?.code !== 'EEXIST') throw err;
    } finally {
      try { unlinkSync(temp); } catch { /* no temp file */ }
    }
  }

  list(chat: LearnScope | undefined, limit = 8, hostRequest = false): LearnDraft[] {
    const owner = this.getOwner()?.trim();
    if (!owner || (chat && !this.allows(chat)) || (!hostRequest && !(chat && this.canReview(chat)))) {
      throw new Error('请在主人私聊或本地主人会话显式发起 /learn 后读取经验草稿。');
    }
    const dir = this.dir(owner);
    let files: string[];
    try { files = readdirSync(dir); } catch (err) { if (object(err)?.code === 'ENOENT') return []; throw err; }
    const found: LearnDraft[] = [];
    for (const file of files) {
      if (!/^[a-f0-9]{64}\.json$/u.test(file)) continue;
      let raw: string;
      try { raw = readFileSync(join(dir, file), 'utf8'); } catch (err) { if (object(err)?.code === 'ENOENT') continue; throw err; }
      if (raw.length > 4096) continue;
      let candidate: Partial<LearnDraft>;
      try { candidate = JSON.parse(raw) as Partial<LearnDraft>; } catch { continue; }
      if (!candidate || candidate.id !== file.slice(0, -5) || typeof candidate.summary !== 'string' || typeof candidate.createdAt !== 'string' || !candidate.evidence) continue;
      found.push(candidate as LearnDraft);
    }
    return found.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
      .slice(0, Number.isSafeInteger(limit) ? Math.max(1, Math.min(12, limit)) : 8);
  }
}
