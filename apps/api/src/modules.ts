import { coreModule, type SezraModule } from '@sezra/core';
import { crmModule } from '@sezra/crm';
import { financeModule } from '@sezra/finance';
import { hrModule } from '@sezra/hr';
import { purchasingModule } from '@sezra/purchasing';
import { inventoryModule } from '@sezra/inventory';
import { qualityModule } from '@sezra/quality';
import { maintenanceModule } from '@sezra/maintenance';
import { posModule } from '@sezra/pos';
import { projectsModule } from '@sezra/projects';
import { helpdeskModule } from '@sezra/helpdesk';

/**
 * Yüklenecek modüller.
 *
 * Yeni bir modül eklemek = migration'ını yazmak + bu listeye eklemek.
 * Sunucu, veritabanında core.modules'ta kayıtlı olmayan bir modülü reddeder.
 */
export const modules: SezraModule[] = [coreModule, crmModule, financeModule, hrModule, purchasingModule, inventoryModule, qualityModule, maintenanceModule, posModule, projectsModule, helpdeskModule];
