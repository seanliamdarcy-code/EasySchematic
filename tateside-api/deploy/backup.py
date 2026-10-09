#!/usr/bin/python3
"""Consistent online SQLite/repository backup to an encrypted restic repository."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import tempfile
from datetime import datetime, timezone


def restic_environment():
    config = {}
    for line in Path('/etc/easyschematic-backup/restic.env').read_text().splitlines():
        if line and not line.startswith('#'):
            key, value = line.split('=', 1)
            config[key] = value
    return {**os.environ, **config}


def snapshot(destination):
    source = Path('/var/lib/tateside-schematic')
    data = destination / 'data'
    data.mkdir()
    live = sqlite3.connect(f'file:{source}/tateside.db?mode=ro', uri=True)
    db = sqlite3.connect(data / 'tateside.db')
    live.backup(db)
    live.close()
    assert db.execute('PRAGMA integrity_check').fetchall() == [('ok',)]
    assert not db.execute('PRAGMA foreign_key_check').fetchall()
    repository = data / 'schematic-repository'

    def pointer(schematic_id, name, content_hash):
        assert re.fullmatch(r'[a-zA-Z0-9_-]+', schematic_id)
        assert re.fullmatch(r'[a-f0-9]{64}', content_hash)
        path = repository / 'schematics' / schematic_id / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content_hash + '\n')

    hashes = set()
    for sid, sequence, content_hash in db.execute('SELECT schematic_id,version_sequence,content_hash FROM schematic_versions'):
        assert isinstance(sequence, int) and sequence > 0
        pointer(sid, f'versions/{sequence:06}.sha256', content_hash)
        hashes.add(content_hash)
    for sid, content_hash in db.execute('SELECT id,current_hash FROM schematics'):
        pointer(sid, 'current.sha256', content_hash)
        hashes.add(content_hash)
    # Objects are immutable. Rebuild mutable pointers from the same SQLite snapshot,
    # so concurrent saves cannot create a database/repository mismatch.
    for content_hash in hashes:
        relative = Path('objects') / content_hash[:2] / (content_hash + '.json')
        original = source / 'schematic-repository' / relative
        target = repository / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(original, target)
        assert hashlib.sha256(target.read_bytes()).hexdigest() == content_hash
    counts = {table: db.execute('SELECT count(*) FROM ' + table).fetchone()[0]
              for table in ['devices', 'device_versions', 'schematics', 'schematic_versions']}
    db.close()
    config_paths = [
        '/etc/systemd/system/tateside-schematic-api.service',
        '/etc/systemd/system/tateside-schematic-api.service.d',
        '/etc/tateside-schematic-api', '/etc/easyschematic-production',
        '/etc/easyschematic-office-production.env',
        '/etc/systemd/system/easyschematic-office-production.service', '/etc/caddy/Caddyfile',
    ]
    for name in config_paths:
        original = Path(name)
        target = destination / 'config' / original.relative_to('/')
        target.parent.mkdir(parents=True, exist_ok=True)
        if original.is_dir():
            shutil.copytree(original, target)
        else:
            shutil.copy2(original, target)
    release = subprocess.check_output(['systemctl', 'show', 'tateside-schematic-api.service', '-p', 'WorkingDirectory', '--value'], text=True).strip()
    metadata = {'createdAt': datetime.now(timezone.utc).isoformat(), 'counts': counts,
                'objects': len(hashes), 'releaseDirectory': release,
                'build': json.loads((Path(release) / 'dist-tateside-api/build-info.json').read_text())}
    (destination / 'manifest.json').write_text(json.dumps(metadata, indent=2))
    checksums = []
    for path in sorted(destination.rglob('*')):
        if path.is_file():
            checksums.append(f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.relative_to(destination).as_posix()}\n')
    (destination / 'SHA256SUMS').write_text(''.join(checksums))
    return metadata


def main():
    os.umask(0o077)
    state = Path('/var/lib/easyschematic-backup')
    state.mkdir(mode=0o700, exist_ok=True)
    with (state / 'lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        status_path = state / 'status.json'
        previous = json.loads(status_path.read_text()) if status_path.exists() else {}
        try:
            with tempfile.TemporaryDirectory(prefix='snapshot-', dir=state) as directory:
                metadata = snapshot(Path(directory))
                tar = subprocess.Popen(['tar', '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '-cf', '-', '-C', directory, '.'], stdout=subprocess.PIPE)
                try:
                    result = subprocess.run(['restic', 'backup', '--json', '--stdin', '--stdin-filename', 'easyschematic-production.tar', '--tag', 'production,daily'],
                                            stdin=tar.stdout, capture_output=True, text=True, env=restic_environment())
                finally:
                    tar.stdout.close()
                assert tar.wait() == 0, 'Archive creation failed'
                assert result.returncode == 0, 'Encrypted upload failed: ' + result.stderr[-1000:]
                summary = next(json.loads(line) for line in result.stdout.splitlines() if json.loads(line).get('message_type') == 'summary')
                status = {'ok': True, 'lastSuccess': datetime.now(timezone.utc).isoformat(),
                          'snapshotId': summary['snapshot_id'], 'metadata': metadata}
                status_path.write_text(json.dumps(status, indent=2))
                print(json.dumps(status))
        except Exception as error:
            status_path.write_text(json.dumps({'ok': False, 'lastSuccess': previous.get('lastSuccess'),
                                              'failedAt': datetime.now(timezone.utc).isoformat(), 'error': str(error)}, indent=2))
            raise


if __name__ == '__main__':
    main()
