const { execFileSync } = require('child_process');

const PROFILE = process.env.KF1688_BROWSER_PROFILE || 'user';
const IM_URL_KEYWORDS = ['def_cbu_web_im', 'alires', 'message.1688.com', 'wangwang', 'trade.1688.com'];
const IM_FRAME_SELECTOR = 'iframe[src*="def_cbu_web_im_core"]';
const DEFAULT_RETRY = Number(process.env.KF1688_BROWSER_RETRY || 3);
const DEFAULT_RETRY_WAIT_MS = Number(process.env.KF1688_BROWSER_RETRY_WAIT_MS || 1200);

function browserErrorDetails(error) {
  return {
    message: error && error.message ? error.message : String(error),
    stdout: error && error.stdout ? String(error.stdout) : '',
    stderr: error && error.stderr ? String(error.stderr) : ''
  };
}

function isClosedSelectedPageError(error) {
  const details = browserErrorDetails(error);
  const text = `${details.message}\n${details.stdout}\n${details.stderr}`;
  return /selected page has been closed/i.test(text);
}

function forceResetSelectedPage() {
  const commands = [
    ['tabs'],
    ['open', 'about:blank']
  ];

  for (const args of commands) {
    try {
      execFileSync('openclaw', ['browser', '--browser-profile', PROFILE, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      });
      return true;
    } catch (_) {}
  }

  return false;
}

function runBrowser(args) {
  try {
    return execFileSync('openclaw', ['browser', '--browser-profile', PROFILE, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch (error) {
    if (isClosedSelectedPageError(error) && args[0] === 'tabs') {
      forceResetSelectedPage();
      return execFileSync('openclaw', ['browser', '--browser-profile', PROFILE, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      }).trim();
    }
    throw error;
  }
}

function parseTabs(out) {
  const lines = out.split('\n');
  const tabs = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\d+\.\s+(.*)$/);
    if (!m) continue;
    const title = m[1].trim();
    const url = (lines[i + 1] || '').trim();
    const idLine = (lines[i + 2] || '').trim();
    const idMatch = idLine.match(/^id:\s*(.+)$/);
    tabs.push({ title, url, id: idMatch ? idMatch[1] : '' });
  }
  return tabs;
}

function listTabs() {
  return parseTabs(runBrowser(['tabs']));
}

function startBrowser() {
  try {
    runBrowser(['start']);
  } catch (_) {}
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

function ensureImTab() {
  startBrowser();
  let tabs = [];
  try {
    tabs = listTabs();
  } catch (_) {
    startBrowser();
    tabs = listTabs();
  }
  const candidates = tabs.filter(t => IM_URL_KEYWORDS.some(keyword => (t.url || '').includes(keyword) || (t.title || '').includes(keyword)));
  const tab = candidates[0];
  if (!tab) {
    const error = new Error('1688 IM tab not found');
    error.details = {
      tabs: tabs.map(t => ({ title: t.title, url: t.url, id: t.id })).slice(0, 20),
      keywords: IM_URL_KEYWORDS
    };
    throw error;
  }
  runBrowser(['focus', tab.id]);
  return tab;
}

function evalInIm(fnSource) {
  return JSON.parse(runBrowser(['evaluate', '--fn', fnSource]));
}

function getConversationState() {
  const fn = `() => {
    const frame = document.querySelector('${IM_FRAME_SELECTOR}');
    const framePresent = !!frame;
    const doc = frame && frame.contentDocument;
    if (!doc) {
      return {
        ok:false,
        reason: framePresent ? 'no-frame-doc' : 'no-frame',
        framePresent,
        locationHref: location.href,
        title: document.title
      };
    }
    const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const rows = Array.from(doc.querySelectorAll('.conversation-item')).map(row => ({
      name: norm(row.querySelector('.name')?.innerText || row.querySelector('.name')?.textContent || ''),
      badge: norm(row.querySelector('.unread-badge')?.innerText || row.querySelector('.unread-badge')?.textContent || ''),
      desc: norm(row.querySelector('.desc')?.innerText || row.querySelector('.desc')?.textContent || ''),
      time: norm(row.querySelector('.time')?.innerText || row.querySelector('.time')?.textContent || ''),
      active: row.classList ? row.classList.contains('active') : false
    })).filter(x => x.name);
    const activeConversation = rows.find(x => x.active) || null;
    const panel = doc.querySelector('.message-list, .message-content, .msg-list, .chat-content, .im-main-content, .message-wrapper') || doc.body;
    if (panel && typeof panel.scrollTo === 'function') {
      panel.scrollTo({ top: panel.scrollHeight, behavior: 'instant' });
    }
    if (panel) panel.scrollTop = panel.scrollHeight;
    if (doc.scrollingElement) doc.scrollingElement.scrollTop = doc.scrollingElement.scrollHeight;
    const panelText = norm(panel.innerText || panel.textContent || '');
    const body = norm(doc.body.innerText || '');
    const editable = doc.querySelector('pre.edit[contenteditable="true"], [contenteditable="true"].edit, [contenteditable="true"]');
    const send = Array.from(doc.querySelectorAll('button')).find(b => ((b.innerText || b.textContent || '').replace(/\\s+/g, ' ').trim()) === '发送');
    return {
      ok:true,
      unread: rows.filter(x => x.badge),
      activeConversation,
      panelTail: panelText.slice(-2600),
      tail: body.slice(-3500),
      framePresent: true,
      controls: {
        editableFound: !!editable,
        sendFound: !!send
      },
      scroll: {
        panelScrollTop: panel && typeof panel.scrollTop === 'number' ? panel.scrollTop : null,
        panelScrollHeight: panel && typeof panel.scrollHeight === 'number' ? panel.scrollHeight : null
      },
      locationHref: location.href,
      title: document.title
    };
  }`;
  return evalInIm(fn);
}

function clickConversationByName(name) {
  const safe = JSON.stringify(name);
  const fn = `() => {
    const target = ${safe};
    const frame = document.querySelector('${IM_FRAME_SELECTOR}');
    const doc = frame && frame.contentDocument;
    if (!doc) return { ok:false, reason: frame ? 'no-frame-doc' : 'no-frame' };
    const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const nameEl = Array.from(doc.querySelectorAll('.name')).find(el => norm(el.innerText || el.textContent || '') === target);
    if (!nameEl) {
      return {
        ok:false,
        reason:'target-not-found',
        available: Array.from(doc.querySelectorAll('.name')).map(el => norm(el.innerText || el.textContent || '')).filter(Boolean).slice(0, 30)
      };
    }
    const row = nameEl.closest('.conversation-item') || nameEl.parentElement;
    row.scrollIntoView({ block:'center' });
    row.click();
    return { ok:true, rowText: norm(row.innerText || row.textContent || '') };
  }`;
  return evalInIm(fn);
}

function openConversationAndRead(name, waitMs = 1200) {
  const clickResult = clickConversationByName(name);
  if (!clickResult || !clickResult.ok) {
    return { ok: false, clickResult, state: null };
  }
  sleep(waitMs);
  const state = getConversationState();
  return { ok: true, clickResult, state };
}

function sendText(text) {
  const safe = JSON.stringify(text);
  const fn = `() => {
    const text = ${safe};
    const frame = document.querySelector('${IM_FRAME_SELECTOR}');
    const doc = frame && frame.contentDocument;
    if (!doc) {
      return {
        ok:false,
        reason: frame ? 'no-frame-doc' : 'no-frame'
      };
    }
    const editable = doc.querySelector('pre.edit[contenteditable="true"], [contenteditable="true"].edit, [contenteditable="true"]');
    const send = Array.from(doc.querySelectorAll('button')).find(b => ((b.innerText || b.textContent || '').replace(/\\s+/g, ' ').trim()) === '发送');
    if (!editable || !send) {
      return {
        ok:false,
        reason:'missing-controls',
        diagnostics: {
          editableFound: !!editable,
          sendFound: !!send,
          buttons: Array.from(doc.querySelectorAll('button')).map(b => ((b.innerText || b.textContent || '').replace(/\\s+/g, ' ').trim())).filter(Boolean).slice(0, 20),
          bodyTail: ((doc.body && (doc.body.innerText || doc.body.textContent)) || '').replace(/\\s+/g, ' ').trim().slice(-400)
        }
      };
    }
    editable.focus();
    editable.textContent = '';
    editable.textContent = text;
    editable.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'insertText', data:text }));
    editable.dispatchEvent(new Event('change', { bubbles:true }));
    send.click();
    return { ok:true, sent:text };
  }`;
  return evalInIm(fn);
}

function sendTextWithRecovery(text, options = {}) {
  const attempts = options.attempts || DEFAULT_RETRY;
  const waitMs = options.waitMs || DEFAULT_RETRY_WAIT_MS;
  const steps = [];

  for (let i = 0; i < attempts; i++) {
    const sendResult = sendText(text);
    steps.push({
      attempt: i + 1,
      sendResult
    });

    if (sendResult && sendResult.ok) {
      return {
        ok: true,
        sendResult,
        steps
      };
    }

    const shouldRecover = sendResult && ['no-frame', 'no-frame-doc', 'missing-controls'].includes(sendResult.reason);
    if (!shouldRecover) {
      return {
        ok: false,
        sendResult,
        steps
      };
    }

    const recovered = recoverImTab({ attempts: 1, waitMs });
    steps[steps.length - 1].recovered = recovered;
    sleep(waitMs);
  }

  return {
    ok: false,
    sendResult: steps.length ? steps[steps.length - 1].sendResult : null,
    steps
  };
}

function getRecentProductCardContext() {
  const fn = `() => {
    const frame = document.querySelector('${IM_FRAME_SELECTOR}');
    const doc = frame && frame.contentDocument;
    if (!doc) {
      return { ok:false, reason: frame ? 'no-frame-doc' : 'no-frame' };
    }

    const norm = (value) => String(value || '').split(' ').filter(Boolean).join(' ').trim();
    const nodes = Array.from(doc.querySelectorAll('.text-od-wrap, .infoWrap, .content, .message-item, .message-item-line, .item'));
    const productLike = nodes.filter(node => {
      const text = norm(node.innerText || node.textContent || '');
      return text.includes('￥') && text.length > 3;
    });

    const target = productLike.length ? productLike[productLike.length - 1] : null;
    if (!target) {
      return { ok:true, candidates: [], ancestry: [] };
    }

    const ancestry = [];
    let current = target;
    let depth = 0;
    while (current && depth < 8) {
      const dataset = current.dataset ? Object.fromEntries(Object.entries(current.dataset).slice(0, 10)) : {};
      ancestry.push({
        depth,
        tag: current.tagName || '',
        className: typeof current.className === 'string' ? current.className : '',
        text: norm(current.innerText || current.textContent || '').slice(0, 200),
        onclickType: typeof current.onclick,
        role: current.getAttribute ? (current.getAttribute('role') || '') : '',
        href: current.getAttribute ? (current.getAttribute('href') || '') : '',
        dataUrl: current.getAttribute ? (current.getAttribute('data-url') || '') : '',
        dataHref: current.getAttribute ? (current.getAttribute('data-href') || '') : '',
        dataLink: current.getAttribute ? (current.getAttribute('data-link') || '') : '',
        dataset,
        childCount: current.children ? current.children.length : 0
      });
      current = current.parentElement;
      depth += 1;
    }

    return {
      ok: true,
      candidates: [{
        tag: target.tagName || '',
        className: typeof target.className === 'string' ? target.className : '',
        text: norm(target.innerText || target.textContent || '').slice(0, 200)
      }],
      ancestry
    };
  }`;

  return evalInIm(fn);
}


function clickRecentProductCardAndCaptureUrl(options = {}) {
  const waitMs = options.waitMs || 1500;
  const beforeTabs = listTabs();

  const fn = `() => {
    const frame = document.querySelector('${IM_FRAME_SELECTOR}');
    const doc = frame && frame.contentDocument;
    if (!doc) {
      return { ok:false, reason: frame ? 'no-frame-doc' : 'no-frame' };
    }

    const norm = (value) => String(value || '').trim();
    const cards = Array.from(doc.querySelectorAll('.infoWrap, .text-od-wrap, .content, .item, .message-item'));
    const card = cards.reverse().find(node => {
      const text = String(node.innerText || node.textContent || '');
      return text.includes('￥') && text.length > 5;
    });
    if (!card) return { ok:false, reason:'product-card-not-found' };

    const titleCandidates = Array.from(card.querySelectorAll('span, div, p')).map(el => ({
      el,
      text: norm(el.innerText || el.textContent || '')
    })).filter(item => item.text && !item.text.includes('￥') && item.text.length >= 8);

    const targetItem = titleCandidates.sort((a, b) => b.text.length - a.text.length)[0];
    if (!targetItem) {
      return {
        ok:false,
        reason:'product-title-not-found',
        cardText: String(card.innerText || card.textContent || '').slice(0, 200)
      };
    }

    const target = targetItem.el;
    ['mousedown', 'mouseup', 'click'].forEach(type => {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    });

    return {
      ok:true,
      text: targetItem.text,
      className: typeof target.className === 'string' ? target.className : '',
      cardClassName: typeof card.className === 'string' ? card.className : ''
    };
  }`;

  const clickResult = evalInIm(fn);
  if (!clickResult || !clickResult.ok) {
    return {
      ok: false,
      clickResult,
      beforeTabs,
      afterTabs: []
    };
  }

  sleep(waitMs);
  const afterTabs = listTabs();
  const beforeIds = new Set(beforeTabs.map(t => t.id));
  const detailTabs = afterTabs.filter(t => /detail\.1688\.com\/offer\//.test(t.url || ''));
  const newDetailTab = detailTabs.find(t => !beforeIds.has(t.id));
  const targetTab = newDetailTab || detailTabs[detailTabs.length - 1] || null;

  return {
    ok: true,
    clickResult,
    beforeTabs,
    afterTabs,
    targetTab,
    productUrl: targetTab ? targetTab.url : ''
  };
}

function focusTab(tabId) {
  if (!tabId) return { ok: false, reason: 'missing-tab-id' };
  try {
    runBrowser(['focus', tabId]);
    return { ok: true, tabId };
  } catch (error) {
    return {
      ok: false,
      reason: 'focus-failed',
      tabId,
      error: browserErrorDetails(error)
    };
  }
}

function closeTab(tabId) {
  if (!tabId) return { ok: false, reason: 'missing-tab-id' };
  try {
    runBrowser(['close', tabId]);
    return { ok: true, tabId };
  } catch (error) {
    return {
      ok: false,
      reason: 'close-failed',
      tabId,
      error: browserErrorDetails(error)
    };
  }
}

function cleanupProductTabs(options = {}) {
  const keepTabIds = new Set((options.keepTabIds || []).filter(Boolean));
  const tabs = listTabs();
  const detailTabs = tabs.filter(t => /detail\.1688\.com\/offer\//.test(t.url || ''));
  const closable = detailTabs.filter(t => !keepTabIds.has(t.id));
  const closed = closable.map(tab => ({ tab, result: closeTab(tab.id) }));
  return {
    ok: true,
    totalDetailTabs: detailTabs.length,
    kept: detailTabs.filter(t => keepTabIds.has(t.id)),
    closed
  };
}

function captureDetailPageSignals(tabId, options = {}) {
  if (!tabId) return { ok: false, reason: 'missing-tab-id' };
  const scrollSteps = options.scrollSteps || 6;
  const waitMs = options.waitMs || 700;
  const snapshots = [];

  try {
    focusTab(tabId);
    for (let i = 0; i < scrollSteps; i++) {
      const out = runBrowser(['evaluate', '--fn', `() => {
        const norm = s => String(s || '').replace(/\\s+/g, ' ').trim();
        window.scrollBy(0, Math.max(window.innerHeight * 0.9, 700));
        const text = norm(document.body && (document.body.innerText || document.body.textContent) || '');
        const html = document.body && document.body.innerHTML ? document.body.innerHTML : '';
        const cmHits = Array.from(new Set((text.match(/\\b\\d+(?:\\.\\d+)?\\s*(?:cm|厘米|mm|毫米)\\b/gi) || []).slice(0, 40)));
        const sizeLike = Array.from(new Set((text.match(/\\b\\d+(?:\\.\\d+)?\\s*[x×*]\\s*\\d+(?:\\.\\d+)?\\s*(?:cm|厘米|mm|毫米)?\\b/gi) || []).slice(0, 40)));
        const detailKeywords = [];
        if (/尺寸|规格|厘米|cm|mm|毫米/.test(text)) detailKeywords.push('size-keywords');
        if (/详情|产品参数|商品详情/.test(text)) detailKeywords.push('detail-keywords');
        return {
          scrollY: window.scrollY,
          bodyTail: text.slice(-4000),
          cmHits,
          sizeLike,
          detailKeywords,
          hasDetailSection: /尺寸|规格|厘米|cm|mm|毫米/.test(text) || /尺寸|规格|厘米|cm|mm|毫米/.test(html)
        };
      }`]);
      snapshots.push(safeJsonParse(out, { raw: out }));
      sleep(waitMs);
    }

    const mergedTail = snapshots.map(x => x && x.bodyTail || '').filter(Boolean).join('\n');
    const cmHits = Array.from(new Set(snapshots.flatMap(x => x && x.cmHits || [])));
    const sizeLike = Array.from(new Set(snapshots.flatMap(x => x && x.sizeLike || [])));
    const detailKeywords = Array.from(new Set(snapshots.flatMap(x => x && x.detailKeywords || [])));

    return {
      ok: true,
      tabId,
      snapshots,
      mergedTail: mergedTail.slice(-12000),
      cmHits,
      sizeLike,
      detailKeywords,
      hasDetailSection: snapshots.some(x => x && x.hasDetailSection)
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'capture-failed',
      tabId,
      error: browserErrorDetails(error),
      snapshots
    };
  }
}

function diagnoseIm() {
  try {
    const state = getConversationState();
    if (state && state.ok) {
      return {
        ok: true,
        kind: 'im-state',
        state
      };
    }
    return {
      ok: false,
      kind: 'im-state',
      state
    };
  } catch (error) {
    return {
      ok: false,
      kind: 'exception',
      error: error && error.message ? error.message : String(error)
    };
  }
}

function recoverImTab(options = {}) {
  const attempts = options.attempts || DEFAULT_RETRY;
  const waitMs = options.waitMs || DEFAULT_RETRY_WAIT_MS;
  const steps = [];

  for (let i = 0; i < attempts; i++) {
    try {
      const tab = ensureImTab();
      sleep(waitMs);
      const diagnosis = diagnoseIm();
      steps.push({
        attempt: i + 1,
        tab,
        diagnosis
      });
      if (diagnosis.ok) {
        return {
          ok: true,
          recovered: true,
          tab,
          diagnosis,
          steps
        };
      }
    } catch (error) {
      steps.push({
        attempt: i + 1,
        error: error && error.message ? error.message : String(error)
      });
    }
    sleep(waitMs);
  }

  return {
    ok: false,
    recovered: false,
    steps
  };
}

module.exports = {
  ensureImTab,
  getConversationState,
  clickConversationByName,
  openConversationAndRead,
  sendText,
  sendTextWithRecovery,
  getRecentProductCardContext,
  clickRecentProductCardAndCaptureUrl,
  focusTab,
  closeTab,
  cleanupProductTabs,
  captureDetailPageSignals,
  listTabs,
  diagnoseIm,
  recoverImTab,
  safeJsonParse
};
