# AGENTS — Path C / Feishu POC

## Stack (required)

- **TypeScript** (Node.js ≥ 18)
- Official Feishu SDK: **`@larksuiteoapi/node-sdk`**
- Events via **`WSClient` + `EventDispatcher`** (outbound long connection)
- OpenAPI via **`Client`** (search / list / me_join)
- Run with `tsx` (see `package.json`)

## Do not

- **Do not use Python** for Path-C / Feishu work in this Project
- **Do not use webhook HTTP servers** for events in this POC — use WSClient
- Do not call `im.chatMembers.create` to self-pull (use `meJoin` only)
- Do not search with an empty `query`

## Entry

- Long-running: `server.ts` (`npm start`)
- One-shot REST: `run_once.ts` / `auto_join.ts`
- Spec: `../飞书公开群search与me_join自动入群-技术方案.md`
