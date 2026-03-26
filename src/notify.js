const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(process.env.HOME || '/home/admin', '.openclaw', 'openclaw.json');
const FEISHU_TARGET = process.env.KF1688_NOTIFY_TARGET || 'user:ou_530307aabbf541dddaf607f17ad08c6c';
const GATEWAY_URL = process.env.KF1688_GATEWAY_URL || 'http://127.0.0.1:18789/tools/invoke';

function gatewayToken() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const token = cfg && cfg.gateway && cfg.gateway.auth && cfg.gateway.auth.token;
  if (!token) throw new Error('gateway auth token not found');
  return token;
}

function invokeGatewayTool(tool, args) {
  const token = gatewayToken();
  const payload = JSON.stringify({ tool, args });
  const cmd = `curl -sS ${JSON.stringify(GATEWAY_URL)} -H ${JSON.stringify(`Authorization: Bearer ${token}`)} -H 'Content-Type: application/json' -d ${JSON.stringify(payload)}`;
  const out = execFileSync('bash', ['-lc', cmd], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
  const parsed = JSON.parse(out);
  if (!parsed.ok) throw new Error(parsed?.error?.message || `failed to invoke gateway tool: ${tool}`);
  return parsed.result;
}

function sendFeishuText(text) {
  return invokeGatewayTool('message', {
    action: 'send',
    channel: 'feishu',
    target: FEISHU_TARGET,
    message: text
  });
}

function runMainAgentPrompt(message) {
  const cmd = `openclaw agent --agent main -m ${JSON.stringify(message)}`;
  const out = execFileSync('bash', ['-lc', cmd], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024 * 10
  }).trim();
  return {
    ok: true,
    mode: 'openclaw-agent-main-cli',
    output: out
  };
}

function formatEscalationNotice(notice) {
  const lines = [
    `【待处理】${notice.replyCode || 'RXXXX'}`,
    `会话：${notice.conversation || '未知会话'}`,
    `客户消息：${notice.customerText || '（空）'}`
  ];
  if (notice.reason) lines.push(`原因：${notice.reason}`);
  lines.push(`回复格式：回复 ${notice.replyCode || 'RXXXX'}：你的内容`);
  return lines.join('\n');
}

module.exports = { sendFeishuText, runMainAgentPrompt, formatEscalationNotice, invokeGatewayTool };
