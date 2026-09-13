import { basename, join } from "node:path";
import { readFile, unlink } from "node:fs/promises";
import { atomicWriteJson, digest, ensureDirectory, listFiles } from "./files.js";
import type { CliPaths } from "./config.js";

export interface ReviewCandidate {
  version: 1;
  candidateId: string;
  candidateKey: string;
  payloadDigest: string;
  sourceId: string;
  sourceEventId?: string;
  sourceUrl: string;
  discoveredAt: string;
  reasons: string[];
  event: unknown;
  private?: Record<string, unknown>;
}

export interface CandidateInput {
  sourceId: string;
  sourceEventId?: string;
  sourceUrl: string;
  discoveredAt: string;
  reasons?: string[];
  event: unknown;
  private?: Record<string, unknown>;
}

interface ApprovedDecision {
  candidateId: string;
  candidateKey: string;
  payloadDigest: string;
  decidedAt: string;
  publicPath: string;
}

function decisionPath(directory: string, candidateId: string): string {
  return join(directory, `${candidateId}.json`);
}

function candidateIdentity(input: Pick<CandidateInput, "sourceId" | "sourceEventId" | "event">) {
  const candidateKey = `${input.sourceId}:${input.sourceEventId || digest(input.event)}`;
  return { candidateKey, candidateId: digest(candidateKey).slice(0, 16) };
}

async function readJsonIfPresent<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function reviewPayloadDigest(event: unknown, reasons: string[] = []): string {
  const reviewReasons = [...new Set(reasons.map((reason) => reason.trim()).filter(Boolean))].sort();
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return digest({ event, reasons: reviewReasons });
  }
  const record = event as Record<string, unknown>;
  const source = record.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return digest({ event, reasons: reviewReasons });
  }
  const stableSource = { ...(source as Record<string, unknown>) };
  delete stableSource.verifiedAt;
  const stableEvent: Record<string, unknown> = { ...record, source: stableSource };
  delete stableEvent.publication;
  return digest({ event: stableEvent, reasons: reviewReasons });
}

export async function initializeReviewStore(paths: CliPaths): Promise<void> {
  await Promise.all([
    ensureDirectory(paths.reviewPending),
    ensureDirectory(paths.reviewApproved),
    ensureDirectory(paths.reviewRejected),
    ensureDirectory(paths.raw),
  ]);
}

export async function enqueueCandidate(
  paths: CliPaths,
  input: CandidateInput,
): Promise<"created" | "updated" | "already-pending" | "approved" | "rejected"> {
  await initializeReviewStore(paths);
  const { candidateKey, candidateId } = candidateIdentity(input);
  const reasons = [...new Set((input.reasons || []).map((reason) => reason.trim()).filter(Boolean))];
  const payloadDigest = reviewPayloadDigest(input.event, reasons);
  const approvedPath = decisionPath(paths.reviewApproved, candidateId);
  const rejectedPath = decisionPath(paths.reviewRejected, candidateId);
  const pendingPath = decisionPath(paths.reviewPending, candidateId);

  if (await readJsonIfPresent(rejectedPath)) return "rejected";
  const approved = await readJsonIfPresent<ApprovedDecision>(approvedPath);
  if (approved?.payloadDigest === payloadDigest) {
    // A temporary risk (for example a cross-source duplicate) may have put a
    // changed context in the inbox. Remove that stale work when the exact
    // editor-approved event and reason set returns.
    await unlink(pendingPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return "approved";
  }

  const existing = await readJsonIfPresent<ReviewCandidate>(pendingPath);
  if (existing?.payloadDigest === payloadDigest) return "already-pending";

  const candidate: ReviewCandidate = {
    version: 1,
    candidateId,
    candidateKey,
    payloadDigest,
    sourceId: input.sourceId,
    ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}),
    sourceUrl: input.sourceUrl,
    discoveredAt: input.discoveredAt,
    reasons: [
      ...reasons,
      ...(approved ? ["Kandidaten har ændret sig siden sidste godkendelse"] : []),
    ],
    event: input.event,
    ...(input.private ? { private: input.private } : {}),
  };
  await atomicWriteJson(pendingPath, candidate);
  return existing || approved ? "updated" : "created";
}

export async function getReviewDecision(
  paths: CliPaths,
  input: Pick<CandidateInput, "sourceId" | "sourceEventId" | "event">,
): Promise<"approved" | "rejected" | "pending" | undefined> {
  const { candidateId } = candidateIdentity(input);
  if (await readJsonIfPresent(decisionPath(paths.reviewRejected, candidateId))) return "rejected";
  if (await readJsonIfPresent(decisionPath(paths.reviewApproved, candidateId))) return "approved";
  if (await readJsonIfPresent(decisionPath(paths.reviewPending, candidateId))) return "pending";
  return undefined;
}

export async function clearPendingCandidate(
  paths: CliPaths,
  input: Pick<CandidateInput, "sourceId" | "sourceEventId" | "event">,
): Promise<void> {
  const { candidateId } = candidateIdentity(input);
  await unlink(decisionPath(paths.reviewPending, candidateId)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export async function listPending(paths: CliPaths): Promise<ReviewCandidate[]> {
  const files = await listFiles(paths.reviewPending);
  return Promise.all(
    files.map(async (file) => JSON.parse(await readFile(file, "utf8")) as ReviewCandidate),
  );
}

export async function findPending(paths: CliPaths, idOrPrefix: string): Promise<ReviewCandidate> {
  const files = await listFiles(paths.reviewPending);
  const matches = files.filter((file) => basename(file, ".json").startsWith(idOrPrefix));
  if (matches.length === 0) throw new Error(`Ingen ventende kandidat matcher '${idOrPrefix}'.`);
  if (matches.length > 1) throw new Error(`Flere kandidater matcher '${idOrPrefix}'; brug flere tegn.`);
  const file = matches[0];
  if (!file) throw new Error("Kandidaten forsvandt under opslaget.");
  return JSON.parse(await readFile(file, "utf8")) as ReviewCandidate;
}

export async function markApproved(
  paths: CliPaths,
  candidate: ReviewCandidate,
  publicPath: string,
): Promise<void> {
  const decision: ApprovedDecision = {
    candidateId: candidate.candidateId,
    candidateKey: candidate.candidateKey,
    payloadDigest: candidate.payloadDigest,
    decidedAt: new Date().toISOString(),
    publicPath,
  };
  await atomicWriteJson(decisionPath(paths.reviewApproved, candidate.candidateId), decision);
  await unlink(decisionPath(paths.reviewPending, candidate.candidateId));
}

export async function markRejected(
  paths: CliPaths,
  candidate: ReviewCandidate,
  reason: string,
): Promise<void> {
  await atomicWriteJson(decisionPath(paths.reviewRejected, candidate.candidateId), {
    ...candidate,
    decision: { status: "rejected", reason, decidedAt: new Date().toISOString() },
  });
  await unlink(decisionPath(paths.reviewPending, candidate.candidateId));
}
