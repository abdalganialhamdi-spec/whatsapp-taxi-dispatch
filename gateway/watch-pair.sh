#!/bin/bash
# يراقب الاقتران حتى 20 دقيقة ويكتب النتيجة
for i in $(seq 1 120); do
  S=$(curl -s 'http://127.0.0.1:3010/status?token=TaxiAdmin_2026!x1' 2>/dev/null)
  CONN=$(echo "$S" | python3 -c "import json,sys; print(json.load(sys.stdin).get('connection',''))" 2>/dev/null)
  if [ "$CONN" = "connected" ]; then
    echo "PAIRED_OK at $(date +%H:%M:%S)" >> /tmp/pair-watch.log
    break
  fi
  sleep 10
done
