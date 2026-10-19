# OSA HIVE v0.2 × NeurOSA — integration slice

**Branch-only UI implementation** for apps/brain-web; no production deploy, no schema, no auth, no Brain API mutation.

## Design tokens

Canonical tokens for this slice: apps/brain-web/app/osa-hive.css (--h-*).
Black #08090B, yellow #F5CF2F, carbon accents, accessible keyboard focus.
neurosa.ai branding and direct GitHub link stay in the shared header.
Other products are _navigation links_, not cross-product API connections.

## Runtime continuity

- apps/brain-web/app/page.tsx and LivingBrainWorkspace remain 3D-first, preserving the existing live SSE, neuron and synapse interactions.
- apps/brain-web/app/memory/contextual-export/page.tsx adds a native Next.js route.
- Source import, digest, export, clipboard, Android Web Share, and AI portals run in the client.
- No fake Connected/VERIFIED, no fabricated compiled graph, and no unapproved API calls.
- No second memory store. Real compiler and recall must integrate with the existing authenticated neurosa-human-brain API after a separate interface audit and approval.

## Acceptance

- Native route /memory/contextual-export, shared header on / and bridge.
- Logo 'neurosa.ai' and GitHub repository clickable.
- OSA Proof / Jeverson / Academy links visible.
- Local import JSON/MD/TXT <= 6 MiB, invalid JSON rejected.
- SHA-256 from original input bytes, consistent exports.
- Clipboard and Share are explicit user actions.
- No private content in external URLs.
- Desktop/mobile responsive (including narrow Android viewport).
- Fixture / model / runtime untouched. No deployment.

## Follow-up gates

(1) CI/typecheck/build and desktop+mobile browser tests for branch SHA.
(2) Real NeurOSA Brain API contract, auth, streaming upload and scopes — separate approval.
(3) Propagate accepted design tokens to OSA Proof only after confirming no duplicate control plane.

## C02 — Real Brain API handoff (opt-in)

- The client verifies the configured origin over GET /api/v1/brain/status with a bearer token (required brain:read).
- A **separate explicit consent** is required for POST /api/v1/brain/observe (memory:write). It stores the original source as an observation in **existing** NeurOSA Brain; it does not claim semantic compilation or new graph edges.
- POST /api/v1/brain/recall (memory:read) tests retrieval explicitly, without auto-inserting retrieved data into other apps.
- HTTPS required except localhost; no token in URL, localStorage or repo, no implicit retries. CORS/remote TLS must be configured by the Brain operator. A local Brain API on 127.0.0.1 is not remotely accessible from arbitrary users.
- Single-item limit 900000 chars from Brain API, and browser file cap 6MiB; large history requires server-side streaming pipeline (out of scope).
- No real Brain API endpoints invoked during preview deployment or CI. Integration requires live operator endpoint+scope verification, not a fabricated Connected badge.
- Follow-up: reuse @neurosa/ingest parseConversationExport for branched chat transcripts via an authenticated server-side ingestion flow; no duplicate semantic compiler.

## C03 — Structured Conversation Import
- The browser imports 1–20 conversations per explicit batch, retaining source IDs, roles and ChatGPT branch parent references with the canonical `parseConversationExport` parser shared with the server-side importer.
- Each observation uses content SHA-256, stable source provenance and an idempotency key derived from project, source ID and version.
- All items are validated before the first request; writes are sequential, stop on the first failure and report PARTIAL status. Partial writes are NOT rolled back.
- No automatic graph synthesis; `brain/observe` stores canonical knowledge documents. Large archives (6 GB) require an independently designed, authenticated streaming service.
