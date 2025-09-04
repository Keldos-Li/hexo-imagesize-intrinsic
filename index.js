/* hexo-imagesize-intrinsic
 * 写入远程 <img> 的 intrinsic width/height，降低 CLS
 * - Hooks: after_post_render (page/post), after_generate (summary/report)
 * - Cache:   <site>/.cache/hexo-imgsize.json
 * - Report:  <site>/.cache/imgsize-run-report.json  (按页面分组：{url,status,reason})
 * - 站点配置（_config.yml -> imagesize_intrinsic: {...}）：
 *     enabled: true|false
 *     concurrency: 8
 *     log_level: off|summary|verbose
 *     progress: true|false         // 进度条（stderr）
 *     strip_query: false           // 缓存 key 去掉 ?query 提高命中
 *     timeout_ms: 8000
 *     retry: 1
 *     headers: {}                  // 额外请求头
 *     referer: ""                  // 快捷设置 Referer
 *     whitelist: []                // 只处理这些域名；空数组=不限制
 *     cache_present_with_size: true// 将已带尺寸的远程图也登记到缓存
 */

if (global.__hexo_imagesize_intrinsic_registered__) return;
global.__hexo_imagesize_intrinsic_registered__ = true;

let cheerio, probe, cliProgress;
try {
  cheerio = require('cheerio');
  probe = require('probe-image-size');
  cliProgress = require('cli-progress');
} catch (e) {
  console.warn('[imagesize_intrinsic] deps missing. Please `npm i cheerio probe-image-size cli-progress --save`');
  hexo.extend.filter.register('after_post_render', d => d);
  return;
}

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const SITE_ROOT = process.cwd();
const CACHE_DIR = path.join(SITE_ROOT, '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'hexo-imgsize.json');
const RUN_REPORT = path.join(CACHE_DIR, 'imgsize-run-report.json');

// 默认配置 + 读取站点配置（imagesize_intrinsic）
const defaults = {
  enabled: true,
  concurrency: 8,
  log_level: 'summary', // 'off' | 'summary' | 'verbose'
  progress: true,
  strip_query: false,
  timeout_ms: 8000,
  retry: 1,
  headers: {
    'User-Agent': 'hexo-imagesize-intrinsic/1.0 (+https://hexo.io)',
    'Accept': 'image/*,*/*;q=0.8'
  },
  referer: '',
  whitelist: [],
  cache_present_with_size: true
};
const siteCfg = (hexo.config && hexo.config.imagesize_intrinsic) || {};
const CFG = Object.assign({}, defaults, siteCfg);
if (CFG.referer) CFG.headers = Object.assign({}, CFG.headers, { Referer: CFG.referer });

// 日志
function logSummary(...args){ if (CFG.log_level !== 'off') console.log('[imgsize]', ...args); }
function logVerbose(...args){ if (CFG.log_level === 'verbose') console.log('[imgsize]', ...args); }

// 并发器
function createLimiter(max) {
  let active = 0; const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}
const limit = createLimiter(CFG.concurrency);

// 工具
function isRemote(u){ return /^https?:\/\//i.test(u); }
function hostOf(u){ try { return new URL(u).hostname; } catch { return ''; } }
function inWhitelist(u){
  if (!Array.isArray(CFG.whitelist) || CFG.whitelist.length === 0) return true;
  return CFG.whitelist.includes(hostOf(u));
}
function safeURL(input) {
  const u = new URL(input);
  try { u.pathname = encodeURI(decodeURI(u.pathname)); }
  catch { u.pathname = encodeURI(u.pathname); }
  return u.toString();
}
async function loadJson(p, def = {}) { try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch { return def; } }
async function saveJson(p, data) { await fsp.mkdir(path.dirname(p), { recursive: true }); await fsp.writeFile(p, JSON.stringify(data, null, 2)); }
async function mergeCache(cacheFile, inMem) {
  const onDisk = await loadJson(cacheFile, {});
  let cleaned = 0;
  
  // 添加新条目或更新现有条目
  for (const k of Object.keys(inMem)) {
    if (!onDisk[k] || !onDisk[k].width || !onDisk[k].height) onDisk[k] = inMem[k];
  }
  
  // 清理未使用的条目
  if (usedImageUrls.size > 0) {
    const unusedKeys = Object.keys(onDisk).filter(k => !usedImageUrls.has(k));
    unusedKeys.forEach(k => {
      delete onDisk[k];
      cleaned++;
    });
    if (cleaned > 0) {
      logVerbose(`清理了 ${cleaned} 个未使用的缓存条目`);
      runTotals.cleaned = cleaned;
    }
  }
  
  return onDisk;
}
function buildCacheKey(url) {
  const u = new URL(url);
  if (CFG.strip_query) u.search = '';
  return u.toString();
}

// 运行统计
const runTotals = { pages: 0, imgs_total: 0, wrote: 0, cached: 0, failed: 0, skipped: 0, cleaned: 0 };
// 页面报告
const runMap = new Map();
// 用于跟踪本次运行中实际使用的URL
const usedImageUrls = new Set();
function addRec(pageId, url, status, reason) {
  if (!runMap.has(pageId)) runMap.set(pageId, { page: pageId, images: [] });
  const rec = { url, status };
  if (reason) rec.reason = reason;
  runMap.get(pageId).images.push(rec);
}

// 进度条（stderr）
const globals = { bar: null, barStarted: false, finished: 0 };
function countRemoteImgsInHtml(html) {
  let total = 0;
  const re = /<img\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const $one = cheerio.load(m[0])('img');
    const src = ($one.attr('src') || '').trim();
    if (src && isRemote(src) && inWhitelist(src)) total++;
  }
  return total;
}
function ensureProgressBarAndGrow(by) {
  if (!CFG.progress || CFG.log_level === 'off') return;
  if (!globals.barStarted) {
    const SingleBar = cliProgress.SingleBar;
    globals.bar = new SingleBar(
      {
        format: '[imgsize] {bar} {percentage}% | {value}/{total} images',
        barCompleteChar: '█',
        barIncompleteChar: '░',
        hideCursor: true,
        autopadding: true,
        stopOnComplete: true,
        clearOnComplete: true,
        linewrap: false,
        stream: process.stderr
      },
      cliProgress.Presets.shades_classic
    );
    globals.bar.start(by || 0, 0);
    globals.barStarted = true;
  } else if (by && by > 0 && typeof globals.bar.setTotal === 'function') {
    globals.bar.setTotal(globals.bar.getTotal() + by);
  }
}
function tick() {
  if (!CFG.progress || CFG.log_level === 'off') return;
  if (globals.bar && globals.barStarted) {
    globals.finished++;
    globals.bar.update(globals.finished);
  }
}

// 尺寸探测（超时+重试）
async function probeSize(url, timeout = CFG.timeout_ms, retry = CFG.retry) {
  const safe = safeURL(url);
  let lastErr;
  for (let i = 0; i <= retry; i++) {
    try {
      const p = probe(safe, { headers: CFG.headers });
      const t = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeout));
      const res = await Promise.race([p, t]);
      return { width: res.width, height: res.height, url: safe };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// 主钩子
hexo.extend.filter.register('after_post_render', async function(data) {
  if (!CFG.enabled) return data;
  if (!['post', 'page'].includes(data.layout)) return data;

  ensureProgressBarAndGrow(countRemoteImgsInHtml(data.content || ''));

  const cache = await loadJson(CACHE_FILE, {});
  const tasks = [];
  let pageTotals = { total: 0, wrote: 0, cached: 0, failed: 0, skipped: 0 };
  const pageId = data.source || data.path || data.slug || data.title || 'unknown';

  const re = /<img\b[^>]*>/gi;
  let matches = [], m;
  while ((m = re.exec(data.content)) !== null) matches.push({ match: m[0], index: m.index });
  let replaces = [];

  for (const item of matches) {
    const $img = cheerio.load(item.match, { decodeEntities: false })('img');
    const rawSrc = ($img.attr('src') || '').trim();

    if (!rawSrc) { pageTotals.skipped++; addRec(pageId, null, 'skipped', 'no-src'); replaces.push({ start: item.index, end: item.index + item.match.length, html: $img.toString() }); tick(); continue; }
    if (!isRemote(rawSrc) || !inWhitelist(rawSrc)) {
      pageTotals.skipped++; addRec(pageId, rawSrc, 'skipped', isRemote(rawSrc) ? 'not-in-whitelist' : 'not-remote');
      replaces.push({ start: item.index, end: item.index + item.match.length, html: $img.toString() }); tick(); continue;
    }
    pageTotals.total++;

    const safe = safeURL(rawSrc);
    const key = buildCacheKey(safe);

    // 已带尺寸：可选入缓存
    if ($img.attr('width') && $img.attr('height')) {
      if (CFG.cache_present_with_size && (!cache[key] || !cache[key].width || !cache[key].height)) {
        const w = parseInt($img.attr('width'), 10);
        const h = parseInt($img.attr('height'), 10);
        if (Number.isFinite(w) && Number.isFinite(h)) {
          cache[key] = { width: w, height: h };
          // 记录使用的URL
          usedImageUrls.add(key);
          pageTotals.cached++; addRec(pageId, safe, 'cached-present', 'had-size');
          replaces.push({ start: item.index, end: item.index + item.match.length, html: $img.toString() }); tick(); continue;
        }
      }
      pageTotals.skipped++; addRec(pageId, safe, 'skipped', 'already-has-size');
      replaces.push({ start: item.index, end: item.index + item.match.length, html: $img.toString() }); tick(); continue;
    }

    // 缓存命中
    if (cache[key] && cache[key].width && cache[key].height) {
      $img.attr('width', cache[key].width);
      $img.attr('height', cache[key].height);
      pageTotals.cached++; addRec(pageId, safe, 'cached');
      // 记录使用的URL
      usedImageUrls.add(key);
      replaces.push({ start: item.index, end: item.index + item.match.length, html: $img.toString() }); tick(); continue;
    }

    // 异步探测（并发）
    tasks.push(limit(async () => {
      try {
        const { width, height, url: finalURL } = await probeSize(safe);
        if (width && height) {
          cache[key] = { width, height };
          $img.attr('width', width);
          $img.attr('height', height);
          // 记录使用的URL
          usedImageUrls.add(key);
          pageTotals.wrote++; addRec(pageId, finalURL, 'wrote');
        } else {
          pageTotals.failed++; addRec(pageId, finalURL, 'failed', 'no-size');
        }
      } catch (e) {
        pageTotals.failed++; addRec(pageId, safe, 'failed', e && e.message || 'error');
      }
      replaces.push({ start: item.index, end: item.index + item.match.length, html: $img.toString() });
      tick();
    }));
  }

  if (tasks.length) await Promise.all(tasks);

  // 应用替换
  if (replaces.length) {
    replaces.sort((a, b) => a.start - b.start);
    let result = ''; let last = 0;
    for (const r of replaces) { result += data.content.slice(last, r.start) + r.html; last = r.end; }
    result += data.content.slice(last);
    data.content = result;
  }

  // 累计
  runTotals.pages++;
  runTotals.imgs_total += pageTotals.total;
  runTotals.wrote += pageTotals.wrote;
  runTotals.cached += pageTotals.cached;
  runTotals.failed += pageTotals.failed;
  runTotals.skipped += pageTotals.skipped;

  // 持久化缓存
  await saveJson(CACHE_FILE, await mergeCache(CACHE_FILE, cache));

  // 详细页日志
  if (CFG.log_level === 'verbose') {
    const rec = runMap.get(pageId);
    console.log(`[imgsize] [page] ${pageTotals.total} wrote=${pageTotals.wrote} cached=${pageTotals.cached} failed=${pageTotals.failed} skipped=${pageTotals.skipped} :: ${pageId}`);
    if (rec && rec.images) {
      for (const r of rec.images) {
        console.log(`  [imgsize]   ${String(r.status).padEnd(14)} ${r.reason ? `[${r.reason}]` : ''} ${r.url || ''}`);
      }
    }
  }

  return data;
}, 0);

// 收尾：停进度条，打印总计与报告
hexo.extend.filter.register('after_generate', async function() {
  if (!CFG.enabled || CFG.log_level === 'off') return;

  if (CFG.progress && globals.bar && globals.barStarted) {
    try { globals.bar.stop(); } catch (_) {}
    globals.bar = null;
    globals.barStarted = false;
  }

  logSummary(`[total] pages=${runTotals.pages} imgs=${runTotals.imgs_total} wrote=${runTotals.wrote} cached=${runTotals.cached} failed=${runTotals.failed} skipped=${runTotals.skipped} cleaned=${runTotals.cleaned || 0}`);
  const pages = Array.from(runMap.values());
  await saveJson(RUN_REPORT, { pages });
  logSummary(`run report -> ${path.relative(SITE_ROOT, RUN_REPORT)}`);
});