# Firefox 版本

## 构建

在项目根目录执行：

```bash
node tools/build-firefox.mjs
```

产物：

- 解压目录：`dist/firefox`
- 安装包：`dist/antidebug-breaker-firefox-3.5.3.xpi`

## 本地调试安装

1. 在 Firefox 地址栏打开 `about:debugging#/runtime/this-firefox`。
2. 点击“临时载入附加组件”。
3. 选择 `dist/firefox/manifest.json`。
4. 打开普通网页后再打开开发者工具，工具栏中会出现 `AntiDebug` 面板。

该构建要求 Firefox 142 或更高版本；当前开发机的 Firefox 153 满足要求。

临时附加组件会在 Firefox 退出后移除。普通正式版 Firefox 若要永久安装 XPI，必须先通过 Mozilla 签名。

## MCP

Firefox 插件侧默认连接 `ws://localhost:9527`。现有 Trae 配置仍可保留 `MCP_PORT=1719`，MCP 服务会自动把浏览器桥接端口映射到 `9527`。插件设置中的端口应填写 `9527` 并启用 MCP。

插件会在本机分析网页 URL、页面内容、交互行为和可能包含身份凭据的请求信息；启用 MCP 后，这些数据可能传给本机 MCP 进程处理。因此 Firefox 清单如实声明了对应的数据权限。MCP 不启用时不会建立 WebSocket 连接。

Firefox 会限制扩展访问部分 Mozilla 内置或受保护页面；请在普通 HTTP/HTTPS 业务页面中测试捕获、脚本注入和 DevTools 面板。
