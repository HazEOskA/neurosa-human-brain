# NeurOSA Memory Connector v0.1 — raport weryfikacji

Cel: jedna kanoniczna NeurOSA, dowolny agent i pamięć między sesjami przez `remember`, `recall`, `health`.

## Wynik i granice

**PASS dla odizolowanego lokalnego LIVE E2E.** Test użył rzeczywistego entrypointu `apps/brain-api/src/server.ts`, istniejącego `BrainApiServer`, SQLite/WAL i ledgeru. Oddzielne procesy Jeverson oraz Hermes instalowały i importowały spakowany connector. Nie podawano historii rozmowy ani nie wywoływano modeli.

**Istniejący Azure: NOT_TESTED / UNKNOWN.** W tej sesji nie było konfiguracji jego endpointu i tokenu. Wynik lokalny nie potwierdza stanu wdrożenia, trwałego wolumenu Azure ani działania rzeczywistych aplikacji Jeverson/Hermes. Nazwy agentów w teście oznaczają oddzielne procesy korzystające z connectora. T07 sprawdza opcjonalny hook i deterministyczny callback hosta, bez wywołania modelu.

Production, główna gałąź, istniejące dane i zewnętrzne konfiguracje pozostały bez zmian. Nie wykonywano merge, deploymentu ani publikacji npm.

## Audyt i ponowne użycie kodu

Źródło kanoniczne: `HazEOskA/neurosa-human-brain`, audytowany bazowy commit `90edd1d58ff1c04a33286165e8e643662e48289e`. Nowy pakiet znajduje się w tym samym repozytorium, na gałęzi `build/neurosa-universal-memory-v0.1-20261018`.

| Istniejący element                            | Zastosowanie w v0.1                                                              |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| `packages/neurosa-brain-api`                  | te same endpointy status/remember/recall/documents, tokeny i scopes              |
| `packages/neurosa-connect`                    | ten sam transport, HTTPS i istniejący cykl sesji; dodana kontrola źródeł i scope |
| `packages/neurosa-workspace/src/knowledge.ts` | istniejący zapis, receipts i idempotencja                                        |
| `packages/neurosa-storage`                    | istniejący SQLite/WAL; bez nowego storage i bez migracji schematu                |
| `packages/neurosa-event-ledger`               | istniejący hash-chain; nowe zdarzenie trwałego przypisania scope                 |
| `apps/neurosa-connect/src/mcp.ts`             | ponownie użyty serwer MCP; bez kolejnego serwera                                 |

Wcześniejsze integracje wymagały brainu przypisanego do jednego projektu, ponieważ istniejący recall jest globalny. W v0.1 pełny brain/baza zostaje trwale przypisany do jednej organizacji, projektu i namespace. Przypisanie egzekwuje backend dla wszystkich uwierzytelnionych endpointów. Obce i brakujące nagłówki scope oraz obcy projekt zapisu są odrzucane. `agentId` wpisu jest provenance, a nie tożsamością autoryzacyjną.

Pierwsze przypisanie dopuszcza wyłącznie bazę bez dokumentów i historii pamięci/sesji. Niepusta istniejąca baza nie jest automatycznie migrowana. Jej późniejsze podłączenie wymaga audytu danych i osobnej zgody na migrację; obecny kod nie przenosi, nie czyści ani nie kopiuje takiej pamięci. Starszy kod wymaga audytu zgodności przed otwarciem bazy z nowym typem zdarzenia `MEMORY_SCOPE_BOUND`.

## Testy akceptacyjne

Czas zapisu dowodu UTC: `2026-10-18T09:05:36.551Z`. Node: `v24.19.0`.

| Test             | Rzeczywisty wynik             | Dowód                                                                               |
| ---------------- | ----------------------------- | ----------------------------------------------------------------------------------- |
| T01              | PASS — LIVE lokalnie          | uwierzytelniony status prawdziwego Brain API; brain `OsaBrain`                      |
| T02              | PASS                          | Jeverson zapisuje unikalny nonce w oddzielnym procesie                              |
| T03              | PASS                          | ten sam klucz i wejście zwracają ten sam dokument, bez nowego zdarzenia             |
| T04              | PASS                          | nowy proces Hermes odczytuje źródło bez historii czatu                              |
| T05              | PASS                          | pełny dokument, referencja, SHA-256 i odpowiadające zdarzenie ledgeru               |
| T06              | PASS                          | błędny token 401, obcy namespace 403, token read-only nie zapisuje jako `admin`     |
| T07              | PASS w zakresie hooka hosta   | po zatrzymaniu API: UNAVAILABLE, pusty kontekst, zwykły callback może działać dalej |
| T08              | PASS — wyłącznie baza testowa | SIGTERM → nowy proces → ta sama baza, źródło, hash i działająca idempotencja        |
| HTTP/Python      | PASS                          | Python odczytuje ten sam dokument i hash z tokenem read-only                        |
| Instalacja JS/TS | PASS                          | offline npm install archiwum do czystego projektu i niezależny typecheck deklaracji |

Źródłowy dokument testu: `ddb5410a-0554-4b54-99a9-37bc56bee5d7`. SHA-256 jego pełnej treści: `86e12164deace9b82c24fdb2d29db613fbd429f3e736c340f9cd11fd3115316e`. Dokument powstał wyłącznie w tymczasowej bazie testowej, która została usunięta po teście; identyfikator jest dowodem przebiegu, nie linkiem do prywatnej pamięci użytkownika.

Surowe wyniki i identyfikatory operacji: [universal-memory-v0.1.json](evidence/universal-memory-v0.1.json).

## Bramki jakości i regresji

| Polecenie                                           | Wynik                                                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                    | PASS; nowe zależności są wyłącznie build/dev, bez aktualizacji wersji dotychczasowych pakietów |
| `node_modules/.bin/vitest run`                      | 160/160 PASS, 16 plików; [log](evidence/universal-memory-tests.log)                            |
| `node_modules/.bin/tsc --noEmit`                    | PASS                                                                                           |
| `node_modules/.bin/eslint .`                        | PASS                                                                                           |
| `node_modules/.bin/prettier --check .`              | PASS                                                                                           |
| `node_modules/.bin/turbo run build --concurrency=2` | 21/21 PASS, w tym samodzielny pakiet i istniejąca aplikacja                                    |
| `node --import tsx tests/e2e/vertical-slice.ts`     | PASS, restart i ledger                                                                         |
| `node --import tsx tests/e2e/deployment-smoke.ts`   | PASS, rzeczywisty proces, restart, SIGKILL recovery, idempotencja                              |
| `git diff --check`                                  | PASS                                                                                           |

Nowy plik `tests/connect/universal-memory.test.ts` zawiera 11 przypadków z lokalnym HTTP i rzeczywistym SQLite oraz 5 przypadków z mockiem transportu. Negatywne testy obejmują rzeczywistą zmianę treści/hash dokumentu oraz uszkodzenie ledgeru **wyłącznie w świeżej bazie testowej**. Mocki sprawdzają m.in. podmienioną odpowiedź, limit rozmiaru, redakcję błędów i stary backend bez scope. Mocki nie są dowodem połączenia z Azure.

Dotychczasowy build zgłasza ostrzeżenia Turbo o braku plików wyjściowych dla pakietów budowanych przez `tsc --noEmit`; wszystkie 21 zadań zakończyło się poprawnie. Lokalnie nie uruchamiano Dockera. Następnie [GitHub Actions #39114284194](https://github.com/HazEOskA/neurosa-human-brain/actions/runs/39114284194) zakończyło się **success** dla commita implementacji `3b83ca69d2f108159d5308e471086afd8ed1268f`: zarówno „Kod i integracja”, jak i „Kontener i trwałość danych” przeszły. Obejmuje to test kontenera z odtworzeniem i awarią procesu. [Zapis statusów CI](evidence/universal-memory-ci.json).

## Artefakt i integralność

Instalowalny artefakt: `osatech-neurosa-memory-0.1.0.tgz` (75 970 bajtów w tym przebiegu), bez zależności runtime. Zawiera ESM, deklaracje TypeScript i przykład HTTP/Python. Instrukcja budowania i instalacji: [README pakietu](../packages/neurosa-memory/README.md).

- SHA-256 archiwum: `4775fdce698280247762ac950e1310f868aa3e7a29b0590300a384e5a72d2776`.
- Digest wejść źródłowych backendu i connectora: `551d404ff8919d254aa45d8b9d7d99fdc36cfa2b81a4bd5f6287d758500051b7`. Sposób obliczenia znajduje się w skrypcie akceptacyjnym; obejmuje ścieżki i zawartość źródeł, nie opis raportu.
- `CONTENT_HASH_CHECKED` oznacza kontrolę hasha pełnego dokumentu; `SERVER_VALIDATED` oznacza weryfikację ledgeru przez backend. Nie jest to zewnętrzne poświadczenie kryptograficzne ani dowód prawdziwości zapamiętanej treści.
- `beforeMessage` oznacza kontekst jako niezaufane dane; model nie otrzymuje z pamięci uprawnień ani zatwierdzenia operacji. Odporność konkretnego modelu/hosta na prompt injection nie była testowana.
- `afterMessage` domyślnie zwraca SKIPPED. Płatne wywołania modeli: **0**. Tokeny w logach: **nie wykryto**.

## Następny krok

Przed użyciem z istniejącym środowiskiem Azure ustalić dokładny testowy endpoint, backendową konfigurację tokenu i trwałe przypisanie danych do scope. Nie podłączać automatycznie niezaudytowanej, niepustej bazy i nie traktować lokalnego PASS jako zgody na zmianę Production.
