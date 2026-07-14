#!/usr/bin/env bun

import { reagentCatalog } from './config.ts';
import { generateRecipes } from './generate.ts';
import { customStates, vanillaStates } from './potions.ts';
import { IngredientTagRegistry } from './tags.ts';
import type { GeneratorConfig } from './types.ts';
import { joinPath, readJson,  removeGeneratedDirectory,  resolveFromConfig, writeJson } from './utils.ts';
import { buildVanillaRecipes } from './vanilla.ts';
import { removeGeneratedVanillaRecipes, validateGenerated } from './validate.ts';

/**
 * Loads configuration, generates recipes and tags, validates the output, and
 * prints the generation manifest.
 */
async function main(): Promise<void> {
  const configArgument = Bun.argv[2],
   configPath = configArgument ? Bun.resolveSync(configArgument, '.') : joinPath(import.meta.dir, 'config.json'),
   config = await readJson<GeneratorConfig>(configPath),
   includeVanilla = config.generator.include_vanilla_recipes ?? true,
   output = config.generator.output ?? {},

   dataRoot = resolveFromConfig(configPath, output.root ?? './data'),
   customNamespaceRoot = joinPath(dataRoot, config.namespaces.custom),
   vanillaNamespaceRoot = joinPath(dataRoot, config.namespaces.vanilla),
   customRecipeRoot = joinPath(customNamespaceRoot, 'recipe', 'brewing'),
   manifestPath = output.manifest ? resolveFromConfig(configPath, output.manifest) : null,

   vanillaRecipes = buildVanillaRecipes(config),

   tags = new IngredientTagRegistry(
    config.namespaces.custom,
    config.namespaces.vanilla,
    config.generator.item_tags,
    reagentCatalog(config),
  ),
   paths = { customNamespaceRoot, vanillaNamespaceRoot };

  await removeGeneratedDirectory(customRecipeRoot);
  await removeGeneratedDirectory(joinPath(customNamespaceRoot, 'tags', 'item', tags.root));
  await removeGeneratedVanillaRecipes(vanillaNamespaceRoot, vanillaRecipes);

  const custom = customStates(config),
   vanilla = vanillaStates(config),
   counts = await generateRecipes(config, paths, custom, vanilla, vanillaRecipes, tags, includeVanilla);
  counts.item_tags = await tags.write(customNamespaceRoot);

  const [recipeTotal, tagTotal] = await validateGenerated(
    customRecipeRoot,
    customNamespaceRoot,
    vanillaNamespaceRoot,
    vanillaRecipes,
    includeVanilla,
    tags,
    config.namespaces.vanilla,
  ),
   countedRecipes = Object.entries(counts)
    .filter(([key]) => key !== 'item_tags')
    .reduce((total, [, count]) => total + count, 0);
  if (recipeTotal !== countedRecipes)
    throw new Error(`Recipe count mismatch: validated ${recipeTotal}, generated ${countedRecipes}`);

  if (tagTotal !== counts.item_tags)
    throw new Error(`Tag count mismatch: validated ${tagTotal}, generated ${counts.item_tags}`);


  const manifest = {
    namespaces: config.namespaces,
    include_vanilla_recipes: includeVanilla,
    output: { root: dataRoot, customNamespaceRoot, vanillaNamespaceRoot },
    counts,
    recipe_total: recipeTotal,
    item_tag_total: tagTotal,
  };
  if (manifestPath) await writeJson(manifestPath, manifest);
  await Bun.write(Bun.stdout, `${JSON.stringify(manifest, null, 2)}\n`);
}

await main();
