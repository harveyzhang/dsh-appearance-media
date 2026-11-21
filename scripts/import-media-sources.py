#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""外观媒体 · 素材导入工具（Wallpaper Engine / 任意目录 / 在线抓取）

素材库在 `~/.dsh/dsh-appearance-media/media/`。这个工具往里补素材，规矩与
`同目录/sync-upstream-media.py` 完全一致：

    扫目录 → SHA-256 内容比对 → 区分「同一片子的 faststart 优化版」与「真新素材」
    → **只加不删** → 记出处

★ 默认是**演练**（只报告不写任何文件）：加 `--apply` 才真导入。
★ 永远不删除、不改名、不改 mtime —— 素材 id 是 `fs-<slug>-<mtime>`（见插件
  `lib/catalog.js` 的 `libraryId`），动了 mtime 就换了 id，槽位会指空。
★ 只用标准库 + 已有的 ffprobe；不装任何全局依赖。

三个子命令：

    we   [ROOT]   扫 Wallpaper Engine 安装根 / Steam 创意工坊，导入**视频壁纸**
    dir  DIR      批量导入任意目录里的视频 / 图片
    fetch         在线抓取（**默认关闭**，来源清单可编辑，见 media-sources.json）

边界（写在这里，也写进 03-素材来源清单.md）：

  * 视频壁纸（mp4/webm/…）—— 能导入，就是文件本身。
  * Scene 壁纸 —— **不能**作为静态素材导入。它们是实时渲染的场景（scene.pkg /
    scene.json + 材质 + 相机 + 脚本），静态文件只是它的零件；要看到效果必须走
    WE 插件自己的 WebWallGL 渲染引擎。本工具**跳过**并说明原因。
  * Web 壁纸 —— 同上，是要跑 JS 的网页，必须靠渲染引擎。
  * 贴图（场景 assets/ 里的纹理 / 材质 / 视频贴图）—— **不导入**：它们是场景的
    一部分，单独当壁纸没有意义（而且多半是别人作品里的素材）。

用法：

    python3 import-media-sources.py --help
    python3 import-media-sources.py we                      # 演练：自动探测 WE
    python3 import-media-sources.py we /path/to/steamapps    # 演练：指定根
    python3 import-media-sources.py we --apply               # 真导入
    python3 import-media-sources.py dir ~/Movies --apply
    python3 import-media-sources.py fetch --source unsplash --apply
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

# ── 常量 ────────────────────────────────────────────────────────────────────

HOME = Path.home()

#: 素材库（★ 只放素材文件；出处记录写在它的**上一级**，不写进这里）
DEFAULT_LIBRARY = HOME / ".dsh" / "dsh-appearance-media" / "media"
#: 出处记录（JSONL，一行一条）
DEFAULT_SOURCES_LOG = HOME / ".dsh" / "dsh-appearance-media" / "sources.jsonl"
#: 在线来源清单（可编辑的 JSON）
DEFAULT_MANIFEST = Path(__file__).resolve().parent / "media-sources.json"

#: Wallpaper Engine 的 Steam appid（创意工坊内容目录名）
WE_APPID = "431960"

#: 视频扩展名（可导入）
VIDEO_EXT = {".mp4", ".webm", ".ogv", ".mov", ".m4v", ".mkv", ".avi"}
#: 图片扩展名（可导入）
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif"}
#: 工具愿意搬进库的扩展名（比插件认的多几个 —— 多出来的会被插件标成「不支持的扩展名」）
IMPORTABLE_EXT = VIDEO_EXT | IMAGE_EXT
#: ★ 插件 `lib/catalog.js` 的 MEDIA_TYPES —— 只有这几种真会被播放/显示
PLUGIN_SERVED_EXT = {".mp4", ".webm", ".ogv", ".jpg", ".jpeg", ".png"}

#: 在线抓取用的浏览器指纹（照 dsh-skin 的三个 fetcher）
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

#: 出处记录里的时间一律用新加坡时间（UTC+8）—— 机器时区是美国
TZ_SG = timezone(timedelta(hours=8))

#: 素材来源的许可说明（写进出处记录）
LICENSE_WE = (
    "本机 Steam 已购/已订阅的创意工坊内容；作者保留版权，仅限本机自用，禁止再分发"
)
LICENSE_LOCAL = "本地目录，版权由用户自定（默认按未知处理）"

#: 出处记录里的工具标识
TOOL_ID = "import-media-sources"
TOOL_VERSION = 1


class PathEscape(Exception):
    """路径越界（目录穿越 / 绝对路径 / 符号链接逃出）。"""


class ToolError(Exception):
    """用法 / 环境类错误。"""


# ── 通用工具 ────────────────────────────────────────────────────────────────

def sha256_file(path: Path) -> str:
    """文件内容的 SHA-256（分块读，96 MiB 的视频也不会整块进内存）。"""
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def faststart(path: Path):
    """★ 这个 mp4 是不是 faststart（moov 原子在 mdat 之前）。

    非 faststart 的文件，浏览器必须把整个文件下完才能出第一帧。

    ★ 只读每个 box 的头、其余用 seek 跳过 ⇒ 53MB 的文件也是毫秒级，
      而且 moov 在文件尾（没优化的那种）也照样能看见。
    —— 这段判定逐字照抄 `sync-upstream-media.py`，两边口径必须一致。
    """
    try:
        size = path.stat().st_size
        order = []
        with path.open("rb") as fh:
            off = 0
            while off < size - 8 and len(order) < 32:
                fh.seek(off)
                head = fh.read(8)
                if len(head) < 8:
                    break
                box = struct.unpack(">I", head[:4])[0]
                typ = head[4:8].decode("latin1", "replace")
                order.append(typ)
                if box == 1:
                    # 64 位长度：紧跟 8 字节的大端长度
                    ext = fh.read(8)
                    box = struct.unpack(">Q", ext)[0]
                if box <= 0:
                    break
                off += box
        if "moov" not in order or "mdat" not in order:
            return None
        return order.index("moov") < order.index("mdat")
    except Exception:
        return None


def probe(path: Path):
    """时长/分辨率/编码 —— 用来判断「上游那份是不是我们那条的优化版」。"""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries",
             "format=duration,size:stream=width,height,codec_name",
             "-of", "json", str(path)],
            capture_output=True, text=True, timeout=30)
        data = json.loads(out.stdout or "{}")
        dur = float((data.get("format") or {}).get("duration") or 0)
        st = (data.get("streams") or [{}])[0]
        raw = (data.get("format") or {}).get("size")
        try:
            raw = int(raw)
        except (TypeError, ValueError):
            raw = 0
        return {"duration": round(dur, 3), "width": st.get("width"), "height": st.get("height"),
                "codec": st.get("codec_name"), "size": raw}
    except Exception:
        return None


def same_video(a: dict, b: dict) -> bool:
    """同一个片子吗：时长一致（差 < 0.05 秒）、分辨率与编码一致、体积差 < 1%。"""
    if not a or not b:
        return False
    if abs((a.get("duration") or 0) - (b.get("duration") or 0)) > 0.05:
        return False
    if a.get("width") != b.get("width") or a.get("height") != b.get("height"):
        return False
    sa, sb = a.get("size") or 0, b.get("size") or 0
    if not sa or not sb:
        return False
    return abs(sa - sb) / max(sa, sb) < 0.01


# ── 路径守卫 ────────────────────────────────────────────────────────────────

def is_within(base: Path, target: Path) -> bool:
    """target 在 base 之内吗（含 base 自己）。resolve 跟随符号链接 ⇒ 符号链接逃逸也挡得住。"""
    try:
        base_r = base.resolve()
        tgt_r = Path(target).resolve()
    except OSError:
        return False
    if tgt_r == base_r:
        return True
    return base_r in tgt_r.parents


def safe_join(base: Path, relative: str) -> Path:
    """把「项目里声明的相对路径」解析成 base 内的绝对路径；越界一律拒绝。

    ★ 照 WE 插件 issue #252 的口径：创意工坊的 project.json 由上传者随便写
      （`"file": "../../../.ssh/id_ed25519"`）⇒ 声明值必须先收紧到项目目录内，
      否则一个恶意 project.json 就能让本工具把库外的文件读进来。
    """
    if relative is None or str(relative).strip() == "":
        raise PathEscape("空路径")
    raw = str(relative).replace("\\", "/")
    if raw.startswith("/") or re.match(r"^[A-Za-z]:", raw):
        raise PathEscape("绝对路径：%s" % relative)
    if any(part == ".." for part in raw.split("/")):
        raise PathEscape("上级目录穿越：%s" % relative)
    target = (base / raw).resolve()
    if not is_within(base, target):
        raise PathEscape("越出项目目录：%s" % relative)
    return target


def library_target(library: Path, name: str) -> Path:
    """库里要写的一个文件名的绝对路径；名字不合法或会逃出库目录 ⇒ 拒绝。"""
    if not name or name in (".", ".."):
        raise PathEscape("非法文件名：%r" % name)
    if "/" in name or "\\" in name or "\x00" in name:
        raise PathEscape("文件名里带路径分隔符：%r" % name)
    if name.startswith("."):
        raise PathEscape("文件名以点开头（插件会跳过点文件）：%r" % name)
    target = library / name
    if not is_within(library, target):
        raise PathEscape("目标越出素材库：%r" % name)
    return target


# ── 素材 id（照插件 lib/catalog.js 的口径）────────────────────────────────

def library_slug(name: str) -> str:
    """插件 `libraryId` 用的 slug 规则：基名小写 + 非 [0-9a-z-] 折叠成 '-'。"""
    base = os.path.basename(name)
    ext = os.path.splitext(base)[1]
    if ext:
        base = base[: -len(ext)]
    slug = re.sub(r"[^0-9a-z-]+", "-", base.lower())
    slug = re.sub(r"-+", "-", slug)
    slug = slug.lstrip("-").rstrip("-")
    return slug or "media"


def library_id(name: str, mtime_ms: int) -> str:
    """插件给手放文件发的 id：``fs-<slug>-<mtime 毫秒>``。"""
    return "fs-%s-%d" % (library_slug(name), int(round(mtime_ms)))


def ascii_base(stem: str, fallback_hash: str) -> str:
    """把源文件名转成能进插件 slug 的 ASCII 基名；全是非 ASCII 时退回哈希前缀。"""
    out = re.sub(r"[^0-9a-zA-Z]+", "-", stem).strip("-").lower()
    out = re.sub(r"-+", "-", out)
    return out or fallback_hash[:8]


def propose_name(prefix: str, stem: str, ext: str, taken: set, fallback_hash: str) -> str:
    """给新素材起名：不覆盖已有文件，冲突就加序号。"""
    base = ascii_base(stem, fallback_hash)
    cand = "%s-%s%s" % (prefix, base, ext)
    n = 2
    while cand in taken:
        cand = "%s-%s-%d%s" % (prefix, base, n, ext)
        n += 1
    return cand


# ── 素材库索引 ──────────────────────────────────────────────────────────────

class Library:
    """素材库的只读索引 + 写入闸门。

    ★ 这个类**只加不删**：没有 unlink、没有 rename、没有 utimes。
      写操作只有「在库目录里新建一个文件」。
    """

    def __init__(self, root: Path):
        self.root = Path(root)
        self.by_hash = {}      # sha256 → Path
        self.names = set()     # 已有文件名
        self.ids = set()       # 已有 id（slug+mtime）
        self._fs_cache = {}    # path → faststart 结果
        self._probe_cache = {}  # path → probe 结果
        self.refresh()

    def refresh(self) -> None:
        self.by_hash.clear()
        self.names.clear()
        self.ids.clear()
        if not self.root.is_dir():
            return
        for entry in sorted(self.root.iterdir(), key=lambda p: p.name):
            if not entry.is_file():
                continue
            if entry.name.startswith("."):
                continue
            self.names.add(entry.name)
            try:
                info = entry.stat()
            except OSError:
                continue
            self.ids.add(library_id(entry.name, info.st_mtime * 1000))
            try:
                self.by_hash[sha256_file(entry)] = entry
            except OSError:
                continue

    def faststart_of(self, path: Path):
        if path not in self._fs_cache:
            self._fs_cache[path] = faststart(path)
        return self._fs_cache[path]

    def probe_of(self, path: Path):
        if path not in self._probe_cache:
            self._probe_cache[path] = probe(path)
        return self._probe_cache[path]

    def id_taken(self, name: str, mtime_ms: int) -> bool:
        """这个名字 + 这个 mtime 会不会撞上库里已有的 id。"""
        return library_id(name, mtime_ms) in self.ids


# ── 候选素材 ────────────────────────────────────────────────────────────────

def make_candidate(source, source_name, path=None, url=None, title=None,
                   kind=None, license_text=None, license_url=None, detail=None):
    """一条待判定的候选素材。"""
    if kind is None and path is not None:
        ext = path.suffix.lower()
        kind = "video" if ext in VIDEO_EXT else ("image" if ext in IMAGE_EXT else "other")
    return {
        "source": source,
        "source_name": source_name,
        "path": Path(path) if path is not None else None,
        "url": url,
        "title": title or (path.name if path is not None else (url or "")),
        "kind": kind or "other",
        "license": license_text or LICENSE_LOCAL,
        "license_url": license_url,
        "detail": detail or {},
    }


# ── 计划：判定 → 决定 ───────────────────────────────────────────────────────

def classify(candidate: dict, library: Library):
    """判定一条候选素材属于哪一类。

    返回 ``(action, reason)``：
      ``import``    真新素材 → 导入
      ``duplicate`` 内容哈希与库里已有文件完全相同 → 不重复导入
      ``optimized`` 同一个片子的 faststart 优化版（库里那份没优化）→ **不覆盖**，只报
      ``skip``      不该导（扩展名不认识等）
    """
    path = candidate["path"]
    if path is None:
        return "import", ""
    if not path.is_file():
        return "skip", "文件不存在"
    if path.suffix.lower() not in IMPORTABLE_EXT:
        return "skip", "扩展名不在可导入范围"
    digest = sha256_file(path)
    candidate["sha256"] = digest
    candidate["bytes"] = path.stat().st_size
    if digest in library.by_hash:
        return "duplicate", "内容与库里已有文件逐字节相同（%s）" % library.by_hash[digest].name
    up_fs = faststart(path)
    candidate["faststart"] = up_fs
    if up_fs is True:
        up_probe = probe(path)
        candidate["probe"] = up_probe
        for other_hash, other_path in library.by_hash.items():
            # 命中条件照抄 sync-upstream-media.py：库里那份**没**做 faststart，
            # 候选那份做了，且两者是同一个片子。
            if library.faststart_of(other_path) is True:
                continue
            if same_video(up_probe, library.probe_of(other_path)):
                candidate["optimized_of"] = other_path
                return "optimized", "同一片子的 faststart 优化版（库里那份：%s）" % other_path.name
    return "import", ""


def plan_import(candidates, library: Library, namer):
    """把候选素材排成一个导入计划（还不写任何东西）。

    ``namer(candidate, digest, taken)`` 返回目标文件名；它必须保证不覆盖已有文件。
    """
    plan = []
    taken = set(library.names)
    seen_hashes = {}
    for cand in candidates:
        action, reason = classify(cand, library)
        entry = {"candidate": cand, "action": action, "reason": reason,
                 "target": None, "id": None}
        if action == "import":
            digest = cand.get("sha256") or ""
            if digest and digest in seen_hashes:
                entry["action"] = "duplicate"
                entry["reason"] = "与本次导入里的 %s 内容相同" % seen_hashes[digest]
            else:
                if digest:
                    seen_hashes[digest] = cand.get("source_path_label") or cand["title"]
                name = namer(cand, digest, taken)
                # id 冲突防护：插件按「slug + mtime」发 id，撞了就换一个名字。
                mtime_ms = int(round(cand["path"].stat().st_mtime * 1000))
                n = 2
                while library.id_taken(name, mtime_ms):
                    base, ext = os.path.splitext(name)
                    name = "%s-%d%s" % (base, n, ext)
                    n += 1
                taken.add(name)
                entry["target"] = name
                entry["id"] = library_id(name, mtime_ms)
        plan.append(entry)
    return plan


def apply_plan(plan, library: Library, sources_log: Path, apply_flag: bool) -> list:
    """执行计划。只新建文件 —— 不删、不改名、不改已有文件的 mtime。"""
    records = []
    for entry in plan:
        cand = entry["candidate"]
        if entry["action"] != "import":
            continue
        target_name = entry["target"]
        target = library_target(library.root, target_name)
        if apply_flag:
            library.root.mkdir(parents=True, exist_ok=True)
            # copy2 保留 mtime ⇒ id 里的时间戳与源文件一致，稳定可复现。
            shutil.copy2(cand["path"], target)
        records.append({
            "ts": datetime.now(TZ_SG).isoformat(timespec="seconds"),
            "tool": TOOL_ID,
            "tool_version": TOOL_VERSION,
            "action": "imported" if apply_flag else "planned",
            "source": cand["source"],
            "source_name": cand["source_name"],
            "source_path": str(cand["path"]) if cand["path"] is not None else None,
            "source_url": cand["url"],
            "title": cand["title"],
            "license": cand["license"],
            "license_url": cand["license_url"],
            "kind": cand["kind"],
            "library": str(library.root),
            "file": target_name,
            "sha256": cand.get("sha256"),
            "bytes": cand.get("bytes"),
            "faststart": cand.get("faststart"),
            "id": library_id(target_name,
                             int(round(cand["path"].stat().st_mtime * 1000))),
            "detail": cand.get("detail") or {},
        })
    if apply_flag and records:
        write_provenance(sources_log, records)
    return records


def write_provenance(path: Path, records) -> None:
    """出处记录：JSONL，一行一条，追加写。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        for rec in records:
            fh.write(json.dumps(rec, ensure_ascii=False, sort_keys=True) + "\n")


# ── Wallpaper Engine ────────────────────────────────────────────────────────

#: WE 的项目种类（照插件 lib/wallpaper-scan.js 的 KINDS）
WE_KINDS = {"scene", "video", "web", "image", "application"}
#: WE 图片扩展名（照插件的 IMAGE_EXT_RE）
WE_IMAGE_EXT_RE = re.compile(r"\.(jpe?g|png|webp|gif|bmp|avif)$", re.I)
#: WE 幻灯片项目的切换档位 → 毫秒（照插件的 SLIDE_SWITCH_MS）
WE_SLIDE_SWITCH_MS = {1: 60000, 2: 300000, 3: 600000, 4: 1800000, 5: 3600000}
WE_SLIDE_MAX = 2000
WE_SLIDE_MAX_DEPTH = 3

#: 为什么 Scene / Web 不能当静态素材导入（写进输出，也写进文档）
SKIP_REASON = {
    "scene": "Scene 是实时渲染的场景（scene.pkg/scene.json + 材质 + 相机 + 脚本），"
             "静态文件只是它的零件；要看到效果得靠 WE 插件的渲染引擎",
    "web": "Web 壁纸是要跑 JS 的网页，必须靠 WE 插件的渲染引擎，静态文件不是它的样子",
    "application": "application 项目不是壁纸素材",
}


def we_infer_type(file: str) -> str:
    """从主文件名猜项目种类 —— 逐字照抄插件的 inferType。"""
    if re.search(r"\.(mp4|webm|mkv|avi|mov)$", file, re.I):
        return "video"
    if re.search(r"\.(html?|js)$", file, re.I):
        return "web"
    if WE_IMAGE_EXT_RE.search(file):
        return "image"
    return "scene"


def is_we_install_root(dir: Path) -> bool:
    """这个目录是不是 WE 安装根？

    ★ 照插件 `steam-discovery.js` 的 `WE_INSTALL_MARKERS`：经典布局把可执行文件放
      在根上，当前布局放在 `distribution/` 里。另外 `projects/` 是安装根一定有的
      目录（插件的 scanRootsP 就从它取扫描根），一并当标记。
    """
    for marker in ("wallpaper32.exe", "wallpaper64.exe",
                   "distribution/wallpaper32.exe", "distribution/wallpaper64.exe",
                   "distribution/version.json", "projects", "config.json"):
        if (dir / marker).exists():
            return True
    return False


def steam_libraries_from_vdf(vdf: Path) -> list:
    """从 `steamapps/libraryfolders.vdf` 里找出拥有 WE 的库。

    ★ 照插件 `steam-discovery.js` 的 `librariesFromVdfP`：逐行看 `"path" "..."`，
      之后的行里出现 appid 就说明这个库装了 WE。
    """
    try:
        text = vdf.read_text("utf-8", errors="replace")
    except OSError:
        return []
    libs = []
    current = None
    for line in text.splitlines():
        m = re.match(r'^\s*"path"\s+"([^"]+)"\s*$', line)
        if m:
            current = m.group(1).replace("\\\\", "\\")
            continue
        if current and WE_APPID in line:
            if current not in libs:
                libs.append(current)
    return libs


def default_steam_roots() -> list:
    """常见 Steam 安装位置（照插件的 STEAM_PROBE_DIRS + macOS 路径）。"""
    roots = []
    env = os.environ.get("DSH_WE_STEAM_ROOT", "")
    for part in re.split(r"[,;]", env):
        part = part.strip()
        if part:
            roots.append(Path(part))
    roots.extend([
        HOME / "Library" / "Application Support" / "Steam",
        HOME / ".steam" / "steam",
        HOME / ".steam" / "root",
        Path("/usr/local/share/Steam"),
        Path("/usr/share/steam"),
    ])
    return roots


def discover_we_targets(root: Path, quiet_missing: bool = False) -> dict:
    """从一个根目录推导出 WE 的安装根、创意工坊根与扫描根。

    返回 ``{install_roots, workshop_roots, scan_roots, notes}``。
    """
    notes = []
    install_roots = []
    workshop_roots = []
    libraries = []

    root = Path(root).expanduser()
    try:
        root = root.resolve()
    except OSError:
        pass
    if not root.exists():
        if not quiet_missing:
            notes.append("根目录不存在：%s" % root)
        return {"install_roots": [], "workshop_roots": [], "scan_roots": [], "notes": notes}

    # 1) 这个根自己就是一个库（有 steamapps/）
    if (root / "steamapps").is_dir():
        libraries.append(root)
    # 2) libraryfolders.vdf 里列的库
    vdf = root / "steamapps" / "libraryfolders.vdf"
    if vdf.is_file():
        for raw in steam_libraries_from_vdf(vdf):
            libraries.append(Path(raw).expanduser())
    # 3) 这个根自己就是 WE 安装根
    if is_we_install_root(root):
        install_roots.append(root)
    # 4) 每个库下的 steamapps/common/Wallpaper Engine 与创意工坊内容
    for lib in libraries:
        for name in ("Wallpaper Engine", "wallpaper_engine"):
            candidate = lib / "steamapps" / "common" / name
            if candidate.is_dir():
                install_roots.append(candidate)
        ws = lib / "steamapps" / "workshop" / "content" / WE_APPID
        if ws.is_dir():
            workshop_roots.append(ws)
    # 5) 这个根本身就是创意工坊内容目录（…/workshop/content/431960）
    if (root.name == WE_APPID and root.parent.name == "content"
            and root.parent.parent.name == "workshop"):
        workshop_roots.append(root)

    def dedup(items):
        seen = set()
        out = []
        for item in items:
            key = str(item)
            if key in seen:
                continue
            seen.add(key)
            out.append(item)
        return out

    install_roots = dedup(install_roots)
    workshop_roots = dedup(workshop_roots)

    # 扫描根：安装根下的 projects/{defaultprojects,myprojects} + content（兼容布局）
    #        与创意工坊内容根。
    scan_roots = []
    for inst in install_roots:
        for sub in ("projects/defaultprojects", "projects/myprojects", "content"):
            p = inst / sub
            if p.is_dir():
                scan_roots.append((p, "安装根/" + sub))
    for ws in workshop_roots:
        scan_roots.append((ws, "创意工坊"))
    if not install_roots and not workshop_roots:
        notes.append("在 %s 下没找到 WE 安装根（projects/、config.json）或创意工坊内容目录" % root)
    return {"install_roots": install_roots, "workshop_roots": workshop_roots,
            "scan_roots": scan_roots, "notes": notes}


def we_list_images(dir: Path):
    """递归列出目录下的图片（相对路径，自然序）—— 照插件的 listImages。"""
    out = []

    def walk(current: Path, prefix: str, depth: int):
        if len(out) >= WE_SLIDE_MAX:
            return
        try:
            entries = sorted(current.iterdir(), key=lambda p: p.name)
        except OSError:
            return
        for entry in entries:
            if entry.name.startswith("."):
                continue
            rel = (prefix + "/" + entry.name) if prefix else entry.name
            if entry.is_symlink():
                continue
            if entry.is_dir():
                if depth >= WE_SLIDE_MAX_DEPTH:
                    continue
                walk(entry, rel, depth + 1)
            elif entry.is_file() and WE_IMAGE_EXT_RE.search(entry.name):
                out.append(rel)

    walk(dir, "", 0)
    out.sort(key=lambda s: [int(t) if t.isdigit() else t.lower()
                            for t in re.split(r"(\d+)", s)])
    return out


def read_we_project(dir: Path):
    """读一个 WE 项目的 project.json —— 照插件的 readProjectP 的口径。

    返回 ``{id, title, type, file, slides, slide_interval_ms, preview}`` 或 None。
    """
    pj = dir / "project.json"
    if not pj.is_file():
        return None
    try:
        obj = json.loads(pj.read_text("utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(obj, dict):
        return None
    declared = str(obj.get("type") or "").lower()
    raw_file = obj.get("file")
    file = raw_file if isinstance(raw_file, str) and raw_file != "" else None
    slides = []
    interval = None
    if file:
        kind = declared if declared in WE_KINDS else we_infer_type(file)
        if kind == "image":
            slides = [file]
    else:
        # 单图 / 幻灯片项目：真身在 preset 里
        preset = obj.get("preset")
        if not isinstance(preset, dict):
            return None
        try:
            mode = int(preset.get("wallpapermode") or 0)
        except (TypeError, ValueError):
            mode = 0
        custom = str(preset.get("customdirectory") or "").strip()
        single = str(preset.get("image") or "").strip()
        if custom and mode in (1, 2):
            prefix = custom.replace("\\", "/").rstrip("/")
            try:
                base = safe_join(dir, custom)
            except PathEscape:
                return None
            for rel in we_list_images(base):
                slides.append((prefix + "/" + rel) if prefix else rel)
        elif single and WE_IMAGE_EXT_RE.search(single):
            try:
                if safe_join(dir, single).is_file():
                    slides.append(single)
            except PathEscape:
                return None
        if not slides:
            return None
        file = slides[0]
        kind = "image"
        try:
            switch = preset.get("imageswitchtimes")
            interval = WE_SLIDE_SWITCH_MS.get(int(switch)) if switch is not None else None
        except (TypeError, ValueError):
            interval = None
    return {
        "id": dir.name,
        "title": obj.get("title") if isinstance(obj.get("title"), str) else dir.name,
        "type": kind,
        "file": file,
        "slides": slides,
        "slide_interval_ms": interval,
        "preview": obj.get("preview") if isinstance(obj.get("preview"), str) else None,
    }


def we_project_videos(dir: Path, project: dict):
    """一个**视频**项目里的视频文件（声明的主文件 + 项目目录内的其它视频）。

    ★ 只在 type == video 的项目里找。Scene 项目的 assets/ 里的视频是**贴图**，
      不在这里面找（也不导）。
    """
    found = []
    seen = set()

    def add(path: Path):
        key = str(path)
        if key in seen:
            return
        seen.add(key)
        found.append(path)

    declared = project.get("file")
    if declared:
        try:
            target = safe_join(dir, declared)
        except PathEscape:
            target = None
        if target is not None and target.is_file() and target.suffix.lower() in VIDEO_EXT:
            add(target)
    # 项目目录内的其它视频（深度 ≤ 3，跳过隐藏文件与符号链接目录）
    def walk(current: Path, depth: int):
        if depth > 3:
            return
        try:
            entries = sorted(current.iterdir(), key=lambda p: p.name)
        except OSError:
            return
        for entry in entries:
            if entry.name.startswith("."):
                continue
            if entry.is_symlink():
                continue
            if entry.is_dir():
                walk(entry, depth + 1)
            elif entry.is_file() and entry.suffix.lower() in VIDEO_EXT:
                add(entry)

    walk(dir, 0)
    return found


def scan_we(root: Path, include_images: bool = False, quiet_missing: bool = False):
    """扫一个 WE 根，返回 (候选素材列表, 跳过清单, 目录信息)。"""
    info = discover_we_targets(root, quiet_missing=quiet_missing)
    candidates = []
    skipped = []
    seen_paths = set()

    for scan_root, role in info["scan_roots"]:
        try:
            entries = sorted(scan_root.iterdir(), key=lambda p: p.name)
        except OSError:
            continue
        for entry in entries:
            if not entry.is_dir() or entry.is_symlink():
                continue
            project = read_we_project(entry)
            if project is None:
                continue
            kind = project["type"]
            if kind == "video":
                for video in we_project_videos(entry, project):
                    key = str(video)
                    if key in seen_paths:
                        continue
                    seen_paths.add(key)
                    cand = make_candidate(
                        source="we",
                        source_name=project["id"],
                        path=video,
                        title=project["title"] or video.name,
                        kind="video",
                        license_text=LICENSE_WE,
                        detail={"we_project_id": project["id"], "we_root_role": role,
                                "we_project_type": kind,
                                "we_project_dir": str(entry),
                                "we_declared_file": project.get("file")},
                    )
                    cand["source_path_label"] = str(video)
                    candidates.append(cand)
            elif kind == "image":
                if not include_images:
                    skipped.append({
                        "kind": "图片壁纸", "id": project["id"], "title": project["title"],
                        "reason": "图片壁纸默认不导入（加 --include-images 才导首图）",
                    })
                    continue
                slides = project.get("slides") or []
                if not slides:
                    continue
                try:
                    target = safe_join(entry, slides[0])
                except PathEscape:
                    skipped.append({"kind": "图片壁纸", "id": project["id"],
                                    "title": project["title"],
                                    "reason": "首图路径越出项目目录，拒绝"})
                    continue
                if not target.is_file():
                    continue
                cand = make_candidate(
                    source="we", source_name=project["id"], path=target,
                    title=project["title"] or target.name, kind="image",
                    license_text=LICENSE_WE,
                    detail={"we_project_id": project["id"], "we_root_role": role,
                            "we_project_type": kind, "we_project_dir": str(entry),
                            "we_slide_count": len(slides)},
                )
                cand["source_path_label"] = str(target)
                candidates.append(cand)
                if len(slides) > 1:
                    skipped.append({"kind": "幻灯片分镜", "id": project["id"],
                                    "title": project["title"],
                                    "reason": "幻灯片其余 %d 张分镜未导入" % (len(slides) - 1)})
            elif kind in ("scene", "web", "application"):
                skipped.append({
                    "kind": {"scene": "Scene", "web": "Web",
                             "application": "Application"}[kind],
                    "id": project["id"], "title": project["title"],
                    "reason": SKIP_REASON[kind],
                })
            else:
                skipped.append({"kind": "未知", "id": project["id"],
                                "title": project["title"],
                                "reason": "认不出的项目类型 %r" % kind})
    return candidates, skipped, info


# ── 任意目录 ────────────────────────────────────────────────────────────────

def scan_dir(root: Path, exts=None, max_depth: int = 4):
    """扫一个目录里的可导入文件。"""
    exts = exts or IMPORTABLE_EXT
    out = []

    def walk(current: Path, depth: int):
        if depth > max_depth:
            return
        try:
            entries = sorted(current.iterdir(), key=lambda p: p.name)
        except OSError:
            return
        for entry in entries:
            if entry.name.startswith("."):
                continue
            if entry.is_symlink():
                continue
            if entry.is_dir():
                walk(entry, depth + 1)
            elif entry.is_file() and entry.suffix.lower() in exts:
                out.append(entry)

    walk(root, 0)
    return out


# ── 在线抓取 ────────────────────────────────────────────────────────────────

def dotted_get(obj, path: str):
    """按 `a.b.c` 取嵌套值。"""
    cur = obj
    for part in path.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return None
    return cur


def http_get(url: str, timeout: int = 30) -> bytes:
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "accept": "*/*",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def http_download(url: str, dest: Path, timeout: int = 60) -> int:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    total = 0
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        with dest.open("wb") as fh:
            while True:
                chunk = resp.read(256 * 1024)
                if not chunk:
                    break
                fh.write(chunk)
                total += len(chunk)
    return total


def fetch_source_items(spec: dict, query: str, limit: int, page: int):
    """按清单里的一条源规则抓候选条目。

    支持三种抓取方式：
      ``unsplash-napi``  Unsplash 的 JSON 接口（results[] / urls.raw）
      ``json-list``      通用 JSON 列表（items_path / image_path）
      ``html-meta``      服务端渲染的 HTML（抓 <meta itemprop="contentUrl">）

    ★ ``list_urls`` 是一串候选地址，按顺序试，第一个能出东西的就用它
      （Unsplash 的官方 API 要 key、免 key 的内部接口又被风控挡着 ⇒ 两手准备）。
    """
    templates = spec.get("list_urls")
    if not templates:
        templates = [spec["list_url"]]
    client_id = os.environ.get(spec.get("api_key_env", ""), "") if spec.get("api_key_env") else ""
    method = spec.get("method", "json-list")
    last_error = None
    for template in templates:
        url = template.format(query=urllib.parse.quote(query), limit=limit, page=page,
                              client_id=client_id)
        try:
            return _fetch_items_from(method, url, spec)
        except (urllib.error.URLError, OSError, ValueError, KeyError) as exc:
            last_error = exc
            continue
    raise last_error if last_error else ToolError("源 %s 没给 list_url" % spec.get("name"))


def _fetch_items_from(method: str, url: str, spec: dict):
    items = []
    if method == "html-meta":
        html = http_get(url).decode("utf-8", "replace")
        for m in re.finditer(r'<meta itemprop="contentUrl" content="([^"]+)"', html):
            items.append({"image_url": m.group(1), "page": url, "title": ""})
        return items, url
    data = json.loads(http_get(url).decode("utf-8", "replace"))
    if method == "unsplash-napi":
        for row in data.get("results") or []:
            raw = dotted_get(row, "urls.raw")
            if not raw:
                continue
            sep = "&" if "?" in raw else "?"
            items.append({
                "image_url": raw + sep + "fm=jpg&q=80&w=2560",
                "page": dotted_get(row, "links.html") or url,
                "title": dotted_get(row, "user.name") or "",
                "author": dotted_get(row, "user.name") or "",
            })
        return items, url
    # json-list
    rows = dotted_get(data, spec.get("items_path", "items")) or []
    for row in rows:
        image = dotted_get(row, spec.get("image_path", "url"))
        if not image:
            continue
        page_url = dotted_get(row, spec.get("page_path")) if spec.get("page_path") else None
        items.append({
            "image_url": image,
            "page": page_url or url,
            "title": str(dotted_get(row, spec.get("title_path")) or "") if spec.get("title_path") else "",
        })
    return items, url


def load_manifest(path: Path):
    try:
        obj = json.loads(Path(path).read_text("utf-8"))
    except (OSError, ValueError) as exc:
        raise ToolError("来源清单读不出来：%s（%s）" % (path, exc))
    sources = obj.get("sources")
    if not isinstance(sources, list):
        raise ToolError("来源清单格式不对：%s 里没有 sources 数组" % path)
    return obj


def pick_sources(manifest, wanted, enabled_only: bool):
    """挑出要抓的源。

    ★ 在线抓取**默认关闭**：清单里 enabled 不是 true 的源，只有在命令行用
      `--source <名>` 点名时才用；点名即视为显式开启。
    """
    out = []
    for spec in manifest.get("sources") or []:
        name = spec.get("name")
        if not name:
            continue
        if wanted:
            if name in wanted:
                out.append(spec)
        elif enabled_only and spec.get("enabled") is True:
            out.append(spec)
    if wanted:
        known = {s.get("name") for s in manifest.get("sources") or []}
        missing = [w for w in wanted if w not in known]
        if missing:
            raise ToolError("清单里没有这些源：%s（可用：%s）"
                            % (", ".join(missing), ", ".join(sorted(x for x in known if x))))
    return out


# ── 输出 ────────────────────────────────────────────────────────────────────

def report_we(info, library, args):
    print("=== Wallpaper Engine 素材导入 · %s ===" % ("真导入" if args.apply else "演练"))
    for note in info["notes"]:
        print("  ! %s" % note)
    for inst in info["install_roots"]:
        print("安装根：%s" % inst)
    for ws in info["workshop_roots"]:
        print("创意工坊根：%s" % ws)
    print("扫描根 %d 个：" % len(info["scan_roots"]))
    for root, role in info["scan_roots"]:
        print("   [%-18s] %s" % (role, root))
    print()


def report_plan(plan, library, args, skipped=None):
    imported = [e for e in plan if e["action"] == "import"]
    dupes = [e for e in plan if e["action"] == "duplicate"]
    opt = [e for e in plan if e["action"] == "optimized"]
    skip = [e for e in plan if e["action"] == "skip"]

    if imported:
        print("── 可导入 %d 个 ──" % len(imported))
        for entry in imported:
            cand = entry["candidate"]
            size = cand.get("bytes") or 0
            fs = cand.get("faststart")
            tag = "" if fs is None else ("  faststart" if fs else "  ★未 faststart")
            print("   %-42s %8.2f MiB%s" % (entry["target"], size / 1048576.0, tag))
            print("      来源：%s %s" % (cand["source"], cand["source_name"]))
    if dupes:
        print("── 内容重复 %d 个（不重复导入）──" % len(dupes))
        for entry in dupes:
            print("   %-42s %s" % (entry["candidate"]["title"], entry["reason"]))
    if opt:
        print("── 同一片子的【faststart 优化版】%d 个（★ 不覆盖已有文件，只报）──" % len(opt))
        for entry in opt:
            cand = entry["candidate"]
            print("   %-42s %s" % (cand["title"], entry["reason"]))
    if skip:
        print("── 跳过 %d 个 ──" % len(skip))
        for entry in skip:
            print("   %-42s %s" % (entry["candidate"]["title"], entry["reason"]))
    if skipped:
        counts = {}
        for item in skipped:
            counts.setdefault(item["kind"], []).append(item)
        print("── 跳过的项目 %d 个 ──" % len(skipped))
        for kind in sorted(counts):
            items = counts[kind]
            print("   %s × %d" % (kind, len(items)))
            print("      原因：%s" % items[0]["reason"])
            for item in items[1:3]:
                print("        · %s（%s）" % (item["id"], item["title"]))
    print()
    print("★ 素材库 %s：已有 %d 个" % (library.root, len(library.names)))
    print("★ 新素材 %d ｜ 重复 %d ｜ 优化版 %d ｜ 跳过 %d"
          % (len(imported), len(dupes), len(opt), len(skip) + len(skipped or [])))
    if not args.apply and imported:
        print("（这是演练；加 --apply 才真的导入）")


def warn_unserved(plan) -> None:
    """提醒：插件只认 6 种扩展名（lib/catalog.js 的 MEDIA_TYPES）。"""
    names = sorted({e["target"] for e in plan
                    if e["action"] == "import"
                    and os.path.splitext(e["target"])[1].lower() not in PLUGIN_SERVED_EXT})
    if names:
        print("★ 提醒：插件只服务 %s —— 下面这些文件在插件的列表里会被标成「不支持的扩展名」："
              % "、".join(sorted(PLUGIN_SERVED_EXT)))
        for name in names:
            print("     %s" % name)


# ── 命名器 ──────────────────────────────────────────────────────────────────

def we_namer(cand, digest, taken):
    stem = os.path.splitext(os.path.basename(cand["title"]))[0]
    ext = os.path.splitext(cand["path"].name)[1].lower()
    return propose_name("we", "%s-%s" % (cand["source_name"], stem), ext, taken, digest)


def dir_namer(cand, digest, taken):
    stem = os.path.splitext(os.path.basename(cand["title"]))[0]
    ext = os.path.splitext(cand["path"].name)[1].lower()
    return propose_name("dir", stem, ext, taken, digest)


def fetch_namer(cand, digest, taken):
    slug = re.sub(r"[^0-9a-z-]+", "-", str(cand["source_name"]).lower()).strip("-") or "src"
    ext = os.path.splitext(cand["path"].name)[1].lower()
    n = 1
    while True:
        name = "%s-%02d%s" % (slug, n, ext)
        if name not in taken:
            return name
        n += 1


def make_prefix_namer(prefix: str, keep_project_id: bool = False):
    """自定义前缀的命名器（--prefix）。"""
    def namer(cand, digest, taken):
        stem = os.path.splitext(os.path.basename(cand["title"]))[0]
        ext = os.path.splitext(cand["path"].name)[1].lower()
        if keep_project_id:
            stem = "%s-%s" % (cand["source_name"], stem)
        return propose_name(prefix, stem, ext, taken, digest)
    return namer


# ── 子命令 ──────────────────────────────────────────────────────────────────

def cmd_we(args) -> int:
    roots = []
    quiet = True
    if args.root:
        roots.append(Path(args.root))
        quiet = False
    else:
        roots.extend(default_steam_roots())
    candidates = []
    skipped = []
    infos = []
    seen_roots = set()
    for root in roots:
        key = str(root)
        if key in seen_roots:
            continue
        seen_roots.add(key)
        cands, skips, info = scan_we(root, include_images=args.include_images,
                                      quiet_missing=quiet)
        if not info["scan_roots"] and not info["notes"]:
            continue
        candidates.extend(cands)
        skipped.extend(skips)
        infos.append(info)
    if not candidates and not skipped:
        print("没找到任何 WE 目录。试：")
        print("  python3 import-media-sources.py we /path/to/steamapps")
        print("  python3 import-media-sources.py we /path/to/steamapps/workshop/content/431960")
        return 2
    library = Library(args.library)
    merged = {"notes": [], "install_roots": [], "workshop_roots": [], "scan_roots": []}
    for info in infos:
        merged["notes"].extend(info["notes"])
        merged["install_roots"].extend(info["install_roots"])
        merged["workshop_roots"].extend(info["workshop_roots"])
        merged["scan_roots"].extend(info["scan_roots"])
    report_we(merged, library, args)
    namer = make_prefix_namer(args.prefix, keep_project_id=True) if args.prefix else we_namer
    plan = plan_import(candidates, library, namer)
    report_plan(plan, library, args, skipped)
    warn_unserved(plan)
    records = apply_plan(plan, library, args.sources_log, args.apply)
    if args.apply and records:
        print("✔ 已导入 %d 个；出处记录：%s" % (len(records), args.sources_log))
    return 0


def cmd_dir(args) -> int:
    root = Path(args.directory).expanduser()
    if not root.is_dir():
        raise ToolError("目录不存在：%s" % root)
    files = scan_dir(root, max_depth=args.depth)
    candidates = []
    for f in files:
        cand = make_candidate(source="dir", source_name=str(root), path=f,
                              title=f.name, license_text=args.license or LICENSE_LOCAL)
        cand["source_path_label"] = str(f)
        candidates.append(cand)
    print("=== 目录素材导入 · %s ===" % ("真导入" if args.apply else "演练"))
    print("目录：%s" % root)
    print("扫到可导入文件 %d 个" % len(files))
    print()
    library = Library(args.library)
    namer = make_prefix_namer(args.prefix) if args.prefix else dir_namer
    plan = plan_import(candidates, library, namer)
    report_plan(plan, library, args)
    warn_unserved(plan)
    records = apply_plan(plan, library, args.sources_log, args.apply)
    if args.apply and records:
        print("✔ 已导入 %d 个；出处记录：%s" % (len(records), args.sources_log))
    return 0


def cmd_fetch(args) -> int:
    manifest = load_manifest(args.manifest)
    if args.list:
        print("=== 在线来源清单：%s ===" % args.manifest)
        note = manifest.get("note")
        if note:
            print(note)
        for spec in manifest.get("sources") or []:
            print()
            print("· %s" % spec.get("name"))
            print("   许可：%s" % spec.get("license"))
            if spec.get("license_url"):
                print("   许可页：%s" % spec["license_url"])
            print("   默认：%s" % ("开" if spec.get("enabled") else "关"))
            if spec.get("notes"):
                print("   备注：%s" % spec["notes"])
        return 0
    wanted = list(args.source or [])
    specs = pick_sources(manifest, wanted, enabled_only=not wanted)
    if not specs:
        print("★ 在线抓取默认关闭：清单里没有 enabled=true 的源。")
        print("  显式开启其中之一：--source <名字>（名字见 --list）")
        return 2
    print("=== 在线抓取 · %s ===" % ("真导入" if args.apply else "演练"))
    print("清单：%s" % args.manifest)
    print("抓取源：%s" % "、".join(s.get("name") for s in specs))
    print("（演练也会把候选图下载到临时目录算哈希 —— 不会写进素材库）")
    print()
    library = Library(args.library)
    candidates = []
    tmpdir = tempfile.mkdtemp(prefix="dsh-media-fetch-")
    try:
        for spec in specs:
            try:
                items, list_url = fetch_source_items(spec, args.query, args.limit, args.page)
            except (urllib.error.URLError, OSError, ValueError, KeyError) as exc:
                print("★ 源 %s 抓取失败：%s" % (spec.get("name"), exc))
                continue
            ext = spec.get("ext", ".jpg")
            for index, item in enumerate(items[: args.limit], start=1):
                tmp = Path(tmpdir) / ("%s-%03d%s" % (spec.get("name"), index, ext))
                try:
                    http_download(item["image_url"], tmp)
                except (urllib.error.URLError, OSError) as exc:
                    print("   下载失败 %s：%s" % (item["image_url"], exc))
                    continue
                cand = make_candidate(
                    source="fetch", source_name=spec.get("name"), path=tmp,
                    url=item["image_url"], title=item.get("title") or item["image_url"],
                    kind="image", license_text=spec.get("license") or "",
                    license_url=spec.get("license_url"),
                    detail={"source_page": item.get("page"), "list_url": list_url,
                            "author": item.get("author")},
                )
                cand["source_path_label"] = item["image_url"]
                candidates.append(cand)
        plan = plan_import(candidates, library, fetch_namer)
        report_plan(plan, library, args)
        records = apply_plan(plan, library, args.sources_log, args.apply)
        if args.apply and records:
            print("✔ 已导入 %d 个；出处记录：%s" % (len(records), args.sources_log))
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    return 0


# ── 命令行 ──────────────────────────────────────────────────────────────────

def add_common(parser, suppress=True):
    """公共开关。子命令上用 SUPPRESS ⇒ 父级与子级都能写，且不会互相覆盖。"""
    default = argparse.SUPPRESS if suppress else False
    parser.add_argument("--apply", action="store_true", default=default,
                        help="真导入（默认只演练，不写任何文件）")
    parser.add_argument("--dry-run", action="store_false", dest="apply", default=default,
                        help="只报告不写（默认行为）")
    parser.add_argument("--library",
                        default=argparse.SUPPRESS if suppress else str(DEFAULT_LIBRARY),
                        help="素材库目录（默认 %s）" % DEFAULT_LIBRARY)
    parser.add_argument("--sources-log", dest="sources_log",
                        default=argparse.SUPPRESS if suppress else str(DEFAULT_SOURCES_LOG),
                        help="出处记录文件（默认 %s）" % DEFAULT_SOURCES_LOG)
    parser.add_argument("--prefix", default=argparse.SUPPRESS if suppress else None,
                        help="新素材文件名前缀（默认按子命令：we/dir/src）")


def build_parser():
    ap = argparse.ArgumentParser(
        prog="import-media-sources.py",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description="外观媒体素材导入工具（WE / 任意目录 / 在线抓取）。",
        epilog=(
            "默认是演练（只报告不写）。加 --apply 才真导入。\n"
            "只加不删：不删除、不改名、不改已有素材的 mtime（素材 id = fs-<slug>-<mtime>）。\n"
            "出处记录默认写 %s（不写进素材库目录）。" % DEFAULT_SOURCES_LOG
        ),
    )
    add_common(ap, suppress=False)
    subs = ap.add_subparsers(dest="command", metavar="<子命令>")

    p_we = subs.add_parser("we", help="导入 Wallpaper Engine 的视频壁纸")
    p_we.add_argument("root", nargs="?", default=None,
                      help="WE 根目录（Steam 库根 / WE 安装根 / 创意工坊内容目录）；不给就自动探测")
    p_we.add_argument("--include-images", action="store_true",
                      help="连图片壁纸的首图一起导（默认不导）")
    add_common(p_we)
    p_we.set_defaults(func=cmd_we)

    p_dir = subs.add_parser("dir", help="批量导入任意目录里的视频/图片")
    p_dir.add_argument("directory", help="要导入的目录")
    p_dir.add_argument("--depth", type=int, default=4, help="递归深度上限（默认 4）")
    p_dir.add_argument("--license", default=None, help="写进出处记录的许可说明")
    add_common(p_dir)
    p_dir.set_defaults(func=cmd_dir)

    p_fetch = subs.add_parser("fetch", help="在线抓取（默认关闭，来源清单可编辑）")
    p_fetch.add_argument("--manifest", default=str(DEFAULT_MANIFEST),
                         help="来源清单 JSON（默认 %s）" % DEFAULT_MANIFEST)
    p_fetch.add_argument("--source", action="append", help="显式开启清单里的某个源（可重复）")
    p_fetch.add_argument("--query", default="nature", help="搜索词（默认 nature）")
    p_fetch.add_argument("--limit", type=int, default=5, help="每个源最多抓几张（默认 5）")
    p_fetch.add_argument("--page", type=int, default=1, help="页码（默认 1）")
    p_fetch.add_argument("--list", action="store_true", help="只打印来源清单")
    add_common(p_fetch)
    p_fetch.set_defaults(func=cmd_fetch)
    return ap


def main(argv=None) -> int:
    ap = build_parser()
    args = ap.parse_args(argv)
    if not getattr(args, "command", None):
        ap.print_help()
        return 0
    # 补齐被 SUPPRESS 掉的默认值
    if not hasattr(args, "apply"):
        args.apply = False
    if not hasattr(args, "library"):
        args.library = str(DEFAULT_LIBRARY)
    if not hasattr(args, "sources_log"):
        args.sources_log = str(DEFAULT_SOURCES_LOG)
    if not hasattr(args, "prefix"):
        args.prefix = None
    args.library = Path(args.library).expanduser()
    args.sources_log = Path(args.sources_log).expanduser()
    try:
        return args.func(args)
    except ToolError as exc:
        print("★ %s" % exc, file=sys.stderr)
        return 2
    except PathEscape as exc:
        print("★ 路径守卫拒绝：%s" % exc, file=sys.stderr)
        return 3


if __name__ == "__main__":
    sys.exit(main())
