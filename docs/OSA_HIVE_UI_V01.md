# OSA HIVE v0.2 × NeurOSA — integration slice

**Branch-only UI implementation** for apps/brain-web; no production deploy, no schema, no auth, no Brain API mutation.

## Design tokens
Canonical tokens for this slice: apps/brain-web/app/osa-hive.css (--h-*).
Black #08090B, yellow #F5CF2F, carbon accents, accessible keyboard focus.
neurosa.ai branding and direct GitHub link stay in the shared header.
Other products are *navigation links*, not cross-product API connections.

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
