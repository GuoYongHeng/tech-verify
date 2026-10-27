/**
 * One-shot feasibility demo: parse URL → probe → commits (+ optional since) → README
 * → log “evidence” lines. No DB / no persistence — cursor is env-only.
 */

import {
  defaultGitApi,
  GitError,
  parseRepoUrl,
  renderCommit,
  renderReadme,
  type Commit,
  type RepoRef,
} from "./git-source.js";

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name] ?? fallback;
  return v === "" ? undefined : v;
}

function log(section: string, msg: string, extra?: unknown): void {
  const line = extra === undefined ? msg : `${msg} ${JSON.stringify(extra)}`;
  console.log(`[${section}] ${line}`);
}

async function main(): Promise<void> {
  const url = env("GIT_REPO_URL");
  if (!url) {
    console.error("missing GIT_REPO_URL (e.g. https://github.com/owner/repo)");
    process.exit(1);
  }

  const token = env("GIT_TOKEN");
  const since = env("GIT_SINCE");
  const perPage = Number(env("GIT_PER_PAGE", "5"));
  const maxPages = Number(env("GIT_MAX_PAGES", "1"));
  const branchOverride = env("GIT_BRANCH");
  const pathOverride = env("GIT_PATH");

  const parsed = parseRepoUrl(url);
  if (!parsed) {
    console.error(
      "invalid / unsafe repo URL (need https://github.com|gitcode.com/owner/repo, no credentials/ports/SSRF hosts)",
    );
    process.exit(1);
  }

  const ref: RepoRef = {
    ...parsed,
    branch: branchOverride ?? parsed.branch,
    path: pathOverride ?? parsed.path,
  };

  log("bind", "parsed RepoRef", ref);

  // --- probe visibility (no DB row) ---
  let visibility: "public" | "private" | "unknown" = "unknown";
  try {
    visibility = await defaultGitApi.probe(ref, token);
    log("probe", `visibility=${visibility}`);
  } catch (e) {
    if (e instanceof GitError) {
      log("probe", `failed code=${e.code}${e.retryAt ? ` retryAt=${e.retryAt.toISOString()}` : ""}`);
      if (e.code === "GIT_NOT_FOUND" || e.code === "GIT_UNAUTHORIZED") {
        console.error("cannot reach repo — check URL / token (private repos need GIT_TOKEN)");
        process.exit(1);
      }
      throw e;
    }
    throw e;
  }

  // --- commits (incremental via GIT_SINCE; dedupe in-memory for this run) ---
  const seen = new Set<string>();
  let newest: string | undefined;
  let pageCommits = 0;

  for (let page = 1; page <= maxPages; page++) {
    let batch: Commit[];
    try {
      batch = await defaultGitApi.commits(ref, {
        token,
        since,
        page,
        perPage,
      });
    } catch (e) {
      if (e instanceof GitError) {
        log("commits", `page=${page} error=${e.code}`);
        process.exit(1);
      }
      throw e;
    }

    log("commits", `page=${page} count=${batch.length} since=${since ?? "(none)"}`);
    if (batch.length === 0) break;

    for (const c of batch) {
      const externalId = `git:demo:${c.sha}`;
      if (seen.has(externalId)) {
        log("evidence", `skip duplicate ${externalId}`);
        continue;
      }
      seen.add(externalId);
      pageCommits += 1;
      if (!newest || c.time > newest) newest = c.time;

      const text = renderCommit(ref, c);
      // “persist” = log only (no DB)
      log("evidence", `type=git_commit external_id=${externalId}`);
      console.log("---");
      console.log(text);
      console.log("---");
    }

    if (batch.length < perPage) break;
  }

  // --- README ---
  try {
    const readme = await defaultGitApi.readme(ref, token);
    if (!readme) {
      log("readme", "none");
    } else {
      const externalId = `git:demo:readme:${readme.sha}`;
      log("evidence", `type=git_readme external_id=${externalId}`);
      console.log("---");
      console.log(renderReadme(ref, readme).slice(0, 800) + (readme.text.length > 400 ? "…" : ""));
      console.log("---");
    }
  } catch (e) {
    if (e instanceof GitError) {
      log("readme", `error=${e.code}`);
    } else {
      throw e;
    }
  }

  log("summary", "sync tick done (log-only, no DB)", {
    visibility,
    commitsLogged: pageCommits,
    suggestedNextSince: newest ?? since ?? null,
    hint: newest
      ? `re-run with GIT_SINCE=${newest} to demo incremental empty/partial pull`
      : null,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
