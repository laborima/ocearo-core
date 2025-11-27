#!/bin/bash

# ocearo-core Plugin Test Script

echo "🧪 Testing ocearo-core Plugin..."

# Base URL
BASE_URL="http://localhost:3000/plugins/ocearo-core"

# Test plugin status
echo -e "\n📊 Testing plugin status..."
curl -X GET "$BASE_URL/status"

# Test manual analysis
echo -e "\n\n🔍 Testing manual analysis..."
curl -X POST "$BASE_URL/analyze" \
  -H "Content-Type: application/json" \
  -d '{"type": "weather"}'

# Test mode change
echo -e "\n\n⚓ Testing mode change..."
curl -X POST "$BASE_URL/mode" \
  -H "Content-Type: application/json" \
  -d '{"mode": "anchored"}'

# Test text-to-speech
echo -e "\n\n🗣️ Testing speech..."
curl -X POST "$BASE_URL/speak" \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello Captain, this is Jarvis speaking", "priority": "medium"}'

# Test high priority speech
echo -e "\n\n🚨 Testing high priority speech..."
curl -X POST "$BASE_URL/speak" \
  -H "Content-Type: application/json" \
  -d '{"text": "Alert! Wind speed increasing to 25 knots", "priority": "high"}'

# Test LLM
echo -e "\n\n🤖 Testing LLM..."
curl -X POST "$BASE_URL/llm/test" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "What is the best wind speed for sailing?"}'

# Test memory view
echo -e "\n\n🧠 Testing memory..."
curl -X GET "$BASE_URL/memory"

# Test logbook entries (last 24 hours)
echo -e "\n\n📚 Testing logbook entries..."
START_DATE=$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)
END_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
curl -X GET "$BASE_URL/logbook/entries?startDate=$START_DATE&endDate=$END_DATE"

# Test logbook summary
echo -e "\n\n📊 Testing logbook summary..."
curl -X GET "$BASE_URL/logbook/summary?startDate=$START_DATE&endDate=$END_DATE"

# Test logbook export (JSON)
echo -e "\n\n💾 Testing logbook export..."
curl -X GET "$BASE_URL/logbook/export?startDate=$START_DATE&endDate=$END_DATE&format=json" \
  -o /tmp/logbook-export.json

echo -e "\n\n✅ Tests completed!"
echo "📁 Logbook export saved to: /tmp/logbook-export.json"