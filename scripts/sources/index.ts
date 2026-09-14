import { churchDeskSource } from "./churchdesk";
import { facebookSource } from "./facebook-feed";
import { librarySource } from "./library";
import { municipalitySource } from "./municipality";
import type { RegisteredSourceId } from "./registry";
import type {
  CollectionContext,
  CollectionResult,
  FetchLike,
  RawResponseRecorder,
  SourceAdapter,
} from "./types";

export * from "./churchdesk";
export * from "./facebook";
export * from "./facebook-feed";
export * from "./library";
export * from "./municipality";
export * from "./registry";
export * from "./types";

export const SOURCE_ADAPTERS: Record<RegisteredSourceId, SourceAdapter> = {
  "aeroe-kommune": municipalitySource,
  "aeroe-kirkeliv": churchDeskSource,
  "aeroe-bibliotek": librarySource,
  facebook: facebookSource,
};

export interface CollectOptions {
  fetch?: FetchLike;
  now?: Date;
  signal?: AbortSignal;
  recordResponse?: RawResponseRecorder;
}

function context(options: CollectOptions): CollectionContext {
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!fetcher) throw new Error("Denne Node-version har ingen global fetch");
  return {
    fetch: fetcher,
    now: options.now ?? new Date(),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.recordResponse ? { recordResponse: options.recordResponse } : {}),
  };
}

export function collectSource(
  sourceId: RegisteredSourceId,
  options: CollectOptions = {},
): Promise<CollectionResult> {
  return SOURCE_ADAPTERS[sourceId].collect(context(options));
}

export async function collectAllSources(
  options: CollectOptions & { sourceIds: RegisteredSourceId[] },
): Promise<CollectionResult[]> {
  const collectionContext = context(options);
  return Promise.all(
    options.sourceIds.map((sourceId) => SOURCE_ADAPTERS[sourceId].collect(collectionContext)),
  );
}
