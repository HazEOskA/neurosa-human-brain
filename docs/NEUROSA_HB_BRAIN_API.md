# Lokalne Brain API NEUROSA-HB

Brain API jest wersjonowanym, lokalnym interfejsem dla Hydry i innych agentów.
Domyślnie nasłuchuje wyłącznie na `127.0.0.1`. Wszystkie endpointy poza `/health`
wymagają tokenu Bearer, a operacje są blokowane, dopóki token nie posiada jawnego scope.

## Uruchomienie

```bash
NEUROSA_API_TOKEN="wstaw-lokalny-token-minimum-24-znaki" \
  pnpm brain:api
```

Opcjonalne zmienne:

- `NEUROSA_API_PORT` — domyślnie `8644`,
- `NEUROSA_BRAIN_SOURCE` — plik `.nsa`,
- `NEUROSA_DATABASE_PATH` — baza SQLite,
- `NEUROSA_AGENT_ID` — identyfikator klienta,
- `NEUROSA_API_SCOPES` — lista scope rozdzielona przecinkami,
- `NEUROSA_ALLOWED_ORIGINS` — jawna lista originów CORS.

## Scope’y

- `brain:read`
- `brain:activate`
- `memory:read`
- `memory:write`
- `events:read`
- `admin`

`admin` obejmuje wszystkie operacje. Brak scope oznacza `403 BRAK_UPRAWNIEŃ`.

## Endpointy v1

- `GET /health`
- `GET /api/v1/brain/status`
- `GET /api/v1/brain/regions`
- `GET /api/v1/brain/neurons`
- `GET /api/v1/brain/neurons/{id}`
- `GET /api/v1/brain/synapses`
- `GET /api/v1/brain/events`
- `GET /api/v1/brain/events/stream`
- `GET /api/v1/brain/ledger/verify`
- `POST /api/v1/brain/activate`
- `GET /api/v1/brain/activations/{id}`
- `GET /api/v1/documents`
- `GET /api/v1/documents/{id}`
- `POST /api/v1/documents`
- `PATCH /api/v1/documents/{id}`
- `DELETE /api/v1/documents/{id}`
- `POST /api/v1/brain/recall`
- `POST /api/v1/brain/remember`
- `POST /api/v1/brain/observe`

## Strumień zdarzeń

`GET /api/v1/brain/events/stream` używa Server-Sent Events. Impulsy nie są
symulowane przez API. Po aktywacji serwer publikuje dokładnie te zdarzenia,
które rzeczywisty runtime dopisał do hash-chain ledgeru. Ten stream będzie
źródłem prawdy dla modelu mózgu 3D.

## Zabezpieczenia

- deny-by-default,
- porównywanie tokenów w stałym czasie,
- limit zapytań na token i endpoint,
- limit rozmiaru JSON,
- jawny CORS bez wildcard,
- correlation ID w każdym wyniku,
- limity propagacji aktywacji,
- lokalny bind bez publicznego admin API,
- brak wykonywania treści dokumentów.
