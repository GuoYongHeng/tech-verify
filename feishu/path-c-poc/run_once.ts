/**
 * Path C feasibility POC: one tick of chats/search → diff → me_join.
 * Follows ../飞书公开群search与me_join自动入群-技术方案.md
 * Does NOT use members.create self-pull, empty query, or ProjectMember writes.
 */

import * as lark from "@larksuiteoapi/node-sdk";

type ChatItem = {
  chat_id?: string;
  name?: string;
};

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") {
    console.error(`missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}

function parseArgs(argv: string[]) {
  return {
    dryRun: argv.includes("--dry-run"),
    confirmPublic: argv.includes("--confirm-public"),
  };
}

async function collectPages(
  iteratorFactory: () => Promise<AsyncIterable<unknown>>,
): Promise<ChatItem[]> {
  const items: ChatItem[] = [];
  const iterable = await iteratorFactory();
  for await (const page of iterable) {
    if (!page || typeof page !== "object") continue;
    const batch = (page as { items?: ChatItem[] }).items ?? [];
    items.push(...batch);
  }
  return items;
}

async function main(): Promise<void> {
  const { dryRun, confirmPublic } = parseArgs(process.argv.slice(2));

  const appId = env("FEISHU_APP_ID");
  const appSecret = env("FEISHU_APP_SECRET");
  const query = env("FEISHU_AUTO_JOIN_QUERY");
  const allowReS = env("FEISHU_AUTO_JOIN_NAME_ALLOW_REGEX");
  const maxJoins = Number(process.env.FEISHU_AUTO_JOIN_MAX_JOINS ?? "3");
  const deny = new Set(
    (process.env.FEISHU_AUTO_JOIN_CHAT_ID_DENY ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  if (!query.trim()) {
    console.error("query must be non-empty (Feishu returns empty list otherwise)");
    process.exit(1);
  }
  if (query.length > 64) {
    console.error("query must be <= 64 chars");
    process.exit(1);
  }

  let allowRe: RegExp;
  try {
    allowRe = new RegExp(allowReS);
  } catch (e) {
    console.error(`invalid FEISHU_AUTO_JOIN_NAME_ALLOW_REGEX: ${e}`);
    process.exit(1);
  }

  const client = new lark.Client({
    appId,
    appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Feishu,
  });

  console.log(
    `client ok; query=${JSON.stringify(query)} allow=${JSON.stringify(allowReS)} max_joins=${maxJoins}`,
  );

  // GET /im/v1/chats/search — never empty query
  const hits = await collectPages(() =>
    client.im.chat.searchWithIterator({
      params: { query, page_size: 100 },
    }),
  );

  // GET /im/v1/chats — bot already joined
  const joined = await collectPages(() =>
    client.im.chat.listWithIterator({
      params: { page_size: 100 },
    }),
  );
  const joinedIds = new Set(
    joined.map((c) => c.chat_id).filter((id): id is string => Boolean(id)),
  );

  console.log(`search_hits=${hits.length} already_joined=${joinedIds.size}`);

  const candidates: ChatItem[] = [];
  for (const chat of hits) {
    const cid = chat.chat_id;
    const name = chat.name ?? "";
    if (!cid) continue;
    if (joinedIds.has(cid)) continue;
    if (deny.has(cid)) {
      console.log(`skip deny: ${cid} ${JSON.stringify(name)}`);
      continue;
    }
    if (!allowRe.test(name)) {
      console.log(`skip nameAllowRegex: ${cid} ${JSON.stringify(name)}`);
      continue;
    }
    candidates.push(chat);
  }

  console.log(`diff_after_filter=${candidates.length}`);
  for (const chat of candidates) {
    console.log(`  candidate: ${chat.chat_id} ${JSON.stringify(chat.name ?? "")}`);
  }

  if (dryRun) {
    console.log("dry-run: stop before me_join");
    return;
  }

  let joinedOk = 0;
  for (const chat of candidates) {
    if (joinedOk >= maxJoins) {
      console.log(`maxJoinsPerTick=${maxJoins} reached; stop`);
      break;
    }
    const cid = chat.chat_id!;
    const name = chat.name ?? "";

    if (confirmPublic) {
      const info = await client.im.chat.get({ path: { chat_id: cid } });
      if (info.code !== 0) {
        console.log(`skip get chat: ${cid} -> code=${info.code} msg=${info.msg}`);
        continue;
      }
      const ctype = (info.data as { chat_type?: string } | undefined)?.chat_type;
      if (ctype !== "public") {
        console.log(`skip non-public chat_type=${JSON.stringify(ctype)}: ${cid} ${JSON.stringify(name)}`);
        continue;
      }
    }

    // Path C: voluntary join only — never chatMembers.create to self-pull.
    const out = await client.im.chatMembers.meJoin({
      path: { chat_id: cid },
    });
    if (out.code === 0) {
      joinedOk += 1;
      console.log(`me_join ok: ${cid} ${JSON.stringify(name)}`);
    } else {
      // common Path C codes: 232075 approval, 232008 type, 232013 full, 232006 bad id
      console.log(
        `me_join fail code=${out.code}: ${cid} ${JSON.stringify(name)} msg=${out.msg}`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
