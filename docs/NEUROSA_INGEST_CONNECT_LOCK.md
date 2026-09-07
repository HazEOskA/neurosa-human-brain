# NeurOSA Ingest + Connect — zatwierdzony zakres

Baza: `build/neurosa-hb-v0.1`, `b0fc8527f41e5908ae68a59802c0ad87bda511a7`.
Gałąź wykonawcza: `build/neurosa-ingest-connect`. Zgoda operatora: „a ZATWIERDZAM”.

Jeden `NeurosaRuntime`, jedna baza SQLite i istniejący `NativeBrainWorkspace` są źródłem prawdy. Connect nie ma własnej pamięci. Drive jest trwałym źródłem wiedzy, synchronizowanym tylko do odczytu; odłączenie Drive nie usuwa natywnej pamięci. Nie wymagamy dostępu do modelu do importu ani retrievalu.

Reuse: Brain API v1, observe/remember/documents/recall, rewizje dokumentów, FTS5, HashChainLedger, tabele agents/agent_sessions/memory_records/imports. Nowe trwałe struktury służą wyłącznie idempotencji i metadanym, nie przechowują drugiej kopii treści mózgu.

Zapis dokumentu, pochodzenia, potwierdzenia operacji i zdarzenia jest jedną transakcją. Powtórzenie klucza operacji z innym wejściem daje konflikt. Aktualizacja istniejącego faktu wymaga oczekiwanej rewizji. Konflikt nie nadpisuje kanonicznej wartości; klient pobiera aktualną wersję i jawnie rozstrzyga przez zapis z jej rewizją.

Sesja: START → trwała rejestracja → status + core context + ograniczony retrieval → praca → atomowy zapis wyników → COMPLETED + ledger/SSE. Każdy klient używa tego samego adresu Brain API i brainId; prywatny stan sesji należy do uwierzytelnionego agenta. Źródła i odpowiedzi modeli są danymi, nie instrukcjami ani dowodem prawdy.

Publiczne endpointy v1 zachowują dotychczasowe pola. Rozszerzenia obejmują opcjonalne provenance/idempotency/expectedRevision i cykl sesji. Każdy adapter jest wymienny; brak konfiguracji aplikacji czatu oznacza brak automatycznego hooka, nie pozorne połączenie.

Walidacja: istniejące testy, migracja/restart, rollback transakcji, dwa różne modele, równoczesny zapis, duplikaty i konflikty, scopes, budżet kontekstu, paginacja i zmiany Drive, eksporty rozmów, prawdziwy lokalny HTTP i stdio MCP, ledger/SSE, build i smoke. Bez merge/deploy i bez zmian w innych repo.
