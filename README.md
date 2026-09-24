# pi-kb

给 [pi](https://pi.dev) 用的个人知识库：把 PDF、Office 文档、图片、Markdown 笔记放进来，agent 回答时自动检索并带页码引用；随时 `/kb on` / `/kb off` 开关。

## 安装

```bash
pi install /path/to/pi-kb     # 本地开发
pi -e ./src/index.ts          # 或只在本次运行加载
```

需要 Node.js 22.19+。导入 Word / PowerPoint / Excel 需要 LibreOffice：`brew install --cask libreoffice`。

## 使用

| 命令 | 作用 |
|---|---|
| `/kb` 或 `/kb status` | 查看开关状态和收录数量 |
| `/kb on` / `/kb off` | 开启 / 关闭（持久保存）。关闭后工具和提示词都会移除，不占上下文 |
| `/kb add <文件或文件夹…>` | 导入资料；支持拖拽路径 |
| `/kb add <笔记.md…> --note` | 作为经验笔记放进 wiki |
| `/kb note [重点]` | 让 agent 回顾本次对话，把值得保留的经验写成 wiki 笔记 |
| `/kb list` | 列出文档和笔记 |
| `/kb search <关键词>` | 自己搜一下 |
| `/kb remove <id>` | 删除（笔记会连文件一起删） |
| `/kb sync` | 手动编辑 wiki 后重建索引（启动时也会自动同步） |
| `/kb semantic [status\|api\|local\|off]` | 语义检索：查看状态、用在线接口、用本机模型、关闭 |
| `/kb eval [init\|draft\|run]` | 评测检索效果：建问题文件、让 agent 起草问题、运行评测 |
| `/kb open` | 打开知识库文件夹 |
| `/kb web` | 在浏览器中打开知识库页面（`/kb web url` 显示完整地址，`/kb web stop` 关闭） |
| `/kb lang zh\|en\|auto` | 切换界面语言 |

启动参数 `pi --kb off` / `--kb on` 只影响本次运行。

## 语义检索（可选）

默认只用关键词检索。开启语义检索后，可以用自然语言提问（"芯片最高能承受多少伏"能找到写着"绝对最大额定值 4.0V"的那页），中英文也能互相搜到。结果由关键词和语义两路按排名融合（RRF），纯语义命中的结果标为「语义相近」，agent 会先用 `kb_read` 核实再引用。

两种方式，任选其一：

| | 在线接口 `/kb semantic api` | 本机模型 `/kb semantic local` |
|---|---|---|
| 模型 | 任意 OpenAI 兼容的 `/embeddings` 接口；默认 OpenAI `text-embedding-3-small` | `Qwen3-Embedding-0.6B`（阿里通义，Apache 2.0，中英文及跨语言检索都强） |
| 安装 | 不增加安装包 | 首次开启时安装运行时（约 500MB）到 `~/.pi/kb`，再下载模型（约 610MB，锁定到测试过的版本） |
| 隐私 | **文档和笔记的文字会发送给服务商**（开启时会提示确认） | 全部留在本机 |
| 费用 | 按服务商计费 | 无 |

- 为什么选 Qwen3-Embedding-0.6B：在同一批资料上（pi 自带的 40 多篇英文文档 + 中文资料，共 502 个片段；23 个有标准答案的问题，含中英文互查；8 个知识库里没有答案的问题；Apple 芯片 Mac）对比了三个本机模型：

  | | Qwen3-Embedding-0.6B（采用） | bge-m3 | Granite R2 311M |
  |---|---|---|---|
  | 正确文档排第一 / 在前三 | **15 / 21** | 13 / 20 | 14 / 21 |
  | MRR | **0.794** | 0.737 | 0.768 |
  | 相关与无关问题的分数间隔 | **0.068** | 0.051 | 0.018 |
  | 建索引 502 个片段 | 127 秒 | 87 秒 | 41 秒 |
  | 下载 | 614MB | 570MB | 313MB |
  | 许可证 | Apache 2.0 | MIT | Apache 2.0（分词器受 Gemma 条款约束） |

  样本不大，前两名的差距只有一两个问题；选 Qwen3 主要因为它最能区分"有答案"和"没有答案"，许可证也最干净。
- Qwen3 默认只保留相似度 ≥ 0.43 的语义结果（有答案的问题最佳结果 ≥ 0.46，没有答案的 ≤ 0.39），问知识库里没有的东西时不会硬凑结果。可以在 `config.json` 用 `semantic.minScore` 调整。
- 建索引时约占用 2–3GB 内存（每次处理 2 个片段；一次处理 8 个会升到 5GB 以上，而速度并不会更快）。一本 300 页的手册大约需要 3–6 分钟，在后台进行，期间关键词检索照常可用；单次查询约 45 毫秒。
- API Key 依次读取：环境变量 `PI_KB_EMBEDDING_API_KEY` → 在 `/kb semantic api` 里填写的 Key（保存在 `config.json`，文件权限 0600）→ 用 OpenAI 时的 `OPENAI_API_KEY`。本机的 Ollama 等服务（`http://localhost…`）不需要 Key。
- 其他常用的在线接口（`/kb semantic api` 里填地址和模型即可）：

  | 服务 | 接口地址 | 模型 | 说明 |
  |---|---|---|---|
  | OpenAI（默认） | `https://api.openai.com/v1` | `text-embedding-3-small` | 暂无默认相似度下限，只限制纯语义结果条数 |
  | 硅基流动（国际） | `https://api.siliconflow.com/v1` | 例如 `Qwen/Qwen3-Embedding-0.6B` 或 `BAAI/bge-m3` | 和本机同一类模型：查询会自动加上 Qwen3 需要的指令，并使用各自测出的下限（0.43 / 0.51） |
  | 硅基流动（中国大陆） | `https://api.siliconflow.cn/v1` | 同上 | 适合在中国大陆的用户；从中国大陆以外可能连不上 |
  | Ollama（本机） | `http://localhost:11434/v1` | 例如 `qwen3-embedding:0.6b` | 不需要 Key，数据不出本机 |
- 导入后先能按关键词搜到，向量在后台生成，状态栏显示进度（`🧠 120/600`，完成后显示 `🧠`）。换模型会自动重建。
- 访问 HuggingFace 或 npm 受限时（例如在中国大陆）：在 `config.json` 的 `semantic.local` 里设置 `"hfEndpoint": "https://hf-mirror.com"`（模型下载）和 `"npmRegistry": "https://registry.npmmirror.com"`（运行时安装）。默认不启用，直接使用官方源。

```json
"semantic": {
  "provider": "local",
  "api": { "baseUrl": "https://api.openai.com/v1", "model": "text-embedding-3-small" },
  "local": { "model": "onnx-community/Qwen3-Embedding-0.6B-ONNX" }
}
```

## 评测检索效果

用自己的资料衡量"知识库到底找不找得到答案"，也可以用来比较不同设置。只评测检索（正确的页有没有被找到、排第几），不调用模型、不产生费用，几秒钟跑完。

1. `/kb eval init` 创建 `~/.pi/kb/eval/questions.txt`（带中英文说明），或 `/kb eval draft` 让 agent 读你的资料起草约 15 个问题。
2. 按格式写问题，每行一个：

   ```
   芯片的最大供电电压是多少 | xr100-manual.pdf p.1
   how do I configure the SPI clock divider | xr100-manual.pdf p.2; SPI 时钟分频踩坑
   今天午饭吃什么 | -
   ```

   竖线右边是答案所在的文档（文件名或笔记标题的一部分，可加页码；多个可接受答案用 `;` 分隔），`-` 表示知识库里没有答案。问题最好用客户真实会问的说法，不要照抄原文。
3. `/kb eval` 运行。终端显示汇总，`~/.pi/kb/eval/reports/` 保存逐题报告（每题在每种模式下排第几、第一条是什么）。

开启语义检索时会同时比较三种模式：只用关键词、关键词+语义（agent 实际使用的）、只用语义。

示例结果（pi 自带文档 + 中文资料，502 个片段；29 个有答案的问题，其中 6 个是 `CTRL_REG`、`setActiveTools` 这类精确词；14 个没有答案的问题，其中 6 个像"docker 面试题"这样一个词在库里、另一个不在；本机 Qwen3）：

| 模式 | 第一条命中 | 前三命中 | 前八命中 | MRR | 无答案时返回空 |
|---|---|---|---|---|---|
| 关键词 | 34% | 34% | 45% | 0.36 | 100% |
| 关键词+语义 | 69% | 90% | 97% | 0.80 | 71% |
| 仅语义 | 69% | 86% | 97% | 0.79 | 71% |

没有答案却返回了结果的，都来自语义检索：例如"docker 面试题"找到讲 Docker 的文档（主题相关，但没有面试题）。这些结果标为「语义相近」，agent 会先核实再引用。

这组问题以自然语言和中英文互查为主，对关键词不利；如果客户多用型号、寄存器名提问，关键词的表现会好得多。融合方式也是用这套评测选出来的：给关键词结果按覆盖率加权、加大语义权重都会让精确词查询出错，最后保留了标准的 RRF。

## 网页

`/kb web` 打开本地网页（只监听 `127.0.0.1`，需要访问令牌）：

- 把文件拖到页面上导入：左半边作为资料，右半边（Markdown）作为经验笔记
- 搜索结果带页码，点开直接定位到那一页；PDF 可以「看原页」在浏览器里打开到对应页
- 浏览转换后的原文（表格、标题按 Markdown 显示）、新建和编辑笔记、删除、开关知识库
- 中文 / English 切换；链接加 `?lang=en` 或 `?lang=zh` 可指定语言，`?q=<关键词>` 直接搜索，`?doc=<id>&page=<n>` 直接打开某份文档的某一页

网页由 pi-web 共享服务提供（`src/hub.ts`）。同时安装了 [pi-sessions 会话管理](https://github.com/woertedetiankong/pi-newsession) 时，两者在同一个地址下（`/sessions/` 和 `/kb/`），顶部可以切换，共用 `~/.pi/agent/pi-web/token` 里的访问令牌。`src/hub.ts` 在两个仓库里必须保持完全一致。

## 界面语言

界面（状态栏、提示、列表、笔记确认框、`/kb note` 发出的请求）支持中文和英文，按以下顺序决定：

1. 环境变量 `PI_KB_LANG=zh|en`
2. `/kb lang zh|en` 保存的设置（`config.json` 的 `language`）
3. `auto`（默认）：依次看 `LC_ALL`、`LC_MESSAGES`、`LANG`（忽略 `C` / `POSIX`），macOS 上再读系统语言，最后用 Node 的区域设置；都识别不了时用英文

给模型看的工具说明和系统提示始终是英文：模型对英文指令最稳定，回答语言仍跟随用户。

开启时 agent 有四个工具：

- `kb_search`：关键词检索，返回 `[手册.pdf p.12]` 形式的引用和文档 id
- `kb_read`：按 id 和页码读取原文（例如 `pages: "12-14"`）
- `kb_add`：用户让它"收进知识库"时导入文件
- `kb_note`：把经验写成 wiki 笔记。解决了不明显的问题（调试找到的根因、坑、变通办法）或了解到你的环境偏好时，agent 会主动调用；每条笔记都会先给你预览，选择 **Save / Edit, then save / Don't save**。同名笔记不会重复创建，而是追加（`append`）或改写（`replace`）已有笔记

## 经验笔记格式

```markdown
---
title: "XR-100 Flash 读错：先设 SPI 分频"
tags: [spi, xr100]
created: 2026-09-24
updated: 2026-09-24
project: "firmware"
---

# XR-100 Flash 读错：先设 SPI 分频

症状 / 根因 / 修复 / 下次怎么识别
```

手写的笔记（没有 front matter 也行）放进 `wiki/` 同样会被索引。每次写入会在 `wiki/log.md` 追加一行记录。索引只收正文和 `#标签`，不收 front matter 字段名。

system prompt 里会注入一个很小的目录（数量、wiki 笔记标题、最近文档），让 agent 知道库里有什么。

## 存储

默认在 `~/.pi/kb`（可用 `PI_KB_DIR` 修改），全部是普通文件：

```
raw/<id>/<原文件>        原件副本
converted/<id>.md        转换后的 Markdown，带 <!-- kb:page N --> 页码标记
wiki/**/*.md             经验笔记，可直接用 Obsidian 或编辑器维护
kb.db                    SQLite FTS5 索引（trigram 分词，中英文都能搜）
config.json              { "enabled", "language", "ocrLanguage", "ocrServerUrl", "semantic" }
tessdata/                OCR 语言包（首次 OCR 时自动下载）
runtime/, models/        本机语义模型的运行时和模型文件（只在 /kb semantic local 后出现）
```

## 解析与检索

- 解析用 [LiteParse](https://github.com/run-llama/liteparse)：PDF 输出带标题和表格的 Markdown，按物理页保留页码；图片和扫描页走 Tesseract OCR（默认 `eng+chi_sim`）。
- 检索用 Node 内置的 `node:sqlite` + FTS5 trigram，无需原生依赖。3 个字以上的词走索引，1–2 字的词（如"电压"）走 LIKE；长中文句子会拆成 trigram 做模糊匹配，按"命中词覆盖率 + BM25"排序。
- 查询里的 how / the 这类英文虚词、"怎么、如何、什么"这类疑问词和落单的汉字（如"用"）会被忽略。
- 有多个词时要命中超过一半：两个词时两个都要有，除非另一个词出现在同一份文档的其他页（例如"Python 列表排序"不会因为某页提到 Python 就算命中）。
- 英文按词首匹配（`compact` 能匹配 `compaction`，`pi` 不会匹配 `api`），复数也能匹配单数（`shortcuts` → `shortcut`）。
- 入库时会去掉 OCR 在汉字间插入的空格和 Markdown 转义（`CTRL\_REG` → `CTRL_REG`），保证原词能搜到。

### 已知限制

- Tesseract 识别中文扫描件质量一般：同一行的词序可能被打乱。扫描件多时建议配置 PaddleOCR 服务：在 `config.json` 里设置 `"ocrServerUrl"`（LiteParse 的 OCR HTTP 接口）。
- 向量检索总会返回"最接近"的片段，即使库里没有相关内容：纯语义结果有数量上限、单独标注；测过的模型（Qwen3-0.6B、bge-m3）还有相似度下限，其他模型（如 OpenAI）暂时只有数量上限。
- 下限是在上面那批数据上测出来的（Qwen3 两侧余量约 0.03–0.04）；资料类型差别很大时，可能需要用 `semantic.minScore` 微调。
- 导入没有后台队列：`/kb add` 会一直等到全部文件处理完（状态栏显示进度）。

## 开发

```bash
npm install
npm run typecheck
npm test
```
