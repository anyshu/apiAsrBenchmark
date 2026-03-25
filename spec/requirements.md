# Audio ASR Bench - 需求分析

## 1. 目标

构建一个基于远程 API 的音频 ASR benchmark 平台，优先支持 OpenAI 兼容接口，同时允许像 ZenMux 这样“表面兼容但最佳调用方式不同”的 provider 走独立实现。

## 2. 用户输入

- 一组 provider 配置：`base_url`、`api_key`、headers、model、重试/调度参数
- 一组本地音频文件：`wav`、`mp3`、`m4a`、`flac`、`ogg`、`aac`
- 可选参考文本：sidecar `.txt` 或独立 reference 目录

## 3. 核心问题

1. 不同 provider 的请求格式和能力入口不一致
2. 不同 provider 的返回 JSON 结构不一致
3. 压测场景需要持续发请求，并支持 provider 级别并发与节流
4. benchmark 需要同时记录性能指标与识别质量指标
5. CLI / Web UI 必须是薄入口，不能把业务逻辑写死在界面层

## 4. 功能需求

### FR-1 Provider 配置
- 支持多个 provider
- 支持 `provider_id`、`name`、`type`、`base_url`、`api_key`、`headers`、`default_model`
- 支持 `timeout_ms`、`retry_policy`、`runner_options`、`adapter_options`
- provider 配置应支持按独立文件组织，推荐一份 provider 一个配置文件
- 系统应支持加载单文件或整个 provider 目录

### FR-2 Provider 扩展能力
- 第一阶段至少支持 `openai_compatible`、`zenmux`、`custom_http`
- 系统应通过 provider switcher 在运行时选择正确 adapter
- ZenMux 这类 provider 可以复用部分 OpenAI 风格构造能力，但设计上仍然应作为独立 provider type

### FR-3 音频输入
- 支持单文件与目录输入
- 支持递归扫描
- 记录路径、文件名、格式、大小、音频时长、`audio_id`

### FR-4 Benchmark 运行
- 支持单次运行 `run:once`
- 支持多轮运行
- 支持按时长持续运行 `run:duration`
- 支持全局默认并发和默认间隔
- 支持 provider 级别覆盖 `concurrency`、`interval_ms`
- 支持可重试错误的自动重试和 backoff

### FR-5 结果采集
- 保存原始响应和标准化 transcript
- 保存 segment / word timestamp（如果 provider 返回）
- 保存错误类型、HTTP 状态、重试历史

### FR-6 指标记录
- 记录开始时间、完成时间、端到端延迟
- 记录成功/失败、provider/model、音频信息
- 在可获得音频时长时记录 `rtf`
- 记录总重试数、平均重试数

### FR-7 识别质量评估
- 支持 sidecar reference（如 `a.wav` 对应 `a.txt`）
- 支持 reference 目录映射
- 在有 reference 时计算 WER / CER
- 在 attempt、provider、run 三个层级输出聚合质量指标

### FR-8 结果持久化
- `JSONL` 保存 attempt 记录
- `JSON` 保存 run summary
- `CSV` 用于导出汇总结果
- `raw/` 保存原始响应与调试信息
- `SQLite` 保存 run / attempt 元信息，供后续 UI 和 API 查询

### FR-9 Provider 验证
- 配置校验
- 请求预览
- 样例音频真实调用
- 响应解析校验
- 标准化结果预览

### FR-10 CLI 与 UI
- CLI 负责 provider 列表、验证、运行、启动 UI
- CLI 负责 SQLite run 查询与导出
- SQLite run 查询支持按 provider、mode、失败情况、时间范围过滤
- 本地 Web UI 从 SQLite 读取 runs / attempts，不直接读取 provider-specific 逻辑
- Web UI 支持失败 attempt 筛选、关键指标过滤、transcript diff 查看
- 将来替换成其他 UI 形态时，不应修改 benchmark 内核

## 5. 非功能需求

- 模块解耦
- 配置驱动
- 可扩展性
- 可复现性
- 可调试性
- 敏感信息脱敏
- 本地可运行
- UI 与核心能力松耦合

## 6. 当前实现结论

当前代码已覆盖：
- provider 独立配置文件
- `openai_compatible` / `zenmux` / `custom_http`
- provider switcher
- `run:once` / `run:duration`
- provider 级别调度覆盖
- 重试 + 指数 backoff
- JSONL / JSON / CSV + SQLite
- sidecar / reference-dir transcript
- WER / CER
- 最小本地 Web UI
