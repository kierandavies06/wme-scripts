// ==UserScript==
// @name         WME Live Alerts
// @author       Kieran Davies
// @description  Display Live Map alerts in WME.
// @match        https://*.waze.com/*/editor*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=waze.com
// @updateURL    https://github.com/kierandavies06/wme-scripts/raw/refs/heads/main/WME-LiveAlerts.user.js
// @downloadURL  https://github.com/kierandavies06/wme-scripts/raw/refs/heads/main/WME-LiveAlerts.user.js
// @version      0.1.3
// @license      MIT
// @grant        none
// @namespace    https://greasyfork.org/users/1577571
// ==/UserScript==

(function () {
    'use strict';

    const LIVEMAP_API_URL = 'https://www.waze.com/live-map/api/georss';
    const ASSET_BASE_URL = 'https://raw.githubusercontent.com/kierandavies06/wme-scripts/refs/heads/main/assets/images/';
    const DEFAULT_ENV = 'row';
    const MAP_MOVE_FETCH_DEBOUNCE_MS = 800;
    const MIN_VISIBLE_ZOOM = 14;
    const ALERTS_LAYER_NAME = 'wme-live-alerts-layer';
    const ALERTS_LAYER_CHECKBOX_NAME = 'Live Alerts';

    const SCRIPT_ID = 'wme-live-alerts';
    const SCRIPT_NAME = 'WME Live Alerts';
    const SCRIPT_TAB_LABEL = 'Live Alerts';
    const LAYER_VISIBILITY_STORAGE_KEY = 'wme-live-alerts:layer-visible';

    const ALERT_DEFINITION_ROWS = {
        HAZARD: ['hazard.svg', 'Hazard'],
        HAZARD_ON_ROAD_POT_HOLE: ['pothole.svg', 'Pothole'],
        HAZARD_ON_SHOULDER_CAR_STOPPED: ['vehicle-stopped.svg', 'Vehicle stopped'],
        HAZARD_ON_ROAD_CONSTRUCTION: ['construction.svg', 'Construction'],
        HAZARD_WEATHER_FLOOD: ['flood.svg', 'Flooding'],
        HAZARD_ON_ROAD_OBJECT: ['object-on-road.svg', 'Object on road'],
        HAZARD_ON_ROAD_LANE_CLOSED: ['closure.svg', 'Lane closed'],
        ROAD_CLOSED: ['closure.svg', 'Road closed'],
        POLICE: ['police.svg', 'Police'],
        POLICE_HIDDEN: ['police-hidden.svg', 'Hidden police'],
        ACCIDENT: ['accident.svg', 'Accident'],
    };
    /** @type {Record<string, { spriteUrl: string, label: string }>} */
    const ALERT_DEFINITIONS = Object.entries(ALERT_DEFINITION_ROWS)
        .reduce((definitions, [key, [spriteUrl, label]]) => {
            definitions[key] = { spriteUrl, label };
            return definitions;
        }, {});

    let lastFetchedBounds = null;
    let cachedAlerts = [];
    let activeRequestController = null;
    let popupAlertsByFeatureId = new Map();
    let popupPageByFeatureId = new Map();
    let popupElement = null;
    let hoveredFeatureId = null;
    let pinnedFeatureId = null;
    let ignoreNextMapClickClose = false;
    let isAlertsLayerVisible = true;
    let userscriptsPanelElement = null;
    let userscriptsPanelActiveTab = 'stats';

    function debounce(fn, delayMs) {
        let timeoutId;
        return (...args) => {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => fn(...args), delayMs);
        };
    }

    function onEvent(sdk, eventName, eventHandler) {
        sdk.Events.on({ eventName, eventHandler });
    }

    function getStoredLayerVisibility() {
        try {
            const storedValue = window.localStorage.getItem(LAYER_VISIBILITY_STORAGE_KEY);
            return storedValue === null ? true : storedValue === 'true';
        } catch {
            return true;
        }
    }

    function setStoredLayerVisibility(isVisible) {
        try {
            window.localStorage.setItem(LAYER_VISIBILITY_STORAGE_KEY, String(Boolean(isVisible)));
        } catch {
        }
    }

    function getTopSubtypeStats(alerts, limit = 5) {
        const counts = new Map();
        (Array.isArray(alerts) ? alerts : []).forEach((alert) => {
            const code = alert?.type === 'HAZARD' ? (alert.subtype || alert.type) : alert?.type;
            const label = translateAlertCode(code) || 'Unknown';
            counts.set(label, (counts.get(label) || 0) + 1);
        });

        return Array.from(counts.entries())
            .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
            .slice(0, limit)
            .map(([label, count]) => ({ label, count }));
    }

    function updateUserscriptsPanelStats(alerts, statusText = '') {
        if (!userscriptsPanelElement) {
            return;
        }

        const totalAlerts = Array.isArray(alerts) ? alerts.length : 0;
        const topStats = getTopSubtypeStats(alerts);
        const statsHtml = topStats.length
            ? `<ol style="margin:6px 0 0 18px;padding:0;">${topStats.map(({ label, count }) => `<li><strong>${count}</strong> ${escapeHtml(label)}</li>`).join('')}</ol>`
            : '<div style="opacity:0.75;margin-top:6px;">No alerts yet.</div>';
        const isConfigTab = userscriptsPanelActiveTab === 'config';
        const tabButtonStyle = (isActive) => [
            'border:1px solid rgba(0,0,0,0.2)',
            'border-radius:4px',
            'padding:3px 8px',
            'font-size:11px',
            'cursor:pointer',
            isActive ? 'background:#ffffff;font-weight:600;' : 'background:rgba(255,255,255,0.45);',
        ].join(';');

        userscriptsPanelElement.innerHTML = `
            <div style="font-weight:600;font-size:13px;margin-bottom:8px;">${SCRIPT_NAME}</div>
            <div style="display:flex;gap:6px;margin-bottom:8px;">
                <button type="button" data-live-alerts-tab="config" style="${tabButtonStyle(isConfigTab)}">Config</button>
                <button type="button" data-live-alerts-tab="stats" style="${tabButtonStyle(!isConfigTab)}">Stats</button>
            </div>
            <div data-live-alerts-panel="config" style="border-top:1px solid rgba(0,0,0,0.1);padding-top:8px;${isConfigTab ? '' : 'display:none;'}">
                <div style="font-weight:600;margin-bottom:4px;">Config</div>
                <div style="opacity:0.8;">No config options yet.</div>
            </div>
            <div data-live-alerts-panel="stats" style="border-top:1px solid rgba(0,0,0,0.1);padding-top:8px;${isConfigTab ? 'display:none;' : ''}">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
                    <div style="font-weight:600;">Top alert subtypes</div>
                    <span style="font-size:11px;opacity:0.8;">${totalAlerts} total</span>
                </div>
                ${statsHtml}
                ${statusText ? `<div style="margin-top:8px;font-size:11px;opacity:0.75;">${escapeHtml(statusText)}</div>` : ''}
            </div>
        `;

        userscriptsPanelElement.querySelectorAll('[data-live-alerts-tab]').forEach((button) => {
            button.addEventListener('click', () => {
                userscriptsPanelActiveTab = button.getAttribute('data-live-alerts-tab') || 'stats';
                updateUserscriptsPanelStats(alerts, statusText);
            });
        });
    }

    async function initUserscriptsPanel(sdk) {
        if (userscriptsPanelElement && userscriptsPanelElement.isConnected) {
            updateUserscriptsPanelStats(cachedAlerts, isAtVisibleZoom(sdk) ? '' : `Zoom in to ${MIN_VISIBLE_ZOOM}+ to load alerts.`);
            return;
        }

        try {
            const { tabLabel, tabPane } = await sdk.Sidebar.registerScriptTab();
            tabLabel.textContent = SCRIPT_TAB_LABEL;

            userscriptsPanelElement = document.createElement('div');
            userscriptsPanelElement.id = `${SCRIPT_ID}-userscripts-panel`;
            tabPane.appendChild(userscriptsPanelElement);

            updateUserscriptsPanelStats(cachedAlerts, isAtVisibleZoom(sdk) ? '' : `Zoom in to ${MIN_VISIBLE_ZOOM}+ to load alerts.`);
        } catch (error) {
            console.error('[WME Live Alerts] Failed to initialize sidebar script tab', error);
        }
    }

    function getBoundsParams(sdk) {
        const [left, bottom, right, top] = sdk.Map.getMapExtent();
        return { top, left, bottom, right };
    }

    function getCurrentZoom(sdk) {
        const candidates = [
            Number(sdk?.Map?.getZoomLevel?.()),
            Number(window.W?.map?.getZoom?.()),
            Number(window.W?.map?.getOLMap?.()?.getView?.()?.getZoom?.()),
        ];
        for (const zoom of candidates) {
            if (Number.isFinite(zoom)) {
                return zoom;
            }
        }
        return null;
    }

    function isAtVisibleZoom(sdk) { return (getCurrentZoom(sdk) ?? -1) >= MIN_VISIBLE_ZOOM; }

    function shouldRequestAlerts(sdk) {
        return isAlertsLayerVisible && isAtVisibleZoom(sdk);
    }

    function clearAlertsFromLayer(sdk) {
        popupAlertsByFeatureId = new Map();
        closeAlertPopupState();
        sdk.Map.removeAllFeaturesFromLayer({
            layerName: ALERTS_LAYER_NAME,
        });
        updateUserscriptsPanelStats([], `Zoom in to ${MIN_VISIBLE_ZOOM}+ to load alerts.`);
    }

    function isBoundsInside(innerBounds, outerBounds) {
        return innerBounds.left >= outerBounds.left && innerBounds.right <= outerBounds.right
            && innerBounds.bottom >= outerBounds.bottom && innerBounds.top <= outerBounds.top;
    }

    function getAlertLonLat(alert) {
        if (!alert || typeof alert !== 'object') {
            return null;
        }

        if (alert.location && typeof alert.location === 'object') {
            const lon = Number(alert.location.x ?? alert.location.lon ?? alert.location.lng);
            const lat = Number(alert.location.y ?? alert.location.lat);
            if (Number.isFinite(lon) && Number.isFinite(lat)) {
                return { lon, lat };
            }
        }

        const lon = Number(alert.x ?? alert.lon ?? alert.lng);
        const lat = Number(alert.y ?? alert.lat);
        if (Number.isFinite(lon) && Number.isFinite(lat)) {
            return { lon, lat };
        }

        return null;
    }

    function isAlertInBounds(alert, bounds) {
        const lonLat = getAlertLonLat(alert);
        if (!lonLat) {
            return false;
        }

        return lonLat.lon >= bounds.left
            && lonLat.lon <= bounds.right
            && lonLat.lat >= bounds.bottom
            && lonLat.lat <= bounds.top;
    }

    function extractAlertsFromResponse(data) { return Array.isArray(data?.alerts) ? data.alerts : []; }

    function getAlertSpriteUrl(alert) {
        if (!alert || typeof alert !== 'object') {
            return null;
        }

        const hazardSpriteUrl = resolveSpriteUrl(ALERT_DEFINITIONS.HAZARD?.spriteUrl);

        if (alert.type === 'HAZARD') {
            if (alert.subtype && ALERT_DEFINITIONS[alert.subtype]?.spriteUrl) {
                return resolveSpriteUrl(ALERT_DEFINITIONS[alert.subtype].spriteUrl);
            }

            return hazardSpriteUrl;
        }

        return resolveSpriteUrl(ALERT_DEFINITIONS[alert.type]?.spriteUrl) || hazardSpriteUrl;
    }

    function resolveSpriteUrl(spriteUrl) {
        if (typeof spriteUrl !== 'string' || !spriteUrl) {
            return null;
        }

        if (spriteUrl.startsWith('http://') || spriteUrl.startsWith('https://') || spriteUrl.startsWith('data:')) {
            return spriteUrl;
        }

        return `${ASSET_BASE_URL}${spriteUrl}`;
    }

    function humanizeAlertCode(value) {
        if (typeof value !== 'string' || !value) {
            return null;
        }

        return value
            .toLowerCase()
            .split('_')
            .filter(Boolean)
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join(' ');
    }

    function translateAlertCode(value) {
        return (typeof value === 'string' && value)
            ? (ALERT_DEFINITIONS[value]?.label || humanizeAlertCode(value) || value)
            : null;
    }

    function buildAlertFeature(alert, index) {
        const lonLat = getAlertLonLat(alert);
        const spriteUrl = getAlertSpriteUrl(alert);
        if (!lonLat || !spriteUrl) {
            return null;
        }

        return {
            id: alert.id || alert.uuid || `live-alert-${index}`,
            type: 'Feature',
            geometry: {
                type: 'Point',
                coordinates: [lonLat.lon, lonLat.lat],
            },
            properties: {
                spriteUrl,
                alertType: alert.type || null,
                alertSubtype: alert.subtype || null,
                alertTypeText: translateAlertCode(alert.type),
                alertSubtypeText: translateAlertCode(alert.subtype),
                alertId: alert.id || null,
            },
        };
    }

    function buildClusterSpriteUrl(count) {
        const label = count > 99 ? '99+' : String(count);
        const fontSize = label.length >= 3 ? 18 : 20;
        const svg = `
            <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
                <circle cx="32" cy="32" r="24" fill="#f97316" stroke="#ffffff" stroke-width="3" />
                <text x="32" y="39" text-anchor="middle" fill="#ffffff" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="700">${label}</text>
            </svg>
        `;
        return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    }

    function buildClusterFeature(alertGroup, index) {
        if (!alertGroup || !Array.isArray(alertGroup.alerts) || alertGroup.alerts.length < 2) {
            return null;
        }

        const memberKey = alertGroup.alerts.map((alert) => alert.id || alert.uuid || '').filter(Boolean).slice(0, 4).join('-');

        return {
            id: `live-alert-cluster-${memberKey || index}-${alertGroup.alerts.length}-${Math.round(alertGroup.lon * 100000)}-${Math.round(alertGroup.lat * 100000)}`,
            type: 'Feature',
            geometry: {
                type: 'Point',
                coordinates: [alertGroup.lon, alertGroup.lat],
            },
            properties: {
                spriteUrl: buildClusterSpriteUrl(alertGroup.alerts.length),
                isCluster: true,
                clusterCount: alertGroup.alerts.length,
            },
        };
    }

    /**
     * @typedef {object} AlertRenderGroup
     * @property {Array<any>} alerts
     * @property {number} lon
     * @property {number} lat
     * @property {number} lonSum
     * @property {number} latSum
     */

    function groupAlertsForRendering(sdk, alerts) {
        const bounds = getBoundsParams(sdk);
        const degPerPixelX = Math.abs(bounds.right - bounds.left) / Math.max(1, window.innerWidth);
        const degPerPixelY = Math.abs(bounds.top - bounds.bottom) / Math.max(1, window.innerHeight);
        const clusterDistancePx = 30;

        /** @type {Array<AlertRenderGroup>} */
        const groups = [];
        alerts.forEach((alert) => {
            const lonLat = getAlertLonLat(alert);
            if (!lonLat) {
                return;
            }

            /** @type {AlertRenderGroup | null} */
            let nearestGroup = null;
            let nearestDistancePx = Number.POSITIVE_INFINITY;

            groups.forEach((group) => {
                const deltaX = degPerPixelX > 0 ? (lonLat.lon - group.lon) / degPerPixelX : Number.POSITIVE_INFINITY;
                const deltaY = degPerPixelY > 0 ? (lonLat.lat - group.lat) / degPerPixelY : Number.POSITIVE_INFINITY;
                const distancePx = Math.hypot(deltaX, deltaY);
                if (distancePx <= clusterDistancePx && distancePx < nearestDistancePx) {
                    nearestGroup = group;
                    nearestDistancePx = distancePx;
                }
            });

            if (!nearestGroup) {
                groups.push({
                    alerts: [alert],
                    lon: lonLat.lon,
                    lat: lonLat.lat,
                    lonSum: lonLat.lon,
                    latSum: lonLat.lat,
                });
                return;
            }

            nearestGroup.alerts.push(alert);
            nearestGroup.lonSum += lonLat.lon;
            nearestGroup.latSum += lonLat.lat;
            nearestGroup.lon = nearestGroup.lonSum / nearestGroup.alerts.length;
            nearestGroup.lat = nearestGroup.latSum / nearestGroup.alerts.length;
        });

        return groups;
    }

    function ensurePopupElement() {
        if (popupElement) {
            return popupElement;
        }

        popupElement = document.createElement('div');
        popupElement.style.position = 'fixed';
        popupElement.style.transform = 'translate(-50%, -100%)';
        popupElement.style.zIndex = '10000';
        popupElement.style.minWidth = '180px';
        popupElement.style.maxWidth = '260px';
        popupElement.style.padding = '8px 10px';
        popupElement.style.borderRadius = '8px';
        popupElement.style.background = '#1f2937';
        popupElement.style.color = '#ffffff';
        popupElement.style.fontSize = '12px';
        popupElement.style.lineHeight = '1.35';
        popupElement.style.boxShadow = '0 6px 18px rgba(0, 0, 0, 0.35)';
        popupElement.style.pointerEvents = 'auto';
        popupElement.style.display = 'none';
        popupElement.style.whiteSpace = 'normal';
        popupElement.style.border = '1px solid rgba(255, 255, 255, 0.12)';
        popupElement.style.overflowWrap = 'anywhere';
        popupElement.style.wordBreak = 'break-word';
        popupElement.style.hyphens = 'auto';
        popupElement.style.overflowX = 'hidden';
        popupElement.style.overflowY = 'auto';
        popupElement.addEventListener('click', (event) => {
            event.stopPropagation();
        });
        document.body.appendChild(popupElement);
        return popupElement;
    }

    function hideAlertPopup() {
        const popup = ensurePopupElement();
        popup.style.display = 'none';
        popup.innerHTML = '';
    }

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function formatAlertAge(pubMillis) {
        const publishedAt = Number(pubMillis);
        if (!Number.isFinite(publishedAt)) {
            return 'Unknown';
        }

        const elapsedMs = Math.max(0, Date.now() - publishedAt);
        const totalMinutes = Math.floor(elapsedMs / 60000);

        if (totalMinutes < 60) {
            return `${totalMinutes}m`;
        }

        const totalHours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        if (totalHours < 24) {
            const paddedMinutes = String(minutes).padStart(2, '0');
            return `${totalHours}h ${paddedMinutes}m`;
        }

        const days = Math.floor(totalHours / 24);
        const hours = totalHours % 24;
        return `${days}d ${hours}h`;
    }

    function buildSegmentedBar(segmentCount, filledValue, filledColor) {
        return `<div style="display:grid;grid-template-columns:repeat(${segmentCount}, 1fr);gap:2px;">${Array.from({ length: segmentCount }, (_, index) => {
            const isFilled = index < (filledValue ?? 0);
            const pillColor = isFilled ? filledColor : 'rgba(255,255,255,0.16)';
            return `<span style="height:7px;border-radius:999px;background:${pillColor};"></span>`;
        }).join('')}</div>`;
    }

    function getAlertPopupHtml(alerts, pageIndex) {
        const popupAlerts = Array.isArray(alerts) ? alerts : [];
        const totalPages = popupAlerts.length;
        const safePageIndex = totalPages ? Math.max(0, Math.min(totalPages - 1, pageIndex || 0)) : 0;
        const alert = popupAlerts[safePageIndex];
        if (!alert) {
            return '';
        }

        const typeText = alert.type === 'HAZARD'
            ? `${translateAlertCode(alert.type) || 'Hazard'} • ${translateAlertCode(alert.subtype) || 'Unknown subtype'}`
            : (translateAlertCode(alert.type) || 'Unknown alert type');

        const locationText = alert.street || alert.nearBy || alert.city || 'Unknown location';
        const thumbsUpCount = Number.isFinite(Number(alert.nThumbsUp)) ? Number(alert.nThumbsUp) : 0;
        const additionalInfoValue = typeof (alert.additionalInfo || alert.provider || '') === 'string'
            ? (alert.additionalInfo || alert.provider || '').trim()
            : '';
        const additionalInfoText = additionalInfoValue
            ? escapeHtml(additionalInfoValue).replace(/\n/g, '<br>')
            : '—';
        const descriptionValue = typeof (alert.reportDescription || '') === 'string'
            ? (alert.reportDescription || '').trim()
            : '';
        const descriptionText = descriptionValue
            ? escapeHtml(descriptionValue).replace(/\n/g, '<br>')
            : '—';
        const alertAgeText = formatAlertAge(alert.pubMillis);
        const reliabilityNumeric = Number(alert.reliability);
        const reliabilityValue = Number.isFinite(reliabilityNumeric)
            ? Math.max(0, Math.min(10, Math.round(reliabilityNumeric)))
            : null;
        const reliabilityLabel = reliabilityValue === null ? 'N/A' : `${reliabilityValue}/10`;
        const reliabilityColor = reliabilityValue === null
            ? '#6b7280'
            : `hsl(${Math.round((reliabilityValue / 10) * 120)}, 85%, 45%)`;
        const confidenceNumeric = Number(alert.confidence);
        const confidenceValue = Number.isFinite(confidenceNumeric)
            ? Math.max(0, Math.min(5, Math.round(confidenceNumeric)))
            : null;
        const confidenceLabel = confidenceValue === null ? 'N/A' : `${confidenceValue}/5`;
        const confidenceColor = confidenceValue === null
            ? '#6b7280'
            : `hsl(${Math.round((confidenceValue / 5) * 120)}, 85%, 45%)`;
        const reliabilityBarHtml = buildSegmentedBar(10, reliabilityValue, reliabilityColor);
        const confidenceBarHtml = buildSegmentedBar(5, confidenceValue, confidenceColor);
        const detailsHtml = [
            ['Location', escapeHtml(locationText)],
            ['Thumbs up', thumbsUpCount],
            ['Age', escapeHtml(alertAgeText)],
            ['Additional info', additionalInfoText],
        ].map(([label, value]) => `<div style="margin-bottom:4px;"><strong>${label}:</strong> ${value}</div>`).join('');
        const paginationHtml = totalPages > 1
            ? `
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;">
                    <button type="button" data-popup-prev="true" style="border:1px solid rgba(255,255,255,0.25);background:rgba(255,255,255,0.08);color:#ffffff;border-radius:4px;padding:1px 6px;cursor:pointer;">‹ Prev</button>
                    <span style="font-size:11px;opacity:0.9;">${safePageIndex + 1} / ${totalPages}</span>
                    <button type="button" data-popup-next="true" style="border:1px solid rgba(255,255,255,0.25);background:rgba(255,255,255,0.08);color:#ffffff;border-radius:4px;padding:1px 6px;cursor:pointer;">Next ›</button>
                </div>
            `
            : '';

        return `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px;">
                <div style="font-weight:600;font-size:12px;">${escapeHtml(typeText)}</div>
                <button type="button" data-popup-close="true" title="Close" style="border:0;background:transparent;color:#ffffff;cursor:pointer;font-size:16px;line-height:1;padding:0 2px;">×</button>
            </div>
            ${paginationHtml}
            ${detailsHtml}
            <div style="margin-bottom:6px;"><strong>Description:</strong> ${descriptionText}</div>
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px;">
                <strong>Reliability</strong>
                <span>${reliabilityLabel}</span>
            </div>
            <div style="margin-bottom:6px;">
                ${reliabilityBarHtml}
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px;">
                <strong>Confidence</strong>
                <span>${confidenceLabel}</span>
            </div>
            <div style="margin-bottom:6px;">
                ${confidenceBarHtml}
            </div>
            <div style="font-size:10px;line-height:1.2;color:rgba(255,255,255,0.58);text-align:right;">
                Sourced from Live Map
            </div>
        `;
    }

    function showAlertPopupForFeature(sdk, featureId) {
        const featureKey = String(featureId);
        const popupAlerts = popupAlertsByFeatureId.get(featureKey);
        if (!popupAlerts || !popupAlerts.length) {
            hideAlertPopup();
            return;
        }

        const totalPages = popupAlerts.length;
        const pageIndex = Math.max(0, Math.min(totalPages - 1, popupPageByFeatureId.get(featureKey) || 0));
        popupPageByFeatureId.set(featureKey, pageIndex);

        const featureElement = sdk.Map.getFeatureDomElement({
            layerName: ALERTS_LAYER_NAME,
            featureId,
        });
        if (!featureElement) {
            hideAlertPopup();
            return;
        }

        const rect = featureElement.getBoundingClientRect();
        const popup = ensurePopupElement();
        popup.innerHTML = getAlertPopupHtml(popupAlerts, pageIndex);

        const viewportPadding = 12;
        const maxPopupWidth = Math.max(220, window.innerWidth - (viewportPadding * 2));
        const maxPopupHeight = Math.max(160, window.innerHeight - (viewportPadding * 2));
        popup.style.maxWidth = `${maxPopupWidth}px`;
        popup.style.maxHeight = `${maxPopupHeight}px`;
        popup.style.visibility = 'hidden';
        popup.style.display = 'block';

        const popupWidth = popup.offsetWidth;
        const popupHeight = popup.offsetHeight;
        let left = rect.left + (rect.width / 2);
        let top = rect.top - 8;

        if ((left - (popupWidth / 2)) < viewportPadding) {
            left = viewportPadding + (popupWidth / 2);
        }
        if ((left + (popupWidth / 2)) > (window.innerWidth - viewportPadding)) {
            left = window.innerWidth - viewportPadding - (popupWidth / 2);
        }

        const canRenderAbove = (top - popupHeight) >= viewportPadding;
        if (canRenderAbove) {
            popup.style.transform = 'translate(-50%, -100%)';
            top = Math.max(viewportPadding + popupHeight, top);
        } else {
            popup.style.transform = 'translate(-50%, 0)';
            top = Math.min(
                window.innerHeight - viewportPadding - popupHeight,
                Math.max(viewportPadding, rect.bottom + 8),
            );
        }

        const closeButton = popup.querySelector('[data-popup-close="true"]');
        if (closeButton) {
            closeButton.addEventListener('click', (event) => {
                event.stopPropagation();
                closeAlertPopupState();
            });
        }
        const prevButton = popup.querySelector('[data-popup-prev="true"]');
        if (prevButton) {
            prevButton.addEventListener('click', (event) => {
                event.stopPropagation();
                const currentPage = popupPageByFeatureId.get(featureKey) || 0;
                popupPageByFeatureId.set(featureKey, currentPage <= 0 ? totalPages - 1 : currentPage - 1);
                showAlertPopupForFeature(sdk, featureId);
            });
        }
        const nextButton = popup.querySelector('[data-popup-next="true"]');
        if (nextButton) {
            nextButton.addEventListener('click', (event) => {
                event.stopPropagation();
                const currentPage = popupPageByFeatureId.get(featureKey) || 0;
                popupPageByFeatureId.set(featureKey, currentPage >= totalPages - 1 ? 0 : currentPage + 1);
                showAlertPopupForFeature(sdk, featureId);
            });
        }
        popup.style.left = `${left}px`;
        popup.style.top = `${top}px`;
        popup.style.visibility = 'visible';
    }

    function closeAlertPopupState() {
        hoveredFeatureId = null;
        pinnedFeatureId = null;
        popupPageByFeatureId.clear();
        hideAlertPopup();
    }

    function initAlertPopupHandlers(sdk) {
        sdk.Events.trackLayerEvents({ layerName: ALERTS_LAYER_NAME });

        onEvent(sdk, 'wme-layer-feature-mouse-enter', ({ layerName, featureId }) => {
            if (layerName !== ALERTS_LAYER_NAME || pinnedFeatureId) {
                return;
            }

            hoveredFeatureId = featureId;
            showAlertPopupForFeature(sdk, featureId);
        });

        onEvent(sdk, 'wme-layer-feature-mouse-leave', ({ layerName, featureId }) => {
            if (layerName !== ALERTS_LAYER_NAME || pinnedFeatureId) {
                return;
            }

            if (hoveredFeatureId === featureId) {
                hoveredFeatureId = null;
                hideAlertPopup();
            }
        });

        onEvent(sdk, 'wme-layer-feature-clicked', ({ layerName, featureId }) => {
            if (layerName !== ALERTS_LAYER_NAME) {
                return;
            }

            pinnedFeatureId = featureId;
            hoveredFeatureId = featureId;
            ignoreNextMapClickClose = true;
            setTimeout(() => {
                ignoreNextMapClickClose = false;
            }, 100);
            showAlertPopupForFeature(sdk, featureId);
        });

        onEvent(sdk, 'wme-map-mouse-click', () => {
            if (ignoreNextMapClickClose) {
                return;
            }

            closeAlertPopupState();
        });

        document.addEventListener('mousedown', (event) => {
            const popup = ensurePopupElement();
            if (popup.style.display !== 'none' && !popup.contains(event.target)) {
                closeAlertPopupState();
            }
        });
    }

    function renderAlertsOnLayer(sdk, alerts) {
        if (!isAtVisibleZoom(sdk)) {
            clearAlertsFromLayer(sdk);
            return;
        }

        popupAlertsByFeatureId = new Map();
        const alertGroups = groupAlertsForRendering(sdk, alerts);
        const features = alertGroups
            .map((alertGroup, index) => {
                if (alertGroup.alerts.length > 1) {
                    const clusterFeature = buildClusterFeature(alertGroup, index);
                    if (clusterFeature) {
                        const sortedClusterAlerts = [...alertGroup.alerts].sort((leftAlert, rightAlert) => {
                            const leftPubMillis = Number(leftAlert?.pubMillis) || 0;
                            const rightPubMillis = Number(rightAlert?.pubMillis) || 0;
                            return rightPubMillis - leftPubMillis;
                        });
                        popupAlertsByFeatureId.set(String(clusterFeature.id), sortedClusterAlerts);
                    }
                    return clusterFeature;
                }

                const singleAlert = alertGroup.alerts[0];
                const feature = buildAlertFeature(singleAlert, index);
                if (feature) {
                    popupAlertsByFeatureId.set(String(feature.id), [singleAlert]);
                }
                return feature;
            })
            .filter(Boolean);

        sdk.Map.removeAllFeaturesFromLayer({
            layerName: ALERTS_LAYER_NAME,
        });

        if (features.length) {
            sdk.Map.addFeaturesToLayer({
                layerName: ALERTS_LAYER_NAME,
                features,
            });
        }

        if (pinnedFeatureId && popupAlertsByFeatureId.has(String(pinnedFeatureId))) {
            showAlertPopupForFeature(sdk, pinnedFeatureId);
        } else if (hoveredFeatureId && popupAlertsByFeatureId.has(String(hoveredFeatureId)) && !pinnedFeatureId) {
            showAlertPopupForFeature(sdk, hoveredFeatureId);
        } else {
            closeAlertPopupState();
        }
    }

    function shouldSkipFetchForBounds(bounds) {
        if (!lastFetchedBounds || !isBoundsInside(bounds, lastFetchedBounds)) {
            return false;
        }
        return cachedAlerts.some((alert) => isAlertInBounds(alert, bounds));
    }

    async function fetchAlerts(sdk, bounds) {
        if (!shouldRequestAlerts(sdk)) {
            clearAlertsFromLayer(sdk);
            return;
        }

        const queryParams = new URLSearchParams({
            top: String(bounds.top),
            bottom: String(bounds.bottom),
            left: String(bounds.left),
            right: String(bounds.right),
            types: 'alerts', // Only fetch alerts (exclude jams, cameras, etc.)
            env: DEFAULT_ENV,
        });

        const url = `${LIVEMAP_API_URL}?${queryParams.toString()}`;

        try {
            if (activeRequestController) {
                activeRequestController.abort();
            }

            activeRequestController = new AbortController();
            const response = await fetch(url, {
                method: 'GET',
                credentials: 'include',
                signal: activeRequestController.signal,
            });
            const contentType = response.headers.get('content-type') || '';
            const data = contentType.includes('application/json')
                ? await response.json()
                : await response.text();

            if (response.ok && contentType.includes('application/json')) {
                cachedAlerts = extractAlertsFromResponse(data);
                lastFetchedBounds = bounds;
                renderAlertsOnLayer(sdk, cachedAlerts);
                updateUserscriptsPanelStats(cachedAlerts);
            } else {
                console.warn('[WME Live Alerts] Unexpected Live Map response', {
                    status: response.status,
                    ok: response.ok,
                    contentType,
                    url,
                });
            }
        } catch (error) {
            if (error && error.name === 'AbortError') {
                return;
            }
            console.error('[WME Live Alerts] Failed to fetch Live Map alerts', error);
        } finally {
            activeRequestController = null;
        }
    }

    function initAlertsLayer(sdk) {
        try {
            const initialLayerVisible = getStoredLayerVisibility();

            sdk.Map.addLayer({
                layerName: ALERTS_LAYER_NAME,
                styleContext: {
                    getSpriteUrl: ({ feature }) => feature?.properties?.spriteUrl || resolveSpriteUrl(ALERT_DEFINITIONS.HAZARD?.spriteUrl),
                },
                styleRules: [
                    {
                        style: {
                            externalGraphic: '${getSpriteUrl}',
                            graphicWidth: 41.5,
                            graphicHeight: 46,
                            graphicXOffset: -20.75,
                            graphicYOffset: -46,
                            graphicOpacity: 1,
                        },
                    },
                ],
            });

            sdk.LayerSwitcher.addLayerCheckbox({
                name: ALERTS_LAYER_CHECKBOX_NAME,
                isChecked: initialLayerVisible,
            });

            sdk.Map.setLayerVisibility({
                layerName: ALERTS_LAYER_NAME,
                visibility: initialLayerVisible,
            });
            isAlertsLayerVisible = initialLayerVisible;

            onEvent(sdk, 'wme-layer-checkbox-toggled', ({ name, checked }) => {
                if (name !== ALERTS_LAYER_CHECKBOX_NAME) {
                    return;
                }

                isAlertsLayerVisible = checked;
                setStoredLayerVisibility(checked);

                sdk.Map.setLayerVisibility({
                    layerName: ALERTS_LAYER_NAME,
                    visibility: checked,
                });

                if (!checked) {
                    if (activeRequestController) {
                        activeRequestController.abort();
                    }
                    closeAlertPopupState();
                }
            });

            initAlertPopupHandlers(sdk);
        } catch (error) {
            console.error('[WME Live Alerts] Failed to initialize layer and checkbox', {
                layerName: ALERTS_LAYER_NAME,
                checkboxName: ALERTS_LAYER_CHECKBOX_NAME,
                error,
            });
        }
    }

    function initScript() {
        const sdk = window.getWmeSdk({
            scriptId: SCRIPT_ID,
            scriptName: SCRIPT_NAME,
        });

        const debouncedFetchAlerts = debounce(() => {
            const bounds = getBoundsParams(sdk);
            if (shouldSkipFetchForBounds(bounds)) {
                return;
            }

            fetchAlerts(sdk, bounds);
        }, MAP_MOVE_FETCH_DEBOUNCE_MS);

        sdk.Events.once({ eventName: 'wme-ready' }).then(() => {
            initAlertsLayer(sdk);
            initUserscriptsPanel(sdk);

            if (shouldRequestAlerts(sdk)) {
                fetchAlerts(sdk, getBoundsParams(sdk));
            } else {
                clearAlertsFromLayer(sdk);
            }

            onEvent(sdk, 'wme-map-move', () => {
                if (!shouldRequestAlerts(sdk)) {
                    if (activeRequestController) activeRequestController.abort();
                    clearAlertsFromLayer(sdk);
                    return;
                }

                debouncedFetchAlerts();
            });
        });
    }

    function waitForSdkAndInit() {
        if (window.SDK_INITIALIZED && typeof window.SDK_INITIALIZED.then === 'function') {
            window.SDK_INITIALIZED.then(initScript);
        } else {
            console.error('[WME Live Alerts] SDK_INITIALIZED is unavailable');
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', waitForSdkAndInit, { once: true });
    } else {
        waitForSdkAndInit();
    }
})();