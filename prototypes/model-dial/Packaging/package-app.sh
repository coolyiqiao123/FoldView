#!/bin/zsh
set -euo pipefail

source_root="${0:A:h:h}"
app_path="$HOME/Applications/Model Dial.app"

cd "$source_root"
swift build -c release

mkdir -p "$app_path/Contents/MacOS" "$app_path/Contents/Resources"
install -m 755 ".build/release/ModelDial" "$app_path/Contents/MacOS/ModelDial"
install -m 644 "Packaging/Info.plist" "$app_path/Contents/Info.plist"
codesign --force --deep --sign - "$app_path"
plutil -lint "$app_path/Contents/Info.plist"

echo "Installed: $app_path"
