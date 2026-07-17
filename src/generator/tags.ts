import { reagentTagPath } from './config.ts';
import type {
  AutoItemTagKind,
  ItemTagContext,
  ItemTagMatchValue,
  ItemTagRuleConfig,
  ItemTagsConfig,
  ReagentCategory,
  ReagentConfig,
  ReagentReference,
} from './types.ts';
import { basePotionKey, joinPath, namespaced, normalizePath, writeJson } from './utils.ts';

interface TagDefinition {
  enabled: boolean;
  values: string[];
  replace: boolean;
}

interface ItemTagRule {
  path: string;
  values: string[];
  matches: Record<string, ItemTagMatchValue>[];
}

const AUTO_TAG_KINDS = new Set<AutoItemTagKind>([
  'base',
  'effect',
  'modifier',
  'variant',
  'convert',
  'conversion',
  'recipe',
]);

function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return Array.isArray(value) && value.every(entry => typeof entry === 'string') ? value : [];
}

function inferredRuleMatch(path: string): Record<string, ItemTagMatchValue>[] {
  const normalized = normalizePath(path);
  if (!normalized.startsWith('convert/')) return [];

  const [input, output] = normalized.slice('convert/'.length).split('_to_', 2);
  if (!input || !output) return [];
  return [
    {
      input: [input, `long_${input}`, `strong_${input}`],
      output: [output, `long_${output}`, `strong_${output}`],
    },
  ];
}

function parseRules(value: unknown): ItemTagRule[] {
  if (!Array.isArray(value)) return [];

  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error(`item_tags.rules[${index}] must be an object`);


    const rule = entry as ItemTagRuleConfig;
    if (typeof rule.path !== 'string' || !rule.path.trim())
      throw new Error(`item_tags.rules[${index}].path must be a non-empty string`);


    const matches = [...(rule.match ? [rule.match] : []), ...(rule.matches ?? [])],
     resolvedMatches = matches.length ? matches : inferredRuleMatch(rule.path);
    if (!resolvedMatches.length)
      throw new Error(`item_tags.rules[${index}] needs match, matches, or an inferable convert path`);


    const values = stringList(rule.values);
    return {
      path: normalizePath(rule.path),
      values: values.length ? values : ['$auto'],
      matches: resolvedMatches,
    };
  });
}

function parseAutoKinds(value: unknown): AutoItemTagKind[] {
  if (!Array.isArray(value)) return [];

  const kinds: AutoItemTagKind[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !AUTO_TAG_KINDS.has(entry as AutoItemTagKind))
      throw new Error(`Unknown item tag auto_generate family: ${String(entry)}`);

    const kind = entry as AutoItemTagKind;
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}

function matchesValue(actual: unknown, expected: ItemTagMatchValue): boolean {
  const expectedValues = Array.isArray(expected) ? expected : [expected],
   actualValues = Array.isArray(actual) ? actual : [actual];
  return expectedValues.some(value => actualValues.includes(value));
}

function matchesContext(context: ItemTagContext, match: Record<string, ItemTagMatchValue>): boolean {
  return Object.entries(match).every(([key, expected]) => matchesValue(context[key], expected));
}

function tagSettings(
  reagent: ReagentConfig,
  defaultEnabled: boolean,
  defaultPath: string,
): { enabled: boolean; path: string; replace: boolean } {
  const setting = reagent.tag;
  if (typeof setting === 'boolean')
    return { enabled: setting, path: defaultPath, replace: false };

  if (typeof setting === 'string')
    return { enabled: true, path: normalizePath(setting), replace: false };

  if (setting) {
    return {
      enabled: setting.enabled ?? true,
      path: normalizePath(setting.path ?? defaultPath),
      replace: setting.replace ?? false,
    };
  }
  return { enabled: defaultEnabled, path: defaultPath, replace: false };
}

/**
 * Owns Overbrew reagent tags and selects the item or tag used by each recipe.
 *
 * Reagent values live beside their base, effect, or modifier definitions. The
 * singular `auto_generate` entries add optional contextual layers without
 * duplicating those values. Disabled tags are flattened to their configured
 * items or nearest enabled parent tag.
 */
export class IngredientTagRegistry {
  readonly namespace: string;
  readonly itemNamespace: string;
  readonly root: string;
  readonly enabled: boolean;
  readonly autoGenerate: AutoItemTagKind[];
  readonly rules: ItemTagRule[];

  private readonly definitions = new Map<string, TagDefinition>();
  private readonly referencePaths = new Map<string, string>();
  private readonly outputValues = new Map<string, Set<string>>();
  private readonly outputReplace = new Map<string, boolean>();
  private readonly materializing = new Set<string>();

  constructor(namespace: string, itemNamespace: string, config: ItemTagsConfig = {}, catalog: ReagentReference[] = []) {
    this.namespace = namespace;
    this.itemNamespace = itemNamespace;
    this.root = normalizePath(config.root ?? 'brewing');
    this.enabled = config.enabled ?? true;
    this.autoGenerate = parseAutoKinds(config.auto_generate);
    this.rules = parseRules(config.rules);

    for (const reference of catalog) this.register(reference);
  }

  private fullPath(value: string): string {
    const path = normalizePath(value);
    return path === this.root || path.startsWith(`${this.root}/`) ? path : `${this.root}/${path}`;
  }

  private referenceKey(category: ReagentCategory, id: string): string {
    return `${category}:${normalizePath(id)}`;
  }

  private tagReference(path: string): string {
    return `#${this.namespace}:${path}`;
  }

  /** Registers one config-owned reagent and merges compatible duplicate values. */
  register(reference: ReagentReference): void {
    const id = normalizePath(reference.id),
     defaultPath = reagentTagPath(reference.category, id),
     settings = tagSettings(reference.config, this.autoGenerate.includes(reference.category), defaultPath),
     path = this.fullPath(settings.path),
     values = reference.config.items.map(item => namespaced(item, this.itemNamespace));
    if (!values.length) throw new Error(`Reagent ${reference.category}:${id} has no items`);

    const key = this.referenceKey(reference.category, id),
     previousPath = this.referencePaths.get(key);
    if (previousPath && previousPath !== path)
      throw new Error(`Reagent ${key} was assigned both ${previousPath} and ${path}`);

    this.referencePaths.set(key, path);

    const previous = this.definitions.get(path);
    if (!previous) {
      this.definitions.set(path, { ...settings, values });
      return;
    }
    if (previous.enabled !== settings.enabled || previous.replace !== settings.replace)
      throw new Error(`Conflicting tag settings for ${path}`);

    previous.values = unique([...previous.values, ...values]);
  }

  private referencePath(reference: ReagentReference): string {
    const key = this.referenceKey(reference.category, reference.id);
    if (!this.referencePaths.has(key)) this.register(reference);
    return this.referencePaths.get(key)!;
  }

  private configuredValue(value: string, stack: string[]): string[] {
    if (!value.startsWith('#')) return [namespaced(value, this.itemNamespace)];

    const raw = value.slice(1);
    if (!raw.includes(':')) return this.resolveTag(this.fullPath(raw), stack);

    const [namespace, path] = raw.split(':', 2);
    return namespace === this.namespace ? this.resolveTag(path, stack) : [`#${raw}`];
  }

  private directValues(path: string, stack: string[] = []): string[] {
    const fullPath = this.fullPath(path),
     definition = this.definitions.get(fullPath);
    if (!definition) throw new Error(`Unknown generated tag: ${fullPath}`);
    if (stack.includes(fullPath))
      throw new Error(`Generated tag cycle: ${[...stack, fullPath].join(' -> ')}`);


    return definition.values.flatMap(value =>
      value.startsWith('#')
        ? this.configuredValue(value, [...stack, fullPath])
        : [namespaced(value, this.itemNamespace)],
    );
  }

  private resolveTag(path: string, stack: string[] = []): string[] {
    const fullPath = this.fullPath(path),
     definition = this.definitions.get(fullPath);
    if (!definition) throw new Error(`Unknown generated tag: ${fullPath}`);
    if (!definition.enabled) return this.directValues(fullPath, stack);

    this.materialize(fullPath, stack);
    return [this.tagReference(fullPath)];
  }

  private materialize(path: string, stack: string[] = []): void {
    if (this.outputValues.has(path)) return;
    if (this.materializing.has(path) || stack.includes(path))
      throw new Error(`Generated tag cycle: ${[...stack, path].join(' -> ')}`);


    const definition = this.definitions.get(path);
    if (!definition?.enabled) return;
    if (!definition.values.length) throw new Error(`Generated tag ${path} has no values`);

    this.materializing.add(path);
    const values = definition.values.flatMap(value =>
      value.startsWith('#') ? this.configuredValue(value, [...stack, path]) : [namespaced(value, this.itemNamespace)],
    );
    this.materializing.delete(path);

    const output = this.outputValues.get(path) ?? new Set<string>();
    for (const value of values) output.add(value);
    this.outputValues.set(path, output);
    this.outputReplace.set(path, definition.replace);
  }

  private automaticPath(kind: AutoItemTagKind, context: ItemTagContext): string | null {
    const value = (key: keyof ItemTagContext): string =>
      typeof context[key] === 'string' ? normalizePath(String(context[key])) : '',

     input = value('input'),
     output = value('output'),
     effect = value('effect'),
     inputEffect = value('input_effect'),
     outputEffect = value('output_effect'),
     modifier = value('modifier'),
     inputForm = value('input_form'),
     outputForm = value('output_form');

    switch (kind) {
      case 'base':
        return context.category === 'base' && output ? `base/${output}` : null;
      case 'effect':
        return context.category === 'effect' && effect ? `effect/${effect}` : null;
      case 'modifier':
        return modifier ? `modifier/${modifier}` : null;
      case 'variant':
        return context.category === 'modifier' && effect && input && output && input !== output
          ? `variant/${input}_to_${output}`
          : null;
      case 'convert':
        return context.category === 'convert' && input && output
          ? `convert/${inputEffect || basePotionKey(input)}_to_${outputEffect || basePotionKey(output)}`
          : null;
      case 'conversion':
        return inputForm && outputForm && inputForm !== outputForm ? `conversion/${inputForm}_to_${outputForm}` : null;
      case 'recipe': {
        if (!context.source || !context.recipe) return null;
        const recipe = normalizePath(String(context.recipe));
        return recipe.startsWith(`${context.source}/`) ? `recipe/${recipe}` : `recipe/${context.source}/${recipe}`;
      }
    }
  }

  private matchingRule(context: ItemTagContext): ItemTagRule | undefined {
    return this.rules.find(rule => rule.matches.some(match => matchesContext(context, match)));
  }

  private ruleValues(values: string[], defaults: string[], automatic: string[]): string[] {
    return values.flatMap(value => {
      if (value === '$default') return defaults;
      if (value === '$auto') return automatic;
      return this.configuredValue(value, []);
    });
  }

  private single(values: string[], description: string): string {
    const resolved = unique(values);
    if (resolved.length !== 1)
      throw new Error(`${description} resolves to ${resolved.length} values; enable or route through an item tag`);

    return resolved[0];
  }

  /**
   * Returns the direct reagent item or generated tag used by one recipe.
   * `fallbackItem` preserves the exact original vanilla reagent when vanilla
   * overrides are disabled but mirrored modifier chains are still generated.
   */
  reference(
    reference: ReagentReference,
    useTag: boolean,
    fallbackItem: string | undefined,
    recipeKey: string | undefined,
    context: ItemTagContext,
  ): string {
    const defaultPath = this.referencePath(reference),
     fullContext: ItemTagContext = {
      ...context,
      operation: `${reference.category}:${reference.id}`,
      recipe_key: recipeKey,
    };

    if (!useTag || !this.enabled) {
      if (fallbackItem) return namespaced(fallbackItem, this.itemNamespace);
      return this.single(this.directValues(defaultPath), `Reagent ${defaultPath}`);
    }

    const defaultValues = this.resolveTag(defaultPath);
    let automaticValues = defaultValues;

    for (const kind of this.autoGenerate) {
      const inferredPath = this.automaticPath(kind, fullContext);
      if (!inferredPath) continue;

      const path = this.fullPath(inferredPath);
      if (path === defaultPath) continue;
      if (!this.definitions.has(path)) {
        this.definitions.set(path, {
          enabled: true,
          values: automaticValues,
          replace: false,
        });
      }
      if (this.definitions.get(path)!.enabled) automaticValues = this.resolveTag(path);
    }

    const rule = this.matchingRule(fullContext);
    if (!rule)
      return this.single(automaticValues, `Automatic reagent for ${recipeKey ?? reference.id}`);


    const path = this.fullPath(rule.path),
     values = this.ruleValues(rule.values, defaultValues, automaticValues),
     definition = this.definitions.get(path);
    if (definition && !definition.enabled)
      return this.single(automaticValues, `Disabled rule tag ${path}`);


    if (definition) definition.values = unique([...definition.values, ...values]);
    else this.definitions.set(path, { enabled: true, values, replace: false });
    return this.single(this.resolveTag(path), `Rule tag ${path}`);
  }

  /** Writes only generated tags that were referenced by at least one recipe. */
  async write(namespaceRoot: string): Promise<number> {
    const entries = [...this.outputValues].sort(([a], [b]) => a.localeCompare(b));
    await Promise.all(
      entries.map(([path, values]) =>
        writeJson(joinPath(namespaceRoot, 'tags', 'item', `${path}.json`), {
          replace: this.outputReplace.get(path) ?? false,
          values: [...values].sort(),
        }),
      ),
    );
    return entries.length;
  }
}
