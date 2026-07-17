import { potionMatchingOptions, potionTypeNeedsEmptyEffects } from './config.ts';
import type { GeneratorConfig, JsonObject, PotionState } from './types.ts';
import { basePotionKey, namespaced, resourcePath } from './utils.ts';
import {
  customVariantDefinitions,
  generatedVanillaFamilies,
  vanillaVariantDefinitions,
  vanillaVariantKey,
} from './variants.ts';

/** Maps Minecraft potion item IDs to configured form names. */
export function formByItem(config: GeneratorConfig): Map<string, string> {
  return new Map(Object.entries(config.forms).map(([name, form]) => [form.item, name]));
}

function normalizeEffect(
  config: GeneratorConfig,
  effect: JsonObject,
  fallbackId?: string,
): JsonObject {
  const rawId = effect.id ?? fallbackId;
  if (typeof rawId !== 'string' || !rawId)
    throw new Error('Potion effects require an effect ID');

  const normalized: JsonObject = {
    id: namespaced(rawId, config.generator.namespaces.vanilla),
    amplifier: Number(effect.amplifier ?? 0),
    duration: Number(effect.duration ?? 1),
    ambient: Boolean(effect.ambient ?? false),
  };
  if (effect.show_particles !== undefined) normalized.show_particles = Boolean(effect.show_particles);
  if (effect.show_icon !== undefined) normalized.show_icon = Boolean(effect.show_icon);

  if (effect.hidden_effect !== undefined) {
    if (!effect.hidden_effect || typeof effect.hidden_effect !== 'object' || Array.isArray(effect.hidden_effect))
      throw new Error(`Invalid hidden_effect for ${normalized.id}`);
    normalized.hidden_effect = normalizeEffect(config, effect.hidden_effect as JsonObject, normalized.id);
  }
  return normalized;
}

/** Normalizes one configurable effect instance for generator-owned output. */
export function normalizeConfiguredEffect(config: GeneratorConfig, effect: JsonObject): JsonObject {
  return normalizeEffect(config, effect);
}

/** Normalizes every configured Overbrew effect variant. */
export function customStates(config: GeneratorConfig): Map<string, PotionState> {
  const states = new Map<string, PotionState>(),
   defaultPotion = potionMatchingOptions(config).default_potion_type;
  for (const [effectKey, effect] of Object.entries(config.custom.effects)) {
    for (const [variant, definition] of Object.entries(customVariantDefinitions(config, effectKey))) {
      states.set(`${effectKey}:${variant}`, {
        key: variant === 'base' ? effectKey : `${variant}_${effectKey}`,
        display: effect.display,
        translationSuffix: effect.translation_suffix ?? effectKey,
        color: Number(definition.color ?? effect.color),
        potion: defaultPotion ?? undefined,
        registeredPotion: definition.potion,
        effects: definition.effects.map(effectDefinition => normalizeEffect(config, effectDefinition, effect.effect_id)),
        family: effectKey,
        variant,
        source: 'custom',
      });
    }
  }
  return states;
}

/** Normalizes registered and generated vanilla potion states. */
export function vanillaStates(config: GeneratorConfig): Map<string, PotionState> {
  const states = new Map<string, PotionState>(),
   defaultPotion = potionMatchingOptions(config).default_potion_type;

  for (const family of generatedVanillaFamilies(config)) {
    const potion = config.vanilla.potions[family];
    for (const [variant, definition] of Object.entries(vanillaVariantDefinitions(config, family))) {
      const stateKey = vanillaVariantKey(family, variant),
       key = definition.potion ? resourcePath(definition.potion) : stateKey;
      states.set(stateKey, {
        key,
        display: potion.display,
        translationSuffix: basePotionKey(potion.translation_suffix ?? family),
        color: Number(definition.color ?? potion.color),
        potion: defaultPotion ?? undefined,
        registeredPotion: definition.potion,
        effects: definition.effects.map(effectDefinition => normalizeEffect(config, effectDefinition)),
        family,
        variant,
        source: 'vanilla',
      });
    }
  }
  return states;
}

function effectVisibility(effect: JsonObject, fallback: boolean): boolean {
  return effect.show_particles === undefined ? fallback : Boolean(effect.show_particles);
}

/** Creates the configured potion-content predicate used for custom potion states. */
export function effectPredicate(
  config: GeneratorConfig,
  state: PotionState,
  showParticles?: boolean,
  fieldOverrides: Partial<ReturnType<typeof potionMatchingOptions>['effect_fields']> = {},
): JsonObject {
  const fields = { ...potionMatchingOptions(config).effect_fields, ...fieldOverrides };
  const predicate: JsonObject = {
    effects: {
      contains: state.effects.map(effect => {
        const properties: JsonObject = {};
        if (fields.duration) properties.duration = effect.duration;
        if (fields.amplifier) properties.amplifier = effect.amplifier;
        if (fields.ambient) properties.ambient = Boolean(effect.ambient ?? false);
        if (fields.visible && showParticles !== undefined)
          properties.visible = effectVisibility(effect, showParticles);
        return { [effect.id]: properties };
      }),
      size: state.effects.length,
    },
  };
  if (state.potion) predicate.potions = namespaced(state.potion, config.generator.namespaces.vanilla);
  return predicate;
}

/** Matches one potion type and adds a zero-effect guard only when active identity strategies require it. */
export function potionTypePredicate(config: GeneratorConfig, potion: string): JsonObject {
  const value = namespaced(potion, config.generator.namespaces.vanilla),
   predicate: JsonObject = { potions: value };
  if (potionTypeNeedsEmptyEffects(config, value)) predicate.effects = { size: 0 };
  return predicate;
}

/** Returns one configured potion form or throws when the form is unknown. */
export function getForm(config: GeneratorConfig, form: string): JsonObject {
  const formData = config.forms[form];
  if (!formData) throw new Error(`Unknown potion form: ${form}`);
  return formData;
}

function itemName(config: GeneratorConfig, state: PotionState, form: string): JsonObject {
  const formConfig = getForm(config, form),
   namespace = config.generator.namespaces.vanilla;
  return {
    translate: `item.${namespace}.${formConfig.translation_item}.effect.${basePotionKey(state.translationSuffix)}`,
    fallback: `${formConfig.fallback_prefix ?? 'Potion of '}${state.display}`,
    italic: false,
  };
}

function outputEffect(effect: JsonObject, showParticles: boolean): JsonObject {
  const output: JsonObject = {
    id: effect.id,
    amplifier: Number(effect.amplifier ?? 0),
    duration: Number(effect.duration ?? 1),
    ambient: Boolean(effect.ambient ?? false),
    show_particles: effectVisibility(effect, showParticles),
    show_icon: Boolean(effect.show_icon ?? true),
  };
  if (effect.hidden_effect)
    output.hidden_effect = outputEffect(effect.hidden_effect as JsonObject, showParticles);
  return output;
}

/**
 * Builds a potion item stack and applies an optional component patch.
 * A `null` value removes the matching component.
 */
export function outputStack(
  config: GeneratorConfig,
  state: PotionState,
  form: string,
  showParticles: boolean,
  componentPatch?: JsonObject | null,
): JsonObject {
  const components: JsonObject = {
    'minecraft:custom_name': itemName(config, state, form),
    'minecraft:potion_contents': {
      custom_color: state.color,
      custom_effects: state.effects.map(effect => outputEffect(effect, showParticles)),
    },
  };
  if (state.potion)
    (components['minecraft:potion_contents'] as JsonObject).potion = namespaced(
      state.potion,
      config.generator.namespaces.vanilla,
    );

  for (const [component, value] of Object.entries(componentPatch ?? {})) {
    if (value === null) delete components[component];
    else components[component] = structuredClone(value);
  }

  return { id: getForm(config, form).item, components };
}

/** Applies one global modifier's component patch. */
export function modifierOutputStack(
  config: GeneratorConfig,
  state: PotionState,
  form: string,
  showParticles: boolean,
  modifier: JsonObject,
): JsonObject {
  return outputStack(config, state, form, showParticles, modifier.components ?? null);
}

/** Creates one data-driven Minecraft brewing recipe. */
export function brewingRecipe(
  config: GeneratorConfig,
  inputItem: string,
  inputPotionContents: JsonObject,
  reagent: string,
  output: JsonObject,
): JsonObject {
  const namespace = config.generator.namespaces.vanilla;
  return {
    type: `${namespace}:brewing`,
    input: { item: inputItem, potion_contents: inputPotionContents },
    reagent: { item: namespaced(reagent, namespace) },
    output,
  };
}

/** Matches a visible registered potion type or a generated custom-effect state. */
export function visibleMatcher(config: GeneratorConfig, state: PotionState): JsonObject {
  return state.registeredPotion
    ? { potions: namespaced(state.registeredPotion, config.generator.namespaces.vanilla) }
    : effectPredicate(config, state, true);
}

/** Builds an unmodified output, preserving registered vanilla potion types when available. */
export function visibleOutputStack(
  config: GeneratorConfig,
  state: PotionState,
  form: string,
): JsonObject {
  if (!state.registeredPotion) return outputStack(config, state, form, true);
  const namespace = config.generator.namespaces.vanilla;
  return {
    id: getForm(config, form).item,
    components: {
      [`${namespace}:potion_contents`]: {
        potion: namespaced(state.registeredPotion, namespace),
      },
    },
  };
}

/** Matches a custom-effect potion state with the requested particle visibility. */
export function customMatcher(config: GeneratorConfig, state: PotionState, showParticles: boolean): JsonObject {
  return effectPredicate(config, state, showParticles);
}

/** Looks up one normalized custom effect variant. */
export function stateForCustom(
  states: Map<string, PotionState>,
  effectKey: string,
  variant: string,
): PotionState | undefined {
  return states.get(`${effectKey}:${variant}`);
}
