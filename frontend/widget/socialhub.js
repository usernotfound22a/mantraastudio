/**
 * SocialHub website widget.
 *
 * Self-contained on purpose: this file is served raw to a customer's website, so
 * it must not import from the dashboard bundle or the React runtime. Everything
 * it needs is inlined below, and the dashboard's copy (EmbedPreview) renders
 * the very same file in an iframe so what you test is what you ship.
 *
 *   GET /api/widget/config?key=...        bootstrap
 *   POST /api/widget/messages             visitor -> inbox
 *   GET  /api/widget/messages?afterId=n   poll for agent/AI replies
 *   POST /api/widget/typing               "visitor is typing"
 *
 * Polling rather than a socket: the widget runs on arbitrary third-party pages
 * with arbitrary CSP, and a 2s poll is invisible to the customer while costing
 * almost nothing. The dashboard is the side that needs realtime.
 */
(function () {
  'use strict';

  // `document.currentScript` is only populated while this file executes
  // synchronously, so it must be captured here - not inside a callback later.
  var scriptEl = document.currentScript;

  var API = (function () {
    // 1. Explicit override. The bundled harness page (?api=...) uses this so
    //    the preview iframe can target a different host than it was served by.
    if (window.SOCIALHUB_API) return window.SOCIALHUB_API;

    // 2. The reliable default: the script is always served BY the SocialHub
    //    API, so its own origin is the API origin no matter which customer
    //    site embeds it. Using location.origin here is the classic embed bug -
    //    on https://myshop.com it would send every request to
    //    https://myshop.com/api and the widget would silently never connect.
    if (scriptEl && scriptEl.src) {
      try {
        return new URL(scriptEl.src).origin + '/api';
      } catch (error) {
        // Malformed src: fall through to the guesses below.
      }
    }

    // 3. Vite dev server: the widget is loaded from :5173 but the API is :4000.
    if (location.port === '5173') return 'http://localhost:4000/api';

    // 4. Production: the API is exposed through the shared origin's /api path.
    return location.origin + '/api';
  })();

  var KEY = (scriptEl && scriptEl.getAttribute('data-key')) || window.SOCIALHUB_KEY;
  if (!KEY) {
    console.warn('[socialhub] no data-key on the script tag; widget not starting');
    return;
  }

  var STORAGE_KEY = 'socialhub_visitor';
  var POLL_MS = 2000;

  // ---------------------------------------------------------------- state
  var state = {
    open: false,
    config: null,
    messages: [],
    lastId: 0,
    visitorId: null,
    sending: false,
    pollTimer: null,
    unread: 0,
    lastReadAt: 0,
  };

  // ----------------------------------------------------------------- dom
  var launcher, panel, headerEl, logEl, formEl, inputEl, statusEl, badgeEl;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function visitorId() {
    if (state.visitorId) return state.visitorId;
    try {
      var stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        state.visitorId = stored;
        return stored;
      }
      var fresh = 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(STORAGE_KEY, fresh);
      state.visitorId = fresh;
      return fresh;
    } catch (error) {
      // Private browsing with storage disabled: keep the id in memory so the
      // current page still works, at the cost of losing history on reload.
      state.visitorId = state.visitorId || 'v_' + Math.random().toString(36).slice(2);
      return state.visitorId;
    }
  }

  function api(path, options) {
    return fetch(API + path, options).then(function (response) {
      return response
        .json()
        .catch(function () {
          return {};
        })
        .then(function (body) {
          if (!response.ok) {
            var message =
              (body && body.error && body.error.message) || 'Something went wrong. Please try again.';
            throw new Error(message);
          }
          return body;
        });
    });
  }

  // -------------------------------------------------------------- styling
  function style() {
    if (document.getElementById('socialhub-styles')) return;
    var css =
      '#socialhub-launcher{position:fixed;right:20px;bottom:20px;z-index:2147483000;width:56px;height:56px;' +
      'border-radius:9999px;border:none;cursor:pointer;box-shadow:0 10px 25px -5px rgba(15,23,42,.35);' +
      'display:flex;align-items:center;justify-content:center;transition:transform .18s ease}' +
      '#socialhub-launcher:hover{transform:scale(1.06)}' +
      '#socialhub-launcher svg{width:26px;height:26px;fill:#fff;pointer-events:none}' +
      '#socialhub-launcher.ch-close svg{display:none}' +
      '#socialhub-launcher .ch-badge{position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;' +
      'padding:0 5px;border-radius:9999px;background:#ef4444;color:#fff;font:600 11px/20px system-ui,sans-serif;' +
      'text-align:center;box-shadow:0 0 0 2px #fff}' +
      '#socialhub-panel{position:fixed;right:20px;bottom:88px;z-index:2147483000;width:370px;max-width:calc(100vw - 32px);' +
      'height:min(560px,calc(100vh - 130px));background:#fff;border-radius:16px;box-shadow:0 24px 60px -20px rgba(15,23,42,.45);' +
      'display:none;flex-direction:column;overflow:hidden;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
      'border:1px solid #e2e8f0}' +
      '#socialhub-panel.ch-open{display:flex}' +
      '#socialhub-panel *{box-sizing:border-box}' +
      '#socialhub-head{background:var(--ch-color,#4f46e5);color:#fff;padding:14px 16px;display:flex;' +
      'align-items:center;gap:10px}' +
      '#socialhub-head .ch-avatar{width:32px;height:32px;border-radius:9999px;background:rgba(255,255,255,.22);' +
      'display:flex;align-items:center;justify-content:center;font-weight:600;font-size:13px}' +
      '#socialhub-head .ch-title{font-size:14px;font-weight:600;line-height:1.2}' +
      '#socialhub-head .ch-sub{font-size:11px;opacity:.85;line-height:1.3}' +
      '#socialhub-head .ch-x{margin-left:auto;background:transparent;border:none;color:#fff;cursor:pointer;' +
      'font-size:20px;line-height:1;padding:2px 6px;border-radius:6px}' +
      '#socialhub-head .ch-x:hover{background:rgba(255,255,255,.16)}' +
      '#socialhub-log{flex:1;overflow-y:auto;padding:16px;background:#f8fafc;display:flex;flex-direction:column;gap:10px}' +
      '.ch-msg{max-width:82%;padding:9px 12px;border-radius:14px;font-size:13.5px;line-height:1.45;white-space:pre-wrap;' +
      'word-break:break-word}' +
      '.ch-msg.ch-them{align-self:flex-start;background:#fff;color:#1e293b;border-bottom-left-radius:4px;' +
      'box-shadow:0 1px 2px rgba(15,23,42,.08)}' +
      '.ch-msg.ch-me{align-self:flex-end;background:var(--ch-color,#4f46e5);color:#fff;border-bottom-right-radius:4px}' +
      '.ch-msg.ch-ai{align-self:flex-start;background:#f5f3ff;color:#4c1d95;border:1px solid #ddd6fe}' +
      '.ch-time{font-size:10px;opacity:.6;margin-top:3px}' +
      '.ch-typing{align-self:flex-start;background:#fff;border-radius:14px;padding:10px 12px;box-shadow:0 1px 2px rgba(15,23,42,.08)}' +
      '.ch-typing i{display:inline-block;width:5px;height:5px;border-radius:9999px;background:#94a3b8;' +
      'margin-right:3px;animation:ch-b 1.2s infinite}' +
      '.ch-typing i:nth-child(2){animation-delay:.2s}.ch-typing i:nth-child(3){animation-delay:.4s}' +
      '@keyframes ch-b{0%,60%,100%{transform:translateY(0);opacity:.5}30%{transform:translateY(-3px);opacity:1}}' +
      '#socialhub-form{border-top:1px solid #e2e8f0;padding:10px;display:flex;gap:8px;align-items:flex-end;background:#fff}' +
      '#socialhub-input{flex:1;border:1px solid #cbd5e1;border-radius:10px;padding:9px 11px;font-size:13.5px;' +
      'font-family:inherit;resize:none;max-height:96px;outline:none}' +
      '#socialhub-input:focus{border-color:var(--ch-color,#4f46e5);box-shadow:0 0 0 3px rgba(99,102,241,.14)}' +
      '#socialhub-send{background:var(--ch-color,#4f46e5);color:#fff;border:none;border-radius:10px;height:38px;' +
      'padding:0 14px;font-size:13.5px;font-weight:600;cursor:pointer;white-space:nowrap}' +
      '#socialhub-send:disabled{opacity:.5;cursor:not-allowed}' +
      '#socialhub-note{font-size:11px;color:#94a3b8;text-align:center;padding:0 10px 8px;background:#fff}' +
      '@media (max-width:480px){#socialhub-panel{right:8px;left:8px;width:auto;bottom:80px;' +
      'height:min(70vh,520px)}#socialhub-launcher{right:14px;bottom:14px}}';

    var tag = document.createElement('style');
    tag.id = 'socialhub-styles';
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  function icon() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    var path = document.createElementNS(ns, 'path');
    path.setAttribute(
      'd',
      'M12 3c-4.97 0-9 3.36-9 7.5 0 2.3 1.25 4.36 3.2 5.73-.13.86-.56 2.1-1.53 3.02 1.6-.16 3.1-.79 4.2-1.55.99.24 2.04.37 3.13.37 4.97 0 9-3.36 9-7.5S16.97 3 12 3z',
    );
    svg.appendChild(path);
    return svg;
  }

  function closeIcon() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z');
    svg.appendChild(path);
    return svg;
  }

  // ---------------------------------------------------------------- build
  function build() {
    style();

    launcher = el('button');
    launcher.id = 'socialhub-launcher';
    launcher.setAttribute('aria-label', 'Chat with us');
    launcher.appendChild(icon());
    badgeEl = el('span', 'ch-badge');
    badgeEl.style.display = 'none';
    launcher.appendChild(badgeEl);
    launcher.addEventListener('click', function () {
      toggle(!state.open);
    });

    panel = el('div');
    panel.id = 'socialhub-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Support chat');

    headerEl = el('div');
    headerEl.id = 'socialhub-head';
    var avatar = el('div', 'ch-avatar', 'CH');
    var titles = el('div');
    var title = el('div', 'ch-title', 'Support');
    statusEl = el('div', 'ch-sub', 'Typically replies within a few minutes');
    titles.appendChild(title);
    titles.appendChild(statusEl);
    var closeBtn = el('button', 'ch-x', '×');
    closeBtn.setAttribute('aria-label', 'Close chat');
    closeBtn.addEventListener('click', function () {
      toggle(false);
    });
    headerEl.appendChild(avatar);
    headerEl.appendChild(titles);
    headerEl.appendChild(closeBtn);

    logEl = el('div');
    logEl.id = 'socialhub-log';

    formEl = el('form');
    formEl.id = 'socialhub-form';
    inputEl = el('textarea');
    inputEl.id = 'socialhub-input';
    inputEl.rows = 1;
    inputEl.setAttribute('aria-label', 'Your message');
    var sendButtonElement = el('button', null, 'Send');
    sendButtonElement.id = 'socialhub-send';
    sendButtonElement.type = 'submit';
    formEl.appendChild(inputEl);
    formEl.appendChild(sendButtonElement);

    formEl.addEventListener('submit', function (event) {
      event.preventDefault();
      send();
    });

    // Enter sends, Shift+Enter is a newline - the convention everywhere.
    inputEl.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        send();
      }
    });
    inputEl.addEventListener('input', function () {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 96) + 'px';
      pingTyping(true);
    });

    var note = el('div', null, 'Powered by SocialHub');
    note.id = 'socialhub-note';

    panel.appendChild(headerEl);
    panel.appendChild(logEl);
    panel.appendChild(formEl);
    panel.appendChild(note);

    document.body.appendChild(launcher);
    document.body.appendChild(panel);
  }

  function toggle(open) {
    state.open = open;
    panel.classList.toggle('ch-open', open);
    launcher.classList.toggle('ch-close', open);
    launcher.innerHTML = '';
    launcher.appendChild(open ? closeIcon() : icon());
    if (open) {
      state.unread = 0;
      badgeEl.style.display = 'none';
      if (inputEl) inputEl.focus();
      scrollDown();
      startPolling();
    } else {
      stopPolling();
    }
  }

  // -------------------------------------------------------------- render
  function greeting() {
    var config = state.config || {};
    var bubble = el('div', 'ch-msg ch-them');
    bubble.appendChild(document.createTextNode(config.greeting || 'Hi! How can we help?'));
    logEl.appendChild(bubble);
  }

  function paint() {
    logEl.innerHTML = '';
    if (!state.messages.length) {
      greeting();
    } else {
      state.messages.forEach(function (message) {
        logEl.appendChild(bubble(message));
      });
    }
    scrollDown();
  }

  /**
   * Renders one message.
   *
   * `direction` is stored from the BUSINESS point of view, which is the
   * opposite of what the visitor sees:
   *   inbound  = the visitor typed it   -> right-hand bubble (ch-me)
   *   outbound = an agent/AI replied    -> left-hand bubble
   * Getting this backwards shows the customer's own questions as if they were
   * answers from support, so it is worth stating explicitly.
   */
  function bubble(message) {
    var mine = message.direction === 'inbound';
    var kind = mine
      ? 'ch-me'
      : message.senderType === 'ai'
        ? 'ch-ai'
        : 'ch-them';
    var node = el('div', 'ch-msg ' + kind);
    node.appendChild(document.createTextNode(message.body || ''));
    if (message.sentAt) {
      var time = el('div', 'ch-time');
      time.textContent = new Date(message.sentAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
      node.appendChild(time);
    }
    return node;
  }

  function scrollDown() {
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  }

  function atBottom() {
    if (!logEl) return true;
    return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 80;
  }

  // ----------------------------------------------------------------- net
  function boot() {
    api('/widget/config?key=' + encodeURIComponent(KEY))
      .then(function (config) {
        state.config = config;
        var colour = config.themeColor || '#4f46e5';
        document.documentElement.style.setProperty('--ch-color', colour);
        launcher.style.background = colour;
        var title = headerEl.querySelector('.ch-title');
        if (title) title.textContent = config.companyName || 'Support';
        var sub = headerEl.querySelector('.ch-sub');
        if (sub) {
          sub.textContent = config.aiEnabled
            ? 'Assistant online - a human is standing by'
            : 'We usually reply within a few minutes';
        }
        if (inputEl) inputEl.setAttribute('placeholder', config.placeholder || 'Type your message...');
        greeting();
        return load(true);
      })
      .catch(function (error) {
        console.warn('[socialhub] config failed:', error.message);
        var node = el(
          'div',
          'ch-msg ch-them',
          'Chat is unavailable right now. Please email us instead.',
        );
        logEl.appendChild(node);
      });
  }

  function load(initial) {
    var url =
      '/widget/messages?key=' +
      encodeURIComponent(KEY) +
      '&visitorId=' +
      encodeURIComponent(visitorId()) +
      (state.lastId ? '&afterId=' + state.lastId : '');
    return api(url)
      .then(function (data) {
        var incoming = data.messages || [];
        if (!incoming.length) {
          if (initial) paint();
          return;
        }

        // Append only what we have not already rendered. Two cases matter:
        //   - a poll that races the POST above would re-add the same row
        //   - afterId can restart from 0 if the server lost the id
        // De-duplicating by id keeps the log correct in both.
        var known = {};
        state.messages.forEach(function (message) {
          known[message.id] = true;
        });
        var fresh = incoming.filter(function (message) {
          return !known[message.id];
        });

        state.lastId = incoming[incoming.length - 1].id;
        if (!fresh.length) {
          if (initial) paint();
          return;
        }
        state.messages = state.messages.concat(fresh);

        var visible = state.open && atBottom();
        if (visible) {
          paint();
        } else {
          // Only repaint when something new arrived off-screen; otherwise this
          // runs every 2s and would fight the user's scrolling.
          fresh.forEach(function (message) {
            logEl.appendChild(bubble(message));
          });
          if (!state.open) {
            state.unread += fresh.length;
            badgeEl.textContent = String(state.unread);
            badgeEl.style.display = 'block';
          }
        }
        if (initial) paint();
      })
      .catch(function () {
        // Polling failures are expected while a laptop sleeps; the next tick
        // retries, so there is nothing useful to show the customer.
      });
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(function () {
      load(false);
    }, POLL_MS);
    document.addEventListener('visibilitychange', onVisible);
  }

  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
    document.removeEventListener('visibilitychange', onVisible);
  }

  function onVisible() {
    if (!document.hidden && state.open) load(false);
  }

  var typingTimer = null;
  function pingTyping(isTyping) {
    if (typingTimer) clearTimeout(typingTimer);
    api('/widget/typing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ widgetKey: KEY, visitorId: visitorId(), isTyping: isTyping }),
    }).catch(function () {});
    // Auto-clear server-side if the customer just stops typing.
    if (isTyping) typingTimer = setTimeout(function () { pingTyping(false); }, 2500);
  }

  function send() {
    var text = inputEl.value.trim();
    if (!text || state.sending) return;

    state.sending = true;
    inputEl.value = '';
    inputEl.style.height = 'auto';
    sendButton().disabled = true;
    pingTyping(false);

    // Optimistic: the customer must see their own message immediately, even if
    // the request is slow. Direction is 'inbound' because that is how the
    // server will store it, so the bubble matches the server copy later.
    var tempId = 'tmp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    state.messages.push({
      id: tempId,
      body: text,
      direction: 'inbound',
      senderType: 'visitor',
      sentAt: new Date().toISOString(),
    });
    paint();

    api('/widget/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        widgetKey: KEY,
        visitorId: visitorId(),
        message: text,
        pageUrl: location.href,
        referrer: document.referrer || undefined,
      }),
    })
      .then(function (data) {
        // The server reports conversationId, so history survives correctly.
        if (data && data.conversationId) state.conversationId = data.conversationId;

        // Swap the optimistic bubble for the authoritative server row when the
        // API hands one back, instead of blindly dropping the temp message:
        // that removes the duplicate AND preserves the real id and timestamp.
        var saved = data && data.message;
        if (saved && saved.id) {
          state.messages = state.messages.map(function (message) {
            return message.id === tempId ? saved : message;
          });
        } else {
          state.messages = state.messages.filter(function (message) {
            return message.id !== tempId;
          });
        }
        paint();
        load(false);
      })
      .catch(function (error) {
        var node = el('div', 'ch-msg ch-them', 'That did not send: ' + error.message);
        logEl.appendChild(node);
        scrollDown();
        inputEl.value = text;
      })
      .finally(function () {
        state.sending = false;
        sendButton().disabled = false;
        inputEl.focus();
      });
  }

  function sendButton() {
    return formEl.querySelector('#socialhub-send');
  }

  // --------------------------------------------------------------- start
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  function start() {
    build();
    boot();
  }
})();
