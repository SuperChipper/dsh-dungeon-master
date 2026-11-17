---
name: dnd-rule-extension
description: 在 dsh-dungeon-master 中确认、建模并热注册自定义 D&D 5e 村规、第三方职业扩展（如魔兽 5e 图腾/光环）、专武特效与个人宿命被动。当玩家提出或确认内置 SRD/PHB 表尚未覆盖的子职能力、专长、魔法武器附伤、光环或战场持续危害，或需要在代码中扩展战斗结算钩子时加载。
metadata:
  version: "1.0.0"
---

# D&D 5e 扩展规则与村规热注册（`dnd-rule-extension`）

`dsh-dungeon-master` 将攻击修正、命中附伤、豁免加值、光环、治疗加成、2.5D 飞行与持续地形统一交由确定性引擎结算，避免依赖模型在长对话中凭 `notes` 文本回忆数值。

遇到内置表尚未收录的扩展规则（如魔兽 5e 职业、塔莎/珊娜萨扩展、个人专武「段云」、宿命被动「风暴遗誓」「冥河炉心」等）时，**默认走路径一（通过 `dnd_rule` 零重启热注册）**；仅当机制引入全新状态机阶段、现有 6 类声明式钩子与 `BattleZone` 均无法表达且经部署者授权修改源码时，才走路径二。

---

## 一、引擎已内置规则（无需重复定义）

注册前先用 `dnd_rule(action="list")` 查看当前规则表。以下能力已原生支持：

- **PHB 14 种标准状态 + 力竭（`力竭:1..6`）**，以及 `闪避`、`狂暴`（近战力量 `+2/+3/+4` + 物理三抗）、`祝福术`、`灾祸术`、`护盾信仰`、`加速术`、`妖火`、`神圣武器`、`战斗英姿`、`咒剑诅咒`。
- **内置声明式特性与法术（`BUILTIN_EFFECTS`）**：
  - `脆弱诅咒`（锁定目标命中 `+1d6` 黯蚀，专注）
  - `猎人印记`（锁定目标武器命中 `+1d6` 武器同型，专注）
  - `神恩`（武器命中 `+1d4` 光耀，专注）
  - `变巨术`（武器命中 `+1d4` + 力量豁免优势，专注）
  - `防护毒素`（毒素伤害抗性 + 对抗毒素/中毒豁免优势，非专注）
  - `守护灵光`（圣武士未失能时，10 尺 / 18 级 30 尺内自身与友军全豁免自动 `+max(1, cha_mod)`）
  - `灵体卫士`（15 尺敌方半速 + 回合开始/首次进圈或扫过触发感知豁免，`3d8` 基础 + 每高 1 环 `+1d8` 光耀半伤，专注）
  - `生命门徒`（1 环及以上治疗法术额外恢复 `2 + slot_level`）、`神佑医者`（治疗他人时自身恢复 `2 + slot_level`）、`保全生命`（`5 * level` 治疗池，上限有效生命值一半）
- **内置战场持续区域预设（`dnd_position action="zone"`）**：
  - `黑暗术`、`云雾术`、`毒雾`、`死云术`、`臭云术`、`蛛网术`、`匕首之云`、`月华之光`、`荆棘丛生`、`火墙术`、`沉默术`。

---

## 二、路径一：零重启热注册工作流（默认路径）

### 第 1 步：与玩家核对规则边界并选定作用域
调用 `dnd_rule(action="define")` 前先确认：
1. **作用域 `scope`**：
   - `"campaign"`（默认）：写入当前团档 `customEffects`，仅本团生效——适用于个人专武、角色宿命被动、本桌房规。
   - `"global"`：写入 `<dnd.root>/custom-effects.json`，跨团复用——适用于魔兽 5e 等整套第三方职业/专长包。
2. **挂载载体**：
   - **常驻被动** → 将规则 `name` 写入角色卡 `dnd_character(action="update", traits=[..., "<规则名>"])`（纯无条件武器元素附伤也可直接填武器的 `riders` 字段）。
   - **限时增益/姿态/诅咒** → 用 `dnd_resource(action="use", ..., apply_state="<规则名>")` 或 `dnd_apply(add_conditions=["<规则名>"])` 激活。
   - **地面/空间持续区域** → 战斗中用 `dnd_position(action="zone", name="<区域名>", ...)` 放置。
3. **同步记入团档约定**：调用 `dnd_chronicle(action="add", kind="ruling", text="...")` 记录文字裁定，确保跨压缩与战后交接一致。

> **子代理权限边界**：独立战斗子代理接管期间仅可调用 `dnd_rule(action="list" | "show")` 查询已登记规则；新增（`define`）或移除（`remove`）须在主 DM 阶段与玩家确认。

### 第 2 步：安全公式语法
公式由确定性递归下降解析器求值（不使用 `eval`）：
- **可用变量**：`level`、`prof`、`slot_level`、`str`..`cha`、`str_mod`..`cha_mod`、`hp`、`max_hp`。
- **运算符与函数**：`+`、`-`、`*`、`/`、括号 `(...)`、`min(a, b, ...)`、`max(a, b, ...)`、`floor(x)`、`ceil(x)`、`abs(x)`。

### 第 3 步：映射到 6 类钩子

| 钩子字段 | 核心配置项 | 典型场景 |
| :--- | :--- | :--- |
| `attack_mod` | `to_hit_formula`, `bonus_dice`, `advantage`, `crit_on` (18–20), `weapon_only`, `melee_only`, `ranged_only` | 战斗姿态、命中图腾、扩展重击区间 |
| `hit_rider` | `damage_dice`, `bonus_formula`, `damage_type`（如 `"闪电"` 或 `"武器同型"`）, `marked_target_only`, `weapon_only`, `melee_only`, `str_attack_only`, `advantage_only`, `once_per_turn` | 元素附伤、巨像屠夫（`once_per_turn`）、优势触发附伤（`advantage_only`）、印记类锁定附伤（`marked_target_only`） |
| `defense_mod` | `ac_bonus`（整数或公式）, `resistant`, `immune`, `vulnerable`, `attacker_advantage` | 护甲增益、元素抗性/免疫（如 `["闪电", "雷鸣"]` 或 `["*"]`） |
| `save_mod` | `abilities`（`["con", "wis"]` 或 `"all"`）, `bonus_formula`, `bonus_dice`, `advantage`, `vs_tags`（如 `["concentration", "毒素"]`） | 专注豁免优势、特定伤害/状态豁免加成 |
| `aura` | `radius`, `radius_at_18`, `target`（`"allies"`/`"enemies"`/`"all"`）, `include_self`, `save_bonus_formula`, `slow_factor`, `hazard`（`{damage_dice, upcast_per_slot, base_slot, damage_type, save_ability, half_on_save}`） | 圣武士/魔兽光环、萨满图腾光环、持续伤害减速光环 |
| `heal_mod` | `bonus_formula`, `self_heal_on_other_formula`, `pool_formula`, `cap_at_half_max_hp` | 治疗量加成、治疗他人自愈、固定治疗池 |

### 第 4 步：常用注册示例

#### 示例 1：个人宿命被动（每回合首击闪电附伤 + 双抗 + 专注优势）
```json
{
  "action": "define",
  "scope": "campaign",
  "name": "风暴遗誓·二阶",
  "description": "获得闪电与雷鸣抗性，每回合首次武器命中额外造成 1d8 闪电伤害。",
  "defense_mod": { "resistant": ["闪电", "雷鸣"] },
  "hit_rider": { "damage_dice": "1d8", "damage_type": "闪电", "weapon_only": true, "once_per_turn": true }
}
```
```json
{
  "action": "define",
  "scope": "campaign",
  "name": "冥河炉心",
  "description": "体质专注豁免与对抗毒素豁免具有优势，并获得毒素抗性。",
  "defense_mod": { "resistant": ["毒素"] },
  "save_mod": { "abilities": ["con"], "advantage": "advantage", "vs_tags": ["concentration", "毒素", "中毒"] }
}
```
随后执行 `dnd_character(action="update", name="角色名", traits=[..., "风暴遗誓·二阶", "冥河炉心"])`。

#### 示例 2：条件触发专武附伤（仅优势命中时追加雷鸣伤害）
若武器每次命中都无条件附带元素伤害（如烈焰舌 `+2d6 火焰`），直接在 `dnd_character` 的 `weapons` 中填 `riders: [{"damage": "2d6", "damage_type": "火焰"}]` 即可；若需条件触发（如优势命中才触发）：
```json
{
  "action": "define",
  "scope": "campaign",
  "name": "段云·雷鸣",
  "description": "具有优势的近战武器攻击命中时额外造成 1d6 雷鸣伤害。",
  "hit_rider": { "damage_dice": "1d6", "damage_type": "雷鸣", "weapon_only": true, "melee_only": true, "advantage_only": true }
}
```

#### 示例 3：跨团复用的职业光环（`scope: "global"`）
```json
{
  "action": "define",
  "scope": "global",
  "name": "献祭光环",
  "concentration": false,
  "default_rounds": 10,
  "description": "10 尺内敌人在回合开始或首次进入时须过敏捷豁免，失败受 2d6 火焰伤害，成功减半。",
  "aura": {
    "radius": 10,
    "target": "enemies",
    "hazard": { "damage_dice": "2d6", "damage_type": "火焰", "save_ability": "dex", "half_on_save": true }
  }
}
```

---

## 三、路径二：源码级扩展（开发维护参考）

当新机制超出上述声明式钩子表达范围（例如新增特殊反应窗口阶段、多目标共享生命链接等）且在源码仓库开发时：
1. 核心模块位于 `src/dnd/`：`custom-effects.ts` / `formula.ts`（钩子与公式）、`conditions.ts`（状态与回合推进）、`zones.ts` / `battlefield.ts` / `battle-image.ts`（持续区域、2.5D 飞行与 `/dnd status` SVG 渲染）、`campaign.ts`（存档结构，新增字段须设为可选 `?` 以兼容旧团档）。
2. 修改后运行 `npm test`、`npm run build` 与 `npm run typecheck:client` 完成校验。
