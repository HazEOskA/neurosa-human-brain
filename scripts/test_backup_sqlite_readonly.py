"""Synthetic-only tests; never touch Azure or real Brain databases."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import unittest

from backup_sqlite_readonly import BackupRefused, backup_readonly, verify_snapshot


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.src = self.root / 'brain.db'
        self.dst = self.root / 'backup.sqlite'
        with sqlite3.connect(self.src) as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE memory(k TEXT PRIMARY KEY, v TEXT)')
            db.execute("INSERT INTO memory VALUES('test','synthetic only')")
            db.commit()

    def test_committed_wal_snapshot_and_manifest_hash(self):
        with sqlite3.connect(self.src) as writer:
            writer.execute('PRAGMA journal_mode=WAL')
            writer.execute("INSERT INTO memory VALUES('wal','committed WAL')")
            writer.commit()
            status = backup_readonly(self.src, self.dst)
        self.assertEqual(status['sqlite_integrity'], 'ok')
        self.assertFalse(status['neurosa_ledger_verified'])
        self.assertFalse(status['restored_on_target'])
        with sqlite3.connect(self.dst) as copy:
            self.assertEqual(copy.execute('SELECT count(*) FROM memory').fetchone()[0], 2)
        self.assertEqual(hashlib.sha256(self.dst.read_bytes()).hexdigest(), status['sha256'])
        doc = json.loads(self.dst.with_name(self.dst.name + '.manifest.json').read_text())
        self.assertEqual(doc['sha256'], status['sha256'])

    def test_preexisting_destination_never_overwritten(self):
        self.dst.write_bytes(b'preexisting')
        with self.assertRaisesRegex(BackupRefused, 'DESTINATION_ALREADY_EXISTS'):
            backup_readonly(self.src, self.dst)
        self.assertEqual(self.dst.read_bytes(), b'preexisting')

    def test_existing_manifest_blocks_backup(self):
        manifest = self.dst.with_name(self.dst.name + '.manifest.json')
        manifest.write_text('old')
        with self.assertRaisesRegex(BackupRefused, 'DESTINATION_ALREADY_EXISTS'):
            backup_readonly(self.src, self.dst)
        self.assertFalse(self.dst.exists())

    def test_source_path_never_target(self):
        with self.assertRaisesRegex(BackupRefused, 'SOURCE_EQUALS_DESTINATION'):
            backup_readonly(self.src, self.src)

    def test_missing_source_fails_closed(self):
        with self.assertRaisesRegex(BackupRefused, 'SOURCE_DB_NOT_FOUND'):
            backup_readonly(self.root / 'missing.db', self.dst)

    def test_backup_retains_state_when_source_still_open(self):
        orig = hashlib.sha256(self.src.read_bytes()).hexdigest()
        backup_readonly(self.src, self.dst)
        self.assertEqual(hashlib.sha256(self.src.read_bytes()).hexdigest(), orig)
        self.assertGreater(self.dst.stat().st_size, 0)

    def test_verify_snapshot_after_copy(self):
        backup_readonly(self.src, self.dst)
        result = verify_snapshot(self.dst)
        self.assertEqual(result['status'], 'SNAPSHOT_REVERIFIED')
        self.assertFalse(result['neurosa_ledger_verified'])

    def test_detect_altered_snapshot_sha(self):
        backup_readonly(self.src, self.dst)
        with self.dst.open('ab') as output:
            output.write(b'tamper')
        with self.assertRaisesRegex(BackupRefused, 'SNAPSHOT_HASH_MISMATCH'):
            verify_snapshot(self.dst)

    def test_verify_without_manifest_fails_closed(self):
        backup_readonly(self.src, self.dst)
        self.dst.with_name(self.dst.name + '.manifest.json').unlink()
        with self.assertRaisesRegex(BackupRefused, 'SNAPSHOT_OR_MANIFEST_MISSING'):
            verify_snapshot(self.dst)


if __name__ == '__main__':
    unittest.main()
