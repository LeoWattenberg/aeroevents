export const NOTIFICATION_PREFERENCES_KEY = "aeroevents.notifications.v1";
export const REMINDER_START_GRACE_MS = 5 * 60_000;

export interface EventReminder {
  id: string;
  eventId: string;
  occurrenceId: string;
  title: string;
  body: string;
  url: string;
  startAt: number;
  notifyAt: number;
  leadMinutes: number;
  createdAt: string;
}

export interface CategoryNotificationSubscription {
  id: string;
  name: string;
  url: string;
  knownEventIds: string[];
  subscribedAt: string;
}

export interface NotificationPreferences {
  version: 1;
  reminders: EventReminder[];
  categories: CategoryNotificationSubscription[];
}

export interface NotificationCatalogEvent {
  id: string;
  title: string;
  categoryIds: string[];
  url: string;
  nextStart?: string | undefined;
}

export interface NotificationCatalogOccurrence {
  /** Stable reminder identity, derived from the event and occurrence identities. */
  id: string;
  eventId: string;
  occurrenceId: string;
  title: string;
  body: string;
  url: string;
  startAt: number;
}

export interface NotificationCatalog {
  version: 1;
  generatedAt?: string | undefined;
  events: NotificationCatalogEvent[];
  occurrences: NotificationCatalogOccurrence[];
}

/** Keep preferences for separate deployments on the same origin isolated. */
export function notificationPreferencesKey(scope: string): string {
  let pathname: string;
  try {
    pathname = new URL(scope, "https://aeroevents.invalid/").pathname;
  } catch {
    pathname = "/";
  }
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;
  if (!pathname.endsWith("/")) pathname = `${pathname}/`;
  return `${NOTIFICATION_PREFERENCES_KEY}:${encodeURIComponent(pathname)}`;
}

export interface ReminderOccurrenceInput {
  start: string;
  date: string;
  /** Authoritative calendar timestamp supplied by the statically generated event page. */
  startAt?: number | undefined;
  allDay?: boolean | undefined;
  timeUnknown?: boolean | undefined;
}

const emptyPreferences = (): NotificationPreferences => ({
  version: 1,
  reminders: [],
  categories: [],
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const uniqueStrings = (value: unknown): string[] =>
  Array.isArray(value) ? Array.from(new Set(value.filter(isString))) : [];

function validReminder(value: unknown): EventReminder | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isString(value.id) ||
    !isString(value.eventId) ||
    !isString(value.occurrenceId) ||
    !isString(value.title) ||
    !isString(value.body) ||
    !isString(value.url) ||
    !Number.isFinite(value.startAt) ||
    !Number.isFinite(value.notifyAt) ||
    !Number.isFinite(value.leadMinutes) ||
    Number(value.leadMinutes) < 0 ||
    !isString(value.createdAt)
  ) {
    return undefined;
  }

  return {
    id: value.id,
    eventId: value.eventId,
    occurrenceId: value.occurrenceId,
    title: value.title,
    body: value.body,
    url: value.url,
    startAt: Number(value.startAt),
    notifyAt: Number(value.notifyAt),
    leadMinutes: Number(value.leadMinutes),
    createdAt: value.createdAt,
  };
}

function validCategory(value: unknown): CategoryNotificationSubscription | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isString(value.id) ||
    !isString(value.name) ||
    !isString(value.url) ||
    !isString(value.subscribedAt)
  ) {
    return undefined;
  }

  return {
    id: value.id,
    name: value.name,
    url: value.url,
    knownEventIds: uniqueStrings(value.knownEventIds),
    subscribedAt: value.subscribedAt,
  };
}

function deduplicate<T extends { id: string }>(items: T[]): T[] {
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
}

function validCatalogEvent(value: unknown): NotificationCatalogEvent | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isString(value.id)
    || !isString(value.title)
    || !isString(value.url)
    || !Array.isArray(value.categoryIds)
    || value.categoryIds.some((categoryId) => !isString(categoryId))
    || (value.nextStart !== undefined && !isString(value.nextStart))
  ) {
    return undefined;
  }

  return {
    id: value.id,
    title: value.title,
    categoryIds: uniqueStrings(value.categoryIds),
    url: value.url,
    ...(value.nextStart ? { nextStart: value.nextStart } : {}),
  };
}

function validCatalogOccurrence(value: unknown): NotificationCatalogOccurrence | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isString(value.id)
    || !isString(value.eventId)
    || !isString(value.occurrenceId)
    || value.id !== reminderId(value.eventId, value.occurrenceId)
    || !isString(value.title)
    || !isString(value.body)
    || !isString(value.url)
    || !Number.isFinite(value.startAt)
  ) {
    return undefined;
  }

  return {
    id: value.id,
    eventId: value.eventId,
    occurrenceId: value.occurrenceId,
    title: value.title,
    body: value.body,
    url: value.url,
    startAt: Number(value.startAt),
  };
}

/** Treat a partial or malformed catalog as unavailable instead of deleting valid local state. */
export function parseNotificationCatalog(value: unknown): NotificationCatalog | undefined {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.events) || !Array.isArray(value.occurrences)) {
    return undefined;
  }

  const events = value.events.map(validCatalogEvent);
  const occurrences = value.occurrences.map(validCatalogOccurrence);
  if (events.some((event) => !event) || occurrences.some((occurrence) => !occurrence)) return undefined;

  const occurrenceIds = occurrences.map((occurrence) => occurrence!.id);
  if (new Set(occurrenceIds).size !== occurrenceIds.length) return undefined;

  return {
    version: 1,
    ...(isString(value.generatedAt) ? { generatedAt: value.generatedAt } : {}),
    events: events as NotificationCatalogEvent[],
    occurrences: occurrences as NotificationCatalogOccurrence[],
  };
}

/** Parse device-local preferences defensively so stale or hand-edited storage cannot break the page. */
export function parseNotificationPreferences(raw: string | null | undefined): NotificationPreferences {
  if (!raw) return emptyPreferences();

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1) return emptyPreferences();

    const reminders = Array.isArray(parsed.reminders)
      ? parsed.reminders.flatMap((item) => validReminder(item) ?? [])
      : [];
    const categories = Array.isArray(parsed.categories)
      ? parsed.categories.flatMap((item) => validCategory(item) ?? [])
      : [];

    return {
      version: 1,
      reminders: deduplicate(reminders),
      categories: deduplicate(categories),
    };
  } catch {
    return emptyPreferences();
  }
}

/**
 * Convert an occurrence to a device-local timestamp. Timed occurrences already carry
 * an offset. All-day and unknown-time entries deliberately use a daytime hour so a
 * notification does not arrive at midnight.
 */
export function occurrenceStartTimestamp(occurrence: ReminderOccurrenceInput): number | undefined {
  if (Number.isFinite(occurrence.startAt)) return Number(occurrence.startAt);
  const value = occurrence.start.includes("T")
    ? occurrence.start
    : `${occurrence.date}T${occurrence.allDay ? "09:00" : "12:00"}:00`;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export function reminderNotificationTimestamp(
  occurrence: ReminderOccurrenceInput,
  leadMinutes: number,
): number | undefined {
  const startAt = occurrenceStartTimestamp(occurrence);
  if (startAt === undefined || !Number.isFinite(leadMinutes) || leadMinutes < 0) return undefined;
  return startAt - leadMinutes * 60_000;
}

export function reminderId(eventId: string, occurrenceId: string): string {
  return `${eventId}::${occurrenceId}`;
}

export function reminderExpirationTimestamp(
  reminder: Pick<EventReminder, "startAt" | "leadMinutes">,
): number {
  return reminder.startAt + (reminder.leadMinutes === 0 ? REMINDER_START_GRACE_MS : 0);
}

export function pruneExpiredReminders(
  preferences: NotificationPreferences,
  now = Date.now(),
): NotificationPreferences {
  return {
    ...preferences,
    reminders: preferences.reminders.filter((reminder) => reminderExpirationTimestamp(reminder) > now),
  };
}

/**
 * Reconcile saved reminders with a successfully fetched occurrence catalog.
 * Missing occurrences are cancelled/removed, while moved occurrences retain the
 * user's chosen lead time and get a fresh delivery timestamp.
 */
export function reconcileRemindersWithCatalog(
  preferences: NotificationPreferences,
  occurrences: NotificationCatalogOccurrence[],
  now = Date.now(),
): NotificationPreferences {
  const currentById = new Map(occurrences.map((occurrence) => [occurrence.id, occurrence]));
  const reminders = preferences.reminders.flatMap((reminder) => {
    const current = currentById.get(reminder.id);
    if (
      !current
      || current.eventId !== reminder.eventId
      || current.occurrenceId !== reminder.occurrenceId
    ) {
      return [];
    }

    const reconciled: EventReminder = {
      ...reminder,
      title: current.title,
      body: current.body,
      url: current.url,
      startAt: current.startAt,
      notifyAt: current.startAt - reminder.leadMinutes * 60_000,
    };
    return reminderExpirationTimestamp(reconciled) > now ? [reconciled] : [];
  });

  return { ...preferences, reminders };
}

export function newEventsForCategory(
  subscription: CategoryNotificationSubscription,
  events: NotificationCatalogEvent[],
): NotificationCatalogEvent[] {
  const known = new Set(subscription.knownEventIds);
  return events.filter((event) => event.categoryIds.includes(subscription.id) && !known.has(event.id));
}

export function mergeKnownEventIds(
  subscription: CategoryNotificationSubscription,
  events: NotificationCatalogEvent[],
): CategoryNotificationSubscription {
  const ids = events
    .filter((event) => event.categoryIds.includes(subscription.id))
    .map((event) => event.id);
  return {
    ...subscription,
    knownEventIds: Array.from(new Set([...subscription.knownEventIds, ...ids])),
  };
}
