import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { launchpadHome } from '../home.js';
import { fileURLToPath } from 'node:url';
import { addIdea, setStatus, isStatus, createTask, setPriority } from '../nightshift/backlog.js';
import { readConfig, writeConfig } from '../nightshift/config.js';
import { readRegistry, addProject, removeProject } from '../registry.js';
import { readState, writeState } from '../state.js';
import { detectAssets } from '../assets.js';
import { scorecard } from '../scorecard.js';
import { confirm, unconfirm, record } from '../confirmations.js';
import { dashboardData } from './data.js';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { demoCode, materializeDemo } from './demo.js';
import { startReplay } from './replay.js';
import { watchFleet } from './watch.js';

/**
 * Mission Control's server.
 *
 * Local-first and zero-dependency on purpose. It binds to loopback, it ships
 * pre-built inside the package, and it has no build step — because a dashboard
 * that needs a bundler is a dashboard that breaks on a customer's machine for
 * reasons neither of us can see, and support at a one-time price has to be near-zero-touch.
 *
 * It is also deliberately read-mostly. Three write endpoints, all of them
 * things a person does *to a queue* rather than *to a repo*. Everything that
 * changes code — fixing a readiness gap, cutting a release — renders as a
 * command to run in Claude Code instead. A dashboard that grows into a full
 * control panel is a second product to maintain.
 */

export interface ServeOptions {
  port?: number;
  home?: string;
  /** Loopback only. Exposed for tests, never for binding to a real interface. */
  host?: string;
  /**
   * Serve the fictional demo fleet instead of the user's own projects.
   *
   * Never the default, and not a rendering mode: it writes real repositories to
   * a temporary directory and points this server's HOME at them, so everything
   * on screen is computed by the same code from real files. The page is told,
   * so it can say so where nobody can miss it.
   */
  demo?: boolean;
  /** Where the demo fleet is written. Exposed for tests. */
  demoRoot?: string;
  /** Milliseconds between replay beats. Slower is easier to narrate over. */
  replayMs?: number;
  /**
   * Quiet before the first beat.
   *
   * A recording needs a still frame to start the take on — and, for the same
   * reason, so does anyone verifying the sequence by hand: with the default
   * three seconds the opening state is gone before a browser has finished
   * connecting, which makes the one frame that shows "freshly added, nothing
   * measured" the hardest one to look at.
   */
  replayLeadMs?: number;
  /**
   * Play the arrival sequence: the fleet appears one resolved check at a time.
   *
   * Only meaningful with `demo`. It is a recording aid, and it works by
   * *changing the files* on a timer — the live-update channel that carries it
   * is the same `fs.watch` → SSE path a customer's own repos use, so what the
   * camera sees is the real mechanism rather than a scripted animation.
   */
  replay?: boolean;
}

export interface RunningServer {
  url: string;
  port: number;
  /** Where this server is reading from. The demo's temp HOME, when in demo mode. */
  home: string;
  close: () => Promise<void>;
}

const PAGE = () => readFileSync(fileURLToPath(new URL('./app.html', import.meta.url)), 'utf8');

/**
 * What the demo band prints in its right-hand slot: the temp folder's NAME,
 * never its path.
 *
 * The band had a slot for this and nothing ever filled it, so every screenshot
 * and every frame of video the product is sold with ended in an empty element.
 * Filling it with the absolute path would have been the other bug — the August
 * audit's Blocker 3 was an absolute path printed on this screen, and a temp
 * root is `/var/folders/…` or `/tmp/…`. `parent/basename`, exactly as the
 * project header's path button does it, says where the fleet is without
 * putting a filesystem tree in a shared image.
 *
 * Sanitised rather than trusted: this string is substituted into a JavaScript
 * string literal in the page, and `tmpdir()` is whatever `TMPDIR` says.
 */
export function demoLabel(home: string): string {
  const root = dirname(home);
  const parts = root.split(/[\\/]/).filter(Boolean);
  return `${parts[parts.length - 1] ?? 'launchpad-demo'}/${basename(demoCode(root))}`
    .replace(/[^A-Za-z0-9._/-]/g, '');
}

export function serve(opts: ServeOptions = {}): Promise<RunningServer> {
  const demo = opts.demo === true;
  // The demo fleet is a HOME, not a code path. Everything downstream of this
  // line is identical to a customer reading their own projects.
  const home = demo ? materializeDemo(opts.demoRoot) : opts.home ?? launchpadHome();
  const host = opts.host ?? '127.0.0.1';
  const replay = demo && opts.replay === true
    ? startReplay(home, {
      ...(opts.replayMs ? { everyMs: opts.replayMs } : {}),
      ...(opts.replayLeadMs ? { leadInMs: opts.replayLeadMs } : {}),
    })
    : null;
  /**
   * A per-run token, required on every write.
   *
   * Loopback alone is not enough: any page in the user's browser can POST to
   * `http://127.0.0.1:<port>` cross-origin, and while it cannot read the reply
   * it does not need to — the write has already happened. The token lives only
   * in the served HTML, so a request that did not come from this page cannot
   * carry it.
   */
  const token = randomBytes(24).toString('hex');

  const server = createServer((req, res) => {
    void handle(req, res, home, token, demo).catch(() => json(res, 500, { error: 'internal error' }));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        // The token is delivered inside the page, never in the URL — a URL is
        // copied, shared and kept in browser history.
        url: `http://${host}:${port}/`,
        port,
        home,
        close: () => new Promise(done => {
          replay?.stop();
          // The demo fleet is scratch: leaving seven repos and a dozen PNGs in
          // the temp directory after every screenshot session is litter.
          if (demo) { try { rmSync(dirname(home), { recursive: true, force: true }); } catch { /* gone */ } }
          server.close(() => done());
        }),
      });
    });
  });
}

async function handle(
  req: IncomingMessage, res: ServerResponse, home: string, token: string, demo = false,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  // Reject anything addressed to a name other than loopback. This is what
  // stops a DNS-rebinding page from reaching a server bound to 127.0.0.1.
  const hostHeader = (req.headers.host ?? '').split(':')[0];
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostHeader)) {
    return json(res, 403, { error: 'this dashboard only answers on localhost' });
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const body = PAGE()
      .replace('__LAUNCHPAD_TOKEN__', token)
      // Not a styling flag. It is what puts "demo data" on the screen and in
      // the title, so a screenshot of this can never be mistaken for a
      // screenshot of somebody's real fleet.
      .replace('__LAUNCHPAD_DEMO__', String(demo))
      .replace('__LAUNCHPAD_DEMO_ROOT__', demo ? demoLabel(home) : '');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      // The page holds a write token; a shared cache holding it would be a bug.
      'cache-control': 'no-store',
    });
    res.end(body);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/data') {
    return json(res, 200, dashboardData(home));
  }

  if (req.method === 'GET' && url.pathname === '/api/stream') return stream(res, home);

  /**
   * An app's own icon.
   *
   * The request names a PROJECT, never a file. The path on disk is re-derived
   * here from that project's state, so this cannot be turned into "read any
   * file on the machine" by editing a query string — the same rule the write
   * endpoints follow, and the one that matters most for a GET.
   */
  if (req.method === 'GET' && url.pathname === '/api/icon') {
    const repo = url.searchParams.get('project') ?? '';
    if (!readRegistry(home).projects.some(p => p.path === repo)) {
      return json(res, 404, { error: 'unknown project' });
    }
    const st = readState(repo);
    const icon = st ? detectAssets(repo, st).icon : undefined;
    if (!icon) return json(res, 404, { error: 'no icon' });
    try {
      const buf = readFileSync(join(repo, icon.path));
      // Icons are small; anything this large is not one, and streaming it would
      // block the loop that also serves the live updates.
      if (buf.length > 8 * 1024 * 1024) return json(res, 413, { error: 'icon too large' });
      res.writeHead(200, {
        'content-type': icon.path.toLowerCase().endsWith('.icns') ? 'image/x-icns' : 'image/png',
        // Short: an icon can change, and a stale one on a dashboard about
        // readiness would be its own small lie.
        'cache-control': 'max-age=60',
      });
      res.end(buf);
    } catch {
      json(res, 404, { error: 'icon unreadable' });
    }
    return;
  }

  if (req.method === 'POST') {
    if (req.headers['x-launchpad-token'] !== token) {
      return json(res, 403, { error: 'missing or wrong token — reload the dashboard' });
    }
    const body = await readJson(req);

    /**
     * Register a project. The one endpoint that legitimately takes a path the
     * caller chooses — that is its entire job — so it is the one that has to be
     * strictest about what it accepts.
     *
     * Registering is not onboarding. The interview that works out what a repo
     * is belongs in Claude Code, where it can ask questions; this only adds a
     * directory to the list of things the dashboard watches. A repo that has
     * not been set up still appears, as a row saying so.
     */
    if (url.pathname === '/api/projects/add') {
      const raw = String(body.path ?? '').trim();
      if (!raw) return json(res, 400, { error: 'a path is required' });
      // `~` is what a person types; resolve it rather than creating a directory
      // literally named "~".
      const expanded = raw.startsWith('~') ? join(home, raw.slice(1)) : raw;
      if (!isAbsolute(expanded)) return json(res, 400, { error: 'give an absolute path' });
      if (!existsSync(expanded) || !statSync(expanded).isDirectory()) {
        return json(res, 400, { error: 'no directory there' });
      }
      // A repo is the unit. Registering a random directory would fill the
      // dashboard with rows that can never mean anything.
      if (!existsSync(join(expanded, '.git'))) {
        return json(res, 400, { error: 'that is not a git repository' });
      }
      addProject(expanded, home);
      return json(res, 200, { ok: true, path: expanded });
    }

    /**
     * Answer a "needs you" item that has no other home — a bill accepted or
     * declined, an irreversible act acknowledged, a store's fee noted.
     *
     * Two things make this safe to have on a read-mostly dashboard. It writes
     * one file, `.launchpad/confirmed.yml`, which is launchpad's own record and
     * not the user's code. And it can only write a NAMESPACED id, enforced by
     * `record()` itself — a bare id would land in the same file the scorecard
     * reads, which is how a button on a dashboard could turn a real gap green.
     *
     * It takes a LIST of paths because the question can be account-wide: Apple's
     * $99 is one fact about a person, not nine facts about nine repositories,
     * and answering it in one repo and being asked again in the next is exactly
     * the nagging this whole strip exists to end. Every path is still checked
     * against the registry, one at a time, like every other write here.
     */
    if (url.pathname === '/api/acknowledge') {
      const id = String(body.id ?? '').trim();
      const choice = String(body.choice ?? 'acknowledged').trim() || 'acknowledged';
      if (!id.includes(':')) {
        return json(res, 400, { error: 'that is not a "needs you" id — a scorecard row is confirmed with /api/confirm' });
      }
      const registered = new Set(readRegistry(home).projects.map(p => p.path));
      const raw = Array.isArray(body.paths) ? body.paths : [body.path];
      const paths = raw.map(String).filter(p => registered.has(p));
      if (!paths.length) return json(res, 400, { error: 'unknown project' });
      // Not a free-text field: the page offers a fixed set, and anything else
      // would end up rendered back as "you decided this on <date>".
      if (!['accept', 'decline', 'acknowledged'].includes(choice)) {
        return json(res, 400, { error: 'choice must be accept, decline or acknowledged' });
      }
      if (body.undo === true) {
        for (const p of paths) unconfirm(p, id);
        return json(res, 200, { ok: true, undone: paths.length });
      }
      for (const p of paths) record(p, id, choice);
      return json(res, 200, { ok: true, recorded: paths.length });
    }

    if (url.pathname === '/api/projects/remove') {
      const target = String(body.path ?? '');
      if (!readRegistry(home).projects.some(p => p.path === target)) {
        return json(res, 400, { error: 'unknown project' });
      }
      // The registry holds only paths, so this loses nothing but the listing.
      removeProject(target, home);
      return json(res, 200, { ok: true });
    }
    // A path is only ever accepted if it is already registered. The request
    // never gets to name a directory: it picks one off a list this machine
    // already wrote.
    const registered = new Set(readRegistry(home).projects.map(p => p.path));
    const repo = typeof body.path === 'string' && registered.has(body.path) ? body.path : null;
    if (!repo) return json(res, 400, { error: 'unknown project' });

    switch (url.pathname) {
      case '/api/idea': {
        const text = String(body.text ?? '').trim();
        if (!text) return json(res, 400, { error: 'an idea needs some words' });
        addIdea(repo, text);
        return json(res, 200, { ok: true });
      }
      /**
       * Answer a question launchpad cannot answer by reading the repo.
       *
       * Guarded the same way the CLI is: only a check currently graded `?` may
       * be confirmed. A gap is something launchpad observed, and letting an
       * HTTP request assert it away would hand the false-pass problem to the
       * user's own mouse.
       */
      case '/api/confirm': {
        const check = String(body.check ?? '').trim();
        if (!check) return json(res, 400, { error: 'which check?' });
        const st = readState(repo);
        if (!st) return json(res, 400, { error: 'this project is not set up' });
        if (body.confirmed === false) { unconfirm(repo, check); return json(res, 200, { ok: true }); }
        const target = scorecard(repo, st).checks.find(c => c.id === check);
        if (!target) return json(res, 400, { error: `no check called ${check}` });
        if (!target.answerable && !target.confirmedAt) {
          return json(res, 400, { error: `${check} is not yours to confirm — launchpad can see this one` });
        }
        confirm(repo, check);
        return json(res, 200, { ok: true });
      }
      /**
       * Decide what happens to a pipeline that was already in the repo.
       *
       * The one write here that touches `state.yml`, and it earns that: the
       * 2026-08-02 audit's prerequisite was "make the answers load-bearing
       * before adding prompts; a prompt whose answer nothing enforces is worse
       * than no prompt". `apply` branches on `disposition` and on nothing else,
       * so recording this anywhere but the state file would put a button on the
       * screen that changed no behaviour at all.
       *
       * It writes ONE field on ONE pipeline that is already listed, and it
       * cannot add a pipeline, name a path or touch a surface.
       */
      case '/api/disposition': {
        const path = String(body.pipeline ?? '');
        const to = String(body.disposition ?? '');
        if (!['adopt', 'migrate', 'leave-alone'].includes(to)) {
          return json(res, 400, { error: 'disposition must be adopt, migrate or leave-alone' });
        }
        const st = readState(repo);
        if (!st) return json(res, 400, { error: 'this project is not set up' });
        const pipe = st.pipelines.find(x => x.path === path);
        if (!pipe) return json(res, 400, { error: `no pipeline at ${path} in this project` });
        pipe.disposition = to as typeof pipe.disposition;
        writeState(repo, st);
        return json(res, 200, { ok: true });
      }
      case '/api/nightshift/enabled': {
        const config = readConfig(repo);
        if (!config) return json(res, 400, { error: 'nightshift is not set up in this project' });
        // Enabling something with no gate would start an unattended agent whose
        // work nothing verifies. The CLI refuses this; so does the dashboard.
        if (body.enabled === true && !config.gate.trim()) {
          return json(res, 400, { error: 'set a gate command first — nothing would verify the agent\'s work' });
        }
        writeConfig(repo, { ...config, enabled: body.enabled === true });
        return json(res, 200, { ok: true });
      }
      /**
       * Add a task straight to the queue.
       *
       * Distinct from `/api/idea`, which captures a line for grooming to shape
       * later. This is someone who already knows what they want. It is still a
       * queue action rather than a repo action, so it stays inside the
       * read-mostly line.
       */
      case '/api/task/create': {
        const title = String(body.title ?? '').trim();
        if (!title) return json(res, 400, { error: 'a task needs a title' });
        const status = typeof body.status === 'string' && isStatus(body.status) ? body.status : 'ready';
        const priority = Number.isFinite(body.priority) ? Number(body.priority) : undefined;
        const config = readConfig(repo);
        const t = createTask(repo, { title, body: String(body.body ?? ''), status, priority },
          new Date(), config?.backlogDir);
        return json(res, 200, { ok: true, id: t.id });
      }
      case '/api/task/priority': {
        const id = String(body.id ?? '');
        const priority = Number(body.priority);
        // P0 is "broken for users"; anything past P9 is not a priority, it is
        // a wish, and an unbounded number would sort unpredictably.
        if (!Number.isInteger(priority) || priority < 0 || priority > 9) {
          return json(res, 400, { error: 'priority must be 0-9' });
        }
        const config = readConfig(repo);
        if (!setPriority(repo, id, priority, config?.backlogDir)) {
          return json(res, 404, { error: 'no such task' });
        }
        return json(res, 200, { ok: true });
      }
      case '/api/task': {
        const id = String(body.id ?? '');
        const status = String(body.status ?? '');
        if (!isStatus(status)) return json(res, 400, { error: 'unknown status' });
        const config = readConfig(repo);
        const updated = setStatus(repo, id, status, body.reason ? String(body.reason) : undefined, config?.backlogDir);
        if (!updated) return json(res, 404, { error: 'no such task' });
        return json(res, 200, { ok: true });
      }
      default:
        return json(res, 404, { error: 'not found' });
    }
  }

  json(res, 404, { error: 'not found' });
}

/**
 * Server-sent events, driven by watching the files the dashboard reads.
 *
 * Polling every 30 seconds is the wrong shape for the one genuinely volatile
 * thing here: an overnight run moves through agent → gate → commit → publish,
 * and a 30s poll shows a phase that ended 29 seconds ago — or misses it whole.
 *
 * SSE rather than WebSockets because the traffic is entirely one-way and SSE
 * reconnects by itself. `fs.watch` rather than a database or a message bus
 * because the repos ARE the state: the files change, we notice, we push. There
 * is nothing else to keep in sync and nothing to migrate.
 *
 * **What is watched is the repository, not `.launchpad/`.** It used to be the
 * other way round, and the consequence was that every check the scorecard
 * actually reads — a privacy policy, a workflow, an icon, a dependency —
 * reached the screen only on the floor tick. `watch.ts` holds the arming rules
 * and the argument for why the excluded directories cannot change an answer.
 */
function stream(res: ServerResponse, home: string): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    // Some proxies buffer event streams into uselessness.
    'x-accel-buffering': 'no',
  });

  let last = '';
  const send = () => {
    try {
      const payload = JSON.stringify(dashboardData(home));
      // The client rebuilds the DOM on every message; sending an identical
      // payload would undo a scroll position for no reason.
      if (payload === last) return;
      last = payload;
      res.write(`data: ${payload}\n\n`);
    } catch { /* a bad read must not kill the stream */ }
  };

  /**
   * How live the channel actually is, sent as its own named event.
   *
   * A named event rather than a field on the payload, because this is a fact
   * about *this connection* and not about the fleet — and because `onmessage`
   * must keep receiving nothing but the payload it parses. The page renders it
   * as a line in the sidebar, so "updates are arriving as they happen" and
   * "updates are fifteen seconds behind" are never the same screen.
   */
  let announced = '';
  const announce = () => {
    const n = watchers.notice();
    const body = JSON.stringify(n);
    if (body === announced) return;
    announced = body;
    try { res.write(`event: watch\ndata: ${body}\n\n`); } catch { /* closed */ }
  };

  // Coalesced: a single `git commit` touches many watched paths at once, and
  // one burst should produce one update rather than twenty.
  let timer: NodeJS.Timeout | null = null;
  const nudge = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      // Re-arm first: the change may BE a newly registered project or a
      // `.github/` that did not exist when the connection opened.
      watchers.arm();
      announce();
      send();
    }, 250);
  };

  const watchers = watchFleet({
    home,
    // Read on every arm, so a project registered while the page is open — which
    // is what `--replay` does six times — is watched from then on.
    projects: () => readRegistry(home).projects.map(p => p.path),
    // An adopted backlog lives outside `.launchpad`; not watching it means task
    // status changes never reach the screen.
    backlogDirOf: repo => readConfig(repo)?.backlogDir,
    onChange: nudge,
  });
  watchers.arm();

  // A slow tick as a floor: `fs.watch` is genuinely unreliable on some network
  // and container filesystems, and a dashboard that silently stops updating is
  // worse than one that updates slowly. It is now a backstop rather than the
  // mechanism, and `announce()` says which of the two the page is getting.
  const floor = setInterval(send, 15000);
  // Comments keep the connection alive through proxies that time out idle ones.
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 25000);

  send();
  announce();
  res.on('close', () => {
    clearInterval(floor); clearInterval(ping);
    if (timer) clearTimeout(timer);
    watchers.close();
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** Bounded: an unbounded read on a local server is a trivial way to exhaust it. */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}
