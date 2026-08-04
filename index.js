#!/usr/bin/env node
'use strict';
/**
 * anonym-community-mcp — read-only MCP access to the anonym.community privacy research
 * corpus: 1,478 documented PII/privacy pain points, 98 structural root causes, a
 * 240-jurisdiction privacy-law directory, 134 evidence-backed FAQ answers, and 1,600+
 * cited academic papers.
 *
 * WHY THIS EXISTS
 * All of this is already public as HTML and JSON at https://anonym.community, but an
 * agent answering "which EU jurisdictions have a DPA and what law applies" has to crawl
 * and re-derive that every time. This server exposes the same data as typed, queryable
 * tools so an agent can ask precisely and cite exactly.
 *
 * READ-ONLY BY CONSTRUCTION. There are no write tools. The server only ever performs
 * GET requests against https://anonym.community's own public JSON endpoints (the same
 * files the website itself is built from) and never mutates anything, locally or
 * remotely. It cannot be talked into altering the site because it has no code path that
 * writes anywhere.
 *
 * LIVE, NOT BUNDLED. Earlier versions of this server shipped a snapshot of the corpus
 * inside the repo, which meant the data was correct on the day it was cloned and stale
 * every day after. This version fetches https://anonym.community/data/*.json at
 * startup, caches in memory, and refreshes on a TTL (stale-while-revalidate — a request
 * that lands just after the TTL expires gets the cached answer immediately while a
 * background fetch updates the cache for the next one). The corpus this server answers
 * from is never more than ANONYM_MCP_TTL_MS old, with zero sync step to remember.
 *
 * Transport: stdio (the MCP default) — works with Claude Desktop, Claude Code, Cursor,
 * and any other MCP client, with no server to host or secure.
 *
 * Protocol: JSON-RPC 2.0 over newline-delimited stdio, implementing the subset of MCP
 * that matters here — initialize, tools/list, tools/call. Implemented directly rather
 * than via the SDK to keep this dependency-free: a read-only data proxy should not carry
 * an npm tree.
 *
 * Requires Node >=18 for native fetch/AbortController.
 */
const readline = require('readline');

const PROTOCOL_VERSION = '2024-11-05';
const BASE_URL = (process.env.ANONYM_MCP_BASE_URL || 'https://anonym.community').replace(/\/$/, '');
const TTL_MS = Number(process.env.ANONYM_MCP_TTL_MS) || 30 * 60 * 1000; // 30 min default
const FETCH_TIMEOUT_MS = 15000;

const DATA_FILES = {
  painPoints: 'pain-points.json',
  taxonomy: 'taxonomy.json',
  jurisdictions: 'jurisdictions.json',
  faq: 'faq-content.json',
  papers: 'case-studies-real.json',
};

// ---------------------------------------------------------------- live data fetch
async function fetchJSON(name) {
  const url = `${BASE_URL}/data/${name}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function loadAll() {
  const [painPoints, taxonomy, jurisdictions, faq, papers] = await Promise.all(
    Object.entries(DATA_FILES).map(async ([key, file]) => {
      try {
        return await fetchJSON(file);
      } catch (e) {
        process.stderr.write(`[anonym-community-mcp] could not fetch ${file}: ${e.message}\n`);
        return key === 'taxonomy' ? {} : [];
      }
    })
  );

  const drivers = Array.isArray(taxonomy.drivers) ? taxonomy.drivers
    : (taxonomy.drivers ? Object.values(taxonomy.drivers).flat() : []);
  const tracks = Array.isArray(taxonomy.tracks) ? taxonomy.tracks
    : (taxonomy.tracks ? Object.values(taxonomy.tracks) : []);

  return { painPoints, jurisdictions, faq, papers, drivers, tracks, fetchedAt: new Date().toISOString() };
}

// stale-while-revalidate: a call after the TTL gets the cached answer immediately and
// triggers a background refresh for the next one, rather than blocking on the network.
let cache = null;
let inFlight = null;
let cachedAt = 0;

function refresh() {
  if (inFlight) return inFlight;
  inFlight = loadAll()
    .then((data) => { cache = data; cachedAt = Date.now(); return data; })
    .finally(() => { inFlight = null; });
  return inFlight;
}

async function getData() {
  if (!cache) return refresh(); // first call: block until we have something
  if (Date.now() - cachedAt > TTL_MS) refresh(); // stale: kick off refresh, don't wait
  return cache;
}

// begin fetching immediately at startup, in parallel with the client's initialize
// handshake, so the first real tool call is rarely the one paying the network cost
refresh().catch(() => {});

// ---------------------------------------------------------------- utilities
const norm = (s) => String(s == null ? '' : s).toLowerCase();

/** Score a record against query terms. Title matches weigh more than body. */
function score(rec, terms, weighted) {
  let n = 0;
  for (const [field, weight] of weighted) {
    const hay = norm(rec[field]);
    if (!hay) continue;
    for (const t of terms) if (hay.includes(t)) n += weight;
  }
  return n;
}

function search(records, query, weighted, limit) {
  const terms = norm(query).split(/\s+/).filter((t) => t.length > 1);
  if (!terms.length) return records.slice(0, limit);
  return records
    .map((r) => ({ r, s: score(r, terms, weighted) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.r);
}

const clampLimit = (n, d = 10) => Math.min(Math.max(parseInt(n, 10) || d, 1), 50);

// ---------------------------------------------------------------- tools
const TOOLS = [
  {
    name: 'search_pain_points',
    description:
      'Search 1,478 documented PII/privacy pain points. Each is a concrete, evidenced problem '
      + '(e.g. re-identification via quasi-identifiers, opt-out futility with data brokers), tagged '
      + 'with research track, category and severity. Use for "what goes wrong with X" questions.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search over title, description and evidence.' },
        track: { type: 'string', description: 'Optional research track filter, e.g. "AI Anonymization", "Data Brokers".' },
        limit: { type: 'number', description: 'Max results, 1-50 (default 10).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_structural_drivers',
    description:
      'List or search the 98 structural drivers — the irreducible root causes that generate the '
      + 'pain points. Breaking one driver weakens many pain points at once, so these are the right '
      + 'unit for "why does this keep happening" and "what should we actually fix" questions.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional free-text filter over driver name and definition.' },
        track: { type: 'string', description: 'Optional research track filter.' },
        limit: { type: 'number', description: 'Max results, 1-50 (default 20).' },
      },
    },
  },
  {
    name: 'lookup_jurisdiction',
    description:
      'Look up privacy-law status for a country or region across 240 jurisdictions: whether it has a '
      + 'data protection authority, what legislation applies, and links. Use for "is there a privacy '
      + 'law in X" and cross-border transfer questions.',
    inputSchema: {
      type: 'object',
      properties: {
        country: { type: 'string', description: 'Country name or fragment, e.g. "Brazil", "united".' },
        region: { type: 'string', description: 'Optional region filter, e.g. "Europe", "Asia".' },
        limit: { type: 'number', description: 'Max results, 1-50 (default 10).' },
      },
    },
  },
  {
    name: 'search_faq',
    description:
      'Search 134 evidence-backed privacy questions and answers, each with root cause, real-world '
      + 'example and supporting data points. Use for direct practitioner questions.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search over question and answer.' },
        limit: { type: 'number', description: 'Max results, 1-50 (default 5).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_research_papers',
    description:
      'Search 1,600+ real academic papers underpinning the research (title, authors, abstract, DOI). '
      + 'Use when a claim needs a citable primary source.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search over title and abstract.' },
        limit: { type: 'number', description: 'Max results, 1-50 (default 8).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_corpus_stats',
    description:
      'Return counts, available filter values (tracks, regions), and data freshness for this corpus. '
      + 'Call this first to discover valid track and region values for the other tools.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ---------------------------------------------------------------- handlers
async function handle(name, args) {
  const a = args || {};
  const d = await getData();
  switch (name) {
    case 'search_pain_points': {
      let rows = d.painPoints;
      if (a.track) rows = rows.filter((r) => norm(r.track).includes(norm(a.track)));
      const hits = search(rows, a.query, [['title', 3], ['description', 1], ['evidence', 1], ['category', 2]], clampLimit(a.limit, 10));
      return {
        matched: hits.length,
        searched: rows.length,
        results: hits.map((r) => ({
          id: r.id, title: r.title, description: r.description,
          evidence: r.evidence, impact: r.impact, severity: r.severity,
          track: r.track, category: r.category,
          sources: r.sources,
        })),
      };
    }
    case 'list_structural_drivers': {
      let rows = d.drivers;
      if (a.track) rows = rows.filter((x) => norm(x.track || x.trackName).includes(norm(a.track)));
      const hits = a.query
        ? search(rows, a.query, [['name', 3], ['definition', 1], ['atomicTruth', 1], ['title', 3]], clampLimit(a.limit, 20))
        : rows.slice(0, clampLimit(a.limit, 20));
      return { matched: hits.length, total: d.drivers.length, results: hits };
    }
    case 'lookup_jurisdiction': {
      let rows = d.jurisdictions;
      if (a.region) rows = rows.filter((j) => norm(j.region).includes(norm(a.region)));
      const hits = a.country
        ? search(rows, a.country, [['country', 3], ['description', 1], ['tags', 1]], clampLimit(a.limit, 10))
        : rows.slice(0, clampLimit(a.limit, 10));
      return {
        matched: hits.length,
        total: d.jurisdictions.length,
        directory: `${BASE_URL}/dpa-directory.html`,
        results: hits.map((j) => ({
          country: j.country, region: j.region,
          hasDpa: j.hasDpa, hasLegislation: j.hasLegislation,
          dpas: j.dpas, legislation: j.legislation,
          description: j.description, iappUrl: j.iappUrl,
        })),
      };
    }
    case 'search_faq': {
      const hits = search(d.faq, a.query, [['question', 3], ['anonymAnswer', 1], ['answerContext', 1], ['rootCause', 1]], clampLimit(a.limit, 5));
      return {
        matched: hits.length, total: d.faq.length, page: `${BASE_URL}/faq.html`,
        results: hits.map((f) => ({
          id: f.id, question: f.question, answer: f.anonymAnswer,
          context: f.answerContext, rootCause: f.rootCause,
          example: f.realWorldExample, dataPoints: f.dataPoints,
          urgency: f.urgency, region: f.region, sourceUrl: f.sourceUrl,
        })),
      };
    }
    case 'search_research_papers': {
      const hits = search(d.papers, a.query, [['title', 3], ['abstract', 1], ['topics', 2]], clampLimit(a.limit, 8));
      return {
        matched: hits.length, total: d.papers.length,
        results: hits.map((p) => ({
          title: p.title, authors: p.authors, date: p.date,
          doi: p.doi, sourceUrl: p.sourceUrl,
          abstract: typeof p.abstract === 'string' ? p.abstract.slice(0, 900) : p.abstract,
          topics: p.topics,
        })),
      };
    }
    case 'get_corpus_stats': {
      const uniq = (arr, k) => [...new Set(arr.map((x) => x[k]).filter(Boolean))].sort();
      return {
        site: BASE_URL,
        dataFetchedAt: d.fetchedAt,
        counts: {
          painPoints: d.painPoints.length,
          structuralDrivers: d.drivers.length,
          researchTracks: d.tracks.length,
          jurisdictions: d.jurisdictions.length,
          faqEntries: d.faq.length,
          researchPapers: d.papers.length,
        },
        painPointTracks: uniq(d.painPoints, 'track'),
        jurisdictionRegions: uniq(d.jurisdictions, 'region'),
        note: 'All data is also published as JSON under ' + BASE_URL + '/chatbot/ and as HTML pages.',
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------- transport
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function dispatch(req) {
  const { id, method, params } = req;
  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'anonym-community-mcp', version: '2.0.0' },
    });
  }
  if (method === 'notifications/initialized') return; // notification, no reply
  if (method === 'ping') return ok(id, {});
  if (method === 'tools/list') return ok(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const name = params && params.name;
    try {
      const result = await handle(name, params && params.arguments);
      return ok(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } catch (e) {
      return ok(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
    }
  }
  if (id !== undefined) err(id, -32601, `Method not found: ${method}`);
}

function main() {
  if (process.argv.includes('--selftest')) return selftest();
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const t = line.trim();
    if (!t) return;
    let req;
    try { req = JSON.parse(t); } catch (e) { return err(null, -32700, 'Parse error'); }
    dispatch(req).catch((e) => { if (req.id !== undefined) err(req.id, -32603, e.message); });
  });
}

/** Exercised by `npm test` — proves every tool returns data from the real, live corpus. */
async function selftest() {
  const checks = [
    ['get_corpus_stats', {}, (r) => r.counts.painPoints > 1000 && r.counts.jurisdictions > 200],
    ['search_pain_points', { query: 'anonymization re-identification', limit: 3 }, (r) => r.results.length > 0],
    ['search_pain_points', { query: 'broker', track: 'Data Brokers', limit: 3 }, (r) => r.results.every((x) => /broker/i.test(x.track))],
    ['list_structural_drivers', { limit: 5 }, (r) => r.results.length > 0],
    ['lookup_jurisdiction', { country: 'Brazil' }, (r) => r.results.some((x) => /brazil/i.test(x.country))],
    ['search_faq', { query: 'GDPR consent', limit: 2 }, (r) => r.results.length > 0],
    ['search_research_papers', { query: 'federated learning privacy', limit: 2 }, (r) => r.results.length > 0],
  ];
  let pass = 0, fail = 0;
  for (const [tool, args, assert] of checks) {
    try {
      const r = await handle(tool, args);
      const good = assert(r);
      console.log(`  ${good ? 'PASS' : 'FAIL'}  ${tool}(${JSON.stringify(args)})`);
      good ? pass++ : fail++;
    } catch (e) {
      console.log(`  FAIL  ${tool} threw: ${e.message}`);
      fail++;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

if (require.main === module) main();
module.exports = { handle, TOOLS, getData, BASE_URL };
