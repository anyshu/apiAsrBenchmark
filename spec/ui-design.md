# Audio ASR Bench - UI 设计

## 1. 设计结论

第一阶段 UI 采用很薄的本地 Web dashboard：
- benchmark 核心仍然由 CLI / service 层执行
- UI 不参与 provider-specific 请求构造
- UI 只消费 SQLite 中的 run / attempt 数据

## 2. UI 目标

- 查看 benchmark runs 列表
- 查看单个 run 的核心统计
- 查看 provider 维度 summary
- 查看 attempt 明细
- 快速定位高延迟、高重试、高 WER/CER 的样本

## 3. 页面结构

### 左侧 Sidebar
- run filters（provider / mode / failures / query）
- create run form（mode、provider、多种 reference / manifest 参数）
- background jobs（queued / running / succeeded / failed）
- provider capability cards
- run 列表
- 展示 run id、模式、attempt 数、平均延迟、平均 WER

### 主内容区
- Run 概览卡片
- Provider Summary 表格
- latency / WER / failure 可视化卡片
- Attempt 列表表格
- Attempt detail / transcript diff 侧栏
- Raw attempt artifact 查看块

## 4. 视觉方向

- 本地工具但不走“朴素后台管理页”风格
- 使用暖色纸面感背景 + 绿色强调色
- 卡片化布局，便于未来扩展更多图表
- 移动端退化为单列布局

## 5. 数据来源

当前 UI 不直接读取 `artifacts/runs/*` 文件，而是走本地 HTTP API：
- `GET /api/providers`
- `GET /api/provider-capabilities`
- `GET /api/demo-assets`
- `GET /api/jobs`
- `GET /api/runs`
- `GET /api/runs/:run_id`
- `GET /api/runs/:run_id/export`
- `GET /api/runs/:run_id/attempts/:attempt_id/raw`
- `POST /api/run`

这样后续替换为：
- Electron
- 桌面客户端
- 更完整的前后端分离页面

都不需要重写 benchmark 核心。

## 6. 最小交互

1. 打开 `/`
2. 自动请求 `/api/providers`、`/api/jobs` 和 `/api/runs`
3. 可在左侧先按 run 维度过滤历史 benchmark
4. 可直接在浏览器内填写 create-run 表单发起 `run:once` / `run:duration`
5. 表单错误以内联字段提示返回，而不是只弹通用错误
6. UI 可一键填充 demo dataset / demo provider
7. run 进入后台 job 队列，页面轮询 job 状态
8. queued / running job 可请求取消
9. job 成功后自动刷新 run 列表并打开最新 run
10. job 卡片显示完成 attempt 数、进度条、当前 provider / audio
11. job 卡片展示最近 retry/backoff 诊断
12. run header 提供 JSON / JSONL / CSV 下载按钮
13. 默认加载最新一个 run
14. 点击左侧 run 卡片切换详情
15. 在 attempt 面板按 provider / status / WER / latency 过滤
16. 点击某个 attempt 查看 failure diagnostics、manifest metadata 和 transcript diff
17. 通过图表快速判断延迟分布、质量分布和失败类型

## 7. 后续演进方向

- latency 分布图
- WER/CER 分布图
- provider 配置编辑器
- 后台异步任务队列与进度反馈
