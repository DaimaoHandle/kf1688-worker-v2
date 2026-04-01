const fs = require('fs');
const path = require('path');

const FAQ_PATH = path.join(__dirname, '..', 'knowledge', 'faq.json');

function normalize(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function loadFaq() {
  try {
    const raw = fs.readFileSync(FAQ_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function normalizeFaqSource(text) {
  return normalize(text)
    .replace(/^[亲呀啊哈哦呢嘛，,。.!！?？\s]+/g, '')
    .replace(/^(你好|您好|哈喽|hello|在吗|有人吗|请问|亲)\s*[呀啊哈哦呢嘛]?\s*[，,。.!！?？]*/gi, '')
    .trim();
}

function textIncludesTrigger(text, trigger) {
  const source = normalize(text);
  const normalizedSource = normalizeFaqSource(text);
  const needle = normalize(trigger);
  if (!needle) return false;
  return !!source && (source.includes(needle) || (!!normalizedSource && normalizedSource.includes(needle)));
}

function detectProvidedFields(texts = []) {
  const merged = normalize((texts || []).join(' '));
  return {
    规格: /规格|尺码|尺寸|颜色|款式|型号/.test(merged),
    数量: /\d+\s*(个|件|套|箱|包|台|只|双|把|张|斤|米|pcs|PCS)/.test(merged) || /数量|采购量|起订/.test(merged),
    是否开票: /开票|发票|普票|专票|票/.test(merged),
    开票信息: /公司名称|公司抬头|税号|统一社会信用代码|开户地址|开户行|账号/.test(merged),
    采购信息: /采购|拿货|批发|数量|规格/.test(merged)
  };
}

function buildFollowupPrompt(faq, context = {}) {
  const followup = Array.isArray(faq && faq.followup) ? faq.followup.filter(Boolean) : [];
  if (!followup.length) return '';

  const provided = detectProvidedFields(context.recentCustomerTexts || []);

  if (faq.intent === 'price_query') {
    const missing = followup.filter(field => !provided[field]);
    if (!missing.length) return '';
    return `麻烦您发下${missing.join('、')}，我这边帮您确认。`;
  }

  if (faq.intent === 'invoice_query') {
    if (provided['开票信息']) return '';
    return '如果您需要开发票的话，麻烦把开票信息发我一下哦。';
  }

  if (faq.intent === 'moq_query') {
    if (provided['采购信息']) return '';
    return '如果您这边是采购，麻烦把采购信息发我一下哦。';
  }

  const missing = followup.filter(field => !provided[field]);
  if (!missing.length) return '';
  return `麻烦您补充下${missing.join('、')}哦。`;
}

function composeFaqReply(faq, context = {}) {
  const baseReply = normalize(faq && faq.reply);
  const followupPrompt = buildFollowupPrompt(faq, context);
  if (baseReply && followupPrompt) return `${baseReply}${followupPrompt}`;
  return baseReply || followupPrompt || '';
}

function regexIntentMatches(source, item) {
  const patterns = {
    address_change_query: [
      /(改|修改).{0,4}(地址|收货地址|备注)/,
      /(地址|收货地址|备注).{0,4}(改|修改)/,
      /(帮我|给我|给俺|帮俺).{0,4}(改|修改).{0,4}(地址|收货地址|备注)/,
      /(能不能|可以不|能否|可不可以).{0,4}(改|修改).{0,4}(地址|收货地址|备注)/
    ]
  };

  const list = patterns[item && item.intent] || [];
  return list.some(re => re.test(source));
}

function matchFaq(text, context = {}) {
  const source = normalize(text);
  if (!source) return null;

  const candidates = loadFaq()
    .filter(item => item && item.enabled !== false)
    .map(item => {
      const triggers = Array.isArray(item.triggers) ? item.triggers : [];
      const matchedTriggers = triggers.filter(trigger => textIncludesTrigger(source, trigger));
      const regexMatched = matchedTriggers.length ? false : regexIntentMatches(source, item);
      return {
        ...item,
        matchedTriggers,
        score: matchedTriggers.length + (regexMatched ? 1 : 0),
        regexMatched
      };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => {
      const pa = Number(a.priority || 0);
      const pb = Number(b.priority || 0);
      if (pb !== pa) return pb - pa;
      return b.score - a.score;
    });

  const matched = candidates[0] || null;
  if (!matched) return null;
  return {
    ...matched,
    composedReply: composeFaqReply(matched, context)
  };
}

module.exports = {
  FAQ_PATH,
  loadFaq,
  matchFaq,
  composeFaqReply,
  buildFollowupPrompt
};
