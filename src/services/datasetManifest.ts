import fs from 'node:fs/promises';
import path from 'node:path';
import type { AudioAsset } from '../domain/types.js';

export interface DatasetManifestItem {
  path: string;
  reference_text?: string;
  reference_path?: string;
  language?: string;
  speaker?: string;
  tags?: string[];
}

export interface DatasetManifest {
  items: DatasetManifestItem[];
}

export async function applyDatasetManifest(
  audioAssets: AudioAsset[],
  options: {
    inputPath: string;
    manifestPath?: string;
  },
): Promise<AudioAsset[]> {
  const manifest = await loadDatasetManifest(options.inputPath, options.manifestPath);
  if (!manifest) {
    return audioAssets;
  }

  const manifestDir = path.dirname(manifest.manifestPath);
  const inputRoot = path.resolve(options.inputPath);
  const itemMap = new Map<string, DatasetManifestItem>();

  for (const item of manifest.data.items) {
    const normalizedKey = normalizeManifestKey(item.path);
    itemMap.set(normalizedKey, item);
  }

  return Promise.all(
    audioAssets.map(async (audio) => {
      const key = buildAudioLookupKey(audio.path, inputRoot);
      const fallbackKey = normalizeManifestKey(audio.filename);
      const manifestItem = itemMap.get(key) ?? itemMap.get(fallbackKey);
      if (!manifestItem) {
        return audio;
      }

      let referenceText = manifestItem.reference_text;
      let referencePath: string | undefined;

      if (!referenceText && manifestItem.reference_path) {
        referencePath = path.resolve(manifestDir, manifestItem.reference_path);
        try {
          referenceText = (await fs.readFile(referencePath, 'utf8')).trim();
        } catch {
          referenceText = undefined;
        }
      }

      return {
        ...audio,
        language: manifestItem.language ?? audio.language,
        speaker: manifestItem.speaker ?? audio.speaker,
        tags: manifestItem.tags ?? audio.tags,
        reference_text: referenceText ?? audio.reference_text,
        reference_path: referencePath ?? audio.reference_path,
      };
    }),
  );
}

async function loadDatasetManifest(
  inputPath: string,
  explicitManifestPath?: string,
): Promise<{ data: DatasetManifest; manifestPath: string } | undefined> {
  const candidates = explicitManifestPath
    ? [path.resolve(explicitManifestPath)]
    : await discoverManifestCandidates(inputPath);

  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(candidate, 'utf8');
      const parsed = JSON.parse(raw) as DatasetManifest;
      if (!Array.isArray(parsed.items)) {
        continue;
      }
      return {
        data: parsed,
        manifestPath: candidate,
      };
    } catch {
      // Ignore unreadable or malformed manifest candidates.
    }
  }

  return undefined;
}

async function discoverManifestCandidates(inputPath: string): Promise<string[]> {
  const resolvedInputPath = path.resolve(inputPath);
  const stat = await fs.stat(resolvedInputPath);
  const roots = stat.isDirectory() ? [resolvedInputPath] : [path.dirname(resolvedInputPath)];
  return roots.flatMap((root) => [
    path.join(root, 'dataset.manifest.json'),
    path.join(root, 'manifest.json'),
  ]);
}

function buildAudioLookupKey(audioPath: string, inputRoot: string): string {
  const relative = path.relative(inputRoot, audioPath);
  if (!relative.startsWith('..') && relative !== '') {
    return normalizeManifestKey(relative);
  }
  return normalizeManifestKey(path.basename(audioPath));
}

function normalizeManifestKey(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}
