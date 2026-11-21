# src/dnd — 跑团开发约定

本文件只给改 `src/dnd/` 的开发者看；DM 运行期读不到 `AGENTS.md`，完整设计背景与历史事故见 `docs/dnd-long-lived-state.md`。

## 规则与状态边界

- **规则落位**：能由代码/工具返回值保证的放返回值；工具用法放工具说明；仅每回合必守的进 `src/dnd/dnd-service.ts` 的 DM 守则（含压缩摘要要求）；停团后只注入 `PAUSED_RULES` 管剧透与凭印象作答。
- **信息隔离**：怪物 AC、HP、DC 不进例行工具结果与团况，只给伤势词与成败（专门查询工具如 `dnd_character show` 除外），不要指望加「机密」标签防止复述。
- **模组与状态**：具名反派/俘虏的 `knows` 要连「不知道什么」一起写，避免审问时现编事实；战斗中需跨压缩保留的状态必须进 `summarize()`，不能只依赖压缩摘要转述。

## 新增 `dnd_*` 工具同步清单

- 工具按类别放进 `src/dnd/tools/`；停团后也要可用的加入 `src/dnd/tool-scope.ts` 的 `PAUSED_DND_TOOLS`（未开团看不到 `dnd_*`，停团只看到该名单）。
- 同步更新：`src/dnd/dnd-service.ts` DM 守则、`README.md` / `README_EN.md` 工具表、以及对应测试。

## 排障备忘

- `dnd_*` 结果永远不发群（`showToolResults`），群里看不到不等于没调用。
- 会话日志 `~/.dsh/sessions/<cwd>/<id>/session.v4.jsonl.zstd` 是多帧独立 zstd，Node 流式解压只解第一帧，需按魔数切帧逐帧解。
- 战役档 `dnd/campaigns/qqbot_*_<群openid>.json`：看 `revealed` 判断演过的房间，结合 `log` 与聊天记录确认进度。
