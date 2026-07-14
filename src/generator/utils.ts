import { mkdir, rm } from 'node:fs/promises';
import { Glob } from 'bun';
import type { JsonObject } from './types.ts';

function slash(value: string): string {
  return value.replaceAll('\\', '/');
}

function splitPrefix(value: string): [prefix: string, body: string] {
  const normalized = slash(value),
   drive = normalized.match(/^[A-Za-z]:\//)?.[0];
  if (drive) return [drive, normalized.slice(drive.length)];
  if (normalized.startsWith('/')) return ['/', normalized.slice(1)];
  return ['', normalized];
}

/** Joins file-system path segments. */
export function joinPath(...values: (string | undefined | null)[]): string {
  const input = values.filter((value): value is string => Boolean(value)).join('/'),
   [prefix, body] = splitPrefix(input),
   parts: string[] = [];

  for (const part of body.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length && parts.at(-1) !== '..') parts.pop();
      else if (!prefix) parts.push(part);
      continue;
    }
    parts.push(part);
  }

  const result = `${prefix}${parts.join('/')}`;
  return result || prefix || '.';
}

/** Returns the parent directory of a file-system path. */
export function parentPath(value: string): string {
  const normalized = slash(value).replace(/\/+$/, ''),
   index = normalized.lastIndexOf('/');
  if (index < 0) return '.';
  if (index === 0) return '/';
  return normalized.slice(0, index);
}

/** Returns the final path segment. */
export function baseName(value: string): string {
  return slash(value).replace(/\/+$/, '').split('/').at(-1) ?? '';
}

/** Returns a filename without its final extension. */
export function fileStem(value: string): string {
  return baseName(value).replace(/\.[^.]+$/, '');
}

/** Resolves a configured path relative to its config file. */
export function resolveFromConfig(configPath: string, configuredPath: string): string {
  const [prefix] = splitPrefix(configuredPath);
  return prefix ? joinPath(configuredPath) : joinPath(parentPath(configPath), configuredPath);
}

/** Reads a JSON file **/
export function readJson<T = JsonObject>(filePath: string): Promise<T> {
  return Bun.file(filePath).json() as Promise<T>;
}

/** Recursively removes generated output while rejecting filesystem roots. */
export async function removeGeneratedDirectory(directory: string): Promise<void> {
  const normalized = slash(directory).replace(/\/+$/, '');
  if (!normalized || normalized === '.' || normalized === '/' || /^[A-Za-z]:$/.test(normalized))
    throw new Error(`Refusing to remove unsafe directory: ${directory}`);
  await rm(directory, { force: true, recursive: true });
}

/** Deletes one file if it exists. */
export async function removeFile(filePath: string): Promise<void> {
  const file = Bun.file(filePath);
  if (await file.exists()) await file.delete();
}

/** Writes stable, two-space-indented JSON and creates parent directories. */
export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(parentPath(filePath), { recursive: true });
  await Bun.write(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/** Adds a default namespace when an item or tag omits one. */
export function namespaced(value: string, defaultNamespace = 'minecraft'): string {
  if (value.startsWith('#')) {
    const inner = value.slice(1);
    return `#${inner.includes(':') ? inner : `${defaultNamespace}:${inner}`}`;
  }
  return value.includes(':') ? value : `${defaultNamespace}:${value}`;
}

/** Extracts the resource path from a namespaced identifier. */
export function resourcePath(value: string): string {
  return value.replace(/^#/, '').split(':', 2).at(-1) ?? value;
}

/** Normalizes user-configured paths into safe data-pack resource paths. */
export function normalizePath(value: string): string {
  return value
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase()
    .replaceAll(' ', '_')
    .replace(/[^a-z0-9_./-]/g, '_')
    .replace(/\/{2,}/g, '/');
}

/** Removes vanilla `long_` and `strong_` prefixes. */
export function basePotionKey(value: string): string {
  for (const prefix of ['long_', 'strong_'])
    if (value.startsWith(prefix)) return value.slice(prefix.length);

  return value;
}

/** Recursively lists JSON files below a directory. */
export async function listJsonFiles(root: string): Promise<string[]> {
  const files: string[] = [],
   glob = new Glob('**/*.json');

  try {
    for await (const relative of glob.scan({ cwd: root, onlyFiles: true }))
      files.push(joinPath(root, relative));
  } catch {
    return [];
  }

  return files.sort();
}
