import { DateTime } from "luxon";

const COPENHAGEN = "Europe/Copenhagen";
const MONTH_PATTERN =
  "januar|jan|februar|feb|marts|mar|april|apr|maj|juni|jun|juli|jul|august|aug|september|sept|sep|oktober|okt|november|nov|december|dec";
const MONTHS: Record<string, number> = {
  januar: 1,
  jan: 1,
  februar: 2,
  feb: 2,
  marts: 3,
  mar: 3,
  april: 4,
  apr: 4,
  maj: 5,
  juni: 6,
  jun: 6,
  juli: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  oktober: 10,
  okt: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};
const WEEKDAYS: Record<string, number> = {
  mandag: 1,
  tirsdag: 2,
  onsdag: 3,
  torsdag: 4,
  fredag: 5,
  lørdag: 6,
  søndag: 7,
};
const DEADLINE_PREFIX =
  "(?:tilmeldingsfrist(?:en)?|(?:svar|booking|billet)frist(?:en)?|tilmelding\\s+senest|(?:book|booking)\\s+senest|køb\\s+billetter?\\s+senest|(?:sidste\\s+)?frist\\s+for\\s+(?:tilmelding|booking|billetkøb)|(?:tilmeldingen|billetsalget)\\s+(?:slutter|lukker|åbner|starter)|senest|frist)";
const EVENT_WORD_PATTERNS = [
  /^(?:\p{L}+)?koncert(?:en|er|erne|s)?$/u,
  /^(?:\p{L}+)?(?:kursus(?:set|ser|serne|s)?|kurser(?:ne)?)$/u,
  /^(?:\p{L}+)?gudstjeneste(?:n|r|rne|s)?$/u,
  /^(?:\p{L}+)?festival(?:en|er|erne|s)?$/u,
  /^(?:\p{L}+)?workshop(?:pen|per|perne|s)?$/u,
  /^(?:\p{L}+)?træning(?:en|er|erne|s)?$/u,
  /^(?:\p{L}+)?vandring(?:en|er|erne|s)?$/u,
  /^(?:\p{L}+)?teater(?:et|forestillinger|s)?$/u,
  /^(?:\p{L}+)?turnering(?:en|er|erne|s)?$/u,
  /^(?:høst|jule|loppe|kræmmer|mad|kunst|forårs|sommer)marked(?:et|er|erne|s)?$/u,
  /^(?:borger|bestyrelses|forenings|medlems|vælger|informations|orienterings|menighedsråds|kommunalbestyrelses|udvalgs)møde(?:t|r|rne|s)?$/u,
  /^(?:arrangement(?:et|er|erne|s)?|event(?:et|s)?|møde(?:t|r|rne|s)?|generalforsamling(?:en|er|erne|s)?|fællesspisning(?:en|er|erne|s)?|foredrag(?:et|ene|s)?|marked(?:et|er|erne|s)?|yoga|familiedag(?:en|e|ene|s)?|fest(?:en|er|erne|s)?|film(?:en|s)?|dans(?:en|e|s)?|musik(?:ken|s)?|kamp(?:en|e|ene|s)?|reception(?:en|er|erne|s)?|banko|brunch(?:en|s)?|middag(?:en|e|s)?|café(?:en|er|erne|s)?|oplæg(?:get|gene|s)?|debat(?:ten|ter|terne|s)?|julehygge(?:n|s)?|fastelavn(?:en|s)?|løb(?:et|ene|s)?|tur(?:en|e|ene|s)?|åbent)$/u,
];

interface DateGroup {
  index: number;
  end: number;
  dates: string[];
  evidence: string;
  inferredYear: boolean;
  rangeExpanded: boolean;
}

export interface ParsedFacebookPostOccurrence {
  date: string;
  startTime?: string;
  endTime?: string;
  allDay: boolean;
  timeUnknown: boolean;
  evidence: string;
}

export interface FacebookAnnouncementParseResult {
  title?: string;
  locationName?: string;
  price?: string;
  attendance: "members" | "unknown";
  status: "scheduled" | "cancelled";
  soldOut: boolean;
  occurrences: ParsedFacebookPostOccurrence[];
  reasons: string[];
  warnings: string[];
  errors: string[];
  evidence: string[];
}

export interface FacebookAnnouncementParseOptions {
  now: Date;
  publishedAt?: string;
  titleHint?: string;
  preferTitleHint?: boolean;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function hasAffirmedSignal(text: string, pattern: RegExp): boolean {
  const flags = unique([...pattern.flags.replace("g", ""), "g"]).join("");
  for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
    if (match.index === undefined) continue;
    const before = text.slice(Math.max(0, match.index - 32), match.index);
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 16);
    const negatedBefore = /\b(?:ikke|ingen)\b(?:\s+\p{L}+){0,2}\s*$/iu.test(before);
    const negatedAfter = /^\s+(?:alligevel\s+)?ikke\b/iu.test(after);
    const conditionalBefore = /\b(?:ved(?:\s+senere)?|hvis|såfremt|i\s+tilfælde\s+af)\s*$/iu.test(
      before,
    );
    if (!negatedBefore && !negatedAfter && !conditionalBefore) return true;
  }
  return false;
}

function hasEventSignal(text: string): boolean {
  if (/(?:kom til|inviterer til|velkommen til|vi holder|vi arrangerer|sæt kryds i kalenderen)/iu.test(text)) {
    return true;
  }
  const words = text.toLocaleLowerCase("da-DK").match(/\p{L}+/gu) ?? [];
  return words.some((word) => EVENT_WORD_PATTERNS.some((pattern) => pattern.test(word)));
}

export function normalizeFacebookPostText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function yearNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return undefined;
  if (value.length === 2) return 2000 + parsed;
  return parsed;
}

function dateAt(year: number, month: number, day: number): DateTime | undefined {
  const value = DateTime.fromObject({ year, month, day }, { zone: COPENHAGEN });
  return value.isValid ? value.startOf("day") : undefined;
}

function anchorDate(options: FacebookAnnouncementParseOptions): {
  date: DateTime;
  fromPublishedAt: boolean;
} {
  if (options.publishedAt) {
    const parsed = parseFacebookTimestamp(options.publishedAt)?.setZone(COPENHAGEN);
    if (parsed?.isValid) return { date: parsed.startOf("day"), fromPublishedAt: true };
  }
  return {
    date: DateTime.fromJSDate(options.now, { zone: "utc" }).setZone(COPENHAGEN).startOf("day"),
    fromPublishedAt: false,
  };
}

export function parseFacebookTimestamp(value: string): DateTime | undefined {
  const hasExplicitOffset = /(?:z|[+-]\d{2}:?\d{2})$/iu.test(value);
  const parsed = hasExplicitOffset
    ? DateTime.fromISO(value, { setZone: true })
    : DateTime.fromISO(value, { zone: COPENHAGEN });
  return parsed.isValid ? parsed : undefined;
}

function resolveDate(
  day: number,
  month: number,
  explicitYear: number | undefined,
  anchor: DateTime,
): { value?: DateTime; inferredYear: boolean } {
  if (explicitYear !== undefined) {
    const value = dateAt(explicitYear, month, day);
    return { ...(value ? { value } : {}), inferredYear: false };
  }
  let value = dateAt(anchor.year, month, day);
  if (!value) return { inferredYear: true };
  if (value < anchor.minus({ days: 7 })) value = dateAt(anchor.year + 1, month, day);
  if (!value || value > anchor.plus({ months: 12, days: 7 })) return { inferredYear: true };
  return { value, inferredYear: true };
}

function deadlineContext(text: string, index: number): boolean {
  const context = text.slice(Math.max(0, index - 80), index).toLocaleLowerCase("da-DK");
  return new RegExp(`${DEADLINE_PREFIX}(?:\\s+(?:er|den|d\\.))?\\s*[:\\-]?\\s*$`, "iu").test(
    context,
  );
}

function beforeDeadlineDetails(segment: string): string {
  const match = new RegExp(`\\b${DEADLINE_PREFIX}\\b`, "iu").exec(segment);
  return match?.index === undefined ? segment : segment.slice(0, match.index);
}

function replacementDateContext(text: string, index: number): boolean {
  const context = text.slice(Math.max(0, index - 160), index).toLocaleLowerCase("da-DK");
  return (
    /(?:ny\s+dato|(?:flyttet|rykket|udsat)\s+til|afholdes\s+i\s+stedet)(?:\s+(?:er|bliver|den|d\.))?\s*[:\-]?\s*$/iu.test(
      context,
    ) ||
    /(?:flyttet|rykket)\s+fra[\s\S]{0,120}\s+til(?:\s+(?:den|d\.))?\s*$/iu.test(context)
  );
}

function enclosingEventDateContext(text: string, index: number): boolean {
  const context = text.slice(Math.max(0, index - 260), index).toLocaleLowerCase("da-DK");
  return /\bdette arrangement er en del af[\s\S]{0,180}\b(?:som\s+)?(?:finder sted|afholdes|løber)(?:\s+fra)?\s*$/iu.test(
    context,
  );
}

function weekdayBefore(text: string, index: number): number | undefined {
  const context = text.slice(Math.max(0, index - 24), index).toLocaleLowerCase("da-DK");
  const match = context.match(/(mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag)(?:\s+(?:den|d\.))?\s*$/);
  return match?.[1] ? WEEKDAYS[match[1]] : undefined;
}

function overlaps(left: DateGroup, index: number, end: number): boolean {
  return index < left.end && end > left.index;
}

function expandRange(start: DateTime, end: DateTime): string[] | undefined {
  const days = Math.round(end.diff(start, "days").days);
  if (days < 0 || days > 14) return undefined;
  return Array.from({ length: days + 1 }, (_value, index) => start.plus({ days: index }).toISODate()!);
}

function collectDateGroups(
  text: string,
  options: FacebookAnnouncementParseOptions,
): {
  groups: DateGroup[];
  titleDateIndex: number;
  reasons: string[];
  warnings: string[];
  errors: string[];
  replacementSelected: boolean;
} {
  const groups: DateGroup[] = [];
  const reasons: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const anchor = anchorDate(options);

  const add = (
    index: number,
    end: number,
    evidence: string,
    rawDates: Array<{ day: number; month: number; year?: number }>,
    range: boolean,
  ) => {
    if (deadlineContext(text, index)) {
      warnings.push(`Ignorerede fristdato: ${evidence}`);
      return;
    }
    if (groups.length > 0 && enclosingEventDateContext(text, index)) {
      warnings.push(`Ignorerede dato for et overordnet arrangement: ${evidence}`);
      return;
    }
    if (groups.some((group) => overlaps(group, index, end))) return;
    const resolved = rawDates.map((raw) => resolveDate(raw.day, raw.month, raw.year, anchor.date));
    if (resolved.some((item) => !item.value)) {
      warnings.push(`Ignorerede ugyldig eller for fjern dato: ${evidence}`);
      return;
    }
    const expectedWeekday = weekdayBefore(text, index);
    if (expectedWeekday && resolved[0]?.value?.weekday !== expectedWeekday) {
      errors.push(`Ugedag og dato er uenige i “${evidence}”`);
      return;
    }
    let dates = resolved.map((item) => item.value!.toISODate()!);
    if (range && resolved.length === 2) {
      const expanded = expandRange(resolved[0]!.value!, resolved[1]!.value!);
      if (!expanded) {
        errors.push(`Datointervallet er ugyldigt eller længere end 14 dage: ${evidence}`);
        return;
      }
      dates = expanded;
      reasons.push("Et datointerval i opslaget er udvidet til enkelte dagsforekomster");
    }
    const inferredYear = resolved.some((item) => item.inferredYear);
    if (inferredYear) {
      reasons.push(
        anchor.fromPublishedAt
          ? "Årstal er udledt fra opslagets publiceringstidspunkt"
          : "Årstal er udledt fra indsamlingsdatoen",
      );
    }
    groups.push({ index, end, dates, evidence, inferredYear, rangeExpanded: range });
  };

  const isoPattern = /\b(20\d{2})-(\d{2})-(\d{2})\b/g;
  for (const match of text.matchAll(isoPattern)) {
    const index = match.index;
    if (index === undefined || !match[0] || !match[1] || !match[2] || !match[3]) continue;
    add(index, index + match[0].length, match[0], [{ day: Number(match[3]), month: Number(match[2]), year: Number(match[1]) }], false);
  }

  const namedPattern = new RegExp(
    `(?<!\\d)(?:den\\s+|d\\.\\s*)?(\\d{1,2})\\.?\\s*(?:(-|\\u2013|\\u2014|til|og|&)\\s*(\\d{1,2})\\.?\\s*)?(${MONTH_PATTERN})\\.?(?:\\s+(20\\d{2}|\\d{2}))?(?![\\p{L}\\p{N}])`,
    "giu",
  );
  for (const match of text.matchAll(namedPattern)) {
    const index = match.index;
    const raw = match[0];
    const firstDay = Number(match[1]);
    const connector = match[2]?.toLocaleLowerCase("da-DK");
    const secondDay = match[3] ? Number(match[3]) : undefined;
    const month = match[4] ? MONTHS[match[4].toLocaleLowerCase("da-DK")] : undefined;
    const year = yearNumber(match[5]);
    if (index === undefined || !raw || !month) continue;
    const rawDates: Array<{ day: number; month: number; year?: number }> = [
      { day: firstDay, month, ...(year !== undefined ? { year } : {}) },
    ];
    if (secondDay !== undefined) rawDates.push({ day: secondDay, month, ...(year !== undefined ? { year } : {}) });
    add(index, index + raw.length, raw, rawDates, connector === "-" || connector === "–" || connector === "—" || connector === "til");
  }

  const numericPattern = /(?<!\d)(?:\b(?:den\s+|d\.\s*))?(\d{1,2})([./-])(\d{1,2})(?:\2(\d{2}|20\d{2}))?(?=$|[\s,.;:!?])/giu;
  for (const match of text.matchAll(numericPattern)) {
    const index = match.index;
    const raw = match[0];
    if (index === undefined || !raw || !match[1] || !match[3]) continue;
    const day = Number(match[1]);
    const month = Number(match[3]);
    if (month < 1 || month > 12) continue;
    const before = text.slice(Math.max(0, index - 24), index).toLocaleLowerCase("da-DK");
    const after = text.slice(index + raw.length, index + raw.length + 18);
    if (/kl(?:okken)?\.?\s*$/.test(before)) continue;
    if (
      !match[4] &&
      (/^\s*(?:år|årige)\b/iu.test(after) || /\b(?:alder(?:en)?|aldersgruppen)\s*$/iu.test(before))
    ) {
      continue;
    }
    if (!match[4] && match[2] === "." && /(?:kl(?:okken)?\.?[^\n]*|\d{1,2}[.:]\d{2}\s*[-–—]\s*)$/u.test(before)) continue;
    const year = yearNumber(match[4]);
    add(index, index + raw.length, raw, [{ day, month, ...(year !== undefined ? { year } : {}) }], false);
  }

  if (groups.length === 0 && /\b(?:i dag|i morgen|på (?:mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag))\b/i.test(text)) {
    if (!anchor.fromPublishedAt) {
      errors.push("Relative datoer kræver et pålideligt publiceringstidspunkt");
    } else {
      const relativePattern = /\b(i dag|i morgen|på (mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag))\b/giu;
      for (const match of text.matchAll(relativePattern)) {
        const index = match.index;
        if (index === undefined || !match[0]) continue;
        let value = anchor.date;
        if (match[1]?.toLocaleLowerCase("da-DK") === "i morgen") value = value.plus({ days: 1 });
        else if (match[2]) {
          const target = WEEKDAYS[match[2].toLocaleLowerCase("da-DK")];
          if (!target) continue;
          const delta = (target - value.weekday + 7) % 7 || 7;
          value = value.plus({ days: delta });
        }
        groups.push({
          index,
          end: index + match[0].length,
          dates: [value.toISODate()!],
          evidence: match[0],
          inferredYear: true,
          rangeExpanded: false,
        });
        reasons.push("En relativ dato er udledt fra opslagets publiceringstidspunkt");
      }
    }
  }

  groups.sort((left, right) => left.index - right.index);
  const titleDateIndex = groups[0]?.index ?? 0;
  const moved = groups.filter((group) => replacementDateContext(text, group.index));
  if (moved.length > 0) {
    reasons.push("Kun datoen markeret som flyttet eller ny er anvendt");
    return {
      groups: moved,
      titleDateIndex,
      reasons: unique(reasons),
      warnings: unique(warnings),
      errors: unique(errors),
      replacementSelected: true,
    };
  }
  return {
    groups,
    titleDateIndex,
    reasons: unique(reasons),
    warnings: unique(warnings),
    errors: unique(errors),
    replacementSelected: false,
  };
}

function clock(hourText: string | undefined, minuteText: string | undefined): string | undefined {
  if (!hourText) return undefined;
  const hour = Number(hourText);
  const minute = minuteText ? Number(minuteText) : 0;
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function timeFromSegment(segment: string): {
  startTime?: string;
  endTime?: string;
  approximate: boolean;
  doorTime: boolean;
  ambiguous: boolean;
  auxiliary: boolean;
  evidence?: string;
} {
  const preferred = /(?:starter|begynder|start)\s*(?:ca\.?\s*|omkring\s*)?(?:klokken|kl\.?)\s*(\d{1,2})(?:[.:](\d{2}))?/iu.exec(segment);
  const general = /(?:(ca\.?|omkring)\s*)?(?:klokken|kl\.?)\s*(\d{1,2})(?:[.:](\d{2}))?(?:\s*(?:-|\u2013|\u2014|til)\s*(?:klokken|kl\.?)?\s*(\d{1,2})(?:[.:](\d{2}))?)?/iu.exec(segment);
  const bareRange = /\b(\d{1,2})[.:](\d{2})\s*(?:-|\u2013|\u2014|til)\s*(\d{1,2})[.:](\d{2})\b/u.exec(segment);
  const match = preferred ?? general ?? bareRange;
  if (!match) {
    return { approximate: false, doorTime: false, ambiguous: false, auxiliary: false };
  }
  let startTime: string | undefined;
  let endTime: string | undefined;
  let approximate = false;
  if (match === preferred) {
    startTime = clock(match[1], match[2]);
    approximate = /(?:ca\.?|omkring)/iu.test(match[0]);
  } else if (match === general) {
    startTime = clock(match[2], match[3]);
    endTime = clock(match[4], match[5]);
    approximate = Boolean(match[1]);
  } else {
    startTime = clock(match[1], match[2]);
    endTime = clock(match[3], match[4]);
  }
  const allTimes = [...segment.matchAll(/(?:klokken|kl\.?)\s*\d{1,2}(?:[.:]\d{2})?/giu)];
  const beforeMatch = segment.slice(Math.max(0, (match.index ?? 0) - 40), match.index ?? 0);
  return {
    ...(startTime ? { startTime } : {}),
    ...(endTime ? { endTime } : {}),
    approximate,
    doorTime: /dørene?\s+(?:åbner|op)\s*(?:ca\.?\s*)?$/iu.test(beforeMatch),
    ambiguous: match !== preferred && allTimes.length > (endTime ? 2 : 1),
    auxiliary:
      match !== preferred &&
      /(?:entré|billetsalg|tilmelding|indskrivning)\s*(?:fra|starter|begynder|klokken|kl\.?)?\s*$/iu.test(
        beforeMatch,
      ),
    evidence: match[0],
  };
}

function timeImmediatelyBeforeDate(text: string, index: number) {
  const prefix = text.slice(Math.max(0, index - 120), index);
  const parsed = timeFromSegment(prefix);
  if (!parsed.evidence) return parsed;
  const matchIndex = prefix.lastIndexOf(parsed.evidence);
  const tail = prefix.slice(matchIndex + parsed.evidence.length);
  return /^\s*(?:(?:mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag)(?:\s+(?:den|d\.))?)?\s*$/iu.test(
    tail,
  )
    ? parsed
    : { approximate: false, doorTime: false, ambiguous: false, auxiliary: false };
}

function cleanTitleHint(hint?: string): string | undefined {
  if (!hint) return undefined;
  const cleaned = hint.replace(/\s*[|\-]\s*Facebook\s*$/iu, "").trim();
  return cleaned && !/^Facebook$/iu.test(cleaned) ? cleaned : undefined;
}

function titleFromText(
  text: string,
  firstDateIndex: number,
  hint?: string,
  preferHint = false,
): string | undefined {
  const cleanedHint = cleanTitleHint(hint);
  if (preferHint && cleanedHint) return cleanedHint;
  const beforeDate = text.slice(0, firstDateIndex).trim();
  const lines = (beforeDate || text)
    .split("\n")
    .map((line) => line.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N})]+$/gu, "").trim())
    .filter(
      (line) =>
        line.length >= 3 &&
        !/^#/.test(line) &&
        !/^(?:klokken|kl\.?)\s*\d{1,2}(?:[.:]\d{2})?(?:\s+(?:mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag)(?:\s+(?:den|d\.))?)?$/iu.test(
          line,
        ),
    );
  let title = lines[0];
  if (!title) title = cleanedHint;
  if (!title) return undefined;
  title = title.replace(/\s+(?:mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag)(?:\s+(?:den|d\.))?\s*$/iu, "").trim();
  if (!title) return undefined;
  const sentence = title.split(/(?<=[!?])\s+/u)[0] || title;
  if (sentence.length <= 180) return sentence;
  const shortened = sentence.slice(0, 177).replace(/\s+\S*$/u, "").trim();
  return `${shortened || sentence.slice(0, 177)}…`;
}

function labeledValue(text: string, labels: string): string | undefined {
  const pattern = new RegExp(`(?:^|\\n)(?:\\p{Extended_Pictographic}\\s*)?(?:${labels})\\s*[:\\-]\\s*([^\\n]{2,180})`, "imu");
  const value = pattern.exec(text)?.[1]?.trim();
  return value?.replace(/\s+(?:pris|dato|tid|tilmelding)\s*[:\-].*$/iu, "").trim() || undefined;
}

export function parseFacebookAnnouncementText(
  rawText: string,
  options: FacebookAnnouncementParseOptions,
): FacebookAnnouncementParseResult {
  const text = normalizeFacebookPostText(rawText);
  const cancellationSignal = hasAffirmedSignal(
    text,
    /\b(?:aflyst|aflyses|aflyser|aflysning)\b|\b(?:må|skal|er\s+nødt\s+til\s+at)(?:\s+desværre)?\s+aflyse\b/iu,
  );
  const membersOnly = hasAffirmedSignal(
    text,
    /(?:kun for medlemmer|medlemsarrangement|foreningens medlemmer)/iu,
  );
  const soldOut = hasAffirmedSignal(text, /\budsolgt\b/iu);
  const result: FacebookAnnouncementParseResult = {
    attendance: membersOnly ? "members" : "unknown",
    status: cancellationSignal ? "cancelled" : "scheduled",
    soldOut,
    occurrences: [],
    reasons: [],
    warnings: [],
    errors: [],
    evidence: [],
  };
  if (!text) {
    result.errors.push("Facebook-opslaget indeholder ingen tekst");
    return result;
  }
  if (text.length > 20_000) {
    result.errors.push("Facebook-opslagets tekst er for lang til sikker automatisk fortolkning");
    return result;
  }
  const eventSignal = hasEventSignal(text);
  const accommodationPromotion =
    /\b(?:overnatning|juleophold|hotelophold|værelser?)\b/iu.test(text) &&
    /\b(?:book|booking|ophold)\b/iu.test(text) &&
    !/\b(?:vi arrangerer|inviterer til|kom til|arrangementet|eventet|afholdes|finder sted)\b/iu.test(text);
  if (
    !eventSignal ||
    accommodationPromotion ||
    /\b(?:vi holder lukket|lukket på grund af|almindelige åbningstider)\b/iu.test(text)
  ) {
    result.errors.push("Opslaget har ikke et entydigt arrangementssignal");
    return result;
  }

  const dates = collectDateGroups(text, options);
  result.reasons.push(...dates.reasons);
  result.warnings.push(...dates.warnings);
  result.errors.push(...dates.errors);
  if (cancellationSignal && dates.replacementSelected) result.status = "scheduled";
  if (dates.groups.length === 0) {
    if (!result.errors.length) result.errors.push("Opslaget mangler en entydig arrangementsdato");
    return result;
  }

  const datesSpan = text.slice(
    dates.groups[0]!.index,
    dates.groups[dates.groups.length - 1]!.end,
  );
  if (
    dates.groups.length > 1 &&
    (/\benten\b[\s\S]{0,240}\beller\b/iu.test(text) || /\beller\b/iu.test(datesSpan))
  ) {
    result.errors.push("Opslaget angiver alternative datoer og kræver manuel registrering");
    return result;
  }

  const title = titleFromText(
    text,
    dates.titleDateIndex,
    options.titleHint,
    options.preferTitleHint,
  );
  if (!title) {
    result.errors.push("Opslaget mangler en brugbar foreløbig titel");
    return result;
  }
  result.title = title;
  result.reasons.push("Titel og arrangementsfelter er udledt af opslagsteksten");

  const allDay = /\b(?:hele dagen|heldagsarrangement)\b/iu.test(text);
  for (const [groupIndex, group] of dates.groups.entries()) {
    const nextIndex = dates.groups[groupIndex + 1]?.index ?? text.length;
    const segment = beforeDeadlineDetails(
      text
        .slice(group.index, nextIndex)
        .split(/\n\s*(?:pris)\b/iu)[0]!,
    );
    const time = (() => {
      const afterDate = timeFromSegment(segment);
      return afterDate.startTime ? afterDate : timeImmediatelyBeforeDate(text, group.index);
    })();
    if (time.approximate) result.reasons.push("Opslaget angiver et omtrentligt tidspunkt");
    if (time.doorTime) result.reasons.push("Det fundne tidspunkt kan være døråbning");
    if (time.ambiguous) result.reasons.push("Opslaget indeholder flere mulige starttidspunkter");
    if (time.auxiliary) result.reasons.push("Det fundne tidspunkt vedrører muligvis entré eller tilmelding");
    if (time.doorTime || time.ambiguous || time.auxiliary) {
      delete time.startTime;
      delete time.endTime;
    }
    if (time.endTime && time.startTime && time.endTime < time.startTime) {
      result.reasons.push("Et sluttidspunkt før start kan ligge efter midnat og skal kontrolleres");
      delete time.endTime;
    }
    for (const [dateIndex, date] of group.dates.entries()) {
      result.occurrences.push({
        date,
        ...(time.startTime ? { startTime: time.startTime } : {}),
        ...(time.endTime ? { endTime: time.endTime } : {}),
        allDay: allDay && !time.startTime,
        timeUnknown: !allDay && !time.startTime,
        evidence: [group.evidence, time.evidence].filter(Boolean).join(" "),
      });
      if (group.rangeExpanded && dateIndex > 0 && time.startTime) {
        result.reasons.push("Samme klokkeslæt er anvendt på alle dage i intervallet");
      }
    }
  }
  if (result.occurrences.some((item) => item.timeUnknown)) {
    result.reasons.push("Tidspunkt mangler i opslagsteksten og er bevaret som ukendt");
  }
  if (result.occurrences.length > 1) {
    result.reasons.push("Kontrollér at de fundne datoer er forekomster af samme arrangement");
  }

  const locationName = labeledValue(text, "sted|hvor|lokation|mødested|adresse");
  if (locationName) result.locationName = locationName;
  else result.reasons.push("Sted kunne ikke udledes sikkert");
  const price = labeledValue(text, "pris");
  if (price && /\b(?:kr\.?|kroner|gratis)\b/iu.test(price)) result.price = price;
  result.evidence = unique(result.occurrences.map((item) => item.evidence));
  result.reasons = unique(result.reasons);
  result.warnings = unique(result.warnings);
  result.errors = unique(result.errors);
  return result;
}
