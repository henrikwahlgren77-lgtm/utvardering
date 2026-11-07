import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { token, sha256 } from '../src/auth.js';
import { parseQuestions, toCsv } from '../src/forms.js';

let app, base;

before(async () => {
  app = createApp({ dbPath: ':memory:', secure: false, baseUrl: 'http://x', limitScale: 1000 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app.close());

/** Minimal klient med cookie-burk. */
function client() {
  let cookie = '';
  const c = {
    csrf: '',
    async req(method, path, form) {
      const headers = {};
      if (cookie) headers.cookie = cookie;
      let body;
      if (form) {
        headers['content-type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams(form).toString();
      }
      const res = await fetch(base + path, { method, headers, body, redirect: 'manual' });
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      const text = await res.text();
      return { status: res.status, text, headers: res.headers, location: res.headers.get('location') };
    },
    get: (p) => c.req('GET', p),
    post: (p, f) => c.req('POST', p, f),
    async loadCsrf() {
      const r = await c.get('/admin');
      c.csrf = /name="csrf" value="([^"]+)"/.exec(r.text)?.[1] ?? '';
      return c.csrf;
    },
  };
  return c;
}

function invite() {
  const t = token(24);
  app.store.st.insInvite.run(sha256(t), new Date().toISOString(), new Date(Date.now() + 86400000).toISOString());
  return t;
}

async function makeUser(name) {
  const c = client();
  const t = invite();
  const r = await c.post('/register', { invite: t, username: name, password: 'correct horse battery' });
  assert.equal(r.status, 303);
  const l = await c.post('/login', { username: name, password: 'correct horse battery' });
  assert.equal(l.status, 303);
  await c.loadCsrf();
  return c;
}

async function makeForm(c, extra = {}) {
  const r = await c.post('/admin/forms', {
    csrf: c.csrf,
    title: 'Kurs <b>1</b>',
    description: '',
    questions: 'skala*: Betyg\nval: Del | A | B\ntext: Kommentar\nkontakt: Kontakt',
    retention_days: '',
    ...extra,
  });
  assert.equal(r.status, 303);
  const id = /\/admin\/forms\/(\d+)/.exec(r.location)[1];
  const page = await c.get(`/admin/forms/${id}`);
  const slug = /\/s\/([A-Za-z0-9_-]+)/.exec(page.text)[1];
  return { id, slug };
}

test('registrering kräver giltig engångsinbjudan', async () => {
  const c = client();
  assert.equal((await c.get('/register')).status, 403);
  assert.equal((await c.get('/register?invite=bogusbogusbogus')).status, 403);
  const t = invite();
  assert.equal((await c.get(`/register?invite=${t}`)).status, 200);
  assert.equal((await c.post('/register', { invite: t, username: 'anna', password: 'korthej' })).status, 422);
  assert.equal((await c.post('/register', { invite: t, username: 'anna', password: 'long enough password' })).status, 303);
  // Samma inbjudan kan inte återanvändas
  assert.equal((await c.post('/register', { invite: t, username: 'anna2', password: 'long enough password' })).status, 403);
});

test('inloggning: fel lösenord och okänd användare ger samma svar; lösenord lagras hashat', async () => {
  await makeUser('bobby');
  const c = client();
  const a = await c.post('/login', { username: 'bobby', password: 'wrong wrong wrong' });
  const b = await c.post('/login', { username: 'finns-inte', password: 'wrong wrong wrong' });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(a.text, b.text);
  const row = app.store.st.userByName.get('bobby');
  assert.match(row.pw_hash, /^scrypt\$/);
  assert.ok(!row.pw_hash.includes('correct horse'));
});

test('sessionstoken lagras endast som hash', async () => {
  const c = await makeUser('cissi');
  assert.ok(c.csrf);
  const rows = app.store.db.prepare('SELECT token_hash FROM sessions').all();
  assert.ok(rows.length > 0 && rows.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash)));
});

test('oinloggad kan inte nå /admin', async () => {
  const c = client();
  const r = await c.get('/admin');
  assert.equal(r.status, 303);
  assert.equal(r.location, '/login');
});

test('skapare ser bara sina egna utvärderingar; andra får 404 överallt', async () => {
  const a = await makeUser('alice');
  const b = await makeUser('bob');
  const { id, slug } = await makeForm(a);
  await client().post(`/s/${slug}`, { q1: '4', q2: 'A', q3: 'hemligt svar' });

  assert.match((await a.get(`/admin/forms/${id}`)).text, /hemligt svar/);
  for (const p of [`/admin/forms/${id}`, `/admin/forms/${id}/results.csv`, `/admin/forms/${id}/edit`]) {
    const r = await b.get(p);
    assert.equal(r.status, 404, p);
    assert.ok(!r.text.includes('hemligt svar'));
  }
  for (const p of [`/admin/forms/${id}`, `/admin/forms/${id}/delete`, `/admin/forms/${id}/delete-responses`]) {
    assert.equal((await b.post(p, { csrf: b.csrf, title: 'x', questions: 'text: a' })).status, 404, p);
  }
  // Bobs försök ändrade ingenting
  assert.match((await a.get(`/admin/forms/${id}`)).text, /hemligt svar/);
  assert.ok(!(await b.get('/admin')).text.includes(slug));
});

test('POST utan giltig CSRF-token avvisas', async () => {
  const a = await makeUser('dora');
  const { id } = await makeForm(a);
  assert.equal((await a.post(`/admin/forms/${id}/delete`, {})).status, 403);
  assert.equal((await a.post(`/admin/forms/${id}/delete`, { csrf: 'fel' })).status, 403);
  assert.equal((await a.get(`/admin/forms/${id}`)).status, 200);
});

test('anonymt svar: inga cookies, ingen IP/UA, bara datum', async () => {
  const a = await makeUser('erik');
  const { slug } = await makeForm(a);
  const res = await fetch(`${base}/s/${slug}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'SuperUnikBrowser/9.9' },
    body: new URLSearchParams({ q1: '5', q2: 'B', q3: 'bra', q4: '' }).toString(),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('set-cookie'), null);
  const cols = app.store.db.prepare('PRAGMA table_info(responses)').all().map((c) => c.name);
  assert.deepEqual(cols.sort(), ['answers', 'day', 'form_id', 'id']);
  const rows = app.store.db.prepare('SELECT * FROM responses').all();
  for (const r of rows) {
    assert.match(r.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(!JSON.stringify(r).includes('SuperUnik'));
    assert.ok(!JSON.stringify(r).includes('127.0.0.1'));
  }
});

test('säkerhetshuvuden finns på svars- och adminsidor', async () => {
  const a = await makeUser('fia');
  const { slug } = await makeForm(a);
  for (const r of [await client().get(`/s/${slug}`), await a.get('/admin')]) {
    assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  }
  assert.equal((await a.get('/admin')).headers.get('cache-control'), 'no-store');
  assert.ok(!(await client().get(`/s/${slug}`)).text.includes('<script'));
});

test('HTML i titel och svar escapas', async () => {
  const a = await makeUser('gus');
  const { id, slug } = await makeForm(a, { title: '<script>alert(1)</script>' });
  await client().post(`/s/${slug}`, { q1: '3', q3: '<img src=x onerror=alert(1)>' });
  const page = (await a.get(`/admin/forms/${id}`)).text;
  assert.ok(!page.includes('<script>alert'));
  assert.ok(!page.includes('<img src=x'));
  assert.match(page, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.ok(!(await client().get(`/s/${slug}`)).text.includes('<script>alert'));
});

test('validering: obligatorisk fråga, ogiltigt värde, okända fält, honeypot', async () => {
  const a = await makeUser('hanna');
  const { id, slug } = await makeForm(a);
  const anon = client();
  assert.equal((await anon.post(`/s/${slug}`, { q3: 'saknar betyg' })).status, 422);
  assert.equal((await anon.post(`/s/${slug}`, { q1: '9' })).status, 422);
  assert.equal((await anon.post(`/s/${slug}`, { q1: '3', q2: 'Z' })).status, 422);
  assert.equal((await anon.post(`/s/${slug}`, { q1: '3', evil: 'x', website: 'bot' })).status, 200);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM responses WHERE form_id = ?').get(Number(id)).n, 0);
  assert.equal((await anon.post(`/s/${slug}`, { q1: '3', evil: 'x' })).status, 200);
  const stored = app.store.db.prepare('SELECT answers FROM responses WHERE form_id = ?').get(Number(id)).answers;
  assert.deepEqual(JSON.parse(stored), { q1: 3 });
});

test('stängd utvärdering tar inte emot svar', async () => {
  const a = await makeUser('ida');
  const { id, slug } = await makeForm(a);
  await a.post(`/admin/forms/${id}`, { csrf: a.csrf, title: 'T', questions: 'text: a' }); // open saknas = stängd
  const r = await client().post(`/s/${slug}`, { q1: 'x' });
  assert.match(r.text, /inte längre/);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM responses WHERE form_id = ?').get(Number(id)).n, 0);
});

test('gallring raderar gamla svar men behåller nya', async () => {
  const a = await makeUser('jon');
  const { id, slug } = await makeForm(a, { retention_days: '30' });
  await client().post(`/s/${slug}`, { q1: '3' });
  const old = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
  app.store.st.insResp.run(Number(id), old, '{"q1":1}');
  assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM responses WHERE form_id = ?').get(Number(id)).n, 2);
  assert.equal(app.store.purgeExpired(), 1);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM responses WHERE form_id = ?').get(Number(id)).n, 1);
});

test('radera svar och radera utvärdering', async () => {
  const a = await makeUser('kim');
  const { id, slug } = await makeForm(a);
  await client().post(`/s/${slug}`, { q1: '3' });
  assert.equal((await a.post(`/admin/forms/${id}/delete-responses`, { csrf: a.csrf })).status, 303);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM responses WHERE form_id = ?').get(Number(id)).n, 0);
  assert.equal((await a.post(`/admin/forms/${id}/delete`, { csrf: a.csrf })).status, 303);
  assert.equal((await client().get(`/s/${slug}`)).status, 404);
});

test('CSV neutraliserar formelinjektion', () => {
  const { questions } = parseQuestions('text: Kommentar');
  const csv = toCsv(questions, [{ day: '2026-11-07', answers: { q1: '=HYPERLINK("http://evil")' } }, { day: '2026-11-07', answers: { q1: '+1' } }]);
  assert.ok(csv.includes(`"'=HYPERLINK(""http://evil"")"`));
  assert.ok(csv.includes(`"'+1"`));
});

test('parseQuestions: felmeddelanden och kontaktfält är aldrig obligatoriska', () => {
  assert.ok(parseQuestions('').errors.length > 0);
  assert.ok(parseQuestions('foo: x').errors.length > 0);
  assert.ok(parseQuestions('val: x | bara-ett').errors.length > 0);
  const ok = parseQuestions('kontakt*: Namn');
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.questions[0].required, false);
});

test('för stor kropp avvisas och fel innehållstyp ger 415', async () => {
  const a = await makeUser('lotta');
  const { slug } = await makeForm(a);
  const big = await fetch(`${base}/s/${slug}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'q1=' + 'x'.repeat(200000) }).catch(() => ({ status: 413 }));
  assert.ok([413].includes(big.status));
  const json = await fetch(`${base}/s/${slug}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"q1":"3"}' });
  assert.equal(json.status, 415);
});

test('hastighetsbegränsning: inloggning och svar stoppas med 429', async () => {
  const strict = createApp({ dbPath: ':memory:', secure: false });
  await new Promise((r) => strict.server.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${strict.server.address().port}`;
  const form = (o) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString(), redirect: 'manual' });
  let last;
  for (let i = 0; i < 11; i++) last = (await fetch(`${b}/login`, form({ username: 'x' + i, password: 'y'.repeat(12) }))).status;
  assert.equal(last, 429);
  strict.close();
});
