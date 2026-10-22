# NeurOSA — offline migration gate (DRAFT, no cutover)

This runbook applies to an **existing NeurOSA Brain API SQLite/WAL database**.
It does **not** migrate data automatically. It must not run against real
records until the operator identifies the source and approves the local
backup destination. No new cloud resources, no network exposure, no fees.

## Known code invariants

- Brain API accepts `NEUROSA_DATABASE_PATH` (container default
  `/data/brain.db`; local default `.neurosa/brain.db`).
- The repository has SQLite schema v3, `better-sqlite3`, WAL, a hash-chain
  ledger and `verifyLedger()`.
- `/health` proves an HTTP process is up, **not** that persistent memory is
  restored or that the ledger is valid.
- A Google Drive chat export or Obsidian Vault is **input**, not a replacement
  for the live NeurOSA SQLite database.
- An existing Docker named volume persists container state, but **is not
  an off-host backup**.

## Gates — STOP before advancing if UNKNOWN

1. **Read-only source inventory.** Identify *all* existing NeurOSA stores:
   VM/container volume, workstation data path, archived snapshots and any
   external export. Confirm actual SQLite source(s), schema and provenance;
   do not assume a previously passing smoke test equals preserved user data.
   If a cloud VM is deallocated, **do not start it without separate approval**
   and a no-cost/hard-stop assessment.
2. **Source snapshot.** Only after source location and authorized backup
   destination are confirmed, use `scripts/backup_sqlite_readonly.py` to
   create a new local snapshot via SQLite's online Backup API. It connects
   to source with `mode=ro`, does not checkpoint WAL or overwrite existing
   destinations. New backup and `.manifest.json` file contain size, SHA-256,
   and SQLite `integrity_check` status. Keep private outside GitHub.
3. **Independent file validation.** After transfer, use the utility's
   `--verify` mode on the *copy* to recompute SHA-256 and SQLite integrity,
   without requiring access to the source or mutating the copy.
4. **Restore to a NEW isolated destination.** The backup utility never
   restores or replaces an existing DB. Only after a verified file is
   available should the operator provision the target storage, restore to
   a new path and run native NeurOSA `verifyLedger()` and same-brainId
   authenticated status checks. Test remember/recall, restart, and
   recall-after-restart with synthetic records.
5. **Target host check first.** Confirm OS, storage health, memory, free disk,
   stable power and network before installing Node/Docker; do not assume
   Linux, working USB, stable Wi-Fi or sufficient space. One Brain API
   process, one SQLite/WAL data store, loopback `127.0.0.1:8644` only.
   Do not expose port 8644 to internet or LAN.
6. **Sherlock test:** use a separate **fictional case/brain/database** and
   verify the same durable-approval semantics proved in Sherlock Phase 5:
   write, restart, recall, three one-time tickets, replay refusal and
   preserved counterevidence. The prior GitHub Actions synthetic test is
   *not* a test of the user's on-prem host.
7. **Cutover review:** archive manifest, backup location (privately), code
   SHA, target schema, ledger check and post-restart proof. Keep source
   unchanged until all gates PASS and separate cutover approval. Never
   turn off/delete a source or migrate production connections automatically.

## Operator-only future examples (DO NOT run from this document automatically)

With a confirmed source and separate empty backup directory:

```bash
python3 scripts/backup_sqlite_readonly.py --source /secure/brain.db --destination /secure-backups/brain-2026.sqlite
python3 scripts/backup_sqlite_readonly.py --verify /secure-backups/brain-2026.sqlite
```

The snapshot and manifest are sensitive and remain outside source control.
A valid snapshot is **not** an authenticated NeurOSA ledger proof.

## Evidence and exclusions

- Local synthetic unit tests:
  `cd scripts && python3 -m unittest -v test_backup_sqlite_readonly.py`
- Covers committed WAL, source unchanged, no overwrite, missing source,
  tampered backup/manifest and independent verification.
- This branch has NOT accessed any actual VM, local host, users' SQLite
  files or cloud API. No Azure CLI, no GitHub Actions run, no merge/deploy.
- Result labels: **UTILITY TESTED LOCALLY** / **REAL BACKUP UNKNOWN** /
  **DELL HOST UNKNOWN** / **CUTOVER BLOCKED**.
