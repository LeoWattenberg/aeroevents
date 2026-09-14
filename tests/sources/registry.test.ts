import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

import { SOURCE_ADAPTERS } from "../../scripts/sources";
import { SOURCE_REGISTRY } from "../../scripts/sources/registry";
import { SOURCE_IDS } from "../../scripts/sources/types";

describe("source registry coverage", () => {
  it("has exactly one adapter and one enabled policy for every registered source", async () => {
    expect(Object.keys(SOURCE_REGISTRY)).toEqual([...SOURCE_IDS]);
    expect(Object.keys(SOURCE_ADAPTERS)).toEqual([...SOURCE_IDS]);
    for (const id of SOURCE_IDS) expect(SOURCE_ADAPTERS[id].definition).toEqual(SOURCE_REGISTRY[id]);

    const yaml = await readFile(path.join(process.cwd(), "data/sources.yaml"), "utf8");
    const policies = parseYaml(yaml) as Array<{ id: string; enabled?: boolean }>;
    const enabledRegistered = policies
      .filter((policy) => policy.enabled && policy.id !== "manual")
      .map((policy) => policy.id);
    expect(enabledRegistered).toEqual([...SOURCE_IDS]);
  });
});
