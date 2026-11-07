# Utvärdering

Enkel, säker och integritetssäker utvärderingstjänst, tänkt som ersättare för Forms.
Svarande är anonyma som standard. Skapare loggar in och ser sina egna svar.

**Inga beroenden.** Node.js 22.13+ (inbyggda `node:http`, `node:sqlite`, `node:crypto`) och SQLite. Inget JavaScript i webbläsaren.

Säkerhets- och integritetskrav: [docs/SECURITY.md](docs/SECURITY.md).

## Kom igång lokalt

```sh
export INSECURE_COOKIES=1            # bara lokalt över http
npm run invite                       # skriver ut en engångslänk för att skapa konto
npm start                            # http://localhost:3000
npm test
```

Öppna inbjudningslänken, skapa konto, logga in och skapa en utvärdering. Svarslänken (`/s/...`) delar du med deltagarna.

## Frågor

En fråga per rad i editorn. `*` efter typen = obligatorisk.

```
skala*: Hur nöjd var du totalt?
val: Vilken del var bäst? | Föreläsning | Övning | Material
text: Vad kan förbättras?
kontakt: Namn eller e-post om du vill bli kontaktad (frivilligt)
```

## Drift (Docker + Caddy)

```sh
BASE_URL=https://utvardering.krigare.se docker compose up -d --build
docker compose exec utvardering node src/cli.js invite     # första kontot
```

Lägg till blocket i `Caddyfile.example` i din Caddyfile. `TRUST_PROXY=1` är satt i compose-filen
och får bara användas när appen enbart nås via Caddy.

Miljövariabler: `BASE_URL`, `DB_PATH` (`/data/utvardering.db` i containern), `PORT`, `HOST`, `TRUST_PROXY`, `INSECURE_COOKIES` (bara lokalt).

Administration: `node src/cli.js invite [dagar]`, `echo "nytt lösenord" | node src/cli.js passwd <användare>`.

## Backup

```sh
sqlite3 /data/utvardering.db ".backup '/backup/utvardering-$(date +%F).db'"
```

Kryptera backupen (t.ex. `age`) innan den lämnar servern.

## Nästa steg (ej gjort)

Visuell frågebyggare, passkeys/TOTP, spärr mot att visa fritext vid få svar, export/import av utvärderingar, öppen registrering när tjänsten ska öppnas för fler.
