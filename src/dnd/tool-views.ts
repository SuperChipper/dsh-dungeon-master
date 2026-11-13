/** 主 DM 保留探索所需的同名工具，完整战斗参数只给战斗代理。执行仍委托原处理器。 */
export interface DndToolDefinition {
  name: string;
  description: string;
  parameters: { type: string; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  output: unknown;
  execute(args: unknown, exec: never): Promise<unknown>;
}

const NARRATIVE_VIEWS: Record<string, { keys: string[]; description: string; types?: string[] }> = {
  dnd_check: {
    keys: ['character', 'type', 'skill', 'ability', 'dc', 'targets', 'on_save', 'on_fail_conditions', 'defense', 'damage', 'damage_type', 'advantage', 'bonus', 'bonus_dice', 'spend', 'secret', 'declared_by', 'dm_override'],
    types: ['skill', 'ability', 'save', 'death'],
    description: 'Exploration skill/ability checks, saves, traps and death saves; roll honestly, keep DCs secret. For a save effect use targets, dc and damage (rolled once), with per-target bonus_dice/defense and failure conditions. Player-declared actions need declared_by; spend consumes before rolling. Attacks, reactions and combat positioning belong to the combat agent: start with dnd_initiative, then stop and let it take over.',
  },
  dnd_apply: {
    keys: ['target', 'targets', 'damage', 'damage_roll', 'heal', 'heal_roll', 'temp_hp', 'damage_type', 'defense', 'crit', 'add_conditions', 'remove_conditions'],
    description: 'Apply already-decided damage/healing, temporary HP or conditions during exploration. target for one, targets=[{name,...}] for an atomic batch. damage_roll/heal_roll roll once; per-target values override defaults. Do not use this to simulate attacks or resolve combat reactions; the combat agent owns those.',
  },
  dnd_initiative: {
    keys: ['action', 'participants', 'room', 'bonus', 'surprised'],
    description: 'Start combat for the combat agent. action=start; give participants, room and surprised as appropriate. Check each sheet: init_bonus is the fixed TOTAL, temporary dice go in bonus={name:"1d8"}; never add a fixed bonus twice. After success, narrate the opening and stop; the combat agent prepares positions and handles all turns/reactions automatically after your reply.',
  },
};

export function narrativeTool(full: DndToolDefinition): DndToolDefinition | undefined {
  const view = NARRATIVE_VIEWS[full.name];
  if (view === undefined) return undefined;
  const properties = Object.fromEntries(view.keys.filter((key) => key in full.parameters.properties).map((key) => [key, full.parameters.properties[key]]));
  if (view.types !== undefined) properties.type = { type: 'string', enum: view.types };
  if (full.name === 'dnd_initiative') properties.action = { type: 'string', enum: ['start'] };
  return {
    ...full, description: view.description, parameters: { ...full.parameters, properties },
    async execute(args, exec) {
      const input = (args ?? {}) as Record<string, unknown>;
      if (Object.keys(input).some((key) => !view.keys.includes(key))
        || (view.types !== undefined && !view.types.includes(String(input.type)))
        || (full.name === 'dnd_initiative' && input.action !== 'start')) {
        throw new Error('主 DM 只负责探索和开战；战斗、反应与回合结算交给战斗代理，不能用旧参数绕过工具分工');
      }
      return full.execute(args, exec);
    },
  };
}

export const NARRATIVE_TOOL_OVERRIDES = Object.keys(NARRATIVE_VIEWS);
export type DndToolView = 'full' | 'narrative' | 'waiting';
