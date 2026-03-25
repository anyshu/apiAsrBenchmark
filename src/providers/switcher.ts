import type { AsrProviderAdapter, ProviderConfig, ProviderSwitcher } from '../domain/types.js';
import { CustomHttpAdapter } from './customHttpAdapter.js';
import { OpenAICompatibleAdapter } from './openaiCompatibleAdapter.js';
import { ZenMuxAdapter } from './zenmuxAdapter.js';

export class DefaultProviderSwitcher implements ProviderSwitcher {
  resolve(provider: ProviderConfig): AsrProviderAdapter {
    switch (provider.type) {
      case 'openai_compatible':
        return new OpenAICompatibleAdapter();
      case 'zenmux':
        return new ZenMuxAdapter();
      case 'custom_http':
        return new CustomHttpAdapter();
      default:
        throw new Error(`Unsupported provider type: ${(provider as ProviderConfig).type}`);
    }
  }
}
