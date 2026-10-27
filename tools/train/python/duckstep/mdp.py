# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""A terrace curriculum that counts climbing, not distance.

mjlab's own rule (``terrain_levels_vel``) moves a robot up only when it ends an episode half a
patch from its start, and down when it covered less than half of its last command times the
episode length. Pollen's commands wander in every direction, so almost every duck was moved down,
and the first step-up run spent its last 500 rounds on 0.5 cm steps. Here a duck moves up when it
got onto the third step at any time in the episode (the rings are concentric, so any direction
counts), and down when it fell, or when it was told to walk and never reached the first step.
"""

from __future__ import annotations

import torch
from mjlab.managers import RewardTermCfg

# Square-ring distance from the patch middle (terrain.py: a 0.8 m centre, steps 0.25 m deep).
FIRST_STEP = 0.45
THIRD_STEP = 0.95


class terrace_reach:
    """A reward term in name only (it returns zeros): the farthest each robot got from its patch
    middle this episode, kept where the curriculum can read it before the episode resets."""

    def __init__(self, cfg: RewardTermCfg, env):
        self.far = torch.zeros(env.num_envs, device=env.device)
        env.duckstep_far = self.far

    def reset(self, env_ids: torch.Tensor | slice | None = None) -> None:
        self.far[slice(None) if env_ids is None else env_ids] = 0.0

    def __call__(self, env, **_) -> torch.Tensor:
        offset = env.scene["robot"].data.root_link_pos_w[:, :2] - env.scene.env_origins[:, :2]
        torch.maximum(self.far, offset.abs().amax(dim=1), out=self.far)
        return torch.zeros_like(self.far)


def terrace_levels(env, env_ids: torch.Tensor, command_name: str = "twist", moving: float = 0.1) -> dict[str, torch.Tensor]:
    terrain = env.scene.terrain
    far = getattr(env, "duckstep_far", None)
    if far is None:
        return {}
    far = far[env_ids]
    fell = env.termination_manager.terminated[env_ids]
    command = env.command_manager.get_command(command_name)[env_ids]
    asked = torch.norm(command[:, :2], dim=1) > moving
    move_up = (far > THIRD_STEP) & ~fell
    move_down = (fell | ((far < FIRST_STEP) & asked)) & ~move_up
    terrain.update_env_origins(env_ids, move_up, move_down)

    levels = terrain.terrain_levels.float()
    result = {"mean": levels.mean(), "max": levels.max(), "climbed": move_up.float().mean(), "demoted": move_down.float().mean()}
    names = list(terrain.cfg.terrain_generator.sub_terrains.keys())
    if terrain.terrain_origins is not None and terrain.terrain_origins.shape[1] == len(names):
        for i, name in enumerate(names):
            mask = terrain.terrain_types == i
            if mask.any():
                result[name] = levels[mask].mean()
    return result


class climb_gain:
    """New height reached this episode (m per second of the step): the root rising above its highest point so
    far. Pays for getting up steps, and only once per step climbed."""

    def __init__(self, cfg: RewardTermCfg, env):
        self.top = torch.full((env.num_envs,), float("nan"), device=env.device)
        self.step_dt = env.step_dt

    def reset(self, env_ids: torch.Tensor | slice | None = None) -> None:
        self.top[slice(None) if env_ids is None else env_ids] = float("nan")

    def __call__(self, env, **_) -> torch.Tensor:
        z = env.scene["robot"].data.root_link_pos_w[:, 2] - env.scene.env_origins[:, 2]
        fresh = torch.isnan(self.top)
        self.top = torch.where(fresh, z, self.top)
        gain = (z - self.top).clamp(min=0.0)
        self.top = torch.maximum(self.top, z)
        return gain / self.step_dt


# --- the test case as terrain (ground.py) ------------------------------------------------------------


class ground_reach:
    """A reward term in name only (zeros): the farthest each robot got along the ground's x (from its start
    towards its goal) this episode, kept where the curriculum can read it before the episode resets."""

    def __init__(self, cfg: RewardTermCfg, env):
        self.far = torch.zeros(env.num_envs, device=env.device)
        env.duckstep_far = self.far

    def reset(self, env_ids: torch.Tensor | slice | None = None) -> None:
        self.far[slice(None) if env_ids is None else env_ids] = 0.0

    def __call__(self, env, **_) -> torch.Tensor:
        along = env.scene["robot"].data.root_link_pos_w[:, 0] - env.scene.env_origins[:, 0]
        torch.maximum(self.far, along, out=self.far)
        return torch.zeros_like(self.far)


def ground_levels(env, env_ids: torch.Tensor, target: float, command_name: str = "twist", moving: float = 0.05) -> dict[str, torch.Tensor]:
    """Up a row (taller copies of the test case's steps) after getting `target` metres along without a fall;
    down after a fall, or after being told to walk and not getting a third of the way."""
    terrain = env.scene.terrain
    far = getattr(env, "duckstep_far", None)
    if far is None:
        return {}
    far = far[env_ids]
    fell = env.termination_manager.terminated[env_ids]
    command = env.command_manager.get_command(command_name)[env_ids]
    asked = command[:, 0] > moving
    move_up = (far > target) & ~fell
    move_down = (fell | ((far < target / 3) & asked)) & ~move_up
    terrain.update_env_origins(env_ids, move_up, move_down)
    levels = terrain.terrain_levels.float()
    return {"mean": levels.mean(), "max": levels.max(), "past": move_up.float().mean(), "fell": fell.float().mean()}
