#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""`import-media-sources.py` 的断言套件。

规矩（这个项目最硬的一条）：**每条断言都必须能变红**。所以本文件自带
「反向对照」机制 —— `--negative-controls` 会把实现复制一份、故意改坏一处、
再跑一遍本套件，**要求它必须失败**，并把实际的红字输出打出来。

跑法：

    python3 test-import-media-sources.py                  # 跑全部断言
    python3 test-import-media-sources.py -v               # 带用例名
    python3 test-import-media-sources.py --negative-controls   # 只跑反向对照

★ 本套件**只在自己的临时目录里干活**：素材库、出处记录、抓取用的 HTTP 服务
  全在 tempfile 里。真实的 `~/.dsh/dsh-appearance-media/media/` 一个字节都不碰
  （`TestNeverTouchesRealLibrary` 会静态检查实现里没有任何删除/改名/改 mtime
  的调用）。
"""
from __future__ import annotations

import argparse
import hashlib
import http.server
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
#: 被测实现的位置（反向对照时指向改坏的副本）
IMPORTER_PATH = Path(os.environ.get("IMPORTER_PATH") or (HERE / "import-media-sources.py"))
#: 真实素材库（★ 只读断言，绝不写）
REAL_LIBRARY = Path.home() / ".dsh" / "dsh-appearance-media" / "media"


def load_importer(path: Path = None):
    """按路径加载被测实现（文件名带横杠，只能用 importlib）。"""
    target = Path(path or IMPORTER_PATH).resolve()
    spec = importlib.util.spec_from_file_location("import_media_sources", str(target))
    if spec is None or spec.loader is None:
        raise ImportError("加载不了 %s" % target)
    module = importlib.util.module_from_spec(spec)
    sys.modules["import_media_sources"] = module
    spec.loader.exec_module(module)
    return module


IMP = load_importer()


# ── 小工具 ──────────────────────────────────────────────────────────────────

def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_path(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def snapshot_dir(root: Path) -> dict:
    """目录里每个文件的 (大小, mtime 纳秒, 内容哈希)。"""
    out = {}
    if not root.is_dir():
        return out
    for entry in sorted(root.iterdir(), key=lambda p: p.name):
        if entry.is_file():
            info = entry.stat()
            out[entry.name] = (info.st_size, info.st_mtime_ns, sha256_path(entry))
    return out


def snapshot_listing(root: Path) -> dict:
    """目录里每个文件的 (大小, mtime 纳秒) —— 不读内容，只看清单有没有被动过。"""
    out = {}
    if not root.is_dir():
        return out
    for entry in sorted(root.iterdir(), key=lambda p: p.name):
        if entry.is_file():
            info = entry.stat()
            out[entry.name] = (info.st_size, info.st_mtime_ns)
    return out


def resolved(paths) -> set:
    """一组路径的 resolve 形态（macOS 上 /var → /private/var，比对时要统一）。"""
    out = set()
    for p in paths:
        try:
            out.add(Path(p).resolve())
        except OSError:
            out.add(Path(p))
    return out


def make_video(path: Path, faststart: bool, size: str = "320x240") -> Path:
    """用 ffmpeg 造一个 2 秒 320x240 的 mp4。

    ★ 两次编码的参数完全一样 ⇒ 视频流逐字节相同，只有容器布局不同
      （一个 moov 在 mdat 后、一个在 mdat 前）⇒ 正好是「同一个片子的
      faststart 优化版」。
      传不同的 ``size`` ⇒ 是两个不同的片子（不会被认成优化版）。
    """
    cmd = ["ffmpeg", "-loglevel", "error", "-f", "lavfi",
           "-i", "testsrc=duration=2:size=%s:rate=10" % size,
           "-c:v", "libx264", "-pix_fmt", "yuv420p"]
    if faststart:
        cmd += ["-movflags", "+faststart"]
    cmd += ["-y", str(path)]
    subprocess.run(cmd, check=True, capture_output=True)
    return path


def make_image(path: Path, color: str = "red") -> Path:
    subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "lavfi",
                    "-i", "color=c=%s:s=64x64" % color, "-frames:v", "1", "-y", str(path)],
                   check=True, capture_output=True)
    return path


def write_project(path: Path, payload: dict) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    (path / "project.json").write_text(json.dumps(payload, ensure_ascii=False), "utf-8")
    return path


def run_cli(args, expect_code=None):
    """跑一次 CLI。★ 必须带 --library / --sources-log 指向临时目录。"""
    cmd = [sys.executable, str(IMPORTER_PATH)] + [str(a) for a in args]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if expect_code is not None and proc.returncode != expect_code:
        raise AssertionError("CLI 退出码 %d（期望 %d）\nstdout:\n%s\nstderr:\n%s"
                             % (proc.returncode, expect_code, proc.stdout, proc.stderr))
    return proc


def temp_paths(args, library: Path, log: Path):
    """给 CLI 拼上临时素材库与临时出处记录。"""
    return list(args) + ["--library", str(library), "--sources-log", str(log)]


# ── 夹具 ────────────────────────────────────────────────────────────────────

class WeFixture:
    """一套假的 Wallpaper Engine 目录结构。

    ★ 照真实布局造（``root`` = Steam 库根）：
      <root>/steamapps/common/Wallpaper Engine/{config.json, projects/…, content/…}
      <root>/steamapps/workshop/content/431960/<id>/project.json
    """

    def __init__(self, root: Path):
        self.root = root
        self.install = root / "steamapps" / "common" / "Wallpaper Engine"
        self.workshop = root / "steamapps" / "workshop" / "content" / "431960"
        self.build()

    def build(self):
        self.install.mkdir(parents=True, exist_ok=True)
        (self.install / "config.json").write_text("{}", "utf-8")

        # ① 安装根 · 默认项目里的视频壁纸
        d = write_project(self.install / "projects" / "defaultprojects" / "vid-default",
                          {"type": "video", "file": "video.mp4", "title": "默认视频"})
        make_video(d / "video.mp4", faststart=True)

        # ② 安装根 · 我的项目里的视频壁纸（webm）
        d = write_project(self.install / "projects" / "myprojects" / "vid-mine",
                          {"type": "video", "file": "clip.webm", "title": "我的项目"})
        (d / "clip.webm").write_bytes(b"\x1a\x45\xdf\xa3fake-webm-bytes")

        # ③ 安装根 · content/ 下的视频壁纸（用户描述的布局）
        d = write_project(self.install / "content" / "vid-content",
                          {"type": "video", "file": "video.mp4", "title": "content 视频"})
        (d / "video.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42fake-mp4")

        # ④ 创意工坊 · 视频壁纸
        d = write_project(self.workshop / "2003-video",
                          {"type": "video", "file": "movie.mp4", "title": "工坊视频"})
        (d / "movie.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42workshop-mp4")

        # ⑤ 创意工坊 · Scene 壁纸（**必须跳过**），assets/ 里还有贴图与视频贴图
        d = write_project(self.workshop / "2001-scene",
                          {"type": "scene", "file": "scene.pkg", "title": "场景壁纸"})
        (d / "scene.pkg").write_bytes(b"PKG-scene-bytes")
        (d / "assets").mkdir(exist_ok=True)
        (d / "assets" / "texture.jpg").write_bytes(b"JPEG-texture")
        (d / "assets" / "video-tex.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42texture")

        # ⑥ 创意工坊 · Web 壁纸（**必须跳过**）
        d = write_project(self.workshop / "2002-web",
                          {"type": "web", "file": "index.html", "title": "网页壁纸"})
        (d / "index.html").write_text("<html></html>", "utf-8")

        # ⑦ 创意工坊 · 图片壁纸（默认不导）
        d = write_project(self.workshop / "2005-image",
                          {"type": "image", "file": "pic.jpg", "title": "图片壁纸"})
        (d / "pic.jpg").write_bytes(b"JPEG-picture")

        # ⑧ 创意工坊 · 越界的 project.json（file 指到项目目录外）⇒ 必须被路径守卫拒绝
        d = write_project(self.workshop / "2004-evil",
                          {"type": "video", "file": "../../../../evil.mp4", "title": "越界项目"})
        evil = self.root / "steamapps" / "evil.mp4"
        evil.parent.mkdir(parents=True, exist_ok=True)
        evil.write_bytes(b"\x00\x00\x00\x18ftypmp42EVIL")


# ── 用例 ────────────────────────────────────────────────────────────────────

class TestWeDetection(unittest.TestCase):
    """WE 目录识别：认得出视频、跳得过场景。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-mt-we-"))
        self.fixture = WeFixture(self.tmp)
        self.lib = self.tmp / "lib"
        self.log = self.tmp / "sources.jsonl"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_finds_install_and_workshop_roots(self):
        info = IMP.discover_we_targets(self.fixture.root)
        self.assertIn(self.fixture.install.resolve(),
                      resolved(info["install_roots"]))
        self.assertIn(self.fixture.workshop.resolve(),
                      resolved(info["workshop_roots"]))
        roles = [role for _root, role in info["scan_roots"]]
        self.assertIn("安装根/projects/defaultprojects", roles)
        self.assertIn("安装根/projects/myprojects", roles)
        self.assertIn("安装根/content", roles)
        self.assertIn("创意工坊", roles)

    def test_recognizes_videos_and_skips_scenes(self):
        candidates, skipped, _info = IMP.scan_we(self.fixture.root)
        names = sorted(c["source_name"] for c in candidates)
        self.assertEqual(names, ["2003-video", "vid-content", "vid-default", "vid-mine"])
        self.assertTrue(all(c["kind"] == "video" for c in candidates))

        skipped_kinds = {}
        for item in skipped:
            skipped_kinds.setdefault(item["kind"], []).append(item["id"])
        self.assertIn("2001-scene", skipped_kinds.get("Scene", []))
        self.assertIn("2002-web", skipped_kinds.get("Web", []))
        for item in skipped:
            if item["id"] == "2001-scene":
                self.assertIn("渲染", item["reason"])

    def test_skips_scene_textures_and_video_textures(self):
        candidates, _skipped, _info = IMP.scan_we(self.fixture.root)
        paths = [str(c["path"]) for c in candidates]
        self.assertFalse([p for p in paths if "texture" in p],
                         "场景里的贴图/视频贴图不该被当成素材")
        self.assertFalse([p for p in paths if "video-tex" in p])

    def test_rejects_project_file_pointing_outside(self):
        candidates, _skipped, _info = IMP.scan_we(self.fixture.root)
        paths = [str(c["path"]) for c in candidates]
        self.assertFalse([p for p in paths if "evil.mp4" in p],
                         "越界的 project.json 必须被路径守卫挡住")

    def test_cli_dry_run_never_writes(self):
        proc = run_cli(temp_paths(["we", str(self.fixture.root)], self.lib, self.log))
        self.assertEqual(proc.returncode, 0)
        self.assertFalse(self.lib.exists(), "演练不该建出素材库目录")
        self.assertFalse(self.log.exists(), "演练不该写出处记录")
        self.assertIn("可导入", proc.stdout)


class TestDirImport(unittest.TestCase):
    """目录导入：视频/图片能导、重复不导、优化版认得出。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-mt-dir-"))
        self.src = self.tmp / "src"
        self.src.mkdir()
        self.lib = self.tmp / "lib"
        self.log = self.tmp / "sources.jsonl"
        self.base = make_video(self.src / "clip.mp4", faststart=False)
        self.opt = make_video(self.src / "clip-fast.mp4", faststart=True)
        make_image(self.src / "photo.jpg")
        (self.src / "notes.txt").write_text("不是素材", "utf-8")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _plan(self):
        files = IMP.scan_dir(self.src)
        candidates = []
        for f in files:
            cand = IMP.make_candidate(source="dir", source_name=str(self.src), path=f,
                                      title=f.name)
            cand["source_path_label"] = str(f)
            candidates.append(cand)
        return IMP.plan_import(candidates, IMP.Library(self.lib), IMP.dir_namer)

    def test_fixture_really_is_faststart_pair(self):
        """先证明夹具本身成立：base 非 faststart，opt 是 faststart，且是同一个片子。"""
        self.assertFalse(IMP.faststart(self.base))
        self.assertTrue(IMP.faststart(self.opt))
        self.assertTrue(IMP.same_video(IMP.probe(self.base), IMP.probe(self.opt)))

    def test_imports_video_and_image_only(self):
        plan = self._plan()
        imported = sorted(e["target"] for e in plan if e["action"] == "import")
        self.assertEqual(len(imported), 3, "应当导入 2 个视频 + 1 张图：%s" % imported)
        self.assertTrue(any(t.endswith(".mp4") for t in imported))
        self.assertTrue(any(t.endswith(".jpg") for t in imported))
        self.assertFalse(any(t.endswith(".txt") for t in imported), "txt 不是素材")

    def test_duplicate_content_is_not_reimported(self):
        self.lib.mkdir(parents=True)
        shutil.copy2(self.base, self.lib / "already-there.mp4")
        plan = self._plan()
        dupes = [e for e in plan if e["action"] == "duplicate"]
        self.assertEqual(len(dupes), 1)
        self.assertIn("already-there.mp4", dupes[0]["reason"])
        self.assertNotIn("already-there.mp4",
                         [e["target"] for e in plan if e["action"] == "import"])

    def test_faststart_variant_is_classified_as_optimized_not_new(self):
        """★ 库里那份没做 faststart、候选那份做了 ⇒ 认成「优化版」，不是「真新素材」。"""
        self.lib.mkdir(parents=True)
        shutil.copy2(self.base, self.lib / "ours.mp4")
        # 候选目录里只放那个「优化版」
        src2 = self.tmp / "src2"
        src2.mkdir()
        shutil.copy2(self.opt, src2 / "clip-fast.mp4")
        candidates = []
        for f in IMP.scan_dir(src2):
            cand = IMP.make_candidate(source="dir", source_name=str(src2), path=f,
                                      title=f.name)
            cand["source_path_label"] = str(f)
            candidates.append(cand)
        plan = IMP.plan_import(candidates, IMP.Library(self.lib), IMP.dir_namer)
        self.assertEqual(len(plan), 1)
        entry = plan[0]
        self.assertEqual(entry["action"], "optimized",
                         "优化版不能被当成新素材：%s" % entry["reason"])
        self.assertIsNone(entry["target"], "优化版不该有导入目标（不覆盖已有文件）")
        self.assertIn("ours.mp4", entry["reason"])

    def test_apply_writes_files_and_records(self):
        proc = run_cli(temp_paths(["dir", str(self.src), "--apply"], self.lib, self.log),
                       expect_code=0)
        self.assertTrue(self.lib.is_dir())
        names = sorted(p.name for p in self.lib.iterdir())
        self.assertEqual(len(names), 3)
        self.assertIn("✔ 已导入 3 个", proc.stdout)


class TestNoDeleteNoModify(unittest.TestCase):
    """★ 不删不改：库里的文件导入前后逐字节没变。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-mt-nodel-"))
        self.src = self.tmp / "src"
        self.src.mkdir()
        self.lib = self.tmp / "lib"
        self.lib.mkdir()
        self.log = self.tmp / "sources.jsonl"
        make_video(self.src / "new.mp4", faststart=True)
        make_image(self.src / "new.jpg", color="blue")
        # 库里的两条是**另一个**片子（分辨率 / 颜色都不同）⇒ 不会被认成「优化版」或重复
        shutil.copy2(make_video(self.tmp / "keep-src.mp4", faststart=False,
                                 size="640x480"),
                     self.lib / "keep.mp4")
        shutil.copy2(make_image(self.tmp / "keep-src.jpg", color="red"),
                     self.lib / "keep.jpg")
        # 固定 mtime，避免测试自己引入抖动
        os.utime(self.lib / "keep.mp4", (1000000, 1000000))
        os.utime(self.lib / "keep.jpg", (2000000, 2000000))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_existing_files_are_byte_identical_after_import(self):
        before = snapshot_dir(self.lib)
        run_cli(temp_paths(["dir", str(self.src), "--apply"], self.lib, self.log),
                expect_code=0)
        after = snapshot_dir(self.lib)
        for name in ("keep.mp4", "keep.jpg"):
            self.assertIn(name, after)
            self.assertEqual(before[name], after[name],
                             "%s 被改了（大小/时间戳/内容变了）" % name)
        self.assertEqual(len(after), 4, "只应该新增 2 个文件")

    def test_never_overwrites_an_existing_file(self):
        """同名文件已在库里 ⇒ 必须另起名字，不许覆盖。"""
        # 同名但**内容不同** ⇒ 不是重复，是真冲突：必须另起一个名字
        (self.lib / "dir-new.mp4").write_bytes(b"COMPLETELY DIFFERENT BYTES")
        keep = (self.lib / "dir-new.mp4").read_bytes()
        run_cli(temp_paths(["dir", str(self.src), "--apply"], self.lib, self.log),
                expect_code=0)
        self.assertEqual((self.lib / "dir-new.mp4").read_bytes(), keep,
                         "已有文件被覆盖了")
        self.assertTrue(any(p.name.startswith("dir-new-") for p in self.lib.iterdir()),
                        "冲突时应该另起一个名字")

    def test_tool_source_contains_no_delete_rename_or_utime(self):
        """★ 静态检查：实现里没有任何删除 / 改名 / 改 mtime 的调用。"""
        source = IMPORTER_PATH.read_text("utf-8")
        for needle in ("os.remove(", "os.unlink(", ".unlink()", "os.rename(",
                       "os.replace(", "shutil.move(", "os.utime(", "os.utimes(",
                       "shutil.copy("):
            self.assertNotIn(needle, source,
                             "实现里出现了 %r —— 工具只许加不许动已有文件" % needle)
        # 唯一允许的删除是抓取时的临时目录
        for line in source.splitlines():
            if "rmtree" in line:
                self.assertIn("tmpdir", line,
                              "rmtree 只能对着 tempfile.mkdtemp 出来的临时目录：%s" % line)
        # 写入素材库只能用 copy2（保留 mtime ⇒ id 不变）
        self.assertIn("shutil.copy2(", source)


class TestPathGuard(unittest.TestCase):
    """★ 路径守卫：能逃出素材目录的路径一律拒绝。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-mt-guard-"))
        self.base = self.tmp / "project"
        self.base.mkdir()
        self.lib = self.tmp / "lib"
        self.lib.mkdir()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_relative_traversal_rejected(self):
        with self.assertRaises(IMP.PathEscape):
            IMP.safe_join(self.base, "../../etc/passwd")
        with self.assertRaises(IMP.PathEscape):
            IMP.safe_join(self.base, "..\\..\\windows\\system32")

    def test_absolute_path_rejected(self):
        with self.assertRaises(IMP.PathEscape):
            IMP.safe_join(self.base, "/etc/passwd")

    def test_symlink_escape_rejected(self):
        outside = self.tmp / "outside.mp4"
        outside.write_bytes(b"x")
        link = self.base / "link.mp4"
        os.symlink(str(outside), str(link))
        with self.assertRaises(IMP.PathEscape):
            IMP.safe_join(self.base, "link.mp4")

    def test_library_target_rejects_escaping_names(self):
        with self.assertRaises(IMP.PathEscape):
            IMP.library_target(self.lib, "../evil.mp4")
        with self.assertRaises(IMP.PathEscape):
            IMP.library_target(self.lib, "sub/evil.mp4")
        with self.assertRaises(IMP.PathEscape):
            IMP.library_target(self.lib, ".hidden.mp4")

    def test_library_target_accepts_plain_name(self):
        target = IMP.library_target(self.lib, "ok.mp4")
        self.assertEqual(target.parent.resolve(), self.lib.resolve())


class TestProvenance(unittest.TestCase):
    """★ 出处记录：每导入一条都有一行，带许可与哈希。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-mt-prov-"))
        self.src = self.tmp / "src"
        self.src.mkdir()
        self.lib = self.tmp / "lib"
        self.log = self.tmp / "sources.jsonl"
        make_image(self.src / "shot.jpg")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_record_has_license_and_hash(self):
        run_cli(temp_paths(["dir", str(self.src), "--apply", "--license", "CC0 测试许可"],
                           self.lib, self.log), expect_code=0)
        self.assertTrue(self.log.is_file(), "出处记录没写出来")
        lines = [json.loads(x) for x in self.log.read_text("utf-8").splitlines() if x.strip()]
        self.assertEqual(len(lines), 1)
        row = lines[0]
        self.assertEqual(row["license"], "CC0 测试许可")
        self.assertEqual(row["file"], (self.lib / "dir-shot.jpg").name)
        self.assertEqual(row["sha256"], sha256_path(self.lib / row["file"]))
        self.assertEqual(row["bytes"], (self.lib / row["file"]).stat().st_size)
        self.assertIn("ts", row)
        self.assertIn("+08:00", row["ts"], "时间戳按约定用新加坡时间（UTC+8）")

    def test_record_is_outside_the_library(self):
        run_cli(temp_paths(["dir", str(self.src), "--apply"], self.lib, self.log),
                expect_code=0)
        self.assertFalse((self.lib / "sources.jsonl").exists(),
                         "出处记录不许写进素材库目录本身")
        self.assertTrue(self.log.is_file())

    def test_dry_run_writes_no_record(self):
        run_cli(temp_paths(["dir", str(self.src)], self.lib, self.log), expect_code=0)
        self.assertFalse(self.log.exists())


class TestFetch(unittest.TestCase):
    """在线抓取：默认关闭；显式开启后按清单抓，并把出处 URL 与许可写进记录。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="dsh-mt-fetch-"))
        self.lib = self.tmp / "lib"
        self.log = self.tmp / "sources.jsonl"
        # 两张图内容不同 ⇒ 都能被导入（内容相同的那张会被去重）
        self.payloads = {
            "/img/a.jpg": b"\xff\xd8\xff\xe0fake-jpeg-A",
            "/img/b.jpg": b"\xff\xd8\xff\xe0fake-jpeg-B",
        }
        self.server = None
        self.thread = None

    def tearDown(self):
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()
        if self.thread is not None:
            self.thread.join(timeout=5)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _serve(self):
        holder = {}

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):  # 静音
                pass

            def do_GET(self):
                if self.path.startswith("/list.json"):
                    body = json.dumps({"items": [
                        {"url": "%s/img/a.jpg" % holder["base"], "page": "%s/page/a" % holder["base"]},
                        {"url": "%s/img/b.jpg" % holder["base"], "page": "%s/page/b" % holder["base"]},
                    ]}).encode()
                    ctype = "application/json"
                else:
                    body = holder["payloads"].get(self.path, b"")
                    ctype = "image/jpeg"
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        holder["base"] = "http://127.0.0.1:%d" % self.server.server_port
        holder["payloads"] = self.payloads
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return holder["base"]

    def _manifest(self, base, enabled):
        spec = {
            "name": "fixture",
            "enabled": enabled,
            "license": "CC0 测试许可（本地夹具）",
            "license_url": "https://example.invalid/license",
            "method": "json-list",
            "items_path": "items",
            "image_path": "url",
            "list_url": base + "/list.json?query={query}&limit={limit}&page={page}",
            "ext": ".jpg",
        }
        path = self.tmp / "manifest.json"
        path.write_text(json.dumps({"version": 1, "sources": [spec]}, ensure_ascii=False),
                        "utf-8")
        return path

    def test_fetch_is_off_by_default(self):
        base = self._serve()
        manifest = self._manifest(base, enabled=False)
        proc = run_cli(temp_paths(["fetch", "--manifest", str(manifest)], self.lib, self.log))
        self.assertEqual(proc.returncode, 2)
        self.assertIn("默认关闭", proc.stdout)
        self.assertFalse(self.lib.exists())

    def test_explicit_source_enables_fetch_and_records_license_and_url(self):
        base = self._serve()
        manifest = self._manifest(base, enabled=False)
        proc = run_cli(temp_paths(["fetch", "--manifest", str(manifest),
                                   "--source", "fixture", "--limit", "2", "--apply"],
                                  self.lib, self.log), expect_code=0)
        names = sorted(p.name for p in self.lib.iterdir())
        self.assertEqual(len(names), 2, "应当抓到 2 张：%s" % proc.stdout)
        rows = [json.loads(x) for x in self.log.read_text("utf-8").splitlines() if x.strip()]
        self.assertEqual(len(rows), 2)
        known = {sha256_bytes(v) for v in self.payloads.values()}
        for row in rows:
            self.assertEqual(row["license"], "CC0 测试许可（本地夹具）")
            self.assertEqual(row["license_url"], "https://example.invalid/license")
            self.assertTrue(row["source_url"].startswith(base))
            self.assertIn(row["sha256"], known)
            self.assertEqual(row["sha256"], sha256_path(self.lib / row["file"]))
            self.assertEqual(row["source"], "fetch")

    def test_fetch_dedupes_by_content(self):
        base = self._serve()
        manifest = self._manifest(base, enabled=True)
        run_cli(temp_paths(["fetch", "--manifest", str(manifest), "--limit", "2", "--apply"],
                           self.lib, self.log), expect_code=0)
        first = sorted(p.name for p in self.lib.iterdir())
        run_cli(temp_paths(["fetch", "--manifest", str(manifest), "--limit", "2", "--apply"],
                           self.lib, self.log), expect_code=0)
        second = sorted(p.name for p in self.lib.iterdir())
        self.assertEqual(first, second, "第二遍应当全部判为重复，不该再导入")


class TestNeverTouchesRealLibrary(unittest.TestCase):
    """★ 真实素材库是用户数据：测试一次都不许碰。"""

    def setUp(self):
        self.before = snapshot_listing(REAL_LIBRARY)

    def tearDown(self):
        after = snapshot_listing(REAL_LIBRARY)
        self.assertEqual(self.before, after,
                         "真实素材库 %s 的文件清单变了 —— 测试碰了用户数据" % REAL_LIBRARY)

    def test_real_library_exists_and_is_untouched(self):
        self.assertTrue(REAL_LIBRARY.is_dir(), "真实素材库不在？%s" % REAL_LIBRARY)

    def test_suite_never_targets_the_real_library(self):
        source = Path(__file__).resolve().read_text("utf-8")
        # 结构性保证：每一次 CLI 调用都必须经过 temp_paths（它强制带临时 --library）
        self.assertIn("def temp_paths(", source)
        # 逐行看：真实素材库从不出现在任何「写/执行」路径上
        danger = ("run_cli", "temp_paths", "shutil.", "write_bytes", "write_text",
                  "unlink", "rmtree", "--library")
        for line in source.splitlines():
            if "REAL_LIBRARY" not in line or "assert" in line:
                continue
            for needle in danger:
                self.assertNotIn(needle, line,
                                 "真实素材库出现在执行路径上（%r）：%s" % (needle, line))


# ── 反向对照：把实现改坏，套件必须变红 ──────────────────────────────────────

#: 每个变异 = (名字, [(原文, 替换), …])。原文必须**只出现一次**。
MUTATIONS = [
    ("M1 · faststart 判定坏掉（优化版认不出来）", [
        ("        return order.index(\"moov\") < order.index(\"mdat\")",
         "        return None"),
    ]),
    ("M2 · 内容哈希去重坏掉（重复文件会重复导入）", [
        ("    if digest in library.by_hash:\n"
         "        return \"duplicate\", \"内容与库里已有文件逐字节相同（%s）\" % library.by_hash[digest].name",
         "    if False:\n"
         "        return \"duplicate\", \"内容与库里已有文件逐字节相同（%s）\" % library.by_hash[digest].name"),
    ]),
    ("M3 · 路径守卫坏掉（目录穿越放行）", [
        ("    if any(part == \"..\" for part in raw.split(\"/\")):\n"
         "        raise PathEscape(\"上级目录穿越：%s\" % relative)\n"
         "    target = (base / raw).resolve()\n"
         "    if not is_within(base, target):\n"
         "        raise PathEscape(\"越出项目目录：%s\" % relative)",
         "    target = (base / raw).resolve()"),
    ]),
    ("M4 · 命名不避让（会覆盖已有文件）", [
        ("    cand = \"%s-%s%s\" % (prefix, base, ext)\n"
         "    n = 2\n"
         "    while cand in taken:\n"
         "        cand = \"%s-%s-%d%s\" % (prefix, base, n, ext)\n"
         "        n += 1\n"
         "    return cand",
         "    return \"%s-%s%s\" % (prefix, base, ext)"),
    ]),
    ("M5 · 顺手 prune（会删掉库里已有文件）", [
        ("    if apply_flag and records:\n"
         "        write_provenance(sources_log, records)",
         "    if apply_flag and records:\n"
         "        for old in list(library.root.iterdir()):\n"
         "            if old.is_file() and old.name not in [r[\"file\"] for r in records]:\n"
         "                old.unlink()\n"
         "        write_provenance(sources_log, records)"),
    ]),
    ("M6 · 出处记录不写", [
        ("    if apply_flag and records:\n"
         "        write_provenance(sources_log, records)",
         "    if False and records:\n"
         "        write_provenance(sources_log, records)"),
    ]),
    ("M7 · 演练也真写（默认不是演练）", [
        ("        if apply_flag:\n"
         "            library.root.mkdir(parents=True, exist_ok=True)",
         "        if True:\n"
         "            library.root.mkdir(parents=True, exist_ok=True)"),
    ]),
    ("M8 · Scene 壁纸不再跳过（场景里的素材会被误导）", [
        ("            if kind == \"video\":",
         "            if kind in (\"video\", \"scene\", \"web\"):"),
    ]),
]


def run_negative_controls() -> int:
    """每个变异跑一遍套件，要求**必须失败**。"""
    source = IMPORTER_PATH.read_text("utf-8")
    failures = []
    print("=" * 78)
    print("反向对照：把实现改坏，套件必须变红")
    print("=" * 78)
    for name, edits in MUTATIONS:
        mutated = source
        ok = True
        for old, new in edits:
            count = mutated.count(old)
            if count != 1:
                print("\n★ %s：变异锚点命中 %d 次（必须恰好 1 次）—— 变异本身坏了" % (name, count))
                ok = False
                break
            mutated = mutated.replace(old, new)
        if not ok:
            failures.append(name)
            continue
        workdir = Path(tempfile.mkdtemp(prefix="dsh-negctl-"))
        try:
            mutant = workdir / "import-media-sources.py"
            mutant.write_text(mutated, "utf-8")
            env = dict(os.environ)
            env["IMPORTER_PATH"] = str(mutant)
            env["DSH_SKIP_NEGCTL"] = "1"
            proc = subprocess.run([sys.executable, str(Path(__file__).resolve())],
                                  env=env, capture_output=True, text=True, timeout=900)
            if proc.returncode == 0:
                print("\n★ %s：套件居然全绿 —— 这条变异没被任何断言抓住" % name)
                failures.append(name)
                continue
            red = [line for line in proc.stderr.splitlines()
                   if line.startswith(("FAIL:", "ERROR:")) or "Ran " in line
                   or line.startswith("FAILED")]
            print("\n--- %s ---" % name)
            for line in red[:12]:
                print("    " + line)
        finally:
            shutil.rmtree(workdir, ignore_errors=True)
    print()
    print("=" * 78)
    if failures:
        print("★ 反向对照失败 %d 项：%s" % (len(failures), "；".join(failures)))
        return 1
    print("★ 反向对照全部通过：%d 个变异，每一个都让套件变红。" % len(MUTATIONS))
    return 0


# ── 入口 ────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description="import-media-sources.py 的断言套件")
    ap.add_argument("-v", "--verbose", action="count", default=1)
    ap.add_argument("--negative-controls", action="store_true",
                    help="只跑反向对照（把实现改坏，要求套件变红）")
    args = ap.parse_args()

    if args.negative_controls:
        return run_negative_controls()

    if os.environ.get("DSH_SKIP_NEGCTL") == "1":
        # 反向对照的子进程：别再递归跑反向对照
        loader = unittest.TestLoader()
        suite = loader.loadTestsFromModule(sys.modules[__name__])
        result = unittest.TextTestRunner(verbosity=args.verbose).run(suite)
        return 0 if result.wasSuccessful() else 1

    loader = unittest.TestLoader()
    suite = loader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(verbosity=args.verbose).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
