#!/usr/bin/env python3
"""Extract trusted source bundles while rejecting links and path escapes."""
import pathlib
import sys
import tarfile


def extract(archive_path, destination):
    destination = pathlib.Path(destination)
    with tarfile.open(archive_path) as archive:
        members = archive.getmembers()
        for member in members:
            name = pathlib.PurePosixPath(member.name)
            if name.is_absolute() or '..' in name.parts or not (member.isfile() or member.isdir()):
                raise ValueError(f'Unsafe archive entry: {member.name}')
        archive.extractall(destination, members=members, filter='data')
    for name in ['package-lock.json', 'server/index.ts', 'ops/proxmox/update.sh']:
        if not (destination / name).is_file():
            raise ValueError(f'Bundle lacks required application file: {name}')


if __name__ == '__main__':
    extract(sys.argv[1], sys.argv[2])
