// 运行在页面主世界(MAIN)，用于从 Discord 自身发出的请求里捕获 Authorization token。
// 捕获到后通过 window.postMessage 传给隔离世界的 content.js。
(function () {
  "use strict";

  let captured = null;

  function report(token) {
    if (!token || token === captured) return;
    captured = token;
    window.postMessage({ source: "DME_TOKEN", token: token }, "*");
  }

  // 从任意 API 响应体里递归提取 user 对象（含 id + username），缓存供按用户名解析使用
  function harvestUsers(obj, sink, depth) {
    if (!obj || depth > 6) return;
    if (Array.isArray(obj)) {
      for (const item of obj) harvestUsers(item, sink, depth + 1);
      return;
    }
    if (typeof obj !== "object") return;

    // 像 user 的对象：有纯数字 id 和 username
    if (typeof obj.id === "string" && /^\d{5,25}$/.test(obj.id) && typeof obj.username === "string") {
      sink.push({
        id: obj.id,
        username: obj.username,
        globalName: obj.global_name || null,
      });
    }
    for (const k in obj) {
      const v = obj[k];
      if (v && typeof v === "object") harvestUsers(v, sink, depth + 1);
    }
  }

  function scanResponse(resp) {
    try {
      const url = resp.url || "";
      if (url.indexOf("/api/") === -1) return;
      // 顺便从消息搜索 URL 里提取 author_id（Discord 原生搜索栏的产物）
      try {
        const u = new URL(url, location.origin);
        if (u.pathname.indexOf("/messages/search") !== -1) {
          const aid = u.searchParams.get("author_id");
          window.postMessage({
            source: "DME_LAST_AUTHOR",
            authorId: aid || null,
            guildId: (u.pathname.match(/guilds\/(\d+)\//) || [])[1] || null,
            searchUrl: u.href,
          }, "*");
        }
      } catch (e) { /* ignore */ }

      const ct = resp.headers && resp.headers.get && resp.headers.get("content-type");
      if (!ct || ct.indexOf("application/json") === -1) return;
      resp.clone().json().then((data) => {
        const sink = [];
        harvestUsers(data, sink, 0);
        if (sink.length) window.postMessage({ source: "DME_USERS", users: sink }, "*");
      }).catch(() => {});
    } catch (e) { /* ignore */ }
  }

  function pickAuth(headers) {
    if (!headers) return null;
    try {
      // Headers 实例
      if (typeof headers.get === "function") {
        return headers.get("Authorization") || headers.get("authorization");
      }
      // 普通对象
      for (const k in headers) {
        if (k.toLowerCase() === "authorization") return headers[k];
      }
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  // --- hook fetch ---
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      try {
        let auth = pickAuth(init && init.headers);
        if (!auth && input && typeof input === "object" && input.headers) {
          auth = pickAuth(input.headers);
        }
        if (auth) report(auth);
      } catch (e) {
        /* ignore */
      }
      const p = origFetch.apply(this, arguments);
      try {
        p.then((resp) => { if (resp) scanResponse(resp); }).catch(() => {});
      } catch (e) { /* ignore */ }
      return p;
    };
  }

  // --- hook XMLHttpRequest ---
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__dme_url = url; } catch (e) { /* ignore */ }
    return origOpen.apply(this, arguments);
  };

  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      if (name && name.toLowerCase() === "authorization") report(value);
    } catch (e) {
      /* ignore */
    }
    return origSetHeader.apply(this, arguments);
  };

  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    try {
      const url = this.__dme_url || "";
      if (url && url.indexOf("/messages/search") !== -1) {
        const u = new URL(url, location.origin);
        const aid = u.searchParams.get("author_id");
        window.postMessage({
          source: "DME_LAST_AUTHOR",
          authorId: aid || null,
          guildId: (u.pathname.match(/guilds\/(\d+)\//) || [])[1] || null,
          searchUrl: u.href,
        }, "*");
      }
      this.addEventListener("load", function () {
        try {
          const ct = this.getResponseHeader && this.getResponseHeader("content-type");
          if (ct && ct.indexOf("application/json") !== -1 && (this.__dme_url || "").indexOf("/api/") !== -1) {
            const data = JSON.parse(this.responseText);
            const sink = [];
            harvestUsers(data, sink, 0);
            if (sink.length) window.postMessage({ source: "DME_USERS", users: sink }, "*");
          }
        } catch (e) { /* ignore */ }
      });
    } catch (e) { /* ignore */ }
    return origSend.apply(this, arguments);
  };

  // 当 content.js 准备好后主动索要一次（处理脚本加载顺序问题）
  window.addEventListener("message", function (ev) {
    if (ev.source === window && ev.data && ev.data.source === "DME_REQUEST_TOKEN") {
      if (captured) report(captured);
    }
  });
})();
