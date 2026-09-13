import { homedir } from "node:os";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface CliPaths {
  repo: string;
  state: string;
  manualEvents: string;
  importedEvents: string;
  overrides: string;
  sourceStatus: string;
  reviewPending: string;
  reviewApproved: string;
  reviewRejected: string;
  raw: string;
}

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function defaultStateDirectory(): string {
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg && isAbsolute(xdg)) return resolve(xdg, "aeroevents");
  return resolve(homedir(), ".local/state/aeroevents");
}

function isInside(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}

function realPathIncludingMissing(path: string): string {
  const missing: string[] = [];
  let existing = path;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missing.unshift(basename(existing));
    existing = parent;
  }
  const realExisting = existsSync(existing) ? realpathSync(existing) : existing;
  return resolve(realExisting, ...missing);
}

export function getPaths(): CliPaths {
  const configured = process.env.AEROEVENTS_STATE_DIR;
  if (configured && !isAbsolute(configured)) {
    throw new Error("AEROEVENTS_STATE_DIR skal være en absolut sti.");
  }
  const state = resolve(configured || defaultStateDirectory());
  if (isInside(realpathSync(repo), realPathIncludingMissing(state))) {
    throw new Error(
      `AEROEVENTS_STATE_DIR skal ligge uden for repositoriet (${repo}); fik ${state}`,
    );
  }

  return {
    repo,
    state,
    manualEvents: resolve(repo, "data/manual/events"),
    importedEvents: resolve(repo, "data/imported"),
    overrides: resolve(repo, "data/overrides"),
    sourceStatus: resolve(repo, "data/source-status.json"),
    reviewPending: resolve(state, "review/pending"),
    reviewApproved: resolve(state, "review/approved"),
    reviewRejected: resolve(state, "review/rejected"),
    raw: resolve(state, "raw"),
  };
}
