import { aeldresagenSource } from "./aeldresagen";
import { aeroeHotelEventsSource } from "./aeroe-hotel-events";
import { aeroeskoebingGrandPrixSource } from "./aeroeskoebing-grand-prix";
import { campusSource } from "./campus";
import { churchDeskSource } from "./churchdesk";
import { dnEventsSource } from "./dn-events";
import { facebookSource } from "./facebook-feed";
import { folkedansSource } from "./folkedans";
import { folkeuniversitetSource } from "./folkeuniversitet";
import { klatreklubSource } from "./klatreklub";
import { kunsthoejskolenSource } from "./kunsthoejskolen";
import { librarySource } from "./library";
import { marnavSource } from "./marnav";
import { momoyogaSource } from "./momoyoga";
import { motorfabrikkenSource } from "./motorfabrikken";
import { municipalityEventsSource } from "./municipality-events";
import { municipalitySource } from "./municipality";
import { ommelBkSource } from "./ommel-bk";
import { ommelSamvirkeSource } from "./ommel-samvirke";
import { parkinsonAeroeSource } from "./parkinson-aeroe";
import { riseSifSource } from "./rise-sif";
import { soebyLokalraadSource } from "./soeby-lokalraad";
import { tennisklubSource } from "./tennisklub";
import { viftenSource } from "./viften";
import type { RegisteredSourceId } from "./registry";
import type {
  CollectionContext,
  CollectionResult,
  FetchLike,
  RawResponseRecorder,
  SourceAdapter,
} from "./types";

export * from "./aeldresagen";
export * from "./aeroe-hotel-events";
export * from "./aeroeskoebing-grand-prix";
export * from "./campus";
export * from "./churchdesk";
export * from "./dn-events";
export * from "./facebook";
export * from "./facebook-feed";
export * from "./folkedans";
export * from "./folkeuniversitet";
export * from "./klatreklub";
export * from "./kunsthoejskolen";
export * from "./library";
export * from "./marnav";
export * from "./momoyoga";
export * from "./motorfabrikken";
export * from "./municipality-events";
export * from "./municipality";
export * from "./ommel-bk";
export * from "./ommel-samvirke";
export * from "./parkinson-aeroe";
export * from "./registry";
export * from "./rise-sif";
export * from "./soeby-lokalraad";
export * from "./tennisklub";
export * from "./types";
export * from "./viften";

export const SOURCE_ADAPTERS: Record<RegisteredSourceId, SourceAdapter> = {
  "aeroe-kommune": municipalitySource,
  "aeroe-kirkeliv": churchDeskSource,
  "aeroe-bibliotek": librarySource,
  facebook: facebookSource,
  "rise-sif": riseSifSource,
  "dn-aeroe": dnEventsSource,
  "ritual-momoyoga": momoyogaSource,
  "aeroe-kommune-events": municipalityEventsSource,
  "aeldresagen-aeroe": aeldresagenSource,
  "aeroe-folkedans": folkedansSource,
  viften: viftenSource,
  "aeroe-folkeuniversitet": folkeuniversitetSource,
  motorfabrikken: motorfabrikkenSource,
  "ommel-bk": ommelBkSource,
  marnav: marnavSource,
  "campus-aeroe": campusSource,
  "ommel-samvirke": ommelSamvirkeSource,
  "kunsthoejskolen-aeroe": kunsthoejskolenSource,
  "soeby-lokalraad": soebyLokalraadSource,
  "aeroe-hotel-events": aeroeHotelEventsSource,
  "aeroeskoebing-grand-prix": aeroeskoebingGrandPrixSource,
  "aeroe-klatreklub": klatreklubSource,
  "aeroe-tennisklub": tennisklubSource,
  "parkinsonforeningen-aeroe": parkinsonAeroeSource,
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
