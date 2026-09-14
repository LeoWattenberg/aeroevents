import { load } from "cheerio";
import { DateTime } from "luxon";

import { cleanText, isoDate, validCalendarDate } from "./html";
import { weeklySchedule } from "./fixed-schedule";
import { errorMessage, fetchText } from "./http";
import { SOURCE_REGISTRY } from "./registry";
import type {
  Attendance,
  CollectionContext,
  CollectionResult,
  ExplicitOccurrenceDraft,
  NormalizedEventDraft,
  SourceAdapter,
} from "./types";

const definition = SOURCE_REGISTRY["marstal-marineforening"];
const SOURCE_ORIGIN = new URL(definition.url).origin;
const COPENHAGEN = "Europe/Copenhagen";
const PAGE_ID = "2674142B-D3C9-4DFC-9AAE-E2905B6EF6C8";
const ACTIVITY_COMPONENT_ID = "704225BE-A48B-4449-B8B2-F1F9358D3DFB";
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_PARAGRAPHS = 200;
const MAX_CONTENT_CHARACTERS = 50_000;
const MAX_ACTIVITY_BLOCKS = 40;
const LOCATION = {
  name: "Marstal Marineforenings Hus",
  address: "Strandstræde 47A",
  postalCode: "5960",
  city: "Marstal",
} as const;
const MONTHS = new Map<string, number>([
  ["januar", 1],
  ["februar", 2],
  ["marts", 3],
  ["april", 4],
  ["maj", 5],
  ["juni", 6],
  ["juli", 7],
  ["august", 8],
  ["september", 9],
  ["oktober", 10],
  ["november", 11],
  ["december", 12],
]);
const WEEKDAYS = new Map<string, number>([
  ["mandag", 1],
  ["tirsdag", 2],
  ["onsdag", 3],
  ["torsdag", 4],
  ["fredag", 5],
  ["lørdag", 6],
  ["søndag", 7],
]);

interface Paragraph {
  text: string;
  visiblyBold: boolean;
}

interface ActivityBlock {
  heading: string;
  body: string;
}

export interface MarstalMarineforeningParseResult {
  candidates: NormalizedEventDraft[];
  warnings: string[];
  errors: string[];
  excludedSourceEventIds: string[];
  rawActivityCount: number;
}

function canonicalIsActivityPage(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^www\./u, "");
    return (
      url.protocol === "https:" &&
      hostname === "marstalmarineforening.dk" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname.replace(/\/+$/u, "") === "/aktiviteter" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function isBoundaryHeading(value: string): boolean {
  return /^(?:20\d{2}|Søndagsmøder|Tordenskjolds bakke|Marineforeningens kalender|Tur til Skagen\b|Efterårsfest\b|Julemarked\b|Julefrokost\b|Pudsedag\b|Generalforsamling\b|Klipfiskespisning\b|5\. maj\b|Sendemandsmøde\b|Sommerfest\b)/iu.test(
    value,
  );
}

function blocksFromParagraphs(paragraphs: Paragraph[]): ActivityBlock[] {
  const boundaries = paragraphs
    .map((paragraph, index) => ({ paragraph, index }))
    .filter(({ paragraph }) => isBoundaryHeading(paragraph.text));
  return boundaries.map(({ paragraph, index }, boundaryIndex) => {
    const next = boundaries[boundaryIndex + 1]?.index ?? paragraphs.length;
    return {
      heading: paragraph.text,
      body: paragraphs
        .slice(index + 1, next)
        .map((candidate) => candidate.text)
        .filter(Boolean)
        .join(" "),
    };
  });
}

function matchingBlock(
  blocks: ActivityBlock[],
  pattern: RegExp,
  label: string,
  errors: string[],
  required = false,
): ActivityBlock | undefined {
  const matches = blocks.filter((block) => pattern.test(block.heading));
  if (matches.length > 1)
    errors.push(`Aktivitetssiden indeholder ${label} flere gange`);
  if (required && matches.length === 0)
    errors.push(`Aktivitetssiden mangler ${label}`);
  return matches.length === 1 ? matches[0] : undefined;
}

function normalizedTime(
  hourValue: string,
  minuteValue = "00",
): string | undefined {
  const hour = Number(hourValue);
  const minute = Number(minuteValue);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return undefined;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return undefined;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function datedValue(
  dayValue: string,
  monthValue: string,
  yearValue: string,
  expectedWeekday: string | undefined,
): string | undefined {
  const day = Number(dayValue);
  const month = MONTHS.get(monthValue.toLocaleLowerCase("da-DK"));
  const year = Number(yearValue);
  if (!month || !validCalendarDate(year, month, day)) return undefined;
  const date = isoDate(year, month, day);
  const parsed = DateTime.fromISO(date, { zone: COPENHAGEN });
  if (!parsed.isValid) return undefined;
  if (expectedWeekday) {
    const weekday = WEEKDAYS.get(expectedWeekday.toLocaleLowerCase("da-DK"));
    if (!weekday || parsed.weekday !== weekday) return undefined;
  }
  return date;
}

function occurrenceIsInWindow(
  occurrence: ExplicitOccurrenceDraft,
  today: DateTime,
  rangeEnd: DateTime,
): boolean {
  const start = DateTime.fromISO(occurrence.date, { zone: COPENHAGEN }).startOf(
    "day",
  );
  const end = DateTime.fromISO(occurrence.endDate ?? occurrence.date, {
    zone: COPENHAGEN,
  }).startOf("day");
  return start.isValid && end.isValid && end >= today && start <= rangeEnd;
}

function baseCandidate(
  sourceEventId: string,
  retrievedAt: string,
  values: {
    title: string;
    description: string;
    occurrences?: ExplicitOccurrenceDraft[];
    attendance: Attendance;
    attendanceDetails?: string;
    price?: string;
    bookingRequired?: boolean;
    bookingDetails?: string;
    reviewReasons: string[];
  },
): NormalizedEventDraft {
  return {
    sourceId: definition.id,
    sourceEventId,
    stableId: `${definition.id}-${sourceEventId}`,
    title: values.title,
    description: values.description,
    organizerId: definition.organizerId,
    categoryIds: [...definition.categoryIds],
    location: { ...LOCATION },
    occurrences: values.occurrences ?? [],
    status: "scheduled",
    attendance: values.attendance,
    ...(values.attendanceDetails
      ? { attendanceDetails: values.attendanceDetails }
      : {}),
    ...(values.price ? { price: values.price } : {}),
    ...(values.bookingRequired !== undefined
      ? { bookingRequired: values.bookingRequired }
      : {}),
    ...(values.bookingDetails ? { bookingDetails: values.bookingDetails } : {}),
    publication: "review",
    reviewReasons: values.reviewReasons,
    provenance: {
      sourceId: definition.id,
      externalId: sourceEventId,
      sourceUrl: definition.url,
      retrievedAt,
    },
  };
}

function compactDateTime(date: string, time: string): string {
  return `${date.replaceAll("-", "")}T${time.replace(":", "")}00`;
}

export function parseMarstalMarineforeningPage(
  html: string,
  retrievedAt: string,
  now: Date,
): MarstalMarineforeningParseResult {
  const $ = load(html);
  const warnings: string[] = [];
  const errors: string[] = [];
  const candidates: NormalizedEventDraft[] = [];
  const excluded = new Set<string>();
  const identities = new Set<string>();

  const title = cleanText($("title").first().text());
  if (!/^Aktiviteter\s*\|\s*marstalmarineforening\.dk$/iu.test(title)) {
    errors.push(
      "Siden kan ikke identificeres som Marstal Marineforenings aktivitetsside",
    );
  }
  const canonicals = $("link[rel]").filter((_index, element) =>
    ($(element).attr("rel") ?? "")
      .split(/\s+/u)
      .some((value) => value.toLowerCase() === "canonical"),
  );
  if (
    canonicals.length !== 1 ||
    !canonicalIsActivityPage(canonicals.first().attr("href") ?? "")
  ) {
    errors.push(
      "Aktivitetssidens canonical-link matcher ikke den officielle aktivitetsside",
    );
  }
  if ($(`body[data-wsb-page-id='${PAGE_ID}']`).length !== 1) {
    errors.push("Aktivitetssidens stabile sideidentitet mangler");
  }
  if (
    !/Marstal Marineforening\s+Strandstræde 47\s*A,\s*5960 Marstal/iu.test(
      cleanText($("body").text()),
    )
  ) {
    errors.push(
      "Aktivitetssiden mangler foreningens officielle adresse i Marstal",
    );
  }

  const components = $(
    `[data-id='${ACTIVITY_COMPONENT_ID}'][data-specific-kind='TEXT']`,
  );
  if (
    components.length !== 1 ||
    components.first().attr("data-in-template") !== "false"
  ) {
    errors.push("Aktivitetssidens entydige indholdsblok mangler");
    return {
      candidates: [],
      warnings,
      errors,
      excludedSourceEventIds: [],
      rawActivityCount: 0,
    };
  }
  const root = components.first();
  const paragraphElements = root.find("p").toArray();
  const contentText = cleanText(root.text());
  if (
    paragraphElements.length === 0 ||
    paragraphElements.length > MAX_PARAGRAPHS
  ) {
    errors.push(
      `Aktivitetssidens indholdsblok skal have 1-${MAX_PARAGRAPHS} afsnit`,
    );
  }
  if (!contentText || contentText.length > MAX_CONTENT_CHARACTERS) {
    errors.push(
      `Aktivitetssidens synlige tekst overstiger grænsen på ${MAX_CONTENT_CHARACTERS} tegn`,
    );
  }
  const paragraphs: Paragraph[] = paragraphElements.map((element) => {
    const firstElement = $(element).children().first();
    const tag = firstElement.prop("tagName")?.toLowerCase();
    const style = firstElement.attr("style") ?? "";
    return {
      text: cleanText($(element).text()),
      visiblyBold:
        tag === "strong" ||
        tag === "b" ||
        /font-weight\s*:\s*(?:bold|[6-9]00)/iu.test(style),
    };
  });
  const blocks = blocksFromParagraphs(paragraphs);
  if (blocks.length === 0 || blocks.length > MAX_ACTIVITY_BLOCKS) {
    errors.push(
      `Aktivitetssiden skal have 1-${MAX_ACTIVITY_BLOCKS} genkendelige aktivitetsblokke`,
    );
  }
  const unknownBoldHeadings = paragraphs.filter(
    (paragraph) =>
      paragraph.visiblyBold &&
      Boolean(paragraph.text) &&
      paragraph.text.length <= 200 &&
      !isBoundaryHeading(paragraph.text) &&
      !/^Huset åbner kl\.\s*18\.?$/iu.test(paragraph.text),
  );
  if (unknownBoldHeadings.length > 0) {
    errors.push(
      `Aktivitetssiden indeholder en ukendt fremhævet overskrift: ${unknownBoldHeadings[0]!.text}`,
    );
  }

  const localNow = DateTime.fromJSDate(now, { zone: COPENHAGEN });
  if (!localNow.isValid) {
    errors.push("Indsamlingstidspunktet er ugyldigt");
  }
  const today = localNow.startOf("day");
  const rangeEnd = today.plus({ months: 12 });

  const addExcluded = (sourceEventId: string): void => {
    if (identities.has(sourceEventId)) {
      errors.push(
        `Aktivitetsidentiteten ${sourceEventId} forekommer flere gange`,
      );
      return;
    }
    identities.add(sourceEventId);
    excluded.add(sourceEventId);
  };
  const addCandidate = (candidate: NormalizedEventDraft): void => {
    if (identities.has(candidate.sourceEventId)) {
      errors.push(
        `Aktivitetsidentiteten ${candidate.sourceEventId} forekommer flere gange`,
      );
      return;
    }
    identities.add(candidate.sourceEventId);
    candidates.push(candidate);
  };
  const addDatedCandidate = (candidate: NormalizedEventDraft): void => {
    if (
      candidate.occurrences.some((occurrence) =>
        occurrenceIsInWindow(occurrence, today, rangeEnd),
      )
    ) {
      addCandidate(candidate);
    } else {
      addExcluded(candidate.sourceEventId);
    }
  };

  const sunday = matchingBlock(
    blocks,
    /^Søndagsmøder$/iu,
    "overskriften Søndagsmøder",
    errors,
    true,
  );
  if (sunday) {
    const time = sunday.body.match(
      /Hver søndag\b.*?åbent hus for medlemmerne\b.*?\bfra kl\.?\s*(\d{1,2})[.:](\d{2})\s+til kl\.?\s*(\d{1,2})[.:](\d{2})/isu,
    );
    const last = sunday.body.match(
      /Sidste søndagsåbning i (20\d{2}) er søndag den (\d{1,2})\.\s*([a-zæøå]+)/iu,
    );
    const startTime =
      time?.[1] && time[2] ? normalizedTime(time[1], time[2]) : undefined;
    const endTime =
      time?.[3] && time[4] ? normalizedTime(time[3], time[4]) : undefined;
    const untilDate =
      last?.[2] && last[3] && last[1]
        ? datedValue(last[2], last[3], last[1], "søndag")
        : undefined;
    if (!startTime || !endTime || !untilDate) {
      errors.push(
        "Søndagsmøder mangler en gyldig synlig tidsregel og slutdato",
      );
    } else {
      const [startHour, startMinute] = startTime.split(":").map(Number);
      const [endHour, endMinute] = endTime.split(":").map(Number);
      const durationMinutes =
        endHour! * 60 + endMinute! - (startHour! * 60 + startMinute!);
      let firstSunday = today.plus({ days: (7 - today.weekday) % 7 });
      if (
        firstSunday.equals(today) &&
        localNow.hour * 60 + localNow.minute >= endHour! * 60 + endMinute!
      ) {
        firstSunday = firstSunday.plus({ weeks: 1 });
      }
      if (durationMinutes <= 0) {
        errors.push("Søndagsmøder har et ugyldigt tidsinterval");
      } else if (
        firstSunday > DateTime.fromISO(untilDate, { zone: COPENHAGEN })
      ) {
        addExcluded(`sunday-open-house-${last![1]}`);
        warnings.push("Den oplyste sæson for søndagsmøder er udløbet");
      } else {
        const sourceEventId = `sunday-open-house-${last![1]}`;
        addCandidate({
          ...baseCandidate(sourceEventId, retrievedAt, {
            title: "Søndagsåbent i Marstal Marineforening",
            description:
              "Åbent hus for medlemmer med hyggesnak. Den første søndag i måneden serveres der normalt lidt mad; første søndag i juli er uden spisning.",
            attendance: "members",
            attendanceDetails:
              "Kilden angiver åbent hus for foreningens medlemmer.",
            reviewReasons: [
              "Serien har ingen eksplicit startdato; DTSTART er derfor et stabilt teknisk anker.",
            ],
          }),
          schedule: {
            kind: "recurring",
            dtstart: {
              kind: "timed",
              date: "2000-01-02",
              startTime,
            },
            startDateUnknown: true,
            rrule: `FREQ=WEEKLY;BYDAY=SU;UNTIL=${compactDateTime(untilDate, startTime)}`,
            rdates: [],
            exdates: [],
            overrides: [],
            durationMinutes,
          },
        });
      }
    }
  }

  const tordenskjold = matchingBlock(
    blocks,
    /^Tordenskjolds bakke$/iu,
    "overskriften Tordenskjolds bakke",
    errors,
    true,
  );
  if (tordenskjold) {
    const rule = tordenskjold.body.match(
      /Hver mandag formiddag er der nogen i huset fra\s+(\d{1,2})[.:](\d{2})\s*[-–—]\s*(\d{1,2})[.:](\d{2})/iu,
    );
    const startTime =
      rule?.[1] && rule[2] ? normalizedTime(rule[1], rule[2]) : undefined;
    const endTime =
      rule?.[3] && rule[4] ? normalizedTime(rule[3], rule[4]) : undefined;
    if (startTime && endTime) {
      const sourceEventId = "tordenskjolds-bakke";
      addCandidate({
        ...baseCandidate(sourceEventId, retrievedAt, {
          title: "Tordenskjolds bakke",
          description:
            "En gruppe medlemmer mødes om de praktiske gøremål, så foreningens hus fungerer til hverdag og fest.",
          attendance: "members",
          attendanceDetails:
            "Aktiviteten beskrives som en gruppe af foreningens medlemmer.",
          reviewReasons: [
            "Kilden angiver ingen start- eller slutdato for den ugentlige serie.",
          ],
        }),
        schedule: weeklySchedule(1, startTime, endTime),
      });
    } else {
      addExcluded("tordenskjolds-bakke");
      warnings.push(
        "Tordenskjolds bakke blev udeladt, fordi den synlige aktivitetsblok ikke angiver en præcis ugedag og tid",
      );
    }
  }

  matchingBlock(
    blocks,
    /^Marineforeningens kalender$/iu,
    "overskriften Marineforeningens kalender",
    errors,
    true,
  );
  if (!blocks.some((block) => /^20\d{2}$/u.test(block.heading))) {
    errors.push("Aktivitetssiden mangler kalenderens årsoverskrifter");
  }

  const skagen = matchingBlock(
    blocks,
    /^Tur til Skagen\b/iu,
    "turen til Skagen",
    errors,
  );
  if (skagen) {
    const match = skagen.heading.match(
      /^Tur til Skagen\s+(\d{1,2})\.-(\d{1,2})\.\s+([a-zæøå]+)\s+(20\d{2})$/iu,
    );
    if (
      !match?.[1] ||
      !match[2] ||
      !match[3] ||
      !match[4] ||
      !datedValue(match[1], match[3], match[4], undefined) ||
      !datedValue(match[2], match[3], match[4], undefined)
    ) {
      errors.push("Turen til Skagen har et ugyldigt datointerval");
    } else {
      addExcluded(`tur-til-skagen-${match[4]}`);
      warnings.push(
        "Turen til Skagen blev udeladt, fordi arrangementet foregår uden for Ærø",
      );
    }
  }

  const afteraarsfest = matchingBlock(
    blocks,
    /^Efterårsfest\b/iu,
    "Efterårsfest",
    errors,
  );
  if (afteraarsfest) {
    const match = afteraarsfest.heading.match(
      /^Efterårsfest\s+(fredag) den (\d{1,2})\.\s+([a-zæøå]+)\s+(20\d{2})\s+kl\.\s*(\d{1,2})[.:](\d{2})$/iu,
    );
    const date =
      match?.[2] && match[3] && match[4]
        ? datedValue(match[2], match[3], match[4], match[1])
        : undefined;
    const startTime =
      match?.[5] && match[6] ? normalizedTime(match[5], match[6]) : undefined;
    if (!date || !startTime || !match?.[4]) {
      errors.push("Efterårsfest har en ugyldig dato eller starttid");
    } else {
      const sourceEventId = `afteraarsfest-${match[4]}`;
      const members =
        /Som medlem eller støttemedlem kan du tilmelde dig selv og en ledsager/iu.test(
          afteraarsfest.body,
        );
      const price = afteraarsfest.body.match(
        /(?:Prisen[^.]*?)kr\.\s*(\d{1,5})\s*,-?\s*pr\. person/iu,
      )?.[1];
      addDatedCandidate(
        baseCandidate(sourceEventId, retrievedAt, {
          title: "Efterårsfest",
          description:
            "Efterårsfest med middag i foreningens hus. Huset åbner kl. 18.00.",
          occurrences: [
            {
              id: `marineforening-${sourceEventId}`,
              date,
              startTime,
              allDay: false,
              timeUnknown: false,
            },
          ],
          attendance: members ? "members" : "unknown",
          ...(members
            ? {
                attendanceDetails:
                  "Et medlem eller støttemedlem kan tilmelde sig selv og én ledsager.",
              }
            : {}),
          ...(price ? { price: `${price} kr. pr. person` } : {}),
          bookingRequired: /tilmeld/iu.test(afteraarsfest.body),
          bookingDetails:
            "Tilmelding sker på listen i foreningens hus; se kildesiden for vilkår.",
          reviewReasons: [
            "Kilden angiver ikke sluttid; adgang og tilmelding skal kontrolleres.",
          ],
        }),
      );
    }
  }

  const julemarked = matchingBlock(
    blocks,
    /^Julemarked\b/iu,
    "Julemarked",
    errors,
  );
  if (julemarked) {
    const dateMatch = julemarked.heading.match(
      /^Julemarked\s+(lørdag) den (\d{1,2})\.\s+([a-zæøå]+)\s+(20\d{2})$/iu,
    );
    const clock = julemarked.body.match(
      /\bkl\.\s*(\d{1,2})(?:[.:](\d{2}))?\s*[-–—]\s*(\d{1,2})(?:[.:](\d{2}))?\b/iu,
    );
    const date =
      dateMatch?.[2] && dateMatch[3] && dateMatch[4]
        ? datedValue(dateMatch[2], dateMatch[3], dateMatch[4], dateMatch[1])
        : undefined;
    const startTime = clock?.[1]
      ? normalizedTime(clock[1], clock[2] ?? "00")
      : undefined;
    const endTime = clock?.[3]
      ? normalizedTime(clock[3], clock[4] ?? "00")
      : undefined;
    if (!date || !startTime || !endTime || !dateMatch?.[4]) {
      errors.push(
        "Julemarked har en ugyldig dato eller et ugyldigt tidsinterval",
      );
    } else {
      const sourceEventId = `julemarked-${dateMatch[4]}`;
      addDatedCandidate(
        baseCandidate(sourceEventId, retrievedAt, {
          title: "Julemarked",
          description:
            "Julemarked i foreningens lokaler. Oplysninger om leje af stand følger på kildesiden.",
          occurrences: [
            {
              id: `marineforening-${sourceEventId}`,
              date,
              startTime,
              endTime,
              allDay: false,
              timeUnknown: false,
            },
          ],
          attendance: "unknown",
          reviewReasons: [
            "Kilden oplyser ikke, om julemarkedet har offentlig adgang.",
          ],
        }),
      );
    }
  }

  const julefrokost = matchingBlock(
    blocks,
    /^Julefrokost\b/iu,
    "Julefrokost",
    errors,
  );
  if (julefrokost) {
    const dateMatch = julefrokost.heading.match(
      /^Julefrokost\s+(lørdag) den (\d{1,2})\.\s+([a-zæøå]+)\s+(20\d{2})$/iu,
    );
    const clock = julefrokost.body.match(/\bkl\.\s*(\d{1,2})[.:](\d{2})\b/iu);
    const date =
      dateMatch?.[2] && dateMatch[3] && dateMatch[4]
        ? datedValue(dateMatch[2], dateMatch[3], dateMatch[4], dateMatch[1])
        : undefined;
    const startTime =
      clock?.[1] && clock[2] ? normalizedTime(clock[1], clock[2]) : undefined;
    if (!date || !startTime || !dateMatch?.[4]) {
      errors.push("Julefrokost har en ugyldig dato eller starttid");
    } else {
      const sourceEventId = `julefrokost-${dateMatch[4]}`;
      addDatedCandidate(
        baseCandidate(sourceEventId, retrievedAt, {
          title: "Julefrokost",
          description:
            "Foreningens julefrokost. Oplysninger om tilmelding følger på kildesiden.",
          occurrences: [
            {
              id: `marineforening-${sourceEventId}`,
              date,
              startTime,
              allDay: false,
              timeUnknown: false,
            },
          ],
          attendance: "unknown",
          reviewReasons: [
            "Kilden angiver endnu ikke tilmeldingsvilkår, adgang eller sluttid.",
          ],
        }),
      );
    }
  }

  for (const pending of [
    { pattern: /^Pudsedag\b/iu, slug: "pudsedag" },
    { pattern: /^Generalforsamling\b/iu, slug: "generalforsamling" },
    { pattern: /^Klipfiskespisning\b/iu, slug: "klipfiskespisning" },
    { pattern: /^Sommerfest\b/iu, slug: "sommerfest" },
  ]) {
    const block = matchingBlock(blocks, pending.pattern, pending.slug, errors);
    if (!block) continue;
    const year = block.body.match(/\b(20\d{2})\b/u)?.[1];
    if (!year || !/dato følger/iu.test(block.body)) {
      errors.push(
        `${block.heading} mangler enten en eksplicit dato eller markeringen 'dato følger'`,
      );
      continue;
    }
    addExcluded(`${pending.slug}-${year}`);
  }

  const liberation = matchingBlock(
    blocks,
    /^5\. maj\b/iu,
    "Danmarks Befrielse",
    errors,
  );
  if (liberation) {
    const dateMatch = liberation.heading.match(
      /^(\d{1,2})\.\s+([a-zæøå]+)\s+(20\d{2})\s+Danmarks Befrielse$/iu,
    );
    const clock = liberation.body.match(/\bKl\.\s*(\d{1,2})[.:](\d{2})\b/u);
    const date =
      dateMatch?.[1] && dateMatch[2] && dateMatch[3]
        ? datedValue(dateMatch[1], dateMatch[2], dateMatch[3], undefined)
        : undefined;
    const startTime =
      clock?.[1] && clock[2] ? normalizedTime(clock[1], clock[2]) : undefined;
    if (!date || !startTime || !dateMatch?.[3]) {
      errors.push("Danmarks Befrielse har en ugyldig dato eller starttid");
    } else {
      const sourceEventId = `danmarks-befrielse-${dateMatch[3]}`;
      addDatedCandidate(
        baseCandidate(sourceEventId, retrievedAt, {
          title: "Danmarks Befrielse",
          description:
            "Fælles march fra Marineforeningens Hus til krigsmindesmærkerne, efterfulgt af kaffe og rundstykker i huset.",
          occurrences: [
            {
              id: `marineforening-${sourceEventId}`,
              date,
              startTime,
              allDay: false,
              timeUnknown: false,
            },
          ],
          attendance: "unknown",
          reviewReasons: ["Kilden angiver ikke adgangsvilkår eller sluttid."],
        }),
      );
    }
  }

  const delegates = matchingBlock(
    blocks,
    /^Sendemandsmøde\b/iu,
    "Sendemandsmøde",
    errors,
  );
  if (delegates) {
    const match = delegates.heading.match(
      /^Sendemandsmøde\s+(\d{1,2})\.-(\d{1,2})\.\s+([a-zæøå]+)\s+(20\d{2})$/iu,
    );
    const firstDate =
      match?.[1] && match[3] && match[4]
        ? datedValue(match[1], match[3], match[4], undefined)
        : undefined;
    const lastDate =
      match?.[2] && match[3] && match[4]
        ? datedValue(match[2], match[3], match[4], undefined)
        : undefined;
    if (!firstDate || !lastDate || !match?.[4]) {
      errors.push("Sendemandsmøde har et ugyldigt datointerval");
    } else {
      const first = DateTime.fromISO(firstDate, { zone: COPENHAGEN });
      const last = DateTime.fromISO(lastDate, { zone: COPENHAGEN });
      const dayCount = Math.round(last.diff(first, "days").days) + 1;
      if (dayCount < 1 || dayCount > 7) {
        errors.push(
          "Sendemandsmøde har et for langt eller omvendt datointerval",
        );
      } else {
        const sourceEventId = `sendemandsmoede-${match[4]}`;
        const occurrences = Array.from(
          { length: dayCount },
          (_value, index) => ({
            id: `marineforening-${sourceEventId}-day-${index + 1}`,
            date: first.plus({ days: index }).toISODate()!,
            allDay: false,
            timeUnknown: true,
          }),
        );
        addDatedCandidate(
          baseCandidate(sourceEventId, retrievedAt, {
            title: "Sendemandsmøde",
            description:
              "Marstal Marineforening er vært for sendemandsmødet i Skipperbyen.",
            occurrences,
            attendance: "unknown",
            reviewReasons: [
              "Kilden angiver et datointerval, men ikke tider eller adgangsvilkår.",
            ],
          }),
        );
      }
    }
  }

  if (candidates.length === 0 && errors.length === 0) {
    errors.push(
      "Aktivitetssiden indeholder ingen aktuelle arrangementer i indsamlingsvinduet",
    );
  }
  return {
    candidates,
    warnings: [...new Set(warnings)],
    errors: [...new Set(errors)],
    excludedSourceEventIds: [...excluded].sort(),
    rawActivityCount: blocks.length,
  };
}

async function collect(context: CollectionContext): Promise<CollectionResult> {
  const retrievedAt = context.now.toISOString();
  try {
    const html = await fetchText(context, definition.url, {
      expectedOrigin: SOURCE_ORIGIN,
      maxBytes: MAX_RESPONSE_BYTES,
    });
    const parsed = parseMarstalMarineforeningPage(
      html,
      retrievedAt,
      context.now,
    );
    if (parsed.errors.length > 0) {
      return {
        status: "partial",
        source: definition,
        retrievedAt,
        pagesFetched: 1,
        candidates: [],
        errors: parsed.errors,
        warnings: parsed.warnings,
        discardedCandidateCount: parsed.candidates.length,
      };
    }
    return {
      status: "complete",
      source: definition,
      retrievedAt,
      pagesFetched: 1,
      candidates: parsed.candidates,
      snapshotCoverage: "authoritative",
      excludedSourceEventIds: parsed.excludedSourceEventIds,
      errors: [],
      warnings: parsed.warnings,
    };
  } catch (error) {
    return {
      status: "failed",
      source: definition,
      retrievedAt,
      pagesFetched: 0,
      candidates: [],
      errors: [errorMessage(error)],
      warnings: [],
    };
  }
}

export const marstalMarineforeningSource: SourceAdapter = {
  definition,
  collect,
};
