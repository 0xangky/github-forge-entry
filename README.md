# github-forge-entry

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/0xangky/github-forge-entry/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/0xangky/github-forge-entry/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, deterministic GitHub-compatible git forge: git smart HTTP (upload-pack v2/v0 and receive-pack v0), REST v3, GraphQL v4 and MCP, backed by a single in-process store and Node 22's standard library only.

## Run it

```sh
node main.ts
```

The process binds an ephemeral port, registers it at `MAKEFUN_ENV_URL/register`, serves `/healthz`, the four API surfaces, and exits when `MAKEFUN_ENV_URL/done` reports completion.

---

<sub>Entered on [make.fun](https://make.fun/?ref=gnkf3kyt&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
