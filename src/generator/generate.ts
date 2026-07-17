import { brewEntries, containerModifiers, getModifier, globalModifierForms, globalModifiers, modifierAutoAdjustOptions, orderedAutoAdjustStrategies, potionMatchingOptions, variantModifiers } from './config.ts';
import type {
  AutoAdjustEffectSelection,
  AutoAdjustStrategy,
  GenerationCounts,
  GeneratorConfig,
  ItemTagContext,
  JsonObject,
  LoadedRecipe,
  PotionSource,
  PotionState,
  ReagentReference,
} from './types.ts';
import { IngredientTagRegistry } from './tags.ts';
import {
  brewingRecipe,
  customMatcher,
  formByItem,
  getForm,
  modifierOutputStack,
  normalizeConfiguredEffect,
  outputStack,
  visibleOutputStack,
  potionTypePredicate,
  stateForCustom,
  visibleMatcher,
} from './potions.ts';
import { extractPotionId, variantName } from './vanilla.ts';
import { basePotionKey, fileStem, joinPath, namespaced, writeJson } from './utils.ts';
import {
  customTransformVariants,
  customVariantNames,
  generatedVanillaFamilies,
  modifierVariantEdges,
  vanillaTransformVariants,
  vanillaVariantKey,
  vanillaVariantNames,
} from './variants.ts';

/** Namespace roots used by recipe writers. */
export interface GenerationPaths {
  customNamespaceRoot: string;
  vanillaNamespaceRoot: string;
}

interface TransitionMode {
  root: string;
  recipePrefix: string;
  inputParticles: boolean;
  outputParticles: boolean;
  globalModifier?: JsonObject;
  globalModifierId?: string;
  modifiedStates?: GlobalModifierStateRegistry;
  allowedForms?: Set<string>;
}

interface StateEntry {
  source: PotionSource;
  key: string;
  effect: string;
  variant: string;
  state: PotionState;
}

function customRecipeRoot(namespaceRoot: string): string {
  return joinPath(namespaceRoot, 'recipe', 'brewing');
}

/** Returns the vanilla recipe registry root for one namespace directory. */
export function vanillaRecipeRoot(namespaceRoot: string): string {
  return joinPath(namespaceRoot, 'recipe');
}

/** Returns the generated component-preserving tipped-arrow recipe path. */
export function componentPreservingTippedArrowPath(namespaceRoot: string): string {
  return joinPath(vanillaRecipeRoot(namespaceRoot), 'tipped_arrow.json');
}

async function forForms(
  config: GeneratorConfig,
  task: (form: string, formData: JsonObject) => Promise<void>,
  selected?: Iterable<string>,
): Promise<number> {
  const allowed = selected ? new Set(selected) : null,
   forms = Object.entries(config.forms).filter(([form]) => !allowed || allowed.has(form));
  await Promise.all(forms.map(([form, formData]) => task(form, formData)));
  return forms.length;
}

async function saveRecipe(root: string, relativePath: string, recipe: JsonObject): Promise<void> {
  await writeJson(joinPath(root, relativePath), recipe);
}

function reagent(
  tags: IngredientTagRegistry,
  reference: ReagentReference,
  recipeKey: string,
  context: ItemTagContext,
  useTag = true,
  fallbackItem?: string,
): string {
  return tags.reference(reference, useTag, fallbackItem, recipeKey, context);
}

function stateEntries(
  custom: Map<string, PotionState>,
  vanilla: Map<string, PotionState>,
  applies: Set<string>,
): StateEntry[] {
  const entries: StateEntry[] = [];
  if (applies.has('custom')) {
    for (const [id, state] of custom)
      entries.push({
        source: 'custom',
        key: id,
        effect: state.family ?? id.split(':', 1)[0],
        variant: state.variant ?? id.split(':', 2)[1] ?? 'base',
        state,
      });
  }
  if (applies.has('vanilla')) {
    for (const [key, state] of vanilla)
      entries.push({
        source: 'vanilla',
        key,
        effect: state.family ?? basePotionKey(key),
        variant: state.variant ?? variantName(key),
        state,
      });
  }
  return entries;
}

function stateIdentityKey(state: PotionState): string {
  return `${state.source}:${state.key}`;
}

function matcherKey(config: GeneratorConfig, state: PotionState, showParticles: boolean): string {
  return JSON.stringify(customMatcher(config, state, showParticles));
}

function stateWithParticleVisibility(state: PotionState, visible: boolean): PotionState {
  const output = structuredClone(state);
  for (const effect of output.effects) effect.show_particles = visible;
  return output;
}

function selectedEffectIndexes(
  state: PotionState,
  selection: AutoAdjustEffectSelection | undefined,
  defaultSelection: AutoAdjustEffectSelection = 'all',
): number[] {
  if (!state.effects.length) return [];
  const resolved = selection ?? defaultSelection;
  if (resolved === 'first') return [0];
  if (Array.isArray(resolved))
    return [...new Set(resolved.filter(index => Number.isInteger(index) && index >= 0 && index < state.effects.length))];
  return state.effects.map((_, index) => index);
}

interface NumericOffsetVector {
  offsets: number[];
  total: number;
  changed: number;
  maxAbsolute: number;
}

function compareNumberLists(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const difference = (left[index] ?? Number.MAX_SAFE_INTEGER) - (right[index] ?? Number.MAX_SAFE_INTEGER);
    if (difference) return difference;
  }
  return 0;
}

function changedPositions(vector: NumericOffsetVector): number[] {
  return vector.offsets.flatMap((offset, index) => offset === 0 ? [] : [index]);
}

function directionRanks(vector: NumericOffsetVector, preferIncrease: boolean): number[] {
  return vector.offsets
    .filter(offset => offset !== 0)
    .map(offset => (offset > 0) === preferIncrease ? 0 : 1);
}

function compareNumericVectors(
  left: NumericOffsetVector,
  right: NumericOffsetVector,
  algorithm: 'minimal' | 'balanced',
  order: 'effect_first' | 'direction_first',
  preferIncrease: boolean,
): number {
  if (left.total !== right.total) return left.total - right.total;

  if (algorithm === 'balanced') {
    if (left.maxAbsolute !== right.maxAbsolute) return left.maxAbsolute - right.maxAbsolute;
    if (left.changed !== right.changed) return right.changed - left.changed;
  } else if (left.changed !== right.changed) {
    return left.changed - right.changed;
  }

  const leftPositions = changedPositions(left),
   rightPositions = changedPositions(right),
   leftDirections = directionRanks(left, preferIncrease),
   rightDirections = directionRanks(right, preferIncrease),
   leftMagnitudes = left.offsets.filter(offset => offset !== 0).map(Math.abs),
   rightMagnitudes = right.offsets.filter(offset => offset !== 0).map(Math.abs);

  if (order === 'effect_first') {
    return compareNumberLists(leftPositions, rightPositions) ||
      compareNumberLists(leftDirections, rightDirections) ||
      compareNumberLists(leftMagnitudes, rightMagnitudes);
  }

  const leftNonPreferred = leftDirections.reduce((total, rank) => total + rank, 0),
   rightNonPreferred = rightDirections.reduce((total, rank) => total + rank, 0);
  return leftNonPreferred - rightNonPreferred ||
    compareNumberLists(leftDirections, rightDirections) ||
    compareNumberLists(leftPositions, rightPositions) ||
    compareNumberLists(leftMagnitudes, rightMagnitudes);
}

function vectorsWithTotal(
  effectCount: number,
  total: number,
  maxDelta: number,
  maxChangedEffects: number,
): NumericOffsetVector[] {
  const vectors: NumericOffsetVector[] = [],
   offsets = Array<number>(effectCount).fill(0);

  const visit = (index: number, remaining: number, changed: number): void => {
    if (changed > maxChangedEffects) return;
    if (index === effectCount) {
      if (remaining !== 0 || changed === 0) return;
      vectors.push({
        offsets: [...offsets],
        total,
        changed,
        maxAbsolute: Math.max(...offsets.map(Math.abs)),
      });
      return;
    }

    offsets[index] = 0;
    visit(index + 1, remaining, changed);

    const maximum = Math.min(maxDelta, remaining);
    for (let magnitude = 1; magnitude <= maximum; magnitude++) {
      offsets[index] = magnitude;
      visit(index + 1, remaining - magnitude, changed + 1);
      offsets[index] = -magnitude;
      visit(index + 1, remaining - magnitude, changed + 1);
    }
    offsets[index] = 0;
  };

  visit(0, total, 0);
  return vectors;
}

function applyNumericOffsets(
  state: PotionState,
  indexes: number[],
  offsets: number[],
  field: 'duration' | 'amplifier',
  minimum: number,
): PotionState | null {
  const candidate = structuredClone(state);
  for (let position = 0; position < indexes.length; position++) {
    const offset = offsets[position];
    if (!offset) continue;
    const index = indexes[position],
     current = Number(state.effects[index][field] ?? minimum),
     next = current + offset;
    if (!Number.isFinite(next) || next < minimum) return null;
    candidate.effects[index][field] = next;
  }
  return candidate;
}

function singleNumericCandidates(
  state: PotionState,
  indexes: number[],
  field: 'duration' | 'amplifier',
  minimum: number,
  preferIncrease: boolean,
  order: 'effect_first' | 'direction_first',
  maxDelta: number,
  maxCandidates: number,
): PotionState[] {
  const candidates: PotionState[] = [];
  for (let distance = 1; distance <= maxDelta && candidates.length < maxCandidates; distance++) {
    const offsets = preferIncrease ? [distance, -distance] : [-distance, distance];
    if (order === 'effect_first') {
      for (const index of indexes) {
        for (const offset of offsets) {
          const vector = indexes.map(candidateIndex => candidateIndex === index ? offset : 0),
           candidate = applyNumericOffsets(state, indexes, vector, field, minimum);
          if (candidate) candidates.push(candidate);
          if (candidates.length >= maxCandidates) break;
        }
        if (candidates.length >= maxCandidates) break;
      }
    } else {
      for (const offset of offsets) {
        for (const index of indexes) {
          const vector = indexes.map(candidateIndex => candidateIndex === index ? offset : 0),
           candidate = applyNumericOffsets(state, indexes, vector, field, minimum);
          if (candidate) candidates.push(candidate);
          if (candidates.length >= maxCandidates) break;
        }
        if (candidates.length >= maxCandidates) break;
      }
    }
  }
  return candidates;
}

function numericCandidates(
  state: PotionState,
  strategy: Extract<AutoAdjustStrategy, { type: 'duration' | 'amplifier' }>,
  defaultSelection: AutoAdjustEffectSelection,
): PotionState[] {
  const indexes = selectedEffectIndexes(state, strategy.effects, defaultSelection),
   preferIncrease = (strategy.prefer ?? 'increase') === 'increase',
   algorithm = strategy.algorithm ?? 'balanced',
   order = strategy.order ?? 'effect_first',
   defaultMax = strategy.type === 'duration' ? 20 : 1,
   maxDelta = Math.max(0, Math.floor(strategy.max_delta ?? defaultMax)),
   maxTotalDelta = Math.max(0, Math.floor(strategy.max_total_delta ?? maxDelta)),
   maxChangedEffects = Math.max(
     0,
     Math.min(indexes.length, Math.floor(strategy.max_changed_effects ?? indexes.length)),
   ),
   maxCandidates = Math.max(1, Math.floor(strategy.max_candidates ?? 10_000)),
   minimum = strategy.type === 'duration' ? 1 : 0;

  if (!indexes.length || !maxDelta || !maxTotalDelta || !maxChangedEffects) return [];
  if (algorithm === 'single')
    return singleNumericCandidates(
      state,
      indexes,
      strategy.type,
      minimum,
      preferIncrease,
      order,
      Math.min(maxDelta, maxTotalDelta),
      maxCandidates,
    );

  const candidates: PotionState[] = [];
  for (let total = 1; total <= maxTotalDelta && candidates.length < maxCandidates; total++) {
    const vectors = vectorsWithTotal(indexes.length, total, maxDelta, maxChangedEffects)
      .sort((left, right) => compareNumericVectors(left, right, algorithm, order, preferIncrease));
    for (const vector of vectors) {
      const candidate = applyNumericOffsets(state, indexes, vector.offsets, strategy.type, minimum);
      if (candidate) candidates.push(candidate);
      if (candidates.length >= maxCandidates) break;
    }
  }
  return candidates;
}

function booleanCandidates(
  state: PotionState,
  strategy: Extract<AutoAdjustStrategy, { type: 'ambient' | 'visible' }>,
  defaultSelection: AutoAdjustEffectSelection,
): PotionState[] {
  const candidates: PotionState[] = [];
  for (const index of selectedEffectIndexes(state, strategy.effects, defaultSelection)) {
    const field = strategy.type === 'visible' ? 'show_particles' : 'ambient',
     current = Boolean(state.effects[index][field] ?? (field === 'show_particles')),
     next = strategy.value ?? !current;
    if (next === current) continue;
    const candidate = structuredClone(state);
    candidate.effects[index][field] = next;
    candidates.push(candidate);
  }
  return candidates;
}

function uniquePotionStates(states: PotionState[]): PotionState[] {
  const seen = new Set<string>(), output: PotionState[] = [];
  for (const state of states) {
    const key = JSON.stringify({ potion: state.potion ?? null, effects: state.effects });
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(state);
  }
  return output;
}

function potionTypeStates(
  config: GeneratorConfig,
  state: PotionState,
  potions: string[],
  includeOriginal: boolean,
): { exact: PotionState[]; search: PotionState[] } {
  const exact: PotionState[] = [],
   search: PotionState[] = [];

  for (const potion of potions) {
    const normalized = namespaced(potion, config.generator.namespaces.vanilla);
    if (normalized === state.potion) continue;
    const candidate = structuredClone(state);
    candidate.potion = normalized;
    exact.push(candidate);
    search.push(candidate);
  }

  if (includeOriginal) search.push(structuredClone(state));
  return { exact: uniquePotionStates(exact), search: uniquePotionStates(search) };
}

function roundRobinPotionStates(groups: PotionState[][]): PotionState[] {
  const output: PotionState[] = [],
   maximum = Math.max(0, ...groups.map(group => group.length));
  for (let index = 0; index < maximum; index++) {
    for (const group of groups) {
      const candidate = group[index];
      if (candidate) output.push(candidate);
    }
  }
  return output;
}

function strategyWithoutAddedEffects(strategy: AutoAdjustStrategy): AutoAdjustStrategy | null {
  if (strategy.type === 'add_effect') return null;
  const clone = structuredClone(strategy);
  if (clone.type === 'potion_type' && clone.strategies)
    clone.strategies = clone.strategies
      .map(strategyWithoutAddedEffects)
      .filter((entry): entry is AutoAdjustStrategy => Boolean(entry));
  return clone;
}

function strategyCandidates(
  config: GeneratorConfig,
  state: PotionState,
  strategy: AutoAdjustStrategy,
  defaultSelection: AutoAdjustEffectSelection = 'all',
  parentStrategies: AutoAdjustStrategy[] = [],
): PotionState[] {
  const fields = potionMatchingOptions(config).effect_fields;
  if (strategy.type === 'duration' || strategy.type === 'amplifier') {
    if (!fields[strategy.type]) return [];
    return numericCandidates(state, strategy, defaultSelection);
  }
  if (strategy.type === 'ambient' || strategy.type === 'visible') {
    if (!fields[strategy.type]) return [];
    return booleanCandidates(state, strategy, defaultSelection);
  }

  if (strategy.type === 'potion_type') {
    const { exact, search } = potionTypeStates(
      config,
      state,
      strategy.potions,
      strategy.include_original ?? true,
    ),
     nestedStrategies = orderedAutoAdjustStrategies(strategy.strategies ?? []),
     candidates = [...exact],
     nestedParents = [strategy, ...parentStrategies];

    for (const nested of nestedStrategies) {
      const groups = search.map(candidate =>
        strategyCandidates(config, candidate, nested, defaultSelection, nestedParents));
      candidates.push(...roundRobinPotionStates(groups));
    }
    return uniquePotionStates(candidates);
  }

  if (strategy.type === 'add_effect') {
    const candidate = structuredClone(state),
     addedIndex = candidate.effects.length,
     nestedStrategies = strategy.strategies ?? [];
    candidate.effects.push(normalizeConfiguredEffect(config, strategy.effect));

    const candidates = [candidate],
     fallbacks: AutoAdjustStrategy[] = [...nestedStrategies];

    if (strategy.inherit_parent_strategies ?? true) {
      for (const parent of parentStrategies) {
        if (parent === strategy) continue;
        const inherited = strategyWithoutAddedEffects(parent);
        if (!inherited) continue;
        fallbacks.push({ ...inherited, effects: undefined } as AutoAdjustStrategy);
      }
    }

    const orderedFallbacks = orderedAutoAdjustStrategies(fallbacks);
    for (const fallback of orderedFallbacks)
      candidates.push(...strategyCandidates(config, candidate, fallback, [addedIndex], orderedFallbacks));

    return uniquePotionStates(candidates);
  }
  return [];
}

function strategyLabel(strategy: AutoAdjustStrategy): string {
  if (strategy.type === 'potion_type') {
    const nested = strategy.strategies?.map(strategyLabel).join(', ');
    return `potion_type(${strategy.potions.join(', ')}${nested ? ` -> ${nested}` : ''})`;
  }
  if (strategy.type !== 'add_effect') return strategy.type;
  const nested = strategy.strategies?.map(strategyLabel).join(', ');
  return `add_effect(${String(strategy.effect.id ?? 'missing id')}${nested ? ` -> ${nested}` : ''})`;
}

/**
 * Creates form-specific potion states only when a global modifier would
 * otherwise leave its output indistinguishable from an existing state.
 */
class GlobalModifierStateRegistry {
  private readonly states = new Map<string, PotionState>();
  private readonly changedModifiers = new Set<string>();

  constructor(
    config: GeneratorConfig,
    custom: Map<string, PotionState>,
    vanilla: Map<string, PotionState>,
  ) {
    const matching = potionMatchingOptions(config),
     allStates = stateEntries(custom, vanilla, new Set(['custom', 'vanilla'])),
     reservedByForm = new Map<string, Set<string>>();

    for (const form of Object.keys(config.forms))
      reservedByForm.set(form, new Set(allStates.map(entry => matcherKey(config, entry.state, true))));

    for (const { config: modifier, id: modifierId } of globalModifiers(config)) {
      const behavior = modifier.global!,
       applies = new Set<string>(behavior.apply_to ?? ['custom', 'vanilla']),
       outputParticles = behavior.output_show_particles ?? false,
       autoAdjust = modifierAutoAdjustOptions(config, modifierId);

      for (const form of globalModifierForms(config, modifier)) {
        const reserved = reservedByForm.get(form)!;
        for (const entry of stateEntries(custom, vanilla, applies)) {
          const original = stateWithParticleVisibility(entry.state, outputParticles),
           originalKey = matcherKey(config, original, outputParticles),
           stateKey = `${modifierId}:${form}:${stateIdentityKey(entry.state)}`;

          if (!reserved.has(originalKey) || !autoAdjust.enabled) {
            reserved.add(originalKey);
            this.states.set(stateKey, original);
            continue;
          }

          let selected: PotionState | null = null,
           selectedStrategy: AutoAdjustStrategy | null = null;
          for (const strategy of autoAdjust.strategies) {
            for (const candidate of strategyCandidates(config, original, strategy, 'all', autoAdjust.strategies)) {
              const key = matcherKey(config, candidate, outputParticles);
              if (reserved.has(key)) continue;
              selected = candidate;
              selectedStrategy = strategy;
              reserved.add(key);
              break;
            }
            if (selected) break;
          }

          if (!selected) {
            const strategies = autoAdjust.strategies.map(strategyLabel).join(', ') || 'none',
             vanillaHint = matching.warnings.length
              ? ' Enabling generator.include_vanilla_recipes would also make the skipped effectless vanilla potion types available.'
              : '';
            throw new Error(
              `Could not create a unique matchable state for modifier ${modifierId}, form ${form}, and ${stateIdentityKey(entry.state)}. ` +
              `Tried strategies: ${strategies}. Increase max_delta, max_total_delta, max_changed_effects, or max_candidates; ` +
              'enable the corresponding generator.potion_matching.effect_fields option; add another strategy; or disable automatic adjustment.' +
              vanillaHint,
            );
          }

          this.states.set(stateKey, selected);
          if (selectedStrategy) this.changedModifiers.add(modifierId);
        }
      }
    }
  }

  get(modifierId: string, state: PotionState, form: string): PotionState {
    return this.states.get(`${modifierId}:${form}:${stateIdentityKey(state)}`) ?? state;
  }

  changes(modifierId: string): boolean {
    return this.changedModifiers.has(modifierId);
  }
}

function modifiedState(mode: TransitionMode, state: PotionState, form: string): PotionState {
  return mode.globalModifierId && mode.modifiedStates
    ? mode.modifiedStates.get(mode.globalModifierId, state, form)
    : state;
}

function modifiedOutput(config: GeneratorConfig, mode: TransitionMode, state: PotionState, form: string): JsonObject {
  const outputState = modifiedState(mode, state, form);
  return mode.globalModifier
    ? modifierOutputStack(config, outputState, form, mode.outputParticles, mode.globalModifier)
    : outputStack(config, outputState, form, mode.outputParticles);
}

/** Generates custom variant and container transitions for one particle mode. */
async function generateCustomTransitions(
  config: GeneratorConfig,
  states: Map<string, PotionState>,
  tags: IngredientTagRegistry,
  mode: TransitionMode,
): Promise<number> {
  let count = 0;

  for (const { config: modifier, id: modifierId } of variantModifiers(config)) {
    for (const effectKey of Object.keys(config.custom.effects)) {
      const variants = customVariantNames(config, effectKey);
      for (const transform of modifierVariantEdges(config, modifier, variants)) {
        const source = stateForCustom(states, effectKey, transform.from),
         target = stateForCustom(states, effectKey, transform.to);
        if (!source || !target) continue;

        count += await forForms(config, async (form, formData) => {
          const transition = `${transform.from}_to_${transform.to}`,
           context: ItemTagContext = {
            source: 'custom',
            input: source.key,
            output: target.key,
            input_form: form,
            output_form: form,
            effect: effectKey,
            variant: transform.to,
            modifier: modifierId,
            category: 'modifier',
            recipe: `${mode.recipePrefix}/${effectKey}/modifier/${modifierId}/${transition}/${form}`,
            input_particles: mode.inputParticles,
            output_particles: mode.outputParticles,
          },
           ingredient = reagent(
            tags,
            { category: 'modifier', id: modifierId, config: modifier.reagent },
            `custom:${effectKey}:modifier:${modifierId}:${transition}`,
            context,
          );
          await saveRecipe(
            mode.root,
            `${effectKey}/modifiers/${modifierId}/${transition}/${form}.json`,
            brewingRecipe(
              config,
              formData.item,
              customMatcher(config, modifiedState(mode, source, form), mode.inputParticles),
              ingredient,
              modifiedOutput(config, mode, target, form),
            ),
          );
        }, mode.allowedForms);
      }
    }
  }

  for (const effectKey of Object.keys(config.custom.effects)) {
    for (const variant of customVariantNames(config, effectKey)) {
      const state = states.get(`${effectKey}:${variant}`)!;
      for (const { config: modifier, id: modifierId } of containerModifiers(config)) {
        const conversion = modifier.container_conversion!;
        if (mode.allowedForms &&
            (!mode.allowedForms.has(conversion.from) || !mode.allowedForms.has(conversion.to))) continue;

        const context: ItemTagContext = {
          source: 'custom',
          input: state.key,
          output: state.key,
          input_form: conversion.from,
          output_form: conversion.to,
          effect: effectKey,
          variant,
          modifier: modifierId,
          category: 'conversion',
          recipe: `${mode.recipePrefix}/${effectKey}/conversion/${variant}/${modifierId}`,
          input_particles: mode.inputParticles,
          output_particles: mode.outputParticles,
        },
         ingredient = reagent(
          tags,
          { category: 'modifier', id: modifierId, config: modifier.reagent },
          `custom:${effectKey}:modifier:${modifierId}`,
          context,
        );
        await saveRecipe(
          mode.root,
          `${effectKey}/conversions/${variant}/${modifierId}.json`,
          brewingRecipe(
            config,
            getForm(config, conversion.from).item,
            customMatcher(config, modifiedState(mode, state, conversion.from), mode.inputParticles),
            ingredient,
            modifiedOutput(config, mode, state, conversion.to),
          ),
        );
        count++;
      }
    }
  }

  return count;
}

/** Generates custom base recipes plus normal variant and form chains. */
async function generateCustomVisible(
  config: GeneratorConfig,
  outputRoot: string,
  states: Map<string, PotionState>,
  tags: IngredientTagRegistry,
): Promise<number> {
  let count = 0;

  for (const [effectKey, effect] of Object.entries(config.custom.effects)) {
    const state = states.get(`${effectKey}:base`)!,
     brews = brewEntries(effect.brew);

    for (const [inputPotion, reagentConfig] of brews) {
      const inputPath = brews.length > 1 ? `/${inputPotion}` : '';
      count += await forForms(config, async (form, formData) => {
        const context: ItemTagContext = {
          source: 'custom',
          input: inputPotion,
          output: state.key,
          input_form: form,
          output_form: form,
          effect: effectKey,
          variant: 'base',
          category: 'effect',
          recipe: `custom/${effectKey}/base${inputPath}/${form}`,
          input_particles: true,
          output_particles: true,
        },
         ingredient = reagent(
          tags,
          { category: 'effect', id: effectKey, config: reagentConfig },
          `custom:${effectKey}:base:${inputPotion}`,
          context,
        );
        await saveRecipe(
          outputRoot,
          `custom/${effectKey}/base${inputPath}/${form}.json`,
          brewingRecipe(
            config,
            formData.item,
            potionTypePredicate(config, inputPotion),
            ingredient,
            outputStack(config, state, form, true),
          ),
        );
      });
    }
  }

  count += await generateCustomTransitions(config, states, tags, {
    root: joinPath(outputRoot, 'custom'),
    recipePrefix: 'custom',
    inputParticles: true,
    outputParticles: true,
  });
  return count;
}


function vanillaTransitionMatcher(
  config: GeneratorConfig,
  mode: TransitionMode,
  state: PotionState,
  form: string,
): JsonObject {
  const input = modifiedState(mode, state, form);
  return mode.globalModifier
    ? customMatcher(config, input, mode.inputParticles)
    : visibleMatcher(config, input);
}

function vanillaTransitionOutput(
  config: GeneratorConfig,
  mode: TransitionMode,
  state: PotionState,
  form: string,
): JsonObject {
  return mode.globalModifier
    ? modifiedOutput(config, mode, state, form)
    : visibleOutputStack(config, state, form);
}

/** Generates only the non-registered vanilla variant tiers and their form conversions. */
async function generateVanillaVariantTransitions(
  config: GeneratorConfig,
  outputRoot: string,
  states: Map<string, PotionState>,
  tags: IngredientTagRegistry,
  mode: TransitionMode,
): Promise<number> {
  let count = 0;

  for (const { config: modifier, id: modifierId } of variantModifiers(config)) {
    for (const family of generatedVanillaFamilies(config)) {
      const variants = vanillaVariantNames(config, family);
      for (const transform of modifierVariantEdges(config, modifier, variants)) {
        const source = states.get(vanillaVariantKey(family, transform.from)),
         target = states.get(vanillaVariantKey(family, transform.to));
        if (!source || !target || (source.registeredPotion && target.registeredPotion)) continue;

        const transition = `${transform.from}_to_${transform.to}`;
        count += await forForms(config, async (form, formData) => {
          const context: ItemTagContext = {
            source: 'vanilla',
            input: source.key,
            output: target.key,
            input_form: form,
            output_form: form,
            effect: family,
            variant: transform.to,
            modifier: modifierId,
            category: 'modifier',
            recipe: `${mode.recipePrefix}/${family}/modifier/${modifierId}/${transition}/${form}`,
            input_particles: mode.inputParticles,
            output_particles: mode.outputParticles,
          },
           ingredient = reagent(
            tags,
            { category: 'modifier', id: modifierId, config: modifier.reagent },
            `vanilla:${family}:modifier:${modifierId}:${transition}`,
            context,
          );
          await saveRecipe(
            mode.root,
            `${family}/modifiers/${modifierId}/${transition}/${form}.json`,
            brewingRecipe(
              config,
              formData.item,
              vanillaTransitionMatcher(config, mode, source, form),
              ingredient,
              vanillaTransitionOutput(config, mode, target, form),
            ),
          );
        }, mode.allowedForms);
      }
    }
  }

  for (const family of generatedVanillaFamilies(config)) {
    for (const variant of vanillaVariantNames(config, family)) {
      const state = states.get(vanillaVariantKey(family, variant));
      if (!state || state.registeredPotion) continue;

      for (const { config: modifier, id: modifierId } of containerModifiers(config)) {
        const conversion = modifier.container_conversion!;
        if (mode.allowedForms &&
            (!mode.allowedForms.has(conversion.from) || !mode.allowedForms.has(conversion.to))) continue;

        const context: ItemTagContext = {
          source: 'vanilla',
          input: state.key,
          output: state.key,
          input_form: conversion.from,
          output_form: conversion.to,
          effect: family,
          variant,
          modifier: modifierId,
          category: 'conversion',
          recipe: `${mode.recipePrefix}/${family}/conversion/${variant}/${modifierId}`,
          input_particles: mode.inputParticles,
          output_particles: mode.outputParticles,
        },
         ingredient = reagent(
          tags,
          { category: 'modifier', id: modifierId, config: modifier.reagent },
          `vanilla:${family}:modifier:${modifierId}`,
          context,
        );
        await saveRecipe(
          mode.root,
          `${family}/conversions/${variant}/${modifierId}.json`,
          brewingRecipe(
            config,
            getForm(config, conversion.from).item,
            vanillaTransitionMatcher(config, mode, state, conversion.from),
            ingredient,
            vanillaTransitionOutput(config, mode, state, conversion.to),
          ),
        );
        count++;
      }
    }
  }

  return count;
}

interface VanillaTransformFamily {
  from: string;
  to: string;
  modifier: string;
  existing: Set<string>;
}

function vanillaTransformFamilies(config: GeneratorConfig): VanillaTransformFamily[] {
  const groups = new Map<string, VanillaTransformFamily>();
  for (const transform of config.vanilla.cross_effect_transforms ?? []) {
    const from = basePotionKey(transform.from),
     to = basePotionKey(transform.to),
     key = `${from}:${to}:${transform.modifier}`,
     group = groups.get(key) ?? { from, to, modifier: transform.modifier, existing: new Set<string>() };
    group.existing.add(`${transform.from}>${transform.to}`);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Extends configured vanilla corruption families across generated matching variants. */
async function generateVanillaVariantTransforms(
  config: GeneratorConfig,
  outputRoot: string,
  states: Map<string, PotionState>,
  tags: IngredientTagRegistry,
  mode: TransitionMode,
): Promise<number> {
  let count = 0;
  for (const transform of vanillaTransformFamilies(config)) {
    const modifier = getModifier(config, transform.modifier);
    for (const pair of vanillaTransformVariants(config, transform.from, transform.to)) {
      const sourceKey = vanillaVariantKey(transform.from, pair.from),
       targetKey = vanillaVariantKey(transform.to, pair.to);
      if (transform.existing.has(`${sourceKey}>${targetKey}`)) continue;

      const source = states.get(sourceKey),
       target = states.get(targetKey);
      if (!source || !target) continue;
      const transition = `${pair.from}_to_${pair.to}`;

      count += await forForms(config, async (form, formData) => {
        const context: ItemTagContext = {
          source: 'vanilla',
          input: source.key,
          output: target.key,
          input_effect: transform.from,
          output_effect: transform.to,
          input_form: form,
          output_form: form,
          effect: transform.to,
          variant: pair.to,
          modifier: transform.modifier,
          category: 'convert',
          recipe: `${mode.recipePrefix}/${transform.from}_to_${transform.to}/${transition}/${form}`,
          input_particles: mode.inputParticles,
          output_particles: mode.outputParticles,
        },
         ingredient = reagent(
          tags,
          { category: 'modifier', id: transform.modifier, config: modifier.reagent },
          `vanilla:transform:${transform.from}:${transform.to}:${transition}`,
          context,
        );
        await saveRecipe(
          mode.root,
          `${transform.from}_to_${transform.to}/${transition}/${form}.json`,
          brewingRecipe(
            config,
            formData.item,
            vanillaTransitionMatcher(config, mode, source, form),
            ingredient,
            vanillaTransitionOutput(config, mode, target, form),
          ),
        );
      }, mode.allowedForms);
    }
  }
  return count;
}

async function generateVanillaExtensions(
  config: GeneratorConfig,
  outputRoot: string,
  states: Map<string, PotionState>,
  tags: IngredientTagRegistry,
  modifiedStates: GlobalModifierStateRegistry,
): Promise<number> {
  const visibleMode: TransitionMode = {
    root: joinPath(outputRoot, 'vanilla_extensions'),
    recipePrefix: 'vanilla_extensions',
    inputParticles: true,
    outputParticles: true,
  };
  let count = await generateVanillaVariantTransitions(config, outputRoot, states, tags, visibleMode);
  count += await generateVanillaVariantTransforms(config, outputRoot, states, tags, visibleMode);

  for (const { config: modifier, id } of globalModifiers(config)) {
    const behavior = modifier.global!,
     outputParticles = behavior.output_show_particles ?? false,
     applies = behavior.apply_to ?? ['custom', 'vanilla'];
    if (!applies.includes('vanilla')) continue;
    if (outputParticles && !modifiedStates.changes(id)) continue;

    const mode: TransitionMode = {
      root: joinPath(outputRoot, id, 'vanilla_extended_chains'),
      recipePrefix: `${id}/vanilla_extended_chains`,
      inputParticles: outputParticles,
      outputParticles,
      globalModifier: behavior,
      globalModifierId: id,
      modifiedStates,
      allowedForms: new Set(globalModifierForms(config, modifier)),
    };
    count += await generateVanillaVariantTransitions(config, outputRoot, states, tags, mode);
    count += await generateVanillaVariantTransforms(config, outputRoot, states, tags, mode);
  }
  return count;
}

/** Applies output-preserving global modifiers across selected potion states. */
async function generateGlobalModifiers(
  config: GeneratorConfig,
  outputRoot: string,
  custom: Map<string, PotionState>,
  vanilla: Map<string, PotionState>,
  tags: IngredientTagRegistry,
  modifiedStates: GlobalModifierStateRegistry,
): Promise<number> {
  let count = 0;
  for (const { config: modifier, id: modifierId } of globalModifiers(config)) {
    const behavior = modifier.global!,
     inputParticles = behavior.input_show_particles ?? true,
     outputParticles = behavior.output_show_particles ?? false,
     applies = new Set<string>(behavior.apply_to ?? ['custom', 'vanilla']),
     forms = globalModifierForms(config, modifier);

    for (const entry of stateEntries(custom, vanilla, applies)) {
      count += await forForms(config, async (form, formData) => {
        const potionKey = entry.source === 'custom' ? entry.effect : entry.key,
         context: ItemTagContext = {
          source: entry.source,
          input: entry.state.key,
          output: entry.state.key,
          input_form: form,
          output_form: form,
          effect: entry.effect,
          variant: entry.variant,
          modifier: modifierId,
          category: 'global_modifier',
          recipe: `${modifierId}/${entry.source}/${potionKey}/${entry.variant}/${form}`,
          input_particles: inputParticles,
          output_particles: outputParticles,
        },
         ingredient = reagent(
          tags,
          { category: 'modifier', id: modifierId, config: modifier.reagent },
          `${entry.source}:${potionKey}:modifier:${modifierId}`,
          context,
        ),
         matcher =
          entry.source === 'vanilla' && inputParticles
            ? visibleMatcher(config, entry.state)
            : customMatcher(config, entry.state, inputParticles),
         relativePath =
          entry.source === 'custom'
            ? `${modifierId}/custom/${entry.effect}/${entry.variant}/${form}.json`
            : `${modifierId}/vanilla/${entry.key}/${form}.json`;

        await saveRecipe(
          outputRoot,
          relativePath,
          brewingRecipe(
            config,
            formData.item,
            matcher,
            ingredient,
            modifierOutputStack(config, modifiedStates.get(modifierId, entry.state, form), form, outputParticles, behavior),
          ),
        );
      }, forms);
    }
  }
  return count;
}

/** Generates custom transitions that preserve distinguishable global modifiers. */
async function generateModifiedCustomChains(
  config: GeneratorConfig,
  outputRoot: string,
  states: Map<string, PotionState>,
  tags: IngredientTagRegistry,
  modifiedStates: GlobalModifierStateRegistry,
): Promise<number> {
  let count = 0;
  for (const { config: modifier, id: modifierId } of globalModifiers(config)) {
    const behavior = modifier.global!,
     outputParticles = behavior.output_show_particles ?? false,
     applies = behavior.apply_to ?? ['custom', 'vanilla'],
     forms = new Set(globalModifierForms(config, modifier));
    if (!applies.includes('custom')) continue;
    if (outputParticles === true && !modifiedStates.changes(modifierId)) continue;

    count += await generateCustomTransitions(config, states, tags, {
      root: joinPath(outputRoot, modifierId, 'custom_chains'),
      recipePrefix: `${modifierId}/custom_chains`,
      inputParticles: outputParticles,
      outputParticles,
      globalModifier: behavior,
      globalModifierId: modifierId,
      modifiedStates,
      allowedForms: forms,
    });
  }
  return count;
}

/** Generates configured transformations between different custom effects. */
async function generateCrossEffectTransforms(
  config: GeneratorConfig,
  outputRoot: string,
  states: Map<string, PotionState>,
  tags: IngredientTagRegistry,
  modifiedStates: GlobalModifierStateRegistry,
): Promise<number> {
  let count = 0;
  for (const transform of config.custom.cross_effect_transforms ?? []) {
    const pairs = customTransformVariants(
      config,
      transform.from_effect,
      transform.to_effect,
      transform.variants,
      transform.from_variant ?? 'base',
      transform.to_variant ?? 'base',
    ),
     modifierId = transform.modifier ?? transform.id,
     modifier = getModifier(config, modifierId);

    for (const pair of pairs) {
      const source = states.get(`${transform.from_effect}:${pair.from}`),
       target = states.get(`${transform.to_effect}:${pair.to}`);
      if (!source || !target)
        throw new Error(`Invalid cross-effect transform ${transform.id}: ${pair.from} -> ${pair.to}`);

      const transition = `${pair.from}_to_${pair.to}`,
       modes: TransitionMode[] = [
        {
          root: joinPath(outputRoot, 'custom_transforms', transform.id, transition),
          recipePrefix: `custom_transform/${transform.id}/${transition}`,
          inputParticles: true,
          outputParticles: true,
        },
      ];

      for (const { config: globalModifier, id: globalId } of globalModifiers(config)) {
        const behavior = globalModifier.global!,
         outputParticles = behavior.output_show_particles ?? false,
         applies = behavior.apply_to ?? ['custom', 'vanilla'];
        if (!applies.includes('custom')) continue;
        if (outputParticles === true && !modifiedStates.changes(globalId)) continue;
        modes.push({
          root: joinPath(outputRoot, globalId, 'custom_chains', 'cross_effect', transform.id, transition),
          recipePrefix: `${globalId}/custom_chains/cross_effect/${transform.id}/${transition}`,
          inputParticles: outputParticles,
          outputParticles,
          globalModifier: behavior,
          globalModifierId: globalId,
          modifiedStates,
          allowedForms: new Set(globalModifierForms(config, globalModifier)),
        });
      }

      for (const mode of modes) {
        count += await forForms(config, async (form, formData) => {
          const context: ItemTagContext = {
            source: 'custom',
            input: source.key,
            output: target.key,
            input_effect: transform.from_effect,
            output_effect: transform.to_effect,
            input_form: form,
            output_form: form,
            effect: transform.to_effect,
            variant: pair.to,
            modifier: modifierId,
            category: 'convert',
            recipe: `${mode.recipePrefix}/${form}`,
            input_particles: mode.inputParticles,
            output_particles: mode.outputParticles,
          },
           ingredient = reagent(
            tags,
            { category: 'modifier', id: modifierId, config: modifier.reagent },
            `custom:transform:${transform.id}:${transition}`,
            context,
          );
          await saveRecipe(
            mode.root,
            `${form}.json`,
            brewingRecipe(
              config,
              formData.item,
              customMatcher(config, modifiedState(mode, source, form), mode.inputParticles),
              ingredient,
              modifiedOutput(config, mode, target, form),
            ),
          );
        }, mode.allowedForms);
      }
    }
  }
  return count;
}

function vanillaReagent(
  tags: IngredientTagRegistry,
  loaded: LoadedRecipe,
  useTag: boolean,
  extraContext: ItemTagContext,
): string {
  return tags.reference(loaded.reagent, useTag, loaded.fallbackItem, `vanilla:${fileStem(loaded.relativePath)}`, {
    ...loaded.context,
    ...extraContext,
  });
}

/** Reconstructs vanilla files and changes only `reagent.item` to the selected tag. */
async function generateVanillaRecipes(
  namespaceRoot: string,
  recipes: LoadedRecipe[],
  tags: IngredientTagRegistry,
  enabled: boolean,
): Promise<number> {
  if (!enabled) return 0;
  let count = 0;
  for (const loaded of recipes) {
    const rewritten = structuredClone(loaded.value);
    rewritten.reagent.item = vanillaReagent(tags, loaded, true, {
      input_particles: true,
      output_particles: true,
    });
    await saveRecipe(vanillaRecipeRoot(namespaceRoot), loaded.relativePath, rewritten);
    count++;
  }
  return count;
}

/** Mirrors vanilla transformation chains for distinguishable global modifiers. */
async function generateModifiedVanillaChains(
  config: GeneratorConfig,
  outputRoot: string,
  recipes: LoadedRecipe[],
  states: Map<string, PotionState>,
  tags: IngredientTagRegistry,
  includeVanilla: boolean,
  modifiedStates: GlobalModifierStateRegistry,
): Promise<number> {
  let count = 0;
  const forms = formByItem(config);

  for (const { config: modifier, id: modifierId } of globalModifiers(config)) {
    const behavior = modifier.global!,
     outputParticles = behavior.output_show_particles ?? false,
     applies = behavior.apply_to ?? ['custom', 'vanilla'],
     allowedForms = new Set(globalModifierForms(config, modifier));
    if (!applies.includes('vanilla')) continue;
    if (outputParticles === true && !modifiedStates.changes(modifierId)) continue;

    const usedPaths = new Set<string>();
    for (const loaded of recipes) {
      const value = loaded.value,
       namespace = config.generator.namespaces.vanilla,
       inputKey = extractPotionId(value.input?.potion_contents, namespace),
       outputKey = extractPotionId(value.output?.components?.[`${namespace}:potion_contents`], namespace),
       source = inputKey ? states.get(inputKey) : undefined,
       target = outputKey ? states.get(outputKey) : undefined,
       fromForm = forms.get(value.input?.item),
       toForm = forms.get(value.output?.id);
      if (!source || !target || !fromForm || !toForm ||
          !allowedForms.has(fromForm) || !allowedForms.has(toForm)) continue;

      const ingredient = vanillaReagent(tags, loaded, includeVanilla, {
        input_particles: outputParticles,
        output_particles: outputParticles,
      }),
       category = fromForm === toForm ? 'transforms' : 'conversions',
       outputPath = joinPath(
        outputRoot,
        modifierId,
        'vanilla_chains',
        category,
        fromForm,
        loaded.relativePath.split('/').at(-1),
      );
      if (usedPaths.has(outputPath)) throw new Error(`Duplicate generated vanilla chain path: ${outputPath}`);
      usedPaths.add(outputPath);

      await writeJson(
        outputPath,
        brewingRecipe(
          config,
          value.input.item,
          customMatcher(config, modifiedStates.get(modifierId, source, fromForm), outputParticles),
          ingredient,
          modifierOutputStack(config, modifiedStates.get(modifierId, target, toForm), toForm, outputParticles, behavior),
        ),
      );
      count++;
    }
  }
  return count;
}

function componentPreservingTippedArrowRecipe(config: GeneratorConfig): JsonObject {
  const namespace = config.generator.namespaces.vanilla,
   lingering = config.forms.lingering;
  if (!lingering) throw new Error('Component-preserving tipped arrows require the lingering form');

  return {
    type: `${namespace}:crafting_transmute`,
    category: 'misc',
    input: lingering.item,
    material: `${namespace}:arrow`,
    material_count: 8,
    result: {
      id: `${namespace}:tipped_arrow`,
      count: 8,
      components: {
        '!minecraft:custom_name': {},
      },
    },
  };
}

async function generateComponentPreservingTippedArrows(
  config: GeneratorConfig,
  vanillaNamespaceRoot: string,
): Promise<number> {
  if (config.generator.preserve_imbued_components === false) return 0;
  await writeJson(
    componentPreservingTippedArrowPath(vanillaNamespaceRoot),
    componentPreservingTippedArrowRecipe(config),
  );
  return 1;
}

/** Runs every recipe generation stage and returns detailed counts. */
export async function generateRecipes(
  config: GeneratorConfig,
  paths: GenerationPaths,
  custom: Map<string, PotionState>,
  vanilla: Map<string, PotionState>,
  vanillaRecipes: LoadedRecipe[],
  tags: IngredientTagRegistry,
  includeVanilla: boolean,
): Promise<GenerationCounts> {
  const outputRoot = customRecipeRoot(paths.customNamespaceRoot),
   modifiedStates = new GlobalModifierStateRegistry(config, custom, vanilla);
  return {
    custom_visible: await generateCustomVisible(config, outputRoot, custom, tags),
    global_modifiers: await generateGlobalModifiers(config, outputRoot, custom, vanilla, tags, modifiedStates),
    custom_modified_chains: await generateModifiedCustomChains(config, outputRoot, custom, tags, modifiedStates),
    cross_effect_transforms: await generateCrossEffectTransforms(config, outputRoot, custom, tags, modifiedStates),
    vanilla_extensions: await generateVanillaExtensions(config, outputRoot, vanilla, tags, modifiedStates),
    vanilla_modified_chains: await generateModifiedVanillaChains(
      config,
      outputRoot,
      vanillaRecipes,
      vanilla,
      tags,
      includeVanilla,
      modifiedStates,
    ),
    component_preserving_imbue: await generateComponentPreservingTippedArrows(
      config,
      paths.vanillaNamespaceRoot,
    ),
    included_vanilla: await generateVanillaRecipes(paths.vanillaNamespaceRoot, vanillaRecipes, tags, includeVanilla),
  };
}
