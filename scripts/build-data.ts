import { DateTime } from "luxon";
import { CALENDAR_ZONE } from "../src/lib/schedule";
import { writeGeneratedData } from "../src/lib/repository";

const requestedNow = process.env.AEROEVENTS_NOW;
const now = requestedNow
  ? DateTime.fromISO(requestedNow, { zone: CALENDAR_ZONE })
  : DateTime.now().setZone(CALENDAR_ZONE);

if (!now.isValid) {
  console.error(`Ugyldig AEROEVENTS_NOW: ${requestedNow}`);
  process.exitCode = 1;
} else {
  try {
    const result = await writeGeneratedData(process.cwd(), now, {
      includeDrafts: process.env.AEROEVENTS_INCLUDE_DRAFTS === "1",
    });
    console.log(`Byggede ${result.publicEvents.length} events og ${result.occurrences.length} forekomster.`);
    for (const warning of result.metadata.warnings) console.warn(`Advarsel: ${warning}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
