const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");

async function readArtifact(name) {
  return readFile(path.join(projectRoot, name), "utf8");
}

test("generated bundle hash matches manifest and contains both runtimes", async () => {
  const [bundle, legacyBundle, manifestText] = await Promise.all([
    readArtifact("dist/dualsubs-ai.bundle.js"),
    readArtifact("dist/yt-ai.bundle.js"),
    readArtifact("dist/manifest.json")
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
  assert.match(bundle, /const MIN_MODEL_REQUEST_TIMEOUT_MS = 8000;/);
  assert.doesNotMatch(bundle, /test-secret|openai-secret|gemini-secret/);
});

test("published plugin artifacts use matching escaped URLs and custom OpenAI settings", async () => {
  const [remotePlugin, legacyRemotePlugin, localPlugin, legacyLocalPlugin, manifestText] = await Promise.all([
    readArtifact("dist/DualSubs.AI.YouTube.remote.plugin"),
    readArtifact("dist/YouTube.AI.Translate.remote.plugin"),
    readArtifact("dist/DualSubs.AI.YouTube.local.plugin"),
    readArtifact("dist/YouTube.AI.Translate.local.plugin"),
    readArtifact("dist/manifest.json")
  ]);
  const manifest = JSON.parse(manifestText);
  assert.equal(legacyRemotePlugin, remotePlugin);
  assert.equal(legacyLocalPlugin, localPlugin);
  assert.match(remotePlugin, /^#!version = 0\.10\.0$/m);
  assert.equal(
    manifest.scriptUrl,
    "https://raw.githubusercontent.com/Wu2200/Youtube-Translate/main/dist/dualsubs-ai.bundle.js"
  );
  assert.ok(remotePlugin.includes(`script-path=${manifest.scriptUrl},`));
  assert.ok(localPlugin.includes("script-path=dualsubs-ai.bundle.js,"));
  assert.doesNotMatch(remotePlugin, /\{\{SCRIPT_URL\}\}/);

  const expectedPatterns = [
    "^https?:\\/\\/(www|m)\\.youtube\.com\\/api\\/timedtext(\\?.+)?$",
    "^https?:\\/\\/(www|m)\\.youtube\.com\\/api\\/timedtext(\\?.+)?$",
    "^https?:\\/\\/s\\.youtube\.com\\/api\\/stats\\/(watchtime|qoe|playback)(\\?.*)?$"
  ];
  for (const plugin of [remotePlugin, localPlugin]) {
    const scriptLines = plugin.split(/\r?\n/).filter((line) => line.startsWith("http-"));
    assert.deepEqual(scriptLines.map((line) => line.split(" ")[1]), expectedPatterns);
    assert.match(scriptLines[0], /timeout=10,/);
    assert.match(scriptLines[1], /timeout=10,/);
    assert.match(scriptLines[2], /timeout=42,/);
    const definitions = new Set(
      [...plugin.matchAll(/^([A-Za-z_]+)\s*=\s*(?:input|select|switch),/gm)].map(
        (match) => match[1]
      )
    );
    for (const line of scriptLines) {
      for (const match of line.matchAll(/\{([A-Za-z_]+)\}/g)) {
        assert.equal(definitions.has(match[1]), true, `missing argument ${match[1]}`);
      }
    }
    assert.doesNotMatch(plugin.split("[Argument]")[1].split("[Rule]")[0], /Gemini|DeepSeek|Claude|deepseek_api_key|openai_api_key|claude_api_key/);
    assert.match(plugin, /^provider = select,"OpenAI-Compatible"/m);
    assert.match(plugin, /^model = input,"gpt-4o-mini"/m);
    assert.match(plugin, /^base_url = input,/m);
    assert.match(plugin, /^api_key = input,/m);
    assert.match(plugin, /^hostname = www\.youtube\.com, m\.youtube\.com, s\.youtube\.com$/m);
  }
});
