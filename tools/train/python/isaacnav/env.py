# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""The navigation env: one brain decision (10 Hz) held for ``nav_repeat`` walker steps (50 Hz).

Newton runs the physics substeps of an env step inside one CUDA graph when every actuator can be
captured (the MicroDuck's BAM servos can), so an action term's Python runs once per env step. The
env therefore steps at the walker's rate (decimation 4, as in NVIDIA's MicroDuck task), and this
class repeats each brain action for five of those steps, as ducknav's NavVecEnv does in mjlab:
rewards add up, a reset in any of them ends the brain's step, observations are made once at the end.
"""

from __future__ import annotations

import torch
from isaaclab.envs import ManagerBasedRLEnv


class DuckNavEnv(ManagerBasedRLEnv):
    def step(self, action: torch.Tensor):
        self.action_manager.process_action(action.to(self.device))
        reward = torch.zeros(self.num_envs, device=self.device)
        terminated = torch.zeros(self.num_envs, dtype=torch.bool, device=self.device)
        timed_out = torch.zeros_like(terminated)
        repeat = int(getattr(self.cfg, "nav_repeat", 1))
        for k in range(repeat):
            self._walker_step(observe=k == repeat - 1)
            reward += self.reward_buf
            terminated |= self.reset_terminated
            timed_out |= self.reset_time_outs
        self.reward_buf = reward
        return self.obs_buf, reward, terminated, timed_out & ~terminated, self.extras

    def _walker_step(self, observe: bool) -> None:
        """ManagerBasedRLEnv.step without processing a new action (Isaac Lab 3)."""
        self.recorder_manager.record_pre_step()
        is_rendering = self.sim.is_rendering
        steps_per_call = self.cfg.decimation if self._physics_handles_decimation else 1
        for _ in range(self.cfg.decimation // steps_per_call):
            self._sim_step_counter += steps_per_call
            self.action_manager.apply_action()
            self.scene.write_data_to_sim()
            self.sim.step(render=False)
            self.recorder_manager.record_post_physics_decimation_step()
            if self._sim_step_counter % self.cfg.sim.render_interval == 0 and is_rendering:
                self.sim.render(skip_app_pumping=not self.render_enabled)
            self.scene.update(dt=self.physics_dt * steps_per_call)

        self.episode_length_buf += 1
        self.common_step_counter += 1
        self.reset_buf = self.termination_manager.compute()
        self.reset_terminated = self.termination_manager.terminated
        self.reset_time_outs = self.termination_manager.time_outs
        self.reward_buf = self.reward_manager.compute(dt=self.step_dt)

        reset_env_ids = self.reset_buf.nonzero(as_tuple=False).squeeze(-1).int()
        if len(reset_env_ids) > 0:
            self.recorder_manager.record_pre_reset(reset_env_ids)
            self._reset_idx(reset_env_ids)
            self.recorder_manager.record_post_reset(reset_env_ids)

        if self.sim.consume_reset_request():
            everyone = torch.arange(self.num_envs, device=self.device)
            self.reset_terminated[:] = True
            self._reset_idx(everyone)

        self.command_manager.compute(dt=self.step_dt)
        if "interval" in self.event_manager.active_terms:
            self.event_manager.apply(mode="interval", dt=self.step_dt)
        if observe:
            for recorder in self.video_recorders:
                recorder.step()
            self.obs_buf = self.observation_manager.compute(update_history=True)
