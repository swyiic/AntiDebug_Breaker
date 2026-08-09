#!/usr/bin/env node
/**
 * AntiDebug Breaker MCP Server
 * 
 * 这个MCP服务器允许Cursor通过Chrome扩展来分析和控制浏览器页面
 * 
 * 功能：
 * - 获取当前页面信息（URL、标题、DOM结构等）
 * - 获取网络请求/API调用记录
 * - 获取Vue Router路由信息
 * - 注入和管理Hook脚本
 * - 获取Hook捕获的数据
 * - 控制页面导航
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { WebSocketServer, WebSocket } from "ws";
import { analyzeJavaScriptEndpoints } from "./js-endpoint-analyzer.js";

// ============== 类型定义 ==============
interface PageInfo {
  url: string;
  title: string;
  hostname: string;
  protocol: string;
  pathname: string;
}

interface NetworkRequest {
  id: string;
  method: string;
  url: string;
  timestamp: number;
  headers?: Record<string, string>;
  body?: string;
  response?: {
    status: number;
    headers?: Record<string, string>;
    body?: string;
  };
}

interface VueRouterData {
  vueVersion: string;
  routerMode: string;
  routes: Array<{
    path: string;
    name?: string;
    meta?: Record<string, any>;
  }>;
  currentRoute?: {
    path: string;
    name?: string;
    params?: Record<string, any>;
    query?: Record<string, any>;
  };
}

interface HookData {
  scriptId: string;
  timestamp: number;
  type: string;
  data: any;
  stack?: string;
}

interface BrowserState {
  connected: boolean;
  pageInfo?: PageInfo;
  networkRequests: NetworkRequest[];
  vueRouterData?: VueRouterData;
  hookData: HookData[];
  enabledScripts: string[];
  cookies: Record<string, string>;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
}

// ============== 全局状态 ==============
let browserState: BrowserState = {
  connected: false,
  networkRequests: [],
  hookData: [],
  enabledScripts: [],
  cookies: {},
  localStorage: {},
  sessionStorage: {}
};

let browserClient: WebSocket | null = null;
let pendingRequests = new Map<string, {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timeout: NodeJS.Timeout;
}>();

// ============== WebSocket 服务器 ==============
// MCP 走 stdio，不需要网络端口；浏览器扩展通过单独的安全 WebSocket 端口连接。
// Chromium 会以 ERR_UNSAFE_PORT 阻止 1719，因此兼容旧 MCP_PORT=1719 配置时自动桥接到 9527。
const REQUESTED_WS_PORT = process.env.BROWSER_WS_PORT
  ? parseInt(process.env.BROWSER_WS_PORT, 10)
  : process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : 9527;
const CHROMIUM_BLOCKED_PORTS = new Set([1719]);
const WS_PORT = CHROMIUM_BLOCKED_PORTS.has(REQUESTED_WS_PORT) ? 9527 : REQUESTED_WS_PORT;
let wss: WebSocketServer | null = null;
let currentPort = WS_PORT;

// 输出端口配置信息
console.error(`[MCP] 浏览器桥接端口: ${WS_PORT}${WS_PORT !== REQUESTED_WS_PORT ? ` (已将 Chromium 禁止的 ${REQUESTED_WS_PORT} 自动映射到安全端口)` : ''}`);

// 初始化WebSocket服务器
async function initWebSocketServer() {
  try {
    wss = new WebSocketServer({ port: WS_PORT });
    currentPort = WS_PORT;
    
    console.error(`[MCP] WebSocket服务器启动在端口 ${WS_PORT}`);
    
    wss.on("connection", (ws) => {
      console.error("[MCP] 浏览器扩展已连接");
      browserClient = ws;
      browserState.connected = true;
      ws.send(JSON.stringify({ type: 'SERVER_CAPABILITIES', data: ['localAstAnalysis', 'networkBridgeV2'] }));

      ws.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString());
          
          // 处理心跳消息
          if (message.type === 'PING') {
            ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
            return;
          }
          
          handleBrowserMessage(message);
        } catch (e) {
          console.error("[MCP] 解析消息失败:", e);
        }
      });

      ws.on("close", () => {
        console.error("[MCP] 浏览器扩展断开连接");
        browserClient = null;
        browserState.connected = false;
      });

      ws.on("error", (error) => {
        console.error("[MCP] WebSocket错误:", error);
        browserClient = null;
        browserState.connected = false;
      });
    });
    
    wss.on("error", (error: any) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`[MCP] ❌ 端口 ${currentPort} 被占用`);
      } else {
        console.error("[MCP] WebSocket服务器错误:", error);
      }
    });
    
  } catch (error: any) {
    console.error(`[MCP] ❌ WebSocket服务器启动失败: ${error.message}`);
    console.error("[MCP] MCP服务器将继续运行，但无法与浏览器扩展通信");
  }
}

// 处理来自浏览器的消息
function handleBrowserMessage(message: any) {
  const { type, requestId, data, error } = message;

  // 处理请求响应
  if (requestId && pendingRequests.has(requestId)) {
    const pending = pendingRequests.get(requestId)!;
    clearTimeout(pending.timeout);
    pendingRequests.delete(requestId);
    
    if (error) {
      pending.reject(new Error(error));
    } else {
      pending.resolve(data);
    }
    return;
  }

  // 处理推送消息
  switch (type) {
    case "LOCAL_AST_ANALYSIS_REQUEST":
      try {
        const endpoints = analyzeJavaScriptEndpoints(data?.scripts || [], data?.pageUrl || '');
        browserClient?.send(JSON.stringify({
          type: 'LOCAL_AST_ANALYSIS_RESULT',
          requestId,
          data: { endpoints, engine: 'babel-ast', analyzedAt: Date.now() }
        }));
      } catch (analysisError: any) {
        browserClient?.send(JSON.stringify({ type: 'LOCAL_AST_ANALYSIS_RESULT', requestId, error: analysisError.message }));
      }
      break;
    case "PAGE_INFO":
      browserState.pageInfo = data;
      break;

    case "NETWORK_REQUEST":
      browserState.networkRequests.push(data);
      // 保留最近1000条请求
      if (browserState.networkRequests.length > 1000) {
        browserState.networkRequests = browserState.networkRequests.slice(-1000);
      }
      break;

    case "VUE_ROUTER_DATA":
      browserState.vueRouterData = data;
      break;

    case "HOOK_DATA":
      browserState.hookData.push(data);
      // 保留最近500条Hook数据
      if (browserState.hookData.length > 500) {
        browserState.hookData = browserState.hookData.slice(-500);
      }
      break;

    case "SCRIPTS_UPDATED":
      browserState.enabledScripts = data.enabledScripts || [];
      break;

    case "STORAGE_DATA":
      if (data.cookies) browserState.cookies = data.cookies;
      if (data.localStorage) browserState.localStorage = data.localStorage;
      if (data.sessionStorage) browserState.sessionStorage = data.sessionStorage;
      break;

    default:
      console.error("[MCP] 未知消息类型:", type);
  }
}

// 发送请求到浏览器并等待响应
function sendToBrowser(type: string, data?: any, timeout = 10000): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!browserClient || browserClient.readyState !== WebSocket.OPEN) {
      reject(new Error("浏览器扩展未连接。请确保Chrome扩展已加载并打开了目标页面。"));
      return;
    }

    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    
    const timeoutHandle = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`请求超时: ${type}`));
    }, timeout);

    pendingRequests.set(requestId, { resolve, reject, timeout: timeoutHandle });

    browserClient.send(JSON.stringify({
      type,
      requestId,
      data
    }));
  });
}

// ============== MCP 服务器 ==============
const server = new McpServer({
  name: "antidebug-breaker-mcp",
  version: "1.0.0"
});

// ============== 工具定义 ==============

// 1. 获取连接状态
server.tool(
  "get_connection_status",
  "获取浏览器扩展的连接状态",
  {},
  async () => {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          connected: browserState.connected,
          wsPort: currentPort,
          message: browserState.connected 
            ? "浏览器扩展已连接，可以开始使用其他工具"
            : `浏览器扩展未连接。请确保：\n1. Chrome扩展已加载\n2. 已在扩展设置中启用MCP连接（端口: ${currentPort}）\n3. 已打开目标网页`
        }, null, 2)
      }]
    };
  }
);

// 2. 获取当前页面信息
server.tool(
  "get_page_info",
  "获取当前浏览器页面的基本信息（URL、标题、域名等）",
  {},
  async () => {
    try {
      const pageInfo = await sendToBrowser("GET_PAGE_INFO");
      return {
        content: [{
          type: "text",
          text: JSON.stringify(pageInfo, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取页面信息失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 3. 获取网络请求列表
server.tool(
  "get_network_requests",
  "获取页面的网络请求/API调用记录",
  {
    limit: z.number().optional().describe("返回的最大请求数量，默认50"),
    filter: z.string().optional().describe("URL过滤关键词"),
    method: z.string().optional().describe("HTTP方法过滤（GET, POST等）")
  },
  async ({ limit = 50, filter, method }) => {
    try {
      const requests = await sendToBrowser("GET_NETWORK_REQUESTS", { limit, filter, method });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(requests, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取网络请求失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 4. 获取Vue Router信息
server.tool(
  "get_vue_routes",
  "获取页面的Vue Router路由信息（需要先启用获取路由脚本）",
  {},
  async () => {
    try {
      const vueData = await sendToBrowser("GET_VUE_ROUTER_DATA");
      return {
        content: [{
          type: "text",
          text: JSON.stringify(vueData, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取Vue路由失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 5. 获取Hook捕获的数据
server.tool(
  "get_hook_data",
  "获取Hook脚本捕获的数据（cookie、localStorage、XHR等）",
  {
    scriptId: z.string().optional().describe("筛选特定Hook脚本的数据"),
    limit: z.number().optional().describe("返回的最大数据条数，默认50"),
    clear: z.boolean().optional().describe("获取后是否清空数据")
  },
  async ({ scriptId, limit = 50, clear = false }) => {
    try {
      const hookData = await sendToBrowser("GET_HOOK_DATA", { scriptId, limit, clear });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(hookData, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取Hook数据失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 6. 获取已启用的脚本列表
server.tool(
  "get_enabled_scripts",
  "获取当前页面已启用的脚本列表",
  {},
  async () => {
    try {
      const scripts = await sendToBrowser("GET_ENABLED_SCRIPTS");
      return {
        content: [{
          type: "text",
          text: JSON.stringify(scripts, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取脚本列表失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 7. 启用/禁用脚本
server.tool(
  "toggle_script",
  "启用或禁用指定的脚本",
  {
    scriptId: z.string().describe("脚本ID，如 'hook_xhr_open', 'Get_Vue_0' 等"),
    enabled: z.boolean().describe("是否启用")
  },
  async ({ scriptId, enabled }) => {
    try {
      const result = await sendToBrowser("TOGGLE_SCRIPT", { scriptId, enabled });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            scriptId,
            enabled,
            message: `脚本 ${scriptId} 已${enabled ? "启用" : "禁用"}，刷新页面后生效`
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `切换脚本失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 8. 导航到指定URL
server.tool(
  "navigate_to",
  "导航到指定的URL或Vue路由",
  {
    url: z.string().describe("目标URL或路由路径")
  },
  async ({ url }) => {
    try {
      const result = await sendToBrowser("NAVIGATE_TO", { url });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            url,
            message: `已导航到: ${url}`
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `导航失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 9. 获取Cookie
server.tool(
  "get_cookies",
  "获取当前页面的Cookie",
  {
    name: z.string().optional().describe("Cookie名称过滤")
  },
  async ({ name }) => {
    try {
      const cookies = await sendToBrowser("GET_COOKIES", { name });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(cookies, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取Cookie失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 10. 获取LocalStorage
server.tool(
  "get_local_storage",
  "获取当前页面的LocalStorage数据",
  {
    key: z.string().optional().describe("键名过滤")
  },
  async ({ key }) => {
    try {
      const storage = await sendToBrowser("GET_LOCAL_STORAGE", { key });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(storage, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取LocalStorage失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 11. 获取SessionStorage
server.tool(
  "get_session_storage",
  "获取当前页面的SessionStorage数据",
  {
    key: z.string().optional().describe("键名过滤")
  },
  async ({ key }) => {
    try {
      const storage = await sendToBrowser("GET_SESSION_STORAGE", { key });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(storage, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取SessionStorage失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 12. 执行JavaScript代码
server.tool(
  "execute_script",
  "在页面上下文中执行JavaScript代码",
  {
    code: z.string().describe("要执行的JavaScript代码"),
    world: z.enum(["MAIN", "ISOLATED"]).optional().describe("执行环境：MAIN(页面主世界)或ISOLATED(隔离环境)")
  },
  async ({ code, world = "MAIN" }) => {
    try {
      const result = await sendToBrowser("EXECUTE_SCRIPT", { code, world });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            result
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `执行脚本失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 13. 获取DOM元素信息
server.tool(
  "get_dom_info",
  "获取页面DOM结构信息",
  {
    selector: z.string().optional().describe("CSS选择器，不填则获取body"),
    depth: z.number().optional().describe("遍历深度，默认3")
  },
  async ({ selector = "body", depth = 3 }) => {
    try {
      const domInfo = await sendToBrowser("GET_DOM_INFO", { selector, depth });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(domInfo, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取DOM信息失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 14. 配置Hook脚本参数
server.tool(
  "configure_hook",
  "配置Hook脚本的参数（如关键字过滤、debugger开关等）",
  {
    scriptId: z.string().describe("脚本ID"),
    config: z.object({
      keywords: z.array(z.string()).optional().describe("关键字过滤列表"),
      enableDebugger: z.boolean().optional().describe("是否启用debugger断点"),
      enableStack: z.boolean().optional().describe("是否打印调用堆栈"),
      fixedValue: z.string().optional().describe("固定返回值（用于Math.random等）")
    }).describe("配置选项")
  },
  async ({ scriptId, config }) => {
    try {
      const result = await sendToBrowser("CONFIGURE_HOOK", { scriptId, config });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            scriptId,
            config,
            message: "Hook配置已更新"
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `配置Hook失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 15. 获取可用脚本列表
server.tool(
  "list_available_scripts",
  "获取所有可用的脚本列表及其描述",
  {
    category: z.enum(["antidebug", "hook", "vue", "all"]).optional().describe("脚本分类")
  },
  async ({ category = "all" }) => {
    try {
      const scripts = await sendToBrowser("LIST_AVAILABLE_SCRIPTS", { category });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(scripts, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取脚本列表失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 16. 刷新页面
server.tool(
  "refresh_page",
  "刷新当前页面",
  {
    hardRefresh: z.boolean().optional().describe("是否强制刷新（清除缓存）")
  },
  async ({ hardRefresh = false }) => {
    try {
      await sendToBrowser("REFRESH_PAGE", { hardRefresh });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: hardRefresh ? "页面已强制刷新" : "页面已刷新"
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `刷新页面失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// ============== 新增：浏览器控制功能 ==============

// 17. 截图
server.tool(
  "take_screenshot",
  "截取当前页面的屏幕截图",
  {
    fullPage: z.boolean().optional().describe("是否截取整个页面"),
    selector: z.string().optional().describe("要截取的元素选择器")
  },
  async ({ fullPage = false, selector }) => {
    try {
      const result = await sendToBrowser("TAKE_SCREENSHOT", { fullPage, selector });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: "截图成功",
            dataUrl: result.dataUrl?.substring(0, 100) + "...[截断]",
            format: result.format
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `截图失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 18. 点击元素
server.tool(
  "click_element",
  "点击页面上的元素",
  {
    selector: z.string().optional().describe("CSS选择器"),
    x: z.number().optional().describe("X坐标"),
    y: z.number().optional().describe("Y坐标"),
    dblClick: z.boolean().optional().describe("是否双击")
  },
  async ({ selector, x, y, dblClick = false }) => {
    try {
      const result = await sendToBrowser("CLICK_ELEMENT", { selector, x, y, dblClick });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `点击失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 19. 填充输入框
server.tool(
  "fill_input",
  "在输入框中填充文本",
  {
    selector: z.string().describe("输入框的CSS选择器"),
    value: z.string().describe("要填充的值"),
    clear: z.boolean().optional().describe("是否先清空（默认true）")
  },
  async ({ selector, value, clear = true }) => {
    try {
      const result = await sendToBrowser("FILL_INPUT", { selector, value, clear });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `填充失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 20. 按键
server.tool(
  "press_key",
  "模拟按键操作",
  {
    key: z.string().describe("按键（如 Enter, Tab, Escape, ArrowDown 等）"),
    modifiers: z.array(z.enum(["Control", "Ctrl", "Shift", "Alt", "Meta", "Command"])).optional().describe("修饰键")
  },
  async ({ key, modifiers = [] }) => {
    try {
      const result = await sendToBrowser("PRESS_KEY", { key, modifiers });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `按键失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 21. 获取控制台消息
server.tool(
  "get_console_messages",
  "获取浏览器控制台消息",
  {
    limit: z.number().optional().describe("返回的最大消息数量"),
    types: z.array(z.enum(["log", "warn", "error", "info", "debug"])).optional().describe("消息类型过滤")
  },
  async ({ limit = 50, types = [] }) => {
    try {
      const messages = await sendToBrowser("GET_CONSOLE_MESSAGES", { limit, types });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(messages, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取控制台消息失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 22. 滚动页面
server.tool(
  "scroll_page",
  "滚动页面到指定位置或元素",
  {
    x: z.number().optional().describe("水平滚动位置"),
    y: z.number().optional().describe("垂直滚动位置"),
    selector: z.string().optional().describe("滚动到指定元素"),
    behavior: z.enum(["smooth", "instant", "auto"]).optional().describe("滚动行为")
  },
  async ({ x = 0, y = 0, selector, behavior = "smooth" }) => {
    try {
      const result = await sendToBrowser("SCROLL_PAGE", { x, y, selector, behavior });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `滚动失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 23. 等待选择器
server.tool(
  "wait_for_selector",
  "等待页面上出现指定元素",
  {
    selector: z.string().describe("CSS选择器"),
    timeout: z.number().optional().describe("超时时间（毫秒），默认5000"),
    visible: z.boolean().optional().describe("是否要求元素可见")
  },
  async ({ selector, timeout = 5000, visible = true }) => {
    try {
      const result = await sendToBrowser("WAIT_FOR_SELECTOR", { selector, timeout, visible });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `等待失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 24. 获取元素信息
server.tool(
  "get_element_info",
  "获取页面元素的详细信息",
  {
    selector: z.string().describe("CSS选择器")
  },
  async ({ selector }) => {
    try {
      const info = await sendToBrowser("GET_ELEMENT_INFO", { selector });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(info, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取元素信息失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 25. 准备路由访问（自动启用必要脚本）
server.tool(
  "prepare_route_access",
  "准备访问Vue路由（自动启用清除路由守卫和清除跳转脚本）",
  {},
  async () => {
    try {
      const result = await sendToBrowser("PREPARE_ROUTE_ACCESS", {});
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `准备失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 26. 扫描路由收集API
server.tool(
  "scan_route_for_api",
  "访问指定路由并收集该路由触发的API请求",
  {
    route: z.string().describe("要访问的路由路径"),
    waitTime: z.number().optional().describe("等待API请求的时间（毫秒），默认3000")
  },
  async ({ route, waitTime = 3000 }) => {
    try {
      const result = await sendToBrowser("SCAN_ROUTE_FOR_API", { route, waitTime }, waitTime + 5000);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `扫描路由失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 27. 批量扫描路由收集API
server.tool(
  "batch_scan_routes",
  "批量访问多个路由并收集所有API请求",
  {
    routes: z.array(z.string()).describe("要访问的路由路径列表"),
    waitTime: z.number().optional().describe("每个路由等待API请求的时间（毫秒），默认2000")
  },
  async ({ routes, waitTime = 2000 }) => {
    try {
      const allApis: any[] = [];
      const results: any[] = [];
      
      for (const route of routes) {
        try {
          const result = await sendToBrowser("SCAN_ROUTE_FOR_API", { route, waitTime }, waitTime + 5000);
          results.push(result);
          if (result.apiRequests) {
            allApis.push(...result.apiRequests.map((api: any) => ({
              ...api,
              route
            })));
          }
        } catch (e: any) {
          results.push({ route, error: e.message });
        }
      }
      
      // 去重
      const uniqueApis = allApis.filter((api, index, self) =>
        index === self.findIndex(a => a.url === api.url && a.method === api.method)
      );
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            totalRoutes: routes.length,
            totalApis: uniqueApis.length,
            apis: uniqueApis,
            routeResults: results
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `批量扫描失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// ============== 加密分析功能 ==============

// 28. 启用加密 Hook 脚本
server.tool(
  "enable_encryption_hooks",
  "启用 RSA 和 CryptoJS 加密 Hook 脚本，用于捕获加密数据",
  {},
  async () => {
    try {
      const result = await sendToBrowser("ENABLE_ENCRYPTION_HOOKS", {});
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `启用加密Hook失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 29. 分析页面加密
server.tool(
  "analyze_page_encryption",
  "分析当前页面使用的加密库和密钥",
  {},
  async () => {
    try {
      const result = await sendToBrowser("ANALYZE_PAGE_ENCRYPTION", {});
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `分析加密失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 30. 自动登录并捕获加密数据
server.tool(
  "auto_login_and_capture",
  "自动填写登录表单并捕获加密数据（密码加密前后的值）",
  {
    username: z.string().describe("用户名"),
    password: z.string().describe("密码"),
    usernameSelector: z.string().optional().describe("用户名输入框选择器"),
    passwordSelector: z.string().optional().describe("密码输入框选择器"),
    submitSelector: z.string().optional().describe("登录按钮选择器"),
    waitTime: z.number().optional().describe("等待时间(毫秒)")
  },
  async ({ username, password, usernameSelector, passwordSelector, submitSelector, waitTime = 3000 }) => {
    try {
      const result = await sendToBrowser("AUTO_LOGIN_AND_CAPTURE", {
        username, password, usernameSelector, passwordSelector, submitSelector, waitTime
      }, waitTime + 5000);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `自动登录失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 31. 获取捕获的加密数据
server.tool(
  "get_captured_encryption",
  "获取 Hook 脚本捕获的加密数据（公钥、明文、密文等）",
  {},
  async () => {
    try {
      const result = await sendToBrowser("GET_CAPTURED_ENCRYPTION", {});
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `获取加密数据失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 32. RSA 解密
server.tool(
  "decrypt_rsa",
  "使用私钥解密 RSA 加密的数据",
  {
    encryptedData: z.string().describe("Base64编码的加密数据"),
    privateKey: z.string().describe("RSA私钥")
  },
  async ({ encryptedData, privateKey }) => {
    try {
      const result = await sendToBrowser("DECRYPT_RSA", { encryptedData, privateKey });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `RSA解密失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 33. 从JS文件提取密钥
server.tool(
  "extract_keys_from_js",
  "从指定的JS文件中提取RSA公钥、私钥等加密信息",
  {
    jsUrl: z.string().describe("JS文件的URL")
  },
  async ({ jsUrl }) => {
    try {
      const result = await sendToBrowser("EXTRACT_KEYS_FROM_JS", { jsUrl }, 15000);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `提取密钥失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 34. 一键分析登录加密（综合功能）
server.tool(
  "analyze_login_encryption",
  "一键分析登录页面的密码加密方式：启用Hook -> 自动登录 -> 捕获加密数据 -> 提取密钥 -> 尝试解密",
  {
    username: z.string().describe("测试用户名"),
    password: z.string().describe("测试密码")
  },
  async ({ username, password }) => {
    try {
      const results: any = { steps: [] };
      
      // 步骤1: 启用加密Hook
      results.steps.push({ step: 1, action: "启用加密Hook" });
      await sendToBrowser("ENABLE_ENCRYPTION_HOOKS", {});
      
      // 步骤2: 刷新页面
      results.steps.push({ step: 2, action: "刷新页面" });
      await sendToBrowser("REFRESH_PAGE", { hardRefresh: true });
      await new Promise(r => setTimeout(r, 2000));
      
      // 步骤3: 注入加密捕获器
      results.steps.push({ step: 3, action: "注入加密捕获器" });
      await sendToBrowser("INJECT_ENCRYPTION_CAPTURE", {});
      
      // 步骤4: 分析页面加密
      results.steps.push({ step: 4, action: "分析页面加密库" });
      results.pageAnalysis = await sendToBrowser("ANALYZE_PAGE_ENCRYPTION", {});
      
      // 步骤5: 自动登录
      results.steps.push({ step: 5, action: "自动登录并捕获" });
      results.loginResult = await sendToBrowser("AUTO_LOGIN_AND_CAPTURE", {
        username, password, waitTime: 3000
      }, 10000);
      
      // 步骤6: 获取捕获的加密数据
      results.steps.push({ step: 6, action: "获取加密数据" });
      results.encryptionData = await sendToBrowser("GET_CAPTURED_ENCRYPTION", {});
      
      // 分析结果
      results.summary = {
        encryptionMethod: results.pageAnalysis?.detectedEncryption || "未知",
        hasPublicKey: !!results.pageAnalysis?.keys?.publicKey,
        hasPrivateKey: !!results.pageAnalysis?.keys?.privateKey,
        capturedDataCount: results.encryptionData?.length || 0
      };
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(results, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `分析失败: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// ============== 智能化功能：反调试 ==============

// 35. 检测反调试机制
server.tool(
  "detect_anti_debug",
  "检测页面中的反调试机制（debugger语句、控制台检测、窗口大小检测等）",
  {},
  async () => {
    try {
      const result = await sendToBrowser("DETECT_ANTI_DEBUG", {});
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `检测失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 36. 自动绕过反调试
server.tool(
  "auto_bypass_anti_debug",
  "检测并自动启用相应的反调试绕过脚本",
  {},
  async () => {
    try {
      const result = await sendToBrowser("AUTO_BYPASS_ANTI_DEBUG", {});
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `绕过失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// ============== 智能化功能：API分析 ==============

// 37. 分析API签名
server.tool(
  "analyze_api_signature",
  "分析最近的API请求，提取签名参数、加密参数等特征",
  {},
  async () => {
    try {
      const result = await sendToBrowser("ANALYZE_API_SIGNATURE", {});
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `分析失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// ============== 智能化功能：框架数据提取 ==============

// 38. 提取Vue数据
server.tool(
  "extract_vue_data",
  "提取页面Vue组件的data、computed、methods等数据",
  {
    selector: z.string().optional().describe("目标元素选择器，默认为#app")
  },
  async ({ selector }) => {
    try {
      const result = await sendToBrowser("EXTRACT_VUE_DATA", { selector });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `提取失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 39. 提取React数据
server.tool(
  "extract_react_data",
  "提取页面React组件的props、state等数据",
  {
    selector: z.string().optional().describe("目标元素选择器，默认为#root")
  },
  async ({ selector }) => {
    try {
      const result = await sendToBrowser("EXTRACT_REACT_DATA", { selector });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `提取失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// ============== 智能化功能：认证分析 ==============

// 40. 分析认证机制
server.tool(
  "analyze_authentication",
  "分析页面的认证机制（Cookie、localStorage中的token、JWT解析等）",
  {},
  async () => {
    try {
      const result = await sendToBrowser("ANALYZE_AUTHENTICATION", {});
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `分析失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// ============== 智能化功能：表单自动化 ==============

// 41. 获取页面表单
server.tool(
  "get_page_forms",
  "获取页面所有表单信息（输入框、按钮、选择器等）",
  {},
  async () => {
    try {
      const result = await sendToBrowser("GET_PAGE_FORMS", {});
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `获取失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 42. 自动填充表单
server.tool(
  "auto_fill_form",
  "自动填充指定表单的输入框",
  {
    formIndex: z.number().optional().describe("表单索引，默认0"),
    values: z.record(z.string()).describe("要填充的值，格式: {选择器: 值}")
  },
  async ({ formIndex = 0, values }) => {
    try {
      const result = await sendToBrowser("AUTO_FILL_FORM", { formIndex, values });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `填充失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// ============== 智能化功能：WebSocket监控 ==============

// 43. 注入WebSocket监控
server.tool(
  "inject_ws_monitor",
  "注入WebSocket监控，捕获所有WebSocket通信",
  {},
  async () => {
    try {
      const result = await sendToBrowser("INJECT_WS_MONITOR", {});
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `注入失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 44. 获取WebSocket消息
server.tool(
  "get_ws_messages",
  "获取捕获的WebSocket消息",
  {
    limit: z.number().optional().describe("返回的最大消息数，默认50")
  },
  async ({ limit = 50 }) => {
    try {
      const result = await sendToBrowser("GET_WS_MESSAGES", { limit });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `获取失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// ============== 智能化功能：数据爬取 ==============

// 45. 提取页面数据
server.tool(
  "extract_page_data",
  "根据选择器提取页面结构化数据",
  {
    selectors: z.record(z.string()).describe("选择器映射，格式: {名称: CSS选择器}")
  },
  async ({ selectors }) => {
    try {
      const result = await sendToBrowser("EXTRACT_PAGE_DATA", { selectors });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `提取失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 46. 提取表格数据
server.tool(
  "extract_table_data",
  "提取页面表格数据为结构化格式",
  {
    selector: z.string().optional().describe("表格选择器，默认为第一个table")
  },
  async ({ selector }) => {
    try {
      const result = await sendToBrowser("EXTRACT_TABLE_DATA", { selector });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `提取失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// ============== 综合功能：一键分析页面 ==============

// 47. 一键分析页面
server.tool(
  "full_page_analysis",
  "一键全面分析页面：反调试检测、框架识别、加密分析、认证分析、表单识别",
  {},
  async () => {
    try {
      const results: any = { timestamp: Date.now() };
      
      // 1. 基本信息
      results.pageInfo = await sendToBrowser("GET_PAGE_INFO", {});
      
      // 2. 反调试检测
      try {
        results.antiDebug = await sendToBrowser("DETECT_ANTI_DEBUG", {});
      } catch (e) { results.antiDebug = { error: 'failed' }; }
      
      // 3. 加密分析
      try {
        results.encryption = await sendToBrowser("ANALYZE_PAGE_ENCRYPTION", {});
      } catch (e) { results.encryption = { error: 'failed' }; }
      
      // 4. 认证分析
      try {
        results.authentication = await sendToBrowser("ANALYZE_AUTHENTICATION", {});
      } catch (e) { results.authentication = { error: 'failed' }; }
      
      // 5. 表单分析
      try {
        results.forms = await sendToBrowser("GET_PAGE_FORMS", {});
      } catch (e) { results.forms = { error: 'failed' }; }
      
      // 6. Vue/React 检测
      try {
        results.vue = await sendToBrowser("EXTRACT_VUE_DATA", {});
      } catch (e) {}
      try {
        results.react = await sendToBrowser("EXTRACT_REACT_DATA", {});
      } catch (e) {}
      
      // 生成摘要
      results.summary = {
        url: results.pageInfo?.url,
        title: results.pageInfo?.title,
        hasAntiDebug: results.antiDebug?.hasDebugger || results.antiDebug?.hasDevtoolsCheck,
        framework: results.vue?.version || results.react?.version || 'Unknown',
        encryptionMethod: results.encryption?.detectedEncryption || 'Unknown',
        hasAuthTokens: (results.authentication?.cookies?.authRelated?.length || 0) + 
                       (results.authentication?.localStorage?.authRelated?.length || 0) > 0,
        formCount: Array.isArray(results.forms) ? results.forms.length : 0
      };
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(results, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `分析失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// ============== Burp Suite 格式网络请求 ==============

// 48. 点击元素并捕获请求
server.tool(
  "click_and_capture",
  "点击指定元素并捕获产生的所有网络请求（包含请求头、响应头、响应体）",
  {
    selector: z.string().describe("要点击的元素CSS选择器"),
    waitTime: z.number().optional().describe("等待请求完成的时间(毫秒)，默认3000")
  },
  async ({ selector, waitTime = 3000 }) => {
    try {
      const result = await sendToBrowser("CLICK_AND_CAPTURE", { selector, waitTime }, waitTime + 5000);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `点击捕获失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 49. 获取 Burp 格式网络请求
server.tool(
  "get_network_requests_burp",
  "获取网络请求并转换为Burp Suite格式（包含完整的HTTP请求和响应）",
  {
    filter: z.string().optional().describe("URL过滤关键词"),
    limit: z.number().optional().describe("返回的最大数量，默认50")
  },
  async ({ filter, limit = 50 }) => {
    try {
      const result = await sendToBrowser("GET_NETWORK_REQUESTS_BURP", { filter, limit });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `获取失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 50. 点击并获取 Burp 格式请求
server.tool(
  "click_and_get_burp",
  "点击元素（如登录按钮）并获取产生的网络请求，输出Burp Suite格式",
  {
    selector: z.string().describe("要点击的元素CSS选择器（如登录按钮）"),
    waitTime: z.number().optional().describe("等待请求完成的时间(毫秒)，默认3000")
  },
  async ({ selector, waitTime = 3000 }) => {
    try {
      const result = await sendToBrowser("CLICK_AND_GET_BURP", { selector, waitTime }, waitTime + 5000);
      
      // 格式化输出
      let output = `## 点击元素: ${selector}\n\n`;
      output += `### 捕获到 ${result.totalRequests || 0} 个请求\n\n`;
      
      if (result.burpRequests && result.burpRequests.length > 0) {
        for (const req of result.burpRequests) {
          output += `---\n`;
          output += `#### [${req.index}] ${req.method} ${req.path}\n`;
          output += `**Host:** ${req.host}:${req.port} (${req.protocol})\n`;
          output += `**Status:** ${req.status || 'Pending'} | **Duration:** ${req.duration}\n\n`;
          
          output += `**📤 Request:**\n\`\`\`http\n${req.request}\`\`\`\n\n`;
          
          if (req.response) {
            output += `**📥 Response:**\n\`\`\`http\n${req.response.substring(0, 2000)}${req.response.length > 2000 ? '\n...(truncated)' : ''}\`\`\`\n\n`;
          }
        }
      } else {
        output += `*未捕获到请求*\n`;
      }
      
      return {
        content: [{
          type: "text",
          text: output
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `点击捕获失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 51. 自动登录并获取 Burp 格式请求
server.tool(
  "login_and_get_burp",
  "自动填写登录表单、点击登录按钮，并获取登录请求的Burp格式数据包",
  {
    username: z.string().describe("用户名"),
    password: z.string().describe("密码"),
    usernameSelector: z.string().optional().describe("用户名输入框选择器"),
    passwordSelector: z.string().optional().describe("密码输入框选择器"),
    submitSelector: z.string().optional().describe("登录按钮选择器"),
    waitTime: z.number().optional().describe("等待时间(毫秒)")
  },
  async ({ username, password, usernameSelector, passwordSelector, submitSelector, waitTime = 3000 }) => {
    try {
      // 使用客户端的 LOGIN_AND_GET_BURP 命令
      const result = await sendToBrowser("LOGIN_AND_GET_BURP", {
        username, password, usernameSelector, passwordSelector, submitSelector, waitTime
      }, waitTime + 10000);
      
      // 格式化 Burp 输出
      if (result.burpRequests && result.burpRequests.length > 0) {
        let output = "## 自动登录并捕获请求\n\n";
        output += "**用户名:** " + username + "\n";
        output += "**密码:** " + password + "\n\n";
        output += "### 捕获到 " + result.burpRequests.length + " 个请求\n\n";
        
        for (const req of result.burpRequests) {
          output += "---\n";
          output += "#### [" + req.index + "] " + req.method + " " + req.path + "\n";
          output += "**Host:** " + req.host + ":" + req.port + " (" + req.protocol + ")\n";
          output += "**Status:** " + (req.status || "Pending") + " | **Duration:** " + req.duration + "\n\n";
          output += "**Request:**\n```http\n" + req.request + "```\n\n";
          if (req.response) {
            const respText = req.response.length > 2000 ? req.response.substring(0, 2000) + "\n...(truncated)" : req.response;
            output += "**Response:**\n```http\n" + respText + "```\n\n";
          }
        }
        
        return {
          content: [{ type: "text", text: output }]
        };
      }
      
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: "登录捕获失败: " + error.message }],
        isError: true
      };
    }
  }
);

// ============== 敏感数据泄露检测功能 ==============

type SensitivePattern = { pattern: RegExp; severity: 'critical' | 'high' | 'medium' | 'low'; description: string; validate?: (value: string, context: string) => boolean; confidence: string };

function validChineseId(value: string): boolean {
  const id = value.toUpperCase();
  if (!/^\d{17}[\dX]$/.test(id) || /^(\d)\1{16}/.test(id)) return false;
  const birth = `${id.slice(6, 10)}-${id.slice(10, 12)}-${id.slice(12, 14)}`;
  const date = new Date(`${birth}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== birth) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
  return checks[weights.reduce((sum, weight, index) => sum + Number(id[index]) * weight, 0) % 11] === id[17];
}

function validLuhn(value: string): boolean {
  if (!/^\d{16,19}$/.test(value) || /^(\d)\1+$/.test(value)) return false;
  let sum = 0;
  let double = false;
  for (let index = value.length - 1; index >= 0; index--) {
    let digit = Number(value[index]);
    if (double) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

const SENSITIVE_PATTERNS: Record<string, SensitivePattern> = {
  idCard: {
    pattern: /(?<!\d)\d{17}[\dXx](?!\d)/g,
    severity: "critical",
    description: "身份证号（校验位有效）", confidence: 'high', validate: value => validChineseId(value)
  },
  phone: {
    pattern: /\b1[3-9]\d{9}\b/g,
    severity: "high", 
    description: "手机号（字段语义匹配）", confidence: 'medium',
    validate: (_value, context) => /(?:phone|mobile|tel|手机号|电话|联系方式)/i.test(context)
  },
  bankCard: {
    pattern: /\b\d{16,19}\b/g,
    severity: "critical",
    description: "银行卡号（Luhn 有效）", confidence: 'high', validate: value => validLuhn(value)
  },
  email: {
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    severity: "medium",
    description: "邮箱地址", confidence: 'medium'
  },
  chineseName: {
    pattern: /["'](?:realName|fullName|姓名|真实姓名)["']\s*:\s*["'][\u4e00-\u9fa5]{2,4}["']/gi,
    severity: "low",
    description: "姓名字段中的中文姓名", confidence: 'medium'
  },
  password: {
    pattern: /"(?:password|passwd|pwd|pass|secret|token|key)"\s*:\s*"[^"]+"/gi,
    severity: "critical",
    description: "密码/密钥字段", confidence: 'high',
    validate: value => !/:\s*["'](?:password|secret|token|test|example|changeme|\*+)["']/i.test(value)
  },
  ipAddress: {
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    severity: "low",
    description: "公开服务 IP（上下文匹配）", confidence: 'low',
    validate: (value, context) => !/^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|0\.|224\.|255\.)/.test(value) && /(?:server|backend|host|origin|endpoint|服务器|后端|主机)/i.test(context)
  },
  jwt: {
    pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    severity: "high",
    description: "JWT Token", confidence: 'high'
  },
  socialSecurity: {
    pattern: /["'](?:socialSecurity|providentFund|社保号|公积金号)["']\s*:\s*["'][A-Z]?\d{7,18}["']/gi,
    severity: "high",
    description: "社保/公积金字段", confidence: 'medium'
  }
};

// 敏感数据分析函数
function analyzeSensitiveData(text: string, enabledPatterns: string[] = []): {
  hasSensitiveData: boolean;
  severity: string;
  findings: Array<{
    type: string;
    description: string;
    severity: string;
    confidence: string;
    matches: string[];
    count: number;
  }>;
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
} {
  const findings: Array<{
    type: string;
    description: string;
    severity: string;
    confidence: string;
    matches: string[];
    count: number;
  }> = [];
  
  const summary = { critical: 0, high: 0, medium: 0, low: 0 };
  
  // 默认检测高风险字段
  const patternsToCheck = enabledPatterns.length > 0 
    ? enabledPatterns 
    : ['idCard', 'phone', 'bankCard', 'password', 'jwt'];
  
  for (const [key, config] of Object.entries(SENSITIVE_PATTERNS)) {
    if (patternsToCheck.includes(key) || patternsToCheck.includes('all')) {
      config.pattern.lastIndex = 0;
      const candidates = [...text.matchAll(config.pattern)];
      const matches = candidates.filter(match => {
        const index = match.index || 0;
        const context = text.slice(Math.max(0, index - 100), index + match[0].length + 100);
        return !config.validate || config.validate(match[0], context);
      }).map(match => match[0]);
      if (matches.length > 0) {
        // 去重并限制数量
        const uniqueMatches = [...new Set(matches)].slice(0, 10);
        
        findings.push({
          type: key,
          description: config.description,
          severity: config.severity,
          confidence: config.confidence,
          matches: uniqueMatches.map(m => maskSensitiveData(m, key)),
          count: matches.length
        });
        
        summary[config.severity as keyof typeof summary]++;
      }
    }
  }
  
  // 确定最高严重级别
  let maxSeverity = 'none';
  if (summary.critical > 0) maxSeverity = 'critical';
  else if (summary.high > 0) maxSeverity = 'high';
  else if (summary.medium > 0) maxSeverity = 'medium';
  else if (summary.low > 0) maxSeverity = 'low';
  
  return {
    hasSensitiveData: findings.length > 0,
    severity: maxSeverity,
    findings,
    summary
  };
}

// 敏感数据脱敏函数
function maskSensitiveData(data: string, type: string): string {
  switch (type) {
    case 'idCard':
      return data.slice(0, 6) + '****' + data.slice(-4);
    case 'phone':
      return data.slice(0, 3) + '****' + data.slice(-4);
    case 'bankCard':
      return data.slice(0, 4) + '****' + data.slice(-4);
    case 'email':
      const [local, domain] = data.split('@');
      return local.slice(0, 2) + '***@' + domain;
    case 'password':
      return data.replace(/"[^"]+"/g, '"***"');
    default:
      return data;
  }
}

// 52. 扫描 API 响应敏感数据
server.tool(
  "scan_sensitive_data",
  "扫描最近的API响应中是否包含敏感数据（身份证、手机号、银行卡、密码等）",
  {
    filter: z.string().optional().describe("URL过滤关键词"),
    patterns: z.array(z.enum(['idCard', 'phone', 'bankCard', 'email', 'chineseName', 'password', 'ipAddress', 'jwt', 'socialSecurity', 'all']))
      .optional()
      .describe("要检测的敏感数据类型，默认检测高风险类型"),
    limit: z.number().optional().describe("扫描的最大请求数量，默认20")
  },
  async ({ filter, patterns = ['idCard', 'phone', 'bankCard', 'password', 'jwt'], limit = 20 }) => {
    try {
      // 获取网络请求（包含响应体）
      const requests = await sendToBrowser("GET_NETWORK_REQUESTS_WITH_BODY", { filter, limit });
      
      const results: Array<{
        url: string;
        method: string;
        status: number;
        sensitiveData: ReturnType<typeof analyzeSensitiveData>;
        alertLevel: string;
      }> = [];
      
      let totalCritical = 0;
      let totalHigh = 0;
      
      for (const req of requests) {
        // 分析响应体
        const responseBody = req.responseBody || '';
        const analysis = analyzeSensitiveData(responseBody, patterns);
        
        if (analysis.hasSensitiveData) {
          results.push({
            url: req.url,
            method: req.method,
            status: req.statusCode,
            sensitiveData: analysis,
            alertLevel: analysis.severity
          });
          
          totalCritical += analysis.summary.critical;
          totalHigh += analysis.summary.high;
        }
      }
      
      // 生成报告
      const report = {
        scanTime: new Date().toISOString(),
        totalScanned: requests.length,
        issuesFound: results.length,
        severity: {
          critical: totalCritical,
          high: totalHigh
        },
        alert: totalCritical > 0 ? "🚨 严重警告：发现敏感数据泄露！" : 
               totalHigh > 0 ? "⚠️ 警告：发现潜在敏感数据" : 
               "✅ 未发现敏感数据泄露",
        findings: results
      };
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(report, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `扫描失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 53. 扫描路由敏感数据泄露
server.tool(
  "scan_route_sensitive_data",
  "访问指定路由并扫描返回数据中的敏感信息泄露",
  {
    route: z.string().describe("要访问的路由路径或完整URL"),
    waitTime: z.number().optional().describe("等待API请求的时间（毫秒），默认3000"),
    patterns: z.array(z.string()).optional().describe("要检测的敏感数据类型")
  },
  async ({ route, waitTime = 3000, patterns = ['idCard', 'phone', 'bankCard', 'password', 'jwt'] }) => {
    try {
      // 导航到目标路由
      await sendToBrowser("NAVIGATE_TO", { url: route });
      
      // 等待页面加载和API请求
      await new Promise(r => setTimeout(r, waitTime));
      
      // 获取页面信息
      const pageInfo = await sendToBrowser("GET_PAGE_INFO", {});
      
      // 获取页面内容
      const pageContent = await sendToBrowser("GET_PAGE_CONTENT", {});
      
      // 获取网络请求
      const requests = await sendToBrowser("GET_NETWORK_REQUESTS_WITH_BODY", { limit: 50 });
      
      // 分析页面内容
      const pageAnalysis = analyzeSensitiveData(pageContent || '', patterns);
      
      // 分析API响应
      const apiFindings: Array<{
        url: string;
        method: string;
        analysis: ReturnType<typeof analyzeSensitiveData>;
      }> = [];
      
      for (const req of requests) {
        if (req.responseBody) {
          const analysis = analyzeSensitiveData(req.responseBody, patterns);
          if (analysis.hasSensitiveData) {
            apiFindings.push({
              url: req.url,
              method: req.method,
              analysis
            });
          }
        }
      }
      
      // 计算总体风险
      const hasCritical = pageAnalysis.summary.critical > 0 || 
                         apiFindings.some(f => f.analysis.summary.critical > 0);
      const hasHigh = pageAnalysis.summary.high > 0 || 
                      apiFindings.some(f => f.analysis.summary.high > 0);
      
      const report = {
        route,
        pageUrl: pageInfo?.url,
        pageTitle: pageInfo?.title,
        scanTime: new Date().toISOString(),
        riskLevel: hasCritical ? "🚨 严重" : hasHigh ? "⚠️ 高危" : "✅ 安全",
        pageContentAnalysis: pageAnalysis,
        apiResponsesAnalysis: {
          totalApis: requests.length,
          apisWithSensitiveData: apiFindings.length,
          findings: apiFindings
        },
        recommendation: hasCritical 
          ? "立即修复！页面或API存在严重敏感数据泄露，包含身份证、银行卡或密码信息。"
          : hasHigh
          ? "建议修复！发现手机号或其他敏感信息泄露。"
          : "该路由暂未发现明显敏感数据泄露。"
      };
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(report, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `扫描失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 54. 批量扫描多个路由的敏感数据
server.tool(
  "batch_scan_sensitive_routes",
  "批量扫描多个路由，检测敏感数据泄露（适用于大屏、后台等未授权访问测试）",
  {
    routes: z.array(z.string()).describe("要扫描的路由列表"),
    waitTime: z.number().optional().describe("每个路由等待时间（毫秒），默认2000"),
    patterns: z.array(z.string()).optional().describe("要检测的敏感数据类型")
  },
  async ({ routes, waitTime = 2000, patterns = ['idCard', 'phone', 'bankCard', 'password', 'jwt'] }) => {
    try {
      const results: Array<{
        route: string;
        riskLevel: string;
        critical: number;
        high: number;
        findings: string[];
      }> = [];
      
      let totalCritical = 0;
      let totalHigh = 0;
      
      for (const route of routes) {
        try {
          // 导航
          await sendToBrowser("NAVIGATE_TO", { url: route });
          await new Promise(r => setTimeout(r, waitTime));
          
          // 获取页面内容
          const pageContent = await sendToBrowser("GET_PAGE_CONTENT", {});
          
          // 获取API响应
          const requests = await sendToBrowser("GET_NETWORK_REQUESTS_WITH_BODY", { limit: 30 });
          
          // 合并分析
          let allContent = pageContent || '';
          for (const req of requests) {
            if (req.responseBody) {
              allContent += '\n' + req.responseBody;
            }
          }
          
          const analysis = analyzeSensitiveData(allContent, patterns);
          
          if (analysis.hasSensitiveData) {
            results.push({
              route,
              riskLevel: analysis.severity,
              critical: analysis.summary.critical,
              high: analysis.summary.high,
              findings: analysis.findings.map(f => `${f.description}: ${f.count}处`)
            });
            
            totalCritical += analysis.summary.critical;
            totalHigh += analysis.summary.high;
          }
        } catch (e: any) {
          results.push({
            route,
            riskLevel: 'error',
            critical: 0,
            high: 0,
            findings: [`扫描出错: ${e.message}`]
          });
        }
      }
      
      // 按风险排序
      results.sort((a, b) => {
        const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, error: 4 };
        return (severityOrder[a.riskLevel] || 5) - (severityOrder[b.riskLevel] || 5);
      });
      
      const report = {
        scanTime: new Date().toISOString(),
        totalRoutes: routes.length,
        routesWithIssues: results.filter(r => r.riskLevel !== 'error' && r.critical + r.high > 0).length,
        overallRisk: totalCritical > 0 ? "🚨 严重 - 存在敏感数据泄露！" :
                     totalHigh > 0 ? "⚠️ 高危 - 存在潜在数据泄露" :
                     "✅ 安全 - 未发现敏感数据泄露",
        summary: {
          criticalFindings: totalCritical,
          highFindings: totalHigh
        },
        details: results,
        recommendation: totalCritical > 0 
          ? "🔴 紧急！发现严重敏感数据泄露（身份证/银行卡/密码），请立即修复访问控制！"
          : totalHigh > 0
          ? "🟡 警告！发现敏感信息泄露（手机号等），建议添加访问权限控制。"
          : "🟢 扫描完成，未发现明显敏感数据泄露。"
      };
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(report, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `批量扫描失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 55. 实时监控敏感数据（开启监控模式）
server.tool(
  "start_sensitive_monitor",
  "开始实时监控所有API响应中的敏感数据泄露",
  {
    patterns: z.array(z.string()).optional().describe("要监控的敏感数据类型"),
    alertOnCritical: z.boolean().optional().describe("发现严重泄露时是否立即告警，默认true")
  },
  async ({ patterns = ['idCard', 'phone', 'bankCard', 'password'], alertOnCritical = true }) => {
    try {
      const result = await sendToBrowser("START_SENSITIVE_MONITOR", { patterns, alertOnCritical });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: "敏感数据监控已启动",
            monitoringPatterns: patterns,
            alertOnCritical,
            ...result
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `启动监控失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 56. 获取敏感数据监控告警
server.tool(
  "get_sensitive_alerts",
  "获取敏感数据监控产生的告警信息",
  {
    limit: z.number().optional().describe("返回的最大告警数量，默认50"),
    severityFilter: z.enum(['critical', 'high', 'medium', 'low', 'all']).optional().describe("严重级别过滤")
  },
  async ({ limit = 50, severityFilter = 'all' }) => {
    try {
      const result = await sendToBrowser("GET_SENSITIVE_ALERTS", { limit, severityFilter });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `获取告警失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// ============== 请求头管理功能 ==============

// 57. 获取请求头配置
server.tool(
  "get_headers_config",
  "获取当前所有请求头组和请求头的配置信息",
  {},
  async () => {
    try {
      const result = await sendToBrowser("GET_HEADERS_CONFIG", {});
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `获取请求头配置失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 58. 创建请求头组
server.tool(
  "create_header_group",
  "创建一个新的请求头组",
  {
    name: z.string().describe("请求头组名称"),
    headers: z.array(z.object({
      name: z.string().describe("请求头名称"),
      value: z.string().describe("请求头值"),
      enabled: z.boolean().optional().describe("是否启用，默认true")
    })).optional().describe("初始请求头列表")
  },
  async ({ name, headers = [] }) => {
    try {
      const result = await sendToBrowser("CREATE_HEADER_GROUP", { name, headers });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `创建请求头组失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 59. 删除请求头组
server.tool(
  "delete_header_group",
  "删除指定的请求头组",
  {
    groupId: z.string().describe("请求头组ID")
  },
  async ({ groupId }) => {
    try {
      const result = await sendToBrowser("DELETE_HEADER_GROUP", { groupId });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `删除请求头组失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 60. 切换当前请求头组
server.tool(
  "switch_header_group",
  "切换到指定的请求头组（启用该组的请求头），传空字符串禁用所有请求头",
  {
    groupId: z.string().describe("请求头组ID，传空字符串禁用所有请求头")
  },
  async ({ groupId }) => {
    try {
      const result = await sendToBrowser("SWITCH_HEADER_GROUP", { groupId: groupId || null });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `切换请求头组失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 61. 添加请求头
server.tool(
  "add_header",
  "向指定请求头组添加一个请求头",
  {
    groupId: z.string().describe("请求头组ID"),
    name: z.string().describe("请求头名称（如 Authorization, X-Token 等）"),
    value: z.string().describe("请求头值"),
    enabled: z.boolean().optional().describe("是否启用，默认true")
  },
  async ({ groupId, name, value, enabled = true }) => {
    try {
      const result = await sendToBrowser("ADD_HEADER", { groupId, name, value, enabled });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `添加请求头失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 62. 更新请求头
server.tool(
  "update_header",
  "更新指定请求头的名称、值或启用状态",
  {
    groupId: z.string().describe("请求头组ID"),
    headerId: z.string().describe("请求头ID"),
    name: z.string().optional().describe("新的请求头名称"),
    value: z.string().optional().describe("新的请求头值"),
    enabled: z.boolean().optional().describe("是否启用")
  },
  async ({ groupId, headerId, name, value, enabled }) => {
    try {
      const result = await sendToBrowser("UPDATE_HEADER", { groupId, headerId, name, value, enabled });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `更新请求头失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 63. 删除请求头
server.tool(
  "delete_header",
  "从请求头组中删除指定的请求头",
  {
    groupId: z.string().describe("请求头组ID"),
    headerId: z.string().describe("请求头ID")
  },
  async ({ groupId, headerId }) => {
    try {
      const result = await sendToBrowser("DELETE_HEADER", { groupId, headerId });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `删除请求头失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 64. 切换请求头启用状态
server.tool(
  "toggle_header",
  "启用或禁用指定的请求头",
  {
    groupId: z.string().describe("请求头组ID"),
    headerId: z.string().describe("请求头ID"),
    enabled: z.boolean().describe("是否启用")
  },
  async ({ groupId, headerId, enabled }) => {
    try {
      const result = await sendToBrowser("TOGGLE_HEADER", { groupId, headerId, enabled });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `切换请求头状态失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 65. 批量更新请求头
server.tool(
  "batch_update_headers",
  "批量更新请求头组中的所有请求头（替换原有请求头）",
  {
    groupId: z.string().describe("请求头组ID"),
    headers: z.array(z.object({
      id: z.string().optional().describe("请求头ID（可选，不传则生成新ID）"),
      name: z.string().describe("请求头名称"),
      value: z.string().describe("请求头值"),
      enabled: z.boolean().optional().describe("是否启用，默认true")
    })).describe("请求头列表")
  },
  async ({ groupId, headers }) => {
    try {
      const result = await sendToBrowser("BATCH_UPDATE_HEADERS", { groupId, headers });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `批量更新请求头失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 66. 快速设置请求头（创建组+添加请求头+启用）
server.tool(
  "quick_set_headers",
  "快速设置请求头：创建新组并添加请求头，然后立即启用该组",
  {
    groupName: z.string().describe("请求头组名称"),
    headers: z.array(z.object({
      name: z.string().describe("请求头名称"),
      value: z.string().describe("请求头值")
    })).describe("请求头列表")
  },
  async ({ groupName, headers }) => {
    try {
      // 1. 创建新组
      const createResult = await sendToBrowser("CREATE_HEADER_GROUP", { 
        name: groupName, 
        headers: headers.map(h => ({ ...h, enabled: true }))
      });
      
      if (!createResult.success) {
        throw new Error("创建请求头组失败");
      }
      
      // 2. 切换到该组
      const switchResult = await sendToBrowser("SWITCH_HEADER_GROUP", { 
        groupId: createResult.groupId 
      });
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            groupId: createResult.groupId,
            groupName,
            headersCount: headers.length,
            message: `已创建请求头组 "${groupName}" 并启用 ${headers.length} 个请求头`,
            headers: headers
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `快速设置请求头失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// ============== 智能场景协调功能 ==============

/**
 * 场景配置：定义用户意图到脚本的映射关系
 * 当用户描述他们的需求时，MCP可以自动启用相关脚本
 */
const SCENARIO_CONFIGS: Record<string, {
  name: string;
  description: string;
  keywords: string[];
  scripts: string[];
  additionalActions?: string[];
}> = {
  // 加密解密分析场景
  encryption_analysis: {
    name: "加密解密分析",
    description: "自动启用RSA和CryptoJS Hook脚本，用于分析页面的加密解密过程",
    keywords: ["加密", "解密", "RSA", "AES", "CryptoJS", "密码", "encrypt", "decrypt", "password", "密文", "明文", "公钥", "私钥", "JSEncrypt"],
    scripts: ["Hook_JSEncrypt", "Hook_CryptoJS", "hook_log"],
    additionalActions: ["analyze_page_encryption"]
  },
  
  // 反调试绕过场景
  anti_debug_bypass: {
    name: "反调试绕过",
    description: "自动检测并启用反调试绕过脚本",
    keywords: ["反调试", "debugger", "调试", "断点", "无限循环", "anti-debug", "绕过", "bypass", "卡住", "控制台"],
    scripts: ["Bypass_Debugger", "hook_log", "hook_clear"],
    additionalActions: ["detect_anti_debug"]
  },
  
  // API请求分析场景
  api_analysis: {
    name: "API请求分析",
    description: "启用XHR和Fetch Hook脚本，分析API请求",
    keywords: ["API", "请求", "接口", "XHR", "fetch", "网络", "request", "response", "header", "签名", "sign"],
    scripts: ["hook_xhr_open", "hook_xhr_setRequestHeader", "hook_fetch", "hook_log"],
    additionalActions: ["analyze_api_signature"]
  },
  
  // Cookie/Storage分析场景
  storage_analysis: {
    name: "存储分析",
    description: "启用Cookie和Storage Hook脚本，分析数据存储",
    keywords: ["cookie", "localStorage", "sessionStorage", "存储", "token", "session", "认证", "auth", "登录状态"],
    scripts: ["Hook_cookie", "hook_localStorage_setItem", "hook_localStorage_getItem", "hook_sessionStorage_setItem", "hook_sessionStorage_getItem", "hook_log"],
    additionalActions: ["analyze_authentication"]
  },
  
  // Vue路由分析场景
  vue_analysis: {
    name: "Vue路由分析",
    description: "启用Vue路由获取和守卫清除脚本",
    keywords: ["vue", "路由", "router", "守卫", "跳转", "导航", "beforeEach", "permission", "权限"],
    scripts: ["Get_Vue_0", "Get_Vue_1", "Clear_vue_Navigation_Guards", "detectorExec"],
    additionalActions: ["get_vue_routes"]
  },
  
  // 登录分析场景
  login_analysis: {
    name: "登录分析",
    description: "综合分析登录页面：加密方式、API请求、认证机制",
    keywords: ["登录", "login", "用户名", "密码", "password", "username", "表单", "form", "submit", "验证码"],
    scripts: ["Hook_JSEncrypt", "Hook_CryptoJS", "hook_xhr_open", "hook_xhr_setRequestHeader", "Hook_cookie", "hook_log"],
    additionalActions: ["get_page_forms", "analyze_page_encryption"]
  },
  
  // 完整分析场景
  full_analysis: {
    name: "完整页面分析",
    description: "启用所有必要的Hook脚本进行完整分析",
    keywords: ["完整分析", "全面分析", "full", "complete", "all", "全部"],
    scripts: ["Hook_JSEncrypt", "Hook_CryptoJS", "hook_xhr_open", "hook_xhr_setRequestHeader", "hook_fetch", "Hook_cookie", "hook_log", "Bypass_Debugger"],
    additionalActions: ["full_page_analysis"]
  },
  
  // JSON数据分析场景
  json_analysis: {
    name: "JSON数据分析",
    description: "Hook JSON.parse和JSON.stringify，分析数据流",
    keywords: ["json", "数据", "parse", "stringify", "序列化", "反序列化"],
    scripts: ["hook_json_parse", "hook_json_stringify", "hook_log"],
    additionalActions: []
  },
  
  // 页面跳转定位场景
  redirect_analysis: {
    name: "跳转分析",
    description: "定位页面跳转代码，防止自动跳转",
    keywords: ["跳转", "redirect", "location", "href", "返回", "关闭", "close", "history"],
    scripts: ["location_href", "hook_close", "hook_history", "hook_log"],
    additionalActions: []
  },
  
  // 敏感数据检测场景
  sensitive_data: {
    name: "敏感数据检测",
    description: "检测API响应中的敏感数据泄露",
    keywords: ["敏感", "泄露", "身份证", "手机号", "银行卡", "隐私", "个人信息", "sensitive", "leak"],
    scripts: ["hook_xhr_open", "hook_fetch", "hook_log"],
    additionalActions: ["scan_sensitive_data"]
  },
  
  // 时间戳/随机数分析场景
  random_analysis: {
    name: "随机数/时间戳分析",
    description: "固定随机数和时间戳，用于签名分析",
    keywords: ["random", "随机", "时间戳", "timestamp", "Date.now", "Math.random", "签名", "sign"],
    scripts: ["hook_random", "Hook_Date_now", "hook_log"],
    additionalActions: []
  },
  
  // 未授权测试场景（需要先检测Vue）
  unauthorized_test: {
    name: "未授权测试",
    description: "测试未授权访问漏洞：大屏未授权、路由未授权等（仅Vue站点可用）",
    keywords: ["未授权", "unauthorized", "大屏", "测试未授权", "找未授权", "权限", "访问控制", "越权"],
    scripts: ["Get_Vue_0", "Get_Vue_1", "Clear_vue_Navigation_Guards", "hook_log"],
    additionalActions: ["batch_scan_routes", "batch_scan_sensitive_routes"]
  }
};

// 67. 智能场景启用工具
server.tool(
  "smart_enable_scenario",
  "根据用户意图智能启用相关脚本组合。例如：'加密分析'会自动启用Hook JSEncrypt RSA和Hook CryptoJS。对于'未授权测试'会先检测Vue站点。",
  {
    intent: z.string().describe("用户意图描述，如：'加密解密分析'、'反调试绕过'、'未授权测试'、'API请求分析'等"),
    autoRefresh: z.boolean().optional().describe("启用脚本后是否自动刷新页面，默认true")
  },
  async ({ intent, autoRefresh = true }) => {
    try {
      // 匹配最合适的场景
      let bestMatch: { scenarioId: string; score: number } | null = null;
      const intentLower = intent.toLowerCase();
      
      for (const [scenarioId, config] of Object.entries(SCENARIO_CONFIGS)) {
        let score = 0;
        for (const keyword of config.keywords) {
          if (intentLower.includes(keyword.toLowerCase())) {
            score += keyword.length; // 关键词越长匹配越精确
          }
        }
        if (score > 0 && (!bestMatch || score > bestMatch.score)) {
          bestMatch = { scenarioId, score };
        }
      }
      
      if (!bestMatch) {
        // 没有匹配，返回可用场景列表
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              message: `未能识别意图 "${intent}"，请尝试以下场景：`,
              availableScenarios: Object.entries(SCENARIO_CONFIGS).map(([id, config]) => ({
                id,
                name: config.name,
                description: config.description,
                keywords: config.keywords.slice(0, 5).join(", ") + "..."
              }))
            }, null, 2)
          }]
        };
      }
      
      const scenario = SCENARIO_CONFIGS[bestMatch.scenarioId];
      
      // 🔥 特殊处理：未授权测试需要先检测Vue站点
      if (bestMatch.scenarioId === 'unauthorized_test' || bestMatch.scenarioId === 'vue_analysis') {
        // 先检测是否为Vue站点
        let isVueSite = false;
        try {
          const vueData = await sendToBrowser("EXTRACT_VUE_DATA", {});
          if (vueData && !vueData.error && (vueData.version || vueData.hasVue)) {
            isVueSite = true;
          }
        } catch (e) {
          // 检测失败
        }
        
        if (!isVueSite) {
          // 不是Vue站点，不能进行Vue相关操作
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: false,
                matchedScenario: {
                  id: bestMatch.scenarioId,
                  name: scenario.name
                },
                isVueSite: false,
                message: `⚠️ 当前站点未检测到Vue框架，无法执行 "${scenario.name}"`,
                reason: "该功能需要Vue Router支持，当前站点不是Vue应用",
                alternativeActions: {
                  canDo: [
                    { tool: "quick_encryption_analysis", description: "加密解密分析 - 分析RSA/AES等加密" },
                    { tool: "quick_api_analysis", description: "API请求分析 - Hook XHR/Fetch请求" },
                    { tool: "quick_anti_debug_bypass", description: "反调试绕过 - 绕过debugger等" },
                    { tool: "scan_sensitive_data", description: "敏感数据扫描 - 检测API响应中的敏感信息" },
                    { tool: "analyze_authentication", description: "认证分析 - 分析token/cookie等" }
                  ],
                  cannotDo: [
                    "Vue路由未授权测试",
                    "大屏页面路由遍历", 
                    "路由守卫清除",
                    "Vue数据提取"
                  ]
                },
                suggestion: "建议使用 quick_encryption_analysis 或 quick_api_analysis 进行通用分析"
              }, null, 2)
            }]
          };
        }
        
        // 是Vue站点，继续执行
      }
      
      // 批量启用脚本
      const results = await sendToBrowser("BATCH_ENABLE_SCRIPTS", { 
        scriptIds: scenario.scripts,
        autoRefresh
      });
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            matchedScenario: {
              id: bestMatch.scenarioId,
              name: scenario.name,
              description: scenario.description
            },
            enabledScripts: scenario.scripts,
            autoRefresh,
            message: `已启用 "${scenario.name}" 场景，共 ${scenario.scripts.length} 个脚本`,
            nextSteps: scenario.additionalActions?.length 
              ? `建议接下来调用: ${scenario.additionalActions.join(", ")}`
              : "脚本已就绪，刷新页面后生效",
            ...results
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `智能启用失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 68. 获取可用场景列表
server.tool(
  "list_scenarios",
  "获取所有可用的智能场景配置列表",
  {},
  async () => {
    const scenarios = Object.entries(SCENARIO_CONFIGS).map(([id, config]) => ({
      id,
      name: config.name,
      description: config.description,
      scripts: config.scripts,
      keywords: config.keywords
    }));
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          totalScenarios: scenarios.length,
          scenarios,
          usage: "使用 smart_enable_scenario 工具并传入意图描述来自动启用相关脚本"
        }, null, 2)
      }]
    };
  }
);

// 69. 快捷工具：加密分析（一键启用加密相关Hook + 分析）
server.tool(
  "quick_encryption_analysis",
  "一键启用加密分析：自动开启 Hook JSEncrypt RSA 和 Hook CryptoJS，然后分析页面加密方式",
  {
    autoRefresh: z.boolean().optional().describe("是否自动刷新页面，默认true")
  },
  async ({ autoRefresh = true }) => {
    try {
      const results: any = { steps: [] };
      
      // 步骤1: 启用加密Hook脚本
      results.steps.push({ step: 1, action: "启用加密Hook脚本" });
      const enableResult = await sendToBrowser("BATCH_ENABLE_SCRIPTS", {
        scriptIds: ["Hook_JSEncrypt", "Hook_CryptoJS", "hook_log"],
        autoRefresh
      });
      results.scriptsEnabled = enableResult;
      
      if (autoRefresh) {
        // 等待页面刷新完成
        results.steps.push({ step: 2, action: "等待页面刷新" });
        await new Promise(r => setTimeout(r, 2000));
      }
      
      // 步骤3: 分析页面加密
      results.steps.push({ step: 3, action: "分析页面加密方式" });
      try {
        results.pageAnalysis = await sendToBrowser("ANALYZE_PAGE_ENCRYPTION", {});
      } catch (e) {
        results.pageAnalysis = { error: "分析失败，请手动调用 analyze_page_encryption" };
      }
      
      results.summary = {
        enabled: ["Hook_JSEncrypt (RSA加密Hook)", "Hook_CryptoJS (对称加密Hook)", "hook_log (控制台保护)"],
        message: "加密分析已就绪，所有加密操作将在控制台打印",
        tips: [
          "刷新页面后脚本生效",
          "在控制台中可以看到加密前的明文和加密后的密文",
          "如果使用JSEncrypt，还会捕获公钥",
          "使用 get_captured_encryption 获取捕获的加密数据"
        ]
      };
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(results, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `加密分析启用失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 70. 快捷工具：反调试绕过（一键检测 + 启用绕过脚本）
server.tool(
  "quick_anti_debug_bypass",
  "一键反调试绕过：自动检测页面反调试机制并启用相应的绕过脚本",
  {
    autoRefresh: z.boolean().optional().describe("是否自动刷新页面，默认true")
  },
  async ({ autoRefresh = true }) => {
    try {
      const results: any = { steps: [] };
      
      // 步骤1: 先启用基础反调试脚本
      results.steps.push({ step: 1, action: "启用基础反调试脚本" });
      await sendToBrowser("BATCH_ENABLE_SCRIPTS", {
        scriptIds: ["Bypass_Debugger", "hook_log", "hook_clear"],
        autoRefresh: false
      });
      
      // 步骤2: 检测页面反调试机制
      results.steps.push({ step: 2, action: "检测反调试机制" });
      try {
        results.detection = await sendToBrowser("DETECT_ANTI_DEBUG", {});
        
        // 步骤3: 根据检测结果启用额外脚本
        if (results.detection.recommendations && results.detection.recommendations.length > 0) {
          results.steps.push({ step: 3, action: "启用推荐脚本" });
          await sendToBrowser("BATCH_ENABLE_SCRIPTS", {
            scriptIds: results.detection.recommendations,
            autoRefresh: false
          });
        }
      } catch (e) {
        results.detection = { error: "检测失败" };
      }
      
      if (autoRefresh) {
        results.steps.push({ step: 4, action: "刷新页面" });
        await sendToBrowser("REFRESH_PAGE", { hardRefresh: true });
      }
      
      results.summary = {
        baseScriptsEnabled: ["Bypass_Debugger", "hook_log", "hook_clear"],
        additionalScripts: results.detection?.recommendations || [],
        message: "反调试绕过已启用",
        tips: [
          "Bypass_Debugger: 绕过无限debugger",
          "hook_log: 防止控制台被清空",
          "hook_clear: 禁止清空控制台"
        ]
      };
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(results, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `反调试绕过失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 71. 快捷工具：API分析（一键启用API Hook + 分析）
server.tool(
  "quick_api_analysis",
  "一键API分析：启用XHR/Fetch Hook脚本，捕获并分析API请求",
  {
    autoRefresh: z.boolean().optional().describe("是否自动刷新页面，默认true")
  },
  async ({ autoRefresh = true }) => {
    try {
      const results: any = { steps: [] };
      
      // 步骤1: 启用API Hook脚本
      results.steps.push({ step: 1, action: "启用API Hook脚本" });
      await sendToBrowser("BATCH_ENABLE_SCRIPTS", {
        scriptIds: ["hook_xhr_open", "hook_xhr_setRequestHeader", "hook_fetch", "hook_log"],
        autoRefresh
      });
      
      if (autoRefresh) {
        results.steps.push({ step: 2, action: "等待页面刷新" });
        await new Promise(r => setTimeout(r, 2000));
      }
      
      // 步骤3: 获取已有的网络请求
      results.steps.push({ step: 3, action: "获取网络请求" });
      try {
        results.requests = await sendToBrowser("GET_NETWORK_REQUESTS", { limit: 20 });
      } catch (e) {
        results.requests = [];
      }
      
      results.summary = {
        enabled: ["hook_xhr_open", "hook_xhr_setRequestHeader", "hook_fetch", "hook_log"],
        message: "API分析已就绪，所有XHR和Fetch请求将在控制台打印",
        tips: [
          "hook_xhr_open: 捕获XHR请求URL和方法",
          "hook_xhr_setRequestHeader: 捕获请求头设置",
          "hook_fetch: 捕获Fetch API请求",
          "使用 get_network_requests 获取所有捕获的请求"
        ]
      };
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(results, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `API分析启用失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 72. 快捷工具：Vue分析（一键获取路由 + 清除守卫）
server.tool(
  "quick_vue_analysis",
  "一键Vue分析：启用路由获取脚本，获取路由信息并可选择清除路由守卫",
  {
    clearGuards: z.boolean().optional().describe("是否同时清除路由守卫，默认false"),
    autoRefresh: z.boolean().optional().describe("是否自动刷新页面，默认true")
  },
  async ({ clearGuards = false, autoRefresh = true }) => {
    try {
      const results: any = { steps: [] };
      
      // 步骤1: 启用Vue脚本
      const scripts = ["Get_Vue_0", "detectorExec"];
      if (clearGuards) {
        scripts.push("Get_Vue_1", "Clear_vue_Navigation_Guards");
      }
      
      results.steps.push({ step: 1, action: "启用Vue分析脚本" });
      await sendToBrowser("BATCH_ENABLE_SCRIPTS", {
        scriptIds: scripts,
        autoRefresh
      });
      
      if (autoRefresh) {
        results.steps.push({ step: 2, action: "等待页面刷新" });
        await new Promise(r => setTimeout(r, 2000));
      }
      
      // 步骤3: 获取Vue路由数据
      results.steps.push({ step: 3, action: "获取Vue路由" });
      try {
        results.vueData = await sendToBrowser("GET_VUE_ROUTER_DATA", {});
      } catch (e) {
        results.vueData = { error: "获取失败，可能页面未使用Vue Router" };
      }
      
      results.summary = {
        enabled: scripts,
        guardsCleared: clearGuards,
        message: clearGuards ? "Vue路由分析已就绪，路由守卫已清除" : "Vue路由分析已就绪",
        tips: [
          "Get_Vue_0: 获取已加载的路由",
          "detectorExec: 激活Vue Devtools",
          clearGuards ? "已清除路由守卫，可自由访问各页面" : "如需清除路由守卫，设置 clearGuards: true"
        ]
      };
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(results, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Vue分析启用失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 73. 智能未授权测试（自动检测Vue + 执行未授权测试）
server.tool(
  "smart_unauthorized_test",
  "智能未授权测试：先检测是否为Vue站点，如果是则进行大屏未授权测试和Vue路由未授权测试；如果不是Vue站点，则提示只能进行通用分析（如加密解密）",
  {
    scanSensitiveData: z.boolean().optional().describe("是否同时扫描敏感数据泄露，默认true"),
    waitTime: z.number().optional().describe("每个路由等待时间(毫秒)，默认2000")
  },
  async ({ scanSensitiveData = true, waitTime = 2000 }) => {
    try {
      const results: any = { 
        timestamp: new Date().toISOString(),
        steps: [],
        isVueSite: false,
        canTestUnauthorized: false
      };
      
      // 步骤1: 获取页面信息
      results.steps.push({ step: 1, action: "获取页面信息" });
      let pageInfo;
      try {
        pageInfo = await sendToBrowser("GET_PAGE_INFO", {});
        results.pageInfo = pageInfo;
      } catch (e) {
        throw new Error("无法获取页面信息，请确保浏览器扩展已连接");
      }
      
      // 步骤2: 检测是否为Vue站点
      results.steps.push({ step: 2, action: "检测Vue框架" });
      let vueDetection;
      try {
        vueDetection = await sendToBrowser("EXTRACT_VUE_DATA", {});
        results.vueDetection = vueDetection;
        
        // 判断是否为Vue站点
        if (vueDetection && !vueDetection.error && (vueDetection.version || vueDetection.hasVue)) {
          results.isVueSite = true;
          results.vueVersion = vueDetection.version;
        }
      } catch (e) {
        results.vueDetection = { error: "检测失败" };
      }
      
      // 如果不是Vue站点
      if (!results.isVueSite) {
        results.canTestUnauthorized = false;
        results.message = "⚠️ 当前站点未检测到Vue Router，无法进行Vue路由未授权测试";
        results.availableActions = {
          canDo: [
            "加密解密分析 (quick_encryption_analysis)",
            "API请求分析 (quick_api_analysis)",
            "反调试绕过 (quick_anti_debug_bypass)",
            "敏感数据扫描 (scan_sensitive_data)",
            "认证机制分析 (analyze_authentication)"
          ],
          cannotDo: [
            "Vue路由未授权测试",
            "大屏页面路由遍历",
            "路由守卫清除"
          ]
        };
        results.suggestion = "该站点不是Vue应用，建议使用 quick_encryption_analysis 或 quick_api_analysis 进行通用分析";
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(results, null, 2)
          }]
        };
      }
      
      // 是Vue站点，开始未授权测试
      results.canTestUnauthorized = true;
      results.message = "✅ 检测到Vue站点，开始未授权测试";
      
      // 步骤3: 启用Vue相关脚本
      results.steps.push({ step: 3, action: "启用Vue路由分析脚本" });
      await sendToBrowser("BATCH_ENABLE_SCRIPTS", {
        scriptIds: ["Get_Vue_0", "Get_Vue_1", "Clear_vue_Navigation_Guards", "hook_log"],
        autoRefresh: true
      });
      
      // 等待页面刷新
      results.steps.push({ step: 4, action: "等待页面刷新" });
      await new Promise(r => setTimeout(r, 2500));
      
      // 步骤5: 获取Vue路由
      results.steps.push({ step: 5, action: "获取Vue路由列表" });
      let vueRoutes;
      try {
        vueRoutes = await sendToBrowser("GET_VUE_ROUTER_DATA", {});
        results.vueRoutes = vueRoutes;
      } catch (e) {
        results.vueRoutes = { error: "获取路由失败" };
      }
      
      // 提取路由路径
      const routePaths: string[] = [];
      if (vueRoutes && vueRoutes.routes && Array.isArray(vueRoutes.routes)) {
        for (const route of vueRoutes.routes) {
          if (route.path && route.path !== '*' && route.path !== '/:pathMatch(.*)*') {
            routePaths.push(route.path);
            // 也添加子路由
            if (route.children && Array.isArray(route.children)) {
              for (const child of route.children) {
                if (child.path) {
                  const fullPath = route.path === '/' 
                    ? '/' + child.path 
                    : route.path + '/' + child.path;
                  routePaths.push(fullPath.replace(/\/+/g, '/'));
                }
              }
            }
          }
        }
      }
      
      results.extractedRoutes = routePaths;
      results.totalRoutes = routePaths.length;
      
      if (routePaths.length === 0) {
        results.warning = "未能获取到路由列表，可能需要手动刷新页面后重试";
        return {
          content: [{
            type: "text",
            text: JSON.stringify(results, null, 2)
          }]
        };
      }
      
      // 步骤6: 识别可能的大屏/敏感路由
      results.steps.push({ step: 6, action: "识别潜在敏感路由" });
      const sensitiveKeywords = ['dashboard', 'admin', 'screen', 'big', 'large', 'monitor', 'data', 'report', 'chart', 'panel', 'manage', 'system', 'user', 'config', 'setting', '大屏', '监控', '管理', '统计', '报表'];
      
      const potentialSensitiveRoutes = routePaths.filter(path => {
        const pathLower = path.toLowerCase();
        return sensitiveKeywords.some(keyword => pathLower.includes(keyword));
      });
      
      results.potentialSensitiveRoutes = potentialSensitiveRoutes;
      results.sensitiveRoutesCount = potentialSensitiveRoutes.length;
      
      // 步骤7: 如果需要扫描敏感数据
      if (scanSensitiveData && potentialSensitiveRoutes.length > 0) {
        results.steps.push({ step: 7, action: "扫描敏感路由中的数据泄露" });
        
        // 限制扫描数量，避免太慢
        const routesToScan = potentialSensitiveRoutes.slice(0, 10);
        
        try {
          const scanResults: any[] = [];
          for (const route of routesToScan) {
            try {
              // 导航到路由
              await sendToBrowser("NAVIGATE_TO", { url: route });
              await new Promise(r => setTimeout(r, waitTime));
              
              // 获取当前页面内容
              const pageContent = await sendToBrowser("GET_PAGE_CONTENT", {});
              
              scanResults.push({
                route,
                accessible: true,
                contentLength: pageContent?.length || 0,
                hasContent: (pageContent?.length || 0) > 100
              });
            } catch (e: any) {
              scanResults.push({
                route,
                accessible: false,
                error: e.message
              });
            }
          }
          
          results.routeScanResults = scanResults;
          results.accessibleRoutes = scanResults.filter(r => r.accessible && r.hasContent);
          results.accessibleCount = results.accessibleRoutes.length;
          
        } catch (e: any) {
          results.scanError = e.message;
        }
      }
      
      // 生成测试报告
      results.summary = {
        isVueSite: true,
        vueVersion: results.vueVersion || "unknown",
        totalRoutes: routePaths.length,
        sensitiveRoutes: potentialSensitiveRoutes.length,
        accessibleWithoutAuth: results.accessibleCount || 0,
        riskLevel: (results.accessibleCount || 0) > 0 ? "🔴 高风险 - 存在未授权访问" : "🟢 暂未发现明显未授权"
      };
      
      results.recommendations = [
        "1. 检查上述可访问的路由是否应该有权限控制",
        "2. 使用 batch_scan_sensitive_routes 进行更详细的敏感数据扫描",
        "3. 对大屏类路由进行手动验证是否可未授权访问",
        "4. 检查路由守卫是否正确配置"
      ];
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(results, null, 2)
        }]
      };
      
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `未授权测试失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 74. 检测站点类型（Vue/React/其他）
server.tool(
  "detect_site_framework",
  "检测当前站点使用的前端框架（Vue、React等），用于判断可以使用哪些功能",
  {},
  async () => {
    try {
      const results: any = {
        frameworks: {
          vue: false,
          react: false,
          angular: false,
          jquery: false
        },
        vueVersion: null,
        reactVersion: null,
        hasRouter: false,
        availableFeatures: []
      };
      
      // 检测Vue
      try {
        const vueData = await sendToBrowser("EXTRACT_VUE_DATA", {});
        if (vueData && !vueData.error && (vueData.version || vueData.hasVue)) {
          results.frameworks.vue = true;
          results.vueVersion = vueData.version;
          if (vueData.routes || vueData.router) {
            results.hasRouter = true;
          }
        }
      } catch (e) {}
      
      // 检测React
      try {
        const reactData = await sendToBrowser("EXTRACT_REACT_DATA", {});
        if (reactData && !reactData.error && (reactData.version || reactData.hasReact)) {
          results.frameworks.react = true;
          results.reactVersion = reactData.version;
        }
      } catch (e) {}
      
      // 根据检测结果设置可用功能
      if (results.frameworks.vue && results.hasRouter) {
        results.availableFeatures = [
          "✅ Vue路由未授权测试 (smart_unauthorized_test)",
          "✅ Vue路由分析 (quick_vue_analysis)",
          "✅ 路由守卫清除",
          "✅ 大屏页面扫描",
          "✅ 加密解密分析",
          "✅ API请求分析",
          "✅ 敏感数据检测"
        ];
      } else if (results.frameworks.vue) {
        results.availableFeatures = [
          "⚠️ Vue站点但无Router，功能受限",
          "✅ 加密解密分析",
          "✅ API请求分析",
          "✅ 敏感数据检测"
        ];
      } else {
        results.availableFeatures = [
          "❌ 非Vue站点，Vue相关功能不可用",
          "✅ 加密解密分析 (quick_encryption_analysis)",
          "✅ API请求分析 (quick_api_analysis)",
          "✅ 反调试绕过 (quick_anti_debug_bypass)",
          "✅ 敏感数据检测 (scan_sensitive_data)"
        ];
      }
      
      results.summary = results.frameworks.vue 
        ? `Vue ${results.vueVersion || ''} 站点${results.hasRouter ? '（有Router）' : '（无Router）'}`
        : results.frameworks.react 
          ? `React ${results.reactVersion || ''} 站点`
          : "非Vue/React站点";
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(results, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `检测失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 75. 批量启用脚本
server.tool(
  "batch_enable_scripts",
  "批量启用或禁用多个脚本",
  {
    scriptIds: z.array(z.string()).describe("要启用的脚本ID列表"),
    enabled: z.boolean().optional().describe("是否启用，默认true"),
    autoRefresh: z.boolean().optional().describe("是否自动刷新页面，默认false")
  },
  async ({ scriptIds, enabled = true, autoRefresh = false }) => {
    try {
      const result = await sendToBrowser("BATCH_ENABLE_SCRIPTS", { 
        scriptIds, 
        enabled,
        autoRefresh 
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `批量操作失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// 74. 禁用所有脚本
server.tool(
  "disable_all_scripts",
  "禁用当前页面的所有已启用脚本",
  {
    autoRefresh: z.boolean().optional().describe("是否自动刷新页面，默认false")
  },
  async ({ autoRefresh = false }) => {
    try {
      const result = await sendToBrowser("DISABLE_ALL_SCRIPTS", { autoRefresh });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `禁用失败: ${error.message}` }],
        isError: true
      };
    }
  }
);

// ============== 统一前端与接口分析 ==============
server.tool(
  "detect_frontend_stack",
  "统一识别当前页面的前端框架、运行时、网络库和加密库，不再要求分别调用Vue/React模块",
  {},
  async () => {
    try {
      const result = await sendToBrowser("DETECT_FRONTEND_STACK", {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `统一框架检测失败: ${error.message}` }], isError: true };
    }
  }
);

server.tool(
  "get_captured_api_analysis",
  "获取用户点击页面功能后自动捕获、去重并切割完成的接口结果（baseUrl、apiPrefix、businessEndpoint）",
  {},
  async () => {
    try {
      const result = await sendToBrowser("GET_CAPTURED_API_ANALYSIS", {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `获取接口分析失败: ${error.message}` }], isError: true };
    }
  }
);

server.tool(
  "clear_captured_api_analysis",
  "清空当前标签页自动捕获的接口分析记录",
  {},
  async () => {
    try {
      const result = await sendToBrowser("CLEAR_CAPTURED_API_ANALYSIS", {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `清空失败: ${error.message}` }], isError: true };
    }
  }
);

server.tool(
  "analyze_page_javascript_endpoints",
  "收集当前页面JavaScript并使用AST还原fetch、XHR、axios/request调用中的字符串拼接接口，同时合并运行时已捕获接口",
  {
    maxScripts: z.number().optional().describe("最多分析脚本数量，默认25，最大60"),
    maxBytesPerScript: z.number().optional().describe("每个脚本最大分析字节数，默认1000000")
  },
  async ({ maxScripts = 25, maxBytesPerScript = 1000000 }) => {
    try {
      const pageScripts = await sendToBrowser("GET_PAGE_SCRIPTS", { maxScripts, maxBytesPerScript }, 30000);
      const staticEndpoints = analyzeJavaScriptEndpoints(pageScripts.scripts || [], pageScripts.pageUrl || '');
      let runtimeAnalysis: any = { endpoints: [] };
      try { runtimeAnalysis = await sendToBrowser("GET_CAPTURED_API_ANALYSIS", {}); } catch {}
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            pageUrl: pageScripts.pageUrl,
            scriptsDiscovered: pageScripts.totalDiscovered,
            scriptsAnalyzed: pageScripts.scripts?.length || 0,
            runtimeEndpoints: runtimeAnalysis.endpoints || [],
            staticEndpoints,
            summary: {
              runtimeCount: runtimeAnalysis.endpoints?.length || 0,
              staticCandidateCount: staticEndpoints.length
            }
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return { content: [{ type: "text", text: `JavaScript接口分析失败: ${error.message}` }], isError: true };
    }
  }
);

// ============== 资源定义 ==============

// 提供当前浏览器状态作为资源
server.resource(
  "browser-state",
  "browser://state",
  async (uri) => {
    return {
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(browserState, null, 2)
      }]
    };
  }
);

// ============== 启动服务器 ==============
async function main() {
  // 先初始化WebSocket服务器
  await initWebSocketServer();
  
  // 启动MCP服务器
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[MCP] AntiDebug Breaker MCP服务器已启动");
  console.error("[MCP] 等待浏览器扩展连接到 ws://localhost:" + currentPort);
}

main().catch((error) => {
  console.error("[MCP] 启动失败:", error);
  process.exit(1);
});
