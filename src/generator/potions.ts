import type { GeneratorConfig, JsonObject, PotionState } from './types.ts';
import { basePotionKey, namespaced } from './utils.ts';

/** Maps Minecraft potion item IDs to configured form names. */
export function formByItem(config: GeneratorConfig): Map<string, string> {
  return new Map(Object.entries(config.forms).map(([name, form]) => [form.item, name]));
}

/** Normalizes every configured Overbrew effect variant. */
export function customStates(config: GeneratorConfig): Map<string, PotionState> {
  const states = new Map<string, PotionState>();
  for (const [effectKey, effect] of Object.entries(config.custom.effects)) {
    for (const [variantName, variant] of Object.entries<JsonObject>(effect.variants)) {
      states.set(`${effectKey}:${variantName}`, {
        key: variantName === 'base' ? effectKey : `${variantName}_${effectKey}`,
        display: effect.display,
        translationSuffix: effect.translation_suffix ?? effectKey,
        color: Number(effect.color),
        effects: [
          {
            id: namespaced(effect.effect_id, config.namespaces.vanilla),
            amplifier: Number(variant.amplifier),
            duration: Number(variant.duration),
          },
        ],
        source: 'custom',
      });
    }
  }
  return states;
}

/** Normalizes vanilla potion definitions used by global modifiers and mirrored chains. */
export function vanillaStates(config: GeneratorConfig): Map<string, PotionState> {
  const states = new Map<string, PotionState>();
  for (const [potionKey, potion] of Object.entries(config.vanilla.potions)) {
    states.set(potionKey, {
      key: potionKey,
      display: potion.display,
      translationSuffix: basePotionKey(potion.translation_suffix ?? potionKey),
      color: Number(potion.color),
      effects: potion.effects.map((effect: JsonObject) => ({
        id: namespaced(effect.id, config.namespaces.vanilla),
        amplifier: Number(effect.amplifier ?? 0),
        duration: Number(effect.duration ?? 1),
      })),
      source: 'vanilla',
    });
  }
  return states;
}

/** Creates the exact effect collection predicate used for custom potion states. */
export function effectPredicate(state: PotionState, showParticles: boolean): JsonObject {
  return {
    effects: {
      contains: state.effects.map(effect => ({
        [effect.id]: {
          amplifier: effect.amplifier,
          duration: effect.duration,
          visible: showParticles,
        },
      })),
      size: state.effects.length,
    },
  };
}

/** Returns one configured potion form or throws when the form is unknown. */
export function getForm(config: GeneratorConfig, form: string): JsonObject {
  const formData = config.forms[form];
  if (!formData) throw new Error(`Unknown potion form: ${form}`);
  return formData;
}

function itemName(config: GeneratorConfig, state: PotionState, form: string): JsonObject {
  const formConfig = getForm(config, form);
  return {
    translate: `item.${config.namespaces.vanilla}.${formConfig.translation_item}.effect.${basePotionKey(state.translationSuffix)}`,
    fallback: `${formConfig.fallback_prefix ?? 'Potion of '}${state.display}`,
    italic: false,
  };
}

/**
 * Builds a potion item stack. Extra components may add or replace any output
 * item component; a `null` component value removes that component.
 */
export function outputStack(
  config: GeneratorConfig,
  state: PotionState,
  form: string,
  showParticles: boolean,
  lore?: JsonObject[] | null,
  extraComponents?: JsonObject | null,
): JsonObject {
  const components: JsonObject = {
    'minecraft:custom_name': itemName(config, state, form),
    'minecraft:potion_contents': {
      custom_color: state.color,
      custom_effects: state.effects.map(effect => ({
        id: effect.id,
        amplifier: effect.amplifier,
        duration: effect.duration,
        show_particles: showParticles,
      })),
    },
  };
  if (lore?.length) components['minecraft:lore'] = lore;
  for (const [component, value] of Object.entries(extraComponents ?? {})) {
    if (value === null) delete components[component];
    else components[component] = structuredClone(value);
  }
  return { id: getForm(config, form).item, components };
}

/** Returns configured modifier lore, or `null` when no lore is defined. */
export function modifierLore(modifier: JsonObject): JsonObject[] | null {
  return Array.isArray(modifier.lore) && modifier.lore.length ? modifier.lore : null;
}

/** Applies one global modifier's lore and output components. */
export function modifierOutputStack(
  config: GeneratorConfig,
  state: PotionState,
  form: string,
  showParticles: boolean,
  modifier: JsonObject,
): JsonObject {
  return outputStack(config, state, form, showParticles, modifierLore(modifier), modifier.output_components ?? null);
}

/** Creates one data-driven Minecraft brewing recipe. */
export function brewingRecipe(
  config: GeneratorConfig,
  inputItem: string,
  inputPotionContents: JsonObject,
  reagent: string,
  output: JsonObject,
): JsonObject {
  return {
    type: `${config.namespaces.vanilla}:brewing`,
    input: { item: inputItem, potion_contents: inputPotionContents },
    reagent: { item: namespaced(reagent, config.namespaces.vanilla) },
    output,
  };
}

/** Matches a visible vanilla or custom potion state. */
export function visibleMatcher(state: PotionState, vanillaNamespace = 'minecraft'): JsonObject {
  return state.source === 'vanilla' ? { potions: `${vanillaNamespace}:${state.key}` } : effectPredicate(state, true);
}

/** Matches a custom-effect potion state with the requested particle visibility. */
export function customMatcher(state: PotionState, showParticles: boolean): JsonObject {
  return effectPredicate(state, showParticles);
}

/** Looks up one normalized custom effect variant. */
export function stateForCustom(
  states: Map<string, PotionState>,
  effectKey: string,
  variant: string,
): PotionState | undefined {
  return states.get(`${effectKey}:${variant}`);
}
