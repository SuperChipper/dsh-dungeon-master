---
name: qqbot-sticker-maker
description: 制作、微调、构图对齐、抠图预览并入库 dsh-dungeon-master 的 Q 版透明表情包（PNG + stickers/index.json）。支持源梗图比例测量与叠影对比、局部拼接防漂移、白底泛洪抠图/原生透明导出、深浅底 1:1 预览及原子注册。当用户要求生成机器人角色表情包、改编梗图动作或修正贴纸细节并入库时加载。
metadata:
  version: "1.0.0"
---

# QQ Bot 表情包制作与入库（`qqbot-sticker-maker`）

先选定目标角色与版本，再将角色身份参考与源表情的构图结合。默认交付 `256×256` 透明 RGBA PNG、`1024×1024` 母版，以及从**最终 256px 文件解码生成**的深底 `#252830` / 浅底 `#F2F4F8` 对照预览。保留原始生成文件并实际核验尺寸；默认无外白边（若源梗图本身需要白边则随源图）。

> **素材与版权边界**：社区同人立绘与本机私有参考图不随 npm 包分发（已被 `.gitignore` / `.npmignore` 排除）。已整理的社区形象出处、原始链接与 SHA-256 校验值见 [`resources/zipzippipe/sources.json`](./resources/zipzippipe/sources.json)；如需使用参考图，请按该清单核对授权并放置于本机 `resources/` 目录，或使用用户当场提供的角色设定图。

## 路径与工具

- 记 `SKILL_ROOT` 为本 `SKILL.md` 所在目录，配套脚本位于 `<SKILL_ROOT>/scripts/sticker-cli.cjs`。不要假定 shell 当前工作目录。
- 图片生成与修改使用当前环境实际提供的生图工具；先用看图工具检查每张输入参考与生成结果。
- 生图工具支持透明底时直接请求真实 alpha 并保留输出；**仅当输入确为白底稿时才运行 `sticker-cli.cjs process`**，不要对白发或原生透明图重复泛洪抠图。
- 坐标网格、局部拼接、透明导出、预览与索引注册均通过 `<SKILL_ROOT>/scripts/sticker-cli.cjs` 离线执行（依赖环境中已安装的 `sharp`，各子命令支持 `--help`）。

## 角色视觉参考

生图前先读 [`references/character-specs.md`](./references/character-specs.md) 的对应章节；社区同人出处见 [`resources/zipzippipe/sources.json`](./resources/zipzippipe/sources.json)。

| 角色 / 文件前缀 | 原设参考（本机可选缓存路径） | Q 版补充参考（本机可选缓存路径） |
| --- | --- | --- |
| Gemini：`gemini_*`；哈基米：`cat_*` | `resources/zipzippipe/gemini-original.jpg` | `resources/hakimi_canonical_full.png`、`resources/hakimi_torso_skirt_zoom.png` |
| Claude：`claude_*` | `resources/zipzippipe/claude-original.jpg` | 与黑发、工程服等其他版本区分 |
| DeepSeek 大肥鱼：`fish_*` | `resources/zipzippipe/deepseek-original.jpg` | `resources/feiyu_canonical_maid_ref.png`（上善无形原角色 → ZipZipPipe 女仆二创） |
| GPT：`gpt_*` | `resources/zipzippipe/gpt-original.jpg` | `resources/zipzippipe/gpt-turnaround.png` |

用户当次明确指定的要求优先：原设图负责身份、物种与服装结构，源表情负责动作、神态、构图与笔触；不要把正常头身比立绘的写实光影照搬进蜡笔平涂 Q 版。未收录的新角色直接从用户提供的参考图提取特征。

## 制作流程

### 1. 固定输入与比例测量

核对目标 `stickers/index.json` 的 `look` 描述与实际图片，标明每张输入属于「编辑目标 / 身份参考 / 风格参考」。换角色改编时同步检查手持道具是否绑定源角色品牌标志（如四角星抱枕 → 对应角色标志物）。

改编源梗图时先运行 `align-guide`（合集大图加 `--crop "x,y,w,h"`），查看网格图与 JSON 指标，记录头部跨度、视线倾角、五官有无眼白、道具纵向区间与底部截断线；详见 [`references/meme-adaptation-notes.md`](./references/meme-adaptation-notes.md)：

```bash
node <SKILL_ROOT>/scripts/sticker-cli.cjs align-guide \
  --ref stickers/cat_夸夸我.png \
  --out-dir tmp/imagegen/example \
  --tag baseline \
  --output tmp/imagegen/example/baseline.json
```

### 2. 生图、叠影对照与局部拼接

同时传入源表情与目标角色参考，保持粗颗粒深色描边与柔和哑光色块，写清画面文字内容与位置。

生成初稿后运行 `align-guide --compare <draft>` 检查「原图 / 红青叠影 / 新稿」三栏对比图。整体外框接近不代表构图合格，需同时核对眼睛位置、手势与道具上沿。若主体已对齐、仅局部服饰需重绘，用 `sticker-cli.cjs splice`（`--clear-box` + `--patch-crop` + `--target-box`）锁定已通过主体，防止整图重绘漂移；最多迭代两轮针对性修正。

### 3. 透明导出与 1:1 尺寸验收

- **原生透明稿**：直接运行 `export`，保留原始 alpha 并生成 `1024` 母版、`256` 成品与深浅底预览。
- **白底稿**：先运行 `process` 泛洪去白底，检查报告中的 `enclosedWhitePockets`——确认属于背景孔洞的坐标传 `--extra-seeds`，白发、眼白、书页、浅色百褶裙或女仆荷叶边传 `--protect-boxes` 或配合 `--gap-close-radius` 保护；随后将透明母版交给 `export` 生成从**最终 256px PNG 解码的 1:1 像素预览**。
- 校验成品为正方形 RGBA PNG、同时包含透明背景像素与可见前景像素、体积 `≤ 300 KiB`，并用看图工具目视核查小字清晰度、发丝白边与实心浅色区域。

```bash
node <SKILL_ROOT>/scripts/sticker-cli.cjs export \
  --input tmp/imagegen/example/generated.png \
  --name gpt_求夸 \
  --tag v1 \
  --out-dir tmp/imagegen/example/final \
  --output tmp/imagegen/example/export-v1.json
```

### 4. 交付与入库注册

仅要求「试做 / 看看效果」时交付预览图与成品路径，不改正式表情库；获得明确入库授权后运行 `register`（可先加 `--dry-run` 预检，通过 `--stickers-dir <cwd>/stickers` 指定目标机器人的表情目录）：

```bash
node <SKILL_ROOT>/scripts/sticker-cli.cjs register \
  --input tmp/imagegen/example/final/gpt_求夸_v1.png \
  --file gpt_求夸.png \
  --stickers-dir ./stickers \
  --emotion "求夸" \
  --look "白紫龙娘抱结形抱枕，眼巴巴等夸奖" \
  --note "做完事想求一句夸时用" \
  --dry-run \
  --output tmp/imagegen/example/register-check.json
```

`emotion` 写简短情绪词，`look` 写客观画面描述，`note` 写触发语境；避免与运行中的机器人在同一时刻并发改写 `index.json`。
