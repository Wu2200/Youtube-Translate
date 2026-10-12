const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");

test("generated bundle hash matches manifest and contains both runtimes", async () => {
  const [bundle, legacyBundle, manifestText] = await Promise.all([
    readFile(path.join(projectRoot, "dist/dualsubs-ai.bundle.js"), "utf8"),
    readFile(path.join(projectRoot, "dist/yt-ai.bundle.js"), "utf8"),
    readFile(path.join(projectRoot, "dist/manifest.json"), "utf8")
  ]);
  const manifest = JSON.parse(manifestText);
  const digest = createHash("sha256").update(bundle).digest("hex");
  assert.equal(digest, manifest.sha256);
  assert.equal(manifest.upstream.youtube, "v1.5.11");
  assert.equal(manifest.upstream.universalReference, "v1.7.5");
  assert.equal(legacyBundle, bundle);
  assert.equal(manifest.compatibility.bundle, "yt-ai.bundle.js");
  assert.match(bundle, /function createYouTubeAICore/);
  assert.match(bundle, /function runDualSubsAITranslator/);
  assert.doesNotMatch(bundle, /test-secret|openai-secret|gemini-secret/);
});

test("existing public subscription filenames remain valid and use the new runtime", async () => {
  const [remotePlugin, legacyRemotePlugin, localPlugin, legacyLocalPlugin] =
    await Promise.all([
      readFile(
        path.join(projectRoot, "dist/DualSubs.AI.YouTube.remote.plugin"),
        "utf8"
      ),
      readFile(
        path.join(projectRoot, "dist/YouTube.AI.Translate.remote.plugin"),
        "utf8"
      ),
      readFile(
        path.join(projectRoot, "dist/DualSubs.AI.YouTube.local.plugin"),
        "utf8"
      ),
      readFile(
        path.join(projectRoot, "dist/YouTube.AI.Translate.local.plugin"),
        "utf8"
      )
    ]);

  assert.equal(legacyRemotePlugin, remotePlugin);
  assert.equal(legacyLocalPlugin, localPlugin);
  assert.match(remotePlugin, /^#!version = 0\\.10\\.0$/m);
  const manifest = JSON.parse(
    await readFile(path.join(projectRoot, "dist/manifest.json"), "utf8")
  );
  assert.match(
    manifest.scriptUrl,
    /^https:\\/\\/raw\\.githubusercontent\\.com\\/Wu2200\\/Youtube-Translate\\/main\\/dist\\/dualsubs-ai\\.bundle\\.js$/
  );
  assert.ok(remotePlugin.includes(`script-path=${manifest.scriptUrl},`));
  const responseRule = remotePlugin
    .split("\\n")
    .find(
      (line) =>
        line.startsWith("http-response ") &&
        line.includes("\\/api\\/timedtext")
    );
  assert.ok(responseRule);
  assert.doesNotMatch(responseRule, /subtype=Official/);
  assert.match(responseRule, /timedtext\\(\\\\\\?\\.\\+\\)\\?\\$/);
});

test("local plugin exposes only custom OpenAI-compatible settings", async () => {
  const plugin = await readFile(
    path.join(projectRoot, "dist/DualSubs.AI.YouTube.local.plugin"),
    "utf8"
  );
  const definitions = new Set(
    [...plugin.matchAll(/^([A-Za-z_]+)\\s*=\\s*(?:input|select|switch),/gm)].map(
      (match) => match[1]
    )
  );
  const scriptLines = plugin
    .split("\\n")
    .filter((line) => line.startsWith("http-"));
  for (const line of scriptLines) {
    for (const match of line.matchAll(/\\{([A-Za-z_]+)\\}/g)) {
      assert.equal(definitions.has(match[1]), true, `missing argument ${match[1]}`);
    }
  }

  assert.doesNotMatch(plugin, /\\{\\{SCRIPT_URL\\}\\}/);
  assert.match(plugin, /script-path=dualsubs-ai\\.bundle\\.js/);
  assert.doesNotMatch(plugin, /Gemini|DeepSeek|Claude|deepseek_api_key|openai_api_key|claude_api_key/);
  assert.match(plugin, /^provider = select,"OpenAI-Compatible"/m);
  assert.match(plugin, /^model = input,"gpt-4o-mini"/m);
  assert.match(plugin, /^base_url = input,/m);
  assert.match(plugin, /^api_key = input,/m);
  assert.deepEqual(
    [...definitions].sort(),
    [
      "LogLevel",
      "Position",
      "ShowOnly",
      "ai_enabled",
      "api_key",
      "background_translate",
      "base_url",
      "custom_prompt",
      "model",
      "provider",
      "secondary_language",
      "sentence_split",
      "target_language"
    ]
  );
  assert.match(plugin, /^target_language = select,"简体中文",/m);
  assert.match(plugin, /^Position = select,"原文在上","译文在上"/m);
  assert.doesNotMatch(plugin, /subtype=Official|tlang=/);
  assert.doesNotMatch(plugin.split("[MITM]")[1], /googlevideo/);
  assert.ok(scriptLines.every((line) => !/googlevideo/.test(line)));
  assert.deepEqual(
    scriptLines.map((line) => line.split(" ")[1]),
    [
      "^https?:\\\\/\\\\/(www|m)\\\\.youtube\\\\.com\\\\/api\\\\/timedtext(\\\\?.+)?$",
      "^https?:\\\\/\\\\/(www|m)\\\\.youtube\\\\.com\\\\/api\\\\/timedtext(\\\\?.+)?$",
      "^https?:\\\\/\\\\/s\\\\.youtube\\\\.com\\\\/api\\\\/stats\\\\/(watchtime|qoe|playback)(\\\\?.*)?$"
    ]
  );
  assert.match(plugin, /^hostname = www\\.youtube\\.com, m\\.youtube\\.com, s\\.youtube\\.com$/m);
  const rules = plugin.split("[Rule]")[1].split("[Script]")[0].split("\\n").filter((line) => line && !line.startsWith("#"));
  assert.deepEqual(rules, [
    "AND,((PROTOCOL,QUIC),(DOMAIN-SUFFIX,youtube.com)),REJECT",
    "AND,((PROTOCOL,QUIC),(DOMAIN-SUFFIX,googlevideo.com)),REJECT",
    "AND,((PROTOCOL,QUIC),(DOMAIN,youtubei.googleapis.com)),REJECT"
  ]);
  const timedTextResponseRule = plugin
    .split("\\n")
    .find(
      (line) =>
        line.startsWith("http-response ") &&
        line.includes("\\/api\\/timedtext")
    );
  assert.ok(timedTextResponseRule);
});
