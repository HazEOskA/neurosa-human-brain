# NeurOSA — połączenie z landingu v0.1.1

Użytkownik otwiera link, wybiera MCP / JavaScript / Python i pobiera gotową konfigurację dla swojego agenta. Nie musi wchodzić do chmury ani szukać klucza w Cloud Shell. Landing jest trybem `web` **istniejącej aplikacji Connect**, w tym samym repozytorium. Wszystkie trwałe dokumenty, sesje i zdarzenia nadal zapisuje kanoniczny `packages/neurosa-brain-api` z istniejącym SQLite/WAL i ledgerem.

## Przepływ użytkownika

1. Operator przekazuje prywatny link połączenia. Link działa raz przez 5 minut; fragment znika z adresu po otwarciu.
2. Strona sprawdza uwierzytelnione API NeurOSA. Dopiero rzeczywisty health umożliwia parowanie/test.
3. Użytkownik podaje nazwę agenta i opcjonalnie wybiera dostęp tylko do odczytu. Pobiera konfigurację albo kopiuje ją do ustawień MCP.
4. Proces agenta wymienia kod w ciągu 5 minut. Przeglądarka nie dostaje tokenu Brain API ani tokenu gatewaya dla agenta.
5. Po udanym żądaniu agenta landing potwierdza **konkretny identyfikator połączenia**. Samo przygotowanie konfiguracji nie oznacza podłączenia.

MCP wymaga lokalnego Node.js 20+, npm i aplikacji obsługującej serwery MCP. Konfiguracja pobiera `.tgz` z tego connectora i uruchamia spakowany dotychczasowy serwer MCP. JavaScript instaluje ten sam pakiet w projekcie agenta. Python pobiera kompletny moduł korzystający tylko ze standardowej biblioteki; uruchomienie modułu wykonuje wyłącznie health. Nie ma obietnicy automatycznego zainstalowania rozszerzenia w każdej aplikacji.

„Test pamięci” jest jawnym zapisem syntetycznego dokumentu. Jeverson-test zapisuje, świeży Hermes-test odczytuje i sprawdza źródło/hash przez istniejący SDK. Powtórzenie z tym samym identyfikatorem testu nie dodaje dokumentu. Test nie uruchamia modeli i nie udaje połączenia rzeczywistego agenta. Dekoracyjna wizualizacja mózgu nie pokazuje dostępności ani zawartości pamięci.

## Przygotowanie przez operatora — jednorazowo

Ta część dotyczy utrzymania serwera. Nie jest krokiem użytkownika podłączającego kolejnego agenta.

Zbuduj pakiet w repozytorium:

```bash
pnpm install --frozen-lockfile
pnpm --filter @osatech/neurosa-memory build
mkdir -p .neurosa/packages
npm pack ./packages/neurosa-memory --ignore-scripts --pack-destination .neurosa/packages
```

Ustaw **po stronie serwera**, poza repozytorium: `NEUROSA_API_URL`, `NEUROSA_API_TOKEN`, `NEUROSA_BRAIN_ID`, `NEUROSA_MEMORY_NAMESPACE`, `NEUROSA_ORGANIZATION_ID`, `NEUROSA_PROJECT_ID`. Wartości muszą wskazywać istniejący, przypisany backend NeurOSA. Nowy connector nie migruje nieprzypisanych baz, nie zmienia Production i nie tworzy storage.

```bash
pnpm connect web
```

Domyślnie nasłuchuje na `127.0.0.1:8645`. Jednorazowy prywatny link pojawia się w wyjściu procesu; przekazuj go tylko uprawnionemu operatorowi i nie publikuj logu startowego. Nie jest to klucz Brain API. Link aktywuje 8-godzinny cookie `HttpOnly; SameSite=Strict`, dodatkowo `Secure` dla HTTPS. Nie ma kont, OAuth, passkeys ani formularza logowania.

Udostępnienie poza komputerem wymaga jawnych `NEUROSA_CONNECT_ALLOW_REMOTE=true`, `NEUROSA_CONNECT_PUBLIC_ORIGIN=https://...` i istniejącego reverse proxy TLS. `NEUROSA_CONNECT_PORT` zmienia port, `NEUROSA_MEMORY_PACKAGE` wskazuje zbudowane archiwum. Każdy agent musi mieć dostęp sieciowy do publicznego adresu connectora. Przeglądarkowy kod nie otrzymuje serwerowych zmiennych środowiskowych.

Nie utworzono nowego hostingu ani domeny i nie wdrożono tej zmiany do Azure/Production. Konfiguracja prawdziwego publicznego adresu wymaga środowiska wdrożeniowego i istniejącego serwerowego sekretu. Ta sesja ich nie udostępnia.

## Granice dostępu i pamięci

- Prywatny link operatora jest uprawnieniem do wystawiania połączeń w jednym przypisanym brain/scope. Publiczny landing sam nie umożliwia odczytu ani zapisu pamięci.
- Jednorazowy kod ma losowe 192 bity, wygasa po 5 minutach i jest przypisany do nazwy agenta oraz uprawnienia read-only/read-write. Wymiana jest odrzucana przy nagłówku Origin lub przeglądarkowych nagłówkach Fetch Metadata; sama autoryzacja opiera się na kodzie, nie na tych nagłówkach.
- Token gatewaya jest podpisany HMAC z separacją domeny, adresu, brain i scope; to uprawnienie connectora, nie token kanonicznego API. Jest ważny 30 dni. Rotacja serwerowego klucza unieważnia wszystkie tokeny; odwołanie pojedynczego tokenu nie jest zaimplementowane w v0.1.1.
- Uprawnienie połączenia jest zapisywane wyłącznie w środowisku agenta (`~/.config/neurosa/connections`, plik 0600). SDK: `cacheDirectory` / `false`; MCP i Python: `NEUROSA_CONNECT_CACHE_DIR`. Katalog zawiera dane dostępowe do gatewaya, bez dokumentów pamięci. Należy chronić go jak pozostałe sekrety agenta.
- Restart gatewaya zachowuje ważność wcześniej wystawionych uprawnień, jeśli adres, klucz serwerowy i scope nie zmieniają się. Niewykorzystane kody i telemetria połączeń są ulotne. Kod i cookie operatora wygasają niezależnie; ponowny start wystawia nowy jednorazowy link.
- Gateway dopuszcza tylko używane trasy status/ledger, recall, remember, dokument źródłowy oraz sesje. Nie udostępnia administracji, listy dokumentów, zdarzeń, usuwania ani dowolnego proxy. Odrzuca obce nagłówki scope, a kanoniczny backend ponownie sprawdza jego przypisanie.
- `agentId` jest pochodzeniem wpisu. Gateway przypina je do wystawionego uprawnienia i oddziela identyfikatory sesji/klucze idempotencji agentów. Zmiana nazwy w body nie daje praw. Read-only nie może zapisywać ani tworzyć/zamykać sesji; używa bezpośrednio recall.
- Izolacja nadal obejmuje **pełny brain / bazę przypisaną do jednej organizacji, projektu i namespace**. Dwa różne tenanty nie mogą współdzielić tej samej mieszanej bazy; gateway nie zastępuje izolacji w backendzie.
- Wszystkie pobrane treści są niezaufanym materiałem źródłowym. Nie zmieniają instrukcji systemowych, uprawnień, polityk ani Approval Gate. `afterMessage` domyślnie niczego nie zapisuje.
- Kontrola SHA-256 dotyczy integralności dokumentu i zgodności z ledgerem kontrolowanym przez serwer. Nie jest zewnętrznym poświadczeniem kryptograficznym. Niedostępny backend zwraca rzeczywisty błąd; opcjonalny `beforeMessage` daje `UNAVAILABLE` bez fikcyjnej pamięci.

## Weryfikacja

`tests/connect/landing.test.ts` używa rzeczywistego lokalnego HTTP gatewaya, kanonicznego Brain API i tymczasowego SQLite. Sprawdza dostęp operatora, Origin, ważność/jednorazowość kodu, przypisanie połączenia, scope, read-only, źródło/hash, idempotencję, brak fałszywej obecności agenta oraz awarię backendu. Nie są to mocki transportu.

`tests/e2e/landing.ts` instaluje `.tgz` offline w czystym projekcie i uruchamia osobne procesy SDK Node, Pythona oraz istniejącego MCP. Weryfikuje wspólny dokument i hash, ponowne użycie zapisanych uprawnień, test z landingu oraz kontrolowane restarty wyłącznie własnego testowego Brain API i gatewaya. Oryginalny `tests/e2e/universal-memory.ts` nadal wykonuje T01–T08 z prawdziwym entrypointem backendu jako osobnym procesem.

```bash
pnpm test
node --import tsx tests/e2e/landing.ts \
  .neurosa/packages/osatech-neurosa-memory-0.1.1.tgz \
  .neurosa/landing-evidence.json
```

Wyniki: [dowód procesu landingu](evidence/landing-v0.1.1.json), [T01–T08 na paczce v0.1.1](evidence/landing-universal-v0.1.1.json). Przetestowane archiwum ma SHA-256 `b280403713fcb77c0e23c6a02c49737750090e15f33e093e687727a157b1c56a` (148 KB). Raport procesu wiąże wynik także z digestem źródeł backendu i connectora.

| Kontrola                         | Rzeczywisty wynik lokalny                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Vitest                           | 169/169, 17 plików; w tym 9 nowych testów landingu na prawdziwym HTTP/SQLite                               |
| Format, ESLint, TypeScript       | PASS                                                                                                       |
| Pełny build                      | 21/21 zadań, Next/Turbo telemetry wyłączona                                                                |
| Dotychczasowy vertical slice     | PASS                                                                                                       |
| T01–T08                          | PASS; osobny proces Brain API i zainstalowany pakiet                                                       |
| L01–L07                          | PASS; osobne procesy Node, Python i zainstalowanego executable MCP, kontrolowany restart backendu/gatewaya |
| Azure / publiczny URL            | NOT_TESTED / niewdrożone                                                                                   |
| Przeglądarka / kontrola wizualna | NOT_RUN                                                                                                    |
| Wywołania modeli                 | 0                                                                                                          |

W pierwszej pełnej próbie automatyczna kontrola odrzuciła build ze względu na domyślną telemetrię Next.js. Została wyłączona w poleceniu build, przekazywaniu środowiska Turbo i CI; ponowny build przeszedł. Próba lokalna oraz [pierwszy CI](https://github.com/HazEOskA/neurosa-human-brain/actions/runs/39118308011) zakończyły E2E błędem `UND_ERR_SOCKET`; test kontenera w tym CI przeszedł. Skrypt testowy zamyka własne połączenia HTTP operatora i odczytuje do końca odpowiedź aktywacji przed kolejnym żądaniem. Po poprawce wykonano 3 kolejne lokalne L01–L07 z wynikiem PASS; błąd zawiera teraz nazwę etapu. Skrypt nie dodaje automatycznych powtórzeń zapisów do produktu. [Log pełnej próby](evidence/landing-quality-v0.1.1.log) zachowuje także nieudane E2E; końcowy lokalny dowód jest w JSON powyżej.

LIVE oznacza tu **lokalne, rzeczywiste HTTP i SQLite**, nie dowód wdrożenia chmurowego. Endpoint/klucz Azure nie były dostępne w tej sesji. Nie wykonano płatnych wywołań modeli. Log i raport nie zawierają produkcyjnych sekretów ani prywatnych danych użytkownika.

Kontrola wizualna w przeglądarce nie została wykonana: wymagane narzędzie `control-browser` jest niedostępne. Nie zastępowano go inną automatyzacją przeglądarki. Testy HTTP i procesów nie potwierdzają wyglądu ani zachowania strony w rzeczywistej przeglądarce.
