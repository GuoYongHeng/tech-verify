# Git 多平台集成技术方案

## 1. 概述

本方案实现了对 GitHub 和 GitCode 两个代码托管平台的统一只读集成，用于跟踪项目关联的代码仓库活动，将提交历史和 README 文档转化为知识库证据。

### 1.1 核心目标

- **多平台统一抽象**：屏蔽不同平台的 API 差异，提供统一的访问接口
- **安全边界控制**：只读访问，严格限制访问范围，防止 SSRF 攻击
- **增量同步机制**：定期拉取新提交，避免重复处理
- **可靠性保障**：限流处理、错误重试、状态追踪

### 1.2 业务场景

项目负责人或管理员关联代码仓库后，系统自动：
1. 定期拉取新提交记录
2. 将每个提交转化为"证据"（Evidence）存入知识库
3. 通过 Kairos 引擎从提交信息中提取"记忆"（Memory）
4. 构建项目的知识图谱

## 2. 架构设计

### 2.1 分层架构

```
┌─────────────────────────────────────────┐
│   业务层 (project-repos.ts)             │
│   - 仓库绑定管理                         │
│   - 增量同步调度                         │
│   - 证据生成                             │
└──────────────┬──────────────────────────┘
               │
┌──────────────▼──────────────────────────┐
│   抽象层 (git-source.ts)                │
│   - GitApi 统一接口                     │
│   - 平台无关的数据模型                   │
│   - 错误统一处理                         │
└──────────────┬──────────────────────────┘
               │
┌──────────────▼──────────────────────────┐
│   传输层                                 │
│   - HTTPS REST API 调用                 │
│   - 响应解析和验证                       │
│   - 限流和重试                           │
└─────────────────────────────────────────┘
```

### 2.2 核心接口定义

```typescript
// 统一的仓库引用
export type RepoRef = {
  platform: 'github' | 'gitcode';
  owner: string;      // 所有者/组织
  repo: string;       // 仓库名
  branch: string;     // 分支名（空字符串表示默认分支）
  path: string;       // 路径作用域（空字符串表示根目录）
};

// 统一的提交记录
export type Commit = {
  sha: string;        // 提交哈希（小写）
  author: string;     // 作者名称
  time: string;       // ISO 8601 时间戳
  message: string;    // 提交说明
  url: string;        // 提交页面 URL
};

// 统一的 README 内容
export type Readme = {
  sha: string;        // 内容哈希
  text: string;       // 解码后的文本内容
};

// 统一的 API 接口
export interface GitApi {
  // 探测仓库可见性
  probe(ref: RepoRef): Promise<'public' | 'private'>;
  
  // 获取提交历史（支持分页和增量）
  commits(ref: RepoRef, options: {
    token?: string;
    since?: string;    // ISO 8601 时间戳
    page: number;
    perPage: number;
  }): Promise<Commit[]>;
  
  // 获取 README 文件
  readme(ref: RepoRef, token?: string): Promise<Readme | null>;
}
```

## 3. 技术实现细节

### 3.1 URL 解析与验证

**安全优先原则**：严格验证仓库 URL，防止被用作 SSRF 探测工具。

```typescript
// 支持的 URL 格式示例：
// ✅ https://github.com/owner/repo
// ✅ https://github.com/owner/repo.git
// ✅ https://github.com/owner/repo/tree/main/src
// ✅ https://gitcode.com/owner/repo

// 拒绝的格式：
// ❌ http://github.com/...           (非 HTTPS)
// ❌ https://user:pass@github.com/... (包含凭据)
// ❌ https://github.com:8080/...     (非标准端口)
// ❌ https://evil.com/...            (非白名单域名)
```

**验证规则**：
- 必须使用 HTTPS 协议
- 不允许 URL 中包含用户名、密码
- 端口必须是 443 或省略
- 域名必须在白名单中（`github.com`、`gitcode.com`）
- owner/repo 名称只允许字母、数字、`_.-` 字符
- 分支和路径名称经过严格正则验证，拒绝 `..` 路径穿越

### 3.2 HTTP 请求实现

使用原生 `fetch()` API，不依赖第三方 SDK：

```typescript
async function request(platform: Platform, path: string, token?: string): Promise<unknown> {
  const headers: Record<string, string> = {
    accept: platform === 'github' 
      ? 'application/vnd.github+json' 
      : 'application/json',
    'user-agent': 'InnoCoworkerSaaS-git-sync'
  };
  
  if (platform === 'github') {
    headers['x-github-api-version'] = '2022-11-28';
  }
  
  if (token) {
    headers.authorization = 'Bearer ' + token;
  }
  
  const response = await fetch(API[platform] + path, {
    headers,
    signal: AbortSignal.timeout(15000),  // 15秒超时
    redirect: 'error'                     // 拒绝重定向
  });
  
  // ... 错误处理和响应解析
}
```

### 3.3 API 端点映射

| 功能 | GitHub API | GitCode API |
|------|-----------|-------------|
| 基础 URL | `https://api.github.com` | `https://api.gitcode.com/api/v5` |
| 提交历史 | `GET /repos/{owner}/{repo}/commits` | `GET /repos/{owner}/{repo}/commits` |
| README | `GET /repos/{owner}/{repo}/readme` | `GET /repos/{owner}/{repo}/readme` |
| 探测仓库 | `GET /repos/{owner}/{repo}/commits?per_page=1` | 同左 |

**查询参数**：
- `sha` / `ref`: 指定分支
- `path`: 限定路径作用域
- `since`: ISO 8601 时间戳，用于增量同步
- `page` / `per_page`: 分页参数

### 3.4 响应数据标准化

不同平台的 API 响应结构略有差异，通过 `normalizeCommit()` 函数统一：

```typescript
export function normalizeCommit(x: any): Commit | null {
  const sha = typeof x?.sha === 'string' ? x.sha : '';
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) return null;
  
  // GitHub: x.commit.author.date
  // GitCode: x.commit.author.date 或 x.commit.committer.date
  const c = x.commit ?? {};
  const a = c.author ?? c.committer ?? {};
  const time = new Date(a.date ?? c.committer?.date ?? '');
  
  if (Number.isNaN(time.getTime())) return null;
  
  // 提取作者名称（优先级：author.name > author.login）
  const author = String(a.name ?? x.author?.login ?? x.author?.name ?? '')
    .slice(0, 120);
  
  return {
    sha: sha.toLowerCase(),
    author,
    time: time.toISOString(),
    message: String(c.message ?? '').slice(0, 4000),
    url: typeof x.html_url === 'string' && x.html_url.startsWith('https://') 
      ? x.html_url.slice(0, 500) 
      : ''
  };
}
```

### 3.5 错误处理与重试

**统一错误类型**：

```typescript
export class GitError extends Error {
  constructor(
    public code: 'GIT_UNAUTHORIZED' 
               | 'GIT_NOT_FOUND' 
               | 'GIT_RATE_LIMITED' 
               | 'GIT_UNAVAILABLE' 
               | 'GIT_BAD_RESPONSE',
    public retryAt?: Date  // 限流时的重试时间
  ) {
    super(code);
  }
}
```

**HTTP 状态码映射**：

| HTTP 状态码 | 错误类型 | 说明 |
|------------|---------|------|
| 401 | `GIT_UNAUTHORIZED` | 令牌无效或已过期 |
| 403 | `GIT_UNAUTHORIZED` / `GIT_RATE_LIMITED` | 根据 `x-ratelimit-remaining` 判断 |
| 404 | `GIT_NOT_FOUND` | 仓库不存在或无权访问 |
| 429 | `GIT_RATE_LIMITED` | API 限流 |
| 其他 | `GIT_UNAVAILABLE` | 平台暂时不可用 |

**限流时间计算**：

优先使用平台返回的重试时间，否则默认 1 分钟后重试，最长不超过 24 小时：

```typescript
function retryDate(headers: Headers, now = Date.now()): Date {
  // Retry-After: 秒数 或 HTTP-date
  const after = headers.get('retry-after');
  // X-RateLimit-Reset: Unix 时间戳（秒）
  const reset = Number(headers.get('x-ratelimit-reset')) * 1000;
  
  const relative = after && /^\d+$/.test(after) 
    ? now + Number(after) * 1000 
    : Date.parse(after ?? '');
  
  return new Date(Math.min(
    now + 86400000,  // 最长 24 小时
    Math.max(
      now + 60000,   // 最短 1 分钟
      Number.isFinite(relative) ? relative : 0,
      Number.isFinite(reset) ? reset : 0
    )
  ));
}
```

### 3.6 安全限制

**响应体大小限制**（防止 DoS）：

```typescript
// 单次请求最大 2MB
const MAX_RESPONSE_SIZE = 2097152;

// 流式读取，超限立即取消
if (Number(response.headers.get('content-length')) > MAX_RESPONSE_SIZE) {
  throw Error('LIMIT');
}

const reader = response.body?.getReader();
const chunks: Uint8Array[] = [];
let size = 0;

try {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    size += value.length;
    if (size > MAX_RESPONSE_SIZE) {
      await reader.cancel();
      throw Error('LIMIT');
    }
    
    chunks.push(value);
  }
} finally {
  reader.releaseLock();
}
```

**超时控制**：

所有请求使用 15 秒超时：

```typescript
fetch(url, {
  signal: AbortSignal.timeout(15000)
});
```

## 4. 业务集成

### 4.1 仓库绑定流程

```
项目负责人/管理员
    │
    ├─ 发送关联命令：关联代码仓 https://github.com/owner/repo
    │
    ├─ 系统解析 URL → RepoRef
    │
    ├─ 探测仓库可见性（public/private）
    │
    ├─ 创建 project_repos 记录
    │     - state: proposed（管理员提交）/ approved（PI 提交）
    │     - visibility: public/private/unknown
    │
    ├─ 如果是私有仓库 → 提示提交访问令牌
    │     - 仓库所有者生成只读 token
    │     - 管理员在网页控制台提交（AES-256-GCM 加密存储）
    │
    ├─ PI 批准（如果是管理员提交）
    │
    └─ 开始增量同步
```

### 4.2 增量同步机制

**时间槽机制**：

```typescript
const SYNC_SLOT_MS = 15 * 60000;  // 15 分钟一个槽
const slot = Math.floor(Date.now() / SYNC_SLOT_MS);
```

每个仓库按槽分配同步时间，避免所有仓库同时请求。

**分页策略**：

- 每页 100 条提交（`PAGE_SIZE = 100`）
- 每次同步最多拉取 5 页（`PAGES_PER_RUN = 5`）
- 历史回填最多 20 页（`MAX_PAGES = 20`），2000 条提交

**增量查询**：

```typescript
// 首次同步：不带 since 参数，从最新提交开始
GET /repos/{owner}/{repo}/commits?per_page=100&page=1

// 增量同步：使用上次成功的最新提交时间
GET /repos/{owner}/{repo}/commits?per_page=100&page=1&since=2024-01-01T00:00:00Z
```

**去重机制**：

使用 `external_id` 唯一标识：

```typescript
const externalId = `git:${repoId}:${commit.sha}`;

// 插入时使用 ON CONFLICT DO NOTHING
INSERT INTO evidence (..., external_id, ...) 
VALUES (..., $externalId, ...) 
ON CONFLICT (kb_id, external_id) DO NOTHING;
```

### 4.3 证据生成

每个提交转化为一条"证据"记录：

```typescript
export function renderCommit(ref: RepoRef, c: Commit): string {
  const when = new Date(c.time).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false
  });
  
  return `Git 提交 [${repoLabel(ref)}] ${c.sha.slice(0, 10)}｜作者 ${c.author || '未知'}｜${when}
${c.message.trim() || '（无提交说明）'}`.slice(0, 5000);
}

// 示例输出：
// Git 提交 [GitHub owner/repo@main] a1b2c3d4e5｜作者 张三｜2024-01-15 14:30:00
// feat: add user authentication module
```

**数据流向**：

```
Commit (API 响应)
    │
    ├─ normalizeCommit() → 标准化 Commit 对象
    │
    ├─ renderCommit() → 生成证据文本
    │
    ├─ 插入 evidence 表
    │     - type: 'git_commit'
    │     - external_id: 'git:{repoId}:{sha}'
    │     - text: 渲染后的文本
    │     - source_id: 引用 source_bindings.id
    │
    └─ Worker 异步处理
          - Kairos 提取记忆候选
          - 生成确认卡片
          - 用户确认后转为正式记忆
```

### 4.4 README 同步

README 作为特殊证据处理：

```typescript
export function renderReadme(ref: RepoRef, r: Readme): string {
  return `README 更新 [${repoLabel(ref)}] 版本 ${r.sha.slice(0, 10)}
${r.text.trim().slice(0, 4000)}`;
}

// external_id 格式：git:{repoId}:readme:{sha}
const externalId = `git:${repoId}:readme:${readme.sha}`;
```

**更新检测**：

数据库存储 `readme_sha` 字段，每次同步时比较：

```typescript
if (currentReadmeSha !== storedReadmeSha) {
  // 创建新的 README 证据
  // 旧的 README 证据保留（体现文档演进历史）
}
```

## 5. 数据库设计

### 5.1 核心表结构

**project_repos**（仓库绑定）：

```sql
CREATE TABLE project_repos (
  id UUID PRIMARY KEY,
  space_id UUID NOT NULL,
  project_id UUID NOT NULL REFERENCES projects(id),
  
  -- 仓库标识
  platform TEXT NOT NULL CHECK (platform IN ('github', 'gitcode')),
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,           -- 空字符串表示默认分支
  path_scope TEXT NOT NULL,       -- 空字符串表示根目录
  
  -- 可见性和状态
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private', 'unknown')),
  state TEXT NOT NULL CHECK (state IN ('proposed', 'needs_authorization', 'approved', 'failed', 'revoked')),
  
  -- 审批记录
  proposed_by TEXT NOT NULL,      -- open_id
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  
  -- 访问令牌（AES-256-GCM 加密）
  token_sealed TEXT,
  token_set_at TIMESTAMPTZ,
  
  -- 关联的数据源
  source_id UUID REFERENCES source_bindings(id),
  
  -- 同步状态
  cursor_time TIMESTAMPTZ,        -- 最新提交时间（用于增量查询）
  backfill_page INT NOT NULL DEFAULT 1,
  backfilled BOOLEAN NOT NULL DEFAULT FALSE,
  backfill_capped BOOLEAN NOT NULL DEFAULT FALSE,
  readme_sha TEXT,
  synced_commits INT NOT NULL DEFAULT 0,
  
  -- 错误追踪
  last_success_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  last_error TEXT,
  attempts INT NOT NULL DEFAULT 0,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- 唯一约束：同一项目不允许重复绑定相同的仓库+分支+路径
  UNIQUE (project_id, platform, owner, repo, branch, path_scope)
);
```

**evidence**（证据）：

```sql
CREATE TABLE evidence (
  id UUID PRIMARY KEY,
  kb_id UUID NOT NULL REFERENCES knowledge_bases(id),
  type TEXT NOT NULL,              -- 'git_commit', 'git_readme', ...
  external_id TEXT NOT NULL,       -- 'git:{repoId}:{sha}'
  source_id UUID REFERENCES source_bindings(id),
  text TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- 唯一约束：同一知识库内 external_id 不重复
  UNIQUE (kb_id, external_id)
);
```

### 5.2 数据隔离

**行级安全（RLS）**：

```sql
-- 只能访问自己作为成员的租户的数据
CREATE POLICY project_repos_isolation ON project_repos
  USING (space_id IN (
    SELECT space_id FROM tenant_members 
    WHERE open_id = current_setting('app.actor_open_id')
  ));

-- 证据继承知识库的访问控制
CREATE POLICY evidence_isolation ON evidence
  USING (kb_id IN (
    SELECT id FROM knowledge_bases 
    WHERE /* 用户有权访问 */
  ));
```

**source_bindings 撤销**：

当 `source_bindings` 被撤销（逻辑删除）时，所有关联的 evidence 自动隐藏（RLS 策略实现），确保数据源权限的即时生效。

## 6. 扩展性设计

### 6.1 当前限制

目前实现为**只读元数据集成**，仅支持：

- ✅ 提交历史（SHA、作者、时间、message）
- ✅ README 文件内容
- ✅ 仓库可见性探测

**不支持**：

- ❌ 克隆完整代码
- ❌ 获取任意文件内容
- ❌ 提取 commit diff
- ❌ 下载代码归档（tarball/zipball）
- ❌ 任何写操作（push、PR、issue）

### 6.2 扩展方向

如果需要扩展到代码内容同步，可以添加以下方法：

```typescript
export interface GitApi {
  // ... 现有方法
  
  // 获取单个文件内容
  getFile(ref: RepoRef, path: string, token?: string): Promise<{
    sha: string;
    content: string;  // Base64 或纯文本
    encoding: 'base64' | 'utf8';
    size: number;
  } | null>;
  
  // 获取目录树
  getTree(ref: RepoRef, path: string, options: {
    token?: string;
    recursive?: boolean;
  }): Promise<Array<{
    path: string;
    mode: string;
    type: 'blob' | 'tree';
    sha: string;
    size: number;
  }>>;
  
  // 获取 commit diff
  getDiff(ref: RepoRef, sha: string, token?: string): Promise<{
    files: Array<{
      filename: string;
      status: 'added' | 'modified' | 'removed';
      additions: number;
      deletions: number;
      patch: string;  // unified diff 格式
    }>;
  }>;
  
  // 下载代码归档
  getArchive(ref: RepoRef, options: {
    token?: string;
    format: 'tarball' | 'zipball';
  }): Promise<Blob>;
}
```

**API 端点参考**：

| 功能 | GitHub API | GitCode API |
|------|-----------|-------------|
| 文件内容 | `GET /repos/{owner}/{repo}/contents/{path}` | 同左 |
| 目录树 | `GET /repos/{owner}/{repo}/git/trees/{tree_sha}?recursive=1` | `GET /repos/{owner}/{repo}/git/trees/{sha}` |
| Commit diff | `GET /repos/{owner}/{repo}/commits/{ref}` | 同左 |
| 归档下载 | `GET /repos/{owner}/{repo}/tarball/{ref}` | `GET /repos/{owner}/{repo}/archive/{ref}.zip` |

### 6.3 新平台接入

接入 GitLab、Gitee 等平台的步骤：

1. **扩展 Platform 类型**：

```typescript
export type Platform = 'github' | 'gitcode' | 'gitlab' | 'gitee';
```

2. **添加域名映射**：

```typescript
const HOSTS: Record<string, Platform> = {
  'github.com': 'github',
  'gitcode.com': 'gitcode',
  'gitlab.com': 'gitlab',
  'gitee.com': 'gitee',
};
```

3. **配置 API 端点**：

```typescript
const API: Record<Platform, string> = {
  github: 'https://api.github.com',
  gitcode: 'https://api.gitcode.com/api/v5',
  gitlab: 'https://gitlab.com/api/v4',
  gitee: 'https://gitee.com/api/v5',
};
```

4. **适配请求头**：

```typescript
if (platform === 'gitlab') {
  headers['PRIVATE-TOKEN'] = token;  // GitLab 使用不同的认证方式
}
```

5. **调整响应标准化逻辑**（如果 API 结构有差异）

## 7. 监控与运维

### 7.1 同步状态监控

通过 `project_repos` 表字段监控：

```sql
-- 查看所有仓库的同步状态
SELECT 
  id,
  platform,
  owner || '/' || repo AS repo,
  state,
  synced_commits,
  last_success_at,
  last_error
FROM project_repos
WHERE state NOT IN ('revoked')
ORDER BY last_attempt_at DESC;
```

**关键指标**：

- `synced_commits`: 已同步提交数（持续增长表示正常）
- `last_success_at`: 最近成功时间（超过 1 小时未更新需关注）
- `last_error`: 最近错误类型
- `attempts`: 连续失败次数（超过 5 次需人工介入）

### 7.2 常见问题排查

| 错误类型 | 可能原因 | 解决方案 |
|---------|---------|---------|
| `GIT_UNAUTHORIZED` | 令牌过期或权限不足 | 重新生成令牌并提交 |
| `GIT_NOT_FOUND` | 仓库被删除或分支不存在 | 检查仓库状态，考虑解除绑定 |
| `GIT_RATE_LIMITED` | API 调用频率超限 | 等待 `retryAt` 时间后自动重试 |
| `GIT_UNAVAILABLE` | 平台暂时不可用 | 自动重试，持续失败需检查网络 |
| `GIT_BAD_RESPONSE` | 响应格式异常 | 可能是平台 API 变更，需更新代码 |

### 7.3 性能优化

**批量操作**：

```typescript
// 批量插入证据，使用 unnest 和 ON CONFLICT
INSERT INTO evidence (id, kb_id, type, external_id, source_id, text, occurred_at)
SELECT * FROM UNNEST(
  $1::uuid[],
  $2::uuid[],
  $3::text[],
  $4::text[],
  $5::uuid[],
  $6::text[],
  $7::timestamptz[]
)
ON CONFLICT (kb_id, external_id) DO NOTHING;
```

**连接池复用**：

每个租户使用独立的数据库连接池（最多缓存 16 个租户），LRU 淘汰策略。

**并发控制**：

Worker 使用 `outbox` 表的租约机制，避免多实例重复处理：

```sql
UPDATE outbox 
SET state = 'processing', lease_until = NOW() + INTERVAL '5 minutes'
WHERE id = $1 AND state = 'pending';
```

## 8. 安全最佳实践

### 8.1 令牌管理

**生成建议**：

- GitHub: 使用 Fine-grained Personal Access Token，只授予 `contents:read` 和 `metadata:read` 权限
- GitCode: 使用只读访问令牌

**存储安全**：

```typescript
// AES-256-GCM 加密存储
import { sealText, unsealText } from './connection-config.js';

const sealed = sealText(token, encryptionKey);
await db.query('UPDATE project_repos SET token_sealed = $1 WHERE id = $2', [sealed, repoId]);

// 使用时解密
const token = unsealText(row.token_sealed, encryptionKey);
```

**轮换策略**：

建议每 90 天轮换一次访问令牌，系统在令牌即将过期时提醒管理员。

### 8.2 审计日志

所有仓库操作记录到审计日志：

```typescript
await audit(db, {
  actor: actorOpenId,
  action: 'repo.proposed',  // repo.approved, repo.revoked, repo.token_set
  target_type: 'project',
  target_id: projectId,
  metadata: {
    repoId,
    repo: repoLabel(ref),
    visibility,
  },
  request_id: requestId,
});
```

### 8.3 限流保护

**本地限流**：

防止单个项目关联过多仓库：

```typescript
const MAX_REPOS_PER_PROJECT = 20;

const count = await db.query(
  'SELECT COUNT(*) FROM project_repos WHERE project_id = $1 AND state != $2',
  [projectId, 'revoked']
);

if (count.rows[0].count >= MAX_REPOS_PER_PROJECT) {
  throw new Error('REPO_LIMIT_EXCEEDED');
}
```

**平台限流应对**：

- GitHub: 5000 次/小时（认证）或 60 次/小时（未认证）
- GitCode: 参考平台文档

系统自动识别 429 响应，计算重试时间并暂停该仓库的同步。

## 9. 测试策略

### 9.1 单元测试

```typescript
import { describe, test, expect } from 'vitest';
import { parseRepoUrl, normalizeCommit } from './git-source.js';

describe('parseRepoUrl', () => {
  test('解析标准 GitHub URL', () => {
    const result = parseRepoUrl('https://github.com/owner/repo');
    expect(result).toEqual({
      platform: 'github',
      owner: 'owner',
      repo: 'repo',
      branch: '',
      path: '',
    });
  });
  
  test('拒绝非 HTTPS URL', () => {
    expect(parseRepoUrl('http://github.com/owner/repo')).toBeNull();
  });
  
  test('拒绝包含凭据的 URL', () => {
    expect(parseRepoUrl('https://user:pass@github.com/owner/repo')).toBeNull();
  });
});

describe('normalizeCommit', () => {
  test('标准化 GitHub API 响应', () => {
    const apiResponse = {
      sha: 'a1b2c3d4e5f6',
      commit: {
        author: { name: '张三', date: '2024-01-15T06:30:00Z' },
        message: 'feat: add feature',
      },
      html_url: 'https://github.com/owner/repo/commit/a1b2c3d4e5f6',
    };
    
    const result = normalizeCommit(apiResponse);
    expect(result).toEqual({
      sha: 'a1b2c3d4e5f6',
      author: '张三',
      time: '2024-01-15T06:30:00.000Z',
      message: 'feat: add feature',
      url: 'https://github.com/owner/repo/commit/a1b2c3d4e5f6',
    });
  });
  
  test('拒绝无效的 SHA', () => {
    expect(normalizeCommit({ sha: 'invalid' })).toBeNull();
  });
});
```

### 9.2 集成测试

使用 Mock 服务器模拟平台 API：

```typescript
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

const server = setupServer(
  http.get('https://api.github.com/repos/:owner/:repo/commits', ({ params }) => {
    return HttpResponse.json([
      {
        sha: 'abc123',
        commit: {
          author: { name: 'Test', date: '2024-01-01T00:00:00Z' },
          message: 'test commit',
        },
        html_url: `https://github.com/${params.owner}/${params.repo}/commit/abc123`,
      },
    ]);
  })
);

describe('Git API 集成', () => {
  beforeAll(() => server.listen());
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
  
  test('拉取提交历史', async () => {
    const commits = await defaultGitApi.commits(
      { platform: 'github', owner: 'test', repo: 'repo', branch: '', path: '' },
      { page: 1, perPage: 100 }
    );
    
    expect(commits).toHaveLength(1);
    expect(commits[0].sha).toBe('abc123');
  });
});
```

### 9.3 端到端测试

使用 testcontainers 启动真实 PostgreSQL：

```typescript
import { PostgreSqlContainer } from '@testcontainers/postgresql';

describe('仓库同步端到端测试', () => {
  let container: StartedPostgreSqlContainer;
  let db: PrismaClient;
  
  beforeAll(async () => {
    container = await new PostgreSqlContainer().start();
    db = new PrismaClient({
      datasources: { db: { url: container.getConnectionUri() } },
    });
    // 运行迁移...
  });
  
  afterAll(async () => {
    await db.$disconnect();
    await container.stop();
  });
  
  test('完整同步流程', async () => {
    // 1. 创建项目和仓库绑定
    // 2. 触发同步
    // 3. 验证证据已创建
    // 4. 验证增量同步不重复
  });
});
```

## 10. 总结

本方案通过**统一抽象 + 直接 HTTP 请求**的方式，实现了对 GitHub 和 GitCode 的轻量级只读集成，具有以下特点：

**优势**：
- ✅ 统一接口屏蔽平台差异
- ✅ 安全边界清晰，防护到位
- ✅ 增量同步效率高
- ✅ 错误处理完善
- ✅ 易于扩展新平台

**权衡**：
- ⚖️ 只支持元数据，不支持完整代码拉取（按需扩展）
- ⚖️ 依赖平台 API 稳定性（限流、变更）
- ⚖️ 历史回填有上限（2000 条提交）

**适用场景**：
- 项目活动追踪
- 提交历史存档
- 知识库自动构建
- 开发进度可视化

对于需要完整代码分析的场景，建议在此基础上扩展文件内容和 diff 获取能力。
