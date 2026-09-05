"""Rebind machine-local checkout paths while preserving registered source bytes."""
import argparse
import hashlib
import json
from pathlib import Path


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--previous-core', type=Path, required=True)
    p.add_argument('--backup-directory', type=Path, required=True)
    a = p.parse_args()
    scripts = Path(__file__).parent.resolve()
    target = scripts / 'registration.json'
    original = target.read_bytes()
    registration = json.loads(original)
    paths = {'previous': a.previous_core.resolve(), 'optimized': scripts.parent.parent}
    for label, root in paths.items():
        for name, expected in registration['productionSources'][label]['hashes'].items():
            if hashlib.sha256((root / name).read_bytes()).hexdigest() != expected:
                raise RuntimeError('Source differs from registered version: ' + label + '/' + name)
        registration['productionSources'][label]['path'] = str(root)
    a.backup_directory.mkdir(parents=True, exist_ok=True)
    backup = a.backup_directory / ('registration-' + hashlib.sha256(original).hexdigest() + '.json')
    if not backup.exists():
        backup.write_bytes(original)
    target.write_text(json.dumps(registration, indent=2) + '\n')
    print('Verified all source hashes; only machine-local path bindings changed. Original registration backed up.')


if __name__ == '__main__':
    main()
