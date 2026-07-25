// Shared test harness: drives headless Chrome over the DevTools protocol using
// only node built-ins, so the test suite needs no npm install either.

const PORT = process.env.LEDGER_PORT || '8765';
const CDP = process.env.LEDGER_CDP || '9222';
// LEDGER_URL points the suites at a deployed build instead of the dev server,
// which is how the production deploy gets smoke-tested.
export const BASE = process.env.LEDGER_URL || `http://127.0.0.1:${PORT}/index.html`;

export async function connect(){
  const targets = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  const page = targets.find(t => t.type === 'page');
  if (!page) throw new Error('No Chrome page target — is the browser running?');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const errors = [];
  const consoleLogs = [];

  function send(method, params = {}){
    const msgId = ++id;
    ws.send(JSON.stringify({ id: msgId, method, params }));
    return new Promise(res => pending.set(msgId, res));
  }

  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)){ pending.get(m.id)(m.result); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown'){
      const d = m.params.exceptionDetails;
      errors.push(d.exception?.description || d.exception?.value || d.text);
    }
    if (m.method === 'Runtime.consoleAPICalled'){
      consoleLogs.push({ kind: m.params.type, text: m.params.args.map(a => a.value ?? a.description ?? '').join(' ') });
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error'){
      errors.push(`${m.params.entry.text} ${m.params.entry.url || ''}`.trim());
    }
  };

  await new Promise(r => ws.onopen = r);
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');

  // Every expression is wrapped so suites can use `await` freely.
  async function ev(expr){
    const r = await send('Runtime.evaluate', {
      expression: `(async () => { return (${expr}); })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }

  const wait = ms => new Promise(r => setTimeout(r, ms));

  async function navigate(url = BASE, settle = 1800){
    await send('Page.navigate', { url });
    await wait(settle);
  }

  async function resetDatabase(){
    await ev(`new Promise(res => { const r = indexedDB.deleteDatabase('the-ledger'); r.onsuccess = r.onerror = r.onblocked = () => res(1); })`);
    await ev(`(localStorage.clear(), 1)`);
  }

  const results = [];
  function check(label, actual, expected){
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    results.push({ ok, label });
    console.log(`  ${ok ? '✓' : '✗'} ${label}` + (ok ? '' :
      `\n      got:      ${JSON.stringify(actual)}\n      expected: ${JSON.stringify(expected)}`));
    return ok;
  }

  function finish(name){
    const failed = results.filter(r => !r.ok).length;
    if (errors.length){
      console.log('\n  uncaught page errors:');
      errors.forEach(e => console.log('    ' + e));
    }
    const total = results.length;
    console.log(`\n${name}: ${total - failed}/${total} checks passed${errors.length ? `, ${errors.length} page error(s)` : ''}`);
    ws.close();
    return failed === 0 && errors.length === 0;
  }

  return { send, ev, wait, navigate, resetDatabase, check, finish, results, errors, consoleLogs };
}
