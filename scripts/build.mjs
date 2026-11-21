import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const scriptUrlIndex = args.indexOf("--script-url");
const defaultRemoteScriptUrl =
  "https://raw.githubusercontent.com/Wu2200/Youtube-Translate/main/dist/dualsubs-ai.bundle.js";
const remoteScriptUrl =
  scriptUrlIndex >= 0 ? args[scriptUrlIndex + 1] : defaultRemoteScriptUrl;

if (scriptUrlIndex >= 0 && !remoteScriptUrl) {
  throw new Error("--script-url requires an HTTPS URL");
}
if (remoteScriptUrl && !/^https:\/\//i.test(remoteScriptUrl)) {
  throw new Error("--script-url must use HTTPS");
}

const pkg = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
const core = await readFile(resolve(projectRoot, "src/yt-ai-core.js"), "utf8");
const loon = await readFile(resolve(projectRoot, "src/yt-ai-loon.js"), "utf8");
const pluginTemplate = await readFile(
  resolve(projectRoot, "template/YouTube.AI.Translate.plugin"),
  "utf8"
);

const banner = [
  `// YouTube AI bilingual subtitles for Loon / Quantumult X v${pkg.version}`,
  "// Translates the source timedtext response with AI; untranslated rows stay as source text.",
  "// Only intercepts /api/timedtext so it can run alongside YouTube ad-block plugins.",
  "// Never logs API keys or full subtitle payloads.",
  ""
].join("\n");
const bundle = `${banner}${core.trim()}\n\n${loon.trim()}\n`;
const sha256 = createHash("sha256").update(bundle).digest("hex");
const distDir = resolve(projectRoot, "dist");
await mkdir(distDir, { recursive: true });
await writeFile(resolve(distDir, "dualsubs-ai.bundle.js"), bundle);
await writeFile(resolve(distDir, "yt-ai.bundle.js"), bundle);

const localPlugin = pluginTemplate
  .replaceAll("{{SCRIPT_URL}}", "dualsubs-ai.bundle.js")
  .replace(/^#!version\s*=.*$/m, `#!version = ${pkg.version}`);
await writeFile(resolve(distDir, "DualSubs.AI.YouTube.local.plugin"), localPlugin);
await writeFile(resolve(distDir, "YouTube.AI.Translate.local.plugin"), localPlugin);

const remotePlugin = pluginTemplate
  .replaceAll("{{SCRIPT_URL}}", remoteScriptUrl)
  .replace(/^#!version\s*=.*$/m, `#!version = ${pkg.version}`);
await writeFile(resolve(distDir, "DualSubs.AI.YouTube.remote.plugin"), remotePlugin);
await writeFile(resolve(distDir, "YouTube.AI.Translate.remote.plugin"), remotePlugin);

const qxRewrite = [
  `#!name=YouTube AI 双语字幕 (Quantumult X) v${pkg.version}`,
  "#!desc=拦截 YouTube 字幕并使用 AI 翻译为双语字幕。请在「持久化数据」中添加 yt_ai_config（1 条 Key 配置全部参数）或 yt_ai_url / yt_ai_model / yt_ai_key。",
  "",
  `^https?:\\/\\/(www|m)\\.youtube\\.com\\/api\\/timedtext(\\?.+)?$ url script-request-header ${remoteScriptUrl}`,
  `^https?:\\/\\/(www|m)\\.youtube\\.com\\/api\\/timedtext(\\?.+)?$ url script-response-body ${remoteScriptUrl}`,
  `^https?:\\/\\/s\\.youtube\\.com\\/api\\/stats\\/(watchtime|qoe|playback)(\\?.*)?$ url script-request-header ${remoteScriptUrl}`,
  "",
  "hostname = www.youtube.com, m.youtube.com, s.youtube.com",
  ""
].join("\n");
await writeFile(resolve(distDir, "YouTube.AI.Translate.qx.conf"), qxRewrite);

await writeFile(
  resolve(distDir, "manifest.json"),
  `${JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      bundle: "dualsubs-ai.bundle.js",
      sha256,
      upstream: {
        youtube: "v1.5.11",
        universalReference: "v1.7.5"
      },
      localPlugin: "DualSubs.AI.YouTube.local.plugin",
      remotePlugin: "DualSubs.AI.YouTube.remote.plugin",
      qxRewrite: "YouTube.AI.Translate.qx.conf",
      scriptUrl: remoteScriptUrl,
      compatibility: {
        bundle: "yt-ai.bundle.js",
        localPlugin: "YouTube.AI.Translate.local.plugin",
        remotePlugin: "YouTube.AI.Translate.remote.plugin"
      }
    },
    null,
    2
  )}\n`
);

console.log(`Built ${pkg.name} v${pkg.version}`);
console.log(`Bundle SHA-256: ${sha256}`);
