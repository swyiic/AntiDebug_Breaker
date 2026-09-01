/**
 * Evidence-driven endpoint discovery.
 *
 * This module never performs a Cartesian product between every origin and every
 * path. A candidate is resolved only when the request call, base URL, runtime
 * request, Storage/config value, or API prefix provides a relationship.
 */
(function (scope) {
    'use strict';

    const API_MARKER = /\/(?:api|apis|meta|rest|openapi|graphql|rpc|gateway|service|auth|login|oauth|sso|admin|internal|v\d+)(?:\/|[?#]|$)/i;
    const STATIC_ASSET = /\.(?:m?js|css|map|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|otf|eot|mp[34]|webm|wav)(?:[?#]|$)/i;
    const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

    function normalizeUrl(value, base) {
        try {
            const parsed = new URL(String(value || ''), base);
            if (!/^https?:$/.test(parsed.protocol)) return null;
            parsed.hash = '';
            return parsed.href;
        } catch (_) { return null; }
    }

    function normalizeBase(value, pageUrl) {
        const url = normalizeUrl(value, pageUrl);
        if (!url) return null;
        try {
            const parsed = new URL(url);
            parsed.search = '';
            parsed.hash = '';
            parsed.pathname = parsed.pathname.replace(/\/$/, '') || '/';
            return parsed.href.replace(/\/$/, parsed.pathname === '/' ? '' : '');
        } catch (_) { return null; }
    }

    function normalizePath(value) {
        const raw = String(value || '').trim();
        if (!raw || STATIC_ASSET.test(raw)) return null;
        if (/^https?:\/\//i.test(raw)) {
            try { return `${new URL(raw).pathname}${new URL(raw).search}`; } catch (_) { return null; }
        }
        if (!raw.startsWith('/')) return null;
        return raw.replace(/\/+/g, '/');
    }

    function pathIsUseful(value) {
        const path = normalizePath(value);
        if (!path) return false;
        const segments = path.replace(/[?#].*$/, '').split('/').filter(Boolean);
        if (!segments.length) return false;
        if (API_MARKER.test(path)) return true;
        if (segments.some(segment => /[{}:$]/.test(segment) || /\d{2,}/.test(segment))) return true;
        return !segments.every(segment => segment.length <= 2);
    }

    function lineSource(item) {
        return `${item?.source || 'unknown'}${item?.line ? `:${item.line}` : ''}`;
    }

    function runtimeValueLooksLikeBase(value, source = '') {
        try {
            const parsed = new URL(value);
            if (STATIC_ASSET.test(parsed.pathname)) return false;
            const segments = parsed.pathname.split('/').filter(Boolean);
            const keySuggestsBase = /(?:^|[._-])(?:base(?:url)?|api(?:base|root|host|origin|server)|gateway|server(?:url)?|origin|host)(?:$|[._-])/i.test(source);
            const pathSuggestsBase = segments.length <= 4 && /\/(?:api|meta|gateway|rest|openapi|graphql|rpc|v\d+)\/?$/i.test(parsed.pathname);
            return parsed.pathname === '/' || keySuggestsBase || pathSuggestsBase;
        } catch (_) { return false; }
    }

    function joinClientRoute(client, route, pageUrl) {
        if (/^https?:\/\//i.test(route)) return normalizeUrl(route, pageUrl);
        const path = normalizePath(route);
        if (!path) return null;
        try {
            const base = new URL(client.baseUrl || client.origin, pageUrl);
            const basePath = base.pathname.replace(/\/$/, '');
            if (basePath && basePath !== '/' && !path.startsWith(`${basePath}/`) && !path.startsWith(basePath) && API_MARKER.test(basePath)) {
                return `${base.origin}${basePath}${path}`;
            }
            return `${base.origin}${path}`;
        } catch (_) { return null; }
    }

    function buildDiscoveryModel({
        pageUrl,
        runtimeRequests = [],
        staticEndpoints = [],
        stringEvidence = {},
        runtimeEvidence = [],
        connectionHints = []
    } = {}) {
        const clientsByBase = new Map();
        const candidatesByKey = new Map();
        const unresolved = [];

        const addClient = (rawBase, evidence = {}) => {
            const baseUrl = normalizeBase(rawBase, pageUrl);
            if (!baseUrl) return null;
            const parsed = new URL(baseUrl);
            const key = baseUrl;
            const previous = clientsByBase.get(key);
            const item = previous || {
                id: `client_${clientsByBase.size + 1}`,
                baseUrl,
                origin: parsed.origin,
                protocol: parsed.protocol.replace(':', ''),
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'https:' ? '443' : '80'),
                apiPrefix: parsed.pathname === '/' ? '/' : parsed.pathname.replace(/\/$/, ''),
                confidence: 0,
                sources: [],
                requestCount: 0
            };
            item.confidence = Math.max(item.confidence, Number(evidence.confidence || 0.6));
            if (evidence.source && !item.sources.some(source => source.source === evidence.source && source.value === evidence.value)) {
                item.sources.push({ ...evidence, value: evidence.value || rawBase });
            }
            clientsByBase.set(key, item);
            return item;
        };

        const pageClient = addClient(pageUrl, { type: 'page', source: 'window.location', confidence: 0.55, value: pageUrl });
        for (const request of runtimeRequests) {
            const url = normalizeUrl(request.url || request.rawUrl, pageUrl);
            if (!url) continue;
            const parsed = new URL(url);
            const split = scope.apiAnalyzer?.inferSplit?.(parsed.pathname) || { apiPrefix: '/' };
            const client = addClient(`${parsed.origin}${split.apiPrefix === '/' ? '' : split.apiPrefix}`, {
                type: 'network', source: request.stack || request.initiator || request.source || 'Network', confidence: 1, value: url
            });
            if (client) client.requestCount += 1;
        }
        for (const item of stringEvidence.baseUrls || []) {
            addClient(item.value, { type: 'javascript', source: lineSource(item), confidence: /^https?:/i.test(item.value) ? 0.9 : 0.7, value: item.value, evidence: item.evidence });
        }
        for (const item of stringEvidence.apiPrefixes || []) {
            addClient(item.value, { type: 'api-prefix', source: lineSource(item), confidence: 0.78, value: item.value, evidence: item.evidence });
        }
        for (const item of runtimeEvidence || []) {
            if (/^https?:\/\//i.test(item.value || '') && runtimeValueLooksLikeBase(item.value, item.source)) {
                addClient(item.value, { type: item.type || 'runtime', source: item.source, confidence: item.type === 'config-response' ? 0.92 : 0.85, value: item.value });
            }
        }
        for (const hint of connectionHints || []) {
            addClient(hint.value || hint.url, { type: hint.type || 'connection-hint', source: hint.source || hint.type, confidence: hint.confidence || 0.62, value: hint.value || hint.url });
        }

        const clientList = () => [...clientsByBase.values()];
        const addCandidate = ({ method = 'UNKNOWN', url, rawPath, client, endpoint, confidence = 0.6, reason, source, fields = [], requestShape = [], headers = {}, inferredHeaders = [], bodyExpression = '', urlExpression = '', callExpression = '', before = '', after = '' }) => {
            const fullUrl = normalizeUrl(url, pageUrl);
            if (!fullUrl || STATIC_ASSET.test(fullUrl)) return;
            const normalizedMethod = String(method || 'UNKNOWN').toUpperCase();
            const key = `${normalizedMethod} ${fullUrl}`;
            const evidence = {
                type: reason || endpoint?.evidence || 'evidence-link',
                source: source || lineSource(endpoint),
                rawPath: rawPath || endpoint?.rawUrl || '',
                clientSource: client?.sources?.[0]?.source || ''
            };
            const previous = candidatesByKey.get(key);
            const item = previous || {
                id: `candidate_${candidatesByKey.size + 1}`,
                method: normalizedMethod,
                url: fullUrl,
                rawPath: rawPath || endpoint?.rawUrl || new URL(fullUrl).pathname,
                clientId: client?.id || null,
                confidence: 0,
                confirmedByNetwork: false,
                safeToProbe: SAFE_METHODS.has(normalizedMethod),
                fields: [],
                requestShape: [],
                headers: {},
                inferredHeaders: [],
                bodyExpression: '',
                urlExpression: '',
                callExpression: '',
                before: '',
                after: '',
                evidence: []
            };
            item.confidence = Math.max(item.confidence, confidence);
            item.confirmedByNetwork = item.confirmedByNetwork || Boolean(endpoint?.confirmedByNetwork) || runtimeRequests.some(request => request.url === fullUrl && String(request.method || 'GET').toUpperCase() === normalizedMethod);
            item.safeToProbe = item.safeToProbe || SAFE_METHODS.has(normalizedMethod);
            item.fields = [...new Set([...item.fields, ...fields])].slice(0, 100);
            item.requestShape = requestShape?.length ? requestShape : item.requestShape;
            item.headers = { ...item.headers, ...headers };
            item.inferredHeaders = [...new Set([...item.inferredHeaders, ...inferredHeaders])].slice(0, 100);
            item.bodyExpression = item.bodyExpression || bodyExpression;
            item.urlExpression = item.urlExpression || urlExpression;
            item.callExpression = item.callExpression || callExpression || endpoint?.callExpression || '';
            item.before = item.before || before || endpoint?.before || '';
            item.after = item.after || after || endpoint?.after || '';
            if (!item.evidence.some(existing => existing.type === evidence.type && existing.source === evidence.source)) item.evidence.push(evidence);
            candidatesByKey.set(key, item);
        };

        for (const request of runtimeRequests) {
            addCandidate({
                method: request.method,
                url: request.url,
                rawPath: request.path,
                endpoint: { ...request, confirmedByNetwork: true },
                confidence: 1,
                reason: 'Network 事实请求',
                source: request.stack || request.initiator || request.source,
                fields: request.fields || [],
                requestShape: request.requestShape || [],
                headers: request.requestHeaders || request.headers || {}
            });
        }

        for (const endpoint of staticEndpoints || []) {
            const raw = endpoint.rawUrl || endpoint.url || endpoint.fullUrl;
            if (!raw || !pathIsUseful(raw)) continue;
            if (/^https?:\/\//i.test(endpoint.fullUrl || raw)) {
                const fullUrl = endpoint.fullUrl || raw;
                const client = clientList().find(item => fullUrl.startsWith(item.origin));
                addCandidate({ method: endpoint.method, url: fullUrl, rawPath: raw, client, endpoint, confidence: endpoint.confidence || 0.85, fields: endpoint.fields || [], requestShape: endpoint.requestShape || [], inferredHeaders: endpoint.inferredHeaders || [], bodyExpression: endpoint.bodyExpression || '', urlExpression: endpoint.urlExpression || '', callExpression: endpoint.callExpression || '', before: endpoint.before || '', after: endpoint.after || '' });
                continue;
            }
            const bases = new Set((endpoint.baseCandidates || []).map(value => normalizeBase(value, pageUrl)).filter(Boolean));
            const sameSourceBases = [...(stringEvidence.baseUrls || []), ...(stringEvidence.apiPrefixes || [])]
                .filter(item => item.source === endpoint.source)
                .map(item => normalizeBase(item.value, pageUrl)).filter(Boolean);
            sameSourceBases.forEach(value => bases.add(value));
            const runtimeMatches = runtimeRequests.filter(request => {
                try {
                    const requestPath = new URL(request.url).pathname;
                    const candidatePath = normalizePath(raw)?.replace(/[?#].*$/, '');
                    return candidatePath && (requestPath === candidatePath || requestPath.endsWith(candidatePath));
                } catch (_) { return false; }
            });
            runtimeMatches.forEach(request => {
                const requestUrl = normalizeUrl(request.url, pageUrl);
                if (!requestUrl) return;
                const requestParsed = new URL(requestUrl);
                const candidatePath = normalizePath(raw)?.replace(/[?#].*$/, '');
                if (candidatePath && requestParsed.pathname.endsWith(candidatePath)) {
                    const exactPrefix = requestParsed.pathname.slice(0, -candidatePath.length).replace(/\/$/, '');
                    const exactClient = addClient(`${requestParsed.origin}${exactPrefix}`, {
                        type: 'network-suffix', source: request.stack || request.initiator || request.source || 'Network', confidence: 0.98, value: requestUrl
                    });
                    if (exactClient) {
                        exactClient.requestCount += 1;
                        bases.add(exactClient.baseUrl);
                        return;
                    }
                }
                // Keep the longest proven request-client prefix. Falling back to the
                // bare page origin would recreate the exact false join this module is
                // designed to prevent (for example /meta/api + /user/sendSMS).
                const provenClient = clientList()
                    .filter(client => client.requestCount > 0 && (requestUrl === client.baseUrl || requestUrl.startsWith(`${client.baseUrl}/`)))
                    .sort((left, right) => right.baseUrl.length - left.baseUrl.length)[0];
                if (provenClient) bases.add(provenClient.baseUrl);
            });

            let relatedClients = clientList().filter(client => bases.has(client.baseUrl) || bases.has(client.origin));
            // If the same evidence exposes nested prefixes such as /api and
            // /api/aibox, keep the most specific one for a relative business path.
            // The shorter prefix remains visible as a client, but does not create a
            // duplicate/wrong candidate URL for this call site.
            relatedClients = relatedClients.filter(client => !relatedClients.some(other =>
                other.id !== client.id && other.origin === client.origin && other.apiPrefix.startsWith(`${client.apiPrefix.replace(/\/$/, '')}/`)
            ));
            if (!relatedClients.length && clientList().length === 1 && API_MARKER.test(raw)) relatedClients.push(clientList()[0]);
            if (!relatedClients.length) {
                unresolved.push({ method: endpoint.method, rawPath: raw, confidence: endpoint.confidence || 0.5, source: lineSource(endpoint), reason: '缺少与该调用点关联的 Base URL' });
                continue;
            }
            for (const client of relatedClients.slice(0, 4)) {
                addCandidate({ method: endpoint.method, url: joinClientRoute(client, raw, pageUrl), rawPath: raw, client, endpoint, confidence: Math.min(endpoint.confidence || 0.7, relatedClients.length === 1 ? 0.82 : 0.68), fields: endpoint.fields || [], requestShape: endpoint.requestShape || [], inferredHeaders: endpoint.inferredHeaders || [], bodyExpression: endpoint.bodyExpression || '', urlExpression: endpoint.urlExpression || '', callExpression: endpoint.callExpression || '', before: endpoint.before || '', after: endpoint.after || '' });
            }
        }

        // Plain business-path strings remain evidence only. Merely sharing a
        // minified bundle with a base URL is not proof of an HTTP call.

        const clients = clientList().sort((a, b) => b.confidence - a.confidence || b.requestCount - a.requestCount);
        const candidates = [...candidatesByKey.values()].map(candidate => ({
            ...candidate,
            clientId: candidate.clientId || clients.find(client => candidate.url.startsWith(client.origin))?.id || null
        })).sort((a, b) => Number(b.confirmedByNetwork) - Number(a.confirmedByNetwork) || b.confidence - a.confidence);
        return {
            generatedAt: Date.now(),
            clients,
            candidates: candidates.slice(0, 1000),
            unresolved: unresolved.slice(0, 500),
            stats: {
                clients: clients.length,
                candidates: candidates.length,
                confirmed: candidates.filter(item => item.confirmedByNetwork).length,
                safeProbe: candidates.filter(item => !item.confirmedByNetwork && item.safeToProbe).length,
                unresolved: unresolved.length
            }
        };
    }

    scope.discoveryEngine = { buildDiscoveryModel, normalizeUrl, normalizePath, pathIsUseful, joinClientRoute };
})(typeof self !== 'undefined' ? self : globalThis);
