# Data- og redaktionspolitik

## Offentligt indhold

Repositoriet må kun indeholde oplysninger, der skal vises offentligt:
validerede arrangementer, arrangører, kategorier, kildehenvisninger og
tidspunkter for seneste vellykkede kildekontrol. Importerede beskrivelser
behandles som ren tekst ved visning.

## Privat arbejdsmateriale

Følgende skal altid opbevares i `AEROEVENTS_STATE_DIR` uden for repositoriet:

- rå HTTP-svar og debugging-captures,
- endnu ikke godkendte kandidater og mistænkte dubletter,
- afviste indsendelser og redaktionelle noter,
- mails, afsenderadresser og anden korrespondance,
- Facebook-oplysninger, der er indsat til gennemsyn.

En godkendelse udgiver kun det normaliserede eventobjekt og den offentlige
kilde-URL. Interne noter, rå tekst og kontaktoplysninger kopieres ikke med.
Indsenders kontaktoplysninger må kun udgives, når de også er den oplyste,
offentlige kontakt for arrangementet.

Gennemgå den private kø jævnligt og slet personoplysninger, når de ikke længere
er nødvendige. Adgang, backup og slettefrist administreres på værtsmaskinen og
ikke i Git.

## Redaktionsbeslutninger

Automatisk udgivelse er begrænset til kildetyper, der er markeret som betroede
i kilderegistret. Alle andre fund kræver en eksplicit godkendelse. En afvisning
gemmer kandidat-id, tidspunkt og en kort begrundelse privat, så samme fund ikke
dukker op igen ved hver kørsel.

Manuelle overrides har forrang for importerede felter og overlever en ny
indsamling. Flyttede forekomster beholder deres forekomst-id. Sammenfald i
titel, sted eller tidspunkt er kun et dubletsignal; poster fra forskellige
kilder flettes aldrig automatisk.

