# Checkpoint 1 Recovery

The original local Git bundle was verified before recovery.

- Original branch: `build/neurosa-hb-v0.1`
- Original local HEAD: `05c2a88a250c2542c34107ea17039a306185fde6`
- Original commit message: `chore: initialize neurosa-hb durable monorepo foundation`
- Bundle verification: PASS
- Bundle history: complete

The branch was reconstructed through the authenticated GitHub connector because the ephemeral workspace did not contain authenticated Git credentials.

The original bundle and source archive remain the canonical exact recovery artifacts. Their SHA-256 values are recorded in `CHECKSUMS.sha256`.

The reconstructed branch preserves the foundation source files and Architecture Lock. The original `pnpm-lock.yaml` remains present in the verified source archive and bundle; it must be restored from either artifact before claiming byte-for-byte equivalence with the original tree.
