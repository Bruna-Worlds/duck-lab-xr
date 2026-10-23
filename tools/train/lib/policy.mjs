// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The walking policy as the trainer sees it. Pollen's policies are small
 * MLPs: observation normaliser, then 61 -> 512 -> 256 -> 128 -> 14 with ELU.
 * The fine-tune keeps everything up to the 128 features fixed and learns a
 * change to the last layer, so:
 *   - for training, the ONNX graph gets a batch dimension and a second
 *     output (the 128 features), and the change is applied in JavaScript;
 *   - for release, the change is added to the last layer's weights and the
 *     file keeps the original graph, inputs and outputs (61 in, 14 out):
 *     any ONNX runtime loads it, the headset included.
 */
import * as ort from 'onnxruntime-node';
import { decodeModel, encodeModel, floatTensor, tensorValues } from './onnx.mjs';

/** The last Gemm (it writes the graph output) and its weight and bias initializers. */
export function lastLayer(model) {
  const graph = model.graph;
  const out = graph.output[0].name;
  const gemm = graph.node.find((n) => n.opType === 'Gemm' && n.output.includes(out));
  if (!gemm) throw new Error('policy: no Gemm writes the output; not an MLP policy');
  const transB = (gemm.attribute ?? []).find((a) => a.name === 'transB')?.i ?? 0;
  if (Number(transB) !== 1) throw new Error('policy: last Gemm without transB=1 is not supported');
  const weight = graph.initializer.find((t) => t.name === gemm.input[1]);
  const bias = graph.initializer.find((t) => t.name === gemm.input[2]);
  if (!weight || !bias) throw new Error('policy: last layer weights are not initializers');
  const [outputs, features] = weight.dims.map(Number);
  return { gemm, weight, bias, outputs, features, featureName: gemm.input[0] };
}

/** Number of trainable values: the last layer's weights and bias. */
export function paramCount(layer) {
  return layer.outputs * layer.features + layer.outputs;
}

/** Reads a policy file into its decoded model and last-layer description. */
export function readPolicy(bytes) {
  const model = decodeModel(bytes);
  return { model, layer: lastLayer(model) };
}

/** A batched copy of the policy that also outputs the last layer's input features. */
export async function featureSession(bytes) {
  const model = decodeModel(bytes);
  const layer = lastLayer(model);
  const graph = model.graph;
  const batch = (vi) => {
    const dims = vi.type?.tensorType?.shape?.dim;
    if (dims?.length) dims[0] = { dimParam: 'N' };
  };
  graph.input.forEach(batch);
  graph.output.forEach(batch);
  graph.valueInfo = [];
  graph.output.push({
    name: layer.featureName,
    type: { tensorType: { elemType: 1, shape: { dim: [{ dimParam: 'N' }, { dimValue: layer.features }] } } },
  });
  const session = await ort.InferenceSession.create(encodeModel(model), {
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all',
  });
  return { session, layer, input: graph.input[0].name, output: graph.output[0].name, features: layer.featureName };
}

/**
 * The released policy: original graph, last layer plus the learned change
 * (theta = [dW (outputs x features, row-major), db (outputs)]), and notes in
 * the model's metadata.
 */
export function bakePolicy(bytes, theta, metadata) {
  const model = decodeModel(bytes);
  const layer = lastLayer(model);
  const W = tensorValues(layer.weight);
  const b = tensorValues(layer.bias);
  const n = layer.outputs * layer.features;
  if (theta.length !== n + layer.outputs) throw new Error(`theta has ${theta.length} values, expected ${n + layer.outputs}`);
  const W2 = new Float32Array(W.length);
  for (let i = 0; i < n; i++) W2[i] = W[i] + theta[i];
  const b2 = new Float32Array(b.length);
  for (let j = 0; j < layer.outputs; j++) b2[j] = b[j] + theta[n + j];
  const replace = (tensor, values) => {
    const index = model.graph.initializer.indexOf(tensor);
    model.graph.initializer[index] = floatTensor(tensor.name, values, tensor.dims.map(Number));
  };
  replace(layer.weight, W2);
  replace(layer.bias, b2);
  const props = (model.metadataProps ?? []).filter((p) => !Object.hasOwn(metadata, p.key));
  for (const [key, value] of Object.entries(metadata)) props.push({ key, value: String(value) });
  model.metadataProps = props;
  model.producerName = 'duckdash-finetune';
  return encodeModel(model);
}

/**
 * Checks a baked policy against the original plus the change, on random
 * observations: max difference of the 14 outputs (should be ~1e-5).
 */
export async function verifyBaked(originalBytes, bakedBytes, theta, samples = 32) {
  const features = await featureSession(originalBytes);
  const baked = await ort.InferenceSession.create(bakedBytes);
  const { layer } = features;
  const obsSize = 61;
  let worst = 0;
  for (let s = 0; s < samples; s++) {
    const obs = new Float32Array(obsSize);
    for (let i = 0; i < obsSize; i++) obs[i] = (Math.random() - 0.5) * (i < 6 ? 2 : 0.6);
    const a = await features.session.run({ [features.input]: new ort.Tensor('float32', obs, [1, obsSize]) });
    const base = a[features.output].data;
    const h = a[features.features].data;
    const b = await baked.run({ [baked.inputNames[0]]: new ort.Tensor('float32', obs, [1, obsSize]) });
    const out = b[baked.outputNames[0]].data;
    for (let j = 0; j < layer.outputs; j++) {
      let expected = base[j] + theta[layer.outputs * layer.features + j];
      for (let k = 0; k < layer.features; k++) expected += theta[j * layer.features + k] * h[k];
      worst = Math.max(worst, Math.abs(expected - out[j]));
    }
  }
  return worst;
}

/** FNV-1a of a file's bytes, the hash the app shows for a policy. */
export function policyHash(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
