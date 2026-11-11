/**
 * 兜底解析模型误写成文本的工具调用。
 *
 * 模型偶尔会把 `qqbot_save_sticker` 写成：
 *   <qqbot_save_sticker>
 *   <image>...</image>
 *   <emotion>...</emotion>
 *   </qqbot_save_sticker>
 * 这不是工具调用，会被当普通文字发出去。这里负责：
 *   - 从出站文本中剥离完整/未完成的标签块，避免用户看到 XML；
 *   - 解析成可执行的收藏参数，供调用方补执行。
 */

export interface PseudoStickerCall {
  image: string;
  emotion: string;
  note?: string;
  file?: string;
}

export interface PseudoStickerExtraction {
  /** 去掉伪调用块后的可见文本 */
  visible: string;
  /** 解析出的收藏调用（可能为空） */
  calls: PseudoStickerCall[];
}

const OPEN_TAG = '<qqbot_save_sticker';
const COMPLETE_BLOCK = /<qqbot_save_sticker([^>]*)>([\s\S]*?)<\/qqbot_save_sticker>/gi;

function readBodyTag(body: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(body);
  const value = match?.[1]?.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
}

function readAttr(attrs: string, name: string): string | undefined {
  const match = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(attrs);
  const value = match?.[1]?.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
}

function parseCall(attrs: string, body: string): PseudoStickerCall | undefined {
  const image = readBodyTag(body, 'image') ?? readAttr(attrs, 'image');
  const emotion = readBodyTag(body, 'emotion') ?? readAttr(attrs, 'emotion');
  if (image === undefined || emotion === undefined) return undefined;
  const note = readBodyTag(body, 'note') ?? readAttr(attrs, 'note');
  const file = readBodyTag(body, 'file') ?? readAttr(attrs, 'file');
  return {
    image,
    emotion,
    ...(note !== undefined ? { note } : {}),
    ...(file !== undefined ? { file } : {}),
  };
}

/** 去掉末尾处于「可能正在流式输出开标签」的半截前缀 */
function stripTrailingPartialOpen(text: string, openTag: string): string {
  const lower = text.toLowerCase();
  for (let length = Math.min(openTag.length, lower.length); length >= 8; length -= 1) {
    if (lower.endsWith(openTag.slice(0, length))) {
      return text.slice(0, text.length - length);
    }
  }
  return text;
}

/** 剥离指定工具的伪调用块（完整/未闭合/流式半截），不执行 */
function stripPseudoBlock(text: string, tag: string): string {
  const openTag = `<${tag}`;
  let visible = text.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), '');
  const lastOpen = visible.toLowerCase().lastIndexOf(openTag);
  if (lastOpen >= 0) visible = visible.slice(0, lastOpen);
  visible = stripTrailingPartialOpen(visible, openTag);
  return visible.replace(/\n{3,}/g, '\n\n').trimEnd();
}

/**
 * 解析并剥离伪调用。
 *
 * 流式场景下会被反复调用：完整块移除、未闭合块从开标签到结尾移除、
 * 末尾半截开标签也先扣住，保证用户看不到 XML 碎片。
 */
export function extractPseudoStickerCalls(text: string): PseudoStickerExtraction {
  const calls: PseudoStickerCall[] = [];
  let visible = text.replace(COMPLETE_BLOCK, (_whole, attrs: string, body: string) => {
    const call = parseCall(attrs, body);
    if (call !== undefined) calls.push(call);
    return '';
  });

  // 未闭合块（流式中途）：从最后一个开标签一直扣到结尾
  const lastOpen = visible.toLowerCase().lastIndexOf(OPEN_TAG);
  if (lastOpen >= 0) {
    visible = visible.slice(0, lastOpen);
  }

  visible = stripTrailingPartialOpen(visible, OPEN_TAG);
  // 移除块后可能留下多余空行，但不破坏正常段落
  visible = visible.replace(/\n{3,}/g, '\n\n').trimEnd();
  return { visible, calls };
}

/** 只取可见文本，不执行调用（流式 update 用） */
export function sanitizePseudoStickerText(text: string): string {
  return extractPseudoStickerCalls(text).visible;
}

/** 剥离 qqbot_send_file 的伪调用文本（图片/文件可能已由真实工具发出，不重复执行） */
export function stripPseudoSendFileText(text: string): string {
  return stripPseudoBlock(text, 'qqbot_send_file');
}

/**
 * 剥离上游网关（如 Gemini OpenAI 兼容层）未拆进 reasoning_content、
 * 而是以 `💭` 前缀直接混进 content 流里的思考链与模型英文草稿纠错。
 */
export function stripLeakedThoughtPrefix(text: string): string {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('💭')) return text;

  let rest = trimmed.slice('💭'.length).trimStart();

  // 模型自己打的重写标记：标记前是草稿，最后一个标记后才是定稿。
  // 以前要求标记后跟「英文句号 + 中文」才算结束，定稿里没有 `.!?` 时一路吃到结尾，整条回复被吞（4148–4154 连吞六条）。
  let lastMark = -1;
  for (const m of rest.matchAll(REWRITE_MARK)) lastMark = m.index + m[0].length;
  if (lastMark >= 0) rest = rest.slice(lastMark).trimStart();

  // 网关在正文前吐了英文思考草稿（`💭 Let's ...`、`💭 Chaos sent ...`、`💭Wait: ...`）：
  // 只有以「至少两个连续英文词（或 `Wait:` / `OK,`）」起手才视为英文 CoT，
  // 避免把中文回复开头的专有名词缩写（如 `DMG（城主指南）`、`AC 19`、`5e 规则`）误判成英文思考链整段吞掉。
  if (ENGLISH_LEAD.test(rest)) {
    const start = replyStart(rest);
    // 找不到正文起点：整段都是思考（调工具前的盘算），一个字也不发
    return start === undefined ? '' : rest.slice(start).trimStart();
  }

  return rest;
}

/** 重写标记 `$]$/$`（反引号里的是在讲这个符号，不算），以及写成英文的「推翻重来」 */
// 模型写的标记会变形：先是 `$]$/$`，后来又出现 `]]/$`。认「两到四个 $ 或 ]（至少一个 ]）再接 /$」这一族
const REWRITE_MARK = /(?<!`)(?=[\]$]*\])[\]$]{2,4}\/\$(?!`)|\bWait no,\s*(?:remove any stray characters\.|clean!)/gi;

const ENGLISH_LEAD = /^(?:[A-Za-z']+\s+[A-Za-z'`"]+|(?:Wait|Okay|OK|Hmm)[:.,!])/i;

/** 句末或换行之后紧跟中文（或中文标点、markdown 起手）的位置，是正文可能开始的地方 */
const REPLY_BOUNDARY = /(?:[.!?:;。！？…)\]]|\n)[ \t]*(?=[一-鿿　-〿！-～「【《*#>])/g;

/**
 * 思考句：在行首或英文句末之后起头、六个以上连着的英文词。
 * 中文回复里夹的专名、术语（Curse of Strahd、AC 19）到不了这个长度；引用的英文原文跟在中文后面，不在句首。
 */
const ENGLISH_SENTENCE = /(?:^|\n|[.!?]\s+)[ \t]*[A-Za-z][A-Za-z']*(?:[ ,]+[A-Za-z][A-Za-z']*){5,}/;

/**
 * 英文思考后面的中文正文从哪开始：第一个「后面再没有英文思考句」的边界。
 * 思考里也会引用中文（U3: `其实应该…`），不能见到中文就切；以前取「最后一个英文句末」，
 * 正文里只要夹一句英文就从那里截断，找不到英文句末时整条吞掉。
 */
function replyStart(text: string): number | undefined {
  for (const m of text.matchAll(REPLY_BOUNDARY)) {
    const at = m.index + m[0].length;
    const remainder = text.slice(at).replace(/`[^`\n]*`/g, '');
    if (!ENGLISH_SENTENCE.test(remainder)) return at;
  }
  return undefined;
}

/** 仅拦截正文中的伪工具块，不将任意文本升级成可执行调用。代码示例保持原样。 */
export function stripBracketToolCalls(text: string): string {
  return extractBracketToolCalls(text).visible;
}

/**
 * 伪工具块：`[::dnd_move::]{…}[::/dnd_move::]`，也有带前缀和空格的写法
 * `[::call:default_api:dnd_move::]`、`[:: call:default_api:web_search ::]`。
 * 后两种以前认不出来，整段 JSON 参数（连笔记全文）直接发进了群。
 */
const BRACKET_TOKEN = /(`{3,}|~{3,}|`+)|\[::\s*(\/?)\s*((?:call\s*:\s*)?(?:default_api\s*:\s*)?[a-zA-Z_][\w.-]*)\s*::\]/g;
const BRACKET_CLOSE = /^\[::\s*\/[^\]\n]{0,80}::\]/;
/** 流式到一半、还没写完的标记：`[`、`[:`、`[::/dnd_mo` */
const PARTIAL_BRACKET = /\[(?::(?::[^\]\n]{0,80})?)?$/;

function toolNameOf(raw: string): string {
  return raw.replace(/^call\s*:\s*/i, '').replace(/^default_api\s*:\s*/i, '');
}

/** 剥离伪工具块，并报出是哪些工具被写成了文字（它们没有执行，调用方要让模型知道） */
export function extractBracketToolCalls(text: string): { visible: string; names: string[] } {
  const token = new RegExp(BRACKET_TOKEN.source, 'g');
  const names: string[] = [];
  let fence = '';
  let inline = '';
  let cursor = 0;
  let visible = '';
  let match: RegExpExecArray | null;
  while ((match = token.exec(text)) !== null) {
    if (match[1]) {
      const ticks = match[1];
      if (fence) {
        if (ticks[0] === fence[0] && ticks.length >= fence.length) fence = '';
      } else if (inline) {
        if (ticks === inline) inline = '';
      } else if (ticks.length >= 3) fence = ticks;
      else if (ticks[0] === '`') inline = ticks;
      continue;
    }
    if (fence || inline) continue;
    const start = match.index;
    if (match[2] === '/') {
      visible += text.slice(cursor, start);
      cursor = token.lastIndex;
      continue;
    }
    let at = token.lastIndex;
    while (/\s/.test(text[at] ?? '') && at < text.length) at++;
    // 普通行文里提到标记而没有 JSON，不当成工具执行块。
    if (at < text.length && text[at] !== '{' && text[at] !== '[') continue;
    visible += text.slice(cursor, start);
    names.push(toolNameOf(match[3] ?? ''));
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let end = text.length;
    for (let i = at; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') quoted = false;
      } else if (ch === '"') quoted = true;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) {
          const tail = text.slice(i + 1);
          const leading = tail.length - tail.trimStart().length;
          const rest = tail.slice(leading);
          const close = BRACKET_CLOSE.exec(rest);
          if (close !== null) end = i + 1 + leading + close[0].length;
          // 没写闭合标记、后面直接接正文：正文照发。只有后面还是空的或半截标记（流式中）才先扣住
          else if (rest !== '' && !PARTIAL_BRACKET.test(rest)) end = i + 1;
          break;
        }
      }
    }
    cursor = end;
    token.lastIndex = end;
  }
  let tail = text.slice(cursor);
  if (!fence && !inline) tail = tail.replace(PARTIAL_BRACKET, '');
  return { visible: (visible + tail).replace(/\n{3,}/g, '\n\n').trimEnd(), names };
}

/** 统一清洗：泄露思考链剥离 + 贴纸伪调用剥离 + send_file 伪调用剥离 */
export function sanitizePseudoToolText(text: string): string {
  return stripPseudoSendFileText(sanitizePseudoStickerText(stripBracketToolCalls(stripLeakedThoughtPrefix(text))));
}
