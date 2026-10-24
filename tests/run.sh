#!/usr/bin/env bash
# يشغّل اختبارات السيرفر على Firestore وهمي في الذاكرة (بدون إنترنت أو Firebase)
# الاستخدام: bash tests/run.sh
set -e
cd "$(dirname "$0")/.."
S=tests/.sandbox
rm -rf "$S" && mkdir -p "$S/node_modules"
cp -r api "$S/api"
cp firestore.indexes.json "$S/"
cp -r tests/fake-firebase-admin "$S/node_modules/firebase-admin"
cp tests/wallet.test.mjs "$S/test.mjs"
echo '{"type":"module"}' > "$S/package.json"
cd "$S" && node test.mjs
