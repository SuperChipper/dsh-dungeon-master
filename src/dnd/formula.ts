/**
 * 安全确定性公式求值器（禁用 eval / Function）。
 *
 * 供扩展规则引擎（dnd_rule）和内置被动/光环/治疗钩子统一求值，支持：
 * - 四则运算：+ - * / 与括号 ()、正负号
 * - 内置函数：min(a, b, ...)、max(a, b, ...)、floor(x)、ceil(x)、abs(x)
 * - 角色上下文变量：level, prof, slot_level, str_mod..cha_mod, str..cha, hp, max_hp
 */
import { abilityModifier, proficiencyBonus, type Ability } from './rules.ts';

export interface FormulaContext {
  level: number;
  prof: number;
  slot_level: number;
  str_mod: number;
  dex_mod: number;
  con_mod: number;
  int_mod: number;
  wis_mod: number;
  cha_mod: number;
  str: number;
  dex: number;
  con: number;
  int: number;
  wis: number;
  cha: number;
  hp: number;
  max_hp: number;
}

export function buildFormulaContext(
  ch: { level: number; hp: number; maxHp: number; abilities: Record<Ability, number> },
  extra: { slotLevel?: number } = {},
): FormulaContext {
  return {
    level: ch.level,
    prof: proficiencyBonus(ch.level),
    slot_level: extra.slotLevel ?? 1,
    str_mod: abilityModifier(ch.abilities.str),
    dex_mod: abilityModifier(ch.abilities.dex),
    con_mod: abilityModifier(ch.abilities.con),
    int_mod: abilityModifier(ch.abilities.int),
    wis_mod: abilityModifier(ch.abilities.wis),
    cha_mod: abilityModifier(ch.abilities.cha),
    str: ch.abilities.str,
    dex: ch.abilities.dex,
    con: ch.abilities.con,
    int: ch.abilities.int,
    wis: ch.abilities.wis,
    cha: ch.abilities.cha,
    hp: ch.hp,
    max_hp: ch.maxHp,
  };
}

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'id'; name: string }
  | { kind: 'op'; op: '+' | '-' | '*' | '/' }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'comma' };

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '(') { tokens.push({ kind: 'lparen' }); i++; continue; }
    if (c === ')') { tokens.push({ kind: 'rparen' }); i++; continue; }
    if (c === ',') { tokens.push({ kind: 'comma' }); i++; continue; }
    if (c === '+' || c === '-' || c === '*' || c === '/') {
      tokens.push({ kind: 'op', op: c });
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let raw = '';
      let dots = 0;
      while (i < expr.length && /[0-9.]/.test(expr[i]!)) {
        if (expr[i] === '.') dots++;
        raw += expr[i]!;
        i++;
      }
      const value = Number(raw);
      if (dots > 1 || !Number.isFinite(value)) throw new Error(`非法数字「${raw}」`);
      tokens.push({ kind: 'num', value });
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let name = '';
      while (i < expr.length && /[a-zA-Z0-9_]/.test(expr[i]!)) {
        name += expr[i]!;
        i++;
      }
      tokens.push({ kind: 'id', name: name.toLowerCase() });
      continue;
    }
    throw new Error(`公式「${expr}」含不支持的字符「${c}」`);
  }
  return tokens;
}

const FUNCTIONS = new Set(['min', 'max', 'floor', 'ceil', 'abs']);

export function evalFormula(expr: string, ctx: FormulaContext): number {
  const trimmed = expr.trim();
  if (trimmed.length === 0) throw new Error('公式不能为空');
  const tokens = tokenize(trimmed);
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  const consume = (): Token => {
    const t = tokens[pos];
    if (t === undefined) throw new Error(`公式「${expr}」意外结束`);
    pos++;
    return t;
  };

  function parseExpr(): number {
    let val = parseTerm();
    while (true) {
      const next = peek();
      if (next?.kind === 'op' && (next.op === '+' || next.op === '-')) {
        consume();
        const rhs = parseTerm();
        val = next.op === '+' ? val + rhs : val - rhs;
      } else {
        break;
      }
    }
    return val;
  }

  function parseTerm(): number {
    let val = parseUnary();
    while (true) {
      const next = peek();
      if (next?.kind === 'op' && (next.op === '*' || next.op === '/')) {
        consume();
        const rhs = parseUnary();
        if (next.op === '/') {
          if (rhs === 0) throw new Error(`公式「${expr}」除以 0`);
          val = val / rhs;
        } else {
          val = val * rhs;
        }
      } else {
        break;
      }
    }
    return val;
  }

  function parseUnary(): number {
    const next = peek();
    if (next?.kind === 'op' && (next.op === '+' || next.op === '-')) {
      consume();
      const v = parseUnary();
      return next.op === '-' ? -v : v;
    }
    return parsePrimary();
  }

  function parsePrimary(): number {
    const t = consume();
    if (t.kind === 'num') return t.value;
    if (t.kind === 'lparen') {
      const inner = parseExpr();
      const close = consume();
      if (close.kind !== 'rparen') throw new Error(`公式「${expr}」缺少右括号`);
      return inner;
    }
    if (t.kind === 'id') {
      if (peek()?.kind === 'lparen') {
        if (!FUNCTIONS.has(t.name)) {
          throw new Error(`未知函数「${t.name}」；可用函数：min, max, floor, ceil, abs`);
        }
        consume(); // '('
        const args: number[] = [];
        if (peek()?.kind !== 'rparen') {
          args.push(parseExpr());
          while (peek()?.kind === 'comma') {
            consume();
            args.push(parseExpr());
          }
        }
        const close = consume();
        if (close.kind !== 'rparen') throw new Error(`函数「${t.name}」缺少右括号`);
        if (args.length === 0) throw new Error(`函数「${t.name}」至少需要 1 个参数`);
        if ((t.name === 'floor' || t.name === 'ceil' || t.name === 'abs') && args.length !== 1) {
          throw new Error(`函数「${t.name}」只接受 1 个参数`);
        }
        if (t.name === 'min') return Math.min(...args);
        if (t.name === 'max') return Math.max(...args);
        if (t.name === 'floor') return Math.floor(args[0]!);
        if (t.name === 'ceil') return Math.ceil(args[0]!);
        return Math.abs(args[0]!);
      }
      if (!(t.name in ctx)) {
        throw new Error(`未知变量「${t.name}」；可用变量：${Object.keys(ctx).join(', ')}`);
      }
      return ctx[t.name as keyof FormulaContext];
    }
    throw new Error(`公式「${expr}」语法错误`);
  }

  const result = parseExpr();
  if (pos < tokens.length) throw new Error(`公式「${expr}」尾部有多余内容`);
  if (!Number.isFinite(result)) throw new Error(`公式「${expr}」计算结果无效`);
  return result;
}

export function evalIntFormula(expr: string | number, ctx: FormulaContext): number {
  if (typeof expr === 'number') return Math.trunc(expr);
  return Math.trunc(evalFormula(expr, ctx));
}

export function validateFormula(expr: string): void {
  evalFormula(expr, {
    level: 6, prof: 3, slot_level: 3,
    str_mod: 3, dex_mod: 2, con_mod: 2, int_mod: 0, wis_mod: 4, cha_mod: 3,
    str: 16, dex: 14, con: 14, int: 10, wis: 18, cha: 16,
    hp: 30, max_hp: 50,
  });
}
