import type {
  GeneratorConfig,
  JsonObject,
  ModifierConfig,
  ResolvedVariantDefinition,
  VariantAxis,
  VariantConfig,
  VariantCoordinate,
  VariantEffectState,
  VariantGenerationConfig,
  VariantPolicy,
  VariantProfile,
  VariantRatio,
  VariantStateConfig,
  VariantStateObject,
} from './types.ts';

const customCache = new WeakMap<GeneratorConfig, Map<string, Record<string, ResolvedVariantDefinition>>>(),
 vanillaCache = new WeakMap<GeneratorConfig, Map<string, Record<string, ResolvedVariantDefinition>>>(),
 generationCache = new WeakMap<GeneratorConfig, VariantGenerationConfig>(),
 profileCache = new WeakMap<GeneratorConfig, Map<string, ResolvedProfile>>();

interface ResolvedProfile extends VariantPolicy {
  states: Record<string, VariantEffectState>;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateEffectState(value: unknown, path: string): asserts value is VariantEffectState {
  if (isObject(value)) return;
  if (Array.isArray(value) && value.length && value.every(isObject)) return;
  throw new Error(`${path} must be an effect object or a non-empty array of effect objects`);
}

function isStateWrapper(value: JsonObject): value is VariantStateObject {
  return 'potion' in value || 'color' in value || 'effects' in value;
}

function stateDescriptor(value: VariantStateConfig | undefined): VariantStateObject {
  if (value === undefined) return {};
  if (typeof value === 'string') return { potion: value };
  if (Array.isArray(value)) return { effects: value };
  return isStateWrapper(value) ? value : { effects: value };
}

function generationConfig(config: GeneratorConfig): VariantGenerationConfig {
  const cached = generationCache.get(config);
  if (cached) return cached;

  const generation = config.generator.variant_generation;
  if (!generation)
    throw new Error('generator.variant_generation is required when generated variants or variant_axis is used');

  const duration = generation.axes?.duration,
   amplifier = generation.axes?.amplifier;
  if (!Array.isArray(duration) || !Array.isArray(amplifier) || !duration.length || !amplifier.length)
    throw new Error('generator.variant_generation.axes must define non-empty duration and amplifier arrays');
  if (duration[0] !== 'base' || amplifier[0] !== 'base')
    throw new Error('Both variant axes must start with "base"');
  if (new Set(duration).size !== duration.length || new Set(amplifier).size !== amplifier.length)
    throw new Error('Variant axis names must be unique within each axis');

  const nonBase = [...duration.slice(1), ...amplifier.slice(1)];
  if (new Set(nonBase).size !== nonBase.length)
    throw new Error('Non-base variant names must be unique across both axes');
  if (generation.rounding !== undefined && !['nearest', 'floor', 'ceil'].includes(generation.rounding))
    throw new Error('generator.variant_generation.rounding must be "nearest", "floor", or "ceil"');
  if (generation.profiles !== undefined && !isObject(generation.profiles))
    throw new Error('generator.variant_generation.profiles must be an object');

  generationCache.set(config, generation);
  return generation;
}

/** Returns the configured ordered variant names for one axis. */
export function variantAxisNames(config: GeneratorConfig, axis: VariantAxis): string[] {
  return [...generationConfig(config).axes[axis]];
}

/** Returns the stable variant name represented by one axis coordinate. */
export function coordinateName(config: GeneratorConfig, duration: number, amplifier: number): string {
  const durationName = variantAxisNames(config, 'duration')[duration],
   amplifierName = variantAxisNames(config, 'amplifier')[amplifier];
  if (!durationName || !amplifierName)
    throw new Error(`Unknown variant coordinate: duration ${duration}, amplifier ${amplifier}`);
  if (!duration && !amplifier) return 'base';
  if (!duration) return amplifierName;
  if (!amplifier) return durationName;
  return `${durationName}_${amplifierName}`;
}

/** Resolves a configured variant name to its duration/amplifier coordinate. */
export function coordinateForName(config: GeneratorConfig, name: string): VariantCoordinate | null {
  const durations = variantAxisNames(config, 'duration'),
   amplifiers = variantAxisNames(config, 'amplifier');
  for (let duration = 0; duration < durations.length; duration++) {
    for (let amplifier = 0; amplifier < amplifiers.length; amplifier++) {
      if (coordinateName(config, duration, amplifier) === name)
        return { duration, amplifier, name };
    }
  }
  return null;
}

/** Returns the state key used by one variant in a vanilla potion family. */
export function vanillaVariantKey(family: string, variant: string): string {
  return variant === 'base' ? family : `${variant}_${family}`;
}

function validateRatio(value: unknown, path: string): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${path} must be greater than zero`);
    return;
  }
  if (!isObject(value)) throw new Error(`${path} must be a number or { numerator, denominator }`);
  const numerator = Number(value.numerator),
   denominator = Number(value.denominator);
  if (!Number.isFinite(numerator) || numerator <= 0)
    throw new Error(`${path}.numerator must be greater than zero`);
  if (!Number.isFinite(denominator) || denominator <= 0)
    throw new Error(`${path}.denominator must be greater than zero`);
}

function ratioValue(value: VariantRatio, path: string): number {
  validateRatio(value, path);
  return typeof value === 'number' ? value : Number(value.numerator) / Number(value.denominator);
}

function validatePolicy(config: GeneratorConfig, policy: VariantPolicy, path: string): void {
  const maxima: Record<VariantAxis, number> = {
    duration: variantAxisNames(config, 'duration').length - 1,
    amplifier: variantAxisNames(config, 'amplifier').length - 1,
  };
  for (const [field, axis] of [['durations', 'duration'], ['amplifiers', 'amplifier']] as const) {
    const value = policy[field];
    if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > maxima[axis]))
      throw new Error(`${path}.${field} must be between 0 and ${maxima[axis]}`);
  }
  if (policy.mix !== undefined && typeof policy.mix !== 'boolean')
    throw new Error(`${path}.mix must be a boolean`);
  if (policy.scaling !== undefined && !isObject(policy.scaling))
    throw new Error(`${path}.scaling must be an object`);

  const duration = policy.scaling?.duration;
  if (duration !== undefined) {
    if (!isObject(duration)) throw new Error(`${path}.scaling.duration must be an object`);
    if (duration.multiplier !== undefined)
      validateRatio(duration.multiplier, `${path}.scaling.duration.multiplier`);
    if (duration.progression !== undefined && !['linear', 'multiplicative'].includes(duration.progression))
      throw new Error(`${path}.scaling.duration.progression must be "linear" or "multiplicative"`);
    if (duration.multipliers !== undefined) {
      if (!isObject(duration.multipliers))
        throw new Error(`${path}.scaling.duration.multipliers must be an object`);
      for (const [effect, value] of Object.entries(duration.multipliers))
        validateRatio(value, `${path}.scaling.duration.multipliers.${effect}`);
    }
  }

  const amplifier = policy.scaling?.amplifier;
  if (amplifier !== undefined) {
    if (!isObject(amplifier)) throw new Error(`${path}.scaling.amplifier must be an object`);
    if (amplifier.step !== undefined && !Number.isInteger(amplifier.step))
      throw new Error(`${path}.scaling.amplifier.step must be an integer`);
    if (amplifier.steps !== undefined) {
      if (!isObject(amplifier.steps))
        throw new Error(`${path}.scaling.amplifier.steps must be an object`);
      for (const [effect, value] of Object.entries(amplifier.steps))
        if (!Number.isInteger(value))
          throw new Error(`${path}.scaling.amplifier.steps.${effect} must be an integer`);
    }
    if (amplifier.duration_multiplier !== undefined)
      validateRatio(amplifier.duration_multiplier, `${path}.scaling.amplifier.duration_multiplier`);
    if (amplifier.duration_multipliers !== undefined) {
      if (!isObject(amplifier.duration_multipliers))
        throw new Error(`${path}.scaling.amplifier.duration_multipliers must be an object`);
      for (const [effect, value] of Object.entries(amplifier.duration_multipliers))
        validateRatio(value, `${path}.scaling.amplifier.duration_multipliers.${effect}`);
    }
  }
}

function mergePolicy(base: VariantPolicy, override: VariantPolicy): VariantPolicy {
  const durationMultipliers = {
    ...(base.scaling?.duration?.multipliers ?? {}),
    ...(override.scaling?.duration?.multipliers ?? {}),
  },
   amplifierSteps = {
     ...(base.scaling?.amplifier?.steps ?? {}),
     ...(override.scaling?.amplifier?.steps ?? {}),
   },
   amplifierDurationMultipliers = {
     ...(base.scaling?.amplifier?.duration_multipliers ?? {}),
     ...(override.scaling?.amplifier?.duration_multipliers ?? {}),
   },
   durationScaling = base.scaling?.duration || override.scaling?.duration
     ? {
         ...structuredClone(base.scaling?.duration ?? {}),
         ...structuredClone(override.scaling?.duration ?? {}),
         ...(Object.keys(durationMultipliers).length ? { multipliers: durationMultipliers } : {}),
       }
     : undefined,
   amplifierScaling = base.scaling?.amplifier || override.scaling?.amplifier
     ? {
         ...structuredClone(base.scaling?.amplifier ?? {}),
         ...structuredClone(override.scaling?.amplifier ?? {}),
         ...(Object.keys(amplifierSteps).length ? { steps: amplifierSteps } : {}),
         ...(Object.keys(amplifierDurationMultipliers).length
           ? { duration_multipliers: amplifierDurationMultipliers }
           : {}),
       }
     : undefined,
   output: VariantPolicy = {};

  output.durations = override.durations ?? base.durations;
  output.amplifiers = override.amplifiers ?? base.amplifiers;
  output.mix = override.mix ?? base.mix;
  if (durationScaling || amplifierScaling)
    output.scaling = {
      ...(durationScaling ? { duration: durationScaling } : {}),
      ...(amplifierScaling ? { amplifier: amplifierScaling } : {}),
    };
  return output;
}

function validateProfileStates(
  config: GeneratorConfig,
  states: Record<string, VariantEffectState> | undefined,
  path: string,
): void {
  if (states === undefined) return;
  if (!isObject(states)) throw new Error(`${path} must be an object`);
  for (const [state, value] of Object.entries(states)) {
    if (!coordinateForName(config, state)) throw new Error(`${path} has unknown state ${state}`);
    validateEffectState(value, `${path}.${state}`);
  }
}

function resolveProfile(config: GeneratorConfig, id: string, stack: string[] = []): ResolvedProfile {
  let cache = profileCache.get(config);
  if (!cache) profileCache.set(config, cache = new Map());
  const cached = cache.get(id);
  if (cached) return structuredClone(cached);

  const profile = generationConfig(config).profiles?.[id];
  if (!profile) throw new Error(`Unknown variant profile: ${id}`);
  if (!isObject(profile)) throw new Error(`generator.variant_generation.profiles.${id} must be an object`);
  if (stack.includes(id)) throw new Error(`Variant profile inheritance cycle: ${[...stack, id].join(' -> ')}`);
  if (profile.extends !== undefined && (typeof profile.extends !== 'string' || !profile.extends.trim()))
    throw new Error(`generator.variant_generation.profiles.${id}.extends must be a non-empty profile ID`);

  validateProfileStates(config, profile.states, `generator.variant_generation.profiles.${id}.states`);
  const { extends: parentId, states: ownStates = {}, ...ownPolicy } = profile as VariantProfile,
   parent = parentId ? resolveProfile(config, parentId, [...stack, id]) : { states: {} },
   resolved: ResolvedProfile = {
     ...mergePolicy(parent, ownPolicy),
     states: {
       ...structuredClone(parent.states),
       ...structuredClone(ownStates),
     },
   };
  validatePolicy(config, resolved, `generator.variant_generation.profiles.${id}`);
  cache.set(id, structuredClone(resolved));
  return resolved;
}

interface ResolvedVariantSetup {
  policy: VariantPolicy;
  profileStates: Record<string, VariantEffectState>;
}

function effectiveSetup(config: GeneratorConfig, variants: VariantConfig): ResolvedVariantSetup {
  const profile = variants.profile ? resolveProfile(config, variants.profile.trim()) : { states: {} },
   local: VariantPolicy = {
     durations: variants.durations,
     amplifiers: variants.amplifiers,
     mix: variants.mix,
     scaling: variants.scaling,
   },
   policy = mergePolicy(profile, local);
  validatePolicy(config, policy, 'resolved variants');
  return { policy, profileStates: structuredClone(profile.states) };
}

function validateVariants(config: GeneratorConfig, path: string, variants: VariantConfig): ResolvedVariantSetup {
  if (!isObject(variants)) throw new Error(`${path} must be an object`);
  if (variants.profile !== undefined && (typeof variants.profile !== 'string' || !variants.profile.trim()))
    throw new Error(`${path}.profile must be a non-empty profile ID`);
  if (variants.profile) resolveProfile(config, variants.profile.trim());
  validatePolicy(config, variants, path);
  if (variants.states !== undefined && !isObject(variants.states))
    throw new Error(`${path}.states must be an object`);
  if (!variants.profile && !Object.hasOwn(variants.states ?? {}, 'base'))
    throw new Error(`${path}.states.base is required when no profile is selected`);

  for (const [state, value] of Object.entries(variants.states ?? {})) {
    if (!coordinateForName(config, state)) throw new Error(`${path}.states has unknown state ${state}`);
    const descriptor = stateDescriptor(value);
    if (descriptor.potion !== undefined &&
        (typeof descriptor.potion !== 'string' || !descriptor.potion.includes(':')))
      throw new Error(`${path}.states.${state}.potion must be a namespaced potion type`);
    if (descriptor.color !== undefined && (!Number.isInteger(descriptor.color) || descriptor.color < 0))
      throw new Error(`${path}.states.${state}.color must be a non-negative integer`);
    if (descriptor.effects !== undefined)
      validateEffectState(descriptor.effects, `${path}.states.${state}.effects`);
  }
  return effectiveSetup(config, variants);
}

function finiteInteger(value: unknown, path: string, minimum: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < minimum)
    throw new Error(`${path} must be an integer greater than or equal to ${minimum}`);
  return number;
}

function rounded(config: GeneratorConfig, value: number): number {
  const mode = generationConfig(config).rounding ?? 'nearest';
  return mode === 'floor' ? Math.floor(value) : mode === 'ceil' ? Math.ceil(value) : Math.round(value);
}

function effectStateAt(
  state: VariantStateConfig | undefined,
  effectIndex: number,
  effectCount: number,
  path: string,
): JsonObject | undefined {
  const values = stateDescriptor(state).effects;
  if (values === undefined) return undefined;
  if (Array.isArray(values)) {
    if (values.length !== effectCount)
      throw new Error(`${path} must contain exactly ${effectCount} effect entries`);
    return structuredClone(values[effectIndex]);
  }
  return structuredClone(values);
}

function effectRule<T>(rules: Record<string, T> | undefined, effectId: string): T | undefined {
  if (!rules) return undefined;
  return rules[effectId] ?? rules[effectId.split(':').at(-1) ?? effectId];
}

function durationMultiplier(policy: VariantPolicy, effectId: string): number | undefined {
  const configured = effectRule(policy.scaling?.duration?.multipliers, effectId) ??
   policy.scaling?.duration?.multiplier;
  return configured === undefined ? undefined : ratioValue(configured, `duration multiplier for ${effectId}`);
}

function durationProgression(policy: VariantPolicy): 'linear' | 'multiplicative' {
  return policy.scaling?.duration?.progression ?? 'multiplicative';
}

function amplifierStep(policy: VariantPolicy, effectId: string): number | undefined {
  return effectRule(policy.scaling?.amplifier?.steps, effectId) ?? policy.scaling?.amplifier?.step;
}

function amplifierDurationMultiplier(policy: VariantPolicy, effectId: string): number | undefined {
  const configured = effectRule(policy.scaling?.amplifier?.duration_multipliers, effectId) ??
   policy.scaling?.amplifier?.duration_multiplier;
  return configured === undefined ? undefined : ratioValue(configured, `amplifier duration multiplier for ${effectId}`);
}

function profileRelativeState(
  config: GeneratorConfig,
  path: string,
  axis: VariantAxis,
  base: JsonObject,
  profile: Record<string, JsonObject>,
  name: string,
): JsonObject | undefined {
  const profileBase = profile.base,
   profileState = profile[name];
  if (!profileBase || !profileState) return undefined;

  const baseDuration = finiteInteger(base.duration, `${path}.base.duration`, 1),
   profileBaseDuration = finiteInteger(profileBase.duration, `${path}.profile.base.duration`, 1),
   profileStateDuration = finiteInteger(profileState.duration, `${path}.profile.${name}.duration`, 1),
   calculated: JsonObject = {
     ...structuredClone(base),
     duration: Math.max(1, rounded(config, baseDuration * profileStateDuration / profileBaseDuration)),
   };

  if (axis === 'amplifier') {
    const baseAmplifier = finiteInteger(base.amplifier ?? 0, `${path}.base.amplifier`, 0),
     profileBaseAmplifier = finiteInteger(profileBase.amplifier ?? 0, `${path}.profile.base.amplifier`, 0),
     profileStateAmplifier = finiteInteger(
       profileState.amplifier ?? profileBaseAmplifier,
       `${path}.profile.${name}.amplifier`,
       0,
     );
    calculated.amplifier = baseAmplifier + profileStateAmplifier - profileBaseAmplifier;
  } else {
    calculated.amplifier = finiteInteger(base.amplifier ?? 0, `${path}.base.amplifier`, 0);
  }
  return calculated;
}

function axisStates(
  config: GeneratorConfig,
  path: string,
  axis: VariantAxis,
  base: JsonObject,
  explicit: Record<string, JsonObject>,
  profile: Record<string, JsonObject>,
  policy: VariantPolicy,
  effectId: string,
  maximum: number,
): JsonObject[] {
  const names = variantAxisNames(config, axis),
   output: JsonObject[] = [structuredClone(base)];

  for (let tier = 1; tier <= maximum; tier++) {
    const previous = output[tier - 1],
     name = names[tier],
     override = explicit[name],
     profiled = profileRelativeState(config, path, axis, base, profile, name),
     calculated = profiled ?? structuredClone(previous);

    if (!profiled && axis === 'duration') {
      const baseDuration = finiteInteger(base.duration, `${path}.base.duration`, 1),
       firstDuration = tier > 1
         ? finiteInteger(output[1]?.duration, `${path}.${names[1]}.duration`, 1)
         : undefined,
       progression = durationProgression(policy);
      let multiplier = durationMultiplier(policy, effectId);
      if (multiplier === undefined && firstDuration !== undefined)
        multiplier = firstDuration / baseDuration;

      if (tier > 1 && progression === 'linear' && firstDuration !== undefined) {
        const previousDuration = finiteInteger(previous.duration, `${path}.${names[tier - 1]}.duration`, 1);
        calculated.duration = Math.max(1, rounded(config, previousDuration + firstDuration - baseDuration));
      } else if (multiplier !== undefined) {
        calculated.duration = Math.max(1, rounded(
          config,
          finiteInteger(previous.duration, `${path}.${names[tier - 1]}.duration`, 1) * multiplier,
        ));
      } else if (!override) {
        throw new Error(
          `${path}.${name} requires a profile state, scaling.duration.multiplier, or an explicit state`,
        );
      }
      calculated.amplifier = finiteInteger(base.amplifier ?? 0, `${path}.base.amplifier`, 0);
    } else if (!profiled) {
      let step = amplifierStep(policy, effectId),
       multiplier = amplifierDurationMultiplier(policy, effectId);
      if (tier > 1) {
        if (step === undefined) {
          step = finiteInteger(output[1]?.amplifier ?? 0, `${path}.${names[1]}.amplifier`, 0) -
            finiteInteger(base.amplifier ?? 0, `${path}.base.amplifier`, 0);
        }
        if (multiplier === undefined) {
          multiplier = finiteInteger(output[1]?.duration, `${path}.${names[1]}.duration`, 1) /
            finiteInteger(base.duration, `${path}.base.duration`, 1);
        }
      }
      if (step !== undefined)
        calculated.amplifier = finiteInteger(previous.amplifier ?? 0, `${path}.${names[tier - 1]}.amplifier`, 0) + step;
      else if (!override)
        throw new Error(`${path}.${name} requires a profile state, scaling.amplifier.step, or an explicit state`);
      if (multiplier !== undefined) {
        calculated.duration = Math.max(1, rounded(
          config,
          finiteInteger(previous.duration, `${path}.${names[tier - 1]}.duration`, 1) * multiplier,
        ));
      } else if (!override) {
        throw new Error(
          `${path}.${name} requires a profile state, scaling.amplifier.duration_multiplier, or an explicit state`,
        );
      }
    }

    if (override) Object.assign(calculated, structuredClone(override));
    calculated.duration = finiteInteger(calculated.duration, `${path}.${name}.duration`, 1);
    calculated.amplifier = finiteInteger(calculated.amplifier ?? 0, `${path}.${name}.amplifier`, 0);
    output.push(calculated);
  }
  return output;
}

function calculatedEffectVariant(
  config: GeneratorConfig,
  path: string,
  explicit: Record<string, JsonObject>,
  profile: Record<string, JsonObject>,
  policy: VariantPolicy,
  durationTier: number,
  amplifierTier: number,
): JsonObject {
  const base = explicit.base;
  if (!base) throw new Error(`${path}.base must provide a duration and amplifier`);
  const baseDuration = finiteInteger(base.duration, `${path}.base.duration`, 1),
   baseAmplifier = finiteInteger(base.amplifier ?? 0, `${path}.base.amplifier`, 0),
   effectId = String(base.id ?? path),
   durationStates = axisStates(config, path, 'duration', base, explicit, profile, policy, effectId, durationTier),
   amplifierStates = axisStates(config, path, 'amplifier', base, explicit, profile, policy, effectId, amplifierTier),
   durationState = durationStates[durationTier],
   amplifierState = amplifierStates[amplifierTier],
   durationProperties = structuredClone(durationState),
   amplifierProperties = structuredClone(amplifierState),
   exactName = coordinateName(config, durationTier, amplifierTier);
  delete durationProperties.amplifier;
  delete amplifierProperties.duration;

  const calculated: JsonObject = {
    ...structuredClone(base),
    ...durationProperties,
    ...amplifierProperties,
    duration: Math.max(1, rounded(
      config,
      finiteInteger(durationState.duration, `${path}.${exactName}.duration`, 1) *
        finiteInteger(amplifierState.duration, `${path}.${exactName}.duration`, 1) /
        baseDuration,
    )),
    amplifier: finiteInteger(amplifierState.amplifier ?? baseAmplifier, `${path}.${exactName}.amplifier`, 0),
  };
  if (explicit[exactName]) Object.assign(calculated, structuredClone(explicit[exactName]));
  calculated.duration = finiteInteger(calculated.duration, `${path}.${exactName}.duration`, 1);
  calculated.amplifier = finiteInteger(calculated.amplifier ?? 0, `${path}.${exactName}.amplifier`, 0);
  return calculated;
}

function generatedCoordinates(config: GeneratorConfig, policy: VariantPolicy): VariantCoordinate[] {
  const output: VariantCoordinate[] = [],
   durationMaximum = policy.durations ?? 0,
   amplifierMaximum = policy.amplifiers ?? 0,
   mix = policy.mix ?? true;
  for (let duration = 0; duration <= durationMaximum; duration++) {
    for (let amplifier = 0; amplifier <= amplifierMaximum; amplifier++) {
      if (!mix && duration && amplifier) continue;
      output.push({ duration, amplifier, name: coordinateName(config, duration, amplifier) });
    }
  }
  return output;
}

function inferredPotionType(
  config: GeneratorConfig,
  states: Record<string, VariantStateConfig>,
  name: string,
  coordinate: VariantCoordinate,
): string | undefined {
  if (Object.hasOwn(states, name)) return undefined;
  const basePotion = stateDescriptor(states.base).potion;
  if (!basePotion) return undefined;

  let prefix: string | undefined;
  if (coordinate.duration === 1 && coordinate.amplifier === 0)
    prefix = 'long';
  else if (coordinate.duration === 0 && coordinate.amplifier === 1)
    prefix = 'strong';
  if (!prefix) return undefined;

  const separator = basePotion.indexOf(':'),
   namespace = separator >= 0 ? basePotion.slice(0, separator) : config.generator.namespaces.vanilla,
   path = separator >= 0 ? basePotion.slice(separator + 1) : basePotion;
  return `${namespace}:${prefix}_${path}`;
}

function resolvedDefinitions(
  config: GeneratorConfig,
  path: string,
  baseEffects: JsonObject[],
  variants: VariantConfig,
  inferRegistered: boolean,
): Record<string, ResolvedVariantDefinition> {
  const { policy, profileStates } = validateVariants(config, path, variants);
  if (!baseEffects.length) throw new Error(`${path} requires at least one base effect template`);

  const states = variants.states ?? {},
   coordinates = generatedCoordinates(config, policy),
   names = [...new Set([...coordinates.map(coordinate => coordinate.name), ...Object.keys(states)])],
   output: Record<string, ResolvedVariantDefinition> = {};

  for (const name of names) {
    const coordinate = coordinateForName(config, name);
    if (!coordinate) throw new Error(`${path}.states has unknown state ${name}`);

    const effects = baseEffects.map((baseEffect, effectIndex) => {
      const explicit: Record<string, JsonObject> = {},
       profile: Record<string, JsonObject> = {};
      for (const [stateName, state] of Object.entries(states)) {
        const values = effectStateAt(state, effectIndex, baseEffects.length, `${path}.states.${stateName}`);
        if (values) explicit[stateName] = values;
      }
      for (const [stateName, state] of Object.entries(profileStates)) {
        const values = effectStateAt(
          state,
          effectIndex,
          baseEffects.length,
          `generator.variant_generation.profiles.${variants.profile}.states.${stateName}`,
        );
        if (values) profile[stateName] = values;
      }

      const explicitBase = explicit.base,
       inheritedBase = baseEffect.duration === undefined && !explicitBase ? profile.base : undefined;
      explicit.base = {
        ...structuredClone(baseEffect),
        ...structuredClone(inheritedBase ?? {}),
        ...structuredClone(explicitBase ?? {}),
      };
      if (explicit.base.duration === undefined)
        throw new Error(`${path}.states.base must provide duration for effect ${effectIndex}`);

      return calculatedEffectVariant(
        config,
        `${path}.states[${effectIndex}]`,
        explicit,
        profile,
        policy,
        coordinate.duration,
        coordinate.amplifier,
      );
    });

    const configured = stateDescriptor(states[name]);
    output[name] = {
      potion: configured.potion ?? (inferRegistered ? inferredPotionType(config, states, name, coordinate) : undefined),
      color: configured.color,
      effects,
    };
  }
  return output;
}

/** Returns registered potion types declared or inferred inside one vanilla family. */
export function registeredVariantPotions(config: GeneratorConfig, family: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(vanillaVariantDefinitions(config, family))
      .flatMap(([state, definition]) => definition.potion ? [[state, definition.potion]] : []),
  );
}

/** Returns explicitly configured and automatically calculated custom states. */
export function customVariantDefinitions(
  config: GeneratorConfig,
  effectKey: string,
): Record<string, ResolvedVariantDefinition> {
  let cache = customCache.get(config);
  if (!cache) customCache.set(config, cache = new Map());
  const cached = cache.get(effectKey);
  if (cached) return cached;

  const effect = config.custom.effects[effectKey];
  if (!effect) throw new Error(`Unknown custom effect: ${effectKey}`);
  const output = resolvedDefinitions(
    config,
    `custom.effects.${effectKey}.variants`,
    [{ id: effect.effect_id }],
    effect.variants,
    false,
  );
  cache.set(effectKey, output);
  return output;
}

/** Returns registered and generated states for one vanilla potion family. */
export function vanillaVariantDefinitions(
  config: GeneratorConfig,
  family: string,
): Record<string, ResolvedVariantDefinition> {
  let cache = vanillaCache.get(config);
  if (!cache) vanillaCache.set(config, cache = new Map());
  const cached = cache.get(family);
  if (cached) return cached;

  const potion = config.vanilla.potions[family];
  if (!potion) throw new Error(`Unknown vanilla potion family: ${family}`);
  const output = resolvedDefinitions(
    config,
    `vanilla.potions.${family}.variants`,
    potion.effects,
    potion.variants,
    true,
  );
  cache.set(family, output);
  return output;
}

/** Returns all generated variant names for one custom effect. */
export function customVariantNames(config: GeneratorConfig, effectKey: string): string[] {
  return Object.keys(customVariantDefinitions(config, effectKey));
}

/** Returns all registered and generated variant names for one vanilla potion family. */
export function vanillaVariantNames(config: GeneratorConfig, family: string): string[] {
  return Object.keys(vanillaVariantDefinitions(config, family));
}

/** Returns vanilla potion families that opt into generated variant tiers. */
export function generatedVanillaFamilies(config: GeneratorConfig): string[] {
  return Object.keys(config.vanilla.potions);
}

/** Returns valid variant edges generated by one modifier for the supplied state set. */
export function modifierVariantEdges(
  config: GeneratorConfig,
  modifier: ModifierConfig,
  availableVariants: Iterable<string>,
): { from: string; to: string }[] {
  const available = new Set(availableVariants);
  if (!modifier.variant_axis) return [];

  const axis = modifier.variant_axis.axis,
   names = variantAxisNames(config, axis),
   targetIndex = names.indexOf(modifier.variant_axis.to),
   fromNames = modifier.variant_axis.from ?? [names[targetIndex - 1]];
  if (targetIndex <= 0 || fromNames.some(name => !names.includes(name)) || fromNames.includes(modifier.variant_axis.to))
    throw new Error(`Invalid ${axis} variant axis transition to ${modifier.variant_axis.to}`);

  const edges: { from: string; to: string }[] = [];
  for (const from of available) {
    const coordinate = coordinateForName(config, from);
    if (!coordinate) continue;
    const currentName = names[coordinate[axis]];
    if (!fromNames.includes(currentName)) continue;
    const target = axis === 'duration'
      ? coordinateName(config, targetIndex, coordinate.amplifier)
      : coordinateName(config, coordinate.duration, targetIndex);
    if (available.has(target)) edges.push({ from, to: target });
  }
  return edges;
}

function matchingVariantPairs(
  source: Iterable<string>,
  target: Iterable<string>,
  variants: 'matching' | string[] | undefined,
  explicitFrom: string,
  explicitTo: string,
  label: string,
): { from: string; to: string }[] {
  if (!variants) return [{ from: explicitFrom, to: explicitTo }];
  const sourceSet = new Set(source),
   targetSet = new Set(target),
   names = variants === 'matching' ? [...sourceSet].filter(name => targetSet.has(name)) : variants;
  return names.map(name => {
    if (!sourceSet.has(name) || !targetSet.has(name))
      throw new Error(`${label} variant ${name} is not shared by both potion families`);
    return { from: name, to: name };
  });
}

/** Expands one custom cross-effect transform into concrete variant pairs. */
export function customTransformVariants(
  config: GeneratorConfig,
  fromEffect: string,
  toEffect: string,
  variants: 'matching' | string[] | undefined,
  explicitFrom = 'base',
  explicitTo = 'base',
): { from: string; to: string }[] {
  return matchingVariantPairs(
    customVariantNames(config, fromEffect),
    customVariantNames(config, toEffect),
    variants,
    explicitFrom,
    explicitTo,
    `Cross-effect ${fromEffect} -> ${toEffect}`,
  );
}

/** Returns matching generated variants shared by two vanilla potion families. */
export function vanillaTransformVariants(
  config: GeneratorConfig,
  fromFamily: string,
  toFamily: string,
): { from: string; to: string }[] {
  return matchingVariantPairs(
    vanillaVariantNames(config, fromFamily),
    vanillaVariantNames(config, toFamily),
    'matching',
    'base',
    'base',
    `Vanilla transform ${fromFamily} -> ${toFamily}`,
  );
}
