const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const source = readFileSync(join(__dirname, "../src/content.js"), "utf8");
const AUTHOR = "123456789";
const startDate = "2026-11-01";
const midnight = new Date(`${startDate}T00:00:00`).getTime();
const guildScope = { type: "guild", guildId: "987654321", startDate };
const channelScope = { ...guildScope, type: "channel", channelId: "555555555" };

function message(timestamp, authorId = AUTHOR, sequence = 0) {
  return {
    id: (((BigInt(timestamp) - 1420070400000n) << 22n) + BigInt(sequence)).toString(),
    author: { id: authorId, username: "test-user" },
    timestamp: new Date(timestamp).toISOString(),
    content: "测试消息",
    hit: true,
  };
}

function hits(messages) {
  return { total_results: messages.length, messages: messages.map((m) => [m]) };
}

// 在独立 VM 中运行真实扩展脚本，只替换浏览器存储和网络，不访问 Discord。
function harness(responses = [], checkpoints = new Map()) {
  const requests = [];
  const progress = [];
  let onProgress = () => {};
  let finish;
  const terminal = new Promise((resolve) => { finish = resolve; });
  const context = vm.createContext({
    URL, URLSearchParams, TextEncoder, Date,
    btoa: (text) => Buffer.from(text, "binary").toString("base64"),
    setTimeout: (fn) => { queueMicrotask(fn); return 0; },
    window: { addEventListener() {}, postMessage() {} },
    location: { pathname: "/channels/987654321/555555555" },
    chrome: {
      storage: { local: { get: async () => ({}), set: async () => {} } },
      runtime: { onMessage: { addListener() {} } },
    },
    fetch: async (url) => {
      requests.push(new URL(url));
      assert.ok(responses.length, "Unexpected extra API request");
      const response = responses.shift();
      const status = response.status || 200;
      return { status, ok: status === 200, json: async () => response };
    },
    save: async (key, value) => { checkpoints.set(key, structuredClone(value)); },
    load: async (key) => checkpoints.get(key),
    report: (payload) => {
      progress.push(payload);
      onProgress(payload);
      if (["done", "cancelled", "error"].includes(payload.stage)) finish(payload);
    },
  });
  const closing = source.lastIndexOf("})();");
  assert.ok(closing > 0);
  vm.runInContext(source.slice(0, closing) + `
    TOKEN = "test-token";
    idbPut = globalThis.save;
    idbGet = globalThis.load;
    onProgress = globalThis.report;
    globalThis.api = {
      dateToMinId, jobKey, fetchAllMessages, fetchChannelHistoryByAuthor,
      startExport, exportPartial,
      cancel() { cancelRequested = true; }
    };
  ` + source.slice(closing), context);
  return {
    api: context.api, requests, progress, checkpoints, terminal,
    onProgress(fn) { onProgress = fn; },
  };
}

function ids(messages) {
  return Array.from(messages, (m) => m.id);
}

function decodeFile(file) {
  return JSON.parse(Buffer.from(file.dataUrl.split(",")[1], "base64").toString("utf8"));
}

async function runExport(h, overrides = {}) {
  const response = await h.api.startExport({
    mode: "id", query: AUTHOR, scopeType: "guild", guildId: guildScope.guildId,
    formats: ["json"], incremental: true, startDate, ...overrides,
  });
  assert.equal(response.ok, true);
  const result = await h.terminal;
  assert.equal(result.stage, "done", result.error);
  return decodeFile(result.files[0]);
}

test("optional date uses local midnight and includes the exact boundary", () => {
  const { api } = harness();
  assert.equal(api.dateToMinId(null), null);
  assert.equal(api.dateToMinId(""), null);
  assert.equal(api.dateToMinId(startDate), (BigInt(message(midnight).id) - 1n).toString());
  assert.equal(api.dateToMinId("2010-01-01"), "0");
  assert.equal(api.dateToMinId("2024-02-29"),
    (BigInt(message(new Date("2024-02-29T00:00:00").getTime()).id) - 1n).toString());
  for (const invalid of ["2026-02-29", "2026-11-31", "2026-13-01", "2026-1-1", "invalid"]) {
    assert.throws(() => api.dateToMinId(invalid), /有效的起始日期/);
  }
});

test("date checkpoints are isolated and the no-date legacy key stays unchanged", () => {
  const { api } = harness();
  const legacy = api.jobKey(AUTHOR, { ...guildScope, startDate: null });
  assert.equal(legacy, `${AUTHOR}|guild|${guildScope.guildId}|`);
  assert.notEqual(api.jobKey(AUTHOR, guildScope), legacy);
  assert.notEqual(api.jobKey(AUTHOR, guildScope),
    api.jobKey(AUTHOR, { ...guildScope, startDate: "2026-10-01" }));
  assert.notEqual(api.jobKey(AUTHOR, guildScope), api.jobKey(AUTHOR, channelScope));
});

test("search applies min_id, excludes older messages and stops at the date", async () => {
  const atStart = message(midnight);
  const newer = message(midnight + 1000);
  const old = message(midnight - 1);
  const h = harness([hits([newer, atStart, old])]);
  const result = await h.api.fetchAllMessages(AUTHOR, guildScope, null, null);
  assert.deepEqual(ids(result), [atStart.id, newer.id]);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].searchParams.get("min_id"), h.api.dateToMinId(startDate));
  assert.equal(h.requests[0].searchParams.get("sort_order"), "desc");
  const cp = h.checkpoints.get(h.api.jobKey(AUTHOR, guildScope));
  assert.equal(cp.done, true);
  assert.equal(cp.scope.startDate, startDate);
  assert.deepEqual(ids(cp.messages).sort(), [atStart.id, newer.id].sort());
});

test("all search pages keep the date bound and advance max_id", async () => {
  const newer = message(midnight + 1000);
  const atStart = message(midnight);
  const h = harness([hits([newer]), hits([atStart])]);
  assert.deepEqual(ids(await h.api.fetchAllMessages(AUTHOR, guildScope, null, null)),
    [atStart.id, newer.id]);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].searchParams.get("max_id"), (BigInt(newer.id) - 1n).toString());
  assert.ok(h.requests.every((u) => u.searchParams.get("min_id") === h.api.dateToMinId(startDate)));
});

test("native search URL keeps other filters but overrides date, paging and sorting", async () => {
  const template = `https://discord.com/api/v9/guilds/${guildScope.guildId}/messages/search` +
    `?author_id=${AUTHOR}&channel_id=${channelScope.channelId}&min_id=1&max_id=2` +
    "&offset=100&sort_by=relevance&sort_order=asc&has=link";
  const h = harness([hits([])]);
  await h.api.fetchAllMessages(AUTHOR, channelScope, template, null);
  const params = h.requests[0].searchParams;
  assert.equal(params.get("min_id"), h.api.dateToMinId(startDate));
  assert.equal(params.get("max_id"), null);
  assert.equal(params.get("offset"), "0");
  assert.equal(params.get("sort_by"), "timestamp");
  assert.equal(params.get("sort_order"), "desc");
  assert.equal(params.get("channel_id"), channelScope.channelId);
  assert.equal(params.get("has"), "link");
});

test("completed search resumes incrementally and only merges records inside the date range", async () => {
  const old = message(midnight - 1000);
  const seed = message(midnight + 1000);
  const newer = message(midnight + 2000);
  const h = harness([hits([newer, seed, old])]);
  const result = await h.api.fetchAllMessages(AUTHOR, guildScope, null, {
    done: true, newestId: seed.id, messages: [old, seed],
  });
  assert.deepEqual(ids(result), [seed.id, newer.id]);
  assert.equal(h.requests[0].searchParams.get("min_id"), seed.id);
  assert.equal(h.progress.find((p) => p.stage === "incremental").seed, 1);
});

test("unfinished search restores its cursor and date bound", async () => {
  const seed = message(midnight + 2000);
  const remaining = message(midnight);
  const cursor = message(midnight + 1000).id;
  const h = harness([hits([remaining])]);
  const result = await h.api.fetchAllMessages(AUTHOR, guildScope, null, {
    done: false, maxId: cursor, messages: [seed],
  });
  assert.deepEqual(ids(result), [remaining.id, seed.id]);
  assert.equal(h.requests[0].searchParams.get("max_id"), cursor);
  assert.equal(h.requests[0].searchParams.get("min_id"), h.api.dateToMinId(startDate));
});

test("unfinished incremental search keeps its newer min_id", async () => {
  const seed = message(midnight + 1000);
  const addedBeforePause = message(midnight + 4000);
  const remaining = message(midnight + 2000);
  const cursor = message(midnight + 3000).id;
  const h = harness([hits([remaining]), hits([])]);
  const result = await h.api.fetchAllMessages(AUTHOR, guildScope, null, {
    done: false, incremental: true, minId: seed.id, maxId: cursor,
    messages: [seed, addedBeforePause],
  });
  assert.deepEqual(ids(result), [seed.id, remaining.id, addedBeforePause.id]);
  assert.equal(h.requests[0].searchParams.get("min_id"), seed.id);
  assert.equal(h.requests[0].searchParams.get("max_id"), cursor);
  assert.equal(h.checkpoints.get(h.api.jobKey(AUTHOR, guildScope)).incremental, true);
});

test("channel-history fallback includes midnight and stops scanning when a full page crosses it", async () => {
  const batch = Array.from({ length: 100 }, (_, i) =>
    message(midnight + (49 - i) * 1000, i === 0 ? "another-user" : AUTHOR));
  const h = harness([batch]);
  const result = await h.api.fetchChannelHistoryByAuthor(AUTHOR, channelScope, null);
  assert.deepEqual(ids(result), ids(batch.slice(1, 50)).reverse());
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].searchParams.get("limit"), "100");
  const cp = h.checkpoints.get(h.api.jobKey(AUTHOR, channelScope));
  assert.equal(cp.done, true);
  assert.equal(cp.scope.startDate, startDate);
});

test("channel-history incremental export respects the date and saves its after cursor", async () => {
  const seed = message(midnight + 1000);
  const newer = message(midnight + 2000);
  const h = harness([[newer]]);
  const result = await h.api.fetchChannelHistoryByAuthor(AUTHOR, channelScope, {
    done: true, newestId: seed.id, messages: [message(midnight - 1), seed],
  });
  assert.deepEqual(ids(result), [seed.id, newer.id]);
  assert.equal(h.requests[0].searchParams.get("after"), seed.id);
  assert.equal(h.checkpoints.get(h.api.jobKey(AUTHOR, channelScope)).minId, newer.id);
});

test("unfinished channel-history incremental export restores its after cursor", async () => {
  const seed = message(midnight + 1000);
  const added = message(midnight + 2000);
  const newer = message(midnight + 3000);
  const h = harness([[newer]]);
  const result = await h.api.fetchChannelHistoryByAuthor(AUTHOR, channelScope, {
    done: false, incremental: true, minId: added.id, newestId: added.id,
    messages: [seed, added],
  });
  assert.deepEqual(ids(result), [seed.id, added.id, newer.id]);
  assert.equal(h.requests[0].searchParams.get("after"), added.id);
  assert.equal(h.requests[0].searchParams.get("before"), null);
});

test("dated exports never load a full-history checkpoint and retain same-date incremental merging", async () => {
  const seed = message(midnight);
  const newer = message(midnight + 1000);
  const checkpoints = new Map();
  const first = harness([hits([seed])], checkpoints);
  const legacyKey = first.api.jobKey(AUTHOR, { ...guildScope, startDate: null });
  const legacy = { done: true, newestId: message(midnight + 5000).id, messages: [message(midnight - 1)] };
  checkpoints.set(legacyKey, legacy);
  const file = await runExport(first);
  assert.deepEqual(ids(file.messages), [seed.id]);
  assert.equal(file.meta.startDate, startDate);
  assert.equal(file.meta.incremental, false);
  assert.equal(checkpoints.get(legacyKey), legacy);

  const second = harness([hits([newer]), hits([])], checkpoints);
  const merged = await runExport(second);
  assert.deepEqual(ids(merged.messages), [seed.id, newer.id]);
  assert.equal(merged.meta.incremental, true);
  assert.equal(merged.meta.newCount, 1);
  assert.equal(second.requests[0].searchParams.get("min_id"), seed.id);
});

test("startExport falls back from search to channel history without losing the date", async () => {
  const atStart = message(midnight);
  const h = harness([{ status: 403, message: "Forbidden" }, [atStart, message(midnight - 1)]]);
  const file = await runExport(h, { scopeType: "channel", channelId: channelScope.channelId });
  assert.deepEqual(ids(file.messages), [atStart.id]);
  assert.equal(file.meta.startDate, startDate);
  assert.equal(h.requests.length, 2);
  assert.ok(h.progress.some((p) => p.stage === "fallback"));
});

test("cancelled exports keep date-filtered partial output and can resume", async () => {
  const seed = message(midnight + 1000);
  const h = harness([hits([seed])]);
  h.onProgress((p) => { if (p.stage === "fetching") h.api.cancel(); });
  const response = await h.api.startExport({
    mode: "id", query: AUTHOR, scopeType: "guild", startDate, formats: ["json"],
  });
  assert.equal(response.ok, true);
  assert.equal((await h.terminal).stage, "cancelled");
  const partial = h.api.exportPartial({ formats: ["json"] });
  assert.equal(partial.ok, true);
  const file = decodeFile(partial.files[0]);
  assert.deepEqual(ids(file.messages), [seed.id]);
  assert.equal(file.meta.startDate, startDate);
  assert.equal(file.meta.partial, true);
  const cp = h.checkpoints.get(h.api.jobKey(AUTHOR, guildScope));
  assert.equal(cp.done, false);
  assert.equal(cp.minId, h.api.dateToMinId(startDate));

  const resumed = harness([hits([message(midnight)])], h.checkpoints);
  const complete = await runExport(resumed);
  assert.deepEqual(ids(complete.messages), [message(midnight).id, seed.id]);
});

test("empty date leaves full-history export behavior unchanged", async () => {
  const old = message(midnight - 1000);
  const h = harness([hits([old]), hits([])]);
  const file = await runExport(h, { startDate: null });
  assert.deepEqual(ids(file.messages), [old.id]);
  assert.equal(file.meta.startDate, null);
  assert.ok(h.requests.every((u) => !u.searchParams.has("min_id")));
});

test("invalid dates are rejected before starting any request", async () => {
  const h = harness();
  const response = await h.api.startExport({
    mode: "id", query: AUTHOR, scopeType: "guild", startDate: "2026-02-30",
  });
  assert.equal(response.ok, false);
  assert.match(response.error, /有效的起始日期/);
  assert.equal(h.requests.length, 0);
});
