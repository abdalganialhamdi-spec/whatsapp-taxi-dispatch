#!/bin/bash
# اختبار سريع: ASR على ملف صوتي محلي (اختياري — يحتاج ملف .ogg)
# الاستخدام: bash gateway/test-asr.sh gateway/test.ogg
KEY=$(grep -m1 'ZAI_API_KEY' /root/ai-gateway-proxy/deploy.sh | tr -d "'" | awk '{print $2}')
F="${1:-}"
if [ -z "$F" ] || [ ! -f "$F" ]; then echo "usage: test-asr.sh file.ogg"; exit 1; fi
curl -s -X POST https://api.z.ai/api/paas/v4/audio/transcriptions \
  -H "Authorization: Bearer $KEY" \
  -F model=glm-asr-2512 -F stream=false -F "file=@$F" | head -c 500
