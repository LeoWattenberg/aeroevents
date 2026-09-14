# Det sker på Ærø

En statisk, dansk eventkalender for Ærø. Hjemmesiden er bygget med Astro og kan ligge på GitHub Pages. Eventdata bliver valideret og udvidet til kalenderforekomster før byggetid, så den offentlige side ikke kræver en database eller server.

## Kom i gang

Projektet kræver Node.js 22 eller nyere.

```sh
npm install
cp .env.example .env
npm run dev
```

`PUBLIC_SITE_URL`, `PUBLIC_BASE_PATH` og `PUBLIC_SUBMISSION_EMAIL` kan sættes i `.env`. Brug eksempelvis `/aeroevents` som base path for en GitHub-projektside og `/` ved eget domæne. Deployment-workflowet kræver en rigtig `PUBLIC_SUBMISSION_EMAIL`, så eksempeladressen ikke kan blive udgivet ved en fejl.

De vigtigste kontroller er:

```sh
npm test
npm run check
npm run build
npm run test:e2e
```

Browsertesten bygger også siden med `/aeroevents` som base path og kræver Chromium. Kør `npx playwright install chromium`, hvis browseren ikke allerede findes lokalt.

## Eventdata

Manuelle events ligger som YAML i `data/manual/events/`. Importerede, publicerbare snapshots ligger som JSON i `data/imported/`, mens redaktionelle rettelser ligger i `data/overrides/`. Arrangører, kategorier og kilder har hver sit register direkte under `data/`.

`npm run data:build` validerer alle filer, anvender rettelser og skriver de afledte filer i `data/generated/`. Den mappe er ignoreret af Git og bliver altid gendannet før et Astro-build.

Et event kan have enten eksplicitte datoer eller en RFC 5545-gentagelsesregel. Alle lokale tider fortolkes i `Europe/Copenhagen`.

## Redaktionens kommandoer

```sh
npm run events -- create
npm run events -- create --from event.yaml --publish
npm run events -- collect
npm run events -- collect aeroe-kirkeliv
npm run events -- collect facebook
npm run events -- review
npm run events -- approve <kandidat-id>
npm run events -- reject <kandidat-id> --reason "Ikke offentligt"
npm run events -- facebook <offentlig-facebook-url> --fetch
npm run events -- facebook <facebook-opslag> --details-file opslag.txt --published-at <ISO-tid> [--title tekst]
npm run events -- facebook <offentlig-facebook-url> --event event.yaml --details-file opslag.txt
npm run events -- validate
npm run events -- publish
```

`create` starter en terminaldialog eller indlæser en færdig eventfil. Nye manuelle events er kladder, medmindre `--publish` er angivet. `collect` publicerer kun fuldstændige resultater fra betroede kilder; tvivlsomme fund sendes til køen. `review` viser kandidaterne én ad gangen med tid, sted og kildelink; `y` godkender og tilføjer kandidaten, mens `n` afviser og arkiverer den privat. Brug `review --json` til en ikke-interaktiv visning. En tom, delvis eller fejlet indsamling erstatter aldrig sidste fungerende snapshot.

Kø, rå fund, afvisninger og eventuelle afsenderoplysninger er private. De gemmes uden for repositoryet i `$AEROEVENTS_STATE_DIR`, ellers under `$XDG_STATE_HOME/aeroevents` eller `~/.local/state/aeroevents`. De bliver ikke læst af Astro-buildet.

`collect` omfatter en lokal Playwright-crawler til de offentlige side- og gruppefeeds i `data/facebook-sources.yaml`. Den finder både formelle Facebook-events og almindelige opslag, der annoncerer et arrangement. Komplette opslag fortolkes direkte fra feedet; eventlinks og afkortede opslag åbnes på deres konkrete permalink. Loginmure, tvetydige datoer og opslag uden arrangementsignal afvises. Alle Facebook-fund gemmes i den private kø, og intet publiceres uden godkendelse. Crawleren starter ikke i GitHub Actions.

Kør kun Facebook med `npm run events -- collect facebook`. Begræns en fejlsøgning til bestemte konfigurations-id'er med eksempelvis `AEROEVENTS_FACEBOOK_SOURCE_IDS=det-sker-paa-aeroe,oplev-mit-aeroe npm run events -- collect facebook`. Hvis Chromium ikke findes automatisk, sættes `AEROEVENTS_CHROMIUM_PATH` til browserens absolutte sti. Den eksisterende `facebook --fetch`-kommando henter fortsat én konkret event- eller post-URL, og `--details-file` er fallback til manuelt kopieret opslagstekst.

## Automatiske kilder

Første version indeholder adapters til:

- Ærø Kommunes mødeplan for Kommunalbestyrelsen
- Ærø Kirkelivs samlede ChurchDesk-kalender, hvor alle valide poster går direkte til publicering
- Ærø Folkebiblioteks arrangements- og detaljesider
- offentlige Facebook-events og eventannoncer i opslag, altid til review

Hver adapter kræver et komplet og strukturelt gyldigt svar. Event-ID'er fra kilden bevares, så en ny kørsel opdaterer samme event. Eventuelle kandidater fra andre kilder med samme titel og starttid går til dubletkontrol.

`data/sources.yaml` er den endelige autoritet for, om en kilde er aktiv, må publicere automatisk, og hvilke kategorireferencer den må bruge. En kildes `organizerId` er kun adapterens standardværdi; en arrangør, der er angivet på selve arrangementet, bevares. Vellykkede HTTP-svar arkiveres privat med begrænsede filrettigheder, så en import kan efterprøves uden at lægge rådata i Git.

Se [driftsvejledningen](docs/operations.md) for cronjob, sikker publicering, fejlhåndtering og GitHub Pages. [Datapolitikken](docs/data-policy.md) beskriver grænsen mellem private arbejdsdata og det, der må publiceres. [Kandidater til nye datakilder](docs/source-candidates.md) er en verificeret, prioriteret scraper-backlog med konkrete endpoints og publiceringsregler. [Facebook-kilder på Ærø](docs/facebook-sources.md) dokumenterer de testede eventfaner, adgangsgrænsen og fallbacken.

## GitHub Pages

Workflowet i `.github/workflows/deploy-pages.yml` validerer, tester og bygger siden ved push til `main`, ved manuel start og én gang dagligt. Repositoryets Pages-kilde skal sættes til **GitHub Actions**. Et dagligt build flytter den 12-måneders kalenderhorisont frem; sourceindsamling udføres fortsat af det lokale cronjob.

GitHub kan forsinke planlagte workflows og slå dem fra efter længere tids inaktivitet i offentlige repositories. Sidens kildeoversigt viser derfor både byggetid og seneste vellykkede kontrol af hver kilde.
