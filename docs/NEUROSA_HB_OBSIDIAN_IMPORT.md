# Jednorazowy import z Obsidiana

NEUROSA-HB nie jest wtyczką do Obsidiana i nie wymaga działającego Vaultu po imporcie.
Obsidian jest wyłącznie źródłem danych. Importer otwiera Vault w trybie tylko do odczytu,
kopiuje obsługiwane dane do natywnego workspace, zapisuje dokumenty w SQLite i tworzy
wykonywalny graf neuronów oraz synaps.

## Uruchomienie

```bash
node --import tsx packages/neurosa-cli/src/cli.ts importuj obsidian ./MojVault \
  --stan .neurosa/brain.db \
  --workspace .neurosa/workspace \
  --brain MojMozg
```

Opcja `--json` zwraca raport maszynowy. Limity plików można ustawić przez
`--maks-plik-bajtow` oraz `--maks-zalacznik-bajtow`.

## Co jest kopiowane

- notatki Markdown wraz z pełną treścią,
- foldery,
- frontmatter,
- tagi i nagłówki,
- wikilinki i backlinki,
- obsługiwane załączniki: PNG, JPEG, GIF, WebP, PDF, MP3, WAV, MP4 i MOV.

Każda notatka otrzymuje stabilny dokument natywny i neuron typu `NOTE`.
Każdy rozwiązany wikilink tworzy synapsę `REFERENCES` w dedykowanym mózgu importu.
Pliki źródłowe nie są potrzebne do późniejszego odczytu, wyszukiwania ani aktywacji.

## Granice bezpieczeństwa

Importer:

- nie zapisuje do oryginalnego Vaultu,
- nie wykonuje treści notatek ani załączników,
- nie podąża za symlinkami,
- blokuje path traversal i ścieżki absolutne,
- sprawdza limit rozmiaru przed odczytem,
- wykrywa zmianę pliku w trakcie kopiowania,
- blokuje wykonywalne i skryptowe rozszerzenia,
- zapisuje kopie atomowo i weryfikuje SHA-256,
- nie pozwala, aby Vault i natywny workspace nakładały się.

Każdy import emituje rzeczywiste zdarzenia do istniejącego hash-chain ledgeru.
Raport JSON jest zapisywany pod `system/imports/` w natywnym workspace.

## Niezależność po imporcie

Po poprawnym imporcie można odłączyć albo usunąć testowy Vault źródłowy. Dokumenty,
załączniki, neurony, synapsy, raport i ledger pozostają w pamięci NEUROSA-HB.
