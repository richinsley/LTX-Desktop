"""LTX full-model ("pro") video pipeline wrapper.

The distilled pipeline trades fidelity for step count. This one runs the undistilled
checkpoint through `TI2VidTwoStagesHQPipeline`: stage 1 generates at half the target
resolution with CFG guidance, stage 2 upsamples x2 and refines using the distilled LoRA,
with the res_2s second-order sampler throughout.

Parameters are not invented here — `ltx_pipelines.utils.constants.LTX_2_3_HQ_PARAMS` is
upstream's own tuned set for exactly this pipeline and checkpoint pairing (15 steps, CFG 3.0
video / 7.0 audio, rescale 0.45). Deviating from it should be a measured decision, not a
default.
"""

from __future__ import annotations

from collections.abc import Iterator
import os
from typing import Final, cast

import torch

from api_types import ImageConditioningInput
from services.ltx_pipeline_common import (
    default_tiling_config,
    encode_video_output,
    offload_mode_for_prefetch_count,
    video_chunks_number,
)
from services.services_utils import AudioOrNone, TilingConfigType, device_supports_fp8


class LTXHQVideoPipeline:
    pipeline_kind: Final = "pro"

    @staticmethod
    def create(
        checkpoint_path: str,
        gemma_root: str | None,
        upsampler_path: str,
        refiner_lora_path: str,
        device: torch.device,
        streaming_prefetch_count: int | None,
        loras: list[tuple[str, float]] | None = None,
    ) -> "LTXHQVideoPipeline":
        return LTXHQVideoPipeline(
            checkpoint_path=checkpoint_path,
            gemma_root=gemma_root,
            upsampler_path=upsampler_path,
            refiner_lora_path=refiner_lora_path,
            device=device,
            streaming_prefetch_count=streaming_prefetch_count,
            loras=loras or [],
        )

    def __init__(
        self,
        checkpoint_path: str,
        gemma_root: str | None,
        upsampler_path: str,
        refiner_lora_path: str,
        device: torch.device,
        streaming_prefetch_count: int | None,
        loras: list[tuple[str, float]] | None = None,
    ) -> None:
        from ltx_core.loader.primitives import LoraPathStrengthAndSDOps
        from ltx_core.loader.sd_ops import LTXV_LORA_COMFY_RENAMING_MAP
        from ltx_core.quantization.fp8_cast import build_policy as build_fp8_cast_policy
        from ltx_pipelines.ti2vid_two_stages_hq import TI2VidTwoStagesHQPipeline

        self._checkpoint_path = checkpoint_path
        self._gemma_root = gemma_root
        self._upsampler_path = upsampler_path
        self._refiner_lora_path = refiner_lora_path
        self._device = device
        self._offload_mode = offload_mode_for_prefetch_count(streaming_prefetch_count, device)
        self._quantization = build_fp8_cast_policy(checkpoint_path) if device_supports_fp8(device) else None
        self._loras = loras or []

        self._refiner_lora = [
            LoraPathStrengthAndSDOps(path=refiner_lora_path, strength=1.0, sd_ops=LTXV_LORA_COMFY_RENAMING_MAP)
        ]
        user_loras = tuple(
            LoraPathStrengthAndSDOps(path=path, strength=scale, sd_ops=LTXV_LORA_COMFY_RENAMING_MAP)
            for path, scale in self._loras
        )

        self.pipeline = TI2VidTwoStagesHQPipeline(
            checkpoint_path=checkpoint_path,
            distilled_lora=self._refiner_lora,
            # Stage 1 runs the base model with CFG and no distilled LoRA; stage 2 applies it at
            # full strength to refine. These are the strengths the two-stage HQ design assumes.
            distilled_lora_strength_stage_1=0.0,
            distilled_lora_strength_stage_2=1.0,
            spatial_upsampler_path=upsampler_path,
            gemma_root=cast(str, gemma_root),
            loras=user_loras,
            device=device,
            quantization=self._quantization,
            offload_mode=self._offload_mode,
        )

    def _run_inference(
        self,
        prompt: str,
        seed: int,
        height: int,
        width: int,
        num_frames: int,
        frame_rate: float,
        images: list[ImageConditioningInput],
        tiling_config: TilingConfigType,
        negative_prompt: str = "",
    ) -> tuple[torch.Tensor | Iterator[torch.Tensor], AudioOrNone]:
        from ltx_pipelines.utils.args import ImageConditioningInput as _LtxImageInput
        from ltx_pipelines.utils.constants import LTX_2_3_HQ_PARAMS

        return self.pipeline(
            prompt=prompt,
            negative_prompt=negative_prompt,
            seed=seed,
            height=height,
            width=width,
            num_frames=num_frames,
            frame_rate=frame_rate,
            num_inference_steps=LTX_2_3_HQ_PARAMS.num_inference_steps,
            video_guider_params=LTX_2_3_HQ_PARAMS.video_guider_params,
            audio_guider_params=LTX_2_3_HQ_PARAMS.audio_guider_params,
            images=[_LtxImageInput(img.path, img.frame_idx, img.strength) for img in images],
            tiling_config=tiling_config,
        )

    @torch.inference_mode()
    def generate(
        self,
        prompt: str,
        seed: int,
        height: int,
        width: int,
        num_frames: int,
        frame_rate: float,
        images: list[ImageConditioningInput],
        output_path: str,
    ) -> None:
        tiling_config = default_tiling_config()
        video, audio = self._run_inference(
            prompt=prompt,
            seed=seed,
            height=height,
            width=width,
            num_frames=num_frames,
            frame_rate=frame_rate,
            images=images,
            tiling_config=tiling_config,
        )
        chunks = video_chunks_number(num_frames, tiling_config)
        encode_video_output(
            video=video, audio=audio, fps=int(frame_rate), output_path=output_path, video_chunks_number_value=chunks
        )

    @torch.inference_mode()
    def warmup(self, output_path: str) -> None:
        warmup_frames = 9
        tiling_config = default_tiling_config()

        try:
            video, audio = self._run_inference(
                prompt="test warmup",
                seed=42,
                height=256,
                width=384,
                num_frames=warmup_frames,
                frame_rate=8,
                images=[],
                tiling_config=tiling_config,
            )
            chunks = video_chunks_number(warmup_frames, tiling_config)
            encode_video_output(
                video=video, audio=audio, fps=8, output_path=output_path, video_chunks_number_value=chunks
            )
        finally:
            if os.path.exists(output_path):
                os.unlink(output_path)

    def compile_transformer(self) -> None:
        from ltx_core.model.transformer.compiling import CompilationConfig
        from ltx_pipelines.ti2vid_two_stages_hq import TI2VidTwoStagesHQPipeline
        from ltx_core.loader.primitives import LoraPathStrengthAndSDOps
        from ltx_core.loader.sd_ops import LTXV_LORA_COMFY_RENAMING_MAP

        user_loras = tuple(
            LoraPathStrengthAndSDOps(path=path, strength=scale, sd_ops=LTXV_LORA_COMFY_RENAMING_MAP)
            for path, scale in self._loras
        )

        self.pipeline = TI2VidTwoStagesHQPipeline(
            checkpoint_path=self._checkpoint_path,
            distilled_lora=self._refiner_lora,
            distilled_lora_strength_stage_1=0.0,
            distilled_lora_strength_stage_2=1.0,
            spatial_upsampler_path=self._upsampler_path,
            gemma_root=cast(str, self._gemma_root),
            loras=user_loras,
            device=self._device,
            quantization=self._quantization,
            offload_mode=self._offload_mode,
            compilation_config=CompilationConfig(),
        )
