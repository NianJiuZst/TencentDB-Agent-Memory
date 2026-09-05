"""Apply a real isolated network only while official test commands execute.

No source, tests, parser or grading logic is changed. Dependency preparation
continues to use the upstream environment. Requests expects 10.255.255.1 to be a
nonresponding address; an internal bridge with that unassigned address supplies
that condition independently of the host's proxy/VPN behavior.
"""
import subprocess


def install(official, network):
    original = official.run_specific_tests_in_container

    class SubprocessProxy:
        def __getattr__(self, name):
            return getattr(subprocess, name)

        @staticmethod
        def run(args, *pos, **kwargs):
            if isinstance(args, (list, tuple)) and list(args[:2]) == ['docker', 'run']:
                args = [*args[:2], '--network', network, '--cpus', '1.5', '--memory', '2g', *args[2:]]
            return subprocess.run(args, *pos, **kwargs)

    def wrapped(*args, **kwargs):
        previous = official.subprocess
        official.subprocess = SubprocessProxy()
        try:
            return original(*args, **kwargs)
        finally:
            official.subprocess = previous

    official.run_specific_tests_in_container = wrapped
