#!/usr/bin/env bash
# scripts/test-canary.sh
# 批量测试灰度比例是否接近 CANARY_PERCENT 配置值
# 用法: bash scripts/test-canary.sh https://app.example.com [样本数]

set -e

URL="${1:?用法: bash scripts/test-canary.sh <url> [样本数]}"
SAMPLES="${2:-1000}"

canary_count=0
non_canary_count=0

echo "测试 $SAMPLES 个 user_id,统计灰度比例..."
echo "目标: CANARY_PERCENT=10 (期望 ~10%)"
echo "---"

for i in $(seq 1 "$SAMPLES"); do
  user_id="user-$i"
  # 取注入的 canary 字段值(true/false)
  canary=$(curl -s -H "Cookie: user_id=$user_id" "$URL" \
    | grep -o '"canary":[a-z]*' \
    | cut -d: -f2)

  if [ "$canary" = "true" ]; then
    canary_count=$((canary_count + 1))
  else
    non_canary_count=$((non_canary_count + 1))
  fi

  # 每 100 个打印一次进度
  if [ $((i % 100)) -eq 0 ]; then
    percent=$(awk "BEGIN { printf \"%.1f\", ($canary_count / $i) * 100 }")
    echo "  进度 $i/$SAMPLES · 当前灰度比例: $percent%"
  fi
done

echo "---"
echo "结果:"
echo "  总样本:   $SAMPLES"
echo "  灰度用户: $canary_count"
echo "  普通用户: $non_canary_count"
final_percent=$(awk "BEGIN { printf \"%.2f\", ($canary_count / $SAMPLES) * 100 }")
echo "  灰度比例: $final_percent% (期望 10%)"
