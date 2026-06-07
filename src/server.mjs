#!/usr/bin/env node
// Zebate — backend. Drives the user's own `claude` CLI (headless) — no API key.
// Stateless per message; supports streaming, abort-to-stop, usage capture,
// editable perspectives, and a multi-agent debate orchestrator.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const SESSIONS_DIR = path.join(DATA, 'sessions');
const PORT = process.env.PORT || 8899;
const SERVER_FILE = fileURLToPath(import.meta.url);
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
function slugify(s) { return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'session'; }
const SESSION_NAME = (process.env.SESSION || '').trim() || 'My research';
const SESSION_SLUG = slugify(SESSION_NAME);
const STATE_FILE = path.join(SESSIONS_DIR, SESSION_SLUG + '.json');
// preserve any legacy single-workspace file as an "Imported" session (never deletes)
try { const legacy = path.join(DATA, 'state.json'); const imp = path.join(SESSIONS_DIR, 'imported.json'); if (fs.existsSync(legacy) && !fs.existsSync(imp)) fs.copyFileSync(legacy, imp); } catch {}

const DEFAULT_PERSPECTIVES = [
  { id: 'direct',     name: 'Direct Answer',  desc: 'A clear, balanced answer — no persona.',           prompt: 'Answer the question directly and clearly. Be balanced, concrete and honest — the single most useful answer, no persona and no padding.' },
  { id: 'advocate',   name: 'Advocate',       desc: 'The strongest case *for*.',                        prompt: 'Make the strongest, most persuasive case FOR the idea. Marshal the best evidence, the upside, and the opportunities others overlook. Be concrete and rigorous — a sharp advocate, never a cheerleader.' },
  { id: 'critic',     name: 'Critic',         desc: 'The strongest case *against* — risks & flaws.',     prompt: 'Make the strongest case AGAINST. Surface the real risks, hidden costs, failure modes and weak assumptions. Steelman the opposition — be rigorous and specific, not nitpicky.' },
  { id: 'expert',     name: 'Domain Expert',  desc: 'Rigorous, specific, technical depth.',              prompt: "Answer as a seasoned domain expert. Be precise and technical: name the relevant mechanisms, trade-offs and standards, and say clearly where the honest answer is 'it depends' and why. No hand-waving." },
  { id: 'pragmatist', name: 'Pragmatist',     desc: 'Trade-offs + what to actually do.',                prompt: "Be the practical operator. Cut to the trade-offs that matter, what actually works under real-world constraints, and the concrete next step you'd take. Prefer the 80/20 path." },
];

let STATE = { windows: {}, cards: [], perspectives: null };
try { Object.assign(STATE, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch {}
if (!STATE.windows) STATE.windows = {};
if (!STATE.cards) STATE.cards = [];
if (!STATE.perspectives || !STATE.perspectives.length) STATE.perspectives = DEFAULT_PERSPECTIVES.slice();
STATE.name = SESSION_NAME;
let saveTimer = null;
function saveState() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(STATE)); } catch (e) { console.error('save failed', e.message); } }, 150); }

let ENGINE = { status: 'unknown', version: '', checkedAt: 0 };
function checkEngine() {
  return new Promise((resolve) => {
    execFile('claude', ['--version'], { timeout: 8000 }, (err, stdout) => {
      ENGINE = err ? { status: err.code === 'ENOENT' ? 'not_found' : 'error', version: '', checkedAt: Date.now() }
                   : { status: 'ready', version: String(stdout).trim(), checkedAt: Date.now() };
      resolve(ENGINE);
    });
  });
}

// ---- drive a headless claude turn (optional streaming, abort, usage) ----
function runClaude({ text, sessionId, system, model, onDelta, onPhase, signal }) {
  return new Promise((resolve) => {
    const args = ['-p', text, '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
    if (sessionId) args.push('--resume', sessionId);
    if (system) args.push('--append-system-prompt', system);
    if (model) args.push('--model', model);
    let buf = '', sid = sessionId || null, full = '', errored = null, err = '', done = false, usage = null, cost = null, rate = null, aborted = false;
    const finish = (v) => { if (!done) { done = true; resolve(Object.assign({ sessionId: sid, usage, cost, rate, aborted }, v)); } };
    let child;
    try { child = spawn('claude', args, { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return finish({ error: 'spawn_failed: ' + e.message }); }
    if (signal) signal.addEventListener('abort', () => { aborted = true; try { child.kill('SIGTERM'); } catch {} }, { once: true });
    child.on('error', (e) => finish({ error: e.code === 'ENOENT' ? 'claude_not_found' : e.message }));
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.on('data', (chunk) => {
      buf += chunk; let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        const t = j.type;
        if (t === 'system' && j.session_id) sid = j.session_id;
        else if (t === 'rate_limit_event') rate = j.rate_limit_info || rate;
        else if (t === 'stream_event') {
          const ev = j.event || {};
          if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'tool_use') { if (onPhase) onPhase({ phase: 'tool', name: ev.content_block.name || 'tool' }); }
          else if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') { const d = ev.delta.text || ''; if (!full && onPhase) onPhase({ phase: 'writing' }); full += d; if (onDelta) onDelta(d); }
        } else if (t === 'assistant' && !full) {
          const blocks = (j.message && j.message.content) || [];
          const tx = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
          if (tx) { full = tx; if (onDelta) onDelta(tx); }
        } else if (t === 'result') {
          if (j.session_id) sid = j.session_id;
          if (j.usage) usage = { in: j.usage.input_tokens || 0, out: j.usage.output_tokens || 0, cacheRead: j.usage.cache_read_input_tokens || 0, cacheCreate: j.usage.cache_creation_input_tokens || 0 };
          if (j.total_cost_usd != null) cost = j.total_cost_usd;
          if (j.is_error) errored = j.result || 'claude reported an error';
          if (!full && j.result) { full = j.result; if (onDelta) onDelta(j.result); }
        }
      }
    });
    child.on('close', (code) => {
      if (aborted) return finish({ result: full, stopped: true });
      if (errored) return finish({ error: errored });
      if (!full && code !== 0) return finish({ error: err.trim() || ('claude exited with code ' + code) });
      finish({ result: full });
    });
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
function send(res, code, type, b) { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(b); }
function json(res, code, obj) { send(res, code, 'application/json', JSON.stringify(obj)); }
function body(req) { return new Promise((resolve) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); }); }
function serveFile(res, fp) { fs.readFile(fp, (e, buf) => e ? send(res, 404, 'text/plain', 'not found') : send(res, 200, MIME[path.extname(fp)] || 'application/octet-stream', buf)); }
function getWin(id, title) { let w = STATE.windows[id]; if (!w) { w = STATE.windows[id] = { id, title: title || 'Chat', sessionId: null, system: null, lens: null, msgs: [], usage: { in: 0, out: 0, cost: 0 }, context: 0, seed: null, open: true }; } if (!w.usage) w.usage = { in: 0, out: 0, cost: 0 }; if (w.context == null) w.context = 0; w.open = true; return w; }
function tally(w, r) { if (r && r.usage) { w.usage.in += r.usage.in || 0; w.usage.out += r.usage.out || 0; w.usage.cost += (r.cost || 0); } }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function tryBind(port) { return new Promise((resolve) => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => { s.close(() => resolve(true)); }); }); }
async function probeSession(port) { try { const r = await fetch('http://127.0.0.1:' + port + '/api/status', { signal: AbortSignal.timeout(500) }); if (!r.ok) return null; const j = await r.json(); if (j && j.engine !== undefined) return { port, url: 'http://127.0.0.1:' + port, session: j.session || ('Port ' + port), slug: j.slug || ('port-' + port), windows: j.windows || 0 }; } catch {} return null; }
async function scanSessions() { const base = Number(PORT) || 8899; const ports = []; for (let i = 0; i < 26; i++) ports.push(base + i); const r = await Promise.all(ports.map(probeSession)); return r.filter(Boolean); }
async function freePortInRange() { const base = Number(PORT) || 8899; for (let i = 0; i < 26; i++) { if (await tryBind(base + i)) return base + i; } return null; }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  if (p === '/api/status') {
    if (Date.now() - ENGINE.checkedAt > 4000) await checkEngine();
    let totIn = 0, totOut = 0, totCost = 0;
    for (const k in STATE.windows) { const us = STATE.windows[k].usage || {}; totIn += us.in || 0; totOut += us.out || 0; totCost += us.cost || 0; }
    return json(res, 200, { engine: ENGINE.status, version: ENGINE.version, windows: Object.keys(STATE.windows).length, usage: { in: totIn, out: totOut, cost: totCost }, session: SESSION_NAME, slug: SESSION_SLUG, port: PORT_N });
  }
  if (p === '/api/state') return json(res, 200, { windows: STATE.windows, cards: STATE.cards, perspectives: STATE.perspectives });

  if (p === '/api/perspectives' && req.method === 'POST') { const b = await body(req); if (Array.isArray(b.perspectives)) { STATE.perspectives = b.perspectives; saveState(); } return json(res, 200, { ok: true }); }

  if (p === '/api/limits' && req.method === 'GET') { const r = await runClaude({ text: 'ok' }); return json(res, 200, { rate: r.rate || null, error: r.error || null }); }

  if (p === '/api/compact' && req.method === 'POST') {
    const { windowId } = await body(req);
    const w = STATE.windows[windowId]; if (!w) return json(res, 200, { error: 'no such chat' });
    const convo = w.msgs.map(m => (m.role === 'user' ? 'User: ' : 'Assistant: ') + m.text).join('\n');
    if (!convo.trim()) return json(res, 200, { error: 'nothing to compact' });
    const r = await runClaude({ text: 'Summarize this conversation so it can continue with full understanding but far less context. Capture key facts, decisions, numbers, and open threads. Be thorough yet compact.\n\n' + convo });
    if (r.error) return json(res, 200, { error: r.error });
    w.seed = r.result; w.sessionId = null; w.context = 0;
    w.msgs = [{ role: 'assistant', text: '\uD83E\uDDF9 Compacted \u2014 earlier conversation summarized to free context:\n\n' + r.result, ts: Date.now() }];
    saveState();
    return json(res, 200, { summary: r.result });
  }

  if (p === '/api/chat/stream' && req.method === 'POST') {
    const { windowId, title, text, system, lens, model } = await body(req);
    if (!windowId || !text || !String(text).trim()) return json(res, 400, { error: 'windowId and text required' });
    const w = getWin(windowId, title);
    if (title) w.title = title; if (lens && !w.lens) w.lens = lens; if (system && !w.system) w.system = system;
    w.msgs.push({ role: 'user', text: String(text), ts: Date.now() }); saveState();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    const write = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
    const ctrl = new AbortController();
    req.on('close', () => { if (!res.writableEnded) ctrl.abort(); });
    const hadSession = !!w.sessionId;
    const sysEff = hadSession ? null : (((w.system || '') + (w.seed ? ('\n\nEarlier conversation summary:\n' + w.seed) : '')) || null);
    const r = await runClaude({ text: String(text), sessionId: w.sessionId, system: sysEff, model, onDelta: (d) => write({ delta: d }), onPhase: (ph) => write({ phase: ph }), signal: ctrl.signal });
    if (r.sessionId) { w.sessionId = r.sessionId; if (!hadSession) w.seed = null; }
    if (r.error) { write({ error: r.error }); }
    else { tally(w, r); if (r.usage) w.context = r.usage.in; if (r.result) w.msgs.push({ role: 'assistant', text: r.result, ts: Date.now() }); write({ done: true, sessionId: w.sessionId, stopped: !!r.stopped, winUsage: w.usage, context: w.context, rate: r.rate }); }
    saveState(); try { res.end(); } catch {}
    return;
  }

  if (p === '/api/chat' && req.method === 'POST') {
    const { windowId, title, text, system, lens, model } = await body(req);
    if (!windowId || !text || !String(text).trim()) return json(res, 400, { error: 'windowId and text required' });
    const w = getWin(windowId, title);
    if (title) w.title = title; if (lens && !w.lens) w.lens = lens; if (system && !w.system) w.system = system;
    w.msgs.push({ role: 'user', text: String(text), ts: Date.now() }); saveState();
    const r = await runClaude({ text: String(text), sessionId: w.sessionId, system: w.sessionId ? null : w.system, model });
    if (r.sessionId) w.sessionId = r.sessionId;
    if (r.error) { saveState(); return json(res, 200, { error: r.error }); }
    tally(w, r); w.msgs.push({ role: 'assistant', text: r.result, ts: Date.now() }); saveState();
    return json(res, 200, { text: r.result, sessionId: w.sessionId, winUsage: w.usage });
  }

  // multi-agent debate (streamed): agents answer, rebut each other across rounds, a moderator concludes
  if (p === '/api/debate' && req.method === 'POST') {
    const { question, participants, rounds } = await body(req);
    const parts = (participants || []).filter(x => x && x.name);
    if (!question || parts.length < 2) return json(res, 400, { error: 'question and at least 2 participants required' });
    const R = Math.max(1, Math.min(3, rounds || 1));
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    const write = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
    const ctrl = new AbortController();
    req.on('close', () => { if (!res.writableEnded) ctrl.abort(); });
    const transcript = []; let usage = { in: 0, out: 0, cost: 0 }; let last = {};
    const addUse = (r) => { if (r.usage) { usage.in += r.usage.in || 0; usage.out += r.usage.out || 0; usage.cost += (r.cost || 0); } };
    write({ phase: 'start', participants: parts.map(pt => pt.name), rounds: R });
    try {
      for (let rnd = 1; rnd <= R; rnd++) {
        write({ roundStart: rnd });
        parts.forEach(pt => write({ agentStart: { round: rnd, name: pt.name } }));
        const others = (self) => parts.filter(p2 => p2.name !== self).map(p2 => '— ' + p2.name + ': ' + last[p2.name]).join('\n\n');
        const promptFor = (pt) => rnd === 1 ? question
          : 'Debate question: ' + question + '\n\nThe other participants said:\n' + others(pt.name) + '\n\nAs ' + pt.name + ', respond: where do you agree, where do you push back, and refine your position. Be concise.';
        await Promise.all(parts.map(pt => runClaude({ text: promptFor(pt), system: pt.prompt, signal: ctrl.signal, onDelta: (d) => write({ agentDelta: { round: rnd, name: pt.name, d } }) }).then(r => {
          const t = r.error ? ('(error: ' + r.error + ')') : r.result;
          last[pt.name] = t; transcript.push({ round: rnd, name: pt.name, text: t }); addUse(r);
          write({ agentDone: { round: rnd, name: pt.name, text: t } });
        })));
      }
      write({ phase: 'moderating' });
      const full = transcript.map(e => '[Round ' + e.round + '] ' + e.name + ': ' + e.text).join('\n\n');
      const concl = await runClaude({ text: 'Question: ' + question + '\n\nHere is a debate between perspectives:\n\n' + full + '\n\nYou are a neutral moderator. Deliver a scannable verdict in Markdown using EXACTLY this structure and these headings:\n\n**Verdict:** the bottom line in 1-2 sentences, first.\n\n## Where they agree\n2-4 tight bullets.\n\n## Where they clash\n2-4 bullets naming the real tensions between the perspectives.\n\n## The call\nThe recommendation and the core reason.\n\n## What would change it\n1-2 conditions that would flip the call.\n\nBe concise. Use short bullets, bold sparingly, and do NOT restate everything.', onDelta: (d) => write({ conclDelta: d }), signal: ctrl.signal });
      addUse(concl);
      write({ done: true, conclusion: concl.error ? '(error)' : concl.result, transcript, rounds: R, usage });
    } catch (e) { write({ error: String((e && e.message) || e) }); }
    try { res.end(); } catch {}
    return;
  }

  if (p === '/api/synthesize' && req.method === 'POST') {
    const { windowIds, instruction } = await body(req);
    const ids = (windowIds && windowIds.length) ? windowIds : Object.keys(STATE.windows);
    let transcript = '';
    for (const id of ids) { const w = STATE.windows[id]; if (!w) continue; transcript += `\n\n=== Thread: ${w.title} ===\n` + w.msgs.map(m => (m.role === 'user' ? 'Q: ' : 'A: ') + m.text).join('\n'); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    const write = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
    if (!transcript.trim()) { write({ error: 'no chat content to summarize' }); try { res.end(); } catch {} return; }
    const ctrl = new AbortController();
    req.on('close', () => { if (!res.writableEnded) ctrl.abort(); });
    write({ phase: 'reading', threads: ids.length });
    const prompt = (instruction || 'Summarize the key findings, agreements, tensions, and a recommendation across these research threads.') + '\nCite which thread each point comes from in (parentheses). Be concise and structured.\n' + transcript;
    const r = await runClaude({ text: prompt, onDelta: (d) => write({ delta: d }), onPhase: (ph) => write({ phase: ph }), signal: ctrl.signal });
    write(r.error ? { error: r.error } : { done: true, text: r.result });
    try { res.end(); } catch {}
    return;
  }

  if (p === '/api/matrix' && req.method === 'POST') {
    const { items, criteria } = await body(req);
    if (!items || !items.length || !criteria || !criteria.length) return json(res, 400, { error: 'items and criteria required' });
    const labels = items.map(i => (typeof i === 'string' ? i : (i.label || i.title || ''))).filter(Boolean);
    const prompt = `Build a comparison matrix. For each item, score each criterion 1-10 and give a <=8-word note.\nItems: ${JSON.stringify(labels)}\nCriteria: ${JSON.stringify(criteria)}\nReturn ONLY valid JSON, no prose, no code fences:\n{"rows":[{"item":"<label>","cells":{"<criterion>":{"score":<1-10>,"note":"<short>"}}}]}`;
    const r = await runClaude({ text: prompt });
    if (r.error) return json(res, 200, { error: r.error });
    let txt = (r.result || '').trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
    try { const parsed = JSON.parse(txt.slice(s, e + 1)); return json(res, 200, { rows: parsed.rows || [], criteria }); }
    catch { return json(res, 200, { error: 'could not parse matrix', raw: r.result }); }
  }

  if (p === '/api/compare/prep' && req.method === 'POST') {
    const { cards } = await body(req);
    if (!Array.isArray(cards) || !cards.length) return json(res, 400, { error: 'cards required' });
    const notes = cards.map((c, i) => `Note ${i + 1}${c && c.source ? ' (from ' + c.source + ')' : ''}: ${typeof c === 'string' ? c : (c && c.text) || ''}`).join('\n\n');
    const prompt = `You are setting up a decision comparison from a person's research notes. Read the notes below and draft the inputs for a weighted comparison table.\n\nNotes:\n${notes}\n\nReturn ONLY valid JSON, no prose, no code fences:\n{"options":[{"label":"<2-5 word clean option name>"}],"criteria":["<criterion>", ...],"weights":[<int 1-5>, ...]}\nRules: derive 2 or more concrete options from the notes (the things being compared); pick 3-6 relevant criteria for choosing between them; give one importance weight (integer 1-5) per criterion, in the SAME order and length as criteria.`;
    const r = await runClaude({ text: prompt });
    if (r.error) return json(res, 200, { error: r.error });
    let txt = (r.result || '').trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
    try {
      const parsed = JSON.parse(txt.slice(s, e + 1));
      return json(res, 200, { options: parsed.options || [], criteria: parsed.criteria || [], weights: parsed.weights || [] });
    } catch { return json(res, 200, { error: 'could not parse comparison draft', raw: r.result }); }
  }

  if (p === '/api/shutdown' && req.method === 'POST') { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end('{"ok":true}'); setTimeout(() => process.exit(0), 100); return; }
  if (p === '/api/ask' && req.method === 'POST') { const { text } = await body(req); if (!text) return json(res, 200, { text: '' }); const r = await runClaude({ text: String(text) }); return json(res, 200, { text: r.error ? '' : (r.result || '') }); }
  if (p === '/api/cards' && req.method === 'POST') { const b = await body(req); if (Array.isArray(b.cards)) { STATE.cards = b.cards; saveState(); } return json(res, 200, { ok: true }); }
  if (p === '/api/window/close' && req.method === 'POST') { const { windowId } = await body(req); if (windowId && STATE.windows[windowId]) { STATE.windows[windowId].open = false; saveState(); } return json(res, 200, { ok: true }); }
  if (p === '/api/window/open' && req.method === 'POST') { const { windowId } = await body(req); if (windowId && STATE.windows[windowId]) { STATE.windows[windowId].open = true; saveState(); } return json(res, 200, { ok: true }); }
  if (p === '/api/window/delete' && req.method === 'POST') { const { windowId } = await body(req); if (windowId) { delete STATE.windows[windowId]; saveState(); } return json(res, 200, { ok: true }); }

  if (p === '/api/session/list') {
    const running = await scanSessions();
    const runSlugs = new Set(running.map(s => s.slug));
    let saved = [];
    try { saved = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json')).map(f => { const slug = f.replace(/\.json$/, ''); let name = slug, windows = 0; try { const st = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')); name = st.name || slug; windows = st.windows ? Object.keys(st.windows).length : 0; } catch {} return { slug, name, windows, running: runSlugs.has(slug) }; }); } catch {}
    return json(res, 200, { running, saved, current: SESSION_SLUG });
  }
  if (p === '/api/session/new' && req.method === 'POST') {
    const { name } = await body(req); const nm = String(name || '').trim() || 'Untitled'; const slug = slugify(nm);
    const running = await scanSessions(); const exist = running.find(s => s.slug === slug);
    if (exist) return json(res, 200, { url: exist.url, existed: true, name: exist.session });
    const fp = await freePortInRange(); if (fp == null) return json(res, 200, { error: 'no free port near ' + PORT });
    try { spawn(process.execPath, [SERVER_FILE], { cwd: ROOT, env: Object.assign({}, process.env, { SESSION: nm, PORT: String(fp), OPEN: '0' }), stdio: 'ignore', detached: true }).unref(); }
    catch (e) { return json(res, 200, { error: 'spawn_failed: ' + e.message }); }
    const url = 'http://127.0.0.1:' + fp;
    for (let i = 0; i < 40; i++) { const ok = await probeSession(fp); if (ok) break; await sleep(150); }
    return json(res, 200, { url, name: nm });
  }
  if (p === '/') return serveFile(res, path.join(PUBLIC, 'index.html'));
  const fp = path.join(PUBLIC, p.replace(/^\/+/, ''));
  if (fp.startsWith(PUBLIC) && fs.existsSync(fp) && fs.statSync(fp).isFile()) return serveFile(res, fp);
  return send(res, 404, 'text/plain', 'not found');
});

function openBrowser(url) {
  try {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {}
}
let PORT_N = Number(PORT) || 8899;
server.on('error', (e) => { if (e.code === 'EADDRINUSE') { PORT_N++; setTimeout(() => server.listen(PORT_N, '127.0.0.1'), 60); } else { console.error(e); process.exit(1); } });
server.on('listening', async () => { await checkEngine(); const url = `http://127.0.0.1:${PORT_N}`; console.log(`\n  Zebate — "${SESSION_NAME}"  →  ${url}\n  engine: ${ENGINE.status} ${ENGINE.version}\n  (close this terminal to stop this session)\n`); if (process.env.OPEN !== '0') openBrowser(url); });
(async function start() {
  const running = await scanSessions();
  const mine = running.find(s => s.slug === SESSION_SLUG);
  if (mine) { console.log(`\n  Zebate session "${SESSION_NAME}" already running → ${mine.url}\n  Opening it…\n`); if (process.env.OPEN !== '0') openBrowser(mine.url); process.exit(0); }
  PORT_N = Number(PORT) || 8899;
  if (!(await tryBind(PORT_N))) { const fp = await freePortInRange(); if (fp == null) { console.error('No free port near ' + PORT + '.'); process.exit(1); } PORT_N = fp; }
  server.listen(PORT_N, '127.0.0.1');
})();
