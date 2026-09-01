import type { EInvoiceProvider } from './types.js';
import { stubProvider } from './stub.js';

const providers = new Map<string, EInvoiceProvider>();

export function registerEInvoiceProvider(provider: EInvoiceProvider): void {
  providers.set(provider.code, provider);
}

export function getEInvoiceProvider(code?: string): EInvoiceProvider {
  const wanted = code ?? process.env.EINVOICE_PROVIDER ?? 'stub';
  const provider = providers.get(wanted);
  if (!provider) {
    throw new Error(
      `e-Fatura sağlayıcısı bulunamadı: "${wanted}". Kayıtlı: ${[...providers.keys()].join(', ')}`,
    );
  }
  return provider;
}

registerEInvoiceProvider(stubProvider);
