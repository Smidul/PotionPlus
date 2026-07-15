import { brewEntries, containerModifiers, getModifier, globalModifiers, variantModifiers } from './config.ts';
import type {
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
  outputStack,
  stateForCustom,
  visibleMatcher,
} from './potions.ts';
import { extractPotionId, variantName } from './vanilla.ts';
import { basePotionKey, fileStem, joinPath, namespaced, writeJson } from './utils.ts';

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
): Promise<number> {
  const forms = Object.entries(config.forms);
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
    for (const [id, state] of custom) {
      const [effect = id, variant = 'base'] = id.split(':', 2);
      entries.push({ source: 'custom', key: id, effect, variant, state });
    }
  }
  if (applies.has('vanilla')) {
    for (const [key, state] of vanilla) {
      entries.push({
        source: 'vanilla',
        key,
        effect: basePotionKey(key),
        variant: variantName(key),
        state,
      });
    }
  }
  return entries;
}

function modifiedOutput(config: GeneratorConfig, mode: TransitionMode, state: PotionState, form: string): JsonObject {
  return mode.globalModifier
    ? modifierOutputStack(config, state, form, mode.outputParticles, mode.globalModifier)
    : outputStack(config, state, form, mode.outputParticles);
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
    const transform = modifier.variant_transform!;
    for (const effectKey of Object.keys(config.custom.effects)) {
      const source = stateForCustom(states, effectKey, transform.from),
       target = stateForCustom(states, effectKey, transform.to);
      if (!source || !target) continue;

      count += await forForms(config, async (form, formData) => {
        const context: ItemTagContext = {
          source: 'custom',
          input: source.key,
          output: target.key,
          input_form: form,
          output_form: form,
          effect: effectKey,
          variant: transform.to,
          modifier: modifierId,
          category: 'modifier',
          recipe: `${mode.recipePrefix}/${effectKey}/modifier/${modifierId}/${form}`,
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
          `${effectKey}/modifiers/${modifierId}/${form}.json`,
          brewingRecipe(
            config,
            formData.item,
            customMatcher(source, mode.inputParticles),
            ingredient,
            modifiedOutput(config, mode, target, form),
          ),
        );
      });
    }
  }

  for (const [effectKey, effect] of Object.entries(config.custom.effects)) {
    for (const variant of Object.keys(effect.variants)) {
      const state = states.get(`${effectKey}:${variant}`)!;
      for (const { config: modifier, id: modifierId } of containerModifiers(config)) {
        const conversion = modifier.container_conversion!,
         context: ItemTagContext = {
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
            customMatcher(state, mode.inputParticles),
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
            { potions: namespaced(inputPotion, config.namespaces.vanilla) },
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

/** Applies output-preserving global modifiers across selected potion states. */
async function generateGlobalModifiers(
  config: GeneratorConfig,
  outputRoot: string,
  custom: Map<string, PotionState>,
  vanilla: Map<string, PotionState>,
  tags: IngredientTagRegistry,
): Promise<number> {
  let count = 0;
  for (const { config: modifier, id: modifierId } of globalModifiers(config)) {
    const behavior = modifier.global!,
     inputParticles = behavior.input_show_particles ?? true,
     outputParticles = behavior.output_show_particles ?? false,
     applies = new Set<string>(behavior.apply_to ?? ['custom', 'vanilla']);

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
            ? visibleMatcher(entry.state, config.namespaces.vanilla)
            : customMatcher(entry.state, inputParticles),
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
            modifierOutputStack(config, entry.state, form, outputParticles, behavior),
          ),
        );
      });
    }
  }
  return count;
}

/** Generates custom transitions that preserve particle-hidden global modifiers. */
async function generateHiddenCustomChains(
  config: GeneratorConfig,
  outputRoot: string,
  states: Map<string, PotionState>,
  tags: IngredientTagRegistry,
): Promise<number> {
  let count = 0;
  for (const { config: modifier, id: modifierId } of globalModifiers(config)) {
    const behavior = modifier.global!;
    if (behavior.output_show_particles !== false || !(behavior.apply_to ?? []).includes('custom')) continue;
    count += await generateCustomTransitions(config, states, tags, {
      root: joinPath(outputRoot, modifierId, 'custom_chains'),
      recipePrefix: `${modifierId}/custom_chains`,
      inputParticles: false,
      outputParticles: false,
      globalModifier: behavior,
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
): Promise<number> {
  let count = 0;
  for (const transform of config.custom.cross_effect_transforms ?? []) {
    const fromVariant = transform.from_variant ?? 'base',
     toVariant = transform.to_variant ?? 'base',
     source = states.get(`${transform.from_effect}:${fromVariant}`),
     target = states.get(`${transform.to_effect}:${toVariant}`);
    if (!source || !target) throw new Error(`Invalid cross-effect transform: ${transform.id}`);

    const modifierId = transform.modifier ?? transform.id,
     modifier = getModifier(config, modifierId),
     modes: TransitionMode[] = [
      {
        root: joinPath(outputRoot, 'custom_transforms', transform.id),
        recipePrefix: `custom_transform/${transform.id}`,
        inputParticles: true,
        outputParticles: true,
      },
    ];

    for (const { config: globalModifier, id: globalId } of globalModifiers(config)) {
      const behavior = globalModifier.global!;
      if (behavior.output_show_particles !== false || !(behavior.apply_to ?? []).includes('custom')) continue;
      modes.push({
        root: joinPath(outputRoot, globalId, 'custom_chains', 'cross_effect', transform.id),
        recipePrefix: `${globalId}/custom_chains/cross_effect/${transform.id}`,
        inputParticles: false,
        outputParticles: false,
        globalModifier: behavior,
      });
    }

    for (const mode of modes) {
      count += await forForms(config, async (form, formData) => {
        const context: ItemTagContext = {
          source: 'custom',
          input: source.key,
          output: target.key,
          input_form: form,
          output_form: form,
          effect: transform.to_effect,
          variant: toVariant,
          modifier: modifierId,
          category: 'convert',
          recipe: `${mode.recipePrefix}/${form}`,
          input_particles: mode.inputParticles,
          output_particles: mode.outputParticles,
        },
         ingredient = reagent(
          tags,
          { category: 'modifier', id: modifierId, config: modifier.reagent },
          `custom:transform:${transform.id}`,
          context,
        );
        await saveRecipe(
          mode.root,
          `${form}.json`,
          brewingRecipe(
            config,
            formData.item,
            customMatcher(source, mode.inputParticles),
            ingredient,
            modifiedOutput(config, mode, target, form),
          ),
        );
      });
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

/** Mirrors vanilla transformation chains for particle-hidden vanilla potions. */
async function generateHiddenVanillaChains(
  config: GeneratorConfig,
  outputRoot: string,
  recipes: LoadedRecipe[],
  states: Map<string, PotionState>,
  tags: IngredientTagRegistry,
  includeVanilla: boolean,
): Promise<number> {
  let count = 0;
  const forms = formByItem(config);

  for (const { config: modifier, id: modifierId } of globalModifiers(config)) {
    const behavior = modifier.global!;
    if (behavior.output_show_particles !== false || !(behavior.apply_to ?? []).includes('vanilla')) continue;

    const usedPaths = new Set<string>();
    for (const loaded of recipes) {
      const value = loaded.value,
       namespace = config.namespaces.vanilla,
       inputKey = extractPotionId(value.input?.potion_contents, namespace),
       outputKey = extractPotionId(value.output?.components?.[`${namespace}:potion_contents`], namespace),
       source = inputKey ? states.get(inputKey) : undefined,
       target = outputKey ? states.get(outputKey) : undefined,
       fromForm = forms.get(value.input?.item),
       toForm = forms.get(value.output?.id);
      if (!source || !target || !fromForm || !toForm) continue;

      const ingredient = vanillaReagent(tags, loaded, includeVanilla, {
        input_particles: false,
        output_particles: false,
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
          customMatcher(source, false),
          ingredient,
          modifierOutputStack(config, target, toForm, false, behavior),
        ),
      );
      count++;
    }
  }
  return count;
}

function componentPreservingTippedArrowRecipe(config: GeneratorConfig): JsonObject {
  const namespace = config.namespaces.vanilla,
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
  const outputRoot = customRecipeRoot(paths.customNamespaceRoot);
  return {
    custom_visible: await generateCustomVisible(config, outputRoot, custom, tags),
    global_modifiers: await generateGlobalModifiers(config, outputRoot, custom, vanilla, tags),
    custom_modified_chains: await generateHiddenCustomChains(config, outputRoot, custom, tags),
    cross_effect_transforms: await generateCrossEffectTransforms(config, outputRoot, custom, tags),
    vanilla_modified_chains: await generateHiddenVanillaChains(
      config,
      outputRoot,
      vanillaRecipes,
      vanilla,
      tags,
      includeVanilla,
    ),
    component_preserving_imbue: await generateComponentPreservingTippedArrows(
      config,
      paths.vanillaNamespaceRoot,
    ),
    included_vanilla: await generateVanillaRecipes(paths.vanillaNamespaceRoot, vanillaRecipes, tags, includeVanilla),
  };
}
