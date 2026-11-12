/* AI Receptionist — website chat widget (template).
 *
 * Embed with one script tag (served by the same server that answers
 * /chat, so the widget always matches the deployed backend):
 *   <script src="https://<your-domain>/widget.js" async></script>
 * The API base URL is derived from this script's own src; override
 * with window.AI_RECEPTIONIST_CHAT_API = 'https://<your-domain>'
 * before the script tag if needed. No dependencies, no tracking,
 * no cookies. Conversations are not stored in the browser beyond
 * the page session.
 *
 * BEFORE GOING LIVE: fill in the CONFIG block below with your own
 * business details, and set CHAT_ALLOWED_ORIGINS on the server to
 * the origin this widget is embedded on.
 */
(function () {
  'use strict';
  if (window.__aiReceptionistChatLoaded) return;
  window.__aiReceptionistChatLoaded = true;

  /* -------------------------------------------------- CONFIGURE THIS */
  var CONFIG = {
    businessName: '[YOUR BUSINESS NAME]',
    phoneDisplay: '[YOUR PUBLIC BUSINESS NUMBER]',
    phoneTel: '[YOUR PUBLIC BUSINESS NUMBER, E.164 — e.g. +15551234567]',
    email: '[YOUR BUSINESS EMAIL]',
    greeting: "Hi! I'm the [YOUR BUSINESS NAME] assistant. Ask me about our services, prices, hours, or how to book — or tap a suggestion below.",
    quickReplies: [
      '[SUGGESTED QUESTION 1, e.g. Prices & hours]',
      '[SUGGESTED QUESTION 2, e.g. How do I book?]',
      '[SUGGESTED QUESTION 3, e.g. Where are you located?]',
      '[SUGGESTED QUESTION 4, e.g. Cancellation policy]'
    ],
    // Only these hosts are ever turned into clickable links, so a stray
    // URL in a model reply can never become a link off-site. List your
    // own website host and your booking provider's host, without www.
    linkHosts: ['[YOUR WEBSITE HOST, e.g. www.example.com]', '[YOUR BOOKING PROVIDER HOST, e.g. booking.example.com]'],
    colorPrimary: '#1b2a6b', // header + user bubbles
    colorPrimaryHover: '#24378c',
    colorAccent: '#ff6600' // send button + focus ring
  };

  var API_BASE = (function () {
    if (window.AI_RECEPTIONIST_CHAT_API) return String(window.AI_RECEPTIONIST_CHAT_API).replace(/\/$/, '');
    try {
      var src = (document.currentScript && document.currentScript.src) || '';
      var m = src.match(/^(https?:\/\/[^/]+)/);
      if (m) return m[1];
    } catch (e) { /* fall through */ }
    return '';
  })();

  var SESSION_ID = (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'web-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);

  var ERROR_TEXT = "Sorry, I'm having trouble right now. Please call us at " + CONFIG.phoneDisplay + " or email " + CONFIG.email + " and we'll help you directly.";
  var LINK_HOSTS = CONFIG.linkHosts.map(function (h) { return h.replace(/^www\./, ''); });

  /* ---------------------------------------------------------- styles */
  var CSS =
    '#ai-chat-launcher{position:fixed;right:20px;bottom:20px;width:58px;height:58px;border-radius:50%;border:0;cursor:pointer;background:' + CONFIG.colorPrimary + ';color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.28);z-index:999990;display:flex;align-items:center;justify-content:center;padding:0}' +
    '#ai-chat-launcher:hover{background:' + CONFIG.colorPrimaryHover + '}' +
    '#ai-chat-launcher:focus-visible,#ai-chat-panel button:focus-visible,#ai-chat-input:focus-visible{outline:3px solid ' + CONFIG.colorAccent + ';outline-offset:2px}' +
    '#ai-chat-panel{position:fixed;right:20px;bottom:90px;width:380px;max-width:calc(100vw - 40px);height:560px;max-height:calc(100vh - 120px);background:#fff;border-radius:14px;box-shadow:0 10px 36px rgba(0,0,0,.30);z-index:999991;display:none;flex-direction:column;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}' +
    '#ai-chat-panel.ai-open{display:flex}' +
    '#ai-chat-header{background:' + CONFIG.colorPrimary + ';color:#fff;padding:14px 16px;display:flex;align-items:flex-start;gap:10px}' +
    '#ai-chat-header h2{margin:0;font-size:16px;line-height:1.3;font-weight:700}' +
    '#ai-chat-header p{margin:3px 0 0;font-size:12.5px;line-height:1.4;opacity:.88}' +
    '#ai-chat-close{margin-left:auto;background:transparent;border:0;color:#fff;font-size:22px;line-height:1;cursor:pointer;padding:2px 6px}' +
    '#ai-chat-messages{flex:1;overflow-y:auto;padding:14px 14px 6px;display:flex;flex-direction:column;gap:10px;background:#f4f5fa}' +
    '.ai-msg{max-width:86%;padding:9px 12px;border-radius:12px;font-size:14px;line-height:1.5;white-space:pre-wrap;overflow-wrap:break-word}' +
    '.ai-msg a{color:' + CONFIG.colorPrimary + ';font-weight:600}' +
    '.ai-msg-assistant{align-self:flex-start;background:#fff;color:#222;box-shadow:0 1px 3px rgba(0,0,0,.08)}' +
    '.ai-msg-user{align-self:flex-end;background:' + CONFIG.colorPrimary + ';color:#fff}' +
    '.ai-msg-user a{color:#fff}' +
    '.ai-typing{display:flex;gap:4px;padding:12px 14px}' +
    '.ai-typing span{width:7px;height:7px;border-radius:50%;background:#9aa0b5;animation:ai-blink 1.2s infinite}' +
    '.ai-typing span:nth-child(2){animation-delay:.2s}.ai-typing span:nth-child(3){animation-delay:.4s}' +
    '@keyframes ai-blink{0%,80%,100%{opacity:.25}40%{opacity:1}}' +
    '#ai-chat-chips{display:flex;flex-wrap:wrap;gap:6px;padding:8px 14px;background:#f4f5fa}' +
    '#ai-chat-chips button{border:1px solid #c9cde0;background:#fff;color:' + CONFIG.colorPrimary + ';border-radius:999px;padding:6px 11px;font-size:13px;cursor:pointer}' +
    '#ai-chat-chips button:hover{background:#eef0f8}' +
    '#ai-chat-form{display:flex;gap:8px;padding:10px 12px;border-top:1px solid #e3e5ee;background:#fff}' +
    '#ai-chat-input{flex:1;border:1px solid #c9cde0;border-radius:999px;padding:10px 14px;font-size:14px;min-width:0}' +
    '#ai-chat-send{border:0;border-radius:999px;background:' + CONFIG.colorAccent + ';color:#fff;padding:0 18px;font-size:14px;font-weight:700;cursor:pointer}' +
    '#ai-chat-send:disabled{opacity:.55;cursor:default}' +
    '#ai-chat-footer{padding:7px 14px 10px;background:#fff;font-size:12px;color:#666;text-align:center}' +
    '#ai-chat-footer a{color:' + CONFIG.colorPrimary + ';font-weight:600}' +
    '@media (max-width:480px){#ai-chat-panel{right:10px;bottom:86px;max-width:calc(100vw - 20px);height:calc(100vh - 110px)}#ai-chat-launcher{right:14px;bottom:16px}}';

  /* ------------------------------------------------------------ DOM */
  function el(tag, attrs, html) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (html != null) n.innerHTML = html;
    return n;
  }

  var style = el('style', { type: 'text/css' });
  style.appendChild(document.createTextNode(CSS));
  document.head.appendChild(style);

  var CHAT_ICON = '<svg width="27" height="27" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-2.9-.4-4.1-1L3 20l1.1-5.4A8.5 8.5 0 1 1 21 11.5Z" fill="currentColor"/></svg>';
  var CLOSE_ICON = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

  var launcher = el('button', { id: 'ai-chat-launcher', 'aria-label': 'Open chat with ' + CONFIG.businessName + ' assistant', title: 'Chat with us' }, CHAT_ICON);
  document.body.appendChild(launcher);

  var panel = el('div', { id: 'ai-chat-panel', role: 'dialog', 'aria-label': CONFIG.businessName + ' chat assistant' });
  panel.innerHTML =
    '<div id="ai-chat-header"><div><h2>' + CONFIG.businessName + ' Assistant</h2><p>AI assistant — answers from our business info. For bookings and refunds, call us.</p></div>' +
    '<button id="ai-chat-close" aria-label="Close chat">&times;</button></div>' +
    '<div id="ai-chat-messages" aria-live="polite"></div>' +
    '<div id="ai-chat-chips"></div>' +
    '<form id="ai-chat-form"><input id="ai-chat-input" type="text" placeholder="Ask a question…" autocomplete="off" maxlength="1000" aria-label="Type your question" /><button id="ai-chat-send" type="submit">Send</button></form>' +
    '<div id="ai-chat-footer">Prefer to talk? Call <a href="tel:' + CONFIG.phoneTel + '">' + CONFIG.phoneDisplay + '</a> · <a href="mailto:' + CONFIG.email + '">Email us</a></div>';
  document.body.appendChild(panel);

  var messagesBox = panel.querySelector('#ai-chat-messages');
  var chipsBox = panel.querySelector('#ai-chat-chips');
  var form = panel.querySelector('#ai-chat-form');
  var input = panel.querySelector('#ai-chat-input');
  var sendBtn = panel.querySelector('#ai-chat-send');
  var greeted = false;
  var awaiting = false;

  /* ------------------------------------------------------- rendering */
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function hostAllowed(url) {
    try {
      var h = new URL(url).hostname.replace(/^www\./, '');
      return LINK_HOSTS.indexOf(h) !== -1;
    } catch (e) { return false; }
  }
  // Renders a model reply safely: HTML-escaped first, then only
  // Markdown links and bare URLs on the allowed hosts become links.
  function renderReply(text) {
    var safe = escapeHtml(text);
    safe = safe.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_, label, url) {
      if (!hostAllowed(url)) return label;
      return '<a href="' + url + '" target="_blank" rel="noopener">' + label + '</a>';
    });
    safe = safe.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, function (_, pre, url) {
      if (!hostAllowed(url)) return pre + url;
      return pre + '<a href="' + url + '" target="_blank" rel="noopener">' + url + '</a>';
    });
    safe = safe.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    return safe;
  }
  function addMessage(text, who, isHtml) {
    var div = el('div', { 'class': 'ai-msg ai-msg-' + who });
    if (isHtml) div.innerHTML = text;
    else div.textContent = text;
    messagesBox.appendChild(div);
    messagesBox.scrollTop = messagesBox.scrollHeight;
    return div;
  }
  function showTyping() {
    var div = el('div', { 'class': 'ai-msg ai-msg-assistant ai-typing', 'aria-label': 'Assistant is typing' }, '<span></span><span></span><span></span>');
    messagesBox.appendChild(div);
    messagesBox.scrollTop = messagesBox.scrollHeight;
    return div;
  }

  CONFIG.quickReplies.forEach(function (q) {
    var b = el('button', { type: 'button' });
    b.textContent = q;
    b.addEventListener('click', function () { sendMessage(q); });
    chipsBox.appendChild(b);
  });

  /* ---------------------------------------------------------- behaviour */
  function openPanel() {
    panel.classList.add('ai-open');
    launcher.innerHTML = CLOSE_ICON;
    launcher.setAttribute('aria-label', 'Close chat');
    if (!greeted) {
      greeted = true;
      addMessage(CONFIG.greeting, 'assistant');
    }
    setTimeout(function () { input.focus(); }, 50);
  }
  function closePanel() {
    panel.classList.remove('ai-open');
    launcher.innerHTML = CHAT_ICON;
    launcher.setAttribute('aria-label', 'Open chat with ' + CONFIG.businessName + ' assistant');
  }
  launcher.addEventListener('click', function () {
    if (panel.classList.contains('ai-open')) closePanel();
    else openPanel();
  });
  panel.querySelector('#ai-chat-close').addEventListener('click', closePanel);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && panel.classList.contains('ai-open')) closePanel();
  });

  function sendMessage(text) {
    var msg = (text || '').trim();
    if (!msg || awaiting) return;
    if (!panel.classList.contains('ai-open')) openPanel();
    addMessage(msg, 'user');
    input.value = '';
    awaiting = true;
    sendBtn.disabled = true;
    input.disabled = true;
    var typing = showTyping();
    fetch(API_BASE + '/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID, message: msg })
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        typing.remove();
        addMessage(renderReply(data.reply || ERROR_TEXT), 'assistant', true);
      })
      .catch(function () {
        typing.remove();
        addMessage(ERROR_TEXT, 'assistant');
      })
      .finally(function () {
        awaiting = false;
        sendBtn.disabled = false;
        input.disabled = false;
        input.focus();
      });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    sendMessage(input.value);
  });
})();
