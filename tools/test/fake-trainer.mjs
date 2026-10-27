// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * A stand-in outside trainer for tools/test/trainer-connector-check.mjs: it
 * follows the trainer contract (tools/train/lib/trainers.mjs) without training.
 * It reads the job, prints "iteration N/M" lines, and hands back the shipped
 * walking policy as its walk.onnx with a metrics.json.
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const job = JSON.parse(readFileSync(process.env.DUCKLAB_JOB, 'utf8'));
const packs = readdirSync(process.env.DUCKLAB_PACKS).filter((d) => existsSync(join(process.env.DUCKLAB_PACKS, d, 'scene.xml')));
const iterations = Number(process.env.DUCKLAB_ITERATIONS) || 3;
console.log(`stand-in trainer: job ${job.id} (${job.version}), ${packs.length} pack(s), ${process.env.DUCKLAB_ENVS} robots`);
for (let i = 1; i <= iterations; i++) {
  console.log(`Learning iteration ${i}/${iterations}`);
  await new Promise((r) => setTimeout(r, 100));
}
copyFileSync(join(process.env.DUCKLAB_PACKS, packs[0], 'policies', 'walk.onnx'), join(process.env.DUCKLAB_OUT, 'walk.onnx'));
writeFileSync(join(process.env.DUCKLAB_OUT, 'metrics.json'), JSON.stringify({ note: 'stand-in: the shipped policy, untrained', iterations }));
