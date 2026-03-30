const fs = require('fs');
const path = require('path');

const runtimeDir = path.join(__dirname, '..', 'runtime');
const retainDays = Number(process.env.KF1688_LOG_RETAIN_DAYS || 3);

function pad(n) {
  return String(n).padStart(2, '0');
}

function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function pruneOldLogs(dir, keepDays) {
  const now = Date.now();
  const maxAgeMs = keepDays * 24 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(dir)) {
    if (!/^worker(?:-\d{4}-\d{2}-\d{2})?\.log$/.test(name)) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (!st.isFile()) continue;
    if (now - st.mtimeMs > maxAgeMs) {
      fs.unlinkSync(full);
      console.log(`[log-rotate] removed old log: ${name}`);
    }
  }
}

function rotateCurrentLog(dir, todayName) {
  const current = path.join(dir, 'worker.log');
  const dated = path.join(dir, todayName);
  if (!fs.existsSync(current)) return;

  const currentStat = fs.statSync(current);
  if (!currentStat.isFile()) return;
  if (currentStat.size === 0) return;

  if (fs.existsSync(dated)) {
    const datedStat = fs.statSync(dated);
    if (datedStat.isFile() && datedStat.size >= currentStat.size) {
      fs.truncateSync(current, 0);
      console.log(`[log-rotate] truncated current log after existing dated log found: ${todayName}`);
      return;
    }
  }

  fs.renameSync(current, dated);
  console.log(`[log-rotate] rotated worker.log -> ${todayName}`);
}

function main() {
  ensureDir(runtimeDir);
  const todayName = `worker-${dateKey()}.log`;
  pruneOldLogs(runtimeDir, retainDays);
  rotateCurrentLog(runtimeDir, todayName);
}

main();
