import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getPaths } from "../../scripts/cli/config";

const originalState = process.env.AEROEVENTS_STATE_DIR;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  if (originalState === undefined) delete process.env.AEROEVENTS_STATE_DIR;
  else process.env.AEROEVENTS_STATE_DIR = originalState;
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("editorial state directory", () => {
  it("rejects relative and repository-local paths", () => {
    process.env.AEROEVENTS_STATE_DIR = "state";
    expect(() => getPaths()).toThrow(/absolut sti/);
    process.env.AEROEVENTS_STATE_DIR = resolve(process.cwd(), ".private-state");
    expect(() => getPaths()).toThrow(/uden for repositoriet/);
  });

  it("resolves symlinks before enforcing the repository boundary", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "aeroevents-config-"));
    temporaryDirectories.push(temporary);
    const link = join(temporary, "linked-state");
    await symlink(process.cwd(), link, "dir");
    process.env.AEROEVENTS_STATE_DIR = link;
    expect(() => getPaths()).toThrow(/uden for repositoriet/);
  });
});

