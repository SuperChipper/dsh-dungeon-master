# 源梗图构图比例对齐与局部拼接指南（Meme Composition Alignment）

在将源梗图改编为目标角色（`cat_*`、`fish_*`、`gpt_*`、`claude_*` 等）Q 版表情时，直接让生图模型自由发挥容易导致头身比、歪头角度、眼睛大小与道具位置偏离源图。改编时遵循「先量标尺、坐标入词、叠影验稿」；仅在局部重绘发生漂移且边界可干净衔接时使用拼接。

---

## 1. 生图前：用 `align-guide` 提取五大构图指标

运行 `<SKILL_ROOT>/scripts/sticker-cli.cjs align-guide`（若源图是合集大图，先通过 `--crop "x,y,w,h"` 切出单张梗图），用看图工具查看生成的 `*_ref_grid.png` 与 JSON 报告，记录以下 5 项坐标参数：

1. **头部宽度占比与出血位置（Head Span & Bleed）**
   - 头部（含发团/角/耳）在 `1024` 画布上从 `x=?%` 跨到 `x=?%`？例如部分大头贴边梗图头部占画布宽 `85%+` 且右侧贴近 `x≈98%`，不在提示词写明就会被模型缩成居中 `60%` 小头。
2. **歪头倾角与视线轴线（Head Tilt & Gaze）**
   - 双眼连线是水平（`0°`），还是倾斜（如向右下 `+12°~15°`）？
3. **五官比例与眼白开关（Eye Scale & Sclera Switch）**
   - 眼睛高度占脸部高度的百分比？原梗图是否有眼白？若原图为纯色块死鱼眼/豆豆眼，提示词需写明 `ZERO white sclera, compact flat semi-closed eyes (~0.8x normal chibi eye size)`。
   - 若梗图含举牌/书封文字，核查文字在牌面内是否水平与垂直居中。
4. **道具/举牌的纵向区间（Prop Vertical Band）**
   - 道具在画布 `y` 轴占据哪一段百分比？上方是否露出衣领，下方是否露出腰腹或裙头？
5. **躯干宽度与底部截断线（Torso Width & Cut-off Line）**
   - 查看 JSON 中 `horizontalBands` 在 `y=80%-100%` 的横向跨度与底部截止位置。

---

## 2. 初稿验收：用 `align-guide --compare` 做红青叠影自检

收到生图初稿后，先运行对比再决定是否微调：

```bash
node <SKILL_ROOT>/scripts/sticker-cli.cjs align-guide \
  --ref <source-meme> \
  --compare <generated-draft> \
  --out-dir <scratch-dir> \
  --tag check_v1 \
  --output <scratch-dir>/align_v1.json
```

用看图工具打开生成的 `*_align_compare.png`（中栏红影为原梗图、青影为新稿），检查头宽、倾角、牌子高度与眼神细节，最多在 2 轮内修正提示词或局部拼接。

---

## 3. 局部打磨防漂移：用 `splice` 锁定已对齐主体

当整张图的头身比、表情、道具都已对齐原梗图，只需重绘某一块复杂服饰细节时：
1. 让生图工具专注于把局部结构画准确；
2. 用 `sticker-cli.cjs splice` 锁定旧稿已通过的区域，先用 `--clear-box` 将旧稿待替换区域擦白消除重影，再将新图局部框（`--patch-crop`）嵌入目标框（`--target-box`），并确保两侧后发/宽袖与中间腰裙之间保留干净的分隔间隙。
