import type { APIRoute, GetStaticPaths } from "astro";
import { sitePath } from "../../../components/paths";
import {
  getBuildMetadata,
  getCategories,
  getOccurrences,
  getOrganizers,
  getPublishedEvents,
} from "../../../lib/catalog";
import { calendarResponse, categoryCalendarPath, renderICalendar } from "../../../lib/ical";
import type { Category, EventRecord, Occurrence, Organizer } from "../../../lib/schema";

interface CategoryCalendarProps {
  category: Category;
  events: EventRecord[];
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

  return categories.map((category) => {
    const categoryEvents = events.filter((event) => event.categoryIds.includes(category.id));
    const eventIds = new Set(categoryEvents.map((event) => event.id));
    return {
      params: { id: category.id },
      props: {
        category,
        events: categoryEvents,
        occurrences: occurrences.filter((occurrence) => eventIds.has(occurrence.eventId)),
        categories,
        organizers,
        generatedAt: metadata.generatedAt,
      } satisfies CategoryCalendarProps,
    };
  });
}) satisfies GetStaticPaths;

export const GET: APIRoute<CategoryCalendarProps> = ({ props, site }) => {
  const baseUrl = site ?? new URL("http://localhost:4321");
  const eventUrl = (event: EventRecord) =>
    new URL(sitePath(`/begivenheder/${encodeURIComponent(event.id)}/`), baseUrl).href;
  const calendarUrl = new URL(sitePath(categoryCalendarPath(props.category.id)), baseUrl).href;
  const description = props.category.description
    ? `${props.category.description}. Opdateres automatisk af Det sker på Ærø.`
    : `Arrangementer i kategorien ${props.category.name}. Opdateres automatisk af Det sker på Ærø.`;
  const calendar = renderICalendar({
    name: `Det sker på Ærø – ${props.category.name}`,
    description,
    events: props.events,
    occurrences: props.occurrences,
    categories: props.categories,
    organizers: props.organizers,
    generatedAt: props.generatedAt,
    eventUrl,
    sourceUrl: calendarUrl,
  });

  return calendarResponse(calendar, `aeroevents-${props.category.id}`);
};
