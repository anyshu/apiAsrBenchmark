import fs from 'node:fs/promises';
import path from 'node:path';
import type { AccuracyMetrics, AudioAsset } from '../domain/types.js';

export interface ReferenceOptions {
  sidecar?: boolean;
  referenceDir?: string;
  inputPath: string;
}

export async function attachReferenceTexts(
  audioAssets: AudioAsset[],
  options: ReferenceOptions,
): Promise<AudioAsset[]> {
  const resolvedInputPath = path.resolve(options.inputPath);
  const resolvedReferenceDir = options.referenceDir ? path.resolve(options.referenceDir) : undefined;

  return Promise.all(
    audioAssets.map(async (audio) => {
      const referencePath = await findReferencePath(audio.path, resolvedInputPath, {
        sidecar: options.sidecar ?? false,
        referenceDir: resolvedReferenceDir,
      });

      if (!referencePath) {
        return audio;
      }

      const referenceText = (await fs.readFile(referencePath, 'utf8')).trim();
      if (!referenceText) {
        return audio;
      }

      return {
        ...audio,
        reference_text: referenceText,
        reference_path: referencePath,
      };
    }),
  );
}

async function findReferencePath(
  audioPath: string,
  inputPath: string,
  options: { sidecar: boolean; referenceDir?: string },
): Promise<string | undefined> {
  const candidates: string[] = [];
  const parsed = path.parse(audioPath);

  if (options.sidecar) {
    candidates.push(path.join(parsed.dir, `${parsed.name}.txt`));
  }

  if (options.referenceDir) {
    const relativeBase = await resolveRelativeBase(audioPath, inputPath);
    candidates.push(path.join(options.referenceDir, `${relativeBase}.txt`));
  }

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    } catch {
      // Ignore missing reference candidates.
    }
  }

  return undefined;
}

async function resolveRelativeBase(audioPath: string, inputPath: string): Promise<string> {
  const inputStat = await fs.stat(inputPath);
  if (inputStat.isDirectory()) {
    return stripExtension(path.relative(inputPath, audioPath));
  }
  return path.parse(audioPath).name;
}

function stripExtension(value: string): string {
  const parsed = path.parse(value);
  return parsed.dir ? path.join(parsed.dir, parsed.name) : parsed.name;
}

export function evaluateTranscript(referenceText: string, hypothesisText: string): AccuracyMetrics {
  const normalizedReference = normalizeForComparison(referenceText);
  const normalizedHypothesis = normalizeForComparison(hypothesisText);
  const referenceWords = tokenizeWords(normalizedReference);
  const hypothesisWords = tokenizeWords(normalizedHypothesis);
  const referenceChars = tokenizeChars(normalizedReference);
  const hypothesisChars = tokenizeChars(normalizedHypothesis);
  const wordDistance = levenshtein(referenceWords, hypothesisWords);
  const charDistance = levenshtein(referenceChars, hypothesisChars);

  return {
    reference_text: referenceText,
    normalized_reference_text: normalizedReference,
    normalized_hypothesis_text: normalizedHypothesis,
    word_error_rate: safeRate(wordDistance, referenceWords.length),
    char_error_rate: safeRate(charDistance, referenceChars.length),
    word_distance: wordDistance,
    char_distance: charDistance,
    reference_word_count: referenceWords.length,
    reference_char_count: referenceChars.length,
  };
}

function normalizeForComparison(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeWords(text: string): string[] {
  if (!text) {
    return [];
  }

  const tokens: string[] = [];
  let buffer = '';
  for (const char of text) {
    if (/\s/u.test(char)) {
      if (buffer) {
        tokens.push(buffer);
        buffer = '';
      }
      continue;
    }

    if (/\p{Script=Han}/u.test(char)) {
      if (buffer) {
        tokens.push(buffer);
        buffer = '';
      }
      tokens.push(char);
      continue;
    }

    buffer += char;
  }

  if (buffer) {
    tokens.push(buffer);
  }

  return tokens;
}

function tokenizeChars(text: string): string[] {
  return Array.from(text.replace(/\s+/g, ''));
}

function levenshtein<T>(source: T[], target: T[]): number {
  if (source.length === 0) {
    return target.length;
  }
  if (target.length === 0) {
    return source.length;
  }

  const previous = Array.from({ length: target.length + 1 }, (_, index) => index);
  const current = new Array<number>(target.length + 1).fill(0);

  for (let i = 1; i <= source.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= target.length; j += 1) {
      const substitutionCost = source[i - 1] === target[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + substitutionCost,
      );
    }
    for (let j = 0; j < current.length; j += 1) {
      previous[j] = current[j];
    }
  }

  return previous[target.length];
}

function safeRate(distance: number, denominator: number): number {
  if (denominator <= 0) {
    return distance === 0 ? 0 : 1;
  }
  return Math.round((distance / denominator) * 1000) / 1000;
}
