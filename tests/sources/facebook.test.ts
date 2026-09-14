import { describe, expect, it } from "vitest";

import {
  collectFacebookPublicUrl,
  createFacebookManualDiscovery,
  parseFacebookPublicPage,
  parseFacebookPostText,
} from "../../scripts/sources/facebook";
import {
  normalizeFacebookPostText,
  parseFacebookAnnouncementText,
} from "../../scripts/sources/facebook-post";
import { fixture, mappedFetch } from "./test-helpers";

const NOW = new Date("2026-09-13T10:00:00.000Z");
const URL = "https://www.facebook.com/events/123456789/";
const POST_URL = "https://www.facebook.com/ommelsamvirke/posts/pfbid-example/";

describe("Facebook discovery source", () => {
  it("removes terminal and bidirectional controls from parsed post text", () => {
    expect(normalizeFacebookPostText("Koncert\u001b[2J \u202e2. oktober")).toBe(
      "Koncert 2. oktober",
    );
  });

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

  it("preserves the selected occurrence identity on a recurring Facebook event", async () => {
    const url = `${URL}?event_time_id=456`;
    const result = await collectFacebookPublicUrl(url, {
      fetch: mappedFetch({ [url]: await fixture("facebook-event.html") }),
      now: NOW,
    });
    expect(result.candidates[0]).toMatchObject({
      sourceEventId: "123456789-456",
      provenance: {
        sourceUrl: "https://www.facebook.com/events/123456789/?event_time_id=456",
      },
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

  it("rejects page and group feeds before fetching them", async () => {
    let fetched = false;
    const result = await collectFacebookPublicUrl("https://www.facebook.com/ommelsamvirke/", {
      fetch: async () => {
        fetched = true;
        return new Response();
      },
      now: NOW,
    });
    expect(result.status).toBe("failed");
    expect(result.errors.join(" ")).toContain("konkret");
    expect(fetched).toBe(false);
  });

  it("rejects credential-bearing Facebook URLs before fetching them", async () => {
    let fetched = false;
    const result = await collectFacebookPublicUrl(
      "https://editor:secret@facebook.com/example/posts/123/",
      {
        fetch: async () => {
          fetched = true;
          return new Response();
        },
        now: NOW,
      },
    );
    expect(result.status).toBe("failed");
    expect(fetched).toBe(false);
    expect(JSON.stringify(result)).not.toContain("secret");
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

  it("turns an announcement post into a review candidate", async () => {
    const result = await collectFacebookPublicUrl(POST_URL, {
      fetch: mappedFetch({ [POST_URL]: await fixture("facebook-post.html") }),
      now: NOW,
    });

    expect(result.status).toBe("complete");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      sourceEventId: "post-pfbid-example",
      stableId: "facebook-post-pfbid-example",
      title: "Fællesspisning i Ommel",
      location: { name: "Ommel Forsamlingshus" },
      price: "75 kr.",
      publication: "review",
      description: expect.stringContaining("Fællesspisning i Ommel"),
      occurrences: [{ date: "2026-10-02", startTime: "18:30", endTime: "21:00" }],
    });
    expect(result.candidates[0]?.reviewReasons.join(" ")).toContain("Årstal er udledt");
  });

  it("extracts only the concrete embed message and ignores comment dates", async () => {
    const url = "https://www.facebook.com/aeroehotel/posts/pfbid-tracking/?mibextid=test";
    const result = await collectFacebookPublicUrl(url, {
      fetch: mappedFetch({ [url]: await fixture("facebook-post-embed.html") }),
      now: NOW,
    });
    expect(result.status).toBe("complete");
    expect(result.candidates[0]).toMatchObject({
      sourceEventId: "post-pfbid-tracking",
      title: "Mortensaften på Ærø Hotel",
      occurrences: [{ date: "2026-11-10", startTime: "18:00" }],
    });
    expect(result.candidates[0]?.occurrences).toHaveLength(1);
  });

  it("rejects truncated announcement metadata", async () => {
    const url = "https://www.facebook.com/example/posts/112233/";
    const result = await collectFacebookPublicUrl(url, {
      fetch: mappedFetch({ [url]: await fixture("facebook-post-truncated.html") }),
      now: NOW,
    });
    expect(result.status).toBe("partial");
    expect(result.candidates).toEqual([]);
    expect(result.errors.join(" ")).toContain("afkortet");

    const domResult = parseFacebookPublicPage(
      `<meta property="og:url" content="https://www.facebook.com/example/posts/112233/">
       <article><div data-testid="post_message">Kom til koncert den 2. oktober 2026 kl. 19
       <button role="button">Se mere</button></div></article>`,
      url,
      NOW.toISOString(),
    );
    expect(domResult.candidates).toEqual([]);
    expect(domResult.errors.join(" ")).toContain("afkortet");
  });

  it("deduplicates identical structured post blocks", () => {
    const post = {
      "@context": "https://schema.org",
      "@type": "SocialMediaPosting",
      articleBody: "Kom til koncert den 2. oktober 2026 kl. 19",
      datePublished: "2026-09-13T10:00:00+02:00",
    };
    const html = `<script type="application/ld+json">${JSON.stringify(post)}</script>
      <script type="application/ld+json">${JSON.stringify(post)}</script>`;
    const parsed = parseFacebookPublicPage(
      html,
      "https://www.facebook.com/example/posts/445566/",
      NOW.toISOString(),
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.candidates).toHaveLength(1);
  });

  it("keeps a date without a time distinct from an all-day announcement", () => {
    const unknown = parseFacebookPostText({
      url: "https://www.facebook.com/example/posts/100/",
      text: "Kom til høstmarked den 4. oktober 2026",
      retrievedAt: NOW.toISOString(),
    });
    const allDay = parseFacebookPostText({
      url: "https://www.facebook.com/example/posts/101/",
      text: "Kom til heldagsarrangement den 4. oktober 2026, hele dagen",
      retrievedAt: NOW.toISOString(),
    });
    expect(unknown.candidates[0]?.occurrences[0]).toMatchObject({
      date: "2026-10-04",
      allDay: false,
      timeUnknown: true,
    });
    expect(allDay.candidates[0]?.occurrences[0]).toMatchObject({
      date: "2026-10-04",
      allDay: true,
      timeUnknown: false,
    });
  });

  it("ignores registration deadlines and expands a short explicit date range", () => {
    const parsed = parseFacebookAnnouncementText(
      "Kunstkursus på Ærø\n14.-16. oktober 2026 kl. 10.00\nTilmelding senest 1. oktober 2026",
      { now: NOW },
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.occurrences.map((item) => item.date)).toEqual([
      "2026-10-14",
      "2026-10-15",
      "2026-10-16",
    ]);
    expect(parsed.warnings.join(" ")).toContain("fristdato");
  });

  it("does not use a registration deadline time as the event time", () => {
    const parsed = parseFacebookAnnouncementText(
      "Høstmarked den 14. oktober 2026. Tilmelding senest 1. oktober 2026 kl. 12",
      { now: NOW },
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.occurrences).toEqual([
      {
        date: "2026-10-14",
        allDay: false,
        timeUnknown: true,
        evidence: "den 14. oktober 2026",
      },
    ]);

    const alternateWording = parseFacebookAnnouncementText(
      "Høstmarked den 14. oktober 2026. Sidste frist for tilmelding er den 1. oktober 2026 kl. 12",
      { now: NOW },
    );
    expect(alternateWording.occurrences).toHaveLength(1);
    expect(alternateWording.occurrences[0]).toMatchObject({
      date: "2026-10-14",
      timeUnknown: true,
    });

    const ticketSale = parseFacebookAnnouncementText(
      "Høstmarked den 14. oktober 2026. Billetsalget åbner 1. oktober 2026 kl. 12",
      { now: NOW },
    );
    expect(ticketSale.occurrences).toHaveLength(1);
    expect(ticketSale.occurrences[0]).toMatchObject({ date: "2026-10-14", timeUnknown: true });
  });

  it("uses the moved date without marking the replacement as cancelled", () => {
    const parsed = parseFacebookAnnouncementText(
      "Koncerten den 4. oktober 2026 er aflyst og flyttet til 11. oktober 2026 kl. 20",
      { now: NOW },
    );
    expect(parsed.status).toBe("scheduled");
    expect(parsed.title).toBe("Koncerten");
    expect(parsed.occurrences.map((item) => item.date)).toEqual(["2026-10-11"]);
    expect(parsed.reasons.join(" ")).toContain("Kun datoen markeret");

    const fromTo = parseFacebookAnnouncementText(
      "Koncert flyttet fra den 4. oktober 2026 til den 11. oktober 2026 kl. 20",
      { now: NOW },
    );
    expect(fromTo.occurrences.map((item) => item.date)).toEqual(["2026-10-11"]);
  });

  it("preserves an explicit cancellation when no replacement date is announced", () => {
    const parsed = parseFacebookAnnouncementText(
      "Koncert den 4. oktober 2026 kl. 20 er desværre aflyst",
      { now: NOW },
    );
    expect(parsed.status).toBe("cancelled");
    expect(parsed.occurrences[0]?.date).toBe("2026-10-04");

    const replacementUnknown = parseFacebookAnnouncementText(
      "Koncert den 4. oktober 2026 er AFLYST. Ny dato meldes ud senere",
      { now: NOW },
    );
    expect(replacementUnknown.status).toBe("cancelled");
    expect(replacementUnknown.occurrences[0]?.date).toBe("2026-10-04");

    const passive = parseFacebookAnnouncementText(
      "Koncert den 4. oktober 2026 kl. 20 aflyses",
      { now: NOW },
    );
    expect(passive.status).toBe("cancelled");

    const negated = parseFacebookAnnouncementText(
      "Koncert den 4. oktober 2026 er ikke aflyst og ikke udsolgt. Ikke kun for medlemmer.",
      { now: NOW },
    );
    expect(negated.status).toBe("scheduled");
    expect(negated.soldOut).toBe(false);
    expect(negated.attendance).toBe("unknown");
  });

  it("resolves relative dates only from an exact post timestamp", () => {
    const anchored = parseFacebookAnnouncementText("Vi inviterer til koncert i morgen kl. 19", {
      now: NOW,
      publishedAt: "2026-09-13T17:00:00+02:00",
    });
    const unanchored = parseFacebookAnnouncementText("Vi inviterer til koncert i morgen kl. 19", {
      now: NOW,
    });
    expect(anchored.occurrences[0]?.date).toBe("2026-09-14");
    expect(unanchored.occurrences).toEqual([]);
    expect(unanchored.errors.join(" ")).toContain("publiceringstidspunkt");

    const localTimestamp = parseFacebookAnnouncementText(
      "Vi inviterer til koncert i morgen kl. 19",
      { now: NOW, publishedAt: "2026-09-13T23:30:00" },
    );
    expect(localTimestamp.occurrences[0]?.date).toBe("2026-09-14");
  });

  it("reads a time immediately before the date and honors an explicit title", () => {
    const parsed = parseFacebookPostText({
      url: "https://www.facebook.com/example/posts/778899/",
      text: "Kl. 19 fredag den 2. oktober 2026\nVi inviterer til koncert",
      titleOverride: "Efterårskoncert",
      retrievedAt: NOW.toISOString(),
    });
    expect(parsed.candidates[0]).toMatchObject({
      title: "Efterårskoncert",
      occurrences: [{ date: "2026-10-02", startTime: "19:00" }],
    });
  });

  it("leaves competing unlabeled times unknown", () => {
    const parsed = parseFacebookAnnouncementText(
      "Koncert den 2. oktober 2026. Dørene åbner kl. 18, koncert kl. 20",
      { now: NOW },
    );
    expect(parsed.occurrences[0]).toMatchObject({ timeUnknown: true });
    expect(parsed.occurrences[0]?.startTime).toBeUndefined();
    expect(parsed.reasons.join(" ")).toContain("flere mulige");
  });

  it("uses the event start before a labelled door time and reads the following venue line", () => {
    const parsed = parseFacebookAnnouncementText(
      "Gratis Koncert med Emma Pilgaard - Årets Fynske Jazzmusiker\nMandag 14. september\nKl 18:00 (Døre åbner 17:30)\nMotorfabrikken Marstal\nhttps://www.facebook.com/events/1619221596534962\nArrangementet er gratis. Bemærk, at dørene åbner kl. 17.30.",
      { now: NOW },
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.occurrences).toEqual([
      expect.objectContaining({ date: "2026-09-14", startTime: "18:00" }),
    ]);
    expect(parsed.locationName).toBe("Motorfabrikken Marstal");
    expect(parsed.reasons.join(" ")).not.toContain("flere mulige starttidspunkter");

    const candidate = parseFacebookPostText({
      url: "https://www.facebook.com/motorfabrikkenmarstal/posts/1513004054196980/",
      text: "Gratis Koncert med Emma Pilgaard\nMandag 14. september\nKl 18:00\nMotorfabrikken Marstal",
      retrievedAt: NOW.toISOString(),
    }).candidates[0];
    expect(candidate?.categoryIds).toEqual(["musik-kultur"]);
  });

  it("rejects recurrence-only, non-event, and inconsistent weekday text", () => {
    expect(
      parseFacebookAnnouncementText("Yoga hver tirsdag kl. 18", { now: NOW }).errors.join(" "),
    ).toContain("dato");
    expect(
      parseFacebookAnnouncementText("Vi holder lukket den 2. oktober 2026", { now: NOW }).errors.join(" "),
    ).toContain("arrangementssignal");
    expect(
      parseFacebookAnnouncementText("Koncert mandag den 2. oktober 2026 kl. 19", { now: NOW }).errors.join(" "),
    ).toContain("uenige");
    expect(
      parseFacebookAnnouncementText("Ny kulturstrategi vedtages den 2. oktober 2026", {
        now: NOW,
      }).errors.join(" "),
    ).toContain("arrangementssignal");
    for (const ordinaryPost of [
      "Information fredag eftermiddag den 2. oktober 2026",
      "Ny rapport om arbejdsmarkedet den 2. oktober 2026",
      "Partiet udgiver sit manifest den 2. oktober 2026",
      "Tak for jeres fremmøde den 2. oktober 2026",
    ]) {
      expect(parseFacebookAnnouncementText(ordinaryPost, { now: NOW }).errors.join(" ")).toContain(
        "arrangementssignal",
      );
    }
    for (const embeddedMonth of [
      "Vi har 2 majestætiske koncerter",
      "Kom til 3 septemberfester",
    ]) {
      expect(parseFacebookAnnouncementText(embeddedMonth, { now: NOW }).errors.join(" ")).toContain(
        "dato",
      );
    }
    expect(
      parseFacebookAnnouncementText(
        "Koncert enten den 2. oktober 2026 eller den 3. oktober 2026",
        { now: NOW },
      ).errors.join(" "),
    ).toContain("alternative datoer");
    expect(
      parseFacebookAnnouncementText(
        "Kom til koncert. Billetnummer 123.10 oplyses ved døren",
        { now: NOW },
      ).errors.join(" "),
    ).toContain("dato");
  });

  it("does not confuse ages, enclosing festival dates, or cancellation terms with event facts", () => {
    const children = parseFacebookAnnouncementText(
      "Kalder alle børn i alderen 8-12 år! Kom med på kreativ workshop i dag kl. 10-12.30",
      { now: NOW, publishedAt: "2026-09-13T08:00:00+02:00" },
    );
    expect(children.occurrences).toHaveLength(1);
    expect(children.occurrences[0]).toMatchObject({ date: "2026-09-13", startTime: "10:00" });

    const festival = parseFacebookAnnouncementText(
      "Gratis koncert mandag den 14. september 2026 kl. 18. Dette arrangement er en del af sundhedsfestivalen, som finder sted fra den 14. til 18. september 2026.",
      { now: NOW },
    );
    expect(festival.occurrences).toHaveLength(1);
    expect(festival.occurrences[0]?.date).toBe("2026-09-14");
    expect(festival.warnings.join(" ")).toContain("overordnet arrangement");

    const terms = parseFacebookAnnouncementText(
      "Julemarkederne afholdes i år over fire lørdage. Henholdsvis lørdag d. 21/11, lørdag d. 28/11, lørdag d. 5/12 samt lørdag d. 12/12. Vi holder åbent fra kl. 9.30-17 alle dage. Man kan vælge at leje en bod for en, to, tre eller alle lørdage. Ved senere aflysning refunderes stadelejen ikke.",
      { now: NOW },
    );
    expect(terms.status).toBe("scheduled");
    expect(terms.occurrences).toEqual([
      expect.objectContaining({ date: "2026-11-21", startTime: "09:30", endTime: "17:00" }),
      expect.objectContaining({ date: "2026-11-28", startTime: "09:30", endTime: "17:00" }),
      expect.objectContaining({ date: "2026-12-05", startTime: "09:30", endTime: "17:00" }),
      expect.objectContaining({ date: "2026-12-12", startTime: "09:30", endTime: "17:00" }),
    ]);
    expect(terms.reasons.join(" ")).toContain("alle annoncerede datoer");

    const stay = parseFacebookAnnouncementText(
      "Jul på Ærø. Fra den 20. november er byen pyntet op til julemarked. Vi holder åbent for overnatning til 13. december. Book årets juleophold.",
      { now: NOW },
    );
    expect(stay.occurrences).toEqual([]);
    expect(stay.errors.join(" ")).toContain("arrangementssignal");
  });

  it("uses stable post identities despite tracking query changes", () => {
    const base = {
      text: "Kom til koncert den 2. oktober 2026 kl. 19",
      retrievedAt: NOW.toISOString(),
    };
    const first = parseFacebookPostText({
      ...base,
      url: "https://www.facebook.com/example/posts/998877/?mibextid=abc",
    });
    const second = parseFacebookPostText({
      ...base,
      url: "https://www.facebook.com/example/posts/998877/?utm_source=test",
    });
    expect(first.candidates[0]?.sourceEventId).toBe("post-998877");
    expect(second.candidates[0]?.sourceEventId).toBe(first.candidates[0]?.sourceEventId);
    expect(second.candidates[0]?.provenance.sourceUrl).toBe(
      "https://www.facebook.com/example/posts/998877/",
    );

    const group = parseFacebookPostText({
      ...base,
      url: "https://www.facebook.com/groups/aeroegruppen/posts/998877/",
    });
    const story = parseFacebookPostText({
      ...base,
      url: "https://www.facebook.com/permalink.php?story_fbid=998877&id=12345",
    });
    expect(group.candidates[0]?.sourceEventId).toBe("post-998877");
    expect(story.candidates[0]?.sourceEventId).toBe("post-998877");

    const groupPermalink = parseFacebookPostText({
      ...base,
      url: "https://www.facebook.com/groups/aeroegruppen/permalink/998877/",
    });
    expect(groupPermalink.candidates[0]?.sourceEventId).toBe("post-998877");
  });

  it("keeps identity stable between fetching and pasting the same pfbid URL", async () => {
    const fetched = await collectFacebookPublicUrl(POST_URL, {
      fetch: mappedFetch({ [POST_URL]: await fixture("facebook-post.html") }),
      now: NOW,
    });
    const pasted = parseFacebookPostText({
      url: POST_URL,
      text: "Fællesspisning i Ommel\nFredag den 2. oktober kl. 18.30",
      publishedAt: "2026-09-12T16:30:00+02:00",
      retrievedAt: NOW.toISOString(),
    });
    expect(fetched.candidates[0]?.sourceEventId).toBe("post-pfbid-example");
    expect(pasted.candidates[0]?.sourceEventId).toBe(fetched.candidates[0]?.sourceEventId);
  });
});
