// Local ambient declarations for WME runtime globals.
// These are injected by the Waze Map Editor at runtime and have no official typings.

interface Window {
    /** Legacy WME internal object. Contains .map (native OpenLayers map), .model, etc. */
    W?: any;
    /** OpenLayers 2 library injected by WME. */
    OpenLayers?: any;
    /** OpenLayers 3+ (ol) library injected by WME. */
    ol?: any;
    /** WME native map reference sometimes available directly on window. */
    map?: any;
}
