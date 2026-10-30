# Paper Translator

一个在原生 PDF 阅读器中选择页面或段落进行文本翻译的 Zotero 插件。

这个插件能保留原有版式、公式和图表，只要你有自己的 OpenAI 兼容 API。目前支持 Zotero 7 – 10（在 Zotero 10.0.6 / macOS & ArchLinux 上测试）。

## 安装

1. 安装 [uv](https://github.com/astral-sh/uv)（插件用它管理 Python 环境，会自动下载 Python 3.12）。
2. 从 [Releases](https://github.com/daniel5u/zotero-paper-translator/releases/latest) 下载 `paper-translator-<版本>.xpi`。
3. Zotero → 工具 → 插件 → 齿轮菜单 → 从文件安装插件，选择这个 xpi。之后 Zotero 可通过更新清单自动检查并安装新版。
4. Zotero → 设置 → Paper Translator：填好 API 地址、API Key、模型，然后点「初始化 / 修复环境」（翻译引擎是 [BabelDOC](https://github.com/funstory-ai/BabelDOC)，首次需要下载约 1 GB。不点也行，第一次翻译时会自动初始化），随后点「测试连接」测试是否可用。

## 使用

- 点击普通 PDF 阅读器顶栏中的「打开文本翻译」，或在附件上右键 →「文本翻译 PDF…」。插件打开专用的原生 Zotero 标签页，此时 PDF 开始在后台解析，可以先阅读。
- 点击顶栏「文本翻译 ▾」，在菜单中输入页码（如 `1-10,12`），选择「正文」「全部」或具体章节，再点「翻译」。正文选择会尝试跳过参考文献与附录，需人工核对。
- 悬停在可翻译段落时会显示淡色背景。在原文段落上右键 →「翻译此段」。结果排版后写入右侧对应位置，已有译文可右键重新翻译。为了提高翻译质量，段落的翻译请求会包含论文标题、当前章节和前后段落的一定上下文。

## 设置说明

| 设置 | 说明 |
| --- | --- |
| 思考强度 | 默认「最低」。思考可能占用输出额度；模型不认这个参数时选「不发送」 |
| 输出 token 上限 | 默认 8192。空响应、截断等重试会增加额度，最高 32768，应按接口能力配置 |
| 思考模式 | 默认由模型决定。支持 `thinking` 参数的接口可以显式关闭思考。不支持该参数的接口应保持默认 |
| 并发请求数 | 同时发出的翻译请求数，受你的 API 限速约束 |
| 系统提示词 | 替换翻译角色说明，段落输出和公式等格式规则保留。 |

## 工作原理

```
右键菜单 → 插件(JS) ──启动子进程──▶ venv/bin/python runner.py session-*
                     ◀── stdout 上一行一条 "@@PT {json}" 进度消息 ──
           批次完成 → 更新原生阅读标签页中的 PDF
```

- 环境放在 `<Zotero 数据目录>/paper-translator/venv`，按插件自带的 `addon/python/requirements.lock` 精确安装。插件更新带来新的依赖清单时会自动重新同步。
- PDF 解析与翻译分离，段落结果逐个保存，全部排版后统一更新阅读器；API 连接测试由设置页单独触发。

## 开发

- 项目文件结构：

  ```
  addon/                 插件本体（打包进 xpi）
    bootstrap.js         Zotero 插件入口
    content/             主逻辑、设置页
    locale/              中英文文案（Fluent）
    python/runner.py     插件与 BabelDOC 之间的桥
    python/text_translation.py  持久化结构、段落任务、页面预览和导出
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
