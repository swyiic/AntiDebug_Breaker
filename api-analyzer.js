/**
 * Shared API URL normalization and business endpoint analysis.
 * Loaded by the extension service worker before mcp-client.js.
 */
(function (scope) {
    'use strict';

    const API_MARKERS = new Set([
        'api', 'apis', 'rest', 'restapi', 'openapi', 'gateway', 'gw',
        'backend', 'service', 'services', 'graphql', 'rpc'
    ]);
    const ACTION_MARKERS = new Set([
        'list', 'page', 'detail', 'info', 'query', 'search', 'get', 'find',
        'create', 'add', 'save', 'update', 'edit', 'delete', 'remove',
        'submit', 'upload', 'download', 'export', 'import', 'login', 'logout',
        'refresh', 'verify', 'check', 'enable', 'disable'
    ]);

    function safeUrl(rawUrl, pageUrl) {
        try {
            return new URL(rawUrl, pageUrl || 'http://localhost/');
        } catch (_) {
            return null;
        }
    }

    function isVersionSegment(segment) {
        return /^v\d+(?:\.\d+)*$/i.test(segment) || /^version\d+$/i.test(segment);
    }

    function isIdentifierSegment(segment) {
        return /^\d+$/.test(segment) ||
            /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment) ||
            /^[0-9a-f]{16,}$/i.test(segment) ||
            /^[A-Za-z0-9_-]{24,}$/.test(segment);
    }

    function normalizePath(pathname) {
        const segments = pathname.split('/').filter(Boolean);
        if (segments.length === 0) return '/';
        return '/' + segments.map(segment => {
            if (isIdentifierSegment(segment)) return '{id}';
            return segment;
        }).join('/');
    }

    function inferSplit(pathname) {
        const segments = pathname.split('/').filter(Boolean);
        if (segments.length === 0) {
            return { apiPrefix: '/', businessEndpoint: '/', splitReason: 'root' };
        }

        let splitIndex = -1;
        let reason = 'full-path';
        for (let index = 0; index < segments.length; index += 1) {
            const current = segments[index].toLowerCase();
            if (API_MARKERS.has(current)) {
                splitIndex = index;
                reason = `marker:${current}`;
                let cursor = index + 1;
                while (cursor < segments.length) {
                    const next = segments[cursor].toLowerCase();
                    if (API_MARKERS.has(next) || isVersionSegment(segments[cursor])) {
                        splitIndex = cursor;
                        cursor += 1;
                    } else {
                        break;
                    }
                }
                break;
            }
        }

        if (splitIndex < 0) {
            const versionIndex = segments.findIndex(isVersionSegment);
            if (versionIndex >= 0 && versionIndex <= 2) {
                splitIndex = versionIndex;
                reason = `version:${segments[versionIndex]}`;
            }
        }

        if (splitIndex < 0 && segments.length >= 3 && /(?:service|server|gateway)$/i.test(segments[0])) {
            splitIndex = 0;
            reason = 'service-prefix';
        }

        if (splitIndex < 0) {
            return {
                apiPrefix: '/',
                businessEndpoint: '/' + segments.join('/'),
                splitReason: reason
            };
        }

        const prefixSegments = segments.slice(0, splitIndex + 1);
        const businessSegments = segments.slice(splitIndex + 1);
        return {
            apiPrefix: '/' + prefixSegments.join('/'),
            businessEndpoint: businessSegments.length ? '/' + businessSegments.join('/') : '/',
            splitReason: reason
        };
    }

    function inferBusiness(pathname, method) {
        const segments = pathname.split('/').filter(Boolean);
        const normalized = segments.filter(segment => !API_MARKERS.has(segment.toLowerCase()) && !isVersionSegment(segment));
        const tail = normalized.slice(-3);
        const action = [...tail].reverse().find(segment => ACTION_MARKERS.has(segment.toLowerCase())) ||
            (method === 'GET' ? 'query' : method === 'POST' ? 'submit' : method.toLowerCase());
        const resource = [...tail].reverse().find(segment =>
            !ACTION_MARKERS.has(segment.toLowerCase()) && !isIdentifierSegment(segment)
        ) || 'unknown';
        return { resource, action };
    }

    function bodyPreview(body) {
        if (body == null) return null;
        if (typeof body === 'string') return body.slice(0, 2000);
        if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString().slice(0, 2000);
        if (typeof body === 'object') {
            try {
                return JSON.stringify(body).slice(0, 2000);
            } catch (_) {
                return `[${body.constructor?.name || 'Object'}]`;
            }
        }
        return String(body).slice(0, 2000);
    }

    function parseStructuredBody(preview) {
        if (!preview || typeof preview !== 'string') return null;
        try { return JSON.parse(preview); } catch (_) {}
        try {
            const params = new URLSearchParams(preview);
            if ([...params.keys()].length) return Object.fromEntries(params.entries());
        } catch (_) {}
        return null;
    }

    function collectShape(value, prefix = '', output = [], depth = 0) {
        if (output.length >= 120 || value == null || depth > 4) return output;
        if (Array.isArray(value)) {
            if (value.length) collectShape(value[0], `${prefix}[]`, output, depth + 1);
            return output;
        }
        if (typeof value === 'object') {
            Object.entries(value).slice(0, 80).forEach(([key, item]) => {
                const path = prefix ? `${prefix}.${key}` : key;
                output.push({ path, type: Array.isArray(item) ? 'array' : item === null ? 'null' : typeof item });
                collectShape(item, path, output, depth + 1);
            });
        }
        return output;
    }

    function graphQLDetails(parsedUrl, structuredBody) {
        const query = String(structuredBody?.query || parsedUrl.searchParams.get('query') || '');
        if (!/graphql/i.test(parsedUrl.pathname) && !query) return null;
        const operation = query.match(/\b(query|mutation|subscription)\b\s*([A-Za-z_$][\w$]*)?/);
        const fields = [...query.matchAll(/(?:^|[\s,{])([A-Za-z_$][\w$]*)\s*(?:\([^)]*\))?\s*\{/g)]
            .map(match => match[1]).filter(name => !/^(?:query|mutation|subscription|fragment)$/i.test(name));
        return {
            type: 'graphql',
            operationType: operation?.[1] || (query ? 'anonymous' : 'unknown'),
            operationName: structuredBody?.operationName || operation?.[2] || '',
            fields: [...new Set(fields)].slice(0, 40),
            variableKeys: structuredBody?.variables && typeof structuredBody.variables === 'object' ? Object.keys(structuredBody.variables).slice(0, 80) : []
        };
    }

    function normalizeHeaders(headers) {
        if (!headers) return {};
        if (typeof headers === 'string') {
            return Object.fromEntries(headers.split(/\r?\n/).map(line => {
                const index = line.indexOf(':');
                return index > 0 ? [line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim()] : null;
            }).filter(Boolean));
        }
        return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)]));
    }

    function analyzeResponseSecurity(headers) {
        const normalized = normalizeHeaders(headers);
        if (!Object.keys(normalized).length) return null;
        const allowOrigin = normalized['access-control-allow-origin'] || '';
        const allowCredentials = normalized['access-control-allow-credentials'] || '';
        const issues = [];
        if (allowOrigin === '*' && /^true$/i.test(allowCredentials)) issues.push('CORS 同时允许任意源和凭据');
        if (normalized['x-powered-by']) issues.push(`技术栈暴露：${normalized['x-powered-by']}`);
        if (normalized.server) issues.push(`Server 暴露：${normalized.server}`);
        return {
            cors: {
                allowOrigin,
                allowCredentials,
                allowMethods: normalized['access-control-allow-methods'] || '',
                allowHeaders: normalized['access-control-allow-headers'] || ''
            },
            policies: {
                csp: normalized['content-security-policy'] || '',
                hsts: normalized['strict-transport-security'] || '',
                coop: normalized['cross-origin-opener-policy'] || '',
                coep: normalized['cross-origin-embedder-policy'] || '',
                corp: normalized['cross-origin-resource-policy'] || '',
                nosniff: normalized['x-content-type-options'] || '',
                frameOptions: normalized['x-frame-options'] || ''
            },
            issues
        };
    }

    function analyzeRequest(request, pageUrl) {
        const parsed = safeUrl(request.url || request.rawUrl, pageUrl || request.pageUrl);
        if (!parsed) {
            return {
                ...request,
                rawUrl: request.url || request.rawUrl,
                analysisError: 'invalid-url'
            };
        }

        const method = String(request.method || 'GET').toUpperCase();
        const split = inferSplit(parsed.pathname);
        const normalizedEndpoint = normalizePath(split.businessEndpoint);
        const normalizedPath = normalizePath(parsed.pathname);
        const query = {};
        parsed.searchParams.forEach((value, key) => {
            query[key] = value.length > 200 ? `${value.slice(0, 200)}…` : value;
        });
        const business = inferBusiness(split.businessEndpoint, method);
        const preview = request.bodyPreview || bodyPreview(request.body);
        const structuredBody = parseStructuredBody(preview);
        const protocol = request.transport === 'websocket' || request.transport === 'websocket-frame'
            ? { type: 'websocket', direction: request.direction || '', frameType: request.frameType || '' }
            : graphQLDetails(parsed, structuredBody);

        return {
            ...request,
            method,
            rawUrl: request.rawUrl || request.url,
            url: parsed.href,
            baseUrl: parsed.origin,
            apiPrefix: split.apiPrefix,
            businessEndpoint: split.businessEndpoint,
            normalizedEndpoint,
            normalizedPath,
            path: parsed.pathname,
            query,
            resource: business.resource,
            action: business.action,
            splitReason: split.splitReason,
            bodyPreview: preview,
            requestShape: collectShape(structuredBody),
            protocol,
            responseSecurity: analyzeResponseSecurity(request.responseHeaders),
            capturedAt: request.capturedAt || Date.now()
        };
    }

    function endpointKey(request) {
        // 去重必须使用真实完整路径。businessEndpoint 只是展示标注，不能参与重建真实 URL。
        return `${request.method || 'GET'} ${request.baseUrl || ''}${request.normalizedPath || request.path || request.url || ''}`;
    }

    function commonPrefixSegments(paths) {
        const rows = paths.map(path => String(path || '').split('/').filter(Boolean));
        if (rows.length < 2) return [];
        const limit = Math.min(...rows.map(row => row.length));
        const result = [];
        for (let index = 0; index < limit; index += 1) {
            const value = rows[0][index];
            if (!rows.every(row => row[index] === value)) break;
            result.push(value);
        }
        return result;
    }

    function isConfigPathHint(path) {
        return /(?:^|[.\[])(?:api|base(?:url)?|url|uri|host|origin|endpoint|gateway|route|path|service|config|env)(?:$|[.\]])/i.test(String(path || ''));
    }

    function addConfigEvidence(output, value, path) {
        const normalized = String(value || '').trim().replace(/[),;]+$/, '');
        if (!normalized || normalized.length > 4000) return;
        if (!/^(?:https?:\/\/|\/)/i.test(normalized)) return;
        if (!/^https?:\/\//i.test(normalized) &&
            !/\/(?:api|meta|rest|openapi|graphql|rpc|gateway|service|auth|login|oauth|sso|v\d+)(?:\/|[?#]|$)/i.test(normalized) &&
            !isConfigPathHint(path)) return;
        if (!output.some(item => item.value === normalized && item.path === path)) output.push({ value: normalized, path });
    }

    function flattenConfigValues(value, path = '', output = [], depth = 0) {
        if (output.length >= 1000 || value == null || depth > 8) return output;
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (/^[{[]/.test(trimmed)) {
                try {
                    const parsed = JSON.parse(trimmed);
                    if (parsed && typeof parsed === 'object') flattenConfigValues(parsed, path, output, depth + 1);
                } catch (_) {}
            }
            addConfigEvidence(output, trimmed, path);
            for (const match of trimmed.matchAll(/https?:\/\/[^\s"'`<>\\]{4,4000}/gi)) addConfigEvidence(output, match[0], path);
            for (const match of trimmed.matchAll(/(?<![:/])\/(?:api|meta|rest|openapi|graphql|rpc|gateway|service|auth|login|oauth|sso|v\d+)(?:\/[A-Za-z0-9_?&=.%{}:@+-]+){0,12}/gi)) {
                addConfigEvidence(output, match[0], path);
            }
            return output;
        }
        if (Array.isArray(value)) {
            value.slice(0, 300).forEach((item, index) => flattenConfigValues(item, `${path}[${index}]`, output, depth + 1));
            return output;
        }
        if (typeof value === 'object') {
            Object.entries(value).slice(0, 500).forEach(([key, item]) => flattenConfigValues(item, path ? `${path}.${key}` : key, output, depth + 1));
        }
        return output;
    }

    function collectRuntimeEvidence(requests, storageTraces) {
        const evidence = [];
        for (const trace of storageTraces || []) {
            const value = String(trace.value || '');
            const source = `${trace.storage || 'storage'}.${trace.key || '?'}`;
            for (const item of flattenConfigValues(value, source)) {
                evidence.push({
                    value: item.value,
                    type: 'storage',
                    source: item.path || source,
                    capturedAt: trace.capturedAt || 0,
                    stack: trace.stack || ''
                });
            }
        }
        for (const request of requests || []) {
            if (!request.responsePreview || !/json/i.test(request.contentType || '')) continue;
            try {
                const parsed = JSON.parse(request.responsePreview);
                flattenConfigValues(parsed).forEach(item => evidence.push({
                    value: item.value,
                    type: 'config-response',
                    source: `${request.url} → response.${item.path}`,
                    capturedAt: request.capturedAt || 0
                }));
            } catch (_) {}
        }
        return evidence;
    }

    function buildEndpointIntelligence(requests, storageTraces = [], staticEvidence = {}) {
        const realRequests = dedupeRequests(requests || []).filter(request => request.url && /^https?:/i.test(request.url));
        const runtimeEvidence = collectRuntimeEvidence(realRequests, storageTraces);
        for (const item of [...(staticEvidence.baseUrls || []), ...(staticEvidence.apiPrefixes || [])]) {
            runtimeEvidence.push({
                value: item.value,
                type: 'js-evidence',
                source: `${item.source || 'script'}${item.line ? `:${item.line}` : ''}`,
                capturedAt: 0,
                evidence: item.evidence || ''
            });
        }
        const originGroups = new Map();
        for (const request of realRequests) {
            let parsed;
            try { parsed = new URL(request.url); } catch (_) { continue; }
            if (!originGroups.has(parsed.origin)) originGroups.set(parsed.origin, []);
            originGroups.get(parsed.origin).push({ request, parsed });
        }

        const clients = [];
        const reconstructions = [];
        for (const [origin, rows] of originGroups) {
            const markerGroups = new Map();
            for (const row of rows) {
                const split = inferSplit(row.parsed.pathname);
                const key = split.apiPrefix !== '/' ? split.apiPrefix : '__unclassified__';
                if (!markerGroups.has(key)) markerGroups.set(key, []);
                markerGroups.get(key).push({ ...row, split });
            }

            for (const [marker, groupRows] of markerGroups) {
                const common = commonPrefixSegments(groupRows.map(row => row.parsed.pathname));
                const inferredPrefix = marker !== '__unclassified__'
                    ? marker
                    : (groupRows.length >= 2 && common.length ? `/${common.join('/')}` : '/');
                const prefixSource = marker !== '__unclassified__'
                    ? 'path-marker'
                    : (inferredPrefix !== '/' ? 'multi-request-common-prefix' : 'unconfirmed');
                const matchedEvidence = runtimeEvidence.filter(item => {
                    try {
                        if (/^https?:/i.test(item.value)) return new URL(item.value).origin === origin && (inferredPrefix === '/' || new URL(item.value).pathname.startsWith(inferredPrefix));
                    } catch (_) {}
                    return inferredPrefix !== '/' && (item.value === inferredPrefix || inferredPrefix.startsWith(item.value) || item.value.startsWith(inferredPrefix));
                });
                const clientId = `${origin}${inferredPrefix}`;
                clients.push({
                    id: clientId,
                    origin,
                    apiPrefix: inferredPrefix,
                    requestCount: groupRows.length,
                    confidence: marker !== '__unclassified__' ? 0.96 : (groupRows.length >= 2 && inferredPrefix !== '/' ? 0.78 : 0.35),
                    source: matchedEvidence[0]?.source || prefixSource,
                    evidence: matchedEvidence.slice(0, 8)
                });

                for (const row of groupRows) {
                    const fullPath = row.parsed.pathname;
                    const businessEndpoint = inferredPrefix !== '/' && fullPath.startsWith(inferredPrefix)
                        ? fullPath.slice(inferredPrefix.length) || '/'
                        : row.split.businessEndpoint;
                    reconstructions.push({
                        requestId: row.request.requestId || row.request.captureId,
                        method: row.request.method,
                        url: row.request.url,
                        clientId,
                        origin,
                        apiPrefix: inferredPrefix,
                        businessEndpoint: businessEndpoint.startsWith('/') ? businessEndpoint : `/${businessEndpoint}`,
                        expression: `${origin}${inferredPrefix === '/' ? '' : inferredPrefix}${businessEndpoint === '/' ? '' : businessEndpoint}`,
                        validated: true,
                        confidence: 1,
                        prefixSource,
                        source: row.request.stack || row.request.initiator || row.request.source || 'network'
                    });
                }
            }
        }
        return { clients, reconstructions, runtimeEvidence };
    }

    function dedupeRequests(requests) {
        const byKey = new Map();
        for (const request of requests || []) {
            const key = endpointKey(request);
            const previous = byKey.get(key);
            if (!previous || (request.capturedAt || 0) >= (previous.capturedAt || 0)) {
                byKey.set(key, request);
            }
        }
        return [...byKey.values()].sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0));
    }

    scope.apiAnalyzer = {
        analyzeRequest,
        dedupeRequests,
        endpointKey,
        normalizePath,
        inferSplit,
        flattenConfigValues,
        buildEndpointIntelligence
    };
})(typeof self !== 'undefined' ? self : globalThis);
