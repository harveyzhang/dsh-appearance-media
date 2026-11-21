# 外观媒体（Appearance media）

DSH 插件 `dsh-appearance-media`，当前版本 **0.1.0**。

这个版本做四件事：声明一份可被设置页编辑的配置、提供五组 HTTP 路由（素材清单、
健康探针、导入/删除、媒体字节、槽位配置）、在页面 `<head>` 注入**四行**脚本（状态信号、
素材适配器、仲裁点、**聊天背景表面**），并在本包的包页上挂一块**素材库面板**（导入、
列出、删除）。

三个槽位（背景 / 片头 / 屏保）**已经能选素材、能开关、能调参数**了 —— 配置在
`<dataDir>/config.json`，读写走 `GET` / `PUT /appearance-media/slots`。
**仲裁点与素材适配器也已经就位**（注入侧，见下面第 5–7 节），**聊天背景表面也上线了**
（第 8 节）；**片头与屏保还没有**。

## 功能

### 1. 配置（一个字段，可热改）

| 字段 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `dataDir` | string | `''` | 素材库所在目录。空串表示默认目录 `~/.dsh/dsh-appearance-media`；填绝对路径则覆盖它。也可用环境变量 `DSH_APPEARANCE_MEDIA_DATA_DIR` 覆盖（优先级：`dataDir` > `DSH_APPEARANCE_MEDIA_DATA_DIR` > 默认目录）。旧的环境变量名 `DSH_APP_DIR` **已弃用**，仅作兼容回退：仍在读，但不再文档化。 |

这个字段是 **volatile**（`.volatile()`）：改完立即生效，不需要重启 DSH。路由**每次
请求现读**它（不是启动时的快照），所以保存之后下一次
`GET /appearance-media/health` 就会报出新的 `dataDir`。

**这个字段在「插件 → dsh-appearance-media → 它的包页」上编辑。** 宿主把这个包的
配置表单渲染在自己的包页里（`plugins.bundle.config` 槽位，按包名
`dsh-appearance-media` 索引），表单上的写入走宿主的配置队列与配置编辑器，
插件自己从不改 profile 的 patch 文件。插件在「设置 → 外观媒体」里的那块面板是
只读的摘要，不是配置入口。

字段挂在 `cordis.patch.yml` 里 `- insert: id: appearance-media` 这个条目下，条目 id
就是设置命名空间，浏览器那半边用同一个字符串去认领。

> ★ **没有 `catalogRevision` 字段了。** 它曾经是一个 volatile 数字，设置页把它画成
> 一个输入框——**那个框是骗人的**：宿主不会递增任何插件自己的字段，手打一个数字
> 完全不起作用；而且它与账本的 revision 构成两个真相来源。现在唯一的事实来源是
> 素材库的账本（`<dataDir>/media/.meta.json`）：**每次写账本，revision 自增 1**，
> `catalog.json` 每次请求现读它。

### 2. 六组路由

| 路由 | 方法 | 回答 |
|---|---|---|
| `/appearance-media/catalog.json` | GET / HEAD | `{"ok":true,"revision":<账本>,"entries":[…],"skipped":[{"name","reason"}]}` |
| `/appearance-media/health` | GET / HEAD | `{"ok":true,"version":"0.1.0","dataDir":"<解析后的绝对路径>"}` |
| `/appearance-media/upload` | POST | 原始字节体 → `{"ok":true,"entry":{…},"duplicate":false}` |
| `/appearance-media/remove` | POST | JSON `{"id":"…"}` → `{"ok":true,"removed":true}` |
| `/appearance-media/media/<id>` | GET / HEAD | 媒体字节 |
| `/appearance-media/slots` | GET / HEAD / PUT | 槽位配置 → `{"ok":true,"config":{…},"ignored":[…]}` |
| `/appearance-media/system-idle.json` | GET / HEAD | 整机闲置读数 → `{"ok":…,"idleMs":…,"status":"ok｜starting｜unavailable","reason":"…"}` |

- 前两条**只读**，只接受 GET / HEAD，其它方法答 **405**（带 `Allow: GET, HEAD`），
  响应头带 `Cache-Control: no-store`。
- `/appearance-media/upload`：
  - 请求体是**原始字节**，`Content-Type` 取文件自己的 MIME，文件名走
    `X-Dsh-Filename` 头或 `?name=`；**不接受表单**（`multipart/form-data` 与
    `application/json` 都被拒，答 415）。
  - 支持的类型：`video/mp4`、`video/webm`、`video/ogg`、`video/ogv`、`image/jpeg`、
    `image/png`。**MIME 与扩展名必须对得上**，对不上答 **415**。
    ★ **`.ogv` 受支持**（它的 MIME 就是 `video/ogg`；`video/ogv` 这个写法也接受）；
    **`.ogg` 这个扩展名不在首版的正则里** ⇒ `.ogg` 文件答 **415**。
  - 上限 **96 MiB**，超了答 **413** 且不留下 `.part` 残留文件；空体答 **400**；
    文件名里带路径分隔符答 **400**。
  - 落盘顺序：`.upload-<pid>-<ts>.part` → 校验通过 → `rename` 到
    `up-<sha12><ext>`（原子）。**同样的内容只落一个文件**，第二次上传返回
    `duplicate: true`。
    ★ **同一份字节、不同扩展名，按同一个素材处理**（**有意设计**，与 id 方案一致）：
    id 只由 sha256 的前 12 位决定 ⇒ 同一份字节用 `.mp4` 与用 `.webm` 上传会得到
    **同一个 id** ⇒ 第二次答 `duplicate: true`，并**保留第一次的 name 与 ext**
    （库认的是这份字节，不是这次贴上的标签）。这不是 bug。
- `/appearance-media/remove`：id 不存在答 **404**，删成功答
  `{"ok":true,"removed":true}`。
- `/appearance-media/media/<id>`：
  - `Content-Type` 按类型，`Accept-Ranges: bytes`，带 `ETag`（服务端自己的完整性
    标签）；
  - ★ **`Cache-Control` 精确等于 `no-store`，200 与 206 一致**，并且**永远不答
    304**；
  - `Range: bytes=0-99` → 206 + 正确的 `Content-Range`；满足不了的 Range 与
    语法非法的 Range 都答 **416**（带 `Content-Range: bytes */<size>`）；
  - id 不存在、id 逃逸出素材目录、URL 解不开，都答 **404**（解不开的百分号编码
    答 **400**）。

> ★ **为什么媒体字节一律 `no-store`（200 与 206 都是）**
>
> 依据是**换素材会打断请求**这件事，不是"别家也这么做"：背景是一个 `<video>`
> 元素，**替换这个元素会中断正在进行的请求**；中断留下的就是**半截 body**。只要
> 响应允许被缓存，半截 body 就会进缓存；下一次解码拿不到 `moov`（`moov` 在尾部的
> 片子尤其如此）⇒ **画面空白，硬刷新才恢复**。原项目 AGENTS.md 里的原话：
> "anything cacheable stores a truncated body… ETag / no-cache does not fix this"。
>

### 2.1 ★ 整机闲置读数（`/appearance-media/system-idle.json`）

| 项 | 值 |
|---|---|
| 方法 | **GET / HEAD**（其它一律 **405**，带 `Allow: GET, HEAD`） |
| 缓存 | `Cache-Control: no-store` |
| 回答 | `{"ok":<bool>,"idleMs":<number｜null>,"status":"ok｜starting｜unavailable","reason":"<短码>"}` |

★ **只读、便宜、可以轮询**：它没有副作用，答的是几百字节。

★ **`idleMs` 只有 `status === 'ok'` 时才是数字**，其它两种状态下是 `null`。
**失败绝不许被压成 `idleMs: 0`**——`0` 的意思是"**此刻有人在用这台机器**"，压成 0
会让屏保**永远立刻触发**，或者让"有人在用"看起来像"闲置 0 毫秒"。三种状态各有
各的意思，**不许合并**：

| `status` | 意思 | 屏保怎么办 |
|---|---|---|
| `ok` | 读到了 | 与阈值比 |
| `starting` | **还没答**（刚启动、超时） | **不算 idle**，过一会儿再问 |
| `unavailable` | **永远不会有**（不是 macOS、没有 `ioreg`、命令拒绝） | **不算 idle**，退回"失焦"那一半 |

#### ★ 读数是怎么来的（`lib/probe.js`）

```
/usr/sbin/ioreg -n IOHIDSystem -d 4   →   "HIDIdleTime" = <纳秒>   ⇒   /1e6 得毫秒
```

- ★ **每次读都直接 spawn**（约 **3.6 ms**，本机实测 **5 ms**）⇒ **没有常驻子进程**。
  常驻子进程是上游为它**自己**的 Windows 慢探针打的补丁，我们不需要，还会踩
  "宿主重启后探针还活着、占 ~110 MB、parent pid 已经不存在"的坑。
- ★ **不用 `-c` 变体**：`ioreg -c IOHIDSystem` 约 **30 ms / 503 KB** ⇒ 慢 8 倍、
  大 25 倍，换来的还是同一个数。
- ★ **先判平台**：不是 macOS 就**不 spawn**，直接答 `unavailable`。
- ★ **`reason` 的取值**：`ok` / `not-darwin` / `ioreg-missing` / `ioreg-failed` /
  `no-idle-counter`（永久失败）｜ `timeout` / `spawn-error`（暂时失败，答
  `starting`，过一会儿再问）。

> ★ **上游那个探针是 Windows-only 的，我们没有搬。**
> 上游用 **PowerShell + `user32.dll` 的 `GetLastInputInfo`**，在 macOS 上恒为
> `unavailable`（协调者实测过）⇒ 它那套三态是**永远走不到 `ok`** 的一态。
> 我们换成 Darwin 的 `ioreg`，三态才真的分得开。
> 另一个插件（dsh-video-skin）的整片 200 用 `no-cache` + `ETag`，是因为它的背景是**单个固定文件、不会中途
> 换素材**；我们的媒体会被替换，所以不照抄那一套。`ETag` 我们照用（它只做完整性
> 判断），但**不下发缓存许可**。

### 3. 槽位配置（`/appearance-media/slots`）

一份配置，三个槽位，各自选一份素材、各自开关、各自的参数。存在
**`<dataDir>/config.json`** 里。

#### 形状

```json
{
  "ok": true,
  "config": {
    "revision": 3,
    "slots": {
      "background":  { "enabled": false, "mediaId": null, "revision": 0 },
      "boot":        { "enabled": false, "mediaId": null, "revision": 0 },
      "screensaver": { "enabled": false, "mediaId": null, "revision": 0 }
    },
    "options": {
      "background":  { "surface": 0, "muted": true, "pauseWhenHidden": true },
      "boot":        { "muted": true },
      "screensaver": { "idleMs": 300000, "volume": 0, "muted": true }
    }
  },
  "ignored": []
}
```

- `config.revision` —— **整体版本**，"配置变过"。
- `config.slots.<name>.revision` —— **该槽位自己的版本**，"**这一个**表面需要重新
  加载"。
- `ignored` —— **响应顶层**，**永远都在**（没有要报告的东西时是空数组）。里面是
  那些**这一版不认识、因而没有采纳**的键的路径（请求体里的、或者配置文件里已有的）。
  不认识的键**被忽略并回报**，不报错，也不影响别的字段。
- ★ **键名是 `mediaId`，不是 `id`** —— 客户端按 `config.slots.background.mediaId` 读。

#### 两个 revision，两个意思

| | 什么时候 +1 | 谁看它 |
|---|---|---|
| **整体 revision** | **每一次写入** +1（哪怕这一次什么也没改） | 客户端知道"要重新读一遍配置" |
| **每槽位 revision** | **只在该槽位的 `enabled` 或 `mediaId` 变了** +1 | 客户端知道"只有这一个表面要重新 apply" |

⇒ ★ **只改 `options` ⇒ 整体 +1，三个槽位都不动**（表面不用重载，但配置页要刷新）。

#### PUT 的请求体

```jsonc
{ "slot": "background", "enabled": true, "mediaId": "up-7b1ae6039bbf" }
{ "options": { "screensaver": { "idleMs": 600000 } } }
```

- `slot` 说 `enabled` / `mediaId` 属于哪一个槽位；**要改 `enabled` 或 `mediaId`
  就必须先说 `slot`**（少了它 ⇒ 400）。
- `options` 是全局的，按组按字段合并。
- ★ **`mediaId: null` 是合法的** —— 那是"清空这个槽位的选择"，答 200，**不是 400**。
- ★ **`mediaId` 必须在素材库里**：路由用**清单自己的** `resolveById(dataDir, id)` 去查，
  查不到 ⇒ **400**，且**磁盘上的 `config.json` 一个字节都不改**（连 revision 都不动）。
- 越界的 `options` 值 ⇒ **400**，文件同样不动：`surface` / `volume` ∈ [0, 1]，
  `idleMs` ∈ [30000, 3600000]。
- 请求体 > **16 KiB** ⇒ **400**；不是 JSON ⇒ **400**；不是 JSON 对象 ⇒ **400**。
  ★ **超限时请求流是被"排空"的，不是被掐断的** —— 服务端停止累积 chunk、**继续把流读完**，
  然后才答复。**绝不 `req.destroy()`**：那会在答复写出去之前掐断 socket，客户端拿到的是
  "Empty reply from server"（curl 退出码 52）而不是 400。
- 其它方法（POST / DELETE / PATCH …）⇒ **405**，带 `Allow: GET, HEAD, PUT`。

#### 写盘

`<dataDir>/config.json.tmp` → `fsync` → `rename` 到 `config.json`。**直接覆盖写**会在崩
一半时留下半截 JSON，插件就再也读不出配置了。

#### ★ 目录不存在 ⇒ 答默认值，不创建

第一次 `GET /appearance-media/slots` 答 **200 + 全默认**（三个槽位都是关的、
`mediaId` 都是 `null`、revision 是 0），**不是 500**，而且**什么都不创建**。目录要等到
第一次写才被建出来。

#### ★ `Cache-Control: no-store`，精确等于

这条路由回答的是"**现在是什么**"，不是可缓存的静态资源。理由与媒体字节同源（见上面
那段），而且更直接：浏览器如果留着上一次的回答，它留着的恰好是**用户刚改完**的那份
⇒ "立即生效"死掉，而**所有离线断言照样全绿**。

### 4. 素材条目

清单里的每一条：

| 字段 | 含义 |
|---|---|
| `id` | `up-<sha12>`（上传的）或 `fs-<slug>-<mtimeMs>`（手放的），字符集只有 `[0-9a-z-]` |
| `name` | 文件名（不含路径） |
| `kind` | `video` 或 `image` |
| `ext` | `.mp4` / `.png` … |
| `bytes` | 字节数 |
| `contentHash` | `sha256:<64 hex>` |
| `source` | `upload`（上传的）或 `library`（手放的） |
| `license` | `user`（上传的）或 `unknown`（手放的） |
| `addedAt` | epoch 毫秒 |
| `mediaUrl` | `/appearance-media/media/<id>` |

★ **`sourcePath` 绝不下发浏览器**：那是用户家目录的绝对路径。跳过的文件也只报
**basename**（`skipped[].name`），不报路径。

★ **id 就是文件名去掉扩展名**：上传的文件叫 `up-<sha12><ext>`，它的 id 就是
`up-<sha12>`。这样"上传接口返回的 id"与"清单里那一行的 id"必然是同一个字符串，
`GET /media/<id>` 才不会 404。
⇒ 因为 id 只由 sha256 的前 12 位决定，**同一份字节只可能有一个 id**
（见上面 `/appearance-media/upload` 那条）。

★ **清单每次请求重扫目录**，没有索引也没有快照：用户把文件丢进素材目录，下一次
请求就能看见。

### 5. 注入页面的六行

页面索引里注入**六行**内联脚本（`kind:'script'`，不是 `script-src`），顺序固定：

| # | 内容 | 全局名 |
|---|---|---|
| 1 | 状态信号 | `globalThis.__DSH_APPEARANCE__` |
| 2 | 素材适配器（`src/renderers.js` 全文） | `globalThis.__DSH_APPEARANCE_RENDERERS__` |
| 3 | 仲裁点（`src/controller.js` 全文） | `globalThis.__DSH_APPEARANCE_CONTROLLER__` |
| 4 | 聊天背景表面（`src/background.js` 全文） | `globalThis.__DSH_APPEARANCE_BACKGROUND__` |
| 5 | 开机片头表面（`src/boot-screen.js` 全文） | `globalThis.__DSH_APPEARANCE_BOOT__` |
| 6 | 闲置屏保表面（`src/screensaver.js` 全文） | `globalThis.__DSH_APPEARANCE_SCREENSAVER__` |

第 2、3、4、5、6 行**不在客户端产物里**：客户端那半边加载得太晚（开机片头必须在 shell 起来
之前就要拿到仲裁点）。宿主半边**每次渲染页面索引时**用 `readFileSync` 把这五个源
文件读成文本推出去 ⇒ **改完这五个文件刷新页面就生效，不必重启宿主**。

> ★ **但"多推一行"要重启宿主。** 注入表的内容由宿主半边（`index.js`）在**宿主启动
> 那一刻**决定：新增一行 ⇒ **必须重启宿主**才会推出去；已有行的**文本**则是
> 每次渲染现读 ⇒ 改了 `src/boot-screen.js` 刷新页面就生效。⇒ **"改文本"与"改行数"
> 是两件事**，别混。

第 1 行是：

```js
globalThis.__DSH_APPEARANCE__ = { version:'0.1.0', state: function(){ return { version:'0.1.0', ready:true } } }
```

★ **注入的文本里不许烘配置。** 桌面端（Electron）的注入行是在宿主启动时收集一次
的，那之后不再重收 ⇒ **任何烘进注入文本的配置都是一份永远不更新的快照**。配置
一律运行时现读（`fetch('/appearance-media/slots')`）。

★ **验收按身份断言，不按数量**（"表里有属于我们的那几行"，而不是"表里有 N 行"）：
加一行不该让任何一条断言翻脸。

★ **读不到源文件不会静默少一行**：那一行照样被推出去，内容是
`globalThis.__DSH_APPEARANCE_INJECT_ERROR__ = { global, message }`，指名是哪个
全局没被定义。

### 6. 素材适配器（`__DSH_APPEARANCE_RENDERERS__`）

```js
globalThis.__DSH_APPEARANCE_RENDERERS__ = { create(entry, options) }
```

- `entry` —— **清单里的那一行**（`kind` / `mediaUrl` / …），由**调用方**解析并传入。
- `options` —— `{ loop, muted, volume }`，**由仲裁点映射后传入，绝不会是 undefined**
  （`undefined` ⇒ `loop` 恒 false ⇒ 需要循环的表面会停在一帧冻屏上）。
- 返回一个 **renderer**，或 `undefined`（`kind` 缺失 / 未知时）。

| | `duration()` | `onEnded()` | `setVolume()` | `mute()` | `currentTime()` | `isEnded()` | `isPaused()` | `getVolume()` | `isMuted()` | `onStall()` | `mediaError()` | `pause()` | `resume()` |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `video` | 有 | 有 | 有 | 有 | 有 | 有 | 有 | 有 | 有 | 有 | 有 | 有 | 有 |
| `image` | — | — | — | — | — | — | — | — | — | — | — | — | — |

共同的：`kind`（`'video'` / `'image'`）/ `el()` / `start()` / `dispose()` / `onShown()` /
`onError()` / `hasAudio()` / `raw`。

★ **"缺席"就是契约。** 一张静止图没有 `duration()` 也没有 `onEnded()` ⇒ 它走调用方
既有的"长度未知"分支，那正是"不会结束的东西"该走的路。给非 video 补一个假的
`duration()` 会**改变所有 kind 的交接时机**，而离线断言照样绿。
★ **图片也没有 `pause()` / `resume()`**：一张静止图本来就没在播，无从暂停，也无从继续。

★ **`loop` 由调用方决定**：片头**不循环**（循环 ⇒ 永远不触发 `ended` ⇒ 卡在片头），
屏保**必须循环**（不循环 ⇒ 播完留一帧冻屏），背景按屏保的规矩循环。

★ **视频的构造顺序固定**：`muted` → `loop` → `volume` → **`src` 最后赋值**。源必须在
最后，因为元素的第一次播放就已经按当时的 `muted` / `loop` 行事。

★ **URL 只来自 `entry.mediaUrl`**：适配器**不许自己拼** `/appearance-media/media/<id>`
（拼出来的 URL 就是没写下来的契约）。

★ **DOM 走宿主接口**：`globalThis.__DSH_APPEARANCE_HOST__` 可以提供
`createElement` / `mount` / `unmount`；没有它就用内置的（`document`）。逻辑本身
**不碰 `document`**，所以离线上可以用假 DOM 跑。

### 7. 仲裁点（`__DSH_APPEARANCE_CONTROLLER__`）

```js
globalThis.__DSH_APPEARANCE_CONTROLLER__ = {
  state(),                 // 当前真相（每次返回新快照）
  apply(slot, entry),      // 同步；'applied' | 'skipped' | 'failed-kept-previous' | 'failed-released'
  release(slot),           // 幂等；返回 void；绝不碰别人的槽位
  releaseAll(),            // 幂等；返回 void
  on(event, fn),           // 'change' → { state, changed, optionsChanged }；'error' → { error }
  // 扩展（给后面的表面用）
  refresh(),               // 现在就读一次配置
  report(slot, fields),    // 表面把自己的事实发布进 state().slots[slot]
  start(), stop(), dispose(),
  registerHost(slot, host),     // 表面登记自己的挂载点（★ 按槽位）
  unregisterHost(slot),         // 表面彻底结束时注销（★ 释放**不**注销）
  displace(slot),               // ★ **让位**：撤媒体，但**不带** hand-over，并标记"被挤下去"
  restore(),                    // ★ **让仲裁点决定谁回来**（表面不许自己决定）
  pause(slot), resume(slot),    // 暂停 / 继续屏幕上那份素材
}
```

★ **`displace()` 与 `release()` 的区别，就是"让位"与"关掉"的区别**：

| | `release(slot)` | `displace(slot)` |
|---|---|---|
| 意思 | **用户关掉了它** | **别人暂时要台子** |
| 媒体 | 撤 | 撤 |
| 槽位 `enabled` | 不动（用户自己关的） | **不动**（用户没关它） |
| 仲裁点记什么 | 什么都不记 | 记 `displaced[slot] = true` |
| 会不会立刻 hand-over | **会** ⇒ 被挤下去的槽位马上回来 | **不会** ⇒ 等台子空了再说 |

★ **`restore()` 是唯一的回来之路**：表面发现"台子空出来了"时调它，**仲裁点自己决定**
谁回来、按什么顺序回来（`SLOT_PRIORITY = boot > screensaver > background`，一次只恢复
一个）⇒ ⇒ **表面之间不需要互相通知**，也**不许**有第二套"我来决定谁回来"的逻辑。

★ **登记上去的 `host` 可以多带两个方法**：

| 方法 | 干什么 | 缺了会怎样 |
|---|---|---|
| `ensure()` | **"我的层还在吗"**——不在就重新建，返回 `false`/`null` 表示建不出来 | 没有它 ⇒ 释放之后层没了，下一个素材落回 body（**看不见**） |
| `resolve(mediaId)` | 把**媒体 id** 解析成素材库里那一行（带 `mediaUrl`） | 没有它 ⇒ 仲裁点只能用"上一次那份" |

`state()` 的形状：

```json
{
  "slot": "background", "mediaId": "up-…", "playing": true, "kind": "video",
  "error": null, "revision": 4,
  "slots": {
    "background":  { "enabled": true, "mediaId": "up-…", "revision": 2, "playing": true, "paused": false },
    "boot":        { "enabled": false, "mediaId": null, "revision": 0, "playing": false, "paused": false },
    "screensaver": { "enabled": false, "mediaId": null, "revision": 0, "playing": false, "paused": false }
  }
}
```

★ **`slots[*].playing` = "这个槽位正在台上跑"**（在台上且没被暂停）。
**仲裁点凭什么知道"谁在台上"，靠的就是它** —— 交接（下面那节）没有它就没有依据。
`slots[*].paused` 是"在台上但被暂停了"。

★ **`apply(slot, entry)` 的顺序不可调换**：

1. **先解析新素材**（适配器建得出来吗）—— 建不出来 ⇒ 答
   **`'failed-kept-previous'`，旧的不动**；
2. ★ **再问表面要宿主**（`ensure()`）—— **要不到 ⇒ 答 `'failed-kept-previous'，旧的不动`**；
3. 上面两步都过了才**释放旧的**、创建新的 ⇒ 任何时候页面上最多一个媒体元素；
4. `entry.kind` 缺失 / 未知 ⇒ 答 **`'skipped'`**，**不产生任何 DOM**；
5. 同一个槽位、同一个素材、同一个槽位 revision ⇒ 答 **`'skipped'`**（幂等）。

★ **竞态**：每次 `apply` 领一个自增的 token；**所有异步回调先比 token**，过期的一律
丢弃（`apply(A)` → `apply(B)` 之后，A 迟到的失败回调不会动 B）。

★ **释放顺序**：适配器自己拆自己（`pause` → 清 `src` → 解绑监听 → 断 observer →
清 timer），**然后**元素才离开页面。元素最后走是有意的：一个源还挂着就离开页面的
元素，浏览器照样会下载并解码它。

★ ★ **两个 revision 必须分开问**（这是最容易写错的地方）：

| | 决定什么 | 怎么看 |
|---|---|---|
| **每槽位 revision** | 这个表面**要不要重新 apply** | `config.slots.<name>.revision` |
| **整体 revision** | **要不要重读 options 并把新的音量/静音推给正在播的东西** | `config.revision` |

**只改 `options` ⇒ 整体 revision 动、三个槽位 revision 都不动。** ⇒ 只逐槽位比较的
仲裁点**永远看不到音量变了**：音量躺在文件里，断言照样全绿，用户听不见动静。
⇒ 仲裁点每次读到配置都**逐项比较 options**，变了就**推给正在播的 renderer**
（`setVolume` / `mute`；图片没有这两个方法 ⇒ 跳过，这就是"缺席即契约"）。

★ **仲裁点自己不决定什么时候上表面**：它只发布"哪个槽位变了"（`changed`），
由表面自己决定要不要 `apply`。这样开机片头才能抢到舞台，而不会被背景抢回去。

#### ★ 宿主是**按槽位**解析的，而且**绝不落 body**

```js
resolveHost(slot, ask):
  1. 该 slot 注册过的宿主（★ ask 时先让它 ensure()：层不在就重新建）
  2. 全局注入的宿主 __DSH_APPEARANCE_HOST__
  3. ★ **没有 ⇒ 失败**（'failed-kept-previous'，旧的不动）—— **绝不回落到 body**
```

★ **为什么不能是"全局替换 + 还原"**：替换的作用域只有那一次调用，而**换素材走的
正是仲裁点自己的 `apply()`** ⇒ 那一次调用早结束了 ⇒ 媒体落回 body ⇒ 靠层样式的
定位失效 ⇒ `position:static` ⇒ **被文档流推到视口外，屏幕上什么都没有**。

★ **为什么"落 body"比"失败"还坏**：body 上的媒体元素没有定位、没有层，**看不见，
而且还在下载**。⇒ 要么在层里，要么**明确失败**（`apply` 答
`'failed-kept-previous'`，**旧的画面不动**）。

★ **为什么层归表面、触发归仲裁点**：层是表面自己的东西（它写透明 CSS、它管遮罩、
它管让路），**只有它能建层**；而"现在该放什么"是仲裁点的事。⇒ 表面**注册一个
宿主**（带 `ensure()`），仲裁点**在 mount 之前问它要**。⇒ **仲裁点自己绝不建层**
（两处建层 = 两份真相）。

★ **释放**不注销**这个注册**：释放拿走的是**层**，不是表面 ⇒ 下一个素材再问一次，
表面把层**重新建起来**。⇒ 这正是"释放之后再开，背景不见了"那个致命缺陷的修法。

#### ★ 交接：谁被挤下去，谁回来（Task 6/7 的地基）

仲裁点**记住每个槽位的期望状态**（`enabled` ＋ `mediaId`），也记住
**"哪个槽位被谁挤下去了"**。

| | |
|---|---|
| **优先级** | **`boot` > `screensaver` > `background`**（片头最优先，屏保其次，背景是环境层、垫底） |
| **什么时候交** | 仲裁点 `release(slot)` 之后（**舞台空了**） |
| **交多少** | ★ **一次只恢复一个**（先 boot，再 screensaver，再 background） |
| **谁被交回来** | **enabled 且当前没在播、且是被挤下去的**（被用户**主动**关掉的**不回来**） |
| **谁来交** | **仲裁点**（表面之间**不需要互相通知**，否则三个表面要互相认识） |

⇒ **"背景被屏保挤下去，屏保一释放，背景自己回来"** —— 这条就解决"设置不动就不回来"。

★ **只有一个 apply 路径**：仲裁点 `apply(slot, entry)` 是**唯一**播放素材的地方；
表面自己播也是走它（`controller.apply`）⇒ **不存在两份 apply 逻辑**。
交接时仲裁点照样调**同一个** `apply`。

★ **仲裁点记住的是 id，不是 URL**：要交回来的时候，它向**那个槽位的表面**要
`resolve(mediaId)`（表面去读素材库、给出带 `mediaUrl` 的那一行）⇒
**URL 永远不是手拼的**。

#### ★ 暂停与继续不是释放

`pause(slot)` / `resume(slot)` 是仲裁点上的两个方法，适配器那边是
**video 专属**的 `pause()` / `resume()`（图片没有 ⇒ "缺席即契约"）。
**释放 = 重新拉流**（切回来卡一下、还要重新解码）⇒ 对常驻背景是坏体验；
**暂停 = 继续播**，切回来连续。

`state()` 多了一个字段：**`paused`**（`true` 表示屏幕上那份素材被暂停了）。

### 8. 聊天背景表面（`__DSH_APPEARANCE_BACKGROUND__`）

第 4 行注入的脚本（`src/background.js` 全文，纯脚本文本）。它做四件事，别的都不做。

| 它做什么 | 怎么做 |
|---|---|
| 让出画面 | 自己写**表面透明 CSS**：`body` 与 `[class*="_frame"]` 变成透明 |
| 承载媒体 | 自己建一层 `div.dsham-bg-layer`，**`document.body.appendChild`** 挂上去，媒体挂在层里 |
| 页面隐藏 | `visibilitychange` ⇒ **暂停**（不是释放：`src` 与进度都留着） |
| 给别人让路 | **只读** body 上别的壁纸插件的标记 ⇒ 读到非空 ⇒ **静默释放**：撤媒体 / 撤层 / 撤 `<style>` / 恢复不透明，**但 watcher 留着**（耳朵还在）⇒ 标记一撤，**背景自己回来** |

#### ★ `z-index` 是 `0`，不是 `-1`

宿主的 `body` 自己是不透明的 ⇒ **`z-index:-1` 的层画在父元素背景之下 ⇒ 看不见**。
所以背景层是 `position:fixed; inset:0; z-index:0; pointer-events:none`。

#### ★ 透明 CSS 是我们自己写的，class 只能子串匹配

宿主的实测 DOM 形状：

```
body                     ← 不透明白底（必须改成 transparent）
 └─ div#root
    └─ div[data-slot="root"]   ← 本来就透明
       └─ div.<hash>_frame     ← ★ 真正不透明的是它
```

⇒ 只让 `body` 与 `[class*="_frame"]` 透明。**聊天中列本来就是透明的**；
**侧栏 / 底栏保留自己的浅色面板背景**（面板浮在壁纸上，正是想要的）。

- ★ **frame 的 class 是构建期哈希过的**（形如 `PIRFFq_frame`）⇒ **只能子串匹配**
  `[class*="_frame"]`：**不许**写死全名（下次构建就变了），**也不许**只匹配 `frame`
  （会误伤这个构建里别的 class）。
- 两条规则都带 `!important`：宿主的 `body` 背景是 `background: var(--dsw-alias-bg-base, #fff)`
  这种简写，不加 `!important` 压不住。

#### ★ 让路：只读不写，**静默释放 ＋ 耳朵留着 ＋ 标记一撤自己回来**

别的壁纸插件在 body 上留了自己的标记。**本表面只读它**（`getAttribute`），
读到非空 ⇒ 判定"别的插件在台上" ⇒ ★ **静默释放**：
**撤媒体 → 撤层 → 撤 `<style>` → 恢复不透明**（外加解绑监听 / 断 observer / 清 timer），
★ **但 watcher 留着**（observer / timer / 订阅**不拆**）⇒ 我们还留着"能听见标记解除"的耳朵。

⇒ **本包在背景这一侧一个字都没写进 body**：没有属性、没有 class、没有内联样式，
body 上只有一次 `appendChild`。那条标记属于别的插件，写它会破坏别人的清理逻辑。

⇒ ★ **为什么台子要"让干净"**：让路是"**别人要上台**"⇒ 残留的层与透明样式会和
**对方的清理逻辑打架**（对方的清理是自己做的）⇒ ⇒ 台子必须让干净。

⇒ ★ **为什么耳朵要留着**：完整释放会把 watcher 一起拆掉 ⇒ 标记解除后**没人知道该回来**
⇒ 用户看到的就是"让个路，背景再也不回来了"⇒ ⇒ **让路 = 静默释放（台子让干净 ＋ 耳朵留着
＋ 槽位 `enabled` 不动）**，标记一撤 ⇒ **表面通知仲裁点** ⇒ **仲裁点按优先级自动重新 apply**
（**一次只恢复一个**）⇒ **背景自己回来**，不需要用户手动 apply 或刷新页面。

⇒ ★ **让路不是公开 `release()`**：公开 `release()` 说的是"这个槽位不播了"，会让仲裁点
当场把手递给别人；让路说的是"**暂时**让别人上台"⇒ ⇒ **槽位的 `enabled` 一律不动**。

#### ★ 页面永远只有**一支** video

**换素材** ⇒ 旧的媒体元素**被移除**（不是"暂停了留在页面上"）。
**暂停**只用于**隐藏**场景（`options.background.pauseWhenHidden`）。

⇒ 旧的元素留着 = 契约被破坏（"最多一支"）+ **白占资源**（源还挂着就还在下载/解码）。

#### ★ 释放时，层与注入的透明 CSS 一起撤

释放素材 ⇒ **层元素移除 ＋ `<style>` 元素移除** ⇒ body / frame 的背景**恢复不透明**。
一个"界面还透着、后面却没东西"的壳不是关掉背景，是坏掉的界面。

⇒ ★ **谁释放的都一样**：仲裁点释放（槽位关掉 / 别的表面抢了舞台 / 换素材）时，
表面在 `'change'` 里把自己的层与 CSS 一起撤掉。

⇒ ★ **被挤下去之后会回来，但不是自己跑回来**：仲裁点**记住每个槽位的期望状态**，
舞台空出来时它**按优先级**（`boot` > `screensaver` > `background`）**一次恢复一个**
⇒ **背景被屏保挤下去，屏保一释放，背景自己回来**。
⇒ 但**被用户主动关掉的不会回来**（"关掉"就得是关掉）。

#### ★ 隐藏 = 暂停，不是释放

`options.background.pauseWhenHidden`（默认 `true`）⇒ 页面隐藏时**暂停**
（元素还在、`src` 还在、进度还在）⇒ 回来时**继续**（`currentTime` 连续，不归零）。
`false` ⇒ 隐藏时既不暂停也不释放，背景继续播。

#### ★ 返回值按契约分

| 情形 | 答案 |
|---|---|
| `entry.kind` 缺失 / 未知（没有可做的事） | **`'skipped'`** |
| 媒体 id 在素材库里解析不到 / 素材坏了 | **`'failed-kept-previous'`**（**旧的画面不动**） |

⇒ 表面把最后一次答案放在 `__DSH_APPEARANCE_BACKGROUND__.state().lastResult`。

#### ★ 释放顺序是契约

```
pause → 清 src → 解绑监听 → 断 observer → 清 timer → 移除元素
```

- ★ **「清 `src`」不能省，而且必须紧跟在 `pause` 之后第一位**：浏览器会继续下载并
  解码一个还挂着源的媒体元素，**半截 body 比没有 body 更糟**。
- 媒体的拆解（pause / 清 src / 解绑它自己的监听）由**适配器**做，仲裁点调用它；
  本表面自己的四步（解绑监听 / 断 observer / 清 timer / 移除元素）接在后面。
- ★ **元素最后走**：媒体元素的移除被**推迟**到释放的最后一步，所以日志里的顺序是
  干净的 `pause → 清 src → 解绑 → 断 observer → 清 timer → remove:VIDEO →
  remove:DIV → remove:STYLE`。
- ★ **推迟只发生在"完整释放"里**：**换素材**时旧元素**当场移除**
  （那一支旧视频的元素离开页面的那一步，就是它自己那次拆解的最后一步），
  ⇒ 页面上永远只有一支 video。
- 释放时**不播退出特效**。

#### ★ 配置运行时现读

注入文本里**不许烘配置** ⇒ 背景层运行时现读 `GET /appearance-media/slots`
（`slots.background` ＋ `options.background`）与 `GET /appearance-media/catalog.json`
（把 `mediaId` 解析成清单里那一行）。**用户刚改的设置立刻生效**（≤ 1 s）。

- ★ **媒体 URL 只来自 `entry.mediaUrl`**，本文件**不拼** `/appearance-media/media/<id>`。
- `options.background.surface` 是**遮罩的不透明度**（0 = 完全透明，只有背景；1 = 完全
  盖住），运行时读、运行时写进遮罩层。

#### ★ 没有仲裁点 ⇒ 不注册表面

背景表面**只找**仲裁点，**从不自己造一个**：找的是
`globalThis.__DSH_APPEARANCE_CONTROLLER__`（`src/controller.js` 发布的**那一个**），
校验方式与客户端半边的 `arbitrationPoint()` 一致（`state` / `on` / `apply` / `release`
都得是函数）。**找不到 ⇒ 只 warn 一次，什么都不注册**。

> ★ **为什么这一行不用客户端半边的 `exports.arbitrationPoint()`**：客户端那半边是
> 宿主模块加载器里的 CommonJS 模块，**只有设置页用到它的时候才会被实体化** ——
> 远晚于这一行注入脚本执行，而且用户可能**永远不开设置页**。注入行不能 `require`
> 它，背景也必须在"设置页从没被打开过"的情况下工作。⇒ **两半读的是同一个已发布的
> 仲裁点**，表面自己不会变成仲裁点。

### 9. 开机片头表面（`__DSH_APPEARANCE_BOOT__`）

> ★ **本节移植自第三方 MIT 插件 [`dsh-boot-animation`](https://github.com/lxj5820/dsh-boot-animation)。**
> **搬的是它的代码，署名保留：`Copyright (c) 2026 dsh-boot-animation contributors`。**
> 搬的是**机制**（覆盖层、`ENDLESS_MS` 上界、持有预算、`onEnded` 交接、有上限的清单
> 等待、渐变与提示条的视觉语言）；**不搬**它的配置快照、它的片段池、它的进度观察，
> **更不搬它的素材**（素材一律来自用户自己的素材库 ⇒ 本包 `assets/` 仍然是空的）。

片头表面只做四件事：

1. **自己盖一层**（`.dsham-boot-layer`，`position:fixed; inset:0; z-index:2147483647`），
   里面是**渐变背景 ＋ 遮罩 ＋ 标题 ＋ 一行提示条**；
2. **把媒体交给仲裁点播**（`controller.apply('boot', entry)`），媒体落在**自己的舞台**
   （`.dsham-boot-stage`）里；
3. **管交接**：三个出口，任何一个都成立就**自己收工**；
4. **管让路**：别的壁纸插件在场上 ⇒ 让路（**只读**那个标记）。

#### ★ 三个交接出口，**没有一个会把用户困住**

| # | 出口 | 什么时候 |
|---|---|---|
| ① | **素材自己放完了** | 媒体元素的 `ended` |
| ② | **`ENDLESS_MS`（20 s）到了** | 素材的**长度拿不到**（`duration` 未知 ⇒ 永远等不到 `ended`）⇒ 上界兜底 |
| ③ | **内核就绪，而且**没有东西可放 | 宿主的 `__DSH_BOOT_READY__.promise` 兑现 **且** 本表面查过了、确实没有素材（没配 / 库里找不到 / 放不出来） |

★ **③ 里的第二个条件不能省**：就绪信号在 web 宿主里是**文档解析到尾部就兑现**的
（`dsh-host-webserver` 在 body 末尾追加一行 `<script>(globalThis.__DSH_BOOT_READY__
??= Promise.withResolvers()).resolve()</script>`）⇒ **"内核就绪"几乎和"素材查完"同时
发生**。只按"就绪"就收工 ⇒ **片头刚出现就被自己撤掉**（这一条是实测出来的：只有把
"查过了、确实没有"也算进去，③ 才是安全的）。

★ **释放顺序是契约**（三个表面共用）：

```
pause → 清 src → 解绑监听 → 断 observer → 清 timer → 移除元素
```

**「清 src」不能省，且必须排在 `pause` 之后第一位**。离线验收按这条契约**逐项**比对
（假 DOM 记两本日志：改页面的动作一本、读一本），不是"这几件事发生过"。

#### ★ 宿主归表面，触发归仲裁点

片头表面向仲裁点注册**自己的宿主**，宿主带两个回调：

| 回调 | 干什么 |
|---|---|
| `ensure()` | **"我的覆盖层还在吗"**——不在就重新建（层 ＋ 舞台 ＋ 提示条 ＋ `<style>`），返回 `false`/`null` 表示建不出来 |
| `resolve(mediaId)` | 把**媒体 id** 解析成素材库里**当前**的那一行（带 `mediaUrl`）——**每次现读 `/appearance-media/catalog.json`**，不缓存 ⇒ **交回来的一定是当前那一份**，不是上一次那份 |

★ **拿不到宿主 ⇒ 明确失败**：仲裁点 `apply()` 答 **`'failed-kept-previous'`**，旧画面
不动，**绝不允许静默落到 `document.body`**（落在 body 上的媒体没有定位，会被文档流推到
视口外——看不见，而且还在下载）。

#### ★ 片头**不循环**

`loop` 由**仲裁点**按槽位决定（`boot` ⇒ `false`）⇒ ★ **循环的片子永远不触发 `ended`
⇒ 永远卡在片头、界面出不来**（上游插件踩过的真 bug）。离线验收直接断言媒体元素的
`loop === false`。

#### ★ 几个有上界的等待（上游机制，移植）

| 上界 | 值 | 兜的是什么 |
|---|---|---|
| `ENDLESS_MS` | 20 s | 素材的**长度拿不到** ⇒ 等不到 `ended` |
| 看门狗 | 6 s | 素材**起得来却画不出一帧** ⇒ 屏幕停在渐变上 |
| 清单等待 | 10 s | 素材库**不应答** ⇒ 不把人卡在渐变上 |
| 持有预算 | `options.boot.holdMs`（缺省 15 s） | 内核迟迟不就绪 ⇒ 提示条改成「启动较慢 · 点一下继续」 |

★ **持有预算与提示条的值由 `options.boot` 提供**（运行时现读，不烘进注入文本）。
★ **`options.boot.fadeMs`（缺省 2000）是交接的溶解时长**，`0` ⇒ 硬切。
★ **`ENDLESS_MS`（20 s）、看门狗（6 s）、清单等待（10 s）是写死的**（与上游同款）⇒
**它们不进 `options`**：用户不需要调这三个，而把它们做成可调项只会多出三个说不清含义的
输入框。⇒ **只有 `fadeMs` 与 `holdMs` 是用户能调的**（`options.boot`）。

#### ★ 让路：只读不写，**而且 watcher 留着**

别的壁纸插件的标记（`body[data-we-wallpaper]`）**只读**：读到非空 ⇒ 片头**让路**
（撤媒体 ＋ 撤层 ＋ 撤 `<style>`，把台子让干净），**但 observer 与定时器留着** ⇒
**那个插件一走，片头自己回来**。★ **槽位的 `enabled` 一个字都没改**（用户没关它）。

#### ★ 已知限制

- ★ **没有声音开关**：表面拿不到适配器（适配器归仲裁点）⇒ 没法调 `mute()`。声音由
  `options.boot.muted` 决定（缺省静音）。
- ★ **没有进度条**：上游靠内核启动页的 `--dsh-boot-arc` 变量画进度，本表面**不观察**
  它（内核就绪信号才是就绪信号）⇒ **不做一根会骗人的进度条**。
- ★ **没有上游的三种入场模式**（`tail` / `end` / `click`）：首版统一为「**播完淡出**」，
  点一下或按 `Esc` / `空格` / `回车` 可提前进入。
- ★ **`THIRD_PARTY_NOTICES.md` 里那句「No code was copied from them」现在不准确了**
  （本 Task 搬了 `dsh-boot-animation` 的 MIT 代码）⇒ **要协调者改那一段**（那个文件不
  在本 Task 的可改清单里）。

### 10. 三个槽位（客户端那半边）

客户端那半边注册三处，各按宿主契约放在该在的地方：

| 槽位 | 形态 | 渲染什么 |
|---|---|---|
| `settings.section` | 列表（id `appearance-media`，order 60） | 「设置 → 外观媒体」里的**摘要**面板：插件名与版本、三个槽位当前都是"未配置"、条目数与清单版本号，以及"完整素材库在包页上"的一句指路。 |
| `plugins.detail.section` | 列表（id `appearance-media`，order 60） | **本包包页上的素材库面板**：导入按钮、条目列表（名称 / 类型 / 来源 / 大小）、每行一个删除按钮、空态与错误文案。 |
| `plugins.bundle.config` | 带键（key `dsh-appearance-media`，按**包名**索引） | 本包自己的配置表单，渲染在包的页面上：`dataDir` 一个字段。 |

★ **素材库面板落在 `plugins.detail.section`**，因为宿主在**本包的包页上**渲染这个
槽位（`PackageDetail`，`PluginManagerPage.tsx:838`，`subject` 是
`{ kind: 'bundle', pkg: packageRef(pkg) }`）。守卫**只判 `subject`**：

```js
subject.kind === 'bundle' && subject.pkg.name === 'dsh-appearance-media'
```

★ **守卫不判 `props.view`**：这个槽位的 owner props 是 `PluginDetailProps` =
`{ subject }`（`slot-contract.ts:68-71`），**根本没有 `view` 这个 prop**。写了
`props.view !== 'page'` 的话，面板会永远不渲染，而所有离线断言照样绿。

**插件页上本包的那张卡片由宿主渲染**，不是插件自己画的：标题、描述、图标都取自
`locale/*.json` 与 `icon.svg`。插件**不**注册官方插件组的那个槽位——一个普通的
已安装 bundle 本来就会由宿主渲染一张包卡片；两处都注册会让同一个插件在插件页上
出现**两张卡**。

面板与表单只在宿主真的伺服这个命名空间时才出现（`configForms.whileServed`），
宿主不伺服时连入口都不出现，而不是出现一块点不动的死面板。

### 11. 闲置屏保表面（`__DSH_APPEARANCE_SCREENSAVER__`）

> ★ **本节移植自第三方 MIT 插件 [`dsh-boot-animation`](https://github.com/lxj5820/dsh-boot-animation)。**
> **搬的是它的代码，署名保留：`Copyright (c) 2026 dsh-boot-animation contributors`。**
> 搬的是**机制**（触发判定的**顺序**、隐藏宽限、消失后的闩、三态纪律、轮播与交叉
> 溶解、破坏效果、指针效果、释放顺序）；**不搬**它的配置模型、它的 Windows 探针、
> 它的片段池，**更不搬它的素材**（素材一律来自用户自己的素材库 ⇒ 本包 `assets/`
> 仍然是空的）。

屏保表面只做四件事：

1. **自己盖一层**（`.dsham-saver-layer`，`position:fixed; inset:0; z-index:2147483647`），
   里面是**舞台**（`.dsham-saver-stage`，媒体落在这里）＋**一行提示条**；
2. **把媒体交给仲裁点播**（`controller.apply('screensaver', entry)`）；
3. **管触发判定**：七条规则，**顺序固定**；
4. **管让路与释放**：别的壁纸插件在场上 ⇒ 让路（**只读**那个标记）；用户一动 ⇒ 退场。

#### ★ 触发判定：七条规则，**顺序是契约**

| # | 规则 | 不满足时 |
|---|---|---|
| ① | 槽位**没启用** | **不显示** |
| ② | 用户**刚手动关掉过**，且机器还没被再次用起来 | **不显示** |
| ③ | **片头还在场** | **不显示** |
| ④ | 页面**隐藏超过 5000 ms**（`HIDDEN_GRACE_MS`） | **不显示** |
| ⑤ | **正在跑的 Turn** | **不显示** |
| ⑥ | idle 读数 `ok` **且** ≥ 阈值 | **显示** |
| ⑦ | **失焦时长** ≥ 阈值 | **显示** |

★ **⑥ 与 ⑦ 是 OR**：单靠任何一个都覆盖不了要解决的问题——⑥ 抓"人走开了"（哪怕
DSH 还是前台窗口），⑦ 抓"切到别的程序去了"（这时系统计数器以为人还在忙）。
★ **④ 的 5000 ms 宽限**是上游机制：Electron 壳里 `visibilityState` 会抖，**宽限
之前信它 ⇒ 整个屏幕频闪**。

★ **判定是一个纯函数**（`decide(readings)`），**七条全在里面**。页面把实况读数
喂进去，它回答"显示 / 不显示"和"被哪一条挡住"。⇒ 离线验收可以拿**假读数**驱动
**同一份代码**，而不是驱动一份拷贝。

#### ★ 三态纪律：只有 `ok` 算 idle

`starting`（还没答）与 `unavailable`（永远不会有）**都不许被读作 idle**。
★ **失败绝不许压成 `idleMs: 0`**——`0` 是"此刻有人在用机器"，压成 0 ⇒ 屏保**永远
立刻触发**。

#### ★ 消失之后会闩住

用户点掉屏保之后，**在机器被再次用起来之前不再出现**（②）。

★ **闩是"证据"清的不是"计时"清的**：读到一条"机器在用"的新读数（idle 小于阈值）
才清。⇒ 没有它，屏保会在用户点掉它**两秒后自己回来**（轮询手里还握着旧读数），
**要点两次才关得掉**。

★ **读数是"取回来再判"，不是"判完再取"**：触发判定用**手里已有的**读数，新读数
到了才换 ⇒ 这正是闩能生效的原因。

#### ★ 屏保**必须循环**

`loop` 由**仲裁点**按槽位决定（`screensaver` ⇒ `true`）⇒ 它的职责是盖住**未知
时长**；不循环 ⇒ **播完停住、留一帧冻屏**。（与片头相反：片头 `loop = false`，
它的结束**就是**交接信号。）

#### ★ 让路：`displace()`，不是 `release()`

别的壁纸插件的标记（`body[data-we-wallpaper]`）**只读**：读到非空 ⇒ 屏保**让路**：
撤媒体 ＋ 撤层 ＋ 撤 `<style>` ＋ **恢复不透明**，**但 observer、定时器、订阅留着**
⇒ **那个插件一走，屏保自己回来**。★ **槽位的 `enabled` 一个字都没改**（用户没关它）。

★ **让路走 `controller.displace('screensaver')`，绝不走 `controller.release()`**：
`release()` 自带 hand-over ⇒ 会在别的壁纸插件**正要上台**的当口把屏保拉上台。
★ **回来也是仲裁点决定的**：标记消失 ⇒ 表面调 **`controller.restore()`** ⇒ 仲裁点
按自己的优先级（`boot > screensaver > background`，**一次只恢复一个**）决定谁回来。
**表面不写第二套恢复规则。**

#### ★ 释放顺序是契约（三个表面共用）

```
pause → 清 src → 解绑监听 → 断 observer → 清 timer → 移除元素
```

★ **「清 src」不能省，且必须排在 `pause` 之后第一位**。**释放时不播退出特效**。

★ **两种退场，watcher 的去留不同**：

| 退场 | 媒体 / 层 / `<style>` | 轮播与指针的定时器 | 轮询 / observer / 订阅 |
|---|---|---|---|
| **退场**（触发条件不再成立、用户点掉、别的槽位上台） | 撤 | 撤 | **留着**（要能再回来） |
| **拆掉**（`dispose()`，这个表面结束） | 撤 | 撤 | **也撤** |

#### ★ 破坏效果与指针效果

- ★ **破坏效果**（`options.screensaver.breakEffect`，缺省 `true`）：用户点一下或按
  任意键 ⇒ 屏保**碎开**退场（把当前画面切成块，往右飘并淡出）。**层先下来**，
  所以屏幕立刻干净，效果是画在空屏上的。`prefers-reduced-motion` ⇒ 不播。
- ★ **指针效果**（`options.screensaver.pointerEffect`，缺省 `false`）：指针在层上
  ⇒ 跟着画涟漪。★ **效果只能由指针引起**（指针不在层上就不画），**监听挂在
  document 上**（挂在层上会被全屏的媒体挡住，事件根本到不了）。

#### ★ 轮播：素材库里的"同族"

`options.screensaver.rotateMs`（缺省 `0` = 不轮播）。★ **槽位只点名一条素材**，所以
轮播的池子是**素材库里与它同族**的那些：文件名去掉扩展名再去掉结尾的 `-<数字>`
⇒ `屏保3.mp4` 与 `屏保4.mp4` 是一族，`背景2.mp4` 是另一族。★ **切换是就地换**
（先快照旧画面 ⇒ 换素材 ⇒ 交叉溶解），**不是"退场再进场"**（那会放一次用户没要的
退出效果）。★ **循环的素材永远不触发 `ended`** ⇒ 到了就换，不等。

#### ★ 已知限制

- ★ **音量曲线**：仲裁点把 `options.screensaver.volume` **线性**映射到素材上；表面
  在挂载时按平方曲线（`volumeToGain`）再校正一次（线性滑杆的底端压不下去——2% 线性
  是 −34 dB，还听得见；平方后是 −68 dB，听不见）。⇒ **但下一次 options 变更会被
  仲裁点的线性值覆盖** ⇒ 要彻底修就得改仲裁点（**仲裁点归协调者**）。
- ★ **破坏效果只有一种**（块状飞散）：上游有三种（`particles` / `fall` / `glitch`），
  由一个字符串枚举挑；`OPTION_SHAPE` 的校验器**只支持 number / boolean**，我们**不
  为此扩类型** ⇒ 首版只有"有 / 没有"两态，效果固定一种。
- ★ **指针效果只有一种**（涟漪）：上游有 `ripples` / `attract` 两种，同上。
- ★ **探针只覆盖 macOS**：不是 macOS ⇒ 恒 `unavailable` ⇒ 屏保**只剩"失焦"那一半**
  （切到别的程序去够久，它会出现）。
- ★ **被别的窗口盖住看不出来**：窗口只是**被盖住**时 `visibilityState` 仍是
  `visible` ⇒ 屏保**会出**。这是渲染器够不到的系统事实（上游诚实地记了同样的限制）。
- ★ **轮播池是"同族"启发式**：按文件名猜 ⇒ 用户自己的命名一乱，轮播池就只有一个。
- ★ **`THIRD_PARTY_NOTICES.md` 里那句「No code was copied from them」现在不准确了**
  （本包搬了 `dsh-boot-animation` 的 MIT 代码）⇒ **要协调者改那一段**（那个文件不
  在本 Task 的可改清单里）。

## 用法

安装到 profile：

```sh
dsh plugin --profile <profile> add file:<本包目录>
```

装好之后：

```sh
curl http://127.0.0.1:<port>/appearance-media/health
# {"ok":true,"version":"0.1.0","dataDir":"/Users/<you>/.dsh/dsh-appearance-media"}

curl http://127.0.0.1:<port>/appearance-media/catalog.json
# {"ok":true,"revision":0,"entries":[],"skipped":[]}
```

导入一个素材：

```sh
curl -X POST --data-binary @clip.mp4 \
  -H 'Content-Type: video/mp4' \
  -H 'X-Dsh-Filename: clip.mp4' \
  http://127.0.0.1:<port>/appearance-media/upload
# {"ok":true,"entry":{...,"id":"up-…"},"duplicate":false}
```

删除：

```sh
curl -X POST -H 'Content-Type: application/json' \
  -d '{"id":"up-…"}' \
  http://127.0.0.1:<port>/appearance-media/remove
# {"ok":true,"removed":true}
```

读槽位配置：

```sh
curl http://127.0.0.1:<port>/appearance-media/slots
# {"ok":true,"config":{"revision":0,"slots":{…},"options":{…}},"ignored":[]}
```

改槽位配置（选素材 / 开关 / 调参数）：

```sh
curl -X PUT -H 'Content-Type: application/json' \
  -d '{"slot":"background","enabled":true,"mediaId":"up-…"}' \
  http://127.0.0.1:<port>/appearance-media/slots
# {"ok":true,"config":{…,"revision":1,…},"ignored":[]}
```

## 限制

- **本包不携带任何第三方媒体。** `assets/` 是空的，本包不含任何视频、图片或立绘。
- ★★ **路由的访问检查**（本插件在宿主上注册 8 条 HTTP 路由，读清单、读配置、传素材、
  改槽位、删素材都在内）：
  **每一条都先过宿主的访问检查**（`connection.requestRejection`，含 Host/Origin 校验与
  浏览器认证）才轮到自己���逻辑 ⇒ 来自 DSH 自己的界面的请求正常，**别的网站伪造的请求
  403，没有凭据的请求 401**。
  没有这道检查的话，用户浏览器里随便一个别的页面就能调这些路由（传素材、改配置、删素材）。
  ★ 这道检查是宿主提供的，本插件只是照它的用法接上（与宿主自己的路由同一种写法）；
  `tools/verify-access.mjs` 盯着它：每条注册的路由都必须拒绝被拒的请求，且**被拒时
  绝不碰到自己的逻辑**。
- ★★ **平台支持矩阵**（每一格都在 [`README.md`](../README.md#平台支持) 里有同样的表）：

  | 功能 | 浏览器（web） | macOS 桌面端 | Windows 桌面端 |
  | --- | --- | --- | --- |
  | 聊天背景（动态壁纸） | ✅ | ✅ | ✅ |
  | 开机片头 | ✅ | ✅ | ✅ |
  | 素材库：上传 / 删除 / 批量导入 | ✅ | ✅ | ✅ |
  | 插件页里的设置卡片 | ✅ | ✅ | ✅ |
  | 设置页左栏里的入口 | ❌ web 版没有设置页 | ✅ | ✅ |
  | 屏保 · 窗口失焦时接管 | ✅ | ✅ | ✅ |
  | 屏保 · 整机闲置时接管 | ✅ | ✅ | ❌ |

  ⇒ **唯一的平台差别是屏保的「整机闲置」那一半**：它要问操作系统"这台机器多久没人碰了"，
  macOS 上读 `ioreg` 的 `HIDIdleTime`，**Windows 上没有对应实现**，那一半如实回答
  `unavailable`（见 §2.1）⇒ **Windows 上只剩失焦触发**。
  ⇒ **其余部分与操作系统无关**：背景、片头、素材库、卡片、路由全是浏览器技术与 Node，
  在 Windows 上开箱可用；**整个包里与平台有关的代码只有那一条 `ioreg` 调用**。
  ⇒ ★ 上游 `dsh-boot-animation` 的闲置探针是 **Windows-only** 的（PowerShell 调
  `GetLastInputInfo`），我们没有搬，改用了 macOS 的 `ioreg` 一版；**两边合起来才完整**，
  这一点如实记在这里。
- ★ **背景表面与开机片头表面已经上线；屏保还没有。** 配置**已经能读能写**
  （`GET` / `PUT /appearance-media/slots`），仲裁点（注入侧）、适配器、**聊天背景表面**
  与**开机片头表面**也已经推上页面，但**没有选择器 UI**，也**没有别的表面在播**：屏保是
  Task 7 的活。⇒ 在那之前，`state().slot` 最多是 `"background"` 或 `"boot"`，这是对的，
  不是坏了。
- **不碰系统唤醒锁。** 屏保一旦要做，用的是宿主自己的空闲判定，本包不申请
  `navigator.wakeLock`。
- **客户端只依赖 `react`。** 产物里没有对任何 `@deepseek-ai/dsh-client-*` 的
  `require`，也没有第二份 React。
- ★ **背景被"外面的"释放之后，要等设置动一下才回来**（**被挤下去**的情况除外）。仲裁点
  释放它（别的表面抢了舞台、或直接调 `release()`）⇒ 背景撤层、撤 CSS，并且**不立刻
  自己回来**（否则它会在刚抢到舞台的那个表面底下又冒出来）。⇒ 改一次背景设置（换素材
  或开关）就会重新 apply。★ **但"被前台槽位挤下去"是另一回事**：仲裁点记得谁把谁挤
  下去了（`boot` > `screensaver` > `background`，**一次只恢复一个**）⇒ **片头交场后
  背景自己回来**，不需要用户改设置。
- **`dataDir` 只被解析，不会被创建。** 素材目录在第一次导入时才被创建；清单在
  目录不存在时**答 200 且条目为空**，不是 500。槽位配置也一样：**目录不存在时
  `GET /appearance-media/slots` 答 200 且全是默认值**，第一次写才建目录。

### ★ 已知限制：注入行在 `<head>` 里跑，那时 `document.body` 还不存在

仲裁点与适配器住在**注入侧**，注入行落在 `<head>` ⇒ **脚本执行的那一刻 body 还不
存在**。⇒ 内置的宿主接口 `mount()` 会**默默跳过**（`document.body` 为空就什么都不
做）。⇒ **开机片头（Task 6）必须自带挂载点**：它在 shell 起来之前就要上屏，那时既
没有 body，也没有应用可以挂。⇒ 想让某一层落在自己那一层里，就给
`globalThis.__DSH_APPEARANCE_HOST__` 一个自己的 `mount` / `unmount`。

★ **聊天背景表面不受这条限制**：它**不抢在 body 之前**，它每 1 s 重新评估一次，
body 一出现就把层挂上去（实测：注入脚本执行时 body 还没有 ⇒ 第一轮评估挂不上，
下一轮就挂上了）。它的层与媒体都挂在 `document.body` 下，
**不写 body 的任何属性**。

### ★ 已知限制：写队列是**进程内**的，宿主没有跨进程文件锁

- 素材库的账本（`.meta.json`）与槽位配置（`config.json`）**共用同一条写队列**，
  队列**按 `dataDir` 串行**：同一时刻只有一个"读-改-写"在进行 ⇒ 两次并发的修改
  不会互相覆盖。
- ★ **但这条队列只存在于当前宿主进程里。** 宿主**没有**跨进程文件锁
  （`dsh-config-editor` 是整文件重写，也没有锁）⇒ **同一个 profile 起两个宿主进程
  时，两个进程各有各的队列**，两边可能丢一次更新。
- ⇒ 实际前提：**一个 profile 一个宿主进程**。桌面端与 web 端是两个不同的 profile、
  两个不同的目录 ⇒ 互不干扰。只有"同一个 profile 起两个进程"才会撞。
- ⇒ ★ **不要假装这里有锁。** 离线验收里的"并发两次 PUT"是**单宿主进程内**的验收。

### ★ 已知限制：跨插件不互相让路

**本包绝不写 `body[data-we-wallpaper]`。**

- 那个属性是 **Wallpaper Engine 与 dsh-video-skin 各自在用的标记**：dsh-video-skin 单向设置它（`runtime/skin.js:112`），
  ★ **WE 的 JavaScript 也在读它**（`WE lib/client.js:22856`
  `document.body.hasAttribute("data-we-wallpaper")`，注释写着"「我方在台上」有两条
  腿"）⇒ **写它会干扰 WE 的清理逻辑**。
- ⇒ 本包**只读**它：★ **聊天背景表面**读到非空 ⇒ 说明 Wallpaper Engine / dsh-video-skin 在场 ⇒
  **我们让路**（撤层并停播）；**绝不写**。
- **代价（已知限制，不在实现里偷偷补回来）**：dsh-video-skin 的皮肤**不会**因为我们上线而
  自动让路 ⇒ 两边可能同时在台。"同一时刻只有一个表面在播"这条**只对本包自己的
  三个槽位成立**，跨插件不成立。

## English summary

One volatile config field (`dataDir`), seven routes (`GET /appearance-media/catalog.json`,
`GET /appearance-media/health`, `POST /appearance-media/upload`,
`POST /appearance-media/remove`, the prefix route `GET /appearance-media/media/<id>`,
`GET`/`PUT /appearance-media/slots` and
`GET /appearance-media/system-idle.json`), six inline `kind:'script'` index rows, and
three client slots: a summary in `settings.section`, the full media library — import,
list, delete — in `plugins.detail.section` on this bundle's own page, and the
configuration form in `plugins.bundle.config`.

The six injected rows are the appearance state (`globalThis.__DSH_APPEARANCE__`), the
media adapters (`globalThis.__DSH_APPEARANCE_RENDERERS__`, read from
`src/renderers.js`), the arbitration point
(`globalThis.__DSH_APPEARANCE_CONTROLLER__`, read from `src/controller.js`), the chat
background surface (`globalThis.__DSH_APPEARANCE_BACKGROUND__`, read from
`src/background.js`), the boot screen (`globalThis.__DSH_APPEARANCE_BOOT__`, read
from `src/boot-screen.js`) and the idle screensaver
(`globalThis.__DSH_APPEARANCE_SCREENSAVER__`, read from `src/screensaver.js`). The last
five are read from their files on every index
render, so editing them needs a page reload and not a Host restart — but **adding a
row does need a Host restart**, because the row list is decided when the Host half
starts. **No configuration is baked
into injected text**: the desktop Host freezes an injection row's text when it starts,
so a snapshot inside it would be a snapshot that never updates — the controller fetches
`/appearance-media/slots` at runtime instead.

★ **The idle screensaver is ported from the MIT plugin `dsh-boot-animation`**
(`Copyright (c) 2026 dsh-boot-animation contributors`), and so is the boot screen above.
What came across for the screensaver is the *mechanism*: the trigger — seven rules in a
fixed order, with the system-idle half and the blur half ORed with each other —, the
5000 ms grace on a hidden page (the Electron shell's `visibilityState` flickers, and
believing every flip strobed the screen), the latch that holds a dismissal until the
machine is seen to be in use again, the rotation with its cross-dissolve, the break-away
exit effect and the pointer decoration. What did **not** come across is its flat
configuration (ours is `slots.screensaver` + `options.screensaver`), its clip pools (ours
is the material library) and — above all — **its Windows idle probe**: that one is
PowerShell plus `user32.dll`, so on macOS it answered `unavailable` forever. Ours is a
Darwin `ioreg` reading (`/usr/sbin/ioreg -n IOHIDSystem -d 4` ⇒ `HIDIdleTime` in
nanoseconds ⇒ milliseconds), served by `GET /appearance-media/system-idle.json` as
`{ ok, idleMs, status, reason }` with `status` one of `ok` / `starting` / `unavailable`
and **`idleMs` a number only when the status is `ok`** — a failure is never flattened
into `idleMs: 0`, because zero means "the machine is being used right now". Each read
spawns the command directly (about 5 ms here) and there is **no resident child process**.
The screensaver LOOPS: its job is to cover the screen for an unknown length of time,
and a clip that stops leaves a frozen frame on a layer that is supposed to be there.
When another wallpaper plugin takes the stage, the screensaver yields through
`controller.displace()` — never `release()`, which would hand the stage over at the
wrong moment — and the comeback is the arbitration point's own decision
(`controller.restore()`, `boot` > `screensaver` > `background`, one at a time).

★ **The boot screen is ported from the MIT plugin `dsh-boot-animation`**
(`Copyright (c) 2026 dsh-boot-animation contributors`). What came across is the
*mechanism*: the hand-built overlay (gradient, veil, one line of caption), the
`ENDLESS_MS` upper bound for a material whose length cannot be known, the hold budget
that tells the user the start is slow, the hand-over on the material's own end, and the
bounded wait for the material library. What did **not** come across is its
configuration snapshot (ours is read live), its clip pools (ours is the material
library), its `--dsh-boot-arc` progress observation (ours waits for the Host's own
readiness signal) and — above all — **its materials**: this package carries none.
Three exits release the screen, and none of them can trap the user: the material
ended, the upper bound expired, or the kernel is ready **and** the surface has looked
and found nothing to show. The boot clip does not loop: its end IS the hand-over
signal, and a looping element never fires `ended`.

★ The chat background surface owns four things and nothing else: the transparent-surface
CSS (`body` and `[class*="_frame"]` — the frame's class is hashed by the shell's build,
so only a substring match survives the next build), the layer the media is mounted into
(`document.body.appendChild`, and **no attribute is written on the body**), the release
of everything when the page is hidden, and the decision to yield to another wallpaper
plugin. Its layer is at `z-index: 0`, never below the opaque body. The other plugin's
marker on the body is **read, never written**: reading it non-empty means somebody else
is on the stage, so this surface withdraws. The surface finds the arbitration point; it
never becomes one — and with no arbitration point it registers nothing.

★ **The host is resolved PER SLOT, not per call — and it never falls back to the body.**
A surface registers the host it wants its material mounted into, and the registration
outlives a release (a release takes the LAYER away, not the surface). The registered
host may carry `ensure()` — "make sure your layer is there" — and the arbitration point
asks for it **before** it mounts. If the surface cannot give a host, the attempt FAILS:
`apply` answers `'failed-kept-previous'` and the old material stays exactly where it is.
This is not a nicety: the first version swapped the global host for the duration of its
own call, and a material switched by the arbitration point itself — the user's "pick
another clip" path — landed on the body, lost the layer's positioning and disappeared
below the viewport. Falling back to the body is the same bug with a quieter face: the
element has no positioning, lands below the viewport, and keeps downloading.

★ **The layer belongs to the surface; the trigger belongs to the arbitration point.**
Only the surface builds its layer (it owns the transparent CSS, the mask and the
yielding); only the arbitration point decides what plays. So the surface registers a
host and the arbitration point asks for it — the arbitration point never builds a layer
of its own, because two places that build a layer are two places that tell the truth.

★ **The stage is handed over, not the surfaces.** The arbitration point remembers every
slot's expected state (`enabled` + `mediaId`) and remembers which slot another slot
pushed off the stage. When a slot is released and the stage is free again, the pushed-off
slots come back — `boot` > `screensaver` > `background`, **one at a time**. The surfaces
never have to know about each other, and there is only ONE apply path: the arbitration
point's own `apply(slot, entry)`. A slot that was released ON PURPOSE does not come
back. The arbitration point answers "who is playing" with `state().slots[*].playing`.

★ **One video at a time.** A switched material does not pause the old one and leave it
on the page: the old element is REMOVED. Pausing is what hiding does
(`options.background.pauseWhenHidden`), not what switching does — an element whose
source is still attached keeps downloading.

★ **Hidden means paused, not released.** Releasing a background means streaming and
decoding it again when the user comes back. So the video adapter carries `pause()` and
`resume()` (a still picture has neither — the ABSENCES are the contract), the
arbitration point exposes `pause(slot)` / `resume(slot)`, and the background pauses
when the page goes hidden and continues when it comes back. A release still takes the
layer **and** the injected transparent CSS with it: a transparent shell with nothing
behind it is a broken interface, not an off switch. The yielding to another wallpaper
plugin goes through the SAME release as the public one — the stage is handed over clean,
so the other plugin's own cleanup finds nothing of ours to fight with.

`create(entry, options)` builds a renderer for one catalog entry; `options` is
`{ loop, muted, volume }` and is never undefined. The URL comes from `entry.mediaUrl`
and is built nowhere. The ABSENCES are the contract: an image renderer has no
`duration()`, no `onEnded()` and no audio methods at all, which is what routes it
through the caller's "unknown length" path. `loop` is the caller's decision — the boot
clip must not loop (its end is the hand-over signal) and the screensaver must loop (it
covers the screen for an unknown length of time).

`apply(slot, entry)` is synchronous and answers `'applied' | 'skipped' |
'failed-kept-previous' | 'failed-released'`. The new material is built FIRST: if it
cannot be built the old one stays and the answer is `'failed-kept-previous'`; only
then is the old one released. An entry whose `kind` is missing or unknown is
`'skipped'` and touches no DOM. Every attempt carries an increasing token, and every
asynchronous callback checks it: an attempt that has been superseded must not touch the
material that replaced it.

★ The two revisions are asked separately. A slot's own revision decides whether that
surface has to be applied again; the WHOLE revision decides whether the options have
to be re-read. Changing only `options` moves the whole revision and none of the slot
revisions, so a controller that compared only the slot revisions would never change
the volume — the volume would sit in the file, every assertion would stay green, and
the user would hear nothing. The controller therefore compares the options by value
and pushes the new level onto the material that is on screen.

The slot configuration is one document, `<dataDir>/config.json`: three slots
(background / boot / screensaver), each with its own material, its own switch and
its own revision, plus the options. `GET` answers `{ ok, config, ignored }` with
`Cache-Control: no-store` — exactly — because it answers "what is true now", and a
cached answer to that is a stale surface. `PUT` takes a flat patch
(`{ slot, enabled, mediaId }` and/or `{ options }`); `mediaId: null` clears a slot,
an id that is not in the catalog answers 400 and leaves the file on disk byte for
byte unchanged, and every other method answers 405 with an `Allow` header.

Two revisions, two meanings: the whole revision moves on every write, while a
slot's own revision moves only when that slot's `enabled` or `mediaId` changed —
changing only `options` moves the whole one and none of the slot ones. The ledger
and the slot configuration share ONE write queue, keyed by the data directory.

Known limitation: the write queue is in-process only — the Host has no
cross-process file lock — so two Host processes on the same profile could lose one
update. This plugin never writes `body[data-we-wallpaper]` (Wallpaper Engine's and dsh-video-skin's marker,
and WE's own JavaScript reads it), so the other plugins do not step aside for us —
only for each other. Another known limitation: an injected row runs in `<head>`, where
`document.body` does not exist yet, so the built-in mount point is unavailable there
— the boot screen has to bring its own.

---

## 怎么加更多素材

插件本身**不带任何素材**（这是所有 DSH 插件的常态）。三条路，从简到繁：

1. **在插件页面里上传** —— 卡片里的「素材库」下方，「导入一个视频或图片（≤ 96 MiB）」，单个文件传上去。
2. **批量导入一个目录**：
   ```bash
   python3 scripts/import-media-sources.py dir <目录>          # 演练
   python3 scripts/import-media-sources.py dir <目录> --apply  # 真导入
   ```
3. **导入 Wallpaper Engine 的视频壁纸**：
   ```bash
   python3 scripts/import-media-sources.py we <WE 安装目录>
   ```

> 命令里的路径相对 **DSH 插件开发工作区的根目录**。默认是演练（只报告、不写任何文件），
> 加 `--apply` 才真导入；工具只加不删。

每次导入都会写一条出处记录（`~/.dsh/dsh-appearance-media/sources.jsonl`）：来源、许可、地址、SHA-256。

**要加一个新的在线素材源**：编辑 `scripts/media-sources.json` 这个来源清单——
每条源写着名称、URL 模板、许可说明。**在线抓取默认是关的**（清单里 `enabled` 默认是 `false`，
要抓得用 `--source <名字>` 点名才生效），清单里只留许可说得清的源。

---

DeepSeek Harness、DSH 与 Cordis 是各自所有者的商标。本插件是独立项目，与它们无关，也没有得到它们的背书。
