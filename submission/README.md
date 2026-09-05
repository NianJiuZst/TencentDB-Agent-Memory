# 版本与分支感知的多状态记忆：比赛提交材料

方案基于 TencentDB Agent Memory 的 `MemoryCore`，在真实写入与召回链路中保存版本作用域，允许不同分支、工作树、并行任务的事实共存。最终报告在 `../MemoryCore/output/pdf/competition-memory-solution-cn.pdf`。

## 交付内容

- 实现：`MemoryCore/src/core/lifecycle/`、`MemoryCore/src/core/hooks/auto-recall.ts`，以及原有写入、去重、宿主接入实现。
- 新回归测试：`version-scope.robustness.test.ts`、`auto-recall.version-boundary.test.ts`，以及扩展的 `git-context.test.ts`。
- 可复现对照：`MemoryCore/benchmarks/competition/recall-benchmark.ts`、`protocol.json`。
- 本次原始结果、历史复算、生产重放：`submission/evidence/`。
- 中文报告源稿、排版程序、最终 PDF：`submission/report.md`、`submission/render-report.py`、`MemoryCore/output/pdf/competition-memory-solution-cn.pdf`。

## 安装与本地验证

本次环境为 macOS arm64、Node.js 26.8.1；使用 Node 内置 SQLite。建议使用同一 Node 版本与 pnpm 10。依赖锁文件一并提交。下列命令从仓库根目录执行。

```sh
pnpm --dir MemoryCore install --frozen-lockfile
node submission/run-local.mjs
node submission/check-regressions.mjs
python3 submission/validate.py
```

`run-local.mjs` 顺序运行类型检查、全部本地单元/集成测试、生命周期评测框架测试、插件构建和优化版 204 次召回。`check-regressions.mjs` 会在临时目录解出旧提交并运行新回归测试，旧实现的断言失败是预期结果；它不会修改当前工作树。`validate.py` 从逐例记忆 ID 独立重算已保存的三组对照和验收条件。以上均不调用付费模型服务。

## 三组对照重跑

旧版比较固定在 `25a025b4be83dbc28877d8a740bd7a089a7297e5`。先在新目录检出该提交，并为其安装同一锁文件的依赖。随后在 `MemoryCore` 下顺序执行：

```sh
node --import tsx benchmarks/competition/recall-benchmark.ts --core-root /path/to/baseline/MemoryCore --policy global --arm global --output ../submission/evidence/global.json
node --import tsx benchmarks/competition/recall-benchmark.ts --core-root /path/to/baseline/MemoryCore --arm previous_strict --output ../submission/evidence/previous-strict.json
node --import tsx benchmarks/competition/recall-benchmark.ts --arm optimized --output ../submission/evidence/optimized.json
python3 ../submission/validate.py
```

基线通过加载旧目录中的真实生产模块运行，评测脚本没有另写一个“旧算法”替身。三组的 k、文本、FTS 排序、作用域、数据库写入和答案期望一致。对照的 204 次/组由 180 个候选池内案例、12 个池外案例、12 个缺失上下文案例构成。延迟应顺序复测，勿与其他负载并行。

## 历史数据与生产重放

公开数据使用 Memora 固定提交 `a6493188efc836d6511ed5e4163fe3ba87da30ff`。在 `MemoryCore` 下：

```sh
node --import tsx benchmarks/lifecycle-memory/src/version-aware-context-cli.ts --data /path/to/Memora/data --prior-contexts benchmarks/lifecycle-memory/results/production-path-final/context/context-manifest.json --output ../submission/evidence/replayed-context --fixture /tmp/tdai-version-aware-competition-replay
node --import tsx benchmarks/lifecycle-memory/src/version-aware-e2e-validator-cli.ts --contexts benchmarks/lifecycle-memory/results/version-aware-final/context/context-manifest.json --evaluations benchmarks/lifecycle-memory/results/version-aware-final/e2e/evaluations.jsonl --summary benchmarks/lifecycle-memory/results/version-aware-final/e2e/summary.json --output ../submission/evidence/historical-revalidation.json
```

第一条会新建真实 Git/worktree、SQLite，重新执行 260 次写入和 330 次召回。fixture 参数必须使用专用的 `/tmp/tdai-version-aware-*` 目录；原有脚本会重建该目录，勿填入需要保留数据的位置。第二条只复算历史 500 条模型判分，不调用新模型。历史模型分数与本次代码测试分别呈现。

## 启用方式

```json
{
  "recall": {
    "strategy": "keyword",
    "maxResults": 5,
    "lifecycle": {
      "enabled": true,
      "versionAwareMode": "strict",
      "autoDetectGit": true,
      "versionCandidateMultiplier": 4,
      "maxVersionStates": 6,
      "minConfidence": 0.85,
      "maxHops": 1,
      "maxExpansions": 64,
      "timeoutMs": 10
    }
  }
}
```

宿主为每次 recall/capture 提供真实 `workspaceDir`，并行任务传稳定 `taskId`；也可传入经过验证的 `versionContext`。作用域是事实的有效性标注，不代替存储后端的用户、租户访问控制。关闭 strict 后保留旧行为。候选池大小为约 4k，池外事实仍可能漏召回。

## 报告复现

```sh
python3 -m pip install reportlab pypdf pypdfium2 pillow
python3 submission/render-report.py
```

排版默认使用 macOS 系统宋体；可通过程序的 `--font` 参数提供其他中文 TrueType 字体。PDF 和全部页图均由保存的测试证据生成，页图用于排版核验。
