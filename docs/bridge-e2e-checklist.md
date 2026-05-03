# Bridge E2E Checklist (Real Servers)

## Voraussetzungen
- Zwei erreichbare SFTP-Server: `A` (Quelle), `B` (Ziel)
- Pro Server ein Test-User mit bekannten Rechten
- Testdatei auf Server A: `500MB` und optional `5GB`
- Optional: macOS Network Link Conditioner zur Netzwerksimulation

## Testablauf
1. In der Sidebar zwei Verbindungen anlegen.
2. Verbindung auf `Panel A` und `Panel B` zuweisen.
3. Datei von `Panel A` nach `Panel B` ziehen (Bridge-Transfer).
4. Während des Transfers `Cmd+K` öffnen und nach Dateien filtern.
5. Transfer im Progress-Hub abbrechen.
6. Bridge-Transfer erneut starten und Resume-Offset prüfen.
7. Auf Server B Schreibrechte entziehen und Transfer erneut starten.
8. Mit Network Link Conditioner Paketverlust/Latenz simulieren und Reconnect/Retry prüfen.

## Erwartetes Verhalten
- Kein lokales Temp-File bei Bridge-Transfer.
- Progress-Ticks ca. alle 200ms, UI bleibt responsiv.
- Status korrekt: `pending`, `active`, `completed`, `cancelled`, `error`.
- Bei fehlender Berechtigung klare Fehlermeldung im Task.
- Mehrere parallele Transfers zeigen getrennte Balken/Geschwindigkeiten.

## Messwerte protokollieren
- App RAM im Activity Monitor:
  - Startwert
  - Während 500MB-Transfer
  - Während 5GB-Transfer
- Transferdurchsatz:
  - Mittelwert
  - Peak
  - Abweichung bei Netzwerksimulation
