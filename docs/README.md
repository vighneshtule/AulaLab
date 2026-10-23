# Public documentation

The guides are plain English HTML in `docs/pages/en/`, rendered by `python3 docs/build.py` into `site/docs/`. They need no Node.js runtime, external CDN, or client router. Search, code copying, and mobile navigation progressively enhance ordinary HTML navigation.

Article bodies live in `docs/pages/en/<slug>.html`; page metadata (slug, group, title, description, menu order) lives in `docs/pages/en/pages.json`. The shared HTML template lives in `docs/build.py`. Edit the sources, then regenerate the guides and search index using the Python standard library:

```sh
python3 docs/build.py
```

Commit the regenerated `site/docs` (HTML and `search-index.json`) together with the source change: the **Docs up to date** workflow (`.github/workflows/docs-check.yml`) rebuilds it and fails when the committed output differs. When you delete a page, remove its generated `site/docs/<slug>.html` too. Styles and browser behavior live in `site/docs/docs.css` and `site/docs/docs.js`; they reuse the landing page's local fonts and palette.

For local preview, from the repository root:

```sh
python3 -m http.server 8766 --bind 127.0.0.1 --directory site
```

Open `http://127.0.0.1:8766/docs/`. Preview through HTTP; `file://` does not provide the same search fetch or root-relative font paths.

Keep claims aligned with `shared/rules.ts`, `shared/publish.ts`, room/admin components, runtime/deployment scripts, and verified deployment records. A successful static-site check is not a VM, networking, backup, or GPU readiness claim. A release bundle does not contain the complete source checkout or its Makefile.
