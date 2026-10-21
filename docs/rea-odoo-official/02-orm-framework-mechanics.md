# 02 - ORM and Framework Mechanics

Phase 2 output. Source: AST walk of every `.py` file in all 693 addon
directories, excluding `static/`, `i18n/`, `data/`, `__pycache__/`. 0 parse
errors.

## Census

| Metric | Value |
|---|---|
| Model classes (`models.Model` / `TransientModel` / `AbstractModel`) | 4,224 |
| Distinct model names | 1,489 |
| Field definitions captured | 17,225 |
| Relational fields | 5,291 |
| `@api.depends` compute methods | 3,738 |
| `@api.constrains` validators | 570 |
| `_inherits` delegations | 32 (11 product, 21 test) |
| Abstract models (mixins) | 180 |
| Transient models (wizards) | 238 |
| Models with a `state` Selection | 79 |

**4,224 classes defining 1,489 models means the average model is assembled
from 2.8 classes across different modules.** This is the defining
characteristic of the codebase: a model is rarely one file. `account.move` is
assembled from 119 classes.

## The three inheritance modes

Odoo overloads the word "inheritance" for three mechanically different things.
Distinguishing them is prerequisite to reading any Odoo module.

### 1. Classical extension: `_inherit` alone

The class has `_inherit` and no `_name`. It reopens an existing model and
merges into it in place. No new table, no new model. This is how 401
`auto_install` bridges work.

```python
# sale_stock/models/sale_order.py:198
class SaleOrder(models.Model):
    _inherit = 'sale.order'

    def _action_confirm(self):
        self._update_delivery_partner_company()
        self.order_line._action_launch_stock_rule()
        return super(SaleOrder, self)._action_confirm()
```

Measured blast radius (count of distinct modules reopening a model):

| Extending modules | Model | Defined in |
|---|---|---|
| 134 | `res.config.settings` | `base` |
| 133 | `account.chart.template` | `account` |
| 124 | `res.company` | `account`, `base`, `l10n_sg`, `point_of_sale` |
| 117 | `res.partner` | `base`, `bus`, `mail`, `phone_validation`, `point_of_sale`, `website`, `website_partner` |
| 114 | `account.move` | `account`, `l10n_sa`, `point_of_sale`, `repair`, `sale` |
| 56 | `product.template` | `point_of_sale`, `product`, `website_sale` |
| 52 | `res.users` | `base`, `bus`, `mail`, `point_of_sale` |
| 48 | `account.tax` | `account`, `point_of_sale` |
| 47 | `ir.http` | `base` |
| 44 | `account.move.line`, `sale.order` | |
| 41 | `account.journal` | |
| 36 | `product.product`, `sale.order.line`, `theme.utils` | |
| 31 | `payment.provider`, `payment.transaction`, `pos.order`, `stock.move` | |

Several models appear with multiple `defined_in` modules. That is not a
contradiction: a module may declare `_name` for a model another module also
declares, because `point_of_sale` and `website_sale` add `_name`-bearing
classes for POS/web-specific variants that merge into the same registry entry.
`res.config.settings` at 134 is the extreme case and is architecturally
different: it is a `TransientModel` that every module appends its own settings
fields to, which is why it carries 784 fields.

### 2. Prototype inheritance: `_name` plus `_inherit`

The class declares both. It creates a **new** model with its own table that
copies the fields and methods of the named parents. The parents are usually
abstract mixins.

```python
# mail/models/ir_access.py:7
class IrAccess(models.Model):
    _name = 'ir.access'
    _inherit = ['ir.access', 'mail.thread']
```

Mixin adoption, measured:

| Adopters | Mixin | Provides |
|---|---|---|
| 118 | `mail.thread` | Chatter, message_post, field tracking, followers |
| 72 | `mail.activity.mixin` | Scheduled activities / to-dos |
| 70 | `pos.load.mixin` | Participation in the POS offline data preload |
| 18 | `website.seo.metadata` | SEO fields for public pages |
| 17 | `mail.thread.blacklist` | Email opt-out handling |
| 17 | `export.generic` | |
| 17 | `ir.qweb.field` | QWeb field rendering |
| 16 | `website.searchable.mixin`, `bus.listener.mixin` | Site search; websocket push |
| 15 | `website.published.multi.mixin` | Per-website publish state |
| 14 | `account.edi.xml.ubl_bis3` | UBL BIS3 e-invoice serialization |
| 13 | `image.mixin`, `website.structured_data.mixin` | |
| 12 | `portal.mixin` | Customer portal access + access tokens |
| 11 | `mail.thread.main.attachment` | |
| 10 | `analytic.mixin` | Analytic distribution JSON |
| 8 | `product.catalog.mixin`, `product.catalog.line.mixin`, `mail.composer.mixin` | |

**`mail.thread` on 118 models is the most consequential mixin in Odoo.** It is
why nearly every business document has a message thread, an activity list, and
automatic audit tracking of `tracking=True` fields. It is abstract with only 12
own fields; the weight is in its methods.

### 3. Delegation inheritance: `_inherits`

A dict mapping parent model to the local Many2one that stores the link. The
child gets a real foreign-key row and transparently proxies the parent's
fields. Rare and deliberate: only 11 non-test uses exist in the whole
ecosystem.

| Child | Parent | Via | Why |
|---|---|---|---|
| `product.product` | `product.template` | `product_tmpl_id` | Variant to template. The canonical example |
| `res.users` | `res.partner` | `partner_id` | A user *is* a contact |
| `hr.employee` | `hr.version` | `version_id` | **New in the 18-20 line**: employee data is versioned over time; the employee row delegates to its current version |
| `account.bank.statement.line` | `account.move` | `move_id` | Every statement line is backed by a journal entry |
| `mail.mail` | `mail.message` | `mail_message_id` | Outgoing mail wraps a message |
| `ir.cron` | `ir.actions.server` | `ir_actions_server_id` | A cron job *is* a server action with a schedule |
| `website.page` | `ir.ui.view` | `view_id` | A CMS page is a view plus metadata |
| `website.controller.page` | `ir.ui.view` | `view_id` | |
| `product.document` | `ir.attachment` | `ir_attachment_id` | |
| `quotation.document` | `ir.attachment` | `ir_attachment_id` | |
| `mail.alias.mixin` | `mail.alias` | `alias_id` | |
| `account.setup.bank.manual.config` | `res.partner.bank` | `res_partner_bank_id` | |

**`hr.employee` delegating to `hr.version` is worth flagging to anyone
migrating.** The old `hr.contract` arrangement is replaced by a versioned
record; `hr.employee` carries 205 fields but reads many of them through
`version_id`. `hr.version` itself has 67 fields and `_order = date_version`.

### Mode comparison

| | `_inherit` only | `_name` + `_inherit` | `_inherits` |
|---|---|---|---|
| New DB table | No | Yes | Yes |
| New model name | No | Yes | Yes |
| Parent fields | Merged in place | Copied | Proxied via FK |
| Parent rows | Same rows | Independent | One parent row per child row |
| Typical use | Module bridges | Mixin adoption | "is-a" with shared storage |
| Count in ecosystem | Dominant (most of 4,224 classes) | 180 mixins adopted | 11 non-test |

## Computed fields and dependency triggers

3,738 `@api.depends` methods. The dependency strings form the recomputation
graph that the ORM walks on every write.

Concentration in the heaviest models:

| Model | Fields | Computes | Constrains | Onchange |
|---|---|---|---|---|
| `res.config.settings` | 784 | - | - | - |
| `account.move` | 537 | 271 | 18 | 29 |
| `res.company` | 497 | - | - | - |
| `res.partner` | 305 | 107 | 18 | 18 |
| `hr.employee` | 205 | 52 | 4 | 9 |
| `product.template` | 190 | 73 | 9 | 18 |
| `sale.order` | 175 | 101 | 5 | 15 |
| `stock.picking` | 158 | 54 | 1 | 7 |
| `account.move.line` | 148 | 60 | 7 | 8 |
| `pos.order` | 148 | 30 | 0 | 3 |
| `sale.order.line` | 134 | 87 | 3 | 10 |
| `payment.provider` | 130 | - | - | - |
| `stock.move` | 128 | 75 | 1 | 3 |
| `account.tax` | 115 | - | - | - |

**`account.move` with 271 compute methods over 537 fields is the densest
object in the system.** Roughly half its fields are derived. This is the
mechanical reason invoice writes are expensive and why `account` carries the
most `@api.constrains` of any domain.

Key trigger decorators observed:

| Decorator | Semantics | Count |
|---|---|---|
| `@api.depends(...)` | Recompute when any listed path changes. Dotted paths cross relations (`'picking_ids.state'`) | 3,738 |
| `@api.constrains(...)` | Python validation on create/write of the listed fields. Raises `ValidationError` | 570 |
| `@api.onchange(...)` | Form-view-only UI reaction, not enforced on ORM writes | measured per model above |
| `@api.ondelete(...)` | Unlink guard that survives module upgrade ordering | present on multiple models |
| `@api.depends_context(...)` | Recompute per context key (company, pricelist) rather than per field | excluded from the 3,738 |
| `@api.model_create_multi` | Batch create entry point; the only correct `create` override shape | e.g. `ir_access.py:152` |

Cross-relation dependency example, from `sale_stock/models/sale_order.py:76`:

```python
@api.depends('picking_ids', 'picking_ids.state')
def _compute_delivery_status(self):
    ...
```

A `stock.picking` state change propagates back into `sale.order.delivery_status`
without `stock` knowing `sale` exists. `sale_stock` owns the dependency edge.
This is the inversion that makes the bridge pattern work.

## Security: the unified `ir.access` model

**This is the largest framework change in Odoo 20 and it breaks every
pre-existing security file.**

Observed: across all 693 modules there are **zero** `ir.model.access.csv` files
and **zero** XML records with `model="ir.rule"`. Both legacy mechanisms are
gone. Verified by exhaustive find/grep.

In their place, a single model:

```python
# base/models/ir_access.py:66
class IrAccess(models.Model):
    """ Access control records with domains. """
    _name = 'ir.access'
    _description = "Access"
    _order = 'model_id, group_id, id'
    _allow_sudo_commands = False
```

Declared through `security/ir.access.csv`. Measured: **235 CSV files, 2,587
rows** across the ecosystem (231 of those files sit under `<module>/security/`;
4 live elsewhere).

Of those 2,587 rows, **531 carry a domain and 2,056 do not** — so in the old
vocabulary this install ships 531 record rules and 2,056 plain ACLs, now stored
as one record type.

The `operation` column is a CRUD letter set, and 15 distinct combinations are
in use:

| Rows | `operation` | Grants |
|---|---|---|
| 1,326 | `crud` | Full access |
| 848 | `r` | Read only |
| 236 | `cru` | No delete |
| 44 | `cud` | No read (write-only sinks) |
| 37 | `ru` | Read and update |
| 22 | `cr` | Create and read |
| 21 | `u` | Update only |
| 16 | `c` | Create only |
| 9 | `d` | Delete only |
| 9 | `cu` | Create and update |
| 7 | `ud` | Update and delete |
| 5 | `rud` | No create |
| 3 | `cd` | Create and delete |
| 2 | `crd` | No update |
| 2 | `rd` | Read and delete |

`crud` and `r` together account for 2,174 of 2,587 rows (84%); the other 13
combinations are the long tail of deliberately narrow grants. The 44 `cud` rows
are notable: records a group may write but not read.

Header and representative rows (`account/security/ir.access.csv`):

```
id,name,model_id,group_id/id,operation,domain
access_account_cash_rounding_readonly,account.cash.rounding,account.cash.rounding,account.group_account_readonly,r,
access_account_cash_rounding_uinvoice,account.cash.rounding,account.cash.rounding,account.group_account_invoice,crud,
```

### What changed mechanically

| Odoo <= 19 | Odoo 20 |
|---|---|
| `ir.model.access` CSV with 4 boolean columns (`perm_read`, `perm_write`, `perm_create`, `perm_unlink`) | One `operation` string using CRUD letters: `r`, `crud`, etc. |
| `ir.rule` XML records with `domain_force`, separate file | Optional `domain` column on the same row |
| Global vs group rule distinguished by empty `groups` | Computed `kind` field derived from `group_id` |
| Two concepts, two file formats | One concept, one file |

**A row with an empty `domain` is an ACL. A row with a `domain` is a record
rule. They are now the same record type.** The boolean fields `for_read`,
`for_write`, `for_create`, `for_unlink` survive as computed/inverse
conveniences for the form view (`ir_access.py:29-61`, with
`_inverse_for_operations` at line 105).

Notable implementation details read from `base/models/ir_access.py`:

- `_check_domain` is an `@api.constrains('active', 'domain', 'model_id')` at
  line 120, so an invalid domain is rejected at write time rather than at
  enforcement time.
- `_get_all_access` is `@api.ormcache(cache='stable')` at line 217. Access
  resolution is cached registry-wide; `_clear_caches` at line 186 is the
  invalidation point.
- `_compute_sql_kind`, `_compute_sql_is_standard`, `_compute_sql_for` (lines
  68, 82, 100) indicate the access layer is partly evaluated **in SQL**, not
  only in Python.
- `_allow_sudo_commands = False` prevents the security table from being
  rewritten through sudo command tuples.
- `mail` extends it with `mail.thread` (`mail/models/ir_access.py:8`), so
  changes to access rules are themselves audit-tracked.

### ACL volume by module

| Rows | Module |
|---|---|
| 240 | `test_base` |
| 141 | `base` |
| 120 | `account` |
| 95 | `mail` |
| 90 | `stock` |
| 83 | `test_mail` |
| 66 | `project` |
| 63 | `point_of_sale` |
| 58 | `mrp` |
| 56 | `test_import_export` |

## State machines

79 models carry a `state` Selection field. The 15 that matter for cross-module
flow, with values read from the Selection definitions in declaration order:

| Model | Field | States |
|---|---|---|
| `account.move` | `state` | `draft` -> `posted` -> `cancel` |
| `account.payment` | `state` | `draft` -> `paid` -> `reconciled` -> `canceled` -> `rejected` |
| `payment.transaction` | `state` | `draft` -> `pending` -> `authorized` -> `done` -> `cancel` -> `error` |
| `stock.picking` | `state` | `draft` -> `waiting` -> `confirmed` -> `assigned` -> `done` -> `cancel` |
| `stock.move` | `state` | `draft` -> `waiting` -> `confirmed` -> `partially_available` -> `assigned` -> `done` -> `cancel` |
| `purchase.order` | `state` | `draft` -> `sent` -> `to approve` -> `purchase` -> `cancel` |
| `mrp.production` | `state` | `draft` -> `confirmed` -> `progress` -> `to_close` -> `done` -> `cancel` |
| `mrp.workorder` | `state` | `blocked` -> `ready` -> `progress` -> `done` -> `cancel` |
| `pos.order` | `state` | `draft` -> `cancel` -> `paid` -> `done` |
| `project.task` | `state` | `01_in_progress` -> `02_changes_requested` -> `03_approved` -> `04_waiting_normal` |
| `sale.order` | `delivery_status` | `pending` -> `started` -> `partial` -> `full` |
| `sale.order.line` | `invoice_status` | `upselling`, `invoiced`, `to invoice`, `no` |
| `purchase.order` | `invoice_status` | `no` -> `to invoice` -> `invoiced` |
| `pos.order` | `invoice_status` | `to_invoice`, `invoiced` |

**`sale.order` has no `state` Selection captured by this extraction** while
`purchase.order` does. `sale.order`'s lifecycle field is defined through a
different mechanism than a literal inline Selection list, and its
`delivery_status`/`invoice_status` are the computed progress trackers. The
`draft`/`sent`/`sale`/`cancel` lifecycle is driven by
`action_quotation_sent` / `action_confirm` / `action_cancel` / `action_draft`
(all present in the measured action list). Treat the exact `sale.order.state`
selection as **unverified by this pass** rather than assuming parity with
`purchase.order`.

`project.task` ordinal-prefixed states (`01_`, `02_`) are a deliberate trick:
the prefix makes the stored value sort correctly in group-by views without a
separate sequence field.

### State machines by owning module

```
account          account.invoice.report, account.lock_exception, account.payment, account.move
account_edi      account.edi.document
base             ir.actions.todo, ir.model, ir.model.fields, res.users.deletion,
                 base.language.export, base.module.update, base.partner.merge.automatic.wizard
crm_iap_mine     crm.iap.lead.mining.request
event            event.registration
event_booth      event.booth
fleet            fleet.vehicle.log.contract, fleet.vehicle.log.services
gamification     gamification.challenge, gamification.goal
hr_attendance    hr.attendance
hr_expense       hr.expense
hr_holidays      hr.leave, hr.leave.allocation + 4 report models
lunch            lunch.order
mail             mail.activity, mail.mail
maintenance      maintenance.request
mass_mailing     mailing.mailing, mailing.trace.report
mrp              mrp.unbuild, mrp.workorder, mrp.production
payment          payment.transaction
point_of_sale    pos.session, pos.order, report.pos.order
project          project.task, project.task.burndown.chart.report, report.project.task.user
purchase         purchase.order, purchase.report
purchase_requisition  purchase.requisition
repair           repair.order
sms              sms.sms
snailmail        snailmail.letter
stock            stock.move, stock.picking, stock.picking.batch, report.stock.quantity
survey           survey.user_input
website_forum    forum.post
l10n_* (9 modules)    per-country EDI document state machines
```

## Automation surface

| Mechanism | Measured | Notes |
|---|---|---|
| `ir.cron` XML records | 105 across 59 modules | Scheduled server actions. `ir.cron` delegates to `ir.actions.server` |
| `base.automation` | model at `base_automation/models/base_automation.py:130` | User-configurable triggers; **invisible to static analysis** |
| `@api.ondelete` hooks | present on multiple models | Upgrade-safe unlink guards |
| SQL constraints | captured per model in `model_index.json` | Database-level enforcement |

**Unknown:** `base.automation` rules are data, not code. Any deployment can
add triggers that this analysis cannot see. A complete behavioral picture of a
running instance requires reading its `base_automation` table.
