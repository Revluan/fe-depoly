#!/usr/bin/env bash
# scripts/upload-r2.sh
# 批量上传 dist/ 到 R2 Bucket
# 用法: bash scripts/upload-r2.sh

set -e

BUCKET="fe-depoly-assets"
DIST_DIR="dist"

if [ ! -d "$DIST_DIR" ]; then
  echo "❌ $DIST_DIR 不存在,请先 npm run build"
  exit 1
fi

echo "📤 上传 $DIST_DIR/ 到 R2 Bucket: $BUCKET"
find "$DIST_DIR" -type f | while IFS= read -r f; do
  # 去掉 dist/ 前缀作为 R2 key
  key="${f#$DIST_DIR/}"
  echo "  → $key"
  npx wrangler r2 object put "$BUCKET/$key" --file="$f" --remote --content-type="$(guess_ct "$key")"
done
echo "✅ 上传完成"

guess_ct() {
  case "${1##*.}" in
    html) echo "text/html; charset=utf-8" ;;
    js|mjs) echo "application/javascript; charset=utf-8" ;;
    css) echo "text/css; charset=utf-8" ;;
    json) echo "application/json; charset=utf-8" ;;
    svg) echo "image/svg+xml" ;;
    png) echo "image/png" ;;
    jpg|jpeg) echo "image/jpeg" ;;
    gif) echo "image/gif" ;;
    webp) echo "image/webp" ;;
    ico) echo "image/x-icon" ;;
    woff) echo "font/woff" ;;
    woff2) echo "font/woff2" ;;
    map) echo "application/json; charset=utf-8" ;;
    *) echo "application/octet-stream" ;;
  esac
}