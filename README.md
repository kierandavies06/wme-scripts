# WME Scripts

Userscripts for Waze Map Editor (WME), maintained in a single repository.

---

## Published userscripts

#### 1) WME Live Alerts
[![Install WME Live Alerts](https://img.shields.io/badge/Install%20from%20Greasy%20Fork-WME%20Live%20Alerts-red?style=for-the-badge&logo=greasyfork)](https://greasyfork.org/en/scripts/568671-wme-live-alerts)

Displays Live Map alerts directly in WME so you can review active reports while editing.

- Script file: `WME-LiveAlerts.user.js`
- Current in-repo version: `0.1.2`
- Description: `Display Live Map alerts in WME.`

**Greasy Fork URL:**
- `https://greasyfork.org/en/scripts/568671-wme-live-alerts`

---

#### 2) WME Super House Numbers
[![Install WME Super House Numbers](https://img.shields.io/badge/Install%20from%20Greasy%20Fork-WME%20Super%20House%20Numbers-red?style=for-the-badge&logo=greasyfork)](https://greasyfork.org/en/scripts/568930-wme-super-house-numbers)

Speeds up house-number entry with draw-line, click-to-add, odd/even, increment, skip-13, and scan/review utilities.

- Script file: `WME-SuperHN.user.js`
- Current in-repo version: `0.1.0`
- Description: `Rapidly add equally spaced house numbers along a drawn line, with odd/even and skip-13 support.`

**Greasy Fork URL:**
- `https://greasyfork.org/en/scripts/568930-wme-super-house-numbers`

---

### Source install (GitHub raw)

If you install directly from GitHub raw URLs instead of Greasy Fork:

- `https://github.com/kierandavies06/wme-scripts/raw/refs/heads/main/WME-LiveAlerts.user.js`
- `https://github.com/kierandavies06/wme-scripts/raw/refs/heads/main/WME-SuperHN.user.js`

---

## Planning Maps User Style

I have also created a custom user stylesheet to improve maximise the usability of certain council planning maps when used alongside WME for finding and verifying house numbers.
You can install this user style in a userstyle manager like [Stylus](https://add0n.com/stylus.html).

### Currently modified sites:
- Luton Council: `https://planning.luton.gov.uk/online-applications/`
- Central Bedfordshire Council: `https://my.centralbedfordshire.gov.uk/`

If you would like me to add support for other councils' planning maps, please open an issue with the URL of the council's public planning map.

**Style file:** `planning-maps.user.css`



## Automatic updates

Updates are automatic once installed.

- If installed from **Greasy Fork**, your userscript manager (e.g. Tampermonkey/Violentmonkey) will periodically check for and install updates.
- If installed from the **GitHub raw URL**, your userscript manager can also auto-update from the script `@updateURL`/`@downloadURL` metadata.

When changes are pushed to `main`, Greasy Fork is notified via webhook and users receive updates through their script manager's normal update checks.
