#!/usr/bin/env python3
"""Generate the English public guides and their search index.

Sources, one directory per language:

    docs/pages/<lang>/pages.json   page metadata: slug, group, title, description, nav
    docs/pages/<lang>/<slug>.html  the article body, plain HTML

Output: English to site/docs/<slug>.html, with a search index.
Never edit the generated HTML by hand: change the sources and run

    python3 docs/build.py

Python standard library only.
"""
from pathlib import Path
import argparse, html, json, re, sys

ROOT = Path(__file__).resolve().parents[1]
SITE = 'https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/'
LANGS = ('en',)
DIRS = {'en': ''}

STRINGS = {
    'en': dict(
        name='English', og_locale='en_US',
        groups={'start': 'Get started', 'teach': 'Run a class', 'server': 'Your own server'},
        title_suffix='Aula Lab docs', skip='Skip to content', home='Aula Lab — home',
        section='Docs', search='Search', back_site='About',
        lang_group='Documentation language',
        nav='Documentation sections', foot_status='On your server', foot_note='Docs for the current implementation',
        toc='On this page', pager='Previous and next article', prev='Previous', next='Next',
        footer='Aula Lab · Docs', motto='Learn together. On your own server.',
        search_title='Search the docs', close_search='Close search', search_label='Search query',
        placeholder='For example, backup or Council', search_status='Start typing a title or a question.',
        search_foot='Search runs in your browser', esc='close',
    ),
}

LOGO = '''<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="2" y="2" width="6" height="6" rx="1.6"/><rect x="9" y="2" width="6" height="6" rx="1.6" opacity=".4"/><rect x="16" y="2" width="6" height="6" rx="1.6"/><rect x="2" y="9" width="6" height="6" rx="1.6" opacity=".4"/><rect x="9" y="9" width="6" height="6" rx="1.6"/><rect x="16" y="9" width="6" height="6" rx="1.6" opacity=".4"/><rect x="2" y="16" width="6" height="6" rx="1.6"/><rect x="9" y="16" width="6" height="6" rx="1.6" opacity=".4"/><rect x="16" y="16" width="6" height="6" rx="1.6"/></svg>'''

H2 = re.compile(r'<h2 id="([^"]+)">(.*?)</h2>')
IDS = re.compile(r'\sid="([^"]+)"')
LOCAL_LINK = re.compile(r'href="([a-z0-9-]+\.html|\./)?(#[^"]*)?"')

errors = []

def fail(msg): errors.append(msg)


def tail(slug): return '' if slug == 'index' else slug + '.html'
def public(lang, slug): return SITE + DIRS[lang] + tail(slug)


def rel(frm, to, slug):
    """Link from a page in language `frm` to `slug` in language `to`."""
    if frm == to: return tail(slug) or './'
    return ('../' if DIRS[frm] else '') + DIRS[to] + tail(slug)


def load(src, lang, order):
    meta_path = src / lang / 'pages.json'
    if not meta_path.exists():
        if any((src / lang).glob('*.html')): fail(f'{meta_path}: missing, but {src / lang} has pages')
        return []
    meta = {}
    for m in json.loads(meta_path.read_text(encoding='utf-8')):
        if m.get('slug') in meta: fail(f'{meta_path}: "{m["slug"]}" is listed twice')
        meta[m.get('slug')] = m
    if order is None: order = list(meta)
    for f in sorted((src / lang).glob('*.html')):
        if f.stem not in order: fail(f'{f}: unknown page "{f.stem}"; add it to docs/pages/en/pages.json first')
    pages = []
    for slug in order:
        f = src / lang / (slug + '.html')
        if not f.exists():
            if lang == 'en': fail(f'{f}: missing (every English page listed in pages.json is required)')
            continue
        m = meta.get(slug)
        if not m: fail(f'{meta_path}: no entry for "{slug}", but {f.name} exists'); continue
        for key in ('group', 'title', 'description'):
            if not m.get(key): fail(f'{meta_path}: "{slug}" needs "{key}"')
        if m.get('group') not in STRINGS[lang]['groups']:
            fail(f'{meta_path}: "{slug}" has unknown group "{m.get("group")}" (one of {", ".join(STRINGS[lang]["groups"])})')
        body = '\n' + f.read_text(encoding='utf-8').strip('\n') + '\n'
        pages.append(dict(slug=slug, lang=lang, group=m.get('group'), title=m.get('title', ''),
                          desc=m.get('description', ''), nav=m.get('nav') or m.get('title', ''), body=body))
    return pages


def fix_links(p, have):
    """Check local links and fragments against the English page set."""
    def sub(m):
        target, frag = m.group(1), m.group(2) or ''
        slug = p['slug'] if not target else ('index' if target == './' else target[:-5])
        if slug not in have['en']:
            fail(f'docs/pages/en/{p["slug"]}.html: link to unknown page "{target}"'); return m.group(0)
        if frag[1:] and frag[1:] not in have['en'][slug]:
            fail(f'docs/pages/en/{p["slug"]}.html: link "{target or ""}{frag}" points at a missing id')
        if not target: return m.group(0)
        return f'href="{rel("en", "en", slug)}{frag}"'
    p['body'] = LOCAL_LINK.sub(sub, p['body'])


def switcher(p, have):
    return '<div class="lang-switch" role="group" aria-label="Documentation language"><span class="lang-option" aria-current="true" lang="en">EN</span></div>'


def render(p, pages, have):
    lang, s = p['lang'], STRINGS[p['lang']]
    up = '../' if DIRS[lang] else ''
    i = pages.index(p)
    nav = ''
    for group in dict.fromkeys(v['group'] for v in pages):
        nav += f'<div class="nav-group"><p class="nav-label">{s["groups"][group]}</p><ul>'
        for v in pages:
            if v['group'] == group:
                current = ' aria-current="page"' if v is p else ''
                nav += f'<li><a href="{rel(lang, lang, v["slug"])}"{current}>{v["nav"]}</a></li>'
        nav += '</ul></div>'
    toc = f'<nav class="toc" aria-label="{s["toc"]}"><p class="nav-label">{s["toc"]}</p><ul>' + ''.join(f'<li><a href="#{key}">{title}</a></li>' for key, title in H2.findall(p['body'])) + '</ul></nav>'
    pager = f'<nav class="pager" aria-label="{s["pager"]}">'
    for label, v in [(s['prev'], pages[i - 1] if i else None), (s['next'], pages[i + 1] if i + 1 < len(pages) else None)]:
        pager += f'<a href="{rel(lang, lang, v["slug"])}"><span>{label}</span><strong>{v["title"]} {"→" if label == s["next"] else ""}</strong></a>' if v else '<span></span>'
    pager += '</nav>'
    twins = [l for l in LANGS if p['slug'] in have[l]]
    alternates = ''.join(f'<link rel="alternate" hreflang="{l}" href="{public(l, p["slug"])}">' for l in twins) + f'<link rel="alternate" hreflang="x-default" href="{public(twins[0], p["slug"])}">' if len(twins) > 1 else ''
    og_alt = ''.join(f'<meta property="og:locale:alternate" content="{STRINGS[l]["og_locale"]}">' for l in twins if l != lang)
    desc = html.escape(p['desc'], quote=True)
    home = rel(lang, lang, 'index')
    return f'''<!doctype html>
<html lang="{lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{p['title']} — {s['title_suffix']}</title><meta name="description" content="{desc}"><meta name="theme-color" content="#0f2d69"><meta name="color-scheme" content="light"><link rel="canonical" href="{public(lang, p['slug'])}">{alternates}<meta property="og:type" content="article"><meta property="og:locale" content="{s['og_locale']}">{og_alt}<meta property="og:title" content="{p['title']} — Aula Lab"><meta property="og:description" content="{desc}"><link rel="icon" href="{up}favicon.svg"><link rel="preload" href="/fonts/hse-sans-400.woff2" as="font" type="font/woff2" crossorigin><link rel="stylesheet" href="{up}docs.css"><script src="{up}docs.js" defer></script></head>
<body class="{'overview' if p['slug'] == 'index' else 'guide'}"><a class="skip-link" href="#main">{s['skip']}</a><header class="header"><a class="wordmark" href="/" aria-label="{s['home']}">{LOGO}<span>AULALAB</span></a><a class="header-section" href="{home}">{s['section']}</a><div class="header-actions"><button class="search-trigger" type="button" hidden><span aria-hidden="true">⌕</span> {s['search']} <kbd>⌘ K / Ctrl K</kbd></button>{switcher(p, have)}<a class="back-site" href="/">{s['back_site']} <span aria-hidden="true">↗</span></a></div></header>
<div class="layout"><aside class="sidebar"><details class="mobile-nav" open><summary>{s['nav']} <span aria-hidden="true">⌄</span></summary><nav aria-label="{s['nav']}">{nav}</nav></details><div class="sidebar-foot"><span class="status-dot" aria-hidden="true"></span> {s['foot_status']}<br><span>{s['foot_note']}</span></div></aside>
<main id="main" tabindex="-1"><div class="article-top"><span class="eyebrow">{s['groups'][p['group']]}</span><span class="doc-kind">AULALAB / GUIDE</span></div><article><h1>{p['title']}</h1><p class="lead">{p['desc']}</p><div class="article-body">{p['body']}</div></article>{pager}<footer class="article-footer"><a href="{home}">{s['footer']}</a><span>{s['motto']}</span></footer></main>{toc}</div>
<dialog id="search-dialog" aria-labelledby="search-title"><div class="search-heading"><h2 id="search-title">{s['search_title']}</h2><button class="close-search" type="button" aria-label="{s['close_search']}">×</button></div><label class="sr-only" for="search-input">{s['search_label']}</label><input id="search-input" type="search" placeholder="{s['placeholder']}" autocomplete="off" spellcheck="false" aria-describedby="search-status"><p id="search-status" role="status">{s['search_status']}</p><div id="search-results"></div><div class="search-foot"><span>{s['search_foot']}</span><span><kbd>Esc</kbd> {s['esc']}</span></div></dialog></body></html>'''


def sitemap(site_dir, by_lang):
    """Write a reproducible sitemap for the English docs pages."""
    def entry(loc, alternates=()):
        links = ''.join(f'<xhtml:link rel="alternate" hreflang="{lang}" href="{href}"/>' for lang, href in alternates)
        return f'<url><loc>{loc}</loc>{links}</url>'
    rows = [entry(public('en', p['slug'])) for p in by_lang['en']]
    body = '\n'.join(rows)
    (site_dir / 'sitemap.xml').write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n'
        f'{body}\n</urlset>\n', encoding='utf-8')
    return len(rows)


def index_entries(p):
    plain = lambda x: html.unescape(re.sub('<[^>]+>', ' ', x)).strip()
    url = rel(p['lang'], p['lang'], p['slug'])
    entries = [dict(title=p['title'], section=STRINGS[p['lang']]['groups'][p['group']], url=url, text=p['desc'])]
    chunks = H2.split(p['body'])
    for n in range(1, len(chunks), 3):
        entries.append(dict(title=plain(chunks[n + 1]), section=p['title'], url=url + '#' + chunks[n], text=re.sub(r'\s+', ' ', plain(chunks[n + 2]))))
    return entries


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--pages', type=Path, default=ROOT / 'docs' / 'pages', help='source directory (default: docs/pages)')
    ap.add_argument('--out', type=Path, default=ROOT / 'site' / 'docs', help='output directory (default: site/docs)')
    args = ap.parse_args()

    by_lang = {'en': load(args.pages, 'en', None)}
    if errors: sys.exit('docs/build.py:\n  ' + '\n  '.join(errors))
    # Check every local page link and fragment before writing the generated site.
    have = {lang: {p['slug']: set(IDS.findall(p['body'])) for p in pages} for lang, pages in by_lang.items()}
    for pages in by_lang.values():
        for p in pages: fix_links(p, have)
    if errors: sys.exit('docs/build.py:\n  ' + '\n  '.join(errors))

    for lang, pages in by_lang.items():
        out = args.out / DIRS[lang]
        written = set()
        search = []
        if pages: out.mkdir(parents=True, exist_ok=True)
        for p in pages:
            (out / (p['slug'] + '.html')).write_text(render(p, pages, have), encoding='utf-8')
            written.add(p['slug'] + '.html')
            search += index_entries(p)
        if out.exists():
            # A page whose source was removed must not linger at its old URL.
            for stale in out.glob('*.html'):
                if stale.name not in written: stale.unlink()
            if not pages: (out / 'search-index.json').unlink(missing_ok=True)
        if pages: (out / 'search-index.json').write_text(json.dumps(search, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        print(f'{lang}: {len(pages)} HTML pages and {len(search)} searchable entries in {out}' if pages else f'{lang}: no pages yet (add docs/pages/{lang}/<slug>.html)')
    # Only for the real site: a build into a scratch --out must not touch site/.
    if args.out.resolve() == (ROOT / 'site' / 'docs').resolve():
        print(f'sitemap: {sitemap(args.out.parent, by_lang)} URLs in {args.out.parent / "sitemap.xml"}')
    (args.out / 'favicon.svg').write_text(LOGO.replace('<svg width="24"', '<svg xmlns="http://www.w3.org/2000/svg" width="24"').replace('fill="currentColor"', 'fill="#0f2d69"'), encoding='utf-8')


if __name__ == '__main__':
    main()
