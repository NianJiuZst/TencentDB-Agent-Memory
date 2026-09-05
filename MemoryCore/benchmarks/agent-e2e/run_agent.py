"""Run pinned mini-swe-agent in an isolated, preinstalled public task image.

Only a task description and frozen past-memory context enter the agent. Reference
and held-out test patches remain in the host-only evaluator's dataset directory.
"""
import argparse
import hashlib
import json
import logging
import os
import re
import shlex
import subprocess
import time
import uuid
from pathlib import Path

from budget import Budget


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--runtime', type=Path, required=True)
    p.add_argument('--input', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--ledger', type=Path, required=True)
    p.add_argument('--cap', type=float, default=190)
    p.add_argument('--steps', type=int, default=50)
    p.add_argument('--seconds', type=int, default=1200)
    p.add_argument('--model', choices=['deepseek-v4-flash', 'MiniMax-M3'], default='deepseek-v4-flash')
    p.add_argument('--network', default='none')
    p.add_argument('--thinking', choices=['enabled', 'disabled'], default='disabled')
    p.add_argument('--max-output', type=int, default=4096)
    p.add_argument('--environment-only', action='store_true')
    a = p.parse_args()
    os.environ['MSWEA_GLOBAL_CONFIG_DIR'] = str(a.runtime / 'mini-config')
    os.environ['MSWEA_SILENT_STARTUP'] = '1'
    os.environ['LITELLM_LOCAL_MODEL_COST_MAP'] = 'True'
    import litellm
    import yaml
    from minisweagent.agents.default import DefaultAgent
    from minisweagent.environments.docker import DockerEnvironment
    from minisweagent.models.litellm_model import LitellmModel
    from minisweagent.models.utils.actions_toolcall import BASH_TOOL

    class BudgetExceeded(RuntimeError):
        pass

    task = json.loads(a.input.read_text())
    # Fail closed if an accidentally expanded dataset record is supplied.
    allowed = {'instance_id', 'problem_statement', 'base_commit', 'image', 'context', 'run_id', 'context_sha256', 'memory_arm', 'workspace', 'harden_history'}
    if set(task) - allowed:
        raise ValueError('Agent input contains fields outside the explicit allowlist')
    if not re.fullmatch(r'[0-9a-f]{40}', task['base_commit']):
        raise ValueError('Expected a full immutable Git commit')
    workspace = task.get('workspace', '/testbed')
    if workspace not in {'/testbed', '/app'}:
        raise ValueError('Unsupported benchmark workspace')
    key_env = 'MINIMAX_API_KEY' if a.model == 'MiniMax-M3' else 'DEEPSEEK_API_KEY'
    key = os.environ.get(key_env)
    if not key:
        raise RuntimeError(key_env + ' is unavailable')
    a.output.mkdir(parents=True, exist_ok=True)
    if (a.output / 'result.json').exists():
        print('Existing completed run retained')
        return
    budget = Budget(a.ledger, a.cap, a.model)

    class MeteredModel(LitellmModel):
        abort_exceptions = LitellmModel.abort_exceptions + [BudgetExceeded]

        def _query(self, messages, **kwargs):
            payload_bytes = len(json.dumps({'messages': messages, 'tools': [BASH_TOOL]}, ensure_ascii=False).encode())
            try:
                call_id, reserved = budget.reserve(task['run_id'], payload_bytes, a.max_output)
            except RuntimeError as exc:
                raise BudgetExceeded(str(exc)) from None
            response = None
            try:
                response = litellm.completion(
                    model=self.config.model_name, messages=messages, tools=[BASH_TOOL],
                    api_key=key, **(self.config.model_kwargs | kwargs))
                return response
            finally:
                usage = response.usage.model_dump() if response is not None and response.usage else None
                self.last_cny = budget.settle(call_id, reserved, usage)

        def _calculate_cost(self, response):
            return {'cost': self.last_cny, 'cost_currency': 'CNY_peak_price_upper_estimate'}

    cfg_path = a.runtime / 'mini-swe-agent/src/minisweagent/config/benchmarks/swebench.yaml'
    cfg = yaml.safe_load(cfg_path.read_text())
    model_cfg = cfg['model']
    model_cfg.update(model_name='openai/' + a.model, cost_tracking='ignore_errors')
    model_cfg['model_kwargs'] = {
        'api_base': 'https://api.minimaxi.com/v1' if a.model == 'MiniMax-M3' else 'https://api.deepseek.com', 'temperature': 0.2,
        'max_tokens': a.max_output, 'timeout': 180, 'num_retries': 0,
        'extra_body': {'thinking': {'type': ('adaptive' if a.model == 'MiniMax-M3' else 'enabled') if a.thinking == 'enabled' else 'disabled'}},
    }
    agent_cfg = cfg['agent']
    agent_cfg['instance_template'] = agent_cfg['instance_template'].replace('/testbed', workspace)
    agent_cfg.update(step_limit=a.steps, cost_limit=0, wall_time_limit_seconds=a.seconds,
                     output_path=a.output / 'trajectory.json')
    # Jinja sees the memory text only as data, never as executable template syntax.
    agent_cfg['instance_template'] += '\n\n<past_repository_memory>\n{{memory_context}}\n</past_repository_memory>\n'
    env_cfg = cfg['environment']
    env_cfg.pop('environment_class', None)
    env_cfg.update(image=task['image'], cwd=workspace, forward_env=[], pull_timeout=120,
                   run_args=['--rm', '--platform', 'linux/amd64', '--cpus', '1.5',
                             '--memory', '2g', '--pids-limit', '512', '--network', a.network])
    model = MeteredModel(**model_cfg)
    class ProEnvironment(DockerEnvironment):
        def _start_container(self):
            name = 'minisweagent-' + uuid.uuid4().hex[:12]
            command = [self.config.executable, 'run', '-d', '--name', name, '-w', self.config.cwd,
                       *self.config.run_args, '--entrypoint', '/bin/sh', self.config.image,
                       '-c', 'sleep ' + self.config.container_timeout]
            run = subprocess.run(command, capture_output=True, text=True, timeout=self.config.pull_timeout, check=True)
            self.container_id = run.stdout.strip()
    env = None
    start = time.time()
    result = {'run_id': task['run_id'], 'instance_id': task['instance_id'],
              'input_sha256': hashlib.sha256(a.input.read_bytes()).hexdigest(),
              'upstream_config_sha256': hashlib.sha256(cfg_path.read_bytes()).hexdigest()}
    try:
        env = (ProEnvironment if workspace == '/app' else DockerEnvironment)(**env_cfg)
        detached = env.execute({'command': 'git checkout --detach ' + shlex.quote(task['base_commit'])})
        if detached['returncode']:
            raise RuntimeError('Unable to detach the task checkout at its immutable base')
        if task.get('harden_history'):
            clean = '/tmp/tdai-shallow-' + uuid.uuid4().hex
            command = ('git reset --hard ' + shlex.quote(task['base_commit']) +
                       ' && git clone --quiet --no-local --no-checkout --depth 1 --single-branch ' +
                       shlex.quote('file://' + workspace) + ' ' + shlex.quote(clean) +
                       ' && rm -rf ' + shlex.quote(workspace + '/.git') +
                       ' && mv ' + shlex.quote(clean + '/.git') + ' ' + shlex.quote(workspace + '/.git') +
                       ' && git reset --mixed ' + shlex.quote(task['base_commit']) +
                       ' && git remote remove origin && rmdir ' + shlex.quote(clean))
            hardened = env.execute({'command': command}, timeout=300)
            result['history_hardening'] = hardened
            if hardened['returncode']:
                raise RuntimeError('Unable to remove future Git objects from task container')
        probe = env.execute({'command': 'git rev-parse HEAD && git status --porcelain'})
        result['environment_probe'] = probe
        if probe['returncode'] or probe['output'].splitlines()[0].strip() != task['base_commit']:
            raise RuntimeError('Task image does not start at the declared base commit')
        # The public hardened image should already contain only the task base.
        # Record reachable history before inference so contamination is auditable.
        history = env.execute({'command': 'git rev-list --all --count && git branch -a && git remote -v'})
        result['history_probe'] = history
        future = env.execute({'command': 'git rev-list --all --not HEAD'})
        result['future_history_probe'] = future
        if future['returncode'] or future['output'].strip():
            raise RuntimeError('Image exposes reachable future commits')
        if a.environment_only:
            result.update(exit_status='EnvironmentValidated', api_calls=0, peak_price_cny=0)
            return
        agent = DefaultAgent(model, env, **agent_cfg)
        try:
            completion = agent.run(task['problem_statement'], memory_context=task.get('context', ''))
            result.update(completion)
        except Exception as exc:
            # Keys are never inserted into exception reports or model config.
            result.update(exit_status=type(exc).__name__, error=str(exc).replace(key, '[REDACTED]'), submission='')
        submission = result.pop('submission', '')
        (a.output / 'model.patch').write_text(submission)
        result.update(api_calls=agent.n_calls, peak_price_cny=agent.cost,
                      patch_sha256=hashlib.sha256(submission.encode()).hexdigest(), patch_bytes=len(submission.encode()))
        last_diff = env.execute({'command': 'git diff --stat && git diff --numstat'})
        result['final_diff_summary'] = last_diff
    except Exception as exc:
        result.update(exit_status='EnvironmentError', error=str(exc).replace(key, '[REDACTED]'))
    finally:
        result['elapsed_seconds'] = time.time() - start
        (a.output / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        if env and env.container_id:
            subprocess.run(['docker', 'rm', '-f', env.container_id], capture_output=True, timeout=60)
            env.container_id = None
    print(json.dumps({k: result.get(k) for k in ['run_id', 'exit_status', 'api_calls', 'peak_price_cny', 'elapsed_seconds', 'patch_bytes']}))


if __name__ == '__main__':
    logging.basicConfig(level=logging.WARNING)
    main()
