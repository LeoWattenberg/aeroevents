import type { APIRoute, GetStaticPaths } from "astro";
import { sitePath } from "../../../components/paths";
import {
  getBuildMetadata,
  getCategories,
  getOccurrences,
  getOrganizers,
  getPublishedEvents,
} from "../../../lib/catalog";
import { calendarResponse, eventCalendarPath, renderICalendar } from "../../../lib/ical";
import type { Category, EventRecord, Occurrence, Organizer } from "../../../lib/schema";

interface EventCalendarProps {
  event: EventRecord;
  occurrences: Occurrence[];
  categories: Category[];
  organizers: Organizer[];
  generatedAt: string;
}

export const getStaticPaths = (async () => {
  const [events, occurrences, categories, organizers, metadata] = await Promise.all([
    getPublishedEvents(),
    getOccurrences(),
    getCategories(),
    getOrganizers(),
    getBuildMetadata(),
  ]);

  const occurrencesByEvent = new Map<string, Occurrence[]>();
  for (const occurrence of occurrences) {
    const eventOccurrences = occurrencesByEvent.get(occurrence.eventId) ?? [];
    eventOccurrences.push(occurrence);
    occurrencesByEvent.set(occurrence.eventId, eventOccurrences);
  }

  return events.flatMap((event) => {
    const eventOccurrences = occurrencesByEvent.get(event.id) ?? [];
    if (eventOccurrences.length === 0) return [];
    return [{
      params: { id: event.id },
      props: {
        event,
        occurrences: eventOccurrences,
        categories,
        organizers,
        generatedAt: metadata.generatedAt,
      } satisfies EventCalendarProps,
    }];
  });
}) satisfies GetStaticPaths;

export const GET: APIRoute<EventCalendarProps> = ({ props, site }) => {
  const baseUrl = site ?? new URL("http://localhost:4321");
  const eventUrl = (event: EventRecord) =>
    new URL(sitePath(`/begivenheder/${encodeURIComponent(event.id)}/`), baseUrl).href;
  const calendarUrl = new URL(sitePath(eventCalendarPath(props.event.id)), baseUrl).href;
  const calendar = renderICalendar({
    name: props.event.title,
    description: `Kalenderfil for ${props.event.title} på Det sker på Ærø.`,
    events: [props.event],
    occurrences: props.occurrences,
    categories: props.categories,
    organizers: props.organizers,
    generatedAt: props.generatedAt,
    eventUrl,
    sourceUrl: calendarUrl,
  });

  return calendarResponse(calendar, `aeroevents-${props.event.id}`);
};
