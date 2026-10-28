/**
 * One-shot Path-C REST tick (no WS). Prefer `npm start` / server.ts for WSClient.
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
  };
}

async function main(): Promise<void> {
  const { dryRun, confirmPublic } = parseArgs(process.argv.slice(2));

  const client = new lark.Client({
    appId: env("FEISHU_APP_ID"),
    appSecret: env("FEISHU_APP_SECRET"),
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Feishu,
  });

  let allowRe: RegExp;
  try {
    allowRe = new RegExp(env("FEISHU_AUTO_JOIN_NAME_ALLOW_REGEX"));
  } catch (e) {
    console.error(`invalid FEISHU_AUTO_JOIN_NAME_ALLOW_REGEX: ${e}`);
    process.exit(1);
  }

  await runAutoJoinTick({
    client,
    query: env("FEISHU_AUTO_JOIN_QUERY"),
    nameAllowRegex: allowRe,
    maxJoins: Number(process.env.FEISHU_AUTO_JOIN_MAX_JOINS ?? "3"),
    denyChatIds: new Set(
      (process.env.FEISHU_AUTO_JOIN_CHAT_ID_DENY ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    dryRun,
    confirmPublic,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
