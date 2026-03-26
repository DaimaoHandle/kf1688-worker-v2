const { runMainAgentPrompt } = require('./notify');

function buildMainAgentPrompt({ productUrl, customerQuestion, conversation }) {
  return [
    '你是 1688 商品分析助手。只返回严格 JSON。',
    '请你在当前正在启动的浏览器内打开这个链接，提取商品页面的尺寸、重量等信息。',
    '这些信息一般都在详情长图里，且通常在比较靠下的位置。不要直接从顶部跳到底部。',
    '请从商品详情开始分段向下滚动查看，重点检查中后段的详情长图内容，确认看过后再回答。',
    '不要只看首屏和规格区。',
    `会话：${conversation || '当前会话'}`,
    `商品链接：${productUrl}`,
    `客户问题：${customerQuestion}`,
    '',
    '输出字段：',
    JSON.stringify({
      title: '',
      price: '',
      specs: [],
      sizes: [],
      weight: '',
      material: '',
      colors: [],
      shipping: '',
      summary: '',
      answer: '',
      confidence: '',
      sourceUrl: ''
    }, null, 2),
    '',
    '要求：',
    '1. answer 用 1-2 句话，直接发给客户。',
    '2. 如果识别到多组尺寸，简短列出主要尺寸，并说明不同款式可能不同。',
    '3. confidence 只填 high / medium / low。',
    '4. sourceUrl 填最终分析使用的商品页 URL。'
  ].join('\n');
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function normalizeAgentText(result) {
  if (!result) return '';
  if (typeof result === 'string') return result.trim();
  if (result.output && typeof result.output === 'string') return result.output.trim();
  if (result.text && typeof result.text === 'string') return result.text.trim();
  if (result.message && typeof result.message === 'string') return result.message.trim();
  if (result.result && typeof result.result === 'string') return result.result.trim();
  if (Array.isArray(result.messages)) {
    const joined = result.messages
      .map(item => item && (item.text || item.content || item.message || ''))
      .filter(Boolean)
      .join('\n');
    return joined.trim();
  }
  return JSON.stringify(result);
}

function stripNoiseLines(text) {
  return String(text || '')
    .split('\n')
    .filter(line => line.trim() && !/^\[plugins\]/.test(line.trim()))
    .join('\n')
    .trim();
}

function extractJsonObject(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  const direct = safeJsonParse(trimmed);
  if (direct && typeof direct === 'object') return direct;

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const sliced = trimmed.slice(start, end + 1);
    const parsed = safeJsonParse(sliced);
    if (parsed && typeof parsed === 'object') return parsed;
  }
  return null;
}

function requestProductAnalysisByMainAgent({ productUrl, customerQuestion, conversation }) {
  const prompt = buildMainAgentPrompt({ productUrl, customerQuestion, conversation });
  const runResult = runMainAgentPrompt(prompt);
  const rawText = normalizeAgentText(runResult);
  const cleanedText = stripNoiseLines(rawText);
  const analysis = extractJsonObject(cleanedText) || extractJsonObject(rawText);

  return {
    ok: !!analysis,
    mode: 'main-agent-subagent-run',
    prompt,
    runResult,
    rawText: cleanedText || rawText,
    rawTextOriginal: rawText,
    analysis,
    schema: {
      title: 'string',
      price: 'string',
      specs: 'string[]',
      sizes: 'string[]',
      weight: 'string',
      material: 'string',
      colors: 'string[]',
      shipping: 'string',
      summary: 'string',
      answer: 'string',
      confidence: 'string',
      sourceUrl: 'string'
    }
  };
}

module.exports = {
  buildMainAgentPrompt,
  requestProductAnalysisByMainAgent,
  extractJsonObject
};
