/// <reference types="node" />
/**
 * Type definitions for uareu-napi — see index.js for full JSDoc.
 */

import { EventEmitter } from "events";

export interface DeviceInfo {
  name: string;
  vendor: string;
  product: string;
  serial: string;
  modality: number;
  technology: number;
  vendorId: number;
  productId: number;
}

export interface Capabilities {
  canCaptureImage: boolean;
  canStreamImage: boolean;
  canExtractFeatures: boolean;
  canMatch: boolean;
  canIdentify: boolean;
  hasFpStorage: boolean;
  indicatorType: number;
  hasPowerMgmt: boolean;
  hasCalibration: boolean;
  pivCompliant: boolean;
  resolutions: number[];
}

export interface ReaderStatus {
  status: number;
  fingerDetected: boolean;
}

export interface CaptureOptions {
  fmt?: number;
  proc?: number;
  dpi?: number;
  timeout?: number;
}

export interface CaptureResult {
  success: boolean;
  quality: number;
  score: number;
  width: number;
  height: number;
  dpi: number;
  bpp: number;
  image: Buffer | null;
}

export interface RawExtractOptions {
  width: number;
  height: number;
  dpi?: number;
  fingerPos?: number;
  cbeffId?: number;
  fmdType?: number;
}

export interface CompareResult {
  score: number;
  falseMatchRate: number;
}

export interface Candidate {
  index: number;
  viewIdx: number;
}

export interface VersionInfo {
  capture: { major: number; minor: number; maintenance: number };
  fingerjet: { major: number; minor: number; maintenance: number };
}

export type ScanFailReason = "no-device" | "timeout" | "bad-quality";

export interface ScanOnceOptions {
  deviceName?: string;
  exclusive?: boolean;
  timeout?: number;
  attemptTimeout?: number;
  extract?: boolean;
  fmdType?: number;
  fmt?: number;
  proc?: number;
  dpi?: number;
  bmp?: boolean;
  pad?: boolean;
  onQuality?: (qualityCode: number, message: string) => void;
}

export interface ScanOnceResult {
  success: boolean;
  reason: ScanFailReason | null;
  device?: string;
  attempts: number;
  quality?: number | null;
  qualityText?: string | null;
  width?: number;
  height?: number;
  dpi?: number;
  bpp?: number;
  score?: number;
  image?: Buffer;
  fmd?: Buffer;
  bmp?: Buffer;
  bmpDataUrl?: string;
}

export interface ScannerOptions {
  deviceName?: string;
  exclusive?: boolean;
  attemptTimeout?: number;
  fmt?: number;
  proc?: number;
  dpi?: number;
  extract?: boolean;
  fmdType?: number;
}

export interface ScanEvent {
  device: string | null;
  width: number;
  height: number;
  dpi: number;
  bpp: number;
  score: number;
  quality: number;
  image: Buffer;
  fmd: Buffer | null;
}

export declare class Scanner extends EventEmitter {
  constructor(options?: ScannerOptions);
  readonly device: DeviceInfo | null;
  readonly isOpen: boolean;
  readonly isScanning: boolean;
  open(): Promise<DeviceInfo>;
  start(): this;
  stop(): this;
  close(): Promise<void>;
  on(event: "open", listener: (payload: { device: DeviceInfo }) => void): this;
  on(event: "scan", listener: (payload: ScanEvent) => void): this;
  on(event: "quality", listener: (qualityCode: number, message: string) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "close", listener: () => void): this;
}

export function openScanner(options?: ScannerOptions): Scanner;
export function scanOnce(options?: ScanOnceOptions): Promise<ScanOnceResult>;

export function init(): void;
export function exit(): void;
export function version(): VersionInfo;
export function selectEngine(engine?: number): void;
export function listDevices(): DeviceInfo[];
export function waitForDevice(options?: WaitForDeviceOptions): Promise<DeviceInfo>;

export interface WaitForDeviceOptions {
  deviceName?: string;
  timeout?: number;
  interval?: number;
}

export function open(name: string, exclusive?: boolean): number;
export function close(handle: number): void;
export function cancel(handle: number): void;
export function getCapabilities(handle: number): Capabilities;
export function getStatus(handle: number): ReaderStatus;

export function capture(handle: number, opts?: CaptureOptions): CaptureResult;
export function captureAsync(handle: number, opts?: CaptureOptions): Promise<CaptureResult>;

export function createFmdFromRaw(image: Buffer, opts: RawExtractOptions): Buffer;
export function createFmdFromFid(fid: Buffer, fidType: number, fmdType?: number): Buffer;
export function compare(
  fmd1: Buffer,
  type1: number,
  fmd2: Buffer,
  type2: number,
  view1?: number,
  view2?: number
): CompareResult;
export function identify(
  probe: Buffer,
  probeType: number,
  list: Buffer[],
  type?: number,
  threshold?: number
): Candidate[];

export function startEnrollment(fmdType?: number): void;
export function addToEnrollment(fmd: Buffer, fmdType?: number): boolean;
export function createEnrollmentFmd(): Buffer;
export function finishEnrollment(): void;

export function ledConfig(handle: number, ledId?: number, mode?: number): void;
export function ledCtrl(handle: number, ledId?: number, cmd?: number): void;
export function setPad(handle: number, enable: boolean): void;

export function qualityText(q: number): string;

export function toBmp(rawImage: Buffer, width: number, height: number, dpi?: number): Buffer;
export function toBmpDataUrl(rawImage: Buffer, width: number, height: number, dpi?: number): string;

export const C: {
  IMG_FMT: { PIXEL_BUFFER: number; ANSI381: number; ISOIEC19794: number };
  IMG_PROC: {
    DEFAULT: number;
    PIV: number;
    ENHANCED: number;
    ENHANCED_2: number;
    UNPROCESSED: number;
  };
  QUALITY: Record<string, number>;
  FID_FORMAT: { ANSI_381_2004: number; ISO_19794_4_2005: number };
  FMD_FORMAT: {
    ANSI_378_2004: number;
    ISO_19794_2_2005: number;
    DP_PRE_REG: number;
    DP_REG: number;
    DP_VER: number;
  };
  LED: {
    MAIN: number;
    REJECT: number;
    ACCEPT: number;
    FINGER_DETECT: number;
    ALL: number;
    MODE_AUTO: number;
    MODE_CLIENT: number;
    CMD_OFF: number;
    CMD_ON: number;
  };
  ENGINE: { DPFJ: number; INNOVATRICS_ANSIISO: number; DPFJ7: number };
  PROBABILITY_ONE: number;
  MAX_FMD_SIZE: number;
};
