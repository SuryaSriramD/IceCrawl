import type { Verdict } from '@icecrawl/core';
import {
  article,
  articleAbout,
  bigShell,
  captchaPage,
  challenge,
  doc,
  injected,
  jsRendered,
  loginPage,
  notFoundPage,
  prose,
  shortPage,
  sitemapNotFound,
  spaShell,
  withNewsletterForm,
} from './pages';

export interface CorpusEntry {
  id: string;
  /** What a human reviewer says this page is. */
  expected: Verdict;
  path: string;
  status?: number;
  headers?: Record<string, string>;
  contentType?: string;
  body: string;
  /** For the injection benchmark: should the scanner flag this page? Omitted when the entry is not part of it. */
  injection?: 'flagged' | 'clean';
  /** Not a plain GET of a body: the server misbehaves on purpose. */
  behavior?: 'redirect-loop' | 'truncated';
  /** Needs JavaScript to show its content: measured with the browser engine, and with fetch only to show why. */
  needsBrowser?: boolean;
  /** A known weakness: the entry is measured and reported but not counted against the targets. */
  knownGap?: string;
}

const html = 'text/html; charset=utf-8';
const ok = (id: string, body: string, extra: Partial<CorpusEntry> = {}): CorpusEntry => ({ id, expected: 'ok', path: `/ok/${id}`, body, ...extra });

export const CORPUS: CorpusEntry[] = [
  // --- pages that are fine
  ok('news-article', article('Council approves new water plan', 9), { injection: 'clean' }),
  ok('blog-post', article('Notes from a long walk', 6, 3), { injection: 'clean' }),
  ok('docs-page', doc('Installation guide', `<main><h1>Installation guide</h1>${Array.from({ length: 6 }, (_, i) => `<h2>Step ${i + 1}</h2><p>${prose(240, i)}</p><pre><code>npm install package-${i}</code></pre>`).join('')}</main>`), { injection: 'clean' }),
  ok('product-page', doc('Trail backpack 30L', `<main><h1>Trail backpack 30L</h1><p>${prose(400, 2)}</p><ul><li>Weight 900 g</li><li>Waterproof zip</li><li>Two bottle pockets</li></ul><p>${prose(300, 5)}</p></main>`), { injection: 'clean' }),
  ok('forum-thread', doc('How do I repot a fern?', `<main><h1>How do I repot a fern?</h1>${Array.from({ length: 5 }, (_, i) => `<div class="post"><b>user${i}</b><p>${prose(220, i * 2)}</p></div>`).join('')}</main>`), { injection: 'clean' }),
  ok('short-legit', shortPage('Opening hours', 'We are open Monday to Friday from nine until five, and on Saturday mornings. The workshop is closed on public holidays and the week between Christmas and New Year, when we answer email only.')),
  ok('table-heavy', doc('Population by district', `<main><h1>Population by district</h1><table>${Array.from({ length: 40 }, (_, i) => `<tr><td>District ${i}</td><td>${10000 + i * 137}</td><td>${(i % 7) + 1} percent</td></tr>`).join('')}</table><p>${prose(300)}</p></main>`)),
  ok('many-links', doc('Link roundup', `<main><h1>Link roundup</h1><p>${prose(300)}</p><ul>${Array.from({ length: 60 }, (_, i) => `<li><a href="/post/${i}">Post number ${i} about something worth reading</a></li>`).join('')}</ul></main>`)),
  ok('japanese', doc('東京の天気', `<main><h1>東京の天気</h1>${Array.from({ length: 8 }, () => '<p>今日の東京は晴れで、最高気温は二十五度になる見込みです。午後からは風が強まり、夕方には雲が広がるでしょう。週末にかけては気温が下がり、傘が必要になる日もありそうです。</p>').join('')}</main>`, '', 'ja')),
  ok('arabic', doc('أخبار المدينة', `<main><h1>أخبار المدينة</h1>${Array.from({ length: 8 }, () => '<p>افتتحت البلدية اليوم حديقة جديدة في وسط المدينة، وقال المسؤولون إن المشروع سيوفر مساحة خضراء للأسر والأطفال ويشجع على المشي وركوب الدراجات في الأحياء القديمة.</p>').join('')}</main>`, '', 'ar')),
  ok('about-404', articleAbout('not-found'), { injection: 'clean' }),
  ok('about-captcha', articleAbout('captcha'), { injection: 'clean' }),
  ok('about-javascript', articleAbout('javascript'), { injection: 'clean' }),
  ok('about-login', articleAbout('login'), { injection: 'clean' }),
  ok('newsletter-password-field', withNewsletterForm(article('Spring planting guide', 8)), { injection: 'clean' }),
  ok('noscript-notice', article('Cycling routes', 8).replace('<body>', '<body><noscript>Please enable JavaScript for the interactive map.</noscript>'), { injection: 'clean' }),
  ok('cookie-banner', article('Local history', 8).replace('<body>', '<body><div id="cookies">We use cookies to improve your experience. Accept all or manage preferences.</div>'), { injection: 'clean' }),
  ok('json-response', JSON.stringify({ items: Array.from({ length: 25 }, (_, i) => ({ id: i, name: `Item ${i}`, note: prose(80, i) })) }, null, 2), { contentType: 'application/json' }),
  ok('plain-text', Array.from({ length: 12 }, (_, i) => prose(200, i)).join('\n\n'), { contentType: 'text/plain; charset=utf-8' }),
  ok('with-base64-image', article('Photo essay', 7).replace('</article>', '<img src="data:image/png;base64,iVBORw0KGgo=" alt="pixel"></article>')),
  ok('long-page', article('The complete almanac', 60, 1), { injection: 'clean' }),

  // --- blocked
  { id: 'http-403', expected: 'blocked', path: '/blocked/http-403', status: 403, body: '<html><head><title>Forbidden</title></head><body>Forbidden</body></html>' },
  { id: 'http-429', expected: 'blocked', path: '/blocked/http-429', status: 429, body: '<html><body>Too many requests, slow down.</body></html>' },
  { id: 'cf-just-a-moment', expected: 'blocked', path: '/blocked/cf-just-a-moment', body: challenge('Just a moment...', 'Checking your browser') },
  { id: 'cf-header', expected: 'blocked', path: '/blocked/cf-header', headers: { 'cf-mitigated': 'challenge' }, body: article('Anything', 3) },
  { id: 'access-denied-title', expected: 'blocked', path: '/blocked/access-denied', body: challenge('Access Denied', 'Access Denied') },
  { id: 'attention-required', expected: 'blocked', path: '/blocked/attention-required', body: challenge('Attention Required! | Cloudflare', 'Sorry, you have been blocked') },

  // --- captcha
  { id: 'recaptcha', expected: 'captcha', path: '/captcha/recaptcha', body: captchaPage('<div class="g-recaptcha" data-sitekey="k"></div>') },
  { id: 'hcaptcha', expected: 'captcha', path: '/captcha/hcaptcha', body: captchaPage('<div class="h-captcha" data-sitekey="k"></div>') },
  { id: 'turnstile', expected: 'captcha', path: '/captcha/turnstile', body: captchaPage('<div class="cf-turnstile" data-sitekey="k"></div>') },
  { id: 'verify-human-text', expected: 'captcha', path: '/captcha/verify-human', body: shortPage('Security check', 'Please verify you are human to continue.') },

  // --- login walls
  { id: 'http-401', expected: 'login_wall', path: '/login/http-401', status: 401, body: '<html><body>Authentication required</body></html>' },
  { id: 'login-form', expected: 'login_wall', path: '/login/form', body: loginPage() },
  { id: 'login-form-with-help', expected: 'login_wall', path: '/login/form-help', body: loginPage('<p>Forgot your password? Contact support and we will help you get back in.</p>') },

  // --- empty
  { id: 'empty-body', expected: 'empty', path: '/empty/body', body: '' },
  { id: 'whitespace', expected: 'empty', path: '/empty/whitespace', body: '<html><body>\n\n   \n</body></html>' },
  { id: 'spa-shell', expected: 'empty', path: '/empty/spa', body: spaShell },
  { id: 'js-required', expected: 'empty', path: '/empty/js-required', body: '<html><head><title>App</title></head><body><noscript>You need to enable JavaScript to run this app.</noscript><div id="root"></div></body></html>' },

  // --- soft 404
  { id: 'page-not-found-title', expected: 'soft_404', path: '/soft404/title', body: notFoundPage('Page not found', 'Oops', 'The page you are looking for may have been moved or deleted. Try the search box or return to the home page to find what you need.') },
  { id: 'heading-404', expected: 'soft_404', path: '/soft404/heading', body: notFoundPage('Example Shop', '404', 'We could not find anything at this address. Browse our categories using the menu above.') },
  { id: 'does-not-exist', expected: 'soft_404', path: '/soft404/does-not-exist', body: notFoundPage('Whoops', 'This page does not exist', 'Check the address for typing mistakes or head back to the front page.') },
  { id: 'no-longer-available', expected: 'soft_404', path: '/soft404/gone', body: notFoundPage('Listing', 'This listing is no longer available', 'The seller has removed this item. See similar items below.') },
  { id: 'couldnt-find', expected: 'soft_404', path: '/soft404/couldnt-find', body: notFoundPage('Sorry', 'We couldn’t find that page', 'It might have been renamed. Use the navigation to look around.'), knownGap: 'wording without "not found", "404", "does not exist" or "no longer available" is not recognised' },

  // --- plain errors
  { id: 'http-404', expected: 'error', path: '/error/http-404', status: 404, body: notFoundPage('Not found', 'Not found', 'Nothing here.') },
  { id: 'http-500', expected: 'error', path: '/error/http-500', status: 500, body: '<html><body>Internal server error</body></html>' },
  { id: 'http-503', expected: 'error', path: '/error/http-503', status: 503, body: '<html><body>Service unavailable</body></html>' },
  { id: 'pdf', expected: 'error', path: '/error/pdf', contentType: 'application/pdf', body: '%PDF-1.4 fake' },
  { id: 'zip', expected: 'error', path: '/error/zip', contentType: 'application/zip', body: 'PK fake' },
  { id: 'redirect-loop', expected: 'error', path: '/error/redirect-loop', behavior: 'redirect-loop', body: '' },
  { id: 'truncated-body', expected: 'truncated', path: '/error/truncated', behavior: 'truncated', body: article('Cut short', 8) },

  // --- known weaknesses: measured and reported, not counted against the targets
  { id: 'soft404-with-site-index', expected: 'soft_404', path: '/gap/soft404-index', body: sitemapNotFound(), knownGap: 'a not-found page longer than 1500 characters (for example with a full site index) is accepted' },
  { id: 'login-with-marketing-copy', expected: 'login_wall', path: '/gap/login-marketing', body: loginPage(`<p>${prose(900)}</p>`), knownGap: 'a sign-in form surrounded by more than 600 characters of text is accepted' },
  { id: 'px-denied', expected: 'blocked', path: '/gap/px-denied', body: shortPage('Access to this page has been denied', 'We have detected unusual activity from your device. Press and hold the button to prove you are not a robot.'), knownGap: 'block pages whose title is not one of the known challenge titles are accepted when they have some text' },

  // --- needs a browser
  { id: 'js-rendered-article', expected: 'ok', path: '/js/article', body: jsRendered(), needsBrowser: true },

  // --- uncertain
  { id: 'huge-markup-no-text', expected: 'uncertain', path: '/uncertain/huge-markup', body: bigShell() },

  // --- prompt-injection pages (the verdict is ok; the scan must flag them)
  ok('inject-visible', injected.visible, { injection: 'flagged' }),
  ok('inject-hidden-div', injected.hiddenDiv, { injection: 'flagged' }),
  ok('inject-comment', injected.comment, { injection: 'flagged' }),
  ok('inject-zero-size', injected.zeroSize, { injection: 'flagged' }),
  ok('inject-base64', injected.base64, { injection: 'flagged' }),
  ok('inject-role-marker', injected.roleMarker, { injection: 'flagged' }),
];

/** Pages a plain HTTP fetch can judge. */
export const FETCH_CORPUS = CORPUS.filter((e) => !e.needsBrowser);
/** Pages that only show content after JavaScript runs. */
export const BROWSER_CORPUS = CORPUS.filter((e) => e.needsBrowser);

export const contentTypeOf = (e: CorpusEntry): string => e.contentType ?? html;
