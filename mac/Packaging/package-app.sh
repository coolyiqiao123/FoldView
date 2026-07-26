#!/bin/zsh
set -euo pipefail

source_root="${0:A:h:h}"

if [[ -z "${HOME:-}" || "$HOME" != /* || "$HOME" == "/" ]]; then
  print -u2 "Foldview packaging: HOME must be a resolved absolute user directory."
  exit 1
fi
physical_home="$(cd "$HOME" 2>/dev/null && pwd -P)" || {
  print -u2 "Foldview packaging: HOME cannot be resolved."
  exit 1
}
if [[ "$physical_home" != "$HOME" || -L "$HOME" || ! -d "$HOME" ]]; then
  print -u2 "Foldview packaging: HOME must be a physical directory, not a symlink."
  exit 1
fi
current_uid="$(id -u)"
read home_uid home_mode <<< "$(/usr/bin/stat -f '%u %Lp' "$physical_home")"
if [[ "$home_uid" != "$current_uid" ]] || (( (8#$home_mode & 8#022) != 0 )); then
  print -u2 "Foldview packaging: HOME has unsafe ownership or permissions."
  exit 1
fi
install_parent="$physical_home/Applications"
if [[ ! -e "$install_parent" ]]; then
  mkdir -m 700 "$install_parent"
fi
physical_install_parent="$(cd "$install_parent" 2>/dev/null && pwd -P)" || {
  print -u2 "Foldview packaging: Applications cannot be resolved."
  exit 1
}
read parent_uid parent_mode <<< "$(/usr/bin/stat -f '%u %Lp' "$install_parent")"
if [[ "$physical_install_parent" != "$install_parent" || -L "$install_parent" || ! -d "$install_parent" ||
      "$parent_uid" != "$current_uid" ]] || (( (8#$parent_mode & 8#022) != 0 )); then
  print -u2 "Foldview packaging: Applications has unsafe ancestry, ownership, or permissions."
  exit 1
fi
app_path="$physical_install_parent/Foldview.app"
if [[ "$app_path" != "$physical_home/Applications/Foldview.app" ]]; then
  print -u2 "Foldview packaging: refusing unexpected install target: $app_path"
  exit 1
fi
for tool in swift plutil codesign; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    print -u2 "Foldview packaging: required tool is unavailable: $tool"
    exit 1
  fi
done

stage_root="$(mktemp -d "$physical_install_parent/.Foldview.install.XXXXXXXX")"
stage_app="$stage_root/Foldview.app"
cleanup() {
  if [[ -n "${stage_root:-}" && "$stage_root" == "$physical_install_parent"/.Foldview.install.* &&
        -d "$stage_root" && ! -L "$stage_root" && "$(/usr/bin/stat -f %u "$stage_root" 2>/dev/null)" == "$current_uid" ]]; then
    rm -rf -- "$stage_root"
  fi
}
on_signal() { exit 130 }
trap cleanup EXIT
trap on_signal INT TERM HUP

cd "$source_root"
swift build -c release
mkdir -p "$stage_app/Contents/MacOS" "$stage_app/Contents/Resources"
install -m 755 ".build/release/FoldviewMenuBar" "$stage_app/Contents/MacOS/FoldviewMenuBar"
install -m 644 "Packaging/Info.plist" "$stage_app/Contents/Info.plist"
print -n 'APPL????' > "$stage_app/Contents/PkgInfo"

plutil -lint "$stage_app/Contents/Info.plist" >/dev/null
[[ "$(plutil -extract CFBundleExecutable raw -o - "$stage_app/Contents/Info.plist")" == "FoldviewMenuBar" ]]
[[ "$(plutil -extract CFBundleIdentifier raw -o - "$stage_app/Contents/Info.plist")" == "com.foldview.menubar" ]]
[[ "$(plutil -extract LSUIElement raw -o - "$stage_app/Contents/Info.plist")" == "true" ]]
codesign --force --deep --sign - "$stage_app"
codesign --verify --deep --strict "$stage_app"

swiftc "Packaging/atomic-install.swift" -o "$stage_root/atomic-install"
"$stage_root/atomic-install" "$stage_app" "$app_path"
codesign --verify --deep --strict "$app_path"
print "Installed: $app_path"
