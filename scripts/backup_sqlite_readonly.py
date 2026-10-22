"""Create an offline, self-verified snapshot of an existing SQLite brain database.

The *source* is opened mode=ro + query_only: never checkpoint, mutate, or
copy its raw -wal/-shm files. Uses SQLite's online backup API, then validates
the copy and its SHA-256. No cloud, no paid services, no external dependencies.

A backup is NOT a successful NeurOSA restore: separately run NeurOSA's
verifyLedger and restart/recall tests on an isolated target before cutover.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
from datetime import datetime, timezone


class BackupRefused(Exception):
    pass


def _hash_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as inp:
        while piece := inp.read(1024 * 1024):
            h.update(piece)
    return h.hexdigest()


def backup_readonly(source: Path, destination: Path) -> dict:
    """Write a new destination DB and JSON manifest; never overwrite either.

    Destination must be in a different file/path from source; backup files
    are written to a temporary file in destination's directory and published
    by hardlink to prevent overwriting existing backups on concurrent calls.
    """
    source, destination = Path(source).absolute(), Path(destination).absolute()
    if not source.is_file():
        raise BackupRefused('SOURCE_DB_NOT_FOUND')
    if not source.name.endswith(('.db', '.sqlite', '.sqlite3')):
        raise BackupRefused('SOURCE_NOT_SQLITE_EXTENSION')
    manifest = destination.with_name(destination.name + '.manifest.json')
    if source == destination or source.resolve() == destination.resolve():
        raise BackupRefused('SOURCE_EQUALS_DESTINATION')
    if os.path.lexists(destination) or os.path.lexists(manifest):
        raise BackupRefused('DESTINATION_ALREADY_EXISTS')
    if not destination.parent.is_dir():
        raise BackupRefused('DESTINATION_DIRECTORY_NOT_FOUND')
    # Never perform WAL checkpoint or any source-side mutation.
    source_connection = None
    temp = None
    try:
        source_connection = sqlite3.connect(
            source.as_uri() + '?mode=ro', uri=True, timeout=10.0
        )
        source_connection.execute('PRAGMA query_only=ON')
        fd, raw_temp = tempfile.mkstemp(
            prefix='.neurosa-backup-', suffix='.sqlite.tmp', dir=destination.parent
        )
        os.close(fd)
        temp = Path(raw_temp)
        with sqlite3.connect(temp, timeout=10.0) as copy:
            source_connection.backup(copy, pages=256, sleep=0.1)
            # SQLite source is a consistent live snapshot (including WAL).
            result = copy.execute('PRAGMA integrity_check').fetchone()[0]
            if result != 'ok':
                raise BackupRefused('BACKUP_INTEGRITY_CHECK_FAILED')
            table_count = copy.execute(
                "SELECT count(*) FROM sqlite_master WHERE type='table'"
            ).fetchone()[0]
            if table_count == 0:
                raise BackupRefused('BACKUP_HAS_NO_TABLES')
            copy.commit()
        sha256 = _hash_file(temp)
        size = temp.stat().st_size
        meta = {
            'schema': 'neurosa.sqlite.snapshot.v1',
            'created_utc': datetime.now(timezone.utc).isoformat(),
            'sha256': sha256,
            'size_bytes': size,
            'sqlite_integrity': 'ok',
            'table_count': table_count,
            'source_mutated': False,
            'neurosa_ledger_verified': False,
            'restored_on_target': False,
        }
        # os.link refuses to overwrite an existing destination (unlike rename).
        os.link(temp, destination)
        with manifest.open('x', encoding='utf-8') as out:
            json.dump(meta, out, sort_keys=True, indent=2)
            out.write('\n')
        return meta
    except (OSError, sqlite3.Error) as exc:
        raise BackupRefused('BACKUP_IO_OR_SQLITE_ERROR') from exc
    finally:
        if source_connection is not None:
            source_connection.close()
        if temp is not None:
            temp.unlink(missing_ok=True)
        # Don't remove published artifact on manifest errors: user can recover
        # the valid DB manually; record it as INCOMPLETE, not verified.


def verify_snapshot(backup: Path) -> dict:
    """Read-only independent check after file transfer; no source access.

    This is NOT a proof of NeurOSA ledger validity, only SQLite integrity and
    consistency with the SHA-256 written at backup time.
    """
    backup = Path(backup).absolute()
    manifest = backup.with_name(backup.name + '.manifest.json')
    if not backup.is_file() or not manifest.is_file():
        raise BackupRefused('SNAPSHOT_OR_MANIFEST_MISSING')
    try:
        meta = json.loads(manifest.read_text(encoding='utf-8'))
        if (type(meta) is not dict
                or meta.get('schema') != 'neurosa.sqlite.snapshot.v1'
                or not isinstance(meta.get('sha256'), str)
                or len(meta['sha256']) != 64
                or type(meta.get('size_bytes')) is not int):
            raise BackupRefused('MANIFEST_INVALID')
        if (backup.stat().st_size != meta['size_bytes']
                or _hash_file(backup) != meta['sha256']):
            raise BackupRefused('SNAPSHOT_HASH_MISMATCH')
        with sqlite3.connect(backup.as_uri() + '?mode=ro', uri=True) as db:
            db.execute('PRAGMA query_only=ON')
            if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise BackupRefused('SNAPSHOT_INTEGRITY_FAILED')
        return {'status': 'SNAPSHOT_REVERIFIED', 'sha256': meta['sha256'],
                'neurosa_ledger_verified': False, 'restored_on_target': False}
    except (OSError, sqlite3.Error, ValueError, TypeError) as exc:
        raise BackupRefused('VERIFY_IO_OR_FORMAT_ERROR') from exc


def main() -> int:
    parser = argparse.ArgumentParser(description='NeurOSA offline SQLite backup/verification, read-only source')
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--source', type=Path, help='Source DB to back up')
    group.add_argument('--verify', type=Path, help='Previously created snapshot to verify')
    parser.add_argument('--destination', type=Path, help='New snapshot path, required with --source')
    args = parser.parse_args()
    try:
        if args.source is not None:
            if args.destination is None:
                parser.error('--destination is required with --source')
            meta = backup_readonly(args.source, args.destination)
            result = {'status': 'SQLITE_SNAPSHOT_VALID', **meta}
        else:
            if args.destination is not None:
                parser.error('--destination is only valid with --source')
            result = verify_snapshot(args.verify)
        print(json.dumps(result, sort_keys=True))
        return 0
    except BackupRefused as exc:
        print(json.dumps({'status': 'BLOCKED', 'reason': str(exc)}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
