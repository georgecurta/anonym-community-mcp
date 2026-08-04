# anonym-community-mcp

**Read-only [Model Context Protocol](https://modelcontextprotocol.io) server for the
[anonym.community](https://anonym.community) privacy research corpus** — 1,478 documented
PII/privacy pain points, 98 structural root causes, a 240-jurisdiction privacy-law
directory, 134 evidence-backed FAQ answers, and 1,600+ cited academic papers, queryable
directly from Claude Desktop, Claude Code, Cursor, or any MCP client.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](package.json)
[![Self-test](https://github.com/georgecurta/anonym-community-mcp/actions/workflows/selftest.yml/badge.svg)](https://github.com/georgecurta/anonym-community-mcp/actions/workflows/selftest.yml)
[![MCP](https://img.shields.io/badge/MCP-2024--11--05-blueviolet)](https://modelcontextprotocol.io)

## Why this exists

All of this is already public as HTML and JSON at
[anonym.community](https://anonym.community), but an agent trying to answer "which EU
jurisdictions have a data protection authority and what law applies" has to crawl and
re-derive that from prose every time. This server exposes the same corpus as typed,
queryable tools, so an agent can ask precisely and cite exactly — pain point IDs,
jurisdiction records, FAQ entries and paper DOIs, not paraphrased HTML.

## What it exposes

| Tool | Data | Use it for |
|---|---|---|
| `search_pain_points` | 1,478 documented PII/privacy problems | "what goes wrong with X" |
| `list_structural_drivers` | 98 irreducible root causes | "why does this keep happening" |
| `lookup_jurisdiction` | 240 jurisdictions, DPAs, legislation | "is there a privacy law in X" |
| `search_faq` | 134 evidence-backed Q&As | direct practitioner questions |
| `search_research_papers` | 1,600+ academic papers with DOIs | "cite a primary source" |
| `get_corpus_stats` | counts, valid filter values, data freshness | **call first** to discover valid `track`/`region` values |

Every result carries its identifiers and source links, so an answer can be cited back to
a specific pain point, driver, jurisdiction, FAQ entry or DOI.

## Install

### Claude Desktop / Claude Code

Add to your MCP config (`claude_desktop_config.json`, or `.mcp.json` in a project):

```json
{
  "mcpServers": {
    "anonym-community": {
      "command": "npx",
      "args": ["-y", "github:georgecurta/anonym-community-mcp"]
    }
  }
}
```

No install step, no clone, no local path. `npx` fetches and runs it on demand.

If you'd rather run a pinned local copy:

```bash
git clone https://github.com/georgecurta/anonym-community-mcp.git
```

```json
{
  "mcpServers": {
    "anonym-community": {
      "command": "node",
      "args": ["/absolute/path/to/anonym-community-mcp/index.js"]
    }
  }
}
```

### Cursor / other MCP clients

Same shape — the server speaks stdio JSON-RPC, the MCP default. No port, no
credentials, nothing to host.

## Verify it works

```bash
node index.js --selftest
```

Runs 7 assertions against the **live** corpus (not fixtures) and exits non-zero on
failure. Expected output ends with `7 passed, 0 failed`.

Manual protocol check:

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node index.js
```

## Example

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
  "name":"search_pain_points",
  "arguments":{"query":"data broker opt-out","limit":2}
}}
```

returns matched pain points with title, evidence, severity, structural driver track,
category and source citations — ready to quote, not to re-summarize.

## Architecture

**Live, not bundled.** The server fetches `https://anonym.community/data/*.json` — the
same files the website itself is built from — at startup, caches in memory, and
refreshes on a TTL (stale-while-revalidate: a request just after the TTL expires gets
the cached answer immediately while a background fetch updates the cache for the next
one). The corpus this server answers from is never more than `ANONYM_MCP_TTL_MS`
(default 30 minutes) old, with no sync step to remember and no risk of a stale local
snapshot drifting from the live site.

| Env var | Default | Purpose |
|---|---|---|
| `ANONYM_MCP_BASE_URL` | `https://anonym.community` | Point at a staging mirror instead |
| `ANONYM_MCP_TTL_MS` | `1800000` (30 min) | How long a cached fetch is served before refreshing |

**Read-only by construction.** There are no write tools, no filesystem writes and no
network calls other than the `GET` requests above. Data is fetched, held in memory, and
never mutated — locally or remotely. The server has no code path that could alter the
site, so it cannot be talked into doing so.

**stdio, not HTTP.** A hosted HTTP/SSE endpoint would make the corpus reachable by
remote agents, but it also means another public service to patch and rate-limit. stdio
gives the same query capability with no attack surface and no operational burden.
`handle(name, args)` is exported and transport-agnostic if a hosted endpoint is ever
wanted — wrap it, don't rewrite it.

**No SDK.** The MCP subset actually needed here — `initialize`, `tools/list`,
`tools/call` — is implemented directly against the JSON-RPC 2.0 spec, so the repo has
zero runtime dependencies beyond Node's own `fetch`.

## Data license

The **code** in this repository is MIT-licensed (see [LICENSE](LICENSE)). The
**corpus** it queries — anonym.community's pain points, structural drivers,
jurisdictions, FAQ and paper citations — is published separately under **CC-BY-4.0** by
[curta.solutions](https://curta.solutions). Attribute the source when citing results.

## Related

- [anonym.community](https://anonym.community) — the research site this server queries
- [anonym.community/faq.html](https://anonym.community/faq.html) — the FAQ corpus, browsable
- [anonym.community/dpa-directory.html](https://anonym.community/dpa-directory.html) — the jurisdiction directory, browsable
- [anonym.community/chatbot/manifest.json](https://anonym.community/chatbot/manifest.json) — index into the same data pre-packaged as static JSON for offline/bulk use (the bare `/chatbot/` directory itself isn't served — start from the manifest, or `/chatbot/combined/full-corpus.json` for everything in one file)
- [anonym.community/llms.txt](https://anonym.community/llms.txt) — a machine-readable site index for AI crawlers
- [curta.solutions](https://curta.solutions) — the PII-anonymization ecosystem this research supports: [anonymize.solutions](https://anonymize.solutions), [cloak.business](https://cloak.business), [anonym.legal](https://anonym.legal), [anonym.plus](https://anonym.plus)

### [anonym.legal](https://anonym.legal)

The product most directly related to this repo. [anonym.legal](https://anonym.legal)
is a cloud/desktop PII anonymization platform (267+ entity types, 48 languages,
Zero-Knowledge architecture) built on the same research this corpus documents — and it
ships its **own** MCP server (7 tools for Claude Desktop and Cursor) for actually
anonymizing data, as distinct from this repo, which only lets an agent *read the
research about why anonymization matters*. If a query against this corpus surfaces a
pain point your own data has, anonym.legal is the tool built to act on it.

## Issues

Found a data problem, a broken query, or a gap in what's exposed? Open an
[issue](https://github.com/georgecurta/anonym-community-mcp/issues) — corrections to
the underlying corpus itself go through [anonym.community/contact.html](https://anonym.community/contact.html)
instead, since this repo only serves what that site publishes.

## License

[MIT](LICENSE) © George Curta / [curta.solutions](https://curta.solutions)
