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
- run 列表
- 展示 run id、模式、attempt 数、平均延迟、平均 WER

### 主内容区
- Run 概览卡片
- Provider Summary 表格
- Attempt 列表表格

## 4. 视觉方向

- 本地工具但不走“朴素后台管理页”风格
- 使用暖色纸面感背景 + 绿色强调色
- 卡片化布局，便于未来扩展更多图表
- 移动端退化为单列布局

## 5. 数据来源

当前 UI 不直接读取 `artifacts/runs/*` 文件，而是走本地 HTTP API：
- `GET /api/runs`
- `GET /api/runs/:run_id`

这样后续替换为：
- Electron
- 桌面客户端
- 更完整的前后端分离页面

都不需要重写 benchmark 核心。

## 6. 最小交互

1. 打开 `/`
2. 自动请求 `/api/runs`
3. 默认加载最新一个 run
4. 点击左侧 run 卡片切换详情

## 7. 后续演进方向

- latency 分布图
- WER/CER 分布图
- 失败 attempt 筛选
- transcript diff 视图
- provider 配置编辑器
- run 创建表单
