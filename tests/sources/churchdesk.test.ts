import { describe, expect, it } from "vitest";
import { load } from "cheerio";
import { DateTime } from "luxon";

import {
  churchDeskPageUrl,
  churchDeskSource,
  parseChurchDeskPage,
} from "../../scripts/sources/churchdesk";
import { sourceDraftToEvent } from "../../scripts/cli/model";
import { expandEvent } from "../../src/lib/schedule";
import { fixture, mappedFetch } from "./test-helpers";

const NOW = new Date("2026-09-13T10:00:00.000Z");

function churchDeskHtml(items: unknown[]): string {
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: {
      pageProps: {
        widget: {
          items,
          pageNumber: 1,
          total: items.length,
          totalPages: 1,
          pageSize: Math.max(items.length, 1),
        },
      },
    },
  })}</script>`;
}

function programmeItem(options: {
  id: number;
  title: string;
  date: string;
  time: string;
  contributor: string;
  locationName: string;
  address: string;
  postalCode: string;
  city: string;
}) {
  const start = DateTime.fromISO(`${options.date}T${options.time}`, {
    zone: "Europe/Copenhagen",
  });
  return {
    id: options.id,
    title: options.title,
    cancelledAt: null,
    startDate: start.toUTC().toISO(),
    endDate: start.plus({ hours: 1 }).toUTC().toISO(),
    contributor: `v. ${options.contributor}`,
    hideEndTime: true,
    allDay: false,
    url: `https://www.xn--rkirkeliv-f3a3r.dk/b/program-${options.id}`,
    locationName: options.locationName,
    locationObj: {
      address: options.address,
      zipcode: options.postalCode,
      city: options.city,
    },
  };
}

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
      organizerId: "linda-skjoennemand",
      organizerName: "Linda Skjønnemand",
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

  it("consolidates only the three allowlisted programmes into bounded recurring events", async () => {
    const babyDates = ["2026-09-16", "2026-09-23", "2026-09-30", "2026-10-07"];
    const babies = babyDates.map(
      (date, index) => programmeItem({
        id: [50756174, 50756177, 50756175, 50756176][index]!,
        title: "Babysalmesang i Tranderup",
        date,
        time: "10:00",
        contributor: "Linda Skjønnemand",
        locationName: "Tranderup sognehus",
        address: "Tranderupgade",
        postalCode: "5970",
        city: "Ærøskøbing",
      }),
    );
    const toddlerDates = ["2026-09-17", "2026-09-24", "2026-10-01", "2026-10-08"];
    const toddlers = toddlerDates.map(
      (date, index) => programmeItem({
        id: 50756144 + index,
        title: "Tumlingemusik i Tranderup",
        date,
        time: "15:30",
        contributor: "Linda Skjønnemand",
        locationName: "Tranderup kirke",
        address: "Tranderupvej 49",
        postalCode: "5970",
        city: "Ærøskøbing",
      }),
    );
    const bibleDates = [
      "2026-09-24",
      "2026-10-08",
      "2026-10-22",
      "2026-11-05",
      "2026-11-19",
      "2026-12-03",
      "2026-12-17",
      "2026-12-31",
      "2027-01-14",
      "2027-01-28",
      "2027-02-11",
    ];
    const bibleStudies = bibleDates.map((date, index) => programmeItem({
      id: 53896466 + index,
      title: "Bibelstudiekreds i Johannesevangeliet / Marstal Menigehedshus",
      date,
      time: "19:00",
      contributor: "Pia Vandrup",
      locationName: "Marstal Menighedshus",
      address: "Strandstræde 20",
      postalCode: "5960",
      city: "Marstal",
    }));
    const ordinaryServices = ["2026-09-20", "2026-09-27", "2026-10-04"].map(
      (date, index) => programmeItem({
        id: 600 + index,
        title: "Gudstjeneste Marstal",
        date,
        time: "10:00",
        contributor: "Linda Skjønnemand",
        locationName: "Marstal Kirke",
        address: "Kongensgade 35",
        postalCode: "5960",
        city: "Marstal",
      }),
    );
    const result = await churchDeskSource.collect({
      fetch: mappedFetch({
        [churchDeskPageUrl(1)]: churchDeskHtml([
          ...babies,
          ...toddlers,
          ...bibleStudies,
          ...ordinaryServices,
        ]),
      }),
      now: NOW,
    });

    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;
    expect(result.excludedSourceEventIds).toHaveLength(19);
    expect(result.candidates).toHaveLength(6);
    expect(result.candidates.filter(({ title }) => title === "Gudstjeneste Marstal"))
      .toHaveLength(3);

    const expected = [
      {
        sourceEventId: "series-babysalmesang-i-tranderup",
        dates: babyDates,
        rrule: "FREQ=WEEKLY;BYDAY=WE;UNTIL=20261007T100000",
      },
      {
        sourceEventId: "series-tumlingemusik-i-tranderup",
        dates: toddlerDates,
        rrule: "FREQ=WEEKLY;BYDAY=TH;UNTIL=20261008T153000",
      },
      {
        sourceEventId: "series-bibelstudiekreds-marstal",
        dates: bibleDates,
        rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=TH;UNTIL=20270211T190000",
      },
    ];
    for (const item of expected) {
      const candidate = result.candidates.find(
        ({ sourceEventId }) => sourceEventId === item.sourceEventId,
      );
      expect(candidate?.schedule).toMatchObject({
        kind: "recurring",
        rrule: item.rrule,
        rdates: [],
        exdates: [],
        overrides: [],
      });
      if (!candidate) throw new Error(`Mangler den samlede serie ${item.sourceEventId}`);
      const expansion = expandEvent(
        sourceDraftToEvent(candidate),
        DateTime.fromISO("2026-09-01", { zone: "Europe/Copenhagen" }),
        DateTime.fromISO("2027-03-01", { zone: "Europe/Copenhagen" }),
      );
      expect(expansion.warnings).toEqual([]);
      expect(expansion.occurrences.map(({ date }) => date)).toEqual(item.dates);
    }
  });

  it("uses EXDATEs to preserve gaps in an allowlisted source series", async () => {
    const dates = ["2026-09-16", "2026-09-30", "2026-10-07"];
    const result = await churchDeskSource.collect({
      fetch: mappedFetch({
        [churchDeskPageUrl(1)]: churchDeskHtml(dates.map((date, index) => programmeItem({
          id: 700 + index,
          title: "Babysalmesang i Tranderup",
          date,
          time: "10:00",
          contributor: "Linda Skjønnemand",
          locationName: "Tranderup sognehus",
          address: "Tranderupgade",
          postalCode: "5970",
          city: "Ærøskøbing",
        }))),
      }),
      now: NOW,
    });

    const candidate = result.candidates[0];
    expect(candidate?.sourceEventId).toBe("series-babysalmesang-i-tranderup");
    expect(candidate?.schedule).toMatchObject({
      kind: "recurring",
      rrule: "FREQ=WEEKLY;BYDAY=WE;UNTIL=20261007T100000",
      exdates: ["2026-09-23T10:00"],
    });
    if (!candidate) throw new Error("Mangler babysalmesangsserien");
    const expansion = expandEvent(
      sourceDraftToEvent(candidate),
      DateTime.fromISO("2026-09-01", { zone: "Europe/Copenhagen" }),
      DateTime.fromISO("2026-10-31", { zone: "Europe/Copenhagen" }),
    );
    expect(expansion.occurrences.map(({ date }) => date)).toEqual(dates);
  });

  it("retries shifting page boundaries and safely unions identical events", async () => {
    const page1 = await fixture("churchdesk-page-1.html");
    const page2 = await fixture("churchdesk-page-2.html");
    const raw = load(page1)("#__NEXT_DATA__").html();
    if (!raw) throw new Error("Test fixture mangler __NEXT_DATA__");
    const data = JSON.parse(raw) as {
      props: { pageProps: { widget: { items: unknown[]; pageNumber: number } } };
    };
    data.props.pageProps.widget.items = [data.props.pageProps.widget.items[1]];
    data.props.pageProps.widget.pageNumber = 2;
    const overlappingPage2 = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`;
    let page2Requests = 0;

    const result = await churchDeskSource.collect({
      fetch: async (input) => {
        const url = String(input);
        if (url === churchDeskPageUrl(1)) return new Response(page1);
        if (url === churchDeskPageUrl(2)) {
          page2Requests += 1;
          return new Response(page2Requests === 1 ? overlappingPage2 : page2);
        }
        return new Response("not found", { status: 404 });
      },
      now: NOW,
    });

    expect(result.status).toBe("complete");
    expect(result.pagesFetched).toBe(4);
    expect(result.candidates.map(({ sourceEventId }) => sourceEventId).sort()).toEqual([
      "501",
      "502",
      "503",
    ]);
    expect(result.warnings.join(" ")).toContain("overlappende sider");
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
