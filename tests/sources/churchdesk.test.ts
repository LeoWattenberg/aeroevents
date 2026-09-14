import { describe, expect, it } from "vitest";

import {
  churchDeskPageUrl,
  churchDeskSource,
  parseChurchDeskPage,
} from "../../scripts/sources/churchdesk";
import { fixture, mappedFetch } from "./test-helpers";

const NOW = new Date("2026-09-13T10:00:00.000Z");

describe("Ærø Kirkeliv ChurchDesk source", () => {
  it("uses the verified site id in every pagination URL", () => {
    expect(churchDeskPageUrl(2)).toBe(
      "https://widget.churchdesk.com/da/w/1709/event/7HsDjgjjLaLL/2/1350954",
    );
  });

  it("collects every advertised page and trusts every valid category", async () => {
    const page1 = await fixture("churchdesk-page-1.html");
    const page2 = await fixture("churchdesk-page-2.html");
    const result = await churchDeskSource.collect({
      fetch: mappedFetch({
        [churchDeskPageUrl(1)]: page1,
        [churchDeskPageUrl(2)]: page2,
      }),
      now: NOW,
    });

    expect(result.status).toBe("complete");
    expect(result.pagesFetched).toBe(2);
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.find(({ sourceEventId }) => sourceEventId === "501")).toMatchObject({
      publication: "trusted",
      occurrences: [{ date: "2026-10-04", startTime: "10:00" }],
    });
    expect(result.candidates.find(({ sourceEventId }) => sourceEventId === "502")).toMatchObject({
      publication: "trusted",
      reviewReasons: [],
    });
    expect(result.candidates.find(({ sourceEventId }) => sourceEventId === "503")?.status).toBe(
      "cancelled",
    );
  });

  it("discards all fetched candidates when a later page fails", async () => {
    const result = await churchDeskSource.collect({
      fetch: mappedFetch({
        [churchDeskPageUrl(1)]: await fixture("churchdesk-page-1.html"),
        [churchDeskPageUrl(2)]: { status: 502 },
      }),
      now: NOW,
    });

    expect(result.status).toBe("partial");
    expect(result.candidates).toEqual([]);
    expect(result.status === "partial" && result.discardedCandidateCount).toBe(2);
  });

  it("rejects missing fields and an unexpectedly empty source", async () => {
    const malformed = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: {
        pageProps: {
          widget: {
            items: [{ id: 1, title: "Mangler dato" }],
            pageNumber: 1,
            total: 1,
            totalPages: 1,
            pageSize: 5,
          },
        },
      },
    })}</script>`;
    expect(parseChurchDeskPage(malformed, NOW.toISOString()).errors.join(" ")).toContain(
      "startdato",
    );

    const empty = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: {
        pageProps: {
          widget: { items: [], pageNumber: 1, total: 0, totalPages: 1, pageSize: 5 },
        },
      },
    })}</script>`;
    const result = await churchDeskSource.collect({
      fetch: mappedFetch({ [churchDeskPageUrl(1)]: empty }),
      now: NOW,
    });
    expect(result.status).toBe("partial");
    expect(result.candidates).toEqual([]);
  });
});
