// HTML-mallar. All användardata går via esc(). Inget JavaScript i webbläsaren.
import { summarize, questionsToSource, LIMITS } from './forms.js';

export const esc = (v) =>
  String(v ?? '').replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c]);

function page(title, body, { nav = '' } = {}) {
  return `<!doctype html>
<html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<link rel="stylesheet" href="/static/style.css"></head>
<body><main>${nav}${body}</main></body></html>`;
}

const adminNav = (s) => `<nav><a href="/admin">Mina utvärderingar</a>
<form method="post" action="/logout" class="inline"><input type="hidden" name="csrf" value="${esc(s.csrf)}"><button class="link">Logga ut (${esc(s.username)})</button></form></nav>`;

const csrf = (s) => `<input type="hidden" name="csrf" value="${esc(s.csrf)}">`;

export const loginView = (error = '') =>
  page('Logga in', `<h1>Logga in</h1>${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/login">
<label>Användarnamn<input name="username" autocomplete="username" required maxlength="32"></label>
<label>Lösenord<input name="password" type="password" autocomplete="current-password" required maxlength="200"></label>
<button>Logga in</button></form>`);

export const registerView = (invite, error = '') =>
  page('Skapa konto', `<h1>Skapa konto</h1>${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/register">
<input type="hidden" name="invite" value="${esc(invite)}">
<label>Användarnamn (3–32 tecken: bokstäver, siffror, . _ -)<input name="username" autocomplete="username" required maxlength="32"></label>
<label>Lösenord (minst 12 tecken)<input name="password" type="password" autocomplete="new-password" required minlength="12" maxlength="200"></label>
<button>Skapa konto</button></form>`);

export function dashboardView(s, forms, baseUrl) {
  const rows = forms
    .map((f) => `<li><a href="/admin/forms/${f.id}">${esc(f.title)}</a> <span class="muted">${f.n} svar · ${f.open ? 'öppen' : 'stängd'}</span><br>
<span class="muted">Svarslänk: ${esc(baseUrl)}/s/${esc(f.slug)}</span></li>`)
    .join('');
  return page('Mina utvärderingar', `<h1>Mina utvärderingar</h1>
<p><a class="btn" href="/admin/forms/new">Ny utvärdering</a></p>
${rows ? `<ul class="list">${rows}</ul>` : '<p class="muted">Inga utvärderingar än.</p>'}`, { nav: adminNav(s) });
}

const HELP = `<details><summary>Hur skriver jag frågor?</summary>
<p>En fråga per rad. Lägg till <code>*</code> efter typen för obligatorisk fråga.</p>
<pre>skala*: Hur nöjd var du totalt?
val: Vilken del var bäst? | Föreläsning | Övning | Material
text: Vad kan förbättras?
kontakt: Vill du bli kontaktad? Skriv namn eller e-post (frivilligt)</pre>
<p><b>skala</b> = 1–5, <b>val</b> = ett alternativ, <b>text</b> = fritext, <b>kontakt</b> = frivilligt fält för personuppgifter.</p></details>`;

export function formEditView(s, f, { errors = [], isNew = false } = {}) {
  const action = isNew ? '/admin/forms' : `/admin/forms/${f.id}`;
  return page(isNew ? 'Ny utvärdering' : 'Redigera', `<h1>${isNew ? 'Ny utvärdering' : 'Redigera utvärdering'}</h1>
${errors.length ? `<ul class="err">${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
<form method="post" action="${action}">${csrf(s)}
<label>Titel<input name="title" required maxlength="${LIMITS.title}" value="${esc(f.title)}"></label>
<label>Inledning (valfritt)<textarea name="description" rows="3" maxlength="${LIMITS.desc}">${esc(f.description)}</textarea></label>
<label>Frågor<textarea name="questions" rows="10" required>${esc(f.source)}</textarea></label>${HELP}
<label>Radera svar automatiskt efter (dagar, tomt = aldrig)<input name="retention_days" inputmode="numeric" pattern="[0-9]*" maxlength="4" value="${esc(f.retention_days ?? '')}"></label>
${isNew ? '' : `<label class="row"><input type="checkbox" name="open" value="1"${f.open ? ' checked' : ''}> Tar emot svar</label>`}
<button>Spara</button></form>`, { nav: adminNav(s) });
}

export function resultsView(s, f, questions, responses, baseUrl) {
  const sums = summarize(questions, responses);
  const body = sums
    .map((x) => {
      let inner = '';
      if (x.q.type === 'scale') {
        const max = Math.max(1, ...x.counts);
        inner = `<p>Svar: ${x.n}${x.avg !== null ? ` · medel ${x.avg.toFixed(2)}` : ''}</p><table class="bars">${x.counts
          .map((c, i) => `<tr><td>${i + 1}</td><td><meter min="0" max="${max}" value="${c}"></meter></td><td>${c}</td></tr>`)
          .join('')}</table>`;
      } else if (x.q.type === 'choice') {
        const max = Math.max(1, ...x.counts);
        inner = `<p>Svar: ${x.n}</p><table class="bars">${x.q.options
          .map((o, i) => `<tr><td>${esc(o)}</td><td><meter min="0" max="${max}" value="${x.counts[i]}"></meter></td><td>${x.counts[i]}</td></tr>`)
          .join('')}</table>`;
      } else {
        inner = `<p>Svar: ${x.n}</p><ul class="texts">${x.texts.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;
      }
      return `<section><h3>${esc(x.q.label)}</h3>${inner}</section>`;
    })
    .join('');
  return page(f.title, `<h1>${esc(f.title)}</h1>
<p class="muted">${responses.length} svar · ${f.open ? 'öppen' : 'stängd'}<br>Svarslänk: ${esc(baseUrl)}/s/${esc(f.slug)}</p>
<p><a class="btn" href="/admin/forms/${f.id}/edit">Redigera</a> <a class="btn" href="/admin/forms/${f.id}/results.csv">Ladda ner CSV</a></p>
${body}
<h2>Radera</h2>
<form method="post" action="/admin/forms/${f.id}/delete-responses">${csrf(s)}<button class="danger">Radera alla svar</button></form>
<form method="post" action="/admin/forms/${f.id}/delete">${csrf(s)}<button class="danger">Radera hela utvärderingen</button></form>`, { nav: adminNav(s) });
}

export function answerView(f, questions, { errors = [], values = {} } = {}) {
  const fields = questions
    .map((q) => {
      const bad = errors.includes(q.id) ? ' class="bad"' : '';
      const req = q.required ? ' <span class="muted">(obligatorisk)</span>' : '';
      const v = values[q.id] ?? '';
      let input = '';
      if (q.type === 'scale')
        input = `<div class="scale">${[1, 2, 3, 4, 5].map((n) => `<label class="row"><input type="radio" name="${q.id}" value="${n}"${String(v) === String(n) ? ' checked' : ''}> ${n}</label>`).join('')}</div><p class="muted small">1 = lägst, 5 = högst</p>`;
      else if (q.type === 'choice')
        input = q.options.map((o) => `<label class="row"><input type="radio" name="${q.id}" value="${esc(o)}"${v === o ? ' checked' : ''}> ${esc(o)}</label>`).join('');
      else if (q.type === 'contact')
        input = `<input name="${q.id}" maxlength="${LIMITS.text}" autocomplete="off" value="${esc(v)}"><p class="muted small">Frivilligt. Lämna tomt om du vill vara anonym.</p>`;
      else input = `<textarea name="${q.id}" rows="4" maxlength="${LIMITS.text}">${esc(v)}</textarea>`;
      return `<fieldset${bad}><legend>${esc(q.label)}${req}</legend>${input}</fieldset>`;
    })
    .join('');
  return page(f.title, `<h1>${esc(f.title)}</h1>${f.description ? `<p>${esc(f.description)}</p>` : ''}
<p class="muted">Svaren är anonyma. Vi sparar varken IP-adress eller cookies. Skriv inte personuppgifter om du inte vill det.</p>
${errors.length ? '<p class="err">Kontrollera de markerade frågorna.</p>' : ''}
<form method="post">${fields}
<div class="hp" aria-hidden="true"><label>Lämna tomt<input name="website" tabindex="-1" autocomplete="off"></label></div>
<button>Skicka svar</button></form>`);
}

export const noticeView = (title, text) => page(title, `<h1>${esc(title)}</h1><p>${esc(text)}</p>`);
