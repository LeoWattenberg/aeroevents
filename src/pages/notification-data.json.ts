import type { APIRoute } from "astro";
import { toCalendarDataset } from "../components/catalog-adapter";
import { capitalize, dateLabel, occurrenceTimeLabel } from "../components/format";
import { sitePath } from "../components/paths";
import {
  getBuildMetadata,
  getCategories,
  getOccurrences,
  getOrganizers,
  getPublishedEvents,
  getSources,
} from "../lib/catalog";
import {
  REMINDER_START_GRACE_MS,
  reminderId,
  type NotificationCatalog,
  type NotificationCatalogEvent,
  type NotificationCatalogOccurrence,
} from "../lib/notification-preferences";
import { notificationOccurrenceStartTimestamp } from "../lib/notification-occurrence";

export const prerender = true;

export const GET: APIRoute = async () => {
  const [events, occurrences, organizers, categories, sources, metadata] = await Promise.all([
    getPublishedEvents(),
    getOccurrences(),
    getOrganizers(),
    getCategories(),
    getSources(),
    getBuildMetadata(),
  ]);
  const dataset = toCalendarDataset(events, occurrences, organizers, categories, sources, metadata);
  const generatedAt = dataset.generatedAt ?? new Date().toISOString();
  const generatedAtTimestamp = Date.parse(generatedAt);

  const notificationOccurrences: NotificationCatalogOccurrence[] = dataset.events.flatMap((event) => {
    if (event.status === "cancelled") return [];
    const url = sitePath(`/begivenheder/${encodeURIComponent(event.id)}/`);

    return event.occurrences.flatMap((occurrence) => {
      if (occurrence.status === "cancelled") return [];
      const startAt = notificationOccurrenceStartTimestamp(occurrence);
      if (startAt === undefined || startAt + REMINDER_START_GRACE_MS < generatedAtTimestamp) return [];

      const label = `${capitalize(dateLabel(occurrence.date))} · ${occurrenceTimeLabel(occurrence)}`;
      const location = (occurrence.location ?? event.location)?.name;
      return [{
        id: reminderId(event.id, occurrence.id),
        eventId: event.id,
        occurrenceId: occurrence.id,
        title: event.title,
        body: `${label}${location ? ` · ${location}` : ""}`,
        url,
        startAt,
      }];
    });
  });

  const occurrencesByEvent = new Map<string, NotificationCatalogOccurrence[]>();
  for (const occurrence of notificationOccurrences) {
    const ownOccurrences = occurrencesByEvent.get(occurrence.eventId) ?? [];
    ownOccurrences.push(occurrence);
    occurrencesByEvent.set(occurrence.eventId, ownOccurrences);
  }

  const notificationEvents: NotificationCatalogEvent[] = dataset.events.flatMap((event) => {
    if (event.status === "cancelled") return [];
    const nextOccurrence = occurrencesByEvent.get(event.id)?.[0];
    if (!nextOccurrence) return [];

    return [{
      id: event.id,
      title: event.title,
      categoryIds: event.categoryIds,
      url: sitePath(`/begivenheder/${encodeURIComponent(event.id)}/`),
      nextStart: new Date(nextOccurrence.startAt).toISOString(),
    }];
  });

  const catalog = {
    version: 1,
    generatedAt,
    events: notificationEvents,
    occurrences: notificationOccurrences,
  } satisfies NotificationCatalog;

  return new Response(JSON.stringify(catalog), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300, must-revalidate",
    },
  });
};
