/** A JSON object accepted by Minecraft data files or generator configuration. */
export type JsonObject = Record<string, any>;

/** Identifies whether a normalized potion state comes from PotionPlus or vanilla. */
export type PotionSource = 'custom' | 'vanilla';

/** A normalized potion state shared by all recipe generation stages. */
export interface PotionState {
  /** Stable config key, such as `absorption` or `long_swiftness`. */
  key: string;
  /** Human-readable effect name used by fallback item text. */
  display: string;
  /** Base vanilla-style translation suffix, without `long_` or `strong_`. */
  translationSuffix: string;
  /** Decimal potion color written to `minecraft:potion_contents.custom_color`. */
  color: number;
  /** Normalized custom effects written to outputs and matched by predicates. */
  effects: JsonObject[];
  /** Whether the state was defined by PotionPlus or the vanilla model. */
  source: PotionSource;
}

/** Controls whether a reagent's default item tag exists and where it is written. */
export type ReagentTagConfig =
  | boolean
  | string
  | {
      /** Enables or disables this reagent's own generated tag. */
      enabled?: boolean;
      /** Overrides the default singular path, such as `modifier/extended`. */
      path?: string;
      /** Sets the generated Minecraft item tag's `replace` field. */
      replace?: boolean;
    };

/** Item values and optional tag behavior for one brewing reagent. */
export interface ReagentConfig {
  /** Items accepted by recipes using this reagent definition. */
  items: string[];
  /** Optional generated-tag override. Defaults to the matching auto family. */
  tag?: ReagentTagConfig;
}

/** Maps each input potion ID to the reagent that brews the configured output. */
export type BrewMap = Record<string, ReagentConfig>;

/** Reagent families that own the three default singular tag folders. */
export type ReagentCategory = 'base' | 'effect' | 'modifier';

/** Logical reagent definition used by custom and reconstructed vanilla recipes. */
export interface ReagentReference {
  /** Default generated tag family. */
  category: ReagentCategory;
  /** Stable ID inside the selected family. */
  id: string;
  /** Reagent item and tag configuration. */
  config: ReagentConfig;
}

/** A reconstructed vanilla recipe paired with its reagent metadata. */
export interface LoadedRecipe {
  /** Output path relative to `data/minecraft/recipe`. */
  relativePath: string;
  /** Exact vanilla recipe object before the reagent is routed through a tag. */
  value: JsonObject;
  /** Logical reagent used by tag generation. */
  reagent: ReagentReference;
  /** Original direct vanilla reagent item. */
  fallbackItem: string;
  /** Metadata exposed to automatic tags and matching rules. */
  context: ItemTagContext;
}

/** Context exposed to item-tag rules and optional automatic tag layers. */
export interface ItemTagContext extends JsonObject {
  source?: PotionSource;
  input?: string;
  output?: string;
  input_form?: string;
  output_form?: string;
  effect?: string;
  variant?: string;
  modifier?: string;
  category?: string;
  recipe?: string;
  operation?: string;
  recipe_key?: string;
  input_particles?: boolean;
  output_particles?: boolean;
}

/** Primitive values supported by item-tag rule comparisons. */
export type ItemTagPrimitive = string | number | boolean;

/** One expected rule value or a list interpreted as an OR comparison. */
export type ItemTagMatchValue = ItemTagPrimitive | ItemTagPrimitive[];

/**
 * Singular automatic item-tag families. Entries in `auto_generate` must match
 * these names exactly; plural aliases are intentionally unsupported.
 */
export type AutoItemTagKind = 'base' | 'effect' | 'modifier' | 'variant' | 'convert' | 'conversion' | 'recipe';

/** Routes matching recipes through one additional generated item tag. */
export interface ItemTagRuleConfig {
  /** Tag path relative to `generator.item_tags.root`. */
  path: string;
  /** Values placed in the tag. `$default` and `$auto` inherit earlier layers. */
  values?: string[];
  /** One context matcher. */
  match?: Record<string, ItemTagMatchValue>;
  /** Alternative context matchers; any matching object activates the rule. */
  matches?: Record<string, ItemTagMatchValue>[];
}

/** Global item-tag generation settings. */
export interface ItemTagsConfig {
  /** Enables generated reagent tags globally. */
  enabled?: boolean;
  /** Root path under `tags/item`; defaults to `brewing`. */
  root?: string;
  /** Ordered singular automatic families to add after the default reagent tag. */
  auto_generate?: AutoItemTagKind[];
  /** Ordered contextual rules; the first matching rule wins. */
  rules?: ItemTagRuleConfig[];
}

/** One configured potion item form. */
export interface FormConfig extends JsonObject {
  /** Minecraft potion item ID used by this form. */
  item: string;
  /** Vanilla translation item segment, such as `potion` or `splash_potion`. */
  translation_item: string;
  /** English prefix used by the custom-name fallback. */
  fallback_prefix: string;
}

/** One base potion and the input-to-reagent brews that create it. */
export interface BaseConfig extends JsonObject {
  /** Maps input potion IDs to reagents that produce this base potion. */
  brew: BrewMap;
}

/** One reusable brewing modifier. */
export interface ModifierConfig extends JsonObject {
  /** Reagent accepted by recipes using this modifier. */
  reagent: ReagentConfig;
  /** Same-container variant transition, such as `base` to `long`. */
  variant_transform?: { from: string; to: string };
  /** Container transition, such as `regular` to `splash`. */
  container_conversion?: { from: string; to: string };
  /** Output-preserving behavior, such as hiding particles or adding components. */
  global?: JsonObject;
}

/** One PotionPlus effect and all of its potion variants. */
export interface CustomEffectConfig extends JsonObject {
  /** Minecraft status-effect ID. */
  effect_id: string;
  /** Fallback display name. */
  display: string;
  /** Optional translation suffix; defaults to the effect config key. */
  translation_suffix?: string;
  /** Decimal potion color. */
  color: number;
  /** Variant definitions keyed by names such as `base`, `long`, and `strong`. */
  variants: Record<string, JsonObject>;
  /** Input potion IDs mapped to their brewing reagents. */
  brew: BrewMap;
}

/** One normalized vanilla potion state. */
export interface VanillaPotionConfig extends JsonObject {
  /** Fallback display name. */
  display: string;
  /** Base translation suffix shared by normal, long, and strong states. */
  translation_suffix?: string;
  /** Decimal potion color. */
  color: number;
  /** Vanilla effects represented by this potion state. */
  effects: JsonObject[];
  /** Optional direct input-to-reagent brews that create this potion state. */
  brew?: BrewMap;
}

/** A configured custom transformation between two PotionPlus effects. */
export interface CustomCrossEffectTransform extends JsonObject {
  id: string;
  from_effect: string;
  to_effect: string;
  from_variant?: string;
  to_variant?: string;
  modifier?: string;
}

/** A configured vanilla transformation between two potion state IDs. */
export interface VanillaCrossEffectTransform {
  from: string;
  to: string;
  modifier: string;
}

/** PotionPlus-owned model. */
export interface CustomConfig {
  /** Custom brewable effects. */
  effects: Record<string, CustomEffectConfig>;
  /** Optional transformations between different custom effects. */
  cross_effect_transforms?: CustomCrossEffectTransform[];
}

/** Config-driven vanilla brewing model. */
export interface VanillaConfig {
  /** Every vanilla potion state used by brewing and mirrored modifier recipes. */
  potions: Record<string, VanillaPotionConfig>;
  /** Vanilla cross-effect conversions, such as Leaping to Slowness. */
  cross_effect_transforms?: VanillaCrossEffectTransform[];
}

/** Generator execution and output settings. */
export interface GeneratorOptions {
  /** Recreates vanilla brewing recipes with only `reagent.item` changed to tags. */
  include_vanilla_recipes?: boolean;
  /** Generated item-tag behavior. */
  item_tags?: ItemTagsConfig;
  /** Output paths resolved relative to the loaded config file. */
  output?: {
    /** Root `data` folder. */
    root?: string;
    /** Optional generation manifest path. */
    manifest?: string;
  };
}

/** Top-level config. All recipe graphs, forms, namespaces, and reagents are data-driven. */
export interface GeneratorConfig extends JsonObject {
  /** Target Minecraft and data-pack versions used for documentation and manifests. */
  target: JsonObject;
  /** Generator behavior, intentionally near the top of the JSON file. */
  generator: GeneratorOptions;
  /** Fixed custom and vanilla data-pack namespaces. */
  namespaces: { custom: string; vanilla: string };
  /** Potion container forms keyed by logical form name. */
  forms: Record<string, FormConfig>;
  /** Base potion recipes. */
  bases: Record<string, BaseConfig>;
  /** Shared recipe modifiers and their reagents. */
  modifiers: Record<string, ModifierConfig>;
  /** PotionPlus-owned effects and transformations. */
  custom: CustomConfig;
  /** Vanilla potion states and transformations. */
  vanilla: VanillaConfig;
}

/** Counts returned by each recipe generation stage. */
export type GenerationCounts = Record<string, number>;
