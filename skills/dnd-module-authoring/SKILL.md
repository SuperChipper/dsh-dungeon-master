---
name: dnd-module-authoring
description: 编写、拆分、校验与维护 dsh-dungeon-master 的 D&D 5e 跑团模组 JSON（adventure.json、sites/*.json、build/ 分片合并、玩家版迷雾地图与战斗场地图）。当用户要求写跑团模组、把本地备团资料/剧本转成可运行模组、标注地图矩形或排查模组加载错误与警告时加载。
metadata:
  version: "1.0.0"
---

# 跑团模组编写与维护

把原创剧本或本机备团资料写成 `dsh-dungeon-master` 可直接加载的模组 JSON（存放于 `<dnd.root>/adventures/`，默认 `cwd/dnd/adventures/`）。

> **版权与仓库边界**：商业模组（官方冒险、付费 PDF）整理出的文本、图片与 JSON 只放在本机 `<dnd.root>/adventures/`，严禁提交进插件仓库或随包分发。`playerView` 等面向玩家的文本一律用自己的话转述，不要照抄原书朗读框。

## 工作流

### 阶段 A：整理本地备团目录（长篇模组前置，可选）

改编整本模组时，先把参考资料收进 `<dnd.root>/adventures/<id>/`（加载器只读 `adventure.json` 和 `sites/*.json`，同目录放参考文件互不干扰）：

```text
<id>/text-en/*.md          按章拆分的参考正文 + 00-索引.md
<id>/text-zh/...           中文对照参考（若有缺漏，房间细节以原版为准）
<id>/译名对照表.md          人名、地名、阵营统一译名，写 JSON 时全程照表
<id>/img/*                 原书图片（区分带编号/暗门的 DM 图与干净的玩家版图）+ 00-图片索引.md
<id>/data/*.json           专属怪物、背景等附录数据
```

- **本机私有导出脚本**：若本技能目录下存在 `scripts/README.md`（仅本机自用，已被 `.gitignore` / `.npmignore` 排除），需要拉取或转换离线备团资料时先读取 `scripts/README.md` 完成阶段 A。
- **两步分开做**：阶段 A 只管把资料落盘对齐译名，阶段 B 再动手写 `adventure.json`，不要边抓资料边写模组。

### 阶段 B：编写模组 JSON（必读 `./guide.md`）

1. **先读同目录 [`guide.md`](./guide.md)**：核对顶层字段（含 `partySize`、`opening`、`routes`）、场景（`kind: "dungeon" | "hub"`、`maps`）、房间（`exits`、`encounter`、`battlemap`、`triggers`、`variants`）、NPC（`knows` 必填）、线索与任务的精确结构。
2. **按体量选文件结构**：
   - **单文件**（小模组、无本地地图图档）：`adventures/<id>.json`。
   - **按场景拆文件**（中型模组）：`adventures/<id>/adventure.json` + `adventures/<id>/sites/*.json`（自动按文件名排序追加进 `sites`）。
   - **`build/` 分片合并**（整本大模组，NPC / 线索 / 地图也要按章分批写）：在 `adventures/<id>/build/` 下放排序好的 `.json` 片段（`00-core.json`、`10-*.json`…、`60-maps.json`、`61-battlemaps.json`），用下面的最小合并脚本合成 `../adventure.json`：

```js
// adventures/<id>/build/merge.mjs — node build/merge.mjs
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ARRAYS = ['chapters', 'sites', 'npcs', 'leads', 'quests', 'flags', 'milestones', 'truth', 'opening'];
const out = {};

for (const f of readdirSync(here).filter((n) => n.endsWith('.json')).sort()) {
  const part = JSON.parse(readFileSync(join(here, f), 'utf8'));
  for (const [k, v] of Object.entries(part)) {
    if (k === 'addRooms') {
      for (const [siteId, rooms] of Object.entries(v)) {
        const site = out.sites?.find((s) => s.id === siteId);
        if (!site) throw new Error(`${f}: addRooms 指向未定义的场景 ${siteId}`);
        site.rooms.push(...rooms);
      }
    } else if (k === 'siteMaps') {
      for (const [siteId, maps] of Object.entries(v)) {
        const site = out.sites?.find((s) => s.id === siteId);
        if (!site) throw new Error(`${f}: siteMaps 指向未定义的场景 ${siteId}`);
        site.maps = [...(site.maps ?? []), ...maps];
      }
    } else if (k === 'roomBattlemaps') {
      for (const [roomId, bm] of Object.entries(v)) {
        const room = out.sites?.flatMap((s) => s.rooms).find((r) => r.id === roomId);
        if (!room) throw new Error(`${f}: roomBattlemaps 指向不存在的房间 ${roomId}`);
        room.battlemap ??= bm;
      }
    } else if (ARRAYS.includes(k)) {
      out[k] = [...(out[k] ?? []), ...v];
    } else if (!k.startsWith('_')) {
      out[k] = v;
    }
  }
}

writeFileSync(join(here, '..', 'adventure.json'), JSON.stringify(out, null, 2));
```

### 阶段 C：交付前自检

1. **结构与警告校验**：在插件仓库根目录运行 `AdventureLibrary` 加载检查，确保零报错，并逐条核查警告（未设置来源的 `flag`、发布人 `offers` 漏列任务、指向隐藏场景少于 2 条的 `leads`、不存在的地图图片路径）：
   ```bash
   node -e "import('./src/dnd/adventure.ts').then(({ AdventureLibrary }) => { const list = new AdventureLibrary({ adventures: '../dnd/adventures' }, console).list(); console.log('loaded:', list.map(a => a.id)); })"
   ```
2. **防剧透与防现编复核**：
   - `playerView` 只含进门即见即闻的内容，埋伏预兆、陷阱、暗门一律放 `dmNotes`，暗门出口标 `hidden: true`。
   - `site.maps` 与 `battlemap.art` 只引用无房间号、无「S」暗门标的玩家版地图。
   - 具名反派与可被俘审问的 NPC，`knows` 同时写清「知道什么」和「不知道什么」；头目写成 NPC 时在 `dmNotes` 提醒开战调 `dnd_story action=npc fight=true`（带伤/被俘可加 `hp=<当前值>`）。
   - 若旧团档已在该房间开过战，改完模组里的 `battlemap` 后提醒 DM 用 `dnd_position action=clear_terrain` 恢复模组预设图。
