import { describe, expect, it } from "vitest";
import { notificationOccurrenceStartTimestamp } from "../src/lib/notification-occurrence";
import {
  mergeKnownEventIds,
  newEventsForCategory,
  notificationPreferencesKey,
  occurrenceStartTimestamp,
  parseNotificationCatalog,
  parseNotificationPreferences,
  pruneExpiredReminders,
  reconcileRemindersWithCatalog,
  REMINDER_START_GRACE_MS,
  reminderNotificationTimestamp,
  type CategoryNotificationSubscription,
  type EventReminder,
  type NotificationCatalogEvent,
  type NotificationCatalogOccurrence,
} from "../src/lib/notification-preferences";

describe("notification preferences", () => {
  it("namespaces browser storage by normalized service-worker scope", () => {
    expect(notificationPreferencesKey("/")).toBe("aeroevents.notifications.v1:%2F");
    expect(notificationPreferencesKey("/aeroevents")).toBe("aeroevents.notifications.v1:%2Faeroevents%2F");
    expect(notificationPreferencesKey("https://example.test/aeroevents/?preview=1")).toBe(
      "aeroevents.notifications.v1:%2Faeroevents%2F",
    );
    expect(notificationPreferencesKey("/preview/")).not.toBe(notificationPreferencesKey("/aeroevents/"));
  });

  it("falls back safely for corrupt storage and filters invalid entries", () => {
    expect(parseNotificationPreferences("not json")).toEqual({ version: 1, reminders: [], categories: [] });

    const parsed = parseNotificationPreferences(JSON.stringify({
      version: 1,
      reminders: [{ nope: true }],
      categories: [
        {
          id: "musik-kultur",
          name: "Musik og kultur",
          url: "/?kategori=musik-kultur",
          knownEventIds: ["one", "one", 42],
          subscribedAt: "2026-09-14T10:00:00.000Z",
        },
      ],
    }));

    expect(parsed.reminders).toEqual([]);
    expect(parsed.categories[0]?.knownEventIds).toEqual(["one"]);
  });

  it("rejects partial catalogs so they cannot erase saved reminders", () => {
    const occurrence: NotificationCatalogOccurrence = {
      id: "event::occurrence",
      eventId: "event",
      occurrenceId: "occurrence",
      title: "Current title",
      body: "Current time and place",
      url: "/begivenheder/event/",
      startAt: 200_000,
    };
    const valid = {
      version: 1,
      generatedAt: "2026-09-14T10:00:00.000Z",
      events: [{ id: "event", title: "Current title", categoryIds: ["andet"], url: "/event/" }],
      occurrences: [occurrence],
    };

    expect(parseNotificationCatalog(valid)?.occurrences).toEqual([occurrence]);
    expect(parseNotificationCatalog({ ...valid, occurrences: undefined })).toBeUndefined();
    expect(parseNotificationCatalog({
      ...valid,
      occurrences: [{ ...occurrence, id: "wrong-identity" }],
    })).toBeUndefined();
  });

  it("uses offset timestamps for timed events and daytime for date-only events", () => {
    const timed = { date: "2026-09-22", start: "2026-09-22T18:00:00+02:00" };
    expect(occurrenceStartTimestamp(timed)).toBe(Date.parse(timed.start));
    expect(reminderNotificationTimestamp(timed, 60)).toBe(Date.parse(timed.start) - 60 * 60_000);

    const allDay = { date: "2026-09-22", start: "2026-09-22", allDay: true };
    expect(occurrenceStartTimestamp(allDay)).toBe(Date.parse("2026-09-22T09:00:00"));

    const authoritative = { ...allDay, startAt: 123_456 };
    expect(occurrenceStartTimestamp(authoritative)).toBe(123_456);
  });

  it("generates date-only catalog timestamps in Europe/Copenhagen", () => {
    expect(notificationOccurrenceStartTimestamp({
      date: "2026-09-22",
      start: "2026-09-22",
      allDay: true,
    })).toBe(Date.parse("2026-09-22T07:00:00Z"));
    expect(notificationOccurrenceStartTimestamp({
      date: "2026-09-22",
      start: "2026-09-22",
      allDay: false,
    })).toBe(Date.parse("2026-09-22T10:00:00Z"));
  });

  it("prunes reminders only after their occurrence starts", () => {
    const base = {
      id: "event::occurrence",
      eventId: "event",
      occurrenceId: "occurrence",
      title: "Event",
      body: "Tomorrow",
      url: "/event/",
      startAt: 2_000,
      notifyAt: 1_000,
      leadMinutes: 60,
      createdAt: "2026-09-14T10:00:00.000Z",
    };
    const preferences = { version: 1 as const, reminders: [base], categories: [] };

    expect(pruneExpiredReminders(preferences, 1_500).reminders).toHaveLength(1);
    expect(pruneExpiredReminders(preferences, 2_000).reminders).toHaveLength(0);
  });

  it("keeps an exact-start reminder for a short delivery grace period", () => {
    const reminder = {
      id: "event::occurrence",
      eventId: "event",
      occurrenceId: "occurrence",
      title: "Event",
      body: "Now",
      url: "/event/",
      startAt: 2_000,
      notifyAt: 2_000,
      leadMinutes: 0,
      createdAt: "2026-09-14T10:00:00.000Z",
    };
    const preferences = { version: 1 as const, reminders: [reminder], categories: [] };

    expect(pruneExpiredReminders(preferences, 2_000).reminders).toHaveLength(1);
    expect(pruneExpiredReminders(preferences, 2_000 + REMINDER_START_GRACE_MS - 1).reminders).toHaveLength(1);
    expect(pruneExpiredReminders(preferences, 2_000 + REMINDER_START_GRACE_MS).reminders).toHaveLength(0);
  });

  it("updates a moved reminder from the catalog and removes a missing occurrence", () => {
    const reminder = (overrides: Partial<EventReminder> = {}): EventReminder => ({
      id: "event::occurrence",
      eventId: "event",
      occurrenceId: "occurrence",
      title: "Stale title",
      body: "Stale time and place",
      url: "/old/",
      startAt: 2_000,
      notifyAt: -58_000,
      leadMinutes: 1,
      createdAt: "2026-09-14T10:00:00.000Z",
      ...overrides,
    });
    const category: CategoryNotificationSubscription = {
      id: "andet",
      name: "Andet",
      url: "/?kategori=andet",
      knownEventIds: [],
      subscribedAt: "2026-09-14T10:00:00.000Z",
    };
    const current: NotificationCatalogOccurrence = {
      id: "event::occurrence",
      eventId: "event",
      occurrenceId: "occurrence",
      title: "Current title",
      body: "Current time and place",
      url: "/begivenheder/event/",
      startAt: 200_000,
    };
    const preferences = {
      version: 1 as const,
      reminders: [reminder(), reminder({
        id: "cancelled::occurrence",
        eventId: "cancelled",
      })],
      categories: [category],
    };

    expect(reconcileRemindersWithCatalog(preferences, [current], 5_000)).toEqual({
      ...preferences,
      reminders: [{
        ...reminder(),
        title: current.title,
        body: current.body,
        url: current.url,
        startAt: current.startAt,
        notifyAt: 140_000,
      }],
    });
  });

  it("establishes and advances a category baseline without forgetting older ids", () => {
    const subscription: CategoryNotificationSubscription = {
      id: "musik-kultur",
      name: "Musik og kultur",
      url: "/?kategori=musik-kultur",
      knownEventIds: ["already-known"],
      subscribedAt: "2026-09-14T10:00:00.000Z",
    };
    const events: NotificationCatalogEvent[] = [
      { id: "already-known", title: "Known", categoryIds: ["musik-kultur"], url: "/known/" },
      { id: "new", title: "New", categoryIds: ["musik-kultur"], url: "/new/" },
      { id: "sport", title: "Sport", categoryIds: ["sport-motion"], url: "/sport/" },
    ];

    expect(newEventsForCategory(subscription, events).map((event) => event.id)).toEqual(["new"]);
    expect(mergeKnownEventIds(subscription, events).knownEventIds).toEqual(["already-known", "new"]);
  });
});
