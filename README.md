# dsh-appearance-media

> DSH 的**外观媒体**插件：把**背景**、**开机片头**、**屏保**三类外观收在一个地方管。
> 一个插件、一张卡片、一份素材库、一套配置。
>
> 代码从 [dsh-boot-animation](https://github.com/lxj5820/dsh-boot-animation)（MIT，原作者 `lxj5820`）移植而来，
> 版权声明保留在 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) 与 `lib/remux.js` 的文件头。

## 三个表面

| 表面 | 做什么 | 关键选项 |
|---|---|---|
| **背景** | 一段视频铺在 app 窗口最底层，UI 浮在上面 | 面板不透明度、背景蒙版、静音、窗口隐藏时暂停 |
| **片头** | 打开 app 时先放一段短片，再淡进界面 | **进入方式**（片尾交叉溶解／放完再淡／点击才进）、**素材来源**（指定／从库随机）、**片头素材池**（多选，不选＝整个库随机）、淡入时长、点鼠标直接进、底部提示文字 |
| **屏保** | 机器空闲一段时间后接管屏幕，动一下或按任意键就走 | 闲置时长、**退场方式**（粒子消散／重力下坠／Glitch）、**鼠标特效**（水波涟漪／星屑吸附）、每 N 秒换素材、提示文字 |

**一份素材库**：视频与图片统一放在 `~/.dsh/dsh-appearance-media/media/`（数据目录可配），
三个表面共用；每条素材有预览。

## 素材库

- 目录：`~/.dsh/dsh-appearance-media/media/`（数据目录可配）
- 支持 **mp4 / webm / ogv / jpg / jpeg / png / webp**（视频与图片都算素材）
- **删除**：`DELETE /appearance-media/media/<id>`（选中被引用的素材时**清空那个槽位**，不留悬挂）
  ⇒ 界面上：素材选择器里每条后面有「优化 / 删除 / 预览」，删除有二次确认。
  ⇒ 旧地址 `POST /appearance-media/remove` 已退役（410，指向上面这条）。
- **优化**：`POST /appearance-media/optimize` —— 无损把 `moov` 挪到文件头（faststart），
  浏览器不用下完整个文件就能出第一帧。

## 从外面搬素材

```bash
cd DSH插件开发/方案与工具
python3 import-media-sources.py we   <WE根目录>   # Wallpaper Engine 的视频壁纸
python3 import-media-sources.py dir <目录>        # 任意目录里的视频/图片
python3 import-media-sources.py fetch --source X # 在线来源（清单默认只留许可明确的，默认关）
python3 sync-upstream-media.py --apply           # P05/P06 的素材（认 faststart 优化版）
```

**默认是演练，`--apply` 才真写；只加不删；每次导入都写一条出处记录**
（`~/.dsh/dsh-appearance-media/sources.jsonl`：来源、许可、URL、SHA-256）。
来源与许可见 [`03-素材来源清单.md`](../../方案与工具/03-素材来源清单.md)。

## 开发

```bash
node build-client.mjs                 # ★ 改完 src/client.js 必须重建 lib/client.js（它是构建产物）
for f in tools/verify-*.mjs; do        # ★ 十套离线断言，全绿才算完成
  printf '%-28s ' "$(basename $f)"; timeout 240 node "$f" 2>&1 | grep -E 'check\(s\)' | tail -1
done
```

**★ 本项目的硬纪律：每条断言都必须能变红。**
`tools/verify-client-ui.mjs --negative` 会把实现改坏再跑一遍，要求对应断言必须失败；
**不能失败的检查不算检查。**

**离线断言之外，还要过两关**：
1. **隔离宿主 + Playwright**（`~/.dsh-iso` 的 appearance-test profile）——真浏览器里点、真截图；
2. **真机（Electron）**——截图 + 用户的眼睛。

## 跟上游（P05）的关系

我们从 P05 移植了片头与屏保的实现，并**多**了这些：
片头素材池多选、退场特效样式、鼠标特效样式、统一素材库、素材优化器（`lib/remux.js`）、新的卡片 UI。

**⇒ 上游更新只能"挑着移植"，不能整包覆盖。** 流程见
`DSH插件开发/方案与工具/02-上游同步流程.md`：

```bash
zsh DSH插件开发/方案与工具/check-upstream.sh --fetch   # 看上游比我们新了什么
python3 DSH插件开发/方案与工具/sync-upstream-media.py --apply   # 素材同步（认 faststart 优化版）
```

本仓库已配置 `upstream` 远程（只读参考）：

```bash
git fetch upstream
git log --oneline HEAD..upstream/main     # 上游比我们新了什么（待挑）
git log --oneline upstream/main..HEAD     # 我们比上游多了什么
```

## 安装（本机）

desktop profile 是 Electron 独占的，CLI 改不了 ⇒ 手动落地：

1. 把本目录的文件复制到 `~/.dsh/profiles/desktop/node_modules/dsh-appearance-media/`；
2. profile 的 `package.json` 里 `dsh.profile.bundles` 要有 `dsh-appearance-media` 这一行；
3. **重启宿主**（bundle 栈在挂载时固化，改完不重启看不到变化）。

## 踩过的坑（写下来免得再踩）

- **★ 隔离宿主 profile 里的插件目录是指向本仓库的符号链接** ⇒ 永远不要在 `~/.dsh-iso/`、`~/.dsh/` 下 rm/cp；改本仓库即可。
- **宿主挂载时固化代码** ⇒ 改了 `lib/store.js` 也要**重启宿主**，刷新页面没用。
- **两个表面会互相让位** ⇒ 屏保开着时片头根本不播；做单表面测试要把另一个关掉。
- **不要让 CSS 自定义属性引用它自己** ⇒ 变量失效 ⇒ 白色面板全透明 ⇒ 整个界面全透（出过两次）。
- **原生 `<input type="range">` 很廉价** ⇒ 滑杆是自绘的。
- **改源文件会断硬链接**（历史遗留说法；现在是符号链接，改仓库即可）。
