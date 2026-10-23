// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Just enough of the ONNX protobuf schema (onnx/onnx.proto, IR v8+) to read a
 * policy, add nodes to its graph and write it back, with protobufjs. Field
 * numbers follow onnx.proto exactly. Fields the policies never use are left
 * out (protobufjs drops unknown fields), so every edited model is checked
 * against the original with onnxruntime before it is published.
 */
import protobuf from 'protobufjs';

const schema = {
  nested: {
    onnx: {
      nested: {
        AttributeProto: {
          fields: {
            name: { type: 'string', id: 1 },
            refAttrName: { type: 'string', id: 21 },
            docString: { type: 'string', id: 13 },
            type: { type: 'int32', id: 20 },
            f: { type: 'float', id: 2 },
            i: { type: 'int64', id: 3 },
            s: { type: 'bytes', id: 4 },
            t: { type: 'TensorProto', id: 5 },
            g: { type: 'GraphProto', id: 6 },
            floats: { rule: 'repeated', type: 'float', id: 7 },
            ints: { rule: 'repeated', type: 'int64', id: 8 },
            strings: { rule: 'repeated', type: 'bytes', id: 9 },
            tensors: { rule: 'repeated', type: 'TensorProto', id: 10 },
            graphs: { rule: 'repeated', type: 'GraphProto', id: 11 },
          },
        },
        ValueInfoProto: {
          fields: {
            name: { type: 'string', id: 1 },
            type: { type: 'TypeProto', id: 2 },
            docString: { type: 'string', id: 3 },
          },
        },
        NodeProto: {
          fields: {
            input: { rule: 'repeated', type: 'string', id: 1 },
            output: { rule: 'repeated', type: 'string', id: 2 },
            name: { type: 'string', id: 3 },
            opType: { type: 'string', id: 4 },
            domain: { type: 'string', id: 7 },
            attribute: { rule: 'repeated', type: 'AttributeProto', id: 5 },
            docString: { type: 'string', id: 6 },
          },
        },
        StringStringEntryProto: {
          fields: {
            key: { type: 'string', id: 1 },
            value: { type: 'string', id: 2 },
          },
        },
        OperatorSetIdProto: {
          fields: {
            domain: { type: 'string', id: 1 },
            version: { type: 'int64', id: 2 },
          },
        },
        ModelProto: {
          fields: {
            irVersion: { type: 'int64', id: 1 },
            opsetImport: { rule: 'repeated', type: 'OperatorSetIdProto', id: 8 },
            producerName: { type: 'string', id: 2 },
            producerVersion: { type: 'string', id: 3 },
            domain: { type: 'string', id: 4 },
            modelVersion: { type: 'int64', id: 5 },
            docString: { type: 'string', id: 6 },
            graph: { type: 'GraphProto', id: 7 },
            metadataProps: { rule: 'repeated', type: 'StringStringEntryProto', id: 14 },
          },
        },
        GraphProto: {
          fields: {
            node: { rule: 'repeated', type: 'NodeProto', id: 1 },
            name: { type: 'string', id: 2 },
            initializer: { rule: 'repeated', type: 'TensorProto', id: 5 },
            docString: { type: 'string', id: 10 },
            input: { rule: 'repeated', type: 'ValueInfoProto', id: 11 },
            output: { rule: 'repeated', type: 'ValueInfoProto', id: 12 },
            valueInfo: { rule: 'repeated', type: 'ValueInfoProto', id: 13 },
          },
        },
        TensorProto: {
          fields: {
            dims: { rule: 'repeated', type: 'int64', id: 1 },
            dataType: { type: 'int32', id: 2 },
            floatData: { rule: 'repeated', type: 'float', id: 4, options: { packed: true } },
            int32Data: { rule: 'repeated', type: 'int32', id: 5, options: { packed: true } },
            int64Data: { rule: 'repeated', type: 'int64', id: 7, options: { packed: true } },
            name: { type: 'string', id: 8 },
            rawData: { type: 'bytes', id: 9 },
            docString: { type: 'string', id: 12 },
            doubleData: { rule: 'repeated', type: 'double', id: 10, options: { packed: true } },
          },
        },
        TensorShapeProto: {
          fields: {
            dim: { rule: 'repeated', type: 'Dimension', id: 1 },
          },
          nested: {
            Dimension: {
              oneofs: { value: { oneof: ['dimValue', 'dimParam'] } },
              fields: {
                dimValue: { type: 'int64', id: 1 },
                dimParam: { type: 'string', id: 2 },
                denotation: { type: 'string', id: 3 },
              },
            },
          },
        },
        TypeProto: {
          oneofs: { value: { oneof: ['tensorType'] } },
          fields: {
            tensorType: { type: 'Tensor', id: 1 },
            denotation: { type: 'string', id: 6 },
          },
          nested: {
            Tensor: {
              fields: {
                elemType: { type: 'int32', id: 1 },
                shape: { type: 'TensorShapeProto', id: 2 },
              },
            },
          },
        },
      },
    },
  },
};

const root = protobuf.Root.fromJSON(schema);
const ModelProto = root.lookupType('onnx.ModelProto');

/** TensorProto.DataType for float32. */
export const FLOAT = 1;

/** Decodes an ONNX file into a plain object (int64 fields as numbers). */
export function decodeModel(bytes) {
  const message = ModelProto.decode(bytes);
  return ModelProto.toObject(message, { longs: Number, bytes: Uint8Array, defaults: false, arrays: true });
}

/** Encodes a plain model object (as from decodeModel) back to ONNX bytes. */
export function encodeModel(model) {
  const error = ModelProto.verify(model);
  if (error) throw new Error(`ONNX model: ${error}`);
  return ModelProto.encode(ModelProto.fromObject(model)).finish();
}

/** A float32 initializer from a Float32Array and its shape. */
export function floatTensor(name, data, dims) {
  const bytes = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return { name, dims, dataType: FLOAT, rawData: bytes };
}

/** The values of a float32 initializer (raw_data or float_data). */
export function tensorValues(tensor) {
  if (tensor.rawData && tensor.rawData.length) {
    const copy = new Uint8Array(tensor.rawData); // a real copy: Node Buffers are unaligned views
    return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
  }
  return Float32Array.from(tensor.floatData ?? []);
}

/** An ONNX node. */
export function node(opType, inputs, outputs, name, attributes = []) {
  return { opType, input: inputs, output: outputs, name, attribute: attributes };
}
