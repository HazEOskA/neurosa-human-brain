# Weryfikacja NeurOSA Connect + Ingest

Data: 2026-09-07. Zakres: gałąź `build/neurosa-ingest-connect`, baza `b0fc8527f41e5908ae68a59802c0ad87bda511a7`.

| Bramka                       | Wynik                                       |
| ---------------------------- | ------------------------------------------- |
| Baseline przed implementacją | 80/80 testów PASS                           |
| pnpm format:check            | PASS                                        |
| pnpm lint                    | PASS                                        |
| pnpm typecheck               | PASS                                        |
| pnpm test                    | 118/118 PASS, 12 plików testowych           |
| pnpm check                   | PASS                                        |
| pnpm compile                 | PASS                                        |
| pnpm build                   | 18/18 zadań PASS, bez cache                 |
| pnpm smoke                   | PASS: aktywacja, 2 impulsy, restart, ledger |
| git diff --check             | PASS                                        |

Build pakietów to istniejące sprawdzenie TypeScript (`tsc --noEmit`). Ostrzeżenia Turborepo o braku plików outputs wynikają z tego kontraktu. Nie jest to build aplikacji Living Brain.

Nowe testy w `tests/connect` sprawdzają: sześć profili klientów; przekazanie pamięci ChatGPT → restart SQLite/API → Claude; idempotencję po restarcie; konkurencyjne aktualizacje; jawne rozstrzygnięcie konfliktu; rollback całej sesji; odmowę zapisu bez scope i dostępu do cudzej sesji; ponowne zamknięcie; budżet core/retrieval; brainId binding; obsługę błędu pracy; SSE/replay; wersje źródeł; deduplikację i rozdzielenie zmieniających się źródeł; blokadę obejścia rewizji przez CRUD; rollback przy błędzie ledgeru; eksport ChatGPT z gałęziami, Claude i neutralny JSON; rzeczywiste PDF/DOCX; symlink escape; paginację/zmiany/błędy Drive; prawdziwy proces stdio MCP wywołujący lokalny serwer HTTP.

Żaden test nie wymaga klucza modelu ani połączenia z kontem użytkownika. W testach Drive kontrolowany transport zwraca odpowiedzi API, a zapis i recall wykonuje prawdziwy lokalny Brain API i SQLite. Profile providerów oraz schematy narzędzi nie są dowodem połączenia live z aplikacjami dostawców.

## Otwarte granice

- BLOCKED: poprawna paczka Living Brain D nie została odzyskana; gotowe jest połączenie backendowe przez rzeczywiste events i SSE. Nie powstał zastępczy UI.
- UNKNOWN: OAuth i synchronizacja z rzeczywistym folderem Google Drive operatora.
- UNKNOWN: podłączenie adaptera/MCP do rzeczywistych kont i runnerów ChatGPT, Claude, Gemini, Grok, OSA.
- Nie wykonano merge ani deployu; lokalny bridge stdio nie jest publicznym remote MCP.
- OCR skanów i automatyczne odświeżanie OAuth w samodzielnym CLI nie są zaimplementowane; credential callback umożliwia użycie istniejącego brokera.

Pełny kontrakt i procedura uruchomienia: `docs/NEUROSA_CONNECT.md`. Nowe źródła nie są oceniane jako prawdziwe tylko dlatego, że zostały zapisane: provenance identyfikuje autora i źródło deklaracji.
