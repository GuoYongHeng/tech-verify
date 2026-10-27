# Path C POC：search + me_join 可行性验证（TypeScript）

对照上级目录技术方案  
`../飞书公开群search与me_join自动入群-技术方案.md`  
做**单轮**可行性验证：搜可见公开群 → 差集过滤 → `me_join`。

栈：**TypeScript** + 官方 **`@larksuiteoapi/node-sdk`**（见 `AGENTS.md`）。不用 Python。

**不是**生产任务：无定时守护、无分布式锁、无退避表、不写业务库、不发群卡片。  
入群成功后的建档仍依赖正式应用订阅的 `im.chat.member.bot.added_v1`（本 POC 不处理事件）。

## 硬性前提（与方案一致）

- 目标群为**公开群**（`chat_type=public`），且**关闭入群审批**
- 群名含约定关键词（search 的 `query` **不能为空**）
- 应用与群同租户；机器人具备搜群 / 所在群列表 / `me_join` 权限
- **禁止**：用 `chatMembers.create`（`POST .../members`）自拉；空关键词轮询；无 `nameAllowRegex` 就一律 join

## 飞书应用权限（最小集）

| 能力 | 权限示例 |
| --- | --- |
| `chats/search`、所在群列表、读群 | `im:chat` 或 `im:chat:readonly` / `im:chat:read` |
| `me_join` | `im:chat` 或 `im:chat.members:write_only` |
| 机器人能力 | 开启 Bot |

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `FEISHU_APP_ID` | 是 | 应用 App ID |
| `FEISHU_APP_SECRET` | 是 | 应用 App Secret |
| `FEISHU_AUTO_JOIN_QUERY` | 是 | search 关键词，非空，≤64 字（如 `课题`） |
| `FEISHU_AUTO_JOIN_NAME_ALLOW_REGEX` | 是 | 群名二次过滤；**无匹配则不 join** |
| `FEISHU_AUTO_JOIN_MAX_JOINS` | 否 | 单轮最多 `me_join`，默认 `3` |
| `FEISHU_AUTO_JOIN_CHAT_ID_DENY` | 否 | 逗号分隔 `chat_id` 黑名单 |

## 怎么跑

```bash
cd feishu/path-c-poc
npm install

export FEISHU_APP_ID=cli_xxx
export FEISHU_APP_SECRET=xxx
export FEISHU_AUTO_JOIN_QUERY=课题
export FEISHU_AUTO_JOIN_NAME_ALLOW_REGEX='^课题'

# 先只看 search/差集，不入群
npm run dry-run
# 或: npx tsx run_once.ts --dry-run

# 确认候选后再真实 me_join（可选再核验公开群）
npx tsx run_once.ts --confirm-public
```

依赖：Node.js ≥ 18。SDK 调用：

- `client.im.chat.searchWithIterator` → `GET /im/v1/chats/search`
- `client.im.chat.listWithIterator` → `GET /im/v1/chats`
- `client.im.chatMembers.meJoin` → `PATCH .../members/me_join`

## 预期结果

1. **dry-run**：打印 `search_hits`、`already_joined`、过滤后候选列表；**不**调用 `me_join`。
2. **正式跑**：对每个候选 `meJoin`；成功打印 `me_join ok`；失败打印飞书 `code`（如 `232075`），进程不崩溃。
3. 机器人应出现在已 join 的公开群中；若正式服务已订阅 `bot.added`，后续建档由那边完成。

## 本 POC 刻意不做的

- 路径 A（人拉 bot）/ 路径 B（业务系统建群）
- 定时循环、指标、冷却退避、多实例单飞
- `ensureProject` / 成员 ACL / 群内说明卡片
