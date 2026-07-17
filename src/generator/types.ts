/** A JSON object accepted by Minecraft data files or generator configuration. */
export type JsonObject = Record<string, any>;

/** Identifies whether a normalized potion state comes from Overbrew or vanilla. */
export type PotionSource = 'custom' | 'vanilla';

/** One independently upgradeable custom-potion property. */
export type VariantAxis = 'duration' | 'amplifier';

/** Coordinate of one generated duration/amplifier combination. */
export interface VariantCoordinate {
  duration: number;
  amplifier: number;
  name: string;
}

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
  /** Optional matchable base potion type written to generator-owned potion outputs. */
  potion?: string;
  /** Registered vanilla potion type used by exact input predicates, when one exists. */
  registeredPotion?: string;
  /** Stable potion family ID shared by every generated variant. */
  family?: string;
  /** Stable variant name within the potion family. */
  variant?: string;
  /** Normalized custom effects written to outputs and matched by predicates. */
  effects: JsonObject[];
  /** Whether the state was defined by Overbrew or the vanilla model. */
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
  input_effect?: string;
  output_effect?: string;
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

/** Output-preserving behavior applied by a global modifier. */
export interface GlobalModifierConfig extends JsonObject {
  /** Potion sources affected by this modifier. */
  apply_to?: PotionSource[];
  /** Logical potion forms affected by this modifier. Omitted means every configured form. */
  apply_to_forms?: string[];
  /** Particle state required on the input potion. */
  input_show_particles?: boolean;
  /** Particle state written to the output potion. */
  output_show_particles?: boolean;
  /**
   * Component patch applied to the generated output stack. A `null` value
   * removes the component.
   */
  components?: JsonObject;
}

/** One reusable brewing modifier. */
export interface ModifierConfig extends JsonObject {
  /** Reagent accepted by recipes using this modifier. */
  reagent: ReagentConfig;
  /** Config-driven transition along one custom variant axis. */
  variant_axis?: {
    /** Property changed by this modifier. */
    axis: VariantAxis;
    /** Target axis variant name, such as `prolonged` or `potent`. */
    to: string;
    /** Accepted source axis names. Defaults to the immediately previous tier. */
    from?: string[];
  };
  /** Container transition, such as `regular` to `splash`. */
  container_conversion?: { from: string; to: string };
  /** Output-preserving behavior, such as hiding particles or adding components. */
  global?: GlobalModifierConfig;
}


/** One explicit or profiled potion state. */
export type VariantEffectState = JsonObject | JsonObject[];

/**
 * One configured variant state. A namespaced string uses an existing potion
 * registry type; an object or array supplies effect values for generated output.
 */
export interface VariantStateObject extends JsonObject {
  /** Optional registered potion type. A plain namespaced string is shorthand for this field. */
  potion?: string;
  /** Optional state-specific potion color. */
  color?: number;
  /** Optional single- or multi-effect values. Without wrapper fields, the object itself is one effect state. */
  effects?: VariantEffectState;
}

/** Registered potion ID or explicit effect state used by one variant. */
export type VariantStateConfig = string | VariantEffectState | VariantStateObject;

/** One fully resolved potion state used by normalization and recipe generation. */
export interface ResolvedVariantDefinition {
  /** Existing potion registry type used by exact predicates and outputs. */
  potion?: string;
  /** Optional state-specific potion color. */
  color?: number;
  /** Fully calculated custom effects represented by this state. */
  effects: JsonObject[];
}

/** Exact multiplier accepted by variant profiles and local scaling rules. */
export type VariantRatio =
  | number
  | {
      /** Multiplier numerator. */
      numerator: number;
      /** Multiplier denominator. */
      denominator: number;
    };

/** Duration-axis calculation shared by profiles and potion families. */
export interface VariantDurationScaling {
  /** Multiplier used to derive the first duration tier. */
  multiplier?: VariantRatio;
  /** How later duration tiers repeat the first upgrade. Defaults to `multiplicative`. */
  progression?: 'linear' | 'multiplicative';
  /** Optional per-effect multiplier overrides keyed by effect ID. */
  multipliers?: Record<string, VariantRatio>;
}

/** Amplifier-axis calculation shared by profiles and potion families. */
export interface VariantAmplifierScaling {
  /** Amplifier increase applied once for every amplifier tier. */
  step?: number;
  /** Optional per-effect amplifier increases keyed by effect ID. */
  steps?: Record<string, number>;
  /** Duration multiplier applied once for every amplifier tier. */
  duration_multiplier?: VariantRatio;
  /** Optional per-effect duration multiplier overrides keyed by effect ID. */
  duration_multipliers?: Record<string, VariantRatio>;
}

/** Reusable or local variant support and calculation behavior. */
export interface VariantPolicy {
  /** Number of supported non-base duration tiers. */
  durations?: number;
  /** Number of supported non-base amplifier tiers. */
  amplifiers?: number;
  /** Generates combinations between both axes. Defaults to `true`. */
  mix?: boolean;
  /** Sequential calculations used for omitted states. */
  scaling?: {
    duration?: VariantDurationScaling;
    amplifier?: VariantAmplifierScaling;
  };
}

/** One reusable variant profile. */
export interface VariantProfile extends VariantPolicy {
  /** Optional parent profile merged before this profile. */
  extends?: string;
  /** Reusable normalized or exact state anchors used to derive omitted tiers. */
  states?: Record<string, VariantEffectState>;
}

/** Generator-wide axes and reusable potion-state calculation profiles. */
export interface VariantGenerationConfig {
  /** Ordered names for each axis. Both arrays must begin with `base`. */
  axes: Record<VariantAxis, string[]>;
  /** Reusable support and scaling profiles used by potion families. */
  profiles?: Record<string, VariantProfile>;
  /** Integer rounding applied to calculated durations. Defaults to `nearest`. */
  rounding?: 'nearest' | 'floor' | 'ceil';
}

/** Configures all generated and registered states in one potion family. */
export interface VariantConfig extends VariantPolicy {
  /** Optional reusable profile ID from `generator.variant_generation.profiles`. */
  profile?: string;
  /**
   * Explicit family states. Namespaced strings select registered potion types;
   * objects and arrays define effect values and override calculated values.
   */
  states?: Record<string, VariantStateConfig>;
}

/** One Overbrew effect and all of its potion variants. */
export interface CustomEffectConfig extends JsonObject {
  /** Minecraft status-effect ID. */
  effect_id: string;
  /** Fallback display name. */
  display: string;
  /** Optional translation suffix; defaults to the effect config key. */
  translation_suffix?: string;
  /** Decimal potion color. */
  color: number;
  /** Supported tiers, profile, and explicit or registered states. */
  variants: VariantConfig;
  /** Input potion IDs mapped to their brewing reagents. */
  brew: BrewMap;
}

/** One vanilla potion family and all of its registered/generated states. */
export interface VanillaPotionConfig extends JsonObject {
  /** Fallback display name. */
  display: string;
  /** Base translation suffix shared by regular, long, and strong states. */
  translation_suffix?: string;
  /** Decimal potion color. */
  color: number;
  /** Base effect templates and IDs used by profile calculations. */
  effects: JsonObject[];
  /** Optional direct input-to-reagent brews that create the base state. */
  brew?: BrewMap;
  /** Registered potion types and generated duration/amplifier tiers. */
  variants: VariantConfig;
}

/** A configured custom transformation between two Overbrew effects. */
export interface CustomCrossEffectTransform extends JsonObject {
  /** Stable recipe path ID. */
  id: string;
  from_effect: string;
  to_effect: string;
  /** Explicit source variant when `variants` is omitted. Defaults to `base`. */
  from_variant?: string;
  /** Explicit target variant when `variants` is omitted. Defaults to `base`. */
  to_variant?: string;
  /** Expands the transform across shared variants or the supplied variant names. */
  variants?: 'matching' | string[];
  modifier?: string;
}

/** A configured vanilla transformation between two potion state IDs. */
export interface VanillaCrossEffectTransform {
  from: string;
  to: string;
  modifier: string;
}

/** Overbrew-owned model. */
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

/** Selects which matchable mob-effect properties are written to potion predicates. */
export interface PotionEffectMatchingConfig {
  /** Matches effect duration exactly. */
  duration?: boolean;
  /** Matches effect amplifier exactly. */
  amplifier?: boolean;
  /** Matches the ambient-effect flag exactly. */
  ambient?: boolean;
  /** Matches effect particle visibility exactly. */
  visible?: boolean;
}


/** Effect indexes targeted by an automatic disambiguation strategy. */
export type AutoAdjustEffectSelection = 'all' | 'first' | number[];

/** Numeric candidate search used by duration and amplifier strategies. */
export type AutoAdjustNumericAlgorithm = 'single' | 'minimal' | 'balanced';

/** Tie-break order used when numeric candidates have equal adjustment cost. */
export type AutoAdjustNumericOrder = 'effect_first' | 'direction_first';

/** Shared fields for one automatic potion-state disambiguation strategy. */
export interface AutoAdjustStrategyBase {
  /** Lower values are attempted first. Equal priorities retain declaration order. */
  priority?: number;
  /** Effects eligible for modification. Defaults to `all`. */
  effects?: AutoAdjustEffectSelection;
}

/** Changes an existing numeric effect field by the nearest available value. */
export interface AutoAdjustNumericStrategy extends AutoAdjustStrategyBase {
  type: 'duration' | 'amplifier';
  /** Direction attempted first when equal-distance values are available. */
  prefer?: 'increase' | 'decrease';
  /** Candidate search algorithm. Defaults to `balanced`. */
  algorithm?: AutoAdjustNumericAlgorithm;
  /** Tie-break order for equally small candidates. Defaults to `effect_first`. */
  order?: AutoAdjustNumericOrder;
  /** Maximum absolute adjustment applied to one effect. */
  max_delta?: number;
  /** Maximum sum of absolute adjustments across all selected effects. */
  max_total_delta?: number;
  /** Maximum number of effects changed by one candidate. */
  max_changed_effects?: number;
  /** Safety cap for generated candidates. Defaults to 10,000. */
  max_candidates?: number;
}

/** Changes an existing boolean effect field. */
export interface AutoAdjustBooleanStrategy extends AutoAdjustStrategyBase {
  type: 'ambient' | 'visible';
  /** Desired value. When omitted, the current value is toggled. */
  value?: boolean;
}

/** Changes the matchable base potion type and optionally interleaves nested fallbacks across every type. */
export interface AutoAdjustPotionTypeStrategy extends AutoAdjustStrategyBase {
  type: 'potion_type';
  /** Registered effectless potion types attempted in declaration order. */
  potions: string[];
  /** Also includes the state's original potion type in nested fallback rounds. Defaults to `true`. */
  include_original?: boolean;
  /** Strategies interleaved across all configured potion types after type-only candidates are exhausted. */
  strategies?: AutoAdjustStrategy[];
}

/** Appends a configured effect instance to make the potion state unique. */
export interface AutoAdjustAddEffectStrategy extends AutoAdjustStrategyBase {
  type: 'add_effect';
  /** Effect instance written to `custom_effects`. */
  effect: JsonObject;
  /**
   * Fallback strategies tried after the configured effect is appended.
   * When a nested strategy omits `effects`, it targets the newly added effect.
   */
  strategies?: AutoAdjustStrategy[];
  /**
   * Also tries compatible strategies from the containing strategy list against
   * the newly added effect. Defaults to `true`; inherited `add_effect` entries
   * are skipped to avoid recursive growth.
   */
  inherit_parent_strategies?: boolean;
}

/** One strategy available to automatic modifier-output disambiguation. */
export type AutoAdjustStrategy =
  | AutoAdjustNumericStrategy
  | AutoAdjustBooleanStrategy
  | AutoAdjustPotionTypeStrategy
  | AutoAdjustAddEffectStrategy;

/** Per-modifier override for automatic potion-state disambiguation. */
export interface AutoAdjustModifierConfig {
  /** Enables or disables adjustment for this modifier. */
  enabled?: boolean;
  /** Replaces the shared strategy list for this modifier. */
  strategies?: AutoAdjustStrategy[];
}

/** Controls automatic disambiguation of output-preserving modifier states. */
export interface AutoAdjustEffectsConfig {
  /** Applies the shared setting to every global modifier. Defaults to `true`. */
  enabled?: boolean;
  /** Ordered strategies. The shipped `config.json` defines the default sequence. */
  strategies?: AutoAdjustStrategy[];
  /** Modifier-specific enablement and strategy overrides keyed by modifier ID. */
  modifiers?: Record<string, boolean | AutoAdjustModifierConfig>;
}

/** Controls potion input predicates and brewing-conflict validation. */
export interface PotionMatchingConfig {
  /** Errors when recipes can accept the same input and reagent or reaccept their own output. */
  detect_conflicts?: boolean;
  /** Expands generated item tags when checking whether different tags share an item. */
  check_tag_overlaps?: boolean;
  /** Registered effectless base written to generated custom-effect stacks, or `null` to omit the field. */
  default_potion_type?: string | null;
  /** Matchable fields included in generated custom-effect predicates. */
  effect_fields?: PotionEffectMatchingConfig;
  /** Optional automatic disambiguation for global modifier outputs. */
  auto_adjust_effects?: AutoAdjustEffectsConfig;
}

/** Fully resolved potion-matching settings used internally by the generator. */
export interface ResolvedPotionMatchingConfig {
  detect_conflicts: boolean;
  check_tag_overlaps: boolean;
  default_potion_type: string | null;
  /** Potion types whose reconstructed input recipes must require exactly zero effects. */
  protected_potion_types: string[];
  /** Non-fatal limitations discovered while resolving the configured strategies. */
  warnings: string[];
  effect_fields: Required<PotionEffectMatchingConfig>;
  auto_adjust_effects: Required<Pick<AutoAdjustEffectsConfig, 'enabled'>> & {
    strategies: AutoAdjustStrategy[];
    modifiers: Record<string, boolean | AutoAdjustModifierConfig>;
  };
}


/** Text accepted by the data-pack description field. */
export type DataPackDescription = string | JsonObject | JsonObject[];

/** One format-gated data-pack overlay. */
export interface DataPackOverlayConfig {
  /** Overlay directory relative to the pack root. */
  directory: string;
  /** Oldest integer data-pack format that activates the overlay. */
  min_format: number;
  /** Newest integer data-pack format that activates the overlay. */
  max_format: number;
}

/** Target format metadata used by generated resources. */
export interface GeneratorTargetConfig extends JsonObject {
  /** Text component written to `pack.description`. */
  description: DataPackDescription;
  /** Oldest integer format accepted by the base pack. */
  min_format: number;
  /** Newest integer format accepted by the pack. */
  max_format: number;
  /** Optional format-gated overlays. */
  overlays?: DataPackOverlayConfig[];
}

/** A scalar config value or multiple accepted values. */
export type OneOrMany<T> = T | T[];

/** Display settings for one generated potion advancement. */
export interface AdvancementDisplayConfig extends JsonObject {
  /** Advancement title as plain text or a complete text component. */
  title: string | JsonObject;
  /** Advancement description as plain text or a complete text component. */
  description: string | JsonObject;
  /** Item ID shorthand or complete advancement icon object. */
  icon: string | JsonObject;
  /** Vanilla advancement frame. Defaults to `task`. */
  frame?: 'task' | 'goal' | 'challenge';
  /** Optional advancement-tab background texture. */
  background?: string;
  /** Whether completion displays a toast. Defaults to `true`. */
  show_toast?: boolean;
  /** Whether completion is announced in chat. Defaults to `true`. */
  announce_to_chat?: boolean;
  /** Whether the advancement is hidden until completed. Defaults to `false`. */
  hidden?: boolean;
}

/** Filters resolved potion states used as one advancement's criteria. */
export interface AdvancementMatchConfig {
  /** Accepted potion sources. */
  source?: OneOrMany<PotionSource>;
  /** Accepted potion-family IDs. */
  family?: OneOrMany<string>;
  /** Accepted full variant names. */
  variant?: OneOrMany<string>;
  /** Accepted duration-axis state names, such as `prolonged`. */
  duration?: OneOrMany<string>;
  /** Accepted amplifier-axis state names, such as `potent`. */
  amplifier?: OneOrMany<string>;
  /** Matches only existing vanilla or generated states when provided. */
  registered?: boolean;
  /** Particle visibility required by generated potion-content criteria. Omitted means either state. */
  show_particles?: boolean;
  /** Per-advancement overrides for matchable effect properties. */
  effect_fields?: PotionEffectMatchingConfig;
}

/** One config-defined potion advancement. */
export interface AdvancementEntryConfig {
  /** Parent path relative to the configured root, a full ID, or `null` for a tab root. */
  parent?: string | null;
  /** User-visible advancement presentation. */
  display: AdvancementDisplayConfig;
  /** One filter or an OR-list of resolved potion-state filters. */
  match?: AdvancementMatchConfig | AdvancementMatchConfig[];
  /** Explicit advancement criteria for non-potion triggers. Cannot be combined with `match`. */
  criteria?: Record<string, JsonObject>;
  /** Whether any or every generated criterion is required. Defaults to `any`. */
  requirements?: 'any' | 'all';
}

/** Markdown potion-table generation settings. */
export interface PotionTableGenerationConfig {
  /** Enables Markdown table generation. */
  enabled?: boolean;
  /** Output Markdown path resolved relative to the config file. */
  output?: string;
  /** Potion sources included in order. Defaults to custom and vanilla. */
  sources?: PotionSource[];
  /** Includes one ingredient column. Defaults to true. */
  include_ingredients?: boolean;
  /** Underlines variants that already exist in vanilla. Defaults to true. */
  underline_existing?: boolean;
  /** Optional section-title overrides. */
  titles?: Partial<Record<PotionSource, string>>;
  /** User-facing ingredient names for IDs whose registry path is not enough. */
  ingredient_names?: Record<string, string>;
}

/** Snapshot-gated advancement generation settings. */
export interface AdvancementGenerationConfig {
  /** Enables advancement generation. */
  enabled?: boolean;
  /** Overlay directory that receives advancements requiring the new potion trigger. */
  overlay?: string;
  /** Resource path below `advancement`; defaults to `overbrew`. */
  root?: string;
  /** Advancements keyed by their path relative to `root`. */
  entries?: Record<string, AdvancementEntryConfig>;
}

/** Generator execution and output settings. */
export interface GeneratorOptions {
  /** Target Minecraft and data-pack versions used for documentation and manifests. */
  target: GeneratorTargetConfig;
  /** Custom and vanilla data-pack namespaces used by generated resources. */
  namespaces: { custom: string; vanilla: string };
  /** Custom variant axes and automatic duration/amplifier calculation. */
  variant_generation?: VariantGenerationConfig;
  /** Recreates vanilla brewing recipes with only `reagent.item` changed to tags. */
  include_vanilla_recipes?: boolean;
  /**
   * Replaces the vanilla tipped-arrow recipe with a component-preserving
   * transmutation recipe.
   */
  preserve_imbued_components?: boolean;
  /** Custom potion input matching and brewing-conflict validation. */
  potion_matching?: PotionMatchingConfig;
  /** Generated item-tag behavior. */
  item_tags?: ItemTagsConfig;
  /** Generated format-gated potion-brewing advancements. */
  advancements?: AdvancementGenerationConfig;
  /** Generated Markdown tables for resolved custom and vanilla potion states. */
  tables?: PotionTableGenerationConfig;
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
  /** Generator metadata, namespaces, matching, tags, and output behavior. */
  generator: GeneratorOptions;
  /** Potion container forms keyed by logical form name. */
  forms: Record<string, FormConfig>;
  /** Base potion recipes. */
  bases: Record<string, BaseConfig>;
  /** Shared recipe modifiers and their reagents. */
  modifiers: Record<string, ModifierConfig>;
  /** Overbrew-owned effects and transformations. */
  custom: CustomConfig;
  /** Vanilla potion states and transformations. */
  vanilla: VanillaConfig;
}

/** Counts returned by each recipe generation stage. */
export type GenerationCounts = Record<string, number>;
