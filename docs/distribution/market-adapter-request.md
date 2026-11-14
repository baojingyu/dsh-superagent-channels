# Community Market 路径 B（受审 adapter）备选申请

> 语言：[中文](market-adapter-request.md) · [English](market-adapter-request.en-US.md)

仅当条目规模增长、需要服务端筛选时才需要。当前一条目用[路径 A](catalog/README.md)即可。按
[catalog-adapter-guide.zh.md](https://github.com/anywhere-labs/dsh-desktop/blob/master/dsh-community-market/docs/catalog-adapter-guide.zh.md)
的「路径 B」准备以下材料发给 Market 团队：

1. **公开 endpoint 文档与 response schema**：本插件的目录是静态 JSON，无私有 API；若改造成动态目录，会提供 OpenAPI 与示例。
2. **已移除 secret 的样例**：成功页、空结果页、分页页、错误页各一份。
3. **稳定字段语义与分页规则**：`id/name/displayName/summary/package/repository` 语义与 `nextCursor` 归属。
4. **来源声明、rate limit 与图标所有权**：静态托管在 GitHub Pages，无 rate limit；图标 `icon.svg` 为本项目所有（MIT）。
5. **不越界**：manifest 与 page 不含 JavaScript、安装命令、凭据、映射表达式。

> 结论：当前无需路径 B。保留本文件仅作将来扩展时的清单。
