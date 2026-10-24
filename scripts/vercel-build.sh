#!/usr/bin/env bash
# بناء موقع Vercel: التطبيق، لوحة الأدمن، صفحة حذف الحساب، وملفات روابط التطبيق
set -e
rm -rf public && mkdir -p public/admin public/delete-account public/.well-known
cp -r www/. public/
cp admin/index.html public/admin/index.html
cp site/delete-account.html public/delete-account/index.html
cp site/assetlinks.json public/.well-known/assetlinks.json
cp site/play-icon-512.png public/play-icon-512.png
