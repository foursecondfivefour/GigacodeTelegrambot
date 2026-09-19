#!/usr/bin/env bash
# Запуск бота: ./start-bot.sh   (Ctrl+C — остановить)
cd "$(dirname "$0")" || exit 1
exec node bot.mjs
