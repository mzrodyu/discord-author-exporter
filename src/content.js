// 运行在隔离世界(ISOLATED)。负责：
// 1. 接收主世界传来的 token
// 2. 接收 popup 的指令，调用 Discord 搜索 API 抓取指定用户的全部消息
// 3. 处理分页、限速(429)、5000 条偏移上限，并回报进度
(function () {
  "use strict";

  const API = "https://discord.com/api/v9";
  let TOKEN = null;
  let running = false;
  let cancelRequested = false;
  const userCache = new Map(); // id -> {id, username, globalName}
  let lastSearchedAuthor = null; // {authorId, guildId, label?}

  // 接收主世界传来的 token
  window.addEventListener("message", function (ev) {
    if (ev.source !== window || !ev.data) return;
    if (ev.data.source === "DME_TOKEN" && ev.data.token) {
      TOKEN = ev.data.token;
      chrome.storage.local.set({ dme_has_token: true });
    }
    if (ev.data.source === "DME_USERS" && Array.isArray(ev.data.users)) {
      for (const u of ev.data.users) {
        if (u && u.id) userCache.set(u.id, u);
      }
    }
    if (ev.data.source === "DME_LAST_AUTHOR" && ev.data.authorId) {
      lastSearchedAuthor = {
        authorId: ev.data.authorId,
        guildId: ev.data.guildId || null,
        searchUrl: ev.data.searchUrl || null,
      };
      chrome.storage.local.set({ dme_last_author: lastSearchedAuthor });
    }
  });

  // 恢复上次捕获的搜索用户（跨刷新）
  chrome.storage.local.get("dme_last_author").then((r) => {
    if (r && r.dme_last_author && !lastSearchedAuthor) {
      lastSearchedAuthor = r.dme_last_author;
    }
  }).catch(() => {});

  // 主动索要 token（应对脚本加载先后顺序）
  window.postMessage({ source: "DME_REQUEST_TOKEN" }, "*");

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ===================== 断点续传存档 (IndexedDB) =====================
  // 边抓边存：保存任务标识、游标 maxId、以及已抓到的所有消息。
  // 网断/刷新后可从存档恢复继续。
  const DB_NAME = "dme_db";
  const STORE = "checkpoint";
  let _db = null;

  function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function idbPut(key, value) {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
  }

  function idbGet(key) {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const r = tx.objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
  }

  function idbDel(key) {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
  }

  // 任务唯一键：作者 + 范围 + 模板URL，参数一致才算同一个任务
  function jobKey(authorId, scope, templateUrl) {
    return [authorId, scope.type, scope.guildId, scope.channelId || "", templateUrl ? "tpl" : "std"].join("|");
  }

  // 进度通过 UI 回调直接更新页面悬浮窗（UI 在文件后半部分定义并赋值给 onProgress）
  let onProgress = function () {};
  function sendProgress(payload) {
    try { onProgress(payload); } catch (e) { /* ignore */ }
  }

  // 带限速 + 网络错误重试的请求
  async function apiGet(url) {
    let indexWaits = 0;
    let netRetries = 0;
    while (true) {
      if (cancelRequested) throw new Error("__CANCELLED__");

      let resp;
      try {
        resp = await fetch(url, {
          method: "GET",
          headers: { Authorization: TOKEN, "Content-Type": "application/json" },
          credentials: "include",
        });
      } catch (netErr) {
        // 网络中断/超时：指数退避重试，不丢已抓进度
        netRetries++;
        if (netRetries > 60) {
          throw new Error("网络持续中断，已暂停。已抓取的进度已存档，恢复网络后可点“继续上次”续传。");
        }
        const wait = Math.min(15000, 1000 * netRetries);
        sendProgress({ stage: "neterror", waitMs: wait, attempt: netRetries });
        await sleep(wait);
        continue;
      }
      netRetries = 0;

      // 202：服务器搜索索引尚未建立，Discord 要求稍后重试
      if (resp.status === 202) {
        let retry = 2;
        try {
          const body = await resp.json();
          if (body && body.retry_after) retry = body.retry_after;
        } catch (e) { /* ignore */ }
        indexWaits++;
        sendProgress({ stage: "indexing", waitMs: Math.ceil(retry * 1000), attempt: indexWaits });
        if (indexWaits > 30) {
          throw new Error("服务器搜索索引长时间未就绪，请稍后再试。");
        }
        await sleep(Math.ceil(retry * 1000) + 300);
        continue;
      }

      if (resp.status === 429) {
        let retry = 1;
        try {
          const body = await resp.json();
          retry = (body && body.retry_after) ? body.retry_after : 1;
        } catch (e) { /* ignore */ }
        sendProgress({ stage: "ratelimited", waitMs: Math.ceil(retry * 1000) });
        await sleep(Math.ceil(retry * 1000) + 200);
        continue;
      }

      if (resp.status === 401 || resp.status === 403) {
        throw new Error("无权限或 token 失效（401/403）。请确认你已登录并对该服务器有访问权限。");
      }

      if (!resp.ok) {
        let detail = "";
        try {
          const body = await resp.json();
          if (body && body.message) detail = "：" + body.message;
        } catch (e) { /* ignore */ }
        throw new Error("请求失败，HTTP " + resp.status + detail);
      }

      return resp.json();
    }
  }

  // 把搜索结果里的二维 messages 数组拍平，只取命中的那条
  function flattenHits(json) {
    const out = [];
    if (!json || !Array.isArray(json.messages)) return out;
    for (const group of json.messages) {
      if (!Array.isArray(group)) continue;
      // group 里 hit:true 的就是命中条目，没有标记则取第一条
      const hit = group.find((m) => m && m.hit) || group[0];
      if (hit) out.push(hit);
    }
    return out;
  }

  // 通过用户名解析出 author_id。
  // 1) 优先用拦截到的 API 响应缓存（最可靠）；2) 再试受限的成员搜索接口；3) 最后从 DOM 兜底。
  async function resolveUsersByName(guildId, name) {
    const lower = name.toLowerCase();

    // 1) 拦截缓存
    const fromCache = [];
    for (const u of userCache.values()) {
      const un = (u.username || "").toLowerCase();
      const gn = (u.globalName || "").toLowerCase();
      if (un === lower || gn === lower || un.includes(lower) || gn.includes(lower)) {
        fromCache.push(u);
      }
    }
    if (fromCache.length) {
      // 精确匹配优先
      fromCache.sort((a, b) => {
        const ax = ((a.username || "").toLowerCase() === lower || (a.globalName || "").toLowerCase() === lower) ? 0 : 1;
        const bx = ((b.username || "").toLowerCase() === lower || (b.globalName || "").toLowerCase() === lower) ? 0 : 1;
        return ax - bx;
      });
      return fromCache;
    }

    // 2) REST 成员搜索（需权限，普通成员常 403）
    try {
      const params = new URLSearchParams();
      params.set("query", name);
      params.set("limit", "10");
      const url = `${API}/guilds/${guildId}/members/search?${params.toString()}`;
      const json = await apiGet(url);
      const list = Array.isArray(json) ? json : [];
      const mapped = list.map((entry) => {
        const u = entry.user || {};
        return { id: u.id, username: u.username, globalName: u.global_name, nick: entry.nick };
      }).filter((u) => u.id);
      if (mapped.length) return mapped;
    } catch (e) {
      // 忽略，走 DOM 兜底
    }

    // 3) DOM 兜底
    const domHits = resolveUsersFromDOM(name);
    if (domHits.length) return domHits;

    return [];
  }

  // 扫描页面上已渲染的头像，建立 用户名/昵称 -> 用户ID 的匹配。
  // 头像地址形如：
  //   https://cdn.discordapp.com/avatars/{userId}/{hash}.png
  //   https://cdn.discordapp.com/guilds/{gid}/users/{userId}/avatars/{hash}.png
  function resolveUsersFromDOM(name) {
    const lower = name.toLowerCase();
    const found = new Map(); // id -> {id, label}
    const imgs = document.querySelectorAll('img[src*="cdn.discordapp.com/avatars/"], img[src*="/users/"][src*="/avatars/"]');

    for (const img of imgs) {
      const src = img.getAttribute("src") || "";
      let m = src.match(/\/users\/(\d+)\/avatars\//) || src.match(/\/avatars\/(\d+)\//);
      if (!m) continue;
      const id = m[1];

      // 向上找承载这条消息/资料卡的容器，再在其中找用户名文本
      const container = img.closest('[class*="message"], [class*="userPopout"], [class*="member"], li, article') || img.parentElement;
      const text = (container ? container.textContent : "") || "";
      const alt = (img.getAttribute("alt") || "").replace(/^@/, "");

      // 命中条件：alt 或容器文本包含目标用户名
      if (alt.toLowerCase().includes(lower) || text.toLowerCase().includes(lower)) {
        const label = alt || name;
        if (!found.has(id)) found.set(id, { id, username: label, globalName: alt || null, nick: null });
      }
    }

    return Array.from(found.values());
  }

  // 核心：抓取某服务器中指定用户的全部消息
  // 用 snowflake 游标(max_id)翻页，避开 offset 5000 上限，也不会因稀疏页提前结束。
  // 支持断点续传：每抓若干页就把游标+消息存进 IndexedDB。
  async function fetchAllMessages(authorId, scope, templateUrl, resume) {
    const collected = new Map(); // id -> message，去重
    let maxId = null;            // 游标：只取比它更早的消息
    let totalEstimate = null;
    const key = jobKey(authorId, scope, templateUrl);

    // 恢复存档
    if (resume && resume.messages) {
      for (const m of resume.messages) collected.set(m.id, m);
      maxId = resume.maxId || null;
      totalEstimate = resume.total || null;
    }

    async function saveCheckpoint(done) {
      try {
        await idbPut(key, {
          key, authorId,
          scope: { type: scope.type, guildId: scope.guildId, channelId: scope.channelId || null },
          templateUrl: templateUrl || null,
          maxId, total: totalEstimate,
          messages: Array.from(collected.values()),
          updatedAt: Date.now(),
          done: !!done,
        });
      } catch (e) { /* 存档失败不影响主流程 */ }
    }

    // 构造请求 URL（offset 恒为 0，靠 max_id 推进）
    let makeUrl;
    if (templateUrl) {
      const tpl = new URL(templateUrl);
      makeUrl = (mId) => {
        const u = new URL(tpl.href);
        u.searchParams.set("offset", "0");
        if (mId) u.searchParams.set("max_id", mId);
        else u.searchParams.delete("max_id");
        return u.href;
      };
    } else {
      const base = `${API}/guilds/${scope.guildId}/messages/search`;
      makeUrl = (mId) => {
        const params = new URLSearchParams();
        params.set("author_id", authorId);
        params.set("offset", "0");
        params.set("sort_by", "timestamp");
        params.set("sort_order", "desc");
        if (scope.type === "channel") params.set("channel_id", scope.channelId);
        if (mId) params.set("max_id", mId);
        return `${base}?${params.toString()}`;
      };
    }

    let pageCount = 0;
    while (true) {
      if (cancelRequested) { await saveCheckpoint(false); throw new Error("__CANCELLED__"); }

      const json = await apiGet(makeUrl(maxId));
      if (totalEstimate === null && typeof json.total_results === "number") {
        totalEstimate = json.total_results;
      }

      const hits = flattenHits(json);
      if (hits.length === 0) break;

      // 找出本页最早(最小)的 id，作为下一页游标
      let smallest = null;
      let added = 0;
      for (const m of hits) {
        if (!collected.has(m.id)) { collected.set(m.id, m); added++; }
        if (smallest === null || BigInt(m.id) < BigInt(smallest)) smallest = m.id;
      }

      sendProgress({ stage: "fetching", collected: collected.size, total: totalEstimate });

      if (added === 0) break;

      const next = (BigInt(smallest) - 1n).toString();
      if (maxId && next === maxId) break; // 游标没动，防止死循环
      maxId = next;

      // 每 10 页存一次档（约每 250 条）
      if (++pageCount % 10 === 0) await saveCheckpoint(false);

      await sleep(650); // 友好限速
    }

    await saveCheckpoint(true); // 标记完成
    return finalize(collected);
  }

  function finalize(map) {
    const arr = Array.from(map.values());
    arr.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1)); // 按时间正序
    return arr;
  }

  // -------- 导出格式化 --------
  function toJSON(messages, meta) {
    return JSON.stringify({ meta, count: messages.length, messages }, null, 2);
  }

  function csvEscape(v) {
    const s = (v === null || v === undefined) ? "" : String(v);
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function toCSV(messages) {
    const header = ["id", "timestamp", "author_id", "author", "channel_id", "content", "attachments"];
    const lines = [header.join(",")];
    for (const m of messages) {
      const author = m.author ? (m.author.global_name || m.author.username || "") : "";
      const atts = (m.attachments || []).map((a) => a.url).join(" | ");
      lines.push([
        csvEscape(m.id),
        csvEscape(m.timestamp),
        csvEscape(m.author ? m.author.id : ""),
        csvEscape(author),
        csvEscape(m.channel_id),
        csvEscape(m.content),
        csvEscape(atts),
      ].join(","));
    }
    return lines.join("\r\n");
  }

  function toTXT(messages) {
    return messages.map((m) => {
      const author = m.author ? (m.author.global_name || m.author.username || m.author.id) : "?";
      const atts = (m.attachments || []).map((a) => "[附件] " + a.url).join("\n");
      return `[${m.timestamp}] ${author}: ${m.content || ""}${atts ? "\n" + atts : ""}`;
    }).join("\n\n");
  }

  function escHtml(s) {
    return String(s || "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function toHTML(messages, meta) {
    const rows = messages.map((m) => {
      const author = m.author ? (m.author.global_name || m.author.username || m.author.id) : "?";
      const atts = (m.attachments || []).map((a) =>
        `<div class="att"><a href="${escHtml(a.url)}" target="_blank">${escHtml(a.filename || a.url)}</a></div>`
      ).join("");
      return `<div class="msg"><div class="meta"><span class="ts">${escHtml(m.timestamp)}</span> <span class="author">${escHtml(author)}</span></div><div class="content">${escHtml(m.content)}</div>${atts}</div>`;
    }).join("\n");
    return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>Discord 导出</title>
<style>body{font-family:system-ui,sans-serif;background:#313338;color:#dbdee1;margin:0;padding:20px}
h1{font-size:18px}.summary{color:#949ba4;margin-bottom:16px;font-size:13px}
.msg{padding:8px 12px;border-radius:6px}.msg:hover{background:#2e3035}
.meta{font-size:12px;color:#949ba4}.author{color:#fff;font-weight:600}
.content{white-space:pre-wrap;word-break:break-word;margin-top:2px}
.att a{color:#00a8fc;font-size:13px}</style></head>
<body><h1>Discord 消息导出</h1>
<div class="summary">用户ID: ${escHtml(meta.authorId)} · 共 ${messages.length} 条 · 导出时间 ${escHtml(meta.exportedAt)}</div>
${rows}</body></html>`;
  }

  function buildOutput(messages, format, meta) {
    switch (format) {
      case "csv":  return { data: toCSV(messages), mime: "text/csv", ext: "csv" };
      case "txt":  return { data: toTXT(messages), mime: "text/plain", ext: "txt" };
      case "html": return { data: toHTML(messages, meta), mime: "text/html", ext: "html" };
      case "json":
      default:     return { data: toJSON(messages, meta), mime: "application/json", ext: "json" };
    }
  }

  // base64 编码（兼容中文）
  function toDataUrl(str, mime) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return `data:${mime};base64,` + btoa(bin);
  }

  // -------- 解析当前页面所在的 guild/channel --------
  function parseLocation() {
    // URL 形如 /channels/{guildId}/{channelId}
    const m = location.pathname.match(/^\/channels\/(@me|\d+)\/?(\d+)?/);
    if (!m) return {};
    return { guildId: m[1], channelId: m[2] };
  }

  // 浏览器内直接触发下载
  function triggerDownload(dataUrl, filename) {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 0);
  }

  // -------- 执行一次导出任务 --------
  async function startExport(opts) {
    const { mode, query, format, scopeType, textOnly } = opts;
    if (running) return { ok: false, error: "已有任务在运行中。" };
    if (!TOKEN) return { ok: false, error: "尚未捕获到登录令牌，请在 Discord 里点开任意频道或刷新页面后重试。" };

    const loc = parseLocation();
    if (!loc.guildId || loc.guildId === "@me") {
      return { ok: false, error: "请先打开目标服务器的某个频道，再开始导出。" };
    }
    if (scopeType === "channel" && !loc.channelId) {
      return { ok: false, error: "未检测到当前频道，请打开一个具体频道。" };
    }

    const scope = scopeType === "channel"
      ? { type: "channel", guildId: loc.guildId, channelId: loc.channelId }
      : { type: "guild", guildId: loc.guildId };

    running = true;
    cancelRequested = false;

    (async () => {
      try {
        // 解析出 author_id
        let authorId = query;
        let templateUrl = null;

        if (mode === "name") {
          sendProgress({ stage: "resolving", name: query });
          const users = await resolveUsersByName(scope.guildId, query);
          if (users.length === 0) {
            throw new Error(`没找到用户名包含“${query}”的人。请先在页面上点开该用户的资料卡（或滚动到其发言处），让头像可见，再试一次；也可以改用“按用户 ID”。`);
          }
          const lower = query.toLowerCase();
          const exact = users.find((u) =>
            (u.username && u.username.toLowerCase() === lower) ||
            (u.globalName && u.globalName.toLowerCase() === lower) ||
            (u.nick && u.nick.toLowerCase() === lower)
          );
          const chosen = exact || users[0];
          authorId = chosen.id;
          sendProgress({ stage: "resolved", authorId, label: chosen.globalName || chosen.username, count: users.length });
        }

        // 若该 authorId 正好是 Discord 原生搜索刚用过的，复用其完整 URL（参数最可靠）
        if (lastSearchedAuthor && lastSearchedAuthor.authorId === authorId &&
            lastSearchedAuthor.searchUrl && scope.type === "guild") {
          templateUrl = lastSearchedAuthor.searchUrl;
        }

        // 查找未完成的存档以续传
        let resume = null;
        if (!opts.fresh) {
          try {
            const cp = await idbGet(jobKey(authorId, scope, templateUrl));
            if (cp && !cp.done && cp.messages && cp.messages.length) {
              resume = cp;
              sendProgress({ stage: "resumed", collected: cp.messages.length });
            }
          } catch (e) { /* ignore */ }
        }

        const messages = await fetchAllMessages(authorId, scope, templateUrl, resume);
        const filtered = textOnly
          ? messages.filter((m) => m && typeof m.content === "string" && m.content.trim().length > 0)
          : messages;
        const meta = {
          authorId,
          query,
          mode,
          textOnly: !!textOnly,
          guildId: scope.guildId,
          channelId: scope.type === "channel" ? scope.channelId : null,
          scope: scope.type,
          usedNativeUrl: !!templateUrl,
          exportedAt: new Date().toISOString(),
        };
        const out = buildOutput(filtered, format, meta);
        const filename = `discord_${authorId}_${Date.now()}.${out.ext}`;
        // 导出成功，清掉该任务存档
        try { await idbDel(jobKey(authorId, scope, templateUrl)); } catch (e) { /* ignore */ }
        sendProgress({
          stage: "done",
          collected: filtered.length,
          dataUrl: toDataUrl(out.data, out.mime),
          filename,
        });
      } catch (e) {
        if (e && e.message === "__CANCELLED__") {
          sendProgress({ stage: "cancelled" });
        } else {
          sendProgress({ stage: "error", error: (e && e.message) || String(e) });
        }
      } finally {
        running = false;
      }
    })();

    return { ok: true, started: true };
  }

  // ======================= 页面内悬浮窗 UI =======================
  let panel = null;

  function buildPanel() {
    if (panel) return panel;

    const root = document.createElement("div");
    root.id = "dme-panel";
    root.innerHTML = `
      <div class="dme-head" id="dme-head">
        <span class="dme-title">Discord 消息导出</span>
        <div class="dme-head-btns">
          <button class="dme-icon" id="dme-min" title="最小化">—</button>
          <button class="dme-icon" id="dme-close" title="关闭">×</button>
        </div>
      </div>
      <div class="dme-body" id="dme-body">
        <div class="dme-status" id="dme-status">检测中…</div>

        <label class="dme-label">查找方式</label>
        <div class="dme-radios">
          <label><input type="radio" name="dme-mode" value="name" checked> 按用户名</label>
          <label><input type="radio" name="dme-mode" value="id"> 按用户 ID</label>
        </div>

        <label class="dme-label" id="dme-query-label">用户名</label>
        <input class="dme-input" id="dme-author" type="text" placeholder="输入用户名 / 昵称" autocomplete="off" />
        <div class="dme-hint" id="dme-query-hint">先在页面点开该用户资料卡让头像可见，再输入其用户名/昵称。</div>
        <button class="dme-btn dme-secondary dme-mini" id="dme-use-last" type="button">↳ 使用 Discord 搜索框最近的用户</button>

        <label class="dme-label">搜索范围</label>
        <div class="dme-radios">
          <label><input type="radio" name="dme-scope" value="guild" checked> 整个服务器</label>
          <label><input type="radio" name="dme-scope" value="channel"> 仅当前频道</label>
        </div>

        <label class="dme-label">导出格式</label>
        <select class="dme-input" id="dme-format">
          <option value="json">JSON</option>
          <option value="csv">CSV (Excel)</option>
          <option value="txt">纯文本 TXT</option>
          <option value="html">HTML 网页</option>
        </select>

        <label class="dme-check"><input type="checkbox" id="dme-text-only"> 仅保留含文本的消息（过滤纯图片/附件）</label>

        <div class="dme-actions">
          <button class="dme-btn dme-primary" id="dme-start">开始导出</button>
          <button class="dme-btn dme-secondary" id="dme-cancel" disabled>取消</button>
        </div>

        <div class="dme-progress dme-hidden" id="dme-progress">
          <div class="dme-bar"><div class="dme-bar-fill" id="dme-bar-fill"></div></div>
          <div class="dme-progress-text" id="dme-progress-text"></div>
        </div>
        <div class="dme-msg dme-hidden" id="dme-msg"></div>
      </div>
    `;
    document.body.appendChild(root);
    injectStyles();

    const $ = (id) => root.querySelector("#" + id);
    const statusEl = $("dme-status");
    const startBtn = $("dme-start");
    const cancelBtn = $("dme-cancel");
    const progressEl = $("dme-progress");
    const barFill = $("dme-bar-fill");
    const progressText = $("dme-progress-text");
    const msgEl = $("dme-msg");
    const bodyEl = $("dme-body");

    function showMsg(text, kind) {
      msgEl.textContent = text;
      msgEl.className = "dme-msg dme-" + (kind || "info");
    }
    function setStatus(text, kind) {
      statusEl.textContent = text;
      statusEl.className = "dme-status dme-" + (kind || "");
    }
    function resetButtons() {
      startBtn.disabled = false;
      cancelBtn.disabled = true;
    }

    function refreshStatus() {
      const loc = parseLocation();
      if (!TOKEN) {
        setStatus("未捕获令牌，请点开任意频道或刷新", "warn");
      } else if (!loc.guildId || loc.guildId === "@me") {
        setStatus("请打开目标服务器的频道", "warn");
      } else {
        setStatus("已就绪", "ok");
      }
    }
    refreshStatus();
    const statusTimer = setInterval(refreshStatus, 1500);

    // 进度回调，更新本悬浮窗
    onProgress = function (msg) {
      switch (msg.stage) {
        case "resolving":
          progressEl.classList.remove("dme-hidden");
          progressText.textContent = `正在解析用户名“${msg.name}”…`;
          break;
        case "resolved":
          progressText.textContent = `已定位用户：${msg.label}（ID ${msg.authorId}）`;
          if (msg.count > 1) {
            showMsg(`匹配到 ${msg.count} 个相近用户名，已选用最接近的「${msg.label}」。如不对请改用“按用户 ID”。`, "info");
          }
          break;
        case "resumed":
          progressEl.classList.remove("dme-hidden");
          progressText.textContent = `从上次断点继续，已有 ${msg.collected} 条`;
          showMsg(`检测到未完成的存档，正在断点续传（已抓 ${msg.collected} 条）。`, "info");
          break;
        case "neterror":
          progressText.textContent = `网络中断，${Math.ceil((msg.waitMs || 1000) / 1000)} 秒后重试（第 ${msg.attempt} 次）…进度已存档`;
          break;
        case "fetching": {
          const c = msg.collected || 0;
          progressEl.classList.remove("dme-hidden");
          if (msg.total) {
            const pct = Math.min(99, Math.round((c / msg.total) * 100));
            barFill.style.width = pct + "%";
            progressText.textContent = `已抓取 ${c} / 约 ${msg.total} 条`;
          } else {
            progressText.textContent = `已抓取 ${c} 条…`;
          }
          break;
        }
        case "indexing":
          progressEl.classList.remove("dme-hidden");
          progressText.textContent = `服务器正在建立搜索索引，等待重试（第 ${msg.attempt} 次）…`;
          break;
        case "ratelimited":
          progressText.textContent = `触发限速，等待 ${Math.ceil((msg.waitMs || 1000) / 1000)} 秒…`;
          break;
        case "done":
          barFill.style.width = "100%";
          progressText.textContent = `完成，共 ${msg.collected} 条`;
          if (msg.collected === 0) {
            showMsg("搜索结果为 0 条。可能原因：用户 ID 不对、该用户在此范围内没有发言、或你无权查看相关频道。", "error");
          } else {
            showMsg(`导出完成，共 ${msg.collected} 条，文件已开始下载。`, "success");
          }
          if (msg.dataUrl) triggerDownload(msg.dataUrl, msg.filename);
          resetButtons();
          break;
        case "cancelled":
          progressText.textContent = "已取消";
          showMsg("任务已取消。", "info");
          resetButtons();
          break;
        case "error":
          progressText.textContent = "出错";
          showMsg("出错：" + (msg.error || "未知错误"), "error");
          resetButtons();
          break;
      }
    };

    // 查找方式切换：更新输入框标签与提示
    const queryLabel = $("dme-query-label");
    const queryHint = $("dme-query-hint");
    const authorInput = $("dme-author");
    root.querySelectorAll('input[name="dme-mode"]').forEach((r) => {
      r.addEventListener("change", () => {
        const mode = root.querySelector('input[name="dme-mode"]:checked').value;
        if (mode === "name") {
          queryLabel.textContent = "用户名";
          authorInput.placeholder = "输入用户名 / 昵称";
          queryHint.textContent = "先在页面点开该用户资料卡让头像可见，再输入其用户名/昵称。";
        } else {
          queryLabel.textContent = "目标用户 ID";
          authorInput.placeholder = "纯数字用户 ID";
          queryHint.textContent = "开发者模式下右键头像 → 复制用户 ID。";
        }
      });
    });

    // 复用 Discord 原生搜索栏最近一次搜过的用户：直接切到“按用户 ID”并填入
    $("dme-use-last").addEventListener("click", () => {
      if (!lastSearchedAuthor || !lastSearchedAuthor.authorId) {
        showMsg("还没捕获到。请先在 Discord 自己的搜索栏里搜一次「来自: 某人」，再点这里。", "info");
        return;
      }
      const idRadio = root.querySelector('input[name="dme-mode"][value="id"]');
      idRadio.checked = true;
      idRadio.dispatchEvent(new Event("change"));
      authorInput.value = lastSearchedAuthor.authorId;
      const cached = userCache.get(lastSearchedAuthor.authorId);
      const label = cached ? (cached.globalName || cached.username) : null;
      showMsg(label
        ? `已填入：${label}（ID ${lastSearchedAuthor.authorId}）`
        : `已填入 ID ${lastSearchedAuthor.authorId}`, "success");
    });

    startBtn.addEventListener("click", async () => {
      const mode = root.querySelector('input[name="dme-mode"]:checked').value;
      const query = authorInput.value.trim();
      if (!query) {
        showMsg(mode === "name" ? "请输入用户名。" : "请输入用户 ID。", "error");
        return;
      }
      if (mode === "id" && !/^\d{5,25}$/.test(query)) {
        showMsg("用户 ID 应为一串纯数字。", "error");
        return;
      }
      const format = $("dme-format").value;
      const scopeType = root.querySelector('input[name="dme-scope"]:checked').value;
      const textOnly = $("dme-text-only").checked;

      startBtn.disabled = true;
      cancelBtn.disabled = false;
      progressEl.classList.remove("dme-hidden");
      barFill.style.width = "0%";
      progressText.textContent = "开始中…";
      showMsg("正在抓取，请保持此 Discord 标签页打开。", "info");

      const resp = await startExport({ mode, query, format, scopeType, textOnly });
      if (!resp.ok) {
        showMsg(resp.error, "error");
        resetButtons();
      }
    });

    cancelBtn.addEventListener("click", () => {
      cancelRequested = true;
      cancelBtn.disabled = true;
      progressText.textContent = "正在取消…";
    });

    // 最小化 / 关闭
    $("dme-min").addEventListener("click", () => {
      bodyEl.classList.toggle("dme-hidden");
    });
    $("dme-close").addEventListener("click", () => {
      clearInterval(statusTimer);
      root.remove();
      panel = null;
    });

    // 拖动
    makeDraggable(root, $("dme-head"));

    panel = root;
    return root;
  }

  function togglePanel() {
    if (panel) {
      panel.remove();
      panel = null;
    } else {
      buildPanel();
    }
  }

  function makeDraggable(el, handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    handle.style.cursor = "move";
    handle.addEventListener("mousedown", (e) => {
      if (e.target.closest(".dme-icon")) return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const rect = el.getBoundingClientRect();
      ox = rect.left; oy = rect.top;
      el.style.right = "auto";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      e.preventDefault();
    });
    function onMove(e) {
      if (!dragging) return;
      let nx = ox + (e.clientX - sx);
      let ny = oy + (e.clientY - sy);
      nx = Math.max(0, Math.min(nx, window.innerWidth - el.offsetWidth));
      ny = Math.max(0, Math.min(ny, window.innerHeight - 40));
      el.style.left = nx + "px";
      el.style.top = ny + "px";
    }
    function onUp() {
      dragging = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
  }

  function injectStyles() {
    if (document.getElementById("dme-style")) return;
    const s = document.createElement("style");
    s.id = "dme-style";
    s.textContent = `
#dme-panel{position:fixed;top:70px;right:20px;width:300px;z-index:2147483647;
  background:#2b2d31;color:#dbdee1;border:1px solid #1e1f22;border-radius:8px;
  box-shadow:0 8px 24px rgba(0,0,0,.5);font-family:system-ui,"Segoe UI",sans-serif;font-size:13px;}
#dme-panel *{box-sizing:border-box;}
.dme-head{display:flex;align-items:center;justify-content:space-between;padding:9px 12px;
  background:#1e1f22;border-radius:8px 8px 0 0;user-select:none;}
.dme-title{font-weight:600;color:#fff;font-size:13px;}
.dme-head-btns{display:flex;gap:4px;}
.dme-icon{width:22px;height:22px;border:none;border-radius:4px;background:transparent;color:#b5bac1;
  cursor:pointer;font-size:14px;line-height:1;}
.dme-icon:hover{background:#35373c;color:#fff;}
.dme-body{padding:12px;}
.dme-status{font-size:11px;padding:3px 8px;border-radius:10px;background:#1e1f22;color:#949ba4;
  display:inline-block;margin-bottom:10px;}
.dme-status.dme-ok{color:#23a55a;} .dme-status.dme-warn{color:#f0b232;} .dme-status.dme-err{color:#f23f43;}
.dme-label{display:block;font-size:12px;font-weight:600;margin:8px 0 4px;color:#b5bac1;}
.dme-input{width:100%;padding:7px;border-radius:4px;border:1px solid #1e1f22;background:#1e1f22;
  color:#dbdee1;font-size:13px;}
.dme-input:focus{outline:none;border-color:#5865f2;}
.dme-hint{font-size:11px;color:#80848e;margin-top:3px;}
.dme-radios{display:flex;gap:12px;}
.dme-radios label{display:flex;align-items:center;gap:4px;cursor:pointer;}
.dme-radios input{accent-color:#5865f2;}
.dme-check{display:flex;align-items:center;gap:6px;margin-top:10px;font-size:12px;font-weight:400;color:#b5bac1;cursor:pointer;}
.dme-check input{accent-color:#5865f2;}
.dme-actions{display:flex;gap:8px;margin-top:12px;}
.dme-btn{flex:1;padding:8px;border:none;border-radius:4px;font-size:13px;font-weight:600;cursor:pointer;}
.dme-btn:disabled{opacity:.5;cursor:not-allowed;}
.dme-mini{flex:none;width:100%;margin-top:6px;padding:5px 8px;font-size:11px;font-weight:500;}
.dme-primary{background:#5865f2;color:#fff;} .dme-primary:hover:not(:disabled){background:#4752c4;}
.dme-secondary{background:#4e5058;color:#fff;} .dme-secondary:hover:not(:disabled){background:#6d6f78;}
.dme-progress{margin-top:12px;}
.dme-bar{width:100%;height:6px;background:#1e1f22;border-radius:3px;overflow:hidden;}
.dme-bar-fill{height:100%;width:0;background:#5865f2;transition:width .3s;}
.dme-progress-text{font-size:12px;color:#b5bac1;margin-top:6px;text-align:center;}
.dme-msg{margin-top:10px;padding:8px;border-radius:4px;font-size:12px;line-height:1.5;}
.dme-msg.dme-info{background:#1e3a5f;color:#a8cfff;}
.dme-msg.dme-error{background:#4a1f22;color:#ffb3b5;}
.dme-msg.dme-success{background:#1f3d2b;color:#9be8b5;}
.dme-hidden{display:none!important;}
`;
    document.head.appendChild(s);
  }

  // -------- 监听后台“切换悬浮窗”指令 --------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "DME_TOGGLE_PANEL") {
      togglePanel();
      sendResponse({ ok: true });
    }
    return true;
  });
})();
