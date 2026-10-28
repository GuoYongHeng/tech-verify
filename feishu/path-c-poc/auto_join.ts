/**
 * Path C one-tick: chats/search → diff → me_join (REST Client).
 * Follows ../飞书公开群search与me_join自动入群-技术方案.md
 */

import * as lark from "@larksuiteoapi/node-sdk";

export type ChatItem = {
  chat_id?: string;
  name?: string;
};

export type AutoJoinOptions = {
  client: lark.Client;
  query: string;
  nameAllowRegex: RegExp;
  maxJoins: number;
  denyChatIds: Set<string>;
  dryRun?: boolean;
  confirmPublic?: boolean;
};

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

/** One Path-C tick over OpenAPI (not events). */
export async function runAutoJoinTick(opts: AutoJoinOptions): Promise<void> {
  const {
    client,
    query,
    nameAllowRegex: allowRe,
    maxJoins,
    denyChatIds: deny,
    dryRun = false,
    confirmPublic = false,
  } = opts;

  if (!query.trim()) {
    throw new Error("query must be non-empty (Feishu returns empty list otherwise)");
  }
  if (query.length > 64) {
    throw new Error("query must be <= 64 chars");
  }

  console.log(
    `[auto-join] tick start query=${JSON.stringify(query)} allow=${allowRe} max_joins=${maxJoins}`,
  );

  const hits = await collectPages(() =>
    client.im.chat.searchWithIterator({
      params: { query, page_size: 100 },
    }),
  );

  const joined = await collectPages(() =>
    client.im.chat.listWithIterator({
      params: { page_size: 100 },
    }),
  );
  const joinedIds = new Set(
    joined.map((c) => c.chat_id).filter((id): id is string => Boolean(id)),
  );

  console.log(`[auto-join] search_hits=${hits.length} already_joined=${joinedIds.size}`);

  const candidates: ChatItem[] = [];
  for (const chat of hits) {
    const cid = chat.chat_id;
    const name = chat.name ?? "";
    if (!cid) continue;
    if (joinedIds.has(cid)) continue;
    if (deny.has(cid)) {
      console.log(`[auto-join] skip deny: ${cid} ${JSON.stringify(name)}`);
      continue;
    }
    if (!allowRe.test(name)) {
      console.log(`[auto-join] skip nameAllowRegex: ${cid} ${JSON.stringify(name)}`);
      continue;
    }
    candidates.push(chat);
  }

  console.log(`[auto-join] diff_after_filter=${candidates.length}`);
  for (const chat of candidates) {
    console.log(
      `[auto-join]   candidate: ${chat.chat_id} ${JSON.stringify(chat.name ?? "")}`,
    );
  }

  if (dryRun) {
    console.log("[auto-join] dry-run: stop before me_join");
    return;
  }

  let joinedOk = 0;
  for (const chat of candidates) {
    if (joinedOk >= maxJoins) {
      console.log(`[auto-join] maxJoinsPerTick=${maxJoins} reached; stop`);
      break;
    }
    const cid = chat.chat_id!;
    const name = chat.name ?? "";

    if (confirmPublic) {
      const info = await client.im.chat.get({ path: { chat_id: cid } });
      if (info.code !== 0) {
        console.log(
          `[auto-join] skip get chat: ${cid} -> code=${info.code} msg=${info.msg}`,
        );
        continue;
      }
      const ctype = (info.data as { chat_type?: string } | undefined)?.chat_type;
      if (ctype !== "public") {
        console.log(
          `[auto-join] skip non-public chat_type=${JSON.stringify(ctype)}: ${cid} ${JSON.stringify(name)}`,
        );
        continue;
      }
    }

    // Path C: voluntary join only — never chatMembers.create to self-pull.
    const out = await client.im.chatMembers.meJoin({
      path: { chat_id: cid },
    });
    if (out.code === 0) {
      joinedOk += 1;
      console.log(`[auto-join] me_join ok: ${cid} ${JSON.stringify(name)}`);
    } else {
      console.log(
        `[auto-join] me_join fail code=${out.code}: ${cid} ${JSON.stringify(name)} msg=${out.msg}`,
      );
    }
  }

  console.log(`[auto-join] tick done me_join_ok=${joinedOk}`);
}
