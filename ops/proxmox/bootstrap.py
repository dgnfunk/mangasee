#!/usr/bin/env python3
"""Bootstrap the pinned Komga API locally. Secrets never enter process arguments."""
import base64
import json
import os
from pathlib import Path
import secrets
import urllib.request


def atomic_json(path, data):
    temporary = path.with_suffix('.new')
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as handle:
        json.dump(data, handle, indent=2)
        handle.write('\n')
    os.replace(temporary, path)


def bootstrap(config_dir=Path('/etc/mangasee'), base='http://127.0.0.1:25600'):
    library_path = (config_dir / 'library-path').read_text().strip()
    if not library_path.startswith('/') or library_path == '/' or '..' in Path(library_path).parts:
        raise ValueError('Invalid local library path')
    path = config_dir / 'credentials.json'
    if not path.exists():
        atomic_json(path, {'app_password': secrets.token_hex(24),
                          'admin_email': 'admin@mangasee.local', 'admin_password': secrets.token_hex(24),
                          'reader_email': 'reader@mangasee.local', 'reader_password': secrets.token_hex(24)})
    credentials = json.loads(path.read_text())

    def call(method, route, data=None, account=None, headers=None):
        headers = dict(headers or {})
        if account:
            token = base64.b64encode(f'{credentials[account + "_email"]}:{credentials[account + "_password"]}'.encode()).decode()
            headers['Authorization'] = f'Basic {token}'
        body = None if data is None else json.dumps(data).encode()
        if body is not None:
            headers['Content-Type'] = 'application/json'
        req = urllib.request.Request(base + route, body, headers, method=method)
        with urllib.request.urlopen(req, timeout=30) as response:
            result = response.read()
            return json.loads(result) if result else None

    if not call('GET', '/api/v1/claim')['isClaimed']:
        call('POST', '/api/v1/claim', headers={
            'X-Komga-Email': credentials['admin_email'], 'X-Komga-Password': credentials['admin_password']})
    # If this server was claimed elsewhere, authentication fails instead of replacing users.
    libraries = call('GET', '/api/v1/libraries', account='admin')
    library = next((item for item in libraries if item['root'].rstrip('/') == library_path), None)
    if library is None:
        flags = ['analyzeDimensions', 'convertToCbz', 'emptyTrashAfterScan', 'hashFiles', 'hashKoreader',
                 'hashPages', 'importBarcodeIsbn', 'importComicInfoBook', 'importComicInfoCollection',
                 'importComicInfoReadList', 'importComicInfoSeries', 'importComicInfoSeriesAppendVolume',
                 'importEpubBook', 'importEpubSeries', 'importLocalArtwork', 'importMylarSeries',
                 'repairExtensions', 'scanCbx', 'scanEpub', 'scanForceModifiedTime', 'scanOnStartup', 'scanPdf']
        body = dict.fromkeys(flags, False)
        for flag in ['analyzeDimensions', 'hashFiles', 'importComicInfoBook', 'importEpubBook', 'scanCbx', 'scanEpub', 'scanPdf']:
            body[flag] = True
        body.update(name='Manga', root=library_path, scanInterval='DAILY', scanDirectoryExclusions=[], seriesCover='FIRST')
        library = call('POST', '/api/v1/libraries', body, account='admin')
    users = call('GET', '/api/v2/users', account='admin')
    reader = next((user for user in users if user['email'] == credentials['reader_email']), None)
    if reader is None:
        call('POST', '/api/v2/users', {
            'email': credentials['reader_email'], 'password': credentials['reader_password'],
            'roles': ['PAGE_STREAMING', 'FILE_DOWNLOAD'],
            'sharedLibraries': {'all': False, 'libraryIds': [library['id']]}
        }, account='admin')
    elif 'ADMIN' in reader.get('roles', []):
        raise RuntimeError('Dedicated reader unexpectedly has administrator access')
    if not credentials.get('komga_api_key'):
        result = call('POST', '/api/v2/users/me/api-keys', {'comment': 'MangaSee LXC'}, account='reader')
        credentials['komga_api_key'] = result['key']
        atomic_json(path, credentials)
    visible = call('GET', '/api/v1/libraries', headers={'X-API-Key': credentials['komga_api_key']})
    if not any(item['id'] == library['id'] for item in visible):
        raise RuntimeError('Reader API key cannot access the library')
    site = (config_dir / 'site-address').read_text().strip()
    values = {'APP_PASSWORD': credentials['app_password'], 'APP_ORIGIN': f'https://{site}',
              'HOST': '127.0.0.1', 'PORT': '3000', 'DEMO_MODE': 'false',
              'DATABASE_PATH': '/var/lib/mangasee/mangasee.sqlite',
              'KOMGA_URL': base, 'KOMGA_API_KEY': credentials['komga_api_key'],
              'LIBRARY_PATH': library_path,
              'LIBRARY_SENTINEL': str(Path(library_path) / '.mangasee-library'), 'LIBRARY_SENTINEL_VALUE': 'mangasee-library'}
    env = config_dir / 'app.env'
    temporary = config_dir / 'app.env.new'
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as handle:
        for key, value in values.items():
            handle.write(f'{key}={json.dumps(value)}\n')
    os.replace(temporary, env)


if __name__ == '__main__':
    try:
        bootstrap()
    except Exception as error:
        # Avoid displaying request headers, response bodies, or credentials.
        raise SystemExit(f'Komga bootstrap failed ({type(error).__name__}). Saved credentials are preserved; inspect Komga service logs before retrying.')
    print('Komga library and restricted API access configured; secrets saved locally.')
