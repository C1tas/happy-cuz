# Skill: Playwright Performance Profiling & Debug

## Overview

使用 Playwright 对 Happy Web App 进行性能分析和网络调试的完整工作流。该流程采用**人机协作模式**：Agent 负责启动浏览器、收集数据、生成报告和分析优化；用户负责在浏览器中执行真实操作（登录、浏览、交互）以模拟真实使用场景。

## 前置条件

| 依赖 | 说明 |
|------|------|
| Playwright | `npx playwright install chromium` 安装浏览器 |
| Happy Web Dev Server | 需要在 `192.168.58.1:8081` 运行（或修改 `TARGET`） |
| Node.js | 运行 profiler.mjs |
| test-results/ 目录 | 报告输出目录，已存在于项目根目录 |

## 工具位置

```
test-results/profiler.mjs    # Playwright profiling 脚本
test-results/*.md             # 生成的 Markdown 报告
test-results/*.json           # 生成的原始 JSON 数据
```

## 数据采集维度

profiler.mjs 采集四类数据：

| 维度 | 采集内容 | 报告章节 |
|------|----------|----------|
| **Network** | 所有 HTTP 请求的 URL、method、status、耗时、大小 | API Requests, Slow Requests, Network Summary |
| **Console** | 所有 console.error / console.warn / console.log | Console Errors, Console Warnings, Sync Logs |
| **WebSocket** | 连接开启/关闭、帧发送/接收计数 | WebSocket Activity |
| **Performance** | DOM loaded、network idle 等关键时间点 | Performance Marks |

API 请求按 URL 中包含 `/v1/` 或 `/v3/` 过滤。Sync 相关日志按关键词（`fetchMessages`, `fetchSessions`, `#init`, `Fast path` 等）过滤。

## 协作流程

### 第一步：启动 Profiler

Agent 在后台启动 profiler 脚本：

```bash
node test-results/profiler.mjs
```

**运行模式**：
- **TTY 模式**（直接在终端运行）：按 Enter 结束录制
- **后台模式**（Agent 通过 Bash tool 启动）：发送 SIGINT 或 SIGTERM 结束录制

Agent 启动时使用 `run_in_background: true`，脚本会：
1. 启动 headed Chromium 浏览器（1400x900）
2. 导航到目标 URL
3. 等待 DOM loaded 和 network idle
4. 开始录制所有网络/控制台/WebSocket 活动
5. 实时打印 error 和 warning 到终端

### 第二步：用户手动操作

浏览器打开后，用户在浏览器中执行测试操作：

1. **登录**（如果需要）— 测试 auth 流程性能
2. **浏览 session 列表** — 测试首屏加载速度
3. **点击 session** — 测试消息加载性能
4. **切换 session** — 测试增量加载和缓存命中
5. **发送消息** — 测试写入路径
6. **下拉刷新** — 测试 reload 机制
7. 其他需要验证的交互场景

**关键原则**：用户操作越贴近真实使用场景，profiling 数据越有价值。

### 第三步：结束录制

用户完成操作后，Agent 停止后台任务（发送信号给 profiler 进程）：

```bash
# 如果知道 PID
kill -INT <pid>

# 或通过 TaskStop 停止后台任务
```

profiler 收到信号后自动生成报告。

### 第四步：提取和分析报告

Agent 读取生成的报告文件，进行分阶段分析：

```
test-results/profiling-report-<timestamp>.md   # 可读报告
test-results/profiling-raw-<timestamp>.json    # 原始数据（用于深入分析）
```

## 报告分析框架

### 1. 页面加载阶段

| 指标 | 来源 | 健康值 |
|------|------|--------|
| DOM Content Loaded | Performance Marks | < 2s |
| Network Idle | Performance Marks | < 5s |

### 2. 认证阶段

关注 `POST /v1/auth/account/request` 和 `POST /v1/auth` 请求链。

| 指标 | 说明 | 健康值 |
|------|------|--------|
| Auth 总耗时 | 从首次 auth 请求到 token 获取 | < 3s |
| Token 刷新频率 | auth/account/request 的调用间隔 | > 30s |

### 3. 首次数据同步阶段

认证完成后并发请求的一组 API：

| 请求 | 是否阻塞 UI | 说明 |
|------|------------|------|
| GET /v1/sessions | **是** — 决定 session 列表可见时机 | 最关键指标 |
| GET /v1/account/settings | 否 | 后台加载 |
| GET /v1/machines | 否 | 后台加载 |
| GET /v1/friends | 否 | 后台加载 |
| GET /v1/artifacts | 否 | 后台加载 |
| GET /v1/feed | 否 | 后台加载 |
| GET /v1/account/profile | 否 | 后台加载 |

**Session 列表可见时间** = sync 开始时间 + sessions 请求耗时 + 解密处理时间

### 4. 消息加载阶段

用户点击 session 后触发：

| 请求模式 | 说明 | 健康值 |
|---------|------|--------|
| `GET /v3/sessions/<id>/messages?before_seq=999999999&limit=50` | 首次加载最近50条 | < 2s |
| `GET /v3/sessions/<id>/messages?after_seq=<N>&limit=100` | 增量更新 | < 500ms |
| `GET /v3/sessions/<id>/messages?before_seq=999999999&limit=20` | 轻量预加载 | < 1s |

### 5. 异常检测

从报告中识别的常见问题模式：

| 模式 | 表现 | 根因方向 |
|------|------|---------|
| **请求风暴** | 同一 endpoint 短时间大量重复请求 | 事件处理绕过 coalescing |
| **长尾请求** | 单个请求 >10s | 服务端慢查询或网络问题 |
| **失败请求** | status=FAILED | 网络断开、服务端错误、超时 |
| **解密循环** | 重复 "encryption permanently unavailable" 警告 | Session 密钥损坏 |
| **WS 重连** | 多次 WebSocket open/close | 网络不稳定或 HMR 触发 |

## 多轮迭代模式

性能优化通常需要多轮 profiling：

```
Round 1: 基线测试
  ↓ 分析报告，定位瓶颈
  ↓ 实施优化
Round 2: 验证优化效果
  ↓ 对比数据，发现新瓶颈
  ↓ 进一步优化
Round N: 确认达到目标
```

每轮测试产生独立的报告文件（带时间戳），便于对比分析。

### 对比分析要点

1. **同一 endpoint 耗时变化** — 优化前后直接对比
2. **请求总数变化** — 是否消除了不必要的重复请求
3. **Failed 请求数变化** — 是否改善了错误处理
4. **Console 错误/警告变化** — 是否消除了已知问题
5. **关键路径耗时** — Session 列表可见时间、消息加载时间

## 清理测试缓存

在新一轮测试前，清理旧的 profiling 数据以避免混淆：

```bash
rm test-results/profiling-report-*.md test-results/profiling-raw-*.json
```

## 注意事项

1. **Headed 模式必须**：profiler 使用 `headless: false`，因为需要用户手动操作浏览器
2. **WSL 环境**：在 WSL 下运行需要 X server 或 WSLg 支持图形界面
3. **后台运行的 stdin 问题**：当 stdin 不是 TTY 时（Agent 后台启动），profiler 通过 `process.stdin.isTTY` 检查自动切换为仅接受 SIGINT/SIGTERM 信号停止
4. **时间戳对齐**：报告中所有时间相对于页面导航开始（`startTime`），不是绝对时间
5. **录制时长**：建议 60-120s 覆盖核心操作路径，长时间录制会产生大量 auth/account/request 心跳数据
6. **WebSocket 持续活跃**：网络 idle 检测可能因 WebSocket 连接无法达到，profiler 设置了 15s 超时
7. **报告只包含 API 请求**：静态资源（JS bundle、字体等）在 Network Summary 中计数，但不在详细列表中展示

## 实际案例

### 案例：Session 列表加载无限循环

**Round 1 发现**：
- 45 个 API 请求中 9 个 FAILED
- Session 列表长时间无法加载，触发 12000ms timeout
- Console 出现大量 "encryption permanently unavailable" 警告

**根因分析**：
- WebSocket `new-message` 事件对解密失败的 session 直接调用 `fetchSessions()`，绕过 InvalidateSync coalescing
- `applyReady()` 等待 sessions + machines 两个 sync 完成，machines 响应慢（14s+）拖慢了整个加载

**优化措施**：
1. 改用 `sessionsSync.invalidate()` 替代直接 `fetchSessions()` 调用
2. 添加 3 次重试限制后放弃解密失败的 session
3. `applyReady()` 仅等待 sessions sync，不等待 machines
4. 添加下拉刷新清理本地缓存重载

**Round 2 验证**：
- Failed 请求从 9 降至 2（减少 78%）
- Session 列表可见时间从 28s+ 降至 ~15s（提升 46%）
- 消息增量更新 125-750ms（流畅）
- 用户反馈"使用体感非常流畅"
