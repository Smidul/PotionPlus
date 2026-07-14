import type { JsonObject, LoadedRecipe } from './types.ts';
import { IngredientTagRegistry } from './tags.ts';
import { joinPath, listJsonFiles, readJson, removeFile } from './utils.ts';
import { vanillaRecipeRoot } from './generate.ts';

function validateRecipe(filePath: string, value: JsonObject, recipeType: string): void {
  if (value.type !== recipeType) throw new Error(`Wrong recipe type in ${filePath}`);
  for (const key of ['input', 'reagent', 'output'])
    if (!(key in value)) throw new Error(`Missing ${key} in ${filePath}`);

  if (!('item' in value.input) || !('potion_contents' in value.input))
    throw new Error(`Invalid input in ${filePath}`);

  if (!('item' in value.reagent)) throw new Error(`Invalid reagent in ${filePath}`);
  if (!('id' in value.output)) throw new Error(`Invalid output in ${filePath}`);
}

/** Validates recipe structure and every generated PotionPlus tag reference. */
export async function validateGenerated(
  customRecipeRoot: string,
  customNamespaceRoot: string,
  vanillaNamespaceRoot: string,
  vanillaRecipes: LoadedRecipe[],
  includeVanilla: boolean,
  tags: IngredientTagRegistry,
  vanillaNamespace: string,
): Promise<[recipeCount: number, tagCount: number]> {
  const recipePaths = await listJsonFiles(customRecipeRoot);
  if (includeVanilla) {
    const vanillaRoot = vanillaRecipeRoot(vanillaNamespaceRoot);
    for (const { relativePath } of vanillaRecipes) {
      const filePath = joinPath(vanillaRoot, relativePath);
      if (!(await Bun.file(filePath).exists()))
        throw new Error(`Missing generated vanilla recipe: ${filePath}`);

      recipePaths.push(filePath);
    }
  }

  const tagRoot = joinPath(customNamespaceRoot, 'tags', 'item', tags.root),
   tagPaths = await listJsonFiles(tagRoot),
   generatedTags = new Set(tagPaths.map(filePath => joinPath(filePath))),
   missing = new Set<string>(),

   requireTag = (reference: string): void => {
    if (!reference.startsWith(`#${tags.namespace}:`)) return;
    const tagName = reference.split(':', 2)[1],
     tagPath = joinPath(customNamespaceRoot, 'tags', 'item', `${tagName}.json`);
    if (!generatedTags.has(tagPath)) missing.add(reference);
  };

  for (const filePath of recipePaths) {
    const recipe = await readJson(filePath);
    validateRecipe(filePath, recipe, `${vanillaNamespace}:brewing`);
    if (typeof recipe.reagent?.item === 'string') requireTag(recipe.reagent.item);
  }

  for (const filePath of tagPaths) {
    const tag = await readJson(filePath);
    if (!Array.isArray(tag.values)) throw new Error(`Invalid item tag in ${filePath}`);
    for (const value of tag.values)
      if (typeof value === 'string') requireTag(value);
  }

  if (missing.size) throw new Error(`Missing generated item tags: ${[...missing].sort().join(', ')}`);
  return [recipePaths.length, tagPaths.length];
}

/** Removes only vanilla recipe files owned by this generator. */
export async function removeGeneratedVanillaRecipes(
  vanillaNamespaceRoot: string,
  vanillaRecipes: LoadedRecipe[],
): Promise<void> {
  const root = vanillaRecipeRoot(vanillaNamespaceRoot);
  await Promise.all(vanillaRecipes.map(({ relativePath }) => removeFile(joinPath(root, relativePath))));
}
