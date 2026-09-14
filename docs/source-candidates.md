# Kildeinventar og implementeringsnoter

Status: undersøgt 13.-14. september 2026 og tredje integrationsrunde afsluttet
14. september 2026. URLs og tekniske detaljer kontrolleres fortsat ved hver
indsamling.

Direkte kilder hos arrangøren eller den ansvarlige myndighed bør have forrang.
En aggregator er nyttig til at opdage huller, men må ikke overskrive bedre data
fra en direkte kilde. Nye adaptere starter i gennemsyn, indtil fixtures viser, at
ID'er, datoer, aflysninger og tomme svar håndteres sikkert. Kilder med et
ensartet eventobjekt eller en ensartet eventdialog kan derefter publicere valide
poster automatisk; kendte undtagelser forbliver på kandidatniveau i gennemsyn.

## Implementeret første bølge

Alle 13 kilder og berigelser i tabellen er implementeret med fixtures,
strukturel validering, atomisk fejlhåndtering og den angivne publiceringsregel.

| Prioritet | Kilde | Udbytte og format | Foreslået publicering |
| --- | --- | --- | --- |
| 1 | [Rise Skytte- & Idrætsforening](https://www.rise-sif.dk/) | Conventus har offentlige JSON-endpoints for ressourcer og bookinger. Kontrollen gav 580 daterede forekomster i 30 serier og enkeltaktiviteter frem til april 2027, blandt andet badminton, gymnastik, dans, yoga, pilates og spinning. Hver forekomst har `booking.id`, og serien har eget ID. | Automatisk for allowlistede hold og foreningsevents. Udelad navnløse eller generiske lokalebookinger, bevar medlems-/tilmeldingskrav, og gem aldrig deltagernes bookingdata. |
| 2 | [Danmarks Naturfredningsforening](https://arrangementer.dn.dk/) | Det offentlige søge-API kan filtreres direkte på Ærøs kommunekode `0492`. Kontrollen fandt tre kommende lokale arrangementer med stabilt numerisk ID, tid med offset, sted, pris, tilmelding, aflysning og arrangørafdeling. | Automatisk for offentlige resultater i kommune `0492`, efter dubletkontrol mod VisitÆrø og de lokale værter. |
| 3 | [Ritual – Ærø hos Momoyoga](https://www.momoyoga.com/nurtureaeroe/schedule) | Den offentlige ugeplan har server-renderede data, numeriske lektions-ID'er, start/slut med korrekt København-offset, underviser, lokale, kapacitet, aflysning og et ICS-link pr. lektion. Kontrollen fandt 106 Flow Yoga-lektioner i de næste 12 måneder. | Automatisk for en allowlist af gruppehold. Udelad massage, ansigtsbehandlinger og andre individuelle tider. |
| 4 | [Ærø Kommune: Det sker](https://www.aeroekommune.dk/om-kommunen/kommunikation-og-presse/det-sker) | Officielle borgerarrangementer, blandt andet borgermøder og kommunale tilbud. Server-renderet liste og detaljesider med dato, tid, sted, pris og links. Detaljesiden har et stabilt `meta[name=pageid]`. | Automatisk efter dubletkontrol mod mødeplanen og biblioteket. Et udeladt årstal bruges kun med to ens synlige datoangivelser, korrekt ugedag og en tilstødende `cmspageactiveto`-dato. |
| 5 | [Ældre Sagen Ærø](https://www.aeldresagen.dk/lokalafdelinger/aeroe/aktiviteter-og-kurser?sortering=dato) | Ugentlig motion, spil, fællesspisning, caféer, møder og foredrag. Detalje-URL'en indeholder et stabilt numerisk aktivitets-ID og angiver adgang, gentagelse, næste dato, tid og eventuelt mødested. | Automatisk; for gentagelser publiceres kun kildens næste eksplicitte forekomst, og et manglende valgfrit mødested udelades. Bevar medlems- og tilmeldingskrav. |
| 6 | [Ærø Folkedanserforening](https://6165826142842.site123.me/) | Server-renderede eventkort med stabilt `data-unique-id` og detail-URL. Der var 24 kommende familie- og voksenarrangementer frem til marts 2027. Siden gengiver eventsektionen to gange. | Automatisk efter deduplikering på `data-unique-id`. Brug kun "kommende begivenheder"; ens start/slut behandles som manglende sluttid, mens sluttider før start sendes til review. |
| 7 | [Viften: Ture og begivenheder](https://www.viften.net/ture) | Kommunale fritidstilbud til børn og unge. Kortene linker til `/subjectclass/<guid>`; detaljen indeholder dato, alder/klassetrin, pris, frist og tilmeldingsstatus. | Automatisk med `boern-familie`; alderskrav skal stå i adgangsdetaljen. |
| 8 | [Ærø Folkeuniversitet](https://fuko.dk/komite/aeroe-folkeuniversitet/) | Offentlige foredrag med dato, sted, pris og eksplicit `Aflyst`/`Afholdt`. Simpel HTML uden pagination; WordPress REST har ændringstidspunkter. | Automatisk. Brug den kanoniske kursus-URL som kilde-ID, da et kursus kan blive genoprettet med et nyt WordPress-ID. |
| 9 | [Motorfabrikken Marstal](https://www.motorfabrikkenmarstal.com/kultur) | Den officielle kulturkalender sælger billetter gennem en struktureret Ticketbutler-kilde med stabilt numerisk ID og UUID, starttid, venue, pris, booking og `is_sold_out`. | Automatisk efter validering af tenant/hostname; den direkte kilde vinder over VisitÆrøs samlepost. |
| 10 | [Ommel BK hos DBU Fyn](https://www.dbufyn.dk/resultater/klub/1464/kampprogram) | DBU's kampprogram har stabile match-ID'er, pulje, hold, status, dato, tid og stadion. To kommende hjemmekampe blev fundet. | Genbrug Marstal IF-parseren. Hent først den aktuelle puljeliste; et `pools=0`-indeks må ikke hardcodes. Publicér kun hjemmekampe på Ærø. |
| 11 | [Marstal Navigationsskole](https://marnav.nemtilmeld.dk/) | NemTilmeld-detaljer har schema.org Event JSON-LD og stabile numeriske ID'er. Der var to kommende offentlige åbent-hus-arrangementer; begge var fuldt bookede med venteliste. | Automatisk for en snæver allowlist som `Åbent hus`; læs også synlig kapacitetsstatus. Send erhvervskurser til review eller udelad dem. |
| 12 | [FirstAgenda](https://dagsordener.aeroekommune.dk/) | Autoritative rettelser til kommunale møder. Efter et anonymt cookie-kald til forsiden returnerer `GET /api/agenda/udvalgsliste` JSON med stabile møde-GUID'er, start/slut med offset, sted, publiceringstid og status. | Berig den eksisterende kommunekilde; opret ikke dubletter. Publicér automatisk for Kommunalbestyrelsen. |
| 13 | [Campus Ærø](https://campusaeroe.dk/events/) | The Events Calendars offentlige [REST-endpoint](https://campusaeroe.dk/wp-json/tribe/events/v1/events) gav 196 fremtidige forekomster med pagination, numerisk ID, start/slut, ændringstid, status, venue og kanonisk URL. Kalenderen blander offentlige kultur-, sundheds- og værkstedsarrangementer med undervisning og lukkede skole-/personaleforløb. | Automatisk for strukturelt valide poster i den positive kategori-allowlist, efter at skjulte og tydeligt interne målgrupper er udeladt. Bevar alder og tilmelding, og send dubletter mod blandt andet biblioteket, Motorfabrikken, Atma og Søbygaard til gennemsyn. |

FirstAgenda bør kombineres med den eksisterende
[årsplan](https://www.aeroekommune.dk/politik-og-indflydelse/moedeplaner):
årsplanen giver datoer langt frem, mens FirstAgenda først bliver autoritativ, når
en dagsorden udgives. Bevar det nuværende permanente event-ID, men gem
FirstAgenda-mødets GUID som source-ID og brug det til at genkende et flyttet
møde.

Årsplanen indeholder også Økonomi- og Erhvervsudvalget, Teknik-, Miljø- og
Havneudvalget, Kultur- og Socialudvalget, Bevillingsnævnet og to
lokalplanudvalg. De stående udvalgs møder er lukkede for offentligheden. De må
derfor ikke få adgangstypen `public`; udvid først modellen med en tydelig
"lukket møde"-markering, eller hold dem ude af kalenderen. Direktionen skal
altid udelades.

DN's API ligger under
`https://func-dn-events-production-003.azurewebsites.net/api`. Kommunelisten
bekræfter `0492` som Ærø, og `GET /events/search` accepterer blandt andet
`municipalityCodes`, `pageIndex`, `pageSize` og `eventTypeIds`. Hent detaljen
med `GET /events/<id>`, hvor beskrivelse, offentlig/privat-markering,
tilmeldingsdata, adresse, koordinater og lokalafdeling findes. Paginationen var
0-indekseret, men `hasNextPage` var sand på den sidste ikke-tomme side; stop
derfor også på et tomt svar og kontrollér det rapporterede sideantal.

Momoyogas plan kan bladres med `?date=YYYY-MM-DD`. Hver forekomst linker til
`/nurtureaeroe/lesson/<numerisk-id>/<slug>` og til en ICS-eksport med
`TZID=Europe/Copenhagen`. ICS-filen mangler `UID`, så det numeriske lektions-ID
skal være source-ID. De samme uger indeholdt 212 bookbare massage- og
ansigtsbehandlingstider; adapteren skal derfor acceptere kendte holdnavne frem
for blot at importere alt, der ligner en tidsbestilling.

Motorfabrikkens Ticketbutler-tenant bruger endpoints under
`https://checkoutapi.ticketbutler.io/api/`, blandt andet
`events/calendar-start-date/`, `events/calendar/?year=<år>&month=<måned>`,
`events/list/?date=<dato>` og `events/title/<slug>/`. Kaldet kræver tenantens
`Origin`/`Referer`; adapteren skal kontrollere, at svaret fortsat tilhører
Motorfabrikken, før poster accepteres.

Rise SIF's Conventus-kilde starter med
`GET https://www.conventus.dk/publicBooking/public/getResources?organization=206`.
De aktuelle aktivitetsressourcer havde ID 247 og 248. Forekomster hentes med
`POST https://www.conventus.dk/publicBooking/public/getBookings`, hvor body har
`organization: {"id": 206}`, den ønskede `from`/`to`-periode, de fundne
ressource-ID'er og `overlap: true`. Tidspunkterne er epoch-millisekunder og gav
samme lokale tider hen over normaltidsskiftet. Spinning kan desuden vise
kapacitet og samlet antal tilmeldinger; adapteren må ikke hente eller gemme
oplysninger om de enkelte bookinger.

Navigationsskolens to kommende offentlige poster var
[åbent hus 16. januar 2027](https://marnav.nemtilmeld.dk/647/) og
[åbent hus 30. januar 2027](https://marnav.nemtilmeld.dk/648/). Status som
fuldt booket/venteliste står uden for JSON-LD og skal derfor parses særskilt.

## Anden bølge og videre backlog

De første otte rækker — fra Ommel Samvirke til Ærøskøbing Grand Prix — er nu
implementeret. En tredje integrationsrunde tilføjede desuden Ærø Rideklub,
Marstal IF, Ærø Golf Klub, Marstal Billard Klub og Ærøskøbing Sejlklub. De
øvrige rækker forbliver dokumenteret backlog og aktiveres først, når en konkret
kommende post kan valideres sikkert.

| Kilde | Teknisk vej | Redaktionel regel |
| --- | --- | --- |
| [Ommel Samvirkes aktivitetskalender](https://www.ommelsamvirke.dk/aktivitetskalender) | Den anonyme Blazor-kalender viste 292 forekomster i 16 aktiviteter fra 14. september 2026 til 13. september 2027. Den samler otte lokale foreninger og har blandt andet gåture, gymnastik, dart, strik, petanque, IT-hjælp, fredagsbar, fællesspisning og møder. Detaljedialogen har tid, sted, kategori, beskrivelse, arrangør og kontakt. | Automatisk for komplette poster fra den ensartede detaljedialog. Manglende sted eller beskrivelse samt pris, tilmelding eller status, der kun står i fritekst, sendes til gennemsyn. Det offentlige [`calendar.ics`](https://www.ommelsamvirke.dk/calendar.ics) er defekt og bruges ikke. |
| [Søby Lokalråd](https://soebylokalraad.dk/11/en/node/12) | Drupal-siden og dens [RSS-feed](https://soebylokalraad.dk/11/en/rss.xml) har stabile node-GUID'er. Den løbende referatside indeholdt fire kommende lokale forekomster: to boguddelinger/åbent hus, et bestyrelsesmøde og Aktivitetshusets åbent hus. | Gennemsyn. RSS-datoen ændres ikke, når referatsiden opdateres, og node-ID'et dækker flere events; hent hele siden, brug content-digest og sammensatte event-ID'er. Bestyrelsesmødets adgang er ukendt. |
| [Ærø Klatreklub](https://aekk.klub-modul.dk/default.aspx) | KlubModul-siden angiver fire gentagelser: børneklub og fri klatring mandag, fri klatring onsdag samt anden søndag i måneden. Den separate eventside og JSON-kilde er tomme. | Manuel gentagelse eller gennemsyn, indtil klubben bekræfter sæson og ferieundtagelser. De fire tekstblokke har ingen ID'er; brug sammensatte serienøgler og bevar medlemskrav. |
| [Ærø Tennisklub](https://aeroetennisklub.dk/faste-aktiviteter/) | WordPress REST-side `22` blev ændret i maj 2026 og angiver fem ugentlige aktiviteter med klokkeslæt, målgruppe og enkelte kapacitetskrav. | Manuel gentagelse eller gennemsyn. Siden siger kun "i sæsonen" uden start/slut; indhent sæsongrænser og gæt ikke forekomster fra banebookinger. |
| [Parkinsonforeningen: Klub Ærø](https://parkinson.dk/kredse/2823-fyn/klubber/) | Fynskredsens direkte klubside angiver første tirsdag hver måned kl. 15-16.30 i Rise Beboerhus og har et stabilt WordPress-klub-ID. | Bounded gentagelse til gennemsyn med klub-ID og regel som identitet. Kontrollér undtagelser ved hver indsamling og mærk medlemsadgang tydeligt. |
| [Kunsthøjskolen på Ærø](https://www.kunstaeroe.dk/for-og-efter%C3%A5rskurser) | Cargo-siden indeholder gyldigt `window.__PRELOADED_STATE__` med stabile side-ID'er, `purl`, tekst, priser og tilmeldingslinks. Fire kommende kurser blev fundet fra 4. oktober til 7. november 2026; tre var udsolgt. | Automatisk efter fixture og et første gennemsyn. Skolen er den direkte kilde og vinder over Højskolerne.dk; bevar `UDSOLGT`. |
| [Ærø Hotel: events](https://www.aeroehotel.dk/event-list) | Wix' `wix-warmup-data` har UUID, slug, tidszone, sted, publiceringstid, billetlink og ICS. En kommende koncert med Johnny Hansen stod to gange med samme tid, men to UUID'er og kun ét korrekt venue. Hotellet har desuden daterede [strikkeworkshops](https://www.aeroehotel.dk/smuttur-1-2) og [veteranbilstræf](https://www.aeroehotel.dk/smuttur-2-1-1). | Automatisk for entydige, komplette Wix Events-poster og kun med tidsintervallet fra `scheduling.config`. Uklart sted, status eller registrering forbliver i gennemsyn; flere betroede UUID'er med samme titel og tidspunkt demoteres som mulige dubletter. |
| [Ærøskøbing Grand Prix](https://www.xn--rgrandprix-c6a1t.dk/) | Wix-siden havde fire eksplicitte dage 12.-15. oktober 2026 kl. 9-12 med alder, kapacitet, pris og tilmelding. Der er intet selvstændigt eventobjekt. | Gennemsyn og årlig import med `arrangør+år` som kilde-ID. Deduplikér mod VisitÆrøs GuideDanmark-post. |
| [Beth Mohr: malekursus på Ærø](https://bethmohr.dk/shop/17-malekursus-paa-aeroe/) | Webshoppen har et offentligt produkt-endpoint på `/json/products`; det daterede kursus 21.-25. september 2026 har stabilt produkt-ID `215`, priser, varianter og lagerfelter. | Kun gennemsyn. Datoen står i titlen, kategoriens prosa modsiger varighed/pris, og lagerstatusfelterne er indbyrdes uenige. Udelad produkter uden faste datoer. |
| [Gravendal: strikkeretreat](https://gravendalbedandbreakfast.dk/strikke-retreat) | Den direkte, statiske detaljeside beskriver et retreat 30. oktober-1. november 2026 med program, ophold og priser. Siden har ingen struktureret eventpost eller andet stabilt ID end sidens slug. | Gennemsyn og sæsonkontrol. Brug `slug+startdato` som ID, bevar at det er et ophold, og gæt ikke enkelttidspunkter ud fra programteksten. |
| [Yogaschule Flensburg: retreat hos Atma](https://www.yogaschule-flensburg.de/retreats) | Squarespace-siden og `?format=json` beskriver et udsolgt retreat 11.-13. juni 2027 med program, undervisere, pris, kapacitet og venteliste. | Kun gennemsyn. Brug sideankeret og startdatoen som sammensat ID, og kontrollér overlap mod Atmas egen kalender. |
| [Ærø Rideklub](https://www.aeroerideklub.dk/events-1) | Den offentlige, server-renderede Squarespace-side har kanoniske detail-slugs, ISO-datoer, lokale tider, beskrivelser og status. Sidens `robots.txt` fravælger `?format=json` og `?format=ical`, så adapteren bruger kun almindelig HTML. Kontrollen fandt ét fremtidigt arrangement. | Implementeret til gennemsyn. Kilden blander offentlige stævner med arbejdsdage og medlemsaktiviteter, og midnatsstart eller uklar adgang markeres eksplicit. |
| [Ærø Jazz Festival](https://www.aeroejazzfestival.dk/program-tidspunkter/) | WordPress-side `9188` kan hentes gennem `/wp-json/wp/v2/pages/9188`; programtabellen har dato, tid, kunstner, venue og adgang. Billetprodukter har stabile WooCommerce-ID'er. | Gennemsyn. Brug `festivalår+dato+tid+kunstner+venue` som ID; HTML kan indeholde udsolgte eller efterladte programrækker. Bevar både festivalen og de enkelte koncerter. |
| [Ærø Bryggeri](https://aeroebryggeri.dk/events/) | Modern Events Calendar-poster findes via `/wp-json/wp/v2/mec-events?per_page=100` med stabile WordPress-ID'er, ændringstid og pagination. Læs synlig dato/tid og status fra detaljesiden. | Gennemsyn først. JSON-LD viste forkert tidszone og valuta ved kontrollen. Udelad almindelige åbningstider og fler-måneders butiksposter. |
| [Marstal IF: kommende kampe](https://www.marstalif.dk/fodbold/kommende-kampe/) | Den server-renderede DBU-tabel har stabilt `matchid` samt dato, tid, hold, pulje, spillestatus og stadion. Livekontrollen 14. september gav 19 fremtidige hjemmekampe efter sted- og hjemmeholdsfilter. | Implementeret automatisk for fremtidige hjemmekampe på stadion i Marstal; udekampe og ikke-lokale rækker udelades. `poolrowid` bruges kun i detail-URL'en, ikke som permanent kampidentitet. |
| [Marstal Billard Klub: kommende kampe](https://spiller.ddbu-admin.dk/?m=1005&klubnr=511) | DDBU's server-renderede kampprogram har stabile numeriske kamp-ID'er, dato, turnering og hjemme-/udehold. Livekontrollen gav 10 fremtidige hjemmekampe; udekampe og frirunder kan afgrænses sikkert. | Implementeret til gennemsyn. Kilden oplyser hverken starttid eller offentlig tilskueradgang, så adapteren gætter ikke og publicerer ikke automatisk. |
| [Ærøskøbing Sejlklub](https://www.aeroeskoebing-sejlklub.dk/) | Siden indlejrer en offentlig Google Calendar med stabile UID'er, lokale/UTC-tider, heldagsdatoer og ugentlige gentagelser. Livekontrollen gav fire kommende klubaktiviteter efter udeladelse af 42 klubhusbookinger og én aktivitet uden for Ærø. | Implementeret til gennemsyn. `Klubhus udlejet`/`optaget` og eksplicitte steder uden for Ærø kasseres; eksklusive iCal-slutdatoer og gentagelsesundtagelser normaliseres uden at gætte adgang. |
| [Bio Andelen](https://www.bio-andelen.dk/) | Programmet kan hentes som WordPress-side via `/wp-json/wp/v2/pages/7`. Teksten bruger datointervaller, undtagne mandage og ekstra matinéer. | Gennemsyn. Udvid kun kendte tekstmønstre til visninger, og stop ved et ukendt mønster. |
| [Ærø Golf Klub: turneringer](https://www.aeroegolf.dk/turneringer.aspx) | Den årlige, server-renderede HTML-liste har dato, turneringsform og markering af åbne turneringer. Kontrollen fandt én resterende turnering 4. oktober 2026; siden oplyser ikke starttid. | Implementeret til gennemsyn med `sæson+titel` som identitet, DGU-/medlemsadgang bevaret og flerdagsturneringer som eksplicitte datoer. |
| [Søbygaardkoncerterne](https://www.soebygaardkoncerterne.dk/) | Sæsonprogram i statisk HTML med titel, dato, tid, beskrivelse og billetpris. | Automatisk efter en fixture; brug koncertens detail-slug, ellers `år+dato+titel`, som kilde-ID. |
| [Marstal Søfartsmuseum](https://service.marmus.dk/da/besog-museet/nyt-pa-museet) | Nyheds-/arrangementskort i HTML. | Gennemsyn; gammelt CMS og flere værtsnavne gør kilden skrøbelig. |
| [Ærø Museum](https://aeroemuseum.dk/) | Arrangementer kan findes som WordPress-poster via `/wp-json/wp/v2/posts?categories=8&per_page=100&_embed`, men web application firewall returnerede også HTTP 455 ved gentagne API-kald. Datoer og fuldt-booket-status står i brødtekst/Divi-markup. | Gennemsyn med langsomme kald, retries og sidste-gode-snapshot. |
| [Ærøskøbing Idrætsklub](https://www.aeik.dk/newlook/proc_liste.asp?valgt_holdtype=9999) | Den ugentlige, server-renderede plan har forekomst-ID'er. Senere uger kræver samme session, skjulte formularfelter og POST med en måldato. Kontrollen viste blandt andet indoor cycling og eksplicit tomme ferieuger. | Gennemsyn først. Parse kun listen, behold sidste gode snapshot, og mærk holdaktiviteter som medlemskrævende. |
| [Ærø Bridgeklub](https://www.bridge.dk/4596/Turneringsoversigt.html) | BridgeCentral-siden har en aktuel 2026/27-plan med faste mandags-/onsdagstider, datointervaller, julefrokost og generalforsamling. | Gennemsyn; der er ingen event-ID'er, så brug klub, sæson og blok/dato i en sammensat nøgle. Bevar pris og gæsteadgang. |
| [Marstal Marineforening](https://www.marstalmarineforening.dk/aktiviteter/) | Server-renderet prosaside med ugentligt søndagsåbent, medlemsfester og et offentligt julemarked. | Gennemsyn. Parse eksplicitte datoer og gentagelser, brug sammensatte nøgler, og bevar medlemsmarkeringen. |
| [Atma Yoga House](https://www.atmayogahouse.com/yoga-schedule?format=json) | Squarespace JSON og ICS har stabile item-ID'er/UID'er. Seks kommende poster blev fundet. En hel ugentlig sæson er dog kodet som ét langt event uden RRULE; antal gange og undtagelser står i teksten. | Gennemsyn. Omsæt aldrig det lange interval direkte; opret først en gentagelse, når tekstens sessioner og undtagelser er entydige. |
| [Ærø Fotoklub](https://www.aeroefotoklub.dk/program) | Programmet har aktuelle klubaftener, men flere trykte datoer modsiger de angivne ugenumre. | Kun discovery og manuel korrektion, indtil kilden er konsistent. |
| [Marstal Sejl- og Roklub](https://marstalsejlogroklub.dk/kalendar/) | Den statiske årsplan havde seks daterede arrangementer i december 2025-marts 2026 samt beskrivelser af årlige sejladser og fester. Der er ingen stabile event-ID'er, alle viste datoer var passeret, og almindelige scriptkald gav HTTP 455 ved kontrollen. | Manuelt gennemsyn og årlig kontrol. Brug `år+dato+titel` som ID, bevar medlemskrav, og publicér kun de arrangementer, hvor gæsteadgang eller offentlig adgang fremgår. Aktivér ingen adapter uden en almindeligt tilgængelig fixture. |
| [Teglværkspladsen / Ærø Kajak & SUP](https://teglvaerkspladsen.dk/kurser-ture/) | WooCommerce-siden viste et IPP2-begynderkursus med eksplicitte 2026-datoer sammen med introer, ture og private instruktørprodukter. Produkterne har egne detail-URL'er og pris/varianter, men ikke alt er en kalenderbegivenhed; almindelige scriptkald gav HTTP 455. | Manuelt gennemsyn. Importér kun navngivne gruppeforløb med fast dato; udelad private guider, bestillingsvarer og ture efter aftale. Deduplikér mod den allerede registrerede Facebook-side, og omgå ikke adgangsbegrænsningen. |
| [Ærø Club for Hundeejere](https://aech.dk/hvalpe-hold) | Holdsiden angav indskrivning 7. september og træningsstart 9. september 2026 samt antal træninger, krav om vaccination/forsikring og kontakt. Andre holdsider fungerer som løbende sæsonplaner uden fælles kalender. | Gennemsyn eller manuel sæsonimport. Brug `hold+sæson+startdato` som ID, bevar deltagerkrav, og opret ikke ugentlige forekomster uden en entydig plan og ferieundtagelser. |
| [OK-klubben i Marstal](https://www.aeroekommune.dk/mit-liv/aeldre/aktivt-seniorliv/sociale-arrangementer/ok-klubben) | Kommunens aktuelle side angiver ugentligt møde torsdag kl. 14-16 med forskellige aktiviteter i Konfirmandstuen. Der er ingen event-ID'er eller sæsongrænser. | Manuel gentagelse eller gennemsyn. Mærk seniormålgruppen tydeligt, indhent undtagelser, og importér kun særarrangementer, når de får en konkret dato. |

## Opdagelseskilder

Disse kilder kan give god dækning, men alle fund skal gennem dubletkontrol og
redaktionelt gennemsyn.

- [VisitÆrø-arrangementer](https://www.visitaeroe.dk/explore/begivenheder-cid58/det-sker-cid59?sort=DATE)
  havde 96 poster ved kontrollen. Browseren kalder `POST /api/explore` med 12
  poster pr. side; hver post har et stabilt GuideDanmark-`pid`, titel, sti,
  geografi og datoperioder. Endpointet er udokumenteret og krævede en
  browsersession for stabil pagination. Den understøttede
  [GuideDanmark API](https://api.guidedanmark.org/swagger/index.html) kræver
  aftale og credentials. Brug derfor den offentlige side som gennemsøgt
  discovery, eller indgå en aftale før automatisk publicering.
- [Søbygaards egen eventside](https://www.soebygaardaeroe.dk/soebygaard/oplevelser/events-og-markeder)
  er et godt arrangør-afgrænset krydstjek. Den kommende høstmarkedsdetalje har
  ID `gdk1139857`, men er samme GuideDanmark-post som hos VisitÆrø. Brug den
  direkte side til berigelse og validering; deduplikér globalt på GDK-ID.
- [Geopark Dage](https://www.geoparkoehavet.dk/geopark-dage) har et årligt
  program for fire kommuner og linker videre til de enkelte GuideDanmark-poster.
  Brug den som sæsonkontrol med krav om et sted på Ærø; den er ikke en ny
  autoritativ eventkilde.
- [Ærø Ugeavis](https://xn--rugeavis-i0a5p.dk/ugensavis/) linker hver uge til en
  offentlig PDF. `pdftotext -layout` kan finde mange små foreningsmøder og
  lokale opslag, som ikke findes andre steder. Layoutet er ustruktureret, så
  output må kun danne kandidater; rå PDF og udtrukket tekst bliver i den private
  state-mappe.
- [Billetto](https://billetto.dk/) har stabile eventnumre og gode oplysninger om
  tid, pris, udsolgt/venteliste og arrangør. Søgning på postnumrene 5960, 5970
  og 5985 kan finde arrangementer uden egen hjemmeside. Almindelige HTTP-kald
  blev blokeret under kontrollen, så dette er en manuel søgekanal, indtil der
  findes en understøttet adgangsvej.
- [KultuNaut](https://www.kultunaut.dk/) og lokale spejle som Vores Marstal kan
  finde turnerende arrangementer, men er sekundære kilder og bør kun bruges til
  discovery.
- Offentlige Facebook-eventfaner kan give små forenings- og
  borgerarrangementer, som ikke findes andre steder. Et almindeligt HTTP-kald
  viste ingen eventlinks, mens en anonym browser kunne læse de første kort hos
  flere sider og grupper. Se den verificerede liste, resultaterne og de konkrete
  crawlergrænser i [Offentlige Facebook-kilder](facebook-sources.md).
  Facebooks `robots.txt` kræver udtrykkelig skriftlig tilladelse til automatisk
  indsamling, så den planlagte browservej forbliver deaktiveret uden en
  autoriseret løsning. Manuel discovery går altid til review.
- [Venstre på Ærø](https://aeroe-venstre.dk/) gengiver offentlige
  Facebook-opslag som server-renderet tekst med dato og stabilt opslag-link. Den
  blandede nyheds- og eventstrøm er lettere at læse end Facebook, men må kun
  skabe reviewkandidater.
- [Ærø Kommunes foreningsoversigt](https://www.aeroekommune.dk/mit-liv/kultur-og-fritidsliv/foreninger/foreninger-paa-aeroe)
  er ikke en eventkilde, men er den bedste seed-liste til at opdage flere lokale
  arrangørers hjemmesider og kalendere. Gennemgå den kvartalsvist og registrér
  kun de underliggende, direkte kilder, som faktisk har daterede arrangementer.

## Ærø-specifik observations- og sikkerhedsliste

Listen omfatter bevidst også lokale kilder uden kommende events: en tom kalender
er stadig nyttig at kende, men skal ikke aktiveres som feed. Kontrollér kun med
den angivne lave frekvens, og behandl poster mærket `defekt`, `hijacket` eller
`lukket` som sikkerhedsregler, ikke som links der skal hentes.

| Kilde | Status 14. september 2026 | Opfølgning |
| --- | --- | --- |
| [Marstal Kajakklubs kalender](https://marstalkajakklub.dk/kalender) | Aktiv klubside, men kalenderen viste ingen poster; siden om indmeldelse siger, at årets åbent hus normalt annonceres i april/maj. | Kontrollér månedligt fra februar til maj; opret intet ud fra traditionen alene. |
| [Ærøhallen hos DanskHåndbold](https://danskhaandbold.dk/spillesteder/14260/kampprogram), [Marstal Håndbold MH89](https://www.mh89.dk/) og [Ærøhallen](https://www.aeroehallen.dk/) | Det stabile spillested `14260` havde nul kampe i den kontrollerede tremånedersperiode. Klub- og halsiderne er aktuelle, men uden egen eventkalender; hallen henviser primært til Facebook. | Kontrollér DanskHåndbold månedligt og publicér kun hjemmekampe på Ærø. Brug web- og Facebook-siderne til manuel discovery. |
| [Ærø Netavis: Det sker](https://aeroenetavis.dk/det-sker/) | Tom sekundær kalender med lokale filtre for Ærøskøbing, Birkholm, Marstal og Søby; sidens metadata nævnte fejlagtigt Randers Netavis. | Lavfrekvent manuel kontrol; kræv altid direkte bekræftelse hos arrangøren. |
| [Ærø Dagblad](https://www.aeroedagblad.dk/) | Aktiv lokal netavis med løbende 2026-artikler, men ingen særskilt struktureret kalender. | Ugentlig manuel søgning efter annoncerede arrangementer; publicér fra den direkte arrangørkilde, når den findes. |
| [Ærø Lokalradio](https://www.aeroelokalradio.dk/) | Aktiv lokalradio med ugentlig programplan og lokalt kultur-/foreningsstof, men intet eventfeed. | Manuel discovery; radioudsendelser er kun kalenderrelevante, hvis de annonceres som et offentligt arrangement. |
| [Ærø Kommunes aktivitetshuse](https://www.aeroekommune.dk/mit-liv/kultur-og-fritidsliv/aktivitetshuse) | Autoritativ oversigt over tre lokale huse, brugere og kontaktpersoner, men ingen offentlige bookinger eller daterede arrangementer. | Brug som kvartalsvis seed-liste; kontakt huset eller find en direkte annoncering før publicering. |
| [Ærøskøbing Byhistoriske Forening](https://aebf.dk/) | Aktiv forening med et anonymt WordPress REST-feed med stabile post-ID'er og ændringstider. Tidligere eventopslag har dato, tid og sted i brødteksten, men der var ingen fremtidige datoer ved kontrollen. Forside og `robots.txt` gav HTTP 455, mens det offentlige REST-feed svarede normalt. | Kontrollér REST-feedet langsomt og start først en review-adapter ved en konkret ny post. Brug altid arrangementsdatoen i teksten, aldrig WordPress-publiceringsdatoen, og omgå ikke HTTP 455. |
| [Ærø BorgerEnergiFællesskab](https://aeroebef.dk/nyheder/) | Aktiv forening med et offentligt WordPress REST-feed og stabile post-ID'er. Eventopslag har dato, tid, sted og adgang i prosa, men ingen fremtidige arrangementer blev fundet. En juli-post annoncerede eksempelvis en allerede passeret maj-dato. | Månedlig kontrol. Filtrér på den udtrykkelige arrangementsdato frem for postdatoen, kræv lokal adresse, og send nye fund til gennemsyn. |
| [Ærø Flyveklub](https://www.aeroe-flyveklub.dk/) | Joomla-siden har daterede nyheder og offentlige aktiviteter, men almindelige side- og feedkald gav HTTP 403. | Manuel discovery. Omgå ikke adgangsbegrænsningen; aktivér først en adapter, når en almindelig identificeret GET virker. |
| [Korbo](https://www.korbo.dk/) | Siden har programoplysninger, men blander gamle programmer og datoer uden entydigt år. | Manuel sæsonkontrol; automatisér ikke, før et aktuelt program har konsistente, fulde datoer. |
| [Ærø Kunstforenings kalender](https://www.aeroekunstforening.dk/arrangementer/kalender.php) | Foreningens egen hjemmeside linker til en særskilt arrangementskalender, men kalenderkaldet gav HTTP 455 ved kontrollen, så aktuelle poster kunne ikke verificeres sikkert. | Kontrollér manuelt med lav frekvens. Omgå ikke adgangsbegrænsningen; aktivér først en adapter efter en almindeligt tilgængelig fixture. |
| [Røde Kors Ærø](https://www.rodekors.dk/afdelinger/aeroe) | Aktiv lokalafdeling med aktivitetsoversigt, men ingen kommende datoer på afdelingssiden. | Månedlig manuel kontrol; bevar målgruppe og eventuelle adgangskrav. |
| [URK Ærø](https://urk.dk/urk-aeroe) | Aktiv lokalside med kontakt og aktivitetsbeskrivelse, men ingen kalender. | Manuel discovery via siden og den registrerede Facebook-profil. |
| [KFUM-spejderne på Ærø](https://aeroespejderne.gruppesite.dk/) | Aktiv gruppeside med faste mødetider, men ingen offentlig eventkalender. | Brug kun konkrete særarrangementer; gæt ikke forekomster ud fra mødetiderne. |
| [Gigtforeningens lokalgruppe Ærø](https://www.gigtforeningen.dk/faellesskabet/kredse-og-lokalgrupper/) og [fælles NemTilmeld-portal](https://gfsydvestfyn.nemtilmeld.dk/) | Den officielle oversigt har en aktiv Ærø-lokalgruppe og henviser til Sydvestfyns eventportal. Portalen havde aktuelle arrangementer, men ingen kunne ved kontrollen knyttes til Ærø. | Kontrollér månedligt, og kræv en konkret Ærø-adresse; bevar medlems- og målgruppekrav. |
| [Kræftens Bekæmpelse Ærø](https://www.cancer.dk/om-os/kontakt/lokalforeninger/aeroe-lokalforening/) og [den nationale kalender](https://www.cancer.dk/faa-raadgivning/kalender/) | Aktiv lokalforeningsside med kontakt og Facebook-gruppe, men ingen aktuel Ærø-post blev fundet i den nationale kalender. | Månedlig manuel kontrol af kalender og lokal side; kræv Ærø-sted og bevar målgruppe/adgang. |
| [Foreningen NORDENs arrangementskalender](https://foreningen-norden.dk/arrangementer/) | Kommunens foreningsoversigt registrerer en Ærø-afdeling, men den aktuelle nationale kalender viste ingen Ærø-arrangementer ved kontrollen. | Kontrollér kvartalsvist og importér kun resultater, der udtrykkeligt tilhører Ærø-afdelingen eller har sted på Ærø. |
| [Ærøforeningen](https://aeroeforeningen.dk/) | Aktiv forening med daterede 2026-poster, men foreningen er hjemmehørende i København, og arrangementerne kan ligge uden for Ærø. | Kontrollér kvartalsvist og kræv et konkret sted på Ærø før import. |
| [Fultons Venner](https://fultons-venner.dk/aktivitetskalender/) | Aktuel 2026-kalender med stabile detail-/bookinglinks, men de kontrollerede ture var medlemsrettede og lå uden for Ærø. | Kun discovery med strengt Ærø-stedfilter og tydelig medlemsadgang. |
| [Danish Sail Training Association](https://dsta.nemtilmeld.dk/) | NemTilmeld-tenant med stabile event-ID'er; en tidligere 2026-post gjaldt Bådebyggerugen på Ærø, men forsiden var tom ved seneste kontrol. | Kontrollér kvartalsvist og acceptér kun poster med dokumenteret sted på Ærø. |
| [Ærøs Operavenner](https://www.operavenner.dk/) | Aktiv forening bag den årlige opera på HCC Bådeværft; 2026-årgangen blev bekræftet af VisitÆrø, mens almindelige scriptkald til arrangørsiden gav HTTP 455. | Årlig manuel kontrol; direkte arrangøroplysning vinder, og ingen adgangsbegrænsning må omgås. |
| [Ærø Sportsfiskerforening hos Fishing in Denmark](https://fishingindenmark.info/foreninger/aero-sportsfiskerforening) | Sikker foreningsprofil med månedlige ture og årlig Havørredweekend, men uden konkrete datoer. Det tidligere domæne er overtaget af SEO-/casinoindhold, og eksterne opslag var uenige om weekendens dato. | Brug kun profilen som seed. Det tidligere domæne og den private Facebook-gruppe må ikke poll'es; publicér først efter direkte datobekræftelse. |
| [Lys i Mørket på Ærø](https://www.visitaeroe.dk/aeroe/events/lys-i-moerket-paa-aeroe) | Sæsonside uden program nu; den oplyser, at 2026-programmet ventes sidst i oktober. Siden er et VisitÆrø-knudepunkt, ikke en ny autoritativ kilde. | Kontrollér årligt i oktober/november og følg videre til den direkte arrangør for hver post. |
| [Alternativet Ærø](https://aero.alternativet.dk/) | Aktiv lokal partside, som lover nyheder og invitationer, men ingen aktuelle datoer blev fundet. | Manuel discovery; mærk medlemsmøder og politisk arrangør tydeligt. |
| [Snorren – Bevaringsforening for Marstal](https://www.snorren.info/) | Foreningen har flyttet til et aktuelt HTTPS-domæne, men aktivitetssiden viste ingen daterede arrangementer. | Kvartalsvis manuel kontrol efter særarrangementer. Poll ikke det gamle domæne som kalenderkilde. |
| [Ærø Portal](http://www.xn--rportal-lxa7n.dk/) | Lokal portal og sekundær link-/nyhedssamling uden selvstændigt autoritativt eventfeed. Den hænger sammen med Facebook-siden Nyt om Ærø, og HTTPS-værtsnavnet har et certifikat fra en anden vært. | Kun manuel discovery via HTTP, indtil TLS er rettet; deaktivér aldrig certifikatkontrol. Deduplikér web- og Facebook-fund som samme kildefamilie. |
| [Spisekammer Ærø hos Underværker](https://undervaerker.dk/udforsk/2026/spisekammer-aeroe-et-regenerativt-faellesskab/) | Aktuel projektside for et lokalt fællesskab, som planlægger åbent hus, workshops, fællesspisninger og arbejdsdage, men ikke viser konkrete datoer endnu. | Brug som projektsignal og følg den registrerede Facebook-side manuelt; publicér først en konkret, direkte annoncering. |
| [Ærø Soap](https://aeroesoap.dk/) | Aktiv lokal webshop og producent uden dateret eventfeed. Rundvisninger og aktiviteter kan annonceres andre steder. | Kvartalsvis manuel discovery på hjemmeside og Facebook; opret kun arrangementer med en konkret offentlig dato. |
| [Casa Ghiorsi: bondegårdsbesøg](https://casaghiorsi.dk/velkommen/bondegaardsbesoeg) | Den direkte side tilbyder besøg efter aftale, men har ingen faste offentlige datoer eller eventfeed. | Brug som arrangørseed, ikke som gentagelse; kun særskilt annoncerede åbne arrangementer er kalenderposter. |
| [Ærø Dog Days](https://www.aeroedogdays.dk/) | `stille`: den indekserede side siger, at initiativet har været sat på pause siden 2020; almindelige scriptkald gav HTTP 455. | Højst årlig manuel kontrol; ingen omgåelse og ingen automatisk import. |
| [Ærø International Mask Festival](https://aeroe.maskefestival.dk/) | `historisk`: siden beskriver festivalen 18.-21. juni 2009 og siger, at videre arbejde blev lagt på hylden. | Arkivér som kendt navn; kontrollér højst årligt for en dokumenteret genstart. |
| `flyingheroes.dk` | `defekt`: domænet viste kun standardsiden "Welcome to nginx!". | Udeluk fra polling, indtil en rigtig lokal arrangørside er dokumenteret. |
| `flaskepeters-samling.dk` | `hijacket`: domænet viser uvedkommende casino-/SEO-indhold og er ikke museets hjemmeside. | Udeluk permanent. Brug kun den registrerede [Ærø Museum-kilde](https://aeroemuseum.dk/). |
| `aeroefestival.dk` | `hijacket`: domænet blander et gammelt festivalprogram med uvedkommende casino-/spilindhold. | Udeluk permanent og forveksl det ikke med Øhavet Festival eller andre aktive arrangører. |
| `event.aeroe.teambooking.dk` | `defekt`: TLS-certifikatet matcher ikke værtsnavnet. | Udeluk; deaktivér aldrig certifikatkontrol for at hente siden. |
| [Ærø Kommunes lokalebooking](https://lokalebooking-aeroe.kmd.dk/Login/Login) | `lukket`: KMD-portalen kræver login og er en lokalebooking, ikke en offentlig eventkalender. | Brug ikke som eventkilde; aktivitetshusene eller arrangøren skal bekræfte offentlige events. |

## Bevidst fravalgt eller afventende

- [GoVisits Ærø-kalender](https://govisit.dk/det-sker/det-sker-paa-aeroe/) er
  en struktureret, server-renderet kalender, men de 59 kontrollerede poster var
  mærket `source: "gd"` og var en delmængde af GuideDanmark/VisitÆrø. En ekstra
  adapter giver derfor dubletter frem for ny dækning.
- [Sydfynskalenderen](https://sydfynskalenderen.dk/) har strukturerede data og
  ICS-ruter, men det komplette API krævede autorisation, og offentlig filtrering
  bruger reCAPTCHA. Bed om API-adgang frem for at omgå grænsen.
- [AOF](https://aof.dk/aftenskole?query=%C3%86r%C3%B8) har et offentligt,
  struktureret søge-endpoint på `/api/Search/NewSearch`, men søgninger på
  Ærø, Marstal, Ærøskøbing og øens tre postnumre gav nul kurser. Kontrollér
  kvartalsvist; en tom adapter giver ingen værdi nu.
- [OpdagDanmarks Ærø-side](https://www.opdagdanmark.dk/guide/aeroe/begivenheder/)
  har et offentligt WordPress-AJAX-feed, men det kommuneafgrænsede resultat var
  tomt. Kilden er desuden en aggregator, så den forbliver på observationslisten.
- [Sogn.dk for Ærøskøbing](https://sogn.dk/aeroeskoebing/kalender) overlapper
  den eksisterende ChurchDesk-import. Den er nyttig som manuel kontrol, men bør
  ikke publiceres som en ny kilde.
- [Landbogaardens eventside](https://landbogaarden.dk/events/) kan hentes gennem
  WordPress REST, men siden blev senest ændret i 2023 og viste gamle datoer.
  Brug fortsat stedets Facebook-side til manuel discovery, indtil den direkte
  kalender bliver vedligeholdt igen.
- [Ærø Svømmeklubs eventoversigt](https://aero.klub-modul.dk/cms/EventOverview.aspx)
  har et offentligt KlubModul-endpoint på `/cms/include/api/json/events.aspx`
  med stabile event-ID'er og kapacitetsfelter, men listen var tom ved kontrollen.
  Behold den på en kvartalsvis observationsliste.
- [Haveselskabet Ærø](https://haveselskabet.dk/fyn-og-oerne/afdelinger/aero/om-os/)
  kan filtreres ud af Haveselskabets strukturerede nationale eventdata, men
  havde ingen aktuelle lokale poster ved kontrollen.
- [Bregninge Lokalråds årskalender](https://bregningelokalraad.dk/%C3%A5rskalender)
  beskriver årlige traditioner og månedlig fællesspisning, men henviser til
  Facebook og Ugeavisen for de faktiske datoer. Brug den som tjekliste; opret
  ikke gentagelser ved at gætte datoer.
- [Øhavet Festival](https://www.oehavet.dk/) og
  [Ærø Harmonikafestival](https://harmonika-festival.dk/da/) har sæsonprogrammer
  uden holdbare event-ID'er, ofte i én lang side, dokumenter eller billeder.
  Årlig manuel import er mere robust end en fast adapter.
- [ÆRØ VIN](https://www.aeroe-vin.com/da) har en tydelig årlig
  begivenhedskalender i sidens tekst, men alle viste 2026-datoer var passeret ved
  kontrollen. Læs den før næste sæson og start med review, fordi datoerne står i
  prosa frem for eventobjekter.
- [På Torvet](https://paatorvet.dk/events/) havde ingen kommende event og gav
  HTTP 455 til almindelige scriptkald. Brug siden manuelt, indtil adgang og et
  aktuelt event kan testes uden omgåelse.
- [Kulturladens Memberlink](https://kulturladenaeroe.memberlink.dk/Activity/ActivityView)
  har et offentligt aktivitetsendpoint, men returnerede en tom liste. Kontrollér
  kvartalsvist frem for at aktivere en tom kilde.
- [Ærø Litteraturfestival](https://www.xn--rlitteraturfestival-kxb39a.dk/)
  har Squarespace-JSON, men 2026-festivalen sluttede 13. september, og programmet
  mangler stabile sessions-ID'er. Kontrollér månedligt og importer næste årgang
  manuelt eller til review.
- [Foreningen Søbygaard hos SafeTicket](https://foreningen-soebygaard.safeticket.dk/)
  har offentlig JSON med stabile numeriske event-ID'er, men nul kommende
  arrangementer. Kontrollér ugentligt; den første nye post skal gennem review.
- [Ærø Bryggeris Understory-oplevelse](https://aeroebryggeri.understory.io/experience/e0130170cacd730a032f49d8d01c695f)
  har et stabilt oplevelses-ID og strukturerede loader-data, men ingen planlagte
  sessioner. Bryggeriets egen eventkalender er mere nyttig nu.
- [Klang Ærø](https://klangaeroe.info/) havde ingen kommende datoer; den
  seneste viste koncert var 22. august 2026. Behold den som en lavfrekvent
  sæsonkontrol.
- [Ærø Buelaug](http://xn--rbuelaug-i0a5p.dk/) beskriver søndagsbueskydning
  kl. cirka 13, afhængig af vejret, men siden blev senest ændret i 2021, og
  HTTPS-certifikatet matcher ikke domænet. Opret ikke en automatisk gentagelse;
  indhent en aktuel bekræftelse manuelt.
- [Ærøske Motorveteraner](https://aeroe-motorveteraner.dk/medlemsorientering)
  har et årligt program i server-renderet prosa, men ingen resterende 2026-datoer
  efter kontroldatoen. Kontrollér siden årligt fra februar til maj og send
  medlems- og ø-ture til review.
## Krav til hver ny adapter

En adapter er klar til at blive aktiveret, når fixtures dækker:

1. stabilt source-ID og samme resultat ved gentagen import,
2. flyttet dato/tid uden nyt offentligt event-ID,
3. aflysning, udsolgt, medlemskrav, alder og tilmeldingsfrist, når kilden har
   oplysningerne,
4. tomt, delvist og ændret HTML/API-svar uden tab af sidste gode snapshot, og
5. dubletter mod eksisterende kilder og mod andre poster i samme kørsel.

De tre prioriterede bølger er nu implementeret. Videre arbejde bør begynde med
en konkret, kommende post fra backloggen frem for at aktivere tomme feeds.
Beth Mohr, Gravendal og eksterne retreats er de nærmeste daterede
reviewkandidater; observationskilder uden aktuelle Ærø-poster forbliver
inaktive. En Facebook-browser må kun aktiveres ved en autoriseret adgangsvej og
bør aldrig blokere de direkte adaptere.
