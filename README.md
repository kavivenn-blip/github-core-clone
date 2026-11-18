# Forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/kavivenn-blip/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/kavivenn-blip/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge for the make.fun github-core-clone-01 bounty
("Build a GitHub-compatible git forge"): one Node 22 process, one in-memory
store, four surfaces — git smart HTTP, REST v3, GraphQL v4 and MCP — all
reading and writing the same state.

`main.ts` is the entry point (the kit's lifecycle: bind an ephemeral port,
register it with the env, poll until the env says done). `src/app.ts` is the
server; the surfaces live in `src/git.ts` (smart HTTP), `src/rest.ts` (REST
v3), `src/graphql.ts` (a small GraphQL parser and executor) and `src/mcp.ts`
(JSON-RPC 2.0 tools). `src/gitobj.ts` is the hand-rolled git engine: objects,
packs, deltas and pkt-lines, with no git binary and no vendored library.
`src/vcs.ts` holds the version-control operations the surfaces share (trees,
commits, diffs, three-way merges). `src/store.ts` is the deterministic
in-memory store: every timestamp and id comes from a counter, so replaying
the same requests produces the same bytes.

## Run

```sh
npm start
```

No install step: the entry uses the Node standard library only, and runs on
Node 22.18+ with type stripping (`node --experimental-strip-types main.ts`).
It expects `MAKEFUN_ENV_URL` (the env to register with) and
`MAKEFUN_SHOP_TOKEN` (the bearer token the API surfaces accept) in the
environment.

## What it serves

- **Git smart HTTP** at `/{owner}/{repo}.git`: upload-pack protocol v2
  (capability advertisement, `ls-refs`, shallow fetch with deepen) and
  receive-pack v0 (report-status, side-band-64k, delete-refs, fast-forward
  enforcement). Packs carry plain objects; the pack reader also resolves
  OFS/REF deltas.
- **REST v3** at `/api/v3`: repos, branches, refs, commits, contents, labels,
  issues, comments and pull requests with squash merge. Every reply is JSON
  with `X-GitHub-Request-Id`; a repo under another owner is 404, never 403.
- **GraphQL v4** at `/api/graphql`: the documents `gh` and
  `github-mcp-server` send — introspection, repository issues and pull
  requests with cursor pagination, and the create/close/merge/add-comment
  mutations, all on the same store.
- **MCP** at `/mcp`: JSON-RPC 2.0 over Streamable HTTP, pre-discover era
  (`server/discover` answers method-not-found and the client falls back to
  the initialize handshake), with six tools: `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`.

## Scores

Local kit runner (`sdk/run.ts --perf`): **120/120 checks**, perf **188/200**
on the second clean run (push 50, clone 43, read 49, write 46), for a total
of **988** (feature 600 + agent 200 + perf 188). A scripted replay of the
same requests against two fresh servers is byte-identical.
