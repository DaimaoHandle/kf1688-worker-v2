const fs = require('fs');
const path = require('path');
const {
  ensureImTab,
  getConversationState,
  openConversationAndRead,
  sendTextWithRecovery,
  getRecentProductCardContext,
  clickRecentProductCardAndCaptureUrl,
  focusTab,
  cleanupProductTabs,
  captureDetailPageSignals,
  recoverImTab
} = require('./browser-adapter');
const {
  extractEffectiveMessages,
  latestOutstandingCustomerMessage,
  findOutstandingCustomerMessage,
  buildMessageFingerprint
} = require('./message-parser');

const SHORT_ACK_DEDUPE_MS = Number(process.env.KF1688_SHORT_ACK_DEDUPE_MS || 2 * 60 * 1000);
const { sendFeishuText, formatEscalationNotice } = require('./notify');
const { requestProductAnalysisByMainAgent } = require('./product-ai');

const STATE_PATH = process.env.KF1688_WORKER_STATE || path.join(__dirname, '..', 'runtime-state.json');
const POLL_MS = Number(process.env.KF1688_POLL_MS || 8000);
const ERROR_BACKOFF_MS = Number(process.env.KF1688_ERROR_BACKOFF_MS || 15000);
const DEDUPE_WINDOW_MS = Number(process.env.KF1688_DEDUPE_WINDOW_MS || 4 * 60 * 60 * 1000);
const CONTEXT_ONLY_FALLBACK_MS = Number(process.env.KF1688_CONTEXT_ONLY_FALLBACK_MS || 60 * 1000);

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(event, data = {}) {
  console.log(JSON.stringify({
    ts: nowIso(),
    event,
    ...data
  }));
}

function holdingReply() {
  return '在的亲，这边帮您查一下哦。';
}

function simpleReply(text, latest = null) {
  if (latest && latest.pureEmojiCode) {
    return '好的亲亲';
  }
  if (/多久发货|什么时候发货|今天还能发货吗|今天可以发货吗|今天能发吗|今天发得出吗|当天能发吗|今天能安排发货吗|现在下单今天能发吗/.test(text)) {
    return '亲，正常下单后一般是48小时内发货哦，如果您这边比较着急，我也可以帮您催一下呢。';
  }
  if (/你好|hello|哈喽|在吗/.test(text)) {
    return '在的亲，有什么可以帮您的';
  }
  return '';
}

function clarificationReply() {
  return '亲，收到商品了，请问您想了解这款的什么信息呢？';
}

function ackReply() {
  return '好的亲，有问题您再联系我';
}

function productContextRequestReply() {
  return '亲，麻烦您发下商品链接或者商品卡片，我帮您看下哦。';
}

function isContextOnlyMessage(latest) {
  if (!latest) return false;
  return !!latest.isCustomer && !latest.hasQuestion && !latest.needsEscalation && !latest.shouldUseAi && /￥|商品|规格|店铺/.test(latest.text || '');
}

function closingReply() {
  return '好的亲亲，有需要您再联系我。';
}

function normalizeAckLikeMessage(text) {
  const cleaned = (text || '').trim();
  const rules = [
    [/^好$/, '好'],
    [/^好的$/, '好的'],
    [/^好的亲$/, '好的亲'],
    [/^知道了$/, '知道了'],
    [/^晓得了$/, '晓得了'],
    [/^了解了$/, '了解了'],
    [/^收到$/, '收到'],
    [/^收到啦$/, '收到啦'],
    [/^行$/, '行'],
    [/^行的$/, '行的'],
    [/^可以$/, '可以'],
    [/^可的$/, '可的'],
    [/^ok$/i, 'ok'],
    [/^okay$/i, 'okay'],
    [/^okk$/i, 'okk'],
    [/^嗯$/, '嗯'],
    [/^嗯嗯$/, '嗯嗯'],
    [/^哦$/, '哦'],
    [/^哦哦$/, '哦哦'],
    [/^哈$/, '哈'],
    [/^哈哈$/, '哈哈'],
    [/^1$/, '1'],
    [/^👌+$/, '👌'],
    [/^👍+$/, '👍'],
    [/^🙏+$/, '🙏'],
    [/^❤+$/, '❤'],
    [/^❤️+$/, '❤️']
  ];
  for (const [re, canonical] of rules) {
    if (re.test(cleaned)) return canonical;
  }
  return '';
}

function isAckLikeMessage(text) {
  return !!normalizeAckLikeMessage(text);
}

function isClosingLikeMessage(text) {
  const cleaned = (text || '').trim();
  return [
    /^没事了$/,
    /^没事啦$/,
    /^不用了$/,
    /^先这样$/,
    /^好的谢谢$/,
    /^好嘞谢谢$/,
    /^行谢谢$/,
    /^谢谢$/,
    /^谢了$/,
    /^不用啦$/,
    /^暂时不用$/
  ].some(re => re.test(cleaned));
}

function loadRuntimeState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (!state.seen) state.seen = {};
    if (!state.inflight) state.inflight = {};
    if (!state.completed) state.completed = {};
    if (!state.pendingReplies) state.pendingReplies = {};
    return state;
  } catch (_) {
    return {
      seen: {},
      inflight: {},
      completed: {},
      pendingReplies: {},
      lastLoopAt: null,
      lastErrorAt: null,
      lastError: null,
      lastResult: null
    };
  }
}

function saveRuntimeState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

function gcSeen(seen, now = Date.now()) {
  for (const [key, value] of Object.entries(seen)) {
    if (!value || !value.at || now - value.at > DEDUPE_WINDOW_MS) delete seen[key];
  }
}

function gcMap(map, windowMs = DEDUPE_WINDOW_MS, now = Date.now()) {
  for (const [key, value] of Object.entries(map || {})) {
    if (!value || !value.at || now - value.at > windowMs) delete map[key];
  }
}

function rememberAction(state, fingerprint, action, extra = {}) {
  state.seen[fingerprint] = {
    at: Date.now(),
    action,
    ...extra
  };
}

function generateReplyCode() {
  return `R${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function buildEscalationNotice(latest, state, conversation, replyCode = '') {
  const reasonMap = {
    keyword: '命中人工介入关键词',
    'product-card-question': '商品卡片/找款类问法',
    'system-product-card': '系统商品卡片消息'
  };
  return {
    type: 'escalation',
    replyCode,
    conversation: conversation || (state.unread && state.unread[0] && state.unread[0].name) || '当前会话',
    customerText: latest.text,
    reason: reasonMap[latest.escalationReason] || '命中人工介入规则'
  };
}

function buildAiTodo(latest, conversation, productContext = null) {
  const urlMatch = (latest.text || '').match(/https?:\/\/\S+/);
  return {
    type: 'main-agent-product-analysis',
    conversation: conversation || '当前会话',
    customerText: latest.text,
    cardIntent: latest.cardIntent || '',
    productUrl: latest.productUrl || (productContext && productContext.productUrl) || (urlMatch ? urlMatch[0] : ''),
    note: '应由当前主 agent 使用现有 user 浏览器会话开新标签继承登录态，打开商品链接后返回结构化商品信息'
  };
}

function parseLatestFromState(state, conversationName) {
  const textSource = state.panelTail || state.tail || '';
  const effective = extractEffectiveMessages(textSource, 8);
  let latest = latestOutstandingCustomerMessage(effective);
  let outstanding = findOutstandingCustomerMessage(effective);

  const activeDesc = ((state.activeConversation && state.activeConversation.desc) || '').trim();
  const fallbackDesc = activeDesc.replace(/\s*(已读|未读)\s*$/g, '').trim();
  if (!latest && fallbackDesc && /^\/:[-\w()]+$/.test(fallbackDesc)) {
    latest = {
      text: fallbackDesc,
      originalText: fallbackDesc,
      pureEmojiCode: true,
      rawText: fallbackDesc,
      speaker: conversationName || (state.activeConversation && state.activeConversation.name) || '',
      ts: '',
      role: 'customer',
      isSystem: false,
      isMeta: false,
      hasProductCard: false,
      hasQuestion: false,
      needsClarification: false,
      shouldUseAi: false,
      cardIntent: '',
      needsProductContext: false,
      productUrl: '',
      needsEscalation: false,
      escalationReason: '',
      isSeller: false,
      isCustomer: true,
      signature: fallbackDesc,
      hasRecentProductContext: false,
      recentProductContextText: '',
      hasProductContext: false,
      synthetic: 'activeConversation.desc'
    };
    outstanding = {
      latest,
      hasOutstanding: true,
      coveredBySellerReply: false,
      lastMessageRole: 'customer'
    };
  }

  return {
    textSource,
    effective,
    latest,
    outstanding,
    conversationName: conversationName || (state.activeConversation && state.activeConversation.name) || ''
  };
}

function ensureReadableConversationState() {
  const tab = ensureImTab();
  let state = getConversationState();
  let recovered = null;

  if (!state.ok) {
    recovered = recoverImTab();
    if (recovered.ok && recovered.diagnosis && recovered.diagnosis.state) {
      state = recovered.diagnosis.state;
    }
  }

  if (!state.ok) {
    const error = new Error(state.reason || 'failed to read IM state');
    error.details = {
      tab,
      state,
      recovered
    };
    throw error;
  }

  return { tab, state, recovered };
}

function assertSendResult(sendResult, stage, context = {}) {
  if (sendResult && sendResult.ok) return;
  if (sendResult && sendResult.sendResult && sendResult.sendResult.ok) return;
  const root = sendResult && sendResult.sendResult ? sendResult.sendResult : sendResult;
  const error = new Error(`${stage} failed: ${(root && root.reason) || 'unknown'}`);
  error.details = {
    stage,
    sendResult: root,
    recovery: sendResult && sendResult.steps ? sendResult.steps : null,
    ...context
  };
  throw error;
}

function refreshCurrentConversationIfStale(state, conversationName) {
  const desc = ((state.activeConversation && state.activeConversation.desc) || '').trim();
  const lastSeen = runtimeStateSafeCurrentDesc(this.runtimeState, conversationName);
  const hasNewDesc = !!desc && desc !== lastSeen;
  const parsed = parseLatestFromState(state, conversationName);
  const latestMissing = !parsed.latest;

  if (conversationName && hasNewDesc && latestMissing) {
    const reopened = openConversationAndRead(conversationName, 1200);
    if (reopened && reopened.ok && reopened.state && reopened.state.ok) {
      return { refreshed: true, state: reopened.state, previousDesc: lastSeen, currentDesc: desc };
    }
  }
  return { refreshed: false, state, previousDesc: lastSeen, currentDesc: desc };
}

function runtimeStateSafeCurrentDesc(runtimeState, conversationName) {
  const key = conversationName || '__current__';
  if (!runtimeState.currentDesc) runtimeState.currentDesc = {};
  return runtimeState.currentDesc[key] || '';
}

function rememberCurrentDesc(runtimeState, conversationName, desc) {
  const key = conversationName || '__current__';
  if (!runtimeState.currentDesc) runtimeState.currentDesc = {};
  runtimeState.currentDesc[key] = desc || '';
}

function processOnce(runtimeState) {
  const ensured = ensureReadableConversationState();
  const tab = ensured.tab;
  let state = ensured.state;
  const recovered = ensured.recovered;

  const result = {
    at: nowIso(),
    tab: tab ? { id: tab.id, title: tab.title, url: tab.url } : null,
    recovered,
    unreadCount: (state.unread || []).length,
    unreadNames: (state.unread || []).map(x => x.name),
    activeConversation: state.activeConversation || null,
    latest: null,
    outstanding: null,
    effectiveMessages: [],
    action: 'none',
    controls: state.controls || null
  };

  log('loop.scan', {
    unreadCount: result.unreadCount,
    unreadNames: result.unreadNames,
    activeConversation: result.activeConversation && result.activeConversation.name,
    recovered: !!recovered
  });

  const initialParsed = parseLatestFromState(state, (state.activeConversation && state.activeConversation.name) || '');
  result.outstanding = initialParsed.outstanding;

  if (initialParsed.outstanding && initialParsed.outstanding.hasOutstanding) {
    result.action = 'stay-current-outstanding';
    log('conversation.keep-current', {
      activeConversation: state.activeConversation && state.activeConversation.name,
      latestText: initialParsed.outstanding.latest && initialParsed.outstanding.latest.text,
      unreadCount: result.unreadCount,
      reason: 'current-conversation-has-outstanding-customer-message'
    });
  } else if ((state.unread || []).length) {
    const target = state.unread[0].name;
    const opened = openConversationAndRead(target, 1200);
    result.target = target;
    result.clickResult = opened.clickResult;
    if (opened.ok && opened.state && opened.state.ok) {
      state = opened.state;
      result.action = 'switch-unread';
      result.activeConversation = state.activeConversation || null;
      result.controls = state.controls || null;
      log('conversation.opened', {
        target,
        clickOk: true,
        activeConversation: result.activeConversation && result.activeConversation.name
      });
    } else {
      result.action = 'switch-unread-failed';
      result.stateAfterClick = opened.state;
      log('conversation.open-failed', {
        target,
        clickResult: opened.clickResult,
        stateAfterClick: opened.state
      });
      return result;
    }
  }

  const refresh = refreshCurrentConversationIfStale.call({ runtimeState }, state, result.target || (state.activeConversation && state.activeConversation.name) || '');
  state = refresh.state;
  result.refreshedConversation = refresh.refreshed ? {
    previousDesc: refresh.previousDesc,
    currentDesc: refresh.currentDesc
  } : null;

  const parsed = parseLatestFromState(state, result.target || (state.activeConversation && state.activeConversation.name) || '');
  result.outstanding = parsed.outstanding;
  const latest = parsed.latest;
  result.latest = latest;
  result.effectiveMessages = parsed.effective.map(msg => ({
    text: msg.text,
    isSystem: msg.isSystem,
    isMeta: msg.isMeta,
    hasProductCard: msg.hasProductCard,
    hasQuestion: msg.hasQuestion,
    needsClarification: msg.needsClarification,
    shouldUseAi: msg.shouldUseAi,
    cardIntent: msg.cardIntent,
    needsProductContext: msg.needsProductContext,
    productUrl: msg.productUrl,
    hasRecentProductContext: msg.hasRecentProductContext,
    recentProductContextText: msg.recentProductContextText,
    needsEscalation: msg.needsEscalation,
    escalationReason: msg.escalationReason,
    isSeller: msg.isSeller,
    isCustomer: msg.isCustomer
  }));
  result.debugTail = parsed.textSource ? parsed.textSource.slice(-500) : '';

  rememberCurrentDesc(runtimeState, parsed.conversationName, state.activeConversation && state.activeConversation.desc);

  log('message.parsed', {
    conversation: parsed.conversationName,
    effectiveCount: parsed.effective.length,
    activeDesc: state.activeConversation && state.activeConversation.desc,
    activeTime: state.activeConversation && state.activeConversation.time,
    latestText: latest && latest.text,
    latestOriginalText: latest && (latest.originalText || latest.text),
    latestTs: latest && latest.ts,
    latestSynthetic: latest && latest.synthetic,
    latestNeedsEscalation: latest && latest.needsEscalation,
    latestEscalationReason: latest && latest.escalationReason,
    latestHasProductCard: latest && latest.hasProductCard,
    latestHasQuestion: latest && latest.hasQuestion,
    latestNeedsClarification: latest && latest.needsClarification,
    latestShouldUseAi: latest && latest.shouldUseAi,
    latestCardIntent: latest && latest.cardIntent,
    latestNeedsProductContext: latest && latest.needsProductContext,
    latestProductUrl: latest && latest.productUrl,
    latestHasRecentProductContext: latest && latest.hasRecentProductContext,
    latestRecentProductContextText: latest && latest.recentProductContextText,
    latestIsSeller: latest && latest.isSeller,
    latestIsCustomer: latest && latest.isCustomer,
    controls: result.controls,
    scroll: state.scroll || null
  });

  if (latest) {
    const fingerprint = buildMessageFingerprint(parsed.conversationName, latest);
    const seen = runtimeState.seen[fingerprint];
    const ackCanonical = normalizeAckLikeMessage(latest.text);
    const conversationKey = parsed.conversationName || '__current__';
    const inflight = runtimeState.inflight[conversationKey];
    const completed = runtimeState.completed[conversationKey];
    result.fingerprint = fingerprint;

    if (inflight && inflight.fingerprint === fingerprint) {
      result.action = 'inflight-skip';
      result.inflight = inflight;
      log('message.inflight-skip', {
        conversation: parsed.conversationName,
        fingerprint,
        inflightAt: inflight.at
      });
      return result;
    }

    if (completed && completed.fingerprint === fingerprint) {
      result.action = 'completed-skip';
      result.completed = completed;
      log('message.completed-skip', {
        conversation: parsed.conversationName,
        fingerprint,
        completedAt: completed.at
      });
      return result;
    }

    if (seen && seen.action !== 'ai-product-analysis-missing-url') {
      result.action = result.action === 'switch-unread' ? 'switch-unread-deduped' : 'deduped';
      result.dedupedBy = seen;
      log('message.deduped', {
        conversation: parsed.conversationName,
        fingerprint,
        previousAction: seen.action,
        previousAt: seen.at
      });
      return result;
    }

    if (ackCanonical) {
      const recentAck = Object.entries(runtimeState.seen).find(([key, value]) => {
        return key.includes(`| ack | ${ackCanonical}`)
          && key.startsWith(`${parsed.conversationName || ''} |`)
          && value && value.at
          && (Date.now() - value.at) < SHORT_ACK_DEDUPE_MS;
      });
      if (recentAck) {
        result.action = result.action === 'switch-unread' ? 'switch-unread-deduped-ack-family' : 'deduped-ack-family';
        result.dedupedBy = recentAck[1];
        log('message.deduped-ack-family', {
          conversation: parsed.conversationName,
          fingerprint,
          ackCanonical,
          previousAction: recentAck[1].action,
          previousAt: recentAck[1].at
        });
        return result;
      }
    }

    runtimeState.inflight[conversationKey] = {
      fingerprint,
      at: Date.now(),
      text: latest.text
    };

    if (isContextOnlyMessage(latest)) {
      const tsMs = latest.ts ? new Date(latest.ts.replace(' ', 'T') + '+08:00').getTime() : Date.now();
      const ageMs = Date.now() - tsMs;
      if (ageMs < CONTEXT_ONLY_FALLBACK_MS) {
        rememberAction(runtimeState, fingerprint, 'context-only-waiting', { ageMs, text: latest.text });
        delete runtimeState.inflight[conversationKey];
        result.action = 'context-only-waiting';
        log('message.context-only-waiting', {
          conversation: parsed.conversationName,
          fingerprint,
          customerText: latest.text,
          ageMs,
          waitMs: CONTEXT_ONLY_FALLBACK_MS
        });
        return result;
      }

      const reply = holdingReply();
      const sendReplyResult = sendTextWithRecovery(reply);
      assertSendResult(sendReplyResult, 'send-context-only-fallback-reply', {
        conversation: parsed.conversationName,
        customerText: latest.text
      });
      const notice = {
        conversation: parsed.conversationName,
        customerText: latest.text,
        reason: '商品卡已等待60秒仍无后续问题，转人工处理'
      };
      const notifyResult = sendFeishuText(formatEscalationNotice(notice));
      rememberAction(runtimeState, fingerprint, 'context-only-fallback-escalated', { reply, notice });
      runtimeState.completed[conversationKey] = { fingerprint, at: Date.now(), action: 'context-only-fallback-escalated' };
      delete runtimeState.inflight[conversationKey];
      result.action = 'context-only-fallback-escalated';
      result.reply = reply;
      result.replyResult = sendReplyResult;
      result.notice = notice;
      result.notifyResult = notifyResult;
      log('message.context-only-fallback-escalated', {
        conversation: parsed.conversationName,
        fingerprint,
        customerText: latest.text,
        ageMs,
        sendReplyOk: true,
        notifyOk: true
      });
      return result;
    }

    if (latest.needsEscalation) {
      const reply = holdingReply();
      const sendReplyResult = sendTextWithRecovery(reply);
      assertSendResult(sendReplyResult, 'send-holding-reply', {
        conversation: parsed.conversationName,
        customerText: latest.text
      });
      const replyCode = generateReplyCode();
      const notice = buildEscalationNotice(latest, state, parsed.conversationName, replyCode);
      runtimeState.pendingReplies[replyCode] = {
        at: Date.now(),
        conversation: parsed.conversationName,
        customerText: latest.text,
        fingerprint,
        status: 'pending'
      };
      const notifyResult = sendFeishuText(formatEscalationNotice(notice));
      saveRuntimeState(runtimeState);
      rememberAction(runtimeState, fingerprint, 'replied-hold', { notice, reply, replyCode });
      result.action = 'replied-hold';
      result.reply = reply;
      result.replyResult = sendReplyResult;
      result.notice = notice;
      result.notifyResult = notifyResult;
      log('message.escalated', {
        conversation: parsed.conversationName,
        fingerprint,
        customerText: latest.text,
        reply,
        noticeReason: notice.reason,
        sendReplyOk: true,
        notifyOk: true
      });
      return result;
    }

    if (latest.hasProductCard && latest.needsClarification) {
      const reply = clarificationReply();
      const sendReplyResult = sendTextWithRecovery(reply);
      assertSendResult(sendReplyResult, 'send-clarification-reply', {
        conversation: parsed.conversationName,
        customerText: latest.text
      });
      rememberAction(runtimeState, fingerprint, 'replied-clarification', { reply });
      result.action = 'replied-clarification';
      result.reply = reply;
      result.replyResult = sendReplyResult;
      log('message.card-clarification', {
        conversation: parsed.conversationName,
        fingerprint,
        customerText: latest.text,
        reply,
        cardIntent: latest.cardIntent,
        sendReplyOk: true
      });
      return result;
    }

    if (latest.needsProductContext) {
      const reply = productContextRequestReply();
      const sendReplyResult = sendTextWithRecovery(reply);
      assertSendResult(sendReplyResult, 'send-product-context-request-reply', {
        conversation: parsed.conversationName,
        customerText: latest.text
      });
      rememberAction(runtimeState, fingerprint, 'replied-product-context-request', { reply });
      result.action = 'replied-product-context-request';
      result.reply = reply;
      result.replyResult = sendReplyResult;
      log('message.product-context-requested', {
        conversation: parsed.conversationName,
        fingerprint,
        customerText: latest.text,
        reply,
        sendReplyOk: true
      });
      return result;
    }

    if (latest.shouldUseAi) {
      const productContext = latest.hasProductContext ? getRecentProductCardContext() : null;
      result.productContext = productContext;
      log('message.product-context-dom', {
        conversation: parsed.conversationName,
        fingerprint,
        productContext,
        hasProductContext: latest.hasProductContext
      });

      const ancestry = (productContext && productContext.ancestry) || [];
      const clickableProductNode = ancestry.find(node => node && (node.dataset?.spmAnchorId || node.onclickType === 'function' || node.onclickType === 'object'));
      let clickedProduct = null;
      if (latest.hasProductContext && clickableProductNode && !productContext.productUrl) {
        clickedProduct = clickRecentProductCardAndCaptureUrl();
        result.clickedProduct = clickedProduct;
        log('message.product-card-clicked', {
          conversation: parsed.conversationName,
          fingerprint,
          clickedProduct
        });
      }

      const aiTodo = buildAiTodo(latest, parsed.conversationName, {
        ...(productContext || {}),
        productUrl: (clickedProduct && clickedProduct.productUrl) || (productContext && productContext.productUrl) || ''
      });
      if (!aiTodo.productUrl) {
        const reply = holdingReply();
        const sendReplyResult = sendTextWithRecovery(reply);
        assertSendResult(sendReplyResult, 'send-ai-missing-url-holding-reply', {
          conversation: parsed.conversationName,
          customerText: latest.text
        });
        const replyCode = generateReplyCode();
        const notice = {
          type: 'escalation',
          replyCode,
          conversation: parsed.conversationName,
          customerText: latest.text,
          reason: latest.hasProductContext ? '商品分析缺少有效商品链接，转人工处理' : '客户在追问商品信息，但当前未识别到可用商品上下文，转人工处理'
        };
        runtimeState.pendingReplies[replyCode] = {
          at: Date.now(),
          conversation: parsed.conversationName,
          customerText: latest.text,
          fingerprint,
          status: 'pending'
        };
        const notifyResult = sendFeishuText(formatEscalationNotice(notice));
        saveRuntimeState(runtimeState);
        rememberAction(runtimeState, fingerprint, 'ai-missing-url-escalated', { aiTodo, notice, reply, replyCode });
        runtimeState.completed[conversationKey] = { fingerprint, at: Date.now(), action: 'ai-missing-url-escalated' };
        delete runtimeState.inflight[conversationKey];
        result.action = 'ai-missing-url-escalated';
        result.aiTodo = aiTodo;
        result.reply = reply;
        result.replyResult = sendReplyResult;
        result.notice = notice;
        result.notifyResult = notifyResult;
        log('message.ai-missing-url-escalated', {
          conversation: parsed.conversationName,
          fingerprint,
          customerText: latest.text,
          cardIntent: latest.cardIntent,
          hasProductContext: latest.hasProductContext,
          sendReplyOk: true,
          notifyOk: true
        });
        return result;
      }

      const aiRequest = requestProductAnalysisByMainAgent({
        productUrl: aiTodo.productUrl,
        customerQuestion: latest.text,
        conversation: parsed.conversationName
      });

      result.aiTodo = aiTodo;
      result.aiRequest = aiRequest;

      if (aiRequest && aiRequest.ok && aiRequest.analysis && aiRequest.analysis.answer) {
        const finalReply = aiRequest.analysis.answer.trim();
        const imFocusResult = tab && tab.id ? focusTab(tab.id) : { ok: false, reason: 'missing-im-tab-id' };
        const cleanupResult = cleanupProductTabs();
        const sendReplyResult = sendTextWithRecovery(finalReply);
        assertSendResult(sendReplyResult, 'send-ai-analysis-reply', {
          conversation: parsed.conversationName,
          customerText: latest.text,
          productUrl: aiTodo.productUrl,
          analysis: aiRequest.analysis
        });

        rememberAction(runtimeState, fingerprint, 'replied-main-agent-product-analysis', {
          aiTodo,
          aiRequest,
          reply: finalReply,
          imFocusResult,
          cleanupResult
        });
        runtimeState.completed[conversationKey] = { fingerprint, at: Date.now(), action: 'replied-main-agent-product-analysis' };
        delete runtimeState.inflight[conversationKey];
        result.action = 'replied-main-agent-product-analysis';
        result.reply = finalReply;
        result.replyResult = sendReplyResult;
        result.imFocusResult = imFocusResult;
        result.cleanupResult = cleanupResult;
        log('message.main-agent-analysis-replied', {
          conversation: parsed.conversationName,
          fingerprint,
          customerText: latest.text,
          productUrl: aiTodo.productUrl,
          mode: aiRequest.mode,
          confidence: aiRequest.analysis.confidence || '',
          reply: finalReply,
          imFocusOk: !!(imFocusResult && imFocusResult.ok),
          closedProductTabs: cleanupResult && cleanupResult.closed ? cleanupResult.closed.filter(x => x.result && x.result.ok).length : 0,
          sendReplyOk: true
        });
        return result;
      }

      const notice = {
        conversation: parsed.conversationName,
        customerText: latest.text,
        reason: '主 agent 商品分析未返回可用 answer，需人工检查'
      };
      const notifyResult = sendFeishuText(formatEscalationNotice(notice));
      rememberAction(runtimeState, fingerprint, 'main-agent-product-analysis-failed', {
        aiTodo,
        aiRequest,
        notice
      });
      runtimeState.completed[conversationKey] = { fingerprint, at: Date.now(), action: 'main-agent-product-analysis-failed' };
      delete runtimeState.inflight[conversationKey];
      result.action = 'main-agent-product-analysis-failed';
      result.notice = notice;
      result.notifyResult = notifyResult;
      log('message.main-agent-analysis-failed', {
        conversation: parsed.conversationName,
        fingerprint,
        customerText: latest.text,
        productUrl: aiTodo.productUrl,
        mode: aiRequest && aiRequest.mode,
        rawText: aiRequest && aiRequest.rawText ? aiRequest.rawText.slice(0, 500) : ''
      });
      return result;
    }

    if (isClosingLikeMessage(latest.text)) {
      const reply = closingReply();
      const sendReplyResult = sendTextWithRecovery(reply);
      assertSendResult(sendReplyResult, 'send-closing-reply', {
        conversation: parsed.conversationName,
        customerText: latest.text
      });
      rememberAction(runtimeState, fingerprint, 'replied-closing', { reply });
      runtimeState.completed[conversationKey] = { fingerprint, at: Date.now(), action: 'replied-closing' };
      delete runtimeState.inflight[conversationKey];
      result.action = 'replied-closing';
      result.reply = reply;
      result.replyResult = sendReplyResult;
      log('message.closing-replied', {
        conversation: parsed.conversationName,
        fingerprint,
        customerText: latest.text,
        reply,
        sendReplyOk: true
      });
      return result;
    }

    if (isAckLikeMessage(latest.text)) {
      const reply = ackReply();
      const sendReplyResult = sendTextWithRecovery(reply);
      assertSendResult(sendReplyResult, 'send-ack-reply', {
        conversation: parsed.conversationName,
        customerText: latest.text
      });
      rememberAction(runtimeState, `${parsed.conversationName || ''} | ack | ${ackCanonical} | ${fingerprint}`, 'replied-ack', { reply, ackCanonical });
      runtimeState.completed[conversationKey] = { fingerprint, at: Date.now(), action: 'replied-ack' };
      delete runtimeState.inflight[conversationKey];
      result.action = 'replied-ack';
      result.reply = reply;
      result.replyResult = sendReplyResult;
      log('message.ack-replied', {
        conversation: parsed.conversationName,
        fingerprint,
        customerText: latest.text,
        reply,
        sendReplyOk: true
      });
      return result;
    }

    const simple = simpleReply(latest.text, latest);
    if (simple) {
      const sendReplyResult = sendTextWithRecovery(simple);
      assertSendResult(sendReplyResult, 'send-simple-reply', {
        conversation: parsed.conversationName,
        customerText: latest.text
      });
      rememberAction(runtimeState, fingerprint, 'replied-simple', { reply: simple });
      runtimeState.completed[conversationKey] = { fingerprint, at: Date.now(), action: 'replied-simple' };
      delete runtimeState.inflight[conversationKey];
      result.action = 'replied-simple';
      result.reply = simple;
      result.replyResult = sendReplyResult;
      log('message.auto-replied', {
        conversation: parsed.conversationName,
        fingerprint,
        customerText: latest.text,
        reply: simple,
        sendReplyOk: true
      });
      return result;
    }

    const reply = holdingReply();
    const sendReplyResult = sendTextWithRecovery(reply);
    assertSendResult(sendReplyResult, 'send-fallback-holding-reply', {
      conversation: parsed.conversationName,
      customerText: latest.text
    });
    const notice = {
      conversation: parsed.conversationName,
      customerText: latest.text,
      reason: '未命中自动回复规则，转人工处理'
    };
    const notifyResult = sendFeishuText(formatEscalationNotice(notice));
    saveRuntimeState(runtimeState);
    rememberAction(runtimeState, fingerprint, 'fallback-escalated', { reply, notice });
    runtimeState.completed[conversationKey] = { fingerprint, at: Date.now(), action: 'fallback-escalated' };
    delete runtimeState.inflight[conversationKey];
    result.action = 'fallback-escalated';
    result.reply = reply;
    result.replyResult = sendReplyResult;
    result.notice = notice;
    result.notifyResult = notifyResult;
    log('message.fallback-escalated', {
      conversation: parsed.conversationName,
      fingerprint,
      customerText: latest.text,
      reply,
      reason: notice.reason,
      sendReplyOk: true,
      notifyOk: true
    });
    return result;
  } else {
    log('message.none', {
      conversation: parsed.conversationName,
      effectiveCount: parsed.effective.length
    });
  }

  return result;
}

async function loop() {
  const runtimeState = loadRuntimeState();
  gcSeen(runtimeState.seen);

  while (true) {
    try {
      runtimeState.lastLoopAt = nowIso();
      gcSeen(runtimeState.seen);
      gcMap(runtimeState.inflight, 30 * 60 * 1000);
      gcMap(runtimeState.completed, DEDUPE_WINDOW_MS);
      const result = processOnce(runtimeState);
      runtimeState.lastErrorAt = null;
      runtimeState.lastError = null;
      runtimeState.lastResult = {
        at: result.at,
        action: result.action,
        target: result.target || null,
        unreadCount: result.unreadCount,
        latestText: result.latest && result.latest.text,
        fingerprint: result.fingerprint || null
      };
      saveRuntimeState(runtimeState);
      console.log(JSON.stringify(result, null, 2));
      await sleep(POLL_MS);
    } catch (error) {
      runtimeState.lastErrorAt = nowIso();
      runtimeState.lastError = error && error.stack ? error.stack : String(error);
      runtimeState.lastResult = error && error.details ? { error: error.details } : runtimeState.lastResult;
      saveRuntimeState(runtimeState);
      console.error(`[kf1688-worker-v2] ${runtimeState.lastErrorAt} ${runtimeState.lastError}`);
      if (error && error.details) {
        console.error(JSON.stringify({ ts: nowIso(), event: 'loop.error-details', ...error.details }, null, 2));
      }
      await sleep(ERROR_BACKOFF_MS);
    }
  }
}

function sendManualReplyByCode(replyCode, text) {
  const runtimeState = loadRuntimeState();
  const pending = runtimeState.pendingReplies && runtimeState.pendingReplies[replyCode];
  if (!pending) {
    throw new Error(`pending reply code not found: ${replyCode}`);
  }
  const tab = ensureImTab();
  const opened = openConversationAndRead(pending.conversation, 1200);
  if (!opened || !opened.ok) {
    throw new Error(`failed to open conversation: ${pending.conversation}`);
  }
  const sendReplyResult = sendTextWithRecovery(text);
  if (!(sendReplyResult && sendReplyResult.ok)) {
    throw new Error(`failed to send reply for ${replyCode}`);
  }
  pending.status = 'sent';
  pending.sentAt = Date.now();
  pending.sentText = text;
  runtimeState.completed[pending.conversation] = {
    fingerprint: pending.fingerprint,
    at: Date.now(),
    action: 'replied-manual-feishu'
  };
  saveRuntimeState(runtimeState);
  return {
    ok: true,
    replyCode,
    conversation: pending.conversation,
    text,
    tab,
    sendReplyResult
  };
}

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return '';
  return process.argv[idx + 1] || '';
}

function main() {
  const sendCode = argValue('--send-code');
  if (sendCode) {
    const text = argValue('--text');
    if (!text) throw new Error('--text is required when using --send-code');
    const result = sendManualReplyByCode(sendCode, text);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--once')) {
    const runtimeState = loadRuntimeState();
    gcSeen(runtimeState.seen);
    const result = processOnce(runtimeState);
    runtimeState.lastResult = {
      at: result.at,
      action: result.action,
      target: result.target || null,
      unreadCount: result.unreadCount,
      latestText: result.latest && result.latest.text,
      fingerprint: result.fingerprint || null
    };
    saveRuntimeState(runtimeState);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  loop().catch(error => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
}

if (require.main === module) main();
