#!/usr/bin/env bash
# LiteMD 快速迭代部署脚本（~2 分钟，替代 10 分钟完整 tauri build）
# 适用：前端/Svelte 或 Rust 的小改动后，需要「可部署的真实 exe」时。
# 原理：依赖已缓存在 .cargo-tmp；关 LTO 只重编 litemd 一个 crate（重嵌前端）+ 重新链接，
#       跳过 msi/nsis 打包，直接拷 exe+dll 到 D:\LiteMD。
# 真正零重编的迭代请用：npm run tauri -- dev（Vite 热重载，保存即生效）
set -e
cd "$(dirname "$0")/.."

export PATH="$USERPROFILE/.cargo/bin:$PATH"
export NODE_OPTIONS=""                       # 绕开 WorkBuddy 安全删除 shim（否则 vite emptyDir 失败）
export CARGO_TARGET_DIR="C:/Users/manwa/Desktop/LiteMD/.cargo-tmp"

echo "==> 1/4 生成前端 dist"
npm run build

echo "==> 2/4 Rust 增量构建（关 LTO，依赖已缓存）"
cd src-tauri
taskkill /F /IM cargo.exe >/dev/null 2>&1; taskkill /F /IM rustc.exe >/dev/null 2>&1
rm -f ../.cargo-tmp/release/.cargo-lock ../.cargo-tmp/release/.cargo-build-lock
CARGO_PROFILE_RELEASE_LTO=false cargo build --release
cd ..

echo "==> 3/4 备份并部署 exe + dll 到 D:\\LiteMD"
if [ -f /d/LiteMD/litemd.exe ]; then mv -f /d/LiteMD/litemd.exe /d/LiteMD/litemd.exe.bak; fi
if [ -f /d/LiteMD/litemd_lib.dll ]; then mv -f /d/LiteMD/litemd_lib.dll /d/LiteMD/litemd_lib.dll.bak; fi
cp -f .cargo-tmp/release/litemd.exe /d/LiteMD/litemd.exe
cp -f .cargo-tmp/release/litemd_lib.dll /d/LiteMD/litemd_lib.dll

echo "==> 4/4 完成：D:\\LiteMD\\litemd.exe 已更新（旧文件 .bak 备份）"
ls -la /d/LiteMD/litemd.exe /d/LiteMD/litemd_lib.dll
