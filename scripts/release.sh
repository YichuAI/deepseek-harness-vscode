#!/usr/bin/env bash
# release.sh — 用 GitHub PAT 通过 REST API 创建 Release 并上传 VSIX。
#
# 用法:
#   ./scripts/release.sh <PAT> [owner] [repo] [tag] [vsix-path]
#
# 参数:
#   PAT        必填。repo 作用域的 GitHub Personal Access Token。
#   owner      默认 YichuAI
#   repo       默认 deepseek-harness-vscode
#   tag        默认 v0.1.0（须已存在于远端）
#   vsix-path  默认 harness-connector-deepseek-0.1.0.vsix（仓库根目录，*.vsix 被 gitignore）
#
# 注：当前发版走 `gh release create`（本机已 gh auth login 为 YichuAI，token 含 repo
# 作用域，存 keyring），不再传 PAT。本脚本保留作离线/CI 备用。
#
# 说明:
#   - Release 正文从 CHANGELOG.md 的对应 `## [x.y.z]` 段落自动截取。
#   - 若同 tag 的 Release 已存在则跳过创建，仅补传缺失的 asset。
#   - PAT 以命令行参数传入，会短暂出现在进程列表；本地一次性使用可接受。
set -euo pipefail

cd "$(dirname "$0")/.."   # 切到仓库根目录

PAT="${1:-}"
OWNER="${2:-YichuAI}"
REPO="${3:-deepseek-harness-vscode}"
TAG="${4:-v0.1.0}"
VSIX="${5:-harness-connector-deepseek-0.1.0.vsix}"

if [ -z "$PAT" ]; then
  echo "用法: ./scripts/release.sh <PAT> [owner] [repo] [tag] [vsix-path]" >&2
  exit 2
fi
if [ ! -f "$VSIX" ]; then
  echo "找不到 VSIX: $VSIX" >&2
  exit 3
fi

API_H="Authorization: Bearer $PAT"
API_V="X-GitHub-Api-Version: 2022-11-28"
ACCEPT="Accept: application/vnd.github+json"

# 凭据自检
echo "==> 校验 PAT ..."
if ! curl -s -o /dev/null -w "%{http_code}" -H "$API_H" https://api.github.com/user | grep -q 200; then
  echo "PAT 无效（非 200）。请确认未过期/未被撤销。" >&2
  exit 4
fi

# 从 CHANGELOG 截取本版本说明
BODY=$(node -e "const fs=require('fs');const t=fs.readFileSync('CHANGELOG.md','utf8');const i=t.indexOf('## [${TAG#v}]');let j=t.indexOf('## [',i+3);if(i<0){console.error('CHANGELOG 无 '+TAG+' 段落');process.exit(5);}if(j<0)j=t.length;process.stdout.write(JSON.stringify(t.slice(i,j).trim()));")

# 是否已存在同 tag Release？
echo "==> 查询已有 Release (tag=$TAG) ..."
EXISTING=$(curl -s -H "$API_H" -H "$ACCEPT" "https://api.github.com/repos/$OWNER/$REPO/releases?per_page=100" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const a=JSON.parse(d);const r=a.find(x=>x.tag_name==='$TAG');console.log(r?r.id:'')}catch(e){console.log('')}});")

RELEASE_ID=""
if [ -n "$EXISTING" ]; then
  echo "    已存在 Release id=$EXISTING，复用。"
  RELEASE_ID="$EXISTING"
else
  echo "==> 创建 Release ..."
  RESP=$(curl -s -X POST -H "$API_H" -H "$ACCEPT" -H "$API_V" \
    "https://api.github.com/repos/$OWNER/$REPO/releases" \
    -d "{\"tag_name\":\"$TAG\",\"name\":\"$TAG\",\"body\":$BODY,\"draft\":false,\"prerelease\":false}")
  RELEASE_ID=$(echo "$RESP" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const o=JSON.parse(d);if(o.id){console.log(o.id)}else{console.error('创建失败: '+d.slice(0,400));process.exit(6)}}catch(e){console.error('解析失败: '+d.slice(0,400));process.exit(6)}});")
  echo "    新建 Release id=$RELEASE_ID"
fi

# 取 upload_url（去掉 {name} 模板）
UPLOAD_URL=$(curl -s -H "$API_H" -H "$ACCEPT" "https://api.github.com/repos/$OWNER/$REPO/releases/$RELEASE_ID" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const o=JSON.parse(d);console.log(o.upload_url.replace(/\{.*$/,'')||o.upload_url)}catch(e){console.error('取 upload_url 失败');process.exit(7)}});")

echo "==> 上传 asset: $VSIX ..."
curl -s -X POST -H "$API_H" -H "$ACCEPT" -H "Content-Type: application/octet-stream" \
  "${UPLOAD_URL}?name=$(basename "$VSIX")" \
  --data-binary "@$VSIX" \
  -w "\n    HTTP %{http_code}\n"

echo "==> 完成。 Release 页: https://github.com/$OWNER/$REPO/releases/tag/$TAG"
