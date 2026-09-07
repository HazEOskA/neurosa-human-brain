# Przygotowanie NeurOSA do wdrożenia

Zakres: istniejący Brain API, Connect i Ingest. Jeden proces runtime'u i jeden lokalny magazyn SQLite/WAL na trwałym dysku. Architecture lock dla pamięci nadal obowiązuje. Google Drive jest źródłem wiedzy, a nie zamiennikiem bazy runtime'u.

## Bramka CI

Workflow `neurosa-ci.yml` uruchamia się dla push na `build/neurosa-ingest-connect` i `main` oraz PR do `main`. Sprawdza format, lint, typy, testy, kompilację, build i smoke. Oddzielne zadanie buduje obraz i wykonuje rzeczywisty test kontenera. Workflow ma wyłącznie `contents: read`; nie wykonuje merge, push obrazu ani deployu.

Dowody zawierają SHA commita, SHA drzewa, logi bramek i identyfikator zbudowanego obrazu. Dla PR checkout sprawdza commit integracyjny GitHuba. Zielony wcześniejszy commit nie zastępuje wyniku bieżącego SHA.

`pnpm smoke:deployment` testuje prawdziwy proces. `pnpm smoke:deployment docker neurosa:ci` wymaga Dockera i zbudowanego obrazu. Oba testy zapisują sesję, odtwarzają proces/kontener po normalnym zakończeniu i po SIGKILL, sprawdzają recall, zachowanie wcześniejszych zdarzeń, ledger, idempotencję, 401 bez tokenu i 409 dla innego brainId. Test kontenera usuwa poprzedni kontener i tworzy nowy na tym samym nazwanym wolumenie.

## Kontrakt nasłuchu

| Zmienna                    | Domyślnie poza obrazem | Znaczenie                                                  |
| -------------------------- | ---------------------- | ---------------------------------------------------------- |
| `NEUROSA_API_HOST`         | `127.0.0.1`            | Loopback lub jawny wildcard `0.0.0.0` / `::`               |
| `NEUROSA_ALLOW_REMOTE`     | `false`                | `true` jest wymagane dla wildcard                          |
| `NEUROSA_API_PORT`         | `PORT`, potem `8644`   | Ma pierwszeństwo przed `PORT`                              |
| `NEUROSA_DATABASE_PATH`    | `.neurosa/brain.db`    | W obrazie: `/data/brain.db`                                |
| `NEUROSA_CREDENTIALS_FILE` | brak                   | Plik tokenów i scopes klientów, montowany tylko do odczytu |

Publiczne HTTP nie jest docelowym sposobem połączenia. Przed dostępem zdalnym potrzebny jest zweryfikowany gateway HTTPS, ochrona portu backendu i właściwe tokeny/scopes. `allowRemote` w `BrainApiStartOptions` to opcjonalne rozszerzenie; dotychczasowe wywołania pozostają lokalne. Connect nadal wymaga HTTPS poza loopback.

Obraz świadomie włącza wildcard na porcie 8080 i uruchamia istniejący entrypoint jako użytkownik `node` (UID 1000), bez powłoki pośredniej. Używa `tsx` i zależności workspace zgodnie z obecnym sposobem uruchamiania repo; dotychczasowy `build` to sprawdzenie TypeScript, nie osobny bundle.

## Lokalny test operatora

Poniższe polecenia tworzą wyłącznie lokalny kontener i nazwany wolumen. Token ustaw poza repo; nie umieszczaj go w obrazie ani commicie. Przykład korzysta z istniejącego trybu jednego operatora. Dla wielu agentów zamontuj plik `NEUROSA_CREDENTIALS_FILE` opisany w `NEUROSA_CONNECT.md`.

```bash
docker build --tag neurosa:local .
: "${NEUROSA_API_TOKEN:?Ustaw token o długości co najmniej 24 znaków}"
export NEUROSA_API_TOKEN
docker volume create neurosa-data
docker run --detach --name neurosa-brain \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --tmpfs /tmp:rw,nosuid,noexec,size=16m \
  --publish 127.0.0.1:8644:8080 \
  --mount type=volume,source=neurosa-data,target=/data \
  --env NEUROSA_API_TOKEN neurosa:local
curl --fail http://127.0.0.1:8644/health
```

`/health` potwierdza gotowość HTTP. Pełne sprawdzenie wymaga uwierzytelnionego statusu, poprawnego brainId, ledgeru oraz zapisu i recall po odtworzeniu kontenera.

## Granica wdrożenia produkcyjnego

Przed deployem należy potwierdzić docelowy host GCP, uprawnienia, HTTPS oraz trwały dysk o semantyce wymaganej przez SQLite/WAL. Nie dopuszczamy wielu niezależnych kopii bazy ani skalowania procesów runtime'u. Samo ograniczenie liczby instancji nie jest dowodem trwałości danych. Kontener bez zamontowanego `/data` nie spełnia kontraktu trwałego mózgu.

Przeniesienie do hostingu wymagającego innego storage wymaga osobnego architecture lock; w tym etapie nie zmieniono silnika bazy. Do backupu i rollbacku zastosuj procedurę migracji schema v3 z `NEUROSA_CONNECT.md`. Nazwany wolumen i test odtworzenia kontenera nie zastępują backupu poza hostem.

Status live pozostaje UNKNOWN do czasu wykonania testu na docelowym hostingu. Living Brain D pozostaje BLOCKED z powodu uszkodzonej paczki źródłowej; ten kontener udostępnia Brain API, a nie odzyskany interfejs 3D. Zdalne konta modeli i Drive wymagają osobnej konfiguracji i weryfikacji.
