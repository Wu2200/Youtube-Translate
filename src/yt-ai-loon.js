(function runDualSubsAITranslator() {
  "use strict";

  const Core = globalThis.YTAI;
  const CACHE_KEY = "@DualSubs-AI.Cache.v1";
  const NOTICE_KEY = "@DualSubs-AI.Notices.v2";
  // 按视频保存已翻好的 AI 行；没翻完的视频下次请求字幕时只翻剩下的行。
  // 每个视频单独一个存储键（避免所有视频挤在一条里撞到存储上限），索引记录最近的视频用于淘汰
  const ROWS_PREFIX = "@DualSubs-AI.Rows.v2:";
  const ROWS_INDEX_KEY = "@DualSubs-AI.RowsIndex.v2";
  // 每个视频单独存储，多留一些：连续打开六七个视频再回到第一个时，不用重新翻
  const ROWS_VIDEO_LIMIT = 20;
  // 剩余时间不够一批正常耗时（真机 2～3 秒）就不再发新批次。
  const MIN_LAUNCH_MS = 2000;
  const RENDER_RESERVE_MS = 150;
  // 记住每个 Gemini 模型能接受的思考设置，下次直接用
  const THINKING_KEY = "@DualSubs-AI.ThinkingLevel.v1";
  // 记住每个模型每行的平均耗时，用来自动决定每批条数
  const SPEED_KEY = "@DualSubs-AI.ModelSpeed.v1";
  // 每批目标耗时：留出余量，保证一次开字幕内能跑完两轮
  const TARGET_BATCH_MS = 3000;
  const MIN_BATCH_ROWS = 8;
  const MAX_BATCH_ROWS = 40;
  // 每批附带前面几行原文作上下文，避免句子被批次切断后译得生硬
  const CONTEXT_ROWS = 2;
  // 失败批次和少返回的行最多重发一次
  const MAX_BATCH_RETRIES = 1;
  const LOG_LEVELS = { OFF: 99, ERROR: 40, WARN: 30, INFO: 20, DEBUG: 10 };
  const CLIENT_SAFE_MAX_WAIT_MS = 20000;
  const MIN_MODEL_REQUEST_TIMEOUT_MS = 15000;
  const config = Core.normalizeConfig(
    typeof $argument === "undefined" ? {} : $argument
  );
  const scriptStartedAt = Date.now();
  // 播放时 App 定期发送的观看统计请求：没人在等它返回，可以借来在后台继续翻
  const isBackgroundPing =
    typeof $response === "undefined" &&
    /^https?:\/\/s\.youtube\.com\/api\/stats\//.test(String((typeof $request === "undefined" ? null : $request)?.url || ""));
  const BACKGROUND_BUDGET_MS = 20000;
  const BACKGROUND_REQUEST_TIMEOUT_MS = 15000;
  // 后台续翻要给视频加载和去广告插件让路：只用 3 个并发；打开/切换视频后 30 秒内不启动；
  // 后台进行中一旦有新的字幕加载，就不再发新批次
  const BACKGROUND_CONCURRENCY = 3;
  const BACKGROUND_COOLDOWN_MS = 3000;
  const FOREGROUND_KEY = "@DualSubs-AI.LastSubtitleLoad.v1";
  let executionDeadline = isBackgroundPing ? Date.now() + BACKGROUND_BUDGET_MS : 0;
  // 没翻完的视频的后台任务：全部原文 + 缓存键；只保留最近 2 个，3 小时后作废
  const JOB_KEY = "@DualSubs-AI.BackgroundJobs.v1";
  const LOCK_KEY = "@DualSubs-AI.BackgroundLock.v1";
  const JOB_LIMIT = 2;
  const JOB_TTL_MS = 3 * 3600 * 1000;

  function log(level, message) {
    if ((LOG_LEVELS[level] || 20) < (LOG_LEVELS[config.logLevel] || 20)) return;
    console.log(`[DualSubs-AI][${level}] ${message}`);
  }

  function safeError(error) {
    return String(error?.message || error || "unknown error")
      .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/([?&](?:key|api_key)=)[^&\s]+/gi, "$1[REDACTED]")
      .slice(0, 220);
  }

  // 不同类型的通知分开限频：部分翻译按视频只去重 30 秒（App 偶尔连发两次请求），
  // 失败、缺 Key 这类重复性提示 5 分钟最多一次，避免刷屏
  function notifyFallback(message, subtitle, options) {
    if (typeof $notification === "undefined" || typeof $notification.post !== "function") {
      return;
    }
    const key = options?.key || "general";
    const intervalMs = options?.intervalMs ?? 300000;
    const now = Date.now();
    let history = {};
    try {
      const parsed = JSON.parse($persistentStore?.read(NOTICE_KEY) || "{}");
      history = parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      history = {};
    }
    if (now - Number(history[key] || 0) < intervalMs) return;
    try {
      history[key] = now;
      // 只保留最近 30 条记录
      const recent = Object.keys(history)
        .sort((a, b) => history[b] - history[a])
        .slice(0, 30);
      $persistentStore?.write(JSON.stringify(Object.fromEntries(recent.map((item) => [item, history[item]]))), NOTICE_KEY);
      $notification.post(
        "YouTube AI 双语字幕",
        subtitle || "AI 翻译未完成，本次只显示原文字幕",
        message
      );
    } catch (_) {
      // Notifications are best-effort and must never block subtitles.
    }
  }

  // 条件请求头：带上它们时 YouTube 可能回 304，App 就继续用它缓存的旧字幕
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
      // 改写过的字幕不能再用 YouTube 原文的校验值，否则 App 会拿它做条件请求、复用旧结果
      if (rewritten && /^(etag|last-modified)$/i.test(key)) delete headers[key];
      if (noStore && /^(cache-control|expires|pragma|age)$/i.test(key)) delete headers[key];
    });
    if (noStore) {
      // 只翻了一部分的字幕不让 App 缓存，下次加载这个视频时才会重新请求、接着翻
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
    const value = { url };
    if (headers) value.headers = headers;
    return $done(value);
  }

  function doneBody(body, contentType, result, error, options) {
    return $done(
      Object.assign({}, $response, {
        headers: sanitizedHeaders(contentType, result, error, Object.assign({ rewritten: true }, options)),
        body
      })
    );
  }

  function donePassthrough(result, error) {
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
      if (typeof $httpClient === "undefined" || typeof $httpClient.post !== "function") {
        reject(new Error("Loon $httpClient.post is unavailable"));
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
      $httpClient.post(request, (error, response, body) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          reject(new Error(String(error)));
          return;
        }
        const status = Number(response?.status || response?.statusCode || 0);
        if (status < 200 || status >= 300) {
          const failure = new Error(`AI HTTP ${status || "unknown"}`);
          failure.status = status;
          failure.body = String(body || "").slice(0, 400);
          reject(failure);
          return;
        }
        resolve(String(body || ""));
      });
    });
  }

  function requestConfigWithinDeadline() {
    const remaining = remainingTime();
    if (remaining <= 700) {
      throw new Error("AI translation exceeded the subtitle deadline");
    }
    // AI 单次请求至少给 15 秒；总翻译期限仍由 translateWithinDeadline 单独控制。
    const cap = isBackgroundPing ? BACKGROUND_REQUEST_TIMEOUT_MS : config.timeoutMs;
    return Object.assign({}, config, {
      timeoutMs: Math.max(MIN_MODEL_REQUEST_TIMEOUT_MS, Math.min(cap, remaining - 350))
    });
  }

  // 思考设置被拒时的退路：2.5 系列用 thinkingBudget 0；其他模型 minimal → low → 不传
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
      // effort 等参数被拒时，去掉 effort 再试一次
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
      // 推理/思考参数被拒时（兼容服务常见），去掉这些参数再试一次
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

  // 在截止时间前尽量多翻：按时间顺序派发批次，到点就带着已完成的行返回，
  // 不等仍在途的请求。单批失败不影响其他批次。
  // 在截止时间前尽量多翻：按时间顺序派发批次，到点就带着已完成的行返回，
  // 不等仍在途的请求。整批失败（限流、报错、返回坏 JSON）或少返回的行，
  // 时间够的话重发一次，尽量在第一次开字幕时就翻完。
  async function translateWithinDeadline(batches, languages, expectedBatchMs, options) {
    const rows = [];
    const failures = [];
    // 每批的耗时样本；超时或到点未完成的批次按 1.5 倍已用时间计，确保慢模型下次自动缩小批次
    const samples = [];
    const inFlight = new Map();
    const queue = batches.slice();
    const launchThreshold = Math.max(MIN_LAUNCH_MS, Math.round((expectedBatchMs || 0) * 0.8));
    let launched = 0;
    let retried = 0;
    let finished = false;

    function requeue(cues, parent, waitMs) {
      if ((parent.attempt || 0) >= MAX_BATCH_RETRIES || !cues.length) return;
      const retry = cues.slice();
      retry.attempt = (parent.attempt || 0) + 1;
      retry.context = parent.context;
      retry.notBefore = Date.now() + (waitMs || 0);
      queue.push(retry);
      retried += 1;
    }

    async function runWorker() {
      while (!finished) {
        if (options?.shouldStop?.()) return;
        if (remainingTime() < launchThreshold) return;
        const index = queue.findIndex((item) => !item.notBefore || item.notBefore <= Date.now());
        if (index < 0) {
          // 队列暂时空了，但在途批次可能还会放回重试，等一下再看
          if (!queue.length && !inFlight.size) return;
          await delay(80);
          continue;
        }
        const batch = queue.splice(index, 1)[0];
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
          if (/timeout|deadline/i.test(String(error?.message || ""))) {
            samples.push({ rows: batch.length, ms: (Date.now() - startedAt) * 1.5 });
          } else {
            // 限流稍等再发，其他错误立刻重发
            requeue(batch, batch, error?.status === 429 ? 600 : 0);
          }
        }
      }
    }
    const workerCount = Math.min(options?.concurrency || config.concurrency, Math.max(1, batches.length));
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
      samples.push({ rows: batch.length, ms: (Date.now() - startedAt) * 1.5 });
    });
    return { rows: rows.slice(), failures, launched, retried, samples };
  }

  function readJsonStore(key, fallback) {
    try {
      const value = typeof $persistentStore === "undefined" ? null : $persistentStore.read(key);
      const parsed = value ? JSON.parse(value) : fallback;
      return parsed && typeof parsed === "object" ? parsed : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function writeJsonStore(key, value) {
    try {
      if (typeof $persistentStore !== "undefined") $persistentStore.write(JSON.stringify(value), key);
    } catch (_) {
      // 只是优化，写不进去下次再试
    }
  }

  // 按这个模型记录下来的速度决定每批条数，目标是每批约 3 秒
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
    if (config.cacheEntries <= 0 || typeof $persistentStore === "undefined") return new Map();
    try {
      const parsed = JSON.parse($persistentStore.read(ROWS_PREFIX + key) || "{}");
      return new Map(Object.entries(parsed && typeof parsed === "object" ? parsed : {}));
    } catch (_) {
      return new Map();
    }
  }

  // 写入前先读最新存储再合并：开字幕和后台续翻可能先后写同一个视频，合并才不会互相覆盖。
  // 写完读回核对，返回实际存下的行；写入失败返回 null
  function writeRows(key, rows) {
    if (config.cacheEntries <= 0 || typeof $persistentStore === "undefined") return null;
    try {
      const merged = readRows(key);
      rows.forEach((text, id) => merged.set(String(id), text));
      const payload = JSON.stringify(Object.fromEntries(merged));
      const saved = $persistentStore.write(payload, ROWS_PREFIX + key);
      const stored = readRows(key);
      if (saved === false || stored.size < merged.size) {
        log("WARN", `Row cache write failed (${merged.size} rows, ${payload.length} chars)`);
        return null;
      }
      log("DEBUG", `Row cache saved (${stored.size} rows, ${payload.length} chars)`);
      // 更新索引，只保留最近的几个视频，淘汰的清空
      const index = readJsonStore(ROWS_INDEX_KEY, []);
      const list = (Array.isArray(index) ? index : []).filter((item) => item !== key);
      list.unshift(key);
      list.slice(ROWS_VIDEO_LIMIT).forEach((old) => {
        try {
          $persistentStore.write("", ROWS_PREFIX + old);
        } catch (_) {
          // 清理失败不影响本次结果
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
    if (config.cacheEntries <= 0 || typeof $persistentStore === "undefined") {
      return { entries: [] };
    }
    try {
      const parsed = JSON.parse(
        $persistentStore.read(CACHE_KEY) || "{\"entries\":[]}"
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
    if (config.cacheEntries <= 0 || typeof $persistentStore === "undefined") return;
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
        $persistentStore.write(payload, CACHE_KEY);
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
      if (typeof $persistentStore === "undefined") return false;
      const saved = $persistentStore.write(payload, JOB_KEY);
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
    // 每次都记一条，方便确认 App 是否真的发了这类请求
    log("INFO", `Playback ping ${endpoint} for ${videoId || "?"}; background job: ${job ? `${job.remaining} rows left` : "none"}`);
    if (!job || !config.backgroundTranslate || !config.aiEnabled || !Core.isConfigured(config)) return;
    const lastLoad = Number((typeof $persistentStore === "undefined" ? 0 : $persistentStore.read(FOREGROUND_KEY)) || 0);
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
          // 有新的字幕加载（打开或切换视频）就停止发新批次
          shouldStop: () => {
            const latest = Number($persistentStore.read(FOREGROUND_KEY) || 0);
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
      // 以真正存下来的为准判断是否翻完，避免写入失败时也通知「已完成」
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
    // 字幕请求意味着正在打开或切换视频：记下时间，后台续翻据此让路
    markSubtitleLoad();
    const rewritten = Core.rewriteTimedTextRequest($request.url, config);
    // 选了模型却没填那一家的 Key 时，字幕会只显示原文；提示一下，免得以为插件坏了
    if (rewritten.reason === "missing-config" && config.aiEnabled) {
      const provider = config.provider === "OpenAI-Compatible" ? "AI" : config.provider;
      notifyFallback(
        `已选择模型 ${config.model}，但还没填写 ${provider} API Key，本次只显示原文字幕。`,
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
    // 要翻译的字幕请求去掉条件请求头，保证每次都拿到完整原文、脚本都能处理
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

  // 0.4.1 起直接翻原文字幕：YouTube 对带 tlang 的官方机翻请求返回 429，
  // 不能再用它做底座。没翻到的行暂时只显示原文。
  function markSubtitleLoad() {
    try {
      if (typeof $persistentStore !== "undefined") $persistentStore.write(String(Date.now()), FOREGROUND_KEY);
    } catch (_) {
      // 只用于给后台让路
    }
  }

  async function handleResponse() {
    if (!Core.shouldProcessResponse($request.url)) {
      donePassthrough("skipped");
      return;
    }
    const status = Number($response?.status || $response?.statusCode || 200);
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
    executionDeadline = Date.now() + Math.min(config.maxWaitMs, CLIENT_SAFE_MAX_WAIT_MS);
    if (config.sentenceSplit) {
      const originalCount = sourceDocument.cues.length;
      sourceDocument = Core.resegmentDocument(sourceDocument);
      if (sourceDocument.resegmented) {
        log("INFO", `Resegmented ${originalCount} cues into ${sourceDocument.cues.length} sentences`);
      }
    }
    const contentType = subtitleContentType(sourceDocument);

    try {
      const languages = Core.responseLanguages($request.url, config, sourceDocument.cues);
      // 识别后原文已经是目标语言（且没有可用的第二语言）时不翻译
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
        Core.chunkCues(pending, plan.size, config.maxBatchChars),
        sourceDocument.cues
      );
      const rememberedThinking = readJsonStore(THINKING_KEY, {})[config.model];
      if (config.provider === "Gemini" && rememberedThinking) config.thinkingLevel = rememberedThinking;
      log(
        "INFO",
        `AI translating ${pending.length}/${sourceDocument.cues.length} cues in ${batches.length} batch(es) ` +
          `of ${plan.size} via ${config.provider} ${config.model}`
      );
      const outcome = batches.length
        ? await translateWithinDeadline(batches, languages, plan.expectedMs, {
            // 用户已切到别的视频（有更新的字幕请求）时，这个视频不再发新批次，把名额让给新视频和去广告插件
            shouldStop: () => {
              const latest = Number((typeof $persistentStore === "undefined" ? 0 : $persistentStore.read(FOREGROUND_KEY)) || 0);
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
        // 合并后可能多出后台刚翻好的行，一起显示
        if (stored) stored.forEach((text, id) => known.set(id, text));
      }

      const aiRows = sourceDocument.cues
        .filter((cue) => known.has(String(cue.id)))
        .map((cue) => ({ id: cue.id, text: known.get(String(cue.id)) }));
      if (!aiRows.length) {
        throw outcome.failures[0] || new Error("AI produced no rows before the subtitle deadline");
      }
      const complete = aiRows.length === sourceDocument.cues.length;
      const aiBody = Core.renderSubtitleDocument(sourceDocument, aiRows, config);
      const percent = Math.floor((aiRows.length / sourceDocument.cues.length) * 100);
      log(
        "INFO",
        `AI rows ${aiRows.length}/${sourceDocument.cues.length} (${percent}%), ` +
          `new ${outcome.rows.length}, failed batches ${outcome.failures.length}, retried ${outcome.retried}, ` +
          `${Date.now() - scriptStartedAt}ms` +
          (outcome.failures.length ? `, first failure: ${safeError(outcome.failures[0])}` : "")
      );
      const videoId = videoIdOf($request.url);
      if (complete) {
        writeCache(responseCacheKey, { body: aiBody, contentType, result: "ai" }, 86400000);
        removeJob(videoId);
      } else {
        const background = config.backgroundTranslate && saveJob(videoId, {
          key: rowsKey,
          languages,
          cues: sourceDocument.cues.map(({ id, text }) => ({ id, text })),
          remaining: sourceDocument.cues.length - aiRows.length,
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
      // 后台续翻在 finally 里已经放行了统计请求，这里不能再调用一次 $done
      if (isBackgroundPing) return;
      if (typeof $response === "undefined") doneRequest($request.url);
      else donePassthrough("source-only", message);
    });
})();
