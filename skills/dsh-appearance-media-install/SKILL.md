---
name: dsh-appearance-media-install
description: 在 DSH 里安装、配置并验收「外观媒体」插件（背景 / 开机片头 / 屏保三合一，一份素材库、一张卡片）。当用户要装这个插件、换背景/片头/屏保的素材、往素材库里批量导入素材、或排查"插件没生效/卡片不见了"时使用。
---

# 安装与配置「外观媒体」插件

这个插件把三样东西收在一处管：**窗口背景**、**开机片头**、**屏保**，
共用一份素材库，全部设置在一张卡片上（插件页 → 内置插件配置 → 外观媒体）。

## 什么时候用

- 用户要装这个插件（"帮我装一下外观媒体插件"、"把背景插件装上"）
- 用户要换素材：换背景视频、换片头、换屏保、往素材库里加东西
- 用户说"卡片不见了 / 改了没反应 / 背景没出来"

## 装（按这个顺序试，成功了就停）

### ① 首选：用宿主自己的工具

DSH 宿主提供了装插件的正规工具 **`plugin_manager`**：

- `plugin_manager(action="install_bundle", target="<包名或安装规格>")`
  —— 装包并把插件挂到当前 profile 上。**不要用 shell 去复刻这一步**（官方文档明确要求）。
- `plugin_manager(action="list_bundles")` / `list_plugins` —— 先看清楚当前 profile 里已经有什么、叫什么。
- `plugin_manager(action="set_bundle", target="<id>", enabled=false/true)` —— 启用或停用。

**包名**：`dsh-appearance-media`（已发布到 npm；也可以从 GitHub 装：`github:harveyzhang/dsh-appearance-media`）。

**装完必须重启宿主**（或者按工具返回的 `restart-required` 提示做）——
插件的代码清单是在 DSH 启动时一次性固定的，**不重启就看不到变化**，刷新页面没用。

### ② 桌面版 profile 的坑（★ 会撞墙，先知道免得白试）

桌面应用独占管理自己的 profile，**命令行改不了它**，会直接报：

```
error: profile "desktop" is managed exclusively by the Electron application
```

所以在桌面版上：

- `dsh plugin --profile desktop add …` 这条路**走不通**，别试；
- 用上面的 `plugin_manager`（宿主工具走的是宿主自己的通道，不受这条限制）；
- 实在不行再走手动落地（下节）。

### ③ 手动落地（最后手段）

桌面 profile 由桌面应用独占、不能被 CLI 改时，才需要手动落地三步：

```bash
# ① 把插件目录放进目标 profile
PROFILE="$HOME/.dsh/profiles/desktop"
cp -R /path/to/dsh-appearance-media "$PROFILE/node_modules/dsh-appearance-media"

# ② 把插件挂到这个 profile 上（等价于在 package.json 的 dsh.profile.bundles 里加一行）
node -e '
const fs=require("fs"), p=process.env.HOME+"/.dsh/profiles/desktop/package.json";
const d=JSON.parse(fs.readFileSync(p,"utf8"));
const b=d.dsh.profile.bundles;
if(!b.includes("dsh-appearance-media")){b.push("dsh-appearance-media");
fs.writeFileSync(p, JSON.stringify(d,null,2)+"\n"); console.log("bundles:",b.join(", "));}
else console.log("already there");'

# ③ 重启宿主（不改这一步，界面不会变）
```

**★ 做完第 ③ 步之前界面不会变**，这是预期行为，不是装失败。

## 装完怎么验收（★ 别只看"命令没报错"）

1. **卡片在不在**：插件页 → 内置插件配置 → 有没有「外观媒体」这一张卡。
2. **宿主半侧活着没**：请求 `GET /appearance-media/catalog.json` 返回 **200**；
   返回 **404** 说明这个插件根本没挂上（先查 profile 的 `dsh.profile.bundles` 里有没有它，再查依赖）。
3. **素材库有几条**：`catalog.json` 里的 `entries` 数量。**新装的是 0 条**（插件不带素材）——
   这不是坏了，是设计如此：素材由用户自己提供。
4. **客户端半侧**：卡上三个表面（背景 / 片头 / 屏保）都在，滑杆能拖、素材选择器能打开。

## 素材从哪来

**插件本身不带素材**，三条路：

1. **界面上传**：卡片里点素材 → 上传（支持 mp4 / webm / ogv / jpg / jpeg / png / webp）。
2. **批量导入一个目录**：
   ```bash
   python3 <仓库>/DSH插件开发/方案与工具/import-media-sources.py dir <目录>          # 演练
   python3 <仓库>/DSH插件开发/方案与工具/import-media-sources.py dir <目录> --apply  # 真导入
   ```
   只加不删；内容相同的不会重复导入；**faststart 优化过的同一段片子会被认成"优化版"而不是新素材**。
3. **导入 Wallpaper Engine 的视频壁纸**：
   ```bash
   python3 <仓库>/DSH插件开发/方案与工具/import-media-sources.py we <WE 安装目录>
   ```
   ★ **Wallpaper Engine 的壁纸分五种**：视频（能导）、3D 场景（**导不了**，实时渲染）、
   网页（**导不了**，要跑 JS）、图片、应用（**导不了**）。
   场景和网页要靠 Wallpaper Engine 插件自己的 WebGL 引擎，不是文件。

**每次导入都会写一条出处记录**：`~/.dsh/dsh-appearance-media/sources.jsonl`
（来源、许可、URL、SHA-256）——加新素材前先看它，能知道库里每条是哪来的。

## 排查

| 现象 | 多半是 |
|---|---|
| 卡片不见了 | profile 的 `dsh.profile.bundles` 里没有这一行 ⇒ 没挂上；加回 + 重启 |
| 改了没反应 | 没重启宿主（代码清单在启动时固定） |
| 路由全 404 | 同上：插件没挂载 |
| 素材列表是空的 | 正常：新装没素材 |
| 背景不显示 | 背景槽位没开，或面板不透明度调成 0（面板全透明 ⇒ 界面看起来"全透"） |
| 片头不播 | 片头与屏保**互相让位**：屏保开着时片头不播，反之亦然。测一个要关另一个 |

**★ 改素材库里正在用的那条**：删除时会**自动清空指向它的槽位**（不会留悬挂引用），
界面会显示"未选择"，重新选一条即可。

## 素材优化（可选）

视频文件里有一段"索引"信息，放在文件末尾时浏览器要先下完整个文件才能出第一帧；
把这个优化器跑一下（卡片里素材那一行的「优化」按钮），把索引挪到文件头，**不损画质**：

```bash
curl -X POST http://127.0.0.1:<端口>/appearance-media/optimize \
  -H 'content-type: application/json' -d '{"mediaId":"<素材 id>"}'
```

★ 只有 mp4 能优化；不是 mp4 会被原样拒绝（不会动你的文件）。
