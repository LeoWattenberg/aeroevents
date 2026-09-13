import { describe, expect, it } from "vitest";

import {
  librarySource,
  parseLibraryDetail,
  parseLibraryListing,
} from "../../scripts/sources/library";
import { fixture, mappedFetch } from "./test-helpers";

const NOW = new Date("2026-09-13T10:00:00.000Z");
const LISTING = "https://www.arrebib.dk/arrangementer";
const LISTING_2 = "https://www.arrebib.dk/arrangementer?page=1";
const DETAIL_1 =
  "https://www.arrebib.dk/aeroskobing-bibliotek/arrangementer/hjerneforedrag";
const DETAIL_2 =
  "https://www.arrebib.dk/marstal-bibliotek/arrangementer/forfatteraften";

describe("Ærø Folkebibliotek source", () => {
  it("follows listing pagination and fetches authoritative detail fields", async () => {
    const result = await librarySource.collect({
      fetch: mappedFetch({
        [LISTING]: await fixture("library-list-page-1.html"),
        [LISTING_2]: await fixture("library-list-page-2.html"),
        [DETAIL_1]: await fixture("library-detail.html"),
        [DETAIL_2]: await fixture("library-detail-cancelled.html"),
      }),
      now: NOW,
    });

    expect(result.status).toBe("complete");
    expect(result.pagesFetched).toBe(4);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({
      stableId: "aeroe-bibliotek-10266",
      price: "Gratis",
      bookingUrl: "https://tickets.example/10266",
      location: {
        name: "Ærø Rådhus",
        address: "Statene 2",
        postalCode: "5970",
        city: "Ærøskøbing",
      },
    });
    expect(result.candidates[1]).toMatchObject({
      status: "cancelled",
      availability: "sold-out",
    });
  });

  it("keeps the Drupal event id and occurrence id when date and venue markup change", async () => {
    const original = parseLibraryDetail(
      await fixture("library-detail.html"),
      DETAIL_1,
      NOW.toISOString(),
    ).candidate!;
    const changed = parseLibraryDetail(
      await fixture("library-detail-changed.html"),
      DETAIL_1,
      NOW.toISOString(),
    ).candidate!;

    expect(changed.stableId).toBe(original.stableId);
    expect(changed.occurrences[0]!.id).toBe(original.occurrences[0]!.id);
    expect(original.occurrences[0]!.date).toBe("2026-09-17");
    expect(changed.occurrences[0]!.date).toBe("2026-09-24");
  });

  it("does not publish a partial snapshot after a detail request fails", async () => {
    const result = await librarySource.collect({
      fetch: mappedFetch({
        [LISTING]: await fixture("library-list-page-1.html"),
        [LISTING_2]: await fixture("library-list-page-2.html"),
        [DETAIL_1]: await fixture("library-detail.html"),
        [DETAIL_2]: { status: 500 },
      }),
      now: NOW,
    });
    expect(result.status).toBe("partial");
    expect(result.candidates).toEqual([]);
  });

  it("treats an empty but structurally valid listing as partial", async () => {
    const empty = "<div data-drupal-views-infinite-scroll-content-wrapper><ul></ul></div>";
    const result = await librarySource.collect({
      fetch: mappedFetch({ [LISTING]: empty }),
      now: NOW,
    });
    expect(result.status).toBe("partial");
    expect(result.errors.join(" ")).toContain("ingen arrangementer");
  });

  it("resolves query-only pagination relative to the current listing path", () => {
    const parsed = parseLibraryListing(
      `<div data-drupal-views-infinite-scroll-content-wrapper>
        <ul><li class="content-list__item"><a class="content-list-item" href="/arrangementer/en-sikker-event"><h2 class="content-list-item__title">Sikker event</h2></a></li></ul>
       </div><a rel="next" href="?page=2">Næste</a>`,
      "https://www.arrebib.dk/arrangementer?page=1",
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.nextUrl).toBe("https://www.arrebib.dk/arrangementer?page=2");
  });

  it("rejects cross-origin detail and insecure pagination links", async () => {
    const unsafeListing = `<div data-drupal-views-infinite-scroll-content-wrapper>
      <ul><li class="content-list__item"><a class="content-list-item" href="https://attacker.example/event"><h2 class="content-list-item__title">Falsk event</h2></a></li></ul>
    </div><a rel="next" href="http://www.arrebib.dk/arrangementer?page=2">Næste</a>`;
    const parsed = parseLibraryListing(unsafeListing, LISTING);
    expect(parsed.items).toEqual([]);
    expect(parsed.nextUrl).toBeUndefined();
    expect(parsed.errors).toHaveLength(2);

    const requested: string[] = [];
    const result = await librarySource.collect({
      fetch: async (input) => {
        requested.push(String(input));
        return new Response(unsafeListing);
      },
      now: NOW,
    });
    expect(result.status).toBe("partial");
    expect(requested).toEqual([LISTING]);
  });
});
