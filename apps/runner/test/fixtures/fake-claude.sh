#!/usr/bin/env bash
# CLI falso do Claude para os testes: imita --version, auth status e auth login.
set -u
marker="$HOME/.fake-claude-login"
case "${1:-} ${2:-}" in
  "--version "*)
    echo "9.9.9 (Claude Code)"
    ;;
  "auth status")
    if [ -f "$marker" ]; then
      echo '{"loggedIn":true,"email":"dono@exemplo.com","subscriptionType":"max"}'
    else
      echo '{"loggedIn":false}'
    fi
    ;;
  "auth login")
    printf '\033[1mAbrindo o navegador…\033[0m\n'
    echo "Se não abrir, visite: https://claude.ai/oauth/authorize?code=true&client_id=teste&state=abc"
    printf 'Paste code here if prompted > '
    read -r code
    if [ "$code" = "codigo-certo" ]; then
      touch "$marker"
      echo "Login successful."
      exit 0
    fi
    echo "Invalid code."
    exit 1
    ;;
  *)
    echo "comando não suportado" >&2
    exit 2
    ;;
esac
