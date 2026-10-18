"""The hand-kept copies the shipped artifacts carry, checked against their sources.

manifest.json (the Claude Desktop bundle) repeats the version, Python range, license, author,
homepage, repository, keywords and tool list that pyproject.toml and the registered tools
define, and config.py keeps a fallback version for a source tree run without an install. The
mcpb version CI packs with is repeated in the build commands README.md and CLAUDE.md give.
Nothing else notices a release that updates one copy and not the others. The manifest's
display_name must also hold no "/", and the User-Agent must name the project's homepage.

Hermetic: the files are read from the checkout, the tools are listed in process, and the
fallback version is read in a fresh interpreter whose metadata lookup for the package fails.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest

import lesswrong_mcp as m
from lesswrong_mcp import config

_REPO_ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(scope="module")
def manifest() -> dict:
    return json.loads((_REPO_ROOT / "manifest.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def project() -> dict:
    with (_REPO_ROOT / "pyproject.toml").open("rb") as f:
        return tomllib.load(f)["project"]


# ------------------------------------------------------------------------- #
# The version: pyproject.toml, manifest.json and the config.py fallback
# ------------------------------------------------------------------------- #

def test_manifest_version_matches_pyproject(manifest, project):
    # Claude Desktop reads the bundle's version from the manifest, not from the package.
    assert manifest["version"] == project["version"]


def test_uninstalled_source_tree_reports_the_pyproject_version(project):
    # Without installed metadata, config.py falls back to its literal, which is then the
    # version the server reports and sends in its User-Agent.
    script = (
        "import importlib.metadata as md\n"
        "installed = md.version\n"
        "def version(name):\n"
        "    if name == 'lesswrong-mcp':\n"
        "        raise md.PackageNotFoundError(name)\n"
        "    return installed(name)\n"
        "md.version = version\n"
        "from lesswrong_mcp import config\n"
        "print(config.__version__)\n"
        "print(config.USER_AGENT)\n"
    )
    out = subprocess.run(
        [sys.executable, "-c", script],
        cwd=_REPO_ROOT, capture_output=True, text=True, check=True,
    )
    version, user_agent = out.stdout.splitlines()
    assert version == project["version"]
    assert user_agent.startswith(f"lesswrong-mcp/{project['version']} ")


# ------------------------------------------------------------------------- #
# The rest of manifest.json
# ------------------------------------------------------------------------- #

def test_manifest_lists_exactly_the_registered_tools(run, manifest):
    listed = sorted(tool["name"] for tool in manifest["tools"])
    assert listed == sorted(tool.name for tool in run(m.mcp.list_tools()))


def test_manifest_python_range_matches_requires_python(manifest, project):
    assert manifest["compatibility"]["runtimes"]["python"] == project["requires-python"]


def test_manifest_and_pyproject_name_the_same_license_author_and_homepage(manifest, project):
    assert manifest["license"] == project["license"]
    assert [manifest["author"]["name"]] == [author["name"] for author in project["authors"]]
    assert manifest["homepage"] == project["urls"]["Homepage"]


def test_manifest_and_pyproject_name_the_same_repository_and_keywords(manifest, project):
    # The manifest names the clone URL; pyproject the repository's page.
    assert manifest["repository"]["url"] == project["urls"]["Repository"] + ".git"
    assert manifest["keywords"] == project["keywords"]


def test_display_name_holds_no_slash(manifest):
    # Claude Desktop builds a per-server log path from display_name, and its path-escape guard
    # refuses to connect a server whose name holds a "/".
    assert "/" not in manifest["display_name"]


def test_user_agent_names_the_project_homepage(manifest):
    # The URL a forum operator follows to find this client and its maintainer.
    assert config.USER_AGENT.startswith(f"lesswrong-mcp/{m.__version__} ")
    assert manifest["homepage"] in config.USER_AGENT


# ------------------------------------------------------------------------- #
# The mcpb version: CI's bundle job and the build commands the docs give
# ------------------------------------------------------------------------- #

_MCPB_PIN = re.compile(r"@anthropic-ai/mcpb@([\w.+-]*\w)")


def test_docs_build_the_bundle_with_the_mcpb_version_ci_packs_with():
    # README's and CLAUDE.md's build commands must make the bundle CI validates and packs.
    ci = (_REPO_ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    [ci_version] = re.findall(r'MCPB: "@anthropic-ai/mcpb@([\w.+-]*\w)"', ci)
    for doc in ("README.md", "CLAUDE.md"):
        pins = _MCPB_PIN.findall((_REPO_ROOT / doc).read_text(encoding="utf-8"))
        assert pins and set(pins) == {ci_version}, doc
