import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { providerConfigDocumentSchema } from './schema.js';
import type { ProviderConfig, ProvidersFile } from '../domain/types.js';

const CONFIG_EXTENSIONS = new Set(['.yaml', '.yml', '.json']);

function normalizeDocument(parsed: unknown): ProviderConfig[] {
  const validated = providerConfigDocumentSchema.parse(parsed);
  return 'providers' in validated ? validated.providers : [validated];
}

async function readConfigDocument(filePath: string): Promise<ProviderConfig[]> {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = YAML.parse(raw);
  return normalizeDocument(parsed);
}

async function listConfigFiles(dirPath: string): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && CONFIG_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(dirPath, entry.name))
    .sort();
}

export async function loadProvidersConfig(configPath: string): Promise<ProvidersFile> {
  const resolvedPath = path.resolve(configPath);
  const stat = await fs.stat(resolvedPath);

  const providers = stat.isDirectory()
    ? (await Promise.all((await listConfigFiles(resolvedPath)).map((filePath) => readConfigDocument(filePath)))).flat()
    : await readConfigDocument(resolvedPath);

  if (providers.length === 0) {
    throw new Error(`No provider configs found in ${resolvedPath}`);
  }

  const seenProviderIds = new Set<string>();
  for (const provider of providers) {
    if (seenProviderIds.has(provider.provider_id)) {
      throw new Error(`Duplicate provider_id detected: ${provider.provider_id}`);
    }
    seenProviderIds.add(provider.provider_id);
  }

  return { providers };
}

export function resolveProviderSecrets(provider: ProviderConfig, apiKeyOverride?: string): ProviderConfig {
  if (apiKeyOverride) {
    return {
      ...provider,
      api_key: apiKeyOverride,
    };
  }

  if (provider.api_key || !provider.api_key_env) {
    return provider;
  }

  const envValue = process.env[provider.api_key_env];
  if (!envValue) {
    throw new Error(
      `Provider ${provider.provider_id} requires env var ${provider.api_key_env}, but it is not set.`,
    );
  }

  return {
    ...provider,
    api_key: envValue,
  };
}

export async function loadResolvedProvider(configPath: string, providerId: string): Promise<ProviderConfig> {
  const providersFile = await loadProvidersConfig(configPath);
  const provider = providersFile.providers.find((item) => item.provider_id === providerId);
  if (!provider) {
    throw new Error(`Provider ${providerId} not found in ${configPath}`);
  }
  return resolveProviderSecrets(provider);
}
