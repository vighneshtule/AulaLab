/**
 * The github.com/vighneshtule/AulaLab mirror must stay a mirror, not a second site.
 *
 * The worker from deploy/cloudflare/aulalab-cc/ lives at the Cloudflare edge,
 * and there is no way to see it break except through a visitor's complaint:
 * it has no logs, a deploy takes a second, and its bugs are exactly the kind
 * that look like a working site. So what is checked here is not "it
 * responds" but four properties, each of which would already have cost a
 * separate investigation.
 *
 * 1. A visitor does not leave the mirror. GitHub Pages answers /docs (without
 *    the slash) with a redirect to the ABSOLUTE https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/ — and
 *    without rewriting Location a person who was given a github.com/vighneshtule/AulaLab link ends
 *    up on example.edu after the very first click. This is exactly why the
 *    mirror is not a single DNS record.
 *
 * 2. A search engine sees ONE site. The page body is not changed by a single
 *    byte, and the <link rel=canonical>, og:url and hreflang in it keep naming
 *    example.edu. The temptation "since we rewrite Location anyway, let us
 *    rewrite canonical too" ends with two identical sites competing with each
 *    other in the results.
 *
 * 3. A foreign address in Location is left alone. A naive "replace example.edu
 *    with github.com/vighneshtule/AulaLab" rule would send a redirect to github.com to a
 *    nonexistent mirror page.
 *
 * 4. An upstream error does not get stuck in the cache. Pages was down for a
 *    minute — the mirror must not keep serving its 500 for five more.
 *
 * It also guards small things that are more expensive to fix later: that
 * Host does not travel to Pages (if it did, Pages would return "There isn't a
 * GitHub Pages site here", because site/CNAME holds a single name), that a
 * conditional request makes it to the upstream (otherwise a 304 never
 * happens), and that the mirror can do nothing besides GET and HEAD.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKER = resolve(ROOT, 'deploy/cloudflare/aulalab-cc/worker.js')

// A dynamic import rather than a static one: worker.js is a real .js without
// types, and that is how other tests that need a non-TypeScript module take it
// too.
const mod = (await import(pathToFileURL(WORKER).href)) as {
  default: { fetch(request: Request): Promise<Response> }
  rewriteVisibleDomain(text: string): string
  VISIBLE_DOMAIN_SELECTOR: string
  twinHref(html: string): string | null
  previewTags(html: string): Map<string, string>
  mirrorPreviewImage(content: string): string | null
  previewContent(
    key: string,
    own: string | null,
    tags: Map<string, string> | null,
    ogUrl: string,
  ): string | null
}
const worker = mod.default
const {
  rewriteVisibleDomain,
  VISIBLE_DOMAIN_SELECTOR,
  twinHref,
  previewTags,
  mirrorPreviewImage,
  previewContent,
} = mod

type Call = { url: string; headers: Headers; method: string; cf: Record<string, unknown> }

const realFetch = globalThis.fetch

/**
 * Ask the mirror while slipping it our own response instead of the real
 * example.edu.
 *
 * Returns both the response to the visitor and what the worker sent to the
 * upstream: half of the checks here are about the latter.
 */
async function ask(
  target: string,
  upstream: (url: URL) => Response,
  init: RequestInit = {},
): Promise<{ response: Response; calls: Call[] }> {
  const calls: Call[] = []
  globalThis.fetch = (async (input: unknown, opts: Record<string, unknown> = {}) => {
    calls.push({
      url: String(input),
      headers: new Headers((opts.headers as HeadersInit) ?? {}),
      method: String(opts.method ?? 'GET'),
      cf: (opts.cf as Record<string, unknown>) ?? {},
    })
    return upstream(new URL(String(input)))
  }) as unknown as typeof fetch
  try {
    return { response: await worker.fetch(new Request(target, init)), calls }
  } finally {
    globalThis.fetch = realFetch
  }
}

const page = (body = '<html></html>', init: ResponseInit = {}) =>
  new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' }, ...init })

/**
 * An HTMLRewriter stub — just enough to check the WIRING.
 *
 * The real HTMLRewriter lives only at the Cloudflare edge, and what needs
 * checking is not it but how the worker talks to it: the right selector, text
 * chunks glued together correctly, no replacement leaking into <head>. So the
 * stub repeats its contract in the two places where the worker has a chance
 * to get it wrong.
 *
 * First: `body .host` really means "only inside body". If `body` is ever
 * removed from the selector, the caption in <head> starts getting replaced —
 * and the test will say so.
 *
 * Second: text arrives in CHUNKS. The stub deliberately cuts it fine, four
 * characters at a time, so that "example.edu" is guaranteed to be split by a
 * boundary. This way the accumulator in the worker is tested, not bypassed.
 *
 * Third (since previews appeared): the element() handler walks TAGS, not
 * text, and its selector starts with "head ". The stub parses exactly the
 * form used in the worker — `head <tag>[<attribute>^="<prefix>"]` — and
 * applies such handlers only to the page head. It rejects a broader selector:
 * the editable area in <head> would widen silently, and that costs the
 * canonical and hreflang.
 */
type Chunk = {
  text: string
  lastInTextNode: boolean
  replace(text: string, options?: { html?: boolean }): void
  remove(): void
}

type Element = {
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
}

type TextHandler = { text(chunk: Chunk): void }
type ElementHandler = { element(el: Element): void }

const everyFour = (s: string): string[] => s.match(/[\s\S]{1,4}/g) ?? ['']

/** A parsed preview selector: the tag and the attribute it starts with. */
type Selector = { tag: string; attr: string; prefix: string }

/** `head meta[property^="og:"]` → the predicate "this tag is ours". */
function parseElementSelector(one: string): Selector {
  assert.ok(one.startsWith('head '), `the preview selector must be inside head: ${one}`)
  const parsed = /^head ([a-z]+)\[([a-z-]+)\^="([^"]*)"\]$/.exec(one)
  assert.ok(parsed, `the stub does not understand the selector: ${one}`)
  return { tag: parsed[1], attr: parsed[2], prefix: parsed[3] }
}

class ShimHTMLRewriter {
  private handlers: Array<{ classes: string[]; handler: TextHandler }> = []
  private elements: Array<Selector & { handler: ElementHandler }> = []

  on(selector: string, handler: TextHandler | ElementHandler): this {
    if ('element' in handler) {
      for (const part of selector.split(',')) {
        this.elements.push({ ...parseElementSelector(part.trim()), handler })
      }
      return this
    }
    const classes: string[] = []
    for (const part of selector.split(',')) {
      const one = part.trim()
      // Anything that does not start with "body " is deliberately unsupported
      // by the stub: it must not silently widen the replacement area.
      assert.ok(one.startsWith('body .'), `the selector must be inside body: ${one}`)
      classes.push(one.slice('body .'.length))
    }
    this.handlers.push({ classes, handler })
    return this
  }

  transform(response: Response): Response {
    const handlers = this.handlers
    const elements = this.elements
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const html = await response.text()
        // Replacement happens only inside body, as the selector asks; preview
        // tags only in the head.
        const at = html.indexOf('<body')
        const head = at === -1 ? '' : html.slice(0, at)
        const rest = at === -1 ? html : html.slice(at)
        controller.enqueue(
          new TextEncoder().encode(
            ShimHTMLRewriter.applyElements(head, elements) + ShimHTMLRewriter.apply(rest, handlers),
          ),
        )
        controller.close()
      },
    })
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }

  private static applyElements(
    html: string,
    elements: Array<Selector & { handler: ElementHandler }>,
  ): string {
    if (!elements.length) return html
    const TAG = /<([a-z]+)\b([^>]*?)(\/?)>/gi
    return html.replace(TAG, (whole, tag: string, attrs: string, slash: string) => {
      let next = attrs
      const read = (name: string): string | null => {
        const found = new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(next)
        return found ? found[1] : null
      }
      const mine = elements.filter(
        (one) => one.tag === tag.toLowerCase() && (read(one.attr) ?? '').startsWith(one.prefix),
      )
      if (!mine.length) return whole
      const el: Element = {
        getAttribute: read,
        setAttribute(name, value) {
          const at = new RegExp(`(\\s${name}=")([^"]*)(")`, 'i')
          next = at.test(next)
            ? next.replace(at, (_all, before: string, _old: string, after: string) => before + value + after)
            : `${next} ${name}="${value}"`
        },
      }
      for (const one of mine) one.handler.element(el)
      return `<${tag}${next}${slash}>`
    })
  }

  private static apply(
    html: string,
    handlers: Array<{ classes: string[]; handler: { text(chunk: Chunk): void } }>,
  ): string {
    return html.replace(
      /<([a-z]+)([^>]*\sclass="([^"]*)"[^>]*)>([^<]*)<\/\1>/gi,
      (whole, tag: string, attrs: string, cls: string, inner: string) => {
        const names = cls.split(/\s+/)
        const found = handlers.find((h) => h.classes.some((c) => names.includes(c)))
        if (!found) return whole
        const pieces = everyFour(inner)
        let out = ''
        pieces.forEach((piece, i) => {
          let emitted = piece
          found.handler.text({
            text: piece,
            lastInTextNode: i === pieces.length - 1,
            replace: (text: string) => { emitted = text },
            remove: () => { emitted = '' },
          })
          out += emitted
        })
        return `<${tag}${attrs}>${out}</${tag}>`
      },
    )
  }
}

// The worker calls HTMLRewriter as a global — that is how Workers declares it.
// The stub is put in place once for the whole file.
;(globalThis as Record<string, unknown>).HTMLRewriter = ShimHTMLRewriter

test('the path and the query reach the upstream as they are, but Host does not', async () => {
  const { response, calls } = await ask(
    'https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/install.html?q=%D1%8F%D0%B4%D1%80%D0%BE&v=2#top',
    () => page(),
    { headers: { cookie: 'a=1', 'x-forwarded-host': 'evil.example', 'if-none-match': '"abc"' } },
  )
  assert.equal(response.status, 200)
  assert.equal(calls.length, 1)

  const asked = new URL(calls[0].url)
  assert.equal(asked.hostname, 'example.edu', 'requests must go to the upstream, not to the mirror itself')
  assert.equal(asked.pathname, '/docs/en/install.html')
  assert.equal(asked.search, '?q=%D1%8F%D0%B4%D1%80%D0%BE&v=2')

  // Host is set by the subrequest URL; the incoming github.com/vighneshtule/AulaLab must not reach
  // Pages — it is the one header that would make Pages answer "no site
  // here".
  assert.equal(calls[0].headers.get('host'), null)
  assert.equal(calls[0].headers.get('x-forwarded-host'), null)
  // Cookies play no part in the mirror at all: it has none of its own, and
  // there is no reason to carry anyone else's.
  assert.equal(calls[0].headers.get('cookie'), null)
  // But a conditional request must make it to the upstream, otherwise there
  // will never be a 304 and the mirror will download the page anew on every
  // F5.
  assert.equal(calls[0].headers.get('if-none-match'), '"abc"')
})

test("a redirect's Location is rewritten to the mirror, but a foreign one is not", async () => {
  // Exactly what Pages answers /docs with: an absolute upstream address.
  const absolute = await ask('https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/docs', () =>
    new Response(null, { status: 301, headers: { location: 'https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/' } }))
  assert.equal(absolute.response.status, 301)
  assert.equal(absolute.response.headers.get('location'), 'https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/docs/')

  // A relative Location counts as "ours" too: without a base there is no way
  // to answer "whose address is this", and left as it is it would take the
  // browser to the mirror's address — but that has to be checked, not hoped
  // for.
  const relative = await ask('https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/docs', () =>
    new Response(null, { status: 301, headers: { location: '/docs/' } }))
  assert.equal(relative.response.headers.get('location'), 'https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/docs/')

  // The query is not lost in the rewrite.
  const withQuery = await ask('https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/x', () =>
    new Response(null, { status: 302, headers: { location: 'https://github.com/vighneshtule/AulaLab/y?a=1' } }))
  assert.equal(withQuery.response.headers.get('location'), 'https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/y?a=1')

  // A foreign address stays foreign: a naive substring replacement would send
  // the person to a nonexistent mirror page.
  const foreign = await ask('https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/x', () =>
    new Response(null, { status: 302, headers: { location: 'https://github.com/vighneshtule/AulaLab' } }))
  assert.equal(foreign.response.headers.get('location'), 'https://github.com/vighneshtule/AulaLab')
})

// The landing page's real footer and a real course address, word for word from
// site/.
const LANDING = [
  '<html><head>',
  '<link rel="canonical" href="https://github.com/vighneshtule/AulaLab/" />',
  '<meta property="og:url" content="https://github.com/vighneshtule/AulaLab/" />',
  '<meta property="og:image" content="https://github.com/vighneshtule/AulaLab/img/og.png?v=30b2e08a" />',
  '<link rel="alternate" hreflang="en" href="https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/" />',
  // A caption with the same class but in the head: the replacement must not
  // reach here.
  '<span class="host">example.edu</span>',
  '</head><body>',
  '<a href="https://github.com/vighneshtule/AulaLab">GitHub</a>',
  '<a class="host" href="mailto:sleep3r@icloud.com">sleep3r@icloud.com</a>',
  '<span class="host">example.edu</span>',
  '<p class="note">Семинар открывается на hse.example.edu</p>',
  '</body></html>',
].join('\n')

test('the visible domain becomes the mirror, but the page head does not', async () => {
  // NOT the root is requested: at the root the preview tags are now replaced,
  // and that is checked separately below. This is about everything else: the
  // page comes from the upstream byte for byte, except for one footer line.
  const { response } = await ask('https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/docs/networking.html', () => page(LANDING))
  const out = await response.text()

  // The caption in the footer is the only thing that changed.
  assert.ok(out.includes('<body>\n<a href="https://github.com/vighneshtule/AulaLab">GitHub</a>'))
  assert.ok(out.includes('<span class="host">github.com/vighneshtule/AulaLab</span>'), 'the footer must name the mirror')

  // The head is untouched in every line: a search engine is supposed to see
  // ONE canonical site, not two identical copies.
  const head = out.slice(0, out.indexOf('<body'))
  assert.ok(head.includes('<link rel="canonical" href="https://github.com/vighneshtule/AulaLab/" />'))
  assert.ok(head.includes('<meta property="og:url" content="https://github.com/vighneshtule/AulaLab/" />'))
  assert.ok(head.includes('content="https://github.com/vighneshtule/AulaLab/img/og.png?v=30b2e08a"'))
  assert.ok(head.includes('hreflang="en" href="https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/"'))
  assert.ok(head.includes('<span class="host">example.edu</span>'), 'there must be no replacement in <head>')

  // Links are left alone: they are either root-relative or absolute on
  // purpose.
  assert.ok(out.includes('href="https://github.com/vighneshtule/AulaLab"'))
  // The author's email has the same class, but its text has no domain — and
  // it stays itself entirely, address included.
  assert.ok(out.includes('<a class="host" href="mailto:sleep3r@icloud.com">sleep3r@icloud.com</a>'))
  // A class's name lives in the example.edu zone on the relay, and it does not
  // exist in .cc.
  assert.ok(out.includes('hse.example.edu'), "the relay's subdomain must not be replaced")

  // And line by line: nothing changed except one footer line.
  const before = LANDING.split('\n')
  const after = out.split('\n')
  assert.equal(after.length, before.length)
  const changed = before.map((line, i) => [i, line, after[i]] as const).filter(([, a, b]) => a !== b)
  assert.deepEqual(changed, [[9, '<span class="host">example.edu</span>', '<span class="host">github.com/vighneshtule/AulaLab</span>']])
})

test("a course's address on its page becomes the mirror's address too", async () => {
  const course = '<html><head></head><body><p class="addr">example.edu/c/ml-strong</p></body></html>'
  const { response } = await ask('https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/c/ml-strong/', () => page(course))
  assert.equal(
    await response.text(),
    '<html><head></head><body><p class="addr">github.com/vighneshtule/AulaLab/c/ml-strong</p></body></html>',
  )
})

test('the replacement survives text split between chunks', async () => {
  // The stub cuts text four characters at a time, so "example.edu" is
  // guaranteed to be split: without the accumulator the replacement would not
  // happen at all, and without chunk.remove() the start of the line would
  // reach the reader twice.
  const html = '<html><head></head><body><p class="addr">пиши на example.edu/docs/ сюда</p></body></html>'
  const { response } = await ask('https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/', () => page(html))
  assert.equal(
    await response.text(),
    '<html><head></head><body><p class="addr">пиши на github.com/vighneshtule/AulaLab/docs/ сюда</p></body></html>',
  )
})

test("domain replacement knows the name's boundaries", () => {
  // Checked separately from markup: these boundaries cannot be made out on the
  // live worker, and a mistake in any of them quietly breaks either the
  // caption or the instructions about the relay.
  assert.equal(rewriteVisibleDomain('example.edu'), 'github.com/vighneshtule/AulaLab')
  assert.equal(rewriteVisibleDomain('example.edu/c/ml-strong'), 'github.com/vighneshtule/AulaLab/c/ml-strong')
  assert.equal(rewriteVisibleDomain('example.edu/docs/'), 'github.com/vighneshtule/AulaLab/docs/')
  assert.equal(rewriteVisibleDomain('открой example.edu, там всё'), 'открой github.com/vighneshtule/AulaLab, там всё')
  assert.equal(rewriteVisibleDomain('example.edu и example.edu'), 'github.com/vighneshtule/AulaLab и github.com/vighneshtule/AulaLab')
  // The relay's subdomains are a foreign zone; they do not exist in .cc.
  assert.equal(rewriteVisibleDomain('hse.example.edu'), 'hse.example.edu')
  assert.equal(rewriteVisibleDomain('*.example.edu'), '*.example.edu')
  // A word that merely starts the same way.
  assert.equal(rewriteVisibleDomain('aulalab.ruby'), 'aulalab.ruby')
  assert.equal(rewriteVisibleDomain('xexample.edu'), 'xexample.edu')
  // Nothing to change: the string must come back the same.
  assert.equal(rewriteVisibleDomain('sleep3r@icloud.com'), 'sleep3r@icloud.com')
})

test('the replacement cannot reach the page head by construction', () => {
  // Not "we checked one page" but "the selector is physically limited to
  // body".
  for (const part of VISIBLE_DOMAIN_SELECTOR.split(',')) {
    assert.match(part.trim(), /^body \./, `the selector must start with body: ${part}`)
  }
})

/*
 * -------------------------------------------------------- link previews
 *
 * A link unfurler does not run JS, and the language auto-selection on the
 * landing page is a script. A bot given github.com/vighneshtule/AulaLab — the name meant precisely
 * for those without Russian — fetched `/` and showed a RUSSIAN card. The
 * whole fork is checked below, because on the live worker it cannot be seen:
 * a preview is shown once, cached by the messenger for days, and its mistake
 * looks like "just that kind of picture".
 *
 * The page heads are the same tags in the same order as in site/: there is
 * no point checking a retelling of the markup.
 */
const RU_ROOT = [
  '<html lang="en"><head>',
  '<title>Aula Lab — одна ссылка на всё занятие</title>',
  '<meta name="description" content="Общий Python-ноутбук и лекции." />',
  '<link rel="canonical" href="https://github.com/vighneshtule/AulaLab/" />',
  '<link rel="alternate" hreflang="ru" href="https://github.com/vighneshtule/AulaLab/" />',
  '<link rel="alternate" hreflang="en" href="https://github.com/vighneshtule/AulaLab/en/" />',
  '<link rel="alternate" hreflang="x-default" href="https://github.com/vighneshtule/AulaLab/en/" />',
  '<meta property="og:type" content="website" />',
  '<meta property="og:locale" content="ru_RU" />',
  '<meta property="og:site_name" content="Aula Lab" />',
  '<meta property="og:title" content="Aula Lab — одна ссылка на всё занятие" />',
  '<meta property="og:description" content="Проводите лекции и пишите код вместе." />',
  '<meta property="og:url" content="https://github.com/vighneshtule/AulaLab/" />',
  '<meta property="og:image" content="https://github.com/vighneshtule/AulaLab/img/og.png?v=e4fba370" />',
  '<meta name="twitter:card" content="summary_large_image" />',
  '</head><body><span class="host">example.edu</span></body></html>',
].join('\n')

const enTwin = (image: string): string =>
  [
    '<html lang="en"><head>',
    '<title>Aula Lab — one link for the whole class</title>',
    '<meta name="description" content="A shared Python notebook and lectures." />',
    '<link rel="canonical" href="https://github.com/vighneshtule/AulaLab/en/" />',
    '<link rel="alternate" hreflang="en" href="https://github.com/vighneshtule/AulaLab/en/" />',
    '<meta property="og:type" content="website" />',
    '<meta property="og:locale" content="en_US" />',
    '<meta property="og:site_name" content="Aula Lab" />',
    '<meta property="og:title" content="Aula Lab — one link for the whole class" />',
    '<meta property="og:description" content="Give lectures and write code together." />',
    '<meta property="og:url" content="https://github.com/vighneshtule/AulaLab/en/" />',
    `<meta property="og:image" content="${image}" />`,
    '<meta name="twitter:card" content="summary_large_image" />',
    '</head><body><span class="host">example.edu</span></body></html>',
  ].join('\n')

const EN_TWIN = enTwin('https://github.com/vighneshtule/AulaLab/img/og-en.png?v=29ecbee2')
/** Until the owner pushes, the English image is not on the upstream yet. */
const EN_TWIN_BEFORE = enTwin('https://github.com/vighneshtule/AulaLab/img/og.png?v=e4fba370')

/** An upstream that answers `/` with the landing and `/en/` with the twin. */
const landing =
  (twin: string | null) =>
  (url: URL): Response => {
    if (url.pathname === '/en/') return twin === null ? page('nope', { status: 404 }) : page(twin)
    return page(RU_ROOT)
  }

test("the mirror's root shows the English twin's preview", async () => {
  const { response, calls } = await ask('https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/', landing(EN_TWIN))
  const out = await response.text()
  const head = out.slice(0, out.indexOf('<body'))

  // The twin is found from the page itself, not from a hard-coded address: if
  // the English version moves, the preview moves with it.
  assert.equal(calls.length, 2)
  assert.equal(calls[1].url, 'https://github.com/vighneshtule/AulaLab/en/')

  // Everything the bot sees is English.
  assert.ok(head.includes('property="og:title" content="Aula Lab — one link for the whole class"'))
  assert.ok(
    head.includes('property="og:description" content="Give lectures and write code together."'),
  )
  assert.ok(head.includes('property="og:locale" content="en_US"'))
  assert.ok(head.includes('property="og:type" content="website"'))
  assert.ok(head.includes('name="twitter:card" content="summary_large_image"'))

  // The image is the mirror's, captioned github.com/vighneshtule/AulaLab, and the version tag is the
  // same: one script draws both images in one commit.
  assert.ok(
    head.includes('property="og:image" content="https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/img/og-cc.png?v=29ecbee2"'),
    `the image stayed foreign: ${head}`,
  )

  // og:url names THIS SAME address on the mirror: Facebook and everything
  // built on its scheme re-reads the tags from og:url, and the upstream
  // address would take the bot back to the Russian page.
  assert.ok(head.includes('property="og:url" content="https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/"'))

  // While a person and a search engine get the truth: the page is Russian
  // after all.
  assert.ok(head.includes('<title>Aula Lab — одна ссылка на всё занятие</title>'))
  assert.ok(head.includes('<meta name="description" content="Общий Python-ноутбук и лекции." />'))
  assert.ok(head.includes('<link rel="canonical" href="https://github.com/vighneshtule/AulaLab/" />'))
  assert.ok(head.includes('hreflang="en" href="https://github.com/vighneshtule/AulaLab/en/"'))
  assert.ok(head.includes('hreflang="x-default" href="https://github.com/vighneshtule/AulaLab/en/"'))

  // The footer still names the mirror.
  assert.ok(out.includes('<span class="host">github.com/vighneshtule/AulaLab</span>'))
})

test("while the English image is not on the upstream, the mirror takes the twin's image", async () => {
  // The worker is deployed before the owner pushes site/img/og-en.png. In that
  // window the twin's tags name the old og.png — and the mirror must show
  // exactly that, not a 404 on its own og-cc.png.
  const { response } = await ask('https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/', landing(EN_TWIN_BEFORE))
  const head = (await response.text()).split('<body')[0]
  assert.ok(head.includes('property="og:image" content="https://github.com/vighneshtule/AulaLab/img/og.png?v=e4fba370"'))
  // The text is already English, though — half of the job works even before
  // the push.
  assert.ok(head.includes('content="Aula Lab — one link for the whole class"'))
})

test('the twin did not answer, so the page goes out as it was', async () => {
  // A half-replaced head — Russian tags with the mirror's address in og:url —
  // is worse than an untouched one: it looks like it works. So on a misfire
  // nothing changes, and the head must match the upstream line by line.
  const { response } = await ask('https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/', landing(null))
  const out = await response.text()
  assert.equal(out.split('<body')[0], RU_ROOT.split('<body')[0])
  assert.ok(out.includes('<span class="host">github.com/vighneshtule/AulaLab</span>'), 'the footer lives a life of its own')
})

test('no hreflang means nobody fetches a twin', async () => {
  const { response, calls } = await ask('https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/', () =>
    page('<html><head><meta property="og:title" content="Тут" /></head><body></body></html>'))
  assert.equal(calls.length, 1, 'an extra upstream request on every serving of the root')
  assert.ok((await response.text()).includes('content="Тут"'))
})

test("the mirror's English page keeps its own tags but takes the mirror's image", async () => {
  const { response, calls } = await ask('https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/en/', () => page(EN_TWIN))
  const head = (await response.text()).split('<body')[0]
  assert.equal(calls.length, 1, 'the English page needs no twin: it is the twin')
  assert.ok(head.includes('property="og:title" content="Aula Lab — one link for the whole class"'))
  assert.ok(
    head.includes('property="og:image" content="https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/img/og-cc.png?v=29ecbee2"'),
  )
  assert.ok(head.includes('property="og:url" content="https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/en/"'))
  assert.ok(head.includes('<link rel="canonical" href="https://github.com/vighneshtule/AulaLab/en/" />'))
})

test('documentation pages do not change their previews at all', async () => {
  // /docs/ has no language auto-selection: an English card would lead to a
  // Russian page, that is, it would lie. And there is no reason to fetch a
  // twin there.
  const docs = [
    '<html lang="en"><head>',
    '<link rel="alternate" hreflang="en" href="https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/" />',
    '<meta property="og:url" content="https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/" />',
    '<meta property="og:title" content="Aula Lab documentation" />',
    '<meta property="og:image" content="https://github.com/vighneshtule/AulaLab/img/og-en.png?v=29ecbee2" />',
    '</head><body></body></html>',
  ].join('\n')
  const { response, calls } = await ask('https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/docs/', () => page(docs))
  assert.equal(calls.length, 1)
  assert.equal(await response.text(), docs, 'the documentation must not be touched in a single tag')
})

test("the twin's address is read from the markup, not guessed", () => {
  assert.equal(twinHref(RU_ROOT), 'https://github.com/vighneshtule/AulaLab/en/')
  // Attribute order can be anything, and that is no reason to lose the link.
  assert.equal(
    twinHref('<head><link hreflang="en" href="/en/" rel="alternate"></head>'),
    '/en/',
  )
  // No link, no head — nothing to replace.
  assert.equal(twinHref('<html><body><a hreflang="en" href="/en/">EN</a></body></html>'), null)
  assert.equal(twinHref('<head><link rel="alternate" hreflang="de" href="/de/"></head>'), null)
})

test('only preview tags are taken from the head', () => {
  const tags = previewTags(EN_TWIN)
  assert.equal(tags.get('og:locale'), 'en_US')
  assert.equal(tags.get('twitter:card'), 'summary_large_image')
  // description and title are not previews: they stay from the page itself.
  assert.equal(tags.has('description'), false)
  assert.equal(tags.size, 8)
})

test("only the upstream's English image is replaced with the mirror's image", () => {
  assert.equal(
    mirrorPreviewImage('https://github.com/vighneshtule/AulaLab/img/og-en.png?v=29ecbee2'),
    'https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/img/og-cc.png?v=29ecbee2',
  )
  // A relative address resolves against the upstream, so it shares that fate.
  assert.equal(mirrorPreviewImage('/img/og-en.png'), 'https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/img/og-cc.png')
  // The Russian image stays Russian: the mirror shows it until the push.
  assert.equal(mirrorPreviewImage('https://github.com/vighneshtule/AulaLab/img/og.png?v=e4fba370'), null)
  // A foreign image stays foreign.
  assert.equal(mirrorPreviewImage('https://example.com/img/og-en.png'), null)
  assert.equal(mirrorPreviewImage('не адрес вовсе'), null)
})

test("one tag's fork: what comes from the twin, what is its own, what comes from the mirror", () => {
  const twin = previewTags(EN_TWIN)
  const url = 'https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/'
  // If the twin has it, it is taken from the twin.
  assert.equal(previewContent('og:locale', 'ru_RU', twin, url), 'en_US')
  // If the twin lacks it, the own value stays.
  assert.equal(previewContent('og:image:width', '1200', twin, url), '1200')
  // og:url is always the mirror's address, even when the twin has its own.
  assert.equal(previewContent('og:url', 'https://github.com/vighneshtule/AulaLab/', twin, url), url)
  // The mirror's English page: no twin, but the image is the mirror's.
  assert.equal(
    previewContent('og:image', 'https://github.com/vighneshtule/AulaLab/img/og-en.png?v=1', null, url),
    'https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/img/og-cc.png?v=1',
  )
})

test('everything that is not markup flows through byte for byte', async () => {
  // Fonts, images, css and json do not go through HTMLRewriter at all — and
  // their length and encoding stay as they came from the upstream.
  const css = 'body{--host:"example.edu"}'
  const { response } = await ask('https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/styles.css', () =>
    new Response(css, {
      headers: { 'content-type': 'text/css; charset=utf-8', 'content-length': String(css.length) },
    }))
  assert.equal(await response.text(), css, 'css must not be rewritten')
  assert.equal(response.headers.get('content-length'), String(css.length))
})

test("after the markup is rebuilt, the upstream's length and encoding do not remain", async () => {
  const { response } = await ask('https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/', () =>
    page(LANDING, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(LANDING.length),
        'content-encoding': 'gzip',
      },
    }))
  // They described the PREVIOUS body. Even when the length matches by chance
  // (example.edu and github.com/vighneshtule/AulaLab are both nine bytes), they must not stay: an edit
  // to the class list will break that coincidence, and it will look like a
  // truncated page.
  assert.equal(response.headers.get('content-length'), null)
  assert.equal(response.headers.get('content-encoding'), null)
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
})

test('the mirror can do nothing besides GET and HEAD', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const { response, calls } = await ask('https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/', () => page(), { method })
    assert.equal(response.status, 405, `${method} must get 405`)
    assert.equal(response.headers.get('allow'), 'GET, HEAD')
    assert.equal(calls.length, 0, `${method} must not reach the upstream`)
  }

  const head = await ask('https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/', () => page(), { method: 'HEAD' })
  assert.equal(head.response.status, 200)
  assert.equal(head.calls[0].method, 'HEAD')
})

test('www is redirected to the apex without bothering the upstream', async () => {
  const { response, calls } = await ask('https://www.github.com/vighneshtule/AulaLab/docs/?a=1', () => page())
  assert.equal(response.status, 301)
  assert.equal(response.headers.get('location'), 'https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/docs/?a=1')
  assert.equal(calls.length, 0, 'there is no reason to go to the upstream for a redirect')
})

test("the upstream's answer passes through, but its error does not stay in the cache", async () => {
  const missing = await ask('https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/nope', () => page('not found', { status: 404 }))
  assert.equal(missing.response.status, 404)
  assert.equal(await missing.response.text(), 'not found')
  // Not-found is cached, but briefly: the page may appear with a deploy.
  assert.equal((missing.calls[0].cf.cacheTtlByStatus as Record<string, number>)['404'], 60)

  const broken = await ask('https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/', () => page('oops', { status: 502 }))
  assert.equal(broken.response.status, 502)
  assert.equal(broken.response.headers.get('cache-control'), 'no-store')
  assert.equal((broken.calls[0].cf.cacheTtlByStatus as Record<string, number>)['500-599'], 0)
})

test('the upstream does not hand out its own cookies through the mirror either', async () => {
  const { response } = await ask('https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/', () =>
    page('<html></html>', { headers: { 'set-cookie': 'session=1' } }))
  assert.equal(response.headers.get('set-cookie'), null)
})

test('lifetimes are laid out by how painful it is to go stale', async () => {
  // File names in site/ carry no content hash: styles.css stays styles.css
  // after a deploy. So only fonts and images live long, css and js an hour,
  // markup five minutes.
  const cases: Array<[string, number]> = [
    ['/fonts/hse-sans-400.woff2', 86400],
    ['/img/workspace.webp', 86400],
    ['/img/og.png?v=30b2e08a', 86400],
    ['/styles.css', 3600],
    ['/docs/docs.js', 3600],
    ['/docs/', 300],
    ['/c/ml-strong/', 300],
    ['/docs/search-index.json', 300],
  ]
  for (const [path, seconds] of cases) {
    const { response, calls } = await ask(`https://github.com/vighneshtule/AulaLab${path}`, () => page())
    assert.equal(
      response.headers.get('cache-control'),
      `public, max-age=${seconds}`,
      `${path} must live ${seconds} s`,
    )
    // And the same number goes to the Cloudflare edge, otherwise only the
    // browser caches, and every new visitor still waits for Pages to answer.
    assert.equal(calls[0].cf.cacheEverything, true)
    assert.equal((calls[0].cf.cacheTtlByStatus as Record<string, number>)['200-299'], seconds)
  }
})

test('HSTS is on every response, including 405 and the www redirect', async () => {
  const expected = 'max-age=31536000; includeSubDomains'
  const answers = await Promise.all([
    ask('https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/', () => page()),
    ask('https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/', () => page(), { method: 'POST' }),
    ask('https://www.github.com/vighneshtule/AulaLab/', () => page()),
    ask('https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/nope', () => page('', { status: 404 })),
  ])
  for (const { response } of answers) {
    // A header that comes only with pages does not protect the first visit
    // over http — and that is the only one anyone gets the chance to read.
    assert.equal(response.headers.get('strict-transport-security'), expected)
  }
})

test('the response shows that this is the mirror, not a spoofed DNS', async () => {
  const { response } = await ask('https://github.com/vighneshtule/AulaLab/tree/main/docs/pages/en/', () => page())
  assert.equal(response.headers.get('x-aulalab-mirror'), 'example.edu')
})
