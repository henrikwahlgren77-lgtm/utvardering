// Frågedefinitioner: parsning av editorns radformat, validering av svar, sammanställning, CSV.
export const LIMITS = { questions: 50, options: 20, text: 2000, label: 300, title: 200, desc: 2000 };

/**
 * Radformat, en fråga per rad:
 *   skala: Hur nöjd var du?
 *   val: Vilken del var bäst? | Föreläsning | Övning
 *   text: Vad kan förbättras?
 *   kontakt: Namn eller kontakt (frivilligt)
 * Lägg till "*" efter typen för obligatorisk fråga, t.ex. "skala*: ...".
 */
const TYPES = { skala: 'scale', val: 'choice', text: 'text', kontakt: 'contact' };
const NAMES = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [v, k]));

export function parseQuestions(src) {
  const errors = [];
  const questions = [];
  const lines = String(src ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) errors.push('Minst en fråga krävs.');
  if (lines.length > LIMITS.questions) errors.push(`Högst ${LIMITS.questions} frågor.`);
  lines.slice(0, LIMITS.questions).forEach((line, i) => {
    const m = /^(skala|val|text|kontakt)(\*)?\s*:\s*(.+)$/i.exec(line);
    if (!m) return errors.push(`Rad ${i + 1}: okänt format. Börja med skala:, val:, text: eller kontakt:`);
    const type = TYPES[m[1].toLowerCase()];
    const required = Boolean(m[2]);
    const parts = m[3].split('|').map((s) => s.trim());
    const label = parts[0];
    if (!label || label.length > LIMITS.label) return errors.push(`Rad ${i + 1}: frågetexten saknas eller är för lång.`);
    const q = { id: `q${i + 1}`, type, label, required };
    if (type === 'choice') {
      q.options = parts.slice(1).filter(Boolean);
      if (q.options.length < 2) return errors.push(`Rad ${i + 1}: "val" kräver minst två alternativ, skilj med |.`);
      if (q.options.length > LIMITS.options || q.options.some((o) => o.length > 100))
        return errors.push(`Rad ${i + 1}: för många eller för långa alternativ.`);
    }
    if (type === 'contact') q.required = false; // personuppgifter är alltid frivilliga
    questions.push(q);
  });
  return { questions, errors };
}

export function questionsToSource(questions) {
  return questions
    .map((q) => `${NAMES[q.type]}${q.required ? '*' : ''}: ${q.label}${q.type === 'choice' ? ' | ' + q.options.join(' | ') : ''}`)
    .join('\n');
}

/** Validerar inkommande fält mot frågorna. Okända fält ignoreras. */
export function validateAnswers(questions, body) {
  const answers = {};
  const errors = [];
  for (const q of questions) {
    const raw = body[q.id];
    const v = typeof raw === 'string' ? raw.trim() : '';
    if (v === '') {
      if (q.required) errors.push(q.id);
      continue;
    }
    if (q.type === 'scale') {
      if (!/^[1-5]$/.test(v)) { errors.push(q.id); continue; }
      answers[q.id] = Number(v);
    } else if (q.type === 'choice') {
      if (!q.options.includes(v)) { errors.push(q.id); continue; }
      answers[q.id] = v;
    } else {
      if (v.length > LIMITS.text) { errors.push(q.id); continue; }
      answers[q.id] = v;
    }
  }
  return { answers, errors };
}

export function summarize(questions, responses) {
  return questions.map((q) => {
    const vals = responses.map((r) => r.answers[q.id]).filter((v) => v !== undefined);
    const s = { q, n: vals.length };
    if (q.type === 'scale') {
      s.counts = [1, 2, 3, 4, 5].map((k) => vals.filter((v) => v === k).length);
      s.avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    } else if (q.type === 'choice') {
      s.counts = q.options.map((o) => vals.filter((v) => v === o).length);
    } else {
      s.texts = vals;
    }
    return s;
  });
}

// Neutralisera formelinjektion i kalkylprogram.
function csvCell(v) {
  let s = v === undefined || v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(questions, responses) {
  const head = ['datum', ...questions.map((q) => q.label)].map(csvCell).join(',');
  const rows = responses.map((r) => [r.day, ...questions.map((q) => r.answers[q.id])].map(csvCell).join(','));
  return '﻿' + [head, ...rows].join('\r\n') + '\r\n';
}
