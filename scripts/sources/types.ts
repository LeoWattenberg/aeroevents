export const SOURCE_IDS = [
  "aeroe-kommune",
  "aeroe-kirkeliv",
  "aeroe-bibliotek",
  "facebook",
] as const;

export type SourceId = (typeof SOURCE_IDS)[number];

export type PublicationDisposition = "trusted" | "review";
export type EventStatus = "scheduled" | "cancelled";
export type Attendance = "public" | "members" | "unknown";

export interface EventLocationDraft {
  name?: string;
  address?: string;
  postalCode?: string;
  city?: string;
}

/**
 * A source occurrence expressed as Copenhagen wall-clock data. Keeping the
 * date/time split prevents the machine timezone running the collector from
 * changing an event's local time.
 */
export interface ExplicitOccurrenceDraft {
  id: string;
  date: string;
  startTime?: string;
  endDate?: string;
  endTime?: string;
  allDay: boolean;
  timeUnknown: boolean;
}

export interface SourceProvenance {
  sourceId: SourceId;
  externalId: string;
  sourceUrl: string;
  retrievedAt: string;
  sourceModifiedAt?: string;
}

/**
 * Validated, source-neutral input for the repository's canonical EventRecord.
 * The persistence layer deliberately owns final IDs and editorial overrides.
 */
export interface NormalizedEventDraft {
  sourceId: SourceId;
  sourceEventId: string;
  stableId: string;
  title: string;
  description?: string;
  organizerId: string;
  categoryIds: string[];
  location?: EventLocationDraft;
  occurrences: ExplicitOccurrenceDraft[];
  status: EventStatus;
  availability?: "available" | "sold-out" | "unknown";
  attendance: Attendance;
  price?: string;
  bookingUrl?: string;
  publication: PublicationDisposition;
  reviewReasons: string[];
  provenance: SourceProvenance;
}

export interface SourceDefinition {
  id: SourceId;
  name: string;
  url: string;
  organizerId: string;
  categoryIds: string[];
}

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface RawSourceResponse {
  /** Final response URL when available, otherwise the requested URL. */
  url: string;
  status: number;
  contentType: string | null;
  body: string;
}

export type RawResponseRecorder = (response: RawSourceResponse) => Promise<void>;

export interface CollectionContext {
  fetch: FetchLike;
  now: Date;
  signal?: AbortSignal;
  recordResponse?: RawResponseRecorder;
}

interface CollectionResultBase {
  source: SourceDefinition;
  retrievedAt: string;
  pagesFetched: number;
  warnings: string[];
}

export interface CompleteCollectionResult extends CollectionResultBase {
  status: "complete";
  candidates: NormalizedEventDraft[];
  errors: [];
}

/** A partial result never exposes candidates, so it cannot replace a snapshot. */
export interface PartialCollectionResult extends CollectionResultBase {
  status: "partial";
  candidates: [];
  errors: string[];
  discardedCandidateCount: number;
}

export interface FailedCollectionResult extends CollectionResultBase {
  status: "failed";
  candidates: [];
  errors: string[];
}

export type CollectionResult =
  | CompleteCollectionResult
  | PartialCollectionResult
  | FailedCollectionResult;

export interface SourceAdapter {
  definition: SourceDefinition;
  collect(context: CollectionContext): Promise<CollectionResult>;
}
