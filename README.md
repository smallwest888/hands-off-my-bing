# 别动我的Bing主页 · Hands Off My Bing

Chrome 扩展：将 Chrome 新标签页打开为 Bing，并自动应用你选择的主页显示偏好。

**Hands Off My Bing** opens Bing in Chrome’s new tab and applies your selected homepage display preferences automatically.

![Metro-style home icon](design/logo/brand-board.png)

## 功能

- 分别设置菜单栏、新闻、热点和背景图片为显示、关闭或保持原样。
- 可暂停自动应用，自定义 0–2000 毫秒的切换间隔，并使用两个快捷预设。
- 设置界面支持简体中文、English、Deutsch，或跟随浏览器语言。
- 采用纯色深色 Metro 风格界面，不使用远程代码、广告或分析服务。

## 安装开发版

1. 下载或克隆此仓库。
2. 在 Chrome 打开扩展管理页并启用开发者模式。
3. 选择“加载已解压的扩展程序”，指定仓库中的 `src/` 文件夹。
4. 阅读 Chrome 显示的站点访问说明。扩展会替换 Chrome 新标签页；暂停设置不会恢复默认新标签页，停用或卸载后才会恢复。

## 检查和维护

需要当前受支持的 Node.js LTS，以及 `zip` 和 `unzip` 命令。运行全部离线检查：

```sh
node scripts/package-current.mjs --check
```

这会检查扩展文件范围、权限和主机范围、翻译、JS语法、历史归档策略，并运行七套离线测试。生成发布快照：

```sh
node scripts/package-current.mjs --freeze
node scripts/package-current.mjs --verify-release 1.2.11
```

发布构建会在本地生成 `extension/`、候选包和发布归档；这些产物不提交到仓库。唯一运行源码位于 `src/`。

## 隐私与范围

扩展只在 HTTPS 的 `www.bing.com`、`cn.bing.com` 和 `bing.com` 首页根路径工作。偏好和界面语言保存在本机；扩展会在浏览器会话内保留自己管理的标签标识，并短暂检查这些标签的URL和状态以应用或清理规则。它不读取搜索词、页面正文、Cookie、账号资料或请求正文，也不向开发者服务器发送数据。Bing 的联网活动及其原生设置由 Bing 自身处理。

仓库：[GitHub](https://github.com/smallwest888/hands-off-my-bing)。公开静态隐私说明：[English](https://smallwest888.github.io/hands-off-my-bing/privacy/privacy.html) · [简体中文](https://smallwest888.github.io/hands-off-my-bing/privacy/privacy.zh-CN.html) · [Deutsch](https://smallwest888.github.io/hands-off-my-bing/privacy/privacy.de.html)。

## 状态与许可

此仓库对应版本 1.2.11 源码快照。此版本尚未完成真实 Chrome 运行验收，也未提交到 Chrome Web Store。该扩展是独立项目，与 Microsoft、Bing 或 Google 无隶属关系，也未获其背书。

尚未添加开源许可证。
