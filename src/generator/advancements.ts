import { effectPredicate } from './potions.ts';
import type {
  AdvancementDisplayConfig,
  AdvancementEntryConfig,
  AdvancementMatchConfig,
  GeneratorConfig,
  JsonObject,
  PotionState,
} from './types.ts';
import { coordinateForName, variantAxisNames } from './variants.ts';
import { joinPath, normalizePath, removeGeneratedDirectory, writeJson } from './utils.ts';

interface AdvancementDefinition {
  path: string;
  value: JsonObject;
}


function list<T>(value: T | T[] | undefined): T[] | null {
  return value === undefined ? null : Array.isArray(value) ? value : [value];
}

function includes<T>(configured: T | T[] | undefined, value: T): boolean {
  const values = list(configured);
  return values === null || values.includes(value);
}

function text(value: string | JsonObject): JsonObject {
  return typeof value === 'string' ? { text: value } : value;
}

function icon(value: string | JsonObject): JsonObject {
  return typeof value === 'string' ? { id: value } : value;
}

function display(config: AdvancementDisplayConfig): JsonObject {
  return {
    title: text(config.title),
    description: text(config.description),
    icon: icon(config.icon),
    frame: config.frame ?? 'task',
    show_toast: config.show_toast ?? true,
    announce_to_chat: config.announce_to_chat ?? true,
    hidden: config.hidden ?? false,
    ...(config.background ? { background: config.background } : {}),
  };
}

function matchesAxis(
  config: GeneratorConfig,
  state: PotionState,
  axis: 'duration' | 'amplifier',
  expected: string | string[] | undefined,
): boolean {
  if (expected === undefined) return true;
  const coordinate = coordinateForName(config, state.variant ?? 'base');
  if (!coordinate) return false;
  const names = variantAxisNames(config, axis);
  return includes(expected, names[coordinate[axis]]);
}

function matchesState(
  config: GeneratorConfig,
  state: PotionState,
  match: AdvancementMatchConfig,
): boolean {
  return includes(match.source, state.source) &&
    includes(match.family, state.family ?? state.key) &&
    includes(match.variant, state.variant ?? 'base') &&
    matchesAxis(config, state, 'duration', match.duration) &&
    matchesAxis(config, state, 'amplifier', match.amplifier) &&
    (match.registered === undefined || Boolean(state.registeredPotion) === match.registered);
}

function criterion(
  config: GeneratorConfig,
  state: PotionState,
  match: AdvancementMatchConfig,
): JsonObject {
  return {
    trigger: 'minecraft:brewed_potion',
    conditions: {
      potion: effectPredicate(config, state, match.show_particles, match.effect_fields),
    },
  };
}

function criterionKey(state: PotionState, showParticles: boolean | undefined): string {
  const suffix = showParticles === false
    ? '_no_particles'
    : showParticles === undefined ? '_any_particles' : '';
  return normalizePath(`${state.source}_${state.family ?? state.key}_${state.variant ?? 'base'}${suffix}`);
}

function uniqueKey(criteria: Record<string, JsonObject>, preferred: string): string {
  if (!Object.hasOwn(criteria, preferred)) return preferred;
  let index = 2;
  while (Object.hasOwn(criteria, `${preferred}_${index}`)) index++;
  return `${preferred}_${index}`;
}

function matchingCriteria(
  config: GeneratorConfig,
  states: PotionState[],
  configured: AdvancementMatchConfig | AdvancementMatchConfig[] = {},
): Record<string, JsonObject> {
  const matches = Array.isArray(configured) ? configured : [configured],
   criteria: Record<string, JsonObject> = {},
   signatures = new Set<string>();

  for (const match of matches) {
    const filtered = states.filter(state => matchesState(config, state, match));
    if (!filtered.length)
      throw new Error(`Advancement match did not resolve any potion states: ${JSON.stringify(match)}`);

    for (const state of filtered) {
      const value = criterion(config, state, match),
       signature = JSON.stringify(value);
      if (signatures.has(signature)) continue;
      signatures.add(signature);
      const key = uniqueKey(criteria, criterionKey(state, match.show_particles));
      criteria[key] = value;
    }
  }
  return criteria;
}

function requirements(keys: string[], mode: 'any' | 'all'): string[][] {
  return mode === 'any' ? [keys] : keys.map(key => [key]);
}

function advancementId(config: GeneratorConfig, root: string, path: string): string {
  return `${config.generator.namespaces.custom}:${normalizePath(`${root}/${path}`)}`;
}

function parentId(
  config: GeneratorConfig,
  root: string,
  parent: string | null | undefined,
): string | null {
  if (parent === null) return null;
  const value = parent ?? 'root';
  return value.includes(':') ? value : advancementId(config, root, value);
}

function advancementRoot(config: GeneratorConfig): string {
  return normalizePath(config.generator.advancements?.root ?? 'overbrew');
}

function buildAdvancement(
  config: GeneratorConfig,
  root: string,
  path: string,
  entry: AdvancementEntryConfig,
  states: PotionState[],
): AdvancementDefinition {
  if (entry.criteria && entry.match !== undefined)
    throw new Error(`Advancement ${path} cannot define both criteria and match`);

  const criteria = entry.criteria ?? matchingCriteria(config, states, entry.match),
   keys = Object.keys(criteria),
   value: JsonObject = {
    display: display(entry.display),
    criteria,
    requirements: requirements(keys, entry.requirements ?? 'any'),
   },
   parent = parentId(config, root, entry.parent);

  if (!keys.length) throw new Error(`Advancement ${path} must define at least one criterion`);
  if (parent) value.parent = parent;
  return { path: normalizePath(`${root}/${path}`), value };
}

/** Builds configured brewing advancements from resolved custom and vanilla potion states. */
export function buildAdvancements(
  config: GeneratorConfig,
  states: Iterable<PotionState>,
): AdvancementDefinition[] {
  const settings = config.generator.advancements;
  if (!settings?.entries || !Object.keys(settings.entries).length)
    throw new Error('generator.advancements.entries must define at least one advancement when generation is enabled');

  const root = advancementRoot(config),
   sortedStates = [...states].sort((left, right) =>
    `${left.source}:${left.family}:${left.variant}`.localeCompare(`${right.source}:${right.family}:${right.variant}`),
   );

  return Object.entries(settings.entries).map(([path, entry]) =>
    buildAdvancement(config, root, path, entry, sortedStates));
}

/** Writes configured brewing advancements and returns the number of generated files. */
export async function writeAdvancements(
  config: GeneratorConfig,
  overlayRoot: string,
  states: Iterable<PotionState>,
): Promise<number> {
  const namespaceRoot = joinPath(overlayRoot, 'data', config.generator.namespaces.custom),
   root = joinPath(namespaceRoot, 'advancement', advancementRoot(config)),
   definitions = buildAdvancements(config, states);

  await removeGeneratedDirectory(root);
  for (const definition of definitions)
    await writeJson(joinPath(namespaceRoot, 'advancement', `${definition.path}.json`), definition.value);
  return definitions.length;
}
