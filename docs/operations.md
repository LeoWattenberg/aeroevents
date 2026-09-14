# Drift af Ærøkalenderen

Kalenderen består af offentlige data i Git-repositoriet og en privat
arbejdskø uden for repositoriet. Kun godkendte arrangementer må ligge i Git.

## Lokal opsætning

Kør værktøjerne med Node.js 22 eller nyere. CLI'en bruger som standard
`$XDG_STATE_HOME/aeroevents` eller `~/.local/state/aeroevents`. Angiv en anden
absolut sti med `AEROEVENTS_STATE_DIR`. Stien skal ligge uden for
repository-roden.

Den private mappe indeholder rå indsamlinger, emner til gennemsyn, afviste
emner og eventuel korrespondance. Tag særskilt backup af den, og giv kun
redaktøren læseadgang. `.gitignore` er ikke den primære beskyttelse: CLI'en
afviser en state-mappe inde i repositoriet.

De daglige kommandoer er:

```text
npm run events -- create
npm run events -- collect [source-id ...]
npm run events -- collect facebook
npm run events -- review
npm run events -- approve <candidate-id>
npm run events -- reject <candidate-id> [--reason "..."]
npm run events -- facebook <offentlig-url> --fetch
npm run events -- facebook <opslags-url> --details-file opslag.txt --published-at <ISO-tid> [--title tekst]
npm run events -- facebook <offentlig-url> --event event.yaml --details-file opslag.txt
npm run events -- validate
npm run events -- publish
```

`create` spørger om de nødvendige felter og skriver et manuelt YAML-udkast.
`collect` opdaterer kun et import-snapshot, når hele kilden er hentet og alle
offentlige poster er valide. Tvivlsomme poster lægges i den private kø.
`review` viser køen én kandidat ad gangen med tid, sted og kildelink. Svar `y`
for at validere og tilføje kandidaten til Git med det samme, eller `n` for at
afvise og arkivere den privat. `review --json` viser køen uden den interaktive
dialog. De separate kommandoer `approve` og `reject` kan fortsat bruges med et
kandidat-id.

`data/sources.yaml` er den afgørende publiceringspolitik. En adapter kan kræve
gennemsyn, men kan ikke selv give tilladelse til automatisk publicering. Filens
kategorimapping anvendes også til sidst, så redaktionelle ændringer slår igennem
uden kodeændringer. `organizerId` er derimod kun en standardværdi for adapteren;
den må ikke erstatte arrangøren på den enkelte post. Poster til gennemsyn gemmes
som ikke-offentlige snapshotbaser; en godkendelse tilføjer derfor en lille override
og opretter ikke et konkurrerende event-id.

`collect facebook` starter en lokal Chromium-session og gennemgår alle aktive
feeds i `data/facebook-sources.yaml`. Den udtrækker konkrete event- og
postpermalinks og fortolker komplette arrangementsopslag fra feedet. Afkortede
opslag åbnes på deres permalink; kommentarer bruges ikke som eventkandidater.
Alle fund går til review. Fejl ved én side eller gruppe rapporteres, mens de
øvrige kilder fortsætter. Browsercrawleren er eksplicit deaktiveret, når
`GITHUB_ACTIONS=true`.

Brug en afgrænset liste under fejlsøgning:

```sh
AEROEVENTS_FACEBOOK_SOURCE_IDS=det-sker-paa-aeroe,oplev-mit-aeroe npm run events -- collect facebook
```

En sådan afgrænset kørsel kan opdatere den private reviewkø, men bevarer det
offentlige Facebook-snapshot og dets kontroltidspunkt.

Browseren findes automatisk på almindelige Linux-stier. Ellers sættes
`AEROEVENTS_CHROMIUM_PATH=/absolut/sti/til/chromium` eller Playwrights browser
installeres med `npx playwright install chromium`. Det samlede loft over
detaljesider er 400 pr. kørsel og kan ændres med
`AEROEVENTS_FACEBOOK_MAX_DETAILS`. Rå feed- og detalje-HTML gemmes kun i den
private state-mappe.

Facebook-kommandoens `--fetch` forsøger én konkret offentlig event- eller
post-URL og lægger fundet i køen. `--details-file` uden `--event` fortolker en
manuelt kopieret offentlig opslagstekst; tilføj `--published-at`, når teksten
bruger en relativ dato eller mangler årstal, og `--title`, hvis den foreløbige
titel skal angives eksplicit. Genbrug samme permalink ved opdateringer. Den
fulde tekst og parserens evidens bliver i den private kø. `--event` bevarer
vejen til en redaktørudfyldt eventfil.

Vellykkede HTTP-svar fra kildeindsamling gemmes med private filrettigheder under
`AEROEVENTS_STATE_DIR/raw/<kørsel>/`. En fejl under denne arkivering får den
pågældende indsamling til at fejle, så sidste komplette snapshot bevares.

## Automatisk indsamling

Brug en dedikeret checkout med ren arbejdsmappe. Kopiér tidsplanen fra
`scripts/cron/aeroevents-cron.example`, ret begge absolutte stier, og installér
den med `crontab -e`. Wrapperen:

1. tager en ikke-blokerende fillås,
2. stopper ved lokale ændringer eller manglende upstream,
3. henter med `git pull --ff-only`,
4. indsamler med en samlet frist på 20 minutter og validerer,
5. stager kun importerede event-snapshots og offentlig kildestatus, og
6. committer og pusher kun, når data faktisk er ændret.

En fejlet eller delvis kilde bevarer sidste komplette snapshot. At en event
forsvinder fra en kilde, gør den ikke automatisk aflyst; en udtrykkelig status
fra kilden eller en manuel redaktionel rettelse kræves.

Wrapperen kræver Linux-værktøjerne `flock` og GNU `timeout`. Facebook-kilden
kræver desuden Chromium og kører kun i det lokale cronjob. Hver HTTP-anmodning
har desuden sin egen tids- og størrelsesgrænse, så en hængende eller urimeligt
stor kildeside ikke kan holde låsen på ubestemt tid.

## Udgivelse

GitHub Actions validerer og bygger ved push til `main`, ved manuel start og
dagligt. Aktivér Pages med **GitHub Actions** som source under repositoryets
Settings → Pages. Den daglige kørsel flytter 12-månedersvinduet frem, også når
ingen data er ændret.

Et almindeligt GitHub project site får automatisk repository-navnet som base-
sti. Ved eget domæne sættes repository-variablerne `PUBLIC_SITE_URL` og
`PUBLIC_BASE_PATH`. Sæt altid repository-variablen `PUBLIC_SUBMISSION_EMAIL`
til redaktionens rigtige adresse; workflowet stopper deployment, hvis den mangler.

`npm run events -- publish` er den manuelle vej: den validerer, afviser
ændringer uden for de offentlige datastier, henter upstream, stager de tilladte
filer, committer, kører et sidste `pull --ff-only` og pusher. Private køfiler kan
ikke vælges, fordi de ligger uden for checkoutet. Brug `--message` til en egen
commitbesked.

GitHub kan deaktivere planlagte workflows i repositories uden aktivitet i en
længere periode. Kontrollér med jævne mellemrum fanen Actions, især efter 60
dage uden commits. Kør workflowet manuelt for at kontrollere eller genaktivere
det.

Før første cron-kørsel skal checkoutens Git-identitet og push-credential være
sat op. Test først `npm run events -- collect`, dernæst wrapperen manuelt. Hvis
en push afvises, efterlades den lokale commit til inspektion; wrapperen bruger
aldrig force-push.

## Fejlretning og gendannelse

- Ved exit-kode 75 kører en anden indsamling stadig. Undersøg processen før
  låsefilen fjernes; en gammel fil uden en aktiv lås er ufarlig.
- Ved ugyldige data standses udgivelsen. Ret kilden eller læg kandidaten til
  gennemsyn, og kør validering igen.
- Ved Git-konflikt skal den dedikerede checkout gøres ren manuelt. Wrapperen
  nulstiller eller overskriver aldrig lokale filer.
- Gendan et fejlagtigt snapshot med en almindelig revert-commit. Bevar audit-
  sporet frem for at omskrive historikken.
