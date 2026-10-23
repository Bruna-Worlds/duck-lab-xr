// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * One WebRTC data channel between the headset and the trainer page, carrying
 * JSON messages and files (link-protocol.ts). The data goes straight between
 * the two devices over the home network; only the offer and the answer pass
 * through the rendezvous. Offers and answers carry all their ICE candidates
 * ("vanilla ICE"), so setting up takes one message each way.
 *
 * No STUN or TURN server by default: two devices on one network reach each
 * other through their local (mDNS-named) candidates.
 */
import { CHUNK_BYTES, type FileHeader, type LinkMessage, MAX_FILE_BYTES } from './link-protocol.js';

export type LinkState = 'connecting' | 'open' | 'closed';

/** Longest wait for ICE candidates before sending what there is. */
const GATHER_MS = 3000;
/** Pause sending once this much is queued in the channel. */
const HIGH_WATER = 1024 * 1024;

export class PeerLink {
  state: LinkState = 'connecting';
  onMessage: ((message: LinkMessage) => void) | null = null;
  onFile: ((header: FileHeader, bytes: Uint8Array) => void) | null = null;
  onState: ((state: LinkState) => void) | null = null;
  private channel: RTCDataChannel | null = null;
  private incoming: { header: FileHeader; bytes: Uint8Array; filled: number } | null = null;
  private sending: Promise<void> = Promise.resolve();

  private constructor(private readonly pc: RTCPeerConnection) {
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.setState('closed');
    });
  }

  /** The calling side (the headset): opens the channel and makes an offer. */
  static async offer(iceServers: RTCIceServer[] = []): Promise<{ link: PeerLink; sdp: string }> {
    const pc = new RTCPeerConnection({ iceServers });
    const link = new PeerLink(pc);
    link.attach(pc.createDataChannel('duck-lab', { ordered: true }));
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    return { link, sdp: pc.localDescription?.sdp ?? '' };
  }

  /** The answering side (the trainer page). */
  static async answer(offerSdp: string, iceServers: RTCIceServer[] = []): Promise<{ link: PeerLink; sdp: string }> {
    const pc = new RTCPeerConnection({ iceServers });
    const link = new PeerLink(pc);
    pc.addEventListener('datachannel', (event) => link.attach(event.channel));
    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);
    return { link, sdp: pc.localDescription?.sdp ?? '' };
  }

  /** The caller takes the answer. */
  async accept(answerSdp: string): Promise<void> {
    await this.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  }

  get open(): boolean {
    return this.state === 'open';
  }

  send(message: LinkMessage): boolean {
    if (this.channel?.readyState !== 'open') return false;
    this.channel.send(JSON.stringify(message));
    return true;
  }

  /** Sends a file; files go one after another, each whole. */
  sendFile(header: FileHeader, bytes: Uint8Array): Promise<void> {
    const job = this.sending.then(() => this.pump(header, bytes));
    this.sending = job.catch(() => undefined);
    return job;
  }

  close(): void {
    try {
      this.channel?.close();
    } catch {
      // already closed
    }
    this.pc.close();
    this.setState('closed');
  }

  private attach(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = HIGH_WATER / 4;
    channel.addEventListener('open', () => this.setState('open'));
    channel.addEventListener('close', () => this.setState('closed'));
    channel.addEventListener('message', (event: MessageEvent<string | ArrayBuffer>) => this.receive(event.data));
  }

  private setState(state: LinkState): void {
    if (this.state === state || this.state === 'closed') return;
    this.state = state;
    if (state === 'closed') this.incoming = null;
    this.onState?.(state);
  }

  private async pump(header: FileHeader, bytes: Uint8Array): Promise<void> {
    const channel = this.channel;
    if (!channel || channel.readyState !== 'open') throw new Error('not connected');
    channel.send(JSON.stringify({ t: 'file', ...header, size: bytes.byteLength } satisfies LinkMessage));
    for (let at = 0; at < bytes.byteLength; at += CHUNK_BYTES) {
      if (channel.bufferedAmount > HIGH_WATER) await drained(channel);
      if (channel.readyState !== 'open') throw new Error('the link closed while sending');
      channel.send(bytes.subarray(at, Math.min(bytes.byteLength, at + CHUNK_BYTES)) as Uint8Array<ArrayBuffer>);
    }
  }

  private receive(data: string | ArrayBuffer): void {
    if (typeof data === 'string') {
      let message: LinkMessage;
      try {
        message = JSON.parse(data) as LinkMessage;
      } catch {
        return;
      }
      if (message.t === 'file') {
        const size = Math.max(0, Math.floor(Number(message.size) || 0));
        if (size > MAX_FILE_BYTES) {
          this.close();
          return;
        }
        this.incoming = { header: { kind: message.kind, name: message.name, release: message.release }, bytes: new Uint8Array(size), filled: 0 };
        if (size === 0) this.finishFile();
        return;
      }
      this.onMessage?.(message);
      return;
    }
    const file = this.incoming;
    if (!file) return;
    const chunk = new Uint8Array(data);
    const n = Math.min(chunk.byteLength, file.bytes.byteLength - file.filled);
    file.bytes.set(chunk.subarray(0, n), file.filled);
    file.filled += n;
    if (file.filled >= file.bytes.byteLength) this.finishFile();
  }

  private finishFile(): void {
    const file = this.incoming;
    this.incoming = null;
    if (file) this.onFile?.(file.header, file.bytes);
  }
}

/** Resolves once ICE gathering is complete, or after GATHER_MS with what there is. */
function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    const timer = setTimeout(done, GATHER_MS);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

function drained(channel: RTCDataChannel): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      channel.removeEventListener('bufferedamountlow', done);
      channel.removeEventListener('close', done);
      resolve();
    };
    channel.addEventListener('bufferedamountlow', done);
    channel.addEventListener('close', done);
  });
}
