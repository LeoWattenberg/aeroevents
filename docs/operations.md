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
npm run events -- review
npm run events -- approve <candidate-id>
npm run events -- reject <candidate-id> [--reason "..."]
npm run events -- facebook <offentlig-url> --fetch
npm run events -- facebook <offentlig-url> --event event.yaml --details-file opslag.txt
npm run events -- validate
npm run events -- publish
```

`create` spørger om de nødvendige felter og skriver et manuelt YAML-udkast.
`collect` opdaterer kun et import-snapshot, når hele kilden er hentet og alle
offentlige poster er valide. Tvivlsomme poster lægges i den private kø.
`review` viser køen; `approve` kopierer en valideret, offentlig event til Git,
mens `reject` arkiverer den privat.

`data/sources.yaml` er den afgørende publiceringspolitik. En adapter kan kræve
gennemsyn, men kan ikke selv give tilladelse til automatisk publicering. Filens
arrangør- og kategorimapping anvendes også til sidst, så redaktionelle ændringer
slår igennem uden kodeændringer. Poster til gennemsyn gemmes som ikke-offentlige
snapshotbaser; en godkendelse tilføjer en lille override og opretter derfor ikke
et konkurrerende event-id.

Facebook-kommandoens `--fetch` forsøger én konkret offentlig URL og lægger alle
fund i køen; loginvægge, blokering og manglende strukturerede eventdata vises
som fejl. Uden `--fetch` gemmer kommandoen URL'en sammen med en redaktørudfyldt
eventfil og eventuelt indsat opslagstekst til samme gennemsyn. Brug kun
offentligt tilgængelige oplysninger, og omgå aldrig en adgangsbegrænsning.

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

Wrapperen kræver Linux-værktøjerne `flock` og GNU `timeout`. Hver HTTP-anmodning
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
