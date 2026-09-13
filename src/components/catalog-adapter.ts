import type {
  Attendance,
  CalendarDataset,
  CalendarEventView,
  CategoryView,
  EventLocationView,
  EventSourceView,
  EventStatus,
  OccurrenceView,
  OrganizerView,
} from "./calendar-types";

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap((item) => (stringValue(item) ? [String(item)] : [])) : [];

function locationView(value: unknown): EventLocationView | undefined {
  if (typeof value === "string" && value.trim()) return { name: value.trim() };
  if (!isRecord(value)) return undefined;
  const name = stringValue(value.name) ?? stringValue(value.venue);
  if (!name) return undefined;
  return {
    name,
    address: stringValue(value.address) ?? stringValue(value.street),
    postalCode: stringValue(value.postalCode),
    city: stringValue(value.city),
    url: stringValue(value.url),
  };
}

function sourceView(value: unknown): EventSourceView | undefined {
  if (!isRecord(value)) return undefined;
  const name = stringValue(value.name) ?? stringValue(value.label) ?? stringValue(value.sourceId);
  if (!name) return undefined;
  return {
    name,
    url: stringValue(value.url),
    verifiedAt: stringValue(value.verifiedAt) ?? stringValue(value.lastVerifiedAt),
  };
}

function bookingUrl(value: unknown): string | undefined {
  if (typeof value === "string") return stringValue(value);
  return isRecord(value) ? stringValue(value.url) : undefined;
}

function validStatus(value: unknown): EventStatus {
  const status = stringValue(value);
  if (status === "cancelled" || status === "postponed" || status === "sold-out") return status;
  return "scheduled";
}

function validAttendance(value: unknown): Attendance {
  const attendance = isRecord(value) ? stringValue(value.kind) : stringValue(value);
  if (attendance === "members" || attendance === "registration") return attendance;
  return "public";
}

function categoryView(value: unknown): CategoryView | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringValue(value.id);
  const name = stringValue(value.name) ?? stringValue(value.label);
  return id && name
    ? { id, name, description: stringValue(value.description), color: stringValue(value.color) }
    : undefined;
}

function organizerView(value: unknown): OrganizerView | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringValue(value.id);
  const name = stringValue(value.name);
  return id && name
    ? {
        id,
        name,
        description: stringValue(value.description),
        website: stringValue(value.website) ?? stringValue(value.url),
        email: stringValue(value.email),
        phone: stringValue(value.phone),
      }
    : undefined;
}

function occurrenceView(value: unknown): OccurrenceView | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringValue(value.id) ?? stringValue(value.recurrenceId);
  const eventId = stringValue(value.eventId);
  const date = stringValue(value.date) ?? stringValue(value.startAt)?.slice(0, 10);
  if (!id || !eventId || !date) return undefined;
  const startAt = stringValue(value.startAt);
  return {
    id,
    eventId,
    date,
    start: startAt ?? date,
    end: stringValue(value.endAt),
    endDate: stringValue(value.endDate),
    allDay: value.allDay === true,
    timeUnknown: value.timeUnknown === true,
    originalStart: stringValue(value.originalStartAt) ?? stringValue(value.originalStart),
    status: validStatus(value.status),
    location: locationView(value.location),
  };
}

export function toCalendarDataset(
  eventsInput: unknown,
  occurrencesInput: unknown,
  organizersInput: unknown,
  categoriesInput: unknown,
  sourcesInput?: unknown,
  metadataInput?: unknown,
): CalendarDataset {
  const occurrences = Array.isArray(occurrencesInput)
    ? occurrencesInput.flatMap((item) => {
        const occurrence = occurrenceView(item);
        return occurrence ? [occurrence] : [];
      })
    : [];

  const byEvent = new Map<string, OccurrenceView[]>();
  for (const occurrence of occurrences) {
    const list = byEvent.get(occurrence.eventId) ?? [];
    list.push(occurrence);
    byEvent.set(occurrence.eventId, list);
  }

  const events: CalendarEventView[] = Array.isArray(eventsInput)
    ? eventsInput.flatMap((value) => {
        if (!isRecord(value)) return [];
        const id = stringValue(value.id);
        const title = stringValue(value.title);
        const organizerId = stringValue(value.organizerId);
        if (!id || !title || !organizerId) return [];
        const ownOccurrences = byEvent.get(id) ?? [];
        ownOccurrences.sort((a, b) => a.start.localeCompare(b.start));
        const booking = isRecord(value.booking) ? value.booking : undefined;
        const attendance = isRecord(value.attendance) ? value.attendance : undefined;
        const sourceReference = isRecord(value.source) ? value.source : undefined;
        const sourceDefinitions = Array.isArray(sourcesInput) ? sourcesInput.filter(isRecord) : [];
        const sourceDefinition = sourceDefinitions.find(
          (source) => stringValue(source.id) === stringValue(sourceReference?.sourceId),
        );
        const source = sourceView({
          ...sourceDefinition,
          ...sourceReference,
          name: stringValue(sourceDefinition?.name) ?? stringValue(sourceReference?.sourceId),
        });
        return [
          {
            id,
            title,
            description: stringValue(value.description),
            organizerId,
            categoryIds: stringArray(value.categoryIds),
            location: locationView(value.location),
            status: booking?.soldOut === true ? "sold-out" : validStatus(value.status),
            attendance: validAttendance(value.attendance),
            attendanceDetails: stringValue(attendance?.details),
            price: stringValue(value.price),
            bookingRequired: booking?.required === true,
            bookingUrl: bookingUrl(value.booking) ?? stringValue(value.bookingUrl),
            bookingDetails: stringValue(booking?.details),
            source,
            occurrences: ownOccurrences,
          },
        ];
      })
    : [];

  const organizers = Array.isArray(organizersInput)
    ? organizersInput.flatMap((item) => {
        const organizer = organizerView(item);
        return organizer ? [organizer] : [];
      })
    : [];
  const categories = Array.isArray(categoriesInput)
    ? categoriesInput.flatMap((item) => {
        const category = categoryView(item);
        return category ? [category] : [];
      })
    : [];

  const metadata = isRecord(metadataInput) ? metadataInput : undefined;
  const metadataSources = Array.isArray(metadata?.sources) ? metadata.sources.filter(isRecord) : [];
  const sourceDefinitions = Array.isArray(sourcesInput) ? sourcesInput.filter(isRecord) : [];
  const sourceVerifications = sourceDefinitions.flatMap((source) => {
    const id = stringValue(source.id);
    const name = stringValue(source.name);
    if (!id || !name) return [];
    const verification = metadataSources.find((item) => stringValue(item.sourceId) === id);
    return [{
      id,
      name,
      verifiedAt: stringValue(verification?.verifiedAt),
      eventCount: typeof verification?.eventCount === "number" ? verification.eventCount : undefined,
    }];
  });

  return {
    events,
    organizers,
    categories,
    generatedAt: stringValue(metadata?.generatedAt),
    sourceVerifications,
  };
}
