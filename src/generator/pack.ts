import type { DataPackOverlayConfig, GeneratorConfig, JsonObject } from './types.ts';
import { joinPath, writeJson } from './utils.ts';

function assertFormat(value: number, path: string): void {
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${path} must be a non-negative integer`);
}

function validateOverlay(
  overlay: DataPackOverlayConfig,
  packMin: number,
  packMax: number,
  index: number,
): void {
  const path = `generator.target.overlays[${index}]`;
  if (!overlay.directory?.trim()) throw new Error(`${path}.directory must not be empty`);
  assertFormat(overlay.min_format, `${path}.min_format`);
  assertFormat(overlay.max_format, `${path}.max_format`);
  if (overlay.min_format > overlay.max_format)
    throw new Error(`${path}.min_format cannot exceed ${path}.max_format`);
  if (overlay.min_format < packMin || overlay.max_format > packMax)
    throw new Error(`${path} must stay inside generator.target's supported format range`);
}

/** Resolves an explicitly selected overlay or the sole configured overlay. */
export function selectedOverlay(config: GeneratorConfig, selected?: string): string | null {
  const overlays = config.generator.target.overlays ?? [];
  if (!selected) return overlays.length === 1 ? overlays[0].directory : null;
  if (!overlays.some(overlay => overlay.directory === selected))
    throw new Error(`Unknown target overlay: ${selected}`);
  return selected;
}

/** Writes modern pack metadata using integer format ranges and optional overlays. */
export async function writePackMetadata(config: GeneratorConfig, packRoot: string): Promise<void> {
  const target = config.generator.target;
  assertFormat(target.min_format, 'generator.target.min_format');
  assertFormat(target.max_format, 'generator.target.max_format');
  if (target.min_format > target.max_format)
    throw new Error('generator.target.min_format cannot exceed generator.target.max_format');
  if (target.description === undefined)
    throw new Error('generator.target.description is required');

  const overlays = target.overlays ?? [];
  overlays.forEach((overlay, index) => validateOverlay(overlay, target.min_format, target.max_format, index));

  const value: JsonObject = {
    pack: {
      description: target.description,
      min_format: target.min_format,
      max_format: target.max_format,
    },
  };
  if (overlays.length) value.overlays = { entries: overlays };

  await writeJson(joinPath(packRoot, 'pack.mcmeta'), value);
}
