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
| `/kb open` | 打开知识库文件夹 |
| `/kb lang zh\|en\|auto` | 切换界面语言 |

启动参数 `pi --kb off` / `--kb on` 只影响本次运行。

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
config.json              { "enabled", "language", "ocrLanguage", "ocrServerUrl" }
tessdata/                OCR 语言包（首次 OCR 时自动下载）
```

## 解析与检索

- 解析用 [LiteParse](https://github.com/run-llama/liteparse)：PDF 输出带标题和表格的 Markdown，按物理页保留页码；图片和扫描页走 Tesseract OCR（默认 `eng+chi_sim`）。
- 检索用 Node 内置的 `node:sqlite` + FTS5 trigram，无需原生依赖。3 个字以上的词走索引，1–2 字的词（如"电压"）走 LIKE；长中文句子会拆成 trigram 做模糊匹配，按"命中词覆盖率 + BM25"排序。
- 入库时会去掉 OCR 在汉字间插入的空格和 Markdown 转义（`CTRL\_REG` → `CTRL_REG`），保证原词能搜到。

### 已知限制

- Tesseract 识别中文扫描件质量一般：同一行的词序可能被打乱。扫描件多时建议配置 PaddleOCR 服务：在 `config.json` 里设置 `"ocrServerUrl"`（LiteParse 的 OCR HTTP 接口）。
- 目前只有关键词检索，没有向量语义检索（"意思相近但用词不同"会搜不到）。
- 导入没有后台队列：`/kb add` 会一直等到全部文件处理完（状态栏显示进度）。

## 开发

```bash
npm install
npm run typecheck
npm test
```
