import { describe, expect, it } from "vitest";

import { safeId } from "../../scripts/cli/files";

describe("safeId", () => {
  it("keeps long IDs valid and distinguishes values beyond the truncation boundary", () => {
    const common = "aeroe-folkeuniversitet-haandtering-af-landbrugets-udfordringer-med-kvaelstof-og-";
    const first = safeId(`${common}pesticider`);
    const second = safeId(`${common}naturgenopretning`);
    expect(first).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(first.length).toBeLessThanOrEqual(80);
    expect(first).not.toBe(second);
  });
});
