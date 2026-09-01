/**
 * Universal, idempotent page-world API monitor.
 * Captures user interactions and associates nearby XHR/fetch/beacon/WebSocket/form activity.
 */
(function () {
    'use strict';

    const INSTALL_KEY = '__ADB_AUTO_API_MONITOR_V2__';
    if (window[INSTALL_KEY]) return;

    const state = {
        enabled: true,
        interactionWindowMs: 4000,
        responseLimit: 100000,
        sequence: 0,
        lastInteraction: null,
        bridgeToken: null,
        storageSnapshotEmitted: false
    };
    window[INSTALL_KEY] = state;

    function post(type, data) {
        if (!state.enabled) return;
        window.postMessage({
            source: 'antidebug-auto-api-monitor',
            type,
            data,
            bridgeToken: state.bridgeToken
        }, '*');
    }

    function cssEscape(value) {
        if (window.CSS?.escape) return window.CSS.escape(value);
        return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
    }

    function selectorFor(element) {
        if (!(element instanceof Element)) return '';
        if (element.id) return `#${cssEscape(element.id)}`;
        const parts = [];
        let current = element;
        while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
            let part = current.tagName.toLowerCase();
            const stableClass = [...current.classList].find(name => name && !/^(active|selected|hover|focus|open|show)$/i.test(name));
            if (stableClass) part += `.${cssEscape(stableClass)}`;
            const parent = current.parentElement;
            if (parent) {
                const siblings = [...parent.children].filter(child => child.tagName === current.tagName);
                if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
            }
            parts.unshift(part);
            current = parent;
        }
        return parts.join(' > ');
    }

    function sanitizeText(value, limit = 160) {
        return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, limit);
    }

    function startInteraction(event) {
        if (!state.enabled) return;
        const target = event.target instanceof Element ? event.target.closest('button,a,input,[role="button"],[onclick],select,textarea') || event.target : null;
        if (!target) return;
        const now = Date.now();
        state.lastInteraction = {
            id: `ui_${now}_${++state.sequence}`,
            timestamp: now,
            type: event.type,
            selector: selectorFor(target),
            tag: target.tagName?.toLowerCase() || '',
            text: sanitizeText(target.innerText || target.value || target.getAttribute?.('aria-label') || target.title),
            pageUrl: location.href
        };
        post('ADB_INTERACTION', state.lastInteraction);
    }

    function currentInteraction() {
        const interaction = state.lastInteraction;
        if (!interaction) return null;
        return Date.now() - interaction.timestamp <= state.interactionWindowMs ? interaction : null;
    }

    function headersToObject(headers) {
        if (!headers) return {};
        if (headers instanceof Headers) return Object.fromEntries(headers.entries());
        if (Array.isArray(headers)) return Object.fromEntries(headers);
        return { ...headers };
    }

    function previewBody(body) {
        if (body == null) return null;
        if (typeof body === 'string') return body.slice(0, 4000);
        if (body instanceof URLSearchParams) return body.toString().slice(0, 4000);
        if (body instanceof FormData) {
            const result = {};
            for (const [key, value] of body.entries()) {
                result[key] = typeof value === 'string' ? value.slice(0, 500) : `[File:${value.name || 'blob'}]`;
            }
            return JSON.stringify(result).slice(0, 4000);
        }
        if (body instanceof Blob) return `[Blob:${body.type || 'unknown'}:${body.size}]`;
        if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return `[Binary:${body.byteLength || body.length || 0}]`;
        return sanitizeText(body, 4000);
    }

    function baseCapture(transport, method, rawUrl, body, headers) {
        const interaction = currentInteraction();
        let resolvedUrl = String(rawUrl || '');
        try { resolvedUrl = new URL(resolvedUrl, location.href).href; } catch (_) {}
        return {
            captureId: `req_${Date.now()}_${++state.sequence}`,
            interactionId: interaction?.id || null,
            interaction,
            transport,
            method: String(method || 'GET').toUpperCase(),
            rawUrl: String(rawUrl || ''),
            url: resolvedUrl,
            headers: headersToObject(headers),
            bodyPreview: previewBody(body),
            pageUrl: location.href,
            frameUrl: location.href,
            startedAt: Date.now(),
            stack: new Error().stack?.split('\n').slice(2, 10).join('\n') || ''
        };
    }

    document.addEventListener('pointerdown', startInteraction, true);
    document.addEventListener('click', startInteraction, true);
    document.addEventListener('submit', startInteraction, true);

    window.addEventListener('message', event => {
        if (event.source !== window || event.data?.source !== 'antidebug-extension') return;
        if (event.data.type === 'ADB_MONITOR_CONFIG') {
            const config = event.data.config || {};
            if (typeof event.data.bridgeToken === 'string') state.bridgeToken = event.data.bridgeToken;
            if (typeof config.enabled === 'boolean') state.enabled = config.enabled;
            if (Number.isFinite(config.interactionWindowMs)) state.interactionWindowMs = Math.max(500, Math.min(15000, config.interactionWindowMs));
            if (Number.isFinite(config.responseLimit)) state.responseLimit = Math.max(10000, Math.min(500000, config.responseLimit));
            setTimeout(emitInitialStorageSnapshot, 0);
        }
    });

    // 记录运行时配置的来源。这里只观察字符串边界，不修改页面实际存储值。
    const originalStorageSetItem = Storage.prototype.setItem;
    const originalStorageGetItem = Storage.prototype.getItem;
    const storageKeyHint = /(?:api|base|url|uri|host|origin|endpoint|gateway|route|path|service|config|env)/i;
    const storageValueHint = /https?:\/\/|\/(?:api|meta|rest|openapi|graphql|rpc|gateway|service|auth|login|oauth|sso|v\d+)(?:\/|[?#]|$)/i;
    const isRelevantStorageValue = (key, value) => value != null && (
        storageKeyHint.test(String(key || '')) ||
        storageValueHint.test(String(value || ''))
    );

    function emitStorageSnapshot(storageArea, storageName) {
        let emitted = 0;
        try {
            for (let index = 0; index < storageArea.length && emitted < 1000; index += 1) {
                const key = storageArea.key(index);
                const value = key == null ? null : originalStorageGetItem.call(storageArea, key);
                if (!isRelevantStorageValue(key, value)) continue;
                post('ADB_STORAGE_TRACE', {
                    operation: 'snapshot',
                    storage: storageName,
                    key: String(key),
                    value: String(value).slice(0, 50000),
                    pageUrl: location.href,
                    capturedAt: Date.now(),
                    stack: ''
                });
                emitted += 1;
            }
        } catch (_) {}
    }

    function emitInitialStorageSnapshot() {
        if (!state.enabled || !state.bridgeToken || state.storageSnapshotEmitted) return;
        state.storageSnapshotEmitted = true;
        emitStorageSnapshot(localStorage, 'localStorage');
        emitStorageSnapshot(sessionStorage, 'sessionStorage');
    }

    Storage.prototype.setItem = function (key, value) {
        const result = originalStorageSetItem.apply(this, arguments);
        let storage = 'storage';
        try { storage = this === localStorage ? 'localStorage' : this === sessionStorage ? 'sessionStorage' : storage; } catch (_) {}
        if (isRelevantStorageValue(key, value)) {
            post('ADB_STORAGE_TRACE', {
                operation: 'set',
                storage,
                key: String(key),
                value: String(value).slice(0, 50000),
                pageUrl: location.href,
                capturedAt: Date.now(),
                stack: new Error().stack?.split('\n').slice(2, 9).join('\n') || ''
            });
        }
        return result;
    };
    Storage.prototype.getItem = function (key) {
        const value = originalStorageGetItem.apply(this, arguments);
        let storage = 'storage';
        try { storage = this === localStorage ? 'localStorage' : this === sessionStorage ? 'sessionStorage' : storage; } catch (_) {}
        if (isRelevantStorageValue(key, value)) {
            post('ADB_STORAGE_TRACE', {
                operation: 'get',
                storage,
                key: String(key),
                value: String(value).slice(0, 50000),
                pageUrl: location.href,
                capturedAt: Date.now(),
                stack: new Error().stack?.split('\n').slice(2, 9).join('\n') || ''
            });
        }
        return value;
    };

    // Hook 安装前已经存在的运行时配置也必须参与接口重组。
    setTimeout(emitInitialStorageSnapshot, 0);

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function (method, url) {
        this.__adbCapture = baseCapture('xhr', method, url, null, {});
        return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        if (this.__adbCapture) this.__adbCapture.headers[name] = String(value);
        return originalSetRequestHeader.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function (body) {
        const capture = this.__adbCapture;
        if (capture && state.enabled) {
            capture.bodyPreview = previewBody(body);
            this.addEventListener('loadend', function () {
                capture.status = this.status;
                capture.statusText = this.statusText;
                capture.responseUrl = this.responseURL || capture.url;
                capture.responseHeaders = this.getAllResponseHeaders?.() || '';
                capture.contentType = this.getResponseHeader?.('content-type') || '';
                try {
                    if (!this.responseType || this.responseType === 'text') {
                        capture.responsePreview = String(this.responseText || '').slice(0, state.responseLimit);
                    } else if (this.responseType === 'json') {
                        capture.responsePreview = JSON.stringify(this.response).slice(0, state.responseLimit);
                    } else {
                        capture.responsePreview = `[${this.responseType || 'binary'} response]`;
                    }
                } catch (_) {
                    capture.responsePreview = '[unavailable response]';
                }
                capture.completedAt = Date.now();
                capture.duration = capture.completedAt - capture.startedAt;
                post('ADB_API_CAPTURE', capture);
            }, { once: true });
        }
        return originalSend.apply(this, arguments);
    };

    const originalFetch = window.fetch;
    window.fetch = async function (input, init) {
        const request = input instanceof Request ? input : null;
        const capture = baseCapture(
            'fetch',
            init?.method || request?.method || 'GET',
            request?.url || input,
            init?.body,
            init?.headers || request?.headers
        );
        try {
            const response = await originalFetch.apply(this, arguments);
            capture.status = response.status;
            capture.statusText = response.statusText;
            capture.responseUrl = response.url || capture.url;
            capture.responseHeaders = Object.fromEntries(response.headers.entries());
            capture.contentType = response.headers.get('content-type') || '';
            try {
                capture.responsePreview = (await response.clone().text()).slice(0, state.responseLimit);
            } catch (_) {
                capture.responsePreview = '[unavailable response]';
            }
            capture.completedAt = Date.now();
            capture.duration = capture.completedAt - capture.startedAt;
            post('ADB_API_CAPTURE', capture);
            return response;
        } catch (error) {
            capture.error = error?.message || String(error);
            capture.completedAt = Date.now();
            capture.duration = capture.completedAt - capture.startedAt;
            post('ADB_API_CAPTURE', capture);
            throw error;
        }
    };
    try {
        Object.defineProperty(window.fetch, 'name', { value: originalFetch.name });
        window.fetch.toString = () => originalFetch.toString();
    } catch (_) {}

    if (navigator.sendBeacon) {
        const originalBeacon = navigator.sendBeacon.bind(navigator);
        navigator.sendBeacon = function (url, data) {
            const capture = baseCapture('beacon', 'POST', url, data, {});
            const result = originalBeacon(url, data);
            capture.status = result ? 202 : 0;
            capture.completedAt = Date.now();
            capture.duration = capture.completedAt - capture.startedAt;
            post('ADB_API_CAPTURE', capture);
            return result;
        };
    }

    const OriginalWebSocket = window.WebSocket;
    if (OriginalWebSocket) {
        function MonitoredWebSocket(url, protocols) {
            const capture = baseCapture('websocket', 'CONNECT', url, null, {});
            const socket = protocols === undefined ? new OriginalWebSocket(url) : new OriginalWebSocket(url, protocols);
            const originalSend = socket.send;
            socket.send = function (data) {
                const frame = baseCapture('websocket-frame', 'SEND', socket.url || url, data, {});
                frame.direction = 'outbound';
                frame.frameType = data instanceof ArrayBuffer || ArrayBuffer.isView(data) ? 'binary' : data instanceof Blob ? 'blob' : 'text';
                frame.completedAt = Date.now();
                post('ADB_API_CAPTURE', frame);
                return originalSend.apply(this, arguments);
            };
            socket.addEventListener('message', event => {
                const frame = baseCapture('websocket-frame', 'RECEIVE', socket.url || url, event.data, {});
                frame.direction = 'inbound';
                frame.frameType = event.data instanceof ArrayBuffer || ArrayBuffer.isView(event.data) ? 'binary' : event.data instanceof Blob ? 'blob' : 'text';
                frame.completedAt = Date.now();
                post('ADB_API_CAPTURE', frame);
            });
            socket.addEventListener('open', () => {
                capture.status = 101;
                capture.completedAt = Date.now();
                capture.duration = capture.completedAt - capture.startedAt;
                post('ADB_API_CAPTURE', capture);
            }, { once: true });
            return socket;
        }
        MonitoredWebSocket.prototype = OriginalWebSocket.prototype;
        Object.setPrototypeOf(MonitoredWebSocket, OriginalWebSocket);
        window.WebSocket = MonitoredWebSocket;
    }

    document.addEventListener('submit', event => {
        const form = event.target;
        if (!(form instanceof HTMLFormElement)) return;
        const capture = baseCapture('form', form.method || 'GET', form.action || location.href, new FormData(form), {});
        capture.status = null;
        capture.completedAt = Date.now();
        post('ADB_API_CAPTURE', capture);
    }, true);

    post('ADB_MONITOR_READY', { pageUrl: location.href, installedAt: Date.now() });
})();
