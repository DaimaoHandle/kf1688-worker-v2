# kf1688-worker-v2

基于 OpenClaw existing-session / browser 控制链路的 1688 客服 worker。

它的目标不是伪造登录，也不是自己维护独立浏览器，而是：
- 复用已经登录好的 1688 旺旺页面
- 识别未读会话
- 读取最近客户消息
- 命中规则时自动回复
- 遇到高风险/复杂问题时转人工
- 通过回复码把人工回复再转发回 1688 会话

这个版本已经去掉了项目内硬编码的服务器地址、通知对象、店铺名等部署相关信息，适合迁移到其他服务器。

## 最近更新（2026-03-31）

昨天这版主要完成了 3 类更新：

1. 去重增强
   - 修复重复回复、重复转人工
   - 增加 inflight / completed / pendingReplies 多层去重
   - 补了 ack 类短消息的去重窗口

2. FAQ/规则库接入
   - 新增 `knowledge/faq.json`
   - 新增 `src/knowledge-base.js`
   - 支持常见问题规则匹配、标准回复、部分 follow-up
   - 售后/投诉/明确要人工类问题直接转人工

3. 日志轮转
   - 新增 `src/log-rotate.js`
   - `npm start` 前自动轮转日志
   - 默认保留近 3 天日志

对应提交：
- `aeeb767 fix: dedupe repeated replies and escalations`
- `c51e3b6 chore: rotate worker logs daily and retain 3 days`

## 当前能力

### 已支持

- 接管已登录的 1688 IM 页签
- 识别未读会话并切换
- 解析会话尾部消息
- 基于规则自动回复简单问法
- 对 FAQ 命中问题直接回复
- 对人工/售后/投诉类问题转人工
- 生成 `RXXXX` 回复码
- 支持手动按回复码把人工回复发回 1688
- 支持商品卡/商品链接相关上下文处理
- 支持调用主 agent 做商品分析

### 当前仍依赖

- 必须已有可用的 1688 登录态
- 页面 DOM 结构不能发生过大变化
- OpenClaw 当前环境必须具备可用 browser / agent 能力

## 目录结构

```text
kf1688-worker-v2/
├── knowledge/
│   └── faq.json
├── runtime/
├── src/
│   ├── browser-adapter.js
│   ├── knowledge-base.js
│   ├── log-rotate.js
│   ├── message-parser.js
│   ├── notify.js
│   ├── product-ai.js
│   └── worker.js
├── package.json
└── README.md
```

## 环境变量

下面这些都建议在部署时显式配置，不要依赖默认值。

### 基础配置

- `KF1688_BROWSER_PROFILE`
  - 已登录 1688 的浏览器 profile 名
  - 默认：`user`

- `KF1688_SELLER_NAME`
  - 当前店铺/卖家显示名
  - 用于区分买家/卖家消息
  - 例：`某某百货`

- `KF1688_NOTIFY_TARGET`
  - 飞书通知目标
  - 例：`user:ou_xxx`

- `KF1688_GATEWAY_URL`
  - Gateway tools invoke 地址
  - 例：`http://127.0.0.1:18789/tools/invoke`

### 轮询与状态

- `KF1688_POLL_MS`
  - 轮询间隔，默认 `8000`

- `KF1688_ERROR_BACKOFF_MS`
  - 异常退避毫秒，默认 `15000`

- `KF1688_DEDUPE_WINDOW_MS`
  - 去重窗口，默认 `14400000`（4 小时）

- `KF1688_SHORT_ACK_DEDUPE_MS`
  - 简短确认类消息去重窗口，默认 `120000`

- `KF1688_CONTEXT_ONLY_FALLBACK_MS`
  - 商品上下文消息等待补充问题的超时，默认 `60000`

- `KF1688_WORKER_STATE`
  - 运行态文件路径

- `KF1688_LOG_RETAIN_DAYS`
  - 日志保留天数，默认 `3`

### Browser 恢复相关

- `KF1688_BROWSER_RETRY`
  - browser 恢复重试次数

- `KF1688_BROWSER_RETRY_WAIT_MS`
  - browser 恢复重试间隔

## 安装

```bash
npm install
npm run check
```

## 推荐启动方式

不要把路径写死进 npm script。更推荐在部署机上通过环境变量启动。

### 单次检查

```bash
KF1688_BROWSER_PROFILE=user \
KF1688_SELLER_NAME='你的店铺名' \
KF1688_NOTIFY_TARGET='user:ou_xxx' \
KF1688_GATEWAY_URL='http://127.0.0.1:18789/tools/invoke' \
KF1688_WORKER_STATE='./runtime-state.json' \
node src/worker.js --once
```

### 持续运行

```bash
mkdir -p runtime
node src/log-rotate.js

KF1688_BROWSER_PROFILE=user \
KF1688_SELLER_NAME='你的店铺名' \
KF1688_NOTIFY_TARGET='user:ou_xxx' \
KF1688_GATEWAY_URL='http://127.0.0.1:18789/tools/invoke' \
KF1688_WORKER_STATE='./runtime-state.json' \
node src/worker.js >> ./runtime/worker.log 2>&1
```

## package.json 脚本说明

仓库里当前 `package.json` 仍保留了本机绝对路径版脚本，便于现有机器直接跑；
但如果你要迁移到新服务器，建议改成相对路径或直接按上面的命令启动。

## 手动人工回复

当 worker 发出人工提醒后，会给出一个回复码，例如：

```text
【待处理】R7821
会话：某客户
客户消息：你好，这款能开专票吗
原因：FAQ命中高风险/人工意图：manual_request
回复格式：回复 R7821：你的内容
```

可以手工执行：

```bash
node src/worker.js --send-code R7821 --text "这里填写要回复给客户的话术"
```

## FAQ 规则库说明

FAQ 放在：

```text
knowledge/faq.json
```

每条规则支持：
- `intent`
- `enabled`
- `priority`
- `triggers`
- `reply`
- `followup`
- `handoff`
- `notes`

目前已覆盖：
- 专票
- LOGO / 贴牌
- 自提
- 现货
- 价格/报价
- 发货时效
- 改地址
- 定制
- 相似款
- 起订量
- 样品/打样
- 运费/物流
- 发票
- 催发
- 明确要求人工
- 售后/投诉/退款/差评风险

## 调试建议

### 1. 先做语法检查

```bash
npm run check
```

### 2. 先跑单轮

```bash
node src/worker.js --once
```

### 3. 看状态文件

```bash
cat runtime-state.json
```

重点关注：
- `lastLoopAt`
- `lastErrorAt`
- `lastError`
- `lastResult`
- `pendingReplies`

### 4. 看日志

```bash
tail -f runtime/worker.log
```

### 5. 如果 browser 能力异常

仓库日志里出现过这类错误：

```text
error: unknown command 'browser'
```

这说明目标机器上的 OpenClaw 版本或能力集不对，不是 worker 本身逻辑错误。
需要先确认该机器：
- OpenClaw 安装正常
- 支持 `openclaw browser ...`
- 有可复用的已登录 profile

## 部署到新服务器前必须改的东西

至少确认这些变量不是写死状态：

- 店铺名：`KF1688_SELLER_NAME`
- 飞书通知对象：`KF1688_NOTIFY_TARGET`
- Gateway 地址：`KF1688_GATEWAY_URL`
- 状态文件路径：`KF1688_WORKER_STATE`
- 浏览器 profile：`KF1688_BROWSER_PROFILE`

如果要做多店铺/多机器部署，建议每个实例独立：
- 一个浏览器 profile
- 一个 runtime-state.json
- 一个 runtime/ 日志目录
- 一组独立环境变量

## 给 OpenClaw 的部署提示词

下面这段可以直接丢给另一台服务器上的 OpenClaw，让它快速接手部署和调试：

```text
请帮我部署并调试 kf1688-worker-v2，要求如下：

1. 先检查当前机器是否满足运行条件：
   - Node.js / npm 可用
   - OpenClaw 可用
   - `openclaw browser` 能正常使用
   - 机器上已有一个浏览器 profile，并且该 profile 已登录 1688 旺旺

2. 从仓库拉取项目后，不要把任何业务变量写死在代码里。以下信息必须通过环境变量或独立配置注入：
   - 店铺名称（KF1688_SELLER_NAME）
   - 飞书通知对象（KF1688_NOTIFY_TARGET）
   - Gateway 地址（KF1688_GATEWAY_URL）
   - 浏览器 profile（KF1688_BROWSER_PROFILE）
   - 状态文件路径（KF1688_WORKER_STATE）

3. 先执行：
   - npm install
   - npm run check
   - 使用 `node src/worker.js --once` 做一次单轮调试

4. 如果调试失败，请优先定位以下问题：
   - OpenClaw 版本不支持 `openclaw browser`
   - 浏览器 profile 未登录 1688
   - 当前没有可复用的 1688 IM 页签
   - DOM 结构变化导致消息解析失败
   - Gateway token / notify 发送链路异常

5. 如果单轮检查通过，再启动长期运行版本，并输出：
   - 启动命令
   - 日志路径
   - runtime-state.json 路径
   - 当前使用的环境变量清单（值可脱敏）

6. 调试过程中，优先保持代码通用性，不要把服务器地址、店铺名、飞书用户、路径等信息直接写死到源码中；如必须调整，优先改成环境变量默认值或 README 示例。
```

## 后续建议

下一步比较值得继续做的是：
- 把 README 里的绝对路径脚本彻底改成相对路径/配置驱动
- 增加 `.env.example`
- 把通知、店铺规则、FAQ 进一步拆成配置文件
- 增加 systemd / pm2 部署示例
- 补一套最小回归测试样本
