@echo off
chcp 65001 >nul
title GigaCode Telegram bot
cd /d "%~dp0"
echo Запускаю Telegram-бота (Ctrl+C — остановить)...
node bot.mjs
echo.
echo Бот завершился. Код выхода: %ERRORLEVEL%
pause
