#!/usr/bin/env python3
"""Local deployment checks. No root or Proxmox mutations are performed."""
import importlib.util
import io
import json
import os
import re
from pathlib import Path
import shlex
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


packager = module('packager', 'scripts/package-lxc.py')
extractor = module('extractor', 'ops/proxmox/extract.py')
bootstrap = module('bootstrap', 'ops/proxmox/bootstrap.py')


class DeploymentTests(unittest.TestCase):
    def test_shell_syntax(self):
        for path in (ROOT / 'ops/proxmox').glob('*.sh'):
            subprocess.run(['bash', '-n', str(path)], check=True)

    def test_guest_installed_commands_with_minimal_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'usr/local/bin').mkdir(parents=True)
            (root / 'usr/local/sbin').mkdir(parents=True)
            node = root / 'usr/local/bin/node'
            node.write_text('#!/bin/sh\nprintf "pinned-node\\n"\n')
            node.chmod(0o755)
            updater = root / 'usr/local/sbin/mangasee-update'
            updater.write_text('#!/bin/sh\nset -e\nprintf "%s\\n" "$1"\n/usr/bin/env node --version\n')
            updater.chmod(0o755)
            for name in ['install.sh', 'update.sh']:
                with self.subTest(script=name):
                    source = (ROOT / 'ops/proxmox' / name).read_text()
                    path_line = next(line for line in source.splitlines() if line.startswith('export PATH='))
                    if name == 'install.sh':
                        invocation = next(line for line in source.splitlines() if line.endswith('mangasee-update "$ARCHIVE"'))
                    else:
                        invocation = '/usr/local/sbin/mangasee-update "$ARCHIVE"'
                    script = ('set -eu\n' + path_line + '\nARCHIVE="/root/source bundle.tar.gz"\n' + invocation).replace('/usr/local/', str(root / 'usr/local') + '/')
                    result = subprocess.run(['/bin/bash', '-c', script], env={'PATH': '/usr/bin:/bin'}, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(result.stdout.splitlines(), ['/root/source bundle.tar.gz', 'pinned-node'])

    def test_guest_network_failures_stop_before_package_install(self):
        # Run the real installer through dependency installation with mocked DNS/APT.
        for failure in ['', 'deb.debian.org', 'security.debian.org', 'apt-resolver', 'apt-dns', 'update']:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / 'bin').mkdir()
                (root / 'os-release').write_text('ID=debian\nVERSION_ID=13\n')
                helper = root / 'bin/mock'
                helper.write_text(f'#!{sys.executable}\n' + '''import json,os,pathlib,sys
r=pathlib.Path(os.environ['TEST_ROOT']); command=pathlib.Path(sys.argv[0]).name; a=sys.argv[1:]
with (r/'commands').open('a') as f: f.write(json.dumps([command,*a])+'\\n')
if command=='timeout': os.execvp(a[1],a[1:])
elif command=='runuser':
 assert a[:3]==['-u','_apt','--']
 if a[3:]==['test','-r','/etc/resolv.conf']: sys.exit(1 if os.environ['FAILURE']=='apt-resolver' else 0)
 os.environ['TEST_ACCOUNT']='_apt'
 os.execvp(a[3],a[3:])
elif command=='getent':
 denied = os.environ['FAILURE']=='apt-dns' and os.environ.get('TEST_ACCOUNT')=='_apt'
 sys.exit(2 if denied or a[-1]==os.environ['FAILURE'] else 0)
elif command=='apt-get' and a[-1]=='update':
 assert '--error-on=any' in a
 sys.exit(100 if os.environ['FAILURE']=='update' else 0)
elif command=='apt-get': assert a[0]=='install'
else: raise Exception(command)
''')
                helper.chmod(0o755)
                for command in ['timeout', 'getent', 'apt-get', 'runuser']:
                    (root / 'bin' / command).symlink_to(helper)
                script = (ROOT / 'ops/proxmox/install.sh').read_text().split('for account in mangasee komga;')[0]
                script = script.replace('[[ $EUID -eq 0 ]]', 'true')
                script = script.replace('/etc/os-release', str(root / 'os-release'))
                script = script.replace('/etc/mangasee', str(root / 'config'))
                script = script.replace('/.mangasee-lxc', str(root / 'marker'))
                script = re.sub(r'^export PATH=(.*)$', lambda m: 'export PATH=' + str(root / 'bin') + ':' + os.environ['PATH'] + ':' + m[1], script, flags=re.M)
                result = subprocess.run(['bash', '-c', script, 'install', 'source.tar.gz', 'mangasee.home.arpa'],
                                        env={**os.environ, 'TEST_ROOT': str(root), 'FAILURE': failure,
                                             'PATH': str(root / 'bin') + ':' + os.environ['PATH']}, capture_output=True, text=True)
                self.assertEqual(result.returncode == 0, not failure, result.stderr)
                commands = [json.loads(line) for line in (root / 'commands').read_text().splitlines()]
                installs = [c for c in commands if c[:2] == ['apt-get', 'install']]
                self.assertEqual(len(installs), 0 if failure else 1)
                if failure.endswith('.org'):
                    self.assertIn('Container DNS cannot resolve', result.stderr)
                    self.assertFalse(any(c[0] == 'apt-get' for c in commands))
                elif failure.startswith('apt-'):
                    self.assertIn('APT download user _apt', result.stderr)
                    self.assertFalse(any(c[0] == 'apt-get' for c in commands))
                elif failure:
                    self.assertIn('Package indexes could not be refreshed', result.stderr)

    def test_source_bundle_excludes_local_state(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'src').mkdir()
            (root / 'src/app.ts').write_text('source')
            (root / '.env').write_text('secret')
            (root / '.nvmrc').write_text('24.21.0')
            (root / 'src/.env').write_text('secret')
            (root / 'src/history.sqlite').write_text('secret')
            for name in ['history.sqlite-wal', 'app.env.backup', 'credentials.json', 'root.key',
                         'root.crt', 'backup.tar.gz', 'debug.log']:
                (root / 'src' / name).write_text('private fixture')
            (root / 'src/backups').mkdir()
            (root / 'src/backups/export.json').write_text('private fixture')
            archive = packager.package(root / 'src/bundle.tar.gz', root)
            with tarfile.open(archive) as handle:
                self.assertEqual(set(handle.getnames()), {'.nvmrc', 'src/app.ts'})

    def test_source_symlinks_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'src').mkdir()
            (root / 'private').write_text('secret')
            (root / 'src/key').symlink_to(root / 'private')
            with self.assertRaises(ValueError):
                packager.package(root / 'bundle.tar.gz', root)

    def test_real_bundle_roundtrip(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = packager.package(root / 'bundle.tar.gz')
            extractor.extract(archive, root / 'source')
            self.assertTrue((root / 'source/ops/proxmox/install.sh').is_file())
            self.assertTrue((root / 'source/.nvmrc').is_file())
            self.assertFalse((root / 'source/.env').exists())

    def test_extract_rejects_escape_and_links(self):
        for name, kind in [('../escaped', tarfile.REGTYPE), ('/escaped', tarfile.REGTYPE),
                           ('link', tarfile.SYMTYPE), ('hardlink', tarfile.LNKTYPE)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                with tarfile.open(root / 'bad.tar', 'w') as archive:
                    item = tarfile.TarInfo(name)
                    item.type = kind
                    item.linkname = '/etc/passwd' if kind != tarfile.REGTYPE else ''
                    archive.addfile(item)
                with self.assertRaises(ValueError):
                    extractor.extract(root / 'bad.tar', root / 'out')
                self.assertFalse((root / 'escaped').exists())

    def test_dry_run_and_invalid_network(self):
        env = {**os.environ, 'LIBRARY_PATH': '/mnt/manga', 'RESUME_EXISTING': 'no'}
        command = ['bash', str(ROOT / 'ops/proxmox/mangasee-lxc.sh'), '--dry-run']
        result = subprocess.run(command, env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Library folder inside LXC: /mnt/manga', result.stdout)
        self.assertNotIn('NFS', result.stdout)
        for settings in [{'CREATE_LIBRARY_DIR': 'maybe'}, {'IP_CONFIG': '999.0.0.1/24'}, {'LIBRARY_PATH': '/mnt/../escape'}, {'LIBRARY_PATH': '/'}, {'LIBRARY_PATH': '/etc/books'},
                         {'SITE_ADDRESS': 'name;command'}, {'MEMORY': '512'}, {'CTID': '42'}]:
            with self.subTest(settings=settings):
                result = subprocess.run(command, env={**env, **settings}, capture_output=True)
                self.assertNotEqual(result.returncode, 0)

    def test_folder_guard(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root / 'local books'
            folder.mkdir()
            marker = folder / '.mangasee-library'
            body = (ROOT / 'ops/proxmox/check-library.sh').read_text()
            # macOS lacks GNU timeout; preserve the actual file and folder checks.
            prefix = 'timeout() { shift 3; "$@"; }; export -f timeout\n'
            command = ['bash', '-c', prefix + body, 'check-library', str(folder)]
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
            marker.write_text('mangasee-library\n')
            self.assertEqual(subprocess.run(command, capture_output=True).returncode, 0)
            marker.write_text('wrong library')
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
            marker.unlink()
            folder.rmdir()
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)

    def test_initialize_missing_local_library(self):
        script = (ROOT / 'ops/proxmox/install.sh').read_text()
        initializer = script.split("<<'INIT_LIBRARY'\n", 1)[1].split('\nINIT_LIBRARY', 1)[0]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            config = root / 'config'
            config.mkdir()
            library = root / 'new-parent/books'
            database = root / 'mangasee.sqlite'
            command = [sys.executable, '-c', initializer, str(library), str(config), str(database)]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(library.stat().st_mode & 0o777, 0o755)
            self.assertEqual(library.parent.stat().st_mode & 0o777, 0o755)
            marker = library / '.mangasee-library'
            self.assertEqual(marker.read_text(), 'mangasee-library\n')
            self.assertEqual(marker.stat().st_mode & 0o777, 0o644)
            marker.chmod(0o600)
            (library / 'book.cbz').write_text('original')
            # Repeating initialization never resets existing contents or permissions.
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(marker.stat().st_mode & 0o777, 0o600)
            self.assertEqual((library / 'book.cbz').read_text(), 'original')
            marker.unlink()
            subprocess.run(command, check=True, capture_output=True)
            self.assertFalse(marker.exists(), 'Existing unmarked folders must remain unmarked')
            (library / 'book.cbz').unlink()
            library.rmdir()
            for record in [config / 'credentials.json', config / 'install-complete', database]:
                record.touch()
                result = subprocess.run(command, capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('already registered', result.stderr)
                self.assertFalse(library.exists())
                record.unlink()
            library.write_text('not a directory')
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
            library.unlink()
            target = root / 'actual'
            target.mkdir()
            library.symlink_to(target, target_is_directory=True)
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
            self.assertEqual(list(target.iterdir()), [])

    def test_prepare_then_resume_preserves_user_mounts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'bin').mkdir()
            (root / 'run/lock').mkdir(parents=True)
            helper = root / 'bin/mock'
            helper.write_text(f'#!{sys.executable}\n' + '''import json,os,pathlib,sys
r=pathlib.Path(os.environ['TEST_ROOT']); command=pathlib.Path(sys.argv[0]).name; a=sys.argv[1:]
with (r/'commands').open('a') as f: f.write(json.dumps([command,*a])+'\\n')
if command=='pct':
 if a[0]=='config':
  if not (r/'created').exists(): sys.exit(1)
  print('description: '+os.environ.get('CT_DESCRIPTION','MangaSee managed LXC v2%0A')+'\\nunprivileged: 1\\narch: amd64\\nmp2: /user/storage,mp=/mnt/my-manga,ro=1', flush=True)
  print('lxc.environment: '+('x'*100000))
 elif a[0] in ['create','start']:
  mask=os.umask(0); os.umask(mask)
  assert mask==0o022, 'pct must use a normal system-file umask'
  if a[0]=='create': (r/'created').touch()
 elif a[0]=='status': print('status: stopped')
 elif a[0]=='exec' and a[-2:]==['hostname','-I']: print('192.168.1.60')
elif command=='pveam' and a[0]=='available': print('system debian-13-standard_13.0-1_amd64.tar.zst')
elif command=='dpkg': print('amd64')
elif command in ['pvesm','pvesh','pveversion','flock','pveam']: pass
else: raise Exception(command)
''')
            helper.chmod(0o755)
            for command in ['pct', 'pvesh', 'pvesm', 'pveam', 'pveversion', 'dpkg', 'flock']:
                (root / 'bin' / command).symlink_to(helper)
            script = (ROOT / 'ops/proxmox/mangasee-lxc.sh').read_text()
            script = re.sub(r'^SOURCE_DIR=.*$', 'SOURCE_DIR=' + shlex.quote(str(ROOT)), script, flags=re.M)
            script = script.replace('[[ $EUID -eq 0 ]]', 'true')
            script = re.sub(r'/var/lib/mangasee-installer|/run/lock', lambda m: str(root) + m.group(), script)
            env = {**os.environ, 'TEST_ROOT': str(root), 'CTID': '123', 'LIBRARY_PATH': '/mnt/my-manga',
                   'ROOT_STORAGE': 'local-lvm', 'TEMPLATE_STORAGE': 'local', 'RESUME_EXISTING': 'no',
                   'PATH': str(root / 'bin') + ':' + os.environ['PATH']}
            result = subprocess.run(['bash', '-c', script, 'installer', '--prepare'], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            commands = [json.loads(line) for line in (root / 'commands').read_text().splitlines()]
            self.assertTrue(any(c[:2] == ['pct', 'create'] for c in commands))
            self.assertFalse(any(c[:2] in [['pct', 'start'], ['pct', 'exec']] for c in commands))
            saved = (root / 'var/lib/mangasee-installer/123.conf').read_text()
            self.assertEqual((root / 'var/lib/mangasee-installer/123.conf').stat().st_mode & 0o777, 0o600)
            self.assertIn('LIBRARY_PATH=/mnt/my-manga', saved)
            self.assertNotIn('NAS_', saved)
            # The saved path must override a conflicting environment on resume.
            result = subprocess.run(['bash', '-c', script, 'installer'],
                                    env={**env, 'RESUME_EXISTING': 'yes', 'LIBRARY_PATH': '/incorrect', 'CREATE_LIBRARY_DIR': 'yes'}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            commands = [json.loads(line) for line in (root / 'commands').read_text().splitlines()]
            self.assertEqual(len([c for c in commands if c[:2] == ['pct', 'create']]), 1)
            self.assertFalse(any(c[:2] == ['pct', 'set'] for c in commands))
            invocation = next(c for c in commands if '/root/mangasee-install.sh' in c and 'bash' in c)
            self.assertEqual(invocation[-2:], ['/mnt/my-manga', 'yes'])
            self.assertFalse(any('--mp0' in c or '--hookscript' in c for c in commands))
            for description in ['MangaSee managed LXC v2', 'MangaSee%20managed%20LXC%20v2%0D%0A',
                                'MangaSee managed LXC v1%0A', 'MangaSee managed LXC v20%0A',
                                'Unrelated CT', '', 'MangaSee managed LXC v2%250A']:
                with self.subTest(description=description):
                    before = len((root / 'commands').read_text().splitlines())
                    result = subprocess.run(['bash', '-c', script, 'installer', '--prepare'],
                                            env={**env, 'RESUME_EXISTING': 'yes', 'CT_DESCRIPTION': description},
                                            capture_output=True, text=True)
                    valid = description in ['MangaSee managed LXC v2', 'MangaSee%20managed%20LXC%20v2%0D%0A']
                    self.assertEqual(result.returncode == 0, valid, result.stderr)
                    if not valid:
                        self.assertIn('unexpected installer description', result.stderr)
                        new_commands = [json.loads(line) for line in (root / 'commands').read_text().splitlines()[before:]]
                        self.assertFalse(any(c[:2] in [['pct', 'create'], ['pct', 'start'], ['pct', 'set'], ['pct', 'exec']] for c in new_commands))


    def test_bootstrap_credentials_permissions_and_idempotence(self):
        calls, libraries, users = [], [], []
        claimed = False

        def request(req, timeout):
            nonlocal claimed
            route = req.full_url.removeprefix('http://komga.test')
            body = json.loads(req.data) if req.data else None
            calls.append((req.method, route, body, dict(req.header_items())))
            result = None
            if route == '/api/v1/claim':
                if req.method == 'GET':
                    result = {'isClaimed': claimed}
                else:
                    claimed = True
            elif route == '/api/v1/libraries':
                if req.method == 'POST':
                    self.assertFalse(body['emptyTrashAfterScan'])
                    self.assertFalse(body['convertToCbz'])
                    self.assertFalse(body['repairExtensions'])
                    self.assertEqual(body['root'], '/mnt/my-manga')
                    libraries.append({'id': 'library-1', 'root': body['root']})
                    result = libraries[-1]
                else:
                    result = libraries
            elif route == '/api/v2/users':
                if req.method == 'POST':
                    self.assertEqual(body['roles'], ['PAGE_STREAMING', 'FILE_DOWNLOAD'])
                    self.assertEqual(body['sharedLibraries'], {'all': False, 'libraryIds': ['library-1']})
                    users.append(body)
                    result = body
                else:
                    result = users
            elif route == '/api/v2/users/me/api-keys':
                result = {'key': 'test-key'}
            else:
                self.fail(f'Unexpected API route {route}')
            return io.BytesIO(json.dumps(result).encode() if result is not None else b'')

        with tempfile.TemporaryDirectory() as directory, patch.object(bootstrap.urllib.request, 'urlopen', request):
            root = Path(directory)
            (root / 'site-address').write_text('mangasee.home.arpa')
            (root / 'library-path').write_text('/mnt/my-manga')
            bootstrap.bootstrap(root, 'http://komga.test')
            saved = (root / 'credentials.json').read_bytes()
            bootstrap.bootstrap(root, 'http://komga.test')
            self.assertEqual(saved, (root / 'credentials.json').read_bytes())
            self.assertEqual((root / 'credentials.json').stat().st_mode & 0o777, 0o600)
            self.assertEqual((root / 'app.env').stat().st_mode & 0o777, 0o600)
            self.assertEqual(len([c for c in calls if c[0] == 'POST']), 4)
            self.assertIn('DEMO_MODE="false"', (root / 'app.env').read_text())
            self.assertIn('LIBRARY_SENTINEL="/mnt/my-manga/.mangasee-library"', (root / 'app.env').read_text())
            self.assertNotIn('NAS_', (root / 'app.env').read_text())
            users[0]['roles'].append('ADMIN')
            with self.assertRaises(RuntimeError):
                bootstrap.bootstrap(root, 'http://komga.test')

    def test_update_success_and_failure_restore(self):
        # Execute the real shell workflow against temporary paths and mocked OS commands.
        # No production script provides a root/path bypass; substitution is test-only.
        for failure in ['', 'build', 'health']:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                for name in ['etc/mangasee', 'opt/mangasee/releases/old', 'var/lib/mangasee', 'run/lock', 'usr/local/sbin', 'usr/local/bin', 'usr/local/lib', 'bin']:
                    (root / name).mkdir(parents=True, exist_ok=True)
                (root / 'var/lib/mangasee/history').write_text('old progress')
                (root / 'etc/mangasee/library-path').write_text('/mnt/my-manga')
                (root / 'opt/mangasee/current').symlink_to(root / 'opt/mangasee/releases/old')
                (root / 'source.tar.gz').write_bytes(b'fixture')
                (root / 'usr/local/lib/mangasee-extract.py').write_text('import pathlib,sys\np=pathlib.Path(sys.argv[2]); (p/".nvmrc").write_text("24.21.0")\n')
                helper = root / 'bin/mock'
                helper.write_text(f'#!{sys.executable}\n' + '''import os,pathlib,sys,shutil,json
r=pathlib.Path(os.environ['TEST_ROOT']); command=pathlib.Path(sys.argv[0]).name; a=sys.argv[1:]; failure=os.environ['FAILURE']
if command in ['flock','chown','sleep']: pass
elif command=='mangasee-check-library': assert a==['/mnt/my-manga']
elif command=='install':
 pathlib.Path(a[-1]).mkdir(parents=True,exist_ok=True)
elif command=='node': print('v24.21.0')
elif command=='sha256sum': print('a'*64+'  fixture')
elif command=='readlink': print(pathlib.Path(a[-1]).resolve())
elif command=='systemctl':
 with (r/'services.log').open('a') as f: f.write(' '.join(a)+'\\n')
 if a==['start','mangasee'] and pathlib.Path(r/'opt/mangasee/current').resolve().name!='old':
  release=(r/'opt/mangasee/current').resolve()
  assert (release/'dist-server/server/index.js').stat().st_mode & 0o004, 'Built entrypoint must remain readable after chown'
  assert (release/'dist-server/server').stat().st_mode & 0o001, 'Service must traverse built directories'
  (r/'var/lib/mangasee/history').write_text('migrated progress')
elif command=='runuser':
 assert str(r/'usr/local/bin/npm') in a
 assert any(arg.startswith('PATH=') and str(r/'usr/local/bin') in arg for arg in a)
 if a[-2:]==['run','build']:
  if failure=='build': sys.exit(1)
  p=pathlib.Path(a[a.index('--prefix')+1]); (p/'dist').mkdir(); (p/'dist-server/server').mkdir(parents=True)
  (p/'dist/index.html').touch(); (p/'dist-server/server/index.js').touch()
elif command=='mv': os.replace(a[-2],a[-1])
elif command=='curl':
 if failure=='health': sys.exit(22)
 print(json.dumps({'ok': True}))
else: raise Exception(command)
''')
                helper.chmod(0o755)
                for command in ['install', 'flock', 'chown', 'node', 'sha256sum', 'readlink', 'systemctl', 'runuser', 'mv', 'curl', 'sleep']:
                    (root / 'bin' / command).symlink_to(helper)
                (root / 'usr/local/sbin/mangasee-check-library').symlink_to(helper)
                (root / 'usr/local/bin/node').symlink_to(helper)
                script = (ROOT / 'ops/proxmox/update.sh').read_text()
                script = script.replace('[[ $EUID -eq 0 && -f /.mangasee-lxc ]]', 'true')
                script = re.sub(r'/etc/|/opt/|/var/|/run/|/usr/local/', lambda m: str(root) + m.group(), script)
                script = re.sub(r'^export PATH=(.*)$', lambda m: 'export PATH=' + str(root / 'bin') + ':' + os.environ['PATH'] + ':' + m[1], script, flags=re.M)
                result = subprocess.run(['bash', '-c', script, 'update', str(root / 'source.tar.gz')],
                                        env={**os.environ, 'TEST_ROOT': str(root), 'FAILURE': failure, 'PATH': str(root / 'bin') + ':' + os.environ['PATH']}, capture_output=True, text=True)
                self.assertEqual(result.returncode == 0, not failure, result.stdout + result.stderr)
                current = (root / 'opt/mangasee/current').resolve()
                if failure:
                    self.assertEqual(current.name, 'old')
                    self.assertEqual((root / 'var/lib/mangasee/history').read_text(), 'old progress')
                else:
                    self.assertNotEqual(current.name, 'old')
                    self.assertEqual((root / 'var/lib/mangasee/history').read_text(), 'migrated progress')
                if failure == 'build':
                    self.assertFalse((root / 'services.log').exists())
                elif failure == 'health':
                    self.assertIn('start mangasee', (root / 'services.log').read_text())
                    self.assertEqual(len(list((root / 'var/backups/mangasee').glob('*/failed-data/history'))), 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
