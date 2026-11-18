import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { NotesStore, chatKeyOf, chunkMarkdown, formatNotesHint, planNoteInjection, selectNotesForInjection, tokenize } from './notes-store.ts';
import { looksLikeCampaignNote } from './notes-tools.ts';
import { EmbeddingCache, type Embedder } from './embedding.ts';

const SAMPLE = [
  '# 大肥鱼小课堂 · 课堂笔记',
  '',
  '- 系列：卡布奇诺ultra《大肥鱼小课堂 DSH》',
  '',
  '## 一、逐集笔记',
  '',
  '### 04 这三句话已被人类拉黑',
  '- 新词：鱼八股——一眼就能看出是模板',
  '- 三句固定句式被公开拉黑',
  '',
  '### 08 哈哈哈哈',
  '- 两个哈 = 敷衍；四个以上才是真笑',
  '',
  '### 10 明天开家长会',
  '- 300 条全是好话 = 这孩子很活跃',
].join('\n');

function tempNotes(files: Record<string, string> = { '课堂笔记.md': SAMPLE }): string {
  const root = mkdtempSync(join(tmpdir(), 'notes-'));
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
  return root;
}

const hintOptions = { topK: 2, maxChars: 600, minCoverage: 0.4 };

describe('tokenize', () => {
  it('中文取二字组，英文取小写词，单个数字保留', () => {
    expect(tokenize('鱼八股 DSH 第4集')).toEqual(['鱼八', '八股', 'dsh', '第', '4', '集']);
  });
});

describe('chunkMarkdown', () => {
  it('按 #/##/### 切段，带标题路径', () => {
    const chunks = chunkMarkdown('a.md', SAMPLE);
    expect(chunks.map((c) => c.heading)).toEqual([
      '大肥鱼小课堂 · 课堂笔记',
      '大肥鱼小课堂 · 课堂笔记 › 一、逐集笔记 › 04 这三句话已被人类拉黑',
      '大肥鱼小课堂 · 课堂笔记 › 一、逐集笔记 › 08 哈哈哈哈',
      '大肥鱼小课堂 · 课堂笔记 › 一、逐集笔记 › 10 明天开家长会',
    ]);
  });

  it('没有标题的文件用文件名当标题；标题跳级不出现 undefined', () => {
    expect(chunkMarkdown('dir/随手记.md', '一段话')[0]!.heading).toBe('随手记');
    expect(chunkMarkdown('x.md', '### 小节\n内容')[0]!.heading).toBe('x › x › 小节');
  });
});

describe('NotesStore.search', () => {
  it('按相关度返回段落', () => {
    const store = new NotesStore(tempNotes());
    const [top] = store.search('你还记得鱼八股是什么吗');
    expect(top!.heading).toContain('04 这三句话已被人类拉黑');
    expect(top!.file).toBe('课堂笔记.md');
  });

  it('递归索引子目录，跳过隐藏文件和非 md 文件', () => {
    const root = tempNotes({ 'sub/群.md': '# 群规\n周五晚上开黑', '.hidden.md': '# 开黑', 'x.txt': '开黑' });
    const hits = new NotesStore(root).search('开黑');
    expect(hits.map((h) => h.file)).toEqual(['sub/群.md']);
  });

  it('整段专名字面命中压过二字组分散命中的段', () => {
    const root = tempNotes({
      '修道.md': '# 修道心得\n沉钟声里修道，道院外沉钟又响，钟修好了；修道之人进度慢，进度靠修道。',
      '跑团.md': '# 沉钟修道院\n## 进度\n- 第 300 回合进入地下室',
    });
    const hits = new NotesStore(root).search('沉钟修道院现在什么进度');
    expect(hits[0]!.file).toBe('跑团.md');
    expect(hits[0]!.exact?.matched).toContain('沉钟修道院');
    // BM25 原本把分散命中的「修道心得」排第一
    expect(hits.find((h) => h.file === '修道.md')!.score).toBeGreaterThan(hits[0]!.score);
  });

  it('同样内容复制到两个文件只返回一份', () => {
    const hits = new NotesStore(tempNotes({ 'a.md': '# 开黑\n周五开黑', 'b.md': '# 开黑\n周五开黑' })).search('周五开黑');
    expect(hits.map((h) => h.file)).toEqual(['a.md']);
  });

  it('目录不存在时返回空', () => {
    expect(new NotesStore(join(tmpdir(), 'no-such-notes-dir-xyz')).search('任何')).toEqual([]);
  });

  it('私有笔记要求匹配身份；本机全库访问必须显式授权', () => {
    const root = tempNotes({
      '共享.md': '# 跑团入门\n沉钟修道院是新手模组',
      'chats/group_A/沉钟.md': '# 沉钟修道院\n队伍已升 2 级',
      'chats/group_B/沉钟.md': '# 沉钟修道院\n还没开团',
    });
    const store = new NotesStore(root);
    const files = (key?: string): string[] => store.search('沉钟修道院', 5, key).map((h) => h.file).sort();

    expect(files('group_A')).toEqual(['chats/group_A/沉钟.md', '共享.md']);
    expect(files('group_C')).toEqual(['共享.md']);
    expect(files(undefined)).toEqual(['共享.md']);
    expect(store.search('沉钟修道院', 5, undefined, { trustedLocal: true })).toHaveLength(3);
  });
});

describe('NotesStore.searchHybrid', () => {
  /** 假向量：按「概念词组」命中与否给分量，模拟同义/换说法 */
  const concepts = [['鱼八股', '套路', '模板'], ['家长会', '开会'], ['哈哈', '笑']];
  const conceptEmbedder = (fail = false): Embedder => ({
    model: 'fake',
    async embed(texts) {
      if (fail) throw new Error('offline');
      return texts.map((t) => concepts.map((words) => (words.some((w) => t.includes(w)) ? 1 : 0)));
    },
  });
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  const gate = { minSimilarity: 0.5, minMargin: 0.16 };

  it('关键词一个都没撞上的同义说法，靠语义一路召回并注入', async () => {
    const store = new NotesStore(tempNotes());
    const query = '说话很套路的那个梗';
    expect(store.search(query).some((h) => h.heading.includes('04'))).toBe(false);

    // 语义检索关闭时，覆盖率为 0 的段不注入
    expect(formatNotesHint(store.search(query, 4), hintOptions)).toBe('');

    store.setSemantic(new EmbeddingCache(conceptEmbedder(), 1000), gate);
    await flush();
    const hits = await store.searchHybrid(query, 4);
    expect(hits[0]!.heading).toContain('04 这三句话已被人类拉黑');
    expect(hits[0]!.similarity).toBeCloseTo(1);
    expect(formatNotesHint(hits, hintOptions)).toContain('04 这三句话已被人类拉黑');
    // 没过语义门槛的段不带 similarity
    expect(hits.slice(1).every((h) => h.similarity === undefined)).toBe(true);
  });

  it('接口失败时退回 BM25 + 精确匹配，结果与 search 一致', async () => {
    const store = new NotesStore(tempNotes());
    store.setSemantic(new EmbeddingCache(conceptEmbedder(true), 1000), gate);
    await flush();
    const query = '被人类拉黑的三句话是哪三句';
    expect(await store.searchHybrid(query, 4)).toEqual(store.search(query, 4));
  });

  it('没挂语义检索时等同于 search', async () => {
    const store = new NotesStore(tempNotes());
    expect(await store.searchHybrid('鱼八股', 4)).toEqual(store.search('鱼八股', 4));
  });
});

describe('NotesStore.save', () => {
  it('新标题建文件，带记录时间与来源；随后可检索到', () => {
    const root = tempNotes({});
    const store = new NotesStore(root);
    const result = store.save({ title: '群友小明', content: '小明养了一只橘猫叫团子', source: '群聊' });

    expect(result.created).toBe(true);
    expect(result.file).toBe('群友小明.md');
    const text = readFileSync(join(root, '群友小明.md'), 'utf8');
    expect(text).toMatch(/^# 群友小明\n\n> 记录于 \d{4}-\d{2}-\d{2} · 来源：群聊\n\n小明养了一只橘猫叫团子\n$/);
    expect(store.search('小明的猫叫什么')[0]!.file).toBe('群友小明.md');
  });

  it('指定已有文件时追加小节', () => {
    const root = tempNotes();
    const store = new NotesStore(root);
    const result = store.save({ title: '11 评论区的钓鱼佬', content: '先撒白米饭再喊鱼', file: '课堂笔记.md' });

    expect(result.created).toBe(false);
    expect(readFileSync(join(root, '课堂笔记.md'), 'utf8')).toContain('\n## 11 评论区的钓鱼佬\n');
  });

  it('文件名去掉路径穿越，补 .md', () => {
    const root = tempNotes({});
    const result = new NotesStore(root).save({ title: 't', content: 'c', file: '../../evil' });
    expect(result.file).toBe('evil.md');
  });

  it('空标题/空内容/超长内容报错', () => {
    const store = new NotesStore(tempNotes({}));
    expect(() => store.save({ title: ' ', content: 'x' })).toThrow();
    expect(() => store.save({ title: 'x', content: ' ' })).toThrow();
    expect(() => store.save({ title: 'x', content: 'a'.repeat(9000) })).toThrow(/过长/);
  });

  it('带 chatKey 时写到 chats/<会话>/ 下，只有该会话检索得到', () => {
    const root = tempNotes({});
    const store = new NotesStore(root);
    const key = chatKeyOf('group', 'A215');
    const result = store.save({ title: '沉钟修道院 队伍', content: '刻德温是战争牧师', chatKey: key });

    expect(result.message).toContain('只有本会话');
    expect(readFileSync(join(root, 'chats', 'group_A215', '沉钟修道院 队伍.md'), 'utf8')).toContain('刻德温');
    expect(store.search('刻德温是什么职业', 5, key)).toHaveLength(1);
    expect(store.search('刻德温是什么职业', 5, chatKeyOf('group', 'D609'))).toEqual([]);
  });

  it('人手改文件后重新索引（mtime/大小变化）', () => {
    vi.useFakeTimers();
    try {
      const root = tempNotes();
      const store = new NotesStore(root);
      expect(store.search('橘猫团子')).toEqual([]);
      writeFileSync(join(root, '新.md'), '# 猫\n橘猫团子', 'utf8');
      vi.advanceTimersByTime(5000);
      expect(store.search('橘猫团子')[0]!.file).toBe('新.md');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('formatNotesHint', () => {
  const store = new NotesStore(tempNotes());

  it('相关问题注入片段', () => {
    const hint = formatNotesHint(store.search('被人类拉黑的三句话是哪三句', 4), hintOptions);
    expect(hint).toContain('[共享笔记 · 可能相关]');
    expect(hint).toContain('04 这三句话已被人类拉黑');
  });

  it('只撞上一个词的短消息不注入', () => {
    expect(formatNotesHint(store.search('哈哈哈哈', 4), hintOptions)).toBe('');
    expect(formatNotesHint(store.search('今天吃什么', 4), hintOptions)).toBe('');
  });

  it('引号原文强命中时，闲聊词拉低覆盖率也照样注入', () => {
    // 「明天」「家长会」在别的段里出现过，算进覆盖率分母
    const query = '明天开家长会的时候想起来那个「鱼八股」是什么';
    const hits = store.search(query, 4);
    expect(hits[0]!.coverage).toBeLessThan(hintOptions.minCoverage);
    expect(formatNotesHint(hits, hintOptions)).toContain('04 这三句话已被人类拉黑');
  });

  it('本会话私有笔记标成 [本会话]，不暴露目录名', () => {
    const scoped = new NotesStore(tempNotes({ 'chats/group_A/团.md': '# 沉钟修道院\n队伍已升两级，下次开矿坑' }));
    const hint = formatNotesHint(scoped.search('沉钟修道院下次开哪里', 4, 'group_A'), hintOptions);
    expect(hint).toContain('- [本会话] 团.md › 沉钟修道院');
    expect(hint).not.toContain('group_A');
  });

  it('按 maxChars 截断', () => {
    const hint = formatNotesHint(store.search('明天开家长会怎么办', 4), { ...hintOptions, maxChars: 80, topK: 1 });
    expect(hint.length).toBeLessThanOrEqual(80);
    expect(hint).toBe('');
  });
});

describe('looksLikeCampaignNote', () => {
  it('跑团存档/约定默认只记到本会话', () => {
    expect(looksLikeCampaignNote('沉钟修道院跑团 · DM 操作约定', '默认先上引导术')).toBe(true);
    expect(looksLikeCampaignNote('2 级队伍配置', '一环位 3 个，20 HP')).toBe(true);
  });

  it('普通梗和知识不算', () => {
    expect(looksLikeCampaignNote('网络缩写小抄', 'ltp、admin、php 的意思')).toBe(false);
    expect(looksLikeCampaignNote('奶蛙迷因档案', '2026 年初在 B 站爆红')).toBe(false);
  });
});

describe('范围隔离、新旧冲突、触发依据与注水预算', () => {
  it('通用教训跨模型跨会话可用；项目笔记只在对应项目或授权点名时命中；角色设定按人设与场景隔离', () => {
    const root = tempNotes({
      '通用工程教训.md': '# 可靠Agent协作\n\n> 记录于 2026-11-13 · 来源：私聊\n\n完成状态必须对应真实证据，禁止用估计值冒充实测。',
      'projects/voice-lab/破音定位.md': '---\nprojects: [voice-lab]\ntriggers: [RVC破音, hp5]\ndate: 2026-11-04\nsource: 私聊\n---\n# RVC 高音破音真因\n干声混有和声时先用 --lead-back hp5 拆主唱。',
      '哈基米角色口癖.md': '---\npersonas: [哈基米]\nscenes: [group]\ndate: 2026-11-10\n---\n# 哈基米猫猫演绎\n被叫小笨猫会炸毛哈气，禁止使用霸总八股腔。',
    });
    const store = new NotesStore(root);

    // 1. 通用教训在不同会话、不同模型下都能检索
    const genA = store.search('真实证据 估计值', 5, 'group_X', { projects: ['dsh-qqbot'], models: ['claude'], scenes: ['group'] });
    const genB = store.search('真实证据 估计值', 5, 'c2c_Y', { projects: ['voice-lab'], models: ['deepseek'], scenes: ['c2c'] });
    expect(genA[0]!.file).toBe('通用工程教训.md');
    expect(genA[0]!.scopeLabel).toBe('跨会话通用');
    expect(genB[0]!.file).toBe('通用工程教训.md');

    // 2. 项目笔记：在无关项目和受限群聊里不命中；在 voice-lab 或授权点名时命中
    expect(store.search('高音破音怎么修 hp5', 5, 'group_X', { projects: ['dsh-qqbot'], scenes: ['group'], allowQueryProjectMatch: false })).toEqual([]);
    expect(store.search('voice-lab 高音破音 hp5', 5, 'group_X', { projects: ['dsh-qqbot'], scenes: ['group'], allowQueryProjectMatch: false })).toEqual([]);
    const inProj = store.search('高音破音怎么修', 5, undefined, { projects: ['voice-lab'], scenes: ['local'] });
    expect(inProj[0]!.file).toBe('projects/voice-lab/破音定位.md');
    expect(inProj[0]!.scopeLabel).toBe('项目:voice-lab');
    const byQuery = store.search('voice-lab 高音破音', 5, 'c2c_OWNER', { allowQueryProjectMatch: true, scenes: ['c2c'] });
    expect(byQuery[0]!.file).toBe('projects/voice-lab/破音定位.md');

    // 3. 角色演绎：只在匹配人设 + 场景启用
    expect(store.search('小笨猫 霸总八股', 5, 'group_X', { personas: ['大肥鱼'], scenes: ['group'] })).toEqual([]);
    expect(store.search('小笨猫 霸总八股', 5, 'c2c_X', { personas: ['哈基米'], scenes: ['c2c'] })).toEqual([]);
    const rpHit = store.search('小笨猫 霸总八股', 5, 'group_X', { personas: ['哈基米'], scenes: ['group'] });
    expect(rpHit[0]!.file).toBe('哈基米角色口癖.md');
    expect(rpHit[0]!.scopeLabel).toContain('人设:哈基米');
  });

  it('过期结论保留日期与来源，默认不自动注入，旧词检索时补召回并优先新记录；问历史时放行', () => {
    const root = tempNotes({
      '旧whisper方案.md': '# 本机 whisper 转写\n\n> 记录于 2026-10-28 · 来源：私聊\n\n本地启动 whisper.cpp 监听 127.0.0.1:8080 跑转写服务。',
      '新音频链路.md': '---\ndate: 2026-11-05\nsource: 私聊\nsupersedes: 旧whisper方案.md\n---\n# 当前音频转写链路\n已改用 qqbot_transcribe 直传云端接口转写，不再开本地服务。',
    });
    const store = new NotesStore(root);

    // 用旧词（8080 / whisper.cpp）搜：新记录虽然没写 8080，仍被替代关系补召回并排第一；旧记录带冲突提醒且不自动注入
    const hits = store.search('whisper.cpp 8080 怎么转写');
    expect(hits[0]!.file).toBe('新音频链路.md');
    expect(hits[0]!.why).toContain('替代旧记录');
    const oldHit = hits.find((h) => h.file === '旧whisper方案.md')!;
    expect(oldHit.meta?.status).toBe('superseded');
    expect(oldHit.meta?.date).toBe('2026-10-28');
    expect(oldHit.meta?.source).toBe('私聊');
    expect(oldHit.conflicts?.[0]).toMatchObject({ file: '新音频链路.md', relation: 'superseded-by' });

    const injected = selectNotesForInjection(hits, { topK: 2, minCoverage: 0.4, query: 'whisper.cpp 8080 怎么转写' });
    expect(injected.map((h) => h.file)).toEqual(['新音频链路.md']);

    // 明确问历史沿革时，允许把旧记录注入参考并附带冲突提醒
    const histHint = formatNotesHint(hits, { topK: 2, maxChars: 600, minCoverage: 0.2, query: '之前旧版 whisper 怎么跑的' });
    expect(histHint).toContain('旧whisper方案.md');
    expect(histHint).toContain('⚠️已过期·2026-10-28·私聊');
    expect(histHint).toContain('⚠️ 冲突提醒：已被《新音频链路.md');
  });

  it('未标过期的同主题新旧笔记自动识别 deprecated-by 与 newer-evidence 冲突', () => {
    const root = tempNotes({
      '旧流程.md': '# 语音转写流程\n\n> 记录于 2026-10-28 · 来源：私聊\n\n通过本地 whisper 服务监听端口完成视频音轨抽帧与转写。',
      '新流程.md': '# 音频转写当前链路\n\n> 记录于 2026-11-05 · 来源：私聊\n\n2026-11-05 整体重写：原有本地 whisper 服务已退役，视频音轨改由云端转写接口完成。',
    });
    const store = new NotesStore(root);
    const hits = store.search('本地 whisper 视频音轨转写');
    expect(hits[0]!.file).toBe('新流程.md');
    const oldHit = hits.find((h) => h.file === '旧流程.md')!;
    expect(oldHit.conflicts?.some((c) => c.file === '新流程.md' && c.relation === 'deprecated-by')).toBe(true);
    const hint = formatNotesHint(hits, { topK: 2, maxChars: 800, minCoverage: 0.4 });
    expect(hint).toContain('⚠️ 冲突提醒：新记录《新流程.md');
  });

  it('大库下纯泛化高频词不自动注入，显式 triggers 与高区分度词正常注入', () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 9; i++) {
      files[`泛化${i}.md`] = `# 测试报告 ${i}\n\n我们今天做了系统测试和日志核对工作。`;
    }
    files['专属触发.md'] = '---\ntriggers: [RVC破音]\n---\n# 测试报告补充\n\n先分离和声再检查日志。';
    const store = new NotesStore(tempNotes(files));

    // 只命中高频词（在 >= 90% 段里都出现的「测试」「系统」「日志」）：大库门控拦下不自动注入
    const weakHits = store.search('系统测试日志核对');
    expect(weakHits.length).toBeGreaterThan(0);
    expect(weakHits[0]!.hasDistinctiveTerm).toBe(false);
    expect(selectNotesForInjection(weakHits, { topK: 2, minCoverage: 0.4 })).toEqual([]);

    // 命中显式触发词「RVC破音」：直接放行并说明触发依据
    const trigHits = store.search('RVC破音 日志怎么看');
    expect(trigHits[0]!.file).toBe('专属触发.md');
    expect(trigHits[0]!.triggeredBy).toContain('RVC破音');
    expect(trigHits[0]!.why).toContain('触发词「RVC破音」');
    expect(selectNotesForInjection(trigHits, { topK: 2, minCoverage: 0.4 }).map((h) => h.file)).toEqual(['专属触发.md']);
  });

  it('注水式预算分配不浪费短段配额，并遵守 inject=search-only 与 budgetChars', () => {
    const shortText = '短提示：先核对凭证。';
    const longText = `长规约：${'甲乙丙丁'.repeat(110)}`; // 约 444 字
    const root = tempNotes({
      'a短.md': `# 凭证核对\n\n${shortText}`,
      'b长.md': `# 长工程规约\n\n${longText}`,
      'c仅搜.md': '---\ninject: search-only\n---\n# 仅检索归档\n\n凭证核对历史背景长篇记录。',
      'd单条限.md': '---\nbudgetChars: 100\n---\n# 单条预算规约\n\n凭证核对单条限制：' + '戊己庚辛'.repeat(50),
    });
    const store = new NotesStore(root);
    const hits = store.search('凭证核对 工程规约', 5);
    expect(hits.some((h) => h.file === 'c仅搜.md')).toBe(true);

    // c仅搜 不进自动注入；总预算 500 字，a短 只占 ~10 字，b长 能吃到 ~490 字，不会被均分拦腰截到 250 字
    const plan = planNoteInjection(hits.filter((h) => h.file !== 'd单条限.md'), {
      topK: 2,
      maxChars: 500,
      minCoverage: 0.3,
    });
    expect(plan.items.map((i) => i.hit.file)).not.toContain('c仅搜.md');
    const longItem = plan.items.find((i) => i.hit.file === 'b长.md')!;
    expect(longItem.snippet.length).toBeGreaterThan(200);
    expect(plan.usedChars).toBe(plan.text.length);
    expect(plan.text.length).toBeLessThanOrEqual(500);
    expect(plan.text).toContain('适用:');

    // 单条 budgetChars=100 生效
    const singlePlan = planNoteInjection(hits.filter((h) => h.file === 'd单条限.md'), {
      topK: 2,
      maxChars: 500,
      minCoverage: 0.3,
    });
    expect(singlePlan.items[0]!.snippet.length).toBeLessThanOrEqual(101);
  });
});


describe('additive operations and safe replacement', () => {
  it('operation tags add candidates without excluding background or semantic recall', async () => {
    const store = new NotesStore(tempNotes({
      'operation.md': '---\noperations: [notes.search]\n---\n# Pipeline\nA completely unrelated operational instruction.',
      'background.md': '# Background\nRemember the orange cat.',
      'other.md': '---\noperations: [other.action]\n---\n# Other\nThe orange cat likes fish.',
    }));
    const hits = store.search('orange cat', 8, 'group_A', { operations: ['NOTES.SEARCH'] });
    expect(hits.map((h) => h.file)).toEqual(expect.arrayContaining(['operation.md', 'background.md', 'other.md']));
    const tagged = hits.find((h) => h.file === 'operation.md')!;
    expect(tagged.operationMatches).toEqual(['notes.search']);
    expect(tagged.why).toContain('notes.search');
    expect(store.search('', 5, 'group_A', { operations: ['notes.search'] })[0]?.file).toBe('operation.md');
    expect(selectNotesForInjection([tagged], { topK: 1, minCoverage: 1 })).toHaveLength(1);
    expect(store.search('orange cat').map((h) => h.file)).toContain('other.md');
    store.setSemantic(new EmbeddingCache({ model: 'test', async embed(texts) { return texts.map((t) => t.includes('orange') || t.includes('feline') ? [1, 0] : [0, 1]); } }, 1000), { minSimilarity: 0.5, minMargin: 0 });
    await new Promise((r) => setTimeout(r, 0));
    const semantic = await store.searchHybrid('feline', 8, 'group_A', { operations: ['notes.search'] });
    expect(semantic.find((h) => h.file === 'background.md')?.similarity).toBeCloseTo(1);
  });

  it('private replacements cannot suppress shared or other-chat evidence or disclose target metadata', () => {
    const store = new NotesStore(tempNotes({
      'shared.md': '# Orange cat\nShared orange cat evidence.',
      'chats/group_A/private.md': '---\nscope: {chatKey: group_B}\nsupersedes: shared.md\n---\n# Hidden replacement\n> 范围：chat=group_B\n\nOrange cat private secret.',
      'chats/group_B/old.md': '---\nsupersededBy: chats/group_A/private.md\n---\n# Old cat\nOrange cat older evidence.',
    }));
    const own = store.search('orange cat', 8, 'group_A');
    expect(own.map((h) => h.file)).toContain('chats/group_A/private.md');
    const other = store.search('orange cat', 8, 'group_B');
    expect(other.map((h) => h.file)).not.toContain('chats/group_A/private.md');
    expect(other.find((h) => h.file === 'shared.md')?.meta?.status).toBe('active');
    expect(other.find((h) => h.file === 'chats/group_B/old.md')?.meta?.status).toBe('active');
    expect(JSON.stringify(other)).not.toContain('private.md');
    expect(store.search('orange cat', 8).every((h) => !h.file.startsWith('chats/'))).toBe(true);
  });

  it('same-chat qualified replacement is recalled only for that chat', () => {
    const store = new NotesStore(tempNotes({
      'chats/group_A/old.md': '# Original\nOrange cat old workflow.',
      'chats/group_A/new.md': '---\nsupersedes: chats/group_A/old.md\n---\n# Current\nUse the updated process.',
      'chats/group_B/old.md': '# Original\nOrange cat independent workflow.',
    }));
    const own = store.search('orange cat', 8, 'group_A');
    expect(own[0]?.file).toBe('chats/group_A/new.md');
    expect(own.find((h) => h.file.endsWith('/old.md'))?.meta?.status).toBe('superseded');
    const other = store.search('orange cat', 8, 'group_B');
    expect(other[0]?.file).toBe('chats/group_B/old.md');
    expect(other[0]?.meta?.status).toBe('active');
    expect(JSON.stringify(other)).not.toContain('group_A');
  });

  it('project-specific replacement does not suppress general evidence even in the matching project', () => {
    const store = new NotesStore(tempNotes({
      'general.md': '# Orange cat\nOriginal orange cat convention.',
      'projects/app/new.md': '---\nsupersedes: general.md\n---\n# New rule\nNew project convention.',
    }));
    expect(store.search('orange cat', 5, 'group_A', { projects: ['app'] })[0]?.meta?.status).toBe('active');
  });

  it('ambiguous bare headings do not replace multiple files; qualified references still work', () => {
    const root = tempNotes({
      'a.md': '# Same heading\nOrange cat original A.',
      'b.md': '# Same heading\nOrange cat original B.',
      'new.md': '---\nsupersedes: Same heading\n---\n# New rule\nUpdated evidence.',
    });
    const store = new NotesStore(root);
    expect(store.search('orange cat', 8).filter((h) => h.meta?.status === 'superseded')).toEqual([]);
    store.save({ title: 'Qualified replacement', content: 'Now updated.', supersedes: ['a.md › Same heading'] });
    const hits = store.search('orange cat', 8);
    expect(hits.find((h) => h.file === 'a.md')?.meta?.status).toBe('superseded');
    expect(hits.find((h) => h.file === 'b.md')?.meta?.status).toBe('active');
  });

  it('full rendered budget includes long provenance, headings, explanations and conflicts', () => {
    const hit = { file: 'file'.repeat(100) + '.md', heading: 'heading'.repeat(100), text: 'body '.repeat(400), score: 1, coverage: 1, matched: 5, why: 'reason'.repeat(300), scopeLabel: 'scope'.repeat(200), conflicts: [{ file: 'replacement'.repeat(200), heading: 'target'.repeat(100), relation: 'newer-evidence' as const }] };
    for (const maxChars of [0, 30, 80, 300, 800, 1200]) {
      const plan = planNoteInjection([hit], { topK: 2, maxChars, minCoverage: 0 });
      expect(plan.text.length).toBeLessThanOrEqual(maxChars);
      expect(plan.usedChars).toBe(plan.text.length);
      for (const item of plan.items) expect(plan.text).toContain(item.snippet);
    }
    const plan = planNoteInjection([hit], { topK: 1, maxChars: 800, minCoverage: 0 });
    expect(plan.items).toHaveLength(1);
    expect(plan.text).toContain('触发:');
    expect(plan.text).toContain('冲突提醒');
  });
});
