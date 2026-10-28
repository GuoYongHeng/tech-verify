# Git 多平台集成 — 可行性 Demo 实用手册

对照 `../git-integration-design.md` 的**最小可行性验证**：用 TypeScript + 原生 `fetch` 跑通

1. 安全 URL 解析（HTTPS / 域名白名单 / 拒凭据与非常规端口）
2. `probe` 可见性
3. `commits`（可带 `since` 做增量）
4. `readme`
5. `normalizeCommit` / `renderCommit` / `renderReadme` → **只打日志**，当作“证据”

**没有**数据库表、没有加密存 token、没有 Worker / Kairos。配置全靠环境变量。

## 目录

| 文件 | 作用 |
| --- | --- |
| `src/git-source.ts` | `parseRepoUrl`、`GitApi`、错误码、标准化 |
| `src/sync-demo.ts` | 单次同步入口（绑定→探测→拉提交→README→log） |
| `package.json` | Node ≥ 18；运行用 `tsx`（无运行时业务依赖） |

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `GIT_REPO_URL` | 是 | 如 `https://github.com/owner/repo` 或带 `/tree/main/src` |
| `GIT_TOKEN` | 私有仓建议 | Bearer token；公开仓可省略 |
| `GIT_SINCE` | 否 | ISO 8601，增量同步（对应设计里的 `cursor_time`） |
| `GIT_BRANCH` | 否 | 覆盖 URL 里解析出的分支 |
| `GIT_PATH` | 否 | 路径作用域（commits `path` 参数） |
| `GIT_PER_PAGE` | 否 | 默认 `5`（demo 小页） |
| `GIT_MAX_PAGES` | 否 | 默认 `1` |

支持域名：`github.com`、`gitcode.com`（与方案白名单一致）。

## 怎么跑

```bash
cd codebase/git-integration-demo
npm install

# 公开仓（可用本仓库或任意公开仓）
export GIT_REPO_URL=https://github.com/GuoYongHeng/tech-verify
npm start

# 增量：用上一次 summary 里的 suggestedNextSince
export GIT_SINCE=2026-10-27T00:00:00.000Z
npm start

# 私有仓
export GIT_TOKEN=ghp_xxx   # 或 GitCode 只读 token
export GIT_REPO_URL=https://github.com/owner/private-repo
npm start
```

## 预期输出

- `[bind]` 解析后的 `RepoRef`
- `[probe]` `visibility=public|private`
- `[commits]` 每页条数；每条 `[evidence] type=git_commit` + 渲染文本
- `[readme]` / README 证据片段
- `[summary]` `commitsLogged` 与建议的下一次 `GIT_SINCE`

失败时打印方案中的错误码：`GIT_UNAUTHORIZED` / `GIT_NOT_FOUND` / `GIT_RATE_LIMITED` 等。

## 与正式方案的差距（刻意）

- 无 `project_repos` / `evidence` 表；`external_id` 仅内存去重 + 日志
- 无 AES 封存 token、无审批流、无 15 分钟时间槽调度
- 不拉 diff / 文件树 / 归档；只读元数据

## 安全注意

Demo 会向白名单平台发真实 HTTPS 请求；请勿把 token 写进仓库或提交进 git。
