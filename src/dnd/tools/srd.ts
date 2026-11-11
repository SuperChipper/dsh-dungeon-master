/** 规则查询：dnd_srd。 */
import { candidatesText } from '../srd-lookup.ts';
import {
lookupSrd,formatSrd,type ToolKit
} from './shared.ts';

export function registerSrdTools(kit: ToolKit): void {
  const { register } = kit;

  register(
    'dnd_srd',
    'Look up official 5e SRD data (monster stat block or spell) from dnd5eapi.co. `index` takes the SRD slug '
    + '("goblin", "fire-bolt"), the English name, or a common Chinese name (地精, 火球术); typos, case and '
    + 'spaces/hyphens are tolerated. When several entries fit, it lists candidates: pick one index and call again.',
    {
      kind: { type: 'string', enum: ['monster', 'spell'] },
      index: { type: 'string', description: 'Slug, English name or Chinese name.' },
    },
    ['kind', 'index'],
    async (args) => {
      const kind = args.kind === 'spell' ? 'spells' : 'monsters';
      const query = String(args.index ?? '');
      const found = await lookupSrd(kind, query);
      if ('candidates' in found) return candidatesText(query, found.candidates);
      return `${found.note !== undefined ? `${found.note}\n` : ''}${formatSrd(kind, found.data)}`;
    },
  );
}
