# Colony Log — Terrarium Station LLC

Private husbandry, growth and breeding records for the *Furcifer angeli* colony.

**The app is `worker.js`** — a Cloudflare Worker deployed as `colonylog`,
served at
`colony.terrariumstation.com`, storing records in the `terrarium-colony` KV namespace
(binding `COLONY`). Storage is server-side. Every write is timestamped, deletes are
tombstones rather than erasures, and JSON/CSV export is built in.

`index.html` is the retired predecessor: a single-page localStorage build kept only for
history. It is not deployed and must not be restored — one browser cache clear would
have destroyed the only copy of every record.

Access requires the `COLONY_KEY` encrypted variable on the Worker. Nothing here is
indexable: `robots.txt` disallows all and every response carries `noindex`.

## Deploy

Paste `worker.js` into the Worker editor (or PUT it via the API with
`main_module: index.js`), keep the `COLONY` KV binding and the `COLONY_KEY` secret.
