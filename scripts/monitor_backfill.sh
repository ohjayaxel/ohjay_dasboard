#!/bin/bash
# Monitor backfill progress every 30 seconds

LOG_FILE="/tmp/backfill_full.log"

while true; do
  clear
  echo "🔄 BACKFILL STATUS - $(date '+%H:%M:%S')"
  echo "================================================"
  echo ""
  
  if [ -f "$LOG_FILE" ]; then
    COMPLETED=$(grep -c "Chunk.*completed" "$LOG_FILE" 2>/dev/null || echo "0")
    echo "✅ Månader klara: $COMPLETED / 11"
    echo ""
    
    echo "📋 Senaste aktivitet:"
    echo "----------------------------------------"
    tail -25 "$LOG_FILE" | grep -E "(Processing chunk|Chunk.*completed|Fetched.*orders|Mapped.*orders|Upserting|Successfully saved|✅ Backfill completed|Summary:)" | tail -8
    
    if grep -q "✅ Backfill completed successfully" "$LOG_FILE" 2>/dev/null; then
      echo ""
      echo "🎉 BACKFILL KLAR!"
      echo ""
      tail -30 "$LOG_FILE" | grep -A 20 "Summary:"
      exit 0
    fi
  else
    echo "⏳ Väntar på loggfil..."
  fi
  
  echo ""
  echo "================================================"
  echo "Nästa uppdatering om 30 sekunder... (Ctrl+C för att avbryta)"
  sleep 30
done
