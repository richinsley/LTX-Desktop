"""Tests for /api/artifacts/* — the file transfer a non-local client depends on.

The interesting cases are the refusals. Download is the one endpoint that turns a path from
the network into a file read, so the bounds around it are the security property of the whole
remote-provider path, not a detail.
"""

from __future__ import annotations

import os
from pathlib import Path


class TestArtifactCapabilities:
    def test_reports_both_directions_and_its_roots(self, client, test_state):
        r = client.get("/api/artifacts/capabilities")
        assert r.status_code == 200
        data = r.json()
        assert data["download"] is True
        assert data["upload"] is True
        assert Path(data["outputs_dir"]) == Path(test_state.config.outputs_dir).resolve()
        assert data["max_upload_bytes"] > 0


class TestArtifactDownload:
    def test_absolute_path_inside_outputs(self, client, test_state):
        artifact = Path(test_state.config.outputs_dir) / "generated.mp4"
        artifact.write_bytes(b"video-bytes")

        r = client.get("/api/artifacts/download", params={"path": str(artifact)})
        assert r.status_code == 200
        assert r.content == b"video-bytes"

    def test_bare_filename_resolves_against_outputs(self, client, test_state):
        (Path(test_state.config.outputs_dir) / "generated.mp4").write_bytes(b"video-bytes")

        r = client.get("/api/artifacts/download", params={"path": "generated.mp4"})
        assert r.status_code == 200
        assert r.content == b"video-bytes"

    def test_missing_file_is_404(self, client):
        r = client.get("/api/artifacts/download", params={"path": "nope.mp4"})
        assert r.status_code == 404
        assert r.json()["code"] == "ARTIFACT_NOT_FOUND"

    def test_empty_path_is_400(self, client):
        r = client.get("/api/artifacts/download", params={"path": "   "})
        assert r.status_code == 400
        assert r.json()["code"] == "INVALID_ARTIFACT_PATH"

    def test_path_outside_roots_is_refused(self, client, tmp_path):
        secret = tmp_path / "elsewhere.txt"
        secret.write_text("not yours")

        r = client.get("/api/artifacts/download", params={"path": str(secret)})
        assert r.status_code == 403
        assert r.json()["code"] == "ARTIFACT_OUT_OF_BOUNDS"

    def test_traversal_out_of_outputs_is_refused(self, client, tmp_path):
        (tmp_path / "elsewhere.txt").write_text("not yours")

        r = client.get("/api/artifacts/download", params={"path": "../elsewhere.txt"})
        assert r.status_code == 403
        assert r.json()["code"] == "ARTIFACT_OUT_OF_BOUNDS"

    def test_symlink_out_of_outputs_is_refused(self, client, test_state, tmp_path):
        """A symlink planted inside outputs must not become a read of its target.

        The bound is checked after resolution precisely so this cannot work.
        """
        secret = tmp_path / "secret.txt"
        secret.write_text("not yours")
        link = Path(test_state.config.outputs_dir) / "innocent.mp4"
        os.symlink(secret, link)

        r = client.get("/api/artifacts/download", params={"path": str(link)})
        assert r.status_code == 403
        assert r.json()["code"] == "ARTIFACT_OUT_OF_BOUNDS"

    def test_directory_is_not_downloadable(self, client, test_state):
        directory = Path(test_state.config.outputs_dir) / "a-directory"
        directory.mkdir()

        r = client.get("/api/artifacts/download", params={"path": str(directory)})
        assert r.status_code == 404


class TestArtifactUpload:
    def test_upload_returns_a_path_the_backend_can_read(self, client, test_state):
        r = client.post(
            "/api/artifacts/upload",
            files={"file": ("conditioning.png", b"png-bytes", "image/png")},
        )
        assert r.status_code == 200
        data = r.json()
        assert data["size_bytes"] == len(b"png-bytes")

        stored = Path(data["path"])
        assert stored.read_bytes() == b"png-bytes"
        assert stored.parent == Path(test_state.config.app_data_dir).resolve() / "uploads"
        # The extension has to survive — pipelines dispatch on it.
        assert stored.suffix == ".png"

    def test_uploaded_file_is_then_downloadable(self, client):
        """The round trip a remote provider actually performs: stage an input, and be able
        to read it back by the path the upload reported."""
        upload = client.post("/api/artifacts/upload", files={"file": ("in.png", b"abc", "image/png")})
        path = upload.json()["path"]

        r = client.get("/api/artifacts/download", params={"path": path})
        assert r.status_code == 200
        assert r.content == b"abc"

    def test_same_name_twice_does_not_overwrite(self, client):
        first = client.post("/api/artifacts/upload", files={"file": ("same.png", b"one", "image/png")})
        second = client.post("/api/artifacts/upload", files={"file": ("same.png", b"two", "image/png")})

        assert first.json()["path"] != second.json()["path"]
        assert Path(first.json()["path"]).read_bytes() == b"one"
        assert Path(second.json()["path"]).read_bytes() == b"two"

    def test_directory_components_in_the_name_are_stripped(self, client, test_state):
        """A filename is a name, never a path — otherwise the upload chooses where it lands."""
        r = client.post(
            "/api/artifacts/upload",
            files={"file": ("../../escape.png", b"x", "image/png")},
        )
        assert r.status_code == 200
        stored = Path(r.json()["path"])
        assert stored.parent == Path(test_state.config.app_data_dir).resolve() / "uploads"
        assert stored.name.endswith("-escape.png")
