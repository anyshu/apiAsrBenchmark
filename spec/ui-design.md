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
- 顶部提供中英文切换（默认记住上次选择）
- run filters（provider / mode / failures / query）
- recent run 列表
- 展示 run id、模式、attempt 数、平均延迟、平均 WER
- 左栏只保留“历史 run 浏览”这一类高频导航，不把所有功能都堆进去

### 主内容区
- 顶部一级导航：Overview / Create Run / Jobs / Providers
- Overview：Run 概览卡片、Provider Summary、latency / WER / failure 图表、Attempt 列表、Attempt detail / transcript diff、Raw attempt artifact
- Create Run：更宽的表单区域，provider 多选与 provider key 输入不再挤在 sidebar 中
- Jobs：queued / running / succeeded / failed 的后台任务面板
- Providers：provider capability cards

## 4. 视觉方向

- 本地工具但不走“朴素后台管理页”风格
- 使用暖色纸面感背景 + 绿色强调色
- 卡片化布局，便于未来扩展更多图表
- 移动端退化为单列布局
- 长路径、长 provider id 和多语言文案不能撑破 sidebar 卡片布局

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
4. 可通过一级导航切到 Create Run，在浏览器内填写表单发起 `run:once` / `run:duration`
5. 表单错误以内联字段提示返回，而不是只弹通用错误
6. UI 可一键填充 demo dataset / demo provider
7. create-run 表单使用标准 `<form>` 提交，provider key 输入框属于表单上下文
8. provider key 输入值保存在浏览器 localStorage，仅在当前浏览器复用，不回写 provider 配置文件
9. run 进入后台 job 队列，页面轮询 job 状态
10. queued / running job 可请求取消
11. job 成功后自动刷新 run 列表并打开最新 run
12. job 卡片显示完成 attempt 数、进度条、当前 provider / audio
13. job 卡片展示最近 retry/backoff 诊断
14. provider 缺少 env / run-scoped key 时，在提交阶段直接拦截，而不是排队后失败
15. run header 提供 JSON / JSONL / CSV 下载按钮
16. 默认加载最新一个 run
17. 点击左侧 run 卡片切换详情
18. 在 attempt 面板按 provider / status / WER / latency 过滤
19. 点击某个 attempt 查看 failure diagnostics、manifest metadata 和 transcript diff
20. 通过图表快速判断延迟分布、质量分布和失败类型

## 7. 后续演进方向

- latency 分布图
- WER/CER 分布图
- provider 配置编辑器
- 后台异步任务队列与进度反馈
