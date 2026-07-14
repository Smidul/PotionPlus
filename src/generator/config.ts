import type {
  BrewMap,
  GeneratorConfig,
  ModifierConfig,
  ReagentCategory,
  ReagentConfig,
  ReagentReference,
} from './types.ts';

/** A modifier paired with its stable config ID. */
export interface NamedModifier {
  id: string;
  config: ModifierConfig;
}

/** Returns entries from an optional brew map in declaration order. */
export function brewEntries(brew?: BrewMap): [string, ReagentConfig][] {
  return Object.entries(brew ?? {});
}

function modifiersWith(
  config: GeneratorConfig,
  key: 'variant_transform' | 'container_conversion' | 'global',
): NamedModifier[] {
  return Object.entries(config.modifiers)
    .filter(([, modifier]) => Boolean(modifier[key]))
    .map(([id, modifier]) => ({ id, config: modifier }));
}

/** Returns modifiers that define same-form potion variant changes. */
export function variantModifiers(config: GeneratorConfig): NamedModifier[] {
  return modifiersWith(config, 'variant_transform');
}

/** Returns modifiers that change potion container forms. */
export function containerModifiers(config: GeneratorConfig): NamedModifier[] {
  return modifiersWith(config, 'container_conversion');
}

/** Returns output-preserving modifiers such as the particle-hiding modifier. */
export function globalModifiers(config: GeneratorConfig): NamedModifier[] {
  return modifiersWith(config, 'global');
}

/** Looks up a modifier and throws a useful configuration error when missing. */
export function getModifier(config: GeneratorConfig, id: string): ModifierConfig {
  const modifier = config.modifiers[id];
  if (!modifier) throw new Error(`Unknown modifier: ${id}`);
  return modifier;
}

/** Creates the default singular path used by a reagent tag. */
export function reagentTagPath(category: ReagentCategory, id: string): string {
  return `${category}/${id}`;
}

function addBrewReagents(entries: ReagentReference[], category: ReagentCategory, id: string, brew?: BrewMap): void {
  for (const reagent of Object.values(brew ?? {}))
    entries.push({ category, id, config: reagent });
}

/**
 * Collects every base, effect, and modifier reagent before generation starts.
 * Pre-registration lets tags reference each other regardless of recipe order.
 */
export function reagentCatalog(config: GeneratorConfig): ReagentReference[] {
  const entries: ReagentReference[] = [];

  for (const [id, base] of Object.entries(config.bases))
    addBrewReagents(entries, 'base', id, base.brew);

  for (const [id, effect] of Object.entries(config.custom.effects))
    addBrewReagents(entries, 'effect', id, effect.brew);

  for (const [id, potion] of Object.entries(config.vanilla.potions))
    addBrewReagents(entries, 'effect', id, potion.brew);

  for (const [id, modifier] of Object.entries(config.modifiers))
    entries.push({ category: 'modifier', id, config: modifier.reagent });

  return entries;
}

/**
 * Returns every potion ID accepted by vanilla container conversions. This is
 * derived from the configured states, so no duplicate convertible list exists.
 */
export function vanillaConvertiblePotions(config: GeneratorConfig): string[] {
  return ['water', ...Object.keys(config.bases), ...Object.keys(config.vanilla.potions)].sort();
}
