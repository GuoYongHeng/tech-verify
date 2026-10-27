/**
 * Minimal GitApi + URL safety from git-integration-design.md.
 * Native fetch only — no platform SDKs, no DB.
 */

export type Platform = "github" | "gitcode";

export type RepoRef = {
  platform: Platform;
  owner: string;
  repo: string;
  branch: string;
  path: string;
};

export type Commit = {
  sha: string;
  author: string;
  time: string;
  message: string;
  url: string;
};

export type Readme = {
  sha: string;
  text: string;
};

export type GitErrorCode =
  | "GIT_UNAUTHORIZED"
  | "GIT_NOT_FOUND"
  | "GIT_RATE_LIMITED"
  | "GIT_UNAVAILABLE"
  | "GIT_BAD_RESPONSE";

export class GitError extends Error {
  constructor(
    public code: GitErrorCode,
    public retryAt?: Date,
  ) {
    super(code);
    this.name = "GitError";
  }
}

const HOSTS: Record<string, Platform> = {
  "github.com": "github",
  "www.github.com": "github",
  "gitcode.com": "gitcode",
  "www.gitcode.com": "gitcode",
};

const API: Record<Platform, string> = {
  github: "https://api.github.com",
  gitcode: "https://api.gitcode.com/api/v5",
};

const MAX_RESPONSE_SIZE = 2_097_152;
const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9._/\-]+$/;

/** Strict URL → RepoRef; null if unsafe / unsupported. */
export function parseRepoUrl(raw: string): RepoRef | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== "443") return null;

  const platform = HOSTS[u.hostname.toLowerCase()];
  if (!platform) return null;

  const parts = u.pathname.replace(/\.git$/i, "").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1];
  if (!NAME_RE.test(owner) || !NAME_RE.test(repo)) return null;

  let branch = "";
  let path = "";
  // /owner/repo/tree/<branch>/...
  if (parts[2] === "tree" && parts[3]) {
    branch = parts[3];
    path = parts.slice(4).join("/");
    if (!BRANCH_RE.test(branch) || branch.includes("..")) return null;
    if (path.includes("..")) return null;
  }

  return { platform, owner, repo, branch, path };
}

export function repoLabel(ref: RepoRef): string {
  const plat = ref.platform === "github" ? "GitHub" : "GitCode";
  const br = ref.branch ? `@${ref.branch}` : "";
  const p = ref.path ? `:${ref.path}` : "";
  return `${plat} ${ref.owner}/${ref.repo}${br}${p}`;
}

export function normalizeCommit(x: unknown): Commit | null {
  if (!x || typeof x !== "object") return null;
  const row = x as Record<string, unknown>;
  const sha = typeof row.sha === "string" ? row.sha : "";
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) return null;

  const c = (row.commit ?? {}) as Record<string, unknown>;
  const a = (c.author ?? c.committer ?? {}) as Record<string, unknown>;
  const committer = (c.committer ?? {}) as Record<string, unknown>;
  const time = new Date(
    String(a.date ?? committer.date ?? ""),
  );
  if (Number.isNaN(time.getTime())) return null;

  const authorLogin =
    row.author && typeof row.author === "object"
      ? String(
          (row.author as Record<string, unknown>).login ??
            (row.author as Record<string, unknown>).name ??
            "",
        )
      : "";
  const author = String(a.name ?? authorLogin)
    .slice(0, 120);

  const html =
    typeof row.html_url === "string" && row.html_url.startsWith("https://")
      ? row.html_url.slice(0, 500)
      : "";

  return {
    sha: sha.toLowerCase(),
    author,
    time: time.toISOString(),
    message: String(c.message ?? "").slice(0, 4000),
    url: html,
  };
}

export function renderCommit(ref: RepoRef, c: Commit): string {
  const when = new Date(c.time).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
  return `Git 提交 [${repoLabel(ref)}] ${c.sha.slice(0, 10)}｜作者 ${c.author || "未知"}｜${when}
${c.message.trim() || "（无提交说明）"}`.slice(0, 5000);
}

export function renderReadme(ref: RepoRef, r: Readme): string {
  return `README 更新 [${repoLabel(ref)}] 版本 ${r.sha.slice(0, 10)}
${r.text.trim().slice(0, 4000)}`;
}

function retryDate(headers: Headers, now = Date.now()): Date {
  const after = headers.get("retry-after");
  const reset = Number(headers.get("x-ratelimit-reset")) * 1000;
  const relative =
    after && /^\d+$/.test(after)
      ? now + Number(after) * 1000
      : Date.parse(after ?? "");
  return new Date(
    Math.min(
      now + 86_400_000,
      Math.max(
        now + 60_000,
        Number.isFinite(relative) ? relative : 0,
        Number.isFinite(reset) ? reset : 0,
      ),
    ),
  );
}

async function readBodyLimited(response: Response): Promise<string> {
  const cl = Number(response.headers.get("content-length"));
  if (Number.isFinite(cl) && cl > MAX_RESPONSE_SIZE) {
    throw new GitError("GIT_BAD_RESPONSE");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.length;
      if (size > MAX_RESPONSE_SIZE) {
        await reader.cancel();
        throw new GitError("GIT_BAD_RESPONSE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }
  return new TextDecoder("utf-8").decode(merged);
}

async function request(
  platform: Platform,
  path: string,
  token?: string,
): Promise<unknown> {
  const headers: Record<string, string> = {
    accept:
      platform === "github" ? "application/vnd.github+json" : "application/json",
    "user-agent": "InnoCoworkerSaaS-git-sync-demo",
  };
  if (platform === "github") {
    headers["x-github-api-version"] = "2022-11-28";
  }
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(API[platform] + path, {
      headers,
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
  } catch {
    throw new GitError("GIT_UNAVAILABLE");
  }

  if (response.status === 401) {
    throw new GitError("GIT_UNAUTHORIZED");
  }
  if (response.status === 404) {
    throw new GitError("GIT_NOT_FOUND");
  }
  if (response.status === 429) {
    throw new GitError("GIT_RATE_LIMITED", retryDate(response.headers));
  }
  if (response.status === 403) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    if (remaining === "0") {
      throw new GitError("GIT_RATE_LIMITED", retryDate(response.headers));
    }
    throw new GitError("GIT_UNAUTHORIZED");
  }
  if (!response.ok) {
    throw new GitError("GIT_UNAVAILABLE");
  }

  const text = await readBodyLimited(response);
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GitError("GIT_BAD_RESPONSE");
  }
}

function commitsQuery(ref: RepoRef, options: {
  since?: string;
  page: number;
  perPage: number;
}): string {
  const q = new URLSearchParams();
  q.set("page", String(options.page));
  q.set("per_page", String(options.perPage));
  if (ref.branch) q.set("sha", ref.branch);
  if (ref.path) q.set("path", ref.path);
  if (options.since) q.set("since", options.since);
  return q.toString();
}

export const defaultGitApi = {
  async probe(ref: RepoRef, token?: string): Promise<"public" | "private"> {
    const q = commitsQuery(ref, { page: 1, perPage: 1 });
    const path = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/commits?${q}`;
    try {
      await request(ref.platform, path, undefined);
      return "public";
    } catch (e) {
      if (
        !(e instanceof GitError) ||
        (e.code !== "GIT_NOT_FOUND" && e.code !== "GIT_UNAUTHORIZED")
      ) {
        throw e;
      }
      if (!token) throw e;
      await request(ref.platform, path, token);
      return "private";
    }
  },

  async commits(
    ref: RepoRef,
    options: {
      token?: string;
      since?: string;
      page: number;
      perPage: number;
    },
  ): Promise<Commit[]> {
    const q = commitsQuery(ref, options);
    const raw = await request(
      ref.platform,
      `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/commits?${q}`,
      options.token,
    );
    if (!Array.isArray(raw)) throw new GitError("GIT_BAD_RESPONSE");
    return raw
      .map(normalizeCommit)
      .filter((c): c is Commit => c !== null);
  },

  async readme(ref: RepoRef, token?: string): Promise<Readme | null> {
    const q = new URLSearchParams();
    if (ref.branch) q.set("ref", ref.branch);
    const suffix = q.toString() ? `?${q}` : "";
    let raw: unknown;
    try {
      raw = await request(
        ref.platform,
        `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/readme${suffix}`,
        token,
      );
    } catch (e) {
      if (e instanceof GitError && e.code === "GIT_NOT_FOUND") return null;
      throw e;
    }
    if (!raw || typeof raw !== "object") return null;
    const row = raw as Record<string, unknown>;
    const sha = typeof row.sha === "string" ? row.sha : "";
    if (!sha) return null;
    let text = "";
    if (typeof row.content === "string") {
      const enc = row.encoding === "base64" || !row.encoding ? "base64" : String(row.encoding);
      if (enc === "base64") {
        text = Buffer.from(row.content.replace(/\n/g, ""), "base64").toString("utf8");
      } else {
        text = row.content;
      }
    }
    return { sha: sha.toLowerCase(), text };
  },
};

export type GitApi = typeof defaultGitApi;
