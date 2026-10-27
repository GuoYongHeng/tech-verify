# AGENTS — Path C / Feishu POC

## Stack (required)

- **TypeScript** (Node.js ≥ 18)
- Official Feishu SDK: **`@larksuiteoapi/node-sdk`**
- Run with `tsx` (see `package.json` scripts)

## Do not

- **Do not use Python** for Path-C / Feishu work in this Project
- Do not call `im.chatMembers.create` to self-pull into a chat (use `meJoin` only)
- Do not search with an empty `query`

## Entry

- One-tick POC: `run_once.ts`
- Usage: `README.md`
- Spec: `../飞书公开群search与me_join自动入群-技术方案.md`
