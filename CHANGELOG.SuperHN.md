# WME Super House Numbers Changelog

## 0.1.4 - 2026-03-15

- Migrated SuperHN run toggle hotkey to WME SDK shortcut registration.
- Added SDK-managed `H` shortcut for start/stop when available.
- Added fallback unbound shortcut entry when `H` is already in use, so `H` can be assigned in WME Shortcuts to replace the native house-number key.
- Added startup status messaging in the SuperHN panel to indicate whether `H` was auto-bound or requires manual assignment.
- Kept `Esc` on legacy key-listener handling to exit click-numbering mode (not SDK shortcut-managed).
- Fixed click-mode sequence advancement so `Alt+Click` skip behavior works correctly immediately after placing a letter suffix with `Ctrl+Click`.
