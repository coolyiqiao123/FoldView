# Model Dial

Model Dial is a compact macOS menu-bar controller for the locally installed Codex and Kimi Code CLIs.

It reads each tool's live model catalog, lets you slide between available models and reasoning levels, saves persistent defaults, and launches a selected configuration in Terminal.

## Build

```sh
swift test
swift build -c release
```

The packaged application is installed at `~/Applications/Model Dial.app`.

## Configuration safety

- Codex settings are updated in `~/.codex/config.toml`.
- Kimi settings are updated in `~/.kimi-code/config.toml`.
- Before a write, Model Dial creates a sibling `model-dial.backup` file.
- Existing file permissions are preserved.
- API keys and credential files are never read into the interface.
