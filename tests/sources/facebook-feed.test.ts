import { describe, expect, it } from "vitest";

import {
  collectFacebookFeeds,
  discoverFacebookFeed,
  parseFacebookFeedConfiguration,
  type FacebookBrowserClient,
  type FacebookBrowserSnapshot,
  type FacebookFeedSource,
} from "../../scripts/sources/facebook-feed";

const NOW = new Date("2026-09-13T10:00:00.000Z");
const FEED_URL = "https://www.facebook.com/example/events?locale=da_DK";

const FEED_HTML = `<!doctype html><html><body>
  <a href="/events/123456789/?event_time_id=456&amp;acontext=tracking">Efterårskoncert</a>
  <a href="https://m.facebook.com/events/123456789/?event_time_id=456&amp;ref=duplicate">Dublet</a>
  <div role="article">
    <a href="/example/posts/998877/?mibextid=test"><time datetime="2026-09-12T16:30:00+02:00">1 d.</time></a>
    <div data-ad-rendering-role="story_message">Fællesspisning i Ommel<br>Fredag den 2. oktober 2026 kl. 18.30 i Ommel Forsamlingshus</div>
    <div role="article">
      <a href="/groups/example/posts/111222/">Kommentar</a>
      <div data-ad-rendering-role="story_message">Jeg kommer den 4. oktober</div>
    </div>
  </div>
  <article>
    <a href="/example/posts/887766/">17 t.</a>
    <div data-testid="post_message">Koncert den 10. oktober 2026 kl. 20 … <button role="button">Se mere</button></div>
  </article>
</body></html>`;

function source(overrides: Partial<FacebookFeedSource> = {}): FacebookFeedSource {
  return {
    id: "example",
    name: "Eksempelkilde",
    enabled: true,
    eventFeedUrl: FEED_URL,
    maxItems: 8,
    ...overrides,
  };
}

function fakeBrowser(
  pages: Record<string, string | Error>,
  opened: string[] = [],
): () => Promise<FacebookBrowserClient> {
  return async () => ({
    async open(url): Promise<FacebookBrowserSnapshot> {
      opened.push(url);
      const page = pages[url];
      if (page instanceof Error) throw page;
      if (page === undefined) throw new Error(`Uventet URL: ${url}`);
      return {
        requestedUrl: url,
        finalUrl: url,
        status: 200,
        contentType: "text/html; charset=utf-8",
        html: page,
      };
    },
    async close() {},
  });
}

describe("Facebook feed crawler", () => {
  it("discovers event links and full announcement posts without treating comments as posts", () => {
    expect(discoverFacebookFeed(FEED_HTML, FEED_URL)).toEqual([
      {
        url: "https://www.facebook.com/events/123456789/?event_time_id=456",
        kind: "event",
        truncated: false,
      },
      {
        url: "https://www.facebook.com/example/posts/998877/",
        kind: "post",
        text: "Fællesspisning i Ommel\nFredag den 2. oktober 2026 kl. 18.30 i Ommel Forsamlingshus",
        publishedAt: "2026-09-12T14:30:00.000Z",
        truncated: false,
      },
      {
        url: "https://www.facebook.com/example/posts/887766/",
        kind: "post",
        text: "Koncert den 10. oktober 2026 kl. 20 …",
        truncated: true,
      },
    ]);
  });

  it("parses inline announcements and opens event and truncated-post detail pages", async () => {
    const eventUrl = "https://www.facebook.com/events/123456789/?event_time_id=456";
    const postUrl = "https://www.facebook.com/example/posts/887766/";
    const eventHtml = `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Event",
      name: "Efterårskoncert",
      startDate: "2026-10-10T20:00:00+02:00",
      url: "https://www.facebook.com/events/123456789/",
    })}</script>`;
    const postHtml = `<meta property="og:url" content="${postUrl}">
      <article><time datetime="2026-09-12T12:00:00+02:00"></time>
      <div data-testid="post_message">Høstmarked den 11. oktober 2026 kl. 10 på Torvet</div></article>`;
    const opened: string[] = [];
    const recorded: string[] = [];
    const result = await collectFacebookFeeds(
      {
        fetch: globalThis.fetch,
        now: NOW,
        recordResponse: async (response) => {
          recorded.push(response.url);
        },
      },
      {
        sources: [source()],
        githubActions: false,
        createBrowser: fakeBrowser({ [FEED_URL]: FEED_HTML, [eventUrl]: eventHtml, [postUrl]: postHtml }, opened),
      },
    );

    expect(result.status).toBe("complete");
    expect(result.pagesFetched).toBe(3);
    expect(opened).toEqual([FEED_URL, eventUrl, postUrl]);
    expect(recorded).toEqual(opened);
    expect(result.candidates.map((candidate) => candidate.sourceEventId).sort()).toEqual([
      "123456789-456",
      "post-887766",
      "post-998877",
    ]);
    expect(result.candidates.find((candidate) => candidate.sourceEventId === "post-998877"))
      .toMatchObject({
        title: "Fællesspisning i Ommel",
        occurrences: [{ date: "2026-10-02", startTime: "18:30" }],
        publication: "review",
      });
  });

  it("keeps successful sources when another configured feed fails", async () => {
    const failedUrl = "https://www.facebook.com/missing/events";
    const result = await collectFacebookFeeds(
      { fetch: globalThis.fetch, now: NOW },
      {
        sources: [source(), source({ id: "missing", name: "Manglende", eventFeedUrl: failedUrl })],
        githubActions: false,
        createBrowser: fakeBrowser({ [FEED_URL]: FEED_HTML, [failedUrl]: new Error("navigation timeout") }),
        maxDetails: 1,
      },
    );
    expect(result.status).toBe("complete");
    expect(result.candidates.some((candidate) => candidate.sourceEventId === "post-998877")).toBe(true);
    expect(result.warnings.join(" ")).toContain("navigation timeout");
  });

  it("validates unique public Facebook feed definitions", () => {
    expect(parseFacebookFeedConfiguration([{ id: "one", name: "En", postFeedUrl: "https://facebook.com/one/posts" }]))
      .toMatchObject([{ id: "one", enabled: true, maxItems: 8 }]);
    expect(() =>
      parseFacebookFeedConfiguration([{ id: "one", name: "En", postFeedUrl: "https://example.com/posts" }]),
    ).toThrow(/facebook\.com/);
    expect(() =>
      parseFacebookFeedConfiguration([
        { id: "one", name: "En", postFeedUrl: "https://facebook.com/one/posts" },
        { id: "one", name: "To", postFeedUrl: "https://facebook.com/two/posts" },
      ]),
    ).toThrow(/flere gange/);
  });

  it("does not start the browser in GitHub Actions", async () => {
    let started = false;
    const result = await collectFacebookFeeds(
      { fetch: globalThis.fetch, now: NOW },
      {
        sources: [source()],
        githubActions: true,
        createBrowser: async () => {
          started = true;
          throw new Error("må ikke ske");
        },
      },
    );
    expect(result.status).toBe("failed");
    expect(result.errors.join(" ")).toContain("kun lokalt");
    expect(started).toBe(false);
  });
});
