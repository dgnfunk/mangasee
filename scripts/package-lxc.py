#!/usr/bin/env python3
"""Package application source only, never databases, .env, or dependencies."""
import fnmatch
import pathlib
import sys
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
FILES = ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.server.json',
         'vite.config.ts', 'playwright.config.ts', 'index.html', '.nvmrc', 'README.md']
DIRS = ['src', 'server', 'public', 'ops/proxmox', 'scripts', 'docs', 'tests']


def package(target, root=ROOT):
    target = pathlib.Path(target).resolve()
    with tarfile.open(target, 'w:gz') as archive:
        paths = [root / name for name in FILES]
        for name in DIRS:
            paths.extend(sorted((root / name).rglob('*')))
        for path in paths:
            if path.resolve() == target:
                continue
            relative = path.relative_to(root)
            if path.is_symlink():
                raise ValueError(f'Symlinks are not allowed in deployment source: {relative}')
            if not path.is_file():
                continue
            if any(p.startswith('.') or p in ['__pycache__', 'node_modules'] for p in relative.parts):
                if str(relative) != '.nvmrc':
                    continue
            private_patterns = ['*.pyc', '*.sqlite*', '*.db', '*.db-*', '*.env', '*.env.*',
                                'credentials*.json', '*.key', '*.pem', '*.crt', '*.p12', '*.pfx',
                                '*.tar', '*.tar.gz', '*.tgz', '*.zip', '*.log']
            if any(fnmatch.fnmatch(path.name, pattern) for pattern in private_patterns):
                continue
            if any(part in ['backups', 'secrets'] for part in relative.parts):
                continue
            archive.add(path, arcname=str(relative), recursive=False)
    return target


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python3 scripts/package-lxc.py /tmp/mangasee.tar.gz')
    print(package(sys.argv[1]))
