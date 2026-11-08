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
  let guildsCache = null;               // [{id, name, icon}]
  const channelsCache = new Map();      // guildId -> [{id, name, type, parent_id, position, nsfw}]
  let onTokenReady = null;              // 令牌晚到时用来触发面板重新加载列表

  // 接收主世界传来的 token
  window.addEventListener("message", function (ev) {
    if (ev.source !== window || !ev.data) return;
    if (ev.data.source === "DME_TOKEN" && ev.data.token) {
      TOKEN = ev.data.token;
      chrome.storage.local.set({ dme_has_token: true });
      if (typeof onTokenReady === "function") {
        try { onTokenReady(); } catch (e) { /* ignore */ }
      }
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
          const err = new Error("服务器搜索索引长时间未就绪，请稍后再试。");
          err.code = "INDEX_TIMEOUT";
          throw err;
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
        let detail = "";
        try {
          const body = await resp.json();
          if (body && body.message) detail = "：" + body.message;
        } catch (e) { /* ignore */ }
        const err = new Error("无权限或 token 失效（HTTP " + resp.status + "）" + detail +
          "。请确认你已登录并对该服务器/频道有访问权限。");
        err.status = resp.status;
        throw err;
      }

      if (!resp.ok) {
        let detail = "";
        try {
          const body = await resp.json();
          if (body && body.message) detail = "：" + body.message;
        } catch (e) { /* ignore */ }
        const err = new Error("请求失败，HTTP " + resp.status + detail);
        err.status = resp.status;
        throw err;
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
        u.searchParams.set("include_nsfw", "true");
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
        // 关键：频道级搜索若频道是 NSFW/年龄限制，缺 include_nsfw 会被服务端直接 403
        params.set("include_nsfw", "true");
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

  // 兜底方案：直接翻「频道历史消息」并按作者过滤。
  // 频道级搜索接口在某些情况下（NSFW/年龄限制频道、线程、搜索索引异常）会返回 403，
  // 而 /channels/{id}/messages 只要求「读取消息历史」权限，稳定可用。
  // 游标用 before（= 已抓到的最早一条的 id），复用存档里的 maxId 字段以便断点续传。
  async function fetchChannelHistoryByAuthor(authorId, scope, resume, key) {
    const collected = new Map();
    let before = (resume && resume.maxId) || null;
    key = key || jobKey(authorId, scope, null);

    if (resume && resume.messages) {
      for (const m of resume.messages) collected.set(m.id, m);
    }

    async function saveCheckpoint(done) {
      try {
        await idbPut(key, {
          key, authorId,
          scope: { type: scope.type, guildId: scope.guildId, channelId: scope.channelId || null },
          templateUrl: null,
          maxId: before, total: null,
          messages: Array.from(collected.values()),
          updatedAt: Date.now(),
          done: !!done,
        });
      } catch (e) { /* ignore */ }
    }

    let scanned = 0;
    let pageCount = 0;
    while (true) {
      if (cancelRequested) { await saveCheckpoint(false); throw new Error("__CANCELLED__"); }

      const params = new URLSearchParams();
      params.set("limit", "100");
      if (before) params.set("before", before);
      const batch = await apiGet(`${API}/channels/${scope.channelId}/messages?${params.toString()}`);
      if (!Array.isArray(batch) || batch.length === 0) break;

      let oldest = null;
      for (const m of batch) {
        scanned++;
        if (m.author && m.author.id === authorId && !collected.has(m.id)) {
          collected.set(m.id, m);
        }
        if (oldest === null || BigInt(m.id) < BigInt(oldest)) oldest = m.id;
      }

      sendProgress({ stage: "scanning", scanned, collected: collected.size });

      if (oldest === null) break;
      if (before && oldest === before) break; // 游标没动，防死循环
      before = oldest;

      // 每 5 页（500 条）存一次档
      if (++pageCount % 5 === 0) await saveCheckpoint(false);

      if (batch.length < 100) break; // 已到频道最早一条
      await sleep(650); // 友好限速
    }

    await saveCheckpoint(true);
    return finalize(collected);
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
    const { mode, query, scopeType, textOnly } = opts;
    // 支持多选导出格式；兼容旧的单个 format 参数
    const ALLOWED_FORMATS = ["json", "csv", "txt", "html"];
    let formats = Array.isArray(opts.formats)
      ? opts.formats.filter((f) => ALLOWED_FORMATS.includes(f))
      : (opts.format ? [opts.format] : []);
    if (!formats.length) formats = ["json"];
    formats = Array.from(new Set(formats));
    if (running) return { ok: false, error: "已有任务在运行中。" };
    if (!TOKEN) return { ok: false, error: "尚未捕获到登录令牌，请在 Discord 里点开任意频道或刷新页面后重试。" };

    // 优先用面板里选中的服务器/频道；没选时退回当前页面所在位置
    const loc = parseLocation();
    const guildId = opts.guildId || (loc.guildId && loc.guildId !== "@me" ? loc.guildId : null);
    const channelId = opts.channelId || loc.channelId || null;
    if (!guildId) {
      return { ok: false, error: "请先在面板里选择服务器。" };
    }
    if (scopeType === "channel" && !channelId) {
      return { ok: false, error: "请先选择一个频道，或把搜索范围改成“整个服务器”。" };
    }

    const scope = scopeType === "channel"
      ? { type: "channel", guildId, channelId }
      : { type: "guild", guildId };

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

        // 若该 authorId 正好是 Discord 原生搜索刚用过的，复用其完整 URL（参数最可靠）。
        // 频道范围时，只有原生搜索确实限定在同一频道才复用。
        if (lastSearchedAuthor && lastSearchedAuthor.authorId === authorId && lastSearchedAuthor.searchUrl &&
            (!lastSearchedAuthor.guildId || lastSearchedAuthor.guildId === scope.guildId)) {
          if (scope.type === "guild") {
            templateUrl = lastSearchedAuthor.searchUrl;
          } else if (scope.type === "channel") {
            try {
              const u = new URL(lastSearchedAuthor.searchUrl);
              const cid = u.searchParams.get("channel_id");
              if (cid === scope.channelId) templateUrl = lastSearchedAuthor.searchUrl;
            } catch (e) { /* ignore */ }
          }
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

        let messages;
        try {
          messages = await fetchAllMessages(authorId, scope, templateUrl, resume);
        } catch (e) {
          // 频道级搜索接口偶发 400/403/404（NSFW 频道、线程、索引异常等）时，
          // 改用频道历史消息兜底，只按作者过滤，稳定可用。
          const canFallback = scope.type === "channel" && e && (
            e.code === "INDEX_TIMEOUT" ||
            (e.status && (e.status === 400 || e.status === 403 || e.status === 404 || e.status >= 500))
          );
          if (!canFallback) throw e;
          sendProgress({ stage: "fallback", status: e.status, reason: e.message });
          // 搜索途中失败时，尽量复用刚存下的断点，避免已抓到的消息白抓
          let cp2 = resume;
          try {
            const cp = await idbGet(jobKey(authorId, scope, templateUrl));
            if (cp && !cp.done && cp.messages && cp.messages.length &&
                (!cp2 || cp.messages.length > cp2.messages.length)) {
              cp2 = cp;
            }
          } catch (err) { /* ignore */ }
          messages = await fetchChannelHistoryByAuthor(
            authorId, scope, cp2, jobKey(authorId, scope, templateUrl)
          );
        }
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
          formats,
          exportedAt: new Date().toISOString(),
        };
        // 每种选中的格式各生成一个文件，共用一个时间戳
        const stamp = Date.now();
        const files = formats.map((fmt) => {
          const out = buildOutput(filtered, fmt, meta);
          return {
            format: fmt,
            ext: out.ext,
            mime: out.mime,
            filename: `discord_${authorId}_${stamp}.${out.ext}`,
            dataUrl: toDataUrl(out.data, out.mime),
          };
        });
        // 导出成功，清掉该任务存档
        try { await idbDel(jobKey(authorId, scope, templateUrl)); } catch (e) { /* ignore */ }
        sendProgress({
          stage: "done",
          collected: filtered.length,
          files,
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

        <div class="dme-field">
          <label class="dme-label dme-label-row">服务器
            <button class="dme-link" id="dme-refresh-guilds" type="button" title="重新加载服务器列表">↻ 刷新</button>
          </label>
          <select class="dme-input" id="dme-guild"><option value="">加载中…</option></select>
        </div>

        <div class="dme-field">
          <label class="dme-label">频道</label>
          <select class="dme-input" id="dme-channel"><option value="">（不指定 / 整个服务器）</option></select>
          <div class="dme-hint" id="dme-channel-hint">选中频道会自动切换为「仅所选频道」。</div>
        </div>

        <label class="dme-label">搜索范围</label>
        <div class="dme-radios">
          <label><input type="radio" name="dme-scope" value="guild" checked> 整个服务器</label>
          <label><input type="radio" name="dme-scope" value="channel"> 仅所选频道</label>
        </div>

        <label class="dme-label">导出格式（可多选）</label>
        <div class="dme-formats">
          <label class="dme-check"><input type="checkbox" name="dme-format" value="json" checked> JSON</label>
          <label class="dme-check"><input type="checkbox" name="dme-format" value="csv"> CSV (Excel)</label>
          <label class="dme-check"><input type="checkbox" name="dme-format" value="txt"> 纯文本 TXT</label>
          <label class="dme-check"><input type="checkbox" name="dme-format" value="html"> HTML 网页</label>
        </div>

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
    const guildSel = $("dme-guild");
    const channelSel = $("dme-channel");
    const channelHint = $("dme-channel-hint");
    const refreshGuildsBtn = $("dme-refresh-guilds");

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

    // ---------- 服务器 / 频道选择 ----------
    const TEXT_LIKE_TYPES = new Set([0, 2, 5, 13, 15, 16]); // 文字/语音/公告/舞台/论坛/媒体
    const channelIcon = (t) =>
      t === 5 ? "📢" : t === 15 ? "🗂" : t === 2 ? "🔊" : t === 13 ? "🎤" : t === 16 ? "🖼" : "#";
    const channelLabel = (c) => channelIcon(c.type) + " " + c.name + (c.nsfw ? " 🔞" : "");

    function setScope(type) {
      const r = root.querySelector(`input[name="dme-scope"][value="${type}"]`);
      if (r) r.checked = true;
    }

    function updateScopeHint() {
      const channelRadio = root.querySelector('input[name="dme-scope"][value="channel"]');
      const hasChannel = !!channelSel.value;
      channelRadio.disabled = !hasChannel;
      if (!hasChannel && channelRadio.checked) setScope("guild");
      channelHint.textContent = hasChannel
        ? "已选择频道，导出范围将限定在该频道。"
        : "选中频道会自动切换为「仅所选频道」。";
    }

    async function fetchGuilds() {
      const json = await apiGet(`${API}/users/@me/guilds`);
      const list = (Array.isArray(json) ? json : [])
        .filter((g) => g && g.id && g.id !== "@me")
        .map((g) => ({ id: g.id, name: g.name || g.id }));
      list.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
      guildsCache = list;
      return list;
    }

    async function fetchChannels(guildId, force) {
      if (!force && channelsCache.has(guildId)) return channelsCache.get(guildId);
      const json = await apiGet(`${API}/guilds/${guildId}/channels`);
      const list = (Array.isArray(json) ? json : [])
        .filter((c) => c && c.id && typeof c.type === "number")
        .map((c) => ({
          id: c.id,
          name: c.name || c.id,
          type: c.type,
          parentId: c.parent_id || null,
          position: typeof c.position === "number" ? c.position : 0,
          nsfw: !!c.nsfw,
        }));
      channelsCache.set(guildId, list);
      return list;
    }

    function fillGuildSelect(list, preferredId) {
      guildSel.innerHTML = "";
      if (!list.length) {
        guildSel.appendChild(new Option("（没有可用服务器）", ""));
        return;
      }
      for (const g of list) guildSel.appendChild(new Option(g.name, g.id));
      if (preferredId && list.some((g) => g.id === preferredId)) guildSel.value = preferredId;
      else guildSel.value = list[0].id;
    }

    function fillChannelSelect(guildId, preferredId) {
      channelSel.innerHTML = "";
      channelSel.appendChild(new Option("（不指定 / 整个服务器）", ""));
      const all = channelsCache.get(guildId) || [];
      const chans = all.filter((c) => TEXT_LIKE_TYPES.has(c.type));
      const cats = all.filter((c) => c.type === 4).sort((a, b) => a.position - b.position);

      const byParent = new Map();
      const loose = [];
      for (const c of chans) {
        if (c.parentId && cats.some((cat) => cat.id === c.parentId)) {
          if (!byParent.has(c.parentId)) byParent.set(c.parentId, []);
          byParent.get(c.parentId).push(c);
        } else {
          loose.push(c);
        }
      }

      // 无分类频道排在最前（与 Discord 侧栏一致）
      loose.sort((a, b) => a.position - b.position)
        .forEach((c) => channelSel.appendChild(new Option(channelLabel(c), c.id)));

      for (const cat of cats) {
        const children = byParent.get(cat.id);
        if (!children || !children.length) continue;
        const grp = document.createElement("optgroup");
        grp.label = cat.name;
        children.sort((a, b) => a.position - b.position)
          .forEach((c) => grp.appendChild(new Option(channelLabel(c), c.id)));
        channelSel.appendChild(grp);
      }

      if (preferredId && chans.some((c) => c.id === preferredId)) {
        channelSel.value = preferredId;
      } else if (preferredId) {
        // 当前页面是线程/论坛帖子等不在服务器频道列表里的频道时，仍允许选中它
        channelSel.appendChild(new Option("当前页面频道（" + preferredId + "）", preferredId));
        channelSel.value = preferredId;
      } else if (!chans.length) {
        channelSel.appendChild(new Option("（没有可用频道）", ""));
        channelSel.value = "";
      } else {
        channelSel.value = "";
      }
    }

    async function onGuildChange(preferredChannelId, force) {
      const gid = guildSel.value;
      channelSel.innerHTML = "";
      channelSel.appendChild(new Option("加载中…", ""));
      if (!gid) { updateScopeHint(); return; }
      try {
        await fetchChannels(gid, force);
        if (guildSel.value !== gid) return; // 期间又切换了服务器，丢弃旧结果
        fillChannelSelect(gid, preferredChannelId || null);
      } catch (e) {
        if (guildSel.value !== gid) return;
        channelSel.innerHTML = "";
        channelSel.appendChild(new Option("（频道加载失败，点「刷新」重试）", ""));
        showMsg("加载频道列表失败：" + ((e && e.message) || "未知错误"), "error");
      }
      updateScopeHint();
    }

    async function loadGuildsAndChannels(force) {
      const loc = parseLocation();
      const onPageGuild = loc.guildId && loc.guildId !== "@me" ? loc.guildId : null;
      const prevGuild = guildSel.value;
      const prevChannel = channelSel.value;
      guildSel.innerHTML = "";
      guildSel.appendChild(new Option("加载中…", ""));
      channelSel.innerHTML = "";
      channelSel.appendChild(new Option("加载中…", ""));
      try {
        if (force) { guildsCache = null; channelsCache.clear(); }
        const list = guildsCache || await fetchGuilds();
        // 当前页面所在服务器若不在列表里（例如刚加入），补一个占位项
        if (onPageGuild && !list.some((g) => g.id === onPageGuild)) {
          list.unshift({ id: onPageGuild, name: "当前服务器（" + onPageGuild + "）" });
        }
        // 刷新时优先保留原来的选择；否则定位到当前页面所在服务器/频道
        const targetGuild =
          (prevGuild && list.some((g) => g.id === prevGuild)) ? prevGuild : onPageGuild;
        fillGuildSelect(list, targetGuild);
        const preferredChannel =
          targetGuild === prevGuild ? prevChannel
            : (targetGuild === onPageGuild ? loc.channelId : null);
        await onGuildChange(preferredChannel || null, force);
      } catch (e) {
        guildSel.innerHTML = "";
        guildSel.appendChild(new Option("（加载失败，点「刷新」重试）", ""));
        channelSel.innerHTML = "";
        channelSel.appendChild(new Option("（不指定 / 整个服务器）", ""));
        updateScopeHint();
        showMsg("加载服务器列表失败：" + ((e && e.message) || "未知错误"), "error");
      }
    }

    guildSel.addEventListener("change", () => {
      const loc = parseLocation();
      const preferred = loc.guildId === guildSel.value ? loc.channelId : null;
      onGuildChange(preferred, false);
    });
    channelSel.addEventListener("change", () => {
      setScope(channelSel.value ? "channel" : "guild");
      updateScopeHint();
    });
    refreshGuildsBtn.addEventListener("click", () => {
      if (running) return;
      loadGuildsAndChannels(true);
    });

    function refreshStatus() {
      if (!TOKEN) {
        setStatus("未捕获令牌，请点开任意频道或刷新", "warn");
      } else if (!guildSel.value) {
        setStatus("请选择服务器", "warn");
      } else {
        setStatus("已就绪", "ok");
      }
    }
    refreshStatus();
    const statusTimer = setInterval(refreshStatus, 1500);
    loadGuildsAndChannels(false);
    onTokenReady = () => {
      if (!guildsCache) loadGuildsAndChannels(false);
    };

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
        case "fallback":
          progressEl.classList.remove("dme-hidden");
          progressText.textContent = "频道搜索接口不可用，正在改用频道历史扫描…";
          showMsg("频道级搜索不可用（" + (msg.status ? "HTTP " + msg.status : "搜索索引未就绪") + "），已自动切换为逐个翻频道历史并按作者过滤，速度会慢一些。", "info");
          break;
        case "scanning":
          progressEl.classList.remove("dme-hidden");
          progressText.textContent = `正在扫描频道历史：已检查 ${msg.scanned} 条，命中 ${msg.collected} 条…`;
          break;
        case "done": {
          barFill.style.width = "100%";
          progressText.textContent = `完成，共 ${msg.collected} 条`;
          const files = (Array.isArray(msg.files) && msg.files.length)
            ? msg.files
            : (msg.dataUrl ? [{ dataUrl: msg.dataUrl, filename: msg.filename, format: "" }] : []);
          if (msg.collected === 0) {
            showMsg("搜索结果为 0 条。可能原因：用户 ID 不对、该用户在此范围内没有发言、或你无权查看相关频道。", "error");
          } else {
            const names = files.map((f) => (f.format || f.ext || "").toUpperCase()).filter(Boolean).join("、");
            const extra = files.length > 1
              ? "若浏览器询问是否允许下载多个文件，请点「允许」。"
              : "";
            showMsg(`导出完成，共 ${msg.collected} 条，正在下载 ${files.length} 个文件` +
              (names ? `（${names}）` : "") + `。${extra}`, "success");
          }
          // 依次触发下载，间隔一点时间，避免被浏览器拦截
          files.forEach((f, i) => {
            setTimeout(() => triggerDownload(f.dataUrl, f.filename), i * 400);
          });
          resetButtons();
          break;
        }
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
      const formats = Array.from(root.querySelectorAll('input[name="dme-format"]:checked'))
        .map((el) => el.value);
      if (!formats.length) {
        showMsg("请至少选择一种导出格式。", "error");
        return;
      }
      const scopeType = root.querySelector('input[name="dme-scope"]:checked').value;
      const textOnly = $("dme-text-only").checked;
      const guildId = guildSel.value || null;
      const channelId = channelSel.value || null;
      if (!guildId) {
        showMsg("请先在「服务器」里选择一个服务器。", "error");
        return;
      }
      if (scopeType === "channel" && !channelId) {
        showMsg("「仅所选频道」需要先在「频道」里选一个频道。", "error");
        return;
      }

      startBtn.disabled = true;
      cancelBtn.disabled = false;
      progressEl.classList.remove("dme-hidden");
      barFill.style.width = "0%";
      progressText.textContent = "开始中…";
      showMsg("正在抓取，请保持此 Discord 标签页打开。", "info");

      const resp = await startExport({ mode, query, formats, scopeType, textOnly, guildId, channelId });
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
      onTokenReady = null;
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
#dme-panel{position:fixed;top:70px;right:20px;width:420px;max-width:calc(100vw - 24px);z-index:2147483647;
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
.dme-body{padding:12px 14px 14px;max-height:calc(100vh - 150px);overflow-y:auto;}
.dme-status{font-size:11px;padding:3px 8px;border-radius:10px;background:#1e1f22;color:#949ba4;
  display:inline-block;margin-bottom:10px;}
.dme-status.dme-ok{color:#23a55a;} .dme-status.dme-warn{color:#f0b232;} .dme-status.dme-err{color:#f23f43;}
.dme-label{display:block;font-size:12px;font-weight:600;margin:8px 0 4px;color:#b5bac1;}
.dme-label-row{display:flex;align-items:center;justify-content:space-between;}
.dme-link{background:none;border:none;padding:0;color:#00a8fc;font-size:11px;font-weight:500;cursor:pointer;}
.dme-link:hover{text-decoration:underline;}
.dme-field{margin-top:2px;}
.dme-input{width:100%;padding:7px;border-radius:4px;border:1px solid #1e1f22;background:#1e1f22;
  color:#dbdee1;font-size:13px;}
.dme-input:focus{outline:none;border-color:#5865f2;}
select.dme-input{cursor:pointer;}
select.dme-input option, select.dme-input optgroup{background:#1e1f22;color:#dbdee1;}
.dme-hint{font-size:11px;color:#80848e;margin-top:3px;}
.dme-radios{display:flex;gap:12px;}
.dme-radios label{display:flex;align-items:center;gap:4px;cursor:pointer;}
.dme-radios input{accent-color:#5865f2;}
.dme-check{display:flex;align-items:center;gap:6px;margin-top:10px;font-size:12px;font-weight:400;color:#b5bac1;cursor:pointer;}
.dme-check input{accent-color:#5865f2;}
.dme-formats{display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:2px;}
.dme-formats .dme-check{margin-top:2px;}
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
