# Audio ASR Bench - UI 设计

## 1. 设计结论

第一阶段建议 CLI 为主；如果需要 UI，建议做一个很薄的本地 Web UI，通过 HTTP API 调用核心服务。

## 2. UI 目标

- 配置 provider
- 发起 benchmark
- 查看进度
- 查看 summary
- 查看失败诊断

## 3. 页面设计

1. Provider 列表页
2. Provider 验证页
3. 新建 Run 页
4. Run 详情页
5. Attempt 浏览页
6. Summary Dashboard

## 4. 关键组件

### Provider Form
- Name
- Type
- Base URL
- API Key
- Default Model
- Adapter Options 编辑器
- Validate 按钮

### Run Builder
- Provider 多选
- 输入路径选择
- 音频格式过滤
- 运行模式
- 并发数
- 速率限制
- 输出目录

### Run Detail
- Run 状态
- 进度条
- attempt 数
- 成功/失败统计
- latency 图表
- transcript 预览表
- failure diagnostics 面板

## 5. 技术原则

- UI 不写 provider-specific 逻辑
- UI 不直接读写 artifacts
- 所有核心能力由应用层提供
- 将来更换成桌面 UI 时不改 benchmark 内核
