"""Recover the exact official image through a verified local OCI cache."""
import argparse
import fcntl
import hashlib
import json
import re
import shutil
import subprocess
import time
from pathlib import Path


def retry_transport(command, *, output, timeout, capture=False):
    """Retry identical public transfers; never retry or inspect model outcomes."""
    for attempt in range(5):
        try:
            result = subprocess.run(command, capture_output=capture, text=capture,
                                    stdout=None if capture else output, stderr=None if capture else output,
                                    timeout=timeout, check=True)
            return result.stdout.strip() if capture else result
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            if attempt == 4:
                raise
            time.sleep(2 ** attempt)


def fetch(image, runtime, output):
    runtime = runtime.resolve()
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    binary = runtime / 'regctl'
    expected = 'f4d536d64d0c3cc1db7400902175a1c314675991d22e87e15c319501a2676d3f'
    if hashlib.sha256(binary.read_bytes()).hexdigest() != expected:
        raise RuntimeError('Expected the verified regctl v0.11.5 darwin-arm64 binary')
    if not image.startswith(('jiayuanz3/swecontextbench:', 'jefzda/sweap-images:')):
        raise ValueError('Only the two public benchmark image repositories are allowed')
    started = time.time()
    cache = runtime / 'image-cache'
    alias = 'image-' + hashlib.sha256(image.encode()).hexdigest()[:24]
    destination = 'ocidir://' + str(cache) + ':' + alias
    archive = runtime / (alias + '.tar')
    with (runtime / 'image-cache.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if shutil.disk_usage(runtime).free < 25 * 1024**3:
            raise RuntimeError('Host disk reserve reached')
        with (output / 'oci-transfer.log').open('a') as log:
            source_digest = retry_transport([str(binary), 'image', 'digest', image], output=log, timeout=120, capture=True)
        if not re.fullmatch('sha256:[0-9a-f]{64}', source_digest):
            raise ValueError('Registry did not return a content digest')
        repo = image.rsplit(':', 1)[0]
        pinned = repo + '@' + source_digest
        with (output / 'oci-transfer.log').open('a') as log:
            # Keep the complete index, including attestation manifests. Selecting
            # only one platform changes the top-level digest even if code matches.
            retry_transport([str(binary), 'image', 'copy', pinned, destination], output=log, timeout=3600)
            local_digest = subprocess.check_output([str(binary), 'image', 'digest', destination], text=True).strip()
            if local_digest != source_digest:
                raise RuntimeError('OCI cache differs from the official image index')
            subprocess.run([str(binary), 'image', 'export', destination, str(archive), '--name', image], stdout=log, stderr=log, check=True, timeout=300)
            subprocess.run(['docker', 'image', 'load', '-i', str(archive)], stdout=log, stderr=log, check=True, timeout=600)
        digests = json.loads(subprocess.check_output(['docker', 'image', 'inspect', image, '--format', '{{json .RepoDigests}}'], text=True))
        if pinned not in digests:
            raise RuntimeError('Imported Docker image does not preserve the official digest')
        archive.unlink()
    result = {'image': image, 'officialDigest': source_digest, 'dockerRepoDigests': digests,
              'verifiedBinarySha256': expected, 'regctlVersion': 'v0.11.5',
              'elapsedSeconds': time.time() - started, 'sameOfficialContent': True}
    (output / 'image-recovery.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--image', required=True)
    p.add_argument('--runtime', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    print(json.dumps(fetch(args.image, args.runtime, args.output)))
