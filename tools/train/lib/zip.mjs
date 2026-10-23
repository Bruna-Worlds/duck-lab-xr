// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * A small .zip writer (deflate, no dependencies): Duck Lab XR's export downloads
 * and NumPy .npz files (a zip of .npy arrays) are made with it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS date and time fields for a JavaScript date. */
function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/**
 * entries: [{ name: 'dir/file.txt', data: Buffer | Uint8Array | string, store?: boolean }].
 * Returns the archive. Files that do not shrink are stored as they are.
 */
export function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, day } = dosTime(new Date());
  for (const entry of entries) {
    const name = Buffer.from(entry.name.split(sep).join('/'), 'utf8');
    const raw = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength);
    const packed = entry.store ? null : deflateRawSync(raw, { level: 6 });
    const deflate = !!packed && packed.length < raw.length;
    const body = deflate ? packed : raw;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, body);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4); // made by
    head.writeUInt16LE(20, 6); // needed
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(deflate ? 8 : 0, 10);
    head.writeUInt16LE(time, 12);
    head.writeUInt16LE(day, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(body.length, 20);
    head.writeUInt32LE(raw.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, name);
    offset += local.length + name.length + body.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, end]);
}

/** Every file under `dir`, as zip entries named `prefix/<path>`. */
export function directoryEntries(dir, prefix) {
  const out = [];
  const walk = (folder) => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push({ name: `${prefix}/${relative(dir, path).split(sep).join('/')}`, data: readFileSync(path) });
    }
  };
  walk(dir);
  return out;
}

/** A NumPy .npy file for a float32 or int32 array of the given shape. */
export function npy(array, shape) {
  const descr = array instanceof Int32Array ? '<i4' : array instanceof Uint8Array ? '|u1' : '<f4';
  const dict = `{'descr': '${descr}', 'fortran_order': False, 'shape': (${shape.join(', ')}${shape.length === 1 ? ',' : ''}), }`;
  // magic (6) + version (2) + header length (2) + header, padded with spaces to a multiple of 64, ending in \n.
  const total = Math.ceil((10 + dict.length + 1) / 64) * 64;
  const header = Buffer.alloc(total, 0x20);
  header.write('\x93NUMPY', 0, 'latin1');
  header[6] = 1;
  header[7] = 0;
  header.writeUInt16LE(total - 10, 8);
  header.write(dict, 10, 'latin1');
  header[total - 1] = 0x0a;
  return Buffer.concat([header, Buffer.from(array.buffer, array.byteOffset, array.byteLength)]);
}

/** A NumPy .npz (a zip of .npy arrays): arrays = { name: [typedArray, shape] }. */
export function npz(arrays) {
  return zip(Object.entries(arrays).map(([name, [array, shape]]) => ({ name: `${name}.npy`, data: npy(array, shape) })));
}
