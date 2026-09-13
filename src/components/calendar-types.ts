export type EventStatus = "scheduled" | "cancelled" | "postponed" | "sold-out";
export type Attendance = "public" | "members" | "registration";

export interface CategoryView {
  id: string;
  name: string;
  description?: string | undefined;
  color?: string | undefined;
}

export interface OrganizerView {
  id: string;
  name: string;
  description?: string | undefined;
  website?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
}

export interface EventLocationView {
  name: string;
  address?: string | undefined;
  postalCode?: string | undefined;
  city?: string | undefined;
  url?: string | undefined;
}

export interface EventSourceView {
  name: string;
  url?: string | undefined;
  verifiedAt?: string | undefined;
}

export interface OccurrenceView {
  /** Stable identifier, including when an occurrence is moved. */
  id: string;
  eventId: string;
  /** Stable local calendar date in Europe/Copenhagen. */
  date: string;
  /** ISO 8601 with an offset for timed events; YYYY-MM-DD for all-day events. */
  start: string;
  end?: string | undefined;
  endDate?: string | undefined;
  allDay?: boolean | undefined;
  /** The date is known, but the source did not publish a time. */
  timeUnknown?: boolean | undefined;
  /** Retained when this occurrence has been moved from its original time. */
  originalStart?: string | undefined;
  status?: EventStatus | undefined;
  location?: EventLocationView | undefined;
}

export interface CalendarEventView {
  id: string;
  title: string;
  description?: string | undefined;
  organizerId: string;
  categoryIds: string[];
  location?: EventLocationView | undefined;
  status?: EventStatus | undefined;
  attendance?: Attendance | undefined;
  attendanceDetails?: string | undefined;
  price?: string | undefined;
  bookingRequired?: boolean | undefined;
  bookingUrl?: string | undefined;
  bookingDetails?: string | undefined;
  source?: EventSourceView | undefined;
  occurrences: OccurrenceView[];
}

export interface CalendarDataset {
  events: CalendarEventView[];
  organizers: OrganizerView[];
  categories: CategoryView[];
  generatedAt?: string | undefined;
  sourceVerifications?: Array<{
    id: string;
    name: string;
    verifiedAt?: string | undefined;
    eventCount?: number | undefined;
  }> | undefined;
}
