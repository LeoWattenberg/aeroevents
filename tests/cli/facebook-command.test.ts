import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { dispatch } from "../../scripts/cli/commands";
import { getPaths } from "../../scripts/cli/config";
import { listPending, markRejected } from "../../scripts/cli/review-store";

const originalState = process.env.AEROEVENTS_STATE_DIR;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalState === undefined) delete process.env.AEROEVENTS_STATE_DIR;
  else process.env.AEROEVENTS_STATE_DIR = originalState;
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function setup(text: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aeroevents-facebook-post-"));
  temporaryDirectories.push(root);
  process.env.AEROEVENTS_STATE_DIR = join(root, "state");
  const details = join(root, "post.txt");
  await writeFile(details, text);
  return details;
}

describe("facebook announcement CLI", () => {
  it("parses pasted public post text into one idempotent private review candidate", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const details = await setup(
      "Fællesspisning i Ommel\nFredag den 2. oktober kl. 18.30\nSted: Ommel Forsamlingshus",
    );
    const args = [
      "facebook",
      "https://www.facebook.com/ommelsamvirke/posts/987654321/?mibextid=test",
      "--details-file",
      details,
      "--published-at",
      "2026-09-12T16:30:00+02:00",
    ];

    await dispatch(args);
    await dispatch(args);

    const candidates = await listPending(getPaths());
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      candidateKey: "facebook:post-987654321",
      sourceEventId: "post-987654321",
      event: {
        title: "Fællesspisning i Ommel",
        description: "",
        publication: "draft",
        location: { name: "Ommel Forsamlingshus" },
        schedule: {
          kind: "explicit",
          dates: [{ kind: "timed", date: "2026-10-02", startTime: "18:30" }],
        },
      },
      private: {
        parseEvidence: ["den 2. oktober kl. 18.30"],
      },
    });
    expect((candidates[0]?.private as { pastedDetails?: string }).pastedDetails).toContain(
      "Fællesspisning",
    );
    expect(JSON.stringify(candidates[0]?.event)).not.toContain("pastedDetails");
  });

  it("keeps a rejected post identity rejected when it is parsed again", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const details = await setup("Kom til koncert den 2. oktober 2026 kl. 19");
    const args = [
      "facebook",
      "https://www.facebook.com/example/posts/112233/",
      "--details-file",
      details,
    ];
    await dispatch(args);
    const paths = getPaths();
    const [candidate] = await listPending(paths);
    expect(candidate).toBeDefined();
    await markRejected(paths, candidate!, "Ikke relevant");

    await dispatch(args);
    expect(await listPending(paths)).toEqual([]);
    const rejected = await readFile(join(paths.reviewRejected, `${candidate!.candidateId}.json`), "utf8");
    expect(rejected).toContain("Ikke relevant");
  });
});
