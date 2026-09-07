# NEUROSA-HB — Living Brain 3D

Status: odzyskany kontrakt Checkpoint D, dostosowany do canonical `main`.

## Cel

Living Brain jest wyłącznie projekcją rzeczywistego stanu NEUROSA-HB. Nie tworzy fikcyjnych neuronów, synaps, aktywacji ani eventów. Źródłem prawdy pozostają runtime, SQLite/WAL i hash-chain ledger.

## Dane

Interfejs pobiera:

- `GET /api/v1/brain/status`
- `GET /api/v1/brain/neurons`
- `GET /api/v1/brain/synapses`
- `GET /api/v1/brain/ledger/verify`
- `GET /api/v1/brain/events`
- `GET /api/v1/brain/events/stream` przez autoryzowany strumień SSE
- `POST /api/v1/brain/activate` dla jawnego testu operatora

Każde światło, impuls i aktywna synapsa wynika z rzeczywistego eventu runtime. Brak eventu oznacza brak efektu wizualnego.

## Model przestrzenny

`@neurosa/brain-visualization` deterministycznie przypisuje neuronom pozycje 3D z `brainId`/regionu/identyfikatora neuronu, odrzuca synapsy bez istniejących końców i utrzymuje stan efektów na podstawie monotonicznej sekwencji eventów.

Obsługiwane efekty obejmują:

- `NEURON_ACTIVATED`
- `NEURON_FIRED`
- `NEURON_INHIBITED`
- `SYNAPSE_ACTIVATED`
- `IMPULSE_CREATED`
- `IMPULSE_DELIVERED`
- przyszłe `SYNAPSE_FORMED` / pruning, jeśli runtime zacznie je emitować

## Bezpieczeństwo

Token jest używany tylko w bieżącej sesji komponentu i nie jest zapisywany w localStorage. Brain API pozostaje deny-by-default. Produkcyjny dostęp zdalny wymaga HTTPS/gateway oraz jawnego CORS zgodnie z `docs/NEUROSA_DEPLOYMENT.md`.

## Recovery evidence

Historyczny Checkpoint D na `build/checkpoint-d-living-brain-3d-20260803` był uszkodzony: `chunk-02.b64` zawierał pełny duplikat `chunk-03.b64`, a gzip miał uszkodzony/niekompletny strumień. Z częściowego TAR odzyskano kompletne pliki aplikacji, CSS, pakiet wizualizacji i testy. Uszkodzone identyfikatory oraz brakujący `living-brain-workspace.tsx` odtworzono na podstawie testów Checkpoint D i aktualnych typów `NeuronState`, `SynapseState`, `BrainEvent` oraz endpointów Brain API na canonical `main`.

Recovery nie zmienia silnika pamięci, runtime'u, Connect ani Ingest.
