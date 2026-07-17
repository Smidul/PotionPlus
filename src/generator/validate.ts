import type {
  GeneratorConfig,
  JsonObject,
  LoadedRecipe,
  PotionState,
  ResolvedPotionMatchingConfig,
} from './types.ts';
import { IngredientTagRegistry } from './tags.ts';
import { joinPath, listJsonFiles, readJson, removeGeneratedDirectory } from './utils.ts';
import { componentPreservingTippedArrowPath, vanillaRecipeRoot } from './generate.ts';
import { configuredPotionEffects, modifierAutoAdjustOptions } from './config.ts';
import { customMatcher } from './potions.ts';

interface BrewingRecipeEntry {
  filePath: string;
  value: JsonObject;
}

interface PreparedBrewingRecipe extends BrewingRecipeEntry {
  inputValues: Set<string>;
  reagentValues: Set<string>;
  output: string;
}

interface NumberBounds {
  min: number;
  max: number;
}

function validateBrewingRecipe(filePath: string, value: JsonObject, recipeType: string): void {
  if (value.type !== recipeType) throw new Error(`Wrong recipe type in ${filePath}`);
  for (const key of ['input', 'reagent', 'output'])
    if (!(key in value)) throw new Error(`Missing ${key} in ${filePath}`);

  if (!('item' in value.input) || !('potion_contents' in value.input))
    throw new Error(`Invalid input in ${filePath}`);

  if (!('item' in value.reagent)) throw new Error(`Invalid reagent in ${filePath}`);
  if (!('id' in value.output)) throw new Error(`Invalid output in ${filePath}`);
}

function validateComponentPreservingImbue(
  filePath: string,
  value: JsonObject,
  namespace: string,
): void {
  if (value.type !== `${namespace}:crafting_transmute`)
    throw new Error(`Wrong tipped-arrow recipe type in ${filePath}`);

  if (value.material_count !== 8)
    throw new Error(`Component-preserving tipped arrows must require eight arrows in ${filePath}`);

  if (value.result?.id !== `${namespace}:tipped_arrow` || value.result?.count !== 8)
    throw new Error(`Invalid tipped-arrow result in ${filePath}`);
}

function normalizedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedJson);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value as JsonObject)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizedJson(entry)]),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizedJson(value));
}

function stateLabel(source: string, id: string, state: PotionState): string {
  return `${source}:${id} (${state.display})`;
}

function fieldValues(group: { state: PotionState }[], field: string): Set<string> {
  return new Set(group.map(entry => stableJson(entry.state.effects.map(effect => effect[field]))));
}

function stateConflictFix(
  group: { state: PotionState }[],
  matching: ResolvedPotionMatchingConfig,
): string {
  const enable: string[] = [];
  for (const field of ['duration', 'amplifier', 'ambient'] as const) {
    if (!matching.effect_fields[field] && fieldValues(group, field).size > 1)
      enable.push(`generator.potion_matching.effect_fields.${field}`);
  }

  if (enable.length)
    return `Enable ${enable.join(' and ')} so the differing effect data is included in the recipe predicate.`;

  return (
    'Change at least one matchable value (potion type, effect duration, amplifier, ambient flag, or particle visibility), ' +
    'or use a different input potion or reagent. `custom_color`, `minecraft:custom_name`, lore, `show_icon`, ' +
    '`hidden_effect`, and other components cannot be checked by a brewing recipe.'
  );
}

/**
 * Errors before output cleanup when multiple configured states receive the same
 * matchable potion-content predicate.
 */
export function validatePotionStateMatchers(
  config: GeneratorConfig,
  custom: Map<string, PotionState>,
  vanilla: Map<string, PotionState>,
  matching: ResolvedPotionMatchingConfig,
): void {
  if (!matching.detect_conflicts) return;

  const groups = new Map<string, { source: string; id: string; state: PotionState }[]>();
  for (const [source, states] of [['custom', custom], ['vanilla', vanilla]] as const) {
    for (const [id, state] of states) {
      const key = stableJson(customMatcher(config, state, true)),
       group = groups.get(key) ?? [];
      group.push({ source, id, state });
      groups.set(key, group);
    }
  }

  const conflicts = [...groups.entries()].filter(([, group]) => group.length > 1);
  if (!conflicts.length) return;

  const details = conflicts.map(([matcher, group], index) => {
    const labels = group.map(entry => stateLabel(entry.source, entry.id, entry.state)).join(', ');
    return `${index + 1}. ${labels}\n   potion_contents: ${matcher}\n   Fix: ${stateConflictFix(group, matching)}`;
  });

  throw new Error(
    `Indistinguishable potion states detected (${conflicts.length} group${conflicts.length === 1 ? '' : 's'}).\n` +
      `A recipe intended for one state can also accept the others.\n\n${details.join('\n\n')}\n\n` +
      'The 26.3 brewing ingredient can inspect only the item and the `potions`/`effects` fields of ' +
      '`minecraft:potion_contents`. Do not disable conflict detection unless the overlap is intentional.',
  );
}

function localTagPath(reference: string, namespace: string, tagRoot: string): string | null {
  const prefix = `#${namespace}:`;
  if (!reference.startsWith(prefix)) return null;

  const resource = reference.slice(prefix.length);
  return joinPath(tagRoot, `${resource}.json`);
}

async function resolvedIngredientValues(
  reference: string,
  namespace: string,
  tagRoot: string,
  cache: Map<string, Set<string>>,
  stack: string[] = [],
): Promise<Set<string>> {
  if (!reference.startsWith('#')) return new Set([reference]);

  const localPath = localTagPath(reference, namespace, tagRoot);
  if (!localPath) return new Set([reference]);
  if (cache.has(localPath)) return new Set(cache.get(localPath));
  if (stack.includes(localPath))
    throw new Error(`Generated tag cycle while validating brewing conflicts: ${[...stack, localPath].join(' -> ')}`);

  const file = Bun.file(localPath);
  if (!(await file.exists())) return new Set([reference]);

  const tag = await readJson(localPath),
   values = new Set<string>();

  for (const value of tag.values ?? []) {
    if (typeof value !== 'string') continue;
    for (const resolved of await resolvedIngredientValues(value, namespace, tagRoot, cache, [...stack, localPath]))
      values.add(resolved);
  }

  cache.set(localPath, values);
  return new Set(values);
}

function intersects(left: Set<string>, right: Set<string>): boolean {
  for (const value of left)
    if (right.has(value)) return true;
  return false;
}

function intersection(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter(value => right.has(value)).sort();
}

function stringValues(value: unknown): string[] | null {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every(entry => typeof entry === 'string')) return value;
  return null;
}

function potionTypesOverlap(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return true;

  const leftValues = stringValues(left),
   rightValues = stringValues(right);
  if (!leftValues || !rightValues) return true;

  // Potion tags cannot be expanded from the generated item-tag tree, so use a
  // conservative overlap unless two concrete lists are provably disjoint.
  if (leftValues.some(value => value.startsWith('#')) || rightValues.some(value => value.startsWith('#')))
    return true;

  return leftValues.some(value => rightValues.includes(value));
}

function numberBounds(value: unknown): NumberBounds | null {
  if (typeof value === 'number') return { min: value, max: value };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const object = value as JsonObject,
   min = typeof object.min === 'number' ? object.min : Number.NEGATIVE_INFINITY,
   max = typeof object.max === 'number' ? object.max : Number.POSITIVE_INFINITY;
  return { min, max };
}

function boundsOverlap(left: unknown, right: unknown): boolean {
  const leftBounds = numberBounds(left),
   rightBounds = numberBounds(right);
  if (!leftBounds || !rightBounds) return true;
  return leftBounds.min <= rightBounds.max && rightBounds.min <= leftBounds.max;
}

function effectPropertiesOverlap(left: JsonObject, right: JsonObject): boolean {
  for (const field of ['duration', 'amplifier'])
    if (field in left && field in right && !boundsOverlap(left[field], right[field])) return false;

  for (const field of ['ambient', 'visible'])
    if (field in left && field in right && left[field] !== right[field]) return false;

  return true;
}

function effectConstraints(value: unknown): Map<string, JsonObject> {
  const constraints = new Map<string, JsonObject>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return constraints;

  const object = value as JsonObject,
   predicates = Array.isArray(object.contains) ? object.contains : [object];

  for (const predicate of predicates) {
    if (!predicate || typeof predicate !== 'object' || Array.isArray(predicate)) continue;
    for (const [effect, properties] of Object.entries(predicate as JsonObject)) {
      if (['contains', 'count', 'size'].includes(effect)) continue;
      constraints.set(effect, properties && typeof properties === 'object' && !Array.isArray(properties)
        ? properties as JsonObject
        : {});
    }
  }
  return constraints;
}

function sizeRange(value: unknown): NumberBounds {
  return numberBounds(value) ?? { min: 0, max: Number.POSITIVE_INFINITY };
}

function effectsOverlap(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return true;

  const leftObject = left as JsonObject,
   rightObject = right as JsonObject,
   leftSize = sizeRange(leftObject.size),
   rightSize = sizeRange(rightObject.size),
   overlapSize = {
    min: Math.max(leftSize.min, rightSize.min),
    max: Math.min(leftSize.max, rightSize.max),
   };
  if (overlapSize.min > overlapSize.max) return false;

  const leftEffects = effectConstraints(leftObject),
   rightEffects = effectConstraints(rightObject),
   requiredEffects = new Set([...leftEffects.keys(), ...rightEffects.keys()]);
  if (requiredEffects.size > overlapSize.max) return false;

  for (const effect of requiredEffects) {
    const leftProperties = leftEffects.get(effect),
     rightProperties = rightEffects.get(effect);
    if (leftProperties && rightProperties && !effectPropertiesOverlap(leftProperties, rightProperties)) return false;
  }

  // Unknown collection-count expressions are treated conservatively as able to overlap.
  return true;
}

function exactEffectsPredicate(
  effects: JsonObject[],
  matching: ResolvedPotionMatchingConfig,
): JsonObject {
  return {
    contains: effects.map(effect => ({
      [effect.id.includes(':') ? effect.id : `minecraft:${effect.id}`]: effectPropertiesForOutput({
        ...effect,
        show_particles: effect.show_particles ?? true,
      }, matching),
    })),
    size: effects.length,
  };
}

function potionTypesCanMatchEffects(
  potionTypes: unknown,
  effectsPredicate: unknown,
  config: GeneratorConfig,
  matching: ResolvedPotionMatchingConfig,
): boolean {
  const values = stringValues(potionTypes);
  if (!values) return true;

  for (const value of values) {
    const effects = configuredPotionEffects(config, value);
    if (!effects) return true;
    if (effectsOverlap(effectsPredicate, exactEffectsPredicate(effects, matching))) return true;
  }
  return false;
}

function potionPredicatesOverlap(
  left: JsonObject,
  right: JsonObject,
  config: GeneratorConfig,
  matching: ResolvedPotionMatchingConfig,
): boolean {
  const leftPotions = left.potions,
   rightPotions = right.potions;

  if (!potionTypesOverlap(leftPotions, rightPotions)) return false;
  if (leftPotions !== undefined && rightPotions === undefined && right.effects !== undefined &&
      !potionTypesCanMatchEffects(leftPotions, right.effects, config, matching)) return false;
  if (rightPotions !== undefined && leftPotions === undefined && left.effects !== undefined &&
      !potionTypesCanMatchEffects(rightPotions, left.effects, config, matching)) return false;

  return effectsOverlap(left.effects, right.effects);
}

function effectPropertiesForOutput(
  effect: JsonObject,
  matching: ResolvedPotionMatchingConfig,
): JsonObject {
  const properties: JsonObject = {};
  if (matching.effect_fields.duration) properties.duration = Number(effect.duration ?? 1);
  if (matching.effect_fields.amplifier) properties.amplifier = Number(effect.amplifier ?? 0);
  if (matching.effect_fields.ambient) properties.ambient = Boolean(effect.ambient ?? false);
  if (matching.effect_fields.visible) properties.visible = Boolean(effect.show_particles ?? true);
  return properties;
}

function outputMatchesPotionPredicate(
  predicate: JsonObject,
  component: JsonObject,
  matching: ResolvedPotionMatchingConfig,
): boolean {
  const potionTypes = predicate.potions;
  if (potionTypes !== undefined) {
    if (typeof component.potion !== 'string') return false;
    const accepted = stringValues(potionTypes);
    if (accepted && !accepted.some(value => value === component.potion || value.startsWith('#'))) return false;
  }

  if (predicate.effects !== undefined) {
    // A base potion can contribute additional effects that are unavailable in
    // the serialized custom_effects list. Treat that uncommon combination
    // conservatively; generated Overbrew modifier outputs use custom effects only.
    if (component.potion && !Array.isArray(component.custom_effects)) return true;

    const actualEffects = Array.isArray(component.custom_effects) ? component.custom_effects : [],
     exactPredicate: JsonObject = {
      contains: actualEffects.map((effect: JsonObject) => ({
        [effect.id]: effectPropertiesForOutput(effect, matching),
      })),
      size: actualEffects.length,
     };
    if (!effectsOverlap(predicate.effects, exactPredicate)) return false;
  }

  return true;
}

function matcherDescription(recipe: JsonObject): string {
  return `input=${recipe.input.item} ${stableJson(recipe.input.potion_contents)}, reagent=${recipe.reagent.item}`;
}

function disabledEffectFields(matching: ResolvedPotionMatchingConfig): string[] {
  return Object.entries(matching.effect_fields)
    .filter(([, enabled]) => !enabled)
    .map(([field]) => `generator.potion_matching.effect_fields.${field}`);
}

function pairConflictFix(
  left: PreparedBrewingRecipe,
  right: PreparedBrewingRecipe,
  matching: ResolvedPotionMatchingConfig,
): string {
  const sharedInput = intersection(left.inputValues, right.inputValues),
   sharedReagent = intersection(left.reagentValues, right.reagentValues),
   tagOverlap = matching.check_tag_overlaps &&
    (String(left.value.input.item) !== String(right.value.input.item) ||
     String(left.value.reagent.item) !== String(right.value.reagent.item));

  if (tagOverlap)
    return (
      `Different item tags overlap on input [${sharedInput.join(', ') || 'unknown'}] or reagent ` +
      `[${sharedReagent.join(', ') || 'unknown'}]. Remove the shared item from one route, use a different reagent, ` +
      'or disable generator.potion_matching.check_tag_overlaps only when the overlap is intentional.'
    );

  const disabled = disabledEffectFields(matching);
  if (disabled.length)
    return `Enable ${disabled.join(' and ')} if those effect values differ, or use a different input potion or reagent.`;

  return (
    'Change a matchable potion value (potion type, effect duration, amplifier, ambient flag, or particle visibility), ' +
    'or use a different input/reagent. Changing color, name, lore, `show_icon`, `hidden_effect`, or another ' +
    'unmatchable item value cannot disambiguate brewing recipes.'
  );
}

async function ingredientValues(
  reference: string,
  customNamespaceRoot: string,
  tags: IngredientTagRegistry,
  matching: ResolvedPotionMatchingConfig,
  cache: Map<string, Set<string>>,
): Promise<Set<string>> {
  if (!matching.check_tag_overlaps) return new Set([reference]);
  return resolvedIngredientValues(
    reference,
    tags.namespace,
    joinPath(customNamespaceRoot, 'tags', 'item'),
    cache,
  );
}


function globalModifierId(filePath: string, config: GeneratorConfig): string | null {
  const marker = '/recipe/brewing/',
   index = filePath.replaceAll('\\', '/').indexOf(marker);
  if (index < 0) return null;
  const id = filePath.replaceAll('\\', '/').slice(index + marker.length).split('/', 1)[0];
  return config.modifiers?.[id]?.global ? id : null;
}

function selfLoopFix(
  recipe: PreparedBrewingRecipe,
  config: GeneratorConfig,
  matching: ResolvedPotionMatchingConfig,
): string {
  const modifierId = globalModifierId(recipe.filePath, config);
  if (modifierId && !modifierAutoAdjustOptions(config, modifierId).enabled)
    return (
      `Enable generator.potion_matching.auto_adjust_effects.modifiers.${modifierId}.enabled and configure ` +
      'its strategy priorities, or make the modifier change a matchable potion field directly.'
    );

  return (
    'Make the modifier change a matchable effect field or particle visibility, configure another automatic ' +
    'adjustment strategy, or use a different input/reagent. `custom_color`, `minecraft:custom_name`, lore, ' +
    '`show_icon`, `hidden_effect`, and other unmatchable values cannot prevent reapplication.'
  );
}

async function validateBrewingConflicts(
  recipes: BrewingRecipeEntry[],
  customNamespaceRoot: string,
  tags: IngredientTagRegistry,
  matching: ResolvedPotionMatchingConfig,
  vanillaNamespace: string,
  config: GeneratorConfig,
): Promise<void> {
  if (!matching.detect_conflicts) return;

  const cache = new Map<string, Set<string>>(),
   prepared: PreparedBrewingRecipe[] = await Promise.all(
    recipes.map(async entry => ({
      ...entry,
      inputValues: await ingredientValues(
        String(entry.value.input.item), customNamespaceRoot, tags, matching, cache,
      ),
      reagentValues: await ingredientValues(
        String(entry.value.reagent.item), customNamespaceRoot, tags, matching, cache,
      ),
      output: stableJson(entry.value.output),
    })),
   ),
   conflicts: string[] = [];

  for (const recipe of prepared) {
    const component = recipe.value.output?.components?.[`${vanillaNamespace}:potion_contents`];
    if (!component || typeof component !== 'object' || Array.isArray(component)) continue;
    if (!recipe.inputValues.has(String(recipe.value.output.id))) continue;
    if (!outputMatchesPotionPredicate(recipe.value.input.potion_contents, component, matching)) continue;

    conflicts.push(
      `${conflicts.length + 1}. ${recipe.filePath}\n` +
      `   ${matcherDescription(recipe.value)}\n` +
      '   accepts its own output because the output keeps the same matchable potion contents.\n' +
      `   Fix: ${selfLoopFix(recipe, config, matching)}`,
    );
  }

  for (let leftIndex = 0; leftIndex < prepared.length; leftIndex++) {
    const left = prepared[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < prepared.length; rightIndex++) {
      const right = prepared[rightIndex];

      if (left.output === right.output) continue;
      if (!potionPredicatesOverlap(left.value.input.potion_contents, right.value.input.potion_contents, config, matching)) continue;
      if (!intersects(left.inputValues, right.inputValues) || !intersects(left.reagentValues, right.reagentValues))
        continue;

      conflicts.push(
        `${conflicts.length + 1}. ${left.filePath}\n` +
          `   ${matcherDescription(left.value)}\n` +
          `   conflicts with ${right.filePath}\n` +
          `   ${matcherDescription(right.value)}\n` +
          `   Fix: ${pairConflictFix(left, right, matching)}`,
      );
    }
  }

  if (conflicts.length)
    throw new Error(
      `Ambiguous brewing recipes detected (${conflicts.length}). ` +
        `Minecraft can select the wrong output or repeatedly apply a modifier.\n\n` +
        `${conflicts.join('\n\n')}\n\n` +
        'Set generator.potion_matching.detect_conflicts to false only when every reported overlap is intentional.',
    );
}

/** Validates recipe structure, ambiguity, and every generated Overbrew tag reference. */
export async function validateGenerated(
  config: GeneratorConfig,
  customRecipeRoot: string,
  customNamespaceRoot: string,
  vanillaNamespaceRoot: string,
  vanillaRecipes: LoadedRecipe[],
  includeVanilla: boolean,
  preserveImbuedComponents: boolean,
  tags: IngredientTagRegistry,
  vanillaNamespace: string,
  potionMatching: ResolvedPotionMatchingConfig,
): Promise<[recipeCount: number, tagCount: number]> {
  const recipePaths = await listJsonFiles(customRecipeRoot);
  if (includeVanilla) {
    const vanillaRoot = vanillaRecipeRoot(vanillaNamespaceRoot);
    for (const { relativePath } of vanillaRecipes) {
      const filePath = joinPath(vanillaRoot, relativePath);
      if (!(await Bun.file(filePath).exists()))
        throw new Error(`Missing generated vanilla recipe: ${filePath}`);

      recipePaths.push(filePath);
    }
  }

  if (preserveImbuedComponents) {
    const imbuePath = componentPreservingTippedArrowPath(vanillaNamespaceRoot);
    if (!(await Bun.file(imbuePath).exists()))
      throw new Error(`Missing component-preserving tipped-arrow recipe: ${imbuePath}`);
    recipePaths.push(imbuePath);
  }

  const tagRoot = joinPath(customNamespaceRoot, 'tags', 'item', tags.root),
   tagPaths = await listJsonFiles(tagRoot),
   generatedTags = new Set(tagPaths.map(filePath => joinPath(filePath))),
   missing = new Set<string>(),
   brewingRecipes: BrewingRecipeEntry[] = [],

   requireTag = (reference: string): void => {
    if (!reference.startsWith(`#${tags.namespace}:`)) return;
    const tagName = reference.split(':', 2)[1],
     tagPath = joinPath(customNamespaceRoot, 'tags', 'item', `${tagName}.json`);
    if (!generatedTags.has(tagPath)) missing.add(reference);
   };

  for (const filePath of recipePaths) {
    const recipe = await readJson(filePath);
    if (recipe.type === `${vanillaNamespace}:crafting_transmute`) {
      validateComponentPreservingImbue(filePath, recipe, vanillaNamespace);
    } else {
      validateBrewingRecipe(filePath, recipe, `${vanillaNamespace}:brewing`);
      if (typeof recipe.reagent?.item === 'string') requireTag(recipe.reagent.item);
      brewingRecipes.push({ filePath, value: recipe });
    }
  }

  for (const filePath of tagPaths) {
    const tag = await readJson(filePath);
    if (!Array.isArray(tag.values)) throw new Error(`Invalid item tag in ${filePath}`);
    for (const value of tag.values)
      if (typeof value === 'string') requireTag(value);
  }

  if (missing.size) throw new Error(`Missing generated item tags: ${[...missing].sort().join(', ')}`);
  await validateBrewingConflicts(
    brewingRecipes,
    customNamespaceRoot,
    tags,
    potionMatching,
    vanillaNamespace,
    config,
  );
  return [recipePaths.length, tagPaths.length];
}

/** Clears the generated vanilla brewing directory before regeneration. */
export async function removeGeneratedVanillaRecipes(vanillaNamespaceRoot: string): Promise<void> {
  await removeGeneratedDirectory(joinPath(vanillaRecipeRoot(vanillaNamespaceRoot), 'brewing'));
}
