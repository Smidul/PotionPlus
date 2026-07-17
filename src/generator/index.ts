#!/usr/bin/env bun

import { writeAdvancements } from './advancements.ts';
import { potionMatchingOptions, reagentCatalog } from './config.ts';
import { componentPreservingTippedArrowPath, generateRecipes } from './generate.ts';
import { selectedOverlay, writePackMetadata } from './pack.ts';
import { customStates, vanillaStates } from './potions.ts';
import { IngredientTagRegistry } from './tags.ts';
import { writePotionTables } from './tables.ts';
import type { GeneratorConfig } from './types.ts';
import { joinPath, parentPath, readJson, removeFile, removeGeneratedDirectory, resolveFromConfig, writeJson } from './utils.ts';
import { buildVanillaRecipes } from './vanilla.ts';
import { removeGeneratedVanillaRecipes, validateGenerated, validatePotionStateMatchers } from './validate.ts';

const NON_RECIPE_COUNT_KEYS = new Set(['item_tags', 'advancements', 'tables']);

/**
 * Loads configuration, generates recipes and tags, validates the output, and
 * prints the generation manifest.
 */
async function main(): Promise<void> {
  const configArgument = Bun.argv[2],
   configPath = configArgument ? Bun.resolveSync(configArgument, '.') : joinPath(import.meta.dir, 'config.json'),
   config = await readJson<GeneratorConfig>(configPath),
   includeVanilla = config.generator.include_vanilla_recipes ?? true,
   preserveImbuedComponents = config.generator.preserve_imbued_components ?? true,
   potionMatching = potionMatchingOptions(config),
   output = config.generator.output ?? {},

   dataRoot = resolveFromConfig(configPath, output.root ?? './data'),
   packRoot = parentPath(dataRoot),
   customNamespaceRoot = joinPath(dataRoot, config.generator.namespaces.custom),
   vanillaNamespaceRoot = joinPath(dataRoot, config.generator.namespaces.vanilla),
   customRecipeRoot = joinPath(customNamespaceRoot, 'recipe', 'brewing'),
   manifestPath = output.manifest ? resolveFromConfig(configPath, output.manifest) : null,

   vanillaRecipes = buildVanillaRecipes(config),

   tags = new IngredientTagRegistry(
    config.generator.namespaces.custom,
    config.generator.namespaces.vanilla,
    config.generator.item_tags,
    reagentCatalog(config),
  ),
   paths = { customNamespaceRoot, vanillaNamespaceRoot },
   custom = customStates(config),
   vanilla = vanillaStates(config);

  await writePackMetadata(config, packRoot);

  validatePotionStateMatchers(config, custom, vanilla, potionMatching);
  for (const warning of potionMatching.warnings)
    await Bun.write(Bun.stderr, `Warning: ${warning}\n`);

  await removeGeneratedDirectory(customRecipeRoot);
  await removeGeneratedDirectory(joinPath(customNamespaceRoot, 'tags', 'item', tags.root));
  await removeGeneratedVanillaRecipes(vanillaNamespaceRoot);
  await removeFile(componentPreservingTippedArrowPath(vanillaNamespaceRoot));

  const counts = await generateRecipes(config, paths, custom, vanilla, vanillaRecipes, tags, includeVanilla);
  counts.item_tags = await tags.write(customNamespaceRoot);

  const advancementSettings = config.generator.advancements;
  if (advancementSettings?.enabled) {
    const overlay = selectedOverlay(config, advancementSettings.overlay);
    if (!overlay) throw new Error('Advancement generation requires generator.advancements.overlay or exactly one target overlay');
    counts.advancements = await writeAdvancements(
      config,
      joinPath(packRoot, overlay),
      [...custom.values(), ...vanilla.values()],
    );
  }

  const tableSettings = config.generator.tables;
  if (tableSettings?.enabled) {
    const tablePath = resolveFromConfig(configPath, tableSettings.output ?? '../../POTION_TABLES.md');
    counts.tables = await writePotionTables(config, tablePath, custom, vanilla);
  }

  const [recipeTotal, tagTotal] = await validateGenerated(
    config,
    customRecipeRoot,
    customNamespaceRoot,
    vanillaNamespaceRoot,
    vanillaRecipes,
    includeVanilla,
    preserveImbuedComponents,
    tags,
    config.generator.namespaces.vanilla,
    potionMatching,
  ),
   countedRecipes = Object.entries(counts)
    .filter(([key]) => !NON_RECIPE_COUNT_KEYS.has(key))
    .reduce((total, [, count]) => total + count, 0);
  if (recipeTotal !== countedRecipes)
    throw new Error(`Recipe count mismatch: validated ${recipeTotal}, generated ${countedRecipes}`);

  if (tagTotal !== counts.item_tags)
    throw new Error(`Tag count mismatch: validated ${tagTotal}, generated ${counts.item_tags}`);


  const { warnings: _warnings, ...manifestPotionMatching } = potionMatching,
   manifest = {
    target: config.generator.target,
    namespaces: config.generator.namespaces,
    include_vanilla_recipes: includeVanilla,
    preserve_imbued_components: preserveImbuedComponents,
    potion_matching: manifestPotionMatching,
    output: { root: dataRoot, packRoot, customNamespaceRoot, vanillaNamespaceRoot },
    counts,
    recipe_total: recipeTotal,
    item_tag_total: tagTotal,
  };
  if (manifestPath) await writeJson(manifestPath, manifest);
  await Bun.write(Bun.stdout, `${JSON.stringify(manifest, null, 2)}\n`);
}

await main();
