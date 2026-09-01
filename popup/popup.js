document.addEventListener('DOMContentLoaded', () => {
    const pageParams = new URLSearchParams(location.search);
    const isDevToolsMode = pageParams.get('devtools') === '1';
    const requestedTabId = Number(pageParams.get('tabId')) || null;
    document.body.classList.toggle('devtools-mode', isDevToolsMode);

    // Firefox 的 DevTools 扩展面板不直接暴露 tabs API。面板中的完整工作台
    // 通过后台页执行同一组受限标签页操作，普通弹窗仍直接使用原生 API。
    const tabsApi = chrome.tabs || new Proxy({}, {
        get(_target, method) {
            return (...rawArgs) => {
                const args = [...rawArgs];
                const callback = typeof args[args.length - 1] === 'function' ? args.pop() : null;
                const request = chrome.runtime.sendMessage({
                    type: 'TABS_API_PROXY',
                    method: String(method),
                    args
                }).then(response => {
                    if (!response?.success) throw new Error(response?.error || `tabs.${String(method)} 执行失败`);
                    return response.result;
                });
                if (!callback) return request;
                request.then(result => callback(result)).catch(error => {
                    console.warn(`[AntiDebug] tabs.${String(method)} 代理失败:`, error);
                    callback(undefined);
                });
            };
        }
    });
    // ========== Toast提示功能（仅用于固定值保存） ==========
    function showToast(message = '已保存') {
        const toast = document.getElementById('toast');
        if (!toast) return;
        
        const toastMessage = toast.querySelector('.toast-message');
        if (toastMessage) {
            toastMessage.textContent = message;
        }
        
        toast.classList.add('show');
        
        // 2秒后自动隐藏
        setTimeout(() => {
            toast.classList.remove('show');
        }, 2000);
    }
    // ========================================================

    // ========== MCP连接管理 ==========
    const mcpToggle = document.getElementById('mcp-toggle');
    const mcpIndicator = document.getElementById('mcp-indicator');
    const mcpStatusText = document.getElementById('mcp-status-text');

    // 初始化MCP状态
    function initMCPStatus() {
        chrome.storage.local.get(['mcp_enabled'], (result) => {
            const enabled = result.mcp_enabled === true;
            if (mcpToggle) {
                mcpToggle.checked = enabled;
            }
            updateMCPStatusUI();
        });
    }

    // 更新MCP状态UI
    function updateMCPStatusUI() {
        chrome.runtime.sendMessage({ type: 'GET_MCP_STATUS' }, (response) => {
            if (chrome.runtime.lastError) {
                // 忽略错误
                return;
            }
            
            if (response) {
                const { connected, enabled, error, connecting, retrying, port, reconnectAttempts, nextReconnectAt } = response;
                
                if (mcpIndicator) {
                    mcpIndicator.classList.remove('connected', 'error', 'connecting');
                    if (connected) {
                        mcpIndicator.classList.add('connected');
                    } else if (error) {
                        mcpIndicator.classList.add('error');
                    } else if (connecting) {
                        mcpIndicator.classList.add('connecting');
                    }
                }
                
                if (mcpStatusText) {
                    // 移除所有状态类名
                    mcpStatusText.classList.remove('status-connected', 'status-error', 'status-disabled', 'status-connecting');
                    
                    if (!enabled) {
                        mcpStatusText.textContent = '状态：已禁用';
                        mcpStatusText.classList.add('status-disabled');
                    } else if (connected) {
                        mcpStatusText.textContent = `状态：已连接 ✓ (端口:${port})`;
                        mcpStatusText.classList.add('status-connected');
                        const livePortInput = document.getElementById('mcp-port-input');
                        if (livePortInput && document.activeElement !== livePortInput) livePortInput.value = port;
                    } else if (error) {
                        mcpStatusText.textContent = `状态：连接失败 ✗ (端口:${port})`;
                        mcpStatusText.classList.add('status-error');
                    } else if (connecting) {
                        mcpStatusText.textContent = '状态：连接中...';
                        mcpStatusText.classList.add('status-connecting');
                    } else {
                        const seconds = nextReconnectAt ? Math.max(0, Math.ceil((nextReconnectAt - Date.now()) / 1000)) : 0;
                        const attemptsInfo = reconnectAttempts > 0 ? `（第 ${reconnectAttempts} 次${retrying ? `，约 ${seconds} 秒后重试` : ''}）` : '';
                        mcpStatusText.textContent = `状态：等待连接${attemptsInfo}`;
                        mcpStatusText.classList.add('status-connecting');
                    }
                }
            }
        });
    }

    // MCP开关事件
    if (mcpToggle) {
        mcpToggle.addEventListener('change', (e) => {
            const enabled = e.target.checked;
            chrome.storage.local.set({ mcp_enabled: enabled }, () => {
                updateMCPStatusUI();
                showToast(enabled ? 'MCP已启用' : 'MCP已禁用');
            });
        });
    }

    // MCP全局操作模式开关
    const mcpGlobalToggleEl = document.getElementById('mcp-global-toggle');
    
    // 初始化MCP全局操作模式
    function initMCPGlobalMode() {
        chrome.storage.local.get(['mcp_global_mode'], (result) => {
            const globalMode = result.mcp_global_mode === true;
            if (mcpGlobalToggleEl) {
                mcpGlobalToggleEl.checked = globalMode;
            }
        });
    }
    
    if (mcpGlobalToggleEl) {
        mcpGlobalToggleEl.addEventListener('change', (e) => {
            const enabled = e.target.checked;
            chrome.storage.local.set({ mcp_global_mode: enabled }, () => {
                showToast(enabled ? '全局操作模式已启用' : '全局操作模式已禁用');
            });
        });
    }
    
    // 初始化MCP全局模式
    initMCPGlobalMode();

    // 初始化MCP
    initMCPStatus();

    // ========== MCP端口配置 ==========
    const mcpPortInput = document.getElementById('mcp-port-input');
    const mcpPortSaveBtn = document.getElementById('mcp-port-save');
    const mcpTestConnectionBtn = document.getElementById('mcp-test-connection');
    
    // 初始化MCP端口
    function initMCPPort() {
        chrome.storage.local.get(['mcp_port'], (result) => {
            const configuredPort = result.mcp_port || 9527;
            const port = configuredPort === 1719 ? 9527 : configuredPort;
            if (mcpPortInput) {
                mcpPortInput.value = port;
            }
        });
    }
    
    // 保存端口配置
    function saveMCPPort() {
        if (!mcpPortInput) return;
        
        let port = parseInt(mcpPortInput.value, 10);
        
        // 验证端口范围
        if (isNaN(port) || port < 1024 || port > 65535) {
            showToast('端口无效 (1024-65535)');
            return;
        }

        // 1719 可以继续作为 Trae 启动 MCP stdio 服务时的环境变量，
        // 但 Chromium 会以 ERR_UNSAFE_PORT 拒绝浏览器 WebSocket。
        if (port === 1719) {
            port = 9527;
            mcpPortInput.value = String(port);
            showToast('1719 被 Chromium 禁止，浏览器桥接已改用 9527');
        }
        
        chrome.storage.local.set({ mcp_port: port }, () => {
            showToast(`端口已设置为 ${port}`);
            // 重新初始化MCP连接
            chrome.storage.local.get(['mcp_enabled'], (result) => {
                if (result.mcp_enabled) {
                    // 通知background重新连接
                    chrome.runtime.sendMessage({ type: 'RECONNECT_MCP' }, () => {
                        if (chrome.runtime.lastError) {
                            // 忽略错误
                        }
                    });
                }
            });
        });
    }
    
    // 端口保存按钮点击事件
    if (mcpPortSaveBtn) {
        mcpPortSaveBtn.addEventListener('click', saveMCPPort);
    }
    
    // 端口输入框回车事件
    if (mcpPortInput) {
        mcpPortInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                saveMCPPort();
            }
        });
    }
    mcpTestConnectionBtn?.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'RECONNECT_MCP' }, () => {
            showToast('正在连接 MCP 服务…');
            setTimeout(updateMCPStatusUI, 600);
        });
    });
    
    // 初始化端口配置
    initMCPPort();
    // ========================================================

    // 定期更新MCP状态
    setInterval(updateMCPStatusUI, 3000);
    // ========================================================
    
    // 🆕 自动触发Vue重扫描
    function triggerVueRescan() {
        try {
            // 向页面发送重扫描消息
            tabsApi.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs[0]) {
                    tabsApi.sendMessage(tabs[0].id, {
                        type: 'TRIGGER_VUE_RESCAN',
                        source: 'antidebug-extension'
                    }, () => {
                        // 忽略错误，某些页面可能没有content script
                        if (chrome.runtime.lastError) {
                            // 静默处理错误
                        }
                    });
                }
            });
        } catch (error) {
            console.warn('触发Vue重扫描失败:', error);
        }
    }

    // popup打开时自动触发重扫描
    triggerVueRescan();

    // ========== Base模式偏好设置（全局持久化） ==========
    function getBaseModePreference() {
        try {
            return localStorage.getItem('antidebug_base_mode') || 'with-base';
        } catch (e) {
            return 'with-base';
        }
    }

    function setBaseModePreference(mode) {
        try {
            localStorage.setItem('antidebug_base_mode', mode);
        } catch (e) {
            console.warn('保存base模式偏好失败:', e);
        }
    }
    // ========================================================

    const scriptsGrid = document.querySelector('.scripts-grid');
    const hookContent = document.querySelector('.hook-content');
    const vueContent = document.querySelector('.vue-content');
    const mcpContent = document.querySelector('.mcp-content');
    const headersContent = document.querySelector('.headers-content');
    const settingsContent = document.querySelector('.settings-content');
    const vueScriptsList = document.querySelector('.vue-scripts-list');
    const vueRouterData = document.querySelector('.vue-router-data');
    const vueVersionBadge = document.querySelector('.vue-version-badge');
    const versionValue = document.querySelector('.vue-version-badge .version-value');
    const routesInfoBar = document.querySelector('.routes-info-bar');
    const vueTabsList = document.querySelector('.vue-tabs-list');
    const vueScriptsPanel = document.querySelector('.vue-scripts-panel');
    const vueRoutesPanel = document.querySelector('.vue-routes-panel');
    const vueEmptyHint = document.querySelector('.vue-empty-hint');
    const routesListContainer = document.querySelector('.routes-list-container');
    const noResults = document.querySelector('.no-results');
    const searchSection = document.querySelector('.search-section');
    const searchInput = document.getElementById('search-input');
    const hookNoticeContainer = document.querySelector('.hook-notice-container');
    const hookFilterEnabledBtn = document.getElementById('hook-filter-enabled');
    const hookFilterDisabledBtn = document.getElementById('hook-filter-disabled');
    const tabBtns = document.querySelectorAll('.nav-item');
    const workbenchTabs = document.querySelectorAll('.analysis-workbench-tab');
    const apiRequestFilter = document.getElementById('api-request-filter');
    const apiFailureOnly = document.getElementById('api-failure-only');
    const exportApiAnalysisBtn = document.getElementById('export-api-analysis');
    const copyParameterDictionaryBtn = document.getElementById('copy-parameter-dictionary');
    // 新的紧凑布局元素
    const vueInlineInfo = document.querySelector('.vue-inline-info');
    const routesModeInfo = document.querySelector('.routes-mode-info');
    const vueVersionInline = document.querySelector('.vue-version-inline .version-value');
    const routeToolbar = document.querySelector('.route-toolbar');
    const vueRouteSearchInput = document.getElementById('vue-route-search-input');
    const routesActionsFooter = document.querySelector('.vue-routes-panel > .routes-actions-footer');
    const copyAllPathsBtn = document.querySelector('.copy-all-paths-btn');
    const copyAllUrlsBtn = document.querySelector('.copy-all-urls-btn');
    const frontendPrimaryFramework = document.getElementById('frontend-primary-framework');
    const frontendFrameworkDetails = document.getElementById('frontend-framework-details');
    const refreshFrontendAnalysisBtn = document.getElementById('refresh-frontend-analysis');
    const autoApiAnalysisToggle = document.getElementById('auto-api-analysis-toggle');
    const apiAnalysisCount = document.getElementById('api-analysis-count');
    const apiAnalysisList = document.getElementById('api-analysis-list');
    const refreshApiAnalysisBtn = document.getElementById('refresh-api-analysis');
    const clearApiAnalysisBtn = document.getElementById('clear-api-analysis');
    const analyzePageJsBtn = document.getElementById('analyze-page-js');
    const staticApiCount = document.getElementById('static-api-count');
    const staticApiList = document.getElementById('static-api-list');
    const apiDiscoveryCount = document.getElementById('api-discovery-count');
    const apiDiscoveryList = document.getElementById('api-discovery-list');
    const discoveryTabCount = document.getElementById('discovery-tab-count');
    const probeApiCandidatesBtn = document.getElementById('probe-api-candidates');
    const clearApiProbesBtn = document.getElementById('clear-api-probes');
    const apiProbeLimit = document.getElementById('api-probe-limit');
    const sessionSnapshotName = document.getElementById('session-snapshot-name');
    const saveSessionSnapshotBtn = document.getElementById('save-session-snapshot');
    const sessionSnapshotList = document.getElementById('session-snapshot-list');
    
    // MCP全局操作模式
    const mcpGlobalToggle = document.getElementById('mcp-global-toggle');

    // 🆕 全局模式相关DOM元素
    const globalModeToggle = document.getElementById('global-mode-toggle');
    const modeText = document.querySelector('.mode-text');

    let currentTab = 'vue'; // 默认展示前端分析
    let allScripts = []; // 所有脚本数据
    let enabledScripts = []; // 启用的脚本
    let hostname = '';
    let currentTab_obj = null;
    let cachedVueDataList = []; // 在popup中缓存所有Vue实例数据（改为数组）
    let currentInstanceIndex = 0; // 当前选中的实例索引
    let isFirstVueDataDisplay = true; // 🆕 标记是否是首次显示Vue路由数据

    // 🆕 全局模式状态管理
    let isGlobalMode = false; // 当前是否为全局模式
    let globalEnabledScripts = []; // 全局模式下启用的脚本

    // 🆕 Hook板块筛选状态（'enabled' | 'disabled' | null）
    let hookFilterState = null;
    
    // 🆕 Vue路由搜索相关全局变量
    let currentVueRoutes = []; // 当前显示的所有路由
    let currentVueBaseUrl = ''; // 当前的baseUrl
    let currentVueRouterMode = 'history'; // 当前路由模式
    let currentCustomBaseValue = ''; // 当前自定义base值

    let activeWorkbenchSection = localStorage.getItem('antidebug_workbench_section') || 'network';
    let latestApiAnalysis = null;
    let latestStaticAnalysis = null;
    let latestProbeResults = null;
    let latestHeaderIntelligence = null;
    let sessionSnapshots = [];

    function escapeAnalysisText(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[char]);
    }

    function selectWorkbenchSection(section) {
        activeWorkbenchSection = section || 'network';
        localStorage.setItem('antidebug_workbench_section', activeWorkbenchSection);
        vueContent?.classList.toggle('routes-workbench-active', activeWorkbenchSection === 'routes');
        workbenchTabs.forEach(button => {
            const active = button.dataset.workbenchTab === activeWorkbenchSection;
            button.classList.toggle('active', active);
            button.setAttribute('aria-selected', String(active));
        });
        document.querySelectorAll('[data-workbench-section]').forEach(element => {
            element.classList.toggle('workbench-active', element.dataset.workbenchSection === activeWorkbenchSection);
        });
    }

    workbenchTabs.forEach(button => button.addEventListener('click', () => selectWorkbenchSection(button.dataset.workbenchTab)));
    document.querySelectorAll('[data-overview-target]').forEach(button => button.addEventListener('click', () => selectWorkbenchSection(button.dataset.overviewTarget)));
    selectWorkbenchSection(activeWorkbenchSection);

    function renderAttackSurfaceOverview() {
        const endpoints = latestApiAnalysis?.endpoints || [];
        const evidence = latestStaticAnalysis?.stringEvidence || {};
        const security = latestStaticAnalysis?.security || {};
        const resources = latestStaticAnalysis?.resources || {};
        const evidenceCount = ['baseUrls', 'apiPrefixes', 'businessPaths', 'storageReferences']
            .reduce((sum, key) => sum + (evidence[key]?.length || 0), 0);
        const securityCount = (security.algorithms?.length || 0) + (security.findings?.length || 0) + (security.flows?.length || 0);
        const sourceMapCount = resources.counts?.['source-maps'] || 0;
        const priorityPattern = /(?:auth|login|logout|register|password|reset|oauth|sso|admin|manage|permission|role|account|user|upload|import|export|download|file|graphql|swagger|openapi|debug|internal|config|secret|token)/i;
        const infrastructureNoisePattern = /(?:\/cdn-cgi\/|cloudflareinsights\.com|google-analytics\.com|googletagmanager\.com|\/rum(?:[/?#]|$)|\/beacon(?:[/?#]|$)|favicon\.ico)/i;
        const priorityItems = [];
        endpoints.forEach(endpoint => {
            const url = endpoint.responseUrl || endpoint.url || endpoint.rawUrl || '';
            if (!url || infrastructureNoisePattern.test(url)) return;
            const reasons = [];
            if (priorityPattern.test(url)) reasons.push('高价值业务语义');
            if (/^(?:POST|PUT|PATCH|DELETE)$/i.test(endpoint.method || '')) reasons.push('状态变更请求');
            if (/websocket/i.test(endpoint.transport || '')) reasons.push('WebSocket 通道');
            if (reasons.length) priorityItems.push({ value: url, reason: reasons.join(' · '), target: 'network' });
        });
        currentVueRoutes.forEach(route => {
            if (priorityPattern.test(route.path || '')) priorityItems.push({ value: route.path, reason: '高价值前端路由', target: 'routes' });
        });
        (evidence.businessPaths || []).forEach(item => {
            if (priorityPattern.test(item.value || '')) priorityItems.push({ value: item.value, reason: 'JS 中的高价值路径证据', target: 'javascript' });
        });
        (latestStaticAnalysis?.discovery?.candidates || []).filter(item => !item.confirmedByNetwork).forEach(candidate => {
            if (priorityPattern.test(candidate.url || '')) priorityItems.push({ value: candidate.url, reason: '已重组、尚未验证的高价值接口', target: 'discovery' });
        });
        const dedupedPriority = [...new Map(priorityItems.map(item => [item.value, item])).values()];
        const metrics = {
            'overview-api-count': endpoints.length,
            'overview-route-count': currentVueRoutes.length,
            'overview-evidence-count': evidenceCount,
            'overview-sensitive-count': securityCount,
            'overview-sourcemap-count': sourceMapCount,
            'overview-priority-count': dedupedPriority.length
        };
        Object.entries(metrics).forEach(([id, value]) => {
            const element = document.getElementById(id);
            if (element) element.textContent = String(value);
        });
        const list = document.getElementById('overview-findings-list');
        if (!list) return;
        const supplementary = [];
        const identityCount = latestHeaderIntelligence?.counts?.identity || 0;
        const customCount = latestHeaderIntelligence?.counts?.custom || 0;
        if (identityCount || customCount) supplementary.push({ value: `${identityCount} 个身份头 · ${customCount} 个自定义头`, reason: '检查鉴权边界与同源复用', target: 'network' });
        if (sourceMapCount) supplementary.push({ value: `${sourceMapCount} 个 Source Map`, reason: '优先还原源码、接口与密钥使用位置', target: 'resources' });
        const rows = [...supplementary, ...dedupedPriority].slice(0, 10);
        list.innerHTML = rows.length ? rows.map(item => `
            <button class="overview-finding-row" data-jump-target="${escapeAnalysisText(item.target)}">
                <span>${escapeAnalysisText(item.reason)}</span><code>${escapeAnalysisText(item.value)}</code>
            </button>`).join('') : '<div class="analysis-empty">暂未发现高价值入口；继续操作页面并捕获更多请求</div>';
        list.querySelectorAll('[data-jump-target]').forEach(button => button.addEventListener('click', () => selectWorkbenchSection(button.dataset.jumpTarget)));
    }

    function syncToggleA11y(input) {
        const label = input.closest('.toggle-switch, .mode-switch');
        if (!label) return;
        label.classList.toggle('is-on', input.checked);
        label.setAttribute('aria-label', input.checked ? '已开启' : '已关闭');
        label.title = input.checked ? '已开启，点击关闭' : '已关闭，点击开启';
    }
    document.querySelectorAll('.toggle-switch input, .mode-switch input').forEach(input => {
        syncToggleA11y(input);
        input.addEventListener('change', () => syncToggleA11y(input));
    });
    setTimeout(() => document.querySelectorAll('.toggle-switch input, .mode-switch input').forEach(syncToggleA11y), 300);

    async function loadFrontendAnalysis() {
        if (!currentTab_obj?.id) return;
        if (frontendPrimaryFramework) frontendPrimaryFramework.textContent = '检测中...';
        const result = await chrome.runtime.sendMessage({ type: 'GET_FRONTEND_ANALYSIS', tabId: currentTab_obj.id }).catch(error => ({ error: error.message }));
        if (!result || result.error) {
            if (frontendPrimaryFramework) frontendPrimaryFramework.textContent = '未识别';
            if (frontendFrameworkDetails) frontendFrameworkDetails.textContent = result?.error || '当前页面不支持脚本检测';
            return;
        }
        const primary = result.primary;
        if (frontendPrimaryFramework) {
            frontendPrimaryFramework.textContent = primary ? `${primary.name}${primary.version ? ` ${primary.version}` : ''}` : '通用网站';
        }
        const frameworkNames = (result.frameworks || []).map(item => item.name).join(' + ');
        const libraryNames = (result.libraries || []).map(item => item.name).join('、');
        if (frontendFrameworkDetails) {
            frontendFrameworkDetails.textContent = [frameworkNames || '未发现特定框架', libraryNames ? `库：${libraryNames}` : '', (result.buildTools || []).join('、')].filter(Boolean).join(' · ');
        }
    }

    function renderApiAnalysis(analysis) {
        latestApiAnalysis = analysis || latestApiAnalysis || { endpoints: [] };
        renderAttackSurfaceOverview();
        const allEndpoints = latestApiAnalysis?.endpoints || [];
        const query = (apiRequestFilter?.value || '').trim().toLowerCase();
        const endpoints = allEndpoints.filter(endpoint => {
            const status = Number(endpoint.status ?? endpoint.statusCode ?? 0);
            if (apiFailureOnly?.checked && !(status >= 400 || endpoint.error)) return false;
            if (!query) return true;
            return [endpoint.url, endpoint.responseUrl, endpoint.rawUrl, endpoint.method, endpoint.status, endpoint.statusCode, endpoint.transport]
                .some(value => String(value ?? '').toLowerCase().includes(query));
        });
        renderEndpointIntelligence(latestApiAnalysis?.intelligence);
        if (apiAnalysisCount) apiAnalysisCount.textContent = `${endpoints.length}/${allEndpoints.length} 个接口 · ${latestApiAnalysis?.totalCaptured || 0} 次捕获${latestApiAnalysis?.hiddenNoiseCount ? ` · 已隐藏 ${latestApiAnalysis.hiddenNoiseCount} 条噪音` : ''}`;
        const networkTabCount = document.getElementById('network-tab-count');
        if (networkTabCount) networkTabCount.textContent = String(allEndpoints.length);
        if (!apiAnalysisList) return;
        if (endpoints.length === 0) {
            apiAnalysisList.innerHTML = '<div class="analysis-empty">点击页面功能后，捕获结果会显示在这里</div>';
            return;
        }
        apiAnalysisList.innerHTML = endpoints.slice(0, 80).map(endpoint => {
            const fullUrl = endpoint.responseUrl || endpoint.url || endpoint.rawUrl || '';
            const requestDetails = {
                query: endpoint.query || {},
                requestHeaders: endpoint.requestHeaders || endpoint.headers || {},
                requestBody: endpoint.bodyPreview || null,
                requestShape: endpoint.requestShape || [],
                protocol: endpoint.protocol || null
            };
            const responseDetails = {
                status: endpoint.status ?? null,
                contentType: endpoint.contentType || null,
                responseHeaders: endpoint.responseHeaders || {},
                responseBody: endpoint.responsePreview || null,
                securityPosture: endpoint.responseSecurity || null
            };
            return `
            <div class="api-analysis-item status-${Number(endpoint.status ?? endpoint.statusCode ?? 0) >= 400 || endpoint.error ? 'error' : 'ok'}" data-url="${escapeAnalysisText(endpoint.url)}">
                <span class="api-method ${escapeAnalysisText(endpoint.method)}">${escapeAnalysisText(endpoint.method)}</span>
                <details class="api-detail">
                    <summary>
                        <strong class="api-full-url">${escapeAnalysisText(fullUrl)}</strong>
                        <span class="api-split">前缀 ${escapeAnalysisText(endpoint.apiPrefix || '/')} · 业务接口 ${escapeAnalysisText(endpoint.businessEndpoint || endpoint.path || '/')} · ${escapeAnalysisText(endpoint.protocol?.type || endpoint.transport || 'network')}${endpoint.protocol?.operationName ? ` · ${escapeAnalysisText(endpoint.protocol.operationName)}` : ''}</span>
                    </summary>
                    <div class="api-detail-body">
                        <div class="api-detail-row"><b>原始请求与拆分结果</b><pre>${escapeAnalysisText(JSON.stringify({ rawUrl: endpoint.rawUrl, fullUrl, baseUrl: endpoint.baseUrl, apiPrefix: endpoint.apiPrefix, businessEndpoint: endpoint.businessEndpoint }, null, 2))}</pre></div>
                        <div class="api-detail-row"><b>请求字段 / Headers / Body</b><pre>${escapeAnalysisText(JSON.stringify(requestDetails, null, 2))}</pre></div>
                        <div class="api-detail-row"><b>响应字段</b><pre>${escapeAnalysisText(JSON.stringify(responseDetails, null, 2))}</pre></div>
                        <div class="api-detail-row"><b>关联点击与调用栈</b><pre>${escapeAnalysisText(JSON.stringify(endpoint.interaction || {}, null, 2))}\n${escapeAnalysisText(endpoint.stack || '')}</pre></div>
                    </div>
                </details>
                <span class="api-capture-tag">${endpoint.transport ? 'Catch' : '分析'}</span>
                <div class="api-row-actions"><button class="api-copy-btn" data-copy-url="${escapeAnalysisText(fullUrl)}">URL</button><button class="api-curl-btn" data-endpoint-index="${allEndpoints.indexOf(endpoint)}">cURL</button></div>
            </div>
        `}).join('');
        apiAnalysisList.querySelectorAll('.api-copy-btn').forEach(button => {
            button.addEventListener('click', async event => {
                event.stopPropagation();
                await navigator.clipboard.writeText(button.dataset.copyUrl || '');
                showToast('接口 URL 已复制');
            });
        });
        apiAnalysisList.querySelectorAll('.api-curl-btn').forEach(button => {
            button.addEventListener('click', async event => {
                event.stopPropagation();
                const endpoint = allEndpoints[Number(button.dataset.endpointIndex)];
                if (!endpoint) return;
                const quote = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;
                const headers = Object.entries(endpoint.headers || {}).filter(([name]) => !/^(?:content-length|host)$/i.test(name));
                const parts = [`curl -X ${endpoint.method || 'GET'} ${quote(endpoint.responseUrl || endpoint.url || endpoint.rawUrl || '')}`];
                headers.forEach(([name, value]) => parts.push(`  -H ${quote(`${name}: ${value}`)}`));
                if (endpoint.bodyPreview) parts.push(`  --data-raw ${quote(endpoint.bodyPreview)}`);
                await navigator.clipboard.writeText(parts.join(' \\\n'));
                showToast('cURL 已复制');
            });
        });
    }

    apiRequestFilter?.addEventListener('input', () => renderApiAnalysis(latestApiAnalysis));
    apiFailureOnly?.addEventListener('change', () => renderApiAnalysis(latestApiAnalysis));
    exportApiAnalysisBtn?.addEventListener('click', () => {
        const payload = JSON.stringify(latestApiAnalysis || { endpoints: [] }, null, 2);
        const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `antidebug-api-${Date.now()}.json`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        showToast('接口分析已导出');
    });
    copyParameterDictionaryBtn?.addEventListener('click', async () => {
        const names = new Set();
        for (const endpoint of latestApiAnalysis?.endpoints || []) {
            Object.keys(endpoint.query || {}).forEach(name => names.add(name));
            (endpoint.requestShape || []).forEach(item => {
                const name = String(item.path || '').split('.').pop()?.replace(/\[\]$/, '');
                if (name) names.add(name);
            });
            const body = endpoint.bodyPreview;
            if (typeof body === 'string') {
                try { Object.keys(JSON.parse(body)).forEach(name => names.add(name)); } catch (_) {
                    try { for (const name of new URLSearchParams(body).keys()) names.add(name); } catch (_) {}
                }
            }
        }
        if (!names.size) return showToast('当前请求中没有可提取的参数名');
        await navigator.clipboard.writeText([...names].sort().join('\n'));
        showToast(`已复制 ${names.size} 个参数名`);
    });

    function currentSnapshotStorageKey() {
        let origin = hostname || 'unknown';
        try { origin = new URL(currentTab_obj?.url || '').origin; } catch (_) {}
        return `api_session_snapshots_${origin}`;
    }

    function endpointSnapshotKey(endpoint) {
        return `${String(endpoint.method || 'GET').toUpperCase()} ${endpoint.normalizedPath || endpoint.path || endpoint.url || endpoint.rawUrl || ''}`;
    }

    function renderSessionSnapshots() {
        if (!sessionSnapshotList) return;
        const currentEndpoints = latestApiAnalysis?.endpoints || [];
        const currentMap = new Map(currentEndpoints.map(endpoint => [endpointSnapshotKey(endpoint), endpoint]));
        if (!sessionSnapshots.length) {
            sessionSnapshotList.innerHTML = '<div class="analysis-empty">尚未保存会话快照；系统没有固定角色时，可按你的实际操作阶段命名</div>';
            return;
        }
        sessionSnapshotList.innerHTML = sessionSnapshots.map(snapshot => {
            const savedKeys = new Set((snapshot.endpoints || []).map(item => item.key));
            const onlyCurrent = [...currentMap.keys()].filter(key => !savedKeys.has(key));
            const onlySaved = [...savedKeys].filter(key => !currentMap.has(key));
            return `<details class="session-snapshot-item">
                <summary><strong>${escapeAnalysisText(snapshot.name)}</strong><span>${snapshot.endpoints?.length || 0} 条 · 当前新增 ${onlyCurrent.length} · 当前缺少 ${onlySaved.length}</span></summary>
                <div class="session-diff-grid">
                    <div><b>当前新增</b><pre>${escapeAnalysisText(onlyCurrent.slice(0, 120).join('\n') || '无')}</pre></div>
                    <div><b>当前未出现</b><pre>${escapeAnalysisText(onlySaved.slice(0, 120).join('\n') || '无')}</pre></div>
                </div>
                <button class="delete-session-snapshot" data-snapshot-id="${escapeAnalysisText(snapshot.id)}">删除快照</button>
            </details>`;
        }).join('');
        sessionSnapshotList.querySelectorAll('.delete-session-snapshot').forEach(button => button.addEventListener('click', async () => {
            sessionSnapshots = sessionSnapshots.filter(item => item.id !== button.dataset.snapshotId);
            await chrome.storage.local.set({ [currentSnapshotStorageKey()]: sessionSnapshots });
            renderSessionSnapshots();
        }));
    }

    async function loadSessionSnapshots() {
        const key = currentSnapshotStorageKey();
        const stored = await chrome.storage.local.get([key]);
        sessionSnapshots = Array.isArray(stored[key]) ? stored[key] : [];
        renderSessionSnapshots();
    }

    saveSessionSnapshotBtn?.addEventListener('click', async () => {
        const endpoints = latestApiAnalysis?.endpoints || [];
        if (!endpoints.length) return showToast('当前还没有真实 Network 接口可保存');
        const name = sessionSnapshotName?.value.trim() || `会话 ${sessionSnapshots.length + 1}`;
        sessionSnapshots.unshift({
            id: `session_${Date.now()}`,
            name,
            pageUrl: currentTab_obj?.url || '',
            capturedAt: Date.now(),
            endpoints: [...new Map(endpoints.map(endpoint => [endpointSnapshotKey(endpoint), {
                key: endpointSnapshotKey(endpoint), url: endpoint.url || endpoint.rawUrl || '', method: endpoint.method || 'GET'
            }])).values()]
        });
        sessionSnapshots = sessionSnapshots.slice(0, 20);
        await chrome.storage.local.set({ [currentSnapshotStorageKey()]: sessionSnapshots });
        if (sessionSnapshotName) sessionSnapshotName.value = '';
        renderSessionSnapshots();
        showToast(`已保存“${name}”攻击面快照`);
    });

    function renderEndpointIntelligence(intelligence) {
        renderSessionSnapshots();
        const clients = intelligence?.clients || [];
        const reconstructions = intelligence?.reconstructions || [];
        const count = document.getElementById('endpoint-model-count');
        const list = document.getElementById('endpoint-model-list');
        if (count) count.textContent = clients.length ? `${clients.length} 个请求客户端 · ${reconstructions.length} 条已验证` : '等待真实请求';
        if (!list) return;
        if (!clients.length) {
            list.innerHTML = '<div class="analysis-empty">至少捕获一条真实 Network 请求；多条请求会提高公共前缀判断可信度</div>';
            return;
        }
        list.innerHTML = clients.map(client => {
            const rows = reconstructions.filter(item => item.clientId === client.id).slice(0, 80);
            return `
                <details class="endpoint-client" open>
                    <summary><strong>${escapeAnalysisText(client.origin)}${escapeAnalysisText(client.apiPrefix === '/' ? '' : client.apiPrefix)}</strong><span>${client.requestCount} 条请求 · 前缀可信度 ${Math.round((client.confidence || 0) * 100)}%</span></summary>
                    <div class="endpoint-client-source">来源：${escapeAnalysisText(client.source || 'Network 多请求联合分析')}</div>
                    ${rows.map(item => `
                        <details class="endpoint-reconstruction">
                            <summary><span class="api-method ${escapeAnalysisText(item.method)}">${escapeAnalysisText(item.method)}</span><strong>${escapeAnalysisText(item.url)}</strong><span class="verified-badge">Network 已验证</span></summary>
                            <div class="reconstruction-expression"><b>重组表达式</b><code>${escapeAnalysisText(item.origin)} + ${escapeAnalysisText(item.apiPrefix)} + ${escapeAnalysisText(item.businessEndpoint)}</code></div>
                            <div class="reconstruction-parts"><span>Origin：${escapeAnalysisText(item.origin)}</span><span>API 前缀：${escapeAnalysisText(item.apiPrefix)}</span><span>业务接口：${escapeAnalysisText(item.businessEndpoint)}</span></div>
                            <pre>${escapeAnalysisText(item.source || '')}</pre>
                        </details>`).join('')}
                </details>`;
        }).join('');
    }

    function renderDiscoveryAnalysis(analysis, probeState = latestProbeResults) {
        const discovery = analysis?.discovery || { clients: [], candidates: [], unresolved: [], stats: {} };
        const clients = discovery.clients || [];
        const candidates = discovery.candidates || [];
        const unresolved = discovery.unresolved || [];
        const resultMap = new Map((probeState?.results || []).map(result => [`${result.originalMethod} ${result.url}`, result]));
        const unconfirmed = candidates.filter(candidate => !candidate.confirmedByNetwork);
        const alive = [...resultMap.values()].filter(result => ['alive', 'exists-auth', 'exists-method', 'exists-params', 'redirect-auth'].includes(result.state)).length;
        if (discoveryTabCount) discoveryTabCount.textContent = String(unconfirmed.length);
        if (apiDiscoveryCount) {
            const progress = probeState?.status === 'running' ? ` · 探测 ${probeState.completed || 0}/${probeState.total || 0}` : '';
            apiDiscoveryCount.textContent = `${clients.length} 个客户端 · ${candidates.length} 个候选 · ${unconfirmed.length} 个待验证 · ${alive} 个探测存活${progress}`;
        }
        if (probeApiCandidatesBtn) {
            probeApiCandidatesBtn.disabled = probeState?.status === 'running' || !unconfirmed.length;
            probeApiCandidatesBtn.textContent = probeState?.status === 'running' ? `探测中 ${probeState.completed || 0}/${probeState.total || 0}` : 'HEAD 安全探测';
        }
        if (!apiDiscoveryList) return;
        if (analysis?.status === 'running') {
            apiDiscoveryList.innerHTML = '<div class="analysis-empty">正在构建 Origin、端口、Base URL、API 前缀、调用点和参数之间的证据关系…</div>';
            return;
        }
        if (!clients.length && !candidates.length) {
            apiDiscoveryList.innerHTML = `<div class="analysis-empty">${escapeAnalysisText(analysis?.error || '没有足够证据建立请求客户端和候选接口')}</div>`;
            return;
        }
        const clientHtml = clients.map(client => {
            const rows = candidates.filter(candidate => candidate.clientId === client.id).slice(0, 300);
            const sources = (client.sources || []).slice(0, 12).map(source => `${source.type || '证据'} · ${source.source || ''} · ${source.value || ''}`).join('\n');
            return `<details class="discovery-client" open>
                <summary><strong>${escapeAnalysisText(client.baseUrl)}</strong><span>${escapeAnalysisText(client.protocol)} · ${escapeAnalysisText(client.hostname)}:${escapeAnalysisText(client.port)} · ${rows.length} 条 · ${Math.round((client.confidence || 0) * 100)}%</span></summary>
                <div class="discovery-client-evidence">${escapeAnalysisText(sources || 'window.location')}</div>
                ${rows.map(candidate => {
                    const probe = resultMap.get(`${candidate.method} ${candidate.url}`);
                    const state = candidate.confirmedByNetwork ? { state: 'alive', label: 'Network 已验证' } : probe || { state: 'pending', label: '待验证' };
                    const details = {
                        urlExpression: candidate.urlExpression || '',
                        rawPath: candidate.rawPath,
                        fields: candidate.fields || [],
                        requestShape: candidate.requestShape || [],
                        headers: candidate.headers || {},
                        inferredHeaders: candidate.inferredHeaders || [],
                        bodyExpression: candidate.bodyExpression || '',
                        callExpression: candidate.callExpression || '',
                        sourceContext: {
                            before: candidate.before || '',
                            after: candidate.after || ''
                        },
                        evidence: candidate.evidence || [],
                        probe: probe || null
                    };
                    return `<div class="discovery-candidate">
                        <input class="probe-candidate-checkbox" type="checkbox" data-candidate-id="${escapeAnalysisText(candidate.id)}" ${candidate.confirmedByNetwork ? 'disabled' : 'checked'} title="选择进行 HEAD 探测">
                        <span class="api-method ${escapeAnalysisText(candidate.method)}">${escapeAnalysisText(candidate.method)}</span>
                        <details class="api-detail"><summary><code>${escapeAnalysisText(candidate.url)}</code><small>原始 ${escapeAnalysisText(candidate.rawPath)} · 可信度 ${Math.round((candidate.confidence || 0) * 100)}%</small></summary><div class="api-detail-body"><pre>${escapeAnalysisText(JSON.stringify(details, null, 2))}</pre></div></details>
                        <span class="probe-state ${escapeAnalysisText(state.state)}">${escapeAnalysisText(state.label)}</span>
                    </div>`;
                }).join('')}
            </details>`;
        }).join('');
        const unresolvedHtml = unresolved.length ? `<details class="discovery-client"><summary><strong>未重组路径</strong><span>${unresolved.length} 条，缺少关联 Base URL</span></summary>${unresolved.slice(0, 300).map(item => `<div class="static-evidence-row"><code>${escapeAnalysisText(item.method)} ${escapeAnalysisText(item.rawPath)}</code><span>${escapeAnalysisText(item.source)} · ${escapeAnalysisText(item.reason)}</span></div>`).join('')}</details>` : '';
        apiDiscoveryList.innerHTML = clientHtml + unresolvedHtml;
    }

    function renderStaticApiAnalysis(analysis) {
        latestStaticAnalysis = analysis || latestStaticAnalysis;
        renderDiscoveryAnalysis(latestStaticAnalysis);
        renderAttackSurfaceOverview();
        const endpoints = analysis?.endpoints || [];
        const stringEvidence = analysis?.stringEvidence || { baseUrls: [], apiPrefixes: [], businessPaths: [], storageReferences: [] };
        const scriptDiagnostics = analysis?.scriptDiagnostics || [];
        const failedScripts = scriptDiagnostics.filter(item => !item.analyzed);
        const evidenceTotal = Object.values(stringEvidence).reduce((sum, items) => sum + (Array.isArray(items) ? items.length : 0), 0);
        if (staticApiCount) staticApiCount.textContent = analysis?.status === 'running'
            ? '后台分析中…'
            : analysis?.error
            ? `失败：${analysis.error}`
            : `${evidenceTotal} 条字符串证据 · ${endpoints.length} 个静态候选 · ${analysis?.astEngine || '本地证据引擎'} · ${analysis?.scriptsAnalyzed || 0}/${analysis?.scriptsDiscovered || 0} 个去重脚本${failedScripts.length ? ` · 失败 ${failedScripts.length}` : ''}${analysis?.scriptsReferenced > analysis?.scriptsDiscovered ? ` · ${analysis.scriptsReferenced} 次资源引用` : ''}${analysis?.documentAnalyzed ? ' · 含页面' : ''}`;
        if (!staticApiList) return;
        if (analysis?.status === 'running') {
            staticApiList.innerHTML = '<div class="analysis-empty">正在后台读取 main / app / index / portal / chunk 等脚本，关闭 popup 也不会中断…</div>';
            return;
        }
        if (!endpoints.length && !evidenceTotal && !scriptDiagnostics.length) {
            staticApiList.innerHTML = `<div class="analysis-empty">${escapeAnalysisText(analysis?.error || '没有从当前 JS 中还原出接口')}</div>`;
            return;
        }
        const evidenceLabels = { baseUrls: 'Base URL / 配置值', apiPrefixes: 'API 前缀', businessPaths: '未验证路径字符串（不等于接口）', storageReferences: 'Storage 引用键' };
        const diagnosticsHtml = scriptDiagnostics.length ? `
            <details class="static-evidence-group" ${failedScripts.length ? 'open' : ''}>
                <summary><strong>脚本读取诊断</strong><span>${scriptDiagnostics.length} 个去重脚本 · ${failedScripts.length} 个失败</span></summary>
                ${scriptDiagnostics.slice(0, 300).map(item => `<div class="static-evidence-row"><code>${escapeAnalysisText(item.source)}</code><span>${item.analyzed ? `已分析 ${(item.bytesAnalyzed || 0).toLocaleString()} 字符` : `失败：${escapeAnalysisText(item.error || `HTTP ${item.status || 0}`)}`} · ${escapeAnalysisText(item.discoveredBy || '')}${item.status ? ` · ${escapeAnalysisText(item.status)}` : ''}</span></div>`).join('')}
            </details>` : '';
        const evidenceHtml = Object.entries(stringEvidence).filter(([, items]) => items?.length).map(([kind, items]) => `
            <details class="static-evidence-group" ${kind === 'baseUrls' || kind === 'apiPrefixes' ? 'open' : ''}>
                <summary><strong>${escapeAnalysisText(evidenceLabels[kind] || kind)}</strong><span class="static-evidence-actions"><span>${items.length}</span><button type="button" class="copy-all-evidence" data-evidence-kind="${escapeAnalysisText(kind)}">复制全部</button></span></summary>
                ${items.slice(0, 160).map(item => `<div class="static-evidence-row"><code>${escapeAnalysisText(item.value)}</code><span>${escapeAnalysisText(item.source || '')}${item.line ? `:${item.line}` : ''}</span></div>`).join('')}
            </details>`).join('');
        staticApiList.innerHTML = diagnosticsHtml + evidenceHtml + endpoints.slice(0, 150).map(endpoint => `
            <div class="api-analysis-item static-endpoint-item">
                <span class="api-method ${escapeAnalysisText(endpoint.method)}">${escapeAnalysisText(endpoint.method)}</span>
                <details class="api-detail">
                    <summary><strong class="api-full-url">${escapeAnalysisText(endpoint.fullUrl)}</strong><span class="api-split">${endpoint.confirmedByNetwork ? 'Network 已验证' : '静态候选，未重组'} · 原始片段 ${escapeAnalysisText(endpoint.rawUrl)} · 可信度 ${Math.round((endpoint.confidence || 0) * 100)}%</span></summary>
                    <div class="api-detail-body">
                        <div class="api-detail-row"><b>识别依据</b><pre>${escapeAnalysisText(endpoint.evidence)} · ${escapeAnalysisText(endpoint.source)}:${endpoint.line || '?'}</pre></div>
                        <div class="api-detail-row"><b>原始调用</b><pre>${escapeAnalysisText(endpoint.callExpression || endpoint.urlExpression || endpoint.rawUrl || '')}</pre></div>
                        <div class="api-detail-row"><b>源码前文</b><pre>${escapeAnalysisText(endpoint.before || '无')}</pre></div>
                        <div class="api-detail-row"><b>源码后文</b><pre>${escapeAnalysisText(endpoint.after || '无')}</pre></div>
                        <div class="api-detail-row"><b>附近请求字段</b><pre>${escapeAnalysisText(JSON.stringify(endpoint.fields || [], null, 2))}</pre></div>
                    </div>
                </details>
                <span class="api-capture-tag ${endpoint.confirmedByNetwork ? 'verified' : 'candidate'}">${endpoint.confirmedByNetwork ? '已验证' : '候选'}</span>
                <button class="api-copy-btn" data-copy-url="${escapeAnalysisText(endpoint.fullUrl)}">复制</button>
            </div>
        `).join('');
        staticApiList.querySelectorAll('.api-copy-btn').forEach(button => button.addEventListener('click', async event => {
            event.stopPropagation();
            await navigator.clipboard.writeText(button.dataset.copyUrl || '');
            showToast('分析接口 URL 已复制');
        }));
        staticApiList.querySelectorAll('.copy-all-evidence').forEach(button => button.addEventListener('click', async event => {
            event.preventDefault();
            event.stopPropagation();
            const kind = button.dataset.evidenceKind;
            const values = [...new Set((stringEvidence[kind] || []).map(item => item.value).filter(Boolean))];
            await navigator.clipboard.writeText(values.join('\n'));
            showToast(`已复制 ${values.length} 条${evidenceLabels[kind] || '证据'}`);
        }));
    }

    function renderSecurityAnalysis(analysis) {
        latestStaticAnalysis = analysis || latestStaticAnalysis;
        renderAttackSurfaceOverview();
        const security = analysis?.security || { algorithms: [], findings: [], urls: [] };
        const algorithms = security.algorithms || [];
        const findings = security.findings || [];
        const flows = security.flows || [];
        const algorithmNames = [...new Set(algorithms.map(item => item.algorithm))];
        if (cryptoSummary) cryptoSummary.textContent = `算法：${algorithmNames.join(' · ') || '未发现'} · 敏感信息 ${findings.length} 项 · 数据流线索 ${flows.length} 项`;
        if (securityCount) securityCount.textContent = analysis?.status === 'running' ? '自动分析中…' : `${algorithms.length + findings.length + flows.length} 条安全定位`;
        const locationList = document.getElementById('security-location-list');
        if (!locationList) return;
        if (analysis?.status === 'running') {
            locationList.innerHTML = '<div class="analysis-empty">安全、编码和 URL 正在随 JS 接口一起自动分析…</div>';
            return;
        }
        const rows = [
            ...flows.slice(0, 100).map(item => ({ type: `数据流 · ${item.type}`, value: `${item.sourceExpression || ''} → ${item.match || ''}`, ...item })),
            ...algorithms.slice(0, 100).map(item => ({ type: `算法 · ${item.algorithm}`, value: item.match, ...item })),
            ...findings.slice(0, 100).map(item => ({ type: `敏感 · ${item.type}`, value: item.match, ...item }))
        ];
        locationList.innerHTML = rows.length ? rows.map(item => `
            <details class="sensitive-item security-location-item">
                <summary><strong>${escapeAnalysisText(item.type)}</strong>${item.confidence ? `<span class="confidence-badge confidence-${item.confidence === '高' ? 'high' : 'medium'}">${escapeAnalysisText(item.confidence)}置信</span>` : ''}<span class="security-source">${escapeAnalysisText(item.source)}:${item.line || '?'}</span><span class="sensitive-context">${escapeAnalysisText(item.value || '')}</span></summary>
                ${item.reason ? `<span class="sensitive-reason">依据：${escapeAnalysisText(item.reason)}</span>` : ''}
                <span class="sensitive-context">前 100 字符：${escapeAnalysisText(item.before || '')}</span>
                <span class="sensitive-context">后 100 字符：${escapeAnalysisText(item.after || '')}</span>
            </details>
        `).join('') : '<div class="analysis-empty">自动分析完成，未发现算法或敏感信息特征</div>';
    }

    function renderResourceInventory(analysis) {
        latestStaticAnalysis = analysis || latestStaticAnalysis;
        renderAttackSurfaceOverview();
        const resources = analysis?.resources || { counts: {}, entries: [] };
        const list = document.getElementById('resource-inventory-list');
        const count = document.getElementById('resource-inventory-count');
        const labels = {
            api: '接口请求', javascript: '业务 JS', chunks: '异步 Chunk', 'source-maps': 'Source Map',
            'workers-wasm': 'Worker / WASM', styles: 'CSS', images: '图片 / SVG', fonts: '字体', media: '媒体', ignored: '已过滤', other: '其他'
        };
        const rows = Object.entries(resources.counts || {}).sort((a, b) => b[1] - a[1]);
        if (count) count.textContent = `${(resources.entries || []).length} 项资源 · ${rows.length} 类`;
        if (!list) return;
        list.innerHTML = rows.length ? rows.map(([category, amount]) => `
            <details class="resource-category">
                <summary><strong>${escapeAnalysisText(labels[category] || category)}</strong><span>${amount}</span></summary>
                ${(resources.entries || []).filter(item => item.category === category).slice(0, 120).map(item => item.category === 'source-maps'
                    ? `<details class="resource-row source-map-row"><summary><span>${escapeAnalysisText(item.error ? '读取失败' : '已解析')}</span><code>${escapeAnalysisText(item.name)}</code></summary><small>来源脚本：${escapeAnalysisText(item.sourceScript || '?')} · 源文件 ${item.sourceCount || 0} · 内嵌源码 ${item.embeddedSourceCount || 0} · 符号 ${item.nameCount || 0}${item.error ? ` · ${escapeAnalysisText(item.error)}` : ''}</small><pre>${escapeAnalysisText((item.sources || []).slice(0, 200).join('\n') || 'Source Map 未包含 sources 列表')}</pre></details>`
                    : `<div class="resource-row"><span>${escapeAnalysisText(item.initiatorType || '')}</span><code>${escapeAnalysisText(item.name)}</code></div>`).join('')}
            </details>`).join('') : '<div class="analysis-empty">没有可分类资源</div>';
    }

    let staticAnalysisPollTimer = null;
    let probePollTimer = null;

    async function loadProbeResults() {
        if (!currentTab_obj?.id) return;
        clearTimeout(probePollTimer);
        latestProbeResults = await chrome.runtime.sendMessage({ type: 'GET_API_PROBE_RESULTS', tabId: currentTab_obj.id }).catch(error => ({ status: 'error', error: error.message, results: [] }));
        renderDiscoveryAnalysis(latestStaticAnalysis, latestProbeResults);
        if (latestProbeResults?.status === 'running') probePollTimer = setTimeout(loadProbeResults, 700);
    }

    async function pollStaticAnalysis() {
        if (!currentTab_obj?.id) return;
        clearTimeout(staticAnalysisPollTimer);
        const analysis = await chrome.runtime.sendMessage({ type: 'GET_STATIC_API_ANALYSIS', tabId: currentTab_obj.id }).catch(error => ({ status: 'error', error: error.message }));
        renderStaticApiAnalysis(analysis);
        renderSecurityAnalysis(analysis);
        renderResourceInventory(analysis);
        if (analysis?.status === 'running') {
            staticAnalysisPollTimer = setTimeout(pollStaticAnalysis, 800);
        } else if (analyzePageJsBtn) {
            analyzePageJsBtn.disabled = false;
            analyzePageJsBtn.textContent = '重新分析 JS';
            loadApiAnalysis();
            loadProbeResults();
        }
    }

    async function startStaticAnalysis() {
        if (!currentTab_obj?.id) return;
        if (analyzePageJsBtn) {
            analyzePageJsBtn.disabled = true;
            analyzePageJsBtn.textContent = '后台分析中…';
        }
        renderStaticApiAnalysis({ status: 'running', endpoints: [] });
        renderSecurityAnalysis({ status: 'running', security: { algorithms: [], findings: [], urls: [] } });
        renderResourceInventory({ resources: { counts: {}, entries: [] } });
        await chrome.runtime.sendMessage({ type: 'ANALYZE_PAGE_JS', tabId: currentTab_obj.id }).catch(error => ({ error: error.message }));
        pollStaticAnalysis();
    }

    async function loadApiAnalysis() {
        if (!currentTab_obj?.id) return;
        const analysis = await chrome.runtime.sendMessage({ type: 'GET_API_ANALYSIS', tabId: currentTab_obj.id }).catch(() => null);
        renderApiAnalysis(analysis);
    }

    async function loadStaticApiAnalysis() {
        if (!currentTab_obj?.id) return;
        const analysis = await chrome.runtime.sendMessage({ type: 'GET_STATIC_API_ANALYSIS', tabId: currentTab_obj.id }).catch(error => ({ status: 'error', error: error.message }));
        if ((analysis?.analysisVersion !== 13 || !analysis?.analyzedAt) && analysis?.status !== 'running' && !analysis?.error) return startStaticAnalysis();
        renderStaticApiAnalysis(analysis);
        renderSecurityAnalysis(analysis);
        renderResourceInventory(analysis);
        if (analysis?.status === 'running') pollStaticAnalysis();
    }

    function initUnifiedFrontendAnalysis() {
        chrome.storage.local.get(['auto_api_analysis_enabled'], result => {
            if (autoApiAnalysisToggle) autoApiAnalysisToggle.checked = result.auto_api_analysis_enabled !== false;
        });
        loadFrontendAnalysis();
        loadApiAnalysis();
        loadStaticApiAnalysis();
        loadProbeResults();
        loadSessionSnapshots();
    }

    refreshFrontendAnalysisBtn?.addEventListener('click', async () => {
        triggerVueRescan();
        await Promise.all([loadFrontendAnalysis(), loadApiAnalysis(), loadStaticApiAnalysis(), loadHeaderIntelligence()]);
        renderAttackSurfaceOverview();
        showToast('攻击面摘要已刷新');
    });
    refreshApiAnalysisBtn?.addEventListener('click', loadApiAnalysis);
    clearApiAnalysisBtn?.addEventListener('click', async () => {
        if (!currentTab_obj?.id) return;
        await chrome.runtime.sendMessage({ type: 'CLEAR_API_ANALYSIS', tabId: currentTab_obj.id });
        renderApiAnalysis({ endpoints: [], totalCaptured: 0 });
        showToast('接口记录已清空');
    });
    analyzePageJsBtn?.addEventListener('click', startStaticAnalysis);
    probeApiCandidatesBtn?.addEventListener('click', async () => {
        if (!currentTab_obj?.id) return;
        const candidateIds = [...document.querySelectorAll('.probe-candidate-checkbox:checked')].map(input => input.dataset.candidateId).filter(Boolean);
        probeApiCandidatesBtn.disabled = true;
        const response = await chrome.runtime.sendMessage({
            type: 'PROBE_API_CANDIDATES',
            tabId: currentTab_obj.id,
            options: { candidateIds, limit: Number(apiProbeLimit?.value) || 80, concurrency: 3, timeoutMs: 10000, intervalMs: 180 }
        }).catch(error => ({ accepted: false, error: error.message }));
        if (!response?.accepted) {
            probeApiCandidatesBtn.disabled = false;
            showToast(response?.error || '无法启动候选探测');
            return;
        }
        showToast(`已启动 ${response.total || candidateIds.length} 条 HEAD 安全探测`);
        loadProbeResults();
    });
    clearApiProbesBtn?.addEventListener('click', async () => {
        if (!currentTab_obj?.id) return;
        await chrome.runtime.sendMessage({ type: 'CLEAR_API_PROBE_RESULTS', tabId: currentTab_obj.id });
        latestProbeResults = { status: 'idle', results: [] };
        renderDiscoveryAnalysis(latestStaticAnalysis, latestProbeResults);
        showToast('候选探测结果已清空');
    });
    autoApiAnalysisToggle?.addEventListener('change', event => {
        chrome.storage.local.set({ auto_api_analysis_enabled: event.target.checked });
        showToast(event.target.checked ? '自动接口分析已开启' : '自动接口分析已关闭');
    });

    const DEFAULT_EXCLUDED_SITES = ['w3.org', 'w3c.org', 'schema.org', 'google-analytics.com', 'googletagmanager.com', 'doubleclick.net', 'adtrafficquality.google', 'cloudflareinsights.com', 'tongji-collector.dcloud.net.cn'];
    const securityCount = document.getElementById('security-analysis-count');
    const cryptoSummary = document.getElementById('crypto-analysis-summary');
    const excludedSitesInput = document.getElementById('excluded-sites-input');
    const excludedResourceExtensions = document.getElementById('excluded-resource-extensions');
    const refreshSecurityAnalysis = document.getElementById('refresh-security-analysis');
    const saveExcludedSites = document.getElementById('save-excluded-sites');

    const DEFAULT_EXCLUDED_RESOURCE_EXTENSIONS = ['css', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'woff', 'woff2', 'ttf', 'ico'];
    chrome.storage.local.get(['analysis_excluded_sites', 'analysis_excluded_resource_extensions'], result => {
        const sites = [...new Set([...DEFAULT_EXCLUDED_SITES, ...(result.analysis_excluded_sites || [])])];
        if (excludedSitesInput) excludedSitesInput.value = sites.join('\n');
        if (excludedResourceExtensions) excludedResourceExtensions.value = (result.analysis_excluded_resource_extensions || DEFAULT_EXCLUDED_RESOURCE_EXTENSIONS).join(', ');
    });

    saveExcludedSites?.addEventListener('click', () => {
        const sites = excludedSitesInput.value.split(/\n|,/).map(v => v.trim().toLowerCase()).filter(Boolean);
        const extensions = (excludedResourceExtensions?.value || '').split(/\n|,/).map(v => v.trim().replace(/^\./, '').toLowerCase()).filter(Boolean);
        chrome.storage.local.set({ analysis_excluded_sites: sites, analysis_excluded_resource_extensions: extensions }, () => {
            showToast('分析过滤器已保存，正在重新分析');
            startStaticAnalysis();
        });
    });

    refreshSecurityAnalysis?.addEventListener('click', startStaticAnalysis);
    
    // 🆕 全局搜索函数（供 HTML oninput 调用）
    window.handleVueRouteSearch = function(searchValue) {
        const searchTerm = (searchValue || '').toLowerCase().trim();
        
        if (currentVueRoutes.length === 0) {
            console.log('[Vue Search] 没有路由数据');
            return;
        }
        
        console.log('[Vue Search] 搜索:', searchTerm, '路由数量:', currentVueRoutes.length);
        
        if (!searchTerm) {
            // 显示所有路由
            renderVueRoutesGlobal(currentVueRoutes);
        } else {
            // 过滤路由
            const filteredRoutes = currentVueRoutes.filter(route => {
                const path = route.path.toLowerCase();
                const name = (route.name || '').toLowerCase();
                return path.includes(searchTerm) || name.includes(searchTerm);
            });
            console.log('[Vue Search] 过滤后:', filteredRoutes.length);
            renderVueRoutesGlobal(filteredRoutes);
        }
    };

    // 🆕 全局模式存储键名
    const GLOBAL_MODE_KEY = 'antidebug_mode';
    const GLOBAL_SCRIPTS_KEY = 'global_scripts';
    
    // 🆕 全局请求头存储键名
    const HEADERS_GROUPS_KEY = 'global_headers_groups';
    const HEADERS_DATA_KEY = 'global_headers_data';
    const sameOriginAuthToggle = document.getElementById('same-origin-auth-toggle');
    chrome.storage.local.get(['same_origin_auth_enabled'], result => {
        if (sameOriginAuthToggle) {
            sameOriginAuthToggle.checked = result.same_origin_auth_enabled === true;
            syncToggleA11y(sameOriginAuthToggle);
        }
    });
    sameOriginAuthToggle?.addEventListener('change', event => {
        chrome.storage.local.set({ same_origin_auth_enabled: event.target.checked }, () => {
            showToast(event.target.checked ? '同源身份头与允许的自定义头复用已开启' : '请求头仍会采集分类，但不再复用');
            loadHeaderIntelligence();
        });
    });

    const observedHeadersList = document.getElementById('observed-headers-list');
    const observedHeadersSummary = document.getElementById('observed-headers-summary');
    function maskHeaderValue(header) {
        const value = String(header.value || '');
        if (!header.sensitive) return value.length > 180 ? `${value.slice(0, 180)}…` : value;
        if (value.length <= 8) return '••••••••';
        return `${value.slice(0, 4)}••••••••${value.slice(-4)}`;
    }
    async function loadHeaderIntelligence() {
        if (!currentTab_obj?.id || !observedHeadersList) return;
        const result = await chrome.runtime.sendMessage({ type: 'GET_HEADER_INTELLIGENCE', tabId: currentTab_obj.id }).catch(error => ({ error: error.message }));
        if (result?.error) {
            observedHeadersList.innerHTML = `<div class="analysis-empty">${escapeAnalysisText(result.error)}</div>`;
            return;
        }
        const headers = result?.headers || [];
        latestHeaderIntelligence = result;
        renderAttackSurfaceOverview();
        const labels = { identity: '身份', custom: '自定义', standard: '常规', browser: '浏览器管理', tracing: '追踪' };
        if (observedHeadersSummary) {
            observedHeadersSummary.textContent = headers.length
                ? `${result.origin || ''} · ${headers.length} 种 · ${result.requestCount || 0} 次请求`
                : '等待捕获请求';
        }
        observedHeadersList.innerHTML = headers.length ? headers.map(header => `
            <div class="observed-header-row category-${escapeAnalysisText(header.category)}">
                <span class="header-category-badge">${escapeAnalysisText(labels[header.category] || header.category)}</span>
                <div class="observed-header-main"><strong>${escapeAnalysisText(header.name)}</strong><code data-raw-value="${escapeAnalysisText(header.value || '')}">${escapeAnalysisText(maskHeaderValue(header))}</code><small>${escapeAnalysisText(header.reason || '')} · 捕获 ${header.seenCount || 1} 次</small></div>
                <span class="header-reuse-state ${header.shareable ? 'shareable' : ''}">${header.shareable ? (result.enabled ? '复用中' : '可复用') : '不复用'}</span>
                <button class="reveal-header-value" type="button">${header.sensitive ? '显示' : '复制'}</button>
            </div>`).join('') : '<div class="analysis-empty">访问或操作页面后显示真实请求头</div>';
        observedHeadersList.querySelectorAll('.reveal-header-value').forEach(button => button.addEventListener('click', async () => {
            const code = button.closest('.observed-header-row')?.querySelector('code');
            if (!code) return;
            if (button.textContent === '显示') {
                code.textContent = code.dataset.rawValue || '';
                button.textContent = '复制';
            } else {
                await navigator.clipboard.writeText(code.dataset.rawValue || '');
                showToast('请求头值已复制');
            }
        }));
    }
    document.getElementById('refresh-observed-headers')?.addEventListener('click', loadHeaderIntelligence);
    
    // 🆕 全局请求头状态
    let headersGroups = []; // [{id, name}]
    let headersData = {}; // {groupId: [{id, name, value, enabled}]}
    let currentHeadersGroupId = null;
    
    // 常用请求头列表（用于自动补全）
    const COMMON_HEADERS = [
        'Accept',
        'Accept-Charset',
        'Accept-Encoding',
        'Accept-Language',
        'Authorization',
        'Cache-Control',
        'Connection',
        'Content-Disposition',
        'Content-Encoding',
        'Content-Language',
        'Content-Length',
        'Content-Type',
        'Cookie',
        'Date',
        'DNT',
        'Host',
        'If-Match',
        'If-Modified-Since',
        'If-None-Match',
        'If-Range',
        'If-Unmodified-Since',
        'Origin',
        'Pragma',
        'Proxy-Authorization',
        'Range',
        'Referer',
        'Sec-Fetch-Dest',
        'Sec-Fetch-Mode',
        'Sec-Fetch-Site',
        'TE',
        'Transfer-Encoding',
        'Upgrade',
        'Upgrade-Insecure-Requests',
        'User-Agent',
        'Via',
        'Warning',
        'X-Api-Key',
        'X-Auth-Token',
        'X-Content-Type-Options',
        'X-Correlation-ID',
        'X-CSRF-Token',
        'X-Custom-Header',
        'X-Forwarded-For',
        'X-Forwarded-Host',
        'X-Forwarded-Port',
        'X-Forwarded-Proto',
        'X-Frame-Options',
        'X-Real-IP',
        'X-Request-ID',
        'X-Requested-With',
        'X-Token',
        'X-Trace-ID',
        'X-XSS-Protection'
    ]; // 当前选中的标签组ID

    // 🆕 初始化全局模式状态
    function initializeGlobalMode() {
        chrome.storage.local.get([GLOBAL_MODE_KEY, GLOBAL_SCRIPTS_KEY], (result) => {
            // 获取模式状态，默认为标准模式
            const mode = result[GLOBAL_MODE_KEY] || 'standard';
            isGlobalMode = (mode === 'global');
            
            // 获取全局脚本列表，默认为空数组
            globalEnabledScripts = result[GLOBAL_SCRIPTS_KEY] || [];
            
            // 如果没有模式键值，创建默认配置
            if (!result[GLOBAL_MODE_KEY]) {
                chrome.storage.local.set({
                    [GLOBAL_MODE_KEY]: 'standard',
                    [GLOBAL_SCRIPTS_KEY]: []
                });
            }
            
            // 更新UI状态
            updateModeUI();
            
            // 如果是全局模式，使用全局脚本列表
            if (isGlobalMode) {
                enabledScripts = [...globalEnabledScripts];
            }
        });
    }

    // 🆕 更新模式UI显示
    function updateModeUI() {
        globalModeToggle.checked = isGlobalMode;
        modeText.textContent = isGlobalMode ? '全局模式' : '标准模式';
    }

    // 🆕 模式切换处理（修复bug：添加旧模式脚本清理）
    function handleModeToggle(newGlobalMode) {
        const oldGlobalMode = isGlobalMode;
        isGlobalMode = newGlobalMode;
        
        // 保存模式状态
        const mode = isGlobalMode ? 'global' : 'standard';
        chrome.storage.local.set({ [GLOBAL_MODE_KEY]: mode });
        
        // 🔧 关键修复：先清理旧模式的脚本注册
        if (oldGlobalMode !== newGlobalMode) {
            clearOldModeScripts(oldGlobalMode);
        }
        
        if (isGlobalMode) {
            // 切换到全局模式
            enabledScripts = [...globalEnabledScripts];
        } else {
            // 切换到标准模式
            // 检查当前URL是否为web网站
            if (currentTab_obj && currentTab_obj.url && 
                (currentTab_obj.url.startsWith('http://') || currentTab_obj.url.startsWith('https://'))) {
                
                // 读取当前域名的脚本配置
                chrome.storage.local.get([hostname], (result) => {
                    if (result[hostname]) {
                        // 存在配置，使用该配置
                        enabledScripts = result[hostname] || [];
                    } else {
                        // 不存在配置，创建空配置
                        enabledScripts = [];
                        chrome.storage.local.set({ [hostname]: [] });
                    }
                    
                    // 更新UI显示和脚本注册
                    updateModeUI();
                    renderCurrentTab();
                    updateScriptRegistration();
                });
                return;
            } else {
                // 不是web网站，清空脚本
                enabledScripts = [];
            }
        }
        
        // 更新UI显示和脚本注册
        updateModeUI();
        renderCurrentTab();
        updateScriptRegistration();
    }

    // 🔧 新增：清理旧模式脚本的函数
    function clearOldModeScripts(wasGlobalMode) {
        chrome.runtime.sendMessage({
            type: 'clear_mode_scripts',
            clearGlobalMode: wasGlobalMode
        });
    }

    // 🆕 检查是否为有效的web网站
    function isValidWebsite(url) {
        return url && (url.startsWith('http://') || url.startsWith('https://'));
    }

    // 🆕 更新脚本注册（通知background）
    function updateScriptRegistration() {
        chrome.runtime.sendMessage({
            type: 'update_scripts_registration',
            hostname: isGlobalMode ? '*' : hostname,
            enabledScripts: enabledScripts,
            isGlobalMode: isGlobalMode
        });
    }

    // 监听来自 background 的 Vue Router 数据更新
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'FRONTEND_ANALYSIS_UPDATE' && message.tabId === currentTab_obj?.id) {
            const result = message.data || {};
            const primary = result.primary;
            if (frontendPrimaryFramework) frontendPrimaryFramework.textContent = primary ? `${primary.name}${primary.version ? ` ${primary.version}` : ''}` : '通用网站';
            if (frontendFrameworkDetails) frontendFrameworkDetails.textContent = [...(result.frameworks || []).map(item => item.name), ...(result.libraries || []).map(item => `库:${item.name}`)].join(' · ') || '未发现特定框架，已启用通用接口分析';
        }

        if (message.type === 'API_CAPTURE_UPDATE' && message.tabId === currentTab_obj?.id) {
            // 重新读取一次，让多请求模型同时合并最新的 Storage / JS 证据。
            loadApiAnalysis();
            if (message.latest) {
                showToast(`捕获接口：${message.latest.method} ${message.latest.url || message.latest.path || ''}`);
            }
        }

        if (message.type === 'STATIC_API_ANALYSIS_UPDATE' && message.tabId === currentTab_obj?.id) {
            clearTimeout(staticAnalysisPollTimer);
            renderStaticApiAnalysis(message.data);
            renderSecurityAnalysis(message.data);
            renderResourceInventory(message.data);
            loadProbeResults();
            if (analyzePageJsBtn) {
                analyzePageJsBtn.disabled = false;
                analyzePageJsBtn.textContent = '重新分析 JS';
            }
        }

        if (message.type === 'API_PROBE_UPDATE' && message.tabId === currentTab_obj?.id) {
            latestProbeResults = message.data;
            renderDiscoveryAnalysis(latestStaticAnalysis, latestProbeResults);
        }

        if (message.type === 'VUE_ROUTER_DATA_UPDATE' && message.hostname === hostname) {
            const data = message.data;
            
            // 处理多实例数据
            if (data.type === 'MULTIPLE_INSTANCES' && data.instances) {
                cachedVueDataList = data.instances;
                currentInstanceIndex = 0; // 默认选中第一个
                
                // 保存到 storage
                const storageKey = `${hostname}_vue_data`;
                chrome.storage.local.set({
                    [storageKey]: {
                        type: 'MULTIPLE_INSTANCES',
                        instances: data.instances,
                        totalCount: data.totalCount,
                        timestamp: Date.now()
                    }
                });
                
                // 显示多实例
                displayMultipleInstances();
            }
            // 兼容单实例或未找到的情况
            else {
                cachedVueDataList = [data];
                currentInstanceIndex = 0;
                
                // 保存到 storage
                const storageKey = `${hostname}_vue_data`;
                chrome.storage.local.set({
                    [storageKey]: data
                });
                
                // 显示单实例
                displayMultipleInstances();
            }
        }
    });

    // 请求页面的Vue Router数据
    function requestVueRouterData() {
        if (currentTab_obj && currentTab_obj.id) {
            tabsApi.sendMessage(currentTab_obj.id, {
                type: 'REQUEST_VUE_ROUTER_DATA'
            }).catch(err => {
                console.warn('请求Vue数据失败:', err);
            });
        }
    }

    // 获取当前标签页的域名
    const devToolsTabId = requestedTabId || chrome.devtools?.inspectedWindow?.tabId;
    const targetTabsPromise = isDevToolsMode && devToolsTabId
        ? tabsApi.get(devToolsTabId).then(tab => [tab])
        : tabsApi.query({ active: true, currentWindow: true });
    targetTabsPromise.then((tabs) => {
        const tab = tabs[0];
        if (!tab || !tab.url) return;

        hostname = new URL(tab.url).hostname;
        currentTab_obj = tab;
        initUnifiedFrontendAnalysis();

        // 🆕 初始化全局模式
        initializeGlobalMode();

        // 加载脚本元数据
        fetch(chrome.runtime.getURL('scripts.json'))
            .then(response => response.json())
            .then(scripts => {
                allScripts = scripts;

                // 🆕 根据模式获取启用状态
                const getInitialScripts = () => {
                    if (isGlobalMode) {
                        return globalEnabledScripts;
                    } else {
                        // 标准模式：获取该域名下的启用状态
                        chrome.storage.local.get([hostname, 'last_active_tab'], (result) => {
                            enabledScripts = result[hostname] || ['Get_Vue_0'];
                            if (!result[hostname]) chrome.storage.local.set({ [hostname]: enabledScripts });

                            // 恢复上次打开的板块
                            if (result.last_active_tab) {
                                currentTab = result.last_active_tab;
                                // 更新UI中的按钮状态
                                tabBtns.forEach(b => {
                                    if (b.dataset.tab === currentTab) {
                                        b.classList.add('active');
                                    } else {
                                        b.classList.remove('active');
                                    }
                                });
                            }

                            renderCurrentTab();

                            // 检查是否启用了 Get_Vue_0 或 Get_Vue_1 脚本
                            const hasVueScript = enabledScripts.includes('Get_Vue_0') ||
                                enabledScripts.includes('Get_Vue_1');

                            // 如果启用了Vue脚本，立即请求数据
                            if (hasVueScript) {
                                requestVueRouterData();
                            }
                        });
                        return [];
                    }
                };

                // 延迟获取脚本，确保模式状态已初始化
                setTimeout(() => {
                    if (isGlobalMode) {
                        // 🔧 修复：全局模式下也需要恢复上次打开的板块
                        chrome.storage.local.get(['last_active_tab'], (result) => {
                            // 恢复上次打开的板块
                            if (result.last_active_tab) {
                                currentTab = result.last_active_tab;
                                // 更新UI中的按钮状态
                                tabBtns.forEach(b => {
                                    if (b.dataset.tab === currentTab) {
                                        b.classList.add('active');
                                    } else {
                                        b.classList.remove('active');
                                    }
                                });
                            }
                            
                            enabledScripts = [...globalEnabledScripts];
                            renderCurrentTab();
                            
                            // 检查Vue脚本
                            const hasVueScript = enabledScripts.includes('Get_Vue_0') ||
                                enabledScripts.includes('Get_Vue_1');
                            if (hasVueScript) {
                                requestVueRouterData();
                            }
                        });
                    } else {
                        getInitialScripts();
                    }
                }, 100);

                // 搜索功能
                searchInput.addEventListener('input', (e) => {
                    const searchTerm = e.target.value.toLowerCase();
                    
                    if (currentTab === 'antidebug') {
                    const filteredScripts = getScriptsForCurrentTab().filter(script =>
                        script.name.toLowerCase().includes(searchTerm) ||
                        script.description.toLowerCase().includes(searchTerm)
                    );
                        renderAntiDebugScripts(filteredScripts);
                    } else if (currentTab === 'hook') {
                        // Hook板块：只检索脚本名
                        let filteredScripts = getScriptsForCurrentTab().filter(script =>
                            script.name.toLowerCase().includes(searchTerm)
                        );
                        // 🆕 应用筛选（已开启/未开启）
                        filteredScripts = applyHookFilter(filteredScripts);
                        renderHookScripts(filteredScripts);
                    }
                });
                
                // 🆕 Vue路由搜索功能（全局事件监听）
                const vueSearchInput = document.getElementById('vue-route-search-input');
                if (vueSearchInput) {
                    vueSearchInput.addEventListener('input', (e) => {
                        const searchTerm = e.target.value.toLowerCase().trim();
                        if (currentVueRoutes.length === 0) return;
                        
                        if (!searchTerm) {
                            // 显示所有路由
                            renderVueRoutesGlobal(currentVueRoutes);
                        } else {
                            // 过滤路由
                            const filteredRoutes = currentVueRoutes.filter(route => {
                                const path = route.path.toLowerCase();
                                const name = (route.name || '').toLowerCase();
                                return path.includes(searchTerm) || name.includes(searchTerm);
                            });
                            renderVueRoutesGlobal(filteredRoutes);
                        }
                    });
                }
            });
    });

    // 🆕 全局模式开关事件监听
    globalModeToggle.addEventListener('change', (e) => {
        handleModeToggle(e.target.checked);
    });

    // 标签切换事件
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            // 更新按钮状态
            tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            // 更新当前标签
            currentTab = btn.dataset.tab;

            // 清空搜索
            searchInput.value = '';

            // 渲染对应内容
            renderCurrentTab();

            // 保存当前板块到storage
            chrome.storage.local.set({
                'last_active_tab': currentTab
            });
        });
    });

    // 🆕 Hook板块筛选按钮点击事件
    if (hookFilterEnabledBtn && hookFilterDisabledBtn) {
        hookFilterEnabledBtn.addEventListener('click', () => {
            if (hookFilterState === 'enabled') {
                // 如果已选中，则取消筛选
                saveHookFilterState(null);
                hookFilterEnabledBtn.classList.remove('active');
            } else {
                // 选中"已开启"
                saveHookFilterState('enabled');
                hookFilterEnabledBtn.classList.add('active');
                hookFilterDisabledBtn.classList.remove('active');
            }
            // 重新渲染Hook脚本
            if (currentTab === 'hook') {
                const scriptsToShow = getScriptsForCurrentTab();
                renderHookScripts(scriptsToShow);
            }
        });

        hookFilterDisabledBtn.addEventListener('click', () => {
            if (hookFilterState === 'disabled') {
                // 如果已选中，则取消筛选
                saveHookFilterState(null);
                hookFilterDisabledBtn.classList.remove('active');
            } else {
                // 选中"未开启"
                saveHookFilterState('disabled');
                hookFilterDisabledBtn.classList.add('active');
                hookFilterEnabledBtn.classList.remove('active');
            }
            // 重新渲染Hook脚本
            if (currentTab === 'hook') {
                const scriptsToShow = getScriptsForCurrentTab();
                renderHookScripts(scriptsToShow);
            }
        });
    }

    // 根据当前标签获取要显示的脚本
    function getScriptsForCurrentTab() {
        return allScripts.filter(script => script.category === currentTab);
    }

    // 渲染当前标签的内容
    function renderCurrentTab() {
        const scriptsToShow = getScriptsForCurrentTab();

        // 隐藏所有内容区域
        scriptsGrid.style.display = 'none';
        hookContent.style.display = 'none';
        vueContent.style.display = 'none';
        if (mcpContent) mcpContent.style.display = 'none';
        if (headersContent) headersContent.style.display = 'none';
        if (settingsContent) settingsContent.style.display = 'none';

        if (currentTab === 'antidebug') {
            // 显示反调试板块
            if (searchSection) searchSection.style.display = 'block';
            if (hookNoticeContainer) hookNoticeContainer.style.display = 'none';
            scriptsGrid.style.display = 'grid';
            renderAntiDebugScripts(scriptsToShow);
        } else if (currentTab === 'hook') {
            // 显示Hook板块
            if (searchSection) searchSection.style.display = 'block';
            if (hookNoticeContainer) hookNoticeContainer.style.display = 'flex';
            hookContent.style.display = 'flex';
            // 🆕 读取筛选状态并更新按钮
            loadHookFilterState().then(() => {
                updateHookFilterButtons();
                renderHookScripts(scriptsToShow);
            });
        } else if (currentTab === 'vue') {
            // 显示Vue板块
            if (searchSection) searchSection.style.display = 'none';
            if (hookNoticeContainer) hookNoticeContainer.style.display = 'none';
            vueContent.style.display = 'flex';
            loadFrontendAnalysis();
            loadApiAnalysis();
            renderVueScripts(scriptsToShow);
            // 生成实例标签并显示数据
            displayMultipleInstances();
            // 确保默认显示脚本控制面板
            if (currentVueTab === 'scripts') {
                switchVueTab('scripts');
            }
        } else if (currentTab === 'headers') {
            // 显示Headers板块
            if (searchSection) searchSection.style.display = 'none';
            if (hookNoticeContainer) hookNoticeContainer.style.display = 'none';
            if (headersContent) headersContent.style.display = 'flex';
            initHeadersPanel();
            loadHeaderIntelligence();
        } else if (currentTab === 'settings') {
            if (searchSection) searchSection.style.display = 'none';
            if (hookNoticeContainer) hookNoticeContainer.style.display = 'none';
            if (settingsContent) settingsContent.style.display = 'flex';
            renderVueScripts(allScripts.filter(script => script.category === 'vue'));
        } else if (currentTab === 'mcp') {
            // 显示MCP板块
            if (searchSection) searchSection.style.display = 'none';
            if (hookNoticeContainer) hookNoticeContainer.style.display = 'none';
            if (mcpContent) mcpContent.style.display = 'flex';
        }
    }

    // 渲染反调试脚本（3列网格）
    function renderAntiDebugScripts(scripts) {
        scriptsGrid.innerHTML = '';
        noResults.style.display = 'none';

        if (scripts.length === 0) {
            noResults.style.display = 'flex';
            return;
        }

        scripts.forEach(script => {
            if (typeof script.id !== 'string' || !script.id.trim()) {
                console.error('Invalid script ID:', script);
                return;
            }

            const isEnabled = enabledScripts.includes(script.id);
            const scriptItem = document.createElement('div');
            scriptItem.className = `script-item ${isEnabled ? 'active' : ''}`;

            let description = script.description;

            scriptItem.innerHTML = `
                <div class="script-content">
                    <div class="script-header">
                        <div class="script-name">${script.name}</div>
                        <label class="switch">
                            <input type="checkbox" ${isEnabled ? 'checked' : ''} data-id="${script.id}">
                            <span class="slider"></span>
                        </label>
                    </div>
                    <div class="script-description-wrapper">
                        <div class="script-description">${description}</div>
                        <button class="expand-description-btn" style="display: none;">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="6 9 12 15 18 9"></polyline>
                            </svg>
                        </button>
                    </div>
                </div>
            `;

            scriptsGrid.appendChild(scriptItem);

            const checkbox = scriptItem.querySelector('input[type="checkbox"]');
            checkbox.addEventListener('change', (e) => {
                handleScriptToggle(script.id, e.target.checked, scriptItem);
            });

            // 🆕 检查描述是否需要展开按钮
            const descriptionEl = scriptItem.querySelector('.script-description');
            const expandBtn = scriptItem.querySelector('.expand-description-btn');
            
            // 使用 setTimeout 确保 DOM 渲染完成后再检查
            setTimeout(() => {
                // 临时移除line-clamp限制来准确测量完整高度
                const originalDisplay = descriptionEl.style.display;
                const originalWebkitLineClamp = descriptionEl.style.webkitLineClamp;
                const originalOverflow = descriptionEl.style.overflow;
                
                // 临时设置为block以获取完整高度
                descriptionEl.style.display = 'block';
                descriptionEl.style.webkitLineClamp = 'unset';
                descriptionEl.style.overflow = 'visible';
                
                const fullHeight = descriptionEl.scrollHeight;
                
                // 恢复原始样式
                descriptionEl.style.display = originalDisplay || '';
                descriptionEl.style.webkitLineClamp = originalWebkitLineClamp || '';
                descriptionEl.style.overflow = originalOverflow || '';
                
                // 计算3行的高度（line-height * 3）
                const computedStyle = getComputedStyle(descriptionEl);
                const lineHeight = parseFloat(computedStyle.lineHeight) || 15.4; // 默认值：11px * 1.4
                const maxHeight = lineHeight * 3;
                
                // 如果完整高度超过3行高度，显示展开按钮
                if (fullHeight > maxHeight + 2) { // 加2px容差
                    expandBtn.style.display = 'flex';
                }
            }, 10);

            // 🆕 展开/收起按钮点击事件
            expandBtn.addEventListener('click', (e) => {
                e.stopPropagation(); // 阻止事件冒泡
                const isExpanded = scriptItem.classList.contains('expanded');
                
                if (isExpanded) {
                    // 收起
                    scriptItem.classList.remove('expanded');
                    expandBtn.querySelector('svg').style.transform = 'rotate(0deg)';
                } else {
                    // 展开
                    scriptItem.classList.add('expanded');
                    expandBtn.querySelector('svg').style.transform = 'rotate(180deg)';
                }
            });
        });
    }

    // 渲染Vue脚本（横向列表，支持父子关系）
    function renderVueScripts(scripts) {
        vueScriptsList.innerHTML = '';

        // 过滤出父脚本（没有 parentScript 字段的）
        const parentScripts = scripts.filter(script => !script.parentScript);

        if (parentScripts.length === 0 && scripts.length === 0) {
            vueScriptsList.innerHTML = '<div class="empty-state">暂无 Vue 脚本</div>';
            return;
        }

        parentScripts.forEach(parentScript => {
            if (typeof parentScript.id !== 'string' || !parentScript.id.trim()) {
                console.error('Invalid script ID:', parentScript);
                return;
            }

            // 渲染父脚本
            const isParentEnabled = enabledScripts.includes(parentScript.id) ||
                scripts.some(s => s.parentScript === parentScript.id && enabledScripts.includes(s.id));
            const parentItem = createVueScriptItem(parentScript, isParentEnabled, false);
            vueScriptsList.appendChild(parentItem);

            // 查找子脚本
            const childScripts = scripts.filter(s => s.parentScript === parentScript.id);

            // 如果父脚本开启（或子脚本开启），显示子脚本
            if (isParentEnabled && childScripts.length > 0) {
                childScripts.forEach(childScript => {
                    const isChildEnabled = enabledScripts.includes(childScript.id);
                    const childItem = createVueScriptItem(childScript, isChildEnabled, true);
                    vueScriptsList.appendChild(childItem);
                });
            }
        });
    }

    // 创建Vue脚本项
    function createVueScriptItem(script, isEnabled, isChild) {
        const scriptItem = document.createElement('div');
        scriptItem.className = `vue-script-item ${isEnabled ? 'active' : ''} ${isChild ? 'child-script' : ''}`;
        scriptItem.dataset.scriptId = script.id;

        scriptItem.innerHTML = `
            <div class="vue-script-name">${script.name}</div>
            <label class="vue-script-switch">
                <input type="checkbox" ${isEnabled ? 'checked' : ''} data-id="${script.id}">
                <span class="slider"></span>
            </label>
            <div class="vue-script-info">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="16" x2="12" y2="12"></line>
                    <line x1="12" y1="8" x2="12.01" y2="8"></line>
                </svg>
                <div class="tooltip">${script.description}</div>
            </div>
        `;

        const checkbox = scriptItem.querySelector('input[type="checkbox"]');
        checkbox.addEventListener('change', (e) => {
            handleVueScriptToggle(script, e.target.checked);
        });

        return scriptItem;
    }

    // 🆕 读取Hook筛选状态
    function loadHookFilterState() {
        return new Promise((resolve) => {
            chrome.storage.local.get(['hook_filter_state'], (result) => {
                hookFilterState = result.hook_filter_state || null;
                resolve(hookFilterState);
            });
        });
    }

    // 🆕 保存Hook筛选状态
    function saveHookFilterState(state) {
        hookFilterState = state;
        chrome.storage.local.set({ hook_filter_state: state });
    }

    // 🆕 更新筛选按钮状态
    function updateHookFilterButtons() {
        if (hookFilterEnabledBtn && hookFilterDisabledBtn) {
            hookFilterEnabledBtn.classList.toggle('active', hookFilterState === 'enabled');
            hookFilterDisabledBtn.classList.toggle('active', hookFilterState === 'disabled');
        }
    }

    // 🆕 应用Hook筛选
    function applyHookFilter(scripts) {
        if (!hookFilterState) {
            return scripts; // 无筛选，返回所有脚本
        }
        
        return scripts.filter(script => {
            const isEnabled = enabledScripts.includes(script.id);
            if (hookFilterState === 'enabled') {
                return isEnabled;
            } else if (hookFilterState === 'disabled') {
                return !isEnabled;
            }
            return true;
        });
    }

    // 渲染Hook脚本
    function renderHookScripts(scripts) {
        // 🔧 修复：如果当前在 Hook 板块且有搜索词，应用搜索过滤
        if (currentTab === 'hook' && searchInput && searchInput.value.trim()) {
            const searchTerm = searchInput.value.toLowerCase();
            scripts = scripts.filter(script =>
                script.name.toLowerCase().includes(searchTerm)
            );
        }
        
        // 🆕 应用筛选（已开启/未开启）
        scripts = applyHookFilter(scripts);
        
        // 🔧 修复：先批量加载所有配置，配置加载完成后再清空并渲染，避免闪烁
        if (scripts.length === 0) {
            hookContent.innerHTML = '<div class="empty-state">暂无 Hook 脚本</div>';
            return;
        }
        
        // 先批量加载所有配置（不清空容器，保持旧内容显示）
        const configPromises = scripts.map(script => {
            if (typeof script.id !== 'string' || !script.id.trim()) {
                console.error('Invalid script ID:', script);
                return null;
            }
            return loadHookConfig(script.id).then(config => ({
                script,
                config
            }));
        }).filter(p => p !== null);
        
        // 等待所有配置加载完成
        Promise.all(configPromises).then(results => {
            // 配置加载完成后，再清空容器并同步渲染所有脚本项
            hookContent.innerHTML = '';
            
            results.forEach(({ script, config }) => {
                const isEnabled = enabledScripts.includes(script.id);
                const isFixedVariate = script.fixed_variate === 1;
                const hasParam = script.has_Param === 1;
                
                // 如果脚本已启用，确保配置正确初始化
                if (isEnabled && !isFixedVariate) {
                    if (hasParam) {
                        // has_Param=1：必须创建param（即使为空数组）和flag
                        if (config.param === undefined) {
                            config.param = [];
                        }
                        // 🔧 新增：初始化关键字检索开关（默认为关闭，即 false）
                        if (config.keyword_filter_enabled === undefined) {
                            config.keyword_filter_enabled = false;
                        }
                        // 🔧 修改：如果开关关闭，强制 flag=0；如果开关开启，根据关键字数量设置 flag
                        if (config.flag === undefined) {
                            if (config.keyword_filter_enabled) {
                                config.flag = config.param.length > 0 ? 1 : 0;
                            } else {
                                config.flag = 0; // 开关关闭时，flag 必须为 0
                                // 🔧 修复：不清空关键字，保留存储的关键字
                            }
                        } else if (!config.keyword_filter_enabled) {
                            // 🔧 修复：如果开关关闭，只设置 flag=0，不清空存储的关键字
                            config.flag = 0;
                        }
                        if (Object.keys(config).length > 0) {
                            saveHookConfig(script.id, config);
                        }
                    } else {
                        // has_Param=0：必须创建flag=0
                        if (config.flag === undefined) {
                            config.flag = 0;
                            saveHookConfig(script.id, config);
                        }
                    }
                }
                
                const scriptItem = createHookScriptItem(script, isEnabled, isFixedVariate, hasParam, config);
                hookContent.appendChild(scriptItem);
            });
        });
    }
    
    // 创建Hook脚本项
    function createHookScriptItem(script, isEnabled, isFixedVariate, hasParam, config) {
        const scriptItem = document.createElement('div');
        scriptItem.className = `hook-script-item ${isEnabled ? 'enabled' : 'disabled'}`;
        scriptItem.dataset.scriptId = script.id;
        
        // 获取动态开关（debugger, stack等）
        const dynamicSwitches = [];
        Object.keys(script).forEach(key => {
            if (!['id', 'name', 'description', 'category', 'fixed_variate', 'has_Param', 'parentScript'].includes(key)) {
                if (script[key] === 1) {
                    dynamicSwitches.push(key);
                }
            }
        });
        
        // 构建输入区域
        let inputArea = '';
        if (isFixedVariate) {
            // 固定变量脚本：显示固定值输入
            // 优先使用配置中的值，如果没有则使用scripts.json中的默认值
            const value = config?.value || script.value || '';
            inputArea = `
                <div class="hook-input-group">
                    <label class="hook-input-label">固定值：</label>
                    <div class="hook-input-wrapper hook-value-input-wrapper">
                        <input type="text" class="hook-value-input" 
                               value="${value}" 
                               placeholder="输入固定值后按Enter保存" 
                               ${!isEnabled ? 'disabled' : ''}>
                        <div class="hook-value-tooltip">输入固定值后按Enter保存</div>
                    </div>
                </div>
            `;
        } else {
            // 非固定变量脚本
            if (hasParam) {
                // 支持关键字过滤
                // 🔧 新增：检查关键字检索开关状态（默认为关闭，即 false）
                const keywordFilterEnabled = config?.keyword_filter_enabled !== undefined ? config.keyword_filter_enabled : false;
                
                // 🔧 修改：如果开关关闭，只隐藏关键字显示（UI层面），不清空存储的关键字
                let keywords = config?.param || [];
                if (!keywordFilterEnabled) {
                    keywords = []; // 只用于UI显示，不修改 config.param
                    if (config && config.flag !== 0) {
                        config.flag = 0; // 确保 flag=0
                    }
                }
                
                const keywordList = keywords.map((kw, idx) => `
                    <div class="keyword-item">
                        <span>${kw}</span>
                        <button class="keyword-remove-btn" data-index="${idx}" ${!isEnabled || !keywordFilterEnabled ? 'disabled' : ''}>×</button>
                    </div>
                `).join('');
                
                inputArea = `
                    <div class="hook-input-group">
                        <div class="hook-input-label-row">
                            <label class="hook-input-label">关键字：</label>
                            <div class="hook-keyword-filter-switch">
                                <label class="hook-keyword-filter-switch-label">
                                    <input type="checkbox" class="hook-keyword-filter-checkbox" ${keywordFilterEnabled ? 'checked' : ''} ${!isEnabled ? 'disabled' : ''} data-script-id="${script.id}">
                                    <span class="hook-keyword-filter-slider"></span>
                                </label>
                                <span class="hook-keyword-filter-label-text">检索关键字</span>
                            </div>
                        </div>
                        <div class="hook-keywords-container ${!keywordFilterEnabled ? 'keyword-filter-disabled' : ''}">
                            ${keywordList}
                            <div class="hook-input-wrapper">
                                <input type="text" class="hook-keyword-input" 
                                       placeholder="输入关键字后按Enter添加" 
                                       ${!isEnabled || !keywordFilterEnabled ? 'disabled' : ''}>
                            </div>
                        </div>
                    </div>
                `;
            } else {
                // 不支持关键字过滤，不显示输入框
                inputArea = '';
            }
        }
        
        // 构建动态开关
        const switchesHtml = dynamicSwitches.map(switchKey => {
            const switchValue = config?.[switchKey] || 0;
            return `
                <button class="hook-switch-btn ${switchValue === 1 ? 'active' : ''}" 
                        data-switch="${switchKey}" 
                        ${!isEnabled ? 'disabled' : ''}>
                    ${switchKey}
                </button>
            `;
        }).join('');
        
        scriptItem.innerHTML = `
            <div class="hook-script-header">
                <div class="hook-script-name">${script.name}</div>
                <div class="vue-script-info">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="10"></circle>
                        <line x1="12" y1="16" x2="12" y2="12"></line>
                        <line x1="12" y1="8" x2="12.01" y2="8"></line>
                    </svg>
                    <div class="tooltip">${script.description || '暂无描述'}</div>
                </div>
                <label class="hook-main-switch">
                    <input type="checkbox" ${isEnabled ? 'checked' : ''} data-id="${script.id}">
                    <span class="hook-slider"></span>
                </label>
            </div>
            ${inputArea}
            <div class="hook-script-actions">
                <span class="hook-action-label">开启</span>
                ${switchesHtml}
            </div>
        `;
        
        // 绑定事件
        const checkbox = scriptItem.querySelector('input[type="checkbox"]');
        checkbox.addEventListener('change', (e) => {
            handleHookScriptToggle(script, e.target.checked, scriptItem);
        });
        
        // 固定值输入框事件（使用Enter键保存）
        if (isFixedVariate) {
            const valueInput = scriptItem.querySelector('.hook-value-input');
            const tooltip = scriptItem.querySelector('.hook-value-tooltip');
            const inputWrapper = scriptItem.querySelector('.hook-value-input-wrapper');
            
            // 获得焦点时显示提示框
            valueInput.addEventListener('focus', () => {
                inputWrapper.classList.add('show-tooltip');
            });
            
            // 失去焦点时隐藏提示框
            valueInput.addEventListener('blur', () => {
                inputWrapper.classList.remove('show-tooltip');
            });
            
            valueInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter' && isEnabled) {
                    const value = e.target.value.trim();
                    if (value) {
                        // 保存固定值
                        saveHookConfigValue(script.id, value);
                        showToast('已保存');
                    } else {
                        // 如果输入为空，清空固定值
                        saveHookConfigValue(script.id, '');
                        showToast('已清空');
                    }
                }
            });
        }
        
        // 关键字输入框事件（非固定变量且支持关键字）
        if (!isFixedVariate && hasParam) {
            const keywordInput = scriptItem.querySelector('.hook-keyword-input');
            const keywordsContainer = scriptItem.querySelector('.hook-keywords-container');
            const keywordFilterCheckbox = scriptItem.querySelector('.hook-keyword-filter-checkbox');
            
            // 🔧 新增：关键字检索开关切换事件
            if (keywordFilterCheckbox) {
                keywordFilterCheckbox.addEventListener('change', (e) => {
                    handleKeywordFilterToggle(script.id, e.target.checked, scriptItem, isEnabled);
                });
            }
            
            keywordInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter' && e.target.value.trim()) {
                    // 🔧 修改：检查开关状态
                    loadHookConfig(script.id).then(config => {
                        if (config?.keyword_filter_enabled) {
                            addKeyword(script.id, e.target.value.trim(), keywordsContainer, isEnabled);
                            e.target.value = '';
                        }
                    });
                }
            });
            
            // 绑定删除关键字按钮
            scriptItem.querySelectorAll('.keyword-remove-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    // 🔧 修改：检查开关状态
                    loadHookConfig(script.id).then(config => {
                        if (config?.keyword_filter_enabled) {
                            const index = parseInt(e.target.dataset.index);
                            removeKeyword(script.id, index, keywordsContainer, isEnabled);
                        }
                    });
                });
            });
        }
        
        // 动态开关事件
        scriptItem.querySelectorAll('.hook-switch-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                if (isEnabled) {
                    const switchKey = e.target.dataset.switch;
                    // 🔧 修复：根据按钮的当前状态（active类）来判断当前值，而不是依赖闭包中的config
                    const isActive = e.target.classList.contains('active');
                    const newValue = isActive ? 0 : 1;
                    toggleHookSwitch(script.id, switchKey, newValue, e.target);
                }
            });
        });
        
        return scriptItem;
    }
    
    // 加载Hook脚本配置
    function loadHookConfig(scriptId) {
        return new Promise((resolve) => {
            const configKey = `${scriptId}_config`;
            chrome.storage.local.get([configKey], (result) => {
                resolve(result[configKey] || {});
            });
        });
    }
    
    // 保存Hook脚本配置
    function saveHookConfig(scriptId, config) {
        const configKey = `${scriptId}_config`;
        chrome.storage.local.set({
            [configKey]: config
        }, () => {
            // 🔧 修改：用户修改配置时只保存到chrome.storage.local，不发送消息
            // 等下次刷新页面后，content.js会在页面加载时自动同步并发送消息
        });
    }
    
    // 保存固定值
    function saveHookConfigValue(scriptId, value) {
        loadHookConfig(scriptId).then(config => {
            config.value = value;
            saveHookConfig(scriptId, config);
        });
    }
    
    // 🔧 新增：处理关键字检索开关切换
    function handleKeywordFilterToggle(scriptId, enabled, scriptItem, isEnabled) {
        loadHookConfig(scriptId).then(config => {
            config.keyword_filter_enabled = enabled;
            
            if (!enabled) {
                // 🔧 修改：关闭开关时，只设置 flag=0，不清空存储的关键字
                config.flag = 0;
            } else {
                // 开启开关：根据关键字数量设置 flag
                if (!config.param) {
                    config.param = [];
                }
                config.flag = config.param.length > 0 ? 1 : 0;
            }
            
            saveHookConfig(scriptId, config);
            
            // 更新UI状态
            const keywordsContainer = scriptItem.querySelector('.hook-keywords-container');
            const keywordInput = scriptItem.querySelector('.hook-keyword-input');
            const keywordRemoveBtns = scriptItem.querySelectorAll('.keyword-remove-btn');
            
            if (enabled) {
                // 开启：启用输入框和删除按钮，重新显示关键字
                keywordsContainer.classList.remove('keyword-filter-disabled');
                if (keywordInput) keywordInput.disabled = !isEnabled;
                keywordRemoveBtns.forEach(btn => {
                    btn.disabled = !isEnabled;
                });
                
                // 🔧 修改：重新渲染关键字列表（从存储中恢复）
                const existingKeywords = config.param || [];
                const inputWrapper = keywordsContainer.querySelector('.hook-input-wrapper');
                // 清空现有显示的关键字
                keywordsContainer.querySelectorAll('.keyword-item').forEach(item => item.remove());
                // 重新添加关键字
                existingKeywords.forEach((kw, idx) => {
                    const keywordItem = document.createElement('div');
                    keywordItem.className = 'keyword-item';
                    keywordItem.innerHTML = `
                        <span>${kw}</span>
                        <button class="keyword-remove-btn" data-index="${idx}" ${!isEnabled ? 'disabled' : ''}>×</button>
                    `;
                    inputWrapper.parentNode.insertBefore(keywordItem, inputWrapper);
                });
                
                // 重新绑定删除按钮事件
                keywordsContainer.querySelectorAll('.keyword-remove-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        if (isEnabled && config.keyword_filter_enabled) {
                            const index = parseInt(e.target.dataset.index);
                            removeKeyword(scriptId, index, keywordsContainer, isEnabled);
                        }
                    });
                });
            } else {
                // 🔧 修改：关闭：禁用输入框和删除按钮，隐藏关键字列表（不清空存储）
                keywordsContainer.classList.add('keyword-filter-disabled');
                if (keywordInput) keywordInput.disabled = true;
                keywordRemoveBtns.forEach(btn => {
                    btn.disabled = true;
                });
                
                // 🔧 修改：只隐藏关键字列表UI，不清空存储
                const keywordItems = keywordsContainer.querySelectorAll('.keyword-item');
                keywordItems.forEach(item => item.remove());
            }
        });
    }
    
    // 添加关键字
    function addKeyword(scriptId, keyword, container, isEnabled) {
        loadHookConfig(scriptId).then(config => {
            // 🔧 修改：检查开关状态
            if (!config.keyword_filter_enabled) {
                return; // 开关关闭时不允许添加关键字
            }
            
            if (!config.param) {
                config.param = [];
            }
            if (config.param.indexOf(keyword) === -1) {
                config.param.push(keyword);
                // 🔧 修改：根据关键字数量设置 flag
                config.flag = config.param.length > 0 ? 1 : 0;
                saveHookConfig(scriptId, config);
                
                // 更新UI
                const keywordItem = document.createElement('div');
                keywordItem.className = 'keyword-item';
                keywordItem.innerHTML = `
                    <span>${keyword}</span>
                    <button class="keyword-remove-btn" data-index="${config.param.length - 1}" ${!isEnabled ? 'disabled' : ''}>×</button>
                `;
                const inputWrapper = container.querySelector('.hook-input-wrapper');
                container.insertBefore(keywordItem, inputWrapper);
                
                // 绑定删除事件
                keywordItem.querySelector('.keyword-remove-btn').addEventListener('click', (e) => {
                    loadHookConfig(scriptId).then(cfg => {
                        if (cfg?.keyword_filter_enabled) {
                            const index = parseInt(e.target.dataset.index);
                            removeKeyword(scriptId, index, container, isEnabled);
                        }
                    });
                });
            }
        });
    }
    
    // 删除关键字
    function removeKeyword(scriptId, index, container, isEnabled) {
        loadHookConfig(scriptId).then(config => {
            // 🔧 修改：检查开关状态
            if (!config.keyword_filter_enabled) {
                return; // 开关关闭时不允许删除关键字
            }
            
            if (config.param && config.param.length > index) {
                config.param.splice(index, 1);
                // 🔧 修改：根据关键字数量设置 flag
                if (config.param.length === 0) {
                    config.flag = 0; // 没有关键字时设置flag为0
                    config.param = []; // 保持为空数组
                } else {
                    config.flag = 1; // 还有关键字时保持 flag=1
                }
                saveHookConfig(scriptId, config);
                
                // 重新渲染关键字列表
                const keywordItems = container.querySelectorAll('.keyword-item');
                keywordItems[index].remove();
                
                // 更新所有删除按钮的索引
                container.querySelectorAll('.keyword-remove-btn').forEach((btn, idx) => {
                    btn.dataset.index = idx;
                });
            }
        });
    }
    
    // 切换Hook动态开关
    function toggleHookSwitch(scriptId, switchKey, value, buttonElement) {
        loadHookConfig(scriptId).then(config => {
            config[switchKey] = value;
            saveHookConfig(scriptId, config);
            
            // 更新UI
            if (value === 1) {
                buttonElement.classList.add('active');
            } else {
                buttonElement.classList.remove('active');
            }
        });
    }
    
    // 处理Hook脚本开关切换
    function handleHookScriptToggle(script, isChecked, scriptItem) {
        if (isChecked) {
            if (!enabledScripts.includes(script.id)) {
                enabledScripts.push(script.id);
            }
            scriptItem.classList.add('enabled');
            scriptItem.classList.remove('disabled');
            
            // 初始化配置（如果不存在）
            loadHookConfig(script.id).then(config => {
                const isFixedVariate = script.fixed_variate === 1;
                const hasParam = script.has_Param === 1;
                
                // 固定变量脚本：如果配置中没有值，使用scripts.json中的默认值
                if (isFixedVariate) {
                    // 检查scripts.json中是否有默认值
                    if (script.value !== undefined && script.value !== null) {
                        // 如果配置中没有保存的值，使用默认值
                        if (config.value === undefined || config.value === '') {
                            config.value = script.value;
                            saveHookConfig(script.id, config);
                            
                            // 更新输入框显示
                            const valueInput = scriptItem.querySelector('.hook-value-input');
                            if (valueInput) {
                                valueInput.value = script.value;
                            }
                        }
                    }
                } else {
                    // 非固定变量脚本：确保flag和param存在
                    if (hasParam) {
                        // has_Param=1：必须创建param（即使为空数组）和flag
                        if (config.param === undefined) {
                            config.param = [];
                        }
                        // 🔧 新增：初始化关键字检索开关（默认为关闭，即 false）
                        if (config.keyword_filter_enabled === undefined) {
                            config.keyword_filter_enabled = false;
                        }
                        // 🔧 修改：如果开关关闭，强制 flag=0；如果开关开启，根据关键字数量设置 flag
                        if (config.flag === undefined) {
                            if (config.keyword_filter_enabled) {
                                config.flag = config.param.length > 0 ? 1 : 0;
                            } else {
                                config.flag = 0; // 开关关闭时，flag 必须为 0
                                // 🔧 修复：不清空关键字，保留存储的关键字
                            }
                        } else if (!config.keyword_filter_enabled) {
                            // 🔧 修复：如果开关关闭，只设置 flag=0，不清空存储的关键字
                            config.flag = 0;
                        }
                    } else {
                        // has_Param=0：必须创建flag=0，不创建param
                        if (config.flag === undefined) {
                            config.flag = 0;
                        }
                    }
                    saveHookConfig(script.id, config);
                }
                
                // 🔧 修改：根据关键字检索开关状态启用/禁用控件
                if (hasParam && !isFixedVariate) {
                    const keywordFilterEnabled = config?.keyword_filter_enabled !== undefined ? config.keyword_filter_enabled : false;
                    const keywordInput = scriptItem.querySelector('.hook-keyword-input');
                    const keywordRemoveBtns = scriptItem.querySelectorAll('.keyword-remove-btn');
                    const keywordsContainer = scriptItem.querySelector('.hook-keywords-container');
                    
                    if (keywordFilterEnabled) {
                        // 开启：启用关键字输入框和删除按钮
                        if (keywordInput) keywordInput.disabled = false;
                        keywordRemoveBtns.forEach(btn => {
                            btn.disabled = false;
                        });
                        if (keywordsContainer) keywordsContainer.classList.remove('keyword-filter-disabled');
                    } else {
                        // 关闭：禁用关键字输入框和删除按钮
                        if (keywordInput) keywordInput.disabled = true;
                        keywordRemoveBtns.forEach(btn => {
                            btn.disabled = true;
                        });
                        if (keywordsContainer) keywordsContainer.classList.add('keyword-filter-disabled');
                    }
                } else {
                    // 其他控件正常启用
                    scriptItem.querySelectorAll('input:not(.hook-keyword-input), button:not(.keyword-remove-btn)').forEach(el => {
                        el.disabled = false;
                    });
                }
                
                // 🔧 修改：用户修改配置时只保存到chrome.storage.local，不发送消息
                // 等下次刷新页面后，content.js会在页面加载时自动同步并发送消息
            });
        } else {
            enabledScripts = enabledScripts.filter(id => id !== script.id);
            scriptItem.classList.remove('enabled');
            scriptItem.classList.add('disabled');
            
            // 禁用所有控件（除了主开关）
            scriptItem.querySelectorAll('input:not([type="checkbox"]), button:not(.hook-main-switch input)').forEach(el => {
                el.disabled = true;
            });
        }
        
        updateStorage(enabledScripts);
        
        // 🆕 如果当前有筛选状态，重新渲染Hook脚本列表以应用筛选
        if (currentTab === 'hook' && hookFilterState) {
            const scriptsToShow = getScriptsForCurrentTab();
            renderHookScripts(scriptsToShow);
        }
    }
    
    // 同步Hook配置到页面localStorage
    function syncHookConfigToPage(scriptId, config) {
        if (!currentTab_obj || !currentTab_obj.id) return;
        
        // 获取脚本信息以判断类型
        const script = allScripts.find(s => s.id === scriptId);
        if (!script) return;
        
        const scriptName = scriptId; // 脚本文件名
        const baseKey = `Antidebug_breaker_${scriptName}`;
        
        // 构建要同步的localStorage数据
        const localStorageData = {};
        
        const isFixedVariate = script.fixed_variate === 1;
        const hasParam = script.has_Param === 1;
        
        // 固定变量脚本
        if (isFixedVariate) {
            if (config.value !== undefined) {
                localStorageData[`${baseKey}_value`] = config.value;
            }
        } else {
            // 非固定变量脚本
            // has_Param=0：必须创建flag=0
            // has_Param=1：必须创建flag和param（即使为空数组）
            if (hasParam) {
                // 必须创建param（即使为空数组）
                localStorageData[`${baseKey}_param`] = JSON.stringify(config.param || []);
                // 必须创建flag
                localStorageData[`${baseKey}_flag`] = (config.flag !== undefined ? config.flag : (config.param && config.param.length > 0 ? 1 : 0)).toString();
            } else {
                // has_Param=0：必须创建flag=0
                localStorageData[`${baseKey}_flag`] = '0';
            }
        }
        
        // 动态开关（debugger, stack等）
        Object.keys(config).forEach(key => {
            // 🔧 修改：排除 keyword_filter_enabled，它只是插件UI的控制开关，不需要同步到页面
            if (!['value', 'flag', 'param', 'keyword_filter_enabled'].includes(key)) {
                localStorageData[`${baseKey}_${key}`] = (config[key] || 0).toString();
            }
        });
        
        // 发送消息到content script同步
        tabsApi.sendMessage(currentTab_obj.id, {
            type: 'SYNC_HOOK_CONFIG',
            scriptId: scriptId,
            config: localStorageData
        }).catch(err => {
            console.warn('同步Hook配置失败:', err);
        });
    }

    // 当前选中的Vue标签页
    let currentVueTab = 'routes';

    // 显示多个Vue实例（新增函数）
    function displayMultipleInstances() {
        if (!vueTabsList) return;
        
        // 🔧 保存当前用户选择的标签，避免切换脚本时跳转
        const previousTab = currentVueTab;
        
        // 清空除了"脚本控制"以外的标签
        const existingTabs = vueTabsList.querySelectorAll('.vue-tab-item:not([data-vue-tab="scripts"])');
        existingTabs.forEach(tab => tab.remove());
        
        // 没有数据
        if (!cachedVueDataList || cachedVueDataList.length === 0) {
            if (vueEmptyHint) vueEmptyHint.style.display = 'flex';
            if (vueRoutesPanel) vueRoutesPanel.style.display = 'none';
            displayVueRouterData(null);
            return;
        }
        
        // 检查是否有有效的路由数据
        const validInstances = cachedVueDataList.filter(d => d && !d.notFound && d.routes && d.routes.length > 0);
        
        if (validInstances.length === 0) {
            // 没有有效路由数据，但可能有版本信息
            if (vueEmptyHint) vueEmptyHint.style.display = 'flex';
            if (vueRoutesPanel) vueRoutesPanel.style.display = 'none';
            displayVueRouterData(cachedVueDataList[0]); // 尝试显示第一个实例（可能有版本信息）
            return;
        }
        
        if (vueEmptyHint) vueEmptyHint.style.display = 'none';
        
        // 🆕 只有一个有效实例时，直接显示路由列表，不需要点击标签
        if (validInstances.length === 1) {
            // 创建路由列表标签
            const firstValidIndex = cachedVueDataList.findIndex(d => d && !d.notFound && d.routes && d.routes.length > 0);
            const instance = cachedVueDataList[firstValidIndex];
            const routeCount = instance.routes.length;
            
            // 🔧 根据用户当前选择决定标签的激活状态
            const shouldActivateRoutes = previousTab !== 'scripts';
            
            const tabBtn = document.createElement('button');
            tabBtn.className = `vue-tab-item ${shouldActivateRoutes ? 'active' : ''}`;
            tabBtn.dataset.vueTab = `instance-${firstValidIndex}`;
            tabBtn.dataset.instanceIndex = firstValidIndex;
            tabBtn.innerHTML = `
                <span>路由列表</span>
                <span class="tab-badge">${routeCount}</span>
            `;
            tabBtn.onclick = () => switchVueTab(`instance-${firstValidIndex}`, firstValidIndex);
            vueTabsList.appendChild(tabBtn);
            
            // 🔧 更新脚本控制标签的激活状态
            const scriptsTab = vueTabsList.querySelector('[data-vue-tab="scripts"]');
            if (scriptsTab) {
                scriptsTab.classList.toggle('active', previousTab === 'scripts');
            }
            
            // 🔧 根据用户当前选择决定显示哪个面板
            if (previousTab === 'scripts') {
                // 保持在脚本控制面板
                if (vueScriptsPanel) {
                    vueScriptsPanel.classList.add('active');
                    vueScriptsPanel.style.display = 'flex';
                }
                if (vueRoutesPanel) {
                    vueRoutesPanel.classList.remove('active');
                    vueRoutesPanel.style.display = 'none';
                }
                currentVueTab = 'scripts';
            } else {
                // 显示路由面板
                if (vueScriptsPanel) {
                    vueScriptsPanel.classList.remove('active');
                    vueScriptsPanel.style.display = 'none';
                }
                if (vueRoutesPanel) {
                    vueRoutesPanel.classList.add('active');
                    vueRoutesPanel.style.display = 'flex';
                }
                currentVueTab = `instance-${firstValidIndex}`;
                currentInstanceIndex = firstValidIndex;
                displayVueRouterData(instance);
            }
            return;
        }
        
        // 多实例场景：为每个有效实例生成标签
        cachedVueDataList.forEach((instance, index) => {
            if (!instance || instance.notFound || !instance.routes || instance.routes.length === 0) {
                return;
            }
            
            const routeCount = instance.routes.length;
            const tabBtn = document.createElement('button');
            tabBtn.className = 'vue-tab-item';
            tabBtn.dataset.vueTab = `instance-${index}`;
            tabBtn.dataset.instanceIndex = index;
            
            tabBtn.innerHTML = `
                <span>实例 ${index + 1}</span>
                <span class="tab-badge">${routeCount}</span>
            `;
            
            tabBtn.onclick = () => switchVueTab(`instance-${index}`, index);
            vueTabsList.appendChild(tabBtn);
        });
        
        // 🔧 根据用户当前选择决定是否自动切换到路由面板
        const firstValidIndex = cachedVueDataList.findIndex(d => d && !d.notFound && d.routes && d.routes.length > 0);
        if (firstValidIndex >= 0) {
            if (previousTab === 'scripts') {
                // 🔧 用户在脚本控制面板，保持不动
                const scriptsTab = vueTabsList.querySelector('[data-vue-tab="scripts"]');
                if (scriptsTab) scriptsTab.classList.add('active');
                
                if (vueScriptsPanel) {
                    vueScriptsPanel.classList.add('active');
                    vueScriptsPanel.style.display = 'flex';
                }
                if (vueRoutesPanel) {
                    vueRoutesPanel.classList.remove('active');
                    vueRoutesPanel.style.display = 'none';
                }
                currentVueTab = 'scripts';
            } else {
                // 激活第一个标签
                const firstTab = vueTabsList.querySelector(`[data-vue-tab="instance-${firstValidIndex}"]`);
                if (firstTab) firstTab.classList.add('active');
                
                // 显示路由面板
                if (vueScriptsPanel) {
                    vueScriptsPanel.classList.remove('active');
                    vueScriptsPanel.style.display = 'none';
                }
                if (vueRoutesPanel) {
                    vueRoutesPanel.classList.add('active');
                    vueRoutesPanel.style.display = 'flex';
                }
                
                currentVueTab = `instance-${firstValidIndex}`;
                currentInstanceIndex = firstValidIndex;
                displayVueRouterData(cachedVueDataList[firstValidIndex]);
            }
        }
    }
    
    // 切换Vue标签页
    function switchVueTab(tabId, instanceIndex = null) {
        currentVueTab = tabId;
        
        // 更新标签激活状态
        if (vueTabsList) {
            vueTabsList.querySelectorAll('.vue-tab-item').forEach(tab => {
                tab.classList.toggle('active', tab.dataset.vueTab === tabId);
            });
        }
        
        // 切换面板
        if (tabId === 'scripts') {
            if (vueScriptsPanel) {
                vueScriptsPanel.classList.add('active');
                vueScriptsPanel.style.display = 'flex';
            }
            if (vueRoutesPanel) {
                vueRoutesPanel.classList.remove('active');
                vueRoutesPanel.style.display = 'none';
            }
            if (vueEmptyHint) vueEmptyHint.style.display = 'none';
        } else if (tabId.startsWith('instance-') && instanceIndex !== null) {
            if (vueScriptsPanel) {
                vueScriptsPanel.classList.remove('active');
                vueScriptsPanel.style.display = 'none';
            }
            if (vueRoutesPanel) {
                vueRoutesPanel.classList.add('active');
                vueRoutesPanel.style.display = 'flex';
            }
            if (vueEmptyHint) vueEmptyHint.style.display = 'none';
            
            currentInstanceIndex = instanceIndex;
            if (cachedVueDataList[instanceIndex]) {
                displayVueRouterData(cachedVueDataList[instanceIndex]);
            }
        }
    }
    
    // 初始化Vue标签页点击事件
    function initVueTabsEvents() {
        if (!vueTabsList) return;
        
        const scriptsTab = vueTabsList.querySelector('[data-vue-tab="scripts"]');
        if (scriptsTab) {
            scriptsTab.onclick = () => switchVueTab('scripts');
        }
    }
    
    // 初始化
    initVueTabsEvents();
    
    // 🆕 全局路由渲染函数（供搜索使用）
    function renderVueRoutesGlobal(routesToShow) {
        if (!routesListContainer) return;
        routesListContainer.innerHTML = '';
        
        // 路径规范化函数
        const normalizePath = (path) => {
            if (!path || path.trim() === '') return '/';
            if (!path.startsWith('/')) return '/' + path;
            return path;
        };
        
        // URL清理函数
        const cleanUrl = (url) => {
            return url.replace(/([^:]\/)\/+/g, '$1').replace(/\/$/, '');
        };
        
        routesToShow.forEach(route => {
            const normalizedPath = normalizePath(route.path);
            let fullUrl;
            
            // 使用全局变量构建URL
            if (currentCustomBaseValue && currentCustomBaseValue.trim() !== '') {
                const cleanBase = currentCustomBaseValue.endsWith('/') ? currentCustomBaseValue.slice(0, -1) : currentCustomBaseValue;
                if (currentVueRouterMode === 'hash') {
                    const baseUrlWithoutHash = currentVueBaseUrl.endsWith('#') ? currentVueBaseUrl.slice(0, -1) : currentVueBaseUrl;
                    fullUrl = cleanUrl(baseUrlWithoutHash + cleanBase + '/#' + normalizedPath);
                } else {
                    fullUrl = cleanUrl(currentVueBaseUrl + cleanBase + normalizedPath);
                }
            } else {
                if (currentVueRouterMode === 'hash') {
                    const cleanPath = normalizedPath.startsWith('/') ? normalizedPath.substring(1) : normalizedPath;
                    if (currentVueBaseUrl.endsWith('#')) {
                        fullUrl = currentVueBaseUrl + '/' + cleanPath;
                    } else if (currentVueBaseUrl.endsWith('#/')) {
                        fullUrl = currentVueBaseUrl + cleanPath;
                    } else {
                        fullUrl = currentVueBaseUrl + '#/' + cleanPath;
                    }
                    fullUrl = cleanUrl(fullUrl);
                } else {
                    fullUrl = currentVueBaseUrl + normalizedPath;
                }
            }
            
            const routeItem = document.createElement('div');
            routeItem.className = 'route-item';
            routeItem.innerHTML = `
                <div class="route-url" title="${fullUrl}">${fullUrl}</div>
                <div class="route-actions">
                    <button class="route-btn copy-btn" data-url="${fullUrl}">复制</button>
                    <button class="route-btn open-btn" data-url="${fullUrl}">打开</button>
                </div>
            `;
            
            // 绑定事件
            const copyBtn = routeItem.querySelector('.copy-btn');
            const openBtn = routeItem.querySelector('.open-btn');
            
            copyBtn.onclick = () => {
                navigator.clipboard.writeText(fullUrl).then(() => {
                    copyBtn.textContent = '已复制';
                    copyBtn.style.background = 'var(--success)';
                    setTimeout(() => {
                        copyBtn.textContent = '复制';
                        copyBtn.style.background = '';
                    }, 1500);
                });
            };
            
            openBtn.onclick = () => {
                tabsApi.create({ url: fullUrl });
            };
            
            routesListContainer.appendChild(routeItem);
        });
        
        // 显示空状态
        if (routesToShow.length === 0) {
            routesListContainer.innerHTML = '<div class="empty-state">没有匹配的路由</div>';
        }
    }

                // 显示 Vue Router 数据
            // 显示 Vue Router 数据
    function displayVueRouterData(vueRouterInfo) {
        // 路径规范化函数：确保路径以 / 开头
        const normalizePath = (path) => {
            // 如果路径为空或只有空格，返回根路径
            if (!path || path.trim() === '') {
                return '/';
            }
            // 如果路径不以 / 开头，加上 /
            if (!path.startsWith('/')) {
                return '/' + path;
            }
            return path;
        };

        // URL清理函数：清理多余斜杠和尾部斜杠
        const cleanUrl = (url) => {
            return url.replace(/([^:]\/)\/+/g, '$1').replace(/\/$/, '');
        };

        // 默认隐藏工具栏和内联信息
        if (routeToolbar) {
            routeToolbar.style.display = 'none';
        }
        if (vueInlineInfo) {
            vueInlineInfo.style.display = 'none';
        }

        if (!vueRouterInfo) {
            routesListContainer.innerHTML = '<div class="empty-state">暂未捕获运行时路由表。可先使用 Network 与 JS 路径证据，页面刷新后会自动重试。</div>';
            return;
        }

        // 未找到Router
        if (vueRouterInfo.notFound) {
            routesListContainer.innerHTML = '<div class="empty-state">未检测到可读取的运行时路由实例；该站点可能没有前端路由，或框架隐藏了实例。</div>';
            return;
        }

        // ✅ 新增：序列化错误处理
        if (vueRouterInfo.serializationError) {
            routesListContainer.innerHTML = '<div class="empty-state">❌ 路由数据传输失败，请查看控制台（F12）输出的路由信息！</div>';
            return;
        }

        // history 是默认实现细节，不占用结果区；只有 hash 模式需要提醒 URL 生成方式。
        const detectedRouterMode = vueRouterInfo.routerMode || 'history';
        if (vueInlineInfo && routesModeInfo && detectedRouterMode === 'hash') {
            routesModeInfo.textContent = 'Hash 路由';
            vueInlineInfo.style.display = 'flex';
        }

        // 显示路由列表
        if (!vueRouterInfo.routes || vueRouterInfo.routes.length === 0) {
            routesListContainer.innerHTML = '<div class="empty-state">⚠️ 路由表为空</div>';
            return;
        }

        // 显示工具栏（有路由时才显示）
        if (routeToolbar) routeToolbar.style.display = 'flex';

        let baseUrl = vueRouterInfo.baseUrl || window.location.origin;
        const routerMode = vueRouterInfo.routerMode || 'history';
        const detectedBase = vueRouterInfo.routerBase || ''; // 检测到的base（只用于显示）
        const allRoutes = vueRouterInfo.routes;
        
        // 🆕 设置全局变量供搜索使用
        currentVueRoutes = allRoutes;
        currentVueBaseUrl = baseUrl;
        currentVueRouterMode = routerMode;
        renderAttackSurfaceOverview();

        // ✅ 从当前标签页URL提取真实的baseUrl（包含子路径和#）
        if (currentTab_obj && currentTab_obj.url) {
            try {
                const currentUrl = currentTab_obj.url;
                if (routerMode === 'hash' && (currentUrl.includes('#/') || currentUrl.includes('#'))) {
                    const hashIndex = currentUrl.indexOf('#');
                    if (hashIndex > 0) {
                        baseUrl = currentUrl.substring(0, hashIndex + 1);
                    }
                }
            } catch (e) {
                console.warn('[AntiDebug] 提取baseUrl时出错:', e);
            }
        }

        // ✅ 过滤无效的检测结果（完整URL或包含#的base）
        let shouldShowBaseInput = false;
        let cleanDetectedBase = '';
        
        if (detectedBase && detectedBase.trim() !== '') {
            // 如果是完整URL或包含#，不显示输入框
            if (detectedBase.startsWith('http://') || detectedBase.startsWith('https://') || detectedBase.includes('#')) {
                console.warn('[AntiDebug] 检测到的base无效，已忽略:', detectedBase);
            } else {
                // 清理尾部斜杠
                cleanDetectedBase = detectedBase.endsWith('/') ? detectedBase.slice(0, -1) : detectedBase;
                if (cleanDetectedBase !== '/' && cleanDetectedBase !== '') {
                    shouldShowBaseInput = true;
                }
            }
        }

        // ✅ 自定义base逻辑（使用下拉选择框）
        const baseSelect = document.getElementById('base-select');
        const baseCount = document.querySelector('.route-toolbar .base-count');
        const customBaseInput = document.getElementById('custom-base-input');
        const clearBaseBtn = document.querySelector('.route-toolbar .clear-base-btn');

        let currentCustomBase = ''; // 当前选中的base
        const storageKey = `${hostname}_custom_base`;
        const baseListKey = `${hostname}_base_list`; // 存储用户添加的base列表

        // 更新数量显示
        function updateBaseCount() {
            if (!baseCount || !baseSelect) return;
            const count = baseSelect.options.length;
            baseCount.textContent = `+${count}`;
        }

        // 初始化下拉选择框
        function initBaseSelect() {
            if (!baseSelect) return;
            
            // 从storage读取用户添加的base列表和当前选中值
            chrome.storage.local.get([baseListKey, storageKey], (result) => {
                const savedBaseList = result[baseListKey] || [];
                currentCustomBase = result[storageKey] || '';
                currentCustomBaseValue = currentCustomBase;
                
                // 清空并重新填充选项
                baseSelect.innerHTML = '';
                
                // 首先添加"空置"选项
                const noneOption = document.createElement('option');
                noneOption.value = '';
                noneOption.textContent = '空置';
                baseSelect.appendChild(noneOption);
                
                // 如果检测到base，添加到列表
                if (cleanDetectedBase && cleanDetectedBase !== '') {
                    const option = document.createElement('option');
                    option.value = cleanDetectedBase;
                    option.textContent = cleanDetectedBase;
                    baseSelect.appendChild(option);
                }
                
                // 添加用户保存的base（去重）
                savedBaseList.forEach(base => {
                    if (base && base !== cleanDetectedBase && base !== '') {
                        const option = document.createElement('option');
                        option.value = base;
                        option.textContent = base;
                        baseSelect.appendChild(option);
                    }
                });
                
                // 设置当前选中值（默认选"空置"）
                baseSelect.value = currentCustomBase;
                
                // 更新数量显示
                updateBaseCount();
                
                // 初始渲染
                renderRoutes(allRoutes);
            });
        }

        // 显示工具栏
        if (routeToolbar) {
            routeToolbar.style.display = 'flex';
        }
        
        // 初始化下拉框
        initBaseSelect();

        // 下拉选择框变化事件
        if (baseSelect) {
            baseSelect.onchange = (e) => {
                currentCustomBase = e.target.value;
                currentCustomBaseValue = currentCustomBase;
                
                // 保存当前选中值
                chrome.storage.local.set({ [storageKey]: currentCustomBase });
                
                // 重新渲染
                renderRoutesWithSearch();
            };
        }

        // 输入框实时应用
        if (customBaseInput) {
            customBaseInput.oninput = (e) => {
                const newBase = e.target.value.trim();
                if (!newBase) {
                    // 空值时使用下拉框的值
                    currentCustomBase = baseSelect ? baseSelect.value : '';
                } else {
                    // 确保以/开头
                    currentCustomBase = newBase.startsWith('/') ? newBase : '/' + newBase;
                }
                currentCustomBaseValue = currentCustomBase;
                
                // 重新渲染
                renderRoutesWithSearch();
            };
            
            // 回车键保存到列表
            customBaseInput.onkeypress = (e) => {
                if (e.key === 'Enter') {
                    const newBase = customBaseInput.value.trim();
                    if (!newBase) return;
                    
                    const cleanBase = newBase.startsWith('/') ? newBase : '/' + newBase;
                    
                    // 检查是否已存在
                    const exists = Array.from(baseSelect.options).some(opt => opt.value === cleanBase);
                    if (!exists) {
                        // 添加新选项
                        const option = document.createElement('option');
                        option.value = cleanBase;
                        option.textContent = cleanBase;
                        baseSelect.appendChild(option);
                        
                        // 保存到storage
                        chrome.storage.local.get([baseListKey], (result) => {
                            const baseList = result[baseListKey] || [];
                            if (!baseList.includes(cleanBase)) {
                                baseList.push(cleanBase);
                                chrome.storage.local.set({ [baseListKey]: baseList });
                            }
                        });
                        
                        // 更新数量
                        updateBaseCount();
                    }
                    
                    // 选中该选项
                    baseSelect.value = cleanBase;
                    currentCustomBase = cleanBase;
                    currentCustomBaseValue = currentCustomBase;
                    chrome.storage.local.set({ [storageKey]: currentCustomBase });
                    
                    // 清空输入框
                    customBaseInput.value = '';
                    renderRoutesWithSearch();
                }
            };
        }

        // 清空按钮 - 清空输入框，选中"空置"
        if (clearBaseBtn) {
            clearBaseBtn.onclick = () => {
                // 清空输入框
                if (customBaseInput) customBaseInput.value = '';
                
                // 选中"空置"
                baseSelect.value = '';
                currentCustomBase = '';
                currentCustomBaseValue = '';
                
                // 保存到storage
                chrome.storage.local.set({ [storageKey]: '' });
                
                // 重新渲染
                renderRoutesWithSearch();
            };
        }

        // ✅ 渲染路由列表（考虑搜索框）的辅助函数
        function renderRoutesWithSearch() {
            const searchInputEl = document.getElementById('vue-route-search-input');
            const searchTerm = searchInputEl ? searchInputEl.value.toLowerCase().trim() : '';
            if (searchTerm) {
                const filteredRoutes = allRoutes.filter(route => {
                    const path = route.path.toLowerCase();
                    const name = (route.name || '').toLowerCase();
                    const fullUrl = (baseUrl + normalizePath(route.path)).toLowerCase();
                    return path.includes(searchTerm) || name.includes(searchTerm) || fullUrl.includes(searchTerm);
                });
                renderRoutes(filteredRoutes);
            } else {
                renderRoutes(allRoutes);
            }
        };
    
        // 渲染路由列表的函数
        function renderRoutes(routesToShow) {
            routesListContainer.innerHTML = '';

            routesToShow.forEach(route => {
                // 规范化路径
                const normalizedPath = normalizePath(route.path);
                
                // 根据路由模式拼接URL
                let fullUrl;
                
                // ✅ 使用用户输入的base（如果有）
                if (currentCustomBase && currentCustomBase.trim() !== '') {
                    // 用户自定义了base
                    const cleanBase = currentCustomBase.endsWith('/') ? currentCustomBase.slice(0, -1) : currentCustomBase;
                    
                    if (routerMode === 'hash') {
                        const baseUrlWithoutHash = baseUrl.endsWith('#') ? baseUrl.slice(0, -1) : baseUrl;
                        fullUrl = cleanUrl(baseUrlWithoutHash + cleanBase + '/#' + normalizedPath);
                    } else {
                        fullUrl = cleanUrl(baseUrl + cleanBase + normalizedPath);
                    }
                } else {
                    // 标准路径（无base）
                    if (routerMode === 'hash') {
                        const cleanPath = normalizedPath.startsWith('/') ? normalizedPath.substring(1) : normalizedPath;
                        
                        if (baseUrl.endsWith('#')) {
                            fullUrl = baseUrl + '/' + cleanPath;
                        } else if (baseUrl.endsWith('#/')) {
                            fullUrl = baseUrl + cleanPath;
                        } else {
                            fullUrl = baseUrl + '#/' + cleanPath;
                        }
                        
                        fullUrl = cleanUrl(fullUrl);
                    } else {
                        fullUrl = baseUrl + normalizedPath;
                    }
                }

                const routeItem = document.createElement('div');
                routeItem.className = 'route-item';

                routeItem.innerHTML = `
                    <div class="route-url" title="${fullUrl}">${fullUrl}</div>
                    <div class="route-actions">
                        <button class="route-btn copy-btn" data-url="${fullUrl}">复制</button>
                        <button class="route-btn open-btn" data-url="${fullUrl}">打开</button>
                    </div>
                `;

                routesListContainer.appendChild(routeItem);

                // 复制按钮
                const copyBtn = routeItem.querySelector('.copy-btn');
                copyBtn.addEventListener('click', () => {
                    navigator.clipboard.writeText(fullUrl).then(() => {
                        const originalText = copyBtn.textContent;
                        copyBtn.textContent = '✓ 已复制';
                        setTimeout(() => {
                            copyBtn.textContent = originalText;
                        }, 1500);
                    }).catch(err => {
                        console.error('复制失败:', err);
                    });
                });

                // 打开按钮
                const openBtn = routeItem.querySelector('.open-btn');
                openBtn.addEventListener('click', () => {
                    // 🆕 保存当前打开的路由URL到存储（仅当开启了Get_Vue_0或Get_Vue_1脚本时）
                    const hasVueScript = enabledScripts.includes('Get_Vue_0') || enabledScripts.includes('Get_Vue_1');
                    if (hasVueScript && vueRouterInfo && vueRouterInfo.routes && vueRouterInfo.routes.length > 0) {
                        const storageKey = `${hostname}_last_opened_route`;
                        chrome.storage.local.set({
                            [storageKey]: fullUrl
                        });
                    }
                    
                    tabsApi.update(currentTab_obj.id, {
                        url: fullUrl
                    });
                });
            });
            
            // 🆕 渲染完成后，检查是否有保存的路由并滚动到该位置
            // 仅当首次打开插件时执行跳转，切换脚本时不执行
            // 仅当开启了Get_Vue_0或Get_Vue_1脚本且成功获取到路由数据时才执行
            // 🔧 如果用户正在搜索，则不执行跳转
            const hasVueScript = enabledScripts.includes('Get_Vue_0') || enabledScripts.includes('Get_Vue_1');
            const searchInputEl = document.getElementById('vue-route-search-input');
            const isSearching = searchInputEl && searchInputEl.value.trim() !== '';
            
            // 🔧 仅在首次显示Vue路由数据时执行跳转
            if (isFirstVueDataDisplay && hasVueScript && vueRouterInfo && vueRouterInfo.routes && vueRouterInfo.routes.length > 0 && !isSearching) {
                chrome.storage.local.get([`${hostname}_last_opened_route`], (result) => {
                    const lastOpenedRoute = result[`${hostname}_last_opened_route`];
                    if (lastOpenedRoute) {
                        // 检查该路由是否在当前显示的路由列表中
                        const targetRouteItem = Array.from(routesListContainer.querySelectorAll('.route-item')).find(item => {
                            const openBtn = item.querySelector('.open-btn');
                            return openBtn && openBtn.dataset.url === lastOpenedRoute;
                        });
                        
                        if (targetRouteItem) {
                            // 路由存在，直接跳转到该位置并高亮闪烁
                            setTimeout(() => {
                                targetRouteItem.scrollIntoView({
                                    behavior: 'auto',
                                    block: 'center'
                                });
                                
                                // 🆕 添加高亮动画类（柔和淡出效果）
                                targetRouteItem.classList.add('highlight-last-opened');
                                
                                // 动画完成后移除类（1.5秒淡出）
                                setTimeout(() => {
                                    targetRouteItem.classList.remove('highlight-last-opened');
                                }, 1500);
                            }, 100);
                        }
                    }
                });
                // 标记已经执行过跳转，后续不再执行
                isFirstVueDataDisplay = false;
            }
        };

        // 🆕 搜索功能已移至外部全局事件监听
        // 如果搜索框已有内容，立即执行搜索过滤
        const searchInputEl = document.getElementById('vue-route-search-input');
        if (searchInputEl && searchInputEl.value.trim()) {
            const searchTerm = searchInputEl.value.toLowerCase().trim();
            const filteredRoutes = allRoutes.filter(route => {
                const path = route.path.toLowerCase();
                const name = (route.name || '').toLowerCase();
                return path.includes(searchTerm) || name.includes(searchTerm);
            });
            renderRoutes(filteredRoutes);
        }

        // 批量复制功能 - 根据当前用户输入的base复制
        copyAllPathsBtn.onclick = () => {
            const allPaths = allRoutes.map(route => {
                const normalizedPath = normalizePath(route.path);
                
                if (currentCustomBase && currentCustomBase.trim() !== '') {
                    const cleanBase = currentCustomBase.endsWith('/') ? currentCustomBase.slice(0, -1) : currentCustomBase;
                    return cleanBase + normalizedPath;
                }
                return normalizedPath;
            }).join('\n');
            
            navigator.clipboard.writeText(allPaths).then(() => {
                const originalText = copyAllPathsBtn.textContent;
                copyAllPathsBtn.textContent = '✓ 已复制';
                setTimeout(() => {
                    copyAllPathsBtn.textContent = originalText;
                }, 1500);
            }).catch(err => {
                console.error('复制失败:', err);
            });
        };

        copyAllUrlsBtn.onclick = () => {
            const allUrls = allRoutes.map(route => {
                const normalizedPath = normalizePath(route.path);
                let fullUrl;
                
                if (currentCustomBase && currentCustomBase.trim() !== '') {
                    const cleanBase = currentCustomBase.endsWith('/') ? currentCustomBase.slice(0, -1) : currentCustomBase;
                    
                    if (routerMode === 'hash') {
                        const baseUrlWithoutHash = baseUrl.endsWith('#') ? baseUrl.slice(0, -1) : baseUrl;
                        fullUrl = cleanUrl(baseUrlWithoutHash + cleanBase + '/#' + normalizedPath);
                    } else {
                        fullUrl = cleanUrl(baseUrl + cleanBase + normalizedPath);
                    }
                } else {
                    if (routerMode === 'hash') {
                        const cleanPath = normalizedPath.startsWith('/') ? normalizedPath.substring(1) : normalizedPath;
                        
                        if (baseUrl.endsWith('#')) {
                            fullUrl = baseUrl + '/' + cleanPath;
                        } else if (baseUrl.endsWith('#/')) {
                            fullUrl = baseUrl + cleanPath;
                        } else {
                            fullUrl = baseUrl + '#/' + cleanPath;
                        }
                        
                        fullUrl = cleanUrl(fullUrl);
                    } else {
                        fullUrl = baseUrl + normalizedPath;
                    }
                }
                
                return fullUrl;
            }).join('\n');

            navigator.clipboard.writeText(allUrls).then(() => {
                const originalText = copyAllUrlsBtn.textContent;
                copyAllUrlsBtn.textContent = '✓ 已复制';
                setTimeout(() => {
                    copyAllUrlsBtn.textContent = originalText;
                }, 1500);
            }).catch(err => {
                console.error('复制失败:', err);
            });
        };
    }

    // 🆕 处理反调试脚本开关切换（支持全局模式）
    function handleScriptToggle(scriptId, isChecked, scriptItem) {
        if (typeof scriptId !== 'string' || !scriptId.trim()) {
            console.error('Invalid script ID in change event:', scriptId);
            return;
        }

        if (isChecked) {
            if (!enabledScripts.includes(scriptId)) {
                enabledScripts.push(scriptId);
                scriptItem.classList.add('active');
            }
        } else {
            enabledScripts = enabledScripts.filter(id => id !== scriptId);
            scriptItem.classList.remove('active');
        }

        updateStorage(enabledScripts);
    }

    // 🆕 处理Vue脚本开关切换（含父子逻辑，支持全局模式）
    function handleVueScriptToggle(script, isChecked) {
        // 如果是父脚本
        if (!script.parentScript) {
            if (isChecked) {
                // 开启父脚本：添加父脚本ID
                if (!enabledScripts.includes(script.id)) {
                    enabledScripts.push(script.id);
                }
            } else {
                // 关闭父脚本：同时移除父脚本和所有子脚本
                const childScripts = allScripts.filter(s => s.parentScript === script.id);
                enabledScripts = enabledScripts.filter(id => {
                    if (id === script.id) return false;
                    if (childScripts.some(child => child.id === id)) return false;
                    return true;
                });
            }
        }
        // 如果是子脚本
        else {
            if (isChecked) {
                // 开启子脚本：移除父脚本，只保留子脚本
                enabledScripts = enabledScripts.filter(id => id !== script.parentScript);
                if (!enabledScripts.includes(script.id)) {
                    enabledScripts.push(script.id);
                }
            } else {
                // 关闭子脚本：移除子脚本，恢复父脚本
                enabledScripts = enabledScripts.filter(id => id !== script.id);
                if (!enabledScripts.includes(script.parentScript)) {
                    enabledScripts.push(script.parentScript);
                }
            }
        }

        updateStorage(enabledScripts);
    }

    // 🆕 统一的存储更新函数（支持全局模式）
    function updateStorage(enabled) {
        if (isGlobalMode) {
            // 全局模式：更新全局脚本列表
            globalEnabledScripts = [...enabled];
            chrome.storage.local.set({
                [GLOBAL_SCRIPTS_KEY]: globalEnabledScripts
            }, () => {
                // 通知后台更新脚本注册（全局模式）
                chrome.runtime.sendMessage({
                    type: 'update_scripts_registration',
                    hostname: '*',
                    enabledScripts: enabled,
                    isGlobalMode: true
                });

                // 通知标签页更新状态
                tabsApi.sendMessage(currentTab_obj.id, {
                    type: 'scripts_updated',
                    hostname: hostname,
                    enabledScripts: enabled
                });

                // 更新本地状态并重新渲染
                enabledScripts = enabled;
                renderCurrentTab();
            });
        } else {
            // 标准模式：更新当前域名配置
            chrome.storage.local.set({
                [hostname]: enabled
            }, () => {
                // 通知后台更新脚本注册（标准模式）
                chrome.runtime.sendMessage({
                    type: 'update_scripts_registration',
                    hostname: hostname,
                    enabledScripts: enabled,
                    isGlobalMode: false
                });

                // 通知标签页更新状态
                tabsApi.sendMessage(currentTab_obj.id, {
                    type: 'scripts_updated',
                    hostname: hostname,
                    enabledScripts: enabled
                });

                // 更新本地状态并重新渲染
                enabledScripts = enabled;
                renderCurrentTab();
            });
        }
    }
    
    // ========== 全局请求头功能 ==========
    
    // 生成唯一ID
    function generateHeaderId() {
        return `hdr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }
    
    // 初始化Headers面板
    function initHeadersPanel() {
        loadHeadersData().then(() => {
            renderHeadersGroups();
            if (headersGroups.length > 0 && !currentHeadersGroupId) {
                currentHeadersGroupId = headersGroups[0].id;
            }
            renderHeadersItems();
            bindHeadersEvents();
        });
    }
    
    // 加载Headers数据
    function loadHeadersData() {
        return new Promise((resolve) => {
            chrome.storage.local.get([HEADERS_GROUPS_KEY, HEADERS_DATA_KEY, 'current_headers_group'], (result) => {
                headersGroups = result[HEADERS_GROUPS_KEY] || [];
                headersData = result[HEADERS_DATA_KEY] || {};
                // 恢复上次选中的组
                const savedGroupId = result['current_headers_group'];
                if (savedGroupId && headersGroups.find(g => g.id === savedGroupId)) {
                    currentHeadersGroupId = savedGroupId;
                } else if (headersGroups.length > 0) {
                    currentHeadersGroupId = headersGroups[0].id;
                }
                resolve();
            });
        });
    }
    
    // 保存Headers数据
    function saveHeadersData() {
        chrome.storage.local.set({
            [HEADERS_GROUPS_KEY]: headersGroups,
            [HEADERS_DATA_KEY]: headersData
        }, () => {
            // 通知background更新请求头注入
            notifyHeadersUpdate();
        });
    }
    
    // 通知background更新请求头（只使用当前选中组的请求头）
    function notifyHeadersUpdate() {
        // 只收集当前选中组的启用请求头
        const enabledHeaders = [];
        
        if (currentHeadersGroupId) {
            const items = headersData[currentHeadersGroupId] || [];
            console.log('[AntiDebug] 当前组数据:', JSON.stringify(items));
            
            items.forEach(item => {
                if (item.enabled && item.name && item.name.trim()) {
                    console.log('[AntiDebug] 添加请求头:', item.name, '=', item.value);
                    enabledHeaders.push({
                        name: item.name.trim(),
                        value: item.value || ''
                    });
                }
            });
        }
        
        console.log('[AntiDebug] 发送到 background 的请求头:', JSON.stringify(enabledHeaders));
        
        chrome.runtime.sendMessage({
            type: 'UPDATE_GLOBAL_HEADERS',
            headers: enabledHeaders,
            groupId: currentHeadersGroupId
        });
    }
    
    // 渲染标签组列表（标签式布局）
    function renderHeadersGroups() {
        const container = document.getElementById('headers-tabs-list');
        if (!container) return;
        
        container.innerHTML = '';
        
        if (headersGroups.length === 0) {
            // 没有标签组时不显示任何内容
            return;
        }
        
        headersGroups.forEach(group => {
            const items = headersData[group.id] || [];
            const enabledCount = items.filter(i => i.enabled).length;
            const totalCount = items.length;
            const isActive = currentHeadersGroupId === group.id;
            
            const tabEl = document.createElement('div');
            tabEl.className = `headers-tab-item ${isActive ? 'active' : 'inactive'}`;
            tabEl.dataset.groupId = group.id;
            
            // 显示名称和启用数量/总数量
            tabEl.innerHTML = `
                <span class="tab-name">${group.name}</span>
                <span class="tab-count ${enabledCount > 0 ? 'has-enabled' : ''}">${enabledCount}/${totalCount}</span>
                <button class="tab-delete" title="删除">×</button>
            `;
            
            // 点击选中标签组
            tabEl.addEventListener('click', (e) => {
                if (e.target.classList.contains('tab-delete')) return;
                if (e.target.classList.contains('tab-name-input')) return;
                currentHeadersGroupId = group.id;
                renderHeadersGroups();
                renderHeadersItems();
                // 保存当前选中的组
                chrome.storage.local.set({ 'current_headers_group': group.id });
            });
            
            // 双击编辑名称
            const nameEl = tabEl.querySelector('.tab-name');
            nameEl.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                startEditGroupName(group.id, tabEl, nameEl);
            });
            
            // 删除按钮
            const deleteBtn = tabEl.querySelector('.tab-delete');
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                deleteHeadersGroup(group.id);
            });
            
            container.appendChild(tabEl);
        });
    }
    
    // 开始编辑标签组名称
    function startEditGroupName(groupId, tabEl, nameEl) {
        const group = headersGroups.find(g => g.id === groupId);
        if (!group) return;
        
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'tab-name-input';
        input.value = group.name;
        
        nameEl.replaceWith(input);
        input.focus();
        input.select();
        
        const finishEdit = () => {
            const newName = input.value.trim() || '未命名';
            group.name = newName;
            saveHeadersData();
            renderHeadersGroups();
        };
        
        input.addEventListener('blur', finishEdit);
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                input.blur();
            }
        });
        input.addEventListener('click', (e) => {
            e.stopPropagation();
        });
    }
    
    // 添加标签组
    function addHeadersGroup() {
        // 使用更好的默认命名：配置A、配置B、配置C...
        const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        let nextIndex = 0;
        const usedNames = headersGroups.map(g => g.name);
        
        // 找到下一个可用的字母
        while (nextIndex < letters.length && usedNames.includes(`配置${letters[nextIndex]}`)) {
            nextIndex++;
        }
        
        const name = nextIndex < letters.length ? `配置${letters[nextIndex]}` : `配置${headersGroups.length + 1}`;
        
        const newGroup = {
            id: generateHeaderId(),
            name: name
        };
        headersGroups.push(newGroup);
        headersData[newGroup.id] = [];
        currentHeadersGroupId = newGroup.id;
        saveHeadersData();
        renderHeadersGroups();
        renderHeadersItems();
    }
    
    // 删除标签组
    function deleteHeadersGroup(groupId) {
        headersGroups = headersGroups.filter(g => g.id !== groupId);
        delete headersData[groupId];
        
        if (currentHeadersGroupId === groupId) {
            currentHeadersGroupId = headersGroups.length > 0 ? headersGroups[0].id : null;
        }
        
        saveHeadersData();
        renderHeadersGroups();
        renderHeadersItems();
    }
    
    // 渲染请求头列表
    function renderHeadersItems() {
        const container = document.getElementById('headers-items-list');
        const emptyHint = document.getElementById('headers-empty-hint');
        const titleEl = document.getElementById('current-group-name');
        const addBtn = document.getElementById('add-header-btn');
        
        if (!container) return;
        
        // 更新标题
        if (titleEl) {
            const group = headersGroups.find(g => g.id === currentHeadersGroupId);
            titleEl.textContent = group ? group.name : '请求头';
        }
        
        // 如果没有标签组
        if (headersGroups.length === 0) {
            container.style.display = 'none';
            if (addBtn) addBtn.style.display = 'none';
            if (emptyHint) {
                emptyHint.style.display = 'flex';
                emptyHint.querySelector('p').textContent = '点击上方 + 添加标签组';
            }
            return;
        }
        
        // 如果没有选中的标签组
        if (!currentHeadersGroupId) {
            container.style.display = 'none';
            if (addBtn) addBtn.style.display = 'none';
            if (emptyHint) {
                emptyHint.style.display = 'flex';
                emptyHint.querySelector('p').textContent = '选择一个标签组';
            }
            return;
        }
        
        if (addBtn) addBtn.style.display = 'flex';
        
        const items = headersData[currentHeadersGroupId] || [];
        
        if (items.length === 0) {
            container.style.display = 'none';
            if (emptyHint) {
                emptyHint.style.display = 'flex';
                emptyHint.querySelector('p').textContent = '点击「添加请求头」按钮添加';
            }
            return;
        }
        
        container.style.display = 'flex';
        if (emptyHint) emptyHint.style.display = 'none';
        
        container.innerHTML = '';
        
        items.forEach((item, index) => {
            const itemEl = document.createElement('div');
            itemEl.className = `header-item ${item.enabled ? 'enabled' : ''}`;
            itemEl.dataset.itemId = item.id;
            
            itemEl.innerHTML = `
                <input type="checkbox" class="header-checkbox" ${item.enabled ? 'checked' : ''}>
                <div class="header-inputs">
                    <input type="text" class="header-name-input" placeholder="Name" value="${escapeAnalysisText(item.name || '')}" list="header-suggestions-${item.id}" autocomplete="off">
                    <datalist id="header-suggestions-${item.id}"></datalist>
                    <input type="text" class="header-value-input" placeholder="Value" value="${escapeAnalysisText(item.value || '')}">
                </div>
                <button class="header-save-btn" title="保存这一行">✓</button>
                <button class="header-delete-btn">×</button>
            `;
            
            // 绑定事件
            const checkbox = itemEl.querySelector('.header-checkbox');
            const nameInput = itemEl.querySelector('.header-name-input');
            const valueInput = itemEl.querySelector('.header-value-input');
            const saveBtn = itemEl.querySelector('.header-save-btn');
            const deleteBtn = itemEl.querySelector('.header-delete-btn');
            
            checkbox.addEventListener('change', (e) => {
                item.enabled = e.target.checked;
                itemEl.classList.toggle('enabled', item.enabled);
                saveHeadersData();
                renderHeadersGroups(); // 更新指示灯
            });
            
            // 自动补全逻辑
            const datalist = itemEl.querySelector(`#header-suggestions-${item.id}`);
            
            function updateSuggestions(inputValue) {
                if (!datalist) return;
                datalist.innerHTML = '';
                
                if (!inputValue || inputValue.length === 0) return;
                
                const lowerInput = inputValue.toLowerCase();
                const matches = COMMON_HEADERS.filter(h => 
                    h.toLowerCase().includes(lowerInput)
                );
                
                matches.forEach(match => {
                    const option = document.createElement('option');
                    option.value = match;
                    datalist.appendChild(option);
                });
            }
            
            nameInput.addEventListener('input', (e) => {
                item.name = e.target.value;
                itemEl.classList.add('dirty');
                updateSuggestions(e.target.value);
            });
            
            nameInput.addEventListener('focus', (e) => {
                updateSuggestions(e.target.value);
            });
            
            valueInput.addEventListener('input', (e) => {
                item.value = e.target.value;
                itemEl.classList.add('dirty');
            });

            saveBtn.addEventListener('click', () => {
                saveHeadersData();
                itemEl.classList.remove('dirty');
                showToast('该请求头已保存');
            });
            
            deleteBtn.addEventListener('click', () => {
                deleteHeaderItem(item.id);
            });
            
            container.appendChild(itemEl);
        });
    }
    
    // 添加请求头
    function addHeaderItem() {
        if (!currentHeadersGroupId) {
            showToast('请先选择或创建标签组');
            return;
        }
        
        if (!headersData[currentHeadersGroupId]) {
            headersData[currentHeadersGroupId] = [];
        }
        
        const newItem = {
            id: generateHeaderId(),
            name: '',
            value: '',
            enabled: true
        };
        
        headersData[currentHeadersGroupId].push(newItem);
        saveHeadersData();
        renderHeadersItems();
        renderHeadersGroups();
        
        // 自动聚焦到新添加的输入框
        setTimeout(() => {
            const container = document.getElementById('headers-items-list');
            const lastItem = container.lastElementChild;
            if (lastItem) {
                const nameInput = lastItem.querySelector('.header-name-input');
                if (nameInput) nameInput.focus();
            }
        }, 50);
    }
    
    // 删除请求头
    function deleteHeaderItem(itemId) {
        if (!currentHeadersGroupId) return;
        
        headersData[currentHeadersGroupId] = (headersData[currentHeadersGroupId] || []).filter(i => i.id !== itemId);
        saveHeadersData();
        renderHeadersItems();
        renderHeadersGroups();
    }
    
    // 绑定Headers按钮事件
    function bindHeadersEvents() {
        const addGroupBtn = document.getElementById('add-group-btn');
        const addHeaderBtn = document.getElementById('add-header-btn');
        
        if (addGroupBtn) {
            addGroupBtn.onclick = addHeadersGroup;
        }
        
        if (addHeaderBtn) {
            addHeaderBtn.onclick = addHeaderItem;
        }
    }
    
    // ========== 全局请求头功能结束 ==========
});
