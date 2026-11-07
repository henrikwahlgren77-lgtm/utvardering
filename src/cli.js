// Administration: skapa inbjudningar och återställa lösenord.
//   node src/cli.js invite [dagar]
//   node src/cli.js passwd <användarnamn>   (lösenord läses från stdin, aldrig som argument)
import { openDb } from './db.js';
import { token, sha256, hashPassword, validPassword } from './auth.js';

const dbPath = process.env.DB_PATH ?? './data/utvardering.db';
const base = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const [cmd, arg] = process.argv.slice(2);
const store = openDb(dbPath);

if (cmd === 'invite') {
  const days = Math.min(Math.max(Number(arg) || 3, 1), 30);
  const t = token(24);
  const now = new Date();
  store.st.insInvite.run(sha256(t), now.toISOString(), new Date(now.getTime() + days * 86400000).toISOString());
  console.log(`Engångsinbjudan (giltig ${days} dagar):\n${base}/register?invite=${t}`);
} else if (cmd === 'passwd' && arg) {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const pw = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  const user = store.st.userByName.get(arg);
  if (!user) { console.error('Okänd användare.'); process.exit(1); }
  if (!validPassword(pw)) { console.error('Lösenordet måste vara minst 12 tecken.'); process.exit(1); }
  store.st.setPw.run(await hashPassword(pw), user.id);
  store.st.delUserSessions.run(user.id);
  console.log('Lösenordet är uppdaterat och alla sessioner är avslutade.');
} else {
  console.error('Användning: node src/cli.js invite [dagar] | passwd <användarnamn>');
  process.exit(2);
}
store.close();
