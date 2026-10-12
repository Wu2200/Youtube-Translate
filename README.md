# YouTube AI 双语字幕（Loon 插件）

在 iPhone / iPad 的 YouTube App 里，用 AI 把字幕翻成双语：一行原文，一行译文。支持 Gemini、DeepSeek、OpenAI、Claude。

- 字幕成功加载并解析后，最多用 10 秒进行首次翻译；时间到先返回已完成的译文，其余内容由后台续翻
- 某一批失败或模型漏了几行时，时间够就当场重发一次，尽量第一次就翻完
- 长视频第一次只能翻开头一部分，没翻到的行先显示原文；看视频时插件会在后台接着翻，翻完通知你，重新打开视频即可看到完整双语字幕
- 翻好的结果会缓存，同一个视频再看不用重新翻
- 只需要所选模型那一家的 API Key，不需要部署任何服务

## 安装

1. [一键导入 Loon](https://www.nsloon.com/openloon/import?plugin=https%3A%2F%2Fraw.githubusercontent.com%2Fbaitao24%2Floon-youtube-ai-translator%2Fmain%2Fdist%2FYouTube.AI.Translate.remote.plugin)，或手动添加订阅地址：
   `https://raw.githubusercontent.com/baitao24/loon-youtube-ai-translator/main/dist/YouTube.AI.Translate.remote.plugin`
2. 确认 Loon 已开启 MITM 并信任证书。
3. 在插件设置里选模型，并填写对应那一家的 API Key（见下方「模型与 API Key」）。
4. 关闭其他会处理 YouTube 字幕的插件（DualSubs、旧版翻译插件等），否则会重复处理同一条字幕请求。

可以和 YouTube 去广告插件一起用：本插件只拦截字幕接口 `/api/timedtext`，不碰 `player`、`get_watch` 等去广告插件需要处理的接口。

插件还带了三条规则，拒绝 YouTube 相关域名（`youtube.com`、`googlevideo.com`、`youtubei.googleapis.com`）的 QUIC 连接。YouTube 走 QUIC 时 Loon 无法解密，字幕、观看统计和去广告脚本都会被绕过，表现为偶尔只有英文字幕或偶尔漏广告。被拒后 App 会自动改走普通连接，其他 App 不受影响。

切换视频时，前一个视频还没发出的翻译请求会立即停止，后台续翻也会让路 30 秒，把 Loon 的处理能力留给新视频和去广告插件。

## 设置项

| 设置 | 说明 |
| --- | --- |
| AI 翻译 | 总开关。关闭后只显示 YouTube 原文字幕 |
| 模型 | 下拉选择，服务商按模型名自动判断，见下方「模型与 API Key」 |
| Gemini / DeepSeek / OpenAI / Claude API Key | 只填所选模型那一家的。Key 只保存在本机 Loon 里，建议在服务商后台设置用量上限 |
| 翻译成 | 简体中文、繁體中文、日本語、한국어、English。在 YouTube 字幕菜单里选了「自动翻译」成某种语言时，以菜单为准 |
| 同语言视频翻译成 | 默认 English。视频本身就是「翻译成」的语言时（比如设成简体中文、看中文视频），改翻成这个语言 |
| 字幕顺序 | 原文在上 / 译文在上 |
| 只显示译文 | 开启后不显示原文 |
| 播放时后台续翻 | 默认开启。长视频第一次没翻完时，看视频期间在后台接着翻（见下方）。中途不看的视频也可能被翻完，会多用一些 API 额度 |
| 按句断句 | 默认开启。自动字幕常把上一句结尾和下一句开头放在同一条里，开启后按句子重新分条（见下方）。显示异常时可关闭 |
| 额外翻译要求 | 一般留空即可，常用要求已内置（见下方）。有个人偏好时再填，例如“游戏术语保留英文”“称呼统一用‘你’” |
| 日志等级 | 排查问题时用；日志不记录 API Key 和字幕全文 |

## 模型与 API Key

| 服务商 | 可选模型 | 填哪个 Key | 在哪创建 |
| --- | --- | --- | --- |
| Gemini | `gemini-3.5-flash-lite`（默认）、`gemini-3.1-flash-lite`、`gemini-flash-lite-latest`、`gemini-2.5-flash-lite`、`gemini-3.5-flash`、`gemini-3.8-flash` | Gemini API Key | [Google AI Studio](https://aistudio.google.com/apikey) |
| DeepSeek | `deepseek-flash`、`deepseek-v4-pro` | DeepSeek API Key | [DeepSeek 开放平台](https://platform.deepseek.com/api_keys) |
| OpenAI | `gpt-5.4-nano`、`gpt-5.4-mini` | OpenAI API Key | [OpenAI Platform](https://platform.openai.com/api-keys) |
| Claude | `claude-haiku-4-5`、`claude-sonnet-5-5` | Claude API Key | [Claude Platform](https://platform.claude.com/settings/keys) |

带 lite、nano、haiku 的模型和 `deepseek-flash` 是快速模型，适合字幕；其他模型翻得更细，但更慢，长视频第一次开字幕能翻到的部分会少一些。目前只有默认的 Gemini 3.5 Flash-Lite 做过真机测速。

内置的翻译要求：译成母语者会说的自然字幕，而不是逐字直译；人名、品牌、产品名、代码和命令保留原文（有通用译名的除外）；数字、单位准确；不加注释；自动字幕里的听错词按上下文推断原意；`[Music]` 这类音效标注译成简短的方括号标注。

每家的「思考/推理」模式都会关掉或调到最低（Gemini 用最低思考档、DeepSeek 关闭思考、GPT 设为不推理、Claude Sonnet 用 low），因为字幕翻译要的是速度。

## 工作原理

YouTube App 开字幕时会一次性请求整份字幕（`/api/timedtext`）。插件在 Loon 里拦截这份字幕，交给 Gemini 翻译，再改写成双语返回给 App。

几个关键限制，都是真机实测得到的（2026-10）：

| 实测项 | 结果 | 插件的做法 |
| --- | --- | --- |
| YouTube App 等字幕的上限 | 7 秒能显示，8 秒报错 | 最多用 6.2 秒，到点就带着已翻好的部分返回 |
| Gemini 3.5 Flash-Lite 速度 | 30 条一批约 2.5～3 秒 | 每批 30 条，按时间顺序翻，开头最先翻好 |
| Loon 同时在途的请求数 | 约 8 个，再多会排队 | 并发 8 |
| 模型偶尔少返回一行，或某批限流/报错 | 约每 20 批 1 次 | 按行校验，其余照用；漏掉的行和失败的批次在时间够时重发一次 |
| 不同模型速度差很多 | 慢模型 30 条一批会超时 | 按每个模型的实测速度自动调整每批条数（8～40 条），目标每批约 3 秒 |
| YouTube 官方机翻（`tlang` 参数） | 一律返回 429 拦截页 | 不再请求官方机翻，并去掉 App 自带的 `tlang` |

按 Gemini 3.5 Flash-Lite 的速度，一次开字幕大约能翻 400～500 条，相当于视频开头 15～20 分钟。慢一些的模型第一次能翻到的部分会少，但批次会自动变小，重新打开视频几次也能翻完。

### 自动识别字幕语言

插件优先用 YouTube 字幕地址里的语言（`lang=en`、`lang=zh-Hans` 等）判断原文语言；地址里没有时，按字幕里汉字、假名、韩文的比例识别。

- 英文等外语视频：翻成「翻译成」选的语言（默认简体中文）
- 中文视频（与「翻译成」同语言）：翻成「同语言视频翻译成」选的语言（默认 English）
- 字幕顺序设置对两种视频都生效，例如「原文在上」时，英文视频是英文在上、中文在下；中文视频是中文在上、英文在下
- 如果第二语言也和视频语言相同，就不翻译，只显示原文

### 后台续翻

YouTube App 每次加载字幕只请求一次、只等约 7 秒，所以长视频第一次只能翻开头一部分（约 10～15 分钟）。在播放器里开关字幕不会让 App 重新请求。

开启「播放时后台续翻」后：

- 第一次没翻完时，插件把这个视频的原文和进度存成一个后台任务（只保留最近 2 个，3 小时后作废）
- 播放时 App 会定期发送观看统计请求（`s.youtube.com/api/stats/watchtime`、`qoe`、`playback`）。插件借这些请求，每次最多用约 20 秒在后台接着翻，同一时间只跑一个任务
- 翻完后弹出「后台翻译完成」通知；退出视频再重新打开，直接从缓存显示完整双语字幕，不再调用 API

按 Gemini 3.5 Flash-Lite 的速度模拟，60 分钟视频在第一次统计请求时就能翻完剩余部分。不会碰去广告插件拦截的 `stats/ads`。

### 按句断句

YouTube 自动字幕按约 80 个字符硬切，常出现一条里是“上一句结尾 + 下一句开头”的情况，读起来别扭，翻译也容易生硬。开启「按句断句」后：

- 把字幕拆成词，按每条的时间段和字数估算每个词的时间
- 在句号、问号、感叹号处断开（不会在 `Mr.`、`e.g.`、`2.5` 这类地方断）
- 超过约 90 个字符的长句，在逗号或 and、but 等连词前再切一次；`Yeah.` 这类很短的语气词并到下一句
- 每条从句子开头出现，显示到下一句出现为止，前后不重叠

几乎没有句末标点的字幕（多数人工字幕本来就是一小段一小段的）保持原样。词的时间是估算的，可能比实际说话早或晚零点几秒。

每批还会附带前两行原文作为上下文，避免一句话被切在两批之间时译得生硬。

插件只处理字幕请求，不修改播放信息。0.5.0 及以前会顺带加载 DualSubs 的播放器脚本，它和去广告插件拦截同一批接口，会让去广告失效，0.5.1 起已移除。YouTube App 会记住上次是否开着字幕，一般不需要自动打开。

## 常见问题

**怎么确认是 AI 翻的？**
插件不使用任何机器翻译。屏幕上出现的译文都来自你选的 AI 模型；没翻到的行只显示原文。

**换了模型后，只翻了开头一小段？**
慢模型第一次会按保守的批次大小试翻，并记下实测速度，之后自动缩小批次。重新打开视频一两次就会好转。如果一直不翻，检查是否填了这个模型对应那一家的 Key。

**长视频后半段只有英文？**
开着「播放时后台续翻」时，继续看一会儿，等「后台翻译完成」通知后退出视频再重新打开即可。Loon 日志里的 `Playback ping ...` 行表示插件收到了观看统计请求，`Background translated N rows` 表示后台翻了多少。

如果关掉了后台续翻：
第一次开字幕的时间只够翻开头一部分。翻好的部分会保存，**重新打开这个视频**时插件只翻剩下的行，通常两三次就能翻完，之后直接用缓存。

只在播放器里关掉再打开字幕通常没用：实测 YouTube App 这时会直接用已经加载的字幕，不会重新请求，插件没有机会接着翻。

**装了本插件后去广告失效？**
请更新到 0.5.1 或更高版本。旧版本带有 DualSubs 播放器脚本，会和去广告插件抢同一批接口。

**选了模型，字幕却只有英文？**
多半是没填这个模型对应那一家的 Key。插件会弹通知「缺少 API Key」，并写明需要哪一家的 Key。

**字幕显示 error loading？**
先确认 MITM 证书已信任、没有其他字幕插件同时启用。然后在 Loon 的脚本日志里找「AI 字幕响应」，把日志截图用于排查。

**日志怎么看？**
「AI 字幕响应」的日志里有一行类似：

```
AI rows 448/1422 (31%), new 448, failed batches 0, 5711ms
```

依次是已翻行数 / 总行数、本次新翻的行数、失败的批次数、耗时。有失败批次时，行尾会附上第一个失败原因。上面一行 `AI translating ... in N batch(es) of M via ...` 里的 M 是这次每批的条数。

响应头 `x-dualsubs-ai-result` 标明结果：

| 值 | 含义 |
| --- | --- |
| `ai` | 全部由 AI 翻译 |
| `ai-partial` | 部分由 AI 翻译，其余显示原文 |
| `cache-ai` | 命中缓存 |
| `source-only` | AI 未启用、未配置或失败，只显示原文 |
| `upstream-error` | YouTube 本身返回了错误，原样放行 |
| `skipped` | 不是插件处理的请求 |

## 隐私

字幕文本会直接发给你所选模型的服务商（Google、DeepSeek、OpenAI 或 Anthropic）翻译，只用那一家的 Key。本项目没有中转服务器、账号系统或遥测。

翻译结果缓存在 Loon 本机（`$persistentStore`），缓存里不包含 API Key。Loon 插件的输入框不是系统钥匙串，建议使用设了用量上限、可随时撤销的 API Key。

## 诊断工具

[`diag` 分支](https://github.com/baitao24/loon-youtube-ai-translator/tree/diag/diag)里有一个临时诊断插件，可以测 YouTube 等待字幕的上限和 Gemini 从手机调用的速度。上面的实测数据就是用它测的。它会故意延迟字幕，测完要关闭。

## 开发

```bash
npm run verify
```

会构建 `dist/`、做语法检查并运行全部测试。自动测试不能替代真机验收，改动发布前要在 iPhone 上用真实视频确认字幕画面和 Loon 日志。

构建测试分支时，让远程插件指向该分支的脚本：

```bash
npm run build -- --script-url "https://raw.githubusercontent.com/baitao24/loon-youtube-ai-translator/<分支>/dist/dualsubs-ai.bundle.js"
```

## 许可证

本项目采用 MIT License。早期版本参考过 DualSubs（Apache License 2.0），详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
