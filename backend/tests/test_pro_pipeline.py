"""Tests for the local "pro" (full-model) video pipeline.

Two properties matter and neither is visible from the response body, which looks identical
either way: that "pro" is only *offered* when the 54GB of optional checkpoints are actually
present, and that a "pro" request reaches the HQ pipeline rather than the distilled one.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from runtime_config.model_download_specs import (
    get_latest_ltx_model_id,
    get_ltx_model_spec,
    resolve_model_path,
)


@pytest.fixture
def create_full_model_files(test_state):
    """Write stand-ins for the undistilled checkpoint and its stage-2 refiner LoRA."""

    def _create() -> dict[str, Path]:
        spec = get_ltx_model_spec(get_latest_ltx_model_id())
        assert spec.hq_model_cp is not None and spec.hq_refiner_lora_cp is not None
        paths: dict[str, Path] = {}
        for key, cp_id in (("model", spec.hq_model_cp), ("lora", spec.hq_refiner_lora_cp)):
            path = resolve_model_path(test_state.config.default_models_dir, cp_id)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"\x00" * 1024)
            paths[key] = path
        return paths

    return _create


def _local_pipelines(client) -> list[str]:
    response = client.get("/api/generate/models-specs")
    assert response.status_code == 200
    return [m["pipeline"] for m in response.json()["local_models"]]


class TestProAvailability:
    def test_pro_is_hidden_when_the_full_model_is_not_downloaded(self, client):
        # The default install has only the distilled checkpoint. Advertising "pro" here would
        # put a model in the client's UI that the backend must then refuse.
        assert _local_pipelines(client) == ["fast"]

    def test_pro_appears_once_both_checkpoints_are_present(self, client, create_full_model_files):
        create_full_model_files()
        assert _local_pipelines(client) == ["fast", "pro"]

    def test_pro_stays_hidden_when_only_the_refiner_lora_is_present(self, client, test_state):
        # A half-finished download must not enable the tier: the pipeline needs both files,
        # and the failure would otherwise land mid-generation.
        spec = get_ltx_model_spec(get_latest_ltx_model_id())
        assert spec.hq_refiner_lora_cp is not None
        path = resolve_model_path(test_state.config.default_models_dir, spec.hq_refiner_lora_cp)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"\x00" * 1024)

        assert _local_pipelines(client) == ["fast"]


class TestProDispatch:
    def _payload(self, model: str) -> dict[str, object]:
        return {
            "prompt": "a slow pan across an empty room",
            "model": model,
            "resolution": "540p",
            "duration": 5,
            "fps": 24,
            "audio": False,
            "aspectRatio": "16:9",
        }

    def test_pro_request_reaches_the_hq_pipeline(
        self, client, test_state, fake_services, create_fake_model_files, create_full_model_files
    ):
        create_fake_model_files(include_zit=False)
        paths = create_full_model_files()
        test_state.state.app_settings.use_local_text_encoder = True
        test_state.config.local_generations_mode = "full_models_loading"

        response = client.post("/api/generate", json=self._payload("pro"))
        assert response.status_code == 200, response.json()

        # The distilled pipeline must not have been touched...
        assert fake_services.fast_video_pipeline.generate_calls == []
        # ...and the HQ one must have been handed the undistilled checkpoint plus the refiner.
        assert len(fake_services.hq_video_pipeline.generate_calls) == 1
        assert fake_services.hq_video_pipeline.create_checkpoint_paths[-1] == str(paths["model"])
        assert fake_services.hq_video_pipeline.create_refiner_lora_paths[-1] == str(paths["lora"])

    def test_fast_request_still_reaches_the_distilled_pipeline(
        self, client, test_state, fake_services, create_fake_model_files, create_full_model_files
    ):
        # Even with the full model installed, "fast" must not silently upgrade — the tier is
        # the user's choice about time, not something to improve on their behalf.
        create_fake_model_files(include_zit=False)
        create_full_model_files()
        test_state.state.app_settings.use_local_text_encoder = True
        test_state.config.local_generations_mode = "full_models_loading"

        response = client.post("/api/generate", json=self._payload("fast"))
        assert response.status_code == 200, response.json()

        assert len(fake_services.fast_video_pipeline.generate_calls) == 1
        assert fake_services.hq_video_pipeline.generate_calls == []

    def test_pro_is_refused_when_the_full_model_is_missing(
        self, client, test_state, create_fake_model_files
    ):
        create_fake_model_files(include_zit=False)
        test_state.state.app_settings.use_local_text_encoder = True
        test_state.config.local_generations_mode = "full_models_loading"

        response = client.post("/api/generate", json=self._payload("pro"))
        assert response.status_code >= 400


class TestStepCount:
    """The step count is res_2s *second-order* steps: each is two model evaluations, so the
    default 15 equals the 30 Euler steps quoted for undistilled LTX-2.3. Exposing it is what
    makes that budget a decision rather than a constant."""

    def _payload(self, model: str, **extra: object) -> dict[str, object]:
        return {
            "prompt": "a slow pan across an empty room",
            "model": model,
            "resolution": "540p",
            "duration": 5,
            "fps": 24,
            "audio": False,
            "aspectRatio": "16:9",
            **extra,
        }

    def test_pro_uses_the_tuned_default_when_unspecified(
        self, client, test_state, fake_services, create_fake_model_files, create_full_model_files
    ):
        create_fake_model_files(include_zit=False)
        create_full_model_files()
        test_state.state.app_settings.use_local_text_encoder = True
        test_state.config.local_generations_mode = "full_models_loading"

        assert client.post("/api/generate", json=self._payload("pro")).status_code == 200
        # None here means "the pipeline's own default" — the handler must not invent a number.
        assert fake_services.hq_video_pipeline.generate_calls[-1]["num_inference_steps"] is None

    def test_pro_honours_an_explicit_step_count(
        self, client, test_state, fake_services, create_fake_model_files, create_full_model_files
    ):
        create_fake_model_files(include_zit=False)
        create_full_model_files()
        test_state.state.app_settings.use_local_text_encoder = True
        test_state.config.local_generations_mode = "full_models_loading"

        assert client.post("/api/generate", json=self._payload("pro", numSteps=25)).status_code == 200
        assert fake_services.hq_video_pipeline.generate_calls[-1]["num_inference_steps"] == 25

    def test_steps_are_refused_on_the_distilled_pipeline(
        self, client, test_state, create_fake_model_files
    ):
        # Rejected rather than ignored: a silently-dropped quality knob is worth an hour of
        # wondering why nothing changed.
        create_fake_model_files(include_zit=False)
        test_state.state.app_settings.use_local_text_encoder = True
        test_state.config.local_generations_mode = "full_models_loading"

        response = client.post("/api/generate", json=self._payload("fast", numSteps=25))
        assert response.status_code == 422
        assert "numSteps" in response.json()["message"]
