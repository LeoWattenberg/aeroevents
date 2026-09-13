import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRawResponseCapture } from "../../scripts/cli/raw-responses";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("raw response capture", () => {
  it("groups a run outside public data and uses private collision-safe files", async () => {
    const root = await mkdtemp(join(tmpdir(), "aeroevents-raw-"));
    temporaryDirectories.push(root);
    const capture = createRawResponseCapture(root, new Date("2026-09-13T10:00:00Z"));
    const response = {
      url: "https://example.test/events?page=1",
      status: 200,
      contentType: "text/html",
      body: "<p>råt svar</p>",
    };
    await Promise.all([capture.recordResponse(response), capture.recordResponse(response)]);
    const files = await readdir(capture.runDirectory);
    expect(files).toHaveLength(2);
    expect(new Set(files).size).toBe(2);
    expect(await readFile(join(capture.runDirectory, files[0]!), "utf8")).toContain("råt svar");
    expect((await stat(join(capture.runDirectory, files[0]!))).mode & 0o777).toBe(0o600);
  });
});

