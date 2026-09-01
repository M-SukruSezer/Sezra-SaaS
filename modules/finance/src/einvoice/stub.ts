import { randomUUID } from 'node:crypto';
import type { CanonicalInvoice, EInvoiceProvider, SendResult, StatusResult } from './types.js';

/**
 * Sağlayıcı seçilene kadar kullanılan yer tutucu.
 *
 * GİB'e hiçbir şey göndermez; ETTN üretir ve "gönderildi" der. Amacı, ürünün
 * geri kalanının (kuyruk, durum takibi, yeniden deneme, UI) gerçek entegratör
 * gelmeden önce yazılabilmesi ve test edilebilmesidir. Üretimde bu adapter'ın
 * seçili olması, faturaların GİB'e gitmediği anlamına gelir — bu yüzden
 * NODE_ENV=production altında açıkça izin verilmesi gerekir.
 */
class StubProvider implements EInvoiceProvider {
  readonly code = 'stub';

  private assertAllowed(): void {
    if (process.env.NODE_ENV === 'production' && process.env.EINVOICE_ALLOW_STUB !== 'yes') {
      throw new Error(
        'Üretimde stub e-Fatura sağlayıcısı kullanılamaz: faturalar GİB\'e gönderilmez. ' +
        'Gerçek entegratör adapter\'ını yapılandırın.',
      );
    }
  }

  async isRegistered(taxNumber: string): Promise<boolean> {
    this.assertAllowed();
    // Yer tutucu kural: VKN (10 hane) kurumsaldır -> e-Fatura, TCKN -> e-Arşiv.
    return taxNumber.length === 10;
  }

  async send(invoice: CanonicalInvoice): Promise<SendResult> {
    this.assertAllowed();
    return {
      ettn: randomUUID(),
      gibNumber: `GIB${new Date().getFullYear()}${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
      status: 'sent',
      raw: { provider: 'stub', invoiceId: invoice.invoiceId, profile: invoice.profile },
    };
  }

  async status(ettn: string): Promise<StatusResult> {
    this.assertAllowed();
    return { status: 'delivered', raw: { provider: 'stub', ettn } };
  }

  async cancel(_ettn: string, _reason: string): Promise<void> {
    this.assertAllowed();
  }
}

export const stubProvider = new StubProvider();
