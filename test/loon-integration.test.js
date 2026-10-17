const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const Core = require("../src/yt-ai-core.js");

const projectRoot = path.resolve(__dirname, "..");

async function sourceBundle() {
  const [core, loon] = await Promise.all([
    readFile(path.join(projectRoot, "src/yt-ai-core.js"), "utf8"),
    readFile(path.join(projectRoot, "src/yt-ai-loon.js"), "utf8")
  ]);
  return `${core}\n${loon}`;
}

async function runLoon(overrides) {
  const bundle = await sourceBundle();
  let doneValue;
  let doneResolve;
  const donePromise = new Promise((resolve) => {
    doneResolve = resolve;
  });
  const store = overrides.store || new Map();
  const sandbox = {
    URL,
    Date: overrides.Date || Date,
    Promise,
    Map,
    JSON,
    console: overrides.console || { log() {} },
    setTimeout,
    clearTimeout,
    $argument: overrides.argument || {},
    $request: overrides.request,
    $response: overrides.response,
    $httpClient: overrides.httpClient,
    $notification: overrides.notification || { post() {} },
    $persistentStore: {
      read(key) {
        return store.get(key) || null;
      },
      write(value, key) {
        if (overrides.writeFails) return false;
        store.set(key, value);
        return true;
      }
    },
    $done(value) {
      doneValue = value;
      doneResolve(value);
    }
  };
  if (overrides.response === undefined) delete sandbox.$response;
  vm.runInNewContext(bundle, sandbox, { filename: "dualsubs-ai.bundle.js" });
  await Promise.race([
    donePromise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("$done timeout")), overrides.doneTimeoutMs || 2500)
    )
  ]);
  return { doneValue, store };
}

function config(provider = "Gemini") {
  return {
    ai_enabled: true,
    provider,
    api_key: "test-secret",
    model: provider === "Gemini" ? "gemini-test" : "openai-test",
    target_language: "zh-Hans",
    retries: "0",
    concurrency: "1",
    timeout_ms: "4000",
    max_wait_ms: "5000",
    thinking_level: "minimal",
    cache_entries: "3",
    LogLevel: "OFF",
    Position: "Reverse"
  };
}

function sourceJson3() {
  return JSON.stringify({
    events: [
      { tStartMs: 10, dDurationMs: 20, segs: [{ utf8: "Hello" }] },
      { tStartMs: 30, dDurationMs: 40, segs: [{ utf8: "World" }] }
    ]
  });
}

function sourceSrv3() {
  return (
    '<?xml version="1.0"?><timedtext format="3"><body>' +
    '<p t="10" d="20"><s>Hello</s></p><p t="30" d="40"><s>World</s></p>' +
    "</body></timedtext>"
  );
}

// 请求脚本改写后的地址：没有 tlang，带 dsai 标记和目标语言
function processedUrl(format = "json3", video = "abc") {
  return (
    `https://www.youtube.com/api/timedtext?v=${video}&lang=en` +
    `&fmt=${format}&dsai=1&dsai_target=zh-Hans`
  );
}

function successfulGemini(callback) {
  const payload = {
    translations: [
      { id: 0, text: "AI你好" },
      { id: 1, text: "AI世界" }
    ]
  };
  callback(
    null,
    { status: 200 },
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }]
    })
  );
}

function noGet() {
  assert.fail("0.4.1 不应再额外请求字幕");
}

test("request strips tlang because YouTube now answers it with 429", async () => {
  const withTarget = await runLoon({
    argument: config(),
    request: {
      url: "https://www.youtube.com/api/timedtext?v=abc&lang=en&tlang=zh-Hant&format=srv3",
      method: "GET",
      headers: {}
    }
  });
  const rewritten = new URL(withTarget.doneValue.url);
  assert.equal(rewritten.searchParams.has("tlang"), false);
  assert.equal(rewritten.searchParams.get("dsai"), "1");
  assert.equal(rewritten.searchParams.get("dsai_target"), "zh-Hant");
  assert.equal(rewritten.searchParams.get("format"), "srv3");

  const automatic = await runLoon({
    argument: config(),
    request: { url: "https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=json3", method: "GET", headers: {} }
  });
  const automaticUrl = new URL(automatic.doneValue.url);
  assert.equal(automaticUrl.searchParams.has("tlang"), false);
  assert.equal(automaticUrl.searchParams.get("dsai_target"), "zh-Hans");

  const unconfigured = await runLoon({
    argument: { ...config(), api_key: "" },
    request: { url: "https://www.youtube.com/api/timedtext?v=abc&lang=en&tlang=zh-Hans", method: "GET", headers: {} }
  });
  const plainUrl = new URL(unconfigured.doneValue.url);
  assert.equal(plainUrl.searchParams.has("tlang"), false, "没配置 AI 也要去掉 tlang");
  assert.equal(plainUrl.searchParams.has("dsai"), false);
});

test("Gemini translates the source JSON3 response directly into AI bilingual subtitles", async () => {
  let apiRequest;
  const result = await runLoon({
    argument: config(),
    request: { url: processedUrl(), method: "GET", headers: { Cookie: "session" } },
    response: {
      status: 200,
      headers: { "Content-Type": "application/json", "Content-Length": "123" },
      body: sourceJson3()
    },
    httpClient: {
      get: noGet,
      post(request, callback) {
        apiRequest = request;
        successfulGemini(callback);
      }
    }
  });
  assert.equal(apiRequest.headers["x-goog-api-key"], "test-secret");
  assert.equal(apiRequest.timeout, 10000, "model requests must receive at least a 10-second timeout");
  assert.equal(apiRequest.body.includes("test-secret"), false);
  assert.match(apiRequest.body, /zh-Hans/);
  const output = JSON.parse(result.doneValue.body);
  assert.equal(output.events[0].segs[0].utf8, "AI你好\nHello");
  assert.equal(output.events[1].segs[0].utf8, "AI世界\nWorld");
  assert.equal(result.doneValue.headers["Content-Length"], undefined);
  assert.equal(result.doneValue.headers["x-dualsubs-ai-result"], "ai");
});

test("Gemini success preserves srv3 and paragraph timing", async () => {
  const result = await runLoon({
    argument: config(),
    request: { url: processedUrl("srv3"), method: "GET", headers: {} },
    response: {
      status: 200,
      headers: { "content-type": "text/xml", "content-encoding": "gzip" },
      body: sourceSrv3()
    },
    httpClient: { get: noGet, post: (_request, callback) => successfulGemini(callback) }
  });
  assert.match(result.doneValue.body, /<p t="10" d="20"><s>AI你好&#10;Hello<\/s><\/p>/);
  assert.match(result.doneValue.body, /<p t="30" d="40"><s>AI世界&#10;World<\/s><\/p>/);
  assert.equal(result.doneValue.headers["content-type"], "application/xml; charset=utf-8");
  assert.equal(result.doneValue.headers["content-encoding"], "identity");
});

test("missing API configuration passes the source subtitles through", async () => {
  const body = sourceJson3();
  const result = await runLoon({
    argument: { ...config(), api_key: "" },
    request: { url: processedUrl(), method: "GET", headers: {} },
    response: { status: 200, headers: { "Content-Type": "application/json" }, body },
    httpClient: { get: noGet, post: () => assert.fail("不应调用 AI") }
  });
  assert.equal(result.doneValue.body, body);
  assert.equal(result.doneValue.headers["x-dualsubs-ai-result"], "source-only");
});

test("AI failure keeps the source subtitles, never an error", async () => {
  let notificationCount = 0;
  const body = sourceJson3();
  const result = await runLoon({
    argument: config(),
    request: { url: processedUrl(), method: "GET", headers: {} },
    response: { status: 200, headers: { "Content-Type": "application/json", ETag: "src" }, body },
    httpClient: {
      get: noGet,
      post(_request, callback) {
        callback(null, { status: 500 }, "{\"error\":\"bad\"}");
      }
    },
    notification: { post: () => (notificationCount += 1) }
  });
  assert.equal(result.doneValue.body, body);
  assert.equal(result.doneValue.headers.ETag, "src");
  assert.equal(result.doneValue.headers["x-dualsubs-ai-result"], "source-only");
  assert.match(decodeURIComponent(result.doneValue.headers["x-dualsubs-ai-error"]), /AI HTTP 500/);
  assert.equal(notificationCount, 1);
});

test("YouTube error pages pass through untouched without calling AI", async () => {
  const sorry = "<html><head><title>Sorry...</title></head><body>429</body></html>";
  const result = await runLoon({
    argument: config(),
    request: { url: processedUrl("srv3"), method: "GET", headers: {} },
    response: { status: 429, headers: { "Content-Type": "text/html" }, body: sorry },
    httpClient: { get: noGet, post: () => assert.fail("不应调用 AI") }
  });
  assert.equal(result.doneValue.body, sorry, "原样放行，不改写");
  assert.equal(result.doneValue.headers["x-dualsubs-ai-result"], "upstream-error");
});

test("responses without the dsai marker are left alone", async () => {
  const result = await runLoon({
    argument: config(),
    request: { url: "https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=json3", method: "GET", headers: {} },
    response: { status: 200, headers: { "Content-Type": "application/json" }, body: sourceJson3() },
    httpClient: { get: noGet, post: () => assert.fail("不应调用 AI") }
  });
  assert.equal(result.doneValue.headers["x-dualsubs-ai-result"], "skipped");
});

test("OpenAI-compatible adapter retries once without extra parameters", async () => {
  const bodies = [];
  const result = await runLoon({
    argument: { ...config("OpenAI-Compatible"), base_url: "https://example.com/v1" },
    request: { url: processedUrl(), method: "GET", headers: {} },
    response: { status: 200, headers: { "Content-Type": "application/json" }, body: sourceJson3() },
    httpClient: {
      get: noGet,
      post(request, callback) {
        bodies.push(JSON.parse(request.body));
        if (bodies.length === 1) {
          callback(null, { status: 400 }, "{\"error\":\"unsupported\"}");
          return;
        }
        callback(
          null,
          { status: 200 },
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    translations: [
                      { id: 0, text: "AI你好" },
                      { id: 1, text: "AI世界" }
                    ]
                  })
                }
              }
            ]
          })
        );
      }
    }
  });
  assert.equal(bodies.length, 2);
  // 紧凑行格式不再开 JSON 模式；第一次被拒后去掉 temperature 等附加参数重试
  assert.equal(bodies[0].response_format, undefined);
  assert.equal(bodies[0].temperature, 0);
  assert.equal(bodies[1].temperature, undefined);
  assert.equal(JSON.parse(result.doneValue.body).events[0].segs[0].utf8, "AI你好\nHello");
});

test("second identical response uses final cache without network calls", async () => {
  const store = new Map();
  let postCalls = 0;
  const shared = {
    argument: config(),
    request: { url: processedUrl("json3", "cache"), method: "GET", headers: {} },
    response: { status: 200, headers: { "Content-Type": "application/json" }, body: sourceJson3() },
    store,
    httpClient: {
      get: noGet,
      post(_request, callback) {
        postCalls += 1;
        successfulGemini(callback);
      }
    }
  };
  await runLoon(shared);
  const second = await runLoon(shared);
  assert.equal(postCalls, 1);
  assert.equal(JSON.parse(second.doneValue.body).events[1].segs[0].utf8, "AI世界\nWorld");
  assert.equal(second.doneValue.headers["x-dualsubs-ai-result"], "cache-ai");
});

function tenCueJson3(prefix) {
  return JSON.stringify({
    events: Array.from({ length: 10 }, (_, index) => ({
      tStartMs: index * 1000 + 10,
      dDurationMs: 900,
      segs: [{ utf8: `${prefix}${index}` }]
    }))
  });
}

function geminiRows(rows) {
  // 按紧凑行格式回复（主路径）
  return JSON.stringify({
    candidates: [{ content: { parts: [{ text: rows.map((row) => `${row.id}|${row.text}`).join("\n") }] } }]
  });
}

function promptLines(request) {
  return JSON.parse(request.body).contents[0].parts[0].text.split("\n");
}

function requestedIds(request) {
  return promptLines(request)
    .map((line) => line.match(/^(\d+)\|/))
    .filter(Boolean)
    .map((match) => Number(match[1]));
}

function partialRun({ store, onPost, notification }) {
  return runLoon({
    argument: {
      ...config(),
      parallel: "2",
      batch_size: "5",
      max_wait_ms: "3000",
      timeout_ms: "3000"
    },
    request: { url: processedUrl("json3", "longvid"), method: "GET", headers: {} },
    response: { status: 200, headers: { "Content-Type": "application/json" }, body: tenCueJson3("Line ") },
    httpClient: { get: noGet, post: onPost },
    notification,
    store,
    doneTimeoutMs: 4500
  });
}

test("deadline returns finished AI rows, leaves the rest as source text, then resumes", async () => {
  const store = new Map();
  let notifications = 0;
  const first = await partialRun({
    store,
    notification: { post: () => (notifications += 1) },
    onPost(request, callback) {
      const ids = requestedIds(request);
      // 第一批正常返回，第二批一直不返回（模拟慢请求）
      if (ids[0] === 0) callback(null, { status: 200 }, geminiRows(ids.map((id) => ({ id, text: `AI${id}` }))));
    }
  });
  const firstEvents = JSON.parse(first.doneValue.body).events.map((event) => event.segs[0].utf8);
  assert.deepEqual(
    firstEvents,
    Array.from({ length: 10 }, (_, i) => (i < 5 ? `AI${i}\nLine ${i}` : `Line ${i}`))
  );
  assert.equal(first.doneValue.headers["x-dualsubs-ai-result"], "ai-partial");
  assert.equal(notifications, 1);

  const requested = [];
  const second = await partialRun({
    store,
    onPost(request, callback) {
      const ids = requestedIds(request);
      requested.push(...ids);
      callback(null, { status: 200 }, geminiRows(ids.map((id) => ({ id, text: `AI${id}` }))));
    }
  });
  assert.deepEqual(requested, [5, 6, 7, 8, 9], "续翻时只请求剩下的行");
  const secondEvents = JSON.parse(second.doneValue.body).events.map((event) => event.segs[0].utf8);
  assert.deepEqual(secondEvents, Array.from({ length: 10 }, (_, i) => `AI${i}\nLine ${i}`));
  assert.equal(second.doneValue.headers["x-dualsubs-ai-result"], "ai");
});

test("a batch that drops one line keeps the other AI rows", async () => {
  const result = await partialRun({
    store: new Map(),
    onPost(request, callback) {
      const ids = requestedIds(request);
      callback(null, { status: 200 }, geminiRows(ids.filter((id) => id !== 3).map((id) => ({ id, text: `AI${id}` }))));
    }
  });
  const events = JSON.parse(result.doneValue.body).events.map((event) => event.segs[0].utf8);
  assert.deepEqual(events, Array.from({ length: 10 }, (_, i) => (i === 3 ? "Line 3" : `AI${i}\nLine ${i}`)));
  assert.equal(result.doneValue.headers["x-dualsubs-ai-result"], "ai-partial");
});

function thinkingRun(store, model, video, seen, rejects) {
  return runLoon({
    argument: { ...config(), model },
    request: { url: processedUrl("json3", video), method: "GET", headers: {} },
    response: { status: 200, headers: { "Content-Type": "application/json" }, body: sourceJson3() },
    store,
    httpClient: {
      get: noGet,
      post(request, callback) {
        const thinking = JSON.parse(request.body).generationConfig.thinkingConfig || null;
        seen.push(thinking);
        if (rejects(thinking)) {
          callback(null, { status: 400 }, JSON.stringify({ error: { message: "thinking_level is not supported for this model" } }));
          return;
        }
        successfulGemini(callback);
      }
    }
  });
}

test("Gemini 2.5 models fall back to thinkingBudget 0 and remember it", async () => {
  const store = new Map();
  const seen = [];
  const rejects = (thinking) => Boolean(thinking?.thinkingLevel);
  const first = await thinkingRun(store, "gemini-2.5-flash-lite", "t1", seen, rejects);
  assert.equal(first.doneValue.headers["x-dualsubs-ai-result"], "ai");
  assert.deepEqual(seen, [{ thinkingLevel: "minimal" }, { thinkingBudget: 0 }]);
  await thinkingRun(store, "gemini-2.5-flash-lite", "t2", seen, rejects);
  assert.deepEqual(seen.slice(2), [{ thinkingBudget: 0 }], "第二次直接用记住的设置");
});

test("Gemini 3.x models that reject minimal thinking move to low, not to default thinking", async () => {
  const seen = [];
  const result = await thinkingRun(new Map(), "gemini-3.8-flash", "t3", seen, (thinking) => thinking?.thinkingLevel === "minimal");
  assert.equal(result.doneValue.headers["x-dualsubs-ai-result"], "ai");
  assert.deepEqual(seen, [{ thinkingLevel: "minimal" }, { thinkingLevel: "low" }]);
});

test("each batch sends the two preceding source rows as context", async () => {
  const contexts = [];
  await runLoon({
    argument: { ...config(), parallel: "1", batch_size: "5" },
    request: { url: processedUrl("json3", "ctx"), method: "GET", headers: {} },
    response: { status: 200, headers: { "Content-Type": "application/json" }, body: tenCueJson3("Line ") },
    httpClient: {
      get: noGet,
      post(request, callback) {
        contexts.push(promptLines(request).filter((line) => line.startsWith("-|")).map((line) => line.slice(2)));
        const ids = requestedIds(request);
        callback(null, { status: 200 }, geminiRows(ids.map((id) => ({ id, text: `AI${id}` }))));
      }
    }
  });
  assert.deepEqual(contexts, [[], ["Line 3", "Line 4"]]);
});

test("Claude models translate through the Messages API with their own key", async () => {
  let apiRequest;
  const result = await runLoon({
    argument: { ...config(), model: "claude-haiku-4-5", api_key: "gemini-key", claude_api_key: "claude-key" },
    request: { url: processedUrl(), method: "GET", headers: {} },
    response: { status: 200, headers: { "Content-Type": "application/json" }, body: sourceJson3() },
    httpClient: {
      get: noGet,
      post(request, callback) {
        apiRequest = request;
        callback(
          null,
          { status: 200 },
          JSON.stringify({
            stop_reason: "end_turn",
            content: [
              { type: "text", text: JSON.stringify({ translations: [{ id: 0, text: "AI你好" }, { id: 1, text: "AI世界" }] }) }
            ]
          })
        );
      }
    }
  });
  assert.equal(apiRequest.url, "https://api.anthropic.com/v1/messages");
  assert.equal(apiRequest.headers["x-api-key"], "claude-key");
  assert.equal(apiRequest.body.includes("gemini-key"), false);
  assert.equal(JSON.parse(result.doneValue.body).events[1].segs[0].utf8, "AI世界\nWorld");
  assert.equal(result.doneValue.headers["x-dualsubs-ai-result"], "ai");
});

function manyCueJson3(count) {
  return JSON.stringify({
    events: Array.from({ length: count }, (_, index) => ({
      tStartMs: index * 1000,
      dDurationMs: 900,
      segs: [{ utf8: `Line ${index}` }]
    }))
  });
}

test("a model too slow for its batch size gets smaller batches next time", async () => {
  const store = new Map();
  const sizes = [];
  const slowRun = (video, respond) =>
    runLoon({
      argument: { ...config(), model: "gemini-3.8-flash", parallel: "2", max_wait_ms: "3000", timeout_ms: "3000" },
      request: { url: processedUrl("json3", video), method: "GET", headers: {} },
      response: { status: 200, headers: { "Content-Type": "application/json" }, body: manyCueJson3(120) },
      store,
      doneTimeoutMs: 4500,
      httpClient: {
        get: noGet,
        post(request, callback) {
          const ids = requestedIds(request);
          sizes.push(ids.length);
          if (respond) callback(null, { status: 200 }, geminiRows(ids.map((id) => ({ id, text: `AI${id}` }))));
          // respond = false：一直不返回，模拟这批在时限内翻不完
        }
      }
    });
  await slowRun("slow1", false);
  assert.equal(sizes[0], 30, "没有测速数据时，非 lite 模型先用 30 条");
  const speed = JSON.parse(store.get("@DualSubs-AI.ModelSpeed.v1"))["gemini-3.8-flash"];
  assert.ok(speed.msPerRow > 200, `超时批次应记成很慢，实际 ${speed.msPerRow}ms/行`);

  sizes.length = 0;
  const second = await slowRun("slow2", true);
  assert.ok(sizes[0] <= 30 && sizes[0] >= 10, `下次应缩小批次，实际 ${sizes[0]} 条`);
  assert.equal(second.doneValue.headers["x-dualsubs-ai-result"], "ai", "这次接口立即返回，小批次也能全部翻完");
});

test("a model without its provider key shows a hint instead of failing silently", async () => {
  const notes = [];
  const result = await runLoon({
    argument: { ...config(), model: "deepseek-flash", api_key: "gemini-key" },
    request: { url: "https://www.youtube.com/api/timedtext?v=abc&lang=en&tlang=zh-Hans&fmt=json3", method: "GET", headers: {} },
    notification: { post: (...parts) => notes.push(parts.join(" | ")) }
  });
  const url = new URL(result.doneValue.url);
  assert.equal(url.searchParams.has("tlang"), false);
  assert.equal(url.searchParams.has("dsai"), false);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /deepseek-flash/);
  assert.match(notes[0], /DeepSeek API Key/);
});

test("turning AI off leaves the subtitle request unmarked and shows no hint", async () => {
  const notes = [];
  const result = await runLoon({
    argument: { ...config(), ai_enabled: false },
    request: { url: "https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=json3", method: "GET", headers: {} },
    notification: { post: (...parts) => notes.push(parts.join(" | ")) }
  });
  assert.equal(JSON.stringify(result.doneValue), "{}");
  assert.equal(notes.length, 0);
});

test("sentence regrouping can be turned off and changes the cache identity", async () => {
  const body = JSON.stringify({
    events: [
      { tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: "It was late. We went" }] },
      { tStartMs: 4000, dDurationMs: 4000, segs: [{ utf8: "home together. Then it rained." }] }
    ]
  });
  const subtitles = [];
  const run = (sentenceSplit) =>
    runLoon({
      argument: { ...config(), sentence_split: sentenceSplit },
      request: { url: processedUrl("json3", "split"), method: "GET", headers: {} },
      response: { status: 200, headers: { "Content-Type": "application/json" }, body },
      store: new Map(),
      httpClient: {
        get: noGet,
        post(request, callback) {
          const rows = promptLines(request).map((line) => line.match(/^(\d+)\|(.*)$/)).filter(Boolean);
          subtitles.push(rows.map((match) => match[2]));
          callback(null, { status: 200 }, geminiRows(rows.map((match) => ({ id: Number(match[1]), text: `译${match[1]}` }))));
        }
      }
    });
  const on = await run(true);
  assert.deepEqual(subtitles[0], ["It was late.", "We went home together.", "Then it rained."]);
  assert.equal(JSON.parse(on.doneValue.body).events.length, 3);
  const off = await run(false);
  assert.deepEqual(subtitles[1], ["It was late. We went", "home together. Then it rained."]);
  assert.equal(JSON.parse(off.doneValue.body).events.length, 2);
  const key = (value) => Core.makeResponseCacheKey(processedUrl("json3", "split"), body, Core.normalizeConfig({ ...config(), sentence_split: value }));
  assert.notEqual(key(true), key(false));
});

test("a rate-limited batch is retried in the same run and the subtitles complete", async () => {
  const calls = new Map();
  const logs = [];
  const result = await partialRun({
    store: new Map(),
    onPost(request, callback) {
      const ids = requestedIds(request);
      const key = ids.join(",");
      calls.set(key, (calls.get(key) || 0) + 1);
      // 第二批第一次被限流，重发后正常
      if (ids[0] === 5 && calls.get(key) === 1) {
        callback(null, { status: 429 }, JSON.stringify({ error: { message: "rate limited" } }));
        return;
      }
      callback(null, { status: 200 }, geminiRows(ids.map((id) => ({ id, text: `AI${id}` }))));
    }
  });
  const events = JSON.parse(result.doneValue.body).events.map((event) => event.segs[0].utf8);
  assert.deepEqual(events, Array.from({ length: 10 }, (_, i) => `AI${i}\nLine ${i}`));
  assert.equal(result.doneValue.headers["x-dualsubs-ai-result"], "ai");
  assert.equal(calls.get("5,6,7,8,9"), 2);
});

test("rows the model dropped are re-requested on their own and filled in", async () => {
  const requests = [];
  const result = await partialRun({
    store: new Map(),
    onPost(request, callback) {
      const ids = requestedIds(request);
      requests.push(ids);
      // 第一次总是漏掉第 3 行，单独重发时正常返回
      const rows = ids.length > 1 ? ids.filter((id) => id !== 3) : ids;
      callback(null, { status: 200 }, geminiRows(rows.map((id) => ({ id, text: `AI${id}` }))));
    }
  });
  assert.ok(requests.some((ids) => ids.length === 1 && ids[0] === 3), "第 3 行应单独重发");
  const events = JSON.parse(result.doneValue.body).events.map((event) => event.segs[0].utf8);
  assert.deepEqual(events, Array.from({ length: 10 }, (_, i) => `AI${i}\nLine ${i}`));
  assert.equal(result.doneValue.headers["x-dualsubs-ai-result"], "ai");
});

test("a batch that keeps failing is retried only once", async () => {
  let calls = 0;
  const result = await partialRun({
    store: new Map(),
    onPost(_request, callback) {
      calls += 1;
      callback(null, { status: 500 }, "{}");
    }
  });
  assert.equal(calls, 4, "两批各发两次");
  assert.equal(result.doneValue.headers["x-dualsubs-ai-result"], "source-only");
});

test("subtitle requests drop conditional headers so YouTube always returns the full source", async () => {
  const result = await runLoon({
    argument: config(),
    request: {
      url: "https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=json3",
      method: "GET",
      headers: { "If-None-Match": "\"abc\"", "if-modified-since": "Thu, 01 Oct 2026 00:00:00 GMT", Cookie: "c" }
    }
  });
  assert.equal(new URL(result.doneValue.url).searchParams.get("dsai"), "1");
  assert.equal(JSON.stringify(result.doneValue.headers), JSON.stringify({ Cookie: "c" }));
});

test("partial results tell the app not to cache them; complete results drop the source validators", async () => {
  const headers = { "Content-Type": "application/json", ETag: "\"src\"", "Last-Modified": "x", "Cache-Control": "private, max-age=86400" };
  const partial = await partialRun({
    store: new Map(),
    onPost(request, callback) {
      const ids = requestedIds(request);
      if (ids[0] === 0) callback(null, { status: 200 }, geminiRows(ids.map((id) => ({ id, text: `AI${id}` }))));
    }
  });
  // partialRun 的响应头没有 ETag，单独构造一次带校验头的部分结果
  const partialWithValidators = await runLoon({
    argument: { ...config(), parallel: "2", batch_size: "5", max_wait_ms: "3000", timeout_ms: "3000" },
    request: { url: processedUrl("json3", "validators"), method: "GET", headers: {} },
    response: { status: 200, headers, body: tenCueJson3("Line ") },
    httpClient: {
      get: noGet,
      post(request, callback) {
        const ids = requestedIds(request);
        if (ids[0] === 0) callback(null, { status: 200 }, geminiRows(ids.map((id) => ({ id, text: `AI${id}` }))));
      }
    },
    doneTimeoutMs: 4500
  });
  for (const result of [partial, partialWithValidators]) {
    const h = result.doneValue.headers;
    assert.equal(h["x-dualsubs-ai-result"], "ai-partial");
    assert.match(h["cache-control"], /no-store/);
    assert.equal(h.ETag, undefined);
    assert.equal(h["Last-Modified"], undefined);
    assert.equal(h["Cache-Control"], undefined, "原来的缓存头要去掉，不能和 no-store 并存");
  }

  const complete = await runLoon({
    argument: config(),
    request: { url: processedUrl("json3", "complete"), method: "GET", headers: {} },
    response: { status: 200, headers, body: sourceJson3() },
    httpClient: { get: noGet, post: (_request, callback) => successfulGemini(callback) }
  });
  const h = complete.doneValue.headers;
  assert.equal(h["x-dualsubs-ai-result"], "ai");
  assert.equal(h.ETag, undefined);
  assert.equal(h["Last-Modified"], undefined);
  assert.equal(h["Cache-Control"], "private, max-age=86400", "全部翻完的结果允许缓存");
});

test("a failed row-cache write is logged instead of silently losing progress", async () => {
  const lines = [];
  const result = await runLoon({
    argument: { ...config(), LogLevel: "INFO" },
    request: { url: processedUrl("json3", "writefail"), method: "GET", headers: {} },
    response: { status: 200, headers: { "Content-Type": "application/json" }, body: sourceJson3() },
    httpClient: { get: noGet, post: (_request, callback) => successfulGemini(callback) },
    console: { log: (line) => lines.push(line) },
    writeFails: true
  });
  assert.equal(result.doneValue.headers["x-dualsubs-ai-result"], "ai");
  assert.ok(lines.some((line) => /Saved AI rows for this video: 0/.test(line)));
  assert.ok(lines.some((line) => /Row cache write failed/.test(line)), lines.join("\n"));
});

test("partial-translation notices are shown for each video, only deduplicated briefly", async () => {
  const store = new Map();
  const notes = [];
  const run = (video) =>
    runLoon({
      argument: { ...config(), parallel: "2", batch_size: "5", max_wait_ms: "3000", timeout_ms: "3000" },
      request: { url: processedUrl("json3", video), method: "GET", headers: {} },
      response: { status: 200, headers: { "Content-Type": "application/json" }, body: tenCueJson3(`${video} `) },
      store,
      notification: { post: (...parts) => notes.push(parts.join(" | ")) },
      doneTimeoutMs: 4500,
      httpClient: {
        get: noGet,
        post(request, callback) {
          const ids = requestedIds(request);
          if (ids[0] === 0) callback(null, { status: 200 }, geminiRows(ids.map((id) => ({ id, text: `AI${id}` }))));
        }
      }
    });
  await run("videoA");
  await run("videoB");
  assert.equal(notes.length, 2, "不同视频都要通知");
  await run("videoA");
  assert.equal(notes.length, 2, "同一视频 30 秒内重复请求不重复通知");
  // 模拟 30 秒后再次打开同一视频
  const history = JSON.parse(store.get("@DualSubs-AI.Notices.v2"));
  history["partial:videoA"] -= 31000;
  store.set("@DualSubs-AI.Notices.v2", JSON.stringify(history));
  await run("videoA");
  assert.equal(notes.length, 3);
});

test("a model that still answers in JSON is understood through the fallback", async () => {
  const result = await runLoon({
    argument: config(),
    request: { url: processedUrl("json3", "jsonreply"), method: "GET", headers: {} },
    response: { status: 200, headers: { "Content-Type": "application/json" }, body: sourceJson3() },
    httpClient: {
      get: noGet,
      post(_request, callback) {
        const payload = { translations: [{ id: 0, text: "AI你好" }, { id: 1, text: "AI世界" }] };
        callback(null, { status: 200 }, JSON.stringify({ candidates: [{ content: { parts: [{ text: "```json\n" + JSON.stringify(payload) + "\n```" }] } }] }));
      }
    }
  });
  assert.equal(JSON.parse(result.doneValue.body).events[1].segs[0].utf8, "AI世界\nWorld");
  assert.equal(result.doneValue.headers["x-dualsubs-ai-result"], "ai");
});

function pingUrl(video, endpoint = "watchtime") {
  return `https://s.youtube.com/api/stats/${endpoint}?ns=yt&docid=${video}&cpn=abc&st=12`;
}

function slowFirstOpen(store, notes, video, extraArgs) {
  return runLoon({
    argument: { ...config(), parallel: "2", batch_size: "5", max_wait_ms: "3000", timeout_ms: "3000", ...extraArgs },
    request: { url: processedUrl("json3", video), method: "GET", headers: {} },
    response: { status: 200, headers: { "Content-Type": "application/json" }, body: tenCueJson3("Line ") },
    store,
    notification: { post: (...parts) => notes.push(parts.join(" | ")) },
    doneTimeoutMs: 4500,
    httpClient: {
      get: noGet,
      post(request, callback) {
        const ids = requestedIds(request);
        // 第一次开字幕只来得及翻第一批
        if (ids[0] === 0) callback(null, { status: 200 }, geminiRows(ids.map((id) => ({ id, text: `AI${id}` }))));
      }
    }
  });
}

test("playback pings finish a long video in the background; reopening shows it all", async () => {
  const store = new Map();
  const notes = [];
  const first = await slowFirstOpen(store, notes, "bgvideo");
  assert.equal(first.doneValue.headers["x-dualsubs-ai-result"], "ai-partial");
  const jobs = JSON.parse(store.get("@DualSubs-AI.BackgroundJobs.v1"));
  assert.equal(jobs.bgvideo.remaining, 5);
  assert.equal(jobs.bgvideo.cues.length, 10);
  assert.match(notes[0], /后台接着翻/);

  const translated = [];
  const ping = await runLoon({
    argument: config(),
    request: { url: pingUrl("bgvideo"), method: "POST", headers: {} },
    store,
    notification: { post: (...parts) => notes.push(parts.join(" | ")) },
    httpClient: {
      get: noGet,
      post(request, callback) {
        const ids = requestedIds(request);
        translated.push(...ids);
        callback(null, { status: 200 }, geminiRows(ids.map((id) => ({ id, text: `AI${id}` }))));
      }
    }
  });
  assert.equal(JSON.stringify(ping.doneValue), "{}", "统计请求原样放行");
  assert.deepEqual(translated, [5, 6, 7, 8, 9], "后台只翻剩下的行");
  assert.equal(JSON.parse(store.get("@DualSubs-AI.BackgroundJobs.v1")).bgvideo, undefined, "翻完后任务删除");
  assert.match(notes[notes.length - 1], /后台翻译完成/);

  const reopened = await runLoon({
    argument: config(),
    request: { url: processedUrl("json3", "bgvideo"), method: "GET", headers: {} },
    response: { status: 200, headers: { "Content-Type": "application/json" }, body: tenCueJson3("Line ") },
    store,
    httpClient: { get: noGet, post: () => assert.fail("重新打开时不应再调用 AI") }
  });
  assert.equal(reopened.doneValue.headers["x-dualsubs-ai-result"], "ai");
  const events = JSON.parse(reopened.doneValue.body).events.map((event) => event.segs[0].utf8);
  assert.deepEqual(events, Array.from({ length: 10 }, (_, i) => `AI${i}\nLine ${i}`));
});

test("pings for videos without a background job pass straight through", async () => {
  const lines = [];
  const result = await runLoon({
    argument: { ...config(), LogLevel: "INFO" },
    request: { url: pingUrl("nojob", "qoe"), method: "POST", headers: {} },
    console: { log: (line) => lines.push(line) },
    httpClient: { get: noGet, post: () => assert.fail("没有任务时不应调用 AI") }
  });
  assert.equal(JSON.stringify(result.doneValue), "{}");
  assert.ok(lines.some((line) => /Playback ping qoe for nojob; background job: none/.test(line)), lines.join("\n"));
});

test("only one background translation runs at a time", async () => {
  const store = new Map();
  await slowFirstOpen(store, [], "locked");
  store.set("@DualSubs-AI.BackgroundLock.v1", JSON.stringify({ video: "other", until: Date.now() + 10000 }));
  const result = await runLoon({
    argument: config(),
    request: { url: pingUrl("locked"), method: "POST", headers: {} },
    store,
    httpClient: { get: noGet, post: () => assert.fail("已有后台任务在跑时不应再翻") }
  });
  assert.equal(JSON.stringify(result.doneValue), "{}");
  assert.equal(JSON.parse(store.get("@DualSubs-AI.BackgroundJobs.v1")).locked.remaining, 5);
});

test("turning background translation off saves no job", async () => {
  const store = new Map();
  const notes = [];
  await slowFirstOpen(store, notes, "nobg", { background_translate: false });
  assert.equal(store.get("@DualSubs-AI.BackgroundJobs.v1"), undefined);
  assert.match(notes[0], /重新打开这个视频时会接着翻译/);
});

test("background translation waits longer per request, so slow models still make progress", async () => {
  const store = new Map();
  await slowFirstOpen(store, [], "slowbg");
  const started = Date.now();
  const ping = await runLoon({
    argument: config(),
    request: { url: pingUrl("slowbg"), method: "POST", headers: {} },
    store,
    doneTimeoutMs: 15000,
    httpClient: {
      get: noGet,
      post(request, callback) {
        const ids = requestedIds(request);
        // 慢模型：一批要 6 秒，超过开字幕时 5.2 秒的单次上限
        setTimeout(() => callback(null, { status: 200 }, geminiRows(ids.map((id) => ({ id, text: `AI${id}` })))), 6000);
      }
    }
  });
  assert.equal(JSON.stringify(ping.doneValue), "{}");
  assert.ok(Date.now() - started >= 6000);
  assert.equal(JSON.parse(store.get("@DualSubs-AI.BackgroundJobs.v1")).slowbg, undefined, "后台应翻完并删除任务");
});

function storedRows(store) {
  const key = [...store.keys()].find((name) => name.startsWith("@DualSubs-AI.Rows.v2:"));
  return key ? JSON.parse(store.get(key) || "{}") : {};
}

test("a reopen running alongside background translation does not overwrite the background rows", async () => {
  const store = new Map();
  const notes = [];
  await slowFirstOpen(store, notes, "race");
  assert.deepEqual(Object.keys(storedRows(store)).sort(), ["0", "1", "2", "3", "4"]);

  // 重开视频（慢：1.5 秒后只翻出第 5 行）与后台续翻（快：立刻翻完 5～9）同时进行
  const reopen = runLoon({
    argument: { ...config(), parallel: "2", batch_size: "5", max_wait_ms: "3000", timeout_ms: "3000" },
    request: { url: processedUrl("json3", "race"), method: "GET", headers: {} },
    response: { status: 200, headers: { "Content-Type": "application/json" }, body: tenCueJson3("Line ") },
    store,
    doneTimeoutMs: 4500,
    httpClient: {
      get: noGet,
      post(request, callback) {
        const ids = requestedIds(request);
        setTimeout(() => callback(null, { status: 200 }, geminiRows([{ id: ids[0], text: `前台${ids[0]}` }])), 1500);
      }
    }
  });
  const ping = runLoon({
    argument: config(),
    request: { url: pingUrl("race"), method: "POST", headers: {} },
    store,
    notification: { post: (...parts) => notes.push(parts.join(" | ")) },
    httpClient: {
      get: noGet,
      post(request, callback) {
        const ids = requestedIds(request);
        callback(null, { status: 200 }, geminiRows(ids.map((id) => ({ id, text: `后台${id}` }))));
      }
    }
  });
  const [reopened] = await Promise.all([reopen, ping]);
  const rows = storedRows(store);
  assert.equal(Object.keys(rows).length, 10, "两边的结果都要保留");
  assert.match(rows["9"], /后台9/);
  // 前台合并了后台刚存的行，这次就能完整显示
  assert.equal(reopened.doneValue.headers["x-dualsubs-ai-result"], "ai");
});

test("background translation only reports completion after the rows are really saved", async () => {
  const store = new Map();
  const notes = [];
  await slowFirstOpen(store, notes, "unsaved");
  const lines = [];
  await runLoon({
    argument: { ...config(), LogLevel: "INFO" },
    request: { url: pingUrl("unsaved"), method: "POST", headers: {} },
    store,
    writeFails: true,
    console: { log: (line) => lines.push(line) },
    notification: { post: (...parts) => notes.push(parts.join(" | ")) },
    httpClient: {
      get: noGet,
      post(request, callback) {
        const ids = requestedIds(request);
        callback(null, { status: 200 }, geminiRows(ids.map((id) => ({ id, text: `AI${id}` }))));
      }
    }
  });
  assert.ok(!notes.some((note) => /后台翻译完成/.test(note)), "存不进去就不能说翻完了");
  assert.ok(lines.some((line) => /could not be saved/.test(line)), lines.join("\n"));
  assert.ok(lines.some((line) => /Background progress for unsaved: 5\/10 saved/.test(line)));
  assert.ok(JSON.parse(store.get("@DualSubs-AI.BackgroundJobs.v1")).unsaved, "任务保留，下次统计请求再试");
});

test("background translation waits 30 seconds after a subtitle load", async () => {
  const store = new Map();
  await slowFirstOpen(store, [], "cooldown");
  // 请求阶段（打开视频）会记下字幕加载时间
  await runLoon({
    argument: config(),
    request: { url: "https://www.youtube.com/api/timedtext?v=cooldown&lang=en&fmt=json3", method: "GET", headers: {} },
    store
  });
  const lines = [];
  await runLoon({
    argument: { ...config(), LogLevel: "INFO" },
    request: { url: pingUrl("cooldown"), method: "POST", headers: {} },
    store,
    console: { log: (line) => lines.push(line) },
    httpClient: { get: noGet, post: () => assert.fail("刚加载字幕时后台不应启动") }
  });
  assert.ok(lines.some((line) => /background translation waits/.test(line)), lines.join("\n"));
  assert.equal(JSON.parse(store.get("@DualSubs-AI.BackgroundJobs.v1")).cooldown.remaining, 5);
});

test("background translation uses at most 3 requests at a time and yields to a new subtitle load", async () => {
  const store = new Map();
  // 准备一个还剩 20 句的后台任务（每批最少 5 句，共 4 批）
  store.set(
    "@DualSubs-AI.BackgroundJobs.v1",
    JSON.stringify({
      polite: {
        key: "polite-key",
        languages: { source: "en", target: "zh-Hans" },
        cues: Array.from({ length: 20 }, (_, id) => ({ id, text: `Line ${id}` })),
        remaining: 20,
        createdAt: Date.now()
      }
    })
  );
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  await runLoon({
    argument: { ...config(), batch_size: "5" },
    request: { url: pingUrl("polite"), method: "POST", headers: {} },
    store,
    httpClient: {
      get: noGet,
      post(request, callback) {
        calls += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // 前 3 个请求并发发出后，用户切到了别的视频
        if (calls === 3) store.set("@DualSubs-AI.LastSubtitleLoad.v1", String(Date.now() + 50));
        const ids = requestedIds(request);
        setTimeout(() => {
          inFlight -= 1;
          callback(null, { status: 200 }, geminiRows(ids.map((id) => ({ id, text: `AI${id}` }))));
        }, 200);
      }
    }
  });
  assert.equal(maxInFlight, 3, "后台最多 3 个并发");
  assert.equal(calls, 3, "检测到新的字幕加载后不再发第 4 批");
  assert.equal(JSON.parse(store.get("@DualSubs-AI.BackgroundJobs.v1")).polite.remaining, 5);
});

test("switching to another video stops the previous video from sending new batches", async () => {
  const store = new Map();
  let calls = 0;
  const lines = [];
  const result = await runLoon({
    argument: { ...config(), parallel: "2", batch_size: "5", max_wait_ms: "3000", timeout_ms: "3000", LogLevel: "INFO" },
    request: { url: processedUrl("json3", "switched"), method: "GET", headers: {} },
    response: { status: 200, headers: { "Content-Type": "application/json" }, body: manyCueJson3(30) },
    store,
    console: { log: (line) => lines.push(line) },
    doneTimeoutMs: 4500,
    httpClient: {
      get: noGet,
      post(request, callback) {
        calls += 1;
        // 第 2 个请求发出时，用户切到了别的视频（新的字幕请求）
        if (calls === 2) store.set("@DualSubs-AI.LastSubtitleLoad.v1", String(Date.now() + 50));
        const ids = requestedIds(request);
        setTimeout(() => callback(null, { status: 200 }, geminiRows(ids.map((id) => ({ id, text: `AI${id}` })))), 200);
      }
    }
  });
  assert.equal(calls, 2, "切换后不再发新批次（6 批只发了 2 批）");
  assert.ok(lines.some((line) => /newer subtitle load/.test(line)));
  assert.equal(result.doneValue.headers["x-dualsubs-ai-result"], "ai-partial");
});

test("translated rows are kept for the 20 most recent videos", async () => {
  const store = new Map();
  for (let index = 0; index < 22; index += 1) {
    await runLoon({
      argument: config(),
      request: { url: processedUrl("json3", `video${index}`), method: "GET", headers: {} },
      response: {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 900, segs: [{ utf8: `Hello ${index}` }] }] })
      },
      store,
      httpClient: {
        get: noGet,
        post(request, callback) {
          const ids = requestedIds(request);
          callback(null, { status: 200 }, geminiRows(ids.map((id) => ({ id, text: `你好${index}` }))));
        }
      }
    });
  }
  const kept = [...store.entries()].filter(([key, value]) => key.startsWith("@DualSubs-AI.Rows.v2:") && value);
  assert.equal(kept.length, 20, "保留最近 20 个视频");
  assert.equal(JSON.parse(store.get("@DualSubs-AI.RowsIndex.v2")).length, 20);
});

test("a Chinese video gets Chinese on top and the English translation below", async () => {
  let prompt = "";
  const body = JSON.stringify({
    events: [
      { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: "今天我们去湖边" }] },
      { tStartMs: 2000, dDurationMs: 2000, segs: [{ utf8: "风景非常好" }] }
    ]
  });
  const request = await runLoon({
    argument: { ...config(), Position: "原文在上" },
    request: { url: "https://www.youtube.com/api/timedtext?v=zhvideo&lang=zh-Hans&fmt=json3", method: "GET", headers: {} }
  });
  const rewritten = request.doneValue.url;
  assert.equal(new URL(rewritten).searchParams.get("dsai_target"), "en");
  const result = await runLoon({
    argument: { ...config(), Position: "原文在上" },
    request: { url: rewritten, method: "GET", headers: {} },
    response: { status: 200, headers: { "Content-Type": "application/json" }, body },
    httpClient: {
      get: noGet,
      post(apiRequest, callback) {
        prompt = JSON.parse(apiRequest.body).contents[0].parts[0].text;
        callback(null, { status: 200 }, geminiRows([{ id: 0, text: "Today we went to the lake" }, { id: 1, text: "The view was great" }]));
      }
    }
  });
  assert.match(prompt, /^Source: zh-Hans\nTarget: en/);
  const events = JSON.parse(result.doneValue.body).events.map((event) => event.segs[0].utf8);
  assert.deepEqual(events, ["今天我们去湖边\nToday we went to the lake", "风景非常好\nThe view was great"]);
});

test("subtitles detected as the target language with no usable secondary language pass through", async () => {
  const body = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: "今天我们去湖边" }] }] });
  const result = await runLoon({
    argument: { ...config(), secondary_language: "繁體中文" },
    request: { url: "https://www.youtube.com/api/timedtext?v=nolang&fmt=json3&dsai=1&dsai_target=zh-Hans", method: "GET", headers: {} },
    response: { status: 200, headers: { "Content-Type": "application/json" }, body },
    httpClient: { get: noGet, post: () => assert.fail("已经是目标语言，不应调用 AI") }
  });
  assert.equal(result.doneValue.headers["x-dualsubs-ai-result"], "source-only");
});
