import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AudioAsset } from '../domain/types.js';

const formatAliases: Record<string, string> = {
  wave: 'wav',
};

const supportedFormats = new Set(['wav', 'mp3', 'm4a', 'flac', 'ogg', 'aac']);

export async function createAudioAsset(filePath: string): Promise<AudioAsset> {
  const resolvedPath = path.resolve(filePath);
  const stat = await fs.stat(resolvedPath);
  const fileBuffer = await fs.readFile(resolvedPath);
  const filename = path.basename(resolvedPath);
  const extension = path.extname(filename).slice(1).toLowerCase();
  const format = formatAliases[extension] ?? extension;
  const audioId = crypto.createHash('sha1').update(resolvedPath).digest('hex').slice(0, 12);

  return {
    audio_id: audioId,
    path: resolvedPath,
    filename,
    format,
    size_bytes: stat.size,
    duration_ms: detectDurationMs(fileBuffer, format),
  };
}

function detectDurationMs(fileBuffer: Buffer, format: string): number | undefined {
  if (format !== 'wav') {
    return undefined;
  }

  if (fileBuffer.length < 44) {
    return undefined;
  }

  const channels = fileBuffer.readUInt16LE(22);
  const sampleRate = fileBuffer.readUInt32LE(24);
  const bitsPerSample = fileBuffer.readUInt16LE(34);
  const dataSize = fileBuffer.readUInt32LE(40);

  if (!channels || !sampleRate || !bitsPerSample) {
    return undefined;
  }

  const bytesPerSample = bitsPerSample / 8;
  const totalSamples = dataSize / (channels * bytesPerSample);
  if (!Number.isFinite(totalSamples) || totalSamples <= 0) {
    return undefined;
  }

  return Math.round((totalSamples / sampleRate) * 1000);
}

export async function collectAudioAssets(inputPath: string): Promise<AudioAsset[]> {
  const resolvedPath = path.resolve(inputPath);
  const stat = await fs.stat(resolvedPath);

  if (stat.isFile()) {
    const asset = await createAudioAsset(resolvedPath);
    if (!supportedFormats.has(asset.format)) {
      throw new Error(`Unsupported audio format for ${asset.path}`);
    }
    return [asset];
  }

  const files = await walkFiles(resolvedPath);
  const assets = await Promise.all(files.map((filePath) => createAudioAsset(filePath)));
  const filtered = assets.filter((asset) => supportedFormats.has(asset.format));

  if (filtered.length === 0) {
    throw new Error(`No supported audio files found in ${resolvedPath}`);
  }

  return filtered.sort((a, b) => a.path.localeCompare(b.path));
}

async function walkFiles(dirPath: string): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const results = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        return walkFiles(fullPath);
      }
      if (entry.isFile()) {
        return [fullPath];
      }
      return [];
    }),
  );
  return results.flat();
}

export function inferAudioMimeType(format: string): string {
  switch (format) {
    case 'wav':
      return 'audio/wav';
    case 'mp3':
      return 'audio/mpeg';
    case 'm4a':
      return 'audio/mp4';
    case 'flac':
      return 'audio/flac';
    case 'ogg':
      return 'audio/ogg';
    case 'aac':
      return 'audio/aac';
    default:
      return `audio/${format}`;
  }
}
