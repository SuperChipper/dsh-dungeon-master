# DSH Dungeon Master

**[简体中文](./README.md) | English** ｜ **[🤖 Agent Install & Migration Guide](./docs/AGENT_GUIDE.md)**

**An AI dungeon master that runs D&D 5e in QQ groups.** Forked from [tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot): send `/dnd start` in a group and the bot becomes that group's DM—dice, checks, initiative, grid positions, reactions, and HP are resolved deterministically by tools while the model focuses on narration.

QR binding, base configuration, and overall architecture follow upstream: see the **[upstream README](https://github.com/tencent-connect/dsh-qqbot#readme)**. Do not enable `@tencent-connect/dsh-qqbot` alongside this package in the same profile (both share the `im-qqbot` plugin ID).

---

## Quick Start

### 1. Install & Run

#### Option A: Copy Prompt for Your AI Agent (Recommended)

Paste this prompt to your AI coding assistant (DSH / Claude Code / Antigravity / Codex):

```text
Please install or upgrade the DSH plugin dsh-dungeon-master (plugin ID: im-qqbot) on my machine:
1. Read docs/AGENT_GUIDE.md first (if not present locally yet, read node_modules/dsh-dungeon-master/docs/AGENT_GUIDE.md after installation or https://github.com/SuperChipper/dsh-dungeon-master/blob/main/docs/AGENT_GUIDE.md), and strictly follow its guardrails.
2. Confirm my target DSH profile (default to web if unspecified), check Node (>= 20.3.0) and dsh versions, and if the conflicting package @tencent-connect/dsh-qqbot is installed in that profile, back up ~/.dsh/profiles/<profile>/cordis.patch.yml first and cleanly remove the old package while preserving credentials.
3. Install or upgrade (npm: dsh plugin --profile <profile> add dsh-dungeon-master; or build and link local source). If I am upgrading from <0.9.0 (0.8.x or earlier) to 0.9.x, verify the migration checklist inside AGENT_GUIDE, back up cordis.patch.yml before editing, and merge only the im-qqbot entry using a YAML parser.
4. Never print or echo appSecret, apiKey, or personal voice_id values, and never invent unconfirmed third-party gateway URLs, model IDs, or API key env var names.
5. Remind me to restart the dsh process once finished so the updated server bundle loads, then guide me through QR binding under DSH Web -> Plugins -> QQ Bot and running /bot-me, /bot-doctor, and /dnd start to verify.
```

See **[`docs/AGENT_GUIDE.md`](./docs/AGENT_GUIDE.md)** for full details (also bundled in the npm package).

`0.9.2+` bundles the [`/learn` skill](./skills/learn/SKILL.md) for reviewing and revising reusable notes. Existing `0.9.1` settings and notes require no migration.

#### Option B: Manual CLI Install

```bash
# Install from npm (recommended)
dsh plugin --profile web add dsh-dungeon-master

# Or build and mount from local source
pnpm install && pnpm build
npx @deepseek-ai/dsh plugin --profile qqbot add /path/to/dsh-dungeon-master
npx @deepseek-ai/dsh --profile qqbot
```

> **Strongly recommended: Enable PTC (Programmatic Tool Calling / Code mode) by default**
>
> Active D&D sessions perform heavy multi-step `dnd_*` tool calls (sheet lookups, pathfinding, multi-attacks, group saves, resources, and persistent zones). Enabling DSH's PTC executor (`@deepseek-ai/dsh-tool-executor-ptc` or a PTC-enabled preset) allows the model to batch tool calls in a single script execution—substantially reducing round-trips, turn latency, and prompt/token overhead.

- **Requirements**: `Node >= 20.3.0`, `DSH >= 0.1.0-rc.6 <1.0.0` (verified on `0.1.0-rc.8`, `0.2.0-rc.2`, `0.2.1-rc.5`, `0.2.2-rc.5`).
- **Optional dependencies**: `sharp` for PNG battle/fog-of-war maps; system `ffmpeg` / `ffprobe` for video analysis tools.
- **Upgrading & reloading changes**: After upgrading the package or running `pnpm build`, **restart the `dsh` process** so Node loads the new server bundle (refreshing the browser updates the client panel `lib/client.js` only, and reloading a profile does not invalidate Node's ESM module cache).

### 2. Start a Game in Three Steps

1. Run `dsh plugin --profile web add dsh-dungeon-master`, then open DSH Web **Plugins → QQ Bot** to bind via QR scan (or AppID / AppSecret).
2. Invite the bot to your QQ group. If you need owner approvals or full private-chat access, send `/bot-me` to the bot to copy your `openid` into **Owner openid** in Settings.
3. Send `/dnd start` in the group (posts check-in buttons; opens automatically once everyone checks in, or click **Start** to begin early), then `@bot` with your action—e.g. *"Kaes swings his greatsword at Goblin 3"* or *"Enzo sneaks to the door and listens"*.

No preset switch or separate session is needed: active campaigns inject compact DM rules + live state per turn, and `/dnd end` atomically pauses the campaign back into normal chat.

---

## 🎲 Campaigns

### Key Highlights

- **Tool-enforced rulings & hidden secrets**: HP, checks, saves, positions, and resources only mutate through `dnd_*` tools; DM notes, secret doors, and monster AC/HP/DC never leak in routine outputs or group chat (players see wound words only).
- **Ownership checks & PC delegation**: PCs bind to player openids with recent-sender checks. If a player is AFK, `dnd_character`'s `delegate` temporarily hands control to a teammate or to the DM (`delegate="dm"`) while keeping original ownership intact and preventing stalled reaction windows.
- **Full 5e combat engine**:
  - **Reaction windows**: Opportunity Attacks, `Shield`, `Counterspell` (auto-hold within 60 ft with deterministic `DC = 10 + spell level` checks), `Vicious Mockery`, and one-use button/verbal `authorization` tokens.
  - **Passives, auras & conditions**: Covers PHB conditions & exhaustion, transferable concentration (`Hex` / `Hunter's Mark` retained across kills and short rests), conditional passives (Colossus Slayer, Sneak Attack, Brutal Critical, etc.), Paladin/Cleric auras, Life Domain bonuses, and DM-only tactical caster hints.
  - **Spatial combat & batching**: 5-ft Dijkstra pathfinding, flight altitude and falls, persistent hazards, same-turn multi-attack `attacks`, and post-reaction `on_hit` spending. Opening formations support 5, 10, or 15 feet of preferred spacing and individual position corrections.
  - **Hot-registered custom rules (`dnd_rule`)**: Add campaign or global rules for attacks, riders, defenses, save modifiers, ongoing effects, auras, and healing. [Rule extension guide](./skills/dnd-rule-extension/SKILL.md)
- **Durable state & checkpoints**: Saves live as JSON with 40-step fine-grained rollback history plus dedicated milestone checkpoints (auto-saved on resume, combat start, and cross-site travel, or named manually via `dnd_undo` / `/dnd checkpoint` and restored in one step via `dnd_undo` / `/dnd undo`, even while paused); `/dnd end` runs an atomic pause + DM prep handoff state machine; persistent `PromptLatch` and `DndSnapshotGate` preserve KV cache across restarts and within multi-step turns.

### Common Commands

| Command | Description |
|---------|-------------|
| `/dnd start [module]` | Start or resume a campaign and post check-in buttons |
| `/dnd new [module] [blank]` | Archive current campaign and start fresh (keeps sheets unless `blank`) |
| `/dnd status` | Player-facing HP, resources, initiative order, and combat distances |
| `/dnd map [battle\|explore]` | Send combat grid map or explored fog-of-war map (`sharp`, else ASCII) |
| `/dnd checkpoint [name\|list]` | Save or list named rollback checkpoints (works while active or paused) |
| `/dnd undo [list\|N\|cp-id\|name]` | List sanitized undo records or jump back to a checkpoint / N steps |
| `/dnd checkin` / `/dnd end [recap]` | Re-send check-in buttons / atomically pause campaign & hand off |
| `/dnd combat` | Show dedicated combat agent route and cached/uncached token usage |
| `/dnd dungeons` / `/dnd search <term>` / `/dnd spells [class]` | List modules / query [Huiji D&D wiki](https://dnd.huijiwiki.com/wiki/) / list class spells |
| `/bot-me` | Show your `openid` (plus the group `openid` when sent in a group) for owner/allowlist setup |
| `/bot-doctor` | Run runtime diagnostics and dependency checks |

### Dedicated Combat Agent (Optional, Off by Default)

Disabled by default (runs on your main DSH model). Enable **Settings → Advanced D&D & Combat Agent → Dedicated combat agent** to delegate active combat turns to a separate model; the main DM handles initiative and opening narration, while the child resolves turns and narrates the closing round before handing updated state and ledger facts back.

```yaml
dnd:
  combatAgent:
    enabled: true
    provider: <your-provider-id>   # Must match a provider configured in DSH
    model: <your-model-id>         # Target model ID
    reasoningEffort: high
    contextChars: 8000
```

- **Scoped & safe**: The child agent receives combat `dnd_*` tools only—no shell, filesystem, or subagent access required.
- **Automatic fallback**: Falls back cleanly through `modelFailover` backups or the main DM route on provider errors without replaying committed actions.
- **Cost visibility**: `/dnd combat` reports token breakdown; private handoffs stay in `combat-runs/`.

### DM Tools Overview

| Group | Tools | Purpose |
|-------|-------|---------|
| Dice | `dnd_roll`, `dnd_check`, `dnd_apply` | Dice expressions, checks/attacks/group saves (`attacks`, `on_hit`, `bonus_dice`), batch damage/healing & reactions |
| Characters | `dnd_character`, `dnd_resource`, `dnd_rest` | Sheet CRUD (compact update diffs & incremental `append_notes`/`remove_notes`), player binding, `delegate`, NPC `companion_status` (`following`/`stationed`/`retired`), SRD monsters, slots/uses, zero-cost `transfer`, short/long rests |
| Rules | `dnd_rule` | Hot-register/manage `campaign` or `global` custom combat hooks with no-`eval` formulas |
| Combat | `dnd_initiative`, `dnd_position` | Initiative control & `rehearsal` sandbox, grid layout, `swap`, Dijkstra movement, 3D `z`, `area`, persistent `zone` |
| Story & Maps | `dnd_move`, `dnd_map`, `dnd_story`, `dnd_lookup`, `dnd_hook`, `dnd_chronicle` | Room navigation (cleared-dungeon fast travel, non-linear chapter sync & secret doors), map pushing, mutex triggers & caster `spellbook`/`escort` spawns, bounded `source` reader (3k-char cap), backstory hooks, long-term ledger (paused `ruling`/`backstory` adds) |
| Saves & SRD | `dnd_undo`, `dnd_progress`, `dnd_prepare`, `dnd_end`, `dnd_srd` | Named checkpoints & 40-step rollback (active/paused), incremental progress, private DM prep (with `brief` overview), atomic end/pause, 5e SRD queries |

### Modules, Config & Docs

- **Built-in *"The Sunken Bell Abbey"***: Original 7-room level 1–3 adventure; place custom JSON modules in `<dnd.root>/adventures/` for hot reload (do not commit commercial modules).
- **Zero overhead outside games**: Non-campaign chats never load `dnd_*` tools (~10k tokens saved); paused chats keep ledger/prep tools only.
- **Guides**: **[Module Authoring Guide](./skills/dnd-module-authoring/guide.md)** (ZH) ｜ **[`dnd-rule-extension` Skill](./skills/dnd-rule-extension/SKILL.md)** ｜ **[Long-Lived State Notes](./docs/dnd-long-lived-state.md)** (ZH)

| Config Key | Default | Description |
|------------|---------|-------------|
| `dnd.enabled` | `true` | Enable `/dnd` commands and `dnd_*` tools |
| `dnd.root` | `cwd/dnd` | Directory for saves (`campaigns/`) and modules |
| `dnd.turnButtons` | `true` | Attach turn action buttons on PC turns (falls back to text if denied) |
| `dnd.interjections` | `true` | Allow non-resolving banter replies during campaigns; off = `@`-only |

---

## ✨ Other Features & Security

Configurable in the DSH Web **Plugins** settings panel:

| Area | Summary |
|------|---------|
| 💬 Group chat | Reply probability & desire scoring, persisted group history & recent images, auto-compaction, `/new` summary inheritance (`/new blank` resets cleanly) |
| 🎭 Personas | Per-chat `/persona` switching with isolated per-persona history, incremental handoffs, preserved source model, and `scripts/check-persona-handoff-host.mjs` codec check |
| 🧠 Shared notes | Markdown memory library under `notes/` with BM25 recall, group-scoped `chat` notes, and owner `/bot-notes` inspection |
| 😺 Stickers & Art | Emotion-based saving (`qqbot_save_sticker`), hash matching, [`qqbot-sticker-maker`](./skills/qqbot-sticker-maker/SKILL.md), and [`qqbot-image-studio`](./skills/qqbot-image-studio/SKILL.md) |
| 🖼 Multimodal | Caption + media sending, native multimodal image input (when the main model supports image input), online TTS / configurable ASR, and whole-video keyframe review |
| 🔧 Utilities | Optional Bilibili read-only tools, fanart fetcher, reverse image search, external sing service (all `enabled: false` by default), plus `/bot-cleanup` |
| ⏰ Reliability | Scheduled-task migration on `/new` & persona switch, proactive retry queue, and `modelFailover` primary/backup failover |

### Permissions & Privacy

- **Fail-closed defaults**: Empty `allowlist` blocks everyone; `/model`, `/preset`, `/persona`, and approvals require `ownerOpenid` / `adminOpenids`.
- **Scoped chat tools (`toolAccess`, on by default)**: Restricted QQ groups have no shell or subagents; file access stays inside media, stickers, temp, and `toolAccess.readRoots`, always blocking `fileAccess.sensitivePaths`.
- **Granular group grants**: `qqbot_access(capability="image_gen", action="grant")` issues 10-minute owner approval cards per group (`imageGen.allowedGroups`); Bilibili login/subtitles stay private-owner/admin only.
- **Privacy hygiene**: Keep secrets in profile configs/env vars, avoid storing private data in shared `notes/`, and never commit `media/`, `stickers/`, `notes/`, `dnd/`, or `tmp/`.

---

## Credits & License

- Upstream: [tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot) (MIT) ｜ Host: [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- Monster & spell data: SRD 5.1 (Wizards of the Coast, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)) ｜ Rules reference: [Huiji D&D wiki](https://dnd.huijiwiki.com/wiki/) ｜ Bilibili inspiration: [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) (MIT)

[MIT](./LICENSE)
