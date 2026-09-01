import { coreModule, type SezraModule } from '@sezra/core';
import { crmModule } from '@sezra/crm';

/**
 * Yüklenecek modüller.
 *
 * Yeni bir modül eklemek = migration'ını yazmak + bu listeye eklemek.
 * Sunucu, veritabanında core.modules'ta kayıtlı olmayan bir modülü reddeder.
 */
export const modules: SezraModule[] = [coreModule, crmModule];
