(function runDualSubsAITranslator() {
  "use strict";

  const Core = globalThis.YTAI;
  const CACHE_KEY = "@DualSubs-AI.Cache.v1";
  const NOTICE_KEY = "@DualSubs-AI.Notices.v2";
  const ROWS_PREFIX = "@DualSubs-AI.Rows.v2:";
  const ROWS_INDEX_KEY = "@DualSubs-AI.RowsIndex.v2";
  const CONFIG_OVERRIDE_KEY = "yt_ai_config";
  const QUICK_URL_KEY = "yt_ai_url";
  const QUICK_MODEL_KEY = "yt_ai_model";
  const QUICK_KEY_KEY = "yt_ai_key";
  const ROWS_VIDEO_LIMIT = 20;
  const MIN_LAUNCH_MS = 1200;
  const RENDER_RESERVE_MS = 250;
  const THINKING_KEY = "@DualSubs-AI.ThinkingLevel.v1";
  const SPEED_KEY = "@DualSubs-AI.ModelSpeed.v1";
  const TARGET_BATCH_MS = 2500;
  const MIN_BATCH_ROWS = 8;
  const MAX_BATCH_ROWS = 40;
  const CONTEXT_ROWS = 2;
  const MAX_BATCH_RETRIES = 1;
  const LOG_LEVELS = { OFF: 99, ERROR: 40, WARN: 30, INFO: 20, DEBUG: 10 };
  const MIN_MODEL_REQUEST_TIMEOUT_MS = 8000;
  const isQX = typeof $task !== "undefined" && typeof $httpClient === "undefined";

  function hasStore() {
    return (
      (typeof $persistentStore !== "undefined" && typeof $persistentStore.read === "function") ||
      (typeof $prefs !== "undefined" && typeof $prefs.valueForKey === "function") ||
      (typeof $pref !== "undefined" && typeof $pref.valueForKey === "function")
    );
  }

  function storeRead(key) {
    try {
      if (typeof $persistentStore !== "undefined" && typeof $persistentStore.read === "function") {
        return $persistentStore.read(key);
      }
      if (typeof $prefs !== "undefined" && typeof $prefs.valueForKey === "function") {
        return $prefs.valueForKey(key);
      }
      if (typeof $pref !== "undefined" && typeof $pref.valueForKey === "function") {
        return $pref.valueForKey(key);
      }
    } catch (_) {
    }
    return null;
  }

  function storeWrite(value, key) {
    try {
      const text = value === null || value === undefined ? "" : String(value);
      if (typeof $persistentStore !== "undefined" && typeof $persistentStore.write === "function") {
        return $persistentStore.write(text, key);
      }
      if (typeof $prefs !== "undefined" && typeof $prefs.setValueForKey === "function") {
        return $prefs.setValueForKey(text, key);
      }
      if (typeof $pref !== "undefined" && typeof $pref.setValueForKey === "function") {
        return $pref.setValueForKey(text, key);
      }
    } catch (_) {
    }
    return false;
  }

  function canNotify() {
    return (
      (typeof $notification !== "undefined" && typeof $notification.post === "function") ||
      typeof $notify === "function"
    );
  }

  function postNotification(title, subtitle, message) {
    if (typeof $notification !== "undefined" && typeof $notification.post === "function") {
      $notification.post(title, subtitle, message);
      return true;
    }
    if (typeof $notify === "function") {
      $notify(title, subtitle, message);
      return true;
    }
    return false;
  }

  function responseStatus(response, fallback) {
    const code = Number(response?.statusCode);
    if (Number.isFinite(code) && code > 0) return code;
    const numeric = Number(response?.status);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const match = String(response?.status || "").match(/\b(\d{3})\b/);
    if (match) return Number(match[1]);
    return fallback;
  }

  const mergedConfig = Core.mergeConfigSources(
    typeof $argument === "undefined" ? {} : $argument,
    storeRead(CONFIG_OVERRIDE_KEY),
    {
      base_url: storeRead(QUICK_URL_KEY),
      model: storeRead(QUICK_MODEL_KEY),
      api_key: storeRead(QUICK_KEY_KEY)
    }
  );
  const config = Core.normalizeConfig(mergedConfig.raw);
  const scriptStartedAt = Date.now();
  const isBackgroundPing =
    typeof $response === "undefined" &&
    /^https?:\/\/s\.youtube\.com\/api\/stats\//.test(String((typeof $request === "undefined" ? null : $request)?.url || ""));
  const BACKGROUND_BUDGET_MS = isQX ? 10000 : 40000;
  const BACKGROUND_REQUEST_TIMEOUT_MS = isQX ? 9500 : 25000;
  const BACKGROUND_CONCURRENCY = 3;
  const BACKGROUND_COOLDOWN_MS = 3000;
  const FOREGROUND_KEY = "@DualSubs-AI.LastSubtitleLoad.v1";
  let executionDeadline = isBackgroundPing ? Date.now() + BACKGROUND_BUDGET_MS : 0;
  const JOB_KEY = "@DualSubs-AI.BackgroundJobs.v1";
  const LOCK_KEY = "@DualSubs-AI.BackgroundLock.v1";
  const JOB_LIMIT = 2;
  const JOB_TTL_MS = 3 * 3600 * 1000;

  function log(level, message) {
    if ((LOG_LEVELS[level] || 20) < (LOG_LEVELS[config.logLevel] || 20)) return;
    console.log(`[DualSubs-AI][${level}] ${message}`);
  }

  if (mergedConfig.appliedKeys.length) {
    log("DEBUG", `Applied persistent config keys: ${mergedConfig.appliedKeys.join(", ")}`);
  }

  function safeError(error) {
    return String(error?.message || error || "unknown error")
      .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/([?&](?:key|api_key)=)[^&\s]+/gi, "$1[REDACTED]")
      .slice(0, 220);
  }

  function notifyFallback(message, subtitle, options) {
    if (!canNotify()) {
      return;
    }
    const key = options?.key || "general";
    const intervalMs = options?.intervalMs ?? 300000;
    const now = Date.now();
    let history = {};
    try {
      const parsed = JSON.parse(storeRead(NOTICE_KEY) || "{}");
      history = parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      history = {};
    }
    if (now - Number(history[key] || 0) < intervalMs) return;
    try {
      history[key] = now;
      const recent = Object.keys(history)
        .sort((a, b) => history[b] - history[a])
        .slice(0, 30);
      storeWrite(JSON.stringify(Object.fromEntries(recent.map((item) => [item, history[item]]))), NOTICE_KEY);
      postNotification(
        "YouTube AI 双语字幕",
        subtitle || "AI 翻译未完成，本次只显示原文字幕",
        message
      );
    } catch (_) {
    }
  }

  const CONDITIONAL_REQUEST_HEADERS = /^(if-none-match|if-modified-since)$/i;

  function videoIdOf(url) {
    const match = String(url || "").match(/[?&]v=([^&]+)/);
    return match ? match[1] : "";
  }

  function sanitizedHeaders(contentType, result, error, options) {
    const headers = Object.assign({}, $response?.headers || {});
    const rewritten = Boolean(options?.rewritten);
    const noStore = Boolean(options?.noStore);
    Object.keys(headers).forEach((key) => {
      if (/^(content-length|transfer-encoding|content-encoding)$/i.test(key)) {
        delete headers[key];
      }
      if (/^content-type$/i.test(key)) delete headers[key];
      if (rewritten && /^(etag|last-modified)$/i.test(key)) delete headers[key];
      if (noStore && /^(cache-control|expires|pragma|age)$/i.test(key)) delete headers[key];
    });
    if (noStore) {
      headers["cache-control"] = "no-store, no-cache, max-age=0, must-revalidate";
      headers.pragma = "no-cache";
      headers.expires = "0";
    }
    if (contentType) headers["content-type"] = contentType;
    headers["content-encoding"] = "identity";
    headers["x-dualsubs-ai-result"] = result;
    if (error) {
      headers["x-dualsubs-ai-error"] = encodeURIComponent(safeError(error)).slice(
        0,
        220
      );
    }
    return headers;
  }

  function doneRequest(url, headers) {
    if (url === $request.url && !headers) return $done({});
    if (isQX) {
      const value = {};
      if (url !== $request.url) value.path = Core.urlPath(url);
      if (headers) value.headers = headers;
      return $done(value);
    }
    const value = { url };
    if (headers) value.headers = headers;
    return $done(value);
  }

  function doneBody(body, contentType, result, error, options) {
    const headers = sanitizedHeaders(contentType, result, error, Object.assign({ rewritten: true }, options));
    if (isQX) {
      return $done({ headers, body });
    }
    return $done(
      Object.assign({}, $response, {
        headers,
        body
      })
    );
  }

  function donePassthrough(result, error) {
    if (isQX) {
      return $done({});
    }
    return $done(
      Object.assign({}, $response, {
        headers: sanitizedHeaders(
          $response?.headers?.["Content-Type"] ||
            $response?.headers?.["content-type"],
          result,
          error
        )
      })
    );
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function remainingTime() {
    return executionDeadline - Date.now();
  }

  function httpPost(request) {
    return new Promise((resolve, reject) => {
      const useLoonClient = typeof $httpClient !== "undefined" && typeof $httpClient.post === "function";
      const useQXFetch = !useLoonClient && typeof $task !== "undefined" && typeof $task.fetch === "function";
      if (!useLoonClient && !useQXFetch) {
        reject(new Error("HTTP client ($httpClient.post / $task.fetch) is unavailable"));
        return;
      }
      let settled = false;
      const timeoutMs = Math.max(
        MIN_MODEL_REQUEST_TIMEOUT_MS,
        Number(request.timeout) || MIN_MODEL_REQUEST_TIMEOUT_MS
      );
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`AI timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      function finish(error, response, body) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          const message = typeof error === "string"
            ? error
            : String(error?.error || error?.message || error);
          reject(new Error(message));
          return;
        }
        const status = responseStatus(response, 0);
        if (status < 200 || status >= 300) {
          const failure = new Error(`AI HTTP ${status || "unknown"}`);
          failure.status = status;
          failure.body = String(body || "").slice(0, 400);
          reject(failure);
          return;
        }
        resolve(String(body || ""));
      }
      if (useLoonClient) {
        $httpClient.post(request, finish);
      } else {
        $task
          .fetch({
            url: request.url,
            method: "POST",
            headers: request.headers,
            body: request.body
          })
          .then(
            (response) => finish(null, response, response?.body),
            (reason) => finish(reason || "QX fetch error")
          );
      }
    });
  }

  function requestConfigWithinDeadline() {
    const remaining = remainingTime();
    if (remaining <= 700) {
      throw new Error("AI translation exceeded the subtitle deadline");
    }
    const cap = isBackgroundPing
      ? BACKGROUND_REQUEST_TIMEOUT_MS
      : Math.max(config.timeoutMs, config.maxWaitMs);
    return Object.assign({}, config, {
      timeoutMs: Math.max(MIN_MODEL_REQUEST_TIMEOUT_MS, Math.min(cap, remaining - 350))
    });
  }

  function nextThinkingLevel(model, level) {
    if (level === "off") return "";
    if (/gemini-2\.5/i.test(model)) return level === "budget0" ? "off" : "budget0";
    return level === "minimal" ? "low" : "off";
  }

  async function translateGemini(batch, languages, level) {
    try {
      const raw = await httpPost(
        Core.createGeminiRequest(
          Object.assign({}, requestConfigWithinDeadline(), { thinkingLevel: level }),
          batch,
          languages,
          true
        )
      );
      return Core.salvageTranslations(Core.parseGeminiResponse(raw), batch);
    } catch (error) {
      const next = nextThinkingLevel(config.model, level);
      if (error?.status !== 400 || !next || !/thinking/i.test(error.body || "")) throw error;
      if (config.thinkingLevel === level) {
        log("INFO", `${config.model} rejected thinking "${level}"; retrying with "${next}"`);
        config.thinkingLevel = next;
        writeJsonStore(THINKING_KEY, Object.assign(readJsonStore(THINKING_KEY, {}), { [config.model]: next }));
      }
      return translateGemini(batch, languages, next);
    }
  }

  async function translateClaude(batch, languages) {
    try {
      const raw = await httpPost(Core.createClaudeRequest(requestConfigWithinDeadline(), batch, languages, false));
      return Core.salvageTranslations(Core.parseClaudeResponse(raw), batch);
    } catch (error) {
      if (error?.status !== 400) throw error;
      log("DEBUG", "Claude request rejected; retrying without effort");
      const raw = await httpPost(
        Core.createClaudeRequest(Object.assign({}, requestConfigWithinDeadline(), { claudeEffort: false }), batch, languages, false)
      );
      return Core.salvageTranslations(Core.parseClaudeResponse(raw), batch);
    }
  }

  async function translateOpenAIFormat(batch, languages) {
    try {
      const raw = await httpPost(Core.createOpenAIRequest(requestConfigWithinDeadline(), batch, languages, false));
      return Core.salvageTranslations(Core.parseOpenAIResponse(raw), batch);
    } catch (error) {
      if (![400, 404, 422].includes(error?.status)) throw error;
      log("DEBUG", "Request rejected; retrying without reasoning parameters");
      const raw = await httpPost(
        Core.createOpenAIRequest(Object.assign({}, requestConfigWithinDeadline(), { plainRequest: true }), batch, languages, false)
      );
      return Core.salvageTranslations(Core.parseOpenAIResponse(raw), batch);
    }
  }

  async function translateBatch(batch, languages) {
    let lastError;
    for (let attempt = 0; attempt <= config.retries; attempt += 1) {
      try {
        if (config.provider === "Gemini") return await translateGemini(batch, languages, config.thinkingLevel);
        if (config.provider === "Claude") return await translateClaude(batch, languages);
        return await translateOpenAIFormat(batch, languages);
      } catch (error) {
        lastError = error;
        if (attempt < config.retries) await delay(160 * 2 ** attempt);
      }
    }
    throw lastError || new Error("AI translation failed");
  }

  async function translateWithinDeadline(batches, languages, expectedBatchMs, options) {
    const rows = [];
    const failures = [];
    const samples = [];
    const inFlight = new Map();
    const queue = batches.map((batch, seq) => {
      batch.seq = seq;
      return batch;
    });
    const launchThreshold = Math.max(MIN_LAUNCH_MS, Math.min(5000, Math.round((expectedBatchMs || 0) * 0.5)));
    const workerCount = Math.min(options?.concurrency || config.concurrency, Math.max(1, batches.length));
    const orderedMode = options?.strictOrder !== false;
    const defaultMaxRetries = options?.maxRetries ?? MAX_BATCH_RETRIES;
    let launched = 0;
    let retried = 0;
    let finished = false;

    function pushSorted(item) {
      queue.push(item);
      queue.sort((a, b) => (a.seq - b.seq) || ((a[0]?.id ?? 0) - (b[0]?.id ?? 0)));
    }

    function requeue(cues, parent, waitMs, retryLimit) {
      const cap = retryLimit ?? defaultMaxRetries;
      if ((parent.attempt || 0) >= cap || !cues.length) return;
      const retry = cues.slice();
      retry.seq = parent.seq;
      retry.attempt = (parent.attempt || 0) + 1;
      retry.context = parent.context;
      retry.notBefore = Date.now() + (waitMs || 0);
      pushSorted(retry);
      retried += 1;
    }

    function splitAndRequeue(batch, waitMs, retryLimit) {
      const cap = retryLimit ?? defaultMaxRetries;
      if ((batch.attempt || 0) >= cap || batch.length < 10) {
        requeue(batch, batch, waitMs, cap);
        return;
      }
      const mid = Math.ceil(batch.length / 2);
      const left = batch.slice(0, mid);
      const right = batch.slice(mid);
      left.seq = batch.seq;
      left.attempt = (batch.attempt || 0) + 1;
      left.context = batch.context;
      left.notBefore = Date.now() + (waitMs || 0);
      right.seq = batch.seq;
      right.attempt = (batch.attempt || 0) + 1;
      right.context = batch.slice(Math.max(0, mid - CONTEXT_ROWS), mid).map((cue) => cue.text);
      right.notBefore = Date.now() + (waitMs || 0);
      pushSorted(left);
      pushSorted(right);
      retried += 2;
    }

    function nextReadyIndex() {
      const now = Date.now();
      if (!orderedMode) {
        return queue.findIndex((item) => !item.notBefore || item.notBefore <= now);
      }
      let headSeq = Infinity;
      inFlight.forEach((_startedAt, item) => {
        if (item.seq < headSeq) headSeq = item.seq;
      });
      queue.forEach((item) => {
        if (item.seq < headSeq) headSeq = item.seq;
      });
      const tailWindow = remainingTime() <= 2600 ? 1 : Math.max(workerCount * 2, 4);
      const maxSeq = headSeq + tailWindow;
      return queue.findIndex((item) => {
        if (item.notBefore && item.notBefore > now) return false;
        if ((item.attempt || 0) > 0 && item.seq <= headSeq + workerCount) return true;
        return item.seq <= maxSeq;
      });
    }

    function canLaunch(batch) {
      const rem = remainingTime();
      if (launched === 0) return rem >= MIN_LAUNCH_MS;
      if ((batch.attempt || 0) > 0 && batch.length <= 10) return rem >= 900;
      return rem >= launchThreshold;
    }

    async function runWorker() {
      while (!finished) {
        if (options?.shouldStop?.()) return;
        const index = nextReadyIndex();
        if (index < 0) {
          if (!queue.length && !inFlight.size) return;
          if (launched > 0 && remainingTime() < 900) return;
          await delay(60);
          continue;
        }
        const batch = queue[index];
        if (!canLaunch(batch)) return;
        queue.splice(index, 1);
        launched += 1;
        const startedAt = Date.now();
        inFlight.set(batch, startedAt);
        try {
          const translated = await translateBatch(batch, languages);
          if (finished) return;
          inFlight.delete(batch);
          samples.push({ rows: batch.length, ms: Date.now() - startedAt });
          rows.push(...translated);
          const got = new Set(translated.map((row) => String(row.id)));
          requeue(batch.filter((cue) => !got.has(String(cue.id))), batch, 0);
        } catch (error) {
          if (finished) return;
          inFlight.delete(batch);
          failures.push(error);
          const message = String(error?.message || "");
          if (/timeout|deadline/i.test(message)) {
            samples.push({
              rows: batch.length,
              ms: Math.max((Date.now() - startedAt) * 1.5, batch.length * 220)
            });
            if (remainingTime() >= 2500) {
              splitAndRequeue(batch, 120);
            }
          } else if (error?.status === 429) {
            splitAndRequeue(batch, 900, Math.max(defaultMaxRetries, 2));
          } else if (/parse|json|no usable rows|not an array|no text|empty|no message content/i.test(message)) {
            splitAndRequeue(batch, 0, Math.max(defaultMaxRetries, 2));
          } else {
            requeue(batch, batch, 0);
          }
        }
      }
    }
    const workers = Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    let timer;
    await Promise.race([
      workers,
      new Promise((resolve) => {
        timer = setTimeout(resolve, Math.max(0, remainingTime() - RENDER_RESERVE_MS));
      })
    ]);
    clearTimeout(timer);
    finished = true;
    inFlight.forEach((startedAt, batch) => {
      samples.push({
        rows: batch.length,
        ms: Math.max((Date.now() - startedAt) * 1.5, batch.length * 220)
      });
    });
    return { rows: rows.slice(), failures, launched, retried, samples };
  }

  function readJsonStore(key, fallback) {
    try {
      const value = storeRead(key);
      const parsed = value ? JSON.parse(value) : fallback;
      return parsed && typeof parsed === "object" ? parsed : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function writeJsonStore(key, value) {
    try {
      if (hasStore()) storeWrite(JSON.stringify(value), key);
    } catch (_) {
    }
  }

  function batchPlan() {
    if (!config.adaptiveBatch) return { size: config.maxBatchItems, expectedMs: 0 };
    const speed = readJsonStore(SPEED_KEY, {})[config.model];
    if (!(speed?.msPerRow > 0)) return { size: config.maxBatchItems, expectedMs: 0 };
    const size = Math.min(
      MAX_BATCH_ROWS,
      Math.max(MIN_BATCH_ROWS, Math.round(TARGET_BATCH_MS / speed.msPerRow))
    );
    return { size, expectedMs: Math.round(size * speed.msPerRow) };
  }

  function recordSpeed(samples) {
    if (!config.adaptiveBatch || !samples.length) return;
    const rows = samples.reduce((sum, item) => sum + item.rows, 0);
    const ms = samples.reduce((sum, item) => sum + item.ms, 0);
    if (!rows) return;
    const measured = ms / rows;
    const store = readJsonStore(SPEED_KEY, {});
    const previous = store[config.model]?.msPerRow;
    store[config.model] = {
      msPerRow: Math.round(previous > 0 ? previous * 0.5 + measured * 0.5 : measured),
      updatedAt: Date.now()
    };
    writeJsonStore(SPEED_KEY, store);
  }

  function attachContext(batches, cues) {
    const indexById = new Map(cues.map((cue, index) => [cue.id, index]));
    batches.forEach((batch) => {
      const first = indexById.get(batch[0]?.id) || 0;
      batch.context = cues.slice(Math.max(0, first - CONTEXT_ROWS), first).map((cue) => cue.text);
    });
    return batches;
  }

  function readRows(key) {
    if (config.cacheEntries <= 0 || !hasStore()) return new Map();
    try {
      const parsed = JSON.parse(storeRead(ROWS_PREFIX + key) || "{}");
      return new Map(Object.entries(parsed && typeof parsed === "object" ? parsed : {}));
    } catch (_) {
      return new Map();
    }
  }

  function writeRows(key, rows) {
    if (config.cacheEntries <= 0 || !hasStore()) return null;
    try {
      const merged = readRows(key);
      rows.forEach((text, id) => merged.set(String(id), text));
      const payload = JSON.stringify(Object.fromEntries(merged));
      const saved = storeWrite(payload, ROWS_PREFIX + key);
      const stored = readRows(key);
      if (saved === false || stored.size < merged.size) {
        log("WARN", `Row cache write failed (${merged.size} rows, ${payload.length} chars)`);
        return null;
      }
      log("DEBUG", `Row cache saved (${stored.size} rows, ${payload.length} chars)`);
      const index = readJsonStore(ROWS_INDEX_KEY, []);
      const list = (Array.isArray(index) ? index : []).filter((item) => item !== key);
      list.unshift(key);
      list.slice(ROWS_VIDEO_LIMIT).forEach((old) => {
        try {
          storeWrite("", ROWS_PREFIX + old);
        } catch (_) {
        }
      });
      writeJsonStore(ROWS_INDEX_KEY, list.slice(0, ROWS_VIDEO_LIMIT));
      return stored;
    } catch (error) {
      log("WARN", `Row cache write skipped: ${safeError(error)}`);
      return null;
    }
  }

  function loadCache() {
    if (config.cacheEntries <= 0 || !hasStore()) {
      return { entries: [] };
    }
    try {
      const parsed = JSON.parse(
        storeRead(CACHE_KEY) || "{\"entries\":[]}"
      );
      return Array.isArray(parsed?.entries) ? parsed : { entries: [] };
    } catch (_) {
      return { entries: [] };
    }
  }

  function readCache(key) {
    const now = Date.now();
    const cache = loadCache();
    const entry = cache.entries.find(
      (item) =>
        item?.key === key &&
        typeof item?.body === "string" &&
        (!item.expiresAt || item.expiresAt > now)
    );
    return entry || null;
  }

  function writeCache(key, value, ttlMs) {
    if (config.cacheEntries <= 0 || !hasStore()) return;
    try {
      const cache = loadCache();
      const entries = cache.entries.filter((item) => item?.key !== key);
      entries.unshift(
        Object.assign(
          {
            key,
            createdAt: Date.now(),
            expiresAt: ttlMs ? Date.now() + ttlMs : 0
          },
          value
        )
      );
      while (entries.length > config.cacheEntries) entries.pop();
      let payload = JSON.stringify({ entries });
      while (payload.length > config.cacheMaxChars && entries.length > 1) {
        entries.pop();
        payload = JSON.stringify({ entries });
      }
      if (payload.length <= config.cacheMaxChars) {
        storeWrite(payload, CACHE_KEY);
      }
    } catch (error) {
      log("WARN", `Cache write skipped: ${safeError(error)}`);
    }
  }

  function saveJob(videoId, job) {
    if (!videoId) return false;
    const jobs = readJsonStore(JOB_KEY, {});
    jobs[videoId] = job;
    const recent = Object.keys(jobs)
      .sort((a, b) => (jobs[b].createdAt || 0) - (jobs[a].createdAt || 0))
      .slice(0, JOB_LIMIT);
    const payload = JSON.stringify(Object.fromEntries(recent.map((key) => [key, jobs[key]])));
    try {
      if (!hasStore()) return false;
      const saved = storeWrite(payload, JOB_KEY);
      if (saved === false) {
        log("WARN", `Background job save failed (${payload.length} chars)`);
        return false;
      }
      log("INFO", `Background job saved for ${videoId}: ${job.remaining} rows left`);
      return true;
    } catch (error) {
      log("WARN", `Background job save skipped: ${safeError(error)}`);
      return false;
    }
  }

  function removeJob(videoId) {
    const jobs = readJsonStore(JOB_KEY, {});
    if (!videoId || !jobs[videoId]) return;
    delete jobs[videoId];
    writeJsonStore(JOB_KEY, jobs);
  }

  async function handleBackgroundPing() {
    const url = $request.url;
    const endpoint = (url.match(/\/api\/stats\/(\w+)/) || [])[1] || "?";
    const videoId = decodeURIComponent((url.match(/[?&]docid=([^&]+)/) || [])[1] || "");
    const jobs = readJsonStore(JOB_KEY, {});
    const job = jobs[videoId];
    log("INFO", `Playback ping ${endpoint} for ${videoId || "?"}; background job: ${job ? `${job.remaining} rows left` : "none"}`);
    if (!job || !config.backgroundTranslate || !config.aiEnabled || !Core.isConfigured(config)) return;
    const lastLoad = Number(storeRead(FOREGROUND_KEY) || 0);
    if (Date.now() - lastLoad < BACKGROUND_COOLDOWN_MS) {
      log("INFO", `Subtitles loaded ${Math.round((Date.now() - lastLoad) / 1000)}s ago; background translation waits`);
      return;
    }
    if (Date.now() - (job.createdAt || 0) > JOB_TTL_MS) {
      removeJob(videoId);
      return;
    }
    const lock = readJsonStore(LOCK_KEY, {});
    if (lock.until > Date.now()) {
      log("DEBUG", `Background translation already running for ${lock.video}`);
      return;
    }
    writeJsonStore(LOCK_KEY, { video: videoId, until: Date.now() + BACKGROUND_BUDGET_MS + 5000 });
    try {
      const known = readRows(job.key);
      const pending = job.cues.filter((cue) => !known.has(String(cue.id)));
      if (pending.length) {
        const plan = batchPlan();
        const batches = attachContext(Core.chunkCues(pending, plan.size, config.maxBatchChars), job.cues);
        const rememberedThinking = readJsonStore(THINKING_KEY, {})[config.model];
        if (config.provider === "Gemini" && rememberedThinking) config.thinkingLevel = rememberedThinking;
        const startedAt = Date.now();
        const outcome = await translateWithinDeadline(batches, job.languages, plan.expectedMs, {
          concurrency: BACKGROUND_CONCURRENCY,
          strictOrder: true,
          maxRetries: 2,
          shouldStop: () => {
            const latest = Number(storeRead(FOREGROUND_KEY) || 0);
            if (latest > startedAt) {
              log("INFO", "New subtitle load detected; background translation pauses");
              return true;
            }
            return false;
          }
        });
        recordSpeed(outcome.samples);
        const fresh = new Map(outcome.rows.map((row) => [String(row.id), row.text]));
        if (fresh.size && !writeRows(job.key, fresh)) {
          log("WARN", `Background rows for ${videoId} could not be saved; will retry on the next ping`);
        }
        log(
          "INFO",
          `Background translated ${outcome.rows.length} rows for ${videoId}, failed batches ${outcome.failures.length}` +
            (outcome.failures.length ? `, first failure: ${safeError(outcome.failures[0])}` : "")
        );
      }
      const stored = readRows(job.key);
      const left = job.cues.filter((cue) => !stored.has(String(cue.id))).length;
      log("INFO", `Background progress for ${videoId}: ${job.cues.length - left}/${job.cues.length} saved`);
      if (left === 0) {
        removeJob(videoId);
        log("INFO", `Background translation finished for ${videoId}`);
        notifyFallback(
          "这个视频的字幕已经全部翻好。退出视频再重新打开，就能看到完整的双语字幕。",
          "后台翻译完成",
          { key: `done:${videoId}`, intervalMs: 3600000 }
        );
      } else {
        const latest = readJsonStore(JOB_KEY, {});
        if (latest[videoId]) {
          latest[videoId].remaining = left;
          writeJsonStore(JOB_KEY, latest);
        }
      }
    } finally {
      writeJsonStore(LOCK_KEY, {});
    }
  }

  function subtitleContentType(document) {
    return document.format === "srv3"
      ? "application/xml; charset=utf-8"
      : "application/json; charset=utf-8";
  }

  async function handleRequest() {
    markSubtitleLoad();
    const rewritten = Core.rewriteTimedTextRequest($request.url, config);
    if (rewritten.reason === "missing-config" && config.aiEnabled) {
      const provider = config.provider === "OpenAI-Compatible" ? "AI" : config.provider;
      notifyFallback(
        isQX
          ? `已选择模型 ${config.model}，但还没填写 ${provider} API Key。请在圈X「持久化数据」中添加 yt_ai_config 或 yt_ai_key。`
          : `已选择模型 ${config.model}，但还没填写 ${provider} API Key，本次只显示原文字幕。`,
        "缺少 API Key",
        { key: "missing-key" }
      );
    }
    if (rewritten.changed) {
      log(
        "INFO",
        `Requesting source subtitles (${rewritten.sourceLanguage} -> ${rewritten.targetLanguage}, ${rewritten.reason})`
      );
    }
    let headers;
    if (Core.shouldProcessResponse(rewritten.url)) {
      const original = $request.headers || {};
      const conditional = Object.keys(original).filter((key) => CONDITIONAL_REQUEST_HEADERS.test(key));
      if (conditional.length) {
        headers = Object.assign({}, original);
        conditional.forEach((key) => delete headers[key]);
        log("INFO", `Removed conditional headers: ${conditional.join(", ")}`);
      }
    }
    doneRequest(rewritten.url, headers);
  }

  function markSubtitleLoad() {
    try {
      if (hasStore()) storeWrite(String(Date.now()), FOREGROUND_KEY);
    } catch (_) {
    }
  }

  async function handleResponse() {
    const shouldProcess =
      Core.shouldProcessResponse($request.url) ||
      (isQX && Core.isTimedTextUrl($request.url) && config.aiEnabled && config.autoTranslate && Core.isConfigured(config));
    if (!shouldProcess) {
      donePassthrough("skipped");
      return;
    }
    const status = responseStatus($response, 200);
    if (status < 200 || status >= 300) {
      log("WARN", `Subtitle HTTP ${status}; passing through`);
      donePassthrough("upstream-error");
      return;
    }

    const sourceBody = String($response.body || "");
    const sourceContentType =
      $response.headers?.["Content-Type"] || $response.headers?.["content-type"] || "";
    const responseCacheKey = Core.makeResponseCacheKey($request.url, sourceBody, config);
    const cached = readCache(responseCacheKey);
    if (cached) {
      log("INFO", `Final subtitle cache hit (${cached.result})`);
      doneBody(cached.body, cached.contentType, `cache-${cached.result}`);
      return;
    }

    let sourceDocument;
    try {
      sourceDocument = Core.parseSubtitleDocument(sourceBody, sourceContentType);
    } catch (error) {
      log("ERROR", safeError(error));
      donePassthrough("source-only", error);
      return;
    }
    if (!config.aiEnabled || !Core.isConfigured(config) || !sourceDocument.cues.length) {
      donePassthrough("source-only");
      return;
    }
    executionDeadline = Date.now() + config.maxWaitMs;
    if (config.sentenceSplit) {
      const originalCount = sourceDocument.cues.length;
      sourceDocument = Core.resegmentDocument(sourceDocument);
      if (sourceDocument.resegmented) {
        log("INFO", `Resegmented ${originalCount} cues into ${sourceDocument.cues.length} sentences`);
      }
    }
    const contentType = subtitleContentType(sourceDocument);
    const videoId = videoIdOf($request.url);

    try {
      const languages = Core.responseLanguages($request.url, config, sourceDocument.cues);
      if (languages.source !== "auto" && Core.languageRoot(languages.source) === Core.languageRoot(languages.target)) {
        log("INFO", `Subtitles are already in ${languages.target}; nothing to translate`);
        donePassthrough("source-only");
        return;
      }
      const rowsKey = Core.makeCacheKey($request.url, config, sourceDocument.cues, languages);
      const known = readRows(rowsKey);
      log("INFO", `Saved AI rows for this video: ${known.size}`);
      const pending = sourceDocument.cues.filter((cue) => !known.has(String(cue.id)));
      const plan = batchPlan();
      const batches = attachContext(
        Core.chunkForegroundCues(pending, plan.size, config.maxBatchChars, {
          maxCues: config.foregroundMaxCues,
          fastStart: config.strictOrder || config.adaptiveBatch,
          firstBatchItems: 12,
          firstBatchChars: 1000,
          firstBatchCount: 2
        }),
        sourceDocument.cues
      );
      const rememberedThinking = readJsonStore(THINKING_KEY, {})[config.model];
      if (config.provider === "Gemini" && rememberedThinking) config.thinkingLevel = rememberedThinking;
      const foregroundTotal = batches.reduce((sum, batch) => sum + batch.length, 0);
      log(
        "INFO",
        `AI translating ${foregroundTotal}/${pending.length} pending (${sourceDocument.cues.length} total) cues in ${batches.length} batch(es) ` +
          `of <=${plan.size} rows / ${config.maxBatchChars} chars, parallel=${config.concurrency}, wait=${config.maxWaitMs}ms, strict=${config.strictOrder} via ${config.provider} ${config.model}`
      );
      const outcome = batches.length
        ? await translateWithinDeadline(batches, languages, plan.expectedMs, {
            strictOrder: config.strictOrder,
            shouldStop: () => {
              const latest = Number(storeRead(FOREGROUND_KEY) || 0);
              if (latest > scriptStartedAt) {
                log("INFO", "A newer subtitle load started; this video stops sending new batches");
                return true;
              }
              return false;
            }
          })
        : { rows: [], failures: [], launched: 0, retried: 0, samples: [] };
      recordSpeed(outcome.samples);
      outcome.rows.forEach((row) => known.set(String(row.id), row.text));
      if (outcome.rows.length) {
        const stored = writeRows(rowsKey, new Map(outcome.rows.map((row) => [String(row.id), row.text])));
        if (stored) stored.forEach((text, id) => known.set(id, text));
      }

      const savedCount = sourceDocument.cues.filter((cue) => known.has(String(cue.id))).length;
      const orderedRows = savedCount === sourceDocument.cues.length
        ? sourceDocument.cues.map((cue) => ({ id: cue.id, text: known.get(String(cue.id)) }))
        : Core.selectOrderedRows(sourceDocument.cues, known, config.strictOrder);

      if (!orderedRows.length) {
        if (config.backgroundTranslate) {
          saveJob(videoId, {
            key: rowsKey,
            languages,
            cues: sourceDocument.cues.map(({ id, text }) => ({ id, text })),
            remaining: sourceDocument.cues.length - savedCount,
            createdAt: Date.now()
          });
        }
        notifyFallback(
          "视频字幕行数较多，AI 正在后台加速翻译中。本次先显示原文，看视频时后台自动续翻，完成后重新打开即可查看双语字幕。",
          "AI 字幕后台翻译中",
          { key: `queued:${videoId}`, intervalMs: 30000 }
        );
        donePassthrough("source-only", outcome.failures[0] || new Error("AI foreground timeout"));
        return;
      }

      const complete = savedCount === sourceDocument.cues.length;
      const aiBody = Core.renderSubtitleDocument(sourceDocument, orderedRows, config);
      const percent = Math.floor((orderedRows.length / sourceDocument.cues.length) * 100);
      log(
        "INFO",
        `AI rows ${orderedRows.length}/${sourceDocument.cues.length} shown (${savedCount} saved, ${percent}%), ` +
          `new ${outcome.rows.length}, failed batches ${outcome.failures.length}, retried ${outcome.retried}, ` +
          `${Date.now() - scriptStartedAt}ms` +
          (outcome.failures.length ? `, first failure: ${safeError(outcome.failures[0])}` : "")
      );
      if (complete) {
        writeCache(responseCacheKey, { body: aiBody, contentType, result: "ai" }, 86400000);
        removeJob(videoId);
      } else {
        const background = config.backgroundTranslate && saveJob(videoId, {
          key: rowsKey,
          languages,
          cues: sourceDocument.cues.map(({ id, text }) => ({ id, text })),
          remaining: sourceDocument.cues.length - savedCount,
          createdAt: Date.now()
        });
        notifyFallback(
          background
            ? `已用 AI 翻译 ${percent}%，其余暂时只显示原文。看视频时会在后台接着翻，翻完会通知你，之后重新打开这个视频即可看到完整双语字幕。`
            : `已用 AI 翻译 ${percent}%，其余暂时只显示原文。翻好的部分已保存，重新打开这个视频时会接着翻译剩下的部分。`,
          "AI 字幕部分完成",
          { key: `partial:${videoId}`, intervalMs: 30000 }
        );
      }
      doneBody(aiBody, contentType, complete ? "ai" : "ai-partial", undefined, { noStore: !complete });
    } catch (error) {
      const message = safeError(error);
      log("WARN", `${message}; showing source subtitles`);
      notifyFallback(message, "AI 翻译失败，本次只显示原文字幕", { key: "failure" });
      donePassthrough("source-only", message);
    }
  }

  Promise.resolve()
    .then(() => {
      if (isBackgroundPing) return handleBackgroundPing().finally(() => $done({}));
      return typeof $response === "undefined" ? handleRequest() : handleResponse();
    })
    .catch((error) => {
      const message = safeError(error);
      log("ERROR", message);
      if (isBackgroundPing) return;
      if (typeof $response === "undefined") doneRequest($request.url);
      else donePassthrough("source-only", message);
    });
})();
