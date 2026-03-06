// ==UserScript==
// @name         WME Live Alerts
// @author       Kieran Davies
// @description  Display LiveMap alerts on WME using the WME Scripts SDK and the Waze Live Map API.
// @match        https://*.waze.com/*/editor*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=waze.com
// @updateURL    https://github.com/kierandavies06/wme-scripts/raw/refs/heads/main/WME-LiveAlerts.user.js
// @version      0.1.1
// @license      MIT
// @grant        none
// @namespace    https://greasyfork.org/users/1577571
// ==/UserScript==

(function () {
    'use strict';

    // Livemap API endpoint for fetching alerts
    // Note: The Waze Live Map API is not officially documented.
    // Required Query Parameters:
    // - top: The northernmost latitude of the bounding box.
    // - left: The westernmost longitude of the bounding box.
    // - bottom: The southernmost latitude of the bounding box.
    // - right: The easternmost longitude of the bounding box.
    // - env: Environment (e.g. 'usa', 'row', 'il') 
    const LIVEMAP_API_URL = 'https://www.waze.com/live-map/api/georss';
    const DEFAULT_ENV = 'row'; // Default environment if not specified (Rest of World)
    const MAP_MOVE_FETCH_DEBOUNCE_MS = 800;
    const ALERTS_LAYER_NAME = 'wme-live-alerts-layer';
    const ALERTS_LAYER_CHECKBOX_NAME = 'Live Alerts';

    const SCRIPT_ID = 'wme-live-alerts';
    const SCRIPT_NAME = 'WME Live Alerts';

    const ALERT_DEFINITIONS = {
        HAZARD: {
            spriteUrl: 'https://raw.githubusercontent.com/kierandavies06/wme-scripts/refs/heads/main/assets/images/hazard.svg',
            label: 'Hazard',
        },
        HAZARD_ON_ROAD_POT_HOLE: {
            spriteUrl: 'https://raw.githubusercontent.com/kierandavies06/wme-scripts/refs/heads/main/assets/images/pothole.svg',
            label: 'Pothole',
        },
        HAZARD_ON_SHOULDER_CAR_STOPPED: {
            spriteUrl: 'https://raw.githubusercontent.com/kierandavies06/wme-scripts/refs/heads/main/assets/images/vehicle-stopped.svg',
            label: 'Vehicle stopped',
        },
        HAZARD_ON_ROAD_CONSTRUCTION: {
            spriteUrl: 'https://raw.githubusercontent.com/kierandavies06/wme-scripts/refs/heads/main/assets/images/construction.svg',
            label: 'Construction',
        },
        HAZARD_WEATHER_FLOOD: {
            spriteUrl: 'https://raw.githubusercontent.com/kierandavies06/wme-scripts/refs/heads/main/assets/images/flood.svg',
            label: 'Flooding',
        },
        HAZARD_ON_ROAD_OBJECT: {
            spriteUrl: 'https://raw.githubusercontent.com/kierandavies06/wme-scripts/refs/heads/main/assets/images/object-on-road.svg',
            label: 'Object on road',
        },
        HAZARD_ON_ROAD_LANE_CLOSED: {
            spriteUrl: 'https://raw.githubusercontent.com/kierandavies06/wme-scripts/refs/heads/main/assets/images/closure.svg',
            label: 'Lane closed',
        },
        ROAD_CLOSED: {
            spriteUrl: 'https://raw.githubusercontent.com/kierandavies06/wme-scripts/refs/heads/main/assets/images/closure.svg',
            label: 'Road closed',
        },
        POLICE: {
            spriteUrl: 'https://raw.githubusercontent.com/kierandavies06/wme-scripts/refs/heads/main/assets/images/police.svg',
            label: 'Police',
        },
        POLICE_HIDDEN: {
            spriteUrl: 'https://raw.githubusercontent.com/kierandavies06/wme-scripts/refs/heads/main/assets/images/police-hidden.svg',
            label: 'Hidden police',
        },
        ACCIDENT: {
            spriteUrl: 'https://raw.githubusercontent.com/kierandavies06/wme-scripts/refs/heads/main/assets/images/accident.svg',
            label: 'Accident',
        },
    };

    let lastFetchedBounds = null;
    let cachedAlerts = [];
    let activeRequestController = null;
    let alertsByFeatureId = new Map();
    let popupElement = null;
    let hoveredFeatureId = null;
    let pinnedFeatureId = null;
    let ignoreNextMapClickClose = false;

    function debounce(fn, delayMs) {
        let timeoutId;
        return (...args) => {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => {
                fn(...args);
            }, delayMs);
        };
    }

    function getBoundsParams(sdk) {
        const [left, bottom, right, top] = sdk.Map.getMapExtent();
        return {
            top,
            left,
            bottom,
            right,
        };
    }

    function isBoundsInside(innerBounds, outerBounds) {
        return innerBounds.left >= outerBounds.left
            && innerBounds.right <= outerBounds.right
            && innerBounds.bottom >= outerBounds.bottom
            && innerBounds.top <= outerBounds.top;
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

    function extractAlertsFromResponse(data) {
        if (!data || typeof data !== 'object') {
            return [];
        }

        if (Array.isArray(data.alerts)) {
            return data.alerts;
        }

        return [];
    }

    function getAlertSpriteUrl(alert) {
        if (!alert || typeof alert !== 'object') {
            return null;
        }

        if (alert.type === 'HAZARD') {
            if (alert.subtype && ALERT_DEFINITIONS[alert.subtype]?.spriteUrl) {
                return ALERT_DEFINITIONS[alert.subtype].spriteUrl;
            }

            return ALERT_DEFINITIONS.HAZARD?.spriteUrl || null;
        }

        return ALERT_DEFINITIONS[alert.type]?.spriteUrl || null;
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
        if (typeof value !== 'string' || !value) {
            return null;
        }

        return ALERT_DEFINITIONS[value]?.label || humanizeAlertCode(value) || value;
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

    function getAlertPopupHtml(alert) {
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
        const reliabilityBarHtml = `<div style="display:grid;grid-template-columns:repeat(10, 1fr);gap:2px;">${Array.from({ length: 10 }, (_, index) => {
            const isFilled = index < (reliabilityValue ?? 0);
            const pillColor = isFilled ? reliabilityColor : 'rgba(255,255,255,0.16)';
            return `<span style="height:7px;border-radius:999px;background:${pillColor};"></span>`;
        }).join('')}</div>`;
        const confidenceBarHtml = `<div style="display:grid;grid-template-columns:repeat(5, 1fr);gap:2px;">${Array.from({ length: 5 }, (_, index) => {
            const isFilled = index < (confidenceValue ?? 0);
            const pillColor = isFilled ? confidenceColor : 'rgba(255,255,255,0.16)';
            return `<span style="height:7px;border-radius:999px;background:${pillColor};"></span>`;
        }).join('')}</div>`;

        return `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px;">
                <div style="font-weight:600;font-size:12px;">${escapeHtml(typeText)}</div>
                <button type="button" data-popup-close="true" title="Close" style="border:0;background:transparent;color:#ffffff;cursor:pointer;font-size:16px;line-height:1;padding:0 2px;">×</button>
            </div>
            <div style="margin-bottom:4px;"><strong>Location:</strong> ${escapeHtml(locationText)}</div>
            <div style="margin-bottom:4px;"><strong>Thumbs up:</strong> ${thumbsUpCount}</div>
            <div style="margin-bottom:4px;"><strong>Age:</strong> ${escapeHtml(alertAgeText)}</div>
            <div style="margin-bottom:4px;"><strong>Additional info:</strong> ${additionalInfoText}</div>
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
        const alert = alertsByFeatureId.get(String(featureId));
        if (!alert) {
            hideAlertPopup();
            return;
        }

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
        popup.innerHTML = getAlertPopupHtml(alert);

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
        popup.style.left = `${left}px`;
        popup.style.top = `${top}px`;
        popup.style.visibility = 'visible';
    }

    function closeAlertPopupState() {
        hoveredFeatureId = null;
        pinnedFeatureId = null;
        hideAlertPopup();
    }

    function initAlertPopupHandlers(sdk) {
        sdk.Events.trackLayerEvents({ layerName: ALERTS_LAYER_NAME });

        sdk.Events.on({
            eventName: 'wme-layer-feature-mouse-enter',
            eventHandler: ({ layerName, featureId }) => {
                if (layerName !== ALERTS_LAYER_NAME || pinnedFeatureId) {
                    return;
                }

                hoveredFeatureId = featureId;
                showAlertPopupForFeature(sdk, featureId);
            },
        });

        sdk.Events.on({
            eventName: 'wme-layer-feature-mouse-leave',
            eventHandler: ({ layerName, featureId }) => {
                if (layerName !== ALERTS_LAYER_NAME || pinnedFeatureId) {
                    return;
                }

                if (hoveredFeatureId === featureId) {
                    hoveredFeatureId = null;
                    hideAlertPopup();
                }
            },
        });

        sdk.Events.on({
            eventName: 'wme-layer-feature-clicked',
            eventHandler: ({ layerName, featureId }) => {
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
            },
        });

        sdk.Events.on({
            eventName: 'wme-map-mouse-click',
            eventHandler: () => {
                if (ignoreNextMapClickClose) {
                    return;
                }

                closeAlertPopupState();
            },
        });

        document.addEventListener('mousedown', (event) => {
            const popup = ensurePopupElement();
            if (popup.style.display !== 'none' && !popup.contains(event.target)) {
                closeAlertPopupState();
            }
        });
    }

    function renderAlertsOnLayer(sdk, alerts) {
        alertsByFeatureId = new Map();
        const features = alerts
            .map((alert, index) => {
                const feature = buildAlertFeature(alert, index);
                if (feature) {
                    alertsByFeatureId.set(String(feature.id), alert);
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

        console.log('[WME Live Alerts] Alerts rendered on layer', {
            totalAlerts: alerts.length,
            renderedFeatures: features.length,
        });

        if (pinnedFeatureId && alertsByFeatureId.has(String(pinnedFeatureId))) {
            showAlertPopupForFeature(sdk, pinnedFeatureId);
        } else if (hoveredFeatureId && alertsByFeatureId.has(String(hoveredFeatureId)) && !pinnedFeatureId) {
            showAlertPopupForFeature(sdk, hoveredFeatureId);
        } else {
            closeAlertPopupState();
        }
    }

    function shouldSkipFetchForBounds(bounds) {
        if (!lastFetchedBounds || !isBoundsInside(bounds, lastFetchedBounds)) {
            return false;
        }

        const hasCachedAlertInView = cachedAlerts.some((alert) => isAlertInBounds(alert, bounds));
        return hasCachedAlertInView;
    }

    async function fetchAlerts(sdk, bounds) {
        const queryParams = new URLSearchParams({
            top: String(bounds.top),
            bottom: String(bounds.bottom),
            left: String(bounds.left),
            right: String(bounds.right),
            types: 'alerts', // Only fetch alerts (exclude jams, cameras, etc.)
            env: DEFAULT_ENV,
        });

        const url = `${LIVEMAP_API_URL}?${queryParams.toString()}`;
        console.log('[WME Live Alerts] Fetching Live Map alerts', { url, ...bounds });

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
            }

            console.log('[WME Live Alerts] Live Map API response', {
                status: response.status,
                ok: response.ok,
                data,
            });
        } catch (error) {
            if (error && error.name === 'AbortError') {
                console.log('[WME Live Alerts] Previous request aborted in favor of a newer one');
                return;
            }
            console.error('[WME Live Alerts] Failed to fetch Live Map alerts', error);
        } finally {
            activeRequestController = null;
        }
    }

    function initAlertsLayer(sdk) {
        try {
            sdk.Map.addLayer({
                layerName: ALERTS_LAYER_NAME,
                styleContext: {
                    getSpriteUrl: ({ feature }) => feature?.properties?.spriteUrl || ALERT_DEFINITIONS.HAZARD?.spriteUrl,
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
                isChecked: true,
            });

            sdk.Map.setLayerVisibility({
                layerName: ALERTS_LAYER_NAME,
                visibility: true,
            });

            sdk.Events.on({
                eventName: 'wme-layer-checkbox-toggled',
                eventHandler: ({ name, checked }) => {
                    if (name !== ALERTS_LAYER_CHECKBOX_NAME) {
                        return;
                    }

                    sdk.Map.setLayerVisibility({
                        layerName: ALERTS_LAYER_NAME,
                        visibility: checked,
                    });

                    if (!checked) {
                        closeAlertPopupState();
                    }
                },
            });

            initAlertPopupHandlers(sdk);

            console.log('[WME Live Alerts] Layer and checkbox initialized', {
                layerName: ALERTS_LAYER_NAME,
                checkboxName: ALERTS_LAYER_CHECKBOX_NAME,
            });
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
                console.log('[WME Live Alerts] Skipping fetch; cached alerts already cover current map bounds', bounds);
                return;
            }

            fetchAlerts(sdk, bounds);
        }, MAP_MOVE_FETCH_DEBOUNCE_MS);

        sdk.Events.once({ eventName: 'wme-ready' }).then(() => {
            initAlertsLayer(sdk);
            console.log('[WME Live Alerts] WME ready; fetching test API response');
            fetchAlerts(sdk, getBoundsParams(sdk));

            sdk.Events.on({
                eventName: 'wme-map-move',
                eventHandler: () => {
                    debouncedFetchAlerts();
                },
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