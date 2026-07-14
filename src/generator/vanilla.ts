import { brewEntries, containerModifiers, getModifier, vanillaConvertiblePotions, variantModifiers } from './config.ts';
import type { GeneratorConfig, ItemTagContext, JsonObject, LoadedRecipe, ReagentReference } from './types.ts';
import { baseName, basePotionKey, namespaced, resourcePath } from './utils.ts';

function vanillaRecipe(
  config: GeneratorConfig,
  inputItem: string,
  inputPotion: string,
  reagent: string,
  outputItem: string,
  outputPotion: string,
): JsonObject {
  const namespace = config.namespaces.vanilla;
  return {
    type: `${namespace}:brewing`,
    input: {
      item: namespaced(inputItem, namespace),
      potion_contents: { potions: namespaced(inputPotion, namespace) },
    },
    output: {
      components: {
        [`${namespace}:potion_contents`]: {
          potion: namespaced(outputPotion, namespace),
        },
      },
      id: namespaced(outputItem, namespace),
    },
    reagent: { item: namespaced(reagent, namespace) },
  };
}

function pushRecipe(
  recipes: LoadedRecipe[],
  config: GeneratorConfig,
  formInput: string,
  inputPotion: string,
  outputPotion: string,
  formOutput: string,
  reference: ReagentReference,
  fallbackItem: string,
  category: string,
): void {
  const file = `${resourcePath(formInput)}_${inputPotion}_${resourcePath(fallbackItem)}.json`,
   inputForm = vanillaFormName(namespaced(formInput, config.namespaces.vanilla), config),
   outputForm = vanillaFormName(namespaced(formOutput, config.namespaces.vanilla), config),
   context: ItemTagContext = {
    source: 'vanilla',
    input: inputPotion,
    output: outputPotion,
    input_form: inputForm,
    output_form: outputForm,
    effect: basePotionKey(outputPotion),
    variant: variantName(outputPotion),
    modifier: reference.category === 'modifier' ? reference.id : undefined,
    category,
    recipe: file.slice(0, -5),
    input_particles: true,
    output_particles: true,
  };

  recipes.push({
    relativePath: `brewing/${file}`,
    value: vanillaRecipe(config, formInput, inputPotion, fallbackItem, formOutput, outputPotion),
    reagent: reference,
    fallbackItem,
    context,
  });
}

function pushSameFormRecipes(
  recipes: LoadedRecipe[],
  config: GeneratorConfig,
  inputPotion: string,
  outputPotion: string,
  reference: ReagentReference,
  category: string,
): void {
  for (const form of Object.values(config.forms)) {
    for (const item of reference.config.items)
      pushRecipe(recipes, config, form.item, inputPotion, outputPotion, form.item, reference, item, category);
  }
}

function pushBrewMap(
  recipes: LoadedRecipe[],
  config: GeneratorConfig,
  outputPotion: string,
  category: 'base' | 'effect',
  brew: Record<string, ReagentReference['config']> | undefined,
): void {
  for (const [inputPotion, reagent] of brewEntries(brew)) {
    pushSameFormRecipes(
      recipes,
      config,
      inputPotion,
      outputPotion,
      { category, id: outputPotion, config: reagent },
      category,
    );
  }
}

function configuredVariantRecipes(recipes: LoadedRecipe[], config: GeneratorConfig): void {
  const potions = config.vanilla.potions,
   baseIds = new Set(Object.keys(potions).map(basePotionKey));

  for (const baseId of baseIds) {
    for (const { config: modifier, id: modifierId } of variantModifiers(config)) {
      const transform = modifier.variant_transform!,
       source = transform.from === 'base' ? baseId : `${transform.from}_${baseId}`,
       output = transform.to === 'base' ? baseId : `${transform.to}_${baseId}`;
      if (!potions[source] || !potions[output]) continue;

      pushSameFormRecipes(
        recipes,
        config,
        source,
        output,
        { category: 'modifier', id: modifierId, config: modifier.reagent },
        'modifier',
      );
    }
  }
}

/**
 * Reconstructs the complete vanilla brewing graph from config. Direct brews,
 * potion states, cross-effect transforms, forms, modifiers, and namespaces are
 * all data-driven. Variant and container conversion lists are derived.
 */
export function buildVanillaRecipes(config: GeneratorConfig): LoadedRecipe[] {
  const recipes: LoadedRecipe[] = [];

  for (const [baseId, base] of Object.entries(config.bases))
    pushBrewMap(recipes, config, baseId, 'base', base.brew);

  for (const [potionId, potion] of Object.entries(config.vanilla.potions))
    pushBrewMap(recipes, config, potionId, 'effect', potion.brew);


  configuredVariantRecipes(recipes, config);

  for (const transform of config.vanilla.cross_effect_transforms ?? []) {
    const modifier = getModifier(config, transform.modifier);
    pushSameFormRecipes(
      recipes,
      config,
      transform.from,
      transform.to,
      { category: 'modifier', id: transform.modifier, config: modifier.reagent },
      'convert',
    );
  }

  for (const { config: modifier, id } of containerModifiers(config)) {
    const conversion = modifier.container_conversion!,
     fromForm = config.forms[conversion.from],
     toForm = config.forms[conversion.to];
    if (!fromForm || !toForm) throw new Error(`Unknown form in modifier ${id}`);

    for (const potion of vanillaConvertiblePotions(config)) {
      for (const item of modifier.reagent.items) {
        pushRecipe(
          recipes,
          config,
          fromForm.item,
          potion,
          potion,
          toForm.item,
          { category: 'modifier', id, config: modifier.reagent },
          item,
          'conversion',
        );
      }
    }
  }

  return recipes.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/** Extracts one concrete potion ID from a vanilla potion-content predicate. */
export function extractPotionId(predicate: JsonObject | undefined, namespace = 'minecraft'): string | null {
  if (!predicate) return null;
  const potion = predicate.potions ?? predicate.potion,
   value =
    typeof potion === 'string'
      ? potion
      : Array.isArray(potion) && potion.length === 1 && typeof potion[0] === 'string'
        ? potion[0]
        : null;
  return value && !value.startsWith('#') ? value.replace(new RegExp(`^${namespace}:`), '') : null;
}

/** Finds the configured logical form name for a potion item ID. */
export function vanillaFormName(item: string, config: GeneratorConfig): string {
  return Object.entries(config.forms).find(([, form]) => form.item === item)?.[0] ?? baseName(item);
}

/** Returns the variant prefix represented by one vanilla potion state ID. */
export function variantName(potionKey: string): string {
  return potionKey.startsWith('long_') ? 'long' : potionKey.startsWith('strong_') ? 'strong' : 'base';
}
