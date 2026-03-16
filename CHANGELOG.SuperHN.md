# WME Super House Numbers Changelog

## 0.2.0 - 2026-03-16

- Added support for both `RPP` and `HN` placement workflows, following UK best practices for placing house numbers on numbered roads.
- Added a dedicated panel hint that shows the currently detected target street used in `RPP` mode.
- The hint now displays normalized numbered-road conversion when applicable (for example `A505 - High St N` → `High St N`).
- Added a muted `RPP preview` hint in `HN` mode so the converted RPP target street is visible before switching modes.
- Updated `RPP` placement flow to create residential places without forcing address/house-number assignment in-script.
- Wired RPP street resolution to use `getOrCreateDeNumberedStreet()` based on the currently selected segment's road name.
- Refined numbered-road parsing for de-numbering to support prefixes in the format `A` + `1..4` digits + optional trailing letter + ` - ` (for example `A123A - Example Road`).

## 0.1.5 - 2026-03-16

- Added a new placement mode toggle to choose between `HN` and `RPP` output.
- Added optional auto-switch to `RPP` mode when a selected road appears to be a numbered road.
- Added Residential Place Point placement support for line, area, and click workflows using the same numbering sequence logic as HNs.
- Added numbered-road street-name normalization for RPP mode so roads like `A505 - High St N` place against `High St N`.
- Added fallback street resolution/creation for RPP mode when the normalized street is missing from the loaded street model.

## 0.1.4 - 2026-03-15

- Migrated SuperHN run toggle hotkey to WME SDK shortcut registration.
- Added SDK-managed `H` shortcut for start/stop when available.
- Added fallback unbound shortcut entry when `H` is already in use, so `H` can be assigned in WME Shortcuts to replace the native house-number key.
- Added startup status messaging in the SuperHN panel to indicate whether `H` was auto-bound or requires manual assignment.
- Kept `Esc` on legacy key-listener handling to exit click-numbering mode (not SDK shortcut-managed).
- Fixed click-mode sequence advancement so `Alt+Click` skip behavior works correctly immediately after placing a letter suffix with `Ctrl+Click`.
