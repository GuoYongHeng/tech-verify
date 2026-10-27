/**
 * Path C POC long-running process:
 * - WSClient + EventDispatcher: receive im.chat.member.bot.added_v1 (outbound long connection)
 * - Client REST: Path-C search + me_join ticks
 * No webhook HTTP server.
 */

import * as lark from "@larksuiteoapi/node-sdk";
import { runAutoJoinTick } from "./auto_join.js";

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
    skipJoinOnStart: argv.includes("--skip-join-on-start"),
  };
}

async function main(): Promise<void> {
  const { dryRun, confirmPublic, skipJoinOnStart } = parseArgs(process.argv.slice(2));

  const appId = env("FEISHU_APP_ID");
  const appSecret = env("FEISHU_APP_SECRET");
  const query = env("FEISHU_AUTO_JOIN_QUERY");
  const allowReS = env("FEISHU_AUTO_JOIN_NAME_ALLOW_REGEX");
  const maxJoins = Number(process.env.FEISHU_AUTO_JOIN_MAX_JOINS ?? "3");
  const intervalSec = Number(process.env.FEISHU_AUTO_JOIN_INTERVAL_SEC ?? "120");
  const deny = new Set(
    (process.env.FEISHU_AUTO_JOIN_CHAT_ID_DENY ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  let allowRe: RegExp;
  try {
    allowRe = new RegExp(allowReS);
  } catch (e) {
    console.error(`invalid FEISHU_AUTO_JOIN_NAME_ALLOW_REGEX: ${e}`);
    process.exit(1);
  }

  const baseConfig = {
    appId,
    appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Feishu,
  };

  const client = new lark.Client(baseConfig);

  const tickOpts = {
    client,
    query,
    nameAllowRegex: allowRe,
    maxJoins,
    denyChatIds: deny,
    dryRun,
    confirmPublic,
  };

  let tickRunning = false;
  const safeTick = async (reason: string) => {
    if (tickRunning) {
      console.log(`[auto-join] skip overlapping tick (${reason})`);
      return;
    }
    tickRunning = true;
    try {
      console.log(`[auto-join] reason=${reason}`);
      await runAutoJoinTick(tickOpts);
    } catch (err) {
      console.error("[auto-join] tick error", err);
    } finally {
      tickRunning = false;
    }
  };

  // Event path: outbound long connection — NOT webhook.
  const eventDispatcher = new lark.EventDispatcher({}).register({
    "im.chat.member.bot.added_v1": async (data) => {
      const chatId =
        data && typeof data === "object" && "chat_id" in data
          ? String((data as { chat_id?: string }).chat_id ?? "")
          : "";
      console.log(
        `[ws] im.chat.member.bot.added_v1 chat_id=${chatId || "(unknown)"} payload=${JSON.stringify(data)}`,
      );
      // Path C success: me_join → platform pushes this event. POC only logs
      // (production would ensureProject here).
    },
  });

  const wsClient = new lark.WSClient({
    ...baseConfig,
    loggerLevel: lark.LoggerLevel.info,
    onReady: () => {
      console.log("[ws] onReady — long connection established");
    },
    onError: (err) => {
      console.error("[ws] onError", err);
    },
  });

  console.log(
    `[ws] starting WSClient long connection (EventDispatcher); intervalSec=${intervalSec} dryRun=${dryRun}`,
  );

  // start() kicks off outbound WS reconnect loop; process stays alive on the socket timers.
  await wsClient.start({ eventDispatcher });

  console.log(
    "[ws] WSClient start() returned — listening for bot.added (no webhook HTTP server)",
  );

  if (!skipJoinOnStart) {
    await safeTick("startup");
  }

  if (intervalSec > 0) {
    setInterval(() => {
      void safeTick("interval");
    }, intervalSec * 1000);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
