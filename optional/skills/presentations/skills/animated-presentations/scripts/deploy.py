#!/usr/bin/env python3
"""Publish an explicitly selected deck folder to Vercel; never installs or logs in.

Adapted from Frontend Slides' Vercel workflow (see ../LICENSE).
"""
import argparse
from pathlib import Path
import shutil
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder', type=Path)
    parser.add_argument('--publish', action='store_true', help='Required acknowledgement that this folder is intended for publication')
    args = parser.parse_args()
    folder = args.folder.resolve()
    if not folder.is_dir() or not (folder / 'index.html').is_file():
        parser.error('Provide a reviewed folder with index.html and all intended public assets')
    if not args.publish:
        parser.error('Publishing needs an explicit user request; after reviewing the folder, pass --publish')
    # Do not upload linked files outside the reviewed package or repository metadata.
    for path in folder.rglob('*'):
        if path.is_symlink() or path.name in {'.git', '.env', 'node_modules'} or path.name.startswith('.env.'):
            parser.error(f'Remove private/build material or symlinks from the publishing folder: {path}')
    cli = shutil.which('vercel')
    if not cli:
        parser.exit(1, 'Vercel CLI is missing. Set up an explicitly chosen hosting provider first; see references/tools.md.\n')
    subprocess.run([cli, 'whoami'], check=True, cwd=folder)
    # Interactive CLI confirms account/project; no --yes, --prod, or implicit login.
    subprocess.run([cli, str(folder)], check=True, cwd=folder)


if __name__ == '__main__':
    main()
