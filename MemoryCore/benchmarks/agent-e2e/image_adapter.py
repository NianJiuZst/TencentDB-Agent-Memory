"""Give the upstream grader a tag while retaining a verified immutable image."""
import hashlib
import re
import subprocess


def pinned_alias(digest_reference, run_scope):
    if not re.fullmatch(r'[a-z0-9./_-]+@sha256:[0-9a-f]{64}', digest_reference):
        raise ValueError('A full immutable image digest is required')
    alias = 'tdai-verified-base:' + hashlib.sha256((digest_reference + '\n' + run_scope).encode()).hexdigest()[:40]
    def identity(reference):
        return subprocess.check_output(['docker', 'image', 'inspect', reference, '--format', '{{.Id}}'], text=True, timeout=60).strip()
    expected = identity(digest_reference)
    subprocess.run(['docker', 'image', 'tag', digest_reference, alias], check=True, timeout=60)
    if identity(alias) != expected:
        raise RuntimeError('The temporary alias does not identify the pinned official image')
    return alias
