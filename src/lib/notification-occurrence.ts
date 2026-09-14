import { DateTime } from "luxon";
import { COPENHAGEN_TIMEZONE } from "../components/format";

export interface NotificationOccurrenceStartInput {
  start: string;
  date: string;
  allDay?: boolean | undefined;
}

/** Resolve date-only notification times in the event calendar's Copenhagen timezone. */
export function notificationOccurrenceStartTimestamp(
  occurrence: NotificationOccurrenceStartInput,
): number | undefined {
  const timestamp = occurrence.start.includes("T")
    ? Date.parse(occurrence.start)
    : DateTime.fromISO(
        `${occurrence.date}T${occurrence.allDay ? "09:00" : "12:00"}:00`,
        { zone: COPENHAGEN_TIMEZONE },
      ).toMillis();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}
