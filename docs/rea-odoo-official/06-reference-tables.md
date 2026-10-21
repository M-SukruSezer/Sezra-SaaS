# 06 - Technical Reference Tables

Generated from the Phase 1-3 indexes by `gen_tables.py`. Every column is a
measured count, not an estimate.

**Column meanings.** *Depth* is the longest dependency path to a module with
no in-tree dependencies. *Dependents* counts modules naming this one in
`depends`. *Auto* marks `auto_install: True`. *Models defined* counts models
for which this module declares `_name`; *Models extended* counts models it
reopens with `_inherit` only. *Classes* is the number of model classes in the
module. *OWL comp* is `extends Component` occurrences and *patch()* is
frontend patch calls (both regex-derived, so approximate). *ir.access* is
security CSV rows and *w/domain* the subset carrying a record-rule domain.

## 1. The 34 declared applications

Modules with `application: True` — what appears as an installable app.

| Module | Category | Depth | Dependents | Auto | Models defined | Models extended | Classes | Routes | OWL comp | patch() | ir.access | w/domain |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `account` | Accounting/Accounting | 8 | 157 | - | 59 | 33 | 96 | 10 | 42 | 7 | 120 | 19 |
| `calendar` | Productivity/Calendar | 5 | 7 | - | 11 | 9 | 20 | 10 | 3 | 10 | 18 | 5 |
| `contacts` | Sales/CRM | 5 | 6 | - | 0 | 2 | 2 | 0 | 0 | 0 | 0 | 0 |
| `crm` | Sales/CRM | 8 | 16 | - | 12 | 11 | 23 | 3 | 5 | 2 | 34 | 6 |
| `data_recycle` | Productivity/Data Cleaning | 5 | 0 | - | 2 | 0 | 2 | 0 | 1 | 0 | 2 | 0 |
| `fleet` | Human Resources/Fleet | 5 | 4 | - | 14 | 3 | 17 | 0 | 0 | 0 | 29 | 7 |
| `hr` | Human Resources/Employees | 8 | 15 | - | 16 | 17 | 33 | 3 | 16 | 7 | 44 | 17 |
| `hr_attendance` | Human Resources/Attendances | 10 | 3 | - | 2 | 9 | 11 | 15 | 15 | 1 | 6 | 4 |
| `hr_expense` | Human Resources/Expenses | 9 | 3 | - | 6 | 17 | 24 | 0 | 2 | 2 | 22 | 12 |
| `hr_holidays` | Human Resources/Time Off | 10 | 6 | - | 18 | 18 | 36 | 5 | 5 | 10 | 48 | 17 |
| `hr_recruitment` | Human Resources/Recruitment | 9 | 4 | - | 14 | 15 | 29 | 0 | 1 | 1 | 35 | 5 |
| `hr_skills` | Human Resources/Employees | 9 | 5 | yes | 12 | 4 | 16 | 1 | 3 | 3 | 22 | 5 |
| `im_livechat` | Website/Live Chat | 8 | 6 | - | 10 | 13 | 23 | 51 | 11 | 50 | 15 | 3 |
| `lunch` | Human Resources/Lunch | 5 | 0 | - | 9 | 4 | 13 | 6 | 7 | 0 | 24 | 8 |
| `mail` | Productivity/Discuss | 4 | 44 | - | 68 | 23 | 94 | 69 | 168 | 100 | 95 | 36 |
| `maintenance` | Supply Chain/Maintenance | 5 | 3 | - | 6 | 1 | 7 | 0 | 0 | 0 | 15 | 6 |
| `marketing_card` | Marketing/Marketing Card | 9 | 1 | - | 4 | 4 | 8 | 6 | 0 | 0 | 10 | 1 |
| `mass_mailing` | Marketing/Email Marketing | 8 | 15 | - | 12 | 19 | 31 | 17 | 14 | 4 | 27 | 3 |
| `mass_mailing_sms` | Marketing/Email Marketing | 9 | 7 | - | 2 | 11 | 13 | 3 | 0 | 1 | 3 | 0 |
| `mrp` | Supply Chain/Manufacturing | 9 | 11 | - | 27 | 27 | 55 | 0 | 16 | 5 | 58 | 11 |
| `point_of_sale` | Sales/Point of Sale | 9 | 47 | - | 56 | 11 | 67 | 11 | 83 | 10 | 63 | 12 |
| `pos_restaurant` | Sales/Point of Sale | 10 | 5 | - | 4 | 9 | 13 | 0 | 13 | 20 | 7 | 0 |
| `project` | Services/Project | 8 | 10 | - | 21 | 12 | 33 | 9 | 11 | 12 | 66 | 28 |
| `project_todo` | Productivity/To-Do | 9 | 1 | yes | 1 | 2 | 3 | 0 | 1 | 1 | 13 | 8 |
| `purchase` | Supply Chain/Purchase | 9 | 8 | - | 6 | 15 | 21 | 5 | 6 | 1 | 35 | 9 |
| `repair` | Supply Chain/Inventory | 12 | 4 | - | 6 | 14 | 20 | 0 | 0 | 2 | 6 | 1 |
| `sale_management` | Sales/Sales | 11 | 9 | - | 2 | 5 | 7 | 1 | 2 | 17 | 6 | 2 |
| `stock` | Supply Chain/Inventory | 8 | 11 | - | 53 | 13 | 66 | 1 | 21 | 0 | 90 | 16 |
| `survey` | Marketing/Surveys | 8 | 4 | - | 6 | 7 | 13 | 23 | 2 | 0 | 14 | 9 |
| `website` | Website/Website | 8 | 56 | - | 37 | 27 | 67 | 64 | 68 | 26 | 33 | 4 |
| `website_event` | Marketing/Events | 10 | 6 | - | 4 | 8 | 12 | 9 | 0 | 2 | 17 | 6 |
| `website_hr_recruitment` | Website/Website | 10 | 1 | yes | 1 | 5 | 6 | 5 | 1 | 1 | 3 | 2 |
| `website_sale` | Website/Website | 12 | 15 | - | 17 | 26 | 43 | 62 | 9 | 17 | 38 | 8 |
| `website_slides` | Website/eLearning | 11 | 7 | - | 12 | 13 | 25 | 39 | 14 | 9 | 38 | 14 |


## 2. Top 40 hub modules by direct dependents

A change here has the widest blast radius.

| Module | Category | Depth | Dependents | Auto | Models defined | Models extended | Classes | Routes | OWL comp | patch() | ir.access | w/domain |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `account` | Accounting/Accounting | 8 | 157 | - | 59 | 33 | 96 | 10 | 42 | 7 | 120 | 19 |
| `website` | Website/Website | 8 | 56 | - | 37 | 27 | 67 | 64 | 68 | 26 | 33 | 4 |
| `point_of_sale` | Sales/Point of Sale | 9 | 47 | - | 56 | 11 | 67 | 11 | 83 | 10 | 63 | 12 |
| `mail` | Productivity/Discuss | 4 | 44 | - | 68 | 23 | 94 | 69 | 168 | 100 | 95 | 36 |
| `account_edi_ubl_cii` | Accounting/Accounting | 9 | 41 | yes | 15 | 8 | 23 | 0 | 0 | 0 | 0 | 0 |
| `base` | Hidden | 0 | 40 | yes | 126 | 2 | 128 | 0 | 0 | 0 | 141 | 28 |
| `web` | Hidden | 1 | 34 | yes | 2 | 14 | 16 | 73 | 310 | 5 | 3 | 1 |
| `payment` | Hidden | 7 | 25 | - | 7 | 7 | 14 | 7 | 0 | 0 | 12 | 6 |
| `sale` | Sales/Sales | 10 | 25 | - | 7 | 23 | 30 | 14 | 20 | 3 | 54 | 20 |
| `base_setup` | Hidden | 2 | 20 | yes | 1 | 3 | 4 | 3 | 1 | 0 | 0 | 0 |
| `sms` | Sales/Sales | 6 | 18 | yes | 9 | 9 | 18 | 1 | 1 | 7 | 10 | 0 |
| `digest` | Marketing | 7 | 17 | - | 3 | 2 | 5 | 3 | 0 | 0 | 5 | 0 |
| `l10n_syscohada` | Accounting/Localizations/Account Charts | 9 | 17 | - | 0 | 1 | 2 | 0 | 0 | 0 | 0 | 0 |
| `portal` | Hidden | 6 | 17 | - | 5 | 9 | 14 | 16 | 2 | 11 | 4 | 0 |
| `crm` | Sales/CRM | 8 | 16 | - | 12 | 11 | 23 | 3 | 5 | 2 | 34 | 6 |
| `hr` | Human Resources/Employees | 8 | 15 | - | 16 | 17 | 33 | 3 | 16 | 7 | 44 | 17 |
| `mass_mailing` | Marketing/Email Marketing | 8 | 15 | - | 12 | 19 | 31 | 17 | 14 | 4 | 27 | 3 |
| `website_sale` | Website/Website | 12 | 15 | - | 17 | 26 | 43 | 62 | 9 | 17 | 38 | 8 |
| `spreadsheet_dashboard` | Productivity/Dashboard | 8 | 13 | - | 4 | 0 | 4 | 4 | 11 | 2 | 10 | 5 |
| `l10n_account_withholding_tax` | Accounting/Localizations | 9 | 12 | - | 3 | 8 | 11 | 0 | 0 | 1 | 2 | 0 |
| `mrp` | Supply Chain/Manufacturing | 9 | 11 | - | 27 | 27 | 55 | 0 | 16 | 5 | 58 | 11 |
| `sale_stock` | Sales/Sales | 11 | 11 | yes | 1 | 20 | 21 | 3 | 3 | 1 | 18 | 1 |
| `stock` | Supply Chain/Inventory | 8 | 11 | - | 53 | 13 | 66 | 1 | 21 | 0 | 90 | 16 |
| `stock_account` | Supply Chain/Inventory | 9 | 11 | yes | 2 | 20 | 22 | 0 | 0 | 2 | 12 | 2 |
| `event` | Marketing/Events | 8 | 10 | - | 16 | 4 | 20 | 4 | 3 | 0 | 39 | 5 |
| `l10n_fr_account` | Accounting/Localizations/Account Charts | 10 | 10 | yes | 1 | 5 | 14 | 0 | 0 | 0 | 1 | 0 |
| `project` | Services/Project | 8 | 10 | - | 21 | 12 | 33 | 9 | 11 | 12 | 66 | 28 |
| `web_tour` | Hidden | 2 | 10 | yes | 2 | 2 | 4 | 0 | 4 | 2 | 4 | 0 |
| `account_debit_note` | Accounting/Accounting | 9 | 9 | - | 1 | 2 | 3 | 0 | 0 | 0 | 1 | 0 |
| `pos_self_order` | Sales/Point Of Sale | 11 | 9 | yes | 3 | 21 | 24 | 17 | 34 | 22 | 2 | 0 |
| `resource` | Hidden | 2 | 9 | - | 5 | 2 | 7 | 0 | 4 | 0 | 10 | 5 |
| `sale_management` | Sales/Sales | 11 | 9 | - | 2 | 5 | 7 | 1 | 2 | 17 | 6 | 2 |
| `utm` | Marketing | 2 | 9 | - | 6 | 1 | 7 | 0 | 0 | 0 | 10 | 0 |
| `html_editor` | Hidden | 3 | 8 | yes | 15 | 7 | 22 | 17 | 67 | 1 | 2 | 0 |
| `l10n_din5008` | Accounting/Localizations | 9 | 8 | yes | 0 | 4 | 4 | 0 | 0 | 0 | 0 | 0 |
| `l10n_gcc_invoice` | Accounting/Localizations | 9 | 8 | - | 0 | 5 | 5 | 0 | 0 | 0 | 0 | 0 |
| `l10n_latam_invoice_document` | Accounting/Localizations | 10 | 8 | - | 1 | 8 | 9 | 0 | 0 | 0 | 2 | 0 |
| `phone_validation` | Hidden | 5 | 8 | yes | 4 | 5 | 9 | 0 | 0 | 0 | 2 | 0 |
| `purchase` | Supply Chain/Purchase | 9 | 8 | - | 6 | 15 | 21 | 5 | 6 | 1 | 35 | 9 |
| `purchase_stock` | Supply Chain/Purchase | 10 | 8 | yes | 1 | 25 | 26 | 0 | 0 | 3 | 9 | 0 |


## 3. Top 40 auto-install bridge modules

`auto_install` modules that define or extend models, excluding tests,
localizations, and themes. These exist only to reconcile two other modules;
note how many define **zero** models of their own and operate purely by
extension.

| Module | Category | Depth | Dependents | Auto | Models defined | Models extended | Classes | Routes | OWL comp | patch() | ir.access | w/domain |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `purchase_stock` | Supply Chain/Purchase | 10 | 8 | yes | 1 | 25 | 26 | 0 | 0 | 3 | 9 | 0 |
| `pos_self_order` | Sales/Point Of Sale | 11 | 9 | yes | 3 | 21 | 24 | 17 | 34 | 22 | 2 | 0 |
| `sale_stock` | Sales/Sales | 11 | 11 | yes | 1 | 20 | 21 | 3 | 3 | 1 | 18 | 1 |
| `stock_account` | Supply Chain/Inventory | 9 | 11 | yes | 2 | 20 | 22 | 0 | 0 | 2 | 12 | 2 |
| `stock_delivery` | Shipping Connectors | 12 | 7 | yes | 1 | 19 | 20 | 0 | 0 | 1 | 10 | 0 |
| `sale_timesheet` | Sales/Sales | 14 | 3 | yes | 1 | 17 | 18 | 2 | 1 | 0 | 4 | 2 |
| `mrp_account` | Supply Chain/Manufacturing | 10 | 2 | yes | 4 | 16 | 20 | 0 | 0 | 4 | 6 | 0 |
| `pos_stock` | Sales/Point of Sale | 10 | 3 | yes | 3 | 16 | 19 | 0 | 2 | 13 | 7 | 0 |
| `sale_project` | Sales/Sales | 13 | 8 | yes | 0 | 15 | 15 | 0 | 0 | 2 | 2 | 2 |
| `pos_sale` | Sales/Point of Sale | 12 | 7 | yes | 2 | 12 | 14 | 0 | 0 | 7 | 3 | 0 |
| `account_payment` | Accounting/Accounting | 9 | 5 | yes | 1 | 11 | 12 | 5 | 0 | 1 | 4 | 0 |
| `account_peppol` | Accounting/Accounting | 10 | 2 | yes | 4 | 11 | 15 | 5 | 1 | 2 | 4 | 0 |
| `hr_holidays_attendance` | Human Resources | 11 | 0 | yes | 1 | 10 | 11 | 0 | 0 | 0 | 1 | 0 |
| `mrp_subcontracting_purchase` | Supply Chain/Purchase | 12 | 0 | yes | 0 | 10 | 10 | 0 | 0 | 0 | 0 | 0 |
| `pos_hr` | Sales/Point of Sale | 10 | 3 | yes | 3 | 10 | 13 | 0 | 1 | 10 | 0 | 0 |
| `pos_loyalty` | Sales/Point Of Sale | 10 | 2 | yes | 4 | 10 | 14 | 0 | 1 | 14 | 13 | 0 |
| `website_livechat` | Website/Live Chat | 9 | 3 | yes | 0 | 10 | 10 | 2 | 0 | 7 | 2 | 0 |
| `hr_fleet` | Human Resources | 9 | 1 | yes | 0 | 9 | 9 | 0 | 0 | 0 | 1 | 1 |
| `mrp_subcontracting_dropshipping` | Supply Chain/Purchase | 14 | 0 | yes | 0 | 9 | 9 | 0 | 0 | 0 | 0 | 0 |
| `purchase_mrp` | Supply Chain/Purchase | 11 | 1 | yes | 0 | 9 | 9 | 0 | 0 | 0 | 2 | 0 |
| `event_booth_sale` | Marketing/Events | 13 | 1 | yes | 2 | 8 | 10 | 0 | 0 | 2 | 4 | 0 |
| `project_timesheet_holidays` | Human Resources | 11 | 0 | yes | 0 | 8 | 8 | 0 | 0 | 0 | 1 | 0 |
| `website_event_sale` | Website/Website | 13 | 2 | yes | 0 | 8 | 8 | 1 | 0 | 0 | 0 | 0 |
| `website_sale_stock` | Website/Website | 13 | 2 | yes | 1 | 8 | 9 | 2 | 6 | 4 | 0 | 0 |
| `account_fleet` | Accounting/Accounting | 9 | 0 | yes | 0 | 7 | 7 | 0 | 0 | 0 | 0 | 0 |
| `sale_expense` | Sales/Sales | 12 | 3 | yes | 1 | 7 | 8 | 0 | 1 | 0 | 1 | 0 |
| `sale_loyalty` | Sales/Sales | 11 | 2 | yes | 3 | 7 | 10 | 1 | 0 | 1 | 17 | 0 |
| `sale_mrp` | Sales/Sales | 12 | 3 | yes | 0 | 7 | 7 | 0 | 0 | 0 | 6 | 0 |
| `crm_livechat` | Sales/CRM | 9 | 2 | yes | 0 | 6 | 6 | 0 | 0 | 3 | 2 | 2 |
| `event_product` | Marketing/Events | 9 | 2 | yes | 0 | 6 | 6 | 0 | 0 | 0 | 0 | 0 |
| `event_sale` | Marketing/Events | 12 | 7 | yes | 4 | 6 | 10 | 0 | 0 | 2 | 7 | 3 |
| `hr_gamification` | Human Resources | 9 | 0 | yes | 0 | 6 | 6 | 0 | 0 | 2 | 7 | 2 |
| `pos_online_payment` | - | 10 | 1 | yes | 0 | 6 | 6 | 3 | 0 | 8 | 1 | 0 |
| `pos_online_payment_self_order` | Sales/Point of Sale | 12 | 0 | yes | 0 | 6 | 6 | 2 | 0 | 4 | 0 | 0 |
| `pos_sale_stock` | Sales/Point of Sale | 13 | 0 | yes | 0 | 6 | 6 | 0 | 0 | 2 | 0 | 0 |
| `website_slides_survey` | Website/eLearning | 12 | 1 | yes | 0 | 6 | 6 | 3 | 0 | 3 | 5 | 5 |
| `hr_maintenance` | Human Resources | 9 | 0 | yes | 0 | 5 | 5 | 0 | 0 | 0 | 0 | 0 |
| `hr_skills_slides` | Human Resources/Employees | 12 | 0 | yes | 0 | 5 | 5 | 0 | 0 | 0 | 0 | 0 |
| `phone_validation` | Hidden | 5 | 8 | yes | 4 | 5 | 9 | 0 | 0 | 0 | 2 | 0 |
| `project_mrp` | Services/Project | 10 | 2 | yes | 0 | 5 | 5 | 0 | 0 | 0 | 2 | 0 |


## 4. The 40 largest models by field count

| Model | Fields | Rel | m2o | o2m | m2m | Computes | Constrains | Onchange | Ext by | Defined in |
|---|---|---|---|---|---|---|---|---|---|---|
| `res.config.settings` | 784 | 137 | 105 | 6 | 26 | 57 | 0 | 51 | 134 | `base` |
| `account.move` | 537 | 127 | 75 | 33 | 19 | 271 | 18 | 29 | 114 | `account`, `l10n_sa`, `point_of_sale`, `repair`, `sale` |
| `res.company` | 497 | 142 | 122 | 13 | 7 | 71 | 21 | 6 | 124 | `account`, `base`, `l10n_sg`, `point_of_sale` |
| `res.partner` | 305 | 68 | 35 | 24 | 9 | 107 | 18 | 18 | 117 | `base`, `bus`, `mail`, `phone_validation`, `point_of_sale`, `website`, `website_partner` |
| `hr.employee` | 205 | 62 | 37 | 18 | 7 | 52 | 4 | 9 | 18 | `hr`, `pos_hr` |
| `product.template` | 190 | 59 | 30 | 13 | 16 | 73 | 9 | 18 | 56 | `point_of_sale`, `product`, `website_sale` |
| `sale.order` | 175 | 55 | 33 | 8 | 14 | 101 | 5 | 15 | 44 | `pos_sale`, `sale`, `website_sale` |
| `pos.config` | 167 | 56 | 34 | 2 | 20 | 17 | 13 | 4 | 30 | `point_of_sale`, `pos_hr` |
| `res.users` | 162 | 67 | 30 | 21 | 16 | 31 | 6 | 5 | 52 | `base`, `bus`, `mail`, `point_of_sale` |
| `stock.picking` | 158 | 42 | 29 | 10 | 3 | 54 | 1 | 7 | 28 | `stock` |
| `account.move.line` | 148 | 58 | 42 | 7 | 9 | 60 | 7 | 8 | 44 | `account`, `l10n_ph_invoice` |
| `pos.order` | 148 | 32 | 21 | 7 | 4 | 30 | 0 | 3 | 31 | `l10n_sa_pos`, `point_of_sale` |
| `sale.order.line` | 134 | 50 | 26 | 13 | 11 | 87 | 3 | 10 | 36 | `l10n_ph_sale`, `pos_sale`, `sale`, `website_sale` |
| `payment.provider` | 130 | 20 | 13 | 4 | 3 | 9 | 15 | 3 | 31 | `payment` |
| `stock.move` | 128 | 55 | 35 | 8 | 12 | 75 | 1 | 3 | 31 | `stock` |
| `account.journal` | 115 | 30 | 23 | 4 | 3 | 34 | 14 | 4 | 41 | `account` |
| `account.tax` | 115 | 28 | 14 | 5 | 9 | 30 | 12 | 11 | 48 | `account`, `point_of_sale` |
| `stock.picking.type` | 113 | 18 | 14 | 0 | 4 | 24 | 4 | 2 | 10 | `pos_stock`, `stock` |
| `product.product` | 112 | 29 | 7 | 16 | 6 | 21 | 4 | 10 | 36 | `point_of_sale`, `product`, `website_sale` |
| `website` | 105 | 28 | 22 | 2 | 4 | 12 | 3 | 1 | 24 | `base`, `website` |
| `hr.employee.public` | 104 | 31 | 24 | 7 | 0 | 2 | 0 | 0 | 10 | `hr` |
| `mrp.production` | 103 | 41 | 20 | 11 | 10 | 54 | 3 | 3 | 9 | `mrp`, `mrp_account` |
| `pos.payment.method` | 103 | 11 | 6 | 0 | 5 | 9 | 15 | 5 | 27 | `point_of_sale` |
| `project.task` | 102 | 30 | 18 | 5 | 7 | 40 | 6 | 3 | 8 | `project` |
| `project.project` | 100 | 29 | 18 | 7 | 4 | 37 | 4 | 4 | 12 | `project` |
| `event.event` | 98 | 35 | 10 | 17 | 8 | 44 | 4 | 2 | 16 | `event`, `pos_event`, `website_event` |
| `crm.lead` | 94 | 29 | 20 | 3 | 6 | 41 | 1 | 0 | 12 | `crm` |
| `mailing.mailing` | 87 | 13 | 9 | 1 | 3 | 31 | 4 | 1 | 5 | `mass_mailing` |
| `account.payment` | 86 | 40 | 25 | 4 | 11 | 45 | 7 | 2 | 13 | `account` |
| `calendar.event` | 79 | 17 | 9 | 2 | 5 | 27 | 1 | 3 | 5 | `calendar`, `google_calendar`, `microsoft_calendar` |
| `purchase.order` | 74 | 22 | 16 | 2 | 4 | 38 | 1 | 10 | 15 | `purchase` |
| `discuss.channel` | 73 | 33 | 12 | 13 | 8 | 35 | 5 | 0 | 8 | `im_livechat`, `mail` |
| `slide.channel` | 73 | 21 | 9 | 6 | 6 | 21 | 0 | 0 | 5 | `website_slides` |
| `account.payment.register` | 72 | 29 | 14 | 2 | 13 | 52 | 0 | 5 | 9 | `account` |
| `hr.applicant` | 72 | 29 | 17 | 6 | 6 | 20 | 1 | 0 | 4 | `hr_recruitment` |
| `mail.message` | 70 | 38 | 19 | 12 | 6 | 10 | 0 | 0 | 13 | `mail` |
| `slide.slide` | 70 | 13 | 6 | 5 | 2 | 29 | 0 | 3 | 1 | `website_slides` |
| `fleet.vehicle` | 68 | 18 | 12 | 5 | 1 | 20 | 0 | 0 | 3 | `fleet` |
| `survey.survey` | 68 | 15 | 6 | 7 | 2 | 18 | 2 | 3 | 5 | `survey` |
| `hr.version` | 67 | 23 | 22 | 0 | 1 | 11 | 2 | 0 | 5 | `hr`, `hr_attendance` |


## 5. The 30 most-extended models

How many distinct modules reopen each model with `_inherit`.

| Model | Extended by | Fields | Computes | Abstract | Transient | Defined in |
|---|---|---|---|---|---|---|
| `res.config.settings` | 134 | 784 | 57 | - | yes | `base` |
| `account.chart.template` | 133 | 0 | 0 | yes | - | `account` |
| `res.company` | 124 | 497 | 71 | - | - | `account`, `base`, `l10n_sg`, `point_of_sale` |
| `res.partner` | 117 | 305 | 107 | - | - | `base`, `bus`, `mail`, `phone_validation`, `point_of_sale`, `website`, `website_partner` |
| `account.move` | 114 | 537 | 271 | - | - | `account`, `l10n_sa`, `point_of_sale`, `repair`, `sale` |
| `product.template` | 56 | 190 | 73 | - | - | `point_of_sale`, `product`, `website_sale` |
| `res.users` | 52 | 162 | 31 | - | - | `base`, `bus`, `mail`, `point_of_sale` |
| `account.tax` | 48 | 115 | 30 | - | - | `account`, `point_of_sale` |
| `ir.http` | 47 | 0 | 0 | yes | - | `base` |
| `account.move.line` | 44 | 148 | 60 | - | - | `account`, `l10n_ph_invoice` |
| `sale.order` | 44 | 175 | 101 | - | - | `pos_sale`, `sale`, `website_sale` |
| `account.journal` | 41 | 115 | 34 | - | - | `account` |
| `product.product` | 36 | 112 | 21 | - | - | `point_of_sale`, `product`, `website_sale` |
| `sale.order.line` | 36 | 134 | 87 | - | - | `l10n_ph_sale`, `pos_sale`, `sale`, `website_sale` |
| `theme.utils` | 36 | 0 | 0 | yes | - | `website` |
| `payment.provider` | 31 | 130 | 9 | - | - | `payment` |
| `payment.transaction` | 31 | 45 | 3 | - | - | `payment` |
| `pos.order` | 31 | 148 | 30 | - | - | `l10n_sa_pos`, `point_of_sale` |
| `stock.move` | 31 | 128 | 75 | - | - | `stock` |
| `pos.config` | 30 | 167 | 17 | - | - | `point_of_sale`, `pos_hr` |
| `account.move.send` | 29 | 0 | 0 | yes | - | `account` |
| `stock.picking` | 28 | 158 | 54 | - | - | `stock` |
| `pos.payment.method` | 27 | 103 | 9 | - | - | `point_of_sale` |
| `ir.attachment` | 25 | 31 | 4 | - | - | `base`, `bus` |
| `res.groups` | 25 | 34 | 14 | - | - | `base`, `bus` |
| `website` | 24 | 105 | 12 | - | - | `base`, `website` |
| `pos.order.receipt` | 22 | 0 | 0 | yes | - | `point_of_sale` |
| `hr.employee` | 18 | 205 | 52 | - | - | `hr`, `pos_hr` |
| `res.partner.bank` | 18 | 54 | 33 | - | - | `account`, `base` |
| `event.event` | 16 | 98 | 44 | - | - | `event`, `pos_event`, `website_event` |


## 6. Complete state-machine inventory

Every non-test model carrying a `state` Selection with literal values, read
from the Selection definition in declaration order. Declaration order is not
necessarily transition order.

| Model | Defined in | States |
|---|---|---|
| `account.edi.document` | `account_edi` | `to_send` -> `sent` -> `to_cancel` -> `cancelled` |
| `account.invoice.report` | `account` | `draft` -> `posted` -> `cancel` |
| `account.lock_exception` | `account` | `active` -> `revoked` -> `expired` |
| `account.move` | `account`, `l10n_sa`, `point_of_sale`, `repair`, `sale` | `draft` -> `posted` -> `cancel` |
| `account.payment` | `account` | `draft` -> `paid` -> `reconciled` -> `canceled` -> `rejected` |
| `base.automation.lead.test` | `test_base_automation` | `draft` -> `cancel` -> `open` -> `pending` -> `done` |
| `base.import.module` | `base_import_module` | `init` -> `done` |
| `base.language.export` | `base` | `choose` -> `get` |
| `base.module.update` | `base` | `init` -> `done` |
| `base.partner.merge.automatic.wizard` | `base` | `option` -> `selection` -> `finished` |
| `crm.iap.lead.mining.request` | `crm_iap_mine` | `draft` -> `error` -> `done` |
| `digest.digest` | `digest` | `activated` -> `deactivated` |
| `event.booth` | `event_booth` | `available` -> `unavailable` |
| `event.registration` | `event`, `pos_event`, `pos_event_sale` | `draft` -> `open` -> `done` -> `cancel` |
| `fetchmail.server` | `google_gmail`, `mail`, `microsoft_outlook` | `draft` -> `done` |
| `fleet.vehicle.log.contract` | `fleet` | `futur` -> `open` -> `expired` -> `done` -> `closed` |
| `fleet.vehicle.log.services` | `fleet` | `new` -> `running` -> `done` -> `cancelled` |
| `forum.post` | `website_forum` | `active` -> `pending` -> `close` -> `offensive` -> `flagged` |
| `gamification.challenge` | `gamification` | `draft` -> `inprogress` -> `done` |
| `gamification.goal` | `gamification` | `draft` -> `inprogress` -> `reached` -> `failed` -> `canceled` |
| `hr.attendance` | `hr_attendance` | `draft` -> `validated` -> `refused` |
| `hr.expense` | `hr_expense` | `draft` -> `submitted` -> `approved` -> `posted` -> `in_payment` -> `paid` -> `refused` |
| `hr.leave` | `hr_holidays` | `confirm` -> `refuse` -> `validate1` -> `validate` -> `cancel` |
| `hr.leave.allocation` | `hr_holidays` | `confirm` -> `refuse` -> `validate1` -> `validate` |
| `hr.leave.employee.report` | `hr_holidays` | `confirm` -> `refuse` -> `validate1` -> `validate` -> `cancel` |
| `hr.leave.employee.type.report` | `hr_holidays` | `cancel` -> `confirm` -> `refuse` -> `validate1` -> `validate` |
| `hr.leave.report` | `hr_holidays` | `cancel` -> `confirm` -> `refuse` -> `validate1` -> `validate` |
| `hr.leave.report.calendar` | `hr_holidays` | `cancel` -> `confirm` -> `refuse` -> `validate1` -> `validate` |
| `iap.account` | `iap`, `iap_mail` | `banned` -> `registered` -> `unregistered` |
| `ir.actions.server` | `base`, `mail` | `object_write` -> `object_create` -> `object_copy` -> `code` -> `webhook` -> `multi` |
| `ir.actions.todo` | `base` | `open` -> `done` |
| `ir.model` | `base` | `manual` -> `base` |
| `ir.model.fields` | `base` | `manual` -> `base` |
| `l10n.in.ewaybill` | `l10n_in_ewaybill` | `pending` -> `generated` -> `cancel` |
| `l10n_es_edi_sii.document` | `l10n_es_edi_sii` | `to_send` -> `accepted` -> `accepted_with_errors` -> `to_cancel` -> `cancelled` |
| `l10n_es_edi_tbai.document` | `l10n_es_edi_tbai` | `to_send` -> `accepted` -> `rejected` |
| `l10n_es_edi_verifactu.document` | `l10n_es_edi_verifactu` | `invalid` -> `rejected` -> `registered_with_errors` -> `accepted` |
| `l10n_gr_edi.document` | `l10n_gr_edi` | `invoice_sent` -> `invoice_error` -> `bill_fetched` -> `bill_sent` -> `bill_error` |
| `l10n_it_edi_doi.declaration_of_intent` | `l10n_it_edi_doi` | `draft` -> `active` -> `revoked` -> `terminated` |
| `l10n_ro_edi.document` | `l10n_ro_edi` | `invoice_sent` -> `invoice_refused` -> `invoice_validated` |
| `l10n_th.tax.invoice` | `l10n_th` | `draft` -> `posted` -> `cancel` |
| `lunch.order` | `lunch` | `new` -> `ordered` -> `sent` -> `confirmed` -> `cancelled` |
| `mail.activity` | `mail` | `overdue` -> `today` -> `planned` -> `done` |
| `mail.mail` | `mail` | `outgoing` -> `sent` -> `received` -> `exception` -> `cancel` |
| `mail.test.ticket.partner` | `test_mail` | `new` -> `open` -> `close` |
| `mailing.mailing` | `mass_mailing` | `draft` -> `in_queue` -> `sending` -> `done` |
| `mailing.trace.report` | `mass_mailing` | `draft` -> `test` -> `done` |
| `maintenance.request` | `maintenance` | `normal` -> `changes_requested` -> `approved` -> `done` -> `cancelled` |
| `mrp.production` | `mrp`, `mrp_account` | `draft` -> `confirmed` -> `progress` -> `to_close` -> `done` -> `cancel` |
| `mrp.unbuild` | `mrp` | `draft` -> `done` |
| `mrp.workorder` | `mrp` | `blocked` -> `ready` -> `progress` -> `done` -> `cancel` |
| `payment.transaction` | `payment` | `draft` -> `pending` -> `authorized` -> `done` -> `cancel` -> `error` |
| `pos.order` | `l10n_sa_pos`, `point_of_sale` | `draft` -> `cancel` -> `paid` -> `done` |
| `pos.session` | `point_of_sale` | `opening_control` -> `opened` -> `closing_control` -> `closed` |
| `project.task` | `project` | `01_in_progress` -> `02_changes_requested` -> `03_approved` -> `04_waiting_normal` |
| `project.task.burndown.chart.report` | `project` | `01_in_progress` -> `1_done` -> `04_waiting_normal` -> `03_approved` -> `1_canceled` -> `02_changes_requested` |
| `purchase.order` | `purchase` | `draft` -> `sent` -> `to approve` -> `purchase` -> `cancel` |
| `purchase.report` | `purchase` | `draft` -> `sent` -> `to approve` -> `purchase` -> `cancel` |
| `purchase.requisition` | `purchase_requisition` | `draft` -> `confirmed` -> `done` -> `cancel` |
| `repair.order` | `repair` | `draft` -> `confirmed` -> `done` -> `cancel` |
| `report.pos.order` | `point_of_sale` | `draft` -> `paid` -> `done` -> `cancel` |
| `report.project.task.user` | `project` | `01_in_progress` -> `1_done` -> `04_waiting_normal` -> `03_approved` -> `1_canceled` -> `02_changes_requested` |
| `report.stock.quantity` | `stock` | `forecast` -> `in` -> `out` |
| `res.users` | `base`, `bus`, `mail`, `point_of_sale` | `new` -> `active` -> `inactive` |
| `res.users.deletion` | `base` | `todo` -> `done` -> `fail` |
| `sms.sms` | `sms` | `outgoing` -> `process` -> `pending` -> `sent` -> `error` -> `canceled` |
| `snailmail.letter` | `snailmail` | `pending` -> `process` -> `sent` -> `error` -> `canceled` |
| `stock.landed.cost` | `stock_landed_costs` | `draft` -> `done` -> `cancel` |
| `stock.move` | `stock` | `draft` -> `waiting` -> `confirmed` -> `partially_available` -> `assigned` -> `done` -> `cancel` |
| `stock.picking` | `stock` | `draft` -> `waiting` -> `confirmed` -> `assigned` -> `done` -> `cancel` |
| `stock.picking.batch` | `stock` | `draft` -> `in_progress` -> `done` -> `cancel` |
| `survey.user_input` | `survey` | `new` -> `in_progress` -> `done` |


### Secondary status fields

Progress trackers that are not the primary lifecycle.

| Model | Field | Values |
|---|---|---|
| `mail.group.moderation` | `status` | `allow`, `ban` |
| `mail.presence` | `status` | `online`, `away`, `offline` |
| `pdp.response.wizard` | `status` | `PD`, `cancelled`, `suspended`, `refused`, `AP`, `in_hand`, `completed` |
| `pos.config` | `status` | `inactive`, `active` |
| `pos.order` | `invoice_status` | `invoiced`, `to_invoice` |
| `project.update` | `status` | `on_track`, `at_risk`, `off_track`, `on_hold`, `done` |
| `purchase.order` | `invoice_status` | `no`, `to invoice`, `invoiced` |
| `sale.order` | `delivery_status` | `pending`, `started`, `partial`, `full` |
| `sale.order.line` | `invoice_status` | `upselling`, `invoiced`, `to invoice`, `no` |
| `sale.report` | `invoice_status` | `upselling`, `invoiced`, `to invoice`, `no` |


## 7. Mixin adoption

Abstract models adopted via `_name` + `_inherit`, by number of adopting models.

| Adopters | Mixin | Own fields | Abstract | Defined in |
|---|---|---|---|---|
| 118 | `mail.thread` | 12 | yes | `mail` |
| 72 | `mail.activity.mixin` | 12 | yes | `mail` |
| 70 | `pos.load.mixin` | 0 | yes | `point_of_sale` |
| 18 | `website.seo.metadata` | 6 | yes | `website` |
| 17 | `mail.thread.blacklist` | 3 | yes | `mail` |
| 17 | `export.generic` | 2 | yes | `test_import_export` |
| 17 | `ir.qweb.field` | 0 | yes | `base`, `html_editor` |
| 16 | `website.searchable.mixin` | 0 | yes | `website` |
| 16 | `bus.listener.mixin` | 0 | yes | `bus` |
| 15 | `website.published.multi.mixin` | ? | - | - |
| 14 | `account.edi.xml.ubl_bis3` | 0 | yes | `account_edi_ubl_cii` |
| 13 | `image.mixin` | 5 | yes | `base` |
| 13 | `website.structured_data.mixin` | 0 | yes | `website` |
| 12 | `portal.mixin` | 3 | yes | `portal` |
| 11 | `mail.thread.main.attachment` | 1 | yes | `mail` |
| 10 | `analytic.mixin` | 3 | yes | `analytic` |
| 9 | `website.published.mixin` | 5 | yes | `website` |
| 8 | `product.catalog.mixin` | 0 | yes | `product` |
| 8 | `product.catalog.line.mixin` | 1 | yes | `product` |
| 8 | `mail.composer.mixin` | 7 | yes | `mail` |
| 7 | `account.edi.xml.ubl_21` | 0 | yes | `account_edi_ubl_cii` |
| 7 | `utm.mixin` | 4 | yes | `utm` |
| 7 | `mail.thread.phone` | 5 | yes | `phone_validation` |
| 7 | `mail.alias.mixin` | 3 | yes | `mail` |
| 6 | `res.currency.rate.consolidation.mixin` | 2 | yes | `account` |
| 6 | `website.located.mixin` | 2 | yes | `website` |
| 6 | `mail.tracking.duration.mixin` | 3 | yes | `mail` |
| 6 | `ir.actions.actions` | 9 | - | `base` |
| 5 | `website.multi.mixin` | 1 | yes | `website` |
| 5 | `website.trackable.mixin` | 0 | yes | `website` |
| 5 | `mail.render.mixin` | 2 | yes | `mail` |
| 5 | `bus.sync.mixin` | 0 | yes | `mail` |
| 5 | `avatar.mixin` | 5 | yes | `base` |
| 4 | `website.cover_properties.mixin` | 1 | yes | `website` |
| 4 | `mail.thread.subject.suggested` | 0 | yes | `mail` |


## 8. `_inherits` delegation (non-test)

| Child model | Parent model | Link field | Child fields |
|---|---|---|---|
| `account.bank.statement.line` | `account.move` | `move_id` | 28 |
| `account.setup.bank.manual.config` | `res.partner.bank` | `res_partner_bank_id` | 7 |
| `hr.employee` | `hr.version` | `version_id` | 205 |
| `ir.cron` | `ir.actions.server` | `ir_actions_server_id` | 11 |
| `mail.alias.mixin` | `mail.alias` | `alias_id` | 3 |
| `mail.mail` | `mail.message` | `mail_message_id` | 22 |
| `product.document` | `ir.attachment` | `ir_attachment_id` | 7 |
| `product.product` | `product.template` | `product_tmpl_id` | 112 |
| `quotation.document` | `ir.attachment` | `ir_attachment_id` | 7 |
| `res.users` | `res.partner` | `partner_id` | 162 |
| `website.controller.page` | `ir.ui.view` | `view_id` | 9 |
| `website.page` | `ir.ui.view` | `view_id` | 16 |


## 9. Security surface by module (top 30)

`ir.access` rows. A row with a domain is a record rule; without, a plain ACL.

| Module | Rows | With domain | ACL only | Operations observed |
|---|---|---|---|---|
| `test_base` | 240 | 2 | 238 | `crud`=187, `r`=51, `cru`=2 |
| `base` | 141 | 28 | 113 | `crud`=64, `r`=37, `cru`=22, `cr`=5, `cud`=4 |
| `account` | 120 | 19 | 101 | `crud`=56, `r`=48, `cru`=11, `cr`=3, `ru`=1 |
| `mail` | 95 | 36 | 59 | `crud`=40, `r`=22, `c`=7, `d`=6, `cru`=5 |
| `stock` | 90 | 16 | 74 | `crud`=40, `cru`=29, `r`=19, `c`=1, `u`=1 |
| `test_mail` | 83 | 19 | 64 | `crud`=54, `r`=23, `cud`=3, `ru`=3 |
| `project` | 66 | 28 | 38 | `crud`=30, `r`=27, `cud`=5, `cru`=2, `ru`=2 |
| `point_of_sale` | 63 | 12 | 51 | `crud`=29, `r`=23, `cru`=7, `ru`=2, `c`=1 |
| `mrp` | 58 | 11 | 47 | `crud`=26, `r`=18, `cru`=11, `c`=1, `cud`=1 |
| `test_import_export` | 56 | 0 | 56 | `crud`=49, `r`=7 |
| `sale` | 54 | 20 | 34 | `r`=24, `crud`=13, `cru`=11, `cud`=2, `ru`=2 |
| `hr_holidays` | 48 | 17 | 31 | `crud`=26, `r`=14, `cu`=4, `d`=2, `cru`=1 |
| `hr` | 44 | 17 | 27 | `crud`=26, `r`=10, `cru`=3, `cud`=2, `u`=2 |
| `product` | 44 | 8 | 36 | `crud`=26, `r`=17, `cru`=1 |
| `event` | 39 | 5 | 34 | `crud`=17, `r`=16, `cru`=3, `cud`=2, `u`=1 |
| `website_sale` | 38 | 8 | 30 | `r`=23, `crud`=14, `cru`=1 |
| `website_slides` | 38 | 14 | 24 | `r`=19, `crud`=14, `cu`=2, `cud`=2, `cru`=1 |
| `hr_recruitment` | 35 | 5 | 30 | `crud`=15, `r`=11, `cru`=4, `cud`=2, `cd`=1 |
| `purchase` | 35 | 9 | 26 | `r`=18, `crud`=10, `ru`=3, `cru`=2, `c`=1 |
| `crm` | 34 | 6 | 28 | `r`=13, `crud`=9, `cru`=8, `cud`=2, `c`=1 |
| `website` | 33 | 4 | 29 | `crud`=22, `r`=7, `cru`=3, `rud`=1 |
| `test_tests` | 31 | 0 | 31 | `r`=27, `crud`=4 |
| `fleet` | 29 | 7 | 22 | `crud`=20, `r`=8, `cru`=1 |
| `mass_mailing` | 27 | 3 | 24 | `crud`=21, `r`=4, `cru`=1, `cud`=1 |
| `lunch` | 24 | 8 | 16 | `crud`=12, `r`=7, `u`=2, `cr`=1, `d`=1 |
| `hr_expense` | 22 | 12 | 10 | `crud`=9, `cru`=7, `r`=6 |
| `hr_skills` | 22 | 5 | 17 | `r`=10, `crud`=8, `cud`=2, `cr`=1, `cru`=1 |
| `website_forum` | 20 | 6 | 14 | `crud`=13, `r`=4, `c`=1, `cr`=1, `cru`=1 |
| `gamification` | 19 | 2 | 17 | `crud`=8, `r`=5, `cru`=3, `ru`=2, `cd`=1 |
| `calendar` | 18 | 5 | 13 | `crud`=10, `r`=3, `c`=1, `cr`=1, `cud`=1 |


## 10. HTTP surface by module (all 157 with controllers)

| Module | Routes | http | jsonrpc | json2 | public | user | other auth | csrf=False | readonly |
|---|---|---|---|---|---|---|---|---|---|
| `web` | 73 | 48 | 25 | 0 | 13 | 37 | 23 | 8 | 34 |
| `mail` | 69 | 19 | 50 | 0 | 44 | 23 | 2 | 2 | 8 |
| `website` | 64 | 30 | 34 | 0 | 30 | 34 | 0 | 1 | 36 |
| `website_sale` | 62 | 25 | 37 | 0 | 48 | 14 | 0 | 0 | 12 |
| `im_livechat` | 51 | 14 | 37 | 0 | 14 | 9 | 28 | 1 | 1 |
| `website_forum` | 41 | 34 | 7 | 0 | 10 | 31 | 0 | 0 | 6 |
| `website_slides` | 39 | 14 | 25 | 0 | 19 | 20 | 0 | 0 | 3 |
| `test_website` | 37 | 30 | 7 | 0 | 37 | 0 | 0 | 0 | 0 |
| `iot_drivers` | 31 | 19 | 12 | 0 | 0 | 31 | 0 | 5 | 0 |
| `survey` | 23 | 15 | 8 | 0 | 13 | 10 | 0 | 0 | 0 |
| `html_editor` | 17 | 3 | 14 | 0 | 3 | 14 | 0 | 0 | 1 |
| `mass_mailing` | 17 | 13 | 4 | 0 | 14 | 3 | 0 | 1 | 0 |
| `pos_self_order` | 17 | 3 | 14 | 0 | 16 | 1 | 0 | 0 | 0 |
| `portal` | 16 | 10 | 6 | 0 | 3 | 13 | 0 | 0 | 5 |
| `hr_attendance` | 15 | 3 | 12 | 0 | 10 | 5 | 0 | 0 | 1 |
| `sale` | 14 | 6 | 8 | 0 | 6 | 8 | 0 | 0 | 6 |
| `website_event_track` | 14 | 10 | 4 | 0 | 14 | 0 | 0 | 0 | 7 |
| `point_of_sale` | 11 | 9 | 2 | 0 | 5 | 6 | 0 | 0 | 0 |
| `account` | 10 | 9 | 1 | 0 | 3 | 7 | 0 | 0 | 0 |
| `calendar` | 10 | 8 | 2 | 0 | 2 | 3 | 5 | 0 | 0 |
| `mail_plugin` | 10 | 3 | 7 | 0 | 0 | 3 | 7 | 0 | 0 |
| `mail_group` | 9 | 6 | 3 | 0 | 9 | 0 | 0 | 1 | 0 |
| `project` | 9 | 9 | 0 | 0 | 3 | 6 | 0 | 0 | 0 |
| `website_event` | 9 | 7 | 2 | 0 | 9 | 0 | 0 | 0 | 3 |
| `website_profile` | 8 | 5 | 3 | 0 | 6 | 2 | 0 | 0 | 4 |
| `website_sale_loyalty` | 8 | 8 | 0 | 0 | 2 | 6 | 0 | 0 | 0 |
| `payment` | 7 | 4 | 3 | 0 | 5 | 2 | 0 | 0 | 0 |
| `bus` | 6 | 4 | 2 | 0 | 4 | 1 | 1 | 0 | 0 |
| `lunch` | 6 | 0 | 6 | 0 | 0 | 6 | 0 | 0 | 0 |
| `marketing_card` | 6 | 6 | 0 | 0 | 6 | 0 | 0 | 0 | 0 |
| `payment_paypal` | 6 | 3 | 3 | 0 | 4 | 2 | 0 | 1 | 0 |
| `payment_stripe` | 6 | 5 | 1 | 0 | 4 | 2 | 0 | 2 | 0 |
| `rpc` | 6 | 3 | 1 | 2 | 1 | 0 | 5 | 2 | 3 |
| `website_event_booth` | 6 | 4 | 2 | 0 | 6 | 0 | 0 | 0 | 0 |
| `account_payment` | 5 | 3 | 2 | 0 | 3 | 2 | 0 | 0 | 0 |
| `account_peppol` | 5 | 5 | 0 | 0 | 4 | 1 | 0 | 4 | 0 |
| `api_doc` | 5 | 1 | 0 | 4 | 0 | 3 | 2 | 0 | 2 |
| `auth_signup` | 5 | 5 | 0 | 0 | 3 | 2 | 0 | 0 | 0 |
| `hr_holidays` | 5 | 5 | 0 | 0 | 0 | 5 | 0 | 0 | 0 |
| `payment_adyen` | 5 | 2 | 3 | 0 | 5 | 0 | 0 | 2 | 0 |
| `purchase` | 5 | 4 | 1 | 0 | 3 | 2 | 0 | 0 | 0 |
| `test_mail_full` | 5 | 5 | 0 | 0 | 5 | 0 | 0 | 0 | 0 |
| `website_crm_partner_assign` | 5 | 5 | 0 | 0 | 0 | 5 | 0 | 0 | 0 |
| `website_event_track_quiz` | 5 | 3 | 2 | 0 | 4 | 1 | 0 | 0 | 0 |
| `website_hr_recruitment` | 5 | 4 | 1 | 0 | 4 | 1 | 0 | 0 | 0 |
| `event` | 4 | 3 | 1 | 0 | 2 | 2 | 0 | 0 | 0 |
| `l10n_tw_edi_ecpay_website_sale` | 4 | 2 | 2 | 0 | 4 | 0 | 0 | 0 | 0 |
| `payment_mercado_pago` | 4 | 3 | 1 | 0 | 3 | 1 | 0 | 1 | 0 |
| `product` | 4 | 2 | 2 | 0 | 0 | 4 | 0 | 0 | 2 |
| `spreadsheet_dashboard` | 4 | 4 | 0 | 0 | 2 | 2 | 0 | 0 | 3 |
| `web_unsplash` | 4 | 0 | 4 | 0 | 1 | 3 | 0 | 0 | 0 |
| `website_blog` | 4 | 4 | 0 | 0 | 4 | 0 | 0 | 0 | 0 |
| `auth_oauth` | 3 | 3 | 0 | 0 | 0 | 1 | 2 | 0 | 0 |
| `base_setup` | 3 | 0 | 3 | 0 | 0 | 2 | 1 | 0 | 0 |
| `crm` | 3 | 3 | 0 | 0 | 0 | 3 | 0 | 0 | 0 |
| `digest` | 3 | 3 | 0 | 0 | 2 | 1 | 0 | 1 | 0 |
| `hr` | 3 | 0 | 3 | 0 | 0 | 3 | 0 | 0 | 0 |
| `l10n_dk` | 3 | 3 | 0 | 0 | 3 | 0 | 0 | 3 | 0 |
| `loyalty` | 3 | 2 | 1 | 0 | 0 | 3 | 0 | 0 | 0 |
| `mass_mailing_sms` | 3 | 3 | 0 | 0 | 3 | 0 | 0 | 0 | 0 |
| `mrp_subcontracting` | 3 | 3 | 0 | 0 | 0 | 3 | 0 | 0 | 0 |
| `payment_flutterwave` | 3 | 3 | 0 | 0 | 3 | 0 | 0 | 1 | 0 |
| `payment_payu` | 3 | 3 | 0 | 0 | 2 | 1 | 0 | 2 | 0 |
| `payment_razorpay` | 3 | 3 | 0 | 0 | 2 | 1 | 0 | 2 | 0 |
| `payment_toss_payments` | 3 | 3 | 0 | 0 | 3 | 0 | 0 | 1 | 0 |
| `payment_xendit` | 3 | 2 | 1 | 0 | 3 | 0 | 0 | 1 | 0 |
| `pos_online_payment` | 3 | 2 | 1 | 0 | 3 | 0 | 0 | 0 | 0 |
| `pos_safaricom` | 3 | 3 | 0 | 0 | 3 | 0 | 0 | 3 | 0 |
| `pos_viva_com` | 3 | 3 | 0 | 0 | 2 | 0 | 1 | 1 | 0 |
| `project_mail_plugin` | 3 | 1 | 2 | 0 | 0 | 1 | 2 | 0 | 0 |
| `sale_stock` | 3 | 2 | 1 | 0 | 3 | 0 | 0 | 0 | 1 |
| `website_event_exhibitor` | 3 | 2 | 1 | 0 | 3 | 0 | 0 | 0 | 0 |
| `website_payment` | 3 | 3 | 0 | 0 | 1 | 2 | 0 | 0 | 1 |
| `website_sale_collect` | 3 | 2 | 1 | 0 | 1 | 2 | 0 | 0 | 0 |
| `website_slides_survey` | 3 | 2 | 1 | 0 | 0 | 3 | 0 | 0 | 0 |
| `auth_passkey` | 2 | 1 | 1 | 0 | 2 | 0 | 0 | 0 | 0 |
| `auth_totp_mail` | 2 | 1 | 1 | 0 | 0 | 2 | 0 | 0 | 0 |
| `cloud_storage` | 2 | 2 | 0 | 0 | 1 | 1 | 0 | 1 | 0 |
| `google_address_autocomplete` | 2 | 0 | 2 | 0 | 2 | 0 | 0 | 0 | 0 |
| `google_gmail` | 2 | 2 | 0 | 0 | 0 | 2 | 0 | 0 | 0 |
| `http_routing` | 2 | 2 | 0 | 0 | 1 | 1 | 0 | 0 | 1 |
| `l10n_fr_pdp` | 2 | 2 | 0 | 0 | 2 | 0 | 0 | 2 | 0 |
| `l10n_ro_edi` | 2 | 2 | 0 | 0 | 0 | 2 | 0 | 0 | 0 |
| `microsoft_outlook` | 2 | 2 | 0 | 0 | 0 | 2 | 0 | 0 | 0 |
| `payment_aps` | 2 | 2 | 0 | 0 | 2 | 0 | 0 | 2 | 0 |
| `payment_asiapay` | 2 | 2 | 0 | 0 | 2 | 0 | 0 | 1 | 0 |
| `payment_authorize` | 2 | 1 | 1 | 0 | 2 | 0 | 0 | 1 | 0 |
| `payment_buckaroo` | 2 | 2 | 0 | 0 | 2 | 0 | 0 | 2 | 0 |
| `payment_ecpay` | 2 | 2 | 0 | 0 | 2 | 0 | 0 | 2 | 0 |
| `payment_iyzico` | 2 | 2 | 0 | 0 | 2 | 0 | 0 | 2 | 0 |
| `payment_mollie` | 2 | 2 | 0 | 0 | 2 | 0 | 0 | 2 | 0 |
| `payment_nuvei` | 2 | 2 | 0 | 0 | 2 | 0 | 0 | 1 | 0 |
| `payment_paymob` | 2 | 2 | 0 | 0 | 2 | 0 | 0 | 1 | 0 |
| `payment_redsys` | 2 | 2 | 0 | 0 | 2 | 0 | 0 | 1 | 0 |
| `payment_worldline` | 2 | 2 | 0 | 0 | 2 | 0 | 0 | 1 | 0 |
| `portal_discuss` | 2 | 2 | 0 | 0 | 0 | 2 | 0 | 0 | 0 |
| `pos_adyen` | 2 | 1 | 1 | 0 | 1 | 1 | 0 | 1 | 0 |
| `pos_bancontact_pay` | 2 | 2 | 0 | 0 | 1 | 1 | 0 | 1 | 0 |
| `pos_online_payment_self_order` | 2 | 2 | 0 | 0 | 0 | 2 | 0 | 0 | 0 |
| `pos_self_order_event` | 2 | 0 | 2 | 0 | 2 | 0 | 0 | 0 | 0 |
| `pos_self_order_pine_labs` | 2 | 0 | 2 | 0 | 2 | 0 | 0 | 0 | 0 |
| `pos_self_order_razorpay` | 2 | 0 | 2 | 0 | 2 | 0 | 0 | 0 | 0 |
| `rating` | 2 | 2 | 0 | 0 | 2 | 0 | 0 | 0 | 0 |
| `sale_timesheet` | 2 | 2 | 0 | 0 | 0 | 2 | 0 | 0 | 0 |
| `website_customer` | 2 | 2 | 0 | 0 | 2 | 0 | 0 | 0 | 2 |
| `website_livechat` | 2 | 2 | 0 | 0 | 0 | 2 | 0 | 0 | 0 |
| `website_mail` | 2 | 0 | 2 | 0 | 2 | 0 | 0 | 0 | 1 |
| `website_mass_mailing` | 2 | 0 | 2 | 0 | 2 | 0 | 0 | 0 | 0 |
| `website_sale_stock` | 2 | 0 | 2 | 0 | 2 | 0 | 0 | 0 | 0 |
| `auth_totp` | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 0 |
| `base_automation` | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 1 | 0 |
| `base_import` | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| `base_import_module` | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 1 | 0 |
| `board` | 1 | 0 | 1 | 0 | 0 | 1 | 0 | 0 | 0 |
| `crm_mail_plugin` | 1 | 0 | 1 | 0 | 0 | 0 | 1 | 0 | 0 |
| `google_account` | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 0 |
| `google_calendar` | 1 | 0 | 1 | 0 | 0 | 1 | 0 | 0 | 0 |
| `hr_skills` | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| `hr_timesheet` | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| `hr_work_entry` | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| `l10n_es_website_sale` | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| `l10n_eu_account_vies` | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 1 | 0 |
| `l10n_id` | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| `l10n_id_efaktur_coretax` | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| `l10n_pe` | 1 | 0 | 1 | 0 | 1 | 0 | 0 | 0 | 0 |
| `l10n_th` | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| `l10n_tw_edi_ecpay` | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 1 | 0 |
| `mail_bot` | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| `microsoft_account` | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 0 |
| `microsoft_calendar` | 1 | 0 | 1 | 0 | 0 | 1 | 0 | 0 | 0 |
| `payment_custom` | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 1 | 0 |
| `payment_demo` | 1 | 0 | 1 | 0 | 1 | 0 | 0 | 0 | 0 |
| `payment_dpo` | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 0 |
| `portal_rating` | 1 | 0 | 1 | 0 | 0 | 1 | 0 | 0 | 0 |
| `pos_mercado_pago` | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 1 | 0 |
| `pos_mollie` | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 1 | 0 |
| `pos_qfpay` | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 1 | 0 |
| `pos_self_order_bancontact_pay` | 1 | 0 | 1 | 0 | 1 | 0 | 0 | 0 | 0 |
| `project_purchase` | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| `sale_gelato` | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 1 | 0 |
| `sale_loyalty` | 1 | 0 | 1 | 0 | 1 | 0 | 0 | 0 | 0 |
| `sale_management` | 1 | 0 | 1 | 0 | 1 | 0 | 0 | 0 | 0 |
| `sale_pdf_quote_builder` | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| `sms` | 1 | 0 | 1 | 0 | 1 | 0 | 0 | 0 | 0 |
| `sms_twilio` | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 1 | 0 |
| `spreadsheet` | 1 | 0 | 1 | 0 | 0 | 1 | 0 | 0 | 0 |
| `stock` | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| `test_assetsbundle` | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| `website_event_booth_sale` | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| `website_event_sale` | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| `website_event_track_live` | 1 | 0 | 1 | 0 | 1 | 0 | 0 | 0 | 0 |
| `website_google_map` | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 0 |
| `website_mail_group` | 1 | 0 | 1 | 0 | 1 | 0 | 0 | 0 | 0 |
| `website_partner` | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 0 |
| `website_partnership` | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 1 |
| `website_sale_mrp` | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| `website_sale_slides` | 1 | 0 | 1 | 0 | 0 | 1 | 0 | 0 | 0 |


## 11. Module index by domain

| Domain | Modules | Applications | Auto-install | With controllers | With static/src |
|---|---|---|---|---|---|
| Accounting | 258 | 1 | 180 | 44 | 59 |
| Sales | 99 | 5 | 59 | 32 | 62 |
| Hidden | 86 | 0 | 30 | 26 | 39 |
| Marketing | 40 | 5 | 24 | 16 | 25 |
| Website | 40 | 5 | 24 | 30 | 32 |
| Theme | 36 | 0 | 0 | 0 | 35 |
| Supply Chain | 34 | 5 | 20 | 3 | 14 |
| Productivity | 29 | 4 | 18 | 9 | 12 |
| Human Resources | 29 | 8 | 17 | 9 | 17 |
| Services | 16 | 1 | 14 | 6 | 6 |
| Uncategorized | 7 | 0 | 3 | 3 | 6 |
| Technical Settings | 4 | 0 | 0 | 1 | 2 |
| Extra Tools | 3 | 0 | 3 | 3 | 2 |
| Technical | 3 | 0 | 3 | 0 | 3 |
| Website Sale | 2 | 0 | 2 | 1 | 1 |
| Shipping Connectors | 2 | 0 | 2 | 0 | 1 |
| Tools | 1 | 0 | 1 | 0 | 0 |
| Administration | 1 | 0 | 0 | 0 | 1 |
| account | 1 | 0 | 0 | 0 | 1 |
| Point of sale | 1 | 0 | 1 | 0 | 1 |
| Send sms to customer for order confirmation | 1 | 0 | 0 | 0 | 1 |


## Reproduction

```bash
python3 -I build_indexes.py   # writes the 5 JSON indexes
python3 -I gen_tables.py      # regenerates this document
```

Both scripts take the addons root from the `ADDONS` constant and are
idempotent. Running them against a different Odoo tree regenerates every
table above for that version.
