const SELLER_NAME = (process.env.KF1688_SELLER_NAME || '极有光世界百货').trim();
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}$/;
const SPEAKER_RE = /^[\u4e00-\u9fa5A-Za-z0-9_·-]{2,40}(工厂店|百货)$/;
const GENERIC_SPEAKER_RE = /^[A-Za-z0-9_·-]{4,40}$/;
const CHINESE_SPEAKER_RE = /^[\u4e00-\u9fa5A-Za-z0-9_·-]{2,40}$/;

function normalize(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

function stripLeadingTimestamp(text) {
  return normalize(text).replace(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s*/, '').trim();
}

function stripUiNoise(text) {
  return normalize(text)
    .replace(/\s*\d+条新消息\s*$/g, '')
    .replace(/\s*(已读|未读)\s*$/g, '')
    .trim();
}

function stripTrailingRoleLabel(text) {
  return normalize(text)
    .replace(new RegExp(`\\s*${SELLER_NAME}$`), '')
    .replace(/\s*[\u4e00-\u9fa5A-Za-z0-9_·-]{2,40}工厂店$/, '')
    .trim();
}

function extractUrl(text) {
  const m = normalize(text).match(/https?:\/\/\S+/);
  return m ? m[0] : '';
}

function stripEmojiCodes(text) {
  return normalize(text).replace(/\/:[-\w()]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function isPureEmojiCodeMessage(text) {
  const normalized = normalize(text);
  if (!normalized) return false;
  const stripped = stripEmojiCodes(normalized);
  return !stripped;
}

const SYSTEM_PATTERNS = [
  /理赔/, /红包/, /评价邀请/, /查看详情/, /使用红包/, /订单异常/, /退款/, /超时未揽收/, /小助手识别到/
];

const META_PATTERNS = [
  /已读/, /开启智能找品询盘/, /请输入消息/, /^发送$/, /^档案$/, /^商品$/, /^我的订单$/, /^您尚未选择联系人$/, /^请选择联系人$/, /^暂无会话$/, /^暂无聊天记录$/, /^\d+条新消息$/
];

const ESCALATION_PATTERNS = [
  /有没有现货/, /有现货吗/, /现货吗/, /有没有这款/, /这款有吗/, /这个有吗/, /这款还有吗/, /这个还有吗/,
  /有没有类似/, /有没有相似/, /有类似款吗/, /有相似款吗/, /类似款/, /相似款/, /同款/, /找款/, /找这个/, /找这款/,
  /这个品有活吗/, /这个货/, /这个品/, /这个链接/, /这链接/, /这款能做吗/, /这款能不能做/, /能做这个吗/, /有这个货吗/
];

const PRODUCT_CARD_PATTERNS = [
  /商品/, /货号/, /编码/, /颜色/, /尺码/, /规格/, /链接/, /https?:\/\//, /￥/, /下单/, /销量/, /起批/, /成交/, /件装/, /店铺/
];

const QUESTION_PATTERNS = [
  /吗[？?]?/, /呢[？?]?/, /怎么/, /什么/, /为何/, /为什么/, /多少/, /几天/, /多久/, /能不能/, /能否/, /可以不/, /是否/, /多大/, /多长/, /多宽/
];

const PRODUCT_ATTRIBUTE_PATTERNS = [
  /材质/, /什么材质/, /啥材质/, /面料/,
  /尺寸/, /尺码/, /大小/, /多大/, /长宽/, /规格/,
  /重量/, /多重/, /几斤/, /克重/,
  /颜色/, /什么颜色/, /几个颜色/, /色号/
];

const GREETING_PATTERNS = [
  /^你好[呀啊哈]?$/,
  /^hello$/i,
  /^哈喽$/,
  /^在吗$/,
  /^在$/,
  /^在不$/,
  /^在嘛$/,
  /^有人吗$/,
  /^亲$/,
  /^亲在吗$/
];

function detectProductCard(text) {
  const hitCount = PRODUCT_CARD_PATTERNS.filter(re => re.test(text)).length;
  return hitCount >= 2;
}

function detectQuestion(text) {
  return QUESTION_PATTERNS.some(re => re.test(text));
}

function detectProductAttributeQuestion(text) {
  return PRODUCT_ATTRIBUTE_PATTERNS.some(re => re.test(text));
}

function detectGreeting(text) {
  return GREETING_PATTERNS.some(re => re.test(text));
}

function detectEscalation(text) {
  if (ESCALATION_PATTERNS.some(re => re.test(text))) {
    return { needsEscalation: true, escalationReason: 'keyword' };
  }
  return { needsEscalation: false, escalationReason: '' };
}

function detectCardIntent(text, hasProductCard, needsEscalation, isSystem) {
  if (!hasProductCard) {
    return {
      hasQuestion: detectQuestion(text),
      needsClarification: false,
      shouldUseAi: false,
      cardIntent: ''
    };
  }

  const hasQuestion = detectQuestion(text);
  const isGreeting = detectGreeting(text);

  if (needsEscalation) {
    return { hasQuestion, needsClarification: false, shouldUseAi: false, cardIntent: 'card-escalation' };
  }
  if (hasQuestion && !isSystem) {
    return { hasQuestion: true, needsClarification: false, shouldUseAi: true, cardIntent: 'card-question' };
  }
  if (!hasQuestion || isGreeting || isSystem) {
    return { hasQuestion, needsClarification: true, shouldUseAi: false, cardIntent: 'card-no-question' };
  }
  return { hasQuestion, needsClarification: false, shouldUseAi: false, cardIntent: '' };
}

function tokenizeTail(tail) {
  return normalize(tail).split(' ').filter(Boolean);
}

function isTimestampTokenPair(tokens, i) {
  return i + 1 < tokens.length && TIMESTAMP_RE.test(`${tokens[i]} ${tokens[i + 1]}`);
}

function isSpeakerToken(token) {
  const value = normalize(token);
  if (!value) return false;
  if (value === SELLER_NAME) return true;
  if (SPEAKER_RE.test(value)) return true;
  if (GENERIC_SPEAKER_RE.test(value) && !/^\d+$/.test(value) && !/^(https?|￥|到手价)$/.test(value)) {
    return true;
  }
  if (CHINESE_SPEAKER_RE.test(value) && !/^\d+$/.test(value) && !/^(https?|￥|到手价|暂无更多消息|已读|未读|发送|档案|商品|我的订单)$/.test(value)) {
    return true;
  }
  return false;
}

function parseConversationBlocks(tail) {
  const tokens = tokenizeTail(tail);
  const blocks = [];
  let i = 0;

  while (i < tokens.length) {
    if (!isSpeakerToken(tokens[i])) {
      i += 1;
      continue;
    }

    const speaker = tokens[i];
    if (!isTimestampTokenPair(tokens, i + 1)) {
      i += 1;
      continue;
    }

    const ts = `${tokens[i + 1]} ${tokens[i + 2]}`;
    i += 3;

    const bodyTokens = [];
    while (i < tokens.length) {
      if (isSpeakerToken(tokens[i]) && isTimestampTokenPair(tokens, i + 1)) {
        break;
      }
      bodyTokens.push(tokens[i]);
      i += 1;
    }

    const body = stripUiNoise(normalize(bodyTokens.join(' ')))
      .replace(/\s*期待您的真实反馈.*$/g, '')
      .trim();

    if (!body) continue;

    blocks.push({
      speaker,
      ts,
      body,
      raw: normalize(`${speaker} ${ts} ${body}`)
    });
  }

  return blocks;
}

function inferRoleFromSpeaker(speaker) {
  const who = normalize(speaker);
  if (who === SELLER_NAME) return 'seller';
  if (/工厂店$/.test(who)) return 'seller';
  if (GENERIC_SPEAKER_RE.test(who)) return 'customer';
  return 'unknown';
}

function inferCustomerNameFromBlocks(blocks) {
  const names = new Map();
  for (const block of blocks || []) {
    const speaker = normalize(block && block.speaker);
    if (!speaker || speaker === SELLER_NAME) continue;
    if (/工厂店$/.test(speaker)) continue;
    if (!/^[\u4e00-\u9fa5A-Za-z0-9_·-]{2,40}$/.test(speaker)) continue;
    names.set(speaker, (names.get(speaker) || 0) + 1);
  }
  const ranked = [...names.entries()].sort((a, b) => b[1] - a[1]);
  return ranked.length ? ranked[0][0] : '';
}

function classifyBlock(block, options = {}) {
  const originalText = stripUiNoise(stripTrailingRoleLabel(stripLeadingTimestamp(block.body || '')));
  const cleanedText = stripEmojiCodes(originalText) || originalText;
  const pureEmojiCode = isPureEmojiCodeMessage(originalText);
  let role = inferRoleFromSpeaker(block.speaker);
  if (options.detectedCustomerName && normalize(block.speaker) === normalize(options.detectedCustomerName)) {
    role = 'customer';
  }
  const isSeller = role === 'seller';
  const isCustomer = role === 'customer' || role === 'unknown';
  const isSystem = SYSTEM_PATTERNS.some(re => re.test(cleanedText));
  const isMeta = META_PATTERNS.some(re => re.test(cleanedText));
  const hasProductCard = detectProductCard(cleanedText);

  const escalation = isCustomer ? detectEscalation(cleanedText) : { needsEscalation: false, escalationReason: '' };
  const cardIntent = isCustomer
    ? detectCardIntent(cleanedText, hasProductCard, escalation.needsEscalation, isSystem)
    : { hasQuestion: detectQuestion(cleanedText), needsClarification: false, shouldUseAi: false, cardIntent: '' };
  const needsProductContext = isCustomer && detectProductAttributeQuestion(cleanedText) && !hasProductCard;

  return {
    text: cleanedText,
    originalText,
    pureEmojiCode,
    rawText: block.raw,
    speaker: block.speaker,
    ts: block.ts,
    role,
    isSystem,
    isMeta,
    hasProductCard,
    hasQuestion: cardIntent.hasQuestion,
    needsClarification: cardIntent.needsClarification,
    shouldUseAi: cardIntent.shouldUseAi,
    cardIntent: cardIntent.cardIntent,
    needsProductContext,
    productUrl: extractUrl(cleanedText),
    needsEscalation: escalation.needsEscalation,
    escalationReason: escalation.escalationReason,
    isSeller,
    isCustomer,
    signature: cleanedText.slice(-180)
  };
}

function contextPriority(msg) {
  if (!msg) return -1;
  if (msg.productUrl) return 100;
  if (msg.hasProductCard) return 90;
  if (/https?:\/\//.test(msg.text || '')) return 80;
  if (/￥|规格|尺码|材质|颜色|下单|商品/.test(msg.rawText || msg.text || '')) return 70;
  return 0;
}

function findRecentProductContext(effectiveMessages, fromIndex) {
  const start = Math.max(0, fromIndex - 4);
  for (let i = fromIndex - 1; i >= start; i--) {
    const msg = effectiveMessages[i];
    if (!msg || msg.isMeta || msg.isSeller) continue;
    const score = contextPriority(msg);
    if (score >= 70) return msg;
  }

  let fallback = null;
  let bestScore = -1;
  for (let i = fromIndex - 1; i >= start; i--) {
    const msg = effectiveMessages[i];
    if (!msg || msg.isMeta || msg.isSeller) continue;
    const score = contextPriority(msg);
    if (score > bestScore) {
      fallback = msg;
      bestScore = score;
    }
  }
  return fallback;
}

function hasRecentProductContext(effectiveMessages, fromIndex) {
  return !!findRecentProductContext(effectiveMessages, fromIndex);
}

function enrichProductContext(effectiveMessages) {
  return effectiveMessages.map((msg, index) => {
    const recentContextMessage = findRecentProductContext(effectiveMessages, index);
    const hasRecentContext = !!recentContextMessage;
    const hasProductContext = !!msg.hasProductCard || hasRecentContext;
    const shouldUseAi = (!!msg.shouldUseAi || (!!msg.needsProductContext && hasRecentContext)) && msg.isCustomer;
    const needsProductContext = !!msg.needsProductContext && !hasRecentContext;
    return {
      ...msg,
      hasRecentProductContext: hasRecentContext,
      recentProductContextText: recentContextMessage ? recentContextMessage.text : '',
      productUrl: msg.productUrl || (recentContextMessage && recentContextMessage.productUrl) || '',
      hasProductContext,
      shouldUseAi,
      needsProductContext
    };
  });
}

function extractEffectiveMessages(tail, limit = 6) {
  const blocks = parseConversationBlocks(tail);
  const detectedCustomerName = inferCustomerNameFromBlocks(blocks);
  const effective = blocks
    .map(block => classifyBlock(block, { detectedCustomerName }))
    .filter(x => !x.isMeta)
    .slice(-limit);
  return enrichProductContext(effective);
}

function isLikelyContextOnlyCustomerMessage(msg) {
  if (!msg || !msg.isCustomer || msg.isSystem) return false;
  if (msg.hasQuestion || msg.needsEscalation || msg.shouldUseAi || msg.needsProductContext) return false;
  const text = normalize(msg.text || '');
  if (!text) return true;
  if (/￥|https?:\/\/|商品|规格|尺码|颜色|材质|下单|到手价/.test(text)) return true;
  return false;
}

function isPromptLikeMessage(text) {
  const value = normalize(text || '');
  if (!value) return false;
  return /^(\?+|？+|在吗|为什么不回信息呢|为什么不回|怎么不回|咋不回|怎么不回复|怎么不说话|还在吗|有人吗)$/.test(value);
}

function isBusinessPrimaryMessage(msg) {
  if (!msg || !msg.isCustomer || msg.isSystem) return false;
  const text = normalize(msg.text || '');
  if (!text) return false;
  if (isPromptLikeMessage(text)) return false;
  if (msg.needsEscalation) return true;
  if (/价格|多少钱|怎么卖|什么价|报价|500个|100个|起订|批发|能做|可以做/.test(text)) return true;
  if (msg.hasQuestion && !isPromptLikeMessage(text)) return true;
  if (msg.shouldUseAi) return true;
  return false;
}

function latestOutstandingCustomerMessage(effectiveMessages) {
  const last = effectiveMessages[effectiveMessages.length - 1];
  if (!last) return null;

  if (last.isSeller) {
    return null;
  }

  const customerRun = [];
  for (let i = effectiveMessages.length - 1; i >= 0; i--) {
    const msg = effectiveMessages[i];

    if (msg.isSeller) break;
    if (!msg.isCustomer || msg.isSystem) continue;

    customerRun.unshift(msg);
  }

  if (!customerRun.length) return null;

  const primary = customerRun.find(isBusinessPrimaryMessage);
  if (primary) return primary;

  for (let i = customerRun.length - 1; i >= 0; i--) {
    const msg = customerRun[i];
    if (isLikelyContextOnlyCustomerMessage(msg)) continue;
    return msg;
  }

  return customerRun[customerRun.length - 1] || null;
}

function findOutstandingCustomerMessage(effectiveMessages) {
  const latest = latestOutstandingCustomerMessage(effectiveMessages);
  return {
    latest,
    hasOutstanding: !!latest,
    coveredBySellerReply: !latest && effectiveMessages.some(msg => msg.isSeller),
    lastMessageRole: effectiveMessages.length
      ? (effectiveMessages[effectiveMessages.length - 1].isSeller ? 'seller' : 'customer')
      : ''
  };
}

function buildMessageFingerprint(conversation, latest) {
  const text = latest?.signature || latest?.text || '';
  const shortText = normalize(text);
  const ts = latest?.ts || '';
  const context = latest?.recentProductContextText || latest?.productUrl || '';
  const isSizeQuestion = /尺寸|多大|长宽|规格/.test(shortText);

  if (shortText.length <= 4 || isSizeQuestion) {
    return normalize(`${conversation || ''} | ${shortText} | ${ts} | ${context.slice(0, 80)}`);
  }

  return normalize(`${conversation || ''} | ${shortText}`);
}

module.exports = {
  SELLER_NAME,
  normalize,
  stripLeadingTimestamp,
  stripUiNoise,
  stripTrailingRoleLabel,
  stripEmojiCodes,
  isPureEmojiCodeMessage,
  extractUrl,
  parseConversationBlocks,
  findRecentProductContext,
  hasRecentProductContext,
  extractEffectiveMessages,
  latestOutstandingCustomerMessage,
  findOutstandingCustomerMessage,
  buildMessageFingerprint
};
