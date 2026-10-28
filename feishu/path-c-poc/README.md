# Path C POC：search + me_join + WSClient 长连接（TypeScript）

对照 `../飞书公开群search与me_join自动入群-技术方案.md`。

| 能力 | 实现 |
| --- | --- |
| 发现 / 入群 | REST `Client`：`search` → 差集 → `meJoin`（`auto_join.ts`） |
| 事件 | **`WSClient` 出站长连接** + `EventDispatcher`（`server.ts`）订阅 `im.chat.member.bot.added_v1` |
| 非目标 | **不用** webhook HTTP 服务；不写业务库 / ensureProject |

栈：TypeScript + `@larksuiteoapi/node-sdk`（见 `AGENTS.md`）。

## 硬性前提

- 公开群、名称含约定关键词、关闭入群审批；同租户自建应用 + 机器人
- 开放平台 → 事件与回调 → 订阅方式选 **长连接（使用长连接接收事件/回调）**（不是请求地址 webhook）
- 订阅事件：**机器人进群** `im.chat.member.bot.added_v1`
- **禁止**：`chatMembers.create` 自拉；空 `query`；无 `nameAllowRegex` 就 join

## 权限（最小集）

| 能力 | 权限示例 |
| --- | --- |
| search / 所在群 / 读群 | `im:chat` 或 `im:chat:readonly` / `im:chat:read` |
| `me_join` | `im:chat` 或 `im:chat.members:write_only` |
| 机器人进群事件 | 订阅机器人进、出群等（文档「开启任一即可」） |

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `FEISHU_APP_ID` | 是 | App ID（`cli_…`） |
| `FEISHU_APP_SECRET` | 是 | App Secret |
| `FEISHU_AUTO_JOIN_QUERY` | 是 | search 关键词，非空，≤64 |
| `FEISHU_AUTO_JOIN_NAME_ALLOW_REGEX` | 是 | 群名二次过滤 |
| `FEISHU_AUTO_JOIN_MAX_JOINS` | 否 | 单轮最多 me_join，默认 `3` |
| `FEISHU_AUTO_JOIN_INTERVAL_SEC` | 否 | 长连接进程内轮询间隔秒，默认 `120`；`0` 表示只跑启动一轮 |
| `FEISHU_AUTO_JOIN_CHAT_ID_DENY` | 否 | 逗号分隔黑名单 |

## 怎么跑

```bash
cd feishu/path-c-poc
npm install

export FEISHU_APP_ID=cli_xxx
export FEISHU_APP_SECRET=xxx
export FEISHU_AUTO_JOIN_QUERY=课题
export FEISHU_AUTO_JOIN_NAME_ALLOW_REGEX='^课题'

# 推荐：WSClient 长连接 + 定时 Path-C tick（进程保持运行）
npm start
# 等同: npx tsx server.ts
# 可选: --dry-run  /  --confirm-public  /  --skip-join-on-start

# 仅 REST 单轮（不连 WS）
npm run dry-run
npm run once -- --confirm-public
```

## 预期

1. 启动后日志出现 `[ws] starting WSClient…`、`[ws] WSClient start() returned…`，连上后还有 `[ws] onReady`（开发者后台须已选长连接订阅）。
2. Path-C tick 打印 search / 候选 / `me_join ok|fail`。
3. `me_join` 成功后（或人拉 bot），长连接收到 `[ws] im.chat.member.bot.added_v1 …`（本 POC 只打日志）。
4. **没有**本地 HTTP webhook 监听端口。

## 文件

| 文件 | 作用 |
| --- | --- |
| `server.ts` | `WSClient` + `EventDispatcher` + 定时 `runAutoJoinTick` |
| `auto_join.ts` | Path-C REST tick |
| `run_once.ts` | 无 WS 的单轮 CLI |
