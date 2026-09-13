import { describe, expect, it } from "vitest";

import {
  collectFacebookPublicUrl,
  createFacebookManualDiscovery,
} from "../../scripts/sources/facebook";
import { fixture, mappedFetch } from "./test-helpers";

const NOW = new Date("2026-09-13T10:00:00.000Z");
const URL = "https://www.facebook.com/events/123456789/";

describe("Facebook discovery source", () => {
  it("extracts public structured metadata but always requires review", async () => {
    const result = await collectFacebookPublicUrl(URL, {
      fetch: mappedFetch({ [URL]: await fixture("facebook-event.html") }),
      now: NOW,
    });
    expect(result.status).toBe("complete");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      sourceEventId: "123456789",
      publication: "review",
      attendance: "unknown",
      occurrences: [{ date: "2026-07-10", startTime: "19:30" }],
    });
  });

  it("reports login barriers without returning discovered data", async () => {
    const result = await collectFacebookPublicUrl(URL, {
      fetch: mappedFetch({ [URL]: await fixture("facebook-login.html") }),
      now: NOW,
    });
    expect(result.status).toBe("partial");
    expect(result.candidates).toEqual([]);
    expect(result.errors.join(" ")).toContain("login");
  });

  it("rejects non-Facebook URLs before making a request", async () => {
    let fetched = false;
    const result = await collectFacebookPublicUrl("https://example.com/event", {
      fetch: async () => {
        fetched = true;
        return new Response();
      },
      now: NOW,
    });
    expect(result.status).toBe("failed");
    expect(fetched).toBe(false);
  });

  it("provides a deterministic paste fallback for inaccessible public posts", () => {
    const first = createFacebookManualDiscovery(
      { url: URL, title: "Koncert", date: "2026-11-01", startTime: "20:00" },
      NOW,
    );
    const repeated = createFacebookManualDiscovery(
      { url: URL, title: "Koncert (opdateret)", date: "2026-11-01", startTime: "20:30" },
      NOW,
    );
    expect(repeated.stableId).toBe(first.stableId);
    expect(first.publication).toBe("review");
    expect(first.occurrences[0]?.startTime).toBe("20:00");
  });
});
