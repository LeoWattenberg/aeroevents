# Kandidater til nye datakilder

Status: undersøgt 13. september 2026. URLs og tekniske detaljer skal kontrolleres
igen, når en adapter implementeres.

Direkte kilder hos arrangøren eller den ansvarlige myndighed bør have forrang.
En aggregator er nyttig til at opdage huller, men må ikke overskrive bedre data
fra en direkte kilde. Nye adaptere starter i gennemsyn, indtil fixtures viser, at
ID'er, datoer, aflysninger og tomme svar håndteres sikkert.

## Implementér først

| Prioritet | Kilde | Udbytte og format | Foreslået publicering |
| --- | --- | --- | --- |
| 1 | [Rise Skytte- & Idrætsforening](https://www.rise-sif.dk/) | Conventus har offentlige JSON-endpoints for ressourcer og bookinger. Kontrollen gav 580 daterede forekomster i 30 serier og enkeltaktiviteter frem til april 2027, blandt andet badminton, gymnastik, dans, yoga, pilates og spinning. Hver forekomst har `booking.id`, og serien har eget ID. | Automatisk for allowlistede hold og foreningsevents. Udelad navnløse eller generiske lokalebookinger, bevar medlems-/tilmeldingskrav, og gem aldrig deltagernes bookingdata. |
| 2 | [Ærø Kommune: Det sker](https://www.aeroekommune.dk/om-kommunen/kommunikation-og-presse/det-sker) | Officielle borgerarrangementer, blandt andet borgermøder og kommunale tilbud. Server-renderet liste og detaljesider med dato, tid, sted, pris og links. Detaljesiden har et stabilt `meta[name=pageid]`. | Automatisk efter dubletkontrol mod mødeplanen og biblioteket. |
| 3 | [Ældre Sagen Ærø](https://www.aeldresagen.dk/lokalafdelinger/aeroe/aktiviteter-og-kurser?sortering=dato) | Ugentlig motion, spil, fællesspisning, caféer, møder og foredrag. Detalje-URL'en indeholder et stabilt numerisk aktivitets-ID og angiver adgang, gentagelse, næste dato, tid og mødested. | Automatisk; bevar medlems- og tilmeldingskrav. |
| 4 | [Ærø Folkedanserforening](https://6165826142842.site123.me/) | Server-renderede eventkort med stabilt `data-unique-id` og detail-URL. Der var 24 kommende familie- og voksenarrangementer frem til marts 2027. Siden gengiver eventsektionen to gange. | Automatisk efter deduplikering på `data-unique-id`. Brug kun "kommende begivenheder"; send start=slut og andre tidsfejl til review. |
| 5 | [Viften: Ture og begivenheder](https://www.viften.net/ture) | Kommunale fritidstilbud til børn og unge. Kortene linker til `/subjectclass/<guid>`; detaljen indeholder dato, alder/klassetrin, pris, frist og tilmeldingsstatus. | Automatisk med `boern-familie`; alderskrav skal stå i adgangsdetaljen. |
| 6 | [Ærø Folkeuniversitet](https://fuko.dk/komite/aeroe-folkeuniversitet/) | Offentlige foredrag med dato, sted, pris og eksplicit `Aflyst`/`Afholdt`. Simpel HTML uden pagination; WordPress REST har ændringstidspunkter. | Automatisk. Brug den kanoniske kursus-URL som kilde-ID, da et kursus kan blive genoprettet med et nyt WordPress-ID. |
| 7 | [Motorfabrikken Marstal](https://www.motorfabrikkenmarstal.com/kultur) | Den officielle kulturkalender sælger billetter gennem en struktureret Ticketbutler-kilde med stabilt numerisk ID og UUID, starttid, venue, pris, booking og `is_sold_out`. | Automatisk efter validering af tenant/hostname; den direkte kilde vinder over VisitÆrøs samlepost. |
| 8 | [Ommel BK hos DBU Fyn](https://www.dbufyn.dk/resultater/klub/1464/kampprogram) | DBU's kampprogram har stabile match-ID'er, pulje, hold, status, dato, tid og stadion. To kommende hjemmekampe blev fundet. | Genbrug Marstal IF-parseren. Hent først den aktuelle puljeliste; et `pools=0`-indeks må ikke hardcodes. Publicér kun hjemmekampe på Ærø. |
| 9 | [Marstal Navigationsskole](https://marnav.nemtilmeld.dk/) | NemTilmeld-detaljer har schema.org Event JSON-LD og stabile numeriske ID'er. Der var to kommende offentlige åbent-hus-arrangementer; begge var fuldt bookede med venteliste. | Automatisk for en snæver allowlist som `Åbent hus`; læs også synlig kapacitetsstatus. Send erhvervskurser til review eller udelad dem. |
| 10 | [FirstAgenda](https://dagsordener.aeroekommune.dk/) | Autoritative rettelser til kommunale møder. Efter et anonymt cookie-kald til forsiden returnerer `GET /api/agenda/udvalgsliste` JSON med stabile møde-GUID'er, start/slut med offset, sted, publiceringstid og status. | Berig den eksisterende kommunekilde; opret ikke dubletter. Publicér automatisk for Kommunalbestyrelsen. |

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

## Næste gruppe

| Kilde | Teknisk vej | Redaktionel regel |
| --- | --- | --- |
| [Ærø Rideklub](https://www.aeroerideklub.dk/events-1) | Squarespace-samlingen har `?format=json` med stabilt ID, slug, ændringstid, epoch-start/slut, tekst og sted. Hver detalje har desuden `?format=ical` med persistent `UID`. | Start i gennemsyn. Kilden blander offentlige stævner med arbejdsdage og medlemsaktiviteter, og mindst ét fremtidigt tidspunkt ser fejlindtastet ud. |
| [Ærø Jazz Festival](https://www.aeroejazzfestival.dk/program-tidspunkter/) | WordPress-side `9188` kan hentes gennem `/wp-json/wp/v2/pages/9188`; programtabellen har dato, tid, kunstner, venue og adgang. Billetprodukter har stabile WooCommerce-ID'er. | Gennemsyn. Brug `festivalår+dato+tid+kunstner+venue` som ID; HTML kan indeholde udsolgte eller efterladte programrækker. Bevar både festivalen og de enkelte koncerter. |
| [Ærø Bryggeri](https://aeroebryggeri.dk/events/) | Modern Events Calendar-poster findes via `/wp-json/wp/v2/mec-events?per_page=100` med stabile WordPress-ID'er, ændringstid og pagination. Læs synlig dato/tid og status fra detaljesiden. | Gennemsyn først. JSON-LD viste forkert tidszone og valuta ved kontrollen. Udelad almindelige åbningstider og fler-måneders butiksposter. |
| [Marstal IF: kommende kampe](https://www.marstalif.dk/fodbold/kommende-kampe/) | Server-renderet DBU-tabel. `matchid` i kamp-linket er stabilt, og rækkerne indeholder hold, pulje, tidspunkt, spillestatus og stadion. | Automatisk for fremtidige hjemmekampe på Ærø; udelad udekampe. |
| [Ærøskøbing Sejlklub](https://aeroeskoebing-sejlklub.dk/) | Siden indlejrer en offentlig Google Calendar. Den kan hentes som `.../calendar/ical/<calendar-id>/public/basic.ics` og har stabile UID'er. | Gennemsyn først og kassér `Klubhus udlejet`/`Klubhus optaget`; kalenderen bruges også som lokale-booking. |
| [Bio Andelen](https://www.bio-andelen.dk/) | Programmet kan hentes som WordPress-side via `/wp-json/wp/v2/pages/7`. Teksten bruger datointervaller, undtagne mandage og ekstra matinéer. | Gennemsyn. Udvid kun kendte tekstmønstre til visninger, og stop ved et ukendt mønster. |
| [Ærø Golf Klub: turneringer](https://www.aeroegolf.dk/turneringer.aspx) | En årlig, server-renderet HTML-liste med dato, turneringsform og om den er åben eller kun for medlemmer. | Lavt volumen; automatisk er muligt, men manuel YAML én gang om året kan være billigere at vedligeholde. |
| [Søbygaardkoncerterne](https://www.soebygaardkoncerterne.dk/) | Sæsonprogram i statisk HTML med titel, dato, tid, beskrivelse og billetpris. | Automatisk efter en fixture; brug koncertens detail-slug, ellers `år+dato+titel`, som kilde-ID. |
| [Marstal Søfartsmuseum](https://service.marmus.dk/da/besog-museet/nyt-pa-museet) | Nyheds-/arrangementskort i HTML. | Gennemsyn; gammelt CMS og flere værtsnavne gør kilden skrøbelig. |
| [Ærø Museum](https://aeroemuseum.dk/) | Arrangementer kan findes som WordPress-poster via `/wp-json/wp/v2/posts?categories=8&per_page=100&_embed`, men web application firewall returnerede også HTTP 455 ved gentagne API-kald. Datoer og fuldt-booket-status står i brødtekst/Divi-markup. | Gennemsyn med langsomme kald, retries og sidste-gode-snapshot. |
| [Ærøskøbing Idrætsklub](https://www.aeik.dk/newlook/proc_liste.asp?valgt_holdtype=9999) | Den ugentlige, server-renderede plan har forekomst-ID'er. Senere uger kræver samme session, skjulte formularfelter og POST med en måldato. Kontrollen viste blandt andet indoor cycling og eksplicit tomme ferieuger. | Gennemsyn først. Parse kun listen, behold sidste gode snapshot, og mærk holdaktiviteter som medlemskrævende. |
| [Ærø Bridgeklub](https://www.bridge.dk/4596/Turneringsoversigt.html) | BridgeCentral-siden har en aktuel 2026/27-plan med faste mandags-/onsdagstider, datointervaller, julefrokost og generalforsamling. | Gennemsyn; der er ingen event-ID'er, så brug klub, sæson og blok/dato i en sammensat nøgle. Bevar pris og gæsteadgang. |
| [Marstal Marineforening](https://www.marstalmarineforening.dk/aktiviteter/) | Server-renderet prosaside med ugentligt søndagsåbent, medlemsfester og et offentligt julemarked. | Gennemsyn. Parse eksplicitte datoer og gentagelser, brug sammensatte nøgler, og bevar medlemsmarkeringen. |
| [Atma Yoga House](https://www.atmayogahouse.com/yoga-schedule?format=json) | Squarespace JSON og ICS har stabile item-ID'er/UID'er. Seks kommende poster blev fundet. En hel ugentlig sæson er dog kodet som ét langt event uden RRULE; antal gange og undtagelser står i teksten. | Gennemsyn. Omsæt aldrig det lange interval direkte; opret først en gentagelse, når tekstens sessioner og undtagelser er entydige. |
| [Ærø Fotoklub](https://www.aeroefotoklub.dk/program) | Programmet har aktuelle klubaftener, men flere trykte datoer modsiger de angivne ugenumre. | Kun discovery og manuel korrektion, indtil kilden er konsistent. |

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

## Bevidst fravalgt eller afventende

- [GoVisits Ærø-kalender](https://govisit.dk/det-sker/det-sker-paa-aeroe/) er
  en struktureret, server-renderet kalender, men de 59 kontrollerede poster var
  mærket `source: "gd"` og var en delmængde af GuideDanmark/VisitÆrø. En ekstra
  adapter giver derfor dubletter frem for ny dækning.
- [Sydfynskalenderen](https://sydfynskalenderen.dk/) har strukturerede data og
  ICS-ruter, men det komplette API krævede autorisation, og offentlig filtrering
  bruger reCAPTCHA. Bed om API-adgang frem for at omgå grænsen.
- [Sogn.dk for Ærøskøbing](https://sogn.dk/aeroeskoebing/kalender) overlapper
  den eksisterende ChurchDesk-import. Den er nyttig som manuel kontrol, men bør
  ikke publiceres som en ny kilde.
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

## Krav til hver ny adapter

En adapter er klar til at blive aktiveret, når fixtures dækker:

1. stabilt source-ID og samme resultat ved gentagen import,
2. flyttet dato/tid uden nyt offentligt event-ID,
3. aflysning, udsolgt, medlemskrav, alder og tilmeldingsfrist, når kilden har
   oplysningerne,
4. tomt, delvist og ændret HTML/API-svar uden tab af sidste gode snapshot, og
5. dubletter mod de tre eksisterende kilder og mod andre poster i samme kørsel.

Den mest effektive næste leverance er Rise SIF, Kommune `Det sker`, Ældre Sagen,
Ærø Folkedanserforening og Viften. Derefter følger Folkeuniversitetet,
Motorfabrikken, Ommel BK, Navigationsskolens offentlige arrangementer og
FirstAgenda-berigelsen. Det giver tilbagevendende fællesskaber, børn/unge,
officielle borgerarrangementer, sport, foredrag og koncerter uden at være
afhængig af en aggregator. En Facebook-browser må kun aktiveres ved en
autoriseret adgangsvej og bør aldrig blokere de direkte adapters.
