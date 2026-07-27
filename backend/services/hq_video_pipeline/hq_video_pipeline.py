"""Full-model ("pro") video pipeline protocol.

Deliberately not merged with FastVideoPipeline: this one needs the stage-2 refiner LoRA
path, which the distilled pipeline has no notion of. Widening the shared protocol with an
argument only one implementation uses would make every fake and call site carry it.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, ClassVar, Literal, Protocol

from api_types import ImageConditioningInput

if TYPE_CHECKING:
    import torch


class HQVideoPipeline(Protocol):
    pipeline_kind: ClassVar[Literal["pro"]]

    @staticmethod
    def create(
        checkpoint_path: str,
        gemma_root: str | None,
        upsampler_path: str,
        refiner_lora_path: str,
        device: torch.device,
        streaming_prefetch_count: int | None,
        loras: list[tuple[str, float]] | None = None,
    ) -> "HQVideoPipeline":
        ...

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
        ...

    def warmup(self, output_path: str) -> None:
        ...

    def compile_transformer(self) -> None:
        ...
