// Firefox exposes callback-style APIs through `chrome` and Promise-style APIs
// through `browser`. The extension contains both styles, so route only calls
// without a callback to the Promise namespace while preserving existing Chrome
// callback behavior.
(function installFirefoxPromiseCompatibility() {
    if (typeof globalThis.browser === 'undefined' || typeof globalThis.chrome === 'undefined') return;
    if (globalThis.__ANTIDEBUG_FIREFOX_COMPAT__) return;

    const callbackApi = globalThis.chrome;
    const promiseApi = globalThis.browser;
    const methodGroups = {
        'storage.local': ['get', 'set', 'remove', 'clear', 'getBytesInUse', 'setAccessLevel'],
        'storage.sync': ['get', 'set', 'remove', 'clear', 'getBytesInUse', 'setAccessLevel'],
        'storage.session': ['get', 'set', 'remove', 'clear', 'getBytesInUse', 'setAccessLevel'],
        runtime: ['sendMessage', 'openOptionsPage', 'getPlatformInfo', 'getBrowserInfo'],
        tabs: ['query', 'get', 'create', 'update', 'reload', 'remove', 'sendMessage', 'captureVisibleTab'],
        scripting: [
            'executeScript', 'insertCSS', 'removeCSS', 'registerContentScripts',
            'unregisterContentScripts', 'updateContentScripts', 'getRegisteredContentScripts'
        ],
        cookies: ['get', 'getAll', 'set', 'remove'],
        declarativeNetRequest: [
            'getSessionRules', 'updateSessionRules', 'getDynamicRules', 'updateDynamicRules',
            'getEnabledRulesets', 'updateEnabledRulesets', 'getMatchedRules'
        ],
        permissions: ['contains', 'request', 'remove']
    };

    function resolve(root, path) {
        return path.split('.').reduce((value, key) => value && value[key], root);
    }

    for (const [namespacePath, methods] of Object.entries(methodGroups)) {
        const callbackNamespace = resolve(callbackApi, namespacePath);
        const promiseNamespace = resolve(promiseApi, namespacePath);
        if (!callbackNamespace || !promiseNamespace) continue;

        for (const methodName of methods) {
            const callbackMethod = callbackNamespace[methodName];
            const promiseMethod = promiseNamespace[methodName];
            if (typeof callbackMethod !== 'function' || typeof promiseMethod !== 'function') continue;

            try {
                callbackNamespace[methodName] = function (...args) {
                    const lastArgument = args[args.length - 1];
                    if (typeof lastArgument === 'function') {
                        return callbackMethod.apply(callbackNamespace, args);
                    }
                    return promiseMethod.apply(promiseNamespace, args);
                };
            } catch (_) {
                // Older Firefox builds can expose non-writable namespace members.
                // The Firefox manifest requires 128+, where the MV3 Promise surface
                // used by this project is available directly.
            }
        }
    }

    globalThis.__ANTIDEBUG_FIREFOX_COMPAT__ = true;
    globalThis.__ANTIDEBUG_BROWSER__ = 'firefox';
})();
