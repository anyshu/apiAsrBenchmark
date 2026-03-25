# Audio ASR Bench - 方案设计

## 1. 设计原则

1. 核心执行层优先，CLI / UI 只是入口
2. 配置驱动 provider 接入
3. 对外多样，对内统一
4. 原始响应、标准化结果、评估结果分层保存
5. 文件 artifacts 和 SQLite 并行存在
6. 先验证 provider，再进入大规模 benchmark

## 2. 分层架构

### Domain
- `ProviderConfig`
- `AudioAsset`
- `BenchAttemptRecord`
- `BenchRunSummary`
- `NormalizedAsrResult`
- `AccuracyMetrics`

### Application
- `ValidationService`
- `RunOnceService`
- `RunDurationService`
- `ProviderExecutionService`（重试、backoff、runtime override）
- `ReferenceEvaluationService`
- `UiServerService`

### Infrastructure
- provider adapter
- 音频扫描与元数据提取
- JSONL / JSON / CSV artifacts
- SQLite store
- 本地 HTTP server（仅用于 UI）

### Interface
- CLI
- 本地 Web UI
- `RELOAD.md` 会话交接文档，用于记录当前实现状态、未完成项和下一步计划

## 3. 核心模块

### Provider Registry / Switcher
- 加载 provider 独立配置文件
- 做 `provider_id` 去重校验
- 根据 `provider.type` 选择正确 adapter
- 对 `openai_compatible`、`zenmux`、`openrouter`、`custom_http` 做运行时路由
- `openrouter` 允许在 adapter 内部收敛“当前 region 下可用模型”和“最稳定的音频入口”这类聚合平台差异
- `openrouter` adapter 可以在同一逻辑下兼容多种音频 content part 形态，并在必要时做一次 provider 内部回退

### Audio Catalog
- 扫描输入目录
- 生成 `audio_id`
- 记录格式、大小、时长
- 可选加载 dataset manifest 元信息（`language`、`speaker`、`tags`）
- 可选挂载 reference transcript

### Provider Execution
- 统一封装 `executeWithRetry`
- 根据 `retry_policy.max_attempts`、`backoff_ms` 做指数 backoff
- 仅对 retriable error（如 timeout、network、5xx）自动重试

### Benchmark Runner
- `run:once` 按 provider x round x audio 顺序执行
- `run:duration` 为每个 provider 单独维护 worker 池
- provider 级别 `runner_options.concurrency` 与 `runner_options.interval_ms` 覆盖 CLI 默认值
- attempt 记录包含 request attempts、retry count、normalized result、evaluation

### Reference Evaluation
- manifest 模式：`reference_text` inline 或 `reference_path` 指向外部文本
- sidecar 模式：`sample.wav` -> `sample.txt`
- reference-dir 模式：按音频相对路径映射到 `.txt`
- 标准化文本后计算：
  - WER：按词或 CJK 字粒度比较
  - CER：按字符比较

### Result Store
- `artifacts/runs/<run-id>/attempts.jsonl`
- `artifacts/runs/<run-id>/summary.json`
- `artifacts/runs/<run-id>/summary.csv`
- `artifacts/runs/<run-id>/raw/*.json`
- `artifacts/asrbench.sqlite`
- SQLite 查询服务支持 `run:list`、`run:show`、`run:export`

SQLite 的作用：
- 供 UI 快速查询 runs 列表
- 供 UI / API 查看 run 详情与 attempt 明细
- 避免每次都遍历 artifact 目录再拼装数据
- 支持按 provider / mode / failure / 时间范围做历史 run 查询
- 保留 attempt 级别音频 metadata，便于 UI 直接显示 `language`、`speaker`、`tags`

### UI Server
- 使用 Node 内置 `http` 提供本地 dashboard
- `GET /api/providers`
- `GET /api/provider-capabilities`
- `GET /api/demo-assets`
- `GET /api/jobs`
- `GET /api/jobs/:job_id`
- `POST /api/jobs/:job_id/cancel`
- `GET /api/runs`
- `GET /api/runs/:run_id`
- `GET /api/runs/:run_id/export`
- `GET /api/runs/:run_id/attempts/:attempt_id/raw`
- `POST /api/run`
- `/` 返回静态 HTML + JS 页面
- `POST /api/run` 只负责排队并返回 job id，实际 benchmark 在后台执行
- job 通过共享内存状态保存 `completed_attempts`、`progress_ratio`、当前 attempt、取消标记
- 页面支持 run 过滤、浏览器内创建 run、background job 轮询、取消任务、demo 预填充、export 下载、provider capability 查看、attempt 筛选、失败诊断、reference/hypothesis diff
- 页面基于当前 run 数据做轻量级条形图，不依赖前端图表库

## 4. 运行流程

### Provider 验证流程
1. 加载 provider 配置
2. 校验配置
3. 构造请求
4. 输出脱敏 request preview
5. 发起真实请求
6. 标准化响应
7. 保存验证报告

### Benchmark 流程
1. 加载 provider
2. 扫描音频
3. 可选加载 dataset manifest，补齐元信息与 manifest reference
4. 可选加载 sidecar / reference-dir transcript，补齐未提供的 reference
5. 创建 run 目录与 run id
6. 选择对应 adapter
7. 执行请求，必要时重试
8. 标准化结果
9. 可选计算 WER / CER
10. 写入 raw attempt
11. 聚合 summary
12. 写入 JSONL / JSON / CSV
13. 写入 SQLite

## 5. 失败处理

失败类型建议包括：
- `timeout`
- `network_error`
- `auth_error`
- `client_error`
- `server_error`
- `schema_error`
- `unsupported_audio`
- `unknown_error`

重试策略：
- 默认不重试
- 仅当 `error.retriable === true` 时重试
- 4xx 非临时错误通常不重试
- 5xx / timeout / network error 可重试

## 6. 当前实现状态

已完成：
- provider 独立配置
- provider switcher
- ZenMux 独立 provider
- `run:once` 和 `run:duration`
- provider 级别调度覆盖
- retry/backoff
- SQLite 存储
- WER / CER
- dataset manifest enrich
- Web UI run filters / create-run form / background jobs
- demo dataset / demo provider assets
- smoke scripts for OpenAI / ZenMux
- run export downloads and provider capability panel

后续可继续扩展：
- SQLite 查询统计 API
- 更丰富的 dashboard 图表
- streaming benchmark
- 更精细的 tokenization / multilingual evaluation
