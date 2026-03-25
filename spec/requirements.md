# Audio ASR Bench - 需求分析

## 1. 目标

构建一个基于远程 API 的音频 ASR benchmark 平台，优先支持 OpenAI 兼容接口，并为未来新增接口形式保留扩展能力。

## 2. 用户已明确的输入

- 一组 ASR 服务配置，例如 `base_url`、`api_key`
- 一组本地音频文件，例如 `wav`、`mp3` 等主流格式

## 3. 核心问题

1. 不同 provider 的请求格式不一致
2. 不同 provider 的返回结构不一致
3. 需要持续请求并记录关键性能指标
4. 核心能力需要与 CLI / Web UI 解耦

## 4. 功能需求

### FR-1 Provider 配置
- 支持多个 provider
- 支持 `provider_id`、`name`、`type`、`base_url`、`api_key`、`headers`、`default_model`、`timeout_ms`、`retry_policy`、`adapter_options`
- provider 配置应支持按“独立文件”组织，推荐一份 provider 对应一个配置文件
- 系统应支持从 provider 配置目录自动加载所有 provider，而不是要求集中写在单一大文件中

### FR-2 Provider 扩展能力
- 第一阶段至少支持 `openai_compatible`、`zenmux` 与 `custom_http`
- 新 provider 接入应尽量通过配置或 adapter 扩展完成
- 对于像 ZenMux 这类“协议表面兼容、能力路由不同”的 provider，设计上应允许独立 provider 实现
- 系统应有一层 provider switcher / router，在运行时选择正确 provider 实现

### FR-3 音频输入
- 支持单文件与目录输入
- 支持递归扫描
- 支持 `wav`、`mp3`、`m4a`、`flac`、`ogg`、`aac`
- 保留文件路径、文件名、时长、大小、hash 等元数据

### FR-4 持续运行
- 支持单次运行
- 支持多轮运行
- 支持按时长持续运行
- 支持并发配置
- 支持请求间隔 / rate limit

### FR-5 结果采集
- 保存原始响应
- 保存标准化 transcript
- 保存 segment / word timestamp
- 保存错误信息

### FR-6 指标记录
- 记录调度时间、开始时间、返回时间、完成时间
- 记录端到端延迟
- 记录 HTTP 状态、成功失败、provider/model、音频信息

### FR-7 结果持久化
- `JSONL` 保存 attempt 记录
- `JSON` 保存 run summary
- `CSV` 用于导出汇总结果
- `raw/` 保存原始响应与调试信息

### FR-8 Provider 验证
- 配置校验
- 请求预览
- 样例音频真实调用
- 响应解析校验
- 标准化结果预览

### FR-9 CLI
- provider list
- provider validate
- run create/start/once
- run summary
- export

### FR-10 UI 可替换
- 核心逻辑不放在 CLI 或 Web UI 中
- CLI / Web 只作为不同入口

## 5. 非功能需求

- 模块解耦
- 高可扩展性
- 可复现性
- 可调试性
- 敏感信息脱敏
- 本地可运行
- UI 独立于核心能力

## 6. 建议补充项

- 从环境变量读取 API key
- 区分可重试和不可重试错误
- 固定输入 manifest
- 为音频计算 `sha256`
- 预留 cancel / resume 能力
- 预留 reference transcript 字段
