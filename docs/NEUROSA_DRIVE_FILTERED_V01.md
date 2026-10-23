# NeurOSA Drive connector v0.1 — explicit filtered import

## Gate and scope

A Google Drive connection **inside ChatGPT is not an OAuth grant to the deployed NeurOSA Brain**. This adapter requires a separate server-side delegated Google OAuth token broker. No tokens may be committed, logged, returned in API responses, or placed in public `NEXT_PUBLIC_*` variables.

**No automatic sync of folders.** The operator reviews the manifest from `GoogleDriveSource.inspect(folderId)` and explicitly supplies a selected set of file IDs to `syncSelected(folderId, ingest, approvedFileIds)`. An empty selection fails; IDs outside the scoped folder fail; unsupported and oversized files fail. Metadata listing does not fetch media or send data to NeurOSA Brain. The original `sync` remains backward compatible for existing controlled callers but must never be exposed as a public "sync all" endpoint.

Google Drive API scope: prefer read-only, least privilege; token exchange and revocation through an authenticated server-side broker, not a client-side public proxy. The existing Brain API requires its own `brain:read`, `memory:write`, `memory:read` scopes. The connector must verify tenant/project binding and Brain ledger before any ingest.

## API boundary (proposed, NOT YET EXPOSED)

- `GET /api/v1/connectors/google-drive/status` — authenticated, whether OAuth is connected, no token value.
- `POST /api/v1/connectors/google-drive/manifest` — authenticated metadata-only plan for an approved folder ID.
- `POST /api/v1/connectors/google-drive/import` — explicit allowlist, idempotent provenance, detailed partial/failure results.
  Endpoints require completed OAuth broker, tenant isolation, CSRF protection and integration tests before activation.

## Data minimization

Privacy exports often contain User Profile, Online Activity, Financial and other personal information. No recursive unconditional import and no silent inclusion of sensitive categories. For a source archive above the existing 10 MiB-per-file limit, require a separate chunked/streaming ingestion design and explicit approval. No Graph Projection is implied by stored documents.

## Evidence

- Integration/unit tests: metadata-only scan; selected file import; exclusion of unselected files; empty/missing/oversized selection fail-closed.
- Live external Drive authentication from NeurOSA: NOT CONFIGURED.
- Live Brain write: NOT TESTED.
- Production, main, databases and Drive content: UNCHANGED.
