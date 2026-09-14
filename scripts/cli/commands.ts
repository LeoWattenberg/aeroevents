import { spawn } from "node:child_process";
import { readFile, stat, unlink } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { once } from "node:events";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { stringify as stringifyYaml } from "yaml";
import { DateTime } from "luxon";
import {
  collectAllSources,
  collectFacebookPublicUrl,
  canonicalFacebookContentUrl,
  facebookContentId,
  parseFacebookPostText,
  SOURCE_REGISTRY,
  type RegisteredSourceId,
} from "../sources/index.js";
import type { NormalizedEventDraft } from "../sources/types.js";
import { getPaths, type CliPaths } from "./config.js";
import {
  atomicWrite,
  atomicWriteJson,
  readStructuredFile,
  safeId,
} from "./files.js";
import {
  assertEventReferences,
  sourceDraftToEvent,
  validateAllPublicData,
  validateEvent,
  validateSnapshot,
} from "./model.js";
import { booleanOption, parseOptions, stringOption } from "./options.js";
import { promptForEvent } from "./prompts.js";
import { mergeSourceEvents, preserveSnapshotEventId } from "./snapshots.js";
import {
  applyCollectionPolicy,
  applySourceMappings,
  crossSourceDuplicateReasons,
  eventFingerprint,
  eventSourceIdentity,
  reviewSnapshotAction,
} from "./collection-policy.js";
import { createRawResponseCapture } from "./raw-responses.js";
import { buildApprovalOverride } from "./editorial.js";
import {
  enqueueCandidate,
  clearPendingCandidate,
  findPending,
  getReviewDecision,
  listPending,
  markApproved,
  markRejected,
  type CandidateInput,
  type ReviewCandidate,
} from "./review-store.js";
import type { Deduplication, EventRecord } from "../../src/lib/schema.js";
import { formatReviewCandidate, parseReviewDecision } from "./review-display.js";
import {
  DEFAULT_TIME_TOLERANCE_MINUTES,
  DEFAULT_TITLE_SIMILARITY,
  findEventDuplicates,
} from "./duplicate-finder.js";
import {
  CALENDAR_ZONE,
  expandEvent,
  expandEvents,
  wallIdentity,
} from "../../src/lib/schedule.js";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function eventFileName(event: EventRecord): string {
  return `${safeId(event.id)}.yaml`;
}

async function writeManualEvent(paths: CliPaths, event: EventRecord, allowReplace = false): Promise<string> {
  const destination = resolve(paths.manualEvents, eventFileName(event));
  if (!allowReplace && (await exists(destination))) {
    throw new Error(`Filen findes allerede: ${relative(paths.repo, destination)}`);
  }
  const previous = (await exists(destination)) ? await readFile(destination, "utf8") : undefined;
  await atomicWrite(destination, stringifyYaml(event, { lineWidth: 100 }), 0o644);
  try {
    await validateAllPublicData(paths.repo);
  } catch (error) {
    if (previous === undefined) await unlink(destination);
    else await atomicWrite(destination, previous, 0o644);
    throw error;
  }
  return relative(paths.repo, destination);
}

async function writeEventOverride(
  paths: CliPaths,
  event: EventRecord,
  importedBase: EventRecord,
): Promise<string> {
  const destination = resolve(paths.overrides, `${safeId(event.id)}.yaml`);
  const previous = (await exists(destination)) ? await readFile(destination, "utf8") : undefined;
  const override = buildApprovalOverride(event, importedBase);
  await atomicWrite(destination, stringifyYaml(override, { lineWidth: 100 }), 0o644);
  try {
    await validateAllPublicData(paths.repo);
  } catch (error) {
    if (previous === undefined) await unlink(destination);
    else await atomicWrite(destination, previous, 0o644);
    throw error;
  }
  return relative(paths.repo, destination);
}

async function createCommand(args: string[]): Promise<void> {
  const paths = getPaths();
  const options = parseOptions(args);
  const inputFile = stringOption(options, "from");
  let event: EventRecord;
  if (inputFile) {
    event = validateEvent(await readStructuredFile(resolve(inputFile)));
    if (booleanOption(options, "publish")) event = validateEvent({ ...event, publication: "published" });
  } else {
    event = await promptForEvent({ publication: booleanOption(options, "publish") ? "published" : "draft" });
  }
  await assertEventReferences(paths.repo, event);
  const destination = await writeManualEvent(paths, event);
  console.log(`Oprettede ${destination}${event.publication === "draft" ? " som kladde" : ""}.`);
}

async function queueCommand(args: string[]): Promise<void> {
  const paths = getPaths();
  const options = parseOptions(args);
  const supported = new Set(["from", "reason", "evidence"]);
  const unknown = [...options.values.keys()].filter((name) => !supported.has(name));
  if (unknown.length) throw new Error(`Ukendt flag: --${unknown.join(", --")}`);
  if (options.positional.length) throw new Error(`Uventet argument: ${options.positional.join(" ")}`);

  const inputFile = stringOption(options, "from");
  if (!inputFile) throw new Error("queue kræver --from med en YAML- eller JSON-eventfil.");
  const event = validateEvent({
    ...(await readStructuredFile(resolve(inputFile)) as object),
    publication: "draft",
  });
  await assertEventReferences(paths.repo, event);
  if (!event.source.url) {
    throw new Error("En kandidat til reviewkøen skal have et offentligt source.url.");
  }

  const today = DateTime.now().setZone(CALENDAR_ZONE).startOf("day");
  const rangeEnd = today.plus({ months: 12 });
  if (event.schedule.kind === "recurring") {
    const { schedule } = event;
    if (schedule.durationMinutes !== undefined && schedule.durationDays !== undefined) {
      throw new Error("En gentagelse kan ikke have både durationMinutes og durationDays.");
    }
    if (schedule.durationMinutes !== undefined && schedule.dtstart.kind !== "timed") {
      throw new Error("durationMinutes kræver et tidsfastsat dtstart.");
    }
    if (schedule.durationDays !== undefined && schedule.dtstart.kind !== "all-day") {
      throw new Error("durationDays kræver et heldags-dtstart.");
    }

    const anchor = DateTime.fromISO(schedule.dtstart.date, { zone: CALENDAR_ZONE }).startOf("day");
    const anchorEvent: EventRecord = {
      ...event,
      schedule: { ...schedule, rdates: [], exdates: [], overrides: [] },
    };
    const anchorExpansion = expandEvent(anchorEvent, anchor, anchor);
    if (anchorExpansion.warnings.length) {
      throw new Error(
        `Gentagelsesreglen kunne ikke valideres: ${anchorExpansion.warnings.join("; ")}`,
      );
    }
    if (
      !anchorExpansion.occurrences.some(
        (occurrence) => occurrence.recurrenceId === wallIdentity(schedule.dtstart),
      )
    ) {
      throw new Error("Gentagelsesreglens dtstart skal selv passe til RRULE-mønstret.");
    }

    const expansion = expandEvent(event, today, rangeEnd);
    if (expansion.warnings.length) {
      throw new Error(`Gentagelsesreglen kunne ikke valideres: ${expansion.warnings.join("; ")}`);
    }
    if (!expansion.occurrences.length) {
      throw new Error("Gentagelsesreglen giver ingen forekomster i kalenderens næste 12 måneder.");
    }
  }

  const repository = await validateAllPublicData(paths.repo).then((result) => result.repository);
  const duplicateStart = today.minus({ days: 31 });
  const comparisonEvents = [...repository.events.filter((item) => item.id !== event.id), event];
  const comparisonExpansion = expandEvents(comparisonEvents, duplicateStart, rangeEnd);
  const duplicateReasons = findEventDuplicates(comparisonEvents, comparisonExpansion.occurrences, {
    minimumTitleSimilarity: DEFAULT_TITLE_SIMILARITY,
    timeToleranceMinutes: DEFAULT_TIME_TOLERANCE_MINUTES,
  }).flatMap((match) => {
    if (match.left.id !== event.id && match.right.id !== event.id) return [];
    const other = match.left.id === event.id ? match.right : match.left;
    const shared = match.sharedStarts[0];
    return [
      `Mulig dublet af ${other.id} fra ${other.sourceId}` +
        (shared
          ? ` (${shared.date} kl. ${match.left.id === event.id ? shared.leftTime : shared.rightTime})`
          : ""),
    ];
  });

  const reason = stringOption(options, "reason") || "Manuelt researchfund kræver redaktionelt gennemsyn";
  const evidence = stringOption(options, "evidence");
  const outcome = await enqueueCandidate(paths, {
    sourceId: event.source.sourceId,
    sourceEventId: event.source.externalId || event.id,
    sourceUrl: event.source.url,
    discoveredAt: event.source.verifiedAt || new Date().toISOString(),
    reasons: [reason, ...duplicateReasons],
    event,
    ...(evidence ? { private: { parseEvidence: [evidence] } } : {}),
  });
  console.log(`Reviewkandidat ${event.id}: ${outcome}.`);
}

function draftCandidateInput(
  draft: NormalizedEventDraft,
  event: unknown,
  reasons: string[],
  privateData?: Record<string, unknown>,
): CandidateInput {
  return {
    sourceId: draft.sourceId,
    sourceEventId: draft.sourceEventId,
    sourceUrl: draft.provenance.sourceUrl,
    discoveredAt: draft.provenance.retrievedAt,
    reasons,
    event,
    ...(privateData ? { private: privateData } : {}),
  };
}

async function loadSourceStatus(paths: CliPaths): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await readFile(paths.sourceStatus, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function collectCommand(args: string[]): Promise<void> {
  const paths = getPaths();
  const options = parseOptions(args);
  const nowText = stringOption(options, "now");
  const now = nowText ? new Date(nowText) : new Date();
  if (Number.isNaN(now.valueOf())) throw new Error(`Ugyldigt --now-tidspunkt: ${nowText}`);

  const existing = await validateAllPublicData(paths.repo);
  const unknownSourceIds = options.positional.filter((id) => !(id in SOURCE_REGISTRY));
  if (unknownSourceIds.length) throw new Error(`Ukendt kilde: ${unknownSourceIds.join(", ")}`);
  const sourceIds = options.positional.length
    ? (options.positional as RegisteredSourceId[])
    : existing.repository.sources
        .filter((source) => source.enabled && source.id in SOURCE_REGISTRY)
        .map((source) => source.id as RegisteredSourceId);
  const missingPolicies = sourceIds.filter(
    (sourceId) => !existing.repository.sources.some((source) => source.id === sourceId),
  );
  if (missingPolicies.length) {
    throw new Error(`Kilden mangler i data/sources.yaml: ${missingPolicies.join(", ")}`);
  }
  const rawCapture = createRawResponseCapture(paths.raw, now);
  console.log(`Starter indsamling fra ${sourceIds.length} kilder.`);
  const results = await collectAllSources({
    fetch: globalThis.fetch,
    now,
    sourceIds,
    recordResponse: rawCapture.recordResponse,
    onProgress: (progress) => {
      if (progress.phase === "started") {
        console.log(
          `[${progress.position}/${progress.total}] Henter ${progress.source.id}: ${progress.source.name} ...`,
        );
        return;
      }
      const { result } = progress;
      const candidateCount = result.status === "complete"
        ? `, ${result.candidates.length} kandidater`
        : "";
      console.log(
        `[${progress.completed}/${progress.total}] Hentet ${progress.source.id}: ` +
          `${result.status}, ${result.pagesFetched} sider${candidateCount}.`,
      );
    },
  });

  interface PreparedCandidate {
    draft: NormalizedEventDraft;
    event?: EventRecord;
    validationError?: string;
  }

  const preparedBySource = new Map<string, PreparedCandidate[]>();
  const normalizedCandidates: EventRecord[] = [];
  for (const result of results) {
    if (result.status !== "complete") continue;
    const sourcePolicy = existing.repository.sources.find((source) => source.id === result.source.id);
    if (!sourcePolicy) throw new Error(`Kilden ${result.source.id} mangler i data/sources.yaml.`);
    const previousEvents = existing.repository.snapshots.find(
      (snapshot) => snapshot.sourceId === result.source.id,
    )?.events ?? [];
    const prepared: PreparedCandidate[] = [];
    for (const draft of result.candidates) {
      try {
        if (draft.sourceId !== result.source.id) {
          throw new Error(`Kandidaten angiver en anden kilde: ${draft.sourceId}`);
        }
        const event = validateEvent(
          applySourceMappings(
            preserveSnapshotEventId(previousEvents, sourceDraftToEvent(draft)),
            sourcePolicy,
          ),
        );
        await assertEventReferences(paths.repo, event);
        prepared.push({ draft, event });
        normalizedCandidates.push(event);
      } catch (error) {
        prepared.push({
          draft,
          validationError: error instanceof Error ? error.message : String(error),
        });
      }
    }
    preparedBySource.set(result.source.id, prepared);
  }

  // Calculate duplicates over the full batch so every side of a new A/B match
  // is review-routed, independent of collector result order.
  const suppressedEventIds = new Set(
    existing.repository.deduplications.flatMap((item) => item.duplicateEventIds),
  );
  const duplicateReasons = crossSourceDuplicateReasons(
    existing.repository.events,
    normalizedCandidates.filter((event) => !suppressedEventIds.has(event.id)),
  );
  const importedEventIds = new Set(
    existing.repository.snapshots.flatMap((snapshot) => snapshot.events.map((event) => event.id)),
  );
  const editorOwnedIdentities = new Set(
    existing.repository.events
      .filter((event) => !importedEventIds.has(event.id))
      .map(eventSourceIdentity),
  );
  const publicationOverrideEventIds = new Set(
    existing.repository.overrides
      .filter((override) => override.set.publication === "published")
      .map((override) => override.eventId),
  );

  const sourceStatus = await loadSourceStatus(paths);
  let updated = 0;
  let queued = 0;
  let retained = 0;

  for (const result of results) {
    if (result.status !== "complete") {
      retained += 1;
      console.error(
        `${result.source.id}: ${result.status}; sidste komplette snapshot bevares. ${result.errors.join("; ")}`,
      );
      continue;
    }
    for (const warning of result.warnings) console.warn(`${result.source.id}: ${warning}`);
    const excludedSourceEventIds = result.excludedSourceEventIds ?? [];
    const excludedIdentities = new Set(excludedSourceEventIds);
    const candidateIdentities = new Set(result.candidates.map((candidate) => candidate.sourceEventId));
    const invalidExclusions = excludedSourceEventIds.some(
      (identity) => !identity || identity.length > 300 || candidateIdentities.has(identity),
    );
    if (invalidExclusions || excludedIdentities.size !== excludedSourceEventIds.length) {
      retained += 1;
      console.error(
        `${result.source.id}: listen over eksplicit udelukkede kilde-id'er er ugyldig; sidste komplette snapshot bevares.`,
      );
      continue;
    }
    if (result.candidates.length === 0 && excludedIdentities.size === 0) {
      retained += 1;
      console.error(`${result.source.id}: tomt resultat; sidste komplette snapshot bevares.`);
      continue;
    }

    const sourcePolicy = existing.repository.sources.find((source) => source.id === result.source.id);
    if (!sourcePolicy) throw new Error(`Kilden ${result.source.id} mangler i data/sources.yaml.`);
    const observedEvents: EventRecord[] = [];
    const demoteIdentities = new Set<string>();
    const removeIdentities = new Set<string>(excludedIdentities);
    const scopedFacebookRun =
      result.source.id === "facebook" &&
      Boolean(process.env.AEROEVENTS_FACEBOOK_SOURCE_IDS?.trim());
    let trustedInvalid = false;
    let autoPublishedCount = 0;
    let reviewCount = 0;
    for (const prepared of preparedBySource.get(result.source.id) || []) {
      const { draft, event, validationError } = prepared;
      if (!event) {
        await enqueueCandidate(
          paths,
          draftCandidateInput(draft, draft, ["Kandidaten passer ikke til den fælles eventmodel"], {
            validationError: validationError || "Ukendt valideringsfejl",
          }),
        );
        queued += 1;
        const adapterCouldPublish =
          sourcePolicy.enabled &&
          sourcePolicy.publication === "automatic" &&
          draft.publication === "trusted";
        if (adapterCouldPublish) trustedInvalid = true;
        else demoteIdentities.add(draft.sourceEventId);
        console.error(
          `${result.source.id}/${draft.sourceEventId}: ugyldig kandidat: ${validationError}`,
        );
        continue;
      }

      const identity = eventSourceIdentity(event);
      if (suppressedEventIds.has(event.id)) {
        // Keep refreshing the source record for auditability, but a resolved
        // duplicate must neither re-enter review nor demote its canonical peer.
        const suppressedEvent = validateEvent({ ...event, publication: "draft" });
        observedEvents.push(suppressedEvent);
        await clearPendingCandidate(paths, draftCandidateInput(draft, suppressedEvent, []));
        continue;
      }
      const editorOwned = editorOwnedIdentities.has(identity);
      const candidateInput = draftCandidateInput(draft, event, []);
      const reviewDecision = await getReviewDecision(paths, candidateInput);
      const decision = applyCollectionPolicy(
        sourcePolicy,
        draft.publication,
        duplicateReasons.get(identity) || [],
        editorOwned,
        reviewDecision === "rejected",
      );
      const finalEvent = validateEvent({ ...event, publication: decision.publication });
      if (decision.publication === "draft") {
        const outcome = await enqueueCandidate(
          paths,
          draftCandidateInput(draft, finalEvent, [...draft.reviewReasons, ...decision.reasons]),
        );
        if (outcome === "created" || outcome === "updated") queued += 1;
        reviewCount += 1;
        const snapshotAction = reviewSnapshotAction(
          decision.editorOwned,
          outcome,
          publicationOverrideEventIds.has(event.id),
        );
        if (snapshotAction === "remove") removeIdentities.add(draft.sourceEventId);
        else if (snapshotAction === "retain-demoted") {
          // Keep the last reviewed base in place. A publication override may
          // expose it, and must never expose newly changed review-only content
          // until the editor approves that payload.
          demoteIdentities.add(draft.sourceEventId);
        } else observedEvents.push(finalEvent);
      } else {
        observedEvents.push(finalEvent);
        autoPublishedCount += 1;
        await clearPendingCandidate(paths, candidateInput);
      }
    }

    if (trustedInvalid) {
      retained += 1;
      console.error(`${result.source.id}: mindst én automatisk kandidat er ugyldig; snapshot bevares.`);
      continue;
    }

    if (scopedFacebookRun) {
      retained += 1;
      console.log(
        "facebook: afgrænset fejlsøgning opdaterede reviewkøen; snapshot og kildestatus blev bevaret.",
      );
      continue;
    }

    const previousSnapshot = existing.repository.snapshots.find(
      (snapshot) => snapshot.sourceId === result.source.id,
    );
    const mergedEvents = mergeSourceEvents(previousSnapshot?.events || [], observedEvents, {
      demoteIdentities,
      removeIdentities,
      demoteAllRetained: sourcePolicy.publication !== "automatic" || !sourcePolicy.enabled,
      retainUnobserved: result.snapshotCoverage !== "authoritative",
      ...(previousSnapshot ? { previousVerifiedAt: previousSnapshot.verifiedAt } : {}),
    });
    const retainedPreviousCount = mergedEvents.length - observedEvents.length;
    const snapshot = validateSnapshot({
      sourceId: result.source.id,
      verifiedAt: result.retrievedAt,
      events: mergedEvents,
    });
    const snapshotPath = resolve(paths.importedEvents, `${safeId(result.source.id)}.json`);
    const previousContents = (await exists(snapshotPath)) ? await readFile(snapshotPath, "utf8") : undefined;
    await atomicWriteJson(snapshotPath, snapshot, 0o644);
    try {
      await validateAllPublicData(paths.repo);
    } catch (error) {
      if (previousContents === undefined) await unlink(snapshotPath);
      else await atomicWrite(snapshotPath, previousContents, 0o644);
      retained += 1;
      console.error(
        `${result.source.id}: nyt snapshot fejlede repository-validering og blev rullet tilbage: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }
    await Promise.all(
      excludedSourceEventIds.map((sourceEventId) =>
        clearPendingCandidate(paths, {
          sourceId: result.source.id,
          sourceEventId,
          event: {},
        })
      ),
    );
    sourceStatus[result.source.id] = {
      verifiedAt: result.retrievedAt,
      eventCount: snapshot.events.length,
    };
    updated += 1;
    console.log(
      `${result.source.id}: ${autoPublishedCount} automatisk publiceret, ` +
        `${retainedPreviousCount} tidligere bevaret, ${reviewCount} til gennemsyn, ` +
        `${excludedSourceEventIds.length} eksplicit udeladt.`,
    );
  }

  if (updated > 0) {
    await atomicWriteJson(paths.sourceStatus, sourceStatus, 0o644);
    await validateAllPublicData(paths.repo);
  }
  console.log(`Indsamling færdig: ${updated} snapshots opdateret, ${queued} nye/ændrede i kø, ${retained} bevaret.`);
}

async function reviewCommand(args: string[]): Promise<void> {
  const paths = getPaths();
  const options = parseOptions(args);
  const candidates = await listPending(paths);
  if (booleanOption(options, "json")) {
    console.log(JSON.stringify(candidates, null, 2));
    return;
  }
  if (candidates.length === 0) {
    console.log("Der er ingen kandidater til gennemsyn.");
    return;
  }
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("Interaktivt gennemsyn kræver en terminal; brug review --json til maskinlæsbar visning.");
  }

  const prompt = createInterface({ input: stdin, output: stdout });
  let approved = 0;
  let rejected = 0;
  let skipped = 0;
  try {
    for (const [index, candidate] of candidates.entries()) {
      console.log(`\n${formatReviewCandidate(candidate, index + 1, candidates.length)}\n`);
      let decision;
      do {
        decision = parseReviewDecision(await prompt.question("Godkend og tilføj? (y/n/s = skip): "));
        if (!decision) console.log("Svar y for ja, n for nej eller s for skip.");
      } while (!decision);

      if (decision === "approve") {
        console.log(await approveCandidate(paths, candidate));
        approved += 1;
      } else if (decision === "reject") {
        await markRejected(paths, candidate, "Afvist ved interaktivt gennemsyn");
        console.log(`Afviste ${candidate.candidateId}.`);
        rejected += 1;
      } else {
        console.log(`Sprang ${candidate.candidateId} over; kandidaten forbliver i køen.`);
        skipped += 1;
      }
    }
  } finally {
    prompt.close();
  }
  console.log(
    `Gennemsyn færdigt: ${approved} godkendt, ${rejected} afvist, ${skipped} sprunget over.`,
  );
}

async function approveCandidate(paths: CliPaths, candidate: ReviewCandidate): Promise<string> {
  const event = validateEvent({ ...(candidate.event as object), publication: "published" });
  await assertEventReferences(paths.repo, event);

  const repository = await validateAllPublicData(paths.repo);
  const conflicting = repository.repository.events.find((item) => item.id === event.id);
  const importedConflict = repository.repository.snapshots
    .flatMap((snapshot) => snapshot.events)
    .find((item) => item.id === event.id);
  const target = resolve(paths.manualEvents, eventFileName(event));
  let allowReplace = false;
  if (conflicting && importedConflict) {
    const sameSourceRecord =
      importedConflict.source.sourceId === event.source.sourceId &&
      importedConflict.source.externalId === event.source.externalId;
    if (!sameSourceRecord) throw new Error(`Event-id'et ${event.id} tilhører allerede en anden event.`);
    const publicPath = await writeEventOverride(paths, event, importedConflict);
    await markApproved(paths, candidate, publicPath);
    return `Godkendte ${candidate.candidateId} som redaktionel override i ${publicPath}.`;
  }
  if (conflicting) {
    allowReplace =
      conflicting.source.sourceId === event.source.sourceId &&
      conflicting.source.externalId === event.source.externalId &&
      (await exists(target));
    if (!allowReplace) throw new Error(`Event-id'et ${event.id} findes allerede i offentlige data.`);
  }

  const publicPath = await writeManualEvent(paths, event, allowReplace);
  await markApproved(paths, candidate, publicPath);
  return `Godkendte ${candidate.candidateId} som ${publicPath}.`;
}

async function approveCommand(args: string[]): Promise<void> {
  const paths = getPaths();
  const options = parseOptions(args);
  const candidateId = options.positional[0];
  if (!candidateId) throw new Error("approve kræver et kandidat-id.");
  const candidate = await findPending(paths, candidateId);
  console.log(await approveCandidate(paths, candidate));
}

async function rejectCommand(args: string[]): Promise<void> {
  const paths = getPaths();
  const options = parseOptions(args);
  const candidateId = options.positional[0];
  if (!candidateId) throw new Error("reject kræver et kandidat-id.");
  const candidate = await findPending(paths, candidateId);
  const reason = stringOption(options, "reason") || "Afvist af redaktøren";
  await markRejected(paths, candidate, reason);
  console.log(`Afviste ${candidate.candidateId}.`);
}

async function queueFacebookDrafts(
  paths: CliPaths,
  drafts: NormalizedEventDraft[],
  warnings: string[],
  privateData?: Record<string, unknown>,
): Promise<number> {
  const repository = await validateAllPublicData(paths.repo);
  const sourcePolicy = repository.repository.sources.find((source) => source.id === "facebook");
  if (!sourcePolicy) throw new Error("Facebook-kilden mangler i data/sources.yaml.");
  const previousEvents = repository.repository.snapshots.find(
    (snapshot) => snapshot.sourceId === "facebook",
  )?.events ?? [];
  const normalized = drafts.map((draft) =>
    validateEvent(
      applySourceMappings(
        preserveSnapshotEventId(previousEvents, sourceDraftToEvent(draft)),
        sourcePolicy,
      ),
    ),
  );
  const duplicates = crossSourceDuplicateReasons(repository.repository.events, normalized);
  let queued = 0;
  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index];
    const event = normalized[index];
    if (!draft || !event) continue;
    await assertEventReferences(paths.repo, event);
    const sameSourceDuplicates = repository.repository.events.filter(
      (other) =>
        other.source.sourceId === "facebook" &&
        eventSourceIdentity(other) !== eventSourceIdentity(event) &&
        eventFingerprint(other) === eventFingerprint(event),
    );
    const duplicateReasons = [
      ...(duplicates.get(eventSourceIdentity(event)) || []),
      ...sameSourceDuplicates.map(
        (other) =>
          `Mulig dublet af ${other.id} fra et andet Facebook-link; kontrollér permalinket`,
      ),
    ];
    const decision = applyCollectionPolicy(
      sourcePolicy,
      draft.publication,
      duplicateReasons,
      false,
    );
    const reviewEvent = validateEvent({ ...event, publication: "draft" });
    const outcome = await enqueueCandidate(
      paths,
      draftCandidateInput(
        draft,
        reviewEvent,
        [...draft.reviewReasons, ...decision.reasons, ...warnings],
        privateData,
      ),
    );
    if (outcome === "created" || outcome === "updated") queued += 1;
  }
  return queued;
}

async function facebookCommand(args: string[]): Promise<void> {
  const paths = getPaths();
  const options = parseOptions(args);
  const rawUrl = options.positional[0];
  if (!rawUrl) throw new Error("facebook kræver URL'en til den offentlige begivenhed.");
  let url: URL;
  try {
    url = new URL(canonicalFacebookContentUrl(rawUrl));
  } catch {
    throw new Error("Brug en offentlig https-URL på facebook.com.");
  }

  if (booleanOption(options, "fetch")) {
    if (stringOption(options, "event") || stringOption(options, "details-file")) {
      throw new Error("--fetch kan ikke kombineres med --event eller --details-file.");
    }
    const now = new Date();
    const rawCapture = createRawResponseCapture(paths.raw, now);
    const result = await collectFacebookPublicUrl(url.href, {
      fetch: globalThis.fetch,
      now,
      recordResponse: rawCapture.recordResponse,
    });
    for (const warning of result.warnings) console.warn(`Facebook: ${warning}`);
    if (result.status !== "complete") {
      throw new Error(`Facebook-fundet kunne ikke indsamles: ${result.errors.join("; ")}`);
    }
    if (!result.candidates.length) {
      throw new Error("Facebook-siden gav ingen eventoplysninger til gennemsyn.");
    }

    const queued = await queueFacebookDrafts(paths, result.candidates, result.warnings);
    console.log(
      `Facebook: ${result.candidates.length} fund behandlet, ${queued} nye/ændrede i kø. ` +
        `Råsvaret ligger privat i ${rawCapture.runDirectory}.`,
    );
    return;
  }

  const eventFile = stringOption(options, "event");
  const detailsFile = stringOption(options, "details-file");
  const pastedDetails = detailsFile
    ? await readFile(resolve(detailsFile), "utf8")
    : stringOption(options, "details");
  if (!eventFile && pastedDetails) {
    const retrievedAt = new Date().toISOString();
    const parsed = parseFacebookPostText({
      url: url.href,
      text: pastedDetails,
      retrievedAt,
      ...(stringOption(options, "published-at")
        ? { publishedAt: stringOption(options, "published-at")! }
        : {}),
      ...(stringOption(options, "title")
        ? { titleOverride: stringOption(options, "title")! }
        : {}),
    });
    if (!parsed.candidates.length) {
      throw new Error(
        `Facebook-opslaget kunne ikke fortolkes: ${parsed.errors.join("; ")}. ` +
          "Ret teksten eller brug --event med en redigeret eventfil.",
      );
    }
    const queued = await queueFacebookDrafts(paths, parsed.candidates, parsed.warnings, {
      pastedDetails,
      parseEvidence: parsed.evidence,
    });
    console.log(
      `Facebook-opslag: ${parsed.candidates.length} fund behandlet, ${queued} nye/ændrede i kø. ` +
        "Opslagsteksten ligger kun i den private arbejdskø.",
    );
    return;
  }

  const externalId = facebookContentId(url.href);
  let event: EventRecord;
  if (eventFile) {
    const input = validateEvent(await readStructuredFile(resolve(eventFile)));
    event = validateEvent({
      ...input,
      publication: "draft",
      source: { sourceId: "facebook", externalId, url: url.href },
    });
  } else {
    event = await promptForEvent({
      sourceId: "facebook",
      sourceUrl: url.href,
      externalId,
      organizerId: "aeroe-kalenderen",
      categoryIds: ["andet"],
      publication: "draft",
    });
  }
  await assertEventReferences(paths.repo, event);

  const outcome = await enqueueCandidate(paths, {
    sourceId: "facebook",
    sourceEventId: externalId,
    sourceUrl: url.href,
    discoveredAt: new Date().toISOString(),
    reasons: ["Facebook-fund kræver redaktionelt gennemsyn"],
    event,
    ...(pastedDetails ? { private: { pastedDetails } } : {}),
  });
  console.log(`Facebook-kandidat: ${outcome}. Ingen side blev hentet automatisk.`);
}

async function validateCommand(): Promise<void> {
  const paths = getPaths();
  const { repository, publicData } = await validateAllPublicData(paths.repo);
  console.log(
    `Valideret: ${repository.events.length} events, ${publicData.publicEvents.length} publicerede, ` +
      `${publicData.occurrences.length} forekomster, ${repository.suppressedEvents.length} undertrykte dubletter.`,
  );
  for (const warning of publicData.metadata.warnings) console.warn(`Advarsel: ${warning}`);
}

function numericOption(
  options: ReturnType<typeof parseOptions>,
  name: string,
  fallback: number,
): number {
  const raw = options.values.get(name);
  if (raw === undefined) return fallback;
  if (raw === true || raw.trim() === "") throw new Error(`--${name} kræver et tal.`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Ugyldig værdi for --${name}: ${raw}`);
  return value;
}

function duplicateRangeDate(value: string | undefined, name: string, fallback: DateTime): DateTime {
  if (value === undefined) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`--${name} skal være YYYY-MM-DD.`);
  const parsed = DateTime.fromISO(value, { zone: CALENDAR_ZONE }).startOf("day");
  if (!parsed.isValid || parsed.toISODate() !== value) throw new Error(`Ugyldig --${name}-dato: ${value}`);
  return parsed;
}

async function duplicatesCommand(args: string[]): Promise<void> {
  const paths = getPaths();
  const options = parseOptions(args);
  if (options.positional.length) throw new Error(`Uventet argument: ${options.positional.join(" ")}`);
  const supported = new Set(["from", "to", "threshold", "minutes", "published-only", "json", "fail-on-found"]);
  const unknown = [...options.values.keys()].filter((name) => !supported.has(name));
  if (unknown.length) throw new Error(`Ukendt flag: --${unknown.join(", --")}`);

  const now = DateTime.now().setZone(CALENDAR_ZONE).startOf("day");
  const from = duplicateRangeDate(stringOption(options, "from"), "from", now.minus({ days: 31 }));
  const to = duplicateRangeDate(stringOption(options, "to"), "to", now.plus({ months: 12 }));
  if (from > to) throw new Error("--from må ikke ligge efter --to.");
  const threshold = numericOption(options, "threshold", DEFAULT_TITLE_SIMILARITY);
  const minutes = numericOption(options, "minutes", DEFAULT_TIME_TOLERANCE_MINUTES);

  const repository = await validateAllPublicData(paths.repo).then((result) => result.repository);
  const events = booleanOption(options, "published-only")
    ? repository.events.filter((event) => event.publication === "published")
    : repository.events;
  const expansion = expandEvents(events, from, to);
  const matches = findEventDuplicates(events, expansion.occurrences, {
    minimumTitleSimilarity: threshold,
    timeToleranceMinutes: minutes,
  });
  const range = { from: from.toISODate()!, to: to.toISODate()! };

  if (booleanOption(options, "json")) {
    console.log(JSON.stringify({ range, eventCount: events.length, occurrenceCount: expansion.occurrences.length, matches, warnings: expansion.warnings }, null, 2));
  } else if (!matches.length) {
    console.log(
      `Ingen mulige dubletter blandt ${events.length} events og ${expansion.occurrences.length} forekomster ` +
        `fra ${range.from} til ${range.to}.`,
    );
  } else {
    console.log(
      `Fandt ${matches.length} mulige dubletpar blandt ${events.length} events ` +
        `fra ${range.from} til ${range.to}:`,
    );
    for (const match of matches) {
      console.log(`\n${match.left.id} [${match.left.sourceId}] ${match.left.title}`);
      console.log(`${match.right.id} [${match.right.sourceId}] ${match.right.title}`);
      console.log(`Titellighed: ${Math.round(match.titleSimilarity * 100)} %`);
      const visibleStarts = match.sharedStarts.slice(0, 5);
      for (const start of visibleStarts) {
        console.log(`  ${start.date}: ${start.leftTime} / ${start.rightTime}`);
      }
      if (match.sharedStarts.length > visibleStarts.length) {
        console.log(`  ... og ${match.sharedStarts.length - visibleStarts.length} fælles datoer`);
      }
    }
    for (const warning of expansion.warnings) console.warn(`Advarsel: ${warning}`);
    console.log(
      "\nLøs et fund: npm run events -- deduplicate <kanonisk-event-id> <dublet-event-id ...>",
    );
  }

  if (matches.length && booleanOption(options, "fail-on-found")) process.exitCode = 1;
}

async function confirmRegistryChange(question: string, assumeYes: boolean): Promise<boolean> {
  if (assumeYes) return true;
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("Bekræftelse kræver en terminal; kontrollér forhåndsvisningen og brug --yes til automatisering.");
  }
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await prompt.question(`${question} (j/N): `)).trim().toLocaleLowerCase("da-DK");
    return answer === "j" || answer === "ja" || answer === "y" || answer === "yes";
  } finally {
    prompt.close();
  }
}

async function persistDeduplications(paths: CliPaths, deduplications: Deduplication[]): Promise<void> {
  const hadFile = await exists(paths.deduplications);
  const previous = hadFile ? await readFile(paths.deduplications, "utf8") : undefined;
  await atomicWrite(paths.deduplications, stringifyYaml(deduplications, { lineWidth: 100 }), 0o644);
  try {
    await validateAllPublicData(paths.repo);
  } catch (error) {
    if (previous === undefined) await unlink(paths.deduplications);
    else await atomicWrite(paths.deduplications, previous, 0o644);
    throw error;
  }
}

async function deduplicateCommand(args: string[]): Promise<void> {
  const paths = getPaths();
  const options = parseOptions(args);
  const supported = new Set(["reason", "yes"]);
  const unknown = [...options.values.keys()].filter((name) => !supported.has(name));
  if (unknown.length) throw new Error(`Ukendt flag: --${unknown.join(", --")}`);

  const repository = await validateAllPublicData(paths.repo).then((result) => result.repository);
  const allEvents = [...repository.events, ...repository.suppressedEvents];
  const eventById = new Map(allEvents.map((event) => [event.id, event]));
  const [first, ...rest] = options.positional;
  const assumeYes = booleanOption(options, "yes");

  if (first === "restore") {
    if (rest.length !== 1) throw new Error("deduplicate restore kræver præcis ét dublet-event-id.");
    if (stringOption(options, "reason")) throw new Error("--reason kan ikke bruges sammen med restore.");
    const duplicateEventId = rest[0]!;
    const group = repository.deduplications.find((item) => item.duplicateEventIds.includes(duplicateEventId));
    if (!group) throw new Error(`${duplicateEventId} er ikke registreret som dublet.`);
    const duplicate = eventById.get(duplicateEventId);
    const canonical = eventById.get(group.canonicalEventId)!;
    console.log(
      duplicate
        ? `Gendan: ${duplicate.id} — ${duplicate.title}`
        : `Gendan: ${duplicateEventId} (findes ikke i det aktuelle kildesnapshot)`,
    );
    console.log(`Nuværende kanonisk event: ${canonical.id} — ${canonical.title}`);
    if (!(await confirmRegistryChange("Gendan eventen i kalenderen?", assumeYes))) {
      console.log("Ingen ændringer foretaget.");
      return;
    }
    const updated = repository.deduplications
      .map((item) => item === group
        ? { ...item, duplicateEventIds: item.duplicateEventIds.filter((id) => id !== duplicateEventId) }
        : item)
      .filter((item) => item.duplicateEventIds.length > 0);
    await persistDeduplications(paths, updated);
    console.log(`Gendannede ${duplicateEventId}. Kildedata blev ikke ændret.`);
    return;
  }

  if (!first || rest.length === 0) {
    throw new Error("deduplicate kræver et kanonisk event-id og mindst ét dublet-event-id.");
  }
  const canonical = eventById.get(first);
  if (!canonical) throw new Error(`Ukendt kanonisk event: ${first}`);
  const duplicateIds = [...new Set(rest)];
  if (duplicateIds.includes(first)) throw new Error("Den kanoniske event kan ikke undertrykkes som dublet.");
  const duplicates = duplicateIds.map((id) => {
    const event = eventById.get(id);
    if (!event) throw new Error(`Ukendt dublet-event: ${id}`);
    return event;
  });

  const canonicalAsDuplicate = repository.deduplications.find((item) =>
    item.duplicateEventIds.includes(canonical.id),
  );
  if (canonicalAsDuplicate) {
    throw new Error(`${canonical.id} er allerede undertrykt under ${canonicalAsDuplicate.canonicalEventId}.`);
  }
  for (const duplicate of duplicates) {
    const asCanonical = repository.deduplications.find((item) => item.canonicalEventId === duplicate.id);
    if (asCanonical) throw new Error(`${duplicate.id} er allerede kanonisk for en deduplikeringsgruppe.`);
    const existing = repository.deduplications.find((item) => item.duplicateEventIds.includes(duplicate.id));
    if (existing && existing.canonicalEventId !== canonical.id) {
      throw new Error(`${duplicate.id} er allerede undertrykt under ${existing.canonicalEventId}.`);
    }
  }

  const newDuplicateIds = duplicateIds.filter((id) =>
    !repository.deduplications.some((item) =>
      item.canonicalEventId === canonical.id && item.duplicateEventIds.includes(id),
    ),
  );
  if (!newDuplicateIds.length) {
    console.log("Alle valgte events er allerede registreret under den kanoniske event.");
    return;
  }

  console.log(`Behold: ${canonical.id} [${canonical.source.sourceId}] — ${canonical.title}`);
  for (const duplicate of duplicates.filter((item) => newDuplicateIds.includes(item.id))) {
    console.log(`Undertryk: ${duplicate.id} [${duplicate.source.sourceId}] — ${duplicate.title}`);
  }
  console.log("Kildedata slettes ikke; valget kan fortrydes med deduplicate restore.");
  if (!(await confirmRegistryChange("Registrér deduplikeringen?", assumeYes))) {
    console.log("Ingen ændringer foretaget.");
    return;
  }

  const reason = stringOption(options, "reason");
  const existingGroup = repository.deduplications.find((item) => item.canonicalEventId === canonical.id);
  const updated = existingGroup
    ? repository.deduplications.map((item) => item === existingGroup
      ? {
          ...item,
          duplicateEventIds: [...item.duplicateEventIds, ...newDuplicateIds].sort(),
          ...(reason ? { reason } : {}),
        }
      : item)
    : [
        ...repository.deduplications,
        {
          canonicalEventId: canonical.id,
          duplicateEventIds: newDuplicateIds.sort(),
          ...(reason ? { reason } : {}),
        },
      ].sort((left, right) => left.canonicalEventId.localeCompare(right.canonicalEventId, "da-DK"));
  await persistDeduplications(paths, updated);
  console.log(`Registrerede ${newDuplicateIds.length} dublet${newDuplicateIds.length === 1 ? "" : "ter"}.`);
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  stdio: "inherit" | "pipe" = "inherit",
): Promise<string> {
  const child = spawn(command, args, { cwd, stdio, env: process.env });
  let output = "";
  if (stdio === "pipe") {
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (output += chunk));
    child.stderr?.on("data", (chunk: string) => (output += chunk));
  }
  const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  if (code !== 0) {
    throw new Error(
      `${basename(command)} stoppede${signal ? ` med ${signal}` : ` med kode ${code}`}.` +
        (output.trim() ? `\n${output.trim()}` : ""),
    );
  }
  return output;
}

function isPublishablePath(path: string): boolean {
  return (
    path === "data/categories.yaml" ||
    path === "data/organizers.yaml" ||
    path === "data/sources.yaml" ||
    path === "data/deduplications.yaml" ||
    path === "data/source-status.json" ||
    path.startsWith("data/manual/events/") ||
    path.startsWith("data/overrides/") ||
    path.startsWith("data/imported/")
  );
}

async function changedFiles(repo: string): Promise<string[]> {
  const outputs = await Promise.all([
    run("git", ["diff", "--name-only"], repo, "pipe"),
    run("git", ["diff", "--cached", "--name-only"], repo, "pipe"),
    run("git", ["ls-files", "--others", "--exclude-standard"], repo, "pipe"),
  ]);
  return [...new Set(outputs.flatMap((output) => output.split("\n").filter(Boolean)))].sort();
}

async function publishCommand(args: string[]): Promise<void> {
  const paths = getPaths();
  const options = parseOptions(args);
  await validateAllPublicData(paths.repo);

  const changes = await changedFiles(paths.repo);
  const unexpected = changes.filter((path) => !isPublishablePath(path));
  if (unexpected.length) {
    throw new Error(
      `Kun offentlige kalenderdata kan udgives med denne kommando. Andre ændringer:\n${unexpected.join("\n")}`,
    );
  }

  const upstream = (await run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], paths.repo, "pipe")).trim();
  await run("git", ["fetch", "--prune"], paths.repo);
  try {
    await run("git", ["merge-base", "--is-ancestor", upstream, "HEAD"], paths.repo, "pipe");
  } catch {
    throw new Error("Upstream indeholder commits, som ikke er lokale. Hent og løs dem før udgivelse.");
  }

  if (changes.length) await run("git", ["add", "--", ...changes], paths.repo);
  await run("git", ["diff", "--cached", "--check"], paths.repo);

  const staged = (await run("git", ["diff", "--cached", "--name-only"], paths.repo, "pipe"))
    .split("\n")
    .filter(Boolean);
  const unexpectedStaged = staged.filter((path) => !isPublishablePath(path));
  if (unexpectedStaged.length) {
    throw new Error(`Uventede stagede filer; afbryder:\n${unexpectedStaged.join("\n")}`);
  }
  if (staged.length) {
    const message = stringOption(options, "message") || `data: opdater kalender ${new Date().toISOString()}`;
    await run("git", ["commit", "-m", message], paths.repo);
  }

  // Re-check immediately before push. A concurrent upstream change produces a
  // normal conflict and leaves the local commit available for inspection.
  await run("git", ["pull", "--ff-only"], paths.repo);
  await run("git", ["push"], paths.repo);
  console.log(staged.length ? "Kalenderdata er committed og pushed." : "Lokale commits er pushed; ingen nye datafiler.");
}

export const USAGE = `Ærøkalenderens redaktionsværktøj

Brug:
  npm run events -- create [--from event.yaml] [--publish]
  npm run events -- queue --from event.yaml [--reason tekst] [--evidence tekst]
  npm run events -- collect [source-id ...] [--now ISO-tidspunkt]
  npm run events -- review [--json]
  npm run events -- approve <candidate-id>
  npm run events -- reject <candidate-id> [--reason tekst]
  npm run events -- facebook <offentlig-url> --fetch
  npm run events -- facebook <opslags-url> --details-file tekstfil [--published-at ISO-tid] [--title tekst]
  npm run events -- facebook <offentlig-url> [--event event.yaml] [--details-file tekstfil]
  npm run events -- validate
  npm run events -- duplicates [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--threshold 0.60] [--minutes 30]
                              [--published-only] [--json] [--fail-on-found]
  npm run events -- deduplicate <kanonisk-event-id> <dublet-event-id ...> [--reason tekst] [--yes]
  npm run events -- deduplicate restore <dublet-event-id> [--yes]
  npm run events -- publish [--message "commit-besked"]
`;

export async function dispatch(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  switch (command) {
    case "create":
      return createCommand(args);
    case "queue":
      return queueCommand(args);
    case "collect":
      return collectCommand(args);
    case "review":
      return reviewCommand(args);
    case "approve":
      return approveCommand(args);
    case "reject":
      return rejectCommand(args);
    case "facebook":
      return facebookCommand(args);
    case "validate":
      return validateCommand();
    case "duplicates":
      return duplicatesCommand(args);
    case "deduplicate":
      return deduplicateCommand(args);
    case "publish":
      return publishCommand(args);
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(USAGE);
      return;
    default:
      throw new Error(`Ukendt kommando: ${command}\n\n${USAGE}`);
  }
}
