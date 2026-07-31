# The Ledger

A private archive for a card collection: collections, series, rarities, binder
pages, an album that turns like a real binder, and a 3D card viewer with
holographic, gold foil and lenticular effects.

It installs to a phone or desktop as a PWA, works fully offline, and optionally
syncs across devices through a Supabase project you own.

## Running it

No build step, no dependencies, no `npm install`.

```sh
npm run dev      # → http://127.0.0.1:8765/
```

Any static file server works — the app is plain HTML, CSS and ES modules. It
does need to be served over `http(s)` rather than opened as a `file://` URL,
because ES modules and service workers both require an origin.

```sh
npm test         # 84 checks in headless Chrome
npm run icons    # regenerate the PWA icons from scripts/make-icons.mjs
```

## Storing and syncing

The app is **local-first**. Every change is written to IndexedDB on the device
straight away, so it is instant and works with no signal. Sync, if configured,
happens afterwards in the background.

Sync is optional. Without it, the app is a self-contained offline archive and
**Export backup** is how data moves between devices. With it, a phone and a
laptop stay in step automatically — see [`docs/SETUP.md`](docs/SETUP.md) for the
ten-minute Supabase setup.

The merge rule is **last-write-wins per row**. Cards edited on different devices
all survive; the same card edited on two devices at once resolves to the later
edit rather than merging field by field. That is the honest trade for a
single-user app that stays this simple — see `js/storage/sync.js`, which says so
in more detail.

"Later" is decided by the server, not by the device that made the edit. A device
also asks only for rows changed since the newest change it has already seen, so
that stamp has to come from one clock: when devices stamped their own, one
running fast could leave another permanently blind to the first's earlier edits,
while still reporting a successful sync.

## Layout

```
index.html               markup: the shell and every modal
css/ledger.css           all styling
js/
  main.js                entry point — wiring and boot
  ui.js                  DOM helpers, theming, image resizing, toasts
  state.js               in-memory tree + every derived reading
  store.js               the storage facade the views talk to
  render.js              all view rendering
  viewer.js              the 3D card viewer
  album.js               the binder drawn as a binder — pocket pages that turn
  backup.js              export / import
  sync-ui.js             the sync settings modal and status pill
  scan.js                "Scan card": the camera and crop screen
  modals/                collection, series, card, confirm
  storage/
    local.js             IndexedDB, tree ⇄ flat rows, the dirty-diff
    supabase.js          hand-rolled Supabase REST client
    sync.js              push / pull / conflict resolution
  lib/idb.js             promise wrapper over IndexedDB
  lib/scan-detect.js     card-edge detection and perspective correction
sw.js                    offline app shell
supabase/schema.sql      tables, row-level security, storage bucket
supabase/migrations/     changes to apply to a project created earlier
test/                    headless-Chrome suites, no test framework
scripts/                 dev server, icon generator
```

### The one idea worth knowing

The views work with a **nested tree** (collections → series → cards). Storage
keeps **flat rows** with a per-row `updatedAt`, `deletedAt` and `dirty` flag.

`js/storage/local.js` bridges the two: `saveTree()` flattens the tree, diffs it
against a shadow snapshot of what was last written, and stamps only the rows
that actually changed. That is what lets two devices merge card by card instead
of overwriting each other's whole document — without any view code needing to
know that sync exists.

## Scanning a card

**Scan card with camera**, on either photo field, opens the phone's own camera.
The photo that comes back goes through `js/lib/scan-detect.js`, which shrinks
it, finds the pixels where brightness changes sharply, works out which straight
lines those pixels lie on, and picks the four that box in the most convincing
card-shaped region. The card is then straightened out of the photo — corners
pulled square, perspective removed — and stored like any other card photo.

Detection is a guess, so the four corners are always shown as draggable handles
over the photo. A wrong guess costs a nudge rather than a retake, and a photo it
cannot read at all still opens with a card-shaped box ready to be dragged into
place.

This is written out by hand rather than pulled from an image library, because a
library would mean the first build step, the first dependency, and several
megabytes added to an app that is meant to install and run offline.

## Deploying

It is a static site. Drop the repo on Cloudflare Pages, Netlify, GitHub Pages or
any static host; there is nothing to build and no server-side component. Serve
it over HTTPS so the service worker and install prompt work.

Nothing secret lives in the repo — the Supabase URL and anon key are entered in
the app's Sync panel and kept in `localStorage` on each device.

## History

This began as `card_ledger.html`, a single 1,869-line file built as a Claude
artifact. It depended on `window.storage`, an API that only exists inside that
sandbox, so it could not run in a normal browser. The first commit in this repo
is that original file; everything since is the port to a real, standalone app.
