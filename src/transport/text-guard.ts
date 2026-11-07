/**
 * 出站文本的最小体检。
 *
 * 模型发完图/表情后想「就此打住」，但又不肯真的输出空串，常补一个 `.` 或 `…` 当占位，
 * QQ 里就多出一个光秃秃的标点气泡。emoji 属于符号不算标点，单独的 emoji 仍照发。
 */
export function isBlankReply(text: string): boolean {
  return /^[\s\p{P}]*$/u.test(text);
}

/** 超过这个长度就算正经段落，句号留着 */
const CASUAL_MAX_CHARS = 80;

/**
 * 群聊短句去掉句末的「。」。
 *
 * 人设写了「聊天里不太打句号」，近三天 813 条群聊回复里仍有 55% 以句号结尾，提示词管不住；
 * 判定条件都是确定的，放在出站这一层兜底。多行、带代码或链接的回复是在讲正事，不动。
 */
export function dropTrailingPeriod(text: string): string {
  const body = text.trim();
  if (body.length === 0 || body.length >= CASUAL_MAX_CHARS || body.includes('\n')) return text;
  if (/`|https?:\/\//i.test(body)) return text;
  const trimmed = body.replace(/。+$/u, '');
  return trimmed.length === 0 ? text : trimmed;
}
