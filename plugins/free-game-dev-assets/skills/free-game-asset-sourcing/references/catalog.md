# 素材目录用法

## 获取候选

- 已配置上游 MCP 时可用 `search_assets`、`get_asset`、`check_license` 和 `list_stacks`。完整接口见 [上游数据文档](https://github.com/TMHSDigital/Free-Game-Dev-Assets/blob/main/docs/data.md#from-a-shell-ci-or-an-assistant)。
- 用 GitHub CLI 读取仓库或 Release 时先执行 `gh auth status --hostname github.com`。已登录则通过 `gh` 获取数据，可在本次任务工作目录运行 `gh release download --repo TMHSDigital/Free-Game-Dev-Assets --pattern data.json` 下载最新 Release 的快照。读取 JSON 顶层的 `version`，并留意默认分支可能已有更新。如果快照里没有合适结果，查看 [默认分支分类目录](https://github.com/TMHSDigital/Free-Game-Dev-Assets/tree/main/catalog) 或 [starter stacks](https://github.com/TMHSDigital/Free-Game-Dev-Assets/tree/main/stacks)。
- `gh` 未安装或未登录时，可以读取 [公开搜索页](https://tmhsdigital.github.io/Free-Game-Dev-Assets/) 或其 [data.json](https://tmhsdigital.github.io/Free-Game-Dev-Assets/data.json)。已认证的请求失败时，先判断权限、网络或限流，保留诊断信息。

## 读懂字段

- 用 `category`、`subcategories`、`tags`、`formats` 缩小范围。素材匹配要结合条目的说明、`engine_lock`、`limits` 和适用的版本字段。字段参考 [上游数据文档](https://github.com/TMHSDigital/Free-Game-Dev-Assets/blob/main/docs/data.md#fields)。
- `commercial` 和 `attribution_required` 可能是布尔值，也可能是 `varies` 或 `unknown` 等字符串。按实际类型筛选。上游 MCP 的 `commercial: true` 搜索会返回部分 `commercial: "varies"` 的条目，仍需核对具体文件。若需要免署名，核对 `attribution_required` 和实际许可文本，`attributionClass: "notice"` 这类条目还需要检查随包通知文件。
- `active` 表示目录已记录许可证据。`needs-review` 要看条目的待核问题，`per-item` 要逐文件核验，`deprecated` 仅作历史参考。用 `url` 和 `license_url` 找原始获取页和条款。旧快照可能没有 `license_url` 或其为空，此时查看 `path` 指向的目录条目中的 Evidence 和 Notes，再跟到原始许可。MCP 的查询摘要也可能省略该字段。

## PowerShell 初筛示例

下面从已下载的快照筛出允许商用、标记无需署名的 CC0 音频候选。根据需求增加关键词或格式条件。

```powershell
$assetCatalog = Get-Content -Raw -LiteralPath './data.json' | ConvertFrom-Json
$assetCatalog.entries | Where-Object {
    $_.category -eq 'audio' -and $_.status -eq 'active' -and
    $_.license -eq 'CC0' -and $_.commercial -is [bool] -and $_.commercial -and
    $_.attribution_required -is [bool] -and -not $_.attribution_required
} | Select-Object id, name, license, verified, url, license_url, path
```
