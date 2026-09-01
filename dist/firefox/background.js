// ====== MCP 客户端集成 ====== //
// Chrome 使用 Service Worker，需要主动载入依赖；Firefox 的事件页由 manifest
// 按顺序载入这些脚本，没有 importScripts。
if (typeof importScripts === 'function') {
    importScripts('firefox-compat.js', 'api-analyzer.js', 'discovery-engine.js', 'mcp-client.js');
}

// ====== 脚本注册管理 ====== //
const scriptRegistry = new Map(); // 存储: [hostname|scriptId] => 注册ID
let isInitialized = false;
let scriptRegistryInitialization = null;

// 🆕 全局模式存储键名
const GLOBAL_MODE_KEY = 'antidebug_mode';
const GLOBAL_SCRIPTS_KEY = 'global_scripts';

// 🆕 全局请求头存储键名
const HEADERS_ENABLED_KEY = 'global_headers_enabled';
const SAME_ORIGIN_AUTH_KEY = 'same_origin_auth_enabled';
const SAME_ORIGIN_RULE_BASE = 200000;
let sameOriginAuthEnabled = false;
let sameOriginHeaderProfiles = {};
let headerProfilePersistTimer = null;
let pendingHeaderRuleRebuild = false;

const BROWSER_MANAGED_HEADERS = new Set([
    'accept-encoding', 'connection', 'content-length', 'cookie', 'host', 'origin', 'referer',
    'transfer-encoding', 'upgrade', 'user-agent', 'proxy-connection'
]);
const STANDARD_HEADERS = new Set([
    'accept', 'accept-language', 'cache-control', 'content-type', 'dnt', 'if-match',
    'if-modified-since', 'if-none-match', 'pragma', 'range', 'te', 'upgrade-insecure-requests'
]);
const IDENTITY_HEADER_PATTERN = /^(?:authorization|proxy-authorization|x-(?:auth|access)-token|x-api-key|x-csrf-token|x-xsrf-token|csrf-token|xsrf-token|token|jwt|session|x-session-id|api-key)$/i;
const TRACING_HEADER_PATTERN = /^(?:traceparent|tracestate|baggage|x-(?:request|correlation|trace)-id)$/i;
const INFRASTRUCTURE_HEADER_PATTERN = /^(?:forwarded|x-forwarded-.+|x-real-ip|x-requested-with)$/i;

function classifyRequestHeader(name, value = '') {
    const lower = String(name || '').toLowerCase();
    let category = 'custom';
    let reason = '站点自定义请求头';
    if (BROWSER_MANAGED_HEADERS.has(lower) || lower.startsWith('sec-')) {
        category = 'browser';
        reason = lower === 'cookie' ? 'Cookie 由 Chrome 按域、SameSite 与凭据策略管理' : '由 Chromium 管理，不能可靠强制覆盖';
    } else if (TRACING_HEADER_PATTERN.test(lower)) {
        category = 'tracing';
        reason = '每次请求生成的链路追踪值，不应跨 Tab 复用';
    } else if (IDENTITY_HEADER_PATTERN.test(lower)) {
        category = 'identity';
        reason = '登录态或身份凭据，可在同源内按用户开关复用';
    } else if (STANDARD_HEADERS.has(lower) || lower.startsWith('if-') || INFRASTRUCTURE_HEADER_PATTERN.test(lower)) {
        category = 'standard';
        reason = 'HTTP 常规协商或缓存头，仅识别不覆盖';
    }
    const sensitive = category === 'identity' || lower === 'cookie' || /secret|key|token|auth|session/i.test(lower);
    const shareable = category === 'identity' || (category === 'custom' && lower.startsWith('x-'));
    return { name, lowerName: lower, value: String(value || ''), category, reason, sensitive, shareable };
}

function scheduleHeaderProfilePersist(rebuildRules = false) {
    pendingHeaderRuleRebuild = pendingHeaderRuleRebuild || rebuildRules;
    if (headerProfilePersistTimer) return;
    headerProfilePersistTimer = setTimeout(async () => {
        headerProfilePersistTimer = null;
        const profiles = Object.fromEntries(Object.entries(sameOriginHeaderProfiles)
            .sort(([, a], [, b]) => (b.updatedAt || 0) - (a.updatedAt || 0))
            .slice(0, 100));
        sameOriginHeaderProfiles = profiles;
        await chrome.storage.session.set({ same_origin_headers_cache: profiles });
        if (pendingHeaderRuleRebuild && sameOriginAuthEnabled) await rebuildSameOriginAuthRules();
        pendingHeaderRuleRebuild = false;
    }, 300);
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function rebuildSameOriginAuthRules() {
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    const oldIds = existing.filter(rule => rule.id >= SAME_ORIGIN_RULE_BASE).map(rule => rule.id);
    const addRules = [];
    if (sameOriginAuthEnabled) {
        const originEntries = Object.entries(sameOriginHeaderProfiles).sort(([a], [b]) => a.localeCompare(b));
        for (const [index, [origin, profile]] of originEntries.entries()) {
            const reusable = Object.values(profile.headers || {})
                .filter(header => header.shareable && header.value)
                .slice(0, 40)
                .map(header => ({ header: header.name, operation: 'set', value: header.value }));
            if (!reusable.length) continue;
            addRules.push({
                id: SAME_ORIGIN_RULE_BASE + index,
                priority: 10,
                action: { type: 'modifyHeaders', requestHeaders: reusable },
                condition: {
                    regexFilter: `^${escapeRegex(origin)}(?:/|$)`,
                    resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'ping', 'websocket', 'other']
                }
            });
        }
    }
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: oldIds, addRules });
}

chrome.storage.local.get([SAME_ORIGIN_AUTH_KEY], result => {
    sameOriginAuthEnabled = result[SAME_ORIGIN_AUTH_KEY] === true;
    rebuildSameOriginAuthRules().catch(console.error);
});
chrome.storage.session.get(['same_origin_auth_cache'], result => {
    const legacy = result.same_origin_auth_cache || {};
    for (const [origin, authorization] of Object.entries(legacy)) {
        const header = classifyRequestHeader('Authorization', authorization);
        sameOriginHeaderProfiles[origin] = { origin, updatedAt: Date.now(), headers: { authorization: header } };
    }
    rebuildSameOriginAuthRules().catch(console.error);
});
chrome.storage.session.get(['same_origin_headers_cache'], result => {
    sameOriginHeaderProfiles = { ...sameOriginHeaderProfiles, ...(result.same_origin_headers_cache || {}) };
    rebuildSameOriginAuthRules().catch(console.error);
});

const isFirefoxExtension = globalThis.__ANTIDEBUG_BROWSER__ === 'firefox';
const requestHeaderListenerOptions = isFirefoxExtension
    ? ['requestHeaders']
    : ['requestHeaders', 'extraHeaders'];
const responseHeaderListenerOptions = isFirefoxExtension
    ? ['responseHeaders']
    : ['responseHeaders', 'extraHeaders'];

chrome.webRequest.onBeforeSendHeaders.addListener(details => {
    if (details.tabId >= 0 && isApiResourceType(details.type)) {
        patchCapturedNetworkRequest(details.requestId, {
            requestHeaders: Object.fromEntries((details.requestHeaders || []).map(header => [header.name, header.value || ''])),
            headers: Object.fromEntries((details.requestHeaders || []).map(header => [header.name, header.value || '']))
        }).catch(() => {});
    }
    if (!details.url.startsWith('http')) return;
    const origin = new URL(details.url).origin;
    const profile = sameOriginHeaderProfiles[origin] || { origin, updatedAt: 0, requestCount: 0, headers: {} };
    let reusableChanged = false;
    for (const rawHeader of details.requestHeaders || []) {
        const classified = classifyRequestHeader(rawHeader.name, rawHeader.value || '');
        const previous = profile.headers[classified.lowerName];
        profile.headers[classified.lowerName] = {
            ...classified,
            seenCount: (previous?.seenCount || 0) + 1,
            lastSeenAt: Date.now()
        };
        if (classified.shareable && previous?.value !== classified.value) reusableChanged = true;
    }
    profile.updatedAt = Date.now();
    profile.requestCount = (profile.requestCount || 0) + 1;
    sameOriginHeaderProfiles[origin] = profile;
    scheduleHeaderProfilePersist(sameOriginAuthEnabled && reusableChanged);
}, { urls: ['<all_urls>'] }, requestHeaderListenerOptions);

// Network 是接口事实源：即使页面 Hook 被覆盖、请求来自 Worker，也先原样写入最近捕获接口。
chrome.webRequest.onBeforeRequest.addListener(details => {
    if (!autoApiCaptureEnabled || details.tabId < 0 || !isApiResourceType(details.type) || !details.url.startsWith('http')) return;
    networkRequestTabs.set(details.requestId, details.tabId);
    captureChromeNetworkRequest(details).catch(error => console.warn('[AntiDebug] Network捕获失败:', error));
}, { urls: ['<all_urls>'] }, ['requestBody']);

chrome.webRequest.onCompleted.addListener(details => {
    if (details.tabId < 0 || !isApiResourceType(details.type)) return;
    patchCapturedNetworkRequest(details.requestId, {
        status: details.statusCode,
        statusCode: details.statusCode,
        responseHeaders: Object.fromEntries((details.responseHeaders || []).map(header => [header.name, header.value || ''])),
        completedAt: details.timeStamp,
        completed: true
    }).finally(() => networkRequestTabs.delete(details.requestId));
}, { urls: ['<all_urls>'] }, responseHeaderListenerOptions);

chrome.webRequest.onErrorOccurred.addListener(details => {
    if (details.tabId < 0 || !isApiResourceType(details.type)) return;
    patchCapturedNetworkRequest(details.requestId, {
        error: details.error,
        completedAt: details.timeStamp,
        completed: true
    }).finally(() => networkRequestTabs.delete(details.requestId));
}, { urls: ['<all_urls>'] });

// ====== 自动前端分析 ====== //
const AUTO_API_ENABLED_KEY = 'auto_api_analysis_enabled';
const AUTO_FRAMEWORK_ENABLED_KEY = 'auto_frontend_detection_enabled';
const API_STORAGE_PREFIX = 'api_analysis_tab_';
const STATIC_API_STORAGE_PREFIX = 'static_api_analysis_tab_';
const API_STORAGE_TRACE_PREFIX = 'api_storage_trace_tab_';
const FRONTEND_ANALYSIS_STORAGE_PREFIX = 'frontend_analysis_tab_';
const API_PROBE_STORAGE_PREFIX = 'api_probe_results_tab_';
const API_REQUEST_LIMIT = 1000;
const API_STORAGE_TRACE_LIMIT = 1000;
const apiBadgeTimers = new Map();
const networkRequestTabs = new Map();
const tabCacheWriteQueues = new Map();
let analysisCacheMaintenance = null;
let autoApiCaptureEnabled = true;
const DEFAULT_ANALYSIS_EXCLUDED_DOMAINS = ['w3.org', 'w3c.org', 'schema.org', 'google-analytics.com', 'googletagmanager.com', 'doubleclick.net', 'adtrafficquality.google', 'cloudflareinsights.com', 'tongji-collector.dcloud.net.cn'];
let analysisExcludedDomains = new Set(DEFAULT_ANALYSIS_EXCLUDED_DOMAINS);

function updateAnalysisExcludedDomains(custom = []) {
    analysisExcludedDomains = new Set([...DEFAULT_ANALYSIS_EXCLUDED_DOMAINS, ...(Array.isArray(custom) ? custom : [])]
        .map(value => String(value || '').trim().toLowerCase()).filter(Boolean));
}

function isExcludedApiNoise(request) {
    try {
        const parsed = new URL(request?.url || request?.rawUrl);
        if ([...analysisExcludedDomains].some(domain => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`))) return true;
        return /\/(?:gen_204|log|collect|analytics|telemetry|rum|beacon)(?:[/?]|$)/i.test(parsed.pathname) && request?.transport === 'beacon';
    } catch (_) { return false; }
}

function cachedTabId(key, prefix) {
    if (!key.startsWith(prefix)) return null;
    const tabId = Number(key.slice(prefix.length));
    return Number.isInteger(tabId) && tabId >= 0 ? tabId : null;
}

function analysisCacheTabId(key) {
    for (const prefix of [API_STORAGE_PREFIX, STATIC_API_STORAGE_PREFIX, API_STORAGE_TRACE_PREFIX, FRONTEND_ANALYSIS_STORAGE_PREFIX, API_PROBE_STORAGE_PREFIX]) {
        const tabId = cachedTabId(key, prefix);
        if (tabId != null) return tabId;
    }
    return null;
}

function compactStoredApiAnalysis(analysis, tabId) {
    const requests = Array.isArray(analysis?.requests) ? analysis.requests.slice(0, API_REQUEST_LIMIT) : [];
    // endpoints 可随时从 requests 重建，持久化两份完整请求会让每个 Tab 的体积近似翻倍。
    const { endpoints: _discardedEndpoints, ...rest } = analysis || {};
    return { ...rest, tabId, requests };
}

async function maintainAnalysisCache() {
    if (analysisCacheMaintenance) return analysisCacheMaintenance;
    analysisCacheMaintenance = (async () => {
        const [tabs, stored] = await Promise.all([
            chrome.tabs.query({}),
            chrome.storage.local.get(null)
        ]);
        const liveTabIds = new Set(tabs.map(tab => tab.id).filter(Number.isInteger));
        const removeKeys = [];
        const updates = {};
        for (const [key, value] of Object.entries(stored)) {
            const tabId = analysisCacheTabId(key);
            if (tabId == null) continue;
            if (!liveTabIds.has(tabId)) {
                removeKeys.push(key);
                continue;
            }
            if (key.startsWith(API_STORAGE_PREFIX)) {
                updates[key] = compactStoredApiAnalysis(value, tabId);
            } else if (key.startsWith(API_STORAGE_TRACE_PREFIX) && Array.isArray(value) && value.length > API_STORAGE_TRACE_LIMIT) {
                updates[key] = value.slice(0, API_STORAGE_TRACE_LIMIT);
            }
        }
        // 先释放已关闭标签页的旧缓存，确保旧版本已经顶满配额时也能完成迁移。
        if (removeKeys.length) await chrome.storage.local.remove(removeKeys);
        if (Object.keys(updates).length) await chrome.storage.local.set(updates);
        return { removed: removeKeys.length, compacted: Object.keys(updates).length };
    })().finally(() => {
        analysisCacheMaintenance = null;
    });
    return analysisCacheMaintenance;
}

async function writeAnalysisCache(key, value) {
    try {
        await chrome.storage.local.set({ [key]: value });
    } catch (error) {
        if (!/quota|kQuotaBytes/i.test(String(error?.message || error))) throw error;
        await maintainAnalysisCache();
        await chrome.storage.local.set({ [key]: value });
    }
}

function enqueueTabCacheWrite(tabId, operation) {
    const previous = tabCacheWriteQueues.get(tabId) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    tabCacheWriteQueues.set(tabId, next);
    return next.finally(() => {
        if (tabCacheWriteQueues.get(tabId) === next) tabCacheWriteQueues.delete(tabId);
    });
}

maintainAnalysisCache().then(result => {
    if (result.removed || result.compacted) console.info('[AntiDebug] 分析缓存维护完成:', result);
}).catch(error => console.warn('[AntiDebug] 分析缓存维护失败:', error));
chrome.storage.local.get([AUTO_API_ENABLED_KEY, 'analysis_excluded_sites'], result => {
    autoApiCaptureEnabled = result[AUTO_API_ENABLED_KEY] !== false;
    updateAnalysisExcludedDomains(result.analysis_excluded_sites);
});
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[AUTO_API_ENABLED_KEY]) autoApiCaptureEnabled = changes[AUTO_API_ENABLED_KEY].newValue !== false;
    if (changes.analysis_excluded_sites) updateAnalysisExcludedDomains(changes.analysis_excluded_sites.newValue);
});

function decodeWebRequestBody(requestBody) {
    if (!requestBody) return null;
    if (requestBody.formData) {
        try { return JSON.stringify(requestBody.formData).slice(0, 12000); } catch (_) {}
    }
    if (Array.isArray(requestBody.raw)) {
        try {
            const chunks = requestBody.raw.map(item => item.bytes ? new Uint8Array(item.bytes) : new Uint8Array());
            const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
            const joined = new Uint8Array(Math.min(length, 12000));
            let offset = 0;
            for (const chunk of chunks) {
                if (offset >= joined.length) break;
                const part = chunk.slice(0, joined.length - offset);
                joined.set(part, offset);
                offset += part.length;
            }
            return new TextDecoder().decode(joined).slice(0, 12000);
        } catch (_) { return '[binary request body]'; }
    }
    return requestBody.error || null;
}

function isApiResourceType(type) {
    return ['xmlhttprequest', 'ping', 'websocket'].includes(type);
}

chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.get(null, (result) => {
        const defaults = {};
        if (result[AUTO_API_ENABLED_KEY] === undefined) defaults[AUTO_API_ENABLED_KEY] = true;
        if (result[AUTO_FRAMEWORK_ENABLED_KEY] === undefined) defaults[AUTO_FRAMEWORK_ENABLED_KEY] = true;
        if (result.route_default_v320_migrated !== true) {
            for (const [key, value] of Object.entries(result)) {
                if (Array.isArray(value) && (key === GLOBAL_SCRIPTS_KEY || key.includes('.')) && !value.includes('Get_Vue_0')) {
                    defaults[key] = [...value, 'Get_Vue_0'];
                }
            }
            defaults.route_default_v320_migrated = true;
        }
        if (Object.keys(defaults).length > 0) chrome.storage.local.set(defaults);
    });
});

// 生成全局唯一ID
function generateUniqueId() {
    return `ad_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// 🔧 新增：清理指定模式的所有脚本注册
async function clearModeScripts(isGlobalMode) {
    const keysToRemove = [];
    const keyPrefix = isGlobalMode ? 'global' : '';
    
    for (const [key, regId] of scriptRegistry) {
        if (isGlobalMode) {
            // 清理全局模式：移除所有以"global|"开头的键
            if (key.startsWith('global|')) {
                keysToRemove.push(key);
            }
        } else {
            // 清理标准模式：移除所有不以"global|"开头的键（即域名键）
            if (!key.startsWith('global|') && key.includes('|')) {
                keysToRemove.push(key);
            }
        }
    }

    if (keysToRemove.length > 0) {
        const removeIds = keysToRemove.map(key => scriptRegistry.get(key));

        try {
            await chrome.scripting.unregisterContentScripts({
                ids: removeIds
            });
            console.log(`[AntiDebug] Cleared ${isGlobalMode ? 'global' : 'standard'} mode scripts:`, keysToRemove);

            // 清理注册表
            keysToRemove.forEach(key => scriptRegistry.delete(key));
        } catch (error) {
            if (!error.message.includes('Nonexistent')) {
                console.error('[AntiDebug] Failed to clear mode scripts:', error);
            }
        }
    }
}

// 🆕 注册脚本到主世界（支持全局模式）
async function registerScripts(hostname, scriptIds, isGlobalMode = false) {
    // 🆕 全局模式允许特殊的hostname值
    if (!isGlobalMode) {
        // 标准模式：检查hostname是否有效
        if (!hostname || typeof hostname !== 'string' || hostname.trim() === '' || !hostname.includes('.')) {
            // console.warn('[AntiDebug] Skip script registration: Invalid hostname');
            return;
        }
    }

    // 过滤有效脚本ID
    const validScriptIds = scriptIds.filter(
        id => typeof id === 'string' && id.trim() !== ''
    );

    // 🆕 创建当前应存在的键集合（支持全局模式）
    const currentKeys = new Set();
    const keyPrefix = isGlobalMode ? 'global' : hostname;
    validScriptIds.forEach(id => {
        currentKeys.add(`${keyPrefix}|${id}`);
    });

    // === 1. 注销不再需要的脚本 ===
    const keysToRemove = [];
    for (const [key, regId] of scriptRegistry) {
        if (key.startsWith(`${keyPrefix}|`) && !currentKeys.has(key)) {
            keysToRemove.push(key);
        }
    }

    if (keysToRemove.length > 0) {
        const removeIds = keysToRemove.map(key => scriptRegistry.get(key));

        try {
            await chrome.scripting.unregisterContentScripts({
                ids: removeIds
            });
            // console.log(`[AntiDebug] Unregistered scripts for ${keyPrefix}:`, keysToRemove);

            // 清理注册表
            keysToRemove.forEach(key => scriptRegistry.delete(key));
        } catch (error) {
            if (!error.message.includes('Nonexistent')) {
                // console.error('[AntiDebug] Failed to unregister old scripts:', error);
            }
        }
    }

    // === 2. 注册新脚本 ===
    const scriptsToRegister = [];

    validScriptIds.forEach(id => {
        const key = `${keyPrefix}|${id}`;

        // 如果尚未注册，则创建新注册项
        if (!scriptRegistry.has(key)) {
            const regId = generateUniqueId();
            scriptRegistry.set(key, regId);

            // 🆕 根据模式设置matches
            const matches = isGlobalMode ? ['<all_urls>'] : [`*://${hostname}/*`];

            scriptsToRegister.push({
                id: regId,
                js: [`scripts/${id}.js`],
                matches: matches,
                runAt: 'document_start',
                world: 'MAIN'
            });
        }
    });

    if (scriptsToRegister.length > 0) {
        try {
            await chrome.scripting.registerContentScripts(scriptsToRegister);
            // console.log(`[AntiDebug] Registered new scripts for ${keyPrefix}:`,
            //     scriptsToRegister.map(s => s.id));
        } catch (error) {
            console.error(`[AntiDebug] Failed to register scripts for ${keyPrefix}:`, error);
        }
    }
}

// 初始化时清除所有旧注册
async function initializeScriptRegistry() {
    if (isInitialized) return;
    if (scriptRegistryInitialization) return scriptRegistryInitialization;
    scriptRegistryInitialization = (async () => {
        try {
            // 清除所有旧注册。用单一 Promise 防止启动和安装事件并发注销同一个 ID。
            const registered = await chrome.scripting.getRegisteredContentScripts();
            const ourScripts = registered.filter(script => script.id.startsWith('ad_'));

            if (ourScripts.length > 0) {
                await chrome.scripting.unregisterContentScripts({
                    ids: ourScripts.map(s => s.id)
                });
                // console.log('[AntiDebug] Cleared old script registrations');
            }

            isInitialized = true;
        } catch (error) {
            console.error('[AntiDebug] Initialization failed:', error);
        } finally {
            scriptRegistryInitialization = null;
        }
    })();
    return scriptRegistryInitialization;
}

// ====== 初始化及原有徽章管理 ====== //
chrome.runtime.onStartup.addListener(initializeScriptRegistry);
chrome.runtime.onInstalled.addListener(initializeScriptRegistry);

chrome.storage.local.get(null, (data) => {
    // 先初始化注册表
    initializeScriptRegistry().then(() => {
        // 🆕 检查全局模式并初始化全局脚本
        const mode = data[GLOBAL_MODE_KEY] || 'standard';
        const globalScripts = data[GLOBAL_SCRIPTS_KEY] || [];
        
        if (mode === 'global' && globalScripts.length > 0) {
            // 全局模式：注册全局脚本
            registerScripts('*', globalScripts, true);
        }
        
        // 初始化存储结构
        Object.keys(data).forEach(hostname => {
            if (Array.isArray(data[hostname]) && hostname.includes('.')) {
                // 确保计数基于有效的脚本ID
                const validCount = data[hostname].filter(
                    id => typeof id === 'string' && id.trim() !== ''
                ).length;

                updateBadgeForHostname(hostname, validCount);

                // 🆕 只在标准模式下初始化脚本注册
                if (mode === 'standard') {
                    registerScripts(hostname, data[hostname], false);
                }
            }
        });
    });
});

// 监听存储变化并同步
chrome.storage.onChanged.addListener(async (changes, namespace) => {
    for (let [key, {newValue}] of Object.entries(changes)) {
        if (namespace === 'local') {
            if (key === SAME_ORIGIN_AUTH_KEY) {
                sameOriginAuthEnabled = newValue === true;
                if (!sameOriginAuthEnabled) {
                    await chrome.declarativeNetRequest.updateSessionRules({
                        removeRuleIds: (await chrome.declarativeNetRequest.getSessionRules()).filter(rule => rule.id >= SAME_ORIGIN_RULE_BASE).map(rule => rule.id)
                    });
                }
                await rebuildSameOriginAuthRules();
                continue;
            }
            // 🆕 处理全局模式变化
            if (key === GLOBAL_MODE_KEY) {
                // 模式切换时重新初始化所有脚本
                // 这里可以根据需要添加更多逻辑
                continue;
            }
            
            // 🆕 处理全局脚本变化
            if (key === GLOBAL_SCRIPTS_KEY && Array.isArray(newValue)) {
                // 仅在全局模式下注册，避免修改配置时误注入所有网站
                const modeState = await chrome.storage.local.get([GLOBAL_MODE_KEY]);
                if (modeState[GLOBAL_MODE_KEY] === 'global') {
                    await registerScripts('*', newValue, true);
                } else {
                    await clearModeScripts(true);
                }
                continue;
            }
            
            if (Array.isArray(newValue) && key.includes('.')) {
                // 更新标准模式脚本注册
                await registerScripts(key, newValue, false);

                // 同步到所有标签页的localStorage
                chrome.tabs.query({}, (tabs) => {
                    tabs.forEach(tab => {
                        if (tab.url) {
                            try {
                                const tabHostname = new URL(tab.url).hostname;
                                if (tabHostname === key) {
                                    chrome.scripting.executeScript({
                                        target: {tabId: tab.id},
                                        func: (hostname, scripts) => {
                                            try {
                                                const storageData = localStorage.getItem('AntiDebug_Breaker') || '{}';
                                                const parsed = JSON.parse(storageData);
                                                parsed[hostname] = scripts;
                                                localStorage.setItem('AntiDebug_Breaker', JSON.stringify(parsed));
                                            } catch (e) {
                                                console.warn('[AntiDebug] Failed to update localStorage', e);
                                            }
                                        },
                                        args: [key, newValue]
                                    });
                                }
                            } catch (e) {
                                // 忽略URL解析错误
                            }
                        }
                    });
                });
            }
        }
    }
});

// 监听来自 content script 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'TABS_API_PROXY') {
        const allowedMethods = new Set(['query', 'get', 'create', 'update', 'reload', 'remove', 'sendMessage']);
        if (!allowedMethods.has(message.method) || typeof chrome.tabs?.[message.method] !== 'function') {
            sendResponse({ success: false, error: `不允许的 tabs API: ${message.method}` });
            return false;
        }
        Promise.resolve(chrome.tabs[message.method](...(Array.isArray(message.args) ? message.args : [])))
            .then(result => sendResponse({ success: true, result }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }

    // 🔧 新增：处理清理旧模式脚本的请求
    if (message.type === 'clear_mode_scripts') {
        clearModeScripts(message.clearGlobalMode);
        sendResponse({success: true});
        return true;
    }

    if (message.type === 'AUTO_API_CAPTURE' && sender.tab) {
        handleAutoApiCapture(message.data, sender).then(result => {
            sendResponse({ success: true, data: result });
        }).catch(error => {
            console.error('[AntiDebug] 自动接口捕获处理失败:', error);
            sendResponse({ success: false, error: error.message });
        });
        return true;
    }

    if (message.type === 'AUTO_API_STORAGE_TRACE' && sender.tab) {
        const key = apiStorageTraceKey(sender.tab.id);
        enqueueTabCacheWrite(sender.tab.id, async () => {
            const result = await chrome.storage.local.get([key]);
            const incoming = {
                ...message.data,
                value: String(message.data?.value || '').slice(0, 50000),
                tabId: sender.tab.id,
                frameId: sender.frameId ?? 0,
                capturedAt: message.data?.capturedAt || Date.now()
            };
            const traces = [...(result[key] || [])];
            const duplicateIndex = traces.findIndex(trace =>
                trace.storage === incoming.storage && trace.key === incoming.key && trace.value === incoming.value
            );
            if (duplicateIndex >= 0) {
                const previous = traces.splice(duplicateIndex, 1)[0];
                traces.unshift({ ...previous, ...incoming, seenCount: (previous.seenCount || 1) + 1 });
            } else {
                traces.unshift({ ...incoming, seenCount: 1 });
            }
            traces.splice(API_STORAGE_TRACE_LIMIT);
            await writeAnalysisCache(key, traces);
        }).then(() => sendResponse({ success: true })).catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }

    if (message.type === 'AUTO_API_MONITOR_READY' && sender.tab) {
        chrome.storage.local.get([AUTO_FRAMEWORK_ENABLED_KEY], result => {
            if (result[AUTO_FRAMEWORK_ENABLED_KEY] === false || !self.mcpClient?.detectFrontendStack) return;
            setTimeout(() => {
                self.mcpClient.detectFrontendStack({ tabId: sender.tab.id }).then(analysis => {
                    writeAnalysisCache(`${FRONTEND_ANALYSIS_STORAGE_PREFIX}${sender.tab.id}`, analysis).catch(() => {});
                    chrome.runtime.sendMessage({ type: 'FRONTEND_ANALYSIS_UPDATE', tabId: sender.tab.id, data: analysis }).catch(() => {});
                }).catch(() => {});
            }, 800);
        });
        sendResponse({ success: true });
        return true;
    }

    if (message.type === 'GET_API_ANALYSIS') {
        getApiAnalysisForTab(message.tabId).then(sendResponse);
        return true;
    }

    if (message.type === 'GET_HEADER_INTELLIGENCE') {
        chrome.tabs.get(message.tabId).then(tab => {
            let origin = '';
            try { origin = new URL(tab.url).origin; } catch (_) {}
            const profile = sameOriginHeaderProfiles[origin] || { origin, requestCount: 0, updatedAt: 0, headers: {} };
            const headers = Object.values(profile.headers || {}).sort((a, b) => {
                const order = { identity: 0, custom: 1, standard: 2, browser: 3, tracing: 4 };
                return (order[a.category] ?? 9) - (order[b.category] ?? 9) || a.name.localeCompare(b.name);
            });
            const counts = headers.reduce((output, header) => {
                output[header.category] = (output[header.category] || 0) + 1;
                return output;
            }, {});
            sendResponse({ ...profile, headers, counts, enabled: sameOriginAuthEnabled });
        }).catch(error => sendResponse({ error: error.message }));
        return true;
    }

    if (message.type === 'ANALYZE_PAGE_JS') {
        const started = startPageJavaScriptAnalysis(message.tabId);
        sendResponse({ accepted: true, started, status: 'running' });
        return false;
    }

    if (message.type === 'GET_STATIC_API_ANALYSIS') {
        chrome.storage.local.get([staticApiStorageKey(message.tabId)]).then(result => {
            const stored = result[staticApiStorageKey(message.tabId)] || { endpoints: [], security: { algorithms: [], findings: [], urls: [] } };
            sendResponse({ ...stored, status: staticAnalysisJobs.has(message.tabId) ? 'running' : (stored.status || 'idle') });
        });
        return true;
    }

    if (message.type === 'GET_API_PROBE_RESULTS') {
        chrome.storage.local.get([apiProbeStorageKey(message.tabId)]).then(result => {
            sendResponse(result[apiProbeStorageKey(message.tabId)] || { tabId: message.tabId, status: 'idle', results: [] });
        }).catch(error => sendResponse({ tabId: message.tabId, status: 'error', error: error.message, results: [] }));
        return true;
    }

    if (message.type === 'PROBE_API_CANDIDATES') {
        startSafeCandidateProbe(message.tabId, message.options || {}).then(sendResponse).catch(error => sendResponse({ accepted: false, error: error.message }));
        return true;
    }

    if (message.type === 'CLEAR_API_PROBE_RESULTS') {
        chrome.storage.local.remove([apiProbeStorageKey(message.tabId)]).then(() => sendResponse({ success: true })).catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }

    if (message.type === 'CLEAR_API_ANALYSIS') {
        clearApiAnalysisForTab(message.tabId).then(() => sendResponse({ success: true }));
        return true;
    }

    if (message.type === 'GET_FRONTEND_ANALYSIS') {
        if (!self.mcpClient?.detectFrontendStack) {
            sendResponse({ error: '统一框架检测器未就绪' });
            return true;
        }
        self.mcpClient.detectFrontendStack({ tabId: message.tabId }).then(sendResponse).catch(error => {
            sendResponse({ error: error.message });
        });
        return true;
    }
    
    // 🆕 处理全局请求头更新
    if (message.type === 'UPDATE_GLOBAL_HEADERS') {
        updateGlobalHeaders(message.headers);
        // 更新扩展图标徽章显示请求头数量
        updateHeadersBadge(message.headers ? message.headers.length : 0);
        sendResponse({success: true});
        return true;
    }
    
    // 🆕 处理脚本注册更新请求（支持全局模式）
    if (message.type === 'update_scripts_registration') {
        const isGlobalMode = message.isGlobalMode || false;
        const hostname = message.hostname;
        const enabledScripts = message.enabledScripts;
        
        registerScripts(hostname, enabledScripts, isGlobalMode);
        sendResponse({success: true});
        return true;
    }
    
    // 处理 Vue Router 数据
    if (message.type === 'VUE_ROUTER_DATA' && sender.tab) {
        try {
            const hostname = new URL(sender.tab.url).hostname;
            const storageKey = `${hostname}_vue_data`;
            
            // 存储 Vue Router 数据
            chrome.storage.local.set({
                [storageKey]: {
                    ...message.data,
                    timestamp: Date.now()
                }
            });
            
            // 转发给所有打开的popup（如果有的话）
            chrome.runtime.sendMessage({
                type: 'VUE_ROUTER_DATA_UPDATE',
                hostname: hostname,
                data: message.data
            }).catch(() => {
                // popup未打开，忽略错误
            });
        } catch (e) {
            console.error('[AntiDebug] Failed to store Vue Router data:', e);
        }
        
        sendResponse({success: true});
        return true;
    }
    
    return true;
});

// 监听标签切换事件
chrome.tabs.onActivated.addListener((activeInfo) => {
    chrome.tabs.get(activeInfo.tabId, (tab) => {
        if (tab.url) {
            updateBadgeForTab(tab);
        }
    });
});

chrome.tabs.onRemoved.addListener(tabId => {
    const timer = apiBadgeTimers.get(tabId);
    if (timer) clearTimeout(timer);
    apiBadgeTimers.delete(tabId);
    staticAnalysisJobs.delete(tabId);
    candidateProbeJobs.delete(tabId);
    const pendingWrites = tabCacheWriteQueues.get(tabId) || Promise.resolve();
    pendingWrites.catch(() => {}).finally(() => {
        tabCacheWriteQueues.delete(tabId);
        return chrome.storage.local.remove([
            apiStorageKey(tabId),
            apiStorageTraceKey(tabId),
        staticApiStorageKey(tabId),
        `${FRONTEND_ANALYSIS_STORAGE_PREFIX}${tabId}`,
        apiProbeStorageKey(tabId)
        ]);
    }).catch(error => console.warn('[AntiDebug] 清理已关闭标签页缓存失败:', error));
});

// 监听标签URL变化 - 关键修改：只在页面加载完成后更新徽章
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // 只在页面加载完成后更新徽章
    if (changeInfo.status === 'complete') {
        updateBadgeForTab(tab);
    }
    
    // 页面刷新、登录跳转时保留接口记录；仅清理会失效的 Vue Router 数据。
    // 接口由用户主动“清空”，避免刚捕获就因导航被删除。
    if (changeInfo.status === 'loading' && tab.url) {
        try {
            const hostname = new URL(tab.url).hostname;
            const storageKey = `${hostname}_vue_data`;
            chrome.storage.local.remove([storageKey]);
            const nextOrigin = new URL(tab.url).origin;
            const apiKey = apiStorageKey(tabId);
            chrome.storage.local.get([apiKey]).then(result => {
                const previousPageUrl = result[apiKey]?.pageUrl;
                if (!previousPageUrl) return;
                try {
                    if (new URL(previousPageUrl).origin !== nextOrigin) {
                        chrome.storage.local.remove([apiKey, apiStorageTraceKey(tabId), staticApiStorageKey(tabId), apiProbeStorageKey(tabId)]);
                    }
                } catch (_) {}
            });
        } catch (e) {
            // chrome:// 等内部页不会沿用上一站点的接口结果。
            chrome.storage.local.remove([apiStorageKey(tabId), apiStorageTraceKey(tabId), staticApiStorageKey(tabId), apiProbeStorageKey(tabId)]);
        }
    }
});

// 处理消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'tab_updated') {
        updateBadgeForTab(message.tab);
    }
});

// 🆕 更新标签页徽章（支持全局模式）
function updateBadgeForTab(tab) {
    if (!tab.url) return;

    try {
        // 🆕 获取全局模式状态
        chrome.storage.local.get([GLOBAL_MODE_KEY, GLOBAL_SCRIPTS_KEY], (result) => {
            const mode = result[GLOBAL_MODE_KEY] || 'standard';
            
            if (mode === 'global') {
                // 全局模式：显示全局脚本数量
                const globalScripts = result[GLOBAL_SCRIPTS_KEY] || [];
                const validCount = globalScripts.filter(
                    id => typeof id === 'string' && id.trim() !== ''
                ).length;
                updateBadge(tab.id, validCount);
            } else {
                // 标准模式：显示当前域名脚本数量
                const hostname = new URL(tab.url).hostname;
                chrome.storage.local.get([hostname], (domainResult) => {
                    const enabledScripts = domainResult[hostname] || [];
                    const validCount = enabledScripts.filter(
                        id => typeof id === 'string' && id.trim() !== ''
                    ).length;
                    updateBadge(tab.id, validCount);
                });
            }
        });
    } catch (error) {
        console.error('Error updating badge for tab:', tab, error);
    }
}

// 更新特定域名的徽章
function updateBadgeForHostname(hostname, count) {
    chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
            if (tab.url) {
                try {
                    const tabHostname = new URL(tab.url).hostname;
                    if (tabHostname === hostname) {
                        updateBadge(tab.id, count);
                    }
                } catch (e) {
                    // 忽略URL解析错误
                }
            }
        });
    });
}

// 🆕 全局请求头数量缓存
let globalHeadersCount = 0;

// 设置徽章文本（脚本数量 + 请求头数量）
function updateBadge(tabId, scriptCount) {
    const totalCount = scriptCount + globalHeadersCount;
    console.log('[AntiDebug] updateBadge: tabId=', tabId, ', scriptCount=', scriptCount, ', globalHeadersCount=', globalHeadersCount, ', total=', totalCount);
    if (totalCount > 0) {
        chrome.action.setBadgeText({text: totalCount.toString(), tabId});
        const color = globalHeadersCount > 0 ? '#30d158' : '#c7a36a';
        chrome.action.setBadgeBackgroundColor({color: color, tabId});
    } else {
        chrome.action.setBadgeText({text: '', tabId});
    }
}

function apiStorageKey(tabId) {
    return `${API_STORAGE_PREFIX}${tabId}`;
}

function apiStorageTraceKey(tabId) {
    return `${API_STORAGE_TRACE_PREFIX}${tabId}`;
}

async function getApiAnalysisForTab(tabId) {
    let resolvedTabId = tabId;
    if (!resolvedTabId) {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        resolvedTabId = tabs[0]?.id;
    }
    if (!resolvedTabId) return { requests: [], endpoints: [], totalCaptured: 0 };
    const key = apiStorageKey(resolvedTabId);
    const traceKey = apiStorageTraceKey(resolvedTabId);
    const staticKey = staticApiStorageKey(resolvedTabId);
    const result = await chrome.storage.local.get([key, traceKey, staticKey]);
    const analysis = result[key] || { tabId: resolvedTabId, requests: [], endpoints: [], totalCaptured: 0 };
    const storageTraces = result[traceKey] || [];
    const visibleRequests = (analysis.requests || []).filter(request => !isExcludedApiNoise(request));
    const visibleEndpoints = rebuildCapturedEndpoints(visibleRequests);
    return {
        ...analysis,
        requests: visibleRequests,
        endpoints: visibleEndpoints,
        hiddenNoiseCount: Math.max(0, (analysis.requests || []).length - visibleRequests.length),
        storageTraces,
        intelligence: self.apiAnalyzer.buildEndpointIntelligence?.(visibleRequests, storageTraces, result[staticKey]?.stringEvidence || {}) || { clients: [], reconstructions: [], runtimeEvidence: [] }
    };
}

async function clearApiAnalysisForTab(tabId) {
    if (!tabId) return;
    await chrome.storage.local.remove([apiStorageKey(tabId), apiStorageTraceKey(tabId)]);
    updateBadgeForTab(await chrome.tabs.get(tabId));
}

function staticApiStorageKey(tabId) {
    return `${STATIC_API_STORAGE_PREFIX}${tabId}`;
}

function apiProbeStorageKey(tabId) {
    return `${API_PROBE_STORAGE_PREFIX}${tabId}`;
}

const candidateProbeJobs = new Map();

function classifyProbeResponse(status, contentType, responseUrl, pageUrl) {
    if (status === 401 || status === 403) return { state: 'exists-auth', label: '接口存在，需要鉴权', confidence: .98 };
    if (status === 405) return { state: 'exists-method', label: '接口存在，HEAD 方法不允许', confidence: .96 };
    if (status === 400 || status === 409 || status === 415 || status === 422) return { state: 'exists-params', label: '接口存在，需要参数或请求格式', confidence: .95 };
    if (status === 404 || status === 410) return { state: 'missing', label: '未发现接口', confidence: .92 };
    if (status >= 500) return { state: 'server-error', label: '服务端响应异常，接口可能存在', confidence: .75 };
    if (status >= 200 && status < 300) {
        let redirectedToLogin = false;
        try { redirectedToLogin = /(?:login|signin|auth)/i.test(new URL(responseUrl).pathname) && !/(?:login|signin|auth)/i.test(new URL(pageUrl).pathname); } catch (_) {}
        if (redirectedToLogin) return { state: 'redirect-auth', label: '跳转到登录页，接口可能存在', confidence: .82 };
        if (/text\/html/i.test(contentType || '')) return { state: 'html-fallback', label: '返回 HTML，可能是前端兜底', confidence: .55 };
        return { state: 'alive', label: '接口存活', confidence: .95 };
    }
    if (status >= 300 && status < 400) return { state: 'redirect', label: '接口发生重定向', confidence: .75 };
    return { state: 'unknown', label: `HTTP ${status || 0}`, confidence: .4 };
}

function reusableProbeHeaders(origin) {
    const profile = sameOriginHeaderProfiles[origin];
    const headers = {};
    for (const header of Object.values(profile?.headers || {})) {
        if (!header?.value || header.category === 'browser' || header.category === 'tracing') continue;
        if (/^(?:host|content-length|cookie|origin|referer|sec-|connection|accept-encoding)/i.test(header.name || '')) continue;
        if (header.shareable || header.category === 'custom' || header.category === 'identity') headers[header.name] = header.value;
    }
    return headers;
}

async function probeCandidate(candidate, pageUrl, allowedOrigins, timeoutMs) {
    const url = new URL(candidate.url);
    if (!allowedOrigins.has(url.origin)) throw new Error(`候选超出页面证据范围: ${url.origin}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
        const response = await fetch(url.href, {
            method: 'HEAD',
            headers: reusableProbeHeaders(url.origin),
            credentials: 'include',
            cache: 'no-store',
            redirect: 'follow',
            signal: controller.signal
        });
        const contentType = response.headers.get('content-type') || '';
        const classification = classifyProbeResponse(response.status, contentType, response.url, pageUrl);
        return {
            candidateId: candidate.id,
            url: url.href,
            originalMethod: candidate.method,
            probeMethod: 'HEAD',
            status: response.status,
            responseUrl: response.url,
            contentType,
            responseHeaders: Object.fromEntries(response.headers.entries()),
            duration: Date.now() - startedAt,
            checkedAt: Date.now(),
            ...classification
        };
    } catch (error) {
        return {
            candidateId: candidate.id,
            url: url.href,
            originalMethod: candidate.method,
            probeMethod: 'HEAD',
            status: 0,
            duration: Date.now() - startedAt,
            checkedAt: Date.now(),
            state: error?.name === 'AbortError' ? 'timeout' : 'network-error',
            label: error?.name === 'AbortError' ? '探测超时' : `网络错误：${error.message}`,
            confidence: 0,
            error: error.message
        };
    } finally {
        clearTimeout(timeout);
    }
}

async function startSafeCandidateProbe(tabId, options = {}) {
    if (!tabId) throw new Error('缺少目标 Tab');
    if (candidateProbeJobs.has(tabId)) return { accepted: true, started: false, status: 'running' };
    const key = staticApiStorageKey(tabId);
    const stored = await chrome.storage.local.get([key, apiProbeStorageKey(tabId)]);
    const analysis = stored[key];
    if (!analysis?.discovery?.candidates?.length) throw new Error('请先完成 JS 自动分析');
    const tab = await chrome.tabs.get(tabId);
    const pageUrl = analysis.pageUrl || tab.url;
    const allowedOrigins = new Set((analysis.discovery.clients || []).map(client => client.origin));
    try { allowedOrigins.add(new URL(pageUrl).origin); } catch (_) {}
    const selectedIds = new Set(Array.isArray(options.candidateIds) ? options.candidateIds : []);
    const limit = Math.max(1, Math.min(200, Number(options.limit) || 80));
    const candidates = analysis.discovery.candidates.filter(candidate =>
        !candidate.confirmedByNetwork && candidate.url && (!selectedIds.size || selectedIds.has(candidate.id))
    ).slice(0, limit);
    if (!candidates.length) throw new Error('没有尚未验证的可重组候选');

    const existing = stored[apiProbeStorageKey(tabId)]?.results || [];
    const resultMap = new Map(existing.map(result => [`${result.originalMethod} ${result.url}`, result]));
    const state = { tabId, status: 'running', startedAt: Date.now(), total: candidates.length, completed: 0, results: [...resultMap.values()] };
    await writeAnalysisCache(apiProbeStorageKey(tabId), state);
    const job = (async () => {
        const concurrency = Math.max(1, Math.min(6, Number(options.concurrency) || 3));
        const timeoutMs = Math.max(2000, Math.min(30000, Number(options.timeoutMs) || 10000));
        const intervalMs = Math.max(100, Math.min(2000, Number(options.intervalMs) || 180));
        let cursor = 0;
        const workers = Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
            while (cursor < candidates.length) {
                const candidate = candidates[cursor++];
                const result = await probeCandidate(candidate, pageUrl, allowedOrigins, timeoutMs);
                resultMap.set(`${result.originalMethod} ${result.url}`, result);
                state.completed += 1;
                state.results = [...resultMap.values()].sort((a, b) => b.checkedAt - a.checkedAt).slice(0, 1000);
                await writeAnalysisCache(apiProbeStorageKey(tabId), { ...state });
                chrome.runtime.sendMessage({ type: 'API_PROBE_UPDATE', tabId, data: state }).catch(() => {});
                if (cursor < candidates.length) await new Promise(resolve => setTimeout(resolve, intervalMs));
            }
        });
        await Promise.all(workers);
        state.status = 'complete';
        state.completedAt = Date.now();
        await writeAnalysisCache(apiProbeStorageKey(tabId), state);
        chrome.runtime.sendMessage({ type: 'API_PROBE_UPDATE', tabId, data: state }).catch(() => {});
        return state;
    })().finally(() => candidateProbeJobs.delete(tabId));
    candidateProbeJobs.set(tabId, job);
    return { accepted: true, started: true, status: 'running', total: candidates.length };
}

function decodeJsString(value) {
    return String(value || '')
        .replace(/\\\//g, '/')
        .replace(/\\n|\\r|\\t/g, '')
        .replace(/\\(['"`\\])/g, '$1');
}

function resolveStaticExpression(expression, constants) {
    if (!expression) return null;
    let expr = expression.trim().replace(/[;,)]\s*$/, '').trim();
    const direct = expr.match(/^(['"`])([\s\S]*?)\1$/);
    if (direct) {
        return decodeJsString(direct[2]).replace(/\$\{\s*([\w$]+)\s*\}/g, (_, name) => constants.get(name) || `{${name}}`);
    }
    if (/^[A-Za-z_$][\w$]*$/.test(expr)) return constants.get(expr) || `{${expr}}`;
    const parts = expr.split(/\s*\+\s*/);
    if (parts.length > 1) {
        const values = parts.map(part => resolveStaticExpression(part, constants));
        if (values.every(value => value != null)) return values.join('');
    }
    return null;
}

function isLowInformationPath(value) {
    if (typeof value !== 'string' || !value) return true;
    let pathname = value.replace(/[?#].*$/, '');
    try { pathname = new URL(value, 'https://antidebug.invalid/').pathname; } catch (_) {}
    const segments = pathname.split('/').filter(Boolean).map(segment => {
        try { return decodeURIComponent(segment); } catch (_) { return segment; }
    });
    if (!segments.length) return true;
    if (segments.some(segment => /^(?:api|apis|rest|openapi|gateway|graphql|oauth|auth|login|logout|admin|user|users|upload|download|config|internal|debug|v\d+)$/i.test(segment))) return false;
    if (segments.some(segment => /[{}:$]/.test(segment) || /\d{2,}/.test(segment))) return false;
    const lexical = segments.filter(segment => !/^v\d+$/i.test(segment));
    return lexical.length > 0 && lexical.every(segment => segment.length <= 2);
}

function looksLikeStaticEndpoint(value) {
    return typeof value === 'string' && value.length < 1200 && !isLowInformationPath(value) && (
        /^(?:https?:)?\/\//i.test(value) ||
        /^\/(?:[\w{}.-]+\/)*[\w{}.-]+(?:\?.*)?$/.test(value) ||
        /\/(?:api|rest|gateway|openapi|graphql|v\d+)(?:\/|$)/i.test(value)
    );
}

function joinApiBase(base, route, pageUrl) {
    try {
        if (/^https?:\/\//i.test(route)) return route;
        const parsedBase = new URL(base, pageUrl);
        if (!route.startsWith('/')) return new URL(route, parsedBase.href.endsWith('/') ? parsedBase.href : `${parsedBase.href}/`).href;
        const basePath = parsedBase.pathname.replace(/\/$/, '');
        if (basePath && basePath !== '/' && !route.startsWith(`${basePath}/`) && /\/(?:api|v\d+|gateway|rest)/i.test(basePath)) {
            return `${parsedBase.origin}${basePath}${route}`;
        }
        return `${parsedBase.origin}${route}`;
    } catch (_) {
        try { return new URL(route, pageUrl).href; } catch { return route; }
    }
}

function analyzeJavaScriptHeuristically(scripts, pageUrl, runtimeRequests = []) {
    const endpoints = [];
    const baseCandidates = new Set();

    for (const script of scripts) {
        const content = script.content || '';
        for (const match of content.matchAll(/https?:\\?\/\\?\/[^\s"'`<>\\]{4,500}/gi)) {
            const value = decodeJsString(match[0]);
            try {
                const parsed = new URL(value.replace(/[),;]+$/, ''));
                if (/\/(?:api|gateway|rest)(?:\/v\d+)?\/?$/i.test(parsed.pathname) || /\/v\d+\/?$/i.test(parsed.pathname)) {
                    baseCandidates.add(parsed.href.replace(/\/$/, ''));
                }
            } catch (_) {}
        }
        for (const match of content.matchAll(/(?:baseURL|baseUrl|apiBase|apiPrefix|API_BASE|VITE_[A-Z0-9_]*API[A-Z0-9_]*)\s*[:=]\s*(['"`])([\s\S]{1,500}?)\1/g)) {
            const value = decodeJsString(match[2]);
            if (value) baseCandidates.add(value);
        }
    }

    for (const script of scripts) {
        const content = script.content || '';
        if (!content) continue;
        const constants = new Map();
        for (let pass = 0; pass < 3; pass += 1) {
            for (const match of content.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]{1,500})/g)) {
                const value = resolveStaticExpression(match[2], constants);
                if (value != null && value.length < 1200) constants.set(match[1], value);
            }
        }

        const scriptBaseCandidates = new Set();
        const clientBases = new Map();
        for (const match of content.matchAll(/(?:baseURL|baseUrl|apiBase|apiPrefix|API_BASE|VITE_[A-Z0-9_]*API[A-Z0-9_]*)\s*[:=]\s*([^,;}\n]{1,500})/g)) {
            const value = resolveStaticExpression(match[1], constants);
            if (value) scriptBaseCandidates.add(value);
        }
        for (const match of content.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:axios|[A-Za-z_$][\w$]*)\.create\s*\(\s*\{[\s\S]{0,1200}?\bbaseURL\s*:\s*([^,}\n]{1,500})/g)) {
            const value = resolveStaticExpression(match[2], constants);
            if (value) {
                clientBases.set(match[1], value);
                scriptBaseCandidates.add(value);
            }
        }

        const callPatterns = [
            { regex: /\bfetch\s*\(\s*([^,\n)]{1,500})/g, method: 'GET', evidence: 'fetch()' },
            { regex: /\b([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*([^,\n)]{1,500})/gi, clientGroup: 1, methodGroup: 2, exprGroup: 3, evidence: 'HTTP client' },
            { regex: /\.open\s*\(\s*(['"])(GET|POST|PUT|PATCH|DELETE|HEAD)\1\s*,\s*([^,\n)]{1,500})/gi, methodGroup: 2, exprGroup: 3, evidence: 'XMLHttpRequest.open()' },
            { regex: /\.\s*request\s*\(\s*\{[\s\S]{0,500}?\burl\s*:\s*([^,}\n]{1,500})/gi, method: 'UNKNOWN', evidence: 'request({ url })' }
        ];

        const addCandidate = (rawValue, method, evidence, index, confidence = .82, clientName = '', callExpression = '') => {
            const value = decodeJsString(rawValue);
            if (!looksLikeStaticEndpoint(value)) return;
            const absolute = /^https?:\/\//i.test(value);
            const normalizedCandidate = value.replace(/[?#].*$/, '').replace(/^\.?\//, '/');
            const runtimeMatches = absolute ? [] : runtimeRequests.filter(request => {
                try {
                    const pathname = new URL(request.url).pathname;
                    return pathname === normalizedCandidate || pathname.endsWith(normalizedCandidate) || pathname.includes(normalizedCandidate);
                } catch (_) { return false; }
            });
            // 未被 Network 证实的相对字符串保持原样，绝不再与所有 baseURL 做笛卡尔积。
            const fullUrls = absolute ? [value] : runtimeMatches.length ? [...new Set(runtimeMatches.map(request => request.url))] : [value];
            const nearby = content.slice(index, index + 1600);
            const ignored = new Set(['url', 'method', 'headers', 'data', 'body', 'params', 'config', 'then', 'catch']);
            const fields = [...nearby.matchAll(/(?:^|[,({])\s*([A-Za-z_$][\w$-]{1,50})\s*:/g)]
                .map(match => match[1]).filter(name => !ignored.has(name)).slice(0, 100);
            const requestShape = [...new Set(fields)].map(path => ({ path, type: 'unknown', source: '相邻请求对象' }));
            const headerNames = [...nearby.matchAll(/(?:headers?\s*:\s*\{|setRequestHeader\s*\()\s*['"]?([A-Za-z][A-Za-z0-9_-]{1,80})/gi)].map(match => match[1]);
            let inferredMethod = String(method || 'UNKNOWN').toUpperCase();
            if (inferredMethod === 'GET' && evidence === 'fetch()') {
                inferredMethod = nearby.match(/\bmethod\s*:\s*['"](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"]/i)?.[1]?.toUpperCase() || 'GET';
            } else if (inferredMethod === 'UNKNOWN') {
                inferredMethod = nearby.match(/\bmethod\s*:\s*['"](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"]/i)?.[1]?.toUpperCase() || 'UNKNOWN';
            }
            // A named HTTP client owns its configured baseURL. Do not also attach
            // every other base found in the same minified bundle: large bundles
            // commonly contain several backends and that creates false joins.
            const relatedBases = clientName && clientBases.has(clientName)
                ? new Set([clientBases.get(clientName)])
                : new Set(scriptBaseCandidates);
            for (const fullUrl of fullUrls) {
                endpoints.push({
                    method: inferredMethod,
                    rawUrl: value,
                    fullUrl,
                    urlExpression: rawValue,
                    clientExpression: clientName || (evidence === 'fetch()' ? 'fetch' : ''),
                    source: script.src || `inline:${script.index ?? 0}`,
                    line: content.slice(0, index).split('\n').length,
                    evidence,
                    confidence: runtimeMatches.length ? Math.max(confidence, .97) : (absolute ? confidence : Math.min(confidence, .62)),
                    confirmedByNetwork: absolute ? runtimeRequests.some(request => request.url === fullUrl) : runtimeMatches.length > 0,
                    candidateOnly: !absolute && runtimeMatches.length === 0,
                    baseCandidates: [...relatedBases].slice(0, 24),
                    fields: [...new Set(fields)],
                    requestShape,
                    inferredHeaders: [...new Set(headerNames)],
                    bodyExpression: nearby.match(/\b(?:data|body|params)\s*:\s*([^,}\n]{1,500})/)?.[1]?.trim() || '',
                    callExpression: String(callExpression || rawValue).slice(0, 1200),
                    before: content.slice(Math.max(0, index - 240), index).replace(/\s+/g, ' '),
                    after: content.slice(index + String(callExpression || '').length, index + String(callExpression || '').length + 240).replace(/\s+/g, ' ')
                });
            }
        };

        for (const pattern of callPatterns) {
            for (const match of content.matchAll(pattern.regex)) {
                const expression = match[pattern.exprGroup || 1];
                const value = resolveStaticExpression(expression, constants);
                const method = pattern.methodGroup ? match[pattern.methodGroup] : pattern.method;
                const clientName = pattern.clientGroup ? match[pattern.clientGroup] : '';
                if (value) addCandidate(value, method, pattern.evidence, match.index || 0, .82, clientName, match[0]);
            }
        }

        // 普通路径字符串只进入 stringEvidence；没有请求调用点或 Network 事实时不升级为接口。
    }

    const unique = new Map();
    for (const endpoint of endpoints) {
        const key = `${endpoint.method} ${endpoint.fullUrl}`;
        const existing = unique.get(key);
        if (!existing || endpoint.confidence > existing.confidence) unique.set(key, endpoint);
    }
    return [...unique.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 300);
}

function collectScriptStringEvidence(scripts) {
    const baseUrls = [];
    const apiPrefixes = [];
    const businessPaths = [];
    const storageReferences = [];
    const push = (target, item, key = item.value) => {
        if (!key || target.some(existing => existing.value === key && existing.source === item.source)) return;
        target.push(item);
    };
    for (const script of scripts) {
        const content = script.content || '';
        const source = script.src || script.source || `inline:${script.index ?? 0}`;
        for (const match of content.matchAll(/(?:baseURL|baseUrl|apiBase|apiPrefix|API_BASE|VITE_[A-Z0-9_]*API[A-Z0-9_]*)\s*[:=]\s*(['"`])([\s\S]{1,500}?)\1/g)) {
            push(baseUrls, { value: decodeJsString(match[2]), source, line: content.slice(0, match.index).split('\n').length, evidence: match[0].slice(0, 600) });
        }
        for (const match of content.matchAll(/\b(?:localStorage|sessionStorage)\.(?:getItem|setItem)\s*\(\s*(['"])([^'"]{1,200})\1/g)) {
            push(storageReferences, { value: match[2], source, line: content.slice(0, match.index).split('\n').length, evidence: match[0] });
        }
        for (const match of content.matchAll(/(['"`])(\/(?:api|meta|gateway|rest|openapi|v\d+)(?:\/[^\s'"`<>]{0,500})?)\1/gi)) {
            const value = decodeJsString(match[2]);
            const target = /\/(?:api|gateway|rest|openapi|v\d+)(?:\/|$)/i.test(value) && value.split('/').filter(Boolean).length <= 3 ? apiPrefixes : businessPaths;
            push(target, { value, source, line: content.slice(0, match.index).split('\n').length, evidence: match[0] });
        }
        for (const match of content.matchAll(/(['"`])(\/[A-Za-z][A-Za-z0-9_.{}-]*(?:\/[A-Za-z0-9_.{}-]+){1,8})\1/g)) {
            const value = decodeJsString(match[2]);
            if (!isLowInformationPath(value) && !/\.(?:js|css|png|jpe?g|svg|woff2?|ttf|map)$/i.test(value)) {
                push(businessPaths, { value, source, line: content.slice(0, match.index).split('\n').length, evidence: match[0] });
            }
        }
    }
    return {
        baseUrls: baseUrls.slice(0, 100),
        apiPrefixes: apiPrefixes.slice(0, 150),
        businessPaths: businessPaths.slice(0, 300),
        storageReferences: storageReferences.slice(0, 150)
    };
}

function classifyPageResources(resources, excludedExtensions = []) {
    const extensionSet = new Set(excludedExtensions.map(item => String(item).replace(/^\./, '').toLowerCase()));
    const classify = resource => {
        if (resource.initiatorType === 'sourceMappingURL') return 'source-maps';
        let parsed;
        try { parsed = new URL(resource.name); } catch (_) { return 'other'; }
        const extension = parsed.pathname.split('.').pop()?.toLowerCase() || '';
        if (extensionSet.has(extension)) return 'ignored';
        if (/\.(?:m?js)$/i.test(parsed.pathname)) return /(?:chunk|vendor|runtime|bundle)[-_.]/i.test(parsed.pathname) ? 'chunks' : 'javascript';
        if (/\.map$/i.test(parsed.pathname)) return 'source-maps';
        if (/\.(?:wasm)$/i.test(parsed.pathname) || /worker/i.test(resource.initiatorType || '') || /worker/i.test(parsed.pathname)) return 'workers-wasm';
        if (/\.(?:css)$/i.test(parsed.pathname)) return 'styles';
        if (/\.(?:svg|png|jpe?g|gif|webp|ico)$/i.test(parsed.pathname)) return 'images';
        if (/\.(?:woff2?|ttf|otf|eot)$/i.test(parsed.pathname)) return 'fonts';
        if (/\.(?:mp4|webm|mp3|wav|m3u8)$/i.test(parsed.pathname)) return 'media';
        if (['fetch', 'xmlhttprequest', 'beacon'].includes(resource.initiatorType)) return 'api';
        return 'other';
    };
    const entries = (resources || []).map(resource => ({ ...resource, category: classify(resource) }));
    const counts = entries.reduce((output, entry) => {
        output[entry.category] = (output[entry.category] || 0) + 1;
        return output;
    }, {});
    return { counts, entries: entries.slice(0, 1000) };
}

function isJavaScriptResourceUrl(value) {
    try { return /\.(?:m?js)(?:[?#]|$)/i.test(new URL(value).href); } catch (_) { return false; }
}

async function fetchScriptSources(sources, limit = 100) {
    const selected = [...new Map((sources || []).filter(item => item?.src || item?.content).map(item => [item.src || `inline:${item.index}`, item])).values()].slice(0, limit);
    const output = [];
    for (let offset = 0; offset < selected.length; offset += 6) {
        const batch = selected.slice(offset, offset + 6);
        const rows = await Promise.all(batch.map(async script => {
            if (!script.src) return script.content ? script : null;
            try {
                const response = await fetch(script.src, { cache: 'force-cache', credentials: 'include' });
                const content = (await response.text()).slice(0, 2500000);
                return {
                    ...script,
                    content: response.ok ? content : '',
                    status: response.status,
                    contentType: response.headers.get('content-type') || '',
                    error: response.ok ? (content ? '' : '响应正文为空') : `HTTP ${response.status}`
                };
            } catch (error) {
                return { ...script, content: '', status: 0, error: error.message };
            }
        }));
        output.push(...rows.filter(Boolean));
    }
    return output;
}

function discoverReferencedChunkUrls(scripts, pageUrl) {
    const urls = new Map();
    for (const script of scripts || []) {
        const content = script.content || '';
        for (const match of content.matchAll(/(['"`])([^'"`\s]{1,500}\.(?:m?js)(?:\?[^'"`\s]*)?)\1/g)) {
            const raw = decodeJsString(match[2]);
            if (!/(?:chunk|vendor|runtime|bundle|assets|static|js\/|\.[a-f0-9]{6,}\.)/i.test(raw)) continue;
            try {
                const url = new URL(raw, script.src || pageUrl).href;
                if (!urls.has(url)) urls.set(url, { src: url, inline: false, index: `chunk:${urls.size}`, discoveredBy: script.src || script.source || 'runtime' });
            } catch (_) {}
            if (urls.size >= 150) break;
        }
        if (urls.size >= 150) break;
    }
    return [...urls.values()];
}

async function discoverSourceMaps(scripts, pageUrl) {
    const entries = [];
    const sourceScripts = [];
    for (const script of scripts.filter(item => item.content && item.index !== -1).slice(0, 100)) {
        const matches = [...script.content.matchAll(/[#@]\s*sourceMappingURL\s*=\s*([^\s*]+)/g)];
        const reference = matches.at(-1)?.[1]?.trim();
        if (!reference) continue;
        let name = reference;
        let parsedMap = null;
        let error = '';
        try {
            if (/^data:application\/json[^,]*,/i.test(reference)) {
                name = `${script.src || pageUrl}#inline-source-map`;
                const payload = reference.slice(reference.indexOf(',') + 1);
                const text = /;base64,/i.test(reference) ? atob(payload) : decodeURIComponent(payload);
                parsedMap = JSON.parse(text);
            } else {
                name = new URL(reference, script.src || pageUrl).href;
                const response = await fetch(name, { cache: 'force-cache', credentials: 'include' });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                parsedMap = JSON.parse((await response.text()).slice(0, 8000000));
            }
        } catch (sourceMapError) {
            error = sourceMapError.message;
        }
        entries.push({
            name,
            initiatorType: 'sourceMappingURL',
            sourceScript: script.src || `inline:${script.index ?? 0}`,
            sources: Array.isArray(parsedMap?.sources) ? parsedMap.sources.slice(0, 500) : [],
            sourceRoot: parsedMap?.sourceRoot || '',
            sourceCount: parsedMap?.sources?.length || 0,
            embeddedSourceCount: Array.isArray(parsedMap?.sourcesContent) ? parsedMap.sourcesContent.filter(Boolean).length : 0,
            nameCount: parsedMap?.names?.length || 0,
            error
        });
        if (Array.isArray(parsedMap?.sourcesContent)) {
            parsedMap.sourcesContent.slice(0, 300).forEach((content, index) => {
                if (!content || sourceScripts.length >= 500) return;
                const sourceName = parsedMap.sources?.[index] || `source-${index}.js`;
                let sourceUrl = sourceName;
                try { sourceUrl = new URL(sourceName, parsedMap.sourceRoot ? new URL(parsedMap.sourceRoot, name) : name).href; } catch (_) {}
                sourceScripts.push({
                    source: `sourcemap:${sourceUrl}`,
                    src: sourceUrl,
                    index: `map:${sourceScripts.length}`,
                    inline: true,
                    content: String(content).slice(0, 1500000),
                    sourceMap: name
                });
            });
        }
    }
    return {
        entries: [...new Map(entries.map(item => [item.name, item])).values()],
        scripts: sourceScripts
    };
}

function isValidChineseIdCard(value) {
    const id = String(value || '').toUpperCase();
    if (!/^\d{17}[\dX]$/.test(id) || /^(\d)\1{16}/.test(id)) return false;
    const birth = `${id.slice(6, 10)}-${id.slice(10, 12)}-${id.slice(12, 14)}`;
    const date = new Date(`${birth}T00:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== birth) return false;
    const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
    const checks = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
    const sum = weights.reduce((total, weight, index) => total + Number(id[index]) * weight, 0);
    return checks[sum % 11] === id[17];
}

function hasSensitiveFieldContext(content, index, names) {
    const nearby = content.slice(Math.max(0, index - 100), index + 100);
    return names.test(nearby);
}

function isUsefulSecretMatch(match) {
    const raw = String(match?.[0] || '');
    const value = raw.split(/[:=]/).slice(1).join('=').replace(/[\s"']/g, '');
    return value.length >= 8 && !/^(?:undefined|null|false|true|password|secret|token|changeme|example|test|\*+)$/i.test(value) && !/[<{][A-Za-z_$][^>}]*[>}]/.test(value);
}

function analyzeSecurityArtifacts(scripts, excludedDomains) {
    const algorithmPatterns = [
        ['MD5', /\bmd5\b/gi], ['SHA-1', /\bsha-?1\b/gi], ['SHA-256', /\bsha-?256\b/gi],
        ['SHA-512', /\bsha-?512\b/gi], ['SHA', /\bsha(?:224|384)?\b/gi],
        ['AES', /\baes(?:128|192|256)?\b/gi], ['DES/3DES', /\b(?:des|tripledes|3des)\b/gi],
        ['RSA', /\brsa\b|BEGIN (?:RSA )?PUBLIC KEY/gi],
        ['SM2', /\bsm2\b/gi], ['SM3', /\bsm3\b/gi], ['SM4', /\bsm4\b/gi],
        ['bcrypt', /\bbcrypt\b|\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/g],
        ['Base64', /\b(?:base64|btoa|atob)\b/gi]
    ];
    const sensitivePatterns = [
        { type: 'JWT', regex: /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{5,}\b/g, confidence: '高', reason: '符合 JWT 三段结构' },
        { type: 'Authorization/Token', regex: /["']?(?:authorization|access[_-]?token|auth[_-]?token)["']?\s*[:=]\s*(["'])[^"'\\\r\n]{8,}\1/gi, validate: isUsefulSecretMatch, confidence: '高', reason: '身份字段直接绑定了引号包裹的非占位常量' },
        { type: 'API Key/Secret', regex: /["']?(?:api[_-]?key|client[_-]?secret|secret[_-]?key)["']?\s*[:=]\s*(["'])[^"'\\\r\n]{8,}\1/gi, validate: isUsefulSecretMatch, confidence: '高', reason: '密钥字段直接绑定了引号包裹的非占位常量' },
        { type: 'bcrypt 密码哈希', regex: /["']?(?:password|passwd|pwd|passwordHash|hashedPassword)["']?\s*[:=]\s*(["'])\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}\1/gi, confidence: '高', reason: '密码字段与标准 bcrypt 60 字符哈希常量同时命中；bcrypt 为带盐单向哈希，不能直接解密' },
        { type: 'bcrypt 哈希', regex: /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/g, validate: (match, content) => !hasSensitiveFieldContext(content, match.index || 0, /(?:password|passwd|pwd|passwordHash|hashedPassword)/i), confidence: '高', reason: '符合 bcrypt 版本、cost 与 53 字符 salt/hash 结构；属于单向哈希，不能直接解密' },
        { type: '硬编码密码', regex: /["']?(?:password|passwd|pwd)["']?\s*[:=]\s*(["'])([^"'\\\r\n]{8,})\1/g, validate: match => isUsefulSecretMatch(match) && !/\$2[aby]\$/.test(match[0]) && !/\s/.test(match[2] || '') && /[A-Za-z]/.test(match[2] || '') && /(?:\d|[^A-Za-z0-9])/.test(match[2] || ''), confidence: '高', reason: '小写密码字段直接绑定了无空白、同时含字母与数字/符号的常量；变量、表单绑定、空值和国际化文案不会命中' },
        { type: '私钥', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, confidence: '高', reason: '私钥 PEM 头' },
        { type: '邮箱', regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, confidence: '中', reason: '完整邮箱格式' },
        { type: '中国手机号', regex: /(?<!\d)1[3-9]\d{9}(?!\d)/g, validate: (match, content) => hasSensitiveFieldContext(content, match.index || 0, /(?:phone|mobile|tel|手机号|电话|联系方式)/i), confidence: '中', reason: '号码格式有效且附近存在手机号字段语义' },
        { type: '身份证号', regex: /(?<!\d)\d{17}[\dXx](?!\d)/g, validate: match => isValidChineseIdCard(match[0]), confidence: '高', reason: '出生日期与 MOD 11-2 校验位均有效' }
    ];
    const algorithms = [];
    const findings = [];
    const flows = [];
    const urls = [];
    const makeLocation = (script, content, match) => {
        const index = match.index || 0;
        return {
            source: script.src || script.source || `inline:${script.index ?? 0}`,
            line: content.slice(0, index).split('\n').length,
            match: String(match[0]).slice(0, 180),
            before: content.slice(Math.max(0, index - 100), index).replace(/\s+/g, ' '),
            after: content.slice(index + String(match[0]).length, index + String(match[0]).length + 100).replace(/\s+/g, ' ')
        };
    };

    for (const script of scripts) {
        const content = script.content || '';
        if (!content) continue;
        const sourceAssignments = [...content.matchAll(/(?:\b(?:const|let|var)\s+|(?:^|[;,{}])\s*)([A-Za-z_$][\w$]*)\s*=\s*((?:window\.)?location\.(?:search|hash|href)|document\.(?:URL|documentURI|referrer|cookie)|(?:localStorage|sessionStorage)\.getItem\([^)]*\)|[A-Za-z_$][\w$]*\.data)\b/g)];
        const sinkDefinitions = [
            ['DOM HTML 注入', name => new RegExp(`(?:innerHTML|outerHTML)\\s*=\\s*[^;]{0,160}\\b${name}\\b|insertAdjacentHTML\\s*\\([^)]{0,200}\\b${name}\\b`, 'g'), '浏览器输入流向 HTML 解析位置'],
            ['动态代码执行', name => new RegExp(`(?:eval|Function|setTimeout|setInterval)\\s*\\([^)]{0,160}\\b${name}\\b`, 'g'), '浏览器输入流向动态代码执行位置'],
            ['导航 / 开放跳转', name => new RegExp(`(?:location\\.(?:href|assign|replace)\\s*(?:=|\\()|window\\.open\\s*\\()[^;)]{0,160}\\b${name}\\b`, 'g'), '浏览器输入流向页面导航位置'],
            ['文档写入', name => new RegExp(`document\\.(?:write|writeln)\\s*\\([^)]{0,160}\\b${name}\\b`, 'g'), '浏览器输入流向 document.write']
        ];
        for (const sourceMatch of sourceAssignments.slice(0, 120)) {
            const variable = sourceMatch[1].replace(/[$]/g, '\\$&');
            const searchStart = (sourceMatch.index || 0) + sourceMatch[0].length;
            const searchWindow = content.slice(searchStart, searchStart + 20000);
            for (const [type, regexFactory, reason] of sinkDefinitions) {
                const sinkMatch = regexFactory(variable).exec(searchWindow);
                if (!sinkMatch) continue;
                const absoluteIndex = searchStart + (sinkMatch.index || 0);
                const location = makeLocation(script, content, { 0: sinkMatch[0], index: absoluteIndex });
                flows.push({
                    type,
                    confidence: '中',
                    reason: `${reason}；同一变量 ${sourceMatch[1]} 从 ${sourceMatch[2]} 传播到 sink，属于待验证数据流而非漏洞结论`,
                    sourceExpression: sourceMatch[2],
                    variable: sourceMatch[1],
                    ...location
                });
                if (flows.length >= 100) break;
            }
            if (flows.length >= 100) break;
        }
        for (const [name, regex] of algorithmPatterns) {
            regex.lastIndex = 0;
            for (const match of content.matchAll(regex)) {
                algorithms.push({ algorithm: name, ...makeLocation(script, content, match) });
                if (algorithms.length >= 200) break;
            }
            if (algorithms.length >= 200) break;
        }
        for (const pattern of sensitivePatterns) {
            const { type, regex } = pattern;
            regex.lastIndex = 0;
            for (const match of content.matchAll(regex)) {
                if (pattern.validate && !pattern.validate(match, content)) continue;
                findings.push({ type, confidence: pattern.confidence, reason: pattern.reason, ...makeLocation(script, content, match) });
                if (findings.length >= 150) break;
            }
            if (findings.length >= 150) break;
        }
        for (const match of content.matchAll(/https?:\\?\/\\?\/[^\s"'`<>]{4,1000}/gi)) {
            const raw = decodeJsString(match[0]).replace(/[),;]+$/, '');
            try {
                const parsed = new URL(raw);
                const excluded = excludedDomains.some(domain => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`));
                if (!excluded) urls.push({ url: parsed.href, ...makeLocation(script, content, match) });
            } catch (_) {}
            if (urls.length >= 300) break;
        }
    }

    const dedupe = (items, keyOf) => [...new Map(items.map(item => [keyOf(item), item])).values()];
    return {
        algorithms: dedupe(algorithms, item => `${item.algorithm}|${item.source}|${item.line}`),
        findings: dedupe(findings, item => `${item.type}|${item.source}|${item.line}|${item.match}`),
        flows: dedupe(flows, item => `${item.type}|${item.source}|${item.line}|${item.variable}`),
        urls: dedupe(urls, item => item.url)
    };
}

async function analyzePageJavaScript(tabId) {
    const tab = await chrome.tabs.get(tabId);
    const pageResult = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => ({
            pageUrl: location.href,
            html: (document.documentElement?.outerHTML || '').slice(0, 2500000),
            resources: performance.getEntriesByType('resource').map(entry => ({
                name: entry.name,
                initiatorType: entry.initiatorType || 'other',
                duration: Math.round(entry.duration || 0),
                transferSize: entry.transferSize || 0
            })),
            domResources: [...document.querySelectorAll('script[src],link[href],img[src],source[src],video[src],audio[src]')].map(element => ({
                name: element.src || element.href,
                initiatorType: element.tagName.toLowerCase(),
                duration: 0,
                transferSize: 0
            })).filter(item => item.name),
            storageSnapshot: {
                localStorage: Object.fromEntries(Object.entries(localStorage).slice(0, 1000)),
                sessionStorage: Object.fromEntries(Object.entries(sessionStorage).slice(0, 1000)),
                runtimeConfig: Object.fromEntries(['__ENV__', '__CONFIG__', '__INITIAL_STATE__', 'env', 'config'].flatMap(key => {
                    try {
                        const value = window[key];
                        if (value == null) return [];
                        return [[key, typeof value === 'string' ? value.slice(0, 250000) : JSON.stringify(value).slice(0, 250000)]];
                    } catch (_) { return []; }
                }))
            },
            connectionHints: [
                ...[...document.querySelectorAll('link[rel="preconnect"],link[rel="dns-prefetch"]')].map(link => ({ value: link.href, type: link.rel, source: 'document.link', confidence: .72 })),
                ...[...document.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]')].flatMap(meta => (meta.content.match(/https?:\/\/[^\s;]+/g) || []).map(value => ({ value, type: 'csp-connect-src', source: 'meta CSP', confidence: .78 }))),
                ...(navigator.serviceWorker?.controller?.scriptURL ? [{ value: navigator.serviceWorker.controller.scriptURL, type: 'service-worker', source: 'navigator.serviceWorker.controller', confidence: .7 }] : [])
            ],
            scripts: [...document.scripts].map((script, index) => ({
                index,
                src: script.src || null,
                inline: !script.src,
                content: !script.src ? (script.textContent || '').slice(0, 1200000) : ''
            }))
        })
    });
    const pageData = pageResult[0]?.result || { pageUrl: tab.url, scripts: [] };
    const resourceScripts = (pageData.resources || []).filter(resource => isJavaScriptResourceUrl(resource.name)).map((resource, index) => ({
        src: resource.name, inline: false, index: `resource:${index}`, discoveredBy: resource.initiatorType || 'performance'
    }));
    const fetchedScripts = await fetchScriptSources([...(pageData.scripts || []), ...resourceScripts], 160);
    const referencedChunks = discoverReferencedChunkUrls(fetchedScripts, pageData.pageUrl || tab.url)
        .filter(chunk => !fetchedScripts.some(script => script.src === chunk.src));
    const chunkScripts = await fetchScriptSources(referencedChunks, 120);
    const initialScripts = [...fetchedScripts, ...chunkScripts];
    const sourceMapDiscovery = await discoverSourceMaps(initialScripts, pageData.pageUrl || tab.url);
    const scripts = [
        ...(pageData.html ? [{ source: `document:${pageData.pageUrl}`, content: pageData.html, index: -1 }] : []),
        ...initialScripts,
        ...sourceMapDiscovery.scripts
    ];
    const runtimeAnalysis = await getApiAnalysisForTab(tabId);
    let endpoints = analyzeJavaScriptHeuristically(scripts, pageData.pageUrl || tab.url, runtimeAnalysis.requests || []);
    let astEngine = 'browser-evidence';
    if (self.mcpClient?.isConnected?.() && self.mcpClient?.analyzeScriptsLocally) {
        try {
            const astResult = await self.mcpClient.analyzeScriptsLocally({
                pageUrl: pageData.pageUrl || tab.url,
                scripts: scripts.filter(item => item.index !== -1 && item.content).slice(0, 40).map(item => ({ ...item, content: item.content.slice(0, 1500000) }))
            });
            astEngine = astResult.engine || 'babel-ast';
            const astCandidates = (astResult.endpoints || []).map(endpoint => {
                const absolute = /^https?:\/\//i.test(endpoint.url || '');
                const normalized = String(endpoint.url || '').replace(/[?#].*$/, '').replace(/^\.?\//, '/');
                const matches = absolute ? (runtimeAnalysis.requests || []).filter(request => request.url === endpoint.url) : (runtimeAnalysis.requests || []).filter(request => {
                    try { const path = new URL(request.url).pathname; return path === normalized || path.endsWith(normalized) || path.includes(normalized); } catch (_) { return false; }
                });
                return {
                    ...endpoint,
                    rawUrl: endpoint.url,
                    fullUrl: matches[0]?.url || endpoint.url,
                    confirmedByNetwork: matches.length > 0,
                    candidateOnly: !matches.length && !absolute,
                    confidence: matches.length ? .99 : Math.min(endpoint.confidence || .7, absolute ? .82 : .68),
                    evidence: `Babel AST · ${endpoint.evidence || '调用表达式'}`,
                    fields: endpoint.fields || []
                };
            });
            const merged = new Map();
            for (const endpoint of [...endpoints, ...astCandidates]) {
                const key = `${endpoint.method || 'UNKNOWN'} ${endpoint.fullUrl || endpoint.rawUrl}`;
                const existing = merged.get(key);
                if (!existing || (endpoint.confidence || 0) > (existing.confidence || 0)) merged.set(key, endpoint);
            }
            endpoints = [...merged.values()].sort((a, b) => (b.confidence || 0) - (a.confidence || 0)).slice(0, 300);
        } catch (error) {
            astEngine = `browser-evidence (${error.message})`;
        }
    }
    const stringEvidence = collectScriptStringEvidence(scripts);
    for (const [storage, values] of Object.entries(pageData.storageSnapshot || {})) {
        for (const [key, value] of Object.entries(values || {})) {
            const source = `${storage}.${key}`;
            const candidates = self.apiAnalyzer.flattenConfigValues?.(value, source) || [];
            if (!stringEvidence.storageReferences.some(item => item.value === key && item.source === source)) {
                stringEvidence.storageReferences.push({ value: key, source, line: null, evidence: '运行时 Storage 快照' });
            }
            for (const candidate of candidates) {
                const item = { value: candidate.value, source: candidate.path || source, line: null, evidence: '运行时 Storage 快照（含 JSON 递归）' };
                let target = stringEvidence.businessPaths;
                let limit = 300;
                if (/^https?:\/\//i.test(candidate.value)) {
                    try {
                        const parsed = new URL(candidate.value);
                        const segments = parsed.pathname.split('/').filter(Boolean);
                        const isAsset = /\.(?:m?js|css|map|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|mp[34]|webm)(?:$|[?#])/i.test(parsed.pathname);
                        const keySuggestsBase = /(?:^|[._-])(?:base(?:url)?|api(?:base|root|host|origin|server)|gateway|server(?:url)?|origin|host)(?:$|[._-])/i.test(item.source);
                        const pathSuggestsBase = segments.length <= 4 && /\/(?:api|meta|gateway|rest|openapi|graphql|rpc|v\d+)\/?$/i.test(parsed.pathname);
                        if (!isAsset && (parsed.pathname === '/' || keySuggestsBase || pathSuggestsBase)) {
                            target = stringEvidence.baseUrls;
                            limit = 100;
                        }
                    } catch (_) {}
                } else if (/\/(?:api|meta|gateway|rest|openapi|graphql|rpc|v\d+)(?:\/|$)/i.test(candidate.value) && candidate.value.split('/').filter(Boolean).length <= 3) {
                    target = stringEvidence.apiPrefixes;
                    limit = 150;
                }
                if (target.length < limit && !target.some(existing => existing.value === item.value && existing.source === item.source)) target.push(item);
            }
        }
    }
    const settings = await chrome.storage.local.get(['analysis_excluded_sites', 'analysis_excluded_resource_extensions']);
    const excludedDomains = [...new Set(['w3.org', 'w3c.org', 'schema.org', 'google-analytics.com', 'googletagmanager.com', 'doubleclick.net', 'adtrafficquality.google', 'cloudflareinsights.com', 'tongji-collector.dcloud.net.cn', ...(settings.analysis_excluded_sites || [])])];
    const excludedExtensions = settings.analysis_excluded_resource_extensions || ['css', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'woff', 'woff2', 'ttf', 'ico'];
    const security = analyzeSecurityArtifacts(scripts, excludedDomains);
    const discovery = self.discoveryEngine?.buildDiscoveryModel?.({
        pageUrl: pageData.pageUrl || tab.url,
        runtimeRequests: runtimeAnalysis.requests || [],
        staticEndpoints: endpoints,
        stringEvidence,
        runtimeEvidence: runtimeAnalysis.intelligence?.runtimeEvidence || [],
        connectionHints: pageData.connectionHints || []
    }) || { clients: [], candidates: [], unresolved: [], stats: {} };
    const resourceMap = new Map();
    for (const resource of [
        ...(pageData.resources || []),
        ...(pageData.domResources || []),
        ...sourceMapDiscovery.entries,
        ...(runtimeAnalysis.requests || []).map(request => ({ name: request.url, initiatorType: request.transport || 'xmlhttprequest', duration: request.duration || 0, transferSize: 0 }))
    ]) {
        if (resource?.name && !resourceMap.has(resource.name)) resourceMap.set(resource.name, resource);
    }
    const resources = classifyPageResources([...resourceMap.values()], excludedExtensions);
    const scriptDiagnostics = [...initialScripts, ...sourceMapDiscovery.scripts].map(script => ({
        source: script.src || script.source || `inline:${script.index ?? 0}`,
        discoveredBy: script.discoveredBy || (script.sourceMap ? 'source-map' : script.inline ? 'inline-script' : 'document-script'),
        status: script.status ?? (script.sourceMap ? 'embedded' : script.inline ? 'inline' : 0),
        contentType: script.contentType || '',
        bytesAnalyzed: String(script.content || '').length,
        analyzed: Boolean(script.content),
        sourceMap: script.sourceMap || '',
        error: script.error || ''
    })).slice(0, 500);
    const result = {
        analysisVersion: 13,
        tabId,
        pageUrl: pageData.pageUrl || tab.url,
        status: 'complete',
        analyzedAt: Date.now(),
        // scriptsReferenced 是 DOM/Performance/Chunk 发现次数；scriptsDiscovered
        // 是去重后的真实脚本数，避免同一 app.js 被算两次造成“8/13”假失败。
        scriptsReferenced: (pageData.scripts || []).length + resourceScripts.length + referencedChunks.length,
        scriptsDiscovered: scriptDiagnostics.length,
        // 页面 HTML 也参与安全识别，但不应被误算成一个 JS 文件。
        scriptsAnalyzed: scripts.filter(item => item.index !== -1 && item.content).length,
        scriptsFailed: scriptDiagnostics.filter(item => !item.analyzed).length,
        scriptDiagnostics,
        documentAnalyzed: Boolean(pageData.html),
        astEngine,
        endpoints,
        stringEvidence,
        discovery,
        resources,
        security
    };
    await writeAnalysisCache(staticApiStorageKey(tabId), result);
    return result;
}

const staticAnalysisJobs = new Map();

function startPageJavaScriptAnalysis(tabId) {
    if (staticAnalysisJobs.has(tabId)) return false;
    const key = staticApiStorageKey(tabId);
    const task = writeAnalysisCache(key, { tabId, status: 'running', startedAt: Date.now(), endpoints: [], security: { algorithms: [], findings: [], urls: [] } })
        .catch(error => console.warn('[AntiDebug] 无法保存 JS 分析状态，继续在内存中分析:', error))
        .then(() => analyzePageJavaScript(tabId))
        .catch(async error => {
            const failure = { tabId, status: 'error', analyzedAt: Date.now(), error: error.message, endpoints: [], security: { algorithms: [], findings: [], urls: [] } };
            await writeAnalysisCache(key, failure).catch(() => {});
            return failure;
        })
        .then(result => {
            chrome.runtime.sendMessage({ type: 'STATIC_API_ANALYSIS_UPDATE', tabId, data: result }).catch(() => {});
            return result;
        })
        .finally(() => staticAnalysisJobs.delete(tabId));
    staticAnalysisJobs.set(tabId, task);
    return true;
}

function rebuildCapturedEndpoints(requests) {
    const endpointMap = new Map();
    for (const request of requests) {
        const endpointKey = self.apiAnalyzer.endpointKey(request);
        const existing = endpointMap.get(endpointKey);
        if (!existing) {
            endpointMap.set(endpointKey, {
                ...request,
                occurrenceCount: 1,
                firstCapturedAt: request.capturedAt,
                lastCapturedAt: request.capturedAt
            });
            continue;
        }
        existing.occurrenceCount += 1;
        existing.firstCapturedAt = Math.min(existing.firstCapturedAt || request.capturedAt, request.capturedAt);
        existing.lastCapturedAt = Math.max(existing.lastCapturedAt || 0, request.capturedAt);
        if ((request.capturedAt || 0) >= (existing.capturedAt || 0)) {
            Object.assign(existing, request, {
                occurrenceCount: existing.occurrenceCount,
                firstCapturedAt: existing.firstCapturedAt,
                lastCapturedAt: existing.lastCapturedAt
            });
        }
    }
    return [...endpointMap.values()].sort((a, b) => (b.lastCapturedAt || 0) - (a.lastCapturedAt || 0));
}

function storeApiCapture(rawCapture, tabId, frameId = 0, fallbackPageUrl = '') {
    return enqueueTabCacheWrite(tabId, () => storeApiCaptureNow(rawCapture, tabId, frameId, fallbackPageUrl));
}

async function storeApiCaptureNow(rawCapture, tabId, frameId = 0, fallbackPageUrl = '') {
    const pageUrl = rawCapture.pageUrl || fallbackPageUrl;
    const analyzed = self.apiAnalyzer.analyzeRequest({
        ...rawCapture,
        tabId,
        frameId,
        capturedAt: rawCapture.capturedAt || rawCapture.completedAt || rawCapture.startedAt || Date.now(),
        source: rawCapture.source || 'runtime-monitor'
    }, pageUrl);

    // 默认统计域名和用户维护的排除域名在采集入口直接丢弃：不写缓存、
    // 不显示徽章，也不转发到 MCP。这样不会出现“先 Catch 再隐藏”。
    if (isExcludedApiNoise(analyzed)) return analyzed;

    const key = apiStorageKey(tabId);
    const current = await getApiAnalysisForTab(tabId);
    const requests = [...(current.requests || [])];
    const duplicateIndex = requests.findIndex(existing =>
        (analyzed.requestId && existing.requestId === analyzed.requestId) ||
        (existing.method === analyzed.method && existing.url === analyzed.url &&
            Math.abs((existing.startedAt || existing.capturedAt || 0) - (analyzed.startedAt || analyzed.capturedAt || 0)) < 3000)
    );
    const isNew = duplicateIndex < 0;
    if (isNew) requests.unshift(analyzed);
    else requests[duplicateIndex] = {
        ...requests[duplicateIndex],
        ...analyzed,
        headers: { ...(requests[duplicateIndex].headers || {}), ...(analyzed.headers || {}) },
        requestHeaders: { ...(requests[duplicateIndex].requestHeaders || {}), ...(analyzed.requestHeaders || {}) },
        responseHeaders: analyzed.responseHeaders || requests[duplicateIndex].responseHeaders,
        responsePreview: analyzed.responsePreview || requests[duplicateIndex].responsePreview,
        bodyPreview: analyzed.bodyPreview || requests[duplicateIndex].bodyPreview
    };
    requests.sort((a, b) => (b.capturedAt || b.startedAt || 0) - (a.capturedAt || a.startedAt || 0));
    requests.splice(API_REQUEST_LIMIT);

    const analysis = {
        tabId,
        pageUrl,
        updatedAt: Date.now(),
        totalCaptured: (current.totalCaptured || 0) + (isNew ? 1 : 0),
        requests,
        endpoints: rebuildCapturedEndpoints(requests)
    };
    await writeAnalysisCache(key, compactStoredApiAnalysis(analysis, tabId));

    if (self.mcpClient?.addNetworkRequest) self.mcpClient.addNetworkRequest(analyzed);
    showApiCapturedBadge(tabId, analyzed);
    chrome.runtime.sendMessage({
        type: 'API_CAPTURE_UPDATE',
        tabId,
        data: analysis,
        latest: analyzed
    }).catch(() => {});

    return analyzed;
}

async function handleAutoApiCapture(rawCapture, sender) {
    return storeApiCapture(rawCapture, sender.tab.id, sender.frameId ?? 0, sender.tab.url);
}

async function captureChromeNetworkRequest(details) {
    let tab;
    try { tab = await chrome.tabs.get(details.tabId); } catch (_) { tab = null; }
    return storeApiCapture({
        requestId: details.requestId,
        transport: details.type === 'ping' ? 'beacon' : details.type === 'websocket' ? 'websocket' : 'network',
        method: details.method,
        rawUrl: details.url,
        url: details.url,
        bodyPreview: decodeWebRequestBody(details.requestBody),
        pageUrl: tab?.url || details.documentUrl || details.initiator || '',
        frameUrl: details.documentUrl || details.initiator || '',
        initiator: details.initiator || '',
        startedAt: details.timeStamp,
        capturedAt: details.timeStamp,
        source: 'webRequest'
    }, details.tabId, details.frameId ?? 0, tab?.url || '');
}

function patchCapturedNetworkRequest(requestId, patch) {
    const tabId = networkRequestTabs.get(requestId);
    if (tabId == null) return Promise.resolve();
    return enqueueTabCacheWrite(tabId, () => patchCapturedNetworkRequestNow(tabId, requestId, patch));
}

async function patchCapturedNetworkRequestNow(tabId, requestId, patch) {
    const key = apiStorageKey(tabId);
    const stored = await chrome.storage.local.get([key]);
    const analysis = stored[key];
    if (!analysis?.requests?.length) return;
    const index = analysis.requests.findIndex(request => request.requestId === requestId);
    if (index < 0) return;
    analysis.requests[index] = self.apiAnalyzer.analyzeRequest({ ...analysis.requests[index], ...patch }, analysis.pageUrl || analysis.requests[index].pageUrl);
    analysis.endpoints = rebuildCapturedEndpoints(analysis.requests);
    analysis.updatedAt = Date.now();
    await writeAnalysisCache(key, compactStoredApiAnalysis(analysis, tabId));
    chrome.runtime.sendMessage({ type: 'API_CAPTURE_UPDATE', tabId, data: analysis, latest: analysis.requests[index] }).catch(() => {});
}

function showApiCapturedBadge(tabId, request) {
    const previousTimer = apiBadgeTimers.get(tabId);
    if (previousTimer) clearTimeout(previousTimer);

    chrome.action.setBadgeText({ text: 'API', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#ff9800', tabId });
    chrome.action.setTitle({
        tabId,
        title: `捕获接口：${request.method} ${request.url || request.path || request.rawUrl}`
    });

    apiBadgeTimers.set(tabId, setTimeout(async () => {
        apiBadgeTimers.delete(tabId);
        try {
            const tab = await chrome.tabs.get(tabId);
            updateBadgeForTab(tab);
            chrome.action.setTitle({ tabId, title: 'AntiDebug Breaker' });
        } catch (_) {}
    }, 3500));
}

// 🆕 更新全局请求头徽章
function updateHeadersBadge(count) {
    globalHeadersCount = count;
    console.log('[AntiDebug] 更新请求头徽章, 数量:', count, ', globalHeadersCount:', globalHeadersCount);
    
    // 更新所有标签页的徽章
    chrome.tabs.query({}, (tabs) => {
        console.log('[AntiDebug] 更新', tabs.length, '个标签页的徽章');
        tabs.forEach(tab => {
            if (tab.url) {
                updateBadgeForTab(tab);
            }
        });
    });
}

// 🆕 更新全局请求头 - 双重方案：declarativeNetRequest + content script hook
async function updateGlobalHeaders(headers) {
    const hasHeaders = headers && headers.length > 0;
    
    console.log('[AntiDebug] updateGlobalHeaders 被调用, headers:', JSON.stringify(headers));
    
    // 使用 declarativeNetRequest API（和 ModHeader 一样）
    try {
        // 先移除所有旧规则
        const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
        const ruleIdsToRemove = existingRules.map(rule => rule.id);
        
        if (ruleIdsToRemove.length > 0) {
            await chrome.declarativeNetRequest.updateDynamicRules({
                removeRuleIds: ruleIdsToRemove
            });
            console.log('[AntiDebug] 已移除旧规则:', ruleIdsToRemove);
        }
        
        if (hasHeaders) {
            const validHeaders = headers.filter(h => h.name && h.name.trim());
            
            if (validHeaders.length > 0) {
                // 为每个请求头创建操作
                const requestHeaders = validHeaders.map(h => ({
                    header: h.name.trim(),
                    operation: 'set',
                    value: h.value || ''
                }));
                
                // 使用正确的规则格式
                const rules = [{
                    id: 1,
                    priority: 1,
                    action: {
                        type: 'modifyHeaders',
                        requestHeaders: requestHeaders
                    },
                    condition: {
                        // 匹配所有 http 和 https URL
                        regexFilter: '.*',
                        resourceTypes: ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other']
                    }
                }];
                
                console.log('[AntiDebug] 添加规则:', JSON.stringify(rules, null, 2));
                
                await chrome.declarativeNetRequest.updateDynamicRules({
                    addRules: rules
                });
                
                // 验证规则是否添加成功
                const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
                console.log('[AntiDebug] ✅ 当前活动规则数量:', currentRules.length);
                console.log('[AntiDebug] 规则详情:', JSON.stringify(currentRules, null, 2));
            }
        } else {
            console.log('[AntiDebug] 已清除所有请求头规则');
        }
    } catch (error) {
        console.error('[AntiDebug] ❌ declarativeNetRequest 失败:', error.message, error.stack);
    }
    
}

// 🆕 初始化时加载全局请求头配置（只使用当前选中组）
async function initGlobalHeaders() {
    try {
        const result = await chrome.storage.local.get(['global_headers_groups', 'global_headers_data', 'current_headers_group']);
        const data = result.global_headers_data || {};
        const currentGroupId = result.current_headers_group;
        
        // 只收集当前选中组的启用请求头
        const enabledHeaders = [];
        
        if (currentGroupId && data[currentGroupId]) {
            const items = data[currentGroupId] || [];
            items.forEach(item => {
                if (item.enabled && item.name && item.name.trim()) {
                    enabledHeaders.push({
                        name: item.name.trim(),
                        value: item.value || ''
                    });
                }
            });
        }
        
        // 无论有无请求头都更新规则（确保清理旧规则）
        await updateGlobalHeaders(enabledHeaders);
        
        // 更新图标徽章
        updateHeadersBadge(enabledHeaders.length);
    } catch (error) {
        console.error('[AntiDebug] 初始化全局请求头失败:', error);
    }
}

// 在初始化时调用
initGlobalHeaders();
