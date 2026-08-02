# NEUROSA-HB

> Daj agentom mózg, nie tylko okno kontekstu.

NEUROSA Human Brain Runtime jest niezależną, lokalną i programowalną warstwą poznawczą dla systemów agentowych. Zapewnia trwały, kontrolowany i audytowalny stan poznawczy bez uzależnienia od jednego frameworka agentowego, dostawcy modeli, chmury albo grafowej bazy danych.

## Aktualny zakres

Zaimplementowany przepływ:

`.nsa → lexer → parser → AST → analiza semantyczna → kontrola typów → IR 0.1 → runtime → aktywacja → SQLite → hash-chain ledger`

Runtime obsługuje neurony, rzeczywiste synapsy pobudzające i hamujące, ograniczoną propagację impulsów, pełny ślad aktywacji, trwały stan oraz odtworzenie po restarcie.

Checkpoint A dodaje natywne środowisko pamięci: foldery, dokumenty Markdown, frontmatter, tagi, nagłówki, wikilinki, backlinki, przypięcia, ulubione, kosz, niezmienne rewizje i lokalne wyszukiwanie SQLite FTS5. Dokumenty są własnością NEUROSA-HB i nie wymagają Obsidiana.

## Wymagania

- Node.js 24 lub nowszy,
- pnpm 11.7.0.

## Instalacja

```bash
pnpm install
```

## Polski interfejs CLI

```text
Użycie:
  neurosa <polecenie> <plik.nsa> [opcje]

Polecenia:
  parsuj
  sprawdz
  kompiluj
  zbadaj
  formatuj
  uruchom
```

Techniczne aliasy `parse`, `check`, `compile`, `inspect`, `format`, `run` pozostają dostępne dla kompatybilności. Komunikaty operatora pozostają po polsku.

### Uruchomienie aktywacji

```bash
node --import tsx packages/neurosa-cli/src/cli.ts uruchom \
  examples/minimal-brain/brain.nsa \
  --stan .neurosa/brain.db \
  --neuron BrainArchitecture \
  --sila 1 \
  --maks-skoki 8 \
  --limit-zdarzen 500 \
  --limit-czasu-ms 5000 \
  --deterministycznie
```

Opcja `--json` zwraca stabilny wynik maszynowy. Polecenie `formatuj` przyjmuje `--zapisz`; techniczny alias `--write` pozostaje kompatybilny.

## Zabezpieczenia wykonania

Każda aktywacja posiada limit skoków, minimalną siłę impulsu, limit zdarzeń, limit czasu, wykrywanie cykli i możliwość anulowania. Impulsy przechodzą wyłącznie przez synapsy zapisane w skompilowanym IR.

Ledger jest uporządkowany, tylko do dopisywania, połączony skrótami SHA-256 i przechowywany razem ze stanem runtime’u w SQLite. Metoda `verifyLedger()` wykrywa zmianę payloadu, usunięcie lub przestawienie zdarzenia oraz nieprawidłowe `previousHash` i `eventHash`.

Storage jest ukryty za interfejsami repozytoriów i korzysta ze stabilnego `better-sqlite3`, WAL, foreign keys oraz jawnych migracji. Migracja schema v1 → v2 zachowuje dotychczasowy stan runtime’u i ledger.

## Walidacja

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm check
pnpm compile
pnpm build
pnpm smoke
```

## Recovery build

Repozytorium jest funkcjonalną rekonstrukcją po utracie wcześniejszego, niewypchniętego workspace scratch. Nie deklaruje odzyskania dawnych obiektów Git ani identycznych źródeł.

Pełne zamknięte decyzje techniczne znajdują się w [Architecture Lock](docs/NEUROSA_HB_ARCHITECTURE_LOCK.md).
