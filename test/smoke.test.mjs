// Does the app boot cleanly? Catches module wiring and missing-element errors
// before the heavier suites run.

import { connect } from './harness.mjs';

const t = await connect();
const { ev, navigate, check } = t;

await navigate();
await t.resetDatabase();
await navigate();

check('page title', await ev(`document.title`), 'The Ledger');
check('stylesheet applied', await ev(`getComputedStyle(document.body).backgroundColor`), 'rgb(27, 31, 43)');
check('main view rendered', await ev(`document.querySelector('h2.section-title')?.textContent.trim()`), 'All Collections');
check('empty state offers a first collection', await ev(`!!document.getElementById('addTileHome')`), true);
check('sync starts off', await ev(`document.getElementById('syncStatusBtn').dataset.state`), 'off');
check('service worker registers', await ev(`navigator.serviceWorker.getRegistrations().then(r => r.length > 0)`), true);
check('manifest is linked', await ev(`!!document.querySelector('link[rel="manifest"]')`), true);

// Every id the modules reach for must exist by the time it is used; the modal
// markup is static, so it can be verified up front.
check('static modal ids present', await ev(`
  ['collOverlay','subOverlay','cardOverlay','confirmOverlay','viewerOverlay','syncOverlay',
   'collName','collColor','subName','subTotal','fName','fRarity','fNumber','fQty','fNotes',
   'effectPicker','linkedSlotsWrap','syncUrl','syncKey','syncEmail','syncPassword','toast','colorCanvas'
  ].filter(id => !document.getElementById(id))`), []);

process.exit(t.finish('smoke') ? 0 : 1);
