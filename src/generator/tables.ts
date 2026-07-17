import type {
  BrewMap,
  GeneratorConfig,
  PotionSource,
  PotionState,
  ReagentConfig,
} from './types.ts';
import { coordinateName, variantAxisNames } from './variants.ts';
import { basePotionKey, resourcePath, writeText } from './utils.ts';

interface TableFamily {
  display: string;
  brew?: BrewMap;
}

function titleCase(value: string): string {
  return value
    .replaceAll('_', ' ')
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

function itemDisplayName(config: GeneratorConfig, item: string): string {
  const configured = config.generator.tables?.ingredient_names?.[item];
  if (configured) return configured;
  return titleCase(resourcePath(item)).replace(/\b(Of|The|And)\b/g, word => word.toLowerCase());
}

function reagentItems(reagent: ReagentConfig | undefined): string[] {
  return reagent?.items ?? [];
}

function modifierItems(config: GeneratorConfig, modifier: string | undefined): string[] {
  return modifier ? reagentItems(config.modifiers[modifier]?.reagent) : [];
}

function directIngredients(family: TableFamily): string[] {
  return Object.values(family.brew ?? {}).flatMap(reagent => reagent.items);
}

function transformedIngredients(config: GeneratorConfig, source: PotionSource, family: string): string[] {
  if (source === 'custom') {
    return (config.custom.cross_effect_transforms ?? [])
      .filter(transform => transform.to_effect === family)
      .flatMap(transform => modifierItems(config, transform.modifier));
  }

  return (config.vanilla.cross_effect_transforms ?? [])
    .filter(transform => basePotionKey(transform.to) === family)
    .flatMap(transform => modifierItems(config, transform.modifier));
}

function familyIngredients(
  config: GeneratorConfig,
  source: PotionSource,
  family: string,
  definition: TableFamily,
): string {
  const direct = directIngredients(definition),
   values = [...new Set(direct.length ? direct : transformedIngredients(config, source, family))];
  return values.length ? values.map(item => itemDisplayName(config, item)).join('<br>') : '-';
}

function roman(value: number): string {
  if (!Number.isInteger(value) || value <= 0) return String(value);
  const numerals: [number, string][] = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
    [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
    [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let remaining = value,
   result = '';
  for (const [amount, symbol] of numerals) {
    while (remaining >= amount) {
      result += symbol;
      remaining -= amount;
    }
  }
  return result;
}

function durationText(ticks: number): string {
  const totalSeconds = Math.round(ticks / 20),
   minutes = Math.floor(totalSeconds / 60),
   seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function effectName(effectId: string): string {
  return titleCase(resourcePath(effectId));
}

function stateText(state: PotionState): string {
  const instant = state.effects.every(effect =>
    ['instant_damage', 'instant_health'].includes(resourcePath(String(effect.id))),
  );

  if (state.effects.length === 1) {
    const effect = state.effects[0],
     level = roman(Number(effect.amplifier ?? 0) + 1);
    return instant ? level : `${level} (${durationText(Number(effect.duration ?? 1))})`;
  }

  const sameDuration = state.effects.every(effect => effect.duration === state.effects[0]?.duration),
   effects = state.effects.map(effect =>
     `${effectName(String(effect.id))} ${roman(Number(effect.amplifier ?? 0) + 1)}`,
   ).join(' + ');
  if (instant) return effects;
  if (sameDuration) return `${effects} (${durationText(Number(state.effects[0]?.duration ?? 1))})`;
  return state.effects.map(effect =>
    `${effectName(String(effect.id))} ${roman(Number(effect.amplifier ?? 0) + 1)} (${durationText(Number(effect.duration ?? 1))})`,
  ).join(' / ');
}

function displayState(state: PotionState, underlineExisting: boolean): string {
  const value = stateText(state);
  return underlineExisting && state.source === 'vanilla' && state.registeredPotion
    ? `<u>${value}</u>`
    : value;
}

function stateIndex(states: Iterable<PotionState>): Map<string, Map<string, PotionState>> {
  const result = new Map<string, Map<string, PotionState>>();
  for (const state of states) {
    if (!state.family || !state.variant) continue;
    let family = result.get(state.family);
    if (!family) result.set(state.family, family = new Map());
    family.set(state.variant, state);
  }
  return result;
}

function columnCell(
  config: GeneratorConfig,
  familyStates: Map<string, PotionState> | undefined,
  amplifierIndex: number,
  underlineExisting: boolean,
): string {
  if (!familyStates) return '-';
  const values = variantAxisNames(config, 'duration')
    .map((_, durationIndex) => familyStates.get(coordinateName(config, durationIndex, amplifierIndex)))
    .filter((state): state is PotionState => Boolean(state))
    .map(state => displayState(state, underlineExisting));
  return values.length ? values.join('<br>') : '-';
}

function tableSection(
  config: GeneratorConfig,
  source: PotionSource,
  states: Map<string, PotionState>,
): string {
  const settings = config.generator.tables ?? {},
   includeIngredients = settings.include_ingredients ?? true,
   underlineExisting = settings.underline_existing ?? true,
   title = settings.titles?.[source] ?? (source === 'custom' ? 'Overbrew Potions' : 'Vanilla Potions'),
   families: Record<string, TableFamily> = source === 'custom'
     ? config.custom.effects
     : config.vanilla.potions,
   indexed = stateIndex(states.values()),
   amplifierNames = variantAxisNames(config, 'amplifier'),
   headers = [
     'Potion',
     ...(includeIngredients ? ['Ingredient'] : []),
     ...amplifierNames.map((name, index) => index === 0 ? 'Regular' : titleCase(name)),
   ],
   rows = Object.entries(families).map(([family, definition]) => {
     const values = [
       definition.display,
       ...(includeIngredients ? [familyIngredients(config, source, family, definition)] : []),
       ...amplifierNames.map((_, index) => columnCell(config, indexed.get(family), index, underlineExisting)),
     ];
     return `| ${values.join(' | ')} |`;
   });

  return [
    `## ${title}`,
    '',
    'Each cell lists the Regular, Long, and Prolonged duration tiers from top to bottom.',
    ...(source === 'vanilla' && underlineExisting
      ? ['Potion variants already available in vanilla are <u>underlined</u>.']
      : []),
    '',
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows,
  ].join('\n');
}

/** Generates Markdown tables from the resolved custom and vanilla potion graphs. */
export async function writePotionTables(
  config: GeneratorConfig,
  outputPath: string,
  custom: Map<string, PotionState>,
  vanilla: Map<string, PotionState>,
): Promise<number> {
  const settings = config.generator.tables ?? {},
   sources = settings.sources ?? ['custom', 'vanilla'],
   stateMaps: Record<PotionSource, Map<string, PotionState>> = { custom, vanilla },
   sections = sources.map(source => tableSection(config, source, stateMaps[source]));
  await writeText(outputPath, `${sections.join('\n\n')}\n`);
  return sections.length;
}
