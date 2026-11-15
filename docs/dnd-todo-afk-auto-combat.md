# TODO：D&D 跑团玩家挂机托管 / 自动战斗状态（`/dnd afk`）

记录时间：2026-11-14

## 一、背景与当前局限

### 1. 当前机制
- 为防止模型擅自替玩家消耗法术位/激励骰，绑定了 `playerId` 的 `pc` 在触发反应（护盾术、尖刻言语、借机攻击等）时，受 `src/dnd/pending-attack.ts`（`assertReactionAuthorized`）和 `src/dnd/tools/dice.ts` 的一次性服务端令牌 `authorization` 硬锁保护。
- 玩家临时挂机（AFK）或口头说「帮我自动打到底」时：
  - **反应窗口**：战斗代理没有 `authorization` 令牌，**只能传 `decline` 替玩家跳过反应**，不能代开护盾术/借机攻击。
  - **主动回合**：超过 `recentSenders` 活跃窗口后，未委托时只能 `next dm_override=true` 跳过回合。

### 2. 临时改 `kind="npc"` 顶替的三个已知坑
短期测试可在演练模式或临时用 `dnd_character update kind="npc"` 变通（不会丢失卡上的 `playerId`），但正式跑团长期用有三个硬伤：
1. **0 HP 直接暴毙**：`src/dnd/campaign.ts`（`applyDamage`）中仅 `kind === 'pc'` 归零进「昏迷 + 死亡豁免」，`npc` 归零直接判 `死亡`（只能 `dnd_undo` 回滚）。
2. **被攻击不自动挂起反应**：`src/dnd/pending-attack.ts`（`eligibleReactors`）只扫描 `kind === 'pc'`；改成 `npc` 后怪物攻击命中直接落账扣血，除非模型提前预判传 `hold=true`，否则来不及替他开护盾术。
3. **停团与跨团限制**：停团改卡（`src/dnd/tools/character.ts`）和 `/dnd new` 跨模组带卡（`src/dnd/dnd-service.ts`）只认 `kind === 'pc'`，收团前忘了改回 `pc` 会影响后续流程。

---

## 二、后续正道改动方案（零网关层入侵）

不需要改动网关入站消息解析器，直接通过 **`/dnd afk` 斜杠子命令 + `Character.afk` 字段** 实现：
> 斜杠命令只走 `src/commands/dnd.ts` 命令通道，**大模型无法自行调用斜杠命令**，天然保证「只有真实玩家本人能开启/关闭托管」，不会破坏防模型乱扣资源的权限红线，也不会破坏系统提示词 KV 缓存。

### 待办改动清单

- [ ] **1. 数据结构与权限放行（`src/dnd/campaign.ts`）**
  - 在 `Character` 接口新增可选字段：
    - `afk?: boolean`（是否处于玩家本人授权的挂机托管状态）
    - `afkNote?: string`（可选的一句话托管策略，如 `残血才开护盾术，保留最后1个法术位`）
  - 保持 `kind: 'pc'` 不变，确保 **0 HP 依然正常走昏迷与死亡豁免**、停团改卡与跨团继承不受影响。
  - `assertDeclaredByOwner` 与 `assertCanEndTurn`：当 `ch.afk === true` 时放行战斗代理代执行主动回合与 `next`。
  - `/dnd start` 新开团签到完成时（或玩家本人重新点击回合按钮/发行动消息时），可自动清除或提示恢复手动控制。

- [ ] **2. 玩家斜杠命令入口（`src/commands/dnd.ts`）**
  - 新增 `/dnd afk [off | 托管策略备注]`：
    - 仅匹配 `cmdCtx.message.senderId === ch.playerId` 的本人 PC 卡（无参切换开关，带文字则开启并写入 `afkNote`，传 `off` 关闭）。
    - 回复明确回显当前托管状态与策略，例如：`🤖 丛云已开启挂机托管（策略：有战斗英姿就开，危急时允许交护盾术）。发 /dnd afk off 随时接回手动控制。`

- [ ] **3. 禁止模型工具篡改托管位（`src/dnd/tools/character.ts`）**
  - `dnd_character` 的 Schema 与 `upsertCharacter` 参数**不暴露 `afk` / `afkNote`**，更新角色卡时原样保留已有 `afk` 状态，确保模型不能自己给自己签发托管权限。
  - 顺带评估：是否限制战斗代理在战斗中把绑定了 `playerId` 的 `pc` 改成 `kind="npc"`，彻底堵死绕过反应锁的旁路。

- [ ] **4. 反应与借机窗口适配（`src/dnd/pending-attack.ts`、`src/dnd/battlefield.ts`、`src/dnd/tools/dice.ts`）**
  - `eligibleReactors` 与 `moveOnGrid` 依然保持扫描参战 `pc`（因此怪物打托管 PC 时**照常自动挂起 `pending` 窗口**，不会直接把血扣死）。
  - 对 `ch.afk === true` 的反应项打上 `npc: true`（或 `afk: true`）标记：
    - `src/dnd/turn-buttons.ts` 不为托管角色弹群内阻塞按钮，不卡住等真人点击；
    - `assertReactionAuthorized` 与 `dice.ts` 借机攻击分支：当 `ch.afk === true` 且 `!p.declined.includes(ch.name)` 时，免除一次性 `authorization` UUID 校验，允许战斗代理直接按 `afkNote` 策略调用 `dnd_apply reaction=...` 或 `decline=[ch.name]` 当场结算。

- [ ] **5. 回合与挂起提示注入（`src/dnd/tools/shared.ts`）**
  - `combatTurnPrompt` 与 `holdNotice` / 团况行：当目标角色 `ch.afk === true` 时，直接提示战斗代理：`【挂机托管】该角色由玩家本人开启托管（策略：${ch.afkNote ?? '按常规战术行动，节省高阶资源'}），无需停下询问本人，直接代为结算本回合/本次反应并推进。`
  - 注意放在动态团况/工具返回值中，**不写进子代理静态 `systemPrompt.section`**，保证战斗中开关 `/dnd afk` 也不影响缓存命中。

---

## 三、日后实现时的单测验收点

- [ ] 非本人 QQ 号执行 `/dnd afk` 无法修改他人角色的 `afk` 状态；模型调用 `dnd_character update` 无法伪造或覆盖 `afk`。
- [ ] `afk=true` 的 PC 被打至 0 HP 时，依然进入 `昏迷` + `倒地` 并掷死亡豁免，不会像 `npc` 一样直接判 `死亡`。
- [ ] `afk=true` 的 PC 被怪物命中时，自动产生 `pending` 反应窗口但不发真人等待按钮，战斗代理无 `authorization` 也能成功代施放 `护盾术` 或传 `decline` 落账。
- [ ] 玩家发送 `/dnd afk off` 后，下一刀立即恢复原有的真人按钮与 `authorization` 强校验。
