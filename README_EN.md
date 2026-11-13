# DSH Dungeon Master

**[简体中文](./README.md) | English**

**An AI dungeon master that runs D&D 5e in QQ groups.** This is a fork of [tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot): send `/dnd start` in a group and the bot becomes that group's DM. Dice, checks, initiative, positions and hit points are all resolved by tools; the model only tells the story.

> Installation, QR-code binding, the base config options, built-in commands and the overall architecture are unchanged from upstream: see the **[upstream README](https://github.com/tencent-connect/dsh-qqbot#readme)**. This document is mostly about campaigns; the other additions are listed briefly [at the end](#other-features).

## Start a game in three steps

1. Install the plugin as described in [Running locally](#running-locally) and add the bot to a group.
2. Send `/dnd start` in the group. The message carries check-in buttons and the game opens when everyone is in; if someone can't make it, click "Start".
3. @ the bot and say what your character does: "Kaes swings his greatsword at goblin 3", "Enzo sneaks to the door and listens".

There is no preset switch and no new session: while a campaign is active, every turn gets two extra system prompts (the DM rules and a compact campaign state), and `/dnd end` returns the bot to normal chat.

---

## 🎲 Campaigns

### Design principles

- **Every ruling goes through a tool.** Dice, checks, damage, HP, conditions, positions and resources only change through `dnd_*` tools; the model cannot make up a roll.
- **Secrets stay out of reach.** DM notes and secret doors only appear in tool results, and `dnd_*` results are never shown in the group. Monster AC, HP and DCs are kept out of routine tool results and the campaign state too: those give only success or failure and a wound word (unhurt / lightly hurt / badly hurt / barely standing). When a ruling needs the numbers, the DM looks them up with `dnd_character show`.
- **Only a PC's own player can act for it.** PCs are bound to their player's openid. The tool also checks that this person really sent a message recently, so the model can't impersonate someone by copying an openid.
- **Strict turn order.** In combat only the creature whose turn it is can act, and only a PC's own player can end that PC's turn.
- **State lives in the save file, not in the model's memory.** The full state is one JSON file and each turn gets only a compact summary. Anything that has to survive context compaction, such as positions and pending reactions, is in that summary instead of relying on a paraphrased recap.
- **Wrong rulings can be rolled back.** Every change leaves a snapshot, and you can undo by step count or by roll number.

### Player commands

| Command | What it does |
|---------|--------------|
| `/dnd start [module id]` | Start a campaign (an earlier campaign in the same module resumes); the message carries check-in buttons and the game opens when everyone is in |
| `/dnd new [module id] [blank]` | Archive the old campaign and start fresh (keeps the old character sheets unless you add `blank`) |
| `/dnd status` | Campaign state from the players' point of view: HP, resources and initiative order, plus your distance to everyone in combat |
| `/dnd combat` | Latest combat-agent route and usage, with uncached input, cache reads/writes and output counted separately |
| `/dnd map [battle\|explore]` | Send the map: the battle map in combat, otherwise the fog-of-war map of what has been explored |
| `/dnd checkin` | Re-send the check-in buttons |
| `/dnd end [recap]` | Save a handoff and pause, preserving combat; saying you're stopping for tonight also works |
| `/dnd dungeons` | List available modules |
| `/dnd search <term>` | Look up the [Huiji D&D wiki](https://dnd.huijiwiki.com/wiki/) (spells, skills, classes, feats, monsters…) |
| `/dnd spells [class]` | A class's spell list |
| `/dnd help` | How to play |

### How a session runs

- **Declaring actions.** Only @-ing the bot and saying what your character does counts as an action. Chatting, rules questions and "show me the status" don't roll dice or use up your action. You can only control your own character.
- **Turn buttons.** When it's a PC's turn, the bot sends a message with buttons after the DM's reply.
  - **End turn** only works for the PC's own player; after the click the tool advances initiative and the DM resolves the monsters' turns.
  - **Status** is answered directly by the tool, without the model.
  - **My spells** lists the clicker's own spells and slots, each with a wiki link.
  - **Act** fills the character's name into the clicker's own input box.
  - The bot needs message-button permission on the QQ Open Platform. If sending buttons fails, they switch off for the rest of that run and the game continues in plain text.
- **Reaction windows.** When someone could react, an attack only rolls and is held as pending until that player answers (Shield, Vicious Mockery, a Chronal Shift reroll). If nobody answers, the DM skips them.
- **Splitting up.** Only the characters who said they're going move; everyone else stays put, and the map marks every occupied room with a head count.
- **Rollbacks.** If the table agrees something was resolved wrongly, say "roll back to before X". The DM restores a snapshot instead of patching numbers by hand.
- **Ending and resuming.** Pausing writes a handoff (location, what just happened, declared actions, who is with whom, loose ends, where to pick up). Initiative, positions and pending reactions are kept as they are, and the next `start` carries on. While paused, the bot doesn't spoil the module and checks the ledger before answering questions about the game.

### Dedicated combat agent (optional)

Enable **Settings → D&D → Dedicated combat agent** to hand combat to a separate model. It is off by default. The main DM rolls initiative and narrates the opening; after its reply, the child automatically prepares the map/positions and handles the current turn. Later player messages and buttons go directly to that persistent child. The default route is `opencode-go/deepseek-v4.1-flash`, reasoning `high`, with the latest 8,000 characters of dialogue plus party state and recorded table rulings. The full main conversation is not copied. Both DMs use the same campaign save. After combat, current state, spent resources and new ledger facts return to the main DM once.

```yaml
dnd:
  combatAgent:
    enabled: true
    provider: opencode-go
    model: deepseek-v4.1-flash
    reasoningEffort: high
    contextChars: 8000
```

The child has only combat-related `dnd_*` tools, without terminal, file or arbitrary delegation access; no terminal-whitelist grant is needed. Active child sessions resume after plugin reload. Startup/runtime failures return control to the main DM without replaying settled actions; `/new` releases the child. Per-encounter usage and handoffs are saved under `combat-runs/` in the D&D data directory. These files contain private DM material. `/dnd combat` exposes usage only, including the main DM's closing handoff response but excluding its pre-combat work. Use provider invoices for actual charges and compare ruling errors and rollbacks alongside token usage.

With delegation enabled, the main DM hides `dnd_position` and loads exploration-only `dnd_check` / `dnd_apply`, plus a start-only `dnd_initiative`. The child receives full attack/reaction/turn schemas and combat instructions. Exploration checks, group trap saves, healing, sheets and resources remain available to the main DM. During child control, all main-DM D&D tools are hidden. Failure or disabling delegation restores the full main-DM tools; older hosts without scoped tool overrides retain full definitions.

After building, save settings once to recompose the profile and load the new server code.

The handoff includes class/level, abilities, proficiencies/expertise, saves, base weapon attack/damage, spells, passive notes, reactions, resources, and every recorded `ruling`. Notes do not automatically become engine rules. After checking a sheet, use `dnd_character update init_bonus=7` to persist the **total fixed initiative modifier**; temporary dice such as Gift of Alacrity still belong in initiative `bonus`. This does not rewrite the current order. Update the total when abilities change, and persist table agreements with `dnd_chronicle add kind=ruling`.

`dnd_check type=save targets=[…]` rolls shared damage and individual saves, applying reduction, defenses and failure conditions. Each target can specify `bonus_dice="1d4"` for Bless without affecting other creatures. `dnd_apply targets=[{name,…}]` atomically applies damage, healing, temporary HP and conditions; `damage_roll` / `heal_roll` roll once for the batch, with per-target overrides and defenses. One undo reverts the whole batch. Character updates support `names=[…]`.

For a player-authorized "use Divine Smite if the final hit lands", pass `dnd_check on_hit={name:"Divine Smite",damage:"2d8",damage_type:"radiant",spend:"1环法术位"}`. Resources are spent once after defensive reactions; a final miss spends nothing. Critical hits double rider dice; weapon and rider defenses are applied separately before one combined HP change. `critical_only=true` requires explicit permission to spend only on a crit. This does not choose resources for the player after rolling. Multiple attacks, damage across rounds and post-hit player choices still use separate calls and stopping points. Ordinary `spend` still happens before rolling.

### Maps and combat positions

- **Positions in combat.** One square is 5 feet. Dijkstra paths around walls and enemy cells, doubles difficult-terrain costs, and prefers fewer opportunity triggers among equally short routes. Every step is checked; movement pauses before leaving reach or on entering Polearm Master reach, then resumes only after reactions resolve. The built-in reaction resource is 0/1 and resets at the actor's next turn; do not create a duplicate with `dnd_resource`. Shield persists until that turn. Room changes in combat require reaching the mapped exit first. Only actual forced movement/teleportation uses `set` or `dnd_character forced_move=true`.
- **Area spells.** Spheres, cubes and lines can be checked for which friends and foes they cover before casting.
- **Image maps** (need the optional dependency `sharp`). In combat the bot sends the current room's battle map with positions and coordinates, on the module's own art if it has any. Otherwise it sends the fog-of-war map of what has been explored, using the book's player map when there is one. Without `sharp` it falls back to a character map in chat.

### DM tools

| Group | Tool | What it does |
|-------|------|--------------|
| Dice | `dnd_roll` | Any dice expression (`2d6+3`, `4d6kh3`…) |
| | `dnd_check` | Checks, saves, attacks and death saves; per-target bonus dice and pre-authorized `on_hit` riders; reaction attacks spend a reaction; each roll gets a `#R` number |
| | `dnd_apply` | Single/batch damage, healing, temp HP and conditions; rolls shared amounts; resolves held dice, reactions and paused movement |
| Characters | `dnd_character` | Create/edit sheets (player binding, weapons, spell list, items and gold); `show` the current sheet before displaying/checking/editing it, confirm saved only after a successful write; while paused, create/edit/read PC sheets without removing them or changing rooms; `names` changes several characters at once (handing out items, moving rooms, `max_hp_change` for max HP); `srd=goblin count=3` adds monsters with real SRD stats |
| | `dnd_resource` | Spell slots, Lay on Hands, Bardic Inspiration, class feature uses; `set` also configures PC resources while paused |
| | `dnd_rest` | Short rest (the tool rolls hit dice) / long rest |
| Combat | `dnd_initiative` | Initiative start / next / goto / end / status; `surprised` creatures are skipped in round 1 by the tool |
| | `dnd_position` | Positions in combat: draw the battle map, place tokens, move within a turn, query distances, `area` for area spells |
| Exploration | `dnd_move` | Room movement (`who` for splitting up, secret-door discovery); returns the player-facing description plus DM secrets; `check_done` skips the exit check when it was already rolled with `dnd_check` |
| | `dnd_map` | Send the battle map or the fog-of-war map to the group |
| Story | `dnd_story` | Change story state written into the module, by id: triggers, facts, quests, whether an NPC is alive or travelling with the party |
| | `dnd_lookup` | Read module details (rooms, NPCs, clues), for the DM only; `kind=character` shows the party's sheets, also while paused |
| | `dnd_hook` | Backstory hooks: unresolved threads from a character's past sit on the PC sheet, remind the DM when a trigger word comes up, and escalate through 5 tiers |
| | `dnd_chronicle` | Long-term story ledger: improvised facts, promises, prisoners and loose ends, searchable by keyword; still available while paused |
| Saves | `dnd_undo` | List recent changes / undo N steps / take back one roll by number along with everything after it |
| | `dnd_progress` | Save progress without pausing, edited section by section |
| | `dnd_prepare` | Private DM prep: check the state against the handoff and save candidate plans; doesn't advance the story or post to the group |
| | `dnd_end` | Shares the save-and-pause operation with `/dnd end` |
| Lookup | `dnd_srd` | Look up 5e SRD monsters/spells (dnd5eapi.co) |

The tool layer also handles some rules automatically: PCs dropping to 0 HP and death saves, instant death from overflow damage, doubled dice on a crit, and Undead Fortitude. Manually removing "dead" is refused.

### Modules

- **Built-in "The Sunken Bell Abbey".** An original 7-room dungeon for 3–5 characters of level 1–3, playable in one evening. Monster stats are from SRD 5.1 (CC BY 4.0).
- **Writing your own.** Put JSON in `<dnd.root>/adventures/`: one file for a small module, one file per site for a large one. Files are re-read when they change, with no restart. A module can define chapters, sites, rooms, NPCs (including `knows`: what they know and what they don't), clues, quests, triggers and battle maps. The full format is in the **[module authoring guide](./skills/dnd-module-authoring/guide.md)** (Chinese).
- The old single-dungeon format (`dungeons/*.json`) still works.
- **Copyright.** Text converted from commercial modules (such as *Lost Mine of Phandelver*) stays on your own machine. Don't commit it to the repo.

### Data and configuration

- Each group has one save file, `<dnd.root>/campaigns/<chat>.json`, with change snapshots in `campaigns/history/` (the last 40 steps). Saves can only be changed through `dnd_*` tools; file tools cannot write to them.
- `dnd_*` tools are only visible to QQ chats that have a campaign. Chats without one don't carry them (saving roughly ten thousand tokens of tool definitions), a paused campaign keeps only the ledger, prep and handoff tools, and `/dnd start` makes all of them available.
- How state survives compaction and pauses, and the incidents that shaped it, is written up in the **[long-lived campaign state notes](./docs/dnd-long-lived-state.md)** (Chinese).

| Option | Default | Description |
|--------|---------|-------------|
| `dnd.enabled` | `true` | Campaigns on/off (`/dnd` command + `dnd_*` tools) |
| `dnd.root` | `cwd/dnd` | Data directory for saves and modules |
| `dnd.turnButtons` | `true` | Send turn buttons when it's a player's turn |
| `dnd.interjections` | `true` | Keep making random remarks during a campaign (remarks only, nothing is resolved); off means the bot only answers @ |

---

## Other features

Besides campaigns, this fork adds the following on top of upstream. Every option is documented on the QQ bot settings page under "Plugins" in DSH Web.

| Area | Contents |
|------|----------|
| 💬 Group chat | Joins in without an @ by probability or a reply-desire score; group messages are persisted and survive restarts; sees earlier images; merged messages keep each sender; automatic compaction when context grows too large; `/new` compacts the old session first and carries the summary into the new one (`/new blank` starts from nothing) |
| 🎭 Personas | The owner and admins can switch personas in groups and private chats using `/persona` (or `/人设`) buttons or `/persona name`. Each chat has its own selection and each persona keeps its history. Switches generate a shared handoff; restored personas receive only an unseen version. `/persona default` restores the corresponding `groupPrompt` / `directPrompt` |
| 🧠 Memory | A Markdown notes library under `notes/`, shared by every session and recalled by content; `chat`-scoped notes are visible only in their own group. The owner can send `/bot-notes` in a private chat to see what gets injected |
| 😺 Stickers | Saves stickers based on the bot's mood (`qqbot_save_sticker`), matches by hash (`qqbot_match_sticker`), a meme-recognition skill |
| 🖼 Media | Text and media in one message (`caption`), native image input via `deepseek-native`, voice recognition, whole-video understanding with keyframe review, audio transcription, images inside forwarded chat records |
| 🔧 Tools | Reverse image search, read-only Bilibili tools, fanart picker, Playwright browser (off by default, granted per group), agent temp directory and scheduled cleanup (`/bot-cleanup`) |
| ⏰ Schedules | Scheduled tasks migrate on `/new` and persona switches; failed proactive group messages are resent later |
| 🔁 Models | Upstream status monitoring with automatic primary/backup model switching (`modelFailover`, off by default) |
| 🧩 DSH integration | Install, enable and configure from the "Plugins" page in DSH Web; pet balance works with `deepseek-native` |

Persona handoffs are stored in `~/.dsh-qqbot/persona-handoffs/<chat-key-hash>.json`, isolated by app and group/private chat. Switching preserves the source session's actual selected model instead of reverting to a default. Handoffs summarize compacted context, uncovered dialogue and tool evidence, prioritizing user corrections and unfinished work. Long inputs save progress after each chunk so retries can resume. The target receives its own persona prompt and history, then the latest shared handoff before the new message; the previous persona's identity and style are not inherited. Versions, source, time, session/event coverage and per-persona receipts persist across restarts. Background task IDs and schedule migration definitions are retained separately with a reminder to check their status first. Failed generation preserves the previous handoff and saves uncovered records with an explicit warning. Incoming messages wait for the switch to finish; switching during a campaign remains disabled. After host upgrades, run `node scripts/check-persona-handoff-host.mjs [host package directory]` to validate durable messages offline against the installed V4 codec.

### Permissions

- An empty `allowlist` rejects everyone (fail-closed). `/model`, `/preset` and approval buttons only work for `ownerOpenid` / `adminOpenids`.
- **Per-chat tool limits** (`toolAccess`, on by default). The owner's private chat and allowlisted chats are unrestricted. Other QQ chats get no terminal and no sub-agents, and file tools can only touch media, the sticker library, the temp directory and `toolAccess.readRoots`. Local sessions (Web/Desktop) are unaffected.
- The owner can say "give group XX a terminal" in a private chat to allowlist it. In a group the model can only file a request, which the owner approves by clicking a button.
- Paths in `fileAccess.sensitivePaths` are always blocked for restricted chats, even inside `readRoots`. Allowlisted chats have a terminal anyway, so they are not blocked. With `toolAccess` turned off, the paths are blocked for every QQ chat.
- Bilibili login and subtitles are limited to the owner/admins in private chat. Reverse image search uploads the image to third-party services, so it is only called when a user explicitly asks for a source.

> Shared notes are visible to every session, so something said in a private chat can be recalled in a group. Don't have the bot remember private information, and the owner should review `notes/` from time to time.

## Running locally

> Do not enable alongside upstream `@tencent-connect/dsh-qqbot` in the same profile (both register the `im-qqbot` plugin ID).

```bash
# Install from npm (once published)
dsh plugin --profile web add dsh-dungeon-master

# Or build and mount from local source
pnpm install && pnpm build
npx @deepseek-ai/dsh plugin --profile qqbot add /path/to/dsh-dungeon-master
npx @deepseek-ai/dsh --profile qqbot
```

The plugin loads from `dist/`: after changing code, run `pnpm build` and **restart dsh** for it to take effect. Image maps need the optional dependency `sharp`, and the video tools need ffmpeg/ffprobe. Other installation methods are in the upstream README.

## Security and privacy

- Keep credentials in the profile's `cordis.patch.yml` or in environment variables, never in the repo.
- Runtime data stays out of the repo: `media/` (attachments from group and private chats, which may involve other people's privacy), `stickers/`, `notes/`, `dnd/`, `tmp/`.
- Check `git status --short` and `git diff --cached` before committing.

## Credits and license

- Upstream: [tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot) (MIT)
- Host: [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- Monster and spell data: System Reference Document 5.1 (Wizards of the Coast, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/))
- Rules reference: [Huiji D&D wiki](https://dnd.huijiwiki.com/wiki/)
- Bilibili API approach based on [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) (MIT)

[MIT](./LICENSE)
