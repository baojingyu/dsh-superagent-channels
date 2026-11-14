# 文档导出 / Document exports

本目录是**可离线分发的文档合集**，由仓库里的中英文 Markdown 生成。 / This directory holds the offline documentation
collections generated from the Chinese and English Markdown in this repository.

| 文件 / File | 内容 / Contents |
| --- | --- |
| `dsh-superagent-multi-channel-docs-zh-CN.pdf` | 中文合集，21 篇文档 / Chinese set, 21 documents |
| `dsh-superagent-multi-channel-docs-zh-CN.docx` | 中文合集 Word 源文件 / Chinese Word source |
| `dsh-superagent-multi-channel-docs-en-US.pdf` | English set, 21 documents |
| `dsh-superagent-multi-channel-docs-en-US.docx` | English Word source |

## 重新生成 / Regenerate

```bash
python tools/build-docs-export.py
# then export each DOCX with LibreOffice Kit:
# node <libreoffice-kit>/lib/cli.js convert --input docs/export/<name>.docx --output docs/export/<name>.pdf
```

- 合集包含：README、docs/README、000–008、EXTENSIONS、能力矩阵、ADR-005…012。
- 图片来自 `docs/images/`，敏感信息已打码；表格首行在跨页时重复。
- The set contains README, docs/README, 000–008, EXTENSIONS, the capability matrix and ADR-005…012. Table header rows
  repeat across pages; screenshots come from the redacted `docs/images/`.
