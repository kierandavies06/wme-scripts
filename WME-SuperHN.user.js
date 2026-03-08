// ==UserScript==
// @name         WME Super House Numbers
// @author       Kieran Davies
// @description  Rapidly add equally spaced house numbers along a drawn line, with odd/even and skip-13 support.
// @match        https://*.waze.com/*/editor*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=waze.com
// @updateURL    https://github.com/kierandavies06/wme-scripts/raw/refs/heads/main/WME-SuperHN.user.js
// @downloadURL  https://github.com/kierandavies06/wme-scripts/raw/refs/heads/main/WME-SuperHN.user.js
// @version      0.1.0
// @license      MIT
// @grant        none
// @namespace    https://greasyfork.org/users/1577571
// ==/UserScript==

(function () {
    'use strict';

    const SCRIPT_ID = 'wme-super-house-numbers';
    const SCRIPT_NAME = 'WME Super House Numbers';
    const OVERLAY_PANEL_ID = `${SCRIPT_ID}-overlay`;
    const OVERLAY_LAUNCHER_ID = `${SCRIPT_ID}-launcher`;
    const SETTINGS_STORAGE_KEY = `${SCRIPT_ID}-settings`;
    const OVERLAY_STATE_STORAGE_KEY = `${SCRIPT_ID}-overlay-state`;
    const FALSE_POSITIVE_STORAGE_KEY = `${SCRIPT_ID}-false-positive-roads`;

    const UI_IDS = {
        header: 'superhn-overlay-header',
        body: 'superhn-overlay-body',
        collapse: 'superhn-overlay-collapse',
        close: 'superhn-overlay-close',
        toolLocation: 'superhn-tool-location',
        workflow: 'superhn-workflow',
        start: 'superhn-start-number',
        endWrap: 'superhn-end-wrap',
        end: 'superhn-end-number',
        mode: 'superhn-mode',
        incrementWrap: 'superhn-increment-wrap',
        increment: 'superhn-increment',
        skip13: 'superhn-skip-13',
        run: 'superhn-run',
        status: 'superhn-status',
        tip: 'superhn-tip',
    };

    const SIDEBAR_IDS = {
        root: 'superhn-sidebar-root',
        scannerPanel: 'superhn-sidebar-scanner-panel',
        scanMissing: 'superhn-scan-missing',
        showFalsePositives: 'superhn-show-false-positives',
        missingList: 'superhn-missing-list',
        status: 'superhn-scanner-status',
    };

    let panelElement = null;
    let launcherElement = null;
    let isRunning = false;
    let isCollapsed = false;
    let isPanelClosed = false;
    let isDragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    let clickNumberingSession = null;
    let lastMapMouseLonLat = null;
    let lastSelectedRoadKey = null;
    let pendingCtrlClickModifier = false;
    let pendingCtrlClickModifierAt = 0;
    let pendingAltClickModifier = false;
    let pendingAltClickModifierAt = 0;
    let isCtrlModifierHeld = false;
    let isAltModifierHeld = false;
    let missingRoadRows = [];
    let missingRoadCityLabel = '';
    let falsePositiveRoads = loadFalsePositiveRoads();
    let sidebarScannerElement = null;
    let sidebarMountTimerId = null;
    let sidebarScannerSdk = null;
    let scriptsTabContentRoot = null;
    let scriptsTabLabelElement = null;
    let scriptsTabInitPromise = null;

    function normalizeFalsePositiveRoads(rawValue) {
        if (!rawValue || typeof rawValue !== 'object') {
            return {};
        }

        const normalized = {};
        Object.entries(rawValue).forEach(([key, value]) => {
            if (key && value === true) {
                normalized[key] = true;
            }
        });
        return normalized;
    }

    function loadFalsePositiveRoads() {
        try {
            const raw = localStorage.getItem(FALSE_POSITIVE_STORAGE_KEY);
            if (!raw) {
                return {};
            }
            return normalizeFalsePositiveRoads(JSON.parse(raw));
        } catch {
            return {};
        }
    }

    function saveFalsePositiveRoads(map) {
        try {
            localStorage.setItem(FALSE_POSITIVE_STORAGE_KEY, JSON.stringify(normalizeFalsePositiveRoads(map)));
        } catch {
        }
    }

    function getRoadFalsePositiveKey(cityKey, roadKey) {
        return `${cityKey}::${roadKey}`;
    }

    function setRoadFalsePositive(cityKey, roadKey, enabled) {
        const key = getRoadFalsePositiveKey(cityKey, roadKey);
        if (enabled) {
            falsePositiveRoads[key] = true;
        } else {
            delete falsePositiveRoads[key];
        }
        saveFalsePositiveRoads(falsePositiveRoads);
    }

    function isRoadFalsePositive(cityKey, roadKey) {
        return Boolean(falsePositiveRoads[getRoadFalsePositiveKey(cityKey, roadKey)]);
    }

    function normalizeSegmentEntries(raw) {
        if (Array.isArray(raw)) {
            return raw;
        }

        if (raw && typeof raw === 'object') {
            const values = Object.values(raw);
            if (values.length > 0 && values.every((item) => item && typeof item === 'object')) {
                return values;
            }
        }

        return [];
    }

    function getAllSegments(sdk) {
        const segmentsApi = sdk?.DataModel?.Segments;
        if (!segmentsApi) {
            return [];
        }

        const tryCalls = [
            () => segmentsApi.getAll?.(),
            () => segmentsApi.getAllSegments?.(),
            () => segmentsApi.getSegments?.(),
        ];

        for (const call of tryCalls) {
            try {
                const normalized = normalizeSegmentEntries(call());
                if (normalized.length) {
                    return normalized;
                }
            } catch {
            }
        }

        return [];
    }

    function tryFirstValidCall(tryCalls, isValid = (value) => Boolean(value)) {
        for (const call of tryCalls) {
            try {
                const value = call();
                if (isValid(value)) {
                    return value;
                }
            } catch {
            }
        }

        return null;
    }

    function getStreetByIdSafe(sdk, streetId) {
        if (!Number.isFinite(streetId)) {
            return null;
        }

        const streetsApi = sdk?.DataModel?.Streets;
        if (!streetsApi) {
            return null;
        }

        const tryCalls = [
            () => streetsApi.getById?.({ streetId }),
            () => streetsApi.getById?.({ id: streetId }),
            () => streetsApi.getById?.(streetId),
        ];

        return tryFirstValidCall(tryCalls);
    }

    function getCityByIdSafe(sdk, cityId) {
        if (!Number.isFinite(cityId)) {
            return null;
        }

        const citiesApi = sdk?.DataModel?.Cities;
        if (!citiesApi) {
            return null;
        }

        const tryCalls = [
            () => citiesApi.getById?.({ cityId }),
            () => citiesApi.getById?.({ id: cityId }),
            () => citiesApi.getById?.(cityId),
        ];

        return tryFirstValidCall(tryCalls);
    }

    function getSegmentByIdSafe(sdk, segmentId) {
        if (!Number.isFinite(segmentId)) {
            return null;
        }

        const segmentsApi = sdk?.DataModel?.Segments;
        if (!segmentsApi) {
            return null;
        }

        const tryCalls = [
            () => segmentsApi.getById?.({ segmentId }),
            () => segmentsApi.getById?.({ id: segmentId }),
            () => segmentsApi.getById?.(segmentId),
        ];

        return tryFirstValidCall(tryCalls);
    }

    function getSegmentHasHouseNumbers(segment) {
        if (!segment || typeof segment !== 'object') {
            return false;
        }

        const getAttribute = typeof segment.getAttribute === 'function'
            ? (key) => {
                try {
                    return segment.getAttribute(key);
                } catch {
                    return undefined;
                }
            }
            : () => undefined;

        const positiveCountCandidates = [
            segment.houseNumberCount,
            segment.houseNumbersCount,
            segment.hnCount,
            segment.hnTotal,
            segment?.attributes?.houseNumberCount,
            segment?.attributes?.houseNumbersCount,
            segment?.attributes?.hnCount,
            getAttribute('houseNumberCount'),
            getAttribute('houseNumbersCount'),
            getAttribute('hnCount'),
        ];

        if (positiveCountCandidates.some((value) => Number.isFinite(Number(value)) && Number(value) > 0)) {
            return true;
        }

        const truthyFlagCandidates = [
            segment.hasHNs,
            segment.hasHouseNumbers,
            segment?.attributes?.hasHNs,
            segment?.attributes?.hasHouseNumbers,
            getAttribute('hasHNs'),
            getAttribute('hasHouseNumbers'),
        ];

        if (truthyFlagCandidates.some((value) => value === true)) {
            return true;
        }

        const arrayCandidates = [
            segment.houseNumbers,
            segment.hns,
            segment?.attributes?.houseNumbers,
            segment?.attributes?.hns,
        ];

        if (arrayCandidates.some((value) => Array.isArray(value) && value.length > 0)) {
            return true;
        }

        return false;
    }

    function getSegmentRoadMetadata(sdk, segment, streetCache, cityCache) {
        const segmentId = Number(segment?.id);
        if (!Number.isFinite(segmentId)) {
            return null;
        }

        const streetIdRaw = Number(segment?.primaryStreetId);
        const hasStreet = Number.isFinite(streetIdRaw) && streetIdRaw > 0;
        const roadKey = hasStreet ? `street:${streetIdRaw}` : `segment:${segmentId}`;

        let street = null;
        if (hasStreet) {
            if (streetCache.has(streetIdRaw)) {
                street = streetCache.get(streetIdRaw);
            } else {
                street = getStreetByIdSafe(sdk, streetIdRaw);
                streetCache.set(streetIdRaw, street || null);
            }
        }

        const cityId = Number(street?.cityID ?? street?.cityId ?? street?.city?.id);
        let city = null;
        if (Number.isFinite(cityId)) {
            if (cityCache.has(cityId)) {
                city = cityCache.get(cityId);
            } else {
                city = getCityByIdSafe(sdk, cityId);
                cityCache.set(cityId, city || null);
            }
        }

        const cityName = String(city?.name ?? street?.cityName ?? 'Unknown city').trim() || 'Unknown city';
        const cityKey = Number.isFinite(cityId) ? `city:${cityId}` : `cityname:${cityName.toLowerCase()}`;
        const streetNameRaw = String(street?.name ?? segment?.streetName ?? '').trim();
        const hasValidRoadName = streetNameRaw.length > 0 && streetNameRaw.toLowerCase() !== 'none';
        const roadName = hasValidRoadName ? streetNameRaw : `Unnamed road (${roadKey})`;

        return {
            segmentId,
            roadKey,
            roadName,
            cityKey,
            cityName,
            coordinates: Array.isArray(segment?.geometry?.coordinates) ? segment.geometry.coordinates : [],
            hasHouseNumbers: getSegmentHasHouseNumbers(segment),
            hasValidRoadName,
        };
    }

    function getMapCenterLonLat(sdk) {
        const mapApi = sdk?.Map;
        const centerCalls = [
            () => mapApi?.getCenter?.(),
            () => mapApi?.getMapCenter?.(),
            () => mapApi?.getCenterLonLat?.(),
        ];

        for (const call of centerCalls) {
            try {
                const center = call();
                if (Array.isArray(center) && center.length >= 2) {
                    const lon = Number(center[0]);
                    const lat = Number(center[1]);
                    if (Number.isFinite(lon) && Number.isFinite(lat)) {
                        return [lon, lat];
                    }
                }

                const lon = Number(center?.lon ?? center?.lng ?? center?.longitude ?? center?.x);
                const lat = Number(center?.lat ?? center?.latitude ?? center?.y);
                if (Number.isFinite(lon) && Number.isFinite(lat)) {
                    return [lon, lat];
                }
            } catch {
            }
        }

        const mapViewport = sdk?.Map?.getMapViewportElement?.();
        if (mapViewport) {
            const rect = mapViewport.getBoundingClientRect();
            const centerPixel = { x: rect.width / 2, y: rect.height / 2 };

            try {
                const lonLat = sdk.Map.getLonLatFromMapPixel(centerPixel);
                if (Array.isArray(lonLat) && lonLat.length >= 2) {
                    return [lonLat[0], lonLat[1]];
                }
            } catch {
            }

            try {
                const centerClientPixel = {
                    x: rect.left + (rect.width / 2),
                    y: rect.top + (rect.height / 2),
                };
                const lonLat = sdk.Map.getLonLatFromPixel(centerClientPixel);
                if (Array.isArray(lonLat) && lonLat.length >= 2) {
                    return [lonLat[0], lonLat[1]];
                }
            } catch {
            }
        }

        if (Array.isArray(lastMapMouseLonLat) && lastMapMouseLonLat.length >= 2) {
            return [lastMapMouseLonLat[0], lastMapMouseLonLat[1]];
        }

        return null;
    }

    function normalizeCityLookupResult(rawCity) {
        if (!rawCity) {
            return null;
        }

        const cityLike = rawCity.city || rawCity;
        const cityName = String(cityLike?.name ?? '').trim();
        if (!cityName) {
            return null;
        }

        const cityId = Number(cityLike?.id ?? cityLike?.cityId ?? cityLike?.cityID);
        return {
            cityKey: Number.isFinite(cityId) ? `city:${cityId}` : `cityname:${cityName.toLowerCase()}`,
            cityName,
        };
    }

    function pickFirstCityFromLookupResult(raw) {
        if (!raw) {
            return null;
        }

        const direct = normalizeCityLookupResult(raw);
        if (direct) {
            return direct;
        }

        const arrayCandidates = [
            raw.cities,
            raw.results,
            raw.items,
            Array.isArray(raw) ? raw : null,
        ];

        for (const list of arrayCandidates) {
            if (!Array.isArray(list)) {
                continue;
            }

            for (const item of list) {
                const normalized = normalizeCityLookupResult(item);
                if (normalized) {
                    return normalized;
                }
            }
        }

        return null;
    }

    function getCityAtLonLat(sdk, lonLat) {
        if (!Array.isArray(lonLat) || lonLat.length < 2) {
            return null;
        }

        const citiesApi = sdk?.DataModel?.Cities;
        if (!citiesApi) {
            return null;
        }

        const lon = Number(lonLat[0]);
        const lat = Number(lonLat[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
            return null;
        }

        const tryCalls = [
            () => citiesApi.getByPoint?.({ lon, lat }),
            () => citiesApi.getByPoint?.({ point: { lon, lat } }),
            () => citiesApi.getByPoint?.({ coordinates: [lon, lat] }),
            () => citiesApi.getByPoint?.([lon, lat]),
            () => citiesApi.getCityByPoint?.({ lon, lat }),
            () => citiesApi.getCityByPoint?.({ point: { lon, lat } }),
            () => citiesApi.getCityByPoint?.([lon, lat]),
            () => citiesApi.getAtPoint?.({ lon, lat }),
            () => citiesApi.getAtPoint?.([lon, lat]),
        ];

        for (const call of tryCalls) {
            try {
                const result = call();
                const city = pickFirstCityFromLookupResult(result);
                if (city) {
                    return city;
                }
            } catch {
            }
        }

        return null;
    }

    function resolveFocusedCityKey(sdk, segmentMetadata) {
        const center = getMapCenterLonLat(sdk);
        if (center) {
            const cityFromLookup = getCityAtLonLat(sdk, center);
            if (cityFromLookup) {
                return cityFromLookup;
            }
        }

        let nearestKnown = null;
        let nearestKnownDistance = Number.POSITIVE_INFINITY;
        let nearestAny = null;
        let nearestDistance = Number.POSITIVE_INFINITY;

        segmentMetadata.forEach((entry) => {
            const distance = center
                ? pointToLineStringDistanceMeters(center, entry.coordinates)
                : 0;
            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearestAny = entry;
            }

            if (entry.cityName !== 'Unknown city' && distance < nearestKnownDistance) {
                nearestKnownDistance = distance;
                nearestKnown = entry;
            }
        });

        const nearest = nearestKnown || nearestAny;
        return nearest ? { cityKey: nearest.cityKey, cityName: nearest.cityName } : null;
    }

    async function getHouseNumbersForSegmentsInBatchesAsync(sdk, segmentIds, batchSize = 500) {
        const output = [];
        for (let index = 0; index < segmentIds.length; index += batchSize) {
            const batchEntries = await getHouseNumbersForSegmentsAsync(sdk, segmentIds.slice(index, index + batchSize));
            if (batchEntries.length) {
                output.push(...batchEntries);
            }
        }
        return output;
    }

    function forceNativeMapRecenter(bounds, centerLon, centerLat, zoomTarget) {
        const nativeCandidates = [
            window.W?.map,
            window.W?.Map,
            window.W?.model?.map,
            window.map,
        ];

        let attempted = false;

        nativeCandidates.forEach((nativeMap) => {
            if (!nativeMap || typeof nativeMap !== 'object') {
                return;
            }

            const west = bounds.west;
            const south = bounds.south;
            const east = bounds.east;
            const north = bounds.north;

            try {
                if (typeof nativeMap.zoomToExtent === 'function') {
                    attempted = true;
                    try {
                        nativeMap.zoomToExtent([west, south, east, north]);
                    } catch {
                        if (window.OpenLayers?.Bounds) {
                            const olBounds = new window.OpenLayers.Bounds(west, south, east, north);
                            nativeMap.zoomToExtent(olBounds);
                        } else {
                            nativeMap.zoomToExtent({ left: west, bottom: south, right: east, top: north });
                        }
                    }
                }
            } catch {
            }

            try {
                if (typeof nativeMap.panTo === 'function') {
                    attempted = true;
                    if (window.OpenLayers?.LonLat) {
                        nativeMap.panTo(new window.OpenLayers.LonLat(centerLon, centerLat));
                    } else {
                        nativeMap.panTo({ lon: centerLon, lat: centerLat });
                    }
                }
            } catch {
            }

            try {
                if (typeof nativeMap.setCenter === 'function') {
                    attempted = true;
                    try {
                        nativeMap.setCenter([centerLon, centerLat], zoomTarget);
                    } catch {
                        if (window.OpenLayers?.LonLat) {
                            nativeMap.setCenter(new window.OpenLayers.LonLat(centerLon, centerLat), zoomTarget);
                        } else {
                            nativeMap.setCenter({ lon: centerLon, lat: centerLat }, zoomTarget);
                        }
                    }
                }
            } catch {
            }

            try {
                const view = typeof nativeMap.getView === 'function' ? nativeMap.getView() : null;
                if (view) {
                    if (typeof view.fit === 'function') {
                        attempted = true;
                        const extent = [west, south, east, north];
                        try {
                            view.fit(extent, { maxZoom: zoomTarget, duration: 250, padding: [30, 30, 30, 30] });
                        } catch {
                            view.fit(extent);
                        }
                    }

                    if (typeof view.setCenter === 'function') {
                        attempted = true;
                        const projected = window.ol?.proj?.fromLonLat
                            ? window.ol.proj.fromLonLat([centerLon, centerLat])
                            : [centerLon, centerLat];
                        view.setCenter(projected);
                    }

                    if (typeof view.setZoom === 'function') {
                        attempted = true;
                        view.setZoom(zoomTarget);
                    }
                }
            } catch {
            }
        });

        return attempted;
    }

    function trySelectionBasedMapNavigation(sdk) {
        const mapApi = sdk?.Map;
        const calls = [
            () => mapApi?.zoomToSelection?.(),
            () => mapApi?.zoomToSelectedObjects?.(),
            () => mapApi?.centerOnSelection?.(),
            () => mapApi?.focusOnSelection?.(),
            () => mapApi?.panToSelection?.(),
        ];

        let attempted = false;
        calls.forEach((call) => {
            try {
                const result = call();
                if (result instanceof Promise) {
                    void result.catch(() => { });
                }
                attempted = true;
            } catch {
            }
        });

        return attempted;
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function normalizeLongitudeDelta(deltaLon) {
        const normalized = Math.abs(deltaLon) % 360;
        return normalized > 180 ? 360 - normalized : normalized;
    }

    function latitudeToMercatorY(lat) {
        const limitedLat = clamp(Number(lat), -85.05112878, 85.05112878);
        const radians = (limitedLat * Math.PI) / 180;
        return Math.log(Math.tan((Math.PI / 4) + (radians / 2)));
    }

    function getBestZoomForBounds(sdk, bounds, paddingPx = 80) {
        const viewport = sdk?.Map?.getMapViewportElement?.();
        const viewportWidth = Math.max(64, Number(viewport?.clientWidth) || window.innerWidth || 1024);
        const viewportHeight = Math.max(64, Number(viewport?.clientHeight) || window.innerHeight || 768);
        const usableWidth = Math.max(32, viewportWidth - (paddingPx * 2));
        const usableHeight = Math.max(32, viewportHeight - (paddingPx * 2));

        const lonSpan = Math.max(0.000001, normalizeLongitudeDelta(bounds.east - bounds.west));
        const latSouth = clamp(bounds.south, -85.05112878, 85.05112878);
        const latNorth = clamp(bounds.north, -85.05112878, 85.05112878);
        const mercatorSpan = Math.max(0.000001, Math.abs(latitudeToMercatorY(latNorth) - latitudeToMercatorY(latSouth)));

        const worldTileSize = 256;
        const zoomX = Math.log2((usableWidth * 360) / (worldTileSize * lonSpan));
        const zoomY = Math.log2((usableHeight * (2 * Math.PI)) / (worldTileSize * mercatorSpan));

        const mapApi = sdk?.Map;
        const minZoomCandidates = [
            Number(mapApi?.getMinZoom?.()),
            Number(mapApi?.minZoom),
            1,
        ].filter((value) => Number.isFinite(value));
        const maxZoomCandidates = [
            Number(mapApi?.getMaxZoom?.()),
            Number(mapApi?.maxZoom),
            22,
        ].filter((value) => Number.isFinite(value));

        const minZoom = Math.min(...minZoomCandidates);
        const maxZoom = Math.max(...maxZoomCandidates);
        const computed = Math.floor(Math.min(zoomX, zoomY));
        return clamp(computed, minZoom, maxZoom);
    }

    function setMapCenterAndZoom(sdk, centerLon, centerLat, zoomLevel) {
        const mapApi = sdk?.Map;
        let attempted = false;

        const centerCalls = [
            () => mapApi?.setCenter?.({ lon: centerLon, lat: centerLat }),
            () => mapApi?.setCenter?.({ lng: centerLon, lat: centerLat }),
            () => mapApi?.setCenter?.([centerLon, centerLat]),
            () => mapApi?.setMapCenter?.({ lon: centerLon, lat: centerLat }),
            () => mapApi?.setMapCenter?.({ lng: centerLon, lat: centerLat }),
            () => mapApi?.setMapCenter?.([centerLon, centerLat]),
            () => mapApi?.panTo?.({ lon: centerLon, lat: centerLat }),
            () => mapApi?.panTo?.([centerLon, centerLat]),
            () => mapApi?.moveTo?.({ lon: centerLon, lat: centerLat }),
            () => mapApi?.moveTo?.([centerLon, centerLat]),
        ];

        centerCalls.forEach((call) => {
            try {
                const result = call();
                if (result instanceof Promise) {
                    void result.catch(() => { });
                }
                attempted = true;
            } catch {
            }
        });

        const zoomCalls = [
            () => mapApi?.setZoom?.({ zoom: zoomLevel }),
            () => mapApi?.setZoom?.(zoomLevel),
            () => mapApi?.zoomTo?.({ zoom: zoomLevel }),
            () => mapApi?.zoomTo?.(zoomLevel),
            () => mapApi?.zoomToLevel?.(zoomLevel),
            () => mapApi?.setLevel?.(zoomLevel),
        ];

        zoomCalls.forEach((call) => {
            try {
                const result = call();
                if (result instanceof Promise) {
                    void result.catch(() => { });
                }
                attempted = true;
            } catch {
            }
        });

        return attempted;
    }

    function fitMapToCoordinates(sdk, coordinates) {
        const validCoordinates = (Array.isArray(coordinates) ? coordinates : [])
            .filter((coordinate) => Array.isArray(coordinate) && Number.isFinite(Number(coordinate[0])) && Number.isFinite(Number(coordinate[1])));

        if (!validCoordinates.length) {
            return false;
        }

        const bounds = validCoordinates.reduce((acc, coordinate) => {
            const lon = Number(coordinate[0]);
            const lat = Number(coordinate[1]);
            acc.west = Math.min(acc.west, lon);
            acc.east = Math.max(acc.east, lon);
            acc.south = Math.min(acc.south, lat);
            acc.north = Math.max(acc.north, lat);
            return acc;
        }, {
            west: Number.POSITIVE_INFINITY,
            east: Number.NEGATIVE_INFINITY,
            south: Number.POSITIVE_INFINITY,
            north: Number.NEGATIVE_INFINITY,
        });

        const centerLon = (bounds.west + bounds.east) / 2;
        const centerLat = (bounds.south + bounds.north) / 2;
        const mapApi = sdk?.Map;
        const targetCenter = [centerLon, centerLat];
        const initialCenter = getMapCenterLonLat(sdk);
        let attemptedMapMove = false;
        const zoomTarget = getBestZoomForBounds(sdk, bounds, 100);

        const fitCalls = [
            { fn: mapApi?.fitBounds, arg: { west: bounds.west, south: bounds.south, east: bounds.east, north: bounds.north } },
            { fn: mapApi?.fitBounds, arg: [[bounds.west, bounds.south], [bounds.east, bounds.north]] },
            { fn: mapApi?.setMapBounds, arg: { west: bounds.west, south: bounds.south, east: bounds.east, north: bounds.north } },
            { fn: mapApi?.setMapBounds, arg: [[bounds.west, bounds.south], [bounds.east, bounds.north]] },
            { fn: mapApi?.setBounds, arg: { west: bounds.west, south: bounds.south, east: bounds.east, north: bounds.north } },
            { fn: mapApi?.setBounds, arg: [[bounds.west, bounds.south], [bounds.east, bounds.north]] },
            { fn: mapApi?.setBounds, arg: { left: bounds.west, bottom: bounds.south, right: bounds.east, top: bounds.north } },
            { fn: mapApi?.zoomToExtent, arg: { west: bounds.west, south: bounds.south, east: bounds.east, north: bounds.north } },
            { fn: mapApi?.zoomToExtent, arg: [bounds.west, bounds.south, bounds.east, bounds.north] },
        ];

        for (const call of fitCalls) {
            if (typeof call.fn !== 'function') {
                continue;
            }

            try {
                const result = call.fn.call(mapApi, call.arg);
                if (result instanceof Promise) {
                    void result.catch(() => { });
                }
                attemptedMapMove = true;
            } catch {
            }
        }

        const panCalls = [
            () => mapApi?.setCenter?.({ lon: centerLon, lat: centerLat }),
            () => mapApi?.setCenter?.({ lng: centerLon, lat: centerLat }),
            () => mapApi?.setCenter?.({ x: centerLon, y: centerLat }),
            () => mapApi?.setCenter?.([centerLon, centerLat]),
            () => mapApi?.setMapCenter?.({ lon: centerLon, lat: centerLat }),
            () => mapApi?.setMapCenter?.({ lng: centerLon, lat: centerLat }),
            () => mapApi?.setMapCenter?.([centerLon, centerLat]),
            () => mapApi?.panTo?.({ lon: centerLon, lat: centerLat }),
            () => mapApi?.panTo?.({ lng: centerLon, lat: centerLat }),
            () => mapApi?.panTo?.([centerLon, centerLat]),
            () => mapApi?.moveTo?.({ lon: centerLon, lat: centerLat }),
            () => mapApi?.moveTo?.([centerLon, centerLat]),
        ];

        for (const call of panCalls) {
            try {
                call();
                attemptedMapMove = true;
            } catch {
            }
        }

        const lonSpan = Math.max(0.0001, Math.abs(bounds.east - bounds.west));
        const latSpan = Math.max(0.0001, Math.abs(bounds.north - bounds.south));
        const span = Math.max(lonSpan, latSpan);
        const fallbackZoomTarget = span > 1 ? 12 : (span > 0.3 ? 14 : (span > 0.08 ? 15 : 16));

        const zoomCalls = [
            () => mapApi?.setZoom?.({ zoom: zoomTarget }),
            () => mapApi?.setZoom?.(zoomTarget),
            () => mapApi?.zoomTo?.({ zoom: zoomTarget }),
            () => mapApi?.zoomTo?.(zoomTarget),
            () => mapApi?.zoomToLevel?.(zoomTarget),
            () => mapApi?.setLevel?.(zoomTarget),
            () => mapApi?.setZoom?.({ zoom: fallbackZoomTarget }),
            () => mapApi?.setZoom?.(fallbackZoomTarget),
        ];

        for (const call of zoomCalls) {
            try {
                call();
                attemptedMapMove = true;
            } catch {
            }
        }

        if (forceNativeMapRecenter(bounds, centerLon, centerLat, zoomTarget)) {
            attemptedMapMove = true;
        }

        if (setMapCenterAndZoom(sdk, centerLon, centerLat, zoomTarget)) {
            attemptedMapMove = true;
        }

        const finalCenter = getMapCenterLonLat(sdk);
        const isNearTarget = Array.isArray(finalCenter)
            ? distanceMeters(finalCenter, targetCenter) <= 1200
            : false;

        if (isNearTarget) {
            return true;
        }

        if (!attemptedMapMove) {
            return false;
        }

        if (Array.isArray(initialCenter) && Array.isArray(finalCenter)) {
            return distanceMeters(initialCenter, finalCenter) > 10;
        }

        return false;
    }

    function selectAndRecenterRoad(row) {
        const sdk = sidebarScannerSdk;
        if (!sdk || !row) {
            return;
        }

        const selectedSegmentIds = Array.from(new Set((Array.isArray(row.segmentIds) ? row.segmentIds : [row.sampleSegmentId])
            .map((segmentId) => Number(segmentId))
            .filter((segmentId) => Number.isFinite(segmentId))));

        if (!selectedSegmentIds.length) {
            updateScannerStatus(`Could not find a segment to navigate for ${row.roadName}.`, 'error');
            return;
        }

        try {
            sdk.Editing.setSelection({
                selection: {
                    objectType: 'segment',
                    ids: selectedSegmentIds,
                },
            });
        } catch {
        }

        trySelectionBasedMapNavigation(sdk);

        const coordinates = [];
        selectedSegmentIds.forEach((segmentId) => {
            const segment = getSegmentByIdSafe(sdk, segmentId);
            const segmentCoordinates = Array.isArray(segment?.geometry?.coordinates) ? segment.geometry.coordinates : [];
            if (segmentCoordinates.length) {
                coordinates.push(...segmentCoordinates);
            }
        });

        const didFit = coordinates.length ? fitMapToCoordinates(sdk, coordinates) : false;
        if (!didFit) {
            const fallbackSegment = getSegmentByIdSafe(sdk, selectedSegmentIds[0]);
            const fallbackCoordinates = Array.isArray(fallbackSegment?.geometry?.coordinates) ? fallbackSegment.geometry.coordinates : [];
            const firstCoordinate = fallbackCoordinates.find((coordinate) => Array.isArray(coordinate) && coordinate.length >= 2);

            if (firstCoordinate) {
                const didFallbackFit = fitMapToCoordinates(sdk, [firstCoordinate]);
                if (didFallbackFit) {
                    updateScannerStatus(`Selected and centered ${row.roadName}.`, 'success');
                    return;
                }

                updateScannerStatus(`Selected ${row.roadName}; retrying map recenter...`);
                window.setTimeout(() => {
                    const retrySegment = getSegmentByIdSafe(sdk, selectedSegmentIds[0]);
                    const retryCoordinates = Array.isArray(retrySegment?.geometry?.coordinates) ? retrySegment.geometry.coordinates : [];
                    const didRetry = fitMapToCoordinates(sdk, retryCoordinates.length ? retryCoordinates : [firstCoordinate]);
                    updateScannerStatus(
                        didRetry
                            ? `Selected and centered ${row.roadName}.`
                            : `Selected ${row.roadName}, but could not center map view.`,
                        didRetry ? 'success' : 'error',
                    );
                }, 300);
                return;
            }

            updateScannerStatus(`Selected ${row.roadName}, but could not center map view.`, 'error');
            return;
        }

        updateScannerStatus(`Selected and centered ${row.roadName}.`, 'success');
    }

    function renderMissingRoadRows() {
        const container = sidebarScannerElement?.querySelector(`#${SIDEBAR_IDS.missingList}`);
        if (!container) {
            return;
        }

        const showFalsePositives = Boolean(sidebarScannerElement?.querySelector(`#${SIDEBAR_IDS.showFalsePositives}`)?.checked);
        container.innerHTML = '';

        if (!missingRoadRows.length) {
            container.textContent = 'No scan results yet.';
            return;
        }

        const visibleRows = showFalsePositives
            ? missingRoadRows
            : missingRoadRows.filter((row) => !row.isFalsePositive);
        const hiddenCount = missingRoadRows.length - visibleRows.length;

        const summary = document.createElement('div');
        summary.style.marginBottom = '6px';
        summary.style.opacity = '0.85';
        summary.textContent = `${missingRoadCityLabel}: ${visibleRows.length} roads need review${hiddenCount > 0 ? ` (${hiddenCount} hidden false positives)` : ''}.`;
        container.appendChild(summary);

        if (!visibleRows.length) {
            const empty = document.createElement('div');
            empty.style.opacity = '0.75';
            empty.textContent = 'No visible roads. Enable "Show False Positives" to review hidden items.';
            container.appendChild(empty);
            return;
        }

        visibleRows.forEach((row) => {
            const item = document.createElement('div');
            item.style.border = '1px solid var(--separator_default, rgba(0,0,0,0.15))';
            item.style.borderRadius = '4px';
            item.style.padding = '6px';
            item.style.marginBottom = '6px';

            const header = document.createElement('div');
            header.style.display = 'flex';
            header.style.alignItems = 'flex-start';
            header.style.justifyContent = 'space-between';
            header.style.gap = '6px';
            header.style.marginBottom = '4px';

            const title = document.createElement('div');
            title.style.fontWeight = '600';
            title.textContent = row.roadName;
            header.appendChild(title);

            const navigateButton = document.createElement('button');
            navigateButton.type = 'button';
            navigateButton.title = `Select and recenter to ${row.roadName}`;
            navigateButton.ariaLabel = `Select and recenter to ${row.roadName}`;
            navigateButton.style.width = '28px';
            navigateButton.style.height = '28px';
            navigateButton.style.minWidth = '28px';
            navigateButton.style.minHeight = '28px';
            navigateButton.style.borderRadius = '999px';
            navigateButton.style.border = 'none';
            navigateButton.style.padding = '0';
            navigateButton.style.display = 'inline-flex';
            navigateButton.style.alignItems = 'center';
            navigateButton.style.justifyContent = 'center';
            navigateButton.style.lineHeight = '1';
            navigateButton.innerHTML = '<i class="w-icon w-icon-recenter" style="display:block;pointer-events:none;font-size:16px;"></i>';
            navigateButton.addEventListener('click', () => {
                selectAndRecenterRoad(row);
            });
            header.appendChild(navigateButton);
            item.appendChild(header);

            const details = document.createElement('div');
            details.style.fontSize = '11px';
            details.style.opacity = '0.8';
            details.style.margin = '4px 0 6px';
            details.textContent = `${row.missingSegmentCount}/${row.totalSegmentCount} segments have no house numbers.`;
            item.appendChild(details);

            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = row.isFalsePositive ? 'Unmark False Positive' : 'Mark False Positive';
            button.addEventListener('click', () => {
                const nextValue = !row.isFalsePositive;
                setRoadFalsePositive(row.cityKey, row.roadKey, nextValue);
                row.isFalsePositive = nextValue;
                updateScannerStatus(`${nextValue ? 'Marked' : 'Unmarked'} ${row.roadName} as False Positive.`, 'success');
                renderMissingRoadRows();
            });
            item.appendChild(button);

            container.appendChild(item);
        });
    }

    function updateScannerStatus(message, tone = 'info') {
        const statusElement = sidebarScannerElement?.querySelector(`#${SIDEBAR_IDS.status}`);
        if (!statusElement) {
            return;
        }

        const rawMessage = String(message ?? '');
        if (tone === 'success') {
            statusElement.textContent = `Done: ${rawMessage.replace(/^\s*(done:\s*)+/i, '')}`;
            return;
        }

        if (tone === 'error') {
            statusElement.textContent = `Error: ${rawMessage.replace(/^\s*(error:\s*)+/i, '')}`;
            return;
        }

        statusElement.textContent = rawMessage;
    }

    async function scanMissingRoadsInFocusedCity(sdk) {
        updateScannerStatus('Scanning roads in focused city...');

        const segments = getAllSegments(sdk);
        if (!segments.length) {
            updateScannerStatus('Could not read segments from WME data model.', 'error');
            return;
        }

        const streetCache = new Map();
        const cityCache = new Map();
        const metadata = segments
            .map((segment) => getSegmentRoadMetadata(sdk, segment, streetCache, cityCache))
            .filter(Boolean);

        if (!metadata.length) {
            updateScannerStatus('No segment metadata available for scan.', 'error');
            return;
        }

        const focusedCity = resolveFocusedCityKey(sdk, metadata);
        if (!focusedCity) {
            updateScannerStatus('Could not determine focused city from the current map view. Pan/zoom and retry.', 'error');
            return;
        }

        const citySegments = metadata.filter((entry) => entry.cityKey === focusedCity.cityKey);
        if (!citySegments.length) {
            updateScannerStatus('No segments found for the focused city.', 'error');
            return;
        }

        const scannableCitySegments = citySegments.filter((entry) => entry.hasValidRoadName);
        if (!scannableCitySegments.length) {
            updateScannerStatus('No named roads found in the focused city.', 'error');
            return;
        }

        const hnReadApi = getHouseNumbersReadApi(sdk);

        const houseNumberEntries = await getHouseNumbersForSegmentsInBatchesAsync(
            sdk,
            scannableCitySegments.map((entry) => entry.segmentId),
        );
        const resolvedSegmentIds = houseNumberEntries
            .map((entry) => getSegmentIdFromHouseNumberEntry(entry))
            .filter((segmentId) => Number.isFinite(segmentId));
        const segmentsWithHouseNumbers = new Set(resolvedSegmentIds);

        const usedSegmentFallback = !hnReadApi.api || houseNumberEntries.length === 0;
        if (usedSegmentFallback) {
            scannableCitySegments.forEach((entry) => {
                if (entry.hasHouseNumbers === true) {
                    segmentsWithHouseNumbers.add(entry.segmentId);
                }
            });
        }

        const roadMap = new Map();
        scannableCitySegments.forEach((entry) => {
            const existing = roadMap.get(entry.roadKey) || {
                roadKey: entry.roadKey,
                roadName: entry.roadName,
                cityKey: entry.cityKey,
                totalSegmentCount: 0,
                missingSegmentCount: 0,
                sampleSegmentId: null,
                segmentIds: [],
            };

            if (!existing.segmentIds.includes(entry.segmentId)) {
                existing.segmentIds.push(entry.segmentId);
            }

            existing.totalSegmentCount += 1;
            if (!segmentsWithHouseNumbers.has(entry.segmentId)) {
                existing.missingSegmentCount += 1;
                if (!Number.isFinite(existing.sampleSegmentId)) {
                    existing.sampleSegmentId = entry.segmentId;
                }
            }

            if (!Number.isFinite(existing.sampleSegmentId)) {
                existing.sampleSegmentId = entry.segmentId;
            }

            roadMap.set(entry.roadKey, existing);
        });

        missingRoadRows = Array.from(roadMap.values())
            .filter((entry) => entry.missingSegmentCount > 0)
            .map((entry) => ({
                ...entry,
                isFalsePositive: isRoadFalsePositive(entry.cityKey, entry.roadKey),
            }))
            .sort((left, right) => {
                if (right.missingSegmentCount !== left.missingSegmentCount) {
                    return right.missingSegmentCount - left.missingSegmentCount;
                }
                return left.roadName.localeCompare(right.roadName);
            });

        missingRoadCityLabel = focusedCity.cityName;
        renderMissingRoadRows();

        const activeCount = missingRoadRows.filter((row) => !row.isFalsePositive).length;
        updateScannerStatus(`Scan complete: ${activeCount} roads in ${focusedCity.cityName} need review.`, 'success');
    }

    function extractSidebarContainerFromRegistrationResult(result) {
        if (result instanceof HTMLElement) {
            return result;
        }

        const directCandidates = [
            result?.container,
            result?.content,
            result?.element,
            result?.root,
            result?.tabContent,
            result?.tabElement,
        ];

        for (const candidate of directCandidates) {
            if (candidate instanceof HTMLElement) {
                return candidate;
            }
        }

        const getterCandidates = [
            result?.getContainer,
            result?.getContent,
            result?.getElement,
            result?.getRoot,
        ];

        for (const getter of getterCandidates) {
            if (typeof getter !== 'function') {
                continue;
            }
            try {
                const candidate = getter();
                if (candidate instanceof HTMLElement) {
                    return candidate;
                }
            } catch {
            }
        }

        return null;
    }

    function ensureScriptsTabContentRoot(containerElement) {
        if (!(containerElement instanceof HTMLElement)) {
            return null;
        }

        let root = containerElement.querySelector(`#${SIDEBAR_IDS.root}`);
        if (!root) {
            root = document.createElement('div');
            root.id = SIDEBAR_IDS.root;
            containerElement.appendChild(root);
        }

        root.style.paddingLeft = '15px';
        root.style.paddingRight = '15px';
        return root;
    }

    async function registerScriptsSidebarTabIfNeeded(sdk) {
        if (scriptsTabContentRoot && scriptsTabContentRoot.isConnected) {
            return scriptsTabContentRoot;
        }

        if (scriptsTabInitPromise) {
            return scriptsTabInitPromise;
        }

        scriptsTabInitPromise = (async () => {
            const sidebarApi = sdk?.Sidebar;
            if (!sidebarApi || typeof sidebarApi.registerScriptTab !== 'function') {
                return null;
            }

            try {
                const registration = await sidebarApi.registerScriptTab();
                const tabLabel = registration?.tabLabel;
                const tabPane = registration?.tabPane;

                if (tabLabel && 'textContent' in tabLabel) {
                    tabLabel.textContent = SCRIPT_NAME;
                }
                if (tabLabel instanceof HTMLElement) {
                    scriptsTabLabelElement = tabLabel;
                }

                const container = (tabPane instanceof HTMLElement)
                    ? tabPane
                    : extractSidebarContainerFromRegistrationResult(registration);
                const root = ensureScriptsTabContentRoot(container);
                if (root) {
                    scriptsTabContentRoot = root;
                    return root;
                }
            } catch {
            }

            return null;
        })();

        const root = await scriptsTabInitPromise;
        scriptsTabInitPromise = null;
        return root;
    }

    function renderSidebarScanner() {
        if (!sidebarScannerElement) {
            return;
        }

        let scannerPanel = sidebarScannerElement.querySelector(`#${SIDEBAR_IDS.scannerPanel}`);
        if (!scannerPanel) {
            scannerPanel = document.createElement('div');
            scannerPanel.id = SIDEBAR_IDS.scannerPanel;
            scannerPanel.style.border = '1px solid var(--separator_default, rgba(0,0,0,0.15))';
            scannerPanel.style.borderRadius = '6px';
            scannerPanel.style.padding = '8px';
            scannerPanel.style.marginTop = '8px';
            sidebarScannerElement.appendChild(scannerPanel);
        }

        scannerPanel.innerHTML = `
            <div style="font-weight:600;margin-bottom:6px;">Missing HN Scanner</div>
            <div style="font-size:11px;opacity:0.85;margin-bottom:8px;">Scan the currently focused city for roads with segments that have no house numbers.</div>
            <div style="font-size:11px;opacity:0.85;margin-bottom:8px;"><b>Note:</b> This is best used in towns/cities where ALL HNs are supposed to be mapped. This tool also does not respect Residential Place Points as HNs.</div>
            <div style="display:flex;flex-direction:column;gap:8px;align-items:stretch;">
                <button id="${SIDEBAR_IDS.scanMissing}" type="button" style="height:auto;min-height:unset;line-height:1.25;white-space:normal;text-align:left;padding:6px 10px;">Scan focused city for missing HNs</button>
                <label style="font-size:11px;white-space:nowrap;align-self:flex-start;"><input id="${SIDEBAR_IDS.showFalsePositives}" type="checkbox" /> Show False Positives</label>
            </div>
            <div id="${SIDEBAR_IDS.status}" style="margin-top:8px;opacity:0.85;">Ready.</div>
            <div id="${SIDEBAR_IDS.missingList}" style="margin-top:8px;max-height:220px;overflow:auto;font-size:12px;opacity:0.9;">No scan results yet.</div>
        `;
    }

    function wireSidebarScannerEvents(sdk) {
        if (!sidebarScannerElement) {
            return;
        }

        const scanMissingButton = sidebarScannerElement.querySelector(`#${SIDEBAR_IDS.scanMissing}`);
        if (scanMissingButton) {
            scanMissingButton.addEventListener('click', async () => {
                await scanMissingRoadsInFocusedCity(sdk);
            });
        }

        const showFalsePositivesInput = sidebarScannerElement.querySelector(`#${SIDEBAR_IDS.showFalsePositives}`);
        if (showFalsePositivesInput) {
            showFalsePositivesInput.addEventListener('change', () => {
                renderMissingRoadRows();
            });
        }
    }

    async function mountSidebarScannerIfPossible(sdk) {
        const root = await registerScriptsSidebarTabIfNeeded(sdk);
        if (!root) {
            return false;
        }

        sidebarScannerSdk = sdk;

        const shouldRender = sidebarScannerElement !== root
            || !root.querySelector(`#${SIDEBAR_IDS.scannerPanel}`)
            || !root.querySelector(`#${SIDEBAR_IDS.missingList}`);

        sidebarScannerElement = root;
        if (shouldRender) {
            renderSidebarScanner();
            wireSidebarScannerEvents(sdk);
        }
        renderMissingRoadRows();
        return true;
    }

    function startSidebarScannerMountWatcher(sdk) {
        void mountSidebarScannerIfPossible(sdk);

        if (sidebarMountTimerId !== null) {
            clearInterval(sidebarMountTimerId);
            sidebarMountTimerId = null;
        }

        let attempts = 0;
        sidebarMountTimerId = window.setInterval(() => {
            attempts += 1;
            void mountSidebarScannerIfPossible(sdk).then((mounted) => {
                if (mounted || attempts >= 30) {
                    clearInterval(sidebarMountTimerId);
                    sidebarMountTimerId = null;
                }
            });
        }, 1000);
    }

    function setStartInputValue(nextStartNumber, persist = true) {
        const startInput = panelElement?.querySelector(`#${UI_IDS.start}`);
        if (!startInput || !Number.isFinite(nextStartNumber)) {
            return;
        }

        startInput.value = String(Math.round(nextStartNumber));
        if (persist) {
            saveUiSettings(getUiSettings());
        }
    }

    function extractNumericHouseNumber(value) {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return Math.round(value);
        }

        if (typeof value !== 'string') {
            return null;
        }

        const match = value.trim().match(/^\d+/);
        if (!match) {
            return null;
        }

        const parsed = Number(match[0]);
        return Number.isFinite(parsed) ? Math.round(parsed) : null;
    }

    function getSegmentIdFromHouseNumberEntry(entry) {
        if (!entry || typeof entry !== 'object') {
            return null;
        }

        const directId = entry.segmentId
            ?? entry.segmentID
            ?? entry.segment_id
            ?? entry.streetSegmentId
            ?? entry.streetSegmentID
            ?? entry.street_segment_id
            ?? entry.segmentWmeObjectId
            ?? entry.wmeSegmentId
            ?? entry.segID
            ?? entry.segmentObjectId
            ?? entry.segmentObjId
            ?? entry.segId;
        if (Number.isFinite(Number(directId))) {
            return Number(directId);
        }

        const nestedId = entry.segment?.id
            ?? entry.segment?.segmentId
            ?? entry.segment?.segmentID
            ?? entry.segment?.segment_id
            ?? entry.segment?.attributes?.id
            ?? entry.segment?.attributes?.segmentId
            ?? entry.segment?.attributes?.segmentID
            ?? entry.segment?.wmeObjectId;
        if (Number.isFinite(Number(nestedId))) {
            return Number(nestedId);
        }

        const parentNestedId = entry.houseNumber?.segmentId
            ?? entry.houseNumber?.segmentID
            ?? entry.houseNumber?.segment?.id
            ?? entry.houseNumber?.segment?.segmentId;
        if (Number.isFinite(Number(parentNestedId))) {
            return Number(parentNestedId);
        }

        return null;
    }

    function getNumberFromHouseNumberEntry(entry) {
        if (!entry || typeof entry !== 'object') {
            return null;
        }

        const value = entry.number ?? entry.houseNumber ?? entry.value ?? entry.displayNumber;
        return extractNumericHouseNumber(value);
    }

    function normalizeHouseNumberEntries(raw) {
        if (Array.isArray(raw)) {
            return raw;
        }

        if (raw && typeof raw === 'object') {
            const directArrayFields = [
                raw.houseNumbers,
                raw.items,
                raw.results,
                raw.data,
                raw.list,
                raw.entries,
            ];
            for (const list of directArrayFields) {
                if (Array.isArray(list)) {
                    return list;
                }
            }

            const keyedEntries = [];
            Object.entries(raw).forEach(([rawKey, value]) => {
                const keyAsNumber = Number(rawKey);

                const pushWithSegmentHint = (item) => {
                    if (!item || typeof item !== 'object') {
                        return;
                    }

                    if (Number.isFinite(Number(getSegmentIdFromHouseNumberEntry(item)))) {
                        keyedEntries.push(item);
                        return;
                    }

                    if (Number.isFinite(keyAsNumber)) {
                        keyedEntries.push({
                            ...item,
                            segmentId: keyAsNumber,
                        });
                        return;
                    }

                    keyedEntries.push(item);
                };

                if (Array.isArray(value)) {
                    value.forEach((item) => {
                        pushWithSegmentHint(item);
                    });
                    return;
                }

                if (value && typeof value === 'object') {
                    if (Array.isArray(value.houseNumbers)) {
                        value.houseNumbers.forEach((item) => {
                            pushWithSegmentHint(item);
                        });
                        return;
                    }

                    pushWithSegmentHint(value);
                }
            });

            if (keyedEntries.length > 0) {
                return keyedEntries;
            }

            const values = Object.values(raw);
            if (values.length > 0 && values.every((item) => item && typeof item === 'object')) {
                return values;
            }
        }

        return [];
    }

    async function resolveHouseNumberCallEntries(call) {
        try {
            const result = call();
            const resolvedResult = result instanceof Promise ? await result : result;
            return normalizeHouseNumberEntries(resolvedResult);
        } catch {
            return [];
        }
    }

    function getHouseNumbersReadApi(sdk) {
        const readMethodNames = [
            'fetchHouseNumbers',
            'getBySegmentIds',
            'getAllBySegmentIds',
            'getHouseNumbersBySegmentIds',
            'getHouseNumbers',
            'getBySegmentId',
            'getHouseNumbersBySegmentId',
            'getAll',
        ];

        const candidates = [
            { api: sdk?.DataModel?.HouseNumbers, source: 'DataModel.HouseNumbers' },
            { api: sdk?.HouseNumbers, source: 'HouseNumbers' },
        ];

        for (const candidate of candidates) {
            if (!candidate.api) {
                continue;
            }

            const methods = readMethodNames.filter((methodName) => typeof candidate.api?.[methodName] === 'function');
            if (methods.length > 0) {
                return {
                    api: candidate.api,
                    source: candidate.source,
                    methods,
                };
            }
        }

        return {
            api: null,
            source: 'none',
            methods: [],
        };
    }

    async function getHouseNumbersForSegmentsAsync(sdk, segmentIds) {
        const uniqueSegmentIds = Array.from(new Set((segmentIds || []).filter((segmentId) => Number.isFinite(segmentId))));
        if (!uniqueSegmentIds.length) {
            return [];
        }

        const houseNumbersApi = getHouseNumbersReadApi(sdk).api;
        if (!houseNumbersApi) {
            return [];
        }

        const tryCalls = [
            () => houseNumbersApi.fetchHouseNumbers?.({ segmentIds: uniqueSegmentIds }),
            () => houseNumbersApi.fetchHouseNumbers?.(uniqueSegmentIds),
            () => houseNumbersApi.getBySegmentIds?.({ segmentIds: uniqueSegmentIds }),
            () => houseNumbersApi.getBySegmentIds?.(uniqueSegmentIds),
            () => houseNumbersApi.getAllBySegmentIds?.({ segmentIds: uniqueSegmentIds }),
            () => houseNumbersApi.getAllBySegmentIds?.(uniqueSegmentIds),
            () => houseNumbersApi.getHouseNumbersBySegmentIds?.({ segmentIds: uniqueSegmentIds }),
            () => houseNumbersApi.getHouseNumbersBySegmentIds?.(uniqueSegmentIds),
            () => houseNumbersApi.getHouseNumbers?.({ segmentIds: uniqueSegmentIds }),
            () => houseNumbersApi.getHouseNumbers?.(uniqueSegmentIds),
        ];

        for (const call of tryCalls) {
            const entries = await resolveHouseNumberCallEntries(call);
            if (entries.length > 0) {
                return entries;
            }
        }

        const collected = [];
        for (const segmentId of uniqueSegmentIds) {
            const perSegmentCalls = [
                () => houseNumbersApi.getBySegmentId?.({ segmentId }),
                () => houseNumbersApi.getBySegmentId?.(segmentId),
                () => houseNumbersApi.getHouseNumbersBySegmentId?.({ segmentId }),
                () => houseNumbersApi.getHouseNumbersBySegmentId?.(segmentId),
                () => houseNumbersApi.getHouseNumbers?.({ segmentId }),
                () => houseNumbersApi.getHouseNumbers?.(segmentId),
            ];

            for (const call of perSegmentCalls) {
                const entries = await resolveHouseNumberCallEntries(call);
                if (entries.length > 0) {
                    collected.push(...entries);
                    break;
                }
            }
        }

        if (collected.length > 0) {
            return collected;
        }

        const all = await resolveHouseNumberCallEntries(() => houseNumbersApi.getAll?.());
        if (!all.length) {
            return [];
        }

        const segmentIdSet = new Set(uniqueSegmentIds);
        return all.filter((entry) => segmentIdSet.has(getSegmentIdFromHouseNumberEntry(entry)));
    }

    function getHouseNumbersForSegments(sdk, segmentIds) {
        const uniqueSegmentIds = Array.from(new Set((segmentIds || []).filter((segmentId) => Number.isFinite(segmentId))));
        if (!uniqueSegmentIds.length) {
            return [];
        }

        const houseNumbersApi = getHouseNumbersReadApi(sdk).api;
        if (!houseNumbersApi) {
            return [];
        }

        const tryCalls = [
            () => houseNumbersApi.getBySegmentIds?.({ segmentIds: uniqueSegmentIds }),
            () => houseNumbersApi.getBySegmentIds?.(uniqueSegmentIds),
            () => houseNumbersApi.getAllBySegmentIds?.({ segmentIds: uniqueSegmentIds }),
            () => houseNumbersApi.getAllBySegmentIds?.(uniqueSegmentIds),
            () => houseNumbersApi.getHouseNumbersBySegmentIds?.({ segmentIds: uniqueSegmentIds }),
            () => houseNumbersApi.getHouseNumbersBySegmentIds?.(uniqueSegmentIds),
            () => houseNumbersApi.getHouseNumbers?.({ segmentIds: uniqueSegmentIds }),
            () => houseNumbersApi.getHouseNumbers?.(uniqueSegmentIds),
        ];

        for (const call of tryCalls) {
            try {
                const result = call();
                const entries = normalizeHouseNumberEntries(result);
                if (entries.length > 0) {
                    return entries;
                }
            } catch {
            }
        }

        const collected = [];
        uniqueSegmentIds.forEach((segmentId) => {
            const perSegmentCalls = [
                () => houseNumbersApi.getBySegmentId?.({ segmentId }),
                () => houseNumbersApi.getBySegmentId?.(segmentId),
                () => houseNumbersApi.getHouseNumbersBySegmentId?.({ segmentId }),
                () => houseNumbersApi.getHouseNumbersBySegmentId?.(segmentId),
                () => houseNumbersApi.getHouseNumbers?.({ segmentId }),
                () => houseNumbersApi.getHouseNumbers?.(segmentId),
            ];

            for (const call of perSegmentCalls) {
                try {
                    const result = call();
                    const entries = normalizeHouseNumberEntries(result);
                    if (entries.length > 0) {
                        collected.push(...entries);
                        break;
                    }
                } catch {
                }
            }
        });

        if (collected.length > 0) {
            return collected;
        }

        try {
            const all = normalizeHouseNumberEntries(houseNumbersApi.getAll?.());
            if (!all.length) {
                return [];
            }

            const segmentIdSet = new Set(uniqueSegmentIds);
            return all.filter((entry) => segmentIdSet.has(getSegmentIdFromHouseNumberEntry(entry)));
        } catch {
            return [];
        }
    }

    function getLargestHouseNumberOnRoad(sdk, selectedSegmentId) {
        const roadSegments = getRoadSegmentCandidates(sdk, selectedSegmentId);
        if (!roadSegments.length) {
            return null;
        }

        const segmentIds = roadSegments
            .map((segment) => Number(segment?.id))
            .filter((segmentId) => Number.isFinite(segmentId));

        const entries = getHouseNumbersForSegments(sdk, segmentIds);
        if (!entries.length) {
            return null;
        }

        let largest = null;
        entries.forEach((entry) => {
            const parsed = getNumberFromHouseNumberEntry(entry);
            if (Number.isFinite(parsed) && (largest === null || parsed > largest)) {
                largest = parsed;
            }
        });

        return largest;
    }

    function getSuggestedNextStartNumber(baseNumber, mode, skip13, incrementStep) {
        const seed = Number.isFinite(baseNumber) ? Math.round(baseNumber) : 1;
        const step = getNumberStep(mode, incrementStep);
        return getFirstNumberInSequence(seed + step, mode, skip13, incrementStep);
    }

    function updateStartFromRoadMax(sdk) {
        const selectedSegmentId = getSelectedSegmentId(sdk);
        if (selectedSegmentId === null) {
            return;
        }

        const settings = getUiSettings();
        const largestOnRoad = getLargestHouseNumberOnRoad(sdk, selectedSegmentId);
        if (!Number.isFinite(largestOnRoad)) {
            return;
        }

        const suggestedStart = getSuggestedNextStartNumber(largestOnRoad, settings.mode, settings.skip13, settings.incrementStep);
        setStartInputValue(suggestedStart);
    }

    function normalizeUiSettings(rawSettings) {
        const workflowValue = rawSettings?.workflow;
        const modeValue = rawSettings?.mode;
        const toolLocationValue = rawSettings?.toolLocation;
        const startValue = String(rawSettings?.startNumber ?? '1').trim();
        const endValue = String(rawSettings?.endNumber ?? '10').trim();
        const incrementValue = Number(rawSettings?.incrementStep);

        let incrementStep = Number.isFinite(incrementValue) ? Math.round(incrementValue) : 1;
        if (incrementStep === 0) {
            incrementStep = 1;
        }

        return {
            toolLocation: toolLocationValue === 'sidebar' ? 'sidebar' : 'overlay',
            workflow: workflowValue === 'click' ? 'click' : (workflowValue === 'area' ? 'area' : 'line'),
            startNumber: startValue || '1',
            endNumber: endValue || '10',
            mode: modeValue === 'odd' || modeValue === 'even' || modeValue === 'increment' ? modeValue : 'all',
            incrementStep,
            skip13: Boolean(rawSettings?.skip13),
        };
    }

    function loadSavedUiSettings() {
        try {
            const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
            if (!raw) {
                return normalizeUiSettings(null);
            }

            const parsed = JSON.parse(raw);
            return normalizeUiSettings(parsed);
        } catch {
            return normalizeUiSettings(null);
        }
    }

    function saveUiSettings(settings) {
        try {
            const normalized = normalizeUiSettings(settings);
            localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
        } catch {
        }
    }

    function normalizeOverlayState(rawState) {
        const leftValue = Number(rawState?.left);
        const topValue = Number(rawState?.top);
        return {
            left: Number.isFinite(leftValue) ? Math.round(leftValue) : null,
            top: Number.isFinite(topValue) ? Math.round(topValue) : null,
            collapsed: Boolean(rawState?.collapsed),
            closed: Boolean(rawState?.closed),
        };
    }

    function loadOverlayState() {
        try {
            const raw = localStorage.getItem(OVERLAY_STATE_STORAGE_KEY);
            if (!raw) {
                return normalizeOverlayState(null);
            }

            const parsed = JSON.parse(raw);
            return normalizeOverlayState(parsed);
        } catch {
            return normalizeOverlayState(null);
        }
    }

    function saveOverlayState(state) {
        try {
            const normalized = normalizeOverlayState(state);
            localStorage.setItem(OVERLAY_STATE_STORAGE_KEY, JSON.stringify(normalized));
        } catch {
        }
    }

    function getRelativePositionInViewport(element, viewportElement) {
        if (!element || !viewportElement) {
            return { left: null, top: null };
        }

        const elementRect = element.getBoundingClientRect();
        const viewportRect = viewportElement.getBoundingClientRect();
        return {
            left: Math.round(elementRect.left - viewportRect.left),
            top: Math.round(elementRect.top - viewportRect.top),
        };
    }

    function applyOverlayPosition(element, state) {
        if (!element) {
            return;
        }

        if (Number.isFinite(state?.left) && Number.isFinite(state?.top)) {
            element.style.left = `${state.left}px`;
            element.style.top = `${state.top}px`;
            element.style.right = 'auto';
            return;
        }

        element.style.left = 'auto';
        element.style.top = '12px';
        element.style.right = '12px';
    }

    function persistOverlayState(sdk, overrides = {}) {
        if (isToolsInSidebarMode()) {
            return;
        }

        const mapViewport = sdk?.Map?.getMapViewportElement?.();
        const position = getRelativePositionInViewport(panelElement, mapViewport);

        saveOverlayState({
            left: position.left,
            top: position.top,
            collapsed: isCollapsed,
            closed: isPanelClosed,
            ...overrides,
        });
    }

    function refreshOverlayVisibility() {
        const isSidebarMode = isToolsInSidebarMode();

        if (panelElement) {
            panelElement.style.display = (isPanelClosed && !isSidebarMode) ? 'none' : 'block';
        }

        if (launcherElement) {
            launcherElement.style.display = (!isSidebarMode && isPanelClosed) ? 'block' : 'none';
        }

        const closeButton = panelElement?.querySelector(`#${UI_IDS.close}`);
        if (closeButton) {
            closeButton.style.display = isSidebarMode ? 'none' : 'inline-block';
        }

        const headerElement = panelElement?.querySelector(`#${UI_IDS.header}`);
        if (headerElement) {
            headerElement.style.cursor = isSidebarMode ? 'default' : 'move';
        }
    }

    function updateStatus(message, tone = 'info') {
        if (!panelElement) {
            return;
        }

        const statusElement = panelElement.querySelector(`#${UI_IDS.status}`);
        if (!statusElement) {
            return;
        }

        const rawMessage = String(message ?? '');

        if (tone === 'success') {
            statusElement.textContent = `Done: ${rawMessage.replace(/^\s*(done:\s*)+/i, '')}`;
            return;
        }

        if (tone === 'error') {
            statusElement.textContent = `Error: ${rawMessage.replace(/^\s*(error:\s*)+/i, '')}`;
            return;
        }

        statusElement.textContent = rawMessage;
    }

    function getUiSettings() {
        const toolLocationValue = panelElement?.querySelector(`#${UI_IDS.toolLocation}`)?.value || 'overlay';
        const workflowValue = panelElement?.querySelector(`#${UI_IDS.workflow}`)?.value || 'line';
        const startValue = String(panelElement?.querySelector(`#${UI_IDS.start}`)?.value ?? '').trim();
        const endValue = String(panelElement?.querySelector(`#${UI_IDS.end}`)?.value ?? '').trim();
        const modeValue = panelElement?.querySelector(`#${UI_IDS.mode}`)?.value || 'all';
        const incrementValue = Number(panelElement?.querySelector(`#${UI_IDS.increment}`)?.value);
        const skip13Value = Boolean(panelElement?.querySelector(`#${UI_IDS.skip13}`)?.checked);

        return normalizeUiSettings({
            toolLocation: toolLocationValue,
            workflow: workflowValue,
            startNumber: startValue,
            endNumber: endValue,
            mode: modeValue,
            incrementStep: incrementValue,
            skip13: skip13Value,
        });
    }

    function getWorkflowMode() {
        const workflowValue = panelElement?.querySelector(`#${UI_IDS.workflow}`)?.value;
        if (workflowValue === 'click') {
            return 'click';
        }
        if (workflowValue === 'area') {
            return 'area';
        }
        return 'line';
    }

    function isToolsInSidebarMode() {
        return getUiSettings().toolLocation === 'sidebar';
    }

    function applyPanelStyleForLocation(isSidebarMode) {
        if (!panelElement) {
            return;
        }

        if (isSidebarMode) {
            panelElement.style.position = 'relative';
            panelElement.style.top = 'auto';
            panelElement.style.right = 'auto';
            panelElement.style.left = 'auto';
            panelElement.style.zIndex = 'auto';
            panelElement.style.width = '100%';
            panelElement.style.maxWidth = 'none';
            panelElement.style.marginTop = '8px';
            return;
        }

        panelElement.style.position = 'absolute';
        panelElement.style.top = '12px';
        panelElement.style.right = '12px';
        panelElement.style.left = 'auto';
        panelElement.style.zIndex = '999';
        panelElement.style.width = '300px';
        panelElement.style.maxWidth = 'calc(100% - 24px)';
        panelElement.style.marginTop = '0';
        panelElement.style.paddingLeft = '10px';
        panelElement.style.paddingRight = '10px';
    }

    function forceOverlayToolLocationSelection() {
        if (!panelElement) {
            return;
        }

        const toolLocationSelect = panelElement.querySelector(`#${UI_IDS.toolLocation}`);
        if (toolLocationSelect) {
            toolLocationSelect.value = 'overlay';
        }

        saveUiSettings(getUiSettings());
    }

    function applyToolLocation(sdk) {
        if (!panelElement) {
            return;
        }

        const isSidebarMode = isToolsInSidebarMode();
        const mapViewport = sdk?.Map?.getMapViewportElement?.();

        if (isSidebarMode) {
            const sidebarRoot = (scriptsTabContentRoot && scriptsTabContentRoot.isConnected) ? scriptsTabContentRoot : null;
            if (sidebarRoot) {
                if (panelElement.parentElement !== sidebarRoot) {
                    sidebarRoot.prepend(panelElement);
                }
                applyPanelStyleForLocation(true);
                if (scriptsTabLabelElement && typeof scriptsTabLabelElement.click === 'function') {
                    try {
                        scriptsTabLabelElement.click();
                    } catch {
                    }
                }
            } else {
                updateStatus('Opening Scripts tab...');
                void mountSidebarScannerIfPossible(sdk).then((mounted) => {
                    if (mounted) {
                        applyToolLocation(sdk);
                    } else {
                        forceOverlayToolLocationSelection();
                        applyToolLocation(sdk);
                        updateStatus('Scripts sidebar tab unavailable; reverted tools to overlay.', 'error');
                    }
                });
            }
            refreshOverlayVisibility();
            return;
        }

        if (mapViewport && panelElement.parentElement !== mapViewport) {
            mapViewport.appendChild(panelElement);
        }

        applyPanelStyleForLocation(false);
        const overlayState = loadOverlayState();
        applyOverlayPosition(panelElement, overlayState);
        refreshOverlayVisibility();
    }

    function refreshTipMessage() {
        const tipElement = panelElement?.querySelector(`#${UI_IDS.tip}`);
        if (!tipElement) {
            return;
        }

        const workflow = getWorkflowMode();

        if (workflow === 'line') {
            tipElement.textContent = 'Tip: Draw a line just like you would draw a road.\nShift-click to finish.\nHouse numbers are added along the line on the selected road.';
            return;
        }

        if (workflow === 'area') {
            tipElement.textContent = 'Warning: Area drawing is super buggy.\nUse Click to Add or Draw line for reliable results.';
            return;
        }

        if (workflow === 'click') {
            const ctrlHeldHint = (clickNumberingSession && isCtrlModifierHeld)
                ? '\nCtrl is held: next click uses temporary letter mode.'
                : '';
            const altHeldHint = (clickNumberingSession && isAltModifierHeld)
                ? '\nAlt is held: next click skips one extra number in sequence.'
                : '';
            tipElement.textContent = `Tip: Click mode ignores End #.\nUse Shift-click or Esc to finish.\nStart # auto-increments after each add.\nCtrl+Click places temporary letter suffixes (e.g. 25a) without changing the normal next click number.\nAlt+Click skips the next number in the normal sequence.\nCtrl+Alt+Click applies both behaviors.${ctrlHeldHint}${altHeldHint}`;
            return;
        }

        tipElement.textContent = 'Tip: End # is inclusive\nfor all workflows/modes.';
    }

    function refreshEndNumberControl() {
        const endWrap = panelElement?.querySelector(`#${UI_IDS.endWrap}`);
        const endInput = panelElement?.querySelector(`#${UI_IDS.end}`);
        if (!endInput || !endWrap) {
            return;
        }

        const isClickWorkflow = getWorkflowMode() === 'click';
        endWrap.style.display = isClickWorkflow ? 'none' : 'block';
        endInput.disabled = false;
        endInput.title = isClickWorkflow ? 'End # is ignored in Click to add mode' : '';
    }

    function letterToIndex(letter) {
        return letter.toLowerCase().charCodeAt(0) - 97;
    }

    function indexToLetter(index) {
        return String.fromCharCode(97 + index);
    }

    function parseHouseNumberValue(rawValue) {
        const value = String(rawValue ?? '').trim();
        if (!value) {
            return null;
        }

        const alphaMatch = value.match(/^(\d+)([a-zA-Z])$/);
        if (alphaMatch) {
            return {
                kind: 'alpha',
                base: Number(alphaMatch[1]),
                letterIndex: letterToIndex(alphaMatch[2]),
            };
        }

        if (/^\d+$/.test(value)) {
            return {
                kind: 'numeric',
                base: Number(value),
            };
        }

        return null;
    }

    function formatHouseNumberValue(parsedValue) {
        if (!parsedValue) {
            return '';
        }

        if (parsedValue.kind === 'alpha') {
            return `${parsedValue.base}${indexToLetter(parsedValue.letterIndex)}`;
        }

        return String(parsedValue.base);
    }

    function getFirstSequenceValue(startValue, mode, skip13, incrementStep = 1) {
        if (!startValue) {
            return null;
        }

        if (startValue.kind === 'alpha') {
            return {
                kind: 'alpha',
                base: startValue.base,
                letterIndex: startValue.letterIndex,
            };
        }

        return {
            kind: 'numeric',
            base: getFirstNumberInSequence(startValue.base, mode, skip13, incrementStep),
        };
    }

    function getNextSequenceValue(currentValue, mode, skip13, incrementStep = 1) {
        if (!currentValue) {
            return null;
        }

        if (currentValue.kind === 'alpha') {
            const step = mode === 'increment' ? getNumberStep('increment', incrementStep) : 1;
            return {
                kind: 'alpha',
                base: currentValue.base,
                letterIndex: currentValue.letterIndex + step,
            };
        }

        return {
            kind: 'numeric',
            base: getNextNumberInSequence(currentValue.base, mode, skip13, incrementStep),
        };
    }

    function refreshIncrementControl() {
        const incrementWrap = panelElement?.querySelector(`#${UI_IDS.incrementWrap}`);
        const incrementInput = panelElement?.querySelector(`#${UI_IDS.increment}`);
        if (!incrementWrap || !incrementInput) {
            return;
        }

        const settings = getUiSettings();
        const isIncrementMode = settings.mode === 'increment';
        incrementWrap.style.display = isIncrementMode ? 'block' : 'none';
        incrementInput.disabled = false;
        incrementInput.title = '';
    }

    function normalizeIncrementInputValue() {
        const incrementInput = panelElement?.querySelector(`#${UI_IDS.increment}`);
        if (!incrementInput) {
            return;
        }

        const parsed = Number(incrementInput.value);
        if (!Number.isFinite(parsed)) {
            incrementInput.value = '1';
            return;
        }

        const rounded = Math.round(parsed);
        incrementInput.value = String(rounded === 0 ? 1 : rounded);
    }

    function shouldSkipNumber(number, skip13Enabled) {
        return skip13Enabled && number === 13;
    }

    function buildNumberSequence({ startNumber, endNumber, mode, incrementStep, skip13 }) {
        const numbers = [];
        let currentNumber = startNumber;

        if (mode === 'odd' && currentNumber % 2 === 0) {
            currentNumber += 1;
        } else if (mode === 'even' && Math.abs(currentNumber % 2) === 1) {
            currentNumber += 1;
        }

        const step = getNumberStep(mode, incrementStep);

        if (step > 0) {
            while (currentNumber <= endNumber) {
                if (!shouldSkipNumber(currentNumber, skip13)) {
                    numbers.push(currentNumber);
                }
                currentNumber += step;
            }
        } else {
            while (currentNumber >= endNumber) {
                if (!shouldSkipNumber(currentNumber, skip13)) {
                    numbers.push(currentNumber);
                }
                currentNumber += step;
            }
        }

        return numbers;
    }

    function buildNumbersForNonClickWorkflow(settings) {
        const parsedStart = parseHouseNumberValue(settings.startNumber);
        const parsedEnd = parseHouseNumberValue(settings.endNumber);
        if (!parsedStart || !parsedEnd) {
            return [];
        }

        if (parsedStart.kind === 'alpha' || parsedEnd.kind === 'alpha') {
            if (
                parsedStart.kind !== 'alpha'
                || parsedEnd.kind !== 'alpha'
                || parsedStart.base !== parsedEnd.base
            ) {
                return [];
            }

            if (shouldSkipNumber(parsedStart.base, settings.skip13)) {
                return [];
            }

            const stepMagnitude = Math.max(1, Math.abs(settings.mode === 'increment' ? settings.incrementStep : 1));
            const direction = parsedEnd.letterIndex >= parsedStart.letterIndex ? 1 : -1;
            const step = stepMagnitude * direction;
            const numbers = [];

            for (
                let letterIndex = parsedStart.letterIndex;
                direction > 0 ? letterIndex <= parsedEnd.letterIndex : letterIndex >= parsedEnd.letterIndex;
                letterIndex += step
            ) {
                if (letterIndex < 0 || letterIndex > 25) {
                    break;
                }

                numbers.push(formatHouseNumberValue({
                    kind: 'alpha',
                    base: parsedStart.base,
                    letterIndex,
                }));
            }

            return numbers;
        }

        const numericSettings = {
            ...settings,
            startNumber: parsedStart.base,
            endNumber: parsedEnd.base,
        };

        return buildNumberSequence(numericSettings).map((value) => String(value));
    }

    function distanceMeters(leftLonLat, rightLonLat) {
        const [leftLon, leftLat] = leftLonLat;
        const [rightLon, rightLat] = rightLonLat;
        const rad = Math.PI / 180;
        const x = (rightLon - leftLon) * rad * Math.cos(((leftLat + rightLat) * 0.5) * rad);
        const y = (rightLat - leftLat) * rad;
        return Math.hypot(x, y) * 6371000;
    }

    function interpolatePoint(leftLonLat, rightLonLat, ratio) {
        const [leftLon, leftLat] = leftLonLat;
        const [rightLon, rightLat] = rightLonLat;
        return [
            leftLon + ((rightLon - leftLon) * ratio),
            leftLat + ((rightLat - leftLat) * ratio),
        ];
    }

    function getPointsAlongLine(lineCoordinates, pointCount) {
        const coordinates = Array.isArray(lineCoordinates) ? lineCoordinates.filter((item) => Array.isArray(item) && item.length >= 2) : [];
        if (coordinates.length < 2) {
            return [];
        }

        const segmentLengths = [];
        let totalLength = 0;

        for (let index = 0; index < coordinates.length - 1; index += 1) {
            const length = distanceMeters(coordinates[index], coordinates[index + 1]);
            segmentLengths.push(length);
            totalLength += length;
        }

        if (totalLength <= 0) {
            return Array.from({ length: pointCount }, () => [coordinates[0][0], coordinates[0][1]]);
        }

        const targets = pointCount === 1
            ? [totalLength * 0.5]
            : Array.from({ length: pointCount }, (_, index) => (index * totalLength) / (pointCount - 1));

        const output = [];
        let segmentIndex = 0;
        let traversed = 0;

        targets.forEach((targetDistance) => {
            while (segmentIndex < segmentLengths.length - 1 && (traversed + segmentLengths[segmentIndex]) < targetDistance) {
                traversed += segmentLengths[segmentIndex];
                segmentIndex += 1;
            }

            const currentSegmentLength = segmentLengths[segmentIndex] || 0;
            const ratio = currentSegmentLength > 0
                ? (targetDistance - traversed) / currentSegmentLength
                : 0;

            const start = coordinates[segmentIndex];
            const end = coordinates[Math.min(segmentIndex + 1, coordinates.length - 1)];
            output.push(interpolatePoint(start, end, Math.max(0, Math.min(1, ratio))));
        });

        return output;
    }

    function sanitizeCoordinateList(coordinates) {
        if (!Array.isArray(coordinates)) {
            return [];
        }

        return coordinates
            .filter((item) => Array.isArray(item) && item.length >= 2 && Number.isFinite(item[0]) && Number.isFinite(item[1]))
            .map(([lon, lat]) => [Number(lon), Number(lat)]);
    }

    function extractAreaOuterRing(areaGeometry) {
        const coordinates = areaGeometry?.coordinates;
        if (!Array.isArray(coordinates) || coordinates.length < 1) {
            return [];
        }

        if (Number.isFinite(coordinates[0]?.[0]) && Number.isFinite(coordinates[0]?.[1])) {
            return sanitizeCoordinateList(coordinates);
        }

        if (Array.isArray(coordinates[0]) && Number.isFinite(coordinates[0]?.[0]?.[0]) && Number.isFinite(coordinates[0]?.[0]?.[1])) {
            return sanitizeCoordinateList(coordinates[0]);
        }

        if (
            Array.isArray(coordinates[0])
            && Array.isArray(coordinates[0][0])
            && Number.isFinite(coordinates[0]?.[0]?.[0]?.[0])
            && Number.isFinite(coordinates[0]?.[0]?.[0]?.[1])
        ) {
            return sanitizeCoordinateList(coordinates[0][0]);
        }

        return [];
    }

    function isPointInsidePolygon(pointLonLat, polygonRing) {
        const [pointLon, pointLat] = pointLonLat;
        let inside = false;

        for (let i = 0, j = polygonRing.length - 1; i < polygonRing.length; j = i, i += 1) {
            const [lonI, latI] = polygonRing[i];
            const [lonJ, latJ] = polygonRing[j];

            const intersects = (
                ((latI > pointLat) !== (latJ > pointLat))
                && (pointLon < (((lonJ - lonI) * (pointLat - latI)) / ((latJ - latI) || Number.EPSILON)) + lonI)
            );

            if (intersects) {
                inside = !inside;
            }
        }

        return inside;
    }

    function getPolygonCentroid(polygonRing) {
        if (!Array.isArray(polygonRing) || polygonRing.length < 1) {
            return [0, 0];
        }

        const sums = polygonRing.reduce((acc, [lon, lat]) => {
            acc.lon += lon;
            acc.lat += lat;
            return acc;
        }, { lon: 0, lat: 0 });

        return [sums.lon / polygonRing.length, sums.lat / polygonRing.length];
    }

    function getLocalMetersScale(referenceLat) {
        const metersPerDegreeLat = 111319.49079327358;
        const metersPerDegreeLon = metersPerDegreeLat * Math.cos((referenceLat * Math.PI) / 180);
        return {
            metersPerDegreeLon,
            metersPerDegreeLat,
        };
    }

    function lonLatToLocalMeters(pointLonLat, originLonLat, scale) {
        const [lon, lat] = pointLonLat;
        const [originLon, originLat] = originLonLat;
        return {
            x: (lon - originLon) * scale.metersPerDegreeLon,
            y: (lat - originLat) * scale.metersPerDegreeLat,
        };
    }

    function localMetersToLonLat(point, originLonLat, scale) {
        const [originLon, originLat] = originLonLat;
        const lon = originLon + (point.x / scale.metersPerDegreeLon);
        const lat = originLat + (point.y / scale.metersPerDegreeLat);
        return [lon, lat];
    }

    function rotatePoint(point, angleRadians) {
        const cosine = Math.cos(angleRadians);
        const sine = Math.sin(angleRadians);
        return {
            x: (point.x * cosine) - (point.y * sine),
            y: (point.x * sine) + (point.y * cosine),
        };
    }

    function getPolygonOrientationRadians(polygonRing) {
        if (!Array.isArray(polygonRing) || polygonRing.length < 3) {
            return 0;
        }

        const centroid = getPolygonCentroid(polygonRing);
        const scale = getLocalMetersScale(centroid[1]);
        const localPoints = polygonRing.map((point) => lonLatToLocalMeters(point, centroid, scale));

        const sampleCount = localPoints.length;
        const means = localPoints.reduce((acc, point) => {
            acc.x += point.x;
            acc.y += point.y;
            return acc;
        }, { x: 0, y: 0 });
        const meanX = means.x / sampleCount;
        const meanY = means.y / sampleCount;

        const covariance = localPoints.reduce((acc, point) => {
            const dx = point.x - meanX;
            const dy = point.y - meanY;
            acc.varX += dx * dx;
            acc.varY += dy * dy;
            acc.covXY += dx * dy;
            return acc;
        }, { varX: 0, varY: 0, covXY: 0 });

        const varX = covariance.varX / sampleCount;
        const varY = covariance.varY / sampleCount;
        const covXY = covariance.covXY / sampleCount;
        const orientation = 0.5 * Math.atan2(2 * covXY, varX - varY);

        return Number.isFinite(orientation) ? orientation : 0;
    }

    function pickEvenlySpacedCandidates(candidates, targetCount) {
        if (candidates.length <= targetCount) {
            return candidates.slice(0, targetCount);
        }

        return Array.from({ length: targetCount }, (_, index) => {
            const candidateIndex = Math.floor((index * candidates.length) / targetCount);
            return candidates[Math.min(candidates.length - 1, candidateIndex)];
        });
    }

    function getPointsInAreaGrid(areaCoordinates, pointCount) {
        const outerRing = sanitizeCoordinateList(areaCoordinates);
        if (outerRing.length < 3) {
            return [];
        }

        const centroid = getPolygonCentroid(outerRing);
        const localScale = getLocalMetersScale(centroid[1]);
        const orientationRadians = getPolygonOrientationRadians(outerRing);
        const rotatedPolygon = outerRing
            .map((point) => lonLatToLocalMeters(point, centroid, localScale))
            .map((point) => rotatePoint(point, -orientationRadians));

        const xValues = rotatedPolygon.map((point) => point.x);
        const yValues = rotatedPolygon.map((point) => point.y);
        const minX = Math.min(...xValues);
        const maxX = Math.max(...xValues);
        const minY = Math.min(...yValues);
        const maxY = Math.max(...yValues);
        const widthMeters = maxX - minX;
        const heightMeters = maxY - minY;

        if (widthMeters <= 0 || heightMeters <= 0) {
            return Array.from({ length: pointCount }, () => [centroid[0], centroid[1]]);
        }

        const aspectRatio = Math.max(0.2, Math.min(5, widthMeters / heightMeters));
        let columns = Math.max(1, Math.round(Math.sqrt(pointCount * aspectRatio)));
        let rows = Math.max(1, Math.ceil(pointCount / columns));

        for (let attempt = 0; attempt < 8; attempt += 1) {
            const candidates = [];

            for (let row = 0; row < rows; row += 1) {
                for (let col = 0; col < columns; col += 1) {
                    const rotatedX = minX + (((col + 0.5) / columns) * (maxX - minX));
                    const rotatedY = minY + (((row + 0.5) / rows) * (maxY - minY));
                    const localPoint = rotatePoint({ x: rotatedX, y: rotatedY }, orientationRadians);
                    const lonLat = localMetersToLonLat(localPoint, centroid, localScale);
                    if (isPointInsidePolygon(lonLat, outerRing)) {
                        candidates.push(lonLat);
                    }
                }
            }

            if (candidates.length >= pointCount) {
                return pickEvenlySpacedCandidates(candidates, pointCount);
            }

            columns = Math.max(columns + 1, Math.ceil(columns * 1.4));
            rows = Math.max(rows + 1, Math.ceil(rows * 1.4));
        }
        return Array.from({ length: pointCount }, () => [centroid[0], centroid[1]]);
    }

    async function drawAreaGeometry(sdk) {
        if (typeof sdk?.Map?.drawArea === 'function') {
            return sdk.Map.drawArea();
        }
        if (typeof sdk?.Map?.drawPolygon === 'function') {
            return sdk.Map.drawPolygon();
        }
        throw new Error('Area drawing is unavailable in this WME version');
    }

    function setRunButtonBusy(isBusy) {
        const runButton = panelElement?.querySelector(`#${UI_IDS.run}`);
        if (!runButton) {
            return;
        }

        runButton.disabled = isBusy;
        runButton.textContent = isBusy ? 'Working…' : 'Draw line and add HNs';
    }

    function getNumberStep(mode, incrementStep = 1) {
        if (mode === 'increment') {
            const parsed = Number.isFinite(incrementStep) ? Math.round(incrementStep) : 1;
            return parsed === 0 ? 1 : parsed;
        }

        return mode === 'all' ? 1 : 2;
    }

    function getFirstNumberInSequence(startNumber, mode, skip13, incrementStep = 1) {
        let number = startNumber;
        if (mode === 'odd' && number % 2 === 0) {
            number += 1;
        } else if (mode === 'even' && Math.abs(number % 2) === 1) {
            number += 1;
        }

        const step = getNumberStep(mode, incrementStep);
        while (shouldSkipNumber(number, skip13)) {
            number += step;
        }

        return number;
    }

    function getNextNumberInSequence(currentNumber, mode, skip13, incrementStep = 1) {
        const step = getNumberStep(mode, incrementStep);
        let nextNumber = currentNumber + step;

        while (shouldSkipNumber(nextNumber, skip13)) {
            nextNumber += step;
        }

        return nextNumber;
    }

    function getSelectedSegmentId(sdk) {
        const selection = sdk?.Editing?.getSelection?.();
        if (!selection || !Array.isArray(selection.ids) || selection.ids.length !== 1) {
            return null;
        }
        if (String(selection.objectType).toLowerCase() !== 'segment') {
            return null;
        }
        const segmentId = Number(selection.ids[0]);
        return Number.isFinite(segmentId) ? segmentId : null;
    }

    function getSelectedRoadKey(sdk) {
        const selectedSegmentId = getSelectedSegmentId(sdk);
        if (selectedSegmentId === null) {
            return null;
        }

        const segment = sdk?.DataModel?.Segments?.getById?.({ segmentId: selectedSegmentId });
        if (!segment) {
            return null;
        }

        if (segment.primaryStreetId === null || segment.primaryStreetId === undefined) {
            return `segment:${segment.id}`;
        }

        return `street:${segment.primaryStreetId}`;
    }

    function resetStartForRoadChange(sdk) {
        const settings = getUiSettings();
        const defaultStart = getFirstNumberInSequence(1, settings.mode, settings.skip13, settings.incrementStep);
        setStartInputValue(defaultStart);
        updateStartFromRoadMax(sdk);
    }

    function isSameRoadSegment(segment, anchorSegment) {
        if (!segment || !anchorSegment) {
            return false;
        }
        if (anchorSegment.primaryStreetId === null) {
            return segment.id === anchorSegment.id;
        }
        return segment.primaryStreetId === anchorSegment.primaryStreetId;
    }

    function getConnectedSegmentsSafe(sdk, segmentId, reverseDirection) {
        try {
            return sdk.DataModel.Segments.getConnectedSegments({ segmentId, reverseDirection }) || [];
        } catch {
            return [];
        }
    }

    function getRoadSegmentCandidates(sdk, selectedSegmentId) {
        const anchorSegment = sdk?.DataModel?.Segments?.getById?.({ segmentId: selectedSegmentId });
        if (!anchorSegment) {
            return [];
        }

        const queue = [anchorSegment.id];
        const visited = new Set();
        const candidates = [];

        while (queue.length > 0) {
            const currentSegmentId = queue.shift();
            if (!Number.isFinite(currentSegmentId) || visited.has(currentSegmentId)) {
                continue;
            }
            visited.add(currentSegmentId);

            const currentSegment = sdk.DataModel.Segments.getById({ segmentId: currentSegmentId });
            if (!currentSegment || !isSameRoadSegment(currentSegment, anchorSegment)) {
                continue;
            }

            candidates.push(currentSegment);

            const forward = getConnectedSegmentsSafe(sdk, currentSegmentId, false);
            const reverse = getConnectedSegmentsSafe(sdk, currentSegmentId, true);
            [...forward, ...reverse].forEach((neighborSegment) => {
                if (neighborSegment && Number.isFinite(neighborSegment.id) && !visited.has(neighborSegment.id)) {
                    queue.push(neighborSegment.id);
                }
            });
        }

        return candidates;
    }

    function pointToSegmentDistanceMeters(pointLonLat, segmentStartLonLat, segmentEndLonLat) {
        const [pointLon, pointLat] = pointLonLat;
        const [startLon, startLat] = segmentStartLonLat;
        const [endLon, endLat] = segmentEndLonLat;
        const rad = Math.PI / 180;
        const refLatRad = pointLat * rad;
        const metersPerLon = Math.cos(refLatRad) * 6371000;
        const metersPerLat = 6371000;

        const pointX = pointLon * rad * metersPerLon;
        const pointY = pointLat * rad * metersPerLat;
        const startX = startLon * rad * metersPerLon;
        const startY = startLat * rad * metersPerLat;
        const endX = endLon * rad * metersPerLon;
        const endY = endLat * rad * metersPerLat;

        const deltaX = endX - startX;
        const deltaY = endY - startY;
        const lengthSquared = (deltaX * deltaX) + (deltaY * deltaY);

        if (lengthSquared <= 0) {
            return Math.hypot(pointX - startX, pointY - startY);
        }

        const projection = ((pointX - startX) * deltaX + (pointY - startY) * deltaY) / lengthSquared;
        const clampedProjection = Math.max(0, Math.min(1, projection));
        const closestX = startX + (clampedProjection * deltaX);
        const closestY = startY + (clampedProjection * deltaY);

        return Math.hypot(pointX - closestX, pointY - closestY);
    }

    function pointToLineStringDistanceMeters(pointLonLat, coordinates) {
        if (!Array.isArray(coordinates) || coordinates.length < 1) {
            return Number.POSITIVE_INFINITY;
        }

        if (coordinates.length === 1) {
            return distanceMeters(pointLonLat, coordinates[0]);
        }

        let minDistance = Number.POSITIVE_INFINITY;
        for (let index = 0; index < coordinates.length - 1; index += 1) {
            const currentDistance = pointToSegmentDistanceMeters(pointLonLat, coordinates[index], coordinates[index + 1]);
            if (currentDistance < minDistance) {
                minDistance = currentDistance;
            }
        }
        return minDistance;
    }

    function getNearestSameRoadSegmentId(pointLonLat, candidateSegments, fallbackSegmentId) {
        let nearestSegmentId = fallbackSegmentId;
        let nearestDistance = Number.POSITIVE_INFINITY;

        candidateSegments.forEach((segment) => {
            const distance = pointToLineStringDistanceMeters(pointLonLat, segment?.geometry?.coordinates);
            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearestSegmentId = segment.id;
            }
        });

        return nearestSegmentId;
    }

    function isCtrlClickEvent(event) {
        return Boolean(
            event?.ctrlKey
            || event?.metaKey
            || event?.originalEvent?.ctrlKey
            || event?.originalEvent?.metaKey
            || event?.nativeEvent?.ctrlKey
            || event?.nativeEvent?.metaKey
            || event?.domEvent?.ctrlKey
            || event?.domEvent?.metaKey
            || event?.browserEvent?.ctrlKey
            || event?.browserEvent?.metaKey
        );
    }

    function isAltClickEvent(event) {
        return Boolean(
            event?.altKey
            || event?.originalEvent?.altKey
            || event?.nativeEvent?.altKey
            || event?.domEvent?.altKey
            || event?.browserEvent?.altKey
        );
    }

    function rememberCtrlClickModifierFromDomEvent(event) {
        if (!event) {
            return;
        }

        if (isClientPointInsideOverlay(event.clientX, event.clientY)) {
            pendingCtrlClickModifier = false;
            pendingCtrlClickModifierAt = 0;
            pendingAltClickModifier = false;
            pendingAltClickModifierAt = 0;
            return;
        }

        pendingCtrlClickModifier = Boolean(event.ctrlKey || event.metaKey);
        pendingCtrlClickModifierAt = Date.now();
        pendingAltClickModifier = Boolean(event.altKey);
        pendingAltClickModifierAt = Date.now();
    }

    function consumePendingCtrlClickModifier() {
        if (!pendingCtrlClickModifier) {
            return false;
        }

        const isFresh = (Date.now() - pendingCtrlClickModifierAt) <= 1500;
        pendingCtrlClickModifier = false;
        pendingCtrlClickModifierAt = 0;
        return isFresh;
    }

    function consumePendingAltClickModifier() {
        if (!pendingAltClickModifier) {
            return false;
        }

        const isFresh = (Date.now() - pendingAltClickModifierAt) <= 1500;
        pendingAltClickModifier = false;
        pendingAltClickModifierAt = 0;
        return isFresh;
    }

    function setCtrlModifierHeld(nextValue) {
        const normalized = Boolean(nextValue);
        if (isCtrlModifierHeld === normalized) {
            return;
        }

        isCtrlModifierHeld = normalized;
        refreshTipMessage();
    }

    function setAltModifierHeld(nextValue) {
        const normalized = Boolean(nextValue);
        if (isAltModifierHeld === normalized) {
            return;
        }

        isAltModifierHeld = normalized;
        refreshTipMessage();
    }

    function extractLonLatFromMapClickEvent(sdk, event) {
        if (Number.isFinite(event?.lon) && Number.isFinite(event?.lat)) {
            return [event.lon, event.lat];
        }

        if (Array.isArray(event?.lonLat) && event.lonLat.length >= 2) {
            return [event.lonLat[0], event.lonLat[1]];
        }

        if (Array.isArray(event?.coordinates) && event.coordinates.length >= 2) {
            return [event.coordinates[0], event.coordinates[1]];
        }

        const x = Number.isFinite(event?.x) ? event.x : (Number.isFinite(event?.mapX) ? event.mapX : null);
        const y = Number.isFinite(event?.y) ? event.y : (Number.isFinite(event?.mapY) ? event.mapY : null);
        if (x === null || y === null) {
            return null;
        }

        try {
            const lonLat = sdk.Map.getLonLatFromMapPixel({ x, y });
            if (Array.isArray(lonLat) && lonLat.length >= 2) {
                return [lonLat[0], lonLat[1]];
            }
        } catch {
        }

        try {
            const lonLat = sdk.Map.getLonLatFromPixel({ x, y });
            if (Array.isArray(lonLat) && lonLat.length >= 2) {
                return [lonLat[0], lonLat[1]];
            }
        } catch {
        }

        return null;
    }

    function extractLonLatFromClientPoint(sdk, clientX, clientY) {
        const mapViewport = sdk.Map.getMapViewportElement();
        if (!mapViewport) {
            return null;
        }

        const viewportRect = mapViewport.getBoundingClientRect();
        const mapX = clientX - viewportRect.left;
        const mapY = clientY - viewportRect.top;

        if (Number.isFinite(mapX) && Number.isFinite(mapY)) {
            try {
                const lonLat = sdk.Map.getLonLatFromMapPixel({ x: mapX, y: mapY });
                if (Array.isArray(lonLat) && lonLat.length >= 2) {
                    return [lonLat[0], lonLat[1]];
                }
            } catch {
            }
        }

        if (Number.isFinite(clientX) && Number.isFinite(clientY)) {
            try {
                const lonLat = sdk.Map.getLonLatFromPixel({ x: clientX, y: clientY });
                if (Array.isArray(lonLat) && lonLat.length >= 2) {
                    return [lonLat[0], lonLat[1]];
                }
            } catch {
            }
        }

        return null;
    }

    function keepClickSessionSegmentSelected(sdk) {
        if (!clickNumberingSession) {
            return;
        }

        const activeSegmentId = getSelectedSegmentId(sdk);
        if (activeSegmentId === clickNumberingSession.selectedSegmentId) {
            return;
        }

        try {
            sdk.Editing.setSelection({
                selection: {
                    objectType: 'segment',
                    ids: [clickNumberingSession.selectedSegmentId],
                },
            });
        } catch {
        }
    }

    function extractMapPixelFromEvent(event) {
        const x = Number.isFinite(event?.x) ? event.x : (Number.isFinite(event?.mapX) ? event.mapX : null);
        const y = Number.isFinite(event?.y) ? event.y : (Number.isFinite(event?.mapY) ? event.mapY : null);
        if (x === null || y === null) {
            return null;
        }
        return { x, y };
    }

    function isMapEventInsideOverlay(sdk, event) {
        if (!panelElement) {
            return false;
        }

        const mapPixel = extractMapPixelFromEvent(event);
        if (!mapPixel) {
            return false;
        }

        const mapViewport = sdk.Map.getMapViewportElement();
        if (!mapViewport) {
            return false;
        }

        const viewportRect = mapViewport.getBoundingClientRect();
        const panelRect = panelElement.getBoundingClientRect();
        const clientX = viewportRect.left + mapPixel.x;
        const clientY = viewportRect.top + mapPixel.y;

        return (
            clientX >= panelRect.left
            && clientX <= panelRect.right
            && clientY >= panelRect.top
            && clientY <= panelRect.bottom
        );
    }

    function isClientPointInsideOverlay(clientX, clientY) {
        if (!panelElement) {
            return false;
        }

        const panelRect = panelElement.getBoundingClientRect();
        return (
            clientX >= panelRect.left
            && clientX <= panelRect.right
            && clientY >= panelRect.top
            && clientY <= panelRect.bottom
        );
    }

    function shouldInterceptShiftFinishEvent(event) {
        if (!clickNumberingSession || !event?.shiftKey) {
            return false;
        }

        if (Number.isFinite(event?.button) && event.button !== 0) {
            return false;
        }

        return !isClientPointInsideOverlay(event.clientX, event.clientY);
    }

    function stopClickNumberingMode(sdk, message = 'Exited click-numbering mode.', tone = 'info') {
        clickNumberingSession = null;
        updateStatus(message, tone);
        refreshRunButtonState(sdk);
    }

    function startClickNumberingMode(sdk, settings) {
        const selectedSegmentId = getSelectedSegmentId(sdk);
        if (selectedSegmentId === null) {
            updateStatus('Select exactly one road segment first, then run.', 'error');
            refreshRunButtonState(sdk);
            return;
        }

        if (!sdk.Editing.isEditingAllowed()) {
            updateStatus('Editing is currently disabled in WME.', 'error');
            refreshRunButtonState(sdk);
            return;
        }

        const houseNumbersApi = getHouseNumbersApi(sdk);
        if (!houseNumbersApi) {
            console.error('[WME Super House Numbers] HouseNumbers API is unavailable on SDK instance');
            updateStatus('House number API is unavailable in this WME version.', 'error');
            refreshRunButtonState(sdk);
            return;
        }

        const roadSegmentCandidates = getRoadSegmentCandidates(sdk, selectedSegmentId);
        if (roadSegmentCandidates.length < 1) {
            updateStatus('Could not resolve strict same-road segments for selected segment.', 'error');
            refreshRunButtonState(sdk);
            return;
        }

        clickNumberingSession = {
            selectedSegmentId,
            roadSegmentCandidates,
            houseNumbersApi,
            mode: settings.mode,
            incrementStep: settings.incrementStep,
            skip13: settings.skip13,
            currentValue: getFirstSequenceValue(
                parseHouseNumberValue(settings.startNumber),
                settings.mode,
                settings.skip13,
                settings.incrementStep,
            ),
            lastPlacedValue: null,
            ctrlLetterState: null,
        };

        if (!clickNumberingSession.currentValue) {
            clickNumberingSession = null;
            updateStatus('Start # must be numeric or a single-letter suffix (e.g. 12 or 12a).', 'error');
            refreshRunButtonState(sdk);
            return;
        }

        updateStatus('Click map to add HNs. Shift-click to finish, Esc to exit.');
        refreshRunButtonState(sdk);
    }

    function handleMapClickInNumberingMode(sdk, event) {
        if (!clickNumberingSession) {
            return;
        }

        if (isMapEventInsideOverlay(sdk, event)) {
            return;
        }

        const lonLat = extractLonLatFromMapClickEvent(sdk, event);
        const resolvedLonLat = lonLat || lastMapMouseLonLat;
        if (!resolvedLonLat) {
            updateStatus('Could not resolve click location. Try again.', 'error');
            return;
        }

        const segmentId = getNearestSameRoadSegmentId(
            resolvedLonLat,
            clickNumberingSession.roadSegmentCandidates,
            clickNumberingSession.selectedSegmentId,
        );

        const pendingCtrlModifier = consumePendingCtrlClickModifier();
        const isCtrlClick = isCtrlClickEvent(event) || pendingCtrlModifier;
        const pendingAltModifier = consumePendingAltClickModifier();
        const isAltClick = isAltClickEvent(event) || pendingAltModifier;
        let numberToAdd = formatHouseNumberValue(clickNumberingSession.currentValue);

        if (isCtrlClick) {
            const parsedLastPlaced = parseHouseNumberValue(clickNumberingSession.lastPlacedValue);
            const ctrlSourceValue = parsedLastPlaced || clickNumberingSession.currentValue;

            if (ctrlSourceValue) {
                const baseNumber = ctrlSourceValue.base;
                let nextLetterIndex = 0;

                if (clickNumberingSession.ctrlLetterState?.baseNumber === baseNumber) {
                    nextLetterIndex = clickNumberingSession.ctrlLetterState.nextLetterIndex;
                } else if (ctrlSourceValue.kind === 'alpha') {
                    nextLetterIndex = ctrlSourceValue.letterIndex + 1;
                }

                if (nextLetterIndex >= 0 && nextLetterIndex <= 25) {
                    numberToAdd = formatHouseNumberValue({
                        kind: 'alpha',
                        base: baseNumber,
                        letterIndex: nextLetterIndex,
                    });

                    clickNumberingSession.ctrlLetterState = {
                        baseNumber,
                        nextLetterIndex: nextLetterIndex + 1,
                    };
                }
            }
        }

        clickNumberingSession.houseNumbersApi.addHouseNumber({
            number: String(numberToAdd),
            segmentId,
            point: {
                type: 'Point',
                coordinates: [resolvedLonLat[0], resolvedLonLat[1]],
            },
        });

        clickNumberingSession.lastPlacedValue = numberToAdd;

        if (isCtrlClick) {
            if (isAltClick) {
                clickNumberingSession.currentValue = getNextSequenceValue(
                    clickNumberingSession.currentValue,
                    clickNumberingSession.mode,
                    clickNumberingSession.skip13,
                    clickNumberingSession.incrementStep,
                );

                const nextNormalValueText = formatHouseNumberValue(clickNumberingSession.currentValue);
                const startInput = panelElement?.querySelector(`#${UI_IDS.start}`);
                if (startInput && nextNormalValueText) {
                    startInput.value = nextNormalValueText;
                    saveUiSettings(getUiSettings());
                }

                updateStatus(`Added #${numberToAdd}. Ctrl+Alt applied: skipped next normal number. Next normal click: #${nextNormalValueText}.`, 'success');
                return;
            }

            const nextNormalValueText = formatHouseNumberValue(clickNumberingSession.currentValue);
            updateStatus(`Added #${numberToAdd}. Next normal click: #${nextNormalValueText}.`, 'success');
            return;
        }

        clickNumberingSession.ctrlLetterState = null;

        clickNumberingSession.currentValue = getNextSequenceValue(
            clickNumberingSession.currentValue,
            clickNumberingSession.mode,
            clickNumberingSession.skip13,
            clickNumberingSession.incrementStep,
        );

        if (isAltClick) {
            clickNumberingSession.currentValue = getNextSequenceValue(
                clickNumberingSession.currentValue,
                clickNumberingSession.mode,
                clickNumberingSession.skip13,
                clickNumberingSession.incrementStep,
            );
        }

        const nextValueText = formatHouseNumberValue(clickNumberingSession.currentValue);
        const startInput = panelElement?.querySelector(`#${UI_IDS.start}`);
        if (startInput && nextValueText) {
            startInput.value = nextValueText;
            saveUiSettings(getUiSettings());
        }

        if (isAltClick) {
            updateStatus(`Added #${numberToAdd}. Skipped next number. Shift-click to finish, Esc to exit.`, 'success');
            return;
        }

        updateStatus(`Added #${numberToAdd}. Shift-click to finish, Esc to exit.`, 'success');
    }

    function applyManualStartToActiveClickSession() {
        if (!clickNumberingSession) {
            return;
        }

        const startInput = panelElement?.querySelector(`#${UI_IDS.start}`);
        if (!startInput) {
            return;
        }

        const parsedStart = parseHouseNumberValue(startInput.value);
        const nextValue = getFirstSequenceValue(
            parsedStart,
            clickNumberingSession.mode,
            clickNumberingSession.skip13,
            clickNumberingSession.incrementStep,
        );

        if (!nextValue) {
            updateStatus('Invalid Start #. Use numeric or single-letter suffix (e.g. 23 or 23a).', 'error');
            return;
        }

        clickNumberingSession.currentValue = nextValue;
        startInput.value = formatHouseNumberValue(nextValue);
        saveUiSettings(getUiSettings());
        updateStatus(`Next click will place #${formatHouseNumberValue(nextValue)}.`, 'success');
    }

    function applySkip13ToActiveClickSession(skip13Enabled) {
        if (!clickNumberingSession) {
            return;
        }

        clickNumberingSession.skip13 = Boolean(skip13Enabled);

        if (
            clickNumberingSession.skip13
            && clickNumberingSession.currentValue?.kind === 'numeric'
            && clickNumberingSession.currentValue.base === 13
        ) {
            clickNumberingSession.currentValue = getNextSequenceValue(
                clickNumberingSession.currentValue,
                clickNumberingSession.mode,
                clickNumberingSession.skip13,
                clickNumberingSession.incrementStep,
            );

            const nextValueText = formatHouseNumberValue(clickNumberingSession.currentValue);
            const startInput = panelElement?.querySelector(`#${UI_IDS.start}`);
            if (startInput && nextValueText) {
                startInput.value = nextValueText;
            }

            updateStatus(`Skip 13 enabled. Next click will place #${nextValueText}.`, 'success');
        }
    }

    function setPanelCollapsed(collapsed) {
        isCollapsed = Boolean(collapsed);

        const bodyElement = panelElement?.querySelector(`#${UI_IDS.body}`);
        if (bodyElement) {
            bodyElement.style.display = isCollapsed ? 'none' : 'block';
        }

        const collapseButton = panelElement?.querySelector(`#${UI_IDS.collapse}`);
        if (collapseButton) {
            collapseButton.textContent = isCollapsed ? '▸' : '▾';
            collapseButton.title = isCollapsed ? 'Expand panel' : 'Collapse panel';
        }
    }

    function clampOverlayPosition(panelRect, viewportRect, left, top) {
        const minLeft = 0;
        const minTop = 0;
        const maxLeft = Math.max(0, viewportRect.width - panelRect.width);
        const maxTop = Math.max(0, viewportRect.height - panelRect.height);

        return {
            left: Math.max(minLeft, Math.min(maxLeft, left)),
            top: Math.max(minTop, Math.min(maxTop, top)),
        };
    }

    function initOverlayInteractions(sdk) {
        const headerElement = panelElement?.querySelector(`#${UI_IDS.header}`);
        const collapseButton = panelElement?.querySelector(`#${UI_IDS.collapse}`);
        const closeButton = panelElement?.querySelector(`#${UI_IDS.close}`);
        const mapViewport = sdk.Map.getMapViewportElement();
        if (!headerElement || !collapseButton || !closeButton || !mapViewport || !panelElement) {
            return;
        }

        const shieldMapFromPanel = (event) => {
            event.stopPropagation();
        };

        [
            'pointerdown',
            'pointerup',
            'mousedown',
            'mouseup',
            'click',
            'dblclick',
        ].forEach((eventName) => {
            panelElement.addEventListener(eventName, shieldMapFromPanel);
        });

        const preventHeaderButtonDragStart = (event) => {
            event.stopPropagation();
        };

        collapseButton.addEventListener('mousedown', preventHeaderButtonDragStart);
        closeButton.addEventListener('mousedown', preventHeaderButtonDragStart);

        collapseButton.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            setPanelCollapsed(!isCollapsed);
            persistOverlayState(sdk);
        });

        closeButton.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            persistOverlayState(sdk, { closed: true });
            isPanelClosed = true;
            refreshOverlayVisibility();
        });

        headerElement.addEventListener('mousedown', (event) => {
            if (isToolsInSidebarMode()) {
                return;
            }

            if (event.button !== 0) {
                return;
            }

            event.stopPropagation();

            const panelRect = panelElement.getBoundingClientRect();
            const viewportRect = mapViewport.getBoundingClientRect();
            panelElement.style.left = `${panelRect.left - viewportRect.left}px`;
            panelElement.style.top = `${panelRect.top - viewportRect.top}px`;
            panelElement.style.right = 'auto';

            isDragging = true;
            dragOffsetX = event.clientX - panelRect.left;
            dragOffsetY = event.clientY - panelRect.top;
            event.preventDefault();
        });

        headerElement.addEventListener('click', (event) => {
            event.stopPropagation();
        });

        headerElement.addEventListener('dblclick', (event) => {
            event.stopPropagation();
            event.preventDefault();
        });

        window.addEventListener('mousemove', (event) => {
            if (isToolsInSidebarMode()) {
                return;
            }

            if (!isDragging || !panelElement) {
                return;
            }

            event.stopPropagation();
            event.preventDefault();

            const currentPanelRect = panelElement.getBoundingClientRect();
            const viewportRect = mapViewport.getBoundingClientRect();
            const relativeLeft = event.clientX - viewportRect.left - dragOffsetX;
            const relativeTop = event.clientY - viewportRect.top - dragOffsetY;
            const clamped = clampOverlayPosition(currentPanelRect, viewportRect, relativeLeft, relativeTop);

            panelElement.style.left = `${clamped.left}px`;
            panelElement.style.top = `${clamped.top}px`;
            panelElement.style.right = 'auto';
        });

        window.addEventListener('mouseup', (event) => {
            if (isToolsInSidebarMode()) {
                isDragging = false;
                return;
            }

            if (isDragging) {
                event.stopPropagation();
                event.preventDefault();
                persistOverlayState(sdk);
            }
            isDragging = false;
        }, true);
    }

    function refreshRunButtonState(sdk) {
        const runButton = panelElement?.querySelector(`#${UI_IDS.run}`);
        if (!runButton) {
            return;
        }

        const workflow = getWorkflowMode();
        const canRun = getSelectedSegmentId(sdk) !== null;

        if (workflow === 'click') {
            runButton.disabled = isRunning || (!canRun && !clickNumberingSession);
            runButton.textContent = clickNumberingSession ? 'Stop click mode' : 'Start click mode';
            runButton.title = canRun || clickNumberingSession ? '' : 'Select exactly one road segment first';
            return;
        }

        runButton.disabled = isRunning || !canRun || Boolean(clickNumberingSession);
        runButton.textContent = isRunning
            ? 'Working…'
            : (workflow === 'area' ? 'Draw area and add HNs' : 'Draw line and add HNs');
        runButton.title = clickNumberingSession
            ? 'Stop click mode first'
            : (canRun ? '' : 'Select exactly one road segment first');
    }

    function getHouseNumbersApi(sdk) {
        if (sdk?.DataModel?.HouseNumbers && typeof sdk.DataModel.HouseNumbers.addHouseNumber === 'function') {
            return sdk.DataModel.HouseNumbers;
        }
        if (sdk?.HouseNumbers && typeof sdk.HouseNumbers.addHouseNumber === 'function') {
            return sdk.HouseNumbers;
        }
        return null;
    }

    async function runSuperHouseNumbers(sdk) {
        if (isRunning) {
            return;
        }

        const settings = getUiSettings();
        if (settings.workflow === 'click') {
            if (clickNumberingSession) {
                stopClickNumberingMode(sdk, 'Exited click-numbering mode.');
                return;
            }
            startClickNumberingMode(sdk, settings);
            return;
        }

        if (clickNumberingSession) {
            updateStatus('Stop click mode first.', 'error');
            refreshRunButtonState(sdk);
            return;
        }

        const selectedSegmentId = getSelectedSegmentId(sdk);
        if (selectedSegmentId === null) {
            updateStatus('Select exactly one road segment first, then run.', 'error');
            refreshRunButtonState(sdk);
            return;
        }

        if (!sdk.Editing.isEditingAllowed()) {
            updateStatus('Editing is currently disabled in WME.', 'error');
            return;
        }

        const houseNumbersApi = getHouseNumbersApi(sdk);
        if (!houseNumbersApi) {
            console.error('[WME Super House Numbers] HouseNumbers API is unavailable on SDK instance');
            updateStatus('House number API is unavailable in this WME version.', 'error');
            return;
        }

        const roadSegmentCandidates = getRoadSegmentCandidates(sdk, selectedSegmentId);
        if (roadSegmentCandidates.length < 1) {
            updateStatus('Could not resolve strict same-road segments for selected segment.', 'error');
            return;
        }

        isRunning = true;
        setRunButtonBusy(true);

        try {
            const numbers = buildNumbersForNonClickWorkflow(settings);
            if (!numbers.length) {
                updateStatus('No numbers to place. Check Start # / End # format and range.', 'error');
                return;
            }

            let points = [];
            if (settings.workflow === 'area') {
                updateStatus('Draw an area over the addresses.');
                const areaGeometry = await drawAreaGeometry(sdk);
                const outerRing = extractAreaOuterRing(areaGeometry);
                points = getPointsInAreaGrid(outerRing, numbers.length);
            } else {
                updateStatus('Draw a line across the buildings/addresses.');
                const line = await sdk.Map.drawLine();
                points = getPointsAlongLine(line?.coordinates, numbers.length);
            }

            if (!points.length) {
                updateStatus('Could not read a valid shape. Try again.', 'error');
                return;
            }

            const normalizedPoints = pickEvenlySpacedCandidates(points, numbers.length);
            const placementCount = Math.min(numbers.length, normalizedPoints.length);

            for (let index = 0; index < placementCount; index += 1) {
                const [lon, lat] = normalizedPoints[index];
                const segmentId = getNearestSameRoadSegmentId([lon, lat], roadSegmentCandidates, selectedSegmentId);
                houseNumbersApi.addHouseNumber({
                    number: String(numbers[index]),
                    segmentId,
                    point: {
                        type: 'Point',
                        coordinates: [lon, lat],
                    },
                });
            }

            if (placementCount > 0) {
                const lastPlacedNumber = numbers[Math.max(0, placementCount - 1)];
                const parsedLastPlaced = parseHouseNumberValue(lastPlacedNumber);
                if (parsedLastPlaced?.kind === 'numeric') {
                    const suggestedStart = getSuggestedNextStartNumber(parsedLastPlaced.base, settings.mode, settings.skip13, settings.incrementStep);
                    setStartInputValue(suggestedStart);
                    updateStartFromRoadMax(sdk);
                } else if (parsedLastPlaced?.kind === 'alpha') {
                    const nextAlphaValue = getNextSequenceValue(parsedLastPlaced, settings.mode, settings.skip13, settings.incrementStep);
                    const nextAlphaText = formatHouseNumberValue(nextAlphaValue);
                    const startInput = panelElement?.querySelector(`#${UI_IDS.start}`);
                    if (startInput && nextAlphaText) {
                        startInput.value = nextAlphaText;
                        saveUiSettings(getUiSettings());
                    }
                }
            }

            updateStatus(`Added ${placementCount} house numbers. Check and adjust as needed.`, 'success');
        } catch (error) {
            if (error && typeof error === 'object' && 'message' in error && String(error.message).toLowerCase().includes('cancel')) {
                updateStatus('Drawing canceled.');
                return;
            }
            console.error('[WME Super House Numbers] Failed to add house numbers', error);
            updateStatus('Failed to add house numbers. See console error.', 'error');
        } finally {
            isRunning = false;
            setRunButtonBusy(false);
            refreshRunButtonState(sdk);
        }
    }

    function renderPanel(sdk) {
        if (!panelElement) {
            return;
        }

        panelElement.innerHTML = `
			<div id="${UI_IDS.header}" style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;cursor:move;user-select:none;">
				<strong>Super HN Numbering Tool</strong>
                <div style="display:flex;align-items:center;gap:6px;">
                    <button id="${UI_IDS.collapse}" type="button" style="border:1px solid var(--separator_default, rgba(0,0,0,0.25));background:var(--surface_default, #fff);color:var(--content_p1, #202124);border-radius:4px;width:24px;height:24px;line-height:1;padding:0;cursor:pointer;">▾</button>
                    <button id="${UI_IDS.close}" type="button" title="Close panel" style="border:1px solid var(--separator_default, rgba(0,0,0,0.25));background:var(--surface_default, #fff);color:var(--content_p1, #202124);border-radius:4px;width:24px;height:24px;line-height:1;padding:0;cursor:pointer;">✕</button>
                </div>
			</div>
			<div id="${UI_IDS.body}">
                <div style="margin-bottom:8px;">
                    <label>Tool location
                        <select id="${UI_IDS.toolLocation}" style="width:100%;">
                            <option value="overlay">Overlay</option>
                            <option value="sidebar">Sidebar</option>
                        </select>
                    </label>
                </div>
                <div style="margin-bottom:8px;">
                    <label>Workflow
                        <select id="${UI_IDS.workflow}" style="width:100%;">
                            <option value="line">Draw line</option>
                            <option value="area">Area drawing (super experimental - read tip)</option>
                            <option value="click">Click to add</option>
                        </select>
                    </label>
                </div>
				<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
                    <label>Start #<input id="${UI_IDS.start}" type="text" value="1" style="width:100%;" /></label>
                    <label id="${UI_IDS.endWrap}">End #<input id="${UI_IDS.end}" type="text" value="10" style="width:100%;" /></label>
				</div>
				<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;align-items:end;">
					<label>Mode
						<select id="${UI_IDS.mode}" style="width:100%;">
							<option value="all">All</option>
							<option value="odd">Odd</option>
							<option value="even">Even</option>
                            <option value="increment">Increment</option>
						</select>
					</label>
					<label><input id="${UI_IDS.skip13}" type="checkbox" /> Skip 13</label>
				</div>
                <div id="${UI_IDS.incrementWrap}" style="margin-bottom:8px;display:none;">
                    <label>Increment
                        <input id="${UI_IDS.increment}" type="number" value="1" step="1" style="width:100%;" />
                    </label>
                </div>
				<button id="${UI_IDS.run}" type="button">Draw line and add HNs</button>
                <div id="${UI_IDS.status}" style="margin-top:8px;opacity:0.85;">Ready.</div>
                <div id="${UI_IDS.tip}" style="margin-top:8px;opacity:0.75;font-size:11px;white-space:pre-line;">Tip: End # is inclusive
for all workflows/modes.</div>
			</div>
		`;

        const runButton = panelElement.querySelector(`#${UI_IDS.run}`);
        if (runButton) {
            runButton.addEventListener('click', () => {
                runSuperHouseNumbers(sdk);
            });
        }

        const savedSettings = loadSavedUiSettings();
        const toolLocationSelect = panelElement.querySelector(`#${UI_IDS.toolLocation}`);
        const workflowSelect = panelElement.querySelector(`#${UI_IDS.workflow}`);
        const startInput = panelElement.querySelector(`#${UI_IDS.start}`);
        const endInput = panelElement.querySelector(`#${UI_IDS.end}`);
        const modeSelect = panelElement.querySelector(`#${UI_IDS.mode}`);
        const incrementInput = panelElement.querySelector(`#${UI_IDS.increment}`);
        const skip13Input = panelElement.querySelector(`#${UI_IDS.skip13}`);

        if (toolLocationSelect) {
            toolLocationSelect.value = savedSettings.toolLocation;
        }
        if (workflowSelect) {
            workflowSelect.value = savedSettings.workflow;
        }
        if (startInput) {
            startInput.value = String(savedSettings.startNumber);
        }
        if (endInput) {
            endInput.value = String(savedSettings.endNumber);
        }
        if (modeSelect) {
            modeSelect.value = savedSettings.mode;
        }
        if (incrementInput) {
            incrementInput.value = String(savedSettings.incrementStep);
        }
        if (skip13Input) {
            skip13Input.checked = savedSettings.skip13;
        }
        if (toolLocationSelect) {
            toolLocationSelect.addEventListener('change', () => {
                saveUiSettings(getUiSettings());
                if (getUiSettings().toolLocation === 'sidebar') {
                    startSidebarScannerMountWatcher(sdk);
                }
                applyToolLocation(sdk);
            });
        }

        if (workflowSelect) {
            workflowSelect.addEventListener('change', () => {
                saveUiSettings(getUiSettings());
                refreshTipMessage();
                refreshEndNumberControl();
                refreshIncrementControl();
                if (clickNumberingSession && getWorkflowMode() !== 'click') {
                    stopClickNumberingMode(sdk, 'Exited click-numbering mode.');
                } else {
                    refreshRunButtonState(sdk);
                }
            });
        }

        const persistOnChange = () => {
            saveUiSettings(getUiSettings());
        };

        startInput?.addEventListener('change', () => {
            persistOnChange();
            applyManualStartToActiveClickSession();
        });
        endInput?.addEventListener('change', persistOnChange);
        modeSelect?.addEventListener('change', persistOnChange);
        incrementInput?.addEventListener('change', () => {
            normalizeIncrementInputValue();
            persistOnChange();
        });
        skip13Input?.addEventListener('change', () => {
            persistOnChange();
            applySkip13ToActiveClickSession(Boolean(skip13Input?.checked));
        });
        modeSelect?.addEventListener('change', () => {
            refreshIncrementControl();
            updateStartFromRoadMax(sdk);
        });
        incrementInput?.addEventListener('change', () => {
            updateStartFromRoadMax(sdk);
        });
        skip13Input?.addEventListener('change', () => {
            updateStartFromRoadMax(sdk);
        });

        initOverlayInteractions(sdk);
        setPanelCollapsed(isCollapsed);

        refreshTipMessage();
        refreshEndNumberControl();
        refreshIncrementControl();
        applyToolLocation(sdk);
        refreshRunButtonState(sdk);
    }

    function initMapOverlayPanel(sdk) {
        try {
            const existingPanel = document.getElementById(OVERLAY_PANEL_ID);
            if (existingPanel) {
                existingPanel.remove();
            }
            const existingLauncher = document.getElementById(OVERLAY_LAUNCHER_ID);
            if (existingLauncher) {
                existingLauncher.remove();
            }

            const mapViewport = sdk.Map.getMapViewportElement();
            if (!mapViewport) {
                throw new Error('Map viewport element is unavailable');
            }

            panelElement = document.createElement('div');
            panelElement.id = OVERLAY_PANEL_ID;
            panelElement.style.position = 'absolute';
            panelElement.style.top = '12px';
            panelElement.style.right = '12px';
            panelElement.style.zIndex = '999';
            panelElement.style.background = 'var(--background_default, rgba(255, 255, 255, 0.96))';
            panelElement.style.color = 'var(--content_p1, #202124)';
            panelElement.style.border = '1px solid var(--separator_default, rgba(0, 0, 0, 0.2))';
            panelElement.style.borderRadius = '6px';
            panelElement.style.boxShadow = '0 1px 4px var(--always_dark_inactive, rgba(0, 0, 0, 0.2))';
            panelElement.style.padding = '10px';
            panelElement.style.width = '300px';
            panelElement.style.maxWidth = 'calc(100% - 24px)';
            panelElement.style.pointerEvents = 'auto';
            mapViewport.appendChild(panelElement);

            launcherElement = document.createElement('button');
            launcherElement.id = OVERLAY_LAUNCHER_ID;
            launcherElement.type = 'button';
            launcherElement.textContent = 'Super HN';
            launcherElement.style.position = 'absolute';
            launcherElement.style.top = '12px';
            launcherElement.style.left = 'auto';
            launcherElement.style.right = '12px';
            launcherElement.style.zIndex = '999';
            launcherElement.style.display = 'none';
            launcherElement.style.border = '1px solid var(--separator_default, rgba(0, 0, 0, 0.2))';
            launcherElement.style.borderRadius = '6px';
            launcherElement.style.background = 'var(--background_default, rgba(255, 255, 255, 0.96))';
            launcherElement.style.color = 'var(--content_p1, #202124)';
            launcherElement.style.padding = '6px 10px';
            launcherElement.style.cursor = 'pointer';
            launcherElement.style.pointerEvents = 'auto';
            mapViewport.appendChild(launcherElement);

            launcherElement.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                isPanelClosed = false;
                refreshOverlayVisibility();
                persistOverlayState(sdk);
            });

            renderPanel(sdk);
            startSidebarScannerMountWatcher(sdk);

            const overlayState = loadOverlayState();
            isCollapsed = overlayState.collapsed;
            isPanelClosed = overlayState.closed;
            if (!isToolsInSidebarMode()) {
                applyOverlayPosition(panelElement, overlayState);
            }
            refreshOverlayVisibility();

            sdk.Events.on({
                eventName: 'wme-selection-changed',
                eventHandler: () => {
                    keepClickSessionSegmentSelected(sdk);
                    const selectedRoadKey = getSelectedRoadKey(sdk);
                    if (selectedRoadKey && lastSelectedRoadKey && selectedRoadKey !== lastSelectedRoadKey) {
                        resetStartForRoadChange(sdk);
                    } else {
                        updateStartFromRoadMax(sdk);
                    }
                    lastSelectedRoadKey = selectedRoadKey;
                    refreshRunButtonState(sdk);
                },
            });

            sdk.Events.on({
                eventName: 'wme-map-mouse-click',
                eventHandler: (event) => {
                    handleMapClickInNumberingMode(sdk, event);
                },
            });

            sdk.Events.on({
                eventName: 'wme-map-mouse-move',
                eventHandler: (event) => {
                    if (Number.isFinite(event?.lon) && Number.isFinite(event?.lat)) {
                        lastMapMouseLonLat = [event.lon, event.lat];
                    }
                },
            });

            const blockNativeShiftZoom = (event) => {
                if (!shouldInterceptShiftFinishEvent(event)) {
                    return;
                }

                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation?.();
            };

            mapViewport.addEventListener('pointerdown', blockNativeShiftZoom, true);
            mapViewport.addEventListener('pointerup', blockNativeShiftZoom, true);
            mapViewport.addEventListener('mousedown', blockNativeShiftZoom, true);
            mapViewport.addEventListener('mouseup', blockNativeShiftZoom, true);
            mapViewport.addEventListener('dblclick', blockNativeShiftZoom, true);

            mapViewport.addEventListener('pointerdown', rememberCtrlClickModifierFromDomEvent, true);
            mapViewport.addEventListener('mousedown', rememberCtrlClickModifierFromDomEvent, true);

            mapViewport.addEventListener('click', (event) => {
                if (!shouldInterceptShiftFinishEvent(event)) {
                    return;
                }

                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation?.();

                const lonLat = extractLonLatFromClientPoint(sdk, event.clientX, event.clientY);
                const resolvedLonLat = lonLat || lastMapMouseLonLat;
                if (!resolvedLonLat) {
                    updateStatus('Could not resolve click location. Try again.', 'error');
                    return;
                }

                const segmentId = getNearestSameRoadSegmentId(
                    resolvedLonLat,
                    clickNumberingSession.roadSegmentCandidates,
                    clickNumberingSession.selectedSegmentId,
                );

                const numberToAdd = formatHouseNumberValue(clickNumberingSession.currentValue);
                clickNumberingSession.houseNumbersApi.addHouseNumber({
                    number: String(numberToAdd),
                    segmentId,
                    point: {
                        type: 'Point',
                        coordinates: [resolvedLonLat[0], resolvedLonLat[1]],
                    },
                });

                stopClickNumberingMode(sdk, `Done: Added #${numberToAdd}. Click-numbering finished.`, 'success');
            }, true);

            window.addEventListener('keydown', (event) => {
                setCtrlModifierHeld(Boolean(event.ctrlKey || event.metaKey));
                setAltModifierHeld(Boolean(event.altKey));

                if (event.key === 'Escape' && clickNumberingSession) {
                    event.preventDefault();
                    event.stopPropagation();
                    stopClickNumberingMode(sdk, 'Exited click-numbering mode.');
                }
            });

            window.addEventListener('keyup', (event) => {
                setCtrlModifierHeld(Boolean(event.ctrlKey || event.metaKey));
                setAltModifierHeld(Boolean(event.altKey));
            });

            window.addEventListener('blur', () => {
                setCtrlModifierHeld(false);
                setAltModifierHeld(false);
            });
        } catch (error) {
            console.error('[WME Super House Numbers] Failed to initialize map overlay', error);
        }
    }

    function initScript() {
        const sdk = window.getWmeSdk({
            scriptId: SCRIPT_ID,
            scriptName: SCRIPT_NAME,
        });

        sdk.Events.once({ eventName: 'wme-ready' }).then(() => {
            initMapOverlayPanel(sdk);
        });
    }

    function waitForSdkAndInit() {
        if (window.SDK_INITIALIZED && typeof window.SDK_INITIALIZED.then === 'function') {
            window.SDK_INITIALIZED.then(initScript);
        } else {
            console.error('[WME Super House Numbers] SDK_INITIALIZED is unavailable');
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', waitForSdkAndInit, { once: true });
    } else {
        waitForSdkAndInit();
    }
})();

