# Offentlige Facebook-kilder på Ærø

Status: undersøgt anonymt 13.-14. september 2026. Facebook ændrer ofte markup og
adgangskrav, så listen er et øjebliksbillede og ikke et løfte om fortsat adgang.

Facebooks egne regler skelner mellem offentlige og private begivenheder, men en
offentlig begivenhed er ikke det samme som en stabil data-API. Facebooks
[`robots.txt`](https://www.facebook.com/robots.txt) siger direkte, at automatisk
indsamling kræver udtrykkelig skriftlig tilladelse, og henviser til Metas
[vilkår for automatisk dataindsamling](https://www.facebook.com/legal/automated_data_collection_terms).
Kilderne nedenfor er derfor en verificeret liste til manuel discovery og en
implementeringsspecifikation, hvis en autoriseret adgangsvej opnås. En planlagt
browserindsamler skal forblive deaktiveret uden den tilladelse.

## Hvad der faktisk kan indsamles

Et almindeligt HTTP-kald til en offentlig side eller gruppes `/events`-fane gav
HTML uden eventlinks. En anonym Chromium-session viste derimod de første
offentlige eventkort og stabile links på formen `/events/<numerisk-id>/`.
Login-dialogen var synlig, men eventkortene kunne læses uden at logge ind.

Den nuværende `facebook --fetch`-kommando er kun en forsigtig parser til én
konkret event-URL. Den finder JSON-LD eller Open Graph-tidspunkter, hvis Facebook
udleverer dem. En virkelig 2026-eventside gav titel, dato og arrangør i
`og:description`, men intet struktureret klokkeslæt; kommandoen afviste derfor
korrekt fundet som ufuldstændigt. Side- og gruppeopdagelse kræver en særskilt,
lokal browseradapter og en autoriseret adgangsvej, før kilderne her kan sættes i
cron.

## Start med disse kilder

Antallene er kun de første kort, som Facebook viste uden scrolling eller klik på
"Se flere". "Kommende" betyder kommende på kontroldatoen.

| Kilde | Anonymt resultat | Brug |
| --- | --- | --- |
| [Ærø Kommune](https://www.facebook.com/aeroekommune/events) | Mindst otte kommende event-ID'er. | Høj teknisk værdi, men kommunens egne sider er autoritative. Kræv Ærø-sted eller allowlistet lokal vært. |
| [Ærø Folkebibliotek](https://www.facebook.com/arrebib/events) | Mindst syv kommende event-ID'er. | Brug kun til at opdage cohosts eller ændringer; den eksisterende biblioteksadapter vinder. |
| [Det sker på Ærø](https://www.facebook.com/groups/1853077681730379/events) | Offentlig gruppe med ca. 7.400 medlemmer. Seks eventkort, heraf tre kommende. | Bedste brede Facebook-kilde. Kun discovery; høj risiko for overlap og opslag uden for Ærø. |
| [OPLEV MIT ÆRØ](https://www.facebook.com/groups/oplevmitaeroe/events) | Offentlig gruppe med ca. 31.100 medlemmer. Seks eventkort, heraf tre kommende. | Bred discovery og krydstjek. Dedupliker mod VisitÆrø og direkte arrangørkilder. |
| [På Torvet](https://www.facebook.com/PaaTorvet/events) | Tre kommende event-ID'er. | God sæsonkilde til restaurant- og musikevents; den direkte hjemmeside vinder ved overlap. |
| [Viften Ærø](https://www.facebook.com/ViftenAeroe/events) | Ét kommende event-ID. | Nyttig til unge- og familieevents; den direkte Viften-kilde vinder. |
| [Julehygge i Ærøskøbing](https://www.facebook.com/julehyggeiaeroskobing/events) | Fire kommende markedsevents i november og december 2026. | Høj værdi, fordi eventfanen var den mest komplette fundne kalender. |
| [Ærøskøbing – Eventyrbyen](https://www.facebook.com/AEroskobingHandelsstandsforening/events) | Én serie med fire kommende datoer. | Direkte arrangør til julemarkederne; sammenkæd serien med Julehygge-sidens event-ID'er. |
| [Atma Yoga House](https://www.facebook.com/atmayogahouse/events) | Fem kommende gentagelsesserier; et kort viste yderligere 11 forekomster. | Bevar `event_time_id` i linket, så den valgte forekomst ikke forsvinder. Kontrollér gentagelsen mod den direkte Squarespace-kilde. |
| [Motorfabrikken Marstal](https://www.facebook.com/motorfabrikkenmarstal/events) | To kommende koncerter. | Discovery og krydstjek. Ticketbutler-kilden er autoritativ og skal vinde ved overlap. |
| [Søbygaard](https://www.facebook.com/soebygaardaeroe/events) | To kommende eventkort. | Discovery og krydstjek. Søbygaards eller VisitÆrøs direkte post skal vinde. |
| [Bregninge på Ærø](https://www.facebook.com/groups/144664695598174/events) | Tre aktuelle eller nylige event-ID'er. | Værdifuld discovery på landsbyniveau; alle fund kræver manuelt gennemsyn. |

De to brede grupper gav tilsammen konkrete fund om blandt andet familiedans,
folkedans, kreative kurser, fællesspisning og høstmarked. De er derfor nyttige
til netop de små lokale arrangementer, som turismekalendere ofte mangler.

## Årlige og lokale sider at overvåge

Disse sider viste ingen fremtidige kort på kontroldatoen, men deres eventhistorik
viser, at de bruges til tilbagevendende arrangementer. En ugentlig eller
månedlig kontrol er nok; daglige kald giver ringe ekstra udbytte.

| Kilde | Fund ved kontrollen | Regel |
| --- | --- | --- |
| [Det sker i Ommel](https://www.facebook.com/groups/871725845485563/events) | Offentlig gruppe, som den officielle Ommel Samvirke-side linker til. Den havde ca. 388 medlemmer og 58 opslag den seneste måned, men nul kommende eventkort. | Aktiv manuel opslag-discovery; Ommel Samvirkes egen webkalender er den egentlige eventkilde. |
| [Aktivitetshuset i Søby, Ærø](https://www.facebook.com/groups/434434336369842/events) | Offentlig gruppe linket fra Søby Lokalråd, ca. 159 medlemmer og fire opslag den seneste måned, men nul kommende eventkort. | Manuel opslag-discovery; lokalrådets egen side vinder ved overlap. |
| [Ærø Hotel](https://www.facebook.com/aeroehotel/events?locale=da_DK) | Den anonyme fane viste ét kort, "Mortens Aften", med stabilt event-ID `435373937183862`, men ingen dato der kunne verificeres sikkert uden login. | Kun manuel discovery; hotellets Wix-eventside er den direkte kilde. |
| [ÆIK arrangerer](https://www.facebook.com/aeikarrangerer/events) | Otte kort, blandt andet Eventyrfest og fastelavn i 2026. | Overvåg årlige by- og familiearrangementer. |
| [Rise SIF](https://www.facebook.com/RISESIF/events) | Otte kort med Risefest og Forårsfest 2026. | Brug Facebook til enkeltfester; Conventus er bedre til holdplaner. |
| [Marstal Erhvervsforening](https://www.facebook.com/MarstalHandelsforening/events) | Fire kort med sommeraktiviteter i 2026. | Overvåg handelsstandsarrangementer. |
| [Søby Erhvervsforening](https://www.facebook.com/100057148403910/events) | Fem kort, senest april 2026. | Brug det kanoniske numeriske side-ID; det gamle sidenavn gav ustabile redirects. |
| [Landbogaarden](https://www.facebook.com/Landbogaarden/events) | Otte kort; det nyeste lå dagen før kontrollen. | Aktiv kulturscene. Direkte billet- eller arrangørside vinder, når den findes. |
| [På Hat med Ærø](https://www.facebook.com/PaHatMedAEro/events) | Seks Hattefest-kort, herunder august 2026. | Årlig kontrol før sommersæsonen. |
| [Kjobinghus](https://www.facebook.com/61582082199581/events) | To eventkort. | Facebook-først; behold numerisk side-ID i konfigurationen. |
| [Prinsebroen](https://www.facebook.com/prinsebroen/events) | Ét kort fra 2025. | Lavfrekvent årlig kontrol; VisitÆrø kan være mere aktuel. |
| [Ærø Bryggeri](https://www.facebook.com/AeroeBryggeri/events) | Otte kort fra 2026, men ingen kommende. | WordPress REST er den direkte kilde. Facebook kan kontrollere forekomster og aflysninger. |
| [Ærø Jazz Festival](https://www.facebook.com/aerojazz/events) | Otte kort fra 2026 og tidligere. | Festivalens eget program er den direkte kilde. |
| [Ærø Harmonikafestival](https://www.facebook.com/harmonikafestival/events) | Otte kort, mest fra 2024–2025. | Årlig discovery, hvis hjemmesiden mangler et komplet program. |
| [Øhavet Festival](https://www.facebook.com/oehavetfestival/events) | Seks årgange, herunder den afsluttede 2026-festival. | Festivalens egen side vinder; brug kun som årgangskontrol. |
| [Marstal Søfartsmuseum](https://www.facebook.com/MarstalMuseum/events) | Otte kort, senest 2025. | Museets hjemmeside vinder; lavfrekvent fallback. |
| [Marstal Navigationsskole](https://www.facebook.com/marnav.dk/events) | Otte nylige ID'er. | NemTilmeld vinder; Facebook kan opdage foredrag og arrangementer uden tilmelding. |
| [Ærø Kajak & SUP](https://www.facebook.com/kajakudlejningen/events) | Otte nylige ID'er. | Discovery til fællesspisning, Sankt Hans, sauna og friluftsliv. |
| [Marstal Camping](https://www.facebook.com/Marstalcampingplads/events) | Fire nylige ID'er. | Sæsonbestemt discovery til måltider og udendørsarrangementer. |

Andre offentlige sider, som blev fundet via VisitÆrøs 96 aktuelle poster, kan
tilføjes som manuelle overvågninger uden at blokere første adapter:
[Ærø Museum](https://www.facebook.com/pages/%C3%86r%C3%B8-Museum/348123508624926),
[Geopark Det Sydfynske Øhav](https://www.facebook.com/geoparkdetsydfynskeohav),
[I Arthurs Fodspor](https://www.facebook.com/iarthursfodspor),
[Ærøpigen](https://www.facebook.com/%C3%86r%C3%B8pigen-112577627118795/),
[Det Røde Pakhus](https://www.facebook.com/groups/270082970034692/events) og
[Vægterne på Ærø](https://www.facebook.com/groups/313133435691684/events).

Der var også læsbare eventfaner hos
[Ærø Rideklub](https://www.facebook.com/groups/667725396572738/events),
[Ærø Klatreklub](https://www.facebook.com/groups/aeroeklatreklub/events),
[Ærø Golf Klub](https://www.facebook.com/aeroegolfklub/events),
[Ærøskøbing Idrætsklub](https://www.facebook.com/aeroeskoebingindraetsklub/events),
[Ærø Pastorat](https://www.facebook.com/aeroepastorat/events),
[Ærø Vin](https://www.facebook.com/aeroevin/events) og
[Ærø Traktortræk](https://www.facebook.com/profile.php?id=100092558438110&sk=events).
De direkte klub-, kirke- og programkilder skal have forrang.

## Politik og foreningsmøder

Politiske sider er særligt nyttige til vælgermøder og medlemsmøder, som ikke
altid når de almindelige kalendere. De fundne eventfaner var dog mest historiske:

- [Venstre på Ærø](https://www.facebook.com/venstreaeroe/events) viste syv kort,
  primært fra 2025. Partiets [egen hjemmeside](https://aeroe-venstre.dk/)
  gengiver offentlige Facebook-opslag som server-renderet tekst med dato og
  stabilt postlink. Den er en bedre, review-only kilde og indeholdt ved
  kontrollen et medlemsmøde i august 2026.
- [Socialdemokratiet på Ærø](https://www.facebook.com/socialdemokratietaeroe/events)
  viste otte kort fra 2025.
- [Det Konservative Folkeparti på Ærø](https://www.facebook.com/406569136115644?sk=events)
  viste otte kort fra 2025 og tidligere.
- [Enhedslisten Ærø](https://www.facebook.com/EnhedslistenAeroe/events) viste fire
  kort, senest fra 2021.

Alle politiske fund skal mærkes med adgangskrav. Et offentligt annonceret
medlemsmøde må gerne vises, men må ikke præsenteres som åbent for alle.

## Opslag uden eventfane

[Ærøhallen](https://www.facebook.com/Aeroehallen/posts) og
[KFUM-spejderne på Ærø](https://www.facebook.com/aeroespejderne/posts) viste
offentlige opslag med stabile `pfbid`-permalinks, men ingen brugbar eventfane.
Et opslag kan være afkortet og blander nyheder med events. Brug derfor kun disse
sider til manuel discovery med indsat opslagstekst; publicér aldrig direkte fra
et kort uddrag. Arrebo viste "indhold ikke tilgængeligt" ved kontrollen og må
ligeledes bruge den manuelle URL-og-tekst-fallback.

## Sider der ikke bør poll'es nu

Eventfanerne hos Café Arthur, Ærø Soap, Gravendal og Casa Ghiorsi havde kun
flere år gamle kort. Ærø Festspil havde senest kort fra 2018. Ærø Grand Prix,
Kulturladen og Det Røde Pakhus havde ingen aktuelle kommende kort. Behold dem på
en kvartalsvis observationsliste i stedet for at bruge daglige browserkald.
Café Maris, KEFS Guesthouse, Maritim Dag Ærø og MIF's klubhusprofil kunne åbnes
offentligt, men havde ingen eventfane.

Ærø Sportsfiskerforenings gruppe er privat og kan derfor ikke bruges som
anonym eventkilde. Foreningens tidligere domæne indeholder nu uvedkommende
SEO-/casinoindhold; hverken gruppen eller domænet skal poll'es.

## Krav til en eventuel autoriseret browseradapter

Adapteren må kun aktiveres, hvis Meta giver en passende tilladelse eller en anden
understøttet adgangsvej bliver tilgængelig.

1. Konfigurér hver side eller gruppe med fast source-nøgle, arrangørmapping,
   forventet Facebook-ID og højst én kontrol om dagen.
2. Start en ren, anonym browserkontekst. Brug aldrig redaktørens konto eller en
   cookieprofil. Stop og rapportér ved loginmur, checkpoint, blokering eller
   ændret sidenavn/ID.
3. Åbn kun den konfigurerede `/events?locale=da_DK`-fane og udtræk links, der
   matcher `/events/<id>`. Sæt en lav grænse for ventetid, scrolling og antal
   kort.
4. Gem det numeriske event-ID som source-ID. For gentagelser gemmes også
   `event_time_id` på forekomsten; query-parameteren må ikke fjernes fra
   kilde-URL'en.
5. Kræv titel og en entydig dato. Manglende tidspunkt forbliver ukendt; datoer
   eller klokkeslæt må aldrig gættes ud fra lignende kort.
6. Send alle kandidater til review og sammenlign med direkte kilder,
   GuideDanmark-ID'er og andre fund i samme kørsel. En direkte arrangørkilde
   vinder altid over Facebook.
7. Gem HTML og eventuelle browserdiagnoser i den private state-mappe. Et tomt
   eller delvist resultat må aldrig erstatte sidste gode snapshot eller aflyse
   en tidligere event.

Inden adapteren aktiveres, skal en fixture af et sidefeed, et gruppefeed, en
gentagelse med `event_time_id`, en loginmur og et tomt svar bevise de fem vigtigste
fejlveje. Hvis anonym adgang forsvinder, er den eksisterende manuelle
`facebook <url> --event ... --details-file ...`-kommando fallback.
