# OpenPI Browser Bridge

Chrome/Edge 145+ 的可选 Manifest V3 扩展。安装后，打开本机 OpenPI 工作台的浏览器工具即默认启用；网页输入、滚动和选择仍由原生 iframe 处理，不启动 Chromium 服务、截图或视频串流。

## 安装

1. 打开 `chrome://extensions`（Edge 使用 `edge://extensions`），开启开发者模式。
2. 选择“加载已解压的扩展程序”，选择本目录（包含 `manifest.json`）。
3. 刷新 `http://127.0.0.1:端口/` 或 `http://localhost:端口/` 的 OpenPI 页面，打开浏览器工具。底部出现“浏览增强已开启”才表示连接成功。

更新文件后，在扩展管理页点击重新加载，再刷新 OpenPI。禁用或移除扩展即可撤销增强；OpenPI 保留普通 iframe 浏览。扩展不由 npm 安装脚本自动安装，不修改 Pi 配置，不增加 `/openpi-setup` 开关。安装及站点权限由浏览器管理。

## 行为

- 同步嵌入页面的实际地址、标题和可用的原生前进/后退状态；刷新当前页面。
- 普通新窗口链接、中键/修饰键点击，以及用户点击触发的带 HTTP(S) 地址的 `window.open`，转为 OpenPI 内部标签页。最多 8 页；达到上限时保留可外部打开的链接。
- 仅在已连接的本机 OpenPI 顶层标签页中，对外部子框架响应移除 `X-Frame-Options`。工作台自身来源例外，关闭浏览器工具、离开工作台或关闭顶层标签页后撤销规则。
- 保留完整 `Content-Security-Policy`，包括 `frame-ancestors`、脚本和对象限制；不修改 Cookie、登录或其他响应头。

这不是完整浏览器引擎。CSP 禁止嵌入、第三方 Cookie、验证码和登录策略仍可能限制访问。跨来源历史受 Navigation API 可见范围限制，不能保证全部可后退。空白弹窗、非 HTTP(S) 地址、下载和依赖 `window.opener`/返回窗口对象的流程不适合转成 iframe；空白登录弹窗保留浏览器原行为。已转换的 `window.open` 返回 `null`。网站在脚本执行早期保存的原始 `window.open` 引用也可能绕过桥接。

## 权限与边界

扩展申请 HTTP(S) 全站访问权限，才能在用户选择的网站中读地址/标题、处理导航及移除 XFO；安装时浏览器会提示这些权限。它不读取 OpenPI token 的值，不发送页面内容到服务器，不使用 debugger、Cookie API 或远程脚本。

顶层仅识别 loopback 根路径的 OpenPI 页面（标题及入口标记），不是远程身份认证机制。后台端口绑定原生 tab/document，页面桥接还必须匹配 OpenPI 实际 iframe 窗口、一次性 nonce 和活动页面 ID；嵌套框架不接收导航权限。XFO 规则受原生 tab ID、loopback 顶层域及子框架资源类型限制；该顶层标签中的嵌套子框架也在规则范围内，其他浏览器标签页不受影响。规则仅存在于浏览器会话中，后台重启先清理旧规则，再由活跃工作台重新连接。

Chrome 删除规则是异步操作，不能撤销已经处理的响应。同一个原生标签离开工作台、立即进入同一 loopback 域的其他应用时，最早发出的子框架请求可能赶在撤销完成前；撤销完成后的新请求恢复站点原限制。DNR 的顶层域条件不区分本机端口或路径，因此这不是本机不可信应用之间的隔离边界。

## 验证

`tests/web/openpi-web.e2e.ts` 的 `installed browser enhancement` 使用真实 Chrome 扩展测试 XFO 嵌入、地址/标题、前进/后退、刷新、SPA、重定向、内部标签页、空白弹窗，以及 CSP 保留、其他标签页隔离和离开工作台清理。运行方式与其余 Web Playwright 测试相同；需要支持 `Extensions.loadUnpacked` 的 Chrome/Chromium。
