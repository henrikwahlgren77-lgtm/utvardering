# Säkerhets- och integritetskrav

Utvärdering är byggd för att ha så liten attackyta som möjligt. Det som inte behövs finns inte.

## Avgränsning (finns medvetet inte)

Filuppladdning, webhooks, integrationer, rik text/HTML, egen CSS, JavaScript i webbläsaren,
tredjepartsskript/typsnitt, analys, cookies för svarande, flera organisationer.

## Integritet för svarande

- Ingen inloggning, inga cookies och inget JavaScript på svarssidan.
- IP-adress och User-Agent lagras aldrig och loggas aldrig. Appen har ingen åtkomstlogg.
- Tidpunkt lagras bara som datum (inte klockslag), så att svar inte går att koppla till andra loggar via tid.
- Personuppgifter lämnas bara om svarande själv skriver dem i en fråga av typen `kontakt` eller `text`.
- Skaparen kan sätta automatisk radering (`retention_days`) per utvärdering. Raderingen körs vid start och varje timme.
- Skaparen kan när som helst radera enskilda utvärderingars svar eller hela utvärderingen.

## Åtkomstkontroll

- Skapare skapas via engångsinbjudan (`node src/cli.js invite`). Ingen öppen registrering.
- Varje skapar-route kontrollerar att utvärderingen tillhör inloggad användare (`owner_id`). Obehörig åtkomst ger 404, inte 403, så att existens inte avslöjas.
- Lösenord: scrypt (N=2^15, r=8, p=1) med slumpat salt per användare, jämförelse med `timingSafeEqual`. Dummy-hash körs för okända användare för att jämna ut svarstid.
- Sessioner: 256 bitar slumpad token i cookie, endast SHA-256-hashen lagras i databasen. 7 dagars livslängd, rensas vid utloggning och vid byte av lösenord.
- Cookie: `HttpOnly`, `Secure`, `SameSite=Strict`, prefix `__Host-` i produktion.
- CSRF: `SameSite=Strict` plus CSRF-token per session i alla POST-formulär i skaparvyn, kontrollerad med konstant tid.
- Inloggning och svar är rate-limitade (i minnet, nycklas på IP-hash som aldrig lämnar processen).

## Indata och utdata

- All HTML-utdata escapas via en enda funktion (`esc`). Inga mallar med rå HTML från användare.
- Strikta storleksgränser: kropp 64 KB, text 2000 tecken, max 50 frågor, max 20 alternativ.
- Svar valideras mot utvärderingens frågor på servern; okända fält ignoreras.
- CSV-export neutraliserar formelinjektion (`= + - @` i början av cell prefixas med `'`).
- SQL endast via preparerade satser.

## Svarshuvuden

`Content-Security-Policy: default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Resource-Policy: same-origin`, `Permissions-Policy` med alla funktioner avstängda, `Cache-Control: no-store` på skaparvyer, HSTS i produktion.

## Beroenden

Inga runtime-beroenden. Appen använder bara Node.js inbyggda moduler (`node:http`, `node:sqlite`, `node:crypto`).
Det betyder ingen leveranskedja att granska. Node-versionen ska hållas uppdaterad.

## Drift

- Kör som icke-root i container, skrivbar volym endast för databasen.
- Caddy framför med HTTPS. Sätt `TRUST_PROXY=1` bara när appen *enbart* nås via Caddy.
- Nattlig krypterad backup av SQLite-filen (använd `sqlite3 .backup`, inte filkopiering medan appen skriver).

## Kända begränsningar och senare steg

- Rate limiting är i minnet och nollställs vid omstart.
- Ingen tvåfaktor/passkeys ännu.
- Fritextsvar visas oredigerade för skaparen; skaparen ansvarar för personuppgifter i dem (GDPR: skaparen är normalt personuppgiftsansvarig, driftaren personuppgiftsbiträde).
- Ingen k-anonymitetsspärr för små grupper ännu.
