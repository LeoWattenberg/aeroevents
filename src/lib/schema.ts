import { z } from "zod";

const id = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Brug små bogstaver, tal og bindestreger");
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Dato skal være YYYY-MM-DD")
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const parsed = new Date(Date.UTC(year!, month! - 1, day!));
    return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month! - 1 && parsed.getUTCDate() === day;
  }, "Datoen findes ikke");
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Tid skal være HH:mm");
const httpUrl = z.url().refine((value) => /^https?:\/\//i.test(value), "Kun http(s)-links er tilladt");
const instant = z.iso.datetime({ offset: true });

export const categorySchema = z.object({
  id,
  name: z.string().min(1).max(80),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  description: z.string().max(300).optional(),
});

export const organizerSchema = z.object({
  id,
  name: z.string().min(1).max(160),
  description: z.string().max(2_000).optional(),
  url: httpUrl.optional(),
  email: z.email().optional(),
});

export const sourceDefinitionSchema = z.object({
  id,
  name: z.string().min(1),
  url: httpUrl.optional(),
  organizerId: id.optional(),
  categoryIds: z.array(id).default([]),
  publication: z.enum(["automatic", "review"]),
  enabled: z.boolean().default(true),
  notes: z.string().optional(),
});

export const facebookFeedSourceSchema = z
  .object({
    id,
    name: z.string().min(1).max(160),
    eventFeedUrl: httpUrl.optional(),
    postFeedUrl: httpUrl.optional(),
    organizerId: id.optional(),
    enabled: z.boolean().default(true),
  })
  .refine((source) => source.eventFeedUrl || source.postFeedUrl, {
    message: "En Facebook-kilde skal have et event- eller opslagsfeed",
  });

export const candidateSourceSchema = z.object({
  id,
  name: z.string().min(1).max(160),
  url: httpUrl,
  status: z.enum(["automatic-planned", "review-planned", "manual-planned"]),
  summary: z.string().min(1).max(1_000),
});

export const locationSchema = z.object({
  name: z.string().min(1).max(200),
  address: z.string().max(300).optional(),
  postalCode: z.string().max(20).optional(),
  city: z.string().max(100).optional(),
  url: httpUrl.optional(),
});

export const attendanceSchema = z.object({
  kind: z.enum(["public", "members", "registration"]),
  details: z.string().max(500).optional(),
});

export const bookingSchema = z.object({
  required: z.boolean().default(false),
  soldOut: z.boolean().default(false),
  url: httpUrl.optional(),
  details: z.string().max(500).optional(),
});

const dateIdentity = {
  id: id.optional(),
  date,
  status: z.enum(["scheduled", "cancelled", "postponed"]).optional(),
  location: locationSchema.optional(),
};

export const allDayDateSchema = z
  .object({
    ...dateIdentity,
    kind: z.literal("all-day"),
    endDate: date.optional(),
  })
  .superRefine((value, context) => {
    if (value.endDate && value.endDate < value.date) {
      context.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "endDate må ikke ligge før startdatoen",
      });
    }
  });

export const unknownTimeDateSchema = z.object({
  ...dateIdentity,
  kind: z.literal("time-unknown"),
});

export const timedDateSchema = z
  .object({
    ...dateIdentity,
    kind: z.literal("timed"),
    startTime: time,
    endDate: date.optional(),
    endTime: time.optional(),
  })
  .superRefine((value, context) => {
    if (value.endDate && !value.endTime) {
      context.addIssue({ code: "custom", path: ["endTime"], message: "endTime kræves sammen med endDate" });
    }
    if (value.endDate && value.endDate < value.date) {
      context.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "endDate må ikke ligge før startdatoen",
      });
    }
    const effectiveEndDate = value.endDate ?? value.date;
    if (value.endTime && effectiveEndDate === value.date && value.endTime < value.startTime) {
      context.addIssue({
        code: "custom",
        path: ["endTime"],
        message: "Sluttidspunktet må ikke ligge før starttidspunktet",
      });
    }
  });

export const eventDateSchema = z.discriminatedUnion("kind", [
  allDayDateSchema,
  unknownTimeDateSchema,
  timedDateSchema,
]);

export const occurrenceOverrideSchema = z
  .object({
    recurrenceId: z.string().min(1),
    replacement: eventDateSchema.optional(),
    status: z.enum(["scheduled", "cancelled", "postponed"]).optional(),
    location: locationSchema.optional(),
  })
  .refine((value) => value.replacement || value.status || value.location, {
    message: "En forekomstændring skal ændre mindst ét felt",
  })
  .superRefine((value, context) => {
    const replacement = value.replacement;
    if (replacement?.id || replacement?.status || replacement?.location) {
      context.addIssue({
        code: "custom",
        path: ["replacement"],
        message: "Status, sted og id skal angives på selve forekomstændringen",
      });
    }
  });

export const explicitScheduleSchema = z.object({
  kind: z.literal("explicit"),
  dates: z.array(eventDateSchema).min(1),
});

export const recurringScheduleSchema = z
  .object({
    kind: z.literal("recurring"),
    dtstart: eventDateSchema,
    /** DTSTART is a stable technical anchor because the source gives no first date. */
    startDateUnknown: z.literal(true).optional(),
    rrule: z.string().min(1),
    rdates: z.array(eventDateSchema).default([]),
    exdates: z.array(z.string().min(1)).default([]),
    overrides: z.array(occurrenceOverrideSchema).default([]),
    durationMinutes: z.number().int().positive().optional(),
    durationDays: z.number().int().positive().optional(),
  })
  .superRefine((value, context) => {
    const issue = (path: Array<string | number>, message: string) => {
      context.addIssue({ code: "custom", path, message });
    };
    if (value.durationMinutes !== undefined && value.durationDays !== undefined) {
      issue(["durationDays"], "En gentagelse kan ikke have både durationMinutes og durationDays");
    }
    if (value.durationMinutes !== undefined && value.dtstart.kind !== "timed") {
      issue(["durationMinutes"], "durationMinutes kræver et tidsfastsat dtstart");
    }
    if (value.durationDays !== undefined && value.dtstart.kind !== "all-day") {
      issue(["durationDays"], "durationDays kræver et heldags-dtstart");
    }

    const checkRuleDate = (item: z.infer<typeof eventDateSchema>, path: Array<string | number>) => {
      if (item.id || item.status || item.location) {
        issue(path, "Status, sted og id for en enkelt gentagelse skal angives som en override");
      }
      if (
        (item.kind === "timed" && (item.endDate || item.endTime)) ||
        (item.kind === "all-day" && item.endDate)
      ) {
        issue(path, "Sluttid for en gentagelse skal angives med schedule.duration");
      }
    };
    checkRuleDate(value.dtstart, ["dtstart"]);
    value.rdates.forEach((item, index) => {
      if (item.kind !== value.dtstart.kind) {
        issue(["rdates", index, "kind"], "En RDATE skal have samme type som dtstart");
      }
      checkRuleDate(item, ["rdates", index]);
    });

    const identityMatchesStart = (identity: string): boolean => {
      const match = /^(\d{4}-\d{2}-\d{2})(?:T([0-2]\d:[0-5]\d))?$/u.exec(identity);
      if (!match?.[1] || !date.safeParse(match[1]).success) return false;
      if (value.dtstart.kind === "timed") {
        return Boolean(match[2] && time.safeParse(match[2]).success);
      }
      return match[2] === undefined;
    };
    value.exdates.forEach((identity, index) => {
      if (!identityMatchesStart(identity)) {
        issue(["exdates", index], "En EXDATE skal have samme dato-/tidstype som dtstart");
      }
    });
    value.overrides.forEach((override, index) => {
      if (!identityMatchesStart(override.recurrenceId)) {
        issue(
          ["overrides", index, "recurrenceId"],
          "En recurrenceId skal have samme dato-/tidstype som dtstart",
        );
      }
    });
  });

export const scheduleSchema = z.discriminatedUnion("kind", [explicitScheduleSchema, recurringScheduleSchema]);

export const sourceReferenceSchema = z.object({
  sourceId: id,
  externalId: z.string().min(1).max(300).optional(),
  url: httpUrl.optional(),
  verifiedAt: instant.optional(),
  modifiedAt: instant.optional(),
});

export const eventSchema = z.object({
  id,
  title: z.string().min(1).max(240),
  description: z.string().max(10_000).default(""),
  organizerId: id,
  organizerName: z.string().min(1).max(160).optional(),
  categoryIds: z.array(id).min(1),
  location: locationSchema.optional(),
  attendance: attendanceSchema.default({ kind: "public" }),
  status: z.enum(["scheduled", "cancelled", "postponed"]).default("scheduled"),
  publication: z.enum(["published", "draft"]).default("published"),
  price: z.string().max(300).optional(),
  booking: bookingSchema.optional(),
  schedule: scheduleSchema,
  source: sourceReferenceSchema,
});

export const eventOverrideSchema = z.object({
  eventId: id,
  set: z.object({
    title: eventSchema.shape.title.optional(),
    description: eventSchema.shape.description.optional(),
    organizerId: id.optional(),
    organizerName: eventSchema.shape.organizerName.optional(),
    categoryIds: eventSchema.shape.categoryIds.optional(),
    location: locationSchema.nullable().optional(),
    attendance: attendanceSchema.optional(),
    status: eventSchema.shape.status.optional(),
    publication: eventSchema.shape.publication.optional(),
    price: eventSchema.shape.price.nullable().optional(),
    booking: bookingSchema.nullable().optional(),
    schedule: scheduleSchema.optional(),
  }),
});

export const deduplicationSchema = z
  .object({
    canonicalEventId: id,
    duplicateEventIds: z.array(id).min(1),
    reason: z.string().min(1).max(500).optional(),
  })
  .superRefine((value, context) => {
    if (value.duplicateEventIds.includes(value.canonicalEventId)) {
      context.addIssue({
        code: "custom",
        path: ["duplicateEventIds"],
        message: "Den kanoniske event kan ikke samtidig være en dublet",
      });
    }
    if (new Set(value.duplicateEventIds).size !== value.duplicateEventIds.length) {
      context.addIssue({
        code: "custom",
        path: ["duplicateEventIds"],
        message: "Dublet-id'er skal være unikke",
      });
    }
  });

export const importedSnapshotSchema = z.object({
  sourceId: id,
  verifiedAt: instant,
  events: z.array(eventSchema),
});

export const occurrenceSchema = z.object({
  id: z.string().min(1),
  eventId: id,
  recurrenceId: z.string().min(1),
  date,
  startAt: instant.optional(),
  endAt: instant.optional(),
  endDate: date.optional(),
  allDay: z.boolean(),
  timeUnknown: z.boolean(),
  status: z.enum(["scheduled", "cancelled", "postponed"]),
  location: locationSchema.optional(),
});

export const buildMetadataSchema = z.object({
  id: z.literal("build").default("build"),
  generatedAt: instant,
  rangeStart: date,
  rangeEnd: date,
  sources: z.array(
    z.object({
      sourceId: id,
      verifiedAt: instant.optional(),
      eventCount: z.number().int().nonnegative(),
    }),
  ),
  warnings: z.array(z.string()),
});

export type Category = z.infer<typeof categorySchema>;
export type Organizer = z.infer<typeof organizerSchema>;
export type SourceDefinition = z.infer<typeof sourceDefinitionSchema>;
export type FacebookFeedSource = z.infer<typeof facebookFeedSourceSchema>;
export type CandidateSource = z.infer<typeof candidateSourceSchema>;
export type EventDate = z.infer<typeof eventDateSchema>;
export type Schedule = z.infer<typeof scheduleSchema>;
export type EventRecord = z.infer<typeof eventSchema>;
export type EventOverride = z.infer<typeof eventOverrideSchema>;
export type Deduplication = z.infer<typeof deduplicationSchema>;
export type ImportedSnapshot = z.infer<typeof importedSnapshotSchema>;
export type Occurrence = z.infer<typeof occurrenceSchema>;
export type BuildMetadata = z.infer<typeof buildMetadataSchema>;
