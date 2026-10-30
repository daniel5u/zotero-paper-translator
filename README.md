# Paper Translator

一个在原生 PDF 阅读器中选择页面或段落进行文本翻译的 Zotero 插件。

这个插件能保留原有版式、公式和图表，只要你有自己的 OpenAI 兼容 API。目前支持 Zotero 7 – 10（在 Zotero 10.0.6 / macOS & ArchLinux 上测试）。

## 安装

1. 从 [Releases](https://github.com/daniel5u/zotero-paper-translator/releases/latest) 下载 `paper-translator-<版本>.xpi`。
2. Zotero → 工具 → 插件 → 齿轮菜单 → 从文件安装插件，选择这个 xpi。之后 Zotero 可通过更新清单自动检查并安装新版。
3. Zotero → 设置 → Paper Translator：
   - 「环境」中点「初始化环境」。插件用 [uv](https://github.com/astral-sh/uv) 管理 Python 环境：先查找已安装的 uv，找不到时自动下载（校验 SHA-256），再创建 Python 3.12 环境并安装翻译引擎 [BabelDOC](https://github.com/funstory-ai/BabelDOC)。首次约需下载 1 GB，每一步的进度都会显示。不点也行，第一次翻译时会自动初始化。
   - 填好 API 地址、API Key 和模型。点模型旁的「检测」可以列出接口提供的模型（`GET /models`），也可以直接输入模型名。
   - 点「测试连接」。测试会顺带检测这个接口如何关闭模型的思考、用哪个字段限制输出长度。

## 使用

- 点击普通 PDF 阅读器顶栏中的「打开文本翻译」，或在附件上右键 →「文本翻译 PDF…」。插件打开专用的原生 Zotero 标签页，此时 PDF 开始在后台解析，可以先阅读。
- 点击顶栏「文本翻译 ▾」，在菜单中输入页码（如 `1-10,12`），选择「正文」「全部」或具体章节，再点「翻译」。正文选择会尝试跳过参考文献与附录，需人工核对。
- 悬停在可翻译段落时会显示淡色背景。在原文段落上右键 →「翻译此段」。结果排版后写入右侧对应位置，已有译文可右键重新翻译。为了提高翻译质量，段落的翻译请求会包含论文标题、当前章节和前后段落的一定上下文。
- 批量翻译：Zotero → 工具 →「论文翻译…」打开翻译队列。点「添加论文…」从文献库中挑选（可搜索、按文库/分类筛选、按添加时间/标题/作者/年份排序），并选择翻译「正文」（默认）或「全部」；也可以在条目上右键 →「添加到翻译队列」。队列一次翻译一篇，窗口里显示每篇的进度、已用 token 和预计剩余时间，可暂停、跳过、重试。关闭 Zotero 后再打开时会询问是否继续未完成的队列。
- 条目列表可以显示「翻译」列（在列标题上右键勾选），显示排队状态或每篇论文已翻译的比例。

## 设置说明

常用设置只有 API 地址、API Key、模型和目标语言。其余选项收在「高级」里，默认全部自动：

| 设置 | 说明 |
| --- | --- |
| 并发请求数 | 同时发出的翻译请求数，受你的 API 限速约束 |
| 系统提示词 | 替换翻译角色说明，段落输出和公式等格式规则保留 |
| 关闭思考的方式 | 自动时由「测试连接」检测：在 `thinking`（DeepSeek、GLM）、`reasoning_effort`（OpenAI）、`reasoning`（OpenRouter）、`enable_thinking`（Qwen）中，先试最符合 API 地址的一个，再依次尝试其余的，都不被接受时不发送。检测结果按 API 地址和模型分别记住；翻译中接口拒绝了自动选择的字段，也会自动换用下一个 |
| 输出上限字段 | 自动时使用 `max_tokens`，接口要求时换成 `max_completion_tokens`（OpenAI 推理模型） |
| 输出 token 上限 | 自动时从 8192 开始，回答被截断时翻倍，最高 32768；也可以固定一个值 |

手动选择的选项不会被自动检测改动；接口拒绝时会直接报错。「恢复自动」会清除手动选择并重新检测。

## 工作原理

```
右键菜单 → 插件(JS) ──启动子进程──▶ venv/bin/python runner.py session-*
                     ◀── stdout 上一行一条 "@@PT {json}" 进度消息 ──
           批次完成 → 更新原生阅读标签页中的 PDF
```

- 环境放在 `<Zotero 数据目录>/paper-translator/venv`，按插件自带的 `addon/python/requirements.lock` 精确安装。插件更新带来新的依赖清单时会自动重新同步。
- PDF 解析与翻译分离，段落结果逐个保存，全部排版后统一更新阅读器；API 连接测试由设置页单独触发。
- 阅读器里的双栏 PDF 本身就是已完成页面的存储：只重绘译文有变化的页面，没有新译文时重新打开不会改动这个文件。排版中间文件在每次运行结束后删除。
- 解析结果（版面结构、原文快照）7 天未使用会自动清理，需要时重新解析；译文保存在 `session.json` 中长期保留，重新解析后按段落自动接回。附件被删除后，对应的会话目录也会被清理。

## 开发

- 项目文件结构：

  ```
  addon/                 插件本体（打包进 xpi）
    bootstrap.js         Zotero 插件入口
    content/             主逻辑、设置页
    locale/              中英文文案（Fluent）
    python/runner.py     插件与 BabelDOC 之间的桥
    python/text_translation.py  持久化结构、段落任务、双栏阅读 PDF 和导出
    python/translation.py 空响应/截断检查、重试与前后文提示词
    python/requirements.lock
  python/requirements.in 依赖清单的来源
  scripts/build.sh       打包成 build/paper-translator-<版本>.xpi
  scripts/generate_update.py 从发布的 XPI 生成自动更新清单
  ```

- CI 仅在 Ubuntu 上打包 XPI。发布时修改 `addon/manifest.json` 的版本号、提交并推送，再推送对应的 `vX.Y.Z` 标签（例如 `v0.3.0`）；构建成功后自动创建 GitHub Release，上传 XPI 和 `update.json`。插件的 `update_url` 指向 `releases/latest/download/update.json`，清单版本与 SHA-256 从实际 XPI 读取，无需维护仓库中的更新清单或由 CI 提交代码。发布使用 GitHub 自动提供的 `GITHUB_TOKEN`，无需额外配置 Secret；Zotero 版本范围只在 manifest 中维护。在 fork 中独立发布时，需把 manifest 中的 `update_url` 改为自己的仓库地址。
- 使用旧更新地址的已安装版本需手动安装一次新版，之后会从 Release 检查更新。
- 更新依赖：改 `python/requirements.in`，然后

  ```bash
  uv pip compile python/requirements.in --python-version 3.12 --universal --no-header -o addon/python/requirements.lock
  ```

  > 注意：BabelDOC 0.6.4 和 bitstring 5.0 不兼容，必须保留 `bitstring<5`。
- 开发时可以在 Zotero 配置目录的 `extensions/` 里放一个以插件 ID（`paper-translator@danielsu.local`）命名的文件，内容是 `addon/` 目录的绝对路径，Zotero 就会直接从源码加载插件。发布前务必再用打包好的 xpi 安装测试一次：两种方式下插件读取自身文件的地址不同（`file://` 和 `jar:`）。

## 协议

[AGPL-3.0](LICENSE)，与 BabelDOC 和 Zotero 一致。
