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
interface StagedInput { sessionId: string; messageId: string; agentMessageId: string; review: boolean; preference?: string }
interface LearnTurn {
  number: number;
  user?: StagedInput;
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

function preference(raw: string): string | undefined {
  const text = raw.trim();
  if (text.length > 256 || UNSUITABLE.test(text) || /[?？]|假设|转发|引用|举例|比如|要不要|是不是/u.test(text)) return undefined;
  const match = /^(?:我(?:觉得|希望|要求)[，, ]*)?(?:从今以后|今后|以后|往后)\s*[，,：:]?\s*(\S.{3,})$/u.exec(text);
  if (!match) return undefined;
  const clause = match[1]!.trim();
  if (/^(?:(?:都|也|就|一律|默认|按这个|按刚才的|按上面|这样|这么|做法|做|来|吧|了|即可|就行)\s*)+[。！!，,]*$/u.test(clause)) {
    return '用户确认后续沿用当时的做法；复盘时核对所指的做法和适用范围。';
  }
  if (!/^.{0,52}?(?:都|默认|一律|统一|先|不要|别|必须|按|用|保持|只|需要)/u.test(clause)) return undefined;
  // Store a pointer, not a copy of the user's private message. /learn resolves it on demand.
  return '用户给出了后续也适用的做法；复盘时以原消息确认具体内容和适用范围。';
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
      sessionId: chat.sessionId, messageId: qqMessageId, agentMessageId: agentId, review: /^\/learn(?:\s|$)/iu.test(directText.trim()),
      preference: preference(directText),
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
      this.turns.set(chat.sessionId, { number: event.data.turn, revision: 0, failed: new Map() });
      return;
    }
    const turn = this.turns.get(chat.sessionId);
    if (!turn) return;
    if (event.type === 'user/message' && object(event.data.source)?.kind === 'user' && typeof event.data.id === 'string') {
      const selected = this.staged.get(event.data.id);
      if (selected?.sessionId === chat.sessionId) {
        turn.user = selected;
        this.staged.delete(event.data.id);
      }
    }
    if (event.type !== 'turn/end' || event.data.turn !== turn.number) return;
    this.turns.delete(chat.sessionId);
    if (!turn.user || turn.user.review || object(event.data.reason)?.kind !== 'completed') return;
    const draft: DraftInput | undefined = turn.user.preference ? {
      kind: 'preference', summary: turn.user.preference,
      evidence: { sessionId: chat.sessionId, messageId: turn.user.messageId, agentMessageId: turn.user.agentMessageId },
    } : turn.verified;
    if (!draft) return;
    try { this.save(chat, draft); } catch { this.warn(); }
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

  private dir(chat: LearnScope): string { return join(this.root, digest([this.appId, chat.peerId])); }

  private save(chat: LearnScope, input: DraftInput): void {
    if (!SAFE_REF.test(chat.sessionId)) return;
    const id = digest([input.kind, input.evidence.messageId ?? input.evidence]);
    const dir = this.dir(chat);
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

  list(chat: LearnScope, limit = 8): LearnDraft[] {
    if (!this.canReview(chat)) throw new Error('只在主人当前私聊直接输入 /learn 后读取经验草稿。');
    const dir = this.dir(chat);
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
