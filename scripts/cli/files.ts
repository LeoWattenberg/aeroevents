import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { parse as parseYaml } from "yaml";

export async function ensureDirectory(path: string, mode = 0o700): Promise<void> {
  await mkdir(path, { recursive: true, mode });
}

export async function atomicWrite(
  destination: string,
  contents: string,
  mode = 0o600,
): Promise<void> {
  await ensureDirectory(dirname(destination));
  const temporary = join(
    dirname(destination),
    `.${randomBytes(12).toString("hex")}.tmp`,
  );

  try {
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx", mode });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function atomicWriteJson(path: string, value: unknown, mode = 0o600): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export async function readStructuredFile(path: string): Promise<unknown> {
  const contents = await readFile(path, "utf8");
  const extension = extname(path).toLowerCase();
  if (extension === ".yaml" || extension === ".yml") return parseYaml(contents);
  return JSON.parse(contents) as unknown;
}

export async function listFiles(path: string, extensions = [".json"]): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter((name) => extensions.includes(extname(name).toLowerCase()))
    .sort()
    .map((name) => join(path, name));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)) ?? "undefined")
    .digest("hex");
}

export function safeId(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const result = normalized.length <= 80
    ? normalized
    : `${normalized.slice(0, 71).replace(/-+$/g, "")}-${digest(normalized).slice(0, 8)}`;
  if (!result) throw new Error(`Kan ikke danne et sikkert id fra ${JSON.stringify(value)}`);
  return result;
}
