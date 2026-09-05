import unittest
from unittest.mock import patch
from image_adapter import pinned_alias
from score import is_infrastructure_failure


class AdapterTests(unittest.TestCase):
    def test_docker_digest_is_not_used_as_a_mutable_tag(self):
        source = 'example/repository@sha256:' + 'a' * 64
        with patch('image_adapter.subprocess.check_output', return_value='sha256:original\n'), patch('image_adapter.subprocess.run') as command:
            alias = pinned_alias(source, 'independent-run')
        self.assertRegex(alias, r'^tdai-verified-base:[0-9a-f]{40}$')
        self.assertEqual(command.call_args.args[0], ['docker', 'image', 'tag', source, alias])

    def test_changed_image_content_is_rejected(self):
        source = 'example/repository@sha256:' + 'a' * 64
        with patch('image_adapter.subprocess.check_output', side_effect=['one\n', 'two\n']), patch('image_adapter.subprocess.run'):
            with self.assertRaises(RuntimeError):
                pinned_alias(source, 'run')

    def test_setup_failure_does_not_become_a_coding_failure(self):
        self.assertTrue(is_infrastructure_failure({'error': 'Test-patched image commit failed', 'patch_applied': False}))
        self.assertFalse(is_infrastructure_failure({'error': 'Patch failed', 'patch_applied': False}))
        self.assertFalse(is_infrastructure_failure({'error': 'Package cannot import after model change', 'patch_applied': True}))


if __name__ == '__main__':
    unittest.main()
