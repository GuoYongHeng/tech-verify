#!/bin/bash
export FEISHU_APP_ID=cli_aa50e1facdb89bb5
export FEISHU_APP_SECRET=QzqgDDIKxwbHx7lT4OYExdqVtzHKuBnx
export FEISHU_AUTO_JOIN_QUERY=课题
export FEISHU_AUTO_JOIN_NAME_ALLOW_REGEX='^课题'

# 先只看 search/差集，不入群
npm run dry-run
# 或: npx tsx run_once.ts --dry-run

# 确认候选后再真实 me_join（可选再核验公开群）
npx tsx run_once.ts #--confirm-public
