// Bridge browser automation (Phase 2 of website read/click).
//
// This runs ONLY inside the local bridge (your machine), because the whole point
// is to drive a REAL browser that has YOUR logins — something no cloud/serverless
// host can do. It keeps ONE long-lived Chromium open with a PERSISTENT profile
// (scripts/bridge/.browser-profile), so you log into your dashboards once inside
// the Jarvis browser and the sessions stick for next time. It's headed on purpose
// so you can see what Jarvis does and step in to authenticate.
//
// Verbs exposed to server.mjs:
//   page_open(url)             -> navigate only; does NOT snapshot.
//   page_snapshot(url?)        -> navigate (if url) + return a PRUNED accessibility
//                                 tree: one compact line per interactive/heading
//                                 element with a stable [ref] id. Cached per URL so
//                                 a repeat ask reuses it (the token-saver: the model
//                                 gets refs, not raw HTML).
//   page_text(url?)            -> navigate (if url) + return readable page text, for
//                                 reading/summarizing LOGGED-IN pages.
//   page_scroll(direction)      -> scroll current page and return a fresh snapshot.
//   page_act(action, ref, text)-> click / type / press / back by [ref].
//
// Playwright is imported LAZILY so the web app's Vercel build never needs it; the
// bridge tells you how to install it if it's missing.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = join(__dirname, ".browser-profile");

const NAV_TIMEOUT_MS = 20_000;
const SNAPSHOT_TTL_MS = 60_000; // reuse a snapshot for a minute
const MAX_ITEMS = 200; // cap elements per snapshot
const MAX_TEXT = 12_000; // cap extracted text (~3-4k tokens)

let _pw = null; // the playwright module (lazy)
let _context = null; // persistent browser context
let _page = null; // the active page
let _queue = Promise.resolve(); // serialize ops so they never race
// Per-URL snapshot cache: url -> { at, title, items }. `items` carry the in-page
// selector so a later page_act can relocate the element to click it.
const _snapCache = new Map();

async function loadPlaywright() {
  if (_pw) return _pw;
  try {
    _pw = await import("playwright");
    return _pw;
  } catch {
    throw new Error(
      "Playwright isn't installed. In the project folder run:  npm i -D playwright  &&  npx playwright install chromium"
    );
  }
}

// Launch (or reuse) the persistent, headed browser. Prefer the user's installed
// Chrome (channel "chrome") so it feels familiar and Google logins work; fall
// back to Playwright's bundled Chromium.
async function ensureBrowser() {
  if (_context && _page && !_page.isClosed()) return;
  const { chromium } = await loadPlaywright();
  const opts = {
    headless: false,
    viewport: { width: 1280, height: 800 },
    // Hide the automation fingerprint so logins — especially Google — don't reject
    // the browser as "insecure / not a valid browser". Drop Playwright's default
    // --enable-automation switch and the blink feature that sets navigator.webdriver.
    args: ["--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
    // Run sandboxed (the normal, secure mode) so Chrome doesn't show the yellow
    // "unsupported command-line flag: --no-sandbox" warning bar.
    chromiumSandbox: true,
  };
  try {
    _context = await chromium.launchPersistentContext(PROFILE_DIR, { ...opts, channel: "chrome" });
  } catch {
    _context = await chromium.launchPersistentContext(PROFILE_DIR, opts);
  }
  _context.setDefaultTimeout(NAV_TIMEOUT_MS);
  const pages = _context.pages();
  _page = pages.length ? pages[0] : await _context.newPage();
  _context.on("close", () => { _context = null; _page = null; });
}

// Run an op exclusively (FIFO), so concurrent requests can't interleave on the
// single shared page.
function exclusive(fn) {
  const next = _queue.then(fn, fn);
  // Keep the chain alive even if this op throws.
  _queue = next.then(() => {}, () => {});
  return next;
}

async function gotoIfNeeded(url) {
  if (!url) return;
  await ensureBrowser();
  const cur = _page.url();
  if (cur === url) return;
  try {
    await _page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  } catch (e) {
    const msg = String(e?.message || e);
    // Turn navigation failures (bad DNS, refused, timeout) into a readable error
    // instead of an unhandled rejection that would crash the bridge process.
    if (/ERR_NAME_NOT_RESOLVED/.test(msg)) throw new Error(`couldn't reach ${url} — that web address doesn't exist`);
    if (/ERR_CONNECTION_REFUSED/.test(msg)) throw new Error(`couldn't reach ${url} — connection refused`);
    if (/Timeout/i.test(msg)) throw new Error(`couldn't reach ${url} — the page took too long to load`);
    throw new Error(`couldn't open ${url}`);
  }
  // Give client-rendered apps a moment to paint; ignore if it never goes idle.
  try { await _page.waitForLoadState("networkidle", { timeout: 4000 }); } catch {}
}

// ── In-page DOM walk ────────────────────────────────────────────────────────
// Runs in the PAGE. Tags interactive + heading elements with data-jarvis-ref and
// returns a compact list with selector/viewport/clickable metadata. `selector` is a
// nth-of-type CSS path so the bridge can relocate the element later to act on it,
// even though the data-* attribute may not survive a navigation.
const SNAPSHOT_FN = `(maxItems) => {
  const out = [];
  const seen = new Set();
  const viewport = { w: window.innerWidth, h: window.innerHeight };
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const accName = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) { const t = labelledby.split(/\\s+/).map(id => document.getElementById(id)?.innerText || '').join(' ').trim(); if (t) return t; }
    const txt = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (txt) return txt;
    return (el.getAttribute('placeholder') || el.getAttribute('value') || el.getAttribute('alt') || el.getAttribute('title') || '').trim();
  };
  const cssPath = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 8) {
      let sel = node.tagName.toLowerCase();
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter(c => c.tagName === node.tagName);
        if (same.length > 1) sel += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(sel);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };
  const roleOf = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'label' && el.htmlFor) {
      const control = document.getElementById(el.htmlFor);
      if (control?.tagName?.toLowerCase() === 'input') {
        const type = (control.getAttribute('type') || '').toLowerCase();
        if (type === 'checkbox' || type === 'radio') return type;
      }
    }
    return el.getAttribute('role') || (tag === 'a' ? 'link' : (/^h[1-6]$/.test(tag) ? 'heading' : tag));
  };
  const isClickable = (el) => {
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    return !!(el.closest('a[href],button,label,summary,[role=button],[role=link],[role=menuitem],[role=tab],[onclick]') || ['input','select','textarea','label'].includes(tag) || ['button','link','menuitem','tab','checkbox','radio'].includes(role));
  };
  const clickableAncestor = (el) => el.closest('a[href],button,label,summary,[role=button],[role=link],[role=menuitem],[role=tab],[onclick]') || el;
  const viewportState = (el) => {
    const r = el.getBoundingClientRect();
    if (r.bottom < 0) return 'above';
    if (r.top > viewport.h) return 'below';
    if (r.right < 0 || r.left > viewport.w) return 'side';
    return 'in';
  };
  const boxOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const frameName = () => {
    try {
      if (window.top === window) return 'main';
      return window.frameElement?.getAttribute('name') || window.frameElement?.id || 'iframe';
    } catch {
      return 'iframe';
    }
  };
  const sel = [
    'a[href]', 'button', 'input', 'textarea', 'select', 'summary',
    '[role=button]', '[role=link]', '[role=checkbox]', '[role=tab]', '[role=menuitem]', '[role=option]',
    '[onclick]', '[tabindex]', '[aria-expanded]', '[aria-controls]',
    '[data-testid]', '[data-test]', '[data-cy]',
    'h1', 'h2', 'h3', 'label'
  ].join(',');
  const els = Array.from(document.querySelectorAll(sel));
  let ref = Math.max(0, ...Array.from(document.querySelectorAll('[data-jarvis-ref]')).map((el) => Number(el.getAttribute('data-jarvis-ref')) || 0));
  const refFor = (el, role, name, value = '') => {
    let r = el.getAttribute('data-jarvis-ref');
    if (!r) {
      ref += 1;
      r = String(ref);
      el.setAttribute('data-jarvis-ref', r);
    }
    return Number(r);
  };
  const pushItem = (el, role, name, value = '') => {
    const clickable = clickableAncestor(el);
    const selfRef = refFor(el, role, name, value);
    let parentRef = null;
    if (clickable && clickable !== el && isVisible(clickable)) {
      parentRef = refFor(clickable, roleOf(clickable), accName(clickable).slice(0, 120));
    }
    out.push({
      ref: selfRef,
      role,
      name,
      value: value.slice(0, 80),
      selector: cssPath(el),
      clickableSelector: cssPath(clickable || el),
      controlSelector: el.tagName.toLowerCase() === 'label' && el.htmlFor ? '#' + CSS.escape(el.htmlFor) : '',
      parentRef,
      href: el.getAttribute('href') || clickable?.getAttribute?.('href') || '',
      viewport: viewportState(el),
      box: boxOf(el),
      frame: frameName(),
      frameIndex: 0,
    });
  };
  for (const el of els) {
    if (out.length >= maxItems) break;
    if (!isVisible(el)) continue;
    const tag = el.tagName.toLowerCase();
    let role = roleOf(el);
    const name = accName(el).slice(0, 120);
    const isHeading = /^h[1-6]$/.test(tag);
    if (!name && !isHeading) continue;
    const key = role + '|' + name + '|' + (el.getAttribute('href') || '');
    if (seen.has(key)) continue;
    seen.add(key);
    const value = (tag === 'input' || tag === 'textarea') ? (el.value || '') : '';
    pushItem(el, role, name, value);
  }

  // ── Login detection ────────────────────────────────────────────────────────
  // Tell the agent whether this page wants a login: a password form (fill user +
  // pass), an EMAIL-FIRST step (many sites ask for the email, then the password on
  // the next screen — fill the email, the password step is detected after), or
  // SSO-only (Google/Apple/etc — must be done by hand). Refs of the user/pass
  // fields let a confirmed auto-fill target them. A bare nav "Sign in" link
  // shouldn't trip this, so a field/SSO only counts when URL/title looks login-ish.
  const login = { needed: false, hasPassword: false, emailOnly: false, ssoOnly: false, providers: [], userRef: null, passRef: null, submitRef: null };
  // Give an element a ref even if the named-element pass skipped it (login inputs
  // usually have no accessible name), so page_act can locate it later.
  const ensureRef = (el) => {
    if (!el) return null;
    let r = el.getAttribute('data-jarvis-ref');
    if (!r) {
      ref += 1; r = String(ref);
      el.setAttribute('data-jarvis-ref', r);
      pushItem(el, el.tagName.toLowerCase(), accName(el).slice(0, 120), '');
    }
    return Number(r);
  };
  const visInputs = Array.from(document.querySelectorAll('input')).filter(isVisible);
  const idRe = /email|user(name)?|login|account|phone|tel/i;
  const isIdentifier = (el) => {
    const t = (el.type || 'text').toLowerCase();
    if (t === 'email' || t === 'tel') return true;
    if (!['text', 'search', ''].includes(t)) return false;
    return idRe.test((el.name || '') + ' ' + (el.id || '') + ' ' + (el.getAttribute('autocomplete') || '') + ' ' + (el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('aria-label') || ''));
  };
  const pwd = visInputs.find((el) => (el.type || '').toLowerCase() === 'password');
  const ssoRe = /(continue|sign|log|register)\\s*(in|up)?\\s*with\\s*(google|apple|microsoft|github|facebook|okta|twitter|x|sso)|with\\s+(google|apple|microsoft|github)/i;
  const provRe = /google|apple|microsoft|github|facebook|okta|twitter/i;
  const ssoBtns = els.filter((el) => ssoRe.test(accName(el)));
  const providers = [...new Set(ssoBtns.map((el) => { const m = accName(el).match(provRe); return m ? m[0].toLowerCase() : 'sso'; }))];
  const loginish = /log\\s?in|sign\\s?in|signin|\\/auth|account\\/login|\\/login|\\/session|\\/sso/i.test(location.href + ' ' + document.title);
  // Pick the username/identifier field: prefer the one just before a password,
  // else the first identifier-looking input on the page.
  let userEl = null;
  if (pwd) {
    const pIdx = visInputs.indexOf(pwd);
    for (let i = pIdx - 1; i >= 0; i--) { const t = (visInputs[i].type || 'text').toLowerCase(); if (['text', 'email', 'tel', 'search', ''].includes(t)) { userEl = visInputs[i]; break; } }
  }
  if (!userEl) userEl = visInputs.find(isIdentifier);

  if (pwd) {
    login.hasPassword = true;
    login.needed = true;
    login.passRef = ensureRef(pwd);
    login.userRef = ensureRef(userEl);
  } else if (userEl && (loginish || providers.length)) {
    // Email-first / email-only step: no password field yet, just an identifier.
    login.emailOnly = true;
    login.needed = true;
    login.userRef = ensureRef(userEl);
  }
  const sub = els.find((el) => /^(log\\s?in|sign\\s?in|continue|submit|next|go|proceed)$/i.test(accName(el).trim()) && (el.tagName === 'BUTTON' || (el.getAttribute('type') || '') === 'submit'));
  login.submitRef = ensureRef(sub);
  if (providers.length) {
    login.providers = providers;
    login.needed = true;
  }
  // No fillable email/password field but the page is clearly a sign-in (has SSO
  // buttons OR a login-ish URL/title) → method-only login. Always report it so the
  // user isn't left wondering; Jarvis can't fill these, they sign in by hand.
  login.ssoOnly = !pwd && !userEl && (providers.length > 0 || loginish);
  if (login.ssoOnly) login.needed = true;

  return { title: document.title, url: location.href, items: out, login };
}`;

function renderTree(items) {
  // Compact, model-friendly: "[12] button \"Submit\"". Headings give structure.
  return items
    .map((it) => {
      const v = it.value ? ` =\"${it.value}\"` : "";
      const p = it.parentRef ? ` parent=${it.parentRef}` : "";
      const h = it.href ? ` href=${String(it.href).slice(0, 80)}` : "";
      const vp = it.viewport && it.viewport !== "in" ? ` ${it.viewport}` : "";
      const fr = it.frame && it.frame !== "main" ? ` frame=${it.frame}` : "";
      return `[${it.ref}] ${it.role} \"${it.name}\"${v}${p}${vp}${fr}${h}`;
    })
    .join("\n");
}

async function snapshotFrame(frame, frameIndex) {
  try {
    const data = await frame.evaluate(`(${SNAPSHOT_FN})(${MAX_ITEMS})`);
    if (!data || !data.url) return null;
    return { ...data, frameIndex };
  } catch {
    return null;
  }
}

async function snapshotAllFrames() {
  const frames = _page.frames();
  const all = [];
  let title = await _page.title().catch(() => "");
  let url = _page.url();
  let login = null;
  let nextRef = 1;
  for (let i = 0; i < frames.length && all.length < MAX_ITEMS; i++) {
    const data = await snapshotFrame(frames[i], i);
    if (!data) continue;
    if (i === 0) {
      title = data.title || title;
      url = data.url || url;
      login = data.login || null;
    }
    for (const item of data.items || []) {
      if (all.length >= MAX_ITEMS) break;
      all.push({
        ...item,
        localRef: item.ref,
        ref: nextRef++,
        frameIndex: i,
        frame: i === 0 ? item.frame || "main" : item.frame || `iframe-${i}`,
      });
    }
  }
  return { title, url, items: all, login: login || { needed: false } };
}

function emptySnapshotResult(url, title) {
  return {
    ok: false,
    url,
    title,
    count: 0,
    tree: "",
    error: "Snapshot found no clickable elements or headings. Use browser_read to inspect readable page text, or browser_scroll to reveal more refs.",
  };
}

function snapshotResult(data, fromCache = false) {
  if (!data || !data.url) return { ok: false, error: "couldn't read the page structure" };
  if (!data.items.length) return emptySnapshotResult(data.url, data.title);
  _snapCache.set(data.url, { at: Date.now(), title: data.title, items: data.items, login: data.login });
  return {
    ok: true,
    url: data.url,
    title: data.title,
    tree: renderTree(data.items),
    count: data.items.length,
    fromCache,
    login: data.login,
  };
}

// ── Public verbs ────────────────────────────────────────────────────────────
export function pageOpen(url) {
  return exclusive(async () => {
    if (!url || !/^https?:\/\//i.test(url)) return { ok: false, error: "not a web address" };
    await gotoIfNeeded(url);
    const data = await snapshotAllFrames();
    const snapshot = snapshotResult(data, false);
    return {
      ok: true,
      opened: true,
      url: _page.url(),
      title: data?.title || (await _page.title().catch(() => "")),
      snapshot,
      ...(snapshot.ok
        ? { tree: snapshot.tree, count: snapshot.count, login: snapshot.login }
        : { snapshotError: snapshot.error, count: 0 }),
    };
  });
}

export function pageSnapshot(url) {
  return exclusive(async () => {
    if (url && !/^https?:\/\//i.test(url)) return { ok: false, error: "not a web address" };
    // No url means "read the page I'm on" — but if you closed the tab/window there's
    // nothing to read. Say so instead of silently reopening a blank browser.
    if (!url && (!_context || !_page || _page.isClosed())) {
      return { ok: false, error: "The Jarvis browser is closed — say “open <site> in the browser” to start it again." };
    }
    // Cache hit (same url, fresh, and we're still on it) → reuse, no re-walk.
    if (url) {
      const c = _snapCache.get(url);
      if (c && Date.now() - c.at < SNAPSHOT_TTL_MS && _page && _page.url() === url) {
        return { ok: true, url, title: c.title, tree: renderTree(c.items), count: c.items.length, fromCache: true, login: c.login };
      }
    }
    await gotoIfNeeded(url);
    // SNAPSHOT_FN is source for an arrow function. Passed as a bare string,
    // page.evaluate would just return the function object (and ignore the arg),
    // so wrap + invoke it as an expression: ((maxItems)=>{...})(200).
    const data = await snapshotAllFrames();
    return snapshotResult(data, false);
  });
}

export function pageText(url) {
  return exclusive(async () => {
    if (url && !/^https?:\/\//i.test(url)) return { ok: false, error: "not a web address" };
    if (!url && (!_context || !_page || _page.isClosed())) {
      return { ok: false, error: "The Jarvis browser is closed — say “open <site> in the browser” to start it again." };
    }
    await gotoIfNeeded(url);
    let text = await _page.evaluate(() => {
      const drop = document.querySelectorAll("script,style,noscript,nav,footer,header,aside");
      drop.forEach((n) => n.remove());
      return (document.body?.innerText || "").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
    });
    const truncated = text.length > MAX_TEXT;
    if (truncated) text = text.slice(0, MAX_TEXT);
    const title = await _page.title();
    if (!text) return { ok: false, error: "no readable text on that page" };
    return { ok: true, url: _page.url(), title, content: text, truncated };
  });
}

// Resolve a ref to a live element: prefer the data-* attribute (set on the last
// snapshot of THIS page); fall back to the stored CSS selector if the attribute
// is gone (e.g. a re-render). Returns a Playwright locator or null.
async function locateRef(ref) {
  const cur = _snapCache.get(_page.url());
  const item = cur?.items.find((i) => i.ref === Number(ref));
  return await locateSnapshotItem(item, ref);
}

async function locateSnapshotItem(item, ref) {
  const frame = item?.frameIndex != null ? _page.frames()[item.frameIndex] : _page.mainFrame();
  if (!frame) return null;
  const attrRef = item?.localRef ?? ref;
  const byAttr = frame.locator(`[data-jarvis-ref="${attrRef}"]`);
  if (await byAttr.count()) return byAttr.first();
  if (item?.clickableSelector) {
    const byClickable = frame.locator(item.clickableSelector);
    if (await byClickable.count()) return byClickable.first();
  }
  if (item?.selector) {
    const byCss = frame.locator(item.selector);
    if (await byCss.count()) return byCss.first();
  }
  return null;
}

async function snapshotCurrentPage() {
  const data = await snapshotAllFrames();
  if (!data || !data.url) return null;
  return snapshotResult(data, false);
}

async function scrollAndSnapshot(direction = "down", amount) {
  const dy = await _page.evaluate(({ direction, amount }) => {
    // Default to 75% of the viewport so consecutive scroll snapshots have a
    // 25% overlap. That reveals new content without skipping items near edges.
    const step =
      Number.isFinite(amount) && amount > 0
        ? Math.min(amount, 4000)
        : Math.max(240, Math.floor(window.innerHeight * 0.75));
    const dy = direction === "up" ? -step : step;
    const scrollOne = (doc) => {
      const el = doc?.scrollingElement || doc?.documentElement || doc?.body;
      if (el) el.scrollBy({ top: dy, left: 0, behavior: "instant" });
    };
    scrollOne(document);
    for (const frame of Array.from(document.querySelectorAll("iframe"))) {
      try {
        if (frame.contentDocument) scrollOne(frame.contentDocument);
      } catch {}
    }
    return dy;
  }, { direction, amount }).catch(() => direction === "up" ? -800 : 800);
  await _page.mouse.wheel(0, dy).catch(() => {});
  try { await _page.waitForLoadState("networkidle", { timeout: 1500 }); } catch {}
  return await snapshotCurrentPage();
}

async function snapshotAfterAction() {
  try { await _page.waitForLoadState("networkidle", { timeout: 1500 }); } catch {}
  return await snapshotCurrentPage();
}

async function toggleAssociatedControl(loc) {
  return await loc.evaluate((el) => {
    const tag = el.tagName.toLowerCase();
    const control =
      tag === "label" && el.htmlFor
        ? document.getElementById(el.htmlFor)
        : el;
    if (!(control instanceof HTMLInputElement)) return { handled: false };
    const type = (control.type || "").toLowerCase();
    if (type !== "checkbox" && type !== "radio") return { handled: false };
    if (type === "checkbox") {
      if (!control.checked) control.click();
    } else {
      control.click();
    }
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
    return { handled: true, type, checked: control.checked, id: control.id || "" };
  }).catch(() => ({ handled: false }));
}

export function pageScroll(direction = "down", amount) {
  return exclusive(async () => {
    if (!_page || _page.isClosed()) return { ok: false, error: "no page open — snapshot first" };
    const dir = String(direction || "down").toLowerCase() === "up" ? "up" : "down";
    const n = Number.isFinite(Number(amount)) && Number(amount) > 0 ? Math.min(Number(amount), 4000) : undefined;
    const snapshot = await scrollAndSnapshot(dir, n);
    return { ok: true, message: `Scrolled ${dir}.`, snapshot };
  });
}

export function pageAct(action, ref, text) {
  return exclusive(async () => {
    if (!_page || _page.isClosed()) return { ok: false, error: "no page open — snapshot first" };
    // Ref-free actions.
    if (action === "back") { await _page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {}); return { ok: true, message: "Went back." }; }
    if (action === "enter") { await _page.keyboard.press("Enter"); return { ok: true, message: "Pressed Enter." }; }

    const loc = await locateRef(ref);
    if (!loc) {
      return {
        ok: false,
        error: `couldn't find element ${ref}; call browser_scroll to reveal more refs, then retry the action`,
      };
    }
    try {
      await loc.scrollIntoViewIfNeeded({ timeout: NAV_TIMEOUT_MS }).catch(() => {});
      switch (action) {
        case "click":
          {
            const toggled = await toggleAssociatedControl(loc);
            if (toggled?.handled) {
              const snapshot = await snapshotAfterAction();
              return {
                ok: true,
                message: `${toggled.type === "checkbox" ? "Checked" : "Selected"} ${ref}.`,
                checked: toggled.checked,
                snapshot,
              };
            }
          }
          try {
            await loc.click({ timeout: NAV_TIMEOUT_MS });
          } catch {
            await loc.evaluate((el) => {
              el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
              el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
              el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
              el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
            });
          }
          return { ok: true, message: `Clicked ${ref}.`, snapshot: await snapshotAfterAction() };
        case "type":
          await loc.fill(String(text ?? ""), { timeout: NAV_TIMEOUT_MS });
          return { ok: true, message: `Typed into ${ref}.`, snapshot: await snapshotAfterAction() };
        case "select":
          await loc.selectOption(String(text ?? ""), { timeout: NAV_TIMEOUT_MS });
          return { ok: true, message: `Selected in ${ref}.`, snapshot: await snapshotAfterAction() };
        case "check":
          {
            const toggled = await toggleAssociatedControl(loc);
            if (toggled?.handled) {
              return { ok: true, message: `Checked ${ref}.`, checked: toggled.checked, snapshot: await snapshotAfterAction() };
            }
          }
          await loc.check({ timeout: NAV_TIMEOUT_MS });
          return { ok: true, message: `Checked ${ref}.`, snapshot: await snapshotAfterAction() };
        default:
          return { ok: false, error: `unknown action "${action}"` };
      }
    } catch (e) {
      return { ok: false, error: e?.message?.split("\n")[0] || "action failed" };
    }
  });
}

export async function closeBrowser() {
  try { await _context?.close(); } catch {}
  _context = null; _page = null;
}
