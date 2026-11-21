---
name: dsh-appearance-media-dev
description: 改动「外观媒体」插件（DSH 的背景/开机片头/屏保三合一插件）时使用。给出这个仓库的硬规矩、完成的定义、每条坑的来历，以及"断言必须能变红"的纪律。当用户要改这个插件的功能、界面、路由、素材能力，或要给它加东西时使用。
---

# 改动「外观媒体」插件时的规矩

**★ 动手前先读 `docs/项目规则.md`**（在这个仓库里）—— 那里有每条规则对应的真实事故。

## 完成的定义

```bash
node tools/verify-release.mjs          # 默认：两分钟内
node tools/verify-release.mjs --full   # 加上陌生人验收（克隆到临时目录再跑一遍全套）
```

**★ 这条命令全绿，才算做完。** 改了 `src/client.js` 还要跑 `node build-client.mjs`
（`lib/client.js` 是构建产物，**必须随包发布**，少了它装出来是坏的）。

## 三条最容易踩的

1. **★ 别用字符串手术改文件。** 用编辑工具或整文件重写；改完立刻 `node --check` **＋**
   跑一遍看真实输出。（我这么干过一次，把一个文件的 `for` 循环头切掉了，
   **文件还通过了语法检查**，逻辑却坏了。）
2. **★ 每条新断言都要能变红。** 写完自己造一个反例（改副本，不动真文件），
   看到它变红才算写完。**不能失败的检查不算检查。**
   参照：`node tools/verify-client-ui.mjs --negative`、`node tools/verify-media-delete.mjs --negative`。
3. **★ 动别人正在改的文件之前先读最新内容。** 看"红灯但代码看着没问题"，
   先怀疑并发编辑 —— `verify-release.mjs` 会直接告诉你哪些文件在测试期间被改过。

## 这个插件特有的几点

- **★ 用户能看到的文字在两处**：`README.md` 与 `docs/DETAIL.md`
  （后者是**插件详情页正文**，用户点插件名就能看到）。
  **内部代号（P05 之类）不许出现在那里**；第三方出处写在文末的「许可与致谢」里。
- **★ 宿主在启动时固化插件代码清单** ⇒ 改完**必须重启宿主**界面才变；
  刷新页面没用。验证宿主半侧：请求插件自己的路由，200 = 活着，404 = 没挂上。
- **★ 客户端半侧要真浏览器点一遍**（隔离宿主 + Playwright），光看断言不算。
  隔离宿主 profile 里的插件目录是**指向源码的符号链接** ⇒ **永远不要在 `~/.dsh-iso/`、
  `~/.dsh/` 下 rm/cp**，改源码目录即可。
- **★ 素材库是用户的数据**（`~/.dsh/dsh-appearance-media/media/`）：只读。
  测试一律在 `mkdtemp` 出来的临时目录里做。
- **★ 片头与屏保会互相让位**：屏保开着时片头不播，反之亦然。
  测一个必须关另一个，否则验的是另一个对象。
- **★ 面板要透、弹窗不能透**：宿主那套 `--dsw-*` token 本来就是半透明的（壁纸要透出来）。
  弹窗底板必须加 `backdrop-filter` 模糊，否则背后的卡片文字会透上来。

## 加东西时

- **加界面选项**：`lib/store.js` 的 `OPTION_SHAPE` 定义形状，`normalizeConfig` +
  `validateOption` 做校验（枚举值不合法 ⇒ 400，**人话**）；
  `src/client.js` 是卡片，`lib/client.js` 是它的构建产物（**改完要重建**）。
- **加路由**：新文件放 `lib/routes/`，在 `index.js` 注册；
  **★ 宿主的一个路径只能有一条路由**（重复注册会抛）⇒ 字节与删除要合在一条 prefix 路由里。
- **★ 删东西要想清楚顺序**：不可逆的那一步放最后，中间的失败要能整体回滚。
  （`lib/catalog.js` 的 `deleteMaterial`：先改名移开 → 清槽位 → 改账本 → 最后 unlink。）

## 素材

- 插件**不带素材**，素材来自用户上传 / `方案与工具/import-media-sources.py` 导入。
- **Wallpaper Engine 的壁纸分五种**：视频（能导）、3D 场景（**导不了**，实时渲染）、
  网页（**导不了**，要跑 JS）、图片、应用（**导不了**）。
- 导入只加不删；每次导入写一条出处记录（`~/.dsh/dsh-appearance-media/sources.jsonl`）。

## 发布

- 包名 `dsh-appearance-media`；**★ 目前还没发到 npm**（registry 404）⇒ 装它要用
  `github:harveyzhang/dsh-appearance-media` 这个源。
- **市场里还没有它** ⇒ 要先往官方列表仓库提一个 PR（加一个
  `data/plugins/harveyzhang__dsh-appearance-media.yml`）；**那不是实时搜 npm**。
- `npm publish` 之前必须 `npm publish --dry-run --access public` 跑通，
  且 `node tools/verify-package.mjs` 全绿（它核对 tarball 里该有的都在、不该有的不在）。
