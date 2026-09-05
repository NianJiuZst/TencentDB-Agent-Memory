"""Rebind exact source checkouts for a fresh pilot reproduction on another host."""
import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--previous-core', type=Path, required=True)
    p.add_argument('--backup-directory', type=Path, required=True)
    a = p.parse_args()
    scripts = Path(__file__).parent.resolve()
    target = scripts / 'pilot-registration.json'
    original = target.read_bytes()
    a.backup_directory.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(original).hexdigest()
    backup = a.backup_directory / ('pilot-registration-' + digest + '.json')
    if not backup.exists():
        backup.write_bytes(original)
    subprocess.run([sys.executable, str(scripts / 'relocate_registration.py'), '--previous-core', str(a.previous_core),
                    '--backup-directory', str(a.backup_directory)], check=True)
    value = json.loads(original)
    value['baseRegistrationSha256'] = hashlib.sha256((scripts / 'registration.json').read_bytes()).hexdigest()
    value['reproductionPathBinding'] = {'originalPilotRegistrationSha256': digest,
                                       'sourceBytesUnchanged': True,
                                       'note': 'Machine-local paths only; use a fresh result directory. Original submitted results retain their original registration.'}
    target.write_text(json.dumps(value, indent=2) + '\n')
    print('Verified source bytes and rebound only local paths. Original registrations were backed up.')
