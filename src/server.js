// HTTP-server. Inga beroenden. Ingen åtkomstlogg (IP-adresser ska aldrig sparas).
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes, createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import {
  hashPassword, verifyPassword, validPassword, validUsername, createSession, loadSession,
  sha256, token, safeEqual, SESSION_MS,
} from './auth.js';
import { parseQuestions, questionsToSource, validateAnswers, toCsv, LIMITS } from './forms.js';
import * as V from './views.js';

const CSS = readFileSync(fileURLToPath(new URL('../public/style.css', import.meta.url)));
const MAX_BODY = 64 * 1024;

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

/** Rate limiter i minnet. Nyckeln är en HMAC med slumpad nyckel som aldrig lämnar processen. */
function makeLimiter(scale = 1) {
  const key = randomBytes(32);
  const hits = new Map();
  return {
    key: (ip, scope) => createHmac('sha256', key).update(`${scope}|${ip}`).digest('base64url'),
    hit(k, max, windowMs, now = Date.now()) {
      max *= scale;
      const arr = (hits.get(k) ?? []).filter((t) => now - t < windowMs);
      arr.push(now);
      hits.set(k, arr);
      return arr.length > max;
    },
    sweep(now = Date.now()) {
      for (const [k, arr] of hits) if (!arr.some((t) => now - t < 3600000)) hits.delete(k);
    },
  };
}

export function createApp(opts = {}) {
  const cfg = {
    dbPath: opts.dbPath ?? process.env.DB_PATH ?? './data/utvardering.db',
    baseUrl: (opts.baseUrl ?? process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
    secure: opts.secure ?? (process.env.INSECURE_COOKIES !== '1'),
    trustProxy: opts.trustProxy ?? process.env.TRUST_PROXY === '1',
    limitScale: opts.limitScale ?? 1, // endast för tester
  };
  const store = openDb(cfg.dbPath);
  const { st } = store;
  const limiter = makeLimiter(cfg.limitScale);
  const cookieName = cfg.secure ? '__Host-sid' : 'sid';

  const clientIp = (req) => {
    if (cfg.trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
    }
    return req.socket.remoteAddress ?? 'unknown';
  };

  const parseCookies = (req) => {
    const out = {};
    for (const part of (req.headers.cookie ?? '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  };

  const readForm = (req) =>
    new Promise((resolve, reject) => {
      const ct = (req.headers['content-type'] ?? '').split(';')[0].trim();
      if (ct !== 'application/x-www-form-urlencoded') return reject(new HttpError(415, 'Fel innehållstyp'));
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(new HttpError(413, 'För stor förfrågan')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        const body = Object.create(null);
        for (const [k, v] of new URLSearchParams(Buffer.concat(chunks).toString('utf8'))) if (!(k in body)) body[k] = v;
        resolve(body);
      });
      req.on('error', reject);
    });

  function send(res, status, body, type = 'text/html; charset=utf-8', extra = {}) {
    res.writeHead(status, { 'Content-Type': type, ...extra });
    res.end(body);
  }
  const redirect = (res, to, extra = {}) => { res.writeHead(303, { Location: to, ...extra }); res.end(); };

  function baseHeaders(res, admin) {
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
    if (cfg.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (admin) res.setHeader('Cache-Control', 'no-store');
  }

  const sessionCookie = (raw, maxAgeSec) =>
    `${cookieName}=${raw}; Path=/; HttpOnly; SameSite=Strict${cfg.secure ? '; Secure' : ''}; Max-Age=${maxAgeSec}`;

  function newSlug() {
    for (;;) {
      const s = randomBytes(9).toString('base64url');
      if (!st.formBySlug.get(s)) return s;
    }
  }

  function formFromBody(body) {
    const title = (body.title ?? '').trim();
    const description = (body.description ?? '').trim();
    const errors = [];
    if (!title || title.length > LIMITS.title) errors.push('Titel krävs (högst 200 tecken).');
    if (description.length > LIMITS.desc) errors.push('Inledningen är för lång.');
    const parsed = parseQuestions(body.questions);
    errors.push(...parsed.errors);
    let retention = null;
    const rd = (body.retention_days ?? '').trim();
    if (rd !== '') {
      if (!/^\d{1,4}$/.test(rd) || Number(rd) < 1) errors.push('Gallringstid måste vara ett heltal dagar (minst 1) eller tom.');
      else retention = Number(rd);
    }
    return { title, description, questions: parsed.questions, retention, errors, source: String(body.questions ?? '') };
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    const method = req.method;
    const isAdmin = path.startsWith('/admin') || ['/login', '/logout', '/register'].includes(path);
    baseHeaders(res, isAdmin);

    if (method === 'GET' && path === '/static/style.css') return send(res, 200, CSS, 'text/css; charset=utf-8', { 'Cache-Control': 'public, max-age=3600' });
    if (method === 'GET' && path === '/healthz') return send(res, 200, 'ok', 'text/plain');
    if (method === 'GET' && path === '/') return send(res, 200, V.noticeView('Utvärdering', 'Du behöver en länk till en utvärdering för att svara.'));

    const ip = clientIp(req);
    const cookies = parseCookies(req);
    const sess = loadSession(st, cookies[cookieName]);

    // ---------- Svarssidor (öppna, anonyma) ----------
    let m = /^\/s\/([A-Za-z0-9_-]{6,40})$/.exec(path);
    if (m) {
      const f = st.formBySlug.get(m[1]);
      if (!f) return send(res, 404, V.noticeView('Hittades inte', 'Utvärderingen finns inte.'));
      const questions = JSON.parse(f.questions);
      if (method === 'GET') {
        if (!f.open) return send(res, 200, V.noticeView(f.title, 'Den här utvärderingen tar inte längre emot svar.'));
        return send(res, 200, V.answerView(f, questions));
      }
      if (method === 'POST') {
        if (!f.open) return send(res, 200, V.noticeView(f.title, 'Den här utvärderingen tar inte längre emot svar.'));
        if (limiter.hit(limiter.key(ip, 'answer'), 20, 3600000)) throw new HttpError(429, 'För många svar. Försök igen senare.');
        const body = await readForm(req);
        if (body.website) return send(res, 200, V.noticeView('Tack!', 'Ditt svar är registrerat.')); // honeypot: låtsas lyckas
        const { answers, errors } = validateAnswers(questions, body);
        if (errors.length) return send(res, 422, V.answerView(f, questions, { errors, values: body }));
        if (Object.keys(answers).length === 0) return send(res, 422, V.answerView(f, questions, { errors: [], values: body }));
        // Endast datum sparas, aldrig klockslag, IP eller User-Agent.
        st.insResp.run(f.id, new Date().toISOString().slice(0, 10), JSON.stringify(answers));
        return send(res, 200, V.noticeView('Tack!', 'Ditt svar är registrerat.'));
      }
      throw new HttpError(405, 'Metod stöds inte');
    }

    // ---------- Inloggning / registrering ----------
    if (path === '/login') {
      if (method === 'GET') return send(res, 200, V.loginView());
      if (method === 'POST') {
        if (limiter.hit(limiter.key(ip, 'login'), 10, 15 * 60000)) throw new HttpError(429, 'För många försök. Vänta en stund.');
        const body = await readForm(req);
        const u = String(body.username ?? '').slice(0, 64);
        if (limiter.hit(limiter.key(u.toLowerCase(), 'loginuser'), 10, 15 * 60000)) throw new HttpError(429, 'För många försök. Vänta en stund.');
        const user = st.userByName.get(u);
        const ok = await verifyPassword(String(body.password ?? '').slice(0, 200), user?.pw_hash);
        if (!user || !ok) return send(res, 401, V.loginView('Fel användarnamn eller lösenord.'));
        const s = createSession(st, user.id);
        return redirect(res, '/admin', { 'Set-Cookie': sessionCookie(s.raw, SESSION_MS / 1000) });
      }
      throw new HttpError(405, 'Metod stöds inte');
    }

    if (path === '/register') {
      const hasInvite = (t) => typeof t === 'string' && t.length > 10 && t.length < 100 && st.hasInvite.get(sha256(t), new Date().toISOString());
      if (method === 'GET') {
        const t = url.searchParams.get('invite');
        if (!hasInvite(t)) return send(res, 403, V.noticeView('Ogiltig inbjudan', 'Inbjudan är ogiltig eller har gått ut.'));
        return send(res, 200, V.registerView(t));
      }
      if (method === 'POST') {
        if (limiter.hit(limiter.key(ip, 'register'), 10, 3600000)) throw new HttpError(429, 'För många försök.');
        const body = await readForm(req);
        if (!hasInvite(body.invite)) return send(res, 403, V.noticeView('Ogiltig inbjudan', 'Inbjudan är ogiltig eller har gått ut.'));
        if (!validUsername(body.username)) return send(res, 422, V.registerView(body.invite, 'Ogiltigt användarnamn.'));
        if (!validPassword(body.password)) return send(res, 422, V.registerView(body.invite, 'Lösenordet måste vara minst 12 tecken.'));
        if (st.userByName.get(body.username)) return send(res, 422, V.registerView(body.invite, 'Användarnamnet är upptaget.'));
        const hash = await hashPassword(body.password);
        const used = st.delInvite.run(sha256(body.invite), new Date().toISOString());
        if (Number(used.changes) !== 1) return send(res, 403, V.noticeView('Ogiltig inbjudan', 'Inbjudan är ogiltig eller har gått ut.'));
        st.insUser.run(body.username, hash, new Date().toISOString());
        return redirect(res, '/login');
      }
      throw new HttpError(405, 'Metod stöds inte');
    }

    // ---------- Allt under /admin och /logout kräver session ----------
    if (!sess) {
      if (path.startsWith('/admin') || path === '/logout') return redirect(res, '/login');
      return send(res, 404, V.noticeView('Hittades inte', 'Sidan finns inte.'));
    }

    if (path === '/logout' && method === 'POST') {
      const body = await readForm(req);
      if (!safeEqual(body.csrf ?? '', sess.csrf)) throw new HttpError(403, 'Ogiltig begäran');
      st.delSession.run(sha256(cookies[cookieName]));
      return redirect(res, '/login', { 'Set-Cookie': sessionCookie('', 0) });
    }

    // POST kräver CSRF-token
    let body = null;
    if (method === 'POST') {
      body = await readForm(req);
      if (!safeEqual(body.csrf ?? '', sess.csrf)) throw new HttpError(403, 'Ogiltig begäran');
    }

    if (path === '/admin' && method === 'GET') return send(res, 200, V.dashboardView(sess, st.formsByOwner.all(sess.userId), cfg.baseUrl));

    if (path === '/admin/forms/new' && method === 'GET')
      return send(res, 200, V.formEditView(sess, { title: '', description: '', source: 'skala*: Hur nöjd var du totalt?\ntext: Vad kan förbättras?', retention_days: '' }, { isNew: true }));

    if (path === '/admin/forms' && method === 'POST') {
      const f = formFromBody(body);
      if (f.errors.length) return send(res, 422, V.formEditView(sess, { ...f, retention_days: body.retention_days }, { errors: f.errors, isNew: true }));
      const r = st.insForm.run(sess.userId, newSlug(), f.title, f.description, JSON.stringify(f.questions), f.retention, new Date().toISOString());
      return redirect(res, `/admin/forms/${r.lastInsertRowid}`);
    }

    m = /^\/admin\/forms\/(\d{1,12})(\/[a-z-]+(?:\.csv)?)?$/.exec(path);
    if (m) {
      const id = Number(m[1]);
      const sub = m[2] ?? '';
      // Åtkomstkontroll: ägarskap i själva SQL-uppslaget. Annars 404 (avslöjar inte att id finns).
      const f = st.formOwned.get(id, sess.userId);
      if (!f) return send(res, 404, V.noticeView('Hittades inte', 'Utvärderingen finns inte.'));
      const questions = JSON.parse(f.questions);

      if (sub === '' && method === 'GET') {
        const responses = st.respsOwned.all(id, sess.userId).map((r) => ({ day: r.day, answers: JSON.parse(r.answers) }));
        return send(res, 200, V.resultsView(sess, f, questions, responses, cfg.baseUrl));
      }
      if (sub === '/results.csv' && method === 'GET') {
        const responses = st.respsOwned.all(id, sess.userId).map((r) => ({ day: r.day, answers: JSON.parse(r.answers) }));
        return send(res, 200, toCsv(questions, responses), 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="utvardering-${id}.csv"` });
      }
      if (sub === '/edit' && method === 'GET')
        return send(res, 200, V.formEditView(sess, { id, title: f.title, description: f.description, source: questionsToSource(questions), retention_days: f.retention_days, open: f.open }));
      if (sub === '' && method === 'POST') {
        const nf = formFromBody(body);
        const open = body.open === '1' ? 1 : 0;
        if (nf.errors.length) return send(res, 422, V.formEditView(sess, { id, ...nf, retention_days: body.retention_days, open }, { errors: nf.errors }));
        st.updForm.run(nf.title, nf.description, JSON.stringify(nf.questions), open, nf.retention, id, sess.userId);
        return redirect(res, `/admin/forms/${id}`);
      }
      if (sub === '/delete-responses' && method === 'POST') { st.delRespsOwned.run(id, sess.userId); return redirect(res, `/admin/forms/${id}`); }
      if (sub === '/delete' && method === 'POST') { st.delForm.run(id, sess.userId); return redirect(res, '/admin'); }
    }

    return send(res, 404, V.noticeView('Hittades inte', 'Sidan finns inte.'));
  }

  const server = createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error('internt fel:', e?.message); // aldrig förfrågningsdata eller IP
      if (!res.headersSent) {
        baseHeaders(res, true);
        send(res, status, V.noticeView('Något gick fel', status === 500 ? 'Internt fel.' : e.message));
      } else res.end();
    }
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 5000;

  const timer = setInterval(() => { store.purgeExpired(); limiter.sweep(); }, 3600000);
  timer.unref();
  store.purgeExpired();

  return {
    server, store, cfg,
    close() { clearInterval(timer); server.close(); server.closeAllConnections?.(); store.close(); },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createApp();
  const port = Number(process.env.PORT ?? 3000);
  app.server.listen(port, process.env.HOST ?? '127.0.0.1', () => console.log(`Utvärdering lyssnar på port ${port}`));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { app.close(); process.exit(0); });
}

export { token };
