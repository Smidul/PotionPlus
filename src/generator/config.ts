import type {
  AutoAdjustModifierConfig,
  AutoAdjustStrategy,
  BrewMap,
  GeneratorConfig,
  JsonObject,
  ModifierConfig,
  ResolvedPotionMatchingConfig,
  ReagentCategory,
  ReagentConfig,
  ReagentReference,
} from './types.ts';
import { vanillaVariantDefinitions } from './variants.ts';


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
  key: 'container_conversion' | 'global',
): NamedModifier[] {
  return Object.entries(config.modifiers)
    .filter(([, modifier]) => Boolean(modifier[key]))
    .map(([id, modifier]) => ({ id, config: modifier }));
}

/** Returns modifiers that define same-form potion variant changes. */
export function variantModifiers(config: GeneratorConfig): NamedModifier[] {
  return Object.entries(config.modifiers)
    .filter(([, modifier]) => Boolean(modifier.variant_axis))
    .map(([id, modifier]) => ({ id, config: modifier }));
}

/** Returns modifiers that change potion container forms. */
export function containerModifiers(config: GeneratorConfig): NamedModifier[] {
  return modifiersWith(config, 'container_conversion');
}

/** Returns output-preserving modifiers such as the particle-hiding modifier. */
export function globalModifiers(config: GeneratorConfig): NamedModifier[] {
  return modifiersWith(config, 'global');
}

/** Returns the logical forms selected by one global modifier. */
export function globalModifierForms(config: GeneratorConfig, modifier: ModifierConfig): string[] {
  const configured = modifier.global?.apply_to_forms ?? Object.keys(config.forms),
   forms = [...new Set(configured)];
  for (const form of forms)
    if (!config.forms[form]) throw new Error(`Unknown form in global modifier: ${form}`);
  return forms;
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
 * Returns every effectless base-potion ID declared by the config, including
 * both base outputs and the inputs used to brew them.
 */
export function configuredBasePotionIds(config: GeneratorConfig): string[] {
  const ids = new Set(Object.keys(config.bases));
  for (const base of Object.values(config.bases))
    Object.keys(base.brew ?? {}).forEach(id => ids.add(id));
  return [...ids].sort();
}

/** Returns every registered vanilla potion type declared or inferred by family states. */
export function registeredVanillaPotionTypes(config: GeneratorConfig): string[] {
  const potions = Object.keys(config.vanilla.potions).flatMap(family =>
    Object.values(vanillaVariantDefinitions(config, family))
      .flatMap(definition => definition.potion ? [definition.potion] : []),
  );
  return [...new Set(potions)].sort();
}

/** Returns every potion ID accepted by vanilla container conversions. */
export function vanillaConvertiblePotions(config: GeneratorConfig): string[] {
  const registered = registeredVanillaPotionTypes(config).map(potion => potion.split(':', 2).at(-1) ?? potion);
  return [...new Set([...configuredBasePotionIds(config), ...registered])].sort();
}
const MAX_AUTO_ADJUST_NESTING = 16;
const potionMatchingCache = new WeakMap<GeneratorConfig, ResolvedPotionMatchingConfig>();

type PotionTypeStrategy = Extract<AutoAdjustStrategy, { type: 'potion_type' }>;

function strategyPriority(strategy: AutoAdjustStrategy, index: number): number {
  return strategy.priority === undefined ? 1_000 + index : Number(strategy.priority);
}

function strategyChildren(strategy: AutoAdjustStrategy): AutoAdjustStrategy[] {
  return strategy.type === 'potion_type' || strategy.type === 'add_effect'
    ? strategy.strategies ?? []
    : [];
}

function walkStrategies(strategies: AutoAdjustStrategy[]): AutoAdjustStrategy[] {
  return strategies.flatMap(strategy => [strategy, ...walkStrategies(strategyChildren(strategy))]);
}

function mapStrategyTree(
  strategies: AutoAdjustStrategy[],
  transform: (strategy: AutoAdjustStrategy) => AutoAdjustStrategy[],
): AutoAdjustStrategy[] {
  return strategies.flatMap(strategy => {
    const clone = structuredClone(strategy);
    if (clone.type === 'potion_type' || clone.type === 'add_effect') {
      const children = mapStrategyTree(strategyChildren(strategy), transform);
      clone.strategies = children.length ? children : undefined;
    }
    return transform(clone);
  });
}

function validateEffectSelection(value: unknown, path: string): void {
  if (value === undefined || value === 'all' || value === 'first') return;
  if (Array.isArray(value) && value.every(index => Number.isInteger(index) && index >= 0)) return;
  throw new Error(`${path}.effects must be "all", "first", or an array of non-negative indexes`);
}

function normalizeAutoAdjustStrategy(
  strategy: AutoAdjustStrategy,
  index: number,
  listPath: string,
  depth: number,
): AutoAdjustStrategy {
  const path = `${listPath}[${index}]`;
  if (!strategy || typeof strategy !== 'object' || Array.isArray(strategy))
    throw new Error(`${path} must be an object`);
  if (!['duration', 'amplifier', 'ambient', 'visible', 'potion_type', 'add_effect'].includes(strategy.type))
    throw new Error(`${path}.type is unknown: ${String((strategy as { type?: unknown }).type)}`);
  if (strategy.priority !== undefined && !Number.isFinite(strategy.priority))
    throw new Error(`${path}.priority must be a finite number`);
  validateEffectSelection(strategy.effects, path);

  const normalized = structuredClone(strategy);
  if (normalized.type === 'duration' || normalized.type === 'amplifier') {
    if (normalized.prefer !== undefined && !['increase', 'decrease'].includes(normalized.prefer))
      throw new Error(`${path}.prefer must be "increase" or "decrease"`);
    if (normalized.algorithm !== undefined && !['single', 'minimal', 'balanced'].includes(normalized.algorithm))
      throw new Error(`${path}.algorithm must be "single", "minimal", or "balanced"`);
    if (normalized.order !== undefined && !['effect_first', 'direction_first'].includes(normalized.order))
      throw new Error(`${path}.order must be "effect_first" or "direction_first"`);
    for (const key of ['max_delta', 'max_total_delta', 'max_changed_effects', 'max_candidates'] as const) {
      const value = normalized[key];
      if (value !== undefined && (!Number.isInteger(value) || value < 0))
        throw new Error(`${path}.${key} must be a non-negative integer`);
    }
    if (normalized.max_candidates === 0)
      throw new Error(`${path}.max_candidates must be greater than zero`);
  } else if (normalized.type === 'potion_type') {
    if (!Array.isArray(normalized.potions) || !normalized.potions.length ||
        !normalized.potions.every(potion => typeof potion === 'string' && potion.trim()))
      throw new Error(`${path}.potions must be a non-empty array of potion IDs`);
    normalized.potions = [...new Set(normalized.potions.map(potion => potion.trim()))];
    if (normalized.include_original !== undefined && typeof normalized.include_original !== 'boolean')
      throw new Error(`${path}.include_original must be a boolean`);
  } else if (normalized.type === 'add_effect') {
    if (!normalized.effect || typeof normalized.effect !== 'object' || Array.isArray(normalized.effect))
      throw new Error(`${path}.effect must be an effect object`);
    if (typeof normalized.effect.id !== 'string' || !normalized.effect.id)
      throw new Error(`${path}.effect.id must be a non-empty effect ID`);
    if (normalized.inherit_parent_strategies !== undefined &&
        typeof normalized.inherit_parent_strategies !== 'boolean')
      throw new Error(`${path}.inherit_parent_strategies must be a boolean`);
  }

  if ((normalized.type === 'potion_type' || normalized.type === 'add_effect') &&
      normalized.strategies !== undefined)
    normalized.strategies = orderAutoAdjustStrategies(normalized.strategies, `${path}.strategies`, depth + 1);
  return normalized;
}

function orderAutoAdjustStrategies(
  strategies: AutoAdjustStrategy[],
  path: string,
  depth: number,
): AutoAdjustStrategy[] {
  if (!Array.isArray(strategies)) throw new Error(`${path} must be an array`);
  if (depth > MAX_AUTO_ADJUST_NESTING)
    throw new Error(`${path} exceeds the maximum nesting depth of ${MAX_AUTO_ADJUST_NESTING}`);

  return strategies
    .map((strategy, index) => ({ strategy: normalizeAutoAdjustStrategy(strategy, index, path, depth), index }))
    .sort((left, right) =>
      strategyPriority(left.strategy, left.index) - strategyPriority(right.strategy, right.index) ||
      left.index - right.index,
    )
    .map(entry => entry.strategy);
}

function potionTypeStrategies(strategies: AutoAdjustStrategy[]): PotionTypeStrategy[] {
  return walkStrategies(strategies).filter(
    (strategy): strategy is PotionTypeStrategy => strategy.type === 'potion_type',
  );
}

function normalizedPotionType(config: GeneratorConfig, potion: string): string {
  return potion.includes(':') ? potion : `${config.generator.namespaces.vanilla}:${potion}`;
}

/** Returns configured effects for one known potion type, or `null` when it is not modeled by the config. */
export function configuredPotionEffects(config: GeneratorConfig, potion: string): JsonObject[] | null {
  if (potion.startsWith('#')) return null;
  const resolved = normalizedPotionType(config, potion),
   [namespace] = resolved.split(':', 2);
  if (namespace !== config.generator.namespaces.vanilla) return null;
  if (configuredBasePotionIds(config).some(id => normalizedPotionType(config, id) === resolved)) return [];

  for (const family of Object.keys(config.vanilla.potions)) {
    for (const definition of Object.values(vanillaVariantDefinitions(config, family))) {
      if (!definition.potion || normalizedPotionType(config, definition.potion) !== resolved) continue;
      return definition.effects;
    }
  }
  return null;
}

function assertEffectlessPotionType(config: GeneratorConfig, potion: string, path: string): string {
  const resolved = normalizedPotionType(config, potion),
   effects = configuredPotionEffects(config, resolved);
  if (effects === null)
    throw new Error(
      `${path} uses ${potion}, which is not modeled under bases or vanilla.potions. ` +
      'Potion types are fixed registry entries, so add the registered type to the config model before using it.',
    );
  if (effects.length)
    throw new Error(`${path} uses ${potion}, but automatic potion-type identities must have no built-in effects.`);
  return resolved;
}

interface FilteredStrategySet {
  strategies: AutoAdjustStrategy[];
  skippedPotionTypes: Set<string>;
}

/**
 * Removes potion-type identities when vanilla recipes are not regenerated.
 * Their nested fallbacks are promoted so duration and effect strategies remain usable.
 */
function filterUnavailablePotionTypes(
  config: GeneratorConfig,
  strategies: AutoAdjustStrategy[],
): FilteredStrategySet {
  if (config.generator.include_vanilla_recipes ?? true)
    return { strategies, skippedPotionTypes: new Set() };

  const skippedPotionTypes = new Set<string>();
  const filtered = mapStrategyTree(strategies, strategy => {
    if (strategy.type !== 'potion_type') return [strategy];
    for (const potion of strategy.potions)
      skippedPotionTypes.add(normalizedPotionType(config, potion));
    return strategyChildren(strategy);
  });
  return { strategies: orderedAutoAdjustStrategies(filtered), skippedPotionTypes };
}

function validatePotionTypeStrategies(
  config: GeneratorConfig,
  strategies: AutoAdjustStrategy[],
  path: string,
): void {
  for (const strategy of potionTypeStrategies(strategies))
    strategy.potions.forEach((potion, index) =>
      assertEffectlessPotionType(config, potion, `${path}.potion_type[${index}]`));
}

/** Returns a stable priority-ordered clone of automatic adjustment strategies. */
export function orderedAutoAdjustStrategies(strategies: AutoAdjustStrategy[]): AutoAdjustStrategy[] {
  return orderAutoAdjustStrategies(
    strategies,
    'generator.potion_matching.auto_adjust_effects.strategies',
    0,
  );
}

function resolvePotionMatchingOptions(config: GeneratorConfig): ResolvedPotionMatchingConfig {
  const matching = config.generator.potion_matching ?? {},
   fields = matching.effect_fields ?? {},
   autoAdjust = matching.auto_adjust_effects ?? {},
   includeVanilla = config.generator.include_vanilla_recipes ?? true;

  if (matching.default_potion_type !== undefined && matching.default_potion_type !== null &&
      (typeof matching.default_potion_type !== 'string' || !matching.default_potion_type.trim()))
    throw new Error('generator.potion_matching.default_potion_type must be a potion ID or null');

  for (const modifierId of Object.keys(autoAdjust.modifiers ?? {})) {
    if (!config.modifiers[modifierId]?.global)
      throw new Error(
        `generator.potion_matching.auto_adjust_effects.modifiers.${modifierId} must reference a global modifier`,
      );
  }

  const defaultPotionType = matching.default_potion_type == null
    ? null
    : assertEffectlessPotionType(
      config,
      matching.default_potion_type.trim(),
      'generator.potion_matching.default_potion_type',
    );
  if (defaultPotionType && !includeVanilla)
    throw new Error(
      'generator.potion_matching.default_potion_type requires generator.include_vanilla_recipes so recipes for ' +
      'that base can reject effect-bearing identity potions with effects.size = 0.',
    );

  const sharedEnabled = autoAdjust.enabled ?? true,
   sharedFiltered = filterUnavailablePotionTypes(
    config,
    orderedAutoAdjustStrategies(autoAdjust.strategies ?? []),
   ),
   strategies = sharedFiltered.strategies,
   skippedPotionTypes = new Set<string>(),
   resolvedModifiers: Record<string, boolean | AutoAdjustModifierConfig> = {},
   activeStrategySets: { strategies: AutoAdjustStrategy[]; path: string }[] = [];

  for (const [modifierId, override] of Object.entries(autoAdjust.modifiers ?? {})) {
    if (typeof override === 'boolean') {
      resolvedModifiers[modifierId] = override;
      continue;
    }
    const resolvedOverride = structuredClone(override ?? {});
    if (resolvedOverride.strategies) {
      const filtered = filterUnavailablePotionTypes(
        config,
        orderedAutoAdjustStrategies(resolvedOverride.strategies),
      );
      resolvedOverride.strategies = filtered.strategies;
      filtered.skippedPotionTypes.forEach(potion => skippedPotionTypes.add(potion));
    }
    resolvedModifiers[modifierId] = resolvedOverride;
  }

  let sharedStrategiesUsed = sharedEnabled;
  if (sharedEnabled)
    activeStrategySets.push({
      strategies,
      path: 'generator.potion_matching.auto_adjust_effects.strategies',
    });

  for (const [modifierId, override] of Object.entries(resolvedModifiers)) {
    const enabled = typeof override === 'boolean' ? override : override.enabled ?? sharedEnabled;
    if (!enabled) continue;
    const ownStrategies = typeof override === 'object' && override.strategies;
    if (!ownStrategies) sharedStrategiesUsed = true;
    activeStrategySets.push({
      strategies: ownStrategies || strategies,
      path: ownStrategies
        ? `generator.potion_matching.auto_adjust_effects.modifiers.${modifierId}.strategies`
        : 'generator.potion_matching.auto_adjust_effects.strategies',
    });
  }


  if (sharedStrategiesUsed)
    sharedFiltered.skippedPotionTypes.forEach(potion => skippedPotionTypes.add(potion));

  if (defaultPotionType === null && activeStrategySets.some(
    entry => potionTypeStrategies(entry.strategies).length,
  ))
    throw new Error(
      'generator.potion_matching.default_potion_type cannot be null while an enabled potion_type strategy is configured. ' +
      'An effects-only legacy matcher would also accept the typed output, so changing only the conflicting output cannot isolate it.',
    );

  const protectedPotionTypes = new Set<string>();
  if (defaultPotionType) protectedPotionTypes.add(defaultPotionType);
  const validated = new Set<string>();
  for (const entry of activeStrategySets) {
    const key = `${entry.path}:${JSON.stringify(entry.strategies)}`;
    if (validated.has(key)) continue;
    validated.add(key);
    validatePotionTypeStrategies(config, entry.strategies, entry.path);
    for (const strategy of potionTypeStrategies(entry.strategies))
      strategy.potions.forEach(potion => protectedPotionTypes.add(normalizedPotionType(config, potion)));
  }

  const warnings = skippedPotionTypes.size
    ? [
      `Potion-type conflict resolution skipped ${[...skippedPotionTypes].sort().join(', ')} because ` +
      'generator.include_vanilla_recipes is false. Enable vanilla recipe generation to guard those base recipes ' +
      'with effects.size = 0. Generation will continue with the remaining strategies.',
    ]
    : [];

  return {
    detect_conflicts: matching.detect_conflicts ?? true,
    check_tag_overlaps: matching.check_tag_overlaps ?? true,
    default_potion_type: defaultPotionType,
    protected_potion_types: [...protectedPotionTypes].sort(),
    warnings,
    effect_fields: {
      duration: fields.duration ?? true,
      amplifier: fields.amplifier ?? true,
      ambient: fields.ambient ?? true,
      visible: fields.visible ?? true,
    },
    auto_adjust_effects: {
      enabled: sharedEnabled,
      strategies,
      modifiers: resolvedModifiers,
    },
  };
}

/**
 * Resolves and caches potion-matching settings. Treat the loaded config as
 * immutable after the first call, as generation already does.
 */
export function potionMatchingOptions(config: GeneratorConfig): ResolvedPotionMatchingConfig {
  const cached = potionMatchingCache.get(config);
  if (cached) return cached;
  const resolved = resolvePotionMatchingOptions(config);
  potionMatchingCache.set(config, resolved);
  return resolved;
}

/** Returns whether vanilla recipes for this potion type need an exact zero-effect guard. */
export function potionTypeNeedsEmptyEffects(config: GeneratorConfig, potion: string): boolean {
  return potionMatchingOptions(config).protected_potion_types.includes(normalizedPotionType(config, potion));
}

/** Resolves automatic potion-state adjustment for one global modifier. */
export function modifierAutoAdjustOptions(
  config: GeneratorConfig,
  modifierId: string,
): { enabled: boolean; strategies: AutoAdjustStrategy[] } {
  const matching = potionMatchingOptions(config),
   override = matching.auto_adjust_effects.modifiers[modifierId];

  if (typeof override === 'boolean')
    return { enabled: override, strategies: matching.auto_adjust_effects.strategies };

  const modifier = (override ?? {}) as AutoAdjustModifierConfig;
  return {
    enabled: modifier.enabled ?? matching.auto_adjust_effects.enabled,
    strategies: modifier.strategies ?? matching.auto_adjust_effects.strategies,
  };
}
