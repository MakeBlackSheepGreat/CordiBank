# -*- coding: utf-8 -*-
"""把当前工作树打包成交付用源代码 zip。"""
import os, sys, zipfile, hashlib

ROOT = os.path.abspath(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TOP = "CordiBank-面向金融的蜂群智能体系统"
OUT = os.path.join(ROOT, "deliverables", "面向金融的蜂群智能体系统-源代码与部署材料-v1.0.0.zip")

# 顶层排除目录
SKIP_TOP = {
    ".git", ".github-cache", "deliverables", "shots", "_scratch", "node_modules",
    ".work", ".shot-tmp", ".render-tmp", ".uitest", ".local", ".dsh-ops", ".dsh-src-tmp",
    "bank-agent-starter", "NVIDIA Corporation", ".slidep", ".intent-eval-tmp",
    ".demo-store", ".ops-sandbox", ".realtest", ".test-tmp", ".smoke-tmp",
    "runtime/cordibank-test-tmp",
}
# 任意层级排除的目录名
SKIP_ANY = {"node_modules", ".git", "store", ".slidep", ".vitest-cache", "pack-deps",
            ".electron-cache", "release", "cordibank-test-tmp", ".test-tmp", ".probe"}
# 排除的顶层文件
SKIP_FILES = {".eval-report.json", ".redteam-out.txt"}
# 排除的路径后缀/相对路径
SKIP_REL = {
    "runtime/pnpm-lock.yaml", "runtime/pnpm-workspace.yaml",
    "web/.shot.mjs", "web/verify-stream.mjs", "web/.vscode",
    "docs/screenshots", "runtime/.gate.txt", "runtime/.gate2.txt",
    "runtime/.gate3.txt", "runtime/.gate4.txt",
}
# runtime/dist 是构建产物，源码包不带（部署说明要求自行构建）；web/dist 随包发布
SKIP_PREFIX = {"runtime/dist"}

def rel(p):
    return os.path.relpath(p, ROOT).replace("\\", "/")

def skipped(relpath):
    parts = relpath.split("/")
    if parts[0] in SKIP_TOP:
        return True
    for seg in parts:
        if seg in SKIP_ANY:
            return True
    if relpath in SKIP_FILES or relpath in SKIP_REL:
        return True
    for pref in SKIP_PREFIX:
        if relpath == pref or relpath.startswith(pref + "/"):
            return True
    for item in SKIP_REL:
        if relpath == item or relpath.startswith(item + "/"):
            return True
    return False

files = []
dirs = set()
for dirpath, dirnames, filenames in os.walk(ROOT):
    dirnames[:] = sorted(d for d in dirnames if d not in SKIP_ANY)
    for name in sorted(filenames):
        full = os.path.join(dirpath, name)
        r = rel(full)
        if skipped(r):
            continue
        files.append(r)
        d = os.path.dirname(r)
        while d:
            dirs.add(d)
            d = os.path.dirname(d)

if os.path.exists(OUT):
    os.remove(OUT)
os.makedirs(os.path.dirname(OUT), exist_ok=True)

with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for d in sorted(dirs):
        z.writestr(TOP + "/" + d + "/", b"")
    for r in sorted(files):
        z.write(os.path.join(ROOT, r), TOP + "/" + r)

size = os.path.getsize(OUT)
print("files", len(files), "dirs", len(dirs))
print("zip bytes", size, round(size / 1048576.0, 2), "MB")
with zipfile.ZipFile(OUT) as z:
    n = z.namelist()
print("entries", len(n))
# 关键文件核对
must = [
    "cordibank.patch.yml", "README.md", "AGENTS.md",
    "runtime/src/capabilities/manifest.ts", "runtime/src/capabilities/loader.ts",
    "runtime/src/core/settings-store.ts", "runtime/src/plugins/settings.ts",
    "runtime/tests/plugin-loader.test.ts", "runtime/tests/settings.test.ts",
    "scripts/evaluate.mjs", "scripts/intent-eval.mjs", "scripts/redteam-attack.mjs",
    "scripts/demo.mjs", "scripts/tool-audit.mjs", "scripts/eval-metrics.mjs",
    "scripts/intent-cases.mjs", "scripts/verify-tables.mjs",
    "docs/06-渠道接入说明.md", "docs/07-QQ接入教程.md", "docs/dsh-parity-plan.md",
    "web/src/components/workbench/SettingsPanel.vue",
    "web/src/components/workbench/SwarmParticles.vue",
    "web/dist/index.html", "web/public/favicon.svg",
]
missing = [m for m in must if (TOP + "/" + m) not in n]
print("MISSING:", missing)
bad = [x for x in n if "/node_modules/" in x or "/store/" in x or "/runtime/dist/" in x
       or "/.work/" in x or "/.shot-tmp/" in x or "/_scratch/" in x]
print("LEAK:", bad[:10], "count", len(bad))
cssjs = [x for x in n if "/web/dist/assets/" in x and (x.endswith(".css") or x.endswith(".js"))]
print("dist css/js:", cssjs)
print("dist assets total:", len([x for x in n if "/web/dist/assets/" in x]))
