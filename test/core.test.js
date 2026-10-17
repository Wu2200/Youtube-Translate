const assert = require("node:assert/strict");
const test = require("node:test");

const Core = require("../src/yt-ai-core.js");

function sourceJson3() {
  return {
    wireMagic: "pb3",
    events: [
      {
        tStartMs: 100,
        dDurationMs: 900,
        wWinId: 1,
        segs: [{ utf8: "Hello " }, { utf8: "world" }]
      },
      { tStartMs: 1000, dDurationMs: 800, segs: [{ utf8: "How are you?" }] },
      { tStartMs: 1800, dDurationMs: 200, segs: [{ utf8: "\u200b" }] }
    ]
  };
}

function translatedJson3() {
  return {
    events: [
      { tStartMs: 102, dDurationMs: 900, segs: [{ utf8: "你好世界" }] },
      { tStartMs: 1003, dDurationMs: 800, segs: [{ utf8: "你好吗？" }] }
    ]
  };
}

test("normalizes DualSubs AI settings and keeps secrets opaque", () => {
  const config = Core.normalizeConfig({
    provider: "OpenAI-Compatible",
    api_key: "secret-value",
    model: "deepseek-chat",
    auto_translate: "false",
    Position: "Forward",
    ai_enabled: "true",
    concurrency: "20"
  });
  assert.equal(Core.VERSION, "0.10.0");
  assert.equal(config.provider, "OpenAI-Compatible");
  assert.equal(config.apiKey, "secret-value");
  assert.equal(config.model, "deepseek-chat");
  assert.equal(config.autoTranslate, false);
  assert.equal(config.position, "SourceFirst");
  assert.equal(config.aiEnabled, true);
  assert.equal(config.concurrency, 16);
  assert.equal(config.timeoutMs, 10000);
  assert.equal(config.maxWaitMs, 9500);
  assert.equal(config.originalFetchTimeoutMs, 10000);
  assert.equal(Core.normalizeConfig({ timeout_ms: "5000" }).timeoutMs, 10000);
});

test("rewrites timedtext to the source track and never keeps tlang", () => {
  const config = Core.normalizeConfig({ api_key: "k", model: "m", target_language: "zh-Hans" });
  const explicit = Core.rewriteTimedTextRequest(
    "https://www.youtube.com/api/timedtext?v=abc&lang=en&tlang=zh-Hant&format=srv3",
    config
  );
  const url = new URL(explicit.url);
  assert.equal(explicit.changed, true);
  assert.equal(url.searchParams.has("tlang"), false);
  assert.equal(url.searchParams.get("dsai"), "1");
  assert.equal(url.searchParams.get("dsai_target"), "zh-Hant");
  assert.equal(url.searchParams.get("format"), "srv3");
  assert.deepEqual(Core.responseLanguages(explicit.url, config), { source: "en", target: "zh-Hant" });

  const manual = Core.rewriteTimedTextRequest(
    "https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=json3",
    Core.normalizeConfig({ api_key: "k", model: "m", auto_translate: false })
  );
  assert.equal(manual.changed, false);
  assert.equal(manual.reason, "manual-only");

  const unconfigured = Core.rewriteTimedTextRequest(
    "https://www.youtube.com/api/timedtext?v=abc&lang=en&tlang=zh-Hans",
    Core.normalizeConfig({ api_key: "" })
  );
  assert.equal(new URL(unconfigured.url).searchParams.has("tlang"), false);
  assert.equal(unconfigured.reason, "missing-config");
});

test("extracts timed JSON3 cues and chunks deterministically", () => {
  const cues = Core.extractCues(sourceJson3());
  assert.deepEqual(cues, [
    {
      id: 0,
      eventIndex: 0,
      startMs: 100,
      durationMs: 900,
      text: "Hello world"
    },
    {
      id: 1,
      eventIndex: 1,
      startMs: 1000,
      durationMs: 800,
      text: "How are you?"
    }
  ]);
  assert.deepEqual(
    Core.chunkCues(cues, 1, 999).map((chunk) => chunk.map((cue) => cue.id)),
    [[0], [1]]
  );
});

test("default batching uses balanced batches to minimize request count within deadline", () => {
  const cues = Array.from({ length: 962 }, (_, id) => ({
    id,
    eventIndex: id,
    startMs: id * 1000,
    durationMs: 900,
    text: `Subtitle row ${id}`
  }));
  const config = Core.normalizeConfig({});
  const chunks = Core.chunkCues(cues, config.maxBatchItems, config.maxBatchChars);
  assert.equal(config.maxBatchItems, 35);
  assert.equal(config.concurrency, 10);
  assert.equal(chunks.length, 28);
  assert.ok(chunks.every((chunk) => chunk.length <= 35));
  assert.deepEqual(chunks[0].map((cue) => cue.id).slice(0, 3), [0, 1, 2], "按时间顺序，开头先翻");
  assert.equal(chunks.flat().length, 962);
});

test("salvages usable rows from a batch that drops or duplicates a line", () => {
  const batch = [0, 1, 2, 3].map((id) => ({ id, text: `line ${id}` }));
  const rows = Core.salvageTranslations(
    { translations: [{ id: 0, text: "零" }, { id: 1, text: "一" }, { id: 1, text: "壹" }, { id: 3, text: "三" }] },
    batch
  );
  assert.deepEqual(rows.map((row) => [row.id, row.text]), [[0, "零"], [3, "三"]]);
  assert.throws(() => Core.salvageTranslations({ translations: [] }, batch), /no usable rows/);
  const merged = Core.mergeTranslationRows(
    [{ id: 0, text: "官0" }, { id: 1, text: "官1" }, { id: 2, text: "官2" }],
    rows
  );
  assert.deepEqual(merged.map((row) => row.text), ["零", "官1", "官2", "三"]);
});

test("parses flexible separators, markdown, and thinking tags with sequential fallback", () => {
  const withSeparators = Core.parseTranslationText(
    "<think>thought content 1|ignore</think>\n" +
    "**1**: 第一行\n" +
    "2. 第二行\n" +
    "3 - 第三行\n" +
    "[4]：第四行\n" +
    "5 — 第五行"
  );
  assert.deepEqual(withSeparators.translations, [
    { id: 1, text: "第一行" },
    { id: 2, text: "第二行" },
    { id: 3, text: "第三行" },
    { id: 4, text: "第四行" },
    { id: 5, text: "第五行" }
  ]);

  const batch = [{ id: 100, text: "A" }, { id: 101, text: "B" }, { id: 102, text: "C" }];
  const salvaged = Core.salvageTranslations(
    { translations: [{ id: 1, text: "甲" }, { id: 2, text: "乙" }, { id: 3, text: "丙" }] },
    batch
  );
  assert.deepEqual(salvaged, [
    { id: 100, text: "甲" },
    { id: 101, text: "乙" },
    { id: 102, text: "丙" }
  ]);
});

test("builds OpenAI-compatible request with JSON mode and header-only key", () => {
  const config = Core.normalizeConfig({
    provider: "OpenAI-Compatible",
    api_key: "openai-secret",
    model: "model-a",
    base_url: "https://example.com/v1"
  });
  const request = Core.createOpenAIRequest(
    config,
    [{ id: 0, text: "Hello" }],
    { source: "en", target: "zh-Hans" },
    true
  );
  const body = JSON.parse(request.body);
  assert.equal(request.url, "https://example.com/v1/chat/completions");
  assert.equal(request.headers.Authorization, "Bearer openai-secret");
  assert.equal(request.body.includes("openai-secret"), false);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.match(body.messages[0].content, /untrusted data/);
  assert.throws(
    () =>
      Core.createOpenAIRequest(
        { ...config, baseUrl: "http://insecure.example/v1" },
        [{ id: 0, text: "Hello" }],
        { source: "en", target: "zh-Hans" },
        true
      ),
    /must use HTTPS/
  );
});

test("builds current Gemini generateContent request with structured output", () => {
  assert.equal(Core.normalizeConfig({}).model, "gemini-3.5-flash-lite");
  const config = Core.normalizeConfig({
    provider: "Gemini",
    api_key: "gemini-secret",
    model: "gemini-3.6-flash"
  });
  const request = Core.createGeminiRequest(
    config,
    [{ id: 7, text: "Hello" }],
    { source: "en", target: "zh-Hans" },
    true
  );
  const body = JSON.parse(request.body);
  assert.equal(
    request.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent"
  );
  assert.equal(request.headers["x-goog-api-key"], "gemini-secret");
  assert.equal(request.body.includes("gemini-secret"), false);
  assert.equal(body.generationConfig.temperature, undefined);
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, "minimal");
  assert.equal(body.generationConfig.responseMimeType, "text/plain");
  assert.equal(body.generationConfig.responseSchema, undefined, "紧凑行格式不再用 JSON Schema");
});

test("parses thought-aware model responses and rejects misaligned output", () => {
  const batch = [
    { id: 0, text: "Hello" },
    { id: 1, text: "World" }
  ];
  const payload = {
    translations: [
      { id: 0, text: "你好" },
      { id: 1, text: "世界" }
    ]
  };
  const gemini = Core.parseGeminiResponse({
    candidates: [
      {
        content: {
          parts: [
            { thought: true, text: "not JSON" },
            { text: JSON.stringify(payload) }
          ]
        }
      }
    ]
  });
  assert.deepEqual(Core.validateTranslations(gemini, batch), payload.translations);
  assert.throws(
    () =>
      Core.validateTranslations(
        { translations: [{ id: 1, text: "错位" }] },
        [batch[0]]
      ),
    /Missing translation id/
  );
});

test("renders AI bilingual JSON3 without changing source timing", () => {
  const source = Core.parseSubtitleDocument(
    JSON.stringify(sourceJson3()),
    "application/json"
  );
  const rendered = JSON.parse(
    Core.renderSubtitleDocument(
      source,
      [
        { id: 0, text: "你好世界" },
        { id: 1, text: "你好吗？" }
      ],
      Core.normalizeConfig({ Position: "Reverse" })
    )
  );
  assert.equal(rendered.events[0].segs[0].utf8, "你好世界\nHello world");
  assert.equal(rendered.events[1].segs[0].utf8, "你好吗？\nHow are you?");
  assert.equal(rendered.events[0].tStartMs, 100);
  assert.equal(rendered.events[0].dDurationMs, 900);
  assert.equal(rendered.events[0].wWinId, undefined);
});

test("response cache identity changes with official content or AI settings", () => {
  const url =
    "https://www.youtube.com/api/timedtext?v=abc&lang=en&tlang=zh-Hans&subtype=Official";
  const first = Core.makeResponseCacheKey(
    url,
    "official-a",
    Core.normalizeConfig({ model: "a" })
  );
  const second = Core.makeResponseCacheKey(
    url,
    "official-b",
    Core.normalizeConfig({ model: "a" })
  );
  const third = Core.makeResponseCacheKey(
    url,
    "official-a",
    Core.normalizeConfig({ model: "b" })
  );
  assert.notEqual(first, second);
  assert.notEqual(first, third);
});

test("each language is rendered on exactly one line", () => {
  const forward = { position: "SourceFirst", showOnly: false };
  assert.equal(
    Core.combineText(
      "only 10-15% of the total cost of\nownership of a data center is energy.",
      "数据中心总拥有成本中，\n只有10%到15%是能源开销。",
      forward
    ),
    "only 10-15% of the total cost of ownership of a data center is energy.\n数据中心总拥有成本中，只有10%到15%是能源开销。"
  );
  assert.equal(
    Core.combineText("a\nb", "甲\n乙", { position: "TranslationFirst", showOnly: false }),
    "甲乙\na b"
  );
  assert.equal(Core.combineText("a\nb", "Hola\nmundo", { showOnly: true }), "Hola mundo");
  assert.match(Core.buildPrompts([{ id: 0, text: "x" }], "en", "zh-Hans", "").system, /single line/);
});

test("plugin dropdown labels map to config values", () => {
  const config = Core.normalizeConfig({ target_language: "繁體中文", Position: "原文在上" });
  assert.equal(config.targetLanguage, "zh-Hant");
  assert.equal(config.position, "SourceFirst");
  assert.equal(Core.normalizeConfig({ Position: "译文在上" }).position, "TranslationFirst");
  assert.equal(Core.normalizeConfig({ target_language: "日本語" }).targetLanguage, "ja");
  assert.equal(Core.normalizeConfig({ target_language: "es" }).targetLanguage, "es");
  assert.equal(Core.normalizeConfig({}).provider, "Gemini");
});

test("Gemini request carries context rows and can omit thinkingLevel", () => {
  const batch = [{ id: 5, text: "does, we need to go back" }];
  batch.context = ["For the past 2 months", "To understand what it"];
  const base = Core.normalizeConfig({ api_key: "k", model: "gemini-test" });
  const withThinking = JSON.parse(
    Core.createGeminiRequest(base, batch, { source: "en", target: "zh-Hans" }, true).body
  );
  assert.equal(
    withThinking.contents[0].parts[0].text,
    "Source: en\nTarget: zh-Hans\n-|For the past 2 months\n-|To understand what it\n5|does, we need to go back"
  );
  assert.match(withThinking.systemInstruction.parts[0].text, /never translate or return them/);
  assert.equal(withThinking.generationConfig.thinkingConfig.thinkingLevel, "minimal");

  const off = JSON.parse(
    Core.createGeminiRequest({ ...base, thinkingLevel: "off" }, [{ id: 0, text: "x" }], { source: "en", target: "zh-Hans" }, true).body
  );
  assert.equal(off.generationConfig.thinkingConfig, undefined);
  assert.doesNotMatch(off.contents[0].parts[0].text, /^-\|/m);
  assert.doesNotMatch(off.systemInstruction.parts[0].text, /Lines starting with -\|/);
});

test("provider and API key follow the selected model", () => {
  const keys = { api_key: "g", deepseek_api_key: "d", openai_api_key: "o", claude_api_key: "c" };
  const cases = [
    ["gemini-3.8-flash", "Gemini", "g"],
    ["deepseek-flash", "DeepSeek", "d"],
    ["gpt-5.4-mini", "OpenAI", "o"],
    ["claude-haiku-4-5", "Claude", "c"]
  ];
  for (const [model, provider, key] of cases) {
    const config = Core.normalizeConfig({ ...keys, model });
    assert.equal(config.provider, provider, model);
    assert.equal(config.apiKey, key, model);
  }
  assert.equal(Core.normalizeConfig({ model: "deepseek-flash" }).baseUrl, "https://api.deepseek.com");
  assert.equal(Core.normalizeConfig({ model: "gpt-5.4-nano" }).baseUrl, "https://api.openai.com/v1");
  const mismatched = Core.normalizeConfig({ api_key: "g", model: "deepseek-flash" });
  assert.equal(mismatched.apiKey, "");
  assert.equal(Core.isConfigured(mismatched), false);
});

test("batch size starts by model speed class and adapts unless fixed", () => {
  assert.equal(Core.initialBatchSize("gemini-3.5-flash-lite"), 35);
  assert.equal(Core.initialBatchSize("gpt-5.4-nano"), 35);
  assert.equal(Core.initialBatchSize("claude-haiku-4-5"), 35);
  assert.equal(Core.initialBatchSize("deepseek-flash"), 35);
  assert.equal(Core.initialBatchSize("gemini-3.8-flash"), 30);
  assert.equal(Core.initialBatchSize("deepseek-v4-pro"), 30);
  const adaptive = Core.normalizeConfig({ model: "gemini-3.8-flash" });
  assert.equal(adaptive.adaptiveBatch, true);
  assert.equal(adaptive.maxBatchItems, 30);
  const fixed = Core.normalizeConfig({ model: "gemini-3.8-flash", batch_size: "20" });
  assert.equal(fixed.adaptiveBatch, false);
  assert.equal(fixed.maxBatchItems, 20);
});

test("OpenAI and DeepSeek requests disable reasoning the way each provider expects", () => {
  const batch = [{ id: 0, text: "hello" }];
  const languages = { source: "en", target: "zh-Hans" };
  const openai = Core.createOpenAIRequest(
    Core.normalizeConfig({ model: "gpt-5.4-mini", openai_api_key: "o" }), batch, languages, true
  );
  const openaiBody = JSON.parse(openai.body);
  assert.equal(openai.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(openai.headers.Authorization, "Bearer o");
  assert.equal(openaiBody.reasoning_effort, "none");
  assert.equal(openaiBody.temperature, undefined, "GPT-5.x 不接受自定义 temperature");
  assert.deepEqual(openaiBody.response_format, { type: "json_object" });

  const deepseek = Core.createOpenAIRequest(
    Core.normalizeConfig({ model: "deepseek-flash", deepseek_api_key: "d" }), batch, languages, true
  );
  const deepseekBody = JSON.parse(deepseek.body);
  assert.equal(deepseek.url, "https://api.deepseek.com/chat/completions");
  assert.deepEqual(deepseekBody.thinking, { type: "disabled" });
  assert.equal(deepseekBody.reasoning_effort, undefined);
  assert.match(deepseekBody.messages[0].content, /id\|translation/, "要求按紧凑行格式回复");
});

test("Claude request uses the Messages API with structured output", () => {
  const batch = [{ id: 3, text: "hello" }];
  batch.context = ["before"];
  const languages = { source: "en", target: "zh-Hans" };
  const haiku = Core.createClaudeRequest(
    Core.normalizeConfig({ model: "claude-haiku-4-5", claude_api_key: "c" }), batch, languages, true
  );
  const body = JSON.parse(haiku.body);
  assert.equal(haiku.url, "https://api.anthropic.com/v1/messages");
  assert.equal(haiku.headers["x-api-key"], "c");
  assert.equal(haiku.headers["anthropic-version"], "2023-06-01");
  assert.equal(body.model, "claude-haiku-4-5");
  assert.equal(body.messages[0].role, "user");
  assert.equal(body.messages[0].content, "Source: en\nTarget: zh-Hans\n-|before\n3|hello");
  assert.equal(body.output_config.format.type, "json_schema");
  assert.equal(body.output_config.format.schema.additionalProperties, false);
  assert.equal(body.output_config.format.schema.properties.translations.items.additionalProperties, false);
  assert.equal(body.output_config.effort, undefined, "Haiku 4.5 不接受 effort");
  assert.equal(body.thinking, undefined);

  const sonnet = JSON.parse(
    Core.createClaudeRequest(Core.normalizeConfig({ model: "claude-sonnet-5-5", claude_api_key: "c" }), batch, languages, false).body
  );
  assert.equal(sonnet.output_config.effort, "low");
  assert.equal(sonnet.output_config.format, undefined);

  const parsed = Core.parseClaudeResponse(
    JSON.stringify({
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify({ translations: [{ id: 3, text: "你好" }] }) }]
    })
  );
  assert.deepEqual(parsed.translations, [{ id: 3, text: "你好" }]);
  assert.throws(
    () => Core.parseClaudeResponse(JSON.stringify({ stop_reason: "refusal", content: [] })),
    /declined/
  );
});

test("built-in prompt covers subtitle style without needing a custom prompt", () => {
  const { system } = Core.buildPrompts([{ id: 0, text: "x" }], "en", "zh-Hans", "");
  assert.match(system, /native speaker/);
  assert.match(system, /brand and product names/);
  assert.match(system, /misheard/);
  assert.match(system, /\[Music\]/);
  assert.match(system, /untrusted data/);
  assert.doesNotMatch(system, /Additional user preference/);
  assert.match(Core.buildPrompts([{ id: 0, text: "x" }], "en", "zh-Hans", "人名保留英文").system, /Additional user preference: 人名保留英文/);
});

function rollingAsrSrv3() {
  const lines = [
    "We started the trip early in the morning. The road was\nempty and quiet",
    "for a long time. Then we saw the lake. It was bigger than\nwe expected, and",
    "the water was very clear. Mr. Lee said it was the best\nview of the year.",
    "Yeah. After lunch we walked around the lake for about\n2.5 hours, and by the",
    "end everyone was tired but happy. [music] We drove home\nbefore sunset."
  ];
  const body = lines
    .map((text, index) => `<p t="${index * 4000}" d="6000" w="1"><s ac="0">${text}</s></p>`)
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8" ?><timedtext format="3">\n<head>\n<ws id="1" mh="2" ju="0" sd="3"/>\n</head>\n<body>\n<w t="0" id="1" wp="2" ws="1"/>\n${body}\n</body>\n</timedtext>`;
}

test("auto captions are regrouped into whole sentences with non-overlapping timing", () => {
  const document = Core.parseSubtitleDocument(rollingAsrSrv3(), "text/xml");
  const regrouped = Core.resegmentDocument(document);
  assert.equal(regrouped.resegmented, true);
  const texts = regrouped.cues.map((cue) => cue.text);
  assert.deepEqual(texts, [
    "We started the trip early in the morning.",
    "The road was empty and quiet for a long time.",
    "Then we saw the lake.",
    "It was bigger than we expected, and the water was very clear.",
    "Mr. Lee said it was the best view of the year.",
    "Yeah. After lunch we walked around the lake for about 2.5 hours,",
    "and by the end everyone was tired but happy.",
    "[music] We drove home before sunset."
  ].map((text) => text));
  regrouped.cues.forEach((cue, index) => {
    const next = regrouped.cues[index + 1];
    assert.ok(cue.durationMs > 0, `第 ${index} 条时长为正`);
    if (next) {
      assert.ok(cue.startMs < next.startMs, "开始时间递增");
      assert.ok(cue.startMs + cue.durationMs <= next.startMs, "不和下一句重叠");
    }
  });
  const words = (list) => list.map((text) => text.replace(/\n/g, " ")).join(" ").split(/\s+/);
  assert.deepEqual(words(texts), words(document.cues.map((cue) => cue.text)));
});

test("long sentences split at a comma and stay within the length limit", () => {
  const long =
    "When we finally reached the top of the hill after walking for most of the afternoon, " +
    "the wind was so strong that nobody could hear anything anyone else was trying to say to them.";
  const xml = `<?xml version="1.0"?><timedtext format="3"><body>` +
    `<p t="0" d="5000"><s>${long.slice(0, long.indexOf(" ", 75))}</s></p>` +
    `<p t="5000" d="5000"><s>${long.slice(long.indexOf(" ", 75) + 1)} Then it rained.</s></p>` +
    `<p t="10000" d="3000"><s>We ran. It was fun. Really fun.</s></p></body></timedtext>`;
  const regrouped = Core.resegmentDocument(Core.parseSubtitleDocument(xml, "text/xml"));
  assert.equal(regrouped.resegmented, true);
  assert.ok(regrouped.cues.every((cue) => cue.text.length <= 90), regrouped.cues.map((c) => c.text.length).join(","));
  assert.match(regrouped.cues[0].text, /afternoon,$/);
});

test("captions without sentence punctuation keep their original cues", () => {
  const xml = '<?xml version="1.0"?><timedtext format="3"><body>' +
    ["For a long time", "we did not know", "what to do next", "So we waited"]
      .map((text, index) => `<p t="${index * 1500}" d="1400" wp="1">${text}</p>`)
      .join("") + "</body></timedtext>";
  const document = Core.parseSubtitleDocument(xml, "text/xml");
  assert.equal(Core.resegmentDocument(document), document);
});

test("regrouped srv3 renders one sentence per paragraph and drops the rolling window", () => {
  const regrouped = Core.resegmentDocument(Core.parseSubtitleDocument(rollingAsrSrv3(), "text/xml"));
  const out = Core.renderSubtitleDocument(
    regrouped,
    [{ id: 0, text: "我们一早就出发了。" }, { id: 2, text: "然后我们看到了湖。" }],
    { position: "SourceFirst", showOnly: false }
  );
  const paragraphs = [...out.matchAll(/<p t="(\d+)" d="(\d+)"><s>(.*?)<\/s><\/p>/g)];
  assert.equal(paragraphs.length, regrouped.cues.length);
  assert.equal(paragraphs[0][3], "We started the trip early in the morning.&#10;我们一早就出发了。");
  assert.equal(paragraphs[1][3], "The road was empty and quiet for a long time.", "没翻到的句子只显示原文");
  assert.doesNotMatch(out, /<w |w="1"/);
  assert.match(out, /<head>[\s\S]*<\/head>/, "保留 head");
});

test("regrouped json3 keeps window definitions and replaces text events", () => {
  const json = JSON.stringify({
    events: [
      { tStartMs: 0, dDurationMs: 20000, id: 1, wpWinPosId: 1, wsWinStyleId: 1 },
      { tStartMs: 0, dDurationMs: 5000, wWinId: 1, segs: [{ utf8: "It was late. We" }, { utf8: " went", tOffsetMs: 300 }] },
      { tStartMs: 4800, dDurationMs: 300, wWinId: 1, aAppend: 1, segs: [{ utf8: "\n" }] },
      { tStartMs: 5000, dDurationMs: 5000, wWinId: 1, segs: [{ utf8: "home together. Then it rained." }] }
    ]
  });
  const regrouped = Core.resegmentDocument(Core.parseSubtitleDocument(json, "application/json"));
  assert.deepEqual(regrouped.cues.map((cue) => cue.text), ["It was late.", "We went home together.", "Then it rained."]);
  const out = JSON.parse(Core.renderSubtitleDocument(regrouped, [{ id: 1, text: "我们一起回家。" }], { position: "SourceFirst" }));
  assert.equal(out.events[0].id, 1, "窗口定义保留");
  assert.deepEqual(out.events.slice(1).map((event) => event.segs[0].utf8), [
    "It was late.",
    "We went home together.\n我们一起回家。",
    "Then it rained."
  ]);
});

test("compact line replies are parsed, with JSON as a fallback", () => {
  const parsed = Core.parseTranslationText("```\n12|第一句\n13｜第二句\n这是第二句被折行的部分\n-|上下文不应出现\n\n14|第三|句\n```");
  assert.deepEqual(parsed.translations, [
    { id: 12, text: "第一句" },
    { id: 13, text: "第二句 这是第二句被折行的部分" },
    { id: 14, text: "第三|句" }
  ]);
  const json = Core.parseTranslationText('{"translations":[{"id":3,"text":"你好"}]}');
  assert.deepEqual(json.translations, [{ id: 3, text: "你好" }]);
  assert.throws(() => Core.parseTranslationText("抱歉，我无法翻译。"), SyntaxError);
});

test("compact prompt is much shorter than the old JSON rows", () => {
  const batch = Array.from({ length: 30 }, (_, id) => ({ id: 1000 + id, text: `We walked around the lake number ${id}` }));
  const { user } = Core.buildPrompts(batch, "en", "zh-Hans", "");
  const oldStyle = JSON.stringify({ source_language: "en", target_language: "zh-Hans", subtitles: batch.map(({ id, text }) => ({ id, text })) });
  assert.ok(user.length < oldStyle.length * 0.8, `${user.length} vs ${oldStyle.length}`);
  const reply = batch.map(({ id }) => `${id}|我们绕着湖走了一圈`).join("\n");
  const oldReply = JSON.stringify({ translations: batch.map(({ id }) => ({ id, text: "我们绕着湖走了一圈" })) });
  assert.ok(reply.length < oldReply.length * 0.6, `${reply.length} vs ${oldReply.length}`);
});

test("videos already in the target language are translated into the secondary language", () => {
  const config = Core.normalizeConfig({ api_key: "k", model: "m", target_language: "简体中文" });
  assert.equal(config.secondaryLanguage, "en", "默认第二语言是英语");
  const chinese = Core.rewriteTimedTextRequest("https://www.youtube.com/api/timedtext?v=a&lang=zh-Hans&fmt=srv3", config);
  assert.equal(new URL(chinese.url).searchParams.get("dsai_target"), "en");
  const traditional = Core.rewriteTimedTextRequest("https://www.youtube.com/api/timedtext?v=a&lang=zh-TW&fmt=srv3", config);
  assert.equal(new URL(traditional.url).searchParams.get("dsai_target"), "en");
  const english = Core.rewriteTimedTextRequest("https://www.youtube.com/api/timedtext?v=a&lang=en&fmt=srv3", config);
  assert.equal(new URL(english.url).searchParams.get("dsai_target"), "zh-Hans", "英文视频照旧翻成中文");

  const japaneseSecondary = Core.normalizeConfig({ api_key: "k", model: "m", target_language: "简体中文", secondary_language: "日本語" });
  const toJa = Core.rewriteTimedTextRequest("https://www.youtube.com/api/timedtext?v=a&lang=zh-Hans", japaneseSecondary);
  assert.equal(new URL(toJa.url).searchParams.get("dsai_target"), "ja");

  const same = Core.normalizeConfig({ api_key: "k", model: "m", target_language: "简体中文", secondary_language: "繁體中文" });
  const skipped = Core.rewriteTimedTextRequest("https://www.youtube.com/api/timedtext?v=a&lang=zh-Hans", same);
  assert.equal(skipped.reason, "same-language");
  assert.equal(new URL(skipped.url).searchParams.has("dsai"), false);
});

test("subtitle language is detected from the text when the URL does not say", () => {
  const zh = [{ text: "今天我们来看看这个东西到底怎么用" }, { text: "首先打开设置" }];
  const ja = [{ text: "今日はこれを使ってみましょう" }];
  const ko = [{ text: "오늘은 이것을 사용해 보겠습니다" }];
  const en = [{ text: "Today we look at how this works" }];
  assert.equal(Core.detectLanguage(zh), "zh");
  assert.equal(Core.detectLanguage(ja), "ja");
  assert.equal(Core.detectLanguage(ko), "ko");
  assert.equal(Core.detectLanguage(en), "");
  const config = Core.normalizeConfig({ api_key: "k", model: "m", target_language: "简体中文" });
  const url = "https://www.youtube.com/api/timedtext?v=a&dsai=1&dsai_target=zh-Hans";
  assert.deepEqual(Core.responseLanguages(url, config, zh), { source: "zh", target: "en" });
  assert.deepEqual(Core.responseLanguages(url, config, en), { source: "auto", target: "zh-Hans" });
});
