"""Apply a verified public update bundle without changing any Buzz services."""
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path('/docker/fmg-buzz-updates')
PUBLIC = ROOT / 'public'
ROOT.mkdir(mode=0o755, parents=True, exist_ok=True)
lock = (ROOT / 'publish.lock').open('a')
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
archive = Path(sys.argv[1]).resolve()
assert str(archive).startswith('/tmp/fmg-updates-') and archive.stat().st_size < 500 * 1024 * 1024
receipt = {'schema': 1, 'recorded_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
           'state': 'validating', 'gateway_changed': False, 'models_executed': False}


def persist(path, data):
    temporary = path.with_name(path.name + '.pending')
    with temporary.open('wb') as file:
        file.write(data)
        file.flush()
        os.fsync(file.fileno())
    temporary.chmod(0o644)
    os.replace(temporary, path)


def json_bytes(value):
    return (json.dumps(value, indent=2) + '\n').encode()


try:
    with tempfile.TemporaryDirectory(prefix='publish-', dir=ROOT) as directory:
        staged = Path(directory)
        with tarfile.open(archive) as bundle:
            entries = bundle.getmembers()
            assert len(entries) <= 30 and sum(row.size for row in entries) < 500 * 1024 * 1024
            assert all(row.isfile() and row.name in ('manifest.json', 'server.py') or
                       row.isfile() and re.fullmatch(r'payload/[a-z0-9_.-]+', row.name)
                       for row in entries)
            bundle.extractall(staged, filter='data')
        manifest = json.loads((staged / 'manifest.json').read_bytes())
        assert manifest['schema'] == 1
        for name, digest in manifest['files'].items():
            assert name in ('server.py',) or re.fullmatch(r'payload/[a-z0-9_.-]+', name)
            assert hashlib.sha256((staged / name).read_bytes()).hexdigest() == digest
        PUBLIC.mkdir(mode=0o755, exist_ok=True)
        artifact_dir = PUBLIC / 'artifacts'
        artifact_dir.mkdir(mode=0o755, exist_ok=True)
        assert not PUBLIC.is_symlink() and not artifact_dir.is_symlink()
        existing = list(artifact_dir.iterdir())
        assert len(existing) <= 40 and all(row.is_file() and not row.is_symlink() for row in existing)
        new_size = sum((staged / row['source']).stat().st_size for row in manifest['releases'])
        assert len(existing) + sum(not (PUBLIC / row['destination']).exists() for row in manifest['releases']) <= 40
        assert sum(row.stat().st_size for row in existing) + new_size <= 2 * 1024**3
        # Every release is checked before any public feed changes.
        for release in manifest['releases']:
            platform = release['platform']
            assert platform in ('android', 'windows')
            feed_dir = PUBLIC / platform
            feed_dir.mkdir(mode=0o755, exist_ok=True)
            assert not feed_dir.is_symlink()
            feed = release['feed']
            current = feed_dir / 'latest.json'
            if current.exists():
                previous = json.loads(current.read_bytes())
                if platform == 'android':
                    assert feed['build_number'] >= previous['build_number'], 'android_downgrade'
                    same = feed['build_number'] == previous['build_number']
                else:
                    version = lambda value: tuple(map(int, re.fullmatch(r'(\d+)\.(\d+)\.(\d+)-fmg\.(\d+)', value).groups()))
                    assert version(feed['version']) >= version(previous['version']), 'desktop_downgrade'
                    same = feed['version'] == previous['version']
                if same:
                    assert feed == previous, 'immutable_version_conflict'
            assert release['source'] in manifest['files']
            binary = staged / release['source']
            digest = hashlib.sha256(binary.read_bytes()).hexdigest()
            suffix = 'apk' if platform == 'android' else 'exe'
            assert release['destination'] == f'artifacts/{digest}.{suffix}'
            if platform == 'android':
                assert feed['sha256'] == digest and feed['bytes'] == binary.stat().st_size
                assert feed['application_id'] == 'xyz.fmg.buzz.mobile'
            else:
                assert feed['platforms']['windows-x86_64']['signature']
        backup = ROOT / 'backups' / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        backup.mkdir(mode=0o700, parents=True)
        for release in manifest['releases']:
            destination = PUBLIC / release['destination']
            binary = staged / release['source']
            if destination.exists():
                assert hashlib.sha256(destination.read_bytes()).digest() == hashlib.sha256(binary.read_bytes()).digest()
            else:
                persist(destination, binary.read_bytes())
            current = PUBLIC / release['platform'] / 'latest.json'
            if current.exists():
                shutil.copy2(current, backup / (release['platform'] + '.json'))
            persist(current, json_bytes(release['feed']))
        # A small download page supplies the initial updater-capable installations.
        links = []
        for platform in ('android', 'windows'):
            path = PUBLIC / platform / 'latest.json'
            if path.exists():
                feed = json.loads(path.read_bytes())
                url = feed['url'] if platform == 'android' else feed['platforms']['windows-x86_64']['url']
                assert re.fullmatch(r'https://buzz-dnb0\.srv2006121\.hstgr\.cloud/fmg-updates/artifacts/[0-9a-f]{64}\.(apk|exe)', url)
                assert re.fullmatch(r'[0-9a-z.-]+', feed['version'])
                links.append(f'<p><a href="{url}">{platform} FMG Buzz {feed["version"]} 설치</a></p>')
        persist(PUBLIC / 'index.html', ('<!doctype html><html lang="ko"><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            '<title>FMG Buzz 업데이트</title><h1>FMG Buzz 업데이트</h1>'
            '<p>기존 FMG 앱을 삭제하지 않고 업데이트하세요. 계정과 페어링을 유지합니다.</p>'
            + ''.join(links) + '<p>새 앱 설치 후 자동 확인·다운로드를 사용할 수 있습니다.</p></html>').encode())
        server = ROOT / 'server.py'
        changed = not server.exists() or server.read_bytes() != (staged / 'server.py').read_bytes()
        persist(server, (staged / 'server.py').read_bytes())
        image = subprocess.check_output(['docker', 'image', 'inspect', 'python:3.12-slim', '--format', '{{.Id}}'], text=True).strip()
        assert re.fullmatch(r'sha256:[0-9a-f]{64}', image)
        compose = {'services': {'updates': {'image': image, 'container_name': 'fmg-buzz-updates',
            'restart': 'unless-stopped', 'user': '65534:65534', 'read_only': True, 'cap_drop': ['ALL'],
            'security_opt': ['no-new-privileges:true'], 'mem_limit': '192m', 'pids_limit': 24,
            'command': ['python3', '/service/server.py'],
            'volumes': [str(PUBLIC)+':/updates:ro', str(server)+':/service/server.py:ro'],
            'networks': ['dokploy-network'], 'labels': {
                'traefik.enable': 'true', 'traefik.docker.network': 'dokploy-network',
                'traefik.http.routers.fmg-buzz-updates.rule': 'Host(`buzz-dnb0.srv2006121.hstgr.cloud`) && PathPrefix(`/fmg-updates/`)',
                'traefik.http.routers.fmg-buzz-updates.entrypoints': 'websecure',
                'traefik.http.routers.fmg-buzz-updates.priority': '210',
                'traefik.http.routers.fmg-buzz-updates.tls.certresolver': 'letsencrypt',
                'traefik.http.services.fmg-buzz-updates.loadbalancer.server.port': '8000',
            }}}, 'networks': {'dokploy-network': {'external': True}}}
        compose_path = ROOT / 'compose.json'
        persist(compose_path, json_bytes(compose))
        args = ['docker', 'compose', '-f', str(compose_path), 'up', '-d']
        if changed:
            args.append('--force-recreate')
        subprocess.run(args, check=True, timeout=50, capture_output=True)
        receipt.update(state='published', source_commit=manifest['source_commit'], releases=[
            {'platform': row['platform'], 'version': row['feed']['version'], 'artifact': row['destination']}
            for row in manifest['releases']], backup=str(backup), only_update_service_changed=True)
except Exception as error:
    receipt.update(state='needs_reconcile', error_type=type(error).__name__)
    raise
finally:
    persist(ROOT / 'last-publish-receipt.json', json_bytes(receipt))
    print(json.dumps(receipt))
