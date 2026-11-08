#!/bin/bash
# Usage: npm run release -- 0.2.0
# Bumps the version, checks, builds both platforms, then (after asking) commits, pushes and publishes the
# GitHub release. The in-app updater finds new versions through that release, and needs all three files.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=${1:-}
if [[ ! $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "用法：npm run release -- <x.y.z>（当前版本 $(node -p 'require("./package.json").version')）" >&2
  exit 1
fi
TAG="v$VERSION"

[[ $(git branch --show-current) == main ]] || { echo "请在 main 分支上发版" >&2; exit 1; }
[[ -z $(git status --porcelain) ]] || { echo "有没提交的改动，先提交或暂存" >&2; exit 1; }
git fetch -q origin main
[[ $(git rev-parse HEAD) == $(git rev-parse origin/main) ]] || { echo "本地 main 和 origin/main 不一致，先同步" >&2; exit 1; }
if gh release view "$TAG" >/dev/null 2>&1; then echo "$TAG 已经发布过了" >&2; exit 1; fi

# Until the commit below, any exit (a failure, Ctrl-C, saying no) puts the version back. EXIT, not ERR:
# ERR doesn't fire when set -u aborts on an unset variable.
trap 'git checkout -- package.json package-lock.json' EXIT
npm version "$VERSION" --no-git-tag-version >/dev/null

npm run typecheck
npm test
rm -rf dist
npm run build:mac
npm run build:win

FILES=("dist/Hush-$VERSION-arm64.dmg" "dist/Hush-$VERSION-arm64-mac.zip" "dist/Hush-$VERSION-setup.exe")
for f in "${FILES[@]}"; do [[ -f $f ]] || { echo "缺少 ${f}" >&2; exit 1; }; done

echo
ls -lh "${FILES[@]}"
# Braces matter next to Chinese text: bash would read the bytes of ？ as part of the variable's name.
read -r -p "推送到 GitHub 并发布 ${TAG}？[y/N] " answer
[[ $answer == y || $answer == Y ]] || { echo "已取消，版本号改回原样；安装包留在 dist/"; exit 1; }
trap - EXIT

PREV=$(gh release view --json tagName -q .tagName 2>/dev/null || true)
git fetch -q --tags origin
CHANGES=$(git log --format='- %s' ${PREV:+"$PREV..HEAD"})

git commit -q -m "release: $TAG" package.json package-lock.json
git push -q origin main

NOTES="## 下载

- **macOS（Apple 芯片）**：\`Hush-$VERSION-arm64.dmg\`，打开后把 Hush 拖进「应用程序」
- **Windows（x64）**：\`Hush-$VERSION-setup.exe\`

已经装了 Hush 的话，点左栏底部的更新图标就能升级。\`Hush-$VERSION-arm64-mac.zip\` 是给应用内更新用的，不用下载。

第一次打开时系统会拦一下（暂时没有开发者签名）：macOS 上到「系统设置 → 隐私与安全性」点「仍要打开」；Windows 上点「更多信息 → 仍要运行」。

## 改动

$CHANGES
"
gh release create "$TAG" --target main --title "Hush $VERSION" --notes "$NOTES" "${FILES[@]}"
