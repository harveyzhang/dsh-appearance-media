# dsh-appearance-media

**给 DSH 换一身好看的外壳：背景、开机片头、屏保，三样都在一张卡片里管，共用同一份素材库。**

<div align="center">
  <img src="icon.svg" width="96" alt="外观媒体" />
</div>

> **English summary**
>
> One plugin for the three "outside" surfaces of DeepSeek Harness: the window
> background, the intro clip you see when the app opens, and the screensaver
> that takes over when you walk away. All three read from one shared media
> library, so a clip you like only has to be added once.
>
> Three ways in: let the agent inside DSH install it (fastest), use the plugin
> market once the plugin has been listed there, or drop the package into a
> profile by hand. The package ships no media of its own — you bring the
> videos and images, and the plugin takes care of the rest.

---

## 它能做什么

装上之后，DSH 的「插件」页面里会多出一张叫 **外观媒体** 的卡片。点开这张卡片，
里面的东西分三块，每块管一件不同的事。

### 背景

一段视频铺在窗口最底下，界面浮在上面。

| 选项 | 说明 |
| --- | --- |
| 面板不透明度（越小越透） | 界面面板有多透明：0.3 最透，1 完全不透明 |
| 背景蒙版（越大越白） | 蒙版压多白：0 是原图，1 是全白 |
| 静音 | 背景视频不出声 |
| 窗口隐藏时暂停 | 窗口不在前台时把背景停下来 |

### 片头

打开 DSH 时先放一小段片子，然后淡进界面。

| 选项 | 说明 |
| --- | --- |
| 淡入时长 | 片子放完之后，界面淡进来要多久（1 秒 ~ 4 秒） |
| 停留时长 | 片子放完后再停一会儿，才开始淡入（5 秒 ~ 20 秒） |
| 播放声音 | 开＝片头有声音，关＝全程静音 |
| 进入方式 | **片尾交叉溶解** / **放完再淡** / **点击才进** |
| 素材来源 | **指定片段**（固定放你选中的那段）/ **从素材库随机**（每次从库里挑） |

外加一个 **片头素材池**：可以勾选好几条素材，片头只从你勾里的那些里挑。
**一条都不勾＝整个素材库随机。**

### 屏保

鼠标键盘都不动一段时间之后，屏保接管整个窗口，动一下或按任意键就走。

| 选项 | 说明 |
| --- | --- |
| 闲置后出现 | 多久没动之后屏保接管（1 / 3 / 5 / 10 分钟） |
| 随机切换 | 每隔多久换一段素材（15 秒 ~ 5 分钟，也可以「不轮换」） |
| 音量 / 静音 | 屏保素材的声音大小 |
| 退出时播放特效 | 退出屏保时播一段碎裂动画 |
| 退场方式 | **粒子消散** / **重力下坠** / **Glitch** |
| 鼠标划过时的特效 | 鼠标在屏保上移动时给点反馈 |
| 鼠标特效 | **水波涟漪** / **星屑吸附** |
| 显示「点击或按住任意键继续」提示 | 在屏保上告诉用户怎么退出 |

> 「退场方式」和「鼠标特效」这两项只有对应的开关打开时才会出现——
> 一个摆在那儿却不起作用的选项，比没有这个选项更糟。

---

## 平台支持

| 功能 | 浏览器（web） | macOS 桌面端 | Windows 桌面端 |
| --- | --- | --- | --- |
| 聊天背景（动态壁纸） | ✅ | ✅ | ✅ |
| 开机片头 | ✅ | ✅ | ✅ |
| 素材库：上传 / 删除 / 批量导入 | ✅ | ✅ | ✅ |
| 插件页里的设置卡片 | ✅ | ✅ | ✅ |
| 设置页左栏里的入口 | ❌ web 版没有设置页 | ✅ | ✅ |
| 屏保 · 窗口失焦时接管 | ✅ | ✅ | ✅ |
| 屏保 · 整机闲置时接管 | ✅ | ✅ | ❌ |

**★ 唯一的一处差别在屏保的「整机闲置」那一条：**
整机闲置要问操作系统"这台机器多久没人碰了"。macOS 上我们读 `ioreg` 的 `HIDIdleTime`；
**Windows 上没有对应实现**，那一半会如实回答"不可用"，于是**只剩失焦触发**。
（上游 `dsh-boot-animation` 的闲置探针是 Windows-only 的，我们换成了 macOS 那一版；
两边合起来才完整——这一点记在 [`docs/DETAIL.md`](docs/DETAIL.md) 的限制一节里。）

**★ 其余部分与操作系统无关**：背景、片头、素材库、卡片、路由全都是浏览器技术与 Node，
在 Windows 上开箱可用。唯一与平台有关的代码是那一条 `ioreg` 调用。

---

## 路由的访问检查

本插件在宿主上注册了 8 条 HTTP 路由（读清单、读配置、传素材、改槽位、删素材…）。
**★ 每一条都先过宿主的访问检查**（`connection.requestRejection`）才轮到自己���逻辑 ——
宿主的这道检查包含 **Host/Origin 校验** 与 **浏览器认证**。

**为什么必须有它**：宿主上的路由对**任何能发 HTTP 请求的东西**都应答。
没有这道检查的话，用户浏览器里**随便一个别的页面**（另一个标签页、随手点开的一个网页）
就能调这些路由 —— 传素材、改配置、甚至删素材。

**实际表现**：

| 请求 | 结果 |
| --- | --- |
| 来自 DSH 自己的界面 | ✅ 正常 |
| 来自别的网站（伪造 Origin） | **403 forbidden** |
| 没有凭据（脚本、curl） | **401 unauthorized** |

**★ 这道检查是宿主提供的，我们只是照着它的用法接上**（与宿主自己的路由同一种写法），
并且加了断言盯着：每条注册的路由都必须拒绝被拒的请求，而且**被拒时绝不能碰到自己的逻辑**。

---

## 安装

三条路，按「普通人能走通的程度」排：**A 最快，B 一键，C 是给前两条都走不通的人留的后备办法。**

### 路径 A：让 DSH 里的 agent 装（最快）

这个仓库自带一个 skill，正文在 [`skills/dsh-appearance-media-install/SKILL.md`](skills/dsh-appearance-media-install/SKILL.md)，
专门讲怎么装这个插件、怎么验收、素材从哪来、坏了怎么查。

**第一步：把 skill 放进 DSH 的技能目录**（在仓库根目录执行）：

```bash
mkdir -p ~/.dsh/skills/dsh-appearance-media-install
cp skills/dsh-appearance-media-install/SKILL.md ~/.dsh/skills/dsh-appearance-media-install/SKILL.md
```

> ★ **放 `~/.dsh/skills/`，不要放 `~/.agents/skills/`。**
> `~/.agents/skills/` 是好几个 agent 共用的目录（Claude Code / Codex / Cursor 等都会去扫），
> 塞进去会影响到那些工具；`~/.dsh/skills/` 只有 DSH 读。

**第二步：在 DSH 里说一句话**：

> 帮我装一下外观媒体插件

agent 会照 skill 里的步骤装。

> ★ **装哪个源**：本插件**还没发到 npm**，所以给 agent 的安装规格是
> `github:harveyzhang/dsh-appearance-media`（走 GitHub 源，不是 npm 包名）。
> 将来发到 npm 之后，换成包名 `dsh-appearance-media` 即可。

**skill 里具体写了什么**（这是它正文里的原话要点，不是猜的）：

- **装**：首选宿主自己的工具 `plugin_manager(action="install_bundle", target=…)`；
  skill 里明确写着「不要用 shell 去复刻这一步」（宿主文档也是这么要求的）。
  装完**必须重启宿主**——插件的代码清单在 DSH 启动时就固定了，刷新页面没用。
- **桌面版的坑**：`dsh plugin --profile desktop add …` 走不通，会撞
  `error: profile "desktop" is managed exclusively by the Electron application`；
  `plugin_manager` 走的是宿主自己的通道，不受这条限制。
- **手动落地三步**（最后手段，见下面的路径 C）。
- **验收清单**（不是「命令没报错」就算装好了）：卡片在不在、
  `GET /appearance-media/catalog.json` 是不是 200、素材库里有几条、客户端那半边在不在。
- **素材从哪来**（上传 / 批量导入 / 导入 WE）和一张常见故障排查表。

### 路径 B：插件市场（一键装）

> ★ **它已经被收录进官方精选列表了。**
> 收录 PR [`awesome-dsh-plugin#17485`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/17485)
> 已于 2026-11-22 合并，索引重建完成后就能在市场里搜到 `dsh-appearance-media`。
> **★ 索引重建要一点时间（合并之后由官方仓库的 CI 自动跑）** ——
> 若一时没出来，过一会儿再试，或先走路径 A。

装法是四步，全程鼠标：

1. 打开 DSH 的 **插件** 页面。
2. 切到 **插件市场** 标签页（老版本 DSH 在 **设置 → 插件市场**）。
3. 在搜索框里搜 **`dsh-appearance-media`**，
   找到名为 **外观媒体** 的那一项，点 **安装**。
4. **完全退出 DSH 再重新打开**（桌面端请从菜单里退出，不是关窗口）。

装完之后，在「插件」页面找到 **外观媒体** 这张卡片，点进去就能设背景、片头和屏保。

> **为什么要重启？**
> DSH 在启动的时候一次性决定要加载哪些插件。这次安装改变了「要加载哪些」，
> 所以必须重启一次才会生效。刷新页面不管用。

#### 它凭什么会出现在市场里？

市场的索引**不是实时搜 npm**。可视化插件市场（`dshmarket`）读的是一份固定的索引文件：

```
https://awesome-dsh-plugin.com/plugins.json
```

这份索引由官方精选列表仓库
[`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
**自动生成**：每个插件一个 `data/plugins/<owner>__<repo>.yml`，仓库里的
仓库里的索引生成脚本（build-index / publish-catalog）把它们编译成索引，
`.github/workflows/build-site.yml` 在合并之后自动跑。

所以让本插件出现在市场里，要做的是**给那个仓库提一个 PR、加一个 yml 文件**
（一个文件就是全部投稿；合并后两份 README 由脚本自动重新生成，不用手工改）。
收录有几道门槛，CI 自动查：

| 门槛 | 本插件现在的情况 |
| --- | --- |
| `package.json` 声明 `dsh.bundle`（只声明 `dsh.client` 不算） | ✅ 已声明（`dsh.bundle.patch` 指向 `cordis.patch.yml`） |
| 仓库建满 1 天 | ✅ 已过（本仓库建于 2026-11-20 UTC+8，满 1 天是 2026-11-21 23:50 UTC+8） |
| 仓库打 `dsh-plugin` topic | ✅ 已打 |
| 描述属实、分类合适（维护者人工看） | 待评审 |

投稿文件本仓库已经备好了：`.catalog/harveyzhang__dsh-appearance-media.yml`。

**★ 投稿已经提了**：[`awesome-dsh-plugin/awesome-dsh-plugin#17485`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/17485)，
自动门禁（`dsh.bundle` / 仓库年龄 / topic）**全绿**，现在等维护者人工评审与合并。
合并之后索引会由 CI 自动重建（`build-site.yml`），重建完成就能在市场里搜到本插件。
**★ 合并之后索引由官方仓库的 CI 自动重建**，所以从「合并」到「能搜到」之间有一小段延迟。

#### 点安装时走哪条下载通道？

市场装插件的顺序是：**有 npm 包就走 npm registry，没有就从 GitHub 整仓拉下来装。**
所以**发到 npm 决定的是「装得更顺」，不是「能不能被搜到」**：

- **发了 npm**：装的是预构建产物，**免掉 pnpm 的构建授权**（`allowBuilds`）这一步，最快。
- **没发 npm**：从 GitHub 整仓拉源码自己构建，慢一点，还会多卡一次构建授权。

★ **本插件目前还没发到 npm**（npm registry 上查不到 `dsh-appearance-media`），
所以命令行装法要写 `github:` 源（见路径 C）；将来发到 npm 之后才能简写成包名。

### 路径 C：手动落地（后备）

前两条都走不通时——不能用（也不想）在 DSH 里让 agent 装，市场里还没出现（索引重建有延迟）——
用下面的命令。**这一节是后备办法，不是首选。**

**命令行一行（只对非桌面 profile 有效）**

DSH 自带一个命令行装插件的工具，它把参数原样转给 pnpm：

```bash
dsh plugin --profile web add github:harveyzhang/dsh-appearance-media
```

`web` 换成你实际的 profile 名（`web` / `tui` / `sdk` / `headless` …）。
装完**重启一下 DSH** 即可。

> **为什么写的是 `github:` 而不是包名？**
> `dsh plugin --profile web add dsh-appearance-media` 走的是 npm registry，
> 而本插件**还没发到 npm**（registry 上查不到），所以现在必须写 GitHub 源。
> 将来发到 npm 之后，这一行就能简化成包名。

也可以直接在**目标 profile 的目录**里执行，让包管理器装到那儿去：

```bash
cd ~/.dsh/profiles/web
pnpm add github:harveyzhang/dsh-appearance-media
```

**手动落地三步（把插件目录放进任何一个 profile）**

如果你想把插件手动放进一个 profile（桌面版的 `desktop` profile 尤其需要），按下面三步走。

**第 ① 步：把插件目录放进目标 profile**

```bash
PROFILE=desktop
SRC="/path/to/dsh-appearance-media"     # ← 改成你手上这份插件目录的位置
TARGET="$HOME/.dsh/profiles/$PROFILE/node_modules/dsh-appearance-media"

mkdir -p "$(dirname "$TARGET")"
rm -rf "$TARGET"
cp -R "$SRC" "$TARGET"
rm -rf "$TARGET/.git"                    # 别把版本库一起拷进去
ls "$TARGET"                             # 确认能看到 index.js / lib / src
```

**第 ② 步：把插件挂到这个 profile 上**

在 `~/.dsh/profiles/$PROFILE/package.json` 里，`dsh.profile.bundles`
这个列表中加上 `"dsh-appearance-media"` 这一行（没有这个列表就新建一个）：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-appearance-media"
      ]
    }
  }
}
```

不想手改 JSON 的话，用这一行命令改（同样是改那份 `package.json`）：

```bash
PROFILE=desktop
node -e '
const fs = require("fs");
const path = require("path");
const p = path.join(process.env.HOME, ".dsh/profiles", process.argv[1], "package.json");
let j = { name: "dsh-profile-" + process.argv[1] };
if (fs.existsSync(p)) j = JSON.parse(fs.readFileSync(p, "utf8"));
j.dsh = j.dsh || {};
j.dsh.profile = j.dsh.profile || {};
j.dsh.profile.bundles = j.dsh.profile.bundles || [];
if (!j.dsh.profile.bundles.includes("dsh-appearance-media")) {
  j.dsh.profile.bundles.push("dsh-appearance-media");
}
fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
console.log("bundles now:", j.dsh.profile.bundles.join(", "));
' "$PROFILE"
```

**第 ③ 步：完全退出 DSH，重新打开**

> ★ **做完第 ③ 步之前，界面不会变。**
> 这不是出错了——插件的代码清单是在 DSH 启动时一次性固定的，
> 改完文件不重启，DSH 还在跑旧的那一套。
>
> 桌面端请**完全退出应用**（菜单 → 退出），不是关掉窗口；
> 关窗口在 macOS 上应用还活着，插件不会重新加载。

#### 为什么桌面版不能一句 `dsh plugin add` 搞定？

DSH 自带一个命令行装插件的工具，手写的话本该只要一行：

```bash
dsh plugin --profile web add github:harveyzhang/dsh-appearance-media
```

但**桌面版 DSH 用不了这一行**。桌面版的 profile（`desktop`）由桌面应用自己独占管理，
命令行改不了它，一跑就会撞墙：

```
$ dsh plugin --profile desktop add dsh-appearance-media
error: profile "desktop" is managed exclusively by the Electron application
```

所以桌面版只能走**路径 A**（让 agent 装）、**路径 B**（市场），
或者**上面那套手动三步**。
**其它 profile（`web`、`tui`、`sdk` 这些）没有这个限制**，那一行命令可以直接用。

> 这不是 DSH 的毛病，是桌面应用的自我保护：它自己管着那个 profile，
> 不许别人从外面改，改一半崩了没人收拾。

> **首次使用前还有一步**：插件**不带任何素材**（这是所有 DSH 插件的常态，
> 官方目录里绝大多数插件都不打包素材）。请先看下一节「素材从哪来」，
> 放一条视频进去，否则三个表面都会是空的。

---

## 素材从哪来

**这个插件本身不带任何素材**——一个视频文件都不带，`assets/` 目录是空的，
这是有意为之：素材的版权通常属于作者或你本人，不该由一个插件包替你分发。
DSH 官方插件目录里的插件也基本都不打包素材。

你有两个地方可以放素材：

### ① 插件页面里上传（最简单）

打开 **外观媒体** 卡片，下方就是 **素材库**。

- 点「导入一个视频或图片」上传（单个 ≤ 96 MiB）。
- 支持 **mp4 / webm / ogv** 和 **jpg / png / webp**。
- 每条素材后面有三个按钮：**优化** / **删除** / **预览**。
- 删除有二次确认；删掉一条正在被用的素材时，那个位置会被清空，不会留一个坏引用。

### ② 批量导入工具（素材多的时候用）

配套的导入脚本在 **DSH 插件开发工作区**里（不在插件包里），一次能扫一整个目录：

```bash
# 导入任意目录里的视频和图片
python3 scripts/import-media-sources.py dir ~/Movies --apply

# 导入 Wallpaper Engine 的视频壁纸
python3 scripts/import-media-sources.py we /path/to/steamapps --apply
```

> 上面命令里的路径相对 **DSH 插件开发工作区的根目录**。

**默认是演练**（只报告、不写任何文件），**加 `--apply` 才真导入**。
它只加不删，每次导入都会写一条出处记录（来源、许可、地址、SHA-256），
追加在 `~/.dsh/dsh-appearance-media/sources.jsonl` 里。

### 怎么加更多素材

三条路，从简到繁：

1. **在插件页面里上传** —— 卡片里的「素材库」下方，「导入一个视频或图片（≤ 96 MiB）」，单个文件传上去。
2. **批量导入一个目录** —— 一条命令扫一个目录（见上面的 ②）：
   ```bash
   python3 scripts/import-media-sources.py dir <目录>
   ```
   **默认只演练**，加 `--apply` 才真导入。
3. **导入 Wallpaper Engine 的视频壁纸** ——
   ```bash
   python3 scripts/import-media-sources.py we <WE 安装目录>
   ```

**怎么加一个新的在线素材源**：编辑 `scripts/media-sources.json` 这个来源清单——
每条源写着名称、URL 模板、许可说明。**在线抓取默认是关的**
（清单里 `enabled` 默认是 `false`，要抓得用 `--source <名字>` 点名才生效）；
清单里只留**许可说得清**的源，许可混杂的源不要往里加。

想先看看清单里现在有什么（不联网）：

```bash
python3 scripts/import-media-sources.py fetch --list
```

#### 关于 Wallpaper Engine

Wallpaper Engine 的壁纸分五种，**只有视频能导入**：

| 壁纸类型 | 能导入吗 | 为什么 |
| --- | --- | --- |
| **视频** | ✅ 能 | 它就是一个普通的视频文件，直接搬过来就行 |
| **3D 场景** | ❌ 不能 | 它是实时渲染出来的场景（一堆模型、材质、相机、脚本），存成文件的是零件，不是成品 |
| **网页** | ❌ 不能 | 它是要跑 JavaScript 的网页，得靠渲染引擎才有画面 |
| **图片** | ⚠️ 默认不导 | 是一张图，导入价值不大；想导可以加 `--include-images` |
| **应用** | ❌ 不能 | 是一个可运行的程序，不是素材 |

一句话：**能变成「一个文件」的那种才能当素材。**
3D 场景和网页壁纸是「实时算出来的」，一帧不是一个文件，所以导不进来——
这是它们的性质决定的，不是工具偷懒。

### 素材优化（faststart）是什么，为什么值得点一下

素材库里的每条素材后面都有一个 **优化** 按钮。它做的是一件很具体的事：

**把视频文件里「索引信息」的那一段，从文件末尾搬到文件开头。**

为什么这重要：视频文件一般分成两段——开头一小段「索引」（告诉你这一秒的画面在文件哪个位置），
后面是真正的画面数据。如果索引在末尾，播放器必须先把整个文件下载完，才知道第一帧在哪，
于是**打开界面白屏卡半天**。把索引挪到开头，播放器下几 KB 就能开画。

这个操作**不重新编码、不损失画质、不改画面**，只是换一下文件内部的排列顺序。

> 一句话：**优化过的素材，开起来明显更快，画面完全一样。**
> 素材多的时候值得在导入后统一点一遍。

---

## 开发

### 重建客户端产物

浏览端的代码分两份：`src/client.js`（可读的源文件）和 `lib/client.js`
（包在宿主模块加载器外壳里的构建产物，**真正被加载的是它**）。

```bash
node build-client.mjs
```

改完 `src/client.js` **必须**跑这一条，否则界面跑的还是旧代码。
脚本会在写完后自动做语法检查，写坏了当场报错。

### 跑断言

仓库里有 **17 套**离线断言，每套一个命令。**全绿才算完成。**

```bash
node tools/verify-access.mjs
node tools/verify-background.mjs
node tools/verify-boot-screen.mjs
node tools/verify-catalog.mjs
node tools/verify-client-ui.mjs
node tools/verify-deployed.mjs
node tools/verify-docs.mjs
node tools/verify-handover.mjs
node tools/verify-media-delete.mjs
node tools/verify-package.mjs
node tools/verify-platform.mjs
node tools/verify-release.mjs
node tools/verify-remux.mjs
node tools/verify-renderers.mjs
node tools/verify-routes.mjs
node tools/verify-screensaver.mjs
node tools/verify-slots.mjs
```

其中两套是"总闸门"，日常就用它们收尾：

```bash
node tools/verify-release.mjs          # 十几秒：把上面各套当子进程跑一遍，再打包、装进临时目录、导入插件，
                                       #          并检查测试期间有没有人在并发改文件
node tools/verify-release.mjs --full   # 再加"陌生人验收"：克隆到临时目录重跑一遍
```

★ `verify-docs.mjs` 专门核对**文档里的每一句事实**（路径在不在、命令能不能跑、
**发布状态、收录状态这类"关于现在"的说法**与 registry / 官方目录对不对得上）；
`verify-package.mjs` 专门核对**发布包**（该有的文件在不在、不该有的在不在）。
两条都各有反向对照。

想一次跑完：

```bash
for f in tools/verify-*.mjs; do
  printf '%-34s ' "$(basename "$f")"
  node "$f" 2>&1 | grep -E 'check\(s\)' | tail -1
done
```

另外两套断言带有**反向对照**开关，专门验证「断言真的会红」：

```bash
node tools/verify-client-ui.mjs --negative
node tools/verify-media-delete.mjs --negative
```

还有一条针对**真实文件**的反向对照（会把源文件改坏再改回来，
改动前后按字节校验 SHA-256）：

```bash
node tools/negative-controls-task7.mjs
```

### ★ 每条断言都必须能变红

这是本项目的一条硬规矩：

> **把实现改坏，断言必须变红。不能失败的检查不算检查。**

一条永远绿的断言，什么都没有验证——它只是恰好没出错而已。
所以每套断言里都配了**反向对照**：拿一份**副本**故意改坏（把顺序调换、
把某段代码删掉、把一个开关改成反的），用**同一个探针**跑一遍，
要求「改坏前的结论」和「改坏后的结论」**不一样**。
改坏了却还是绿的，说明这条断言是假的，当场就红给你看。

反向对照只在**副本**上跑，不碰仓库里的真文件。

> 打包前的清单检查也是同一个道理：
> `node tools/verify-package.mjs` 会把「该在包里的文件」和「不该在包里的文件」
> 都断言一遍，同样带反向对照——把副本改坏，检查必须变红。

### 离线断言之外

断言全绿只是及格线。真东西还得用眼睛看：

1. **隔离宿主 + Playwright**——真浏览器里点、真截图。
2. **真机（桌面版）**——截图 + 人的眼睛。

---

## 许可与致谢

本项目采用 **MIT** 许可，见 [`LICENSE`](LICENSE)。

本项目的**片头**和**屏保**两部分，以及**视频优化器**（把索引搬到文件开头的那段代码），
来自开源项目 **[dsh-boot-animation](https://github.com/lxj5820/dsh-boot-animation)**，
原作者 **lxj5820**，同样采用 MIT 许可。原项目的版权声明一字未改地保留在
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) 里，以及被搬过来的那两个源文件的文件头。

> 原项目自带的视频素材**不属于** MIT 许可，**没有**被包含进来、
> **没有**被重新分发、也没有被打包进这个插件。想要那些素材的话，
> 请你自行导入到你自己的素材库里使用。

在这个基础上，我们多做了这些：

- **片头素材池多选**——勾好几条，片头只从里面挑（原来只能选一条）。
- **退场特效与鼠标特效**——粒子消散 / 重力下坠 / Glitch，以及水波涟漪 / 星屑吸附。
- **统一的素材库**——背景、片头、屏保三个表面共用一份素材，一条素材不用录三遍。
- **素材优化器**——一键把视频的索引挪到文件开头，打开快很多。
- **新的卡片界面**——按「背景 / 片头 / 屏保」三块重新排的卡片，选项都说人话。

另外两位项目也在本项目的开发过程中作为参考读过，它们的作者与许可同样记在
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) 里：
[dsh-video-skin](https://github.com/Something11235/dsh-video-skin)（作者 Something11235，MIT）、
[dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine)（作者 elysia395，MIT，npm 包名 `dsh-plugin-wallpaper-engine`）。

DeepSeek Harness、DSH 与 Cordis 是各自所有者的商标。本插件是独立项目，与它们无关，也没有得到它们的背书。
